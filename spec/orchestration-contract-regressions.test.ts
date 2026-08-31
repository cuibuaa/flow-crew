import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { evaluateCondition } from '../src/condition.js';
import {
  appendGuidanceEnvelope,
  guidanceForStageFromText,
  readGuidanceForStage,
  RUN_WIDE_GUIDANCE_TARGET,
} from '../src/guidance.js';
import {
  consumeSupervisorReject,
  decideRejectAction,
  inspectDispatchAdmission,
  inspectRealityCheckReachability,
  parseDispatchedStageConfig,
  readGateVerdict,
  resolveDispatchDependencies,
  researchAdvanceEligible,
  tryAdvanceResearch,
  tryTerminateOnTerminalState,
} from '../src/scheduler.js';
import { inspectBriefOutputs } from '../src/ship-inputs.js';
import { inspectBrief } from '../src/brief-preflight.js';
import { inspectTemporalResearchTests } from '../src/temporal-test-guard.js';
import { recordBlockageOccurrence } from '../src/blockage-ledger.js';
import { CommandActivityTracker } from '../src/command-activity.js';
import { inspectStageExecutionFacts } from '../src/supervisor.js';
import { evaluateResearch } from '../src/research-policy.js';
import { buildStagePrompt } from '../src/handoff.js';
import { fcGlobalDir, runDir, setFcGlobalDir, writeRunState } from '../src/store.js';
import type { StoreState, StageStatus } from '../src/store.js';
import type { Adapter } from '../src/adapters/base.js';

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-contract-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const stage = (raw: Record<string, unknown>) => parseDispatchedStageConfig({
  prompt_template: 'bounded test stage',
  skills: [],
  is_gate: false,
  criterion_refs: [],
  ...raw,
});

const inertAdapter: Adapter = {
  run: async () => ({ output: '', exitCode: 0, duration_ms: 0 }),
};

type AdmissionInput = Parameters<typeof inspectDispatchAdmission>[0];

function recordedDispatchFixture(name: string): {
  raw: string;
  source: { dispatchSha256: string; dispatchBytes: number };
  admission: AdmissionInput;
} {
  const root = join(import.meta.dirname, 'fixtures', 'dispatch-admission', name);
  const raw = readFileSync(join(root, 'dispatch.yaml'), 'utf-8');
  const context = JSON.parse(readFileSync(join(root, 'context.json'), 'utf-8')) as {
    source: { dispatchSha256: string; dispatchBytes: number };
    terminalStates?: AdmissionInput['terminalStates'];
    research?: AdmissionInput['research'];
    criteria?: AdmissionInput['criteria'];
  };
  const parsed = parseYaml(raw) as unknown[];
  expect(createHash('sha256').update(raw).digest('hex')).toBe(context.source.dispatchSha256);
  expect(Buffer.byteLength(raw)).toBe(context.source.dispatchBytes);
  return {
    raw,
    source: context.source,
    admission: {
      dispatched: parsed.map((item) => parseDispatchedStageConfig(item)),
      baseStages: [],
      dispatchStageId: 'plan',
      terminalStates: context.terminalStates,
      research: context.research,
      criteria: context.criteria,
    },
  };
}

describe('addressed guidance envelopes', () => {
  it('delivers only exact-target and explicit run-wide entries and quarantines unknown targets', () => {
    const runDir = temporaryRoot();
    appendGuidanceEnvelope({ runDir, target: 'plan', source: 'supervisor', body: 'plan only', knownStageIds: ['plan', 'implement'], createdAt: '2026-01-01T00:00:00.000Z' });
    appendGuidanceEnvelope({ runDir, target: 'implement', source: 'supervisor', body: 'implementation only', knownStageIds: ['plan', 'implement'], createdAt: '2026-01-01T00:00:01.000Z' });
    appendGuidanceEnvelope({ runDir, target: RUN_WIDE_GUIDANCE_TARGET, source: 'operator', body: 'all stages', createdAt: '2026-01-01T00:00:02.000Z' });
    const unknown = appendGuidanceEnvelope({ runDir, target: 'missing', source: 'supervisor', body: 'must not leak', knownStageIds: ['plan', 'implement'], createdAt: '2026-01-01T00:00:03.000Z' });

    const ledger = readFileSync(join(runDir, 'supervisor_guidance.md'), 'utf-8');
    expect(guidanceForStageFromText(ledger, 'implement').map((entry) => entry.body)).toEqual(['implementation only', 'all stages']);
    expect(guidanceForStageFromText(ledger, 'plan').map((entry) => entry.body)).toEqual(['plan only', 'all stages']);
    expect(unknown).toMatchObject({ quarantined: true });
  });

  it('keeps foreign guidance out of the assembled stage prompt', () => {
    const projectDir = temporaryRoot();
    const runDir = join(projectDir, 'run');
    mkdirSync(runDir, { recursive: true });
    appendGuidanceEnvelope({ runDir, target: 'plan', source: 'supervisor', body: 'plan-only instruction', knownStageIds: ['plan', 'implement'] });
    appendGuidanceEnvelope({ runDir, target: 'implement', source: 'supervisor', body: 'implementation instruction', knownStageIds: ['plan', 'implement'] });
    const prompt = buildStagePrompt({
      dependsOn: [], promptTemplate: 'Implement the task.', projectDir, runId: 'test', runDir,
      stageId: 'implement',
    });
    expect(prompt).toContain('implementation instruction');
    expect(prompt).not.toContain('plan-only instruction');
  });

  it('preserves a legacy prefix during envelope migration and fails closed on foreign local ledgers', () => {
    const taskRunDir = temporaryRoot();
    mkdirSync(join(taskRunDir, 'stages', 'implement'), { recursive: true });
    writeFileSync(join(taskRunDir, 'supervisor_guidance.md'), '[plan]: legacy plan only\n\n[implement]: legacy implementation\n');
    appendGuidanceEnvelope({
      runDir: taskRunDir,
      target: 'implement',
      source: 'supervisor',
      body: 'new implementation',
      knownStageIds: ['plan', 'implement'],
    });
    expect(readGuidanceForStage(taskRunDir, 'implement').map((entry) => entry.body))
      .toEqual(['new implementation', 'legacy implementation']);
    expect(readGuidanceForStage(taskRunDir, 'plan').map((entry) => entry.body))
      .toEqual(['legacy plan only']);

    const foreign = appendGuidanceEnvelope({
      runDir: temporaryRoot(),
      target: 'plan',
      source: 'supervisor',
      body: 'must remain foreign',
      knownStageIds: ['plan', 'implement'],
    });
    writeFileSync(
      join(taskRunDir, 'stages', 'implement', 'guidance.md'),
      `<!-- flowcrew-guidance ${JSON.stringify({
        version: foreign.version,
        id: foreign.id,
        target: foreign.target,
        source: foreign.source,
        createdAt: foreign.createdAt,
      })} -->\n${foreign.body}\n`,
    );
    expect(readGuidanceForStage(taskRunDir, 'implement').map((entry) => entry.body))
      .toEqual(['new implementation', 'legacy implementation']);
  });
});

describe('canonical criteria and atomic dispatch admission', () => {
  it('extracts numbered report obligations with stable IDs', () => {
    const artifact = extractBriefCriteria([
      '# Goal',
      'Change the engine.',
      '## What the report must show',
      '1. Reproduce the guidance leak before and after.',
      '2. Report direct validation exit codes.',
      '',
      'Parenthetical examples are illustrative, not criteria.',
    ].join('\n'));
    expect(artifact.criteria).toHaveLength(2);
    expect(artifact.criteria[0]).toMatchObject({ line: 4, text: 'Reproduce the guidance leak before and after.' });
    expect(artifact.criteria[0].id).toMatch(/^criterion_what_the_report_must_/);
  });

  it('requires criterion worker+gate coverage, coherent repairs, and one terminal sink owner', () => {
    const criterionId = 'criterion_report_1_deadbeef';
    const plan = stage({ id: 'plan', role: 'planner', depends_on: [], dependency_reasons: {}, scope: [] });
    const work = stage({ id: 'work', role: 'coder', depends_on: ['plan'], dependency_reasons: { plan: 'Consumes the admitted plan.' }, scope: ['src/**'], criterion_refs: [criterionId] });
    const gate = stage({ id: 'verify', role: 'qa', depends_on: ['work'], dependency_reasons: { work: 'Audits the implementation.' }, scope: [], is_gate: true, criterion_refs: [criterionId] });
    const repair = stage({ id: 'repair', role: 'coder', depends_on: ['verify'], dependency_reasons: { verify: 'Consumes the rejected verdict.' }, scope: ['src/**'], retry_to: ['verify'] });
    const finalizer = stage({ id: 'finalize', role: 'writer', depends_on: ['verify'], dependency_reasons: { verify: 'Consumes the accepted gate evidence.' }, scope: ['docs/final.md'] });
    const criteria = { version: 1 as const, briefDigest: 'abc', criteria: [{ id: criterionId, text: 'Show the repair proof.', line: 1, section: 'Report' }] };
    const accepted = inspectDispatchAdmission({
      dispatched: [work, gate, repair, finalizer],
      baseStages: [plan],
      dispatchStageId: 'plan',
      terminalStates: { complete: { paths: ['docs/final.md'] } },
      criteria,
    });
    expect(accepted.pass, accepted.errors.join('\n')).toBe(true);
    expect(accepted.terminalOwners).toEqual({ 'docs/final.md': 'finalize' });

    const badOwner = stage({ ...work, scope: ['src/**', 'docs/final.md'] });
    const refused = inspectDispatchAdmission({
      dispatched: [badOwner, gate, repair, finalizer],
      baseStages: [plan],
      dispatchStageId: 'plan',
      terminalStates: { complete: { paths: ['docs/final.md'] } },
      criteria,
    });
    expect(refused.pass).toBe(false);
    expect(refused.errors.join('\n')).toMatch(/expected exactly one scoped owner/);

    const collidingFinalizer = stage({
      ...finalizer,
      scope: ['docs/complete/report.md', 'docs/escalated/report.md'],
    });
    const collision = inspectDispatchAdmission({
      dispatched: [work, gate, repair, collidingFinalizer],
      baseStages: [plan],
      dispatchStageId: 'plan',
      terminalStates: {
        complete: { paths: ['docs/complete/report.md'] },
        escalated: { paths: ['docs/escalated/report.md'] },
      },
      criteria,
    });
    expect(collision.errors.join('\n')).toContain('snapshot basename report.md');

    const reusedPath = inspectDispatchAdmission({
      dispatched: [work, gate, repair, finalizer],
      baseStages: [plan],
      dispatchStageId: 'plan',
      terminalStates: {
        complete: { paths: ['docs/final.md'] },
        escalated: { paths: ['docs/final.md'] },
      },
      criteria,
    });
    expect(reusedPath.errors.join('\n')).toContain('one path cannot encode multiple outcomes');
  });

  it('still rejects missing acting-stage transport and ordinary work without a downstream gate', () => {
    const criterionId = 'criterion_report_1_deadbeef';
    const criteria = { version: 1 as const, briefDigest: 'abc', criteria: [{
      id: criterionId, text: 'Show independently checked work.', line: 1, section: 'Report',
    }] };
    const work = stage({
      id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: ['src/**'],
      criterion_refs: [criterionId],
    });
    const gate = stage({
      id: 'verify', role: 'qa', depends_on: ['work'], dependency_reasons: { work: 'Audits work.' },
      scope: [], is_gate: true, criterion_refs: [criterionId],
    });

    const gateOnly = inspectDispatchAdmission({
      dispatched: [{ ...work, criterion_refs: [] }, gate],
      baseStages: [], dispatchStageId: 'plan', criteria,
    });
    expect(gateOnly.pass).toBe(false);
    expect(gateOnly.errors.join('\n')).toContain('not assigned to a capable work/finalizer stage');

    const ordinaryWithoutGate = inspectDispatchAdmission({
      dispatched: [work, { ...gate, criterion_refs: [] }],
      baseStages: [], dispatchStageId: 'plan', criteria,
    });
    expect(ordinaryWithoutGate.pass).toBe(false);
    expect(ordinaryWithoutGate.errors.join('\n')).toContain('not assigned to a gate');
  });

  it('rejects an unconditional research finalizer and malformed dynamic schema', () => {
    expect(() => parseDispatchedStageConfig({ id: 'work', role: 'coder' })).toThrow(/depends_on|scope/);
    const plan = stage({ id: 'plan', role: 'planner', depends_on: [], dependency_reasons: {}, scope: [] });
    const measure = stage({ id: 'measure', role: 'researcher', depends_on: ['plan'], dependency_reasons: { plan: 'Consumes the research plan.' }, scope: ['docs/round.json'] });
    const finalizer = stage({ id: 'finalize', role: 'writer', depends_on: ['measure'], dependency_reasons: { measure: 'Consumes the accepted measurement.' }, scope: ['docs/final.md'] });
    const report = inspectDispatchAdmission({
      dispatched: [measure, finalizer], baseStages: [plan], dispatchStageId: 'plan',
      terminalStates: { ceiling_hit: { paths: ['docs/final.md'] } },
      research: { baseline: 0, policy: 'best_of_n' },
    });
    expect(report.errors.join('\n')).toContain('must be mechanically false when research.decision is continue');

    const reserved = inspectDispatchAdmission({
      dispatched: [stage({
        id: 'research', role: 'researcher', depends_on: ['plan'],
        dependency_reasons: { plan: 'Consumes the research plan.' }, scope: ['docs/round.json'],
      })],
      baseStages: [plan], dispatchStageId: 'plan',
      research: { baseline: 0, policy: 'best_of_n' },
    });
    expect(reserved.errors.join('\n')).toContain('reserved for framework-owned research policy facts');
  });

  it('preserves explicit root dependencies instead of silently wiring them to the planner', () => {
    const root = stage({ id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: ['src/**'] });
    resolveDispatchDependencies([root], 'plan');
    expect(root.depends_on).toEqual([]);
    expect(root.dependency_reasons).toEqual({});
  });

  it('admits the exact recorded research proposal with one guarded writer per terminal path', () => {
    const fixture = recordedDispatchFixture('research_multi_writer');
    const report = inspectDispatchAdmission(fixture.admission);

    expect(report.pass, report.errors.join('\n')).toBe(true);
    expect(report.terminalOwners).toEqual({
      'docs/happymj_incumbent/ship_report.md': 'write_ship',
      'docs/happymj_incumbent/ceiling_report.md': 'write_ceiling',
      'docs/happymj_incumbent/escalation_note.md': 'write_escalation',
    });
    expect(report.criterionTerminalRefs).toMatchObject({
      write_ship: expect.arrayContaining([
        'criterion_what_each_round_s_report_9_f4d0b217',
        'criterion_what_each_round_s_report_10_24e8ca77',
      ]),
    });
    expect(Object.fromEntries(fixture.admission.dispatched.map((item) => [item.id, item.condition])))
      .toMatchObject({
        write_ship: 'research.decision == "ship"',
        write_ceiling: 'research.decision == "stop_ceiling"',
        write_escalation: 'research.terminalStatus == "escalated"',
      });
  });

  it('releases the recorded policy writers on the framework-emitted terminal facts', () => {
    const fixture = recordedDispatchFixture('research_multi_writer');
    const root = temporaryRoot();
    const previousStateRoot = fcGlobalDir();
    setFcGlobalDir(root);
    try {
      const taskRunDir = join(root, 'runs', 'run');
      mkdirSync(taskRunDir, { recursive: true });
      for (const expected of [
        { id: 'write_ship', decision: 'ship', terminalStatus: 'shipped' },
        { id: 'write_ceiling', decision: 'stop_ceiling', terminalStatus: 'ceiling_hit' },
      ]) {
        writeFileSync(join(taskRunDir, 'research_decision.json'), JSON.stringify(expected));
        const condition = fixture.admission.dispatched.find((item) => item.id === expected.id)?.condition;
        expect(condition).toBeTypeOf('string');
        expect(evaluateCondition(condition!, 'unused-project', 'run')).toBe(true);
      }
    } finally {
      setFcGlobalDir(previousStateRoot);
    }
  });

  it.each([
    ['diagram_extra_dist', 'finalize_report', ['dist/**']],
    ['diagram_extra_directory', 'finalize_diagram', ['docs/diagram_shape/**', 'dist/**']],
  ] as const)('admits exact recorded finalizer capability for %s as validation-only scope', (name, owner, scopes) => {
    const fixture = recordedDispatchFixture(name);
    const recorded = JSON.parse(readFileSync(join(
      import.meta.dirname, 'fixtures', 'dispatch-admission', name, 'recorded_admission.json',
    ), 'utf-8')) as { pass: boolean };
    expect(recorded.pass).toBe(false);

    const report = inspectDispatchAdmission(fixture.admission);
    expect(report.pass, report.errors.join('\n')).toBe(true);
    expect(report.terminalValidationScopes?.[owner]).toEqual(scopes);
  });

  it('keeps the exact already-admitted single-owner proposal admitted', () => {
    const fixture = recordedDispatchFixture('admitted_single_owner');
    const report = inspectDispatchAdmission(fixture.admission);
    expect(report.pass, report.errors.join('\n')).toBe(true);
    expect(report.terminalOwners).toEqual({
      'docs/task_ledger_staleness/final_verification.md': 'finalize_outcome',
      'docs/task_ledger_staleness/escalation_note.md': 'finalize_outcome',
    });
  });

  it('still rejects the exact recorded measuring-owner proposal', () => {
    const fixture = recordedDispatchFixture('research_measuring_owner');
    const report = inspectDispatchAdmission(fixture.admission);
    expect(report.pass).toBe(false);
    expect(report.errors.join('\n')).toContain('expected exactly one scoped owner');
  });

  it('mechanically rejects a sole terminal owner that also owns the research result', () => {
    const measureAndFinalize = stage({
      id: 'measure', role: 'researcher', depends_on: [], dependency_reasons: {},
      scope: ['docs/round.json', 'docs/final.md'],
      condition: 'research.decision != continue',
    });
    const report = inspectDispatchAdmission({
      dispatched: [measureAndFinalize], baseStages: [], dispatchStageId: 'plan',
      terminalStates: { complete: { paths: ['docs/final.md'] } },
      research: { baseline: 0, policy: 'best_of_n', resultFile: 'docs/round.json' },
    });
    expect(report.pass).toBe(false);
    expect(report.errors.join('\n')).toMatch(/terminal owner measure.*research result.*docs\/round\.json/);
  });

  it.each([
    'research.decision == continue',
    'research.decision != shipped',
    'research.decision == invented_terminal',
  ])('mechanically rejects a terminal predicate that does not prove exclusion on continue: %s', (condition) => {
    const finalizer = stage({
      id: 'finalize', role: 'writer', depends_on: [], dependency_reasons: {},
      scope: ['docs/final.md'], condition,
    });
    const report = inspectDispatchAdmission({
      dispatched: [finalizer], baseStages: [], dispatchStageId: 'plan',
      terminalStates: { complete: { paths: ['docs/final.md'] } },
      research: { baseline: 0, policy: 'best_of_n' },
    });
    expect(report.pass).toBe(false);
    expect(report.errors.join('\n')).toContain('must be mechanically false when research.decision is continue');
  });
});

describe('gate settlement and research evidence', () => {
  it('does not advance a round while a gate, stage, or supervisor rejection is unsettled', () => {
    expect(researchAdvanceEligible({ gatesSettled: false, stageFailed: false, supervisorRejectPending: false })).toBe(false);
    expect(researchAdvanceEligible({ gatesSettled: true, stageFailed: true, supervisorRejectPending: false })).toBe(false);
    expect(researchAdvanceEligible({ gatesSettled: true, stageFailed: false, supervisorRejectPending: true })).toBe(false);
    expect(researchAdvanceEligible({ gatesSettled: true, stageFailed: false, supervisorRejectPending: false })).toBe(true);
  });

  it('treats contradictory pass/repair fields and missing criterion evidence as rejection', () => {
    const project = temporaryRoot();
    const docs = join(project, 'docs');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'verdict_qa.json'), JSON.stringify({ pass: true, outcome: 'repair-required' }));
    expect(readGateVerdict(project, 'qa')).toMatchObject({ pass: false, reason: expect.stringContaining('contradiction') });

    writeFileSync(join(docs, 'dispatch_admission.json'), JSON.stringify({ version: 1, pass: true, terminalOwners: {}, errors: [], checkedAt: 'now', criterionGateRefs: { qa: ['c1'] } }));
    writeFileSync(join(docs, 'verdict_qa.json'), JSON.stringify({ pass: true }));
    expect(readGateVerdict(project, 'qa')).toMatchObject({ pass: false, reason: expect.stringContaining('missing criteria evidence') });
  });

  it('treats a no-candidate round as no improvement without a fake baseline metric or ship', () => {
    const evaluated = evaluateResearch(
      { baseline: 10, policy: 'best_of_n', stop: { beat: 9, maxRounds: 2 } },
      [{ label: 'no_safe_action', outcome: 'no_candidate', reason: 'all candidates violated a hard constraint' }],
    );
    expect(evaluated).toMatchObject({ runningBest: 10, keptLabels: [], latestKept: false, decision: 'continue' });
  });

  it('journals the no-candidate sidecar with its discriminator and no numeric result', async () => {
    const projectDir = temporaryRoot();
    const taskRunDir = join(projectDir, 'run');
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    mkdirSync(taskRunDir, { recursive: true });
    const sidecar = join(projectDir, 'docs', 'round.json.no_candidate.json');
    writeFileSync(sidecar, JSON.stringify({
      outcome: 'no_candidate', label: 'round_without_action', reason: 'every candidate violated a hard constraint', evidence: { rejected: 4 },
    }));
    const state = {
      runId: 'run', workflowName: 'test', projectDir, status: 'running', stages: {},
      startedAt: new Date(Date.now() - 1000).toISOString(),
      research: { baseline: 10, policy: 'best_of_n', resultFile: 'docs/round.json', reportDir: 'docs', stop: { maxRounds: 2 } },
    } as StoreState;
    await tryAdvanceResearch(state, { projectDir, runId: 'run', runDirPath: taskRunDir, iteration: 1, adapter: inertAdapter });
    const journal = JSON.parse(readFileSync(join(taskRunDir, 'research_journal.json'), 'utf-8')) as { rounds: Array<Record<string, unknown>> };
    expect(journal.rounds[0]).toMatchObject({ outcome: 'no_candidate', label: 'round_without_action', evidence: { rejected: 4 } });
    expect(journal.rounds[0]).not.toHaveProperty('result');
  });

  it('treats a journal label as immutable even when the shared result value changes', async () => {
    const projectDir = temporaryRoot();
    const taskRunDir = join(projectDir, 'run');
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    mkdirSync(taskRunDir, { recursive: true });
    writeFileSync(join(projectDir, 'docs', 'round.json'), JSON.stringify({ label: 'round_1', result: 12 }));
    writeFileSync(join(taskRunDir, 'research_journal.json'), JSON.stringify({
      rounds: [{ label: 'round_1', result: 11, outcome: 'measured' }],
    }));
    const state = {
      runId: 'run', workflowName: 'test', projectDir, status: 'running', stages: {},
      startedAt: new Date(Date.now() - 1000).toISOString(),
      research: { baseline: 10, policy: 'best_of_n', resultFile: 'docs/round.json', reportDir: 'docs', stop: { maxRounds: 3 } },
    } as StoreState;

    await tryAdvanceResearch(state, {
      projectDir, runId: 'run', runDirPath: taskRunDir, iteration: 2, adapter: inertAdapter,
    });

    const journal = JSON.parse(readFileSync(join(taskRunDir, 'research_journal.json'), 'utf-8')) as { rounds: Array<Record<string, unknown>> };
    expect(journal.rounds).toEqual([{ label: 'round_1', result: 11, outcome: 'measured' }]);
    expect(readFileSync(join(taskRunDir, 'supervisor_guidance.md'), 'utf-8')).toContain('immutable identity');
  });

  it('never converts an exhausted or unaddressed REJECT into acceptance', () => {
    expect(decideRejectAction({ targetStage: 'work', reason: 'still false' }, 'work', 2, 2).action).toBe('escalate');
    expect(decideRejectAction({ targetStage: null, reason: 'unknown target' }, null, 0, 2).action).toBe('escalate');
  });

  it('routes a supervisor-rejected gate through its admitted repair stage', () => {
    const projectDir = temporaryRoot();
    const previousStateRoot = fcGlobalDir();
    setFcGlobalDir(join(projectDir, 'fc-home'));
    try {
      const runId = 'supervisor-gate-reject';
      const taskRunDir = runDir(projectDir, runId);
      mkdirSync(join(taskRunDir, 'signals'), { recursive: true });
      const verify = stage({ id: 'verify', role: 'qa', depends_on: ['work'], dependency_reasons: { work: 'Audits work.' }, scope: [], is_gate: true });
      const repair = stage({ id: 'repair', role: 'coder', depends_on: ['verify'], dependency_reasons: { verify: 'Repairs rejection.' }, scope: ['src/**'], retry_to: ['verify'] });
      const state = {
        runId, workflowName: 'test', projectDir, status: 'running', startedAt: new Date().toISOString(),
        stages: {
          work: { status: 'complete', retries: 0 },
          verify: { status: 'complete', retries: 0, completedAt: new Date().toISOString() },
          repair: { status: 'skipped', retries: 0 },
        },
      } as StoreState;
      writeRunState(projectDir, runId, state);
      writeFileSync(join(taskRunDir, 'verdict_verify.json'), JSON.stringify({ pass: true }));
      writeFileSync(join(taskRunDir, 'signals', 'reject_verify.json'), JSON.stringify({ stage: 'verify', reason: 'criterion evidence is incomplete' }));

      expect(consumeSupervisorReject(state, [verify, repair], ['verify', 'repair'], {
        projectDir, runId, runDirPath: taskRunDir, iteration: 1,
      })).toBe(true);
      expect(JSON.parse(readFileSync(join(taskRunDir, 'verdict_verify.json'), 'utf-8'))).toMatchObject({
        pass: false, outcome: 'repair-required', source: 'supervisor_reject',
      });
      expect(state.stages.repair.status).toBe('pending');
      expect(readFileSync(join(taskRunDir, 'supervisor_guidance.md'), 'utf-8')).toContain('"target":"repair"');
      expect(existsSync(join(taskRunDir, 'supervisor_rejections', 'verify', 'reject_1', 'verdict_before.json'))).toBe(true);
    } finally {
      setFcGlobalDir(previousStateRoot);
    }
  });

  it('rejects a terminal artifact that contradicts the settled research terminal path', async () => {
    const projectDir = temporaryRoot();
    const taskRunDir = join(projectDir, 'run');
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    mkdirSync(taskRunDir, { recursive: true });
    const startedAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(join(projectDir, 'docs', 'ship.md'), '# premature ship\n');
    writeFileSync(join(taskRunDir, 'research_decision.json'), JSON.stringify({
      decision: 'stop_ceiling', terminalStatus: 'ceiling_hit', terminalPath: 'docs/ceiling.md', terminalOwner: 'finalize',
    }));
    writeFileSync(join(taskRunDir, 'dispatch_admission.json'), JSON.stringify({
      version: 1, pass: true, checkedAt: new Date().toISOString(), errors: [],
      terminalOwners: { 'docs/ship.md': 'finalize', 'docs/ceiling.md': 'finalize' },
    }));
    const state = {
      runId: 'run', workflowName: 'test', projectDir, status: 'running', startedAt,
      research: { baseline: 0, policy: 'best_of_n' },
      terminalStates: {
        shipped: { paths: ['docs/ship.md'] }, ceiling_hit: { paths: ['docs/ceiling.md'] },
      },
      stages: {
        finalize: {
          status: 'complete', retries: 0,
          attempts: [{ index: 0, status: 'complete', startedAt, writes: ['docs/ship.md'] }],
        },
      },
    } as StoreState;
    const result = await tryTerminateOnTerminalState(state, {
      projectDir, runId: 'run', runDirPath: taskRunDir, iteration: 1, adapter: inertAdapter,
    });
    expect(result.decision).toBe('deferred');
    expect(existsSync(join(projectDir, 'docs', 'ship.md'))).toBe(false);
    expect(readdirSync(taskRunDir).some((name) => name.startsWith('wrong_terminal_shipped_ship.md'))).toBe(true);
  });

  it('quarantines multiple non-research terminal outcomes and re-pends their sole owner', async () => {
    const projectDir = temporaryRoot();
    const taskRunDir = join(projectDir, 'run');
    const startedAt = new Date(Date.now() - 1000).toISOString();
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    mkdirSync(taskRunDir, { recursive: true });
    writeFileSync(join(projectDir, 'docs', 'final.md'), '# complete\n');
    writeFileSync(join(projectDir, 'docs', 'escalation.md'), '# escalated\n');
    writeFileSync(join(taskRunDir, 'dispatch_admission.json'), JSON.stringify({
      version: 1, pass: true, checkedAt: new Date().toISOString(), errors: [],
      terminalOwners: { 'docs/final.md': 'finalize', 'docs/escalation.md': 'finalize' },
    }));
    const state = {
      runId: 'run', workflowName: 'test', projectDir, status: 'running', startedAt,
      terminalStates: {
        complete: { paths: ['docs/final.md'] },
        escalated: { paths: ['docs/escalation.md'] },
      },
      stages: {
        finalize: {
          status: 'complete', retries: 0,
          attempts: [{
            index: 0, status: 'complete', startedAt,
            writes: ['docs/final.md', 'docs/escalation.md'],
          }],
        },
      },
    } as StoreState;
    const result = await tryTerminateOnTerminalState(state, {
      projectDir, runId: 'run', runDirPath: taskRunDir, iteration: 1, adapter: inertAdapter,
    });
    expect(result.decision).toBe('deferred');
    expect(state.status).toBe('running');
    expect(state.stages.finalize.status).toBe('pending');
    expect(existsSync(join(projectDir, 'docs', 'final.md'))).toBe(false);
    expect(existsSync(join(projectDir, 'docs', 'escalation.md'))).toBe(false);
    expect(readdirSync(taskRunDir).filter((name) => name.startsWith('ambiguous_terminal_'))).toHaveLength(2);
  });

  it('re-pends every implicated owner when path-specific terminal writers emit conflicting outcomes', async () => {
    const projectDir = temporaryRoot();
    const taskRunDir = join(projectDir, 'run');
    const startedAt = new Date(Date.now() - 1000).toISOString();
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    mkdirSync(join(taskRunDir, 'stages', 'finish', 'placeholder'), { recursive: true });
    mkdirSync(join(taskRunDir, 'stages', 'escalate', 'placeholder'), { recursive: true });
    writeFileSync(join(projectDir, 'docs', 'final.md'), '# complete\n');
    writeFileSync(join(projectDir, 'docs', 'escalation.md'), '# escalated\n');
    writeFileSync(join(taskRunDir, 'dispatch_admission.json'), JSON.stringify({
      version: 1, pass: true, checkedAt: new Date().toISOString(), errors: [],
      terminalOwners: { 'docs/final.md': 'finish', 'docs/escalation.md': 'escalate' },
    }));
    const complete = (path: string): StageStatus => ({
      status: 'complete', retries: 0,
      attempts: [{ index: 1, status: 'complete', startedAt, writes: [path] }],
    });
    const state = {
      runId: 'run', workflowName: 'test', projectDir, status: 'running', startedAt,
      terminalStates: {
        complete: { paths: ['docs/final.md'] },
        escalated: { paths: ['docs/escalation.md'] },
      },
      stages: {
        finish: complete('docs/final.md'),
        escalate: complete('docs/escalation.md'),
      },
    } as StoreState;
    writeRunState(projectDir, 'run', state);

    const result = await tryTerminateOnTerminalState(state, {
      projectDir, runId: 'run', runDirPath: taskRunDir, iteration: 1, adapter: inertAdapter,
    });

    expect(result.decision).toBe('deferred');
    expect(state.stages.finish.status).toBe('pending');
    expect(state.stages.escalate.status).toBe('pending');
    const guidance = readFileSync(join(taskRunDir, 'supervisor_guidance.md'), 'utf-8');
    expect(guidance).toContain('"target":"finish"');
    expect(guidance).toContain('"target":"escalate"');
  });
});

describe('persistent blockers and quiet active commands', () => {
  it('marks the third identical blockage as a one-time escalation', () => {
    const runDir = temporaryRoot();
    expect(recordBlockageOccurrence({ runDir, kind: 'gate', detail: 'same cause', now: '2026-01-01T00:00:00Z' }).escalatedNow).toBe(false);
    expect(recordBlockageOccurrence({ runDir, kind: 'gate', detail: ' same   cause ', now: '2026-01-01T00:00:01Z' }).escalatedNow).toBe(false);
    const third = recordBlockageOccurrence({ runDir, kind: 'gate', detail: 'SAME CAUSE', now: '2026-01-01T00:00:02Z' });
    expect(third).toMatchObject({ escalatedNow: true, occurrence: { consecutive: 3 } });
    expect(recordBlockageOccurrence({ runDir, kind: 'gate', detail: 'same cause', now: '2026-01-01T00:00:03Z' }).escalatedNow).toBe(false);
  });

  it('resets the blockage streak when rejected evidence or repair evidence changes', () => {
    const runDir = temporaryRoot();
    recordBlockageOccurrence({ runDir, kind: 'gate', detail: 'same cause', evidenceDigest: 'a', repairDigest: 'repair-a' });
    expect(recordBlockageOccurrence({ runDir, kind: 'gate', detail: 'same cause', evidenceDigest: 'a', repairDigest: 'repair-a' }).occurrence.consecutive).toBe(2);
    expect(recordBlockageOccurrence({ runDir, kind: 'gate', detail: 'same cause', evidenceDigest: 'b', repairDigest: 'repair-a' }).occurrence.consecutive).toBe(1);
    expect(recordBlockageOccurrence({ runDir, kind: 'gate', detail: 'same cause', evidenceDigest: 'b', repairDigest: 'repair-b' }).occurrence.consecutive).toBe(1);
  });

  it('escalates the run on the third unchanged supervisor rejection', () => {
    const projectDir = temporaryRoot();
    const previousStateRoot = fcGlobalDir();
    setFcGlobalDir(join(projectDir, 'fc-home'));
    try {
      const runId = 'unchanged-supervisor-reject';
      const taskRunDir = runDir(projectDir, runId);
      const work = stage({
        id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: ['src/**'],
      });
      const state = {
        runId, workflowName: 'test', projectDir, status: 'running',
        startedAt: new Date().toISOString(),
        campaignTriggers: { repeatedFailureAfter: 3 },
        stages: { work: { status: 'complete', retries: 0, completedAt: new Date().toISOString() } },
      } as StoreState;
      mkdirSync(taskRunDir, { recursive: true });
      writeRunState(projectDir, runId, state);
      mkdirSync(join(taskRunDir, 'signals'), { recursive: true });
      mkdirSync(join(taskRunDir, 'stages', 'work'), { recursive: true });
      writeFileSync(join(taskRunDir, 'stages', 'work', 'output.md'), 'unchanged rejected evidence\n');

      for (let observation = 1; observation <= 3; observation += 1) {
        state.stages.work = {
          ...state.stages.work,
          status: 'complete',
          completedAt: new Date().toISOString(),
        };
        writeRunState(projectDir, runId, state);
        writeFileSync(join(taskRunDir, 'signals', 'reject_work.json'), JSON.stringify({
          stage: 'work', reason: 'the same evidence is still invalid',
        }));
        const rework = consumeSupervisorReject(state, [work], ['work'], {
          projectDir, runId, runDirPath: taskRunDir, iteration: observation,
        });
        expect(rework).toBe(observation < 3);
      }

      expect(state.status).toBe('escalated');
      expect(state.failureReason).toContain('3 consecutive observations');
      expect(existsSync(join(taskRunDir, 'signals', 'repeated_blockage.json'))).toBe(true);
    } finally {
      setFcGlobalDir(previousStateRoot);
    }
  });

  it('protects only a current-attempt command between start and completion', () => {
    const runDir = temporaryRoot();
    const attemptStartedAt = '2026-01-01T00:00:00.000Z';
    const status: StageStatus = {
      status: 'running', retries: 0,
      attempts: [{ index: 0, status: 'running', startedAt: attemptStartedAt }],
    };
    const tracker = new CommandActivityTracker({ runDir, stageId: 'work', attemptIndex: 0, attemptStartedAt });
    tracker.feed(`${JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test > /tmp/test.log 2>&1' } })}\n`);
    expect(inspectStageExecutionFacts({ runDir, stageId: 'work', status, sinceMs: Date.now() }).protectedFromIdleAbort).toBe(true);
    tracker.feed(`${JSON.stringify({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution' } })}\n`);
    const completed = inspectStageExecutionFacts({ runDir, stageId: 'work', status, sinceMs: Date.now() });
    expect(completed).toMatchObject({ activeCommandCount: 0, commandActivityValid: true, protectedFromIdleAbort: false });
  });

  it('never grants idle protection for missing or malformed lifecycle evidence', () => {
    const runDir = temporaryRoot();
    const attemptStartedAt = '2026-01-01T00:00:00.000Z';
    const status: StageStatus = {
      status: 'running', retries: 0,
      attempts: [{ index: 0, status: 'running', startedAt: attemptStartedAt }],
    };
    expect(inspectStageExecutionFacts({ runDir, stageId: 'work', status, sinceMs: Date.now() }))
      .toMatchObject({ commandActivityValid: false, activeCommandCount: 0, protectedFromIdleAbort: false });
    mkdirSync(join(runDir, 'stages', 'work'), { recursive: true });
    writeFileSync(join(runDir, 'stages', 'work', 'command_activity.json'), '{not-json');
    expect(inspectStageExecutionFacts({ runDir, stageId: 'work', status, sinceMs: Date.now() }))
      .toMatchObject({ commandActivityValid: false, activeCommandCount: 0, protectedFromIdleAbort: false });
  });
});

describe('temporal tests, output inventory, reachability, and stage prose', () => {
  it('rejects tests that pin mutable round state or require terminal absence', () => {
    const projectDir = temporaryRoot();
    mkdirSync(join(projectDir, 'spec'), { recursive: true });
    writeFileSync(join(projectDir, 'spec', 'round.test.ts'), [
      "const resultFile = 'docs/round_result.json';",
      "expect(read(resultFile).label).toBe('round_3');",
      "expect(existsSync('docs/final.md')).toBe(false);",
    ].join('\n'));
    const findings = inspectTemporalResearchTests({
      projectDir,
      writes: ['spec/round.test.ts'],
      resultFile: 'docs/round_result.json',
      terminalPaths: ['docs/final.md'],
    });
    expect(findings.map((finding) => finding.kind).sort()).toEqual(['asserts_terminal_absence', 'pins_shared_result']);
  });

  it('blocks an occupied create-only output, permits explicit update, and never trusts a symlink', () => {
    const projectDir = temporaryRoot();
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    writeFileSync(join(projectDir, 'docs', 'old.json'), 'x'.repeat(286 * 1024));
    writeFileSync(join(projectDir, 'docs', 'update.json'), '{"old":true}');
    symlinkSync('old.json', join(projectDir, 'docs', 'terminal.md'));
    const brief = [
      '---',
      'outputs:',
      '  - path: docs/old.json',
      '  - path: docs/update.json',
      '    on_existing: update',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/terminal.md]',
      '---',
      '# Goal',
      'Produce outputs.',
    ].join('\n');
    const inventory = inspectBriefOutputs(brief, projectDir);
    expect(inventory.entries.find((entry) => entry.path === 'docs/old.json')).toMatchObject({ blocking: true, size: 286 * 1024 });
    expect(inventory.entries.find((entry) => entry.path === 'docs/update.json')).toMatchObject({ blocking: false, disposition: 'update' });
    expect(inventory.entries.find((entry) => entry.path === 'docs/terminal.md')).toMatchObject({ blocking: true, entryType: 'symlink' });
  });

  it('distinguishes a file-shaped output from a directory-shaped report root', () => {
    const projectDir = temporaryRoot();
    mkdirSync(join(projectDir, 'docs', 'result.json'), { recursive: true });
    mkdirSync(join(projectDir, 'docs', 'reports'), { recursive: true });
    const brief = [
      '---',
      'research:',
      '  result_file: docs/result.json',
      '  report_dir: docs/reports',
      '---',
      '# Goal',
    ].join('\n');
    const inventory = inspectBriefOutputs(brief, projectDir);
    expect(inventory.entries.find((entry) => entry.path === 'docs/result.json')).toMatchObject({
      expectedType: 'file', entryType: 'directory', blocking: true,
    });
    expect(inventory.entries.find((entry) => entry.path === 'docs/reports')).toMatchObject({
      expectedType: 'directory', entryType: 'directory', blocking: false,
    });
  });

  it('refuses absent hard-check paths with no emitter and ignores prose that only discusses stages', () => {
    const projectDir = temporaryRoot();
    const work = stage({ id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: ['docs/generated.json'] });
    const markdown = [
      '## Reality checks',
      '```yaml',
      'checks:',
      '  - name: future file',
      '    type: json-schema-match',
      '    params:',
      '      file: docs/not_owned.json',
      '      schema: {type: object}',
      '```',
    ].join('\n');
    expect(inspectRealityCheckReachability({ markdown, projectDir, stages: [work] }).join('\n')).toContain('no admitted stage');

    const execMarkdown = [
      '## Reality checks',
      '```yaml',
      'checks:',
      '  - name: future script file',
      '    type: exec-script-exit-zero',
      '    params:',
      '      script: |',
      '        artifact="docs/not_owned_from_script.json"',
      '        test -s "$artifact"',
      '```',
    ].join('\n');
    expect(inspectRealityCheckReachability({ markdown: execMarkdown, projectDir, stages: [work] }).join('\n'))
      .toContain('docs/not_owned_from_script.json');

    const evidenceBrief = [
      '# Stop the orchestration contract from producing these failure classes',
      '- Guidance addressed to one stage is delivered to another stage.',
      '- Prose that discusses stages is parsed as a stage assignment.',
    ].join('\n');
    expect(inspectBrief(evidenceBrief).findings.some((finding) => finding.code === 'stage_writable_paths_missing')).toBe(false);
    expect(inspectBrief('# Stage 1 — implementation\nImplement the change.').findings.some((finding) => finding.code === 'stage_writable_paths_missing')).toBe(true);
    expect(inspectBrief('The QA stage must write docs/verdict.md.').findings.some((finding) => finding.code === 'stage_writable_paths_missing')).toBe(true);
    expect(inspectBrief('The QA stage must not write project files.').findings.some((finding) => finding.code === 'stage_writable_paths_missing')).toBe(false);

    const finalizer = stage({ id: 'finalize', role: 'writer', depends_on: ['work'], dependency_reasons: { work: 'Consumes work.' }, scope: ['docs/final.md'] });
    const late = stage({ id: 'late', role: 'writer', depends_on: ['finalize'], dependency_reasons: { finalize: 'Runs too late.' }, scope: ['docs/future.json'] });
    const lateMarkdown = markdown.replace('docs/not_owned.json', 'docs/future.json');
    expect(inspectRealityCheckReachability({
      markdown: lateMarkdown,
      projectDir,
      stages: [work, finalizer, late],
      terminalStates: { complete: { paths: ['docs/final.md'] } },
    }).join('\n')).toContain('no producer is an ancestor of every terminal owner');

    const optionalResultMarkdown = markdown.replace('docs/not_owned.json', 'docs/round.json');
    expect(inspectRealityCheckReachability({
      markdown: optionalResultMarkdown,
      projectDir,
      stages: [work],
      research: { baseline: 0, policy: 'best_of_n', resultFile: 'docs/round.json', reportDir: 'docs' },
    }).join('\n')).toContain('valid no-candidate round writes only its sidecar');
  });
});
