import { runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { artifacts, stageArtifacts  } from './spec_contracts/declared-fixtures.js';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { evaluateCondition } from '../src/condition.js';
import {
  appendGuidanceEnvelope,
  guidanceForStageFromText,
  readGuidanceForStage,
  RUN_WIDE_GUIDANCE_TARGET,
} from '../src/guidance.js';
import { inspectDispatchAdmission, inspectRealityCheckReachability, parseDispatchedStageConfig, readGateEvaluation, resolveDispatchDependencies, tryTerminateOnTerminalState } from '../src/scheduler.js';
import { inspectBriefOutputs } from '../src/ship-inputs.js';
import { recordBlockageOccurrence } from '../src/blockage-ledger.js';
import { CommandActivityTracker } from '../src/command-activity.js';
import { inspectStageExecutionFacts } from '../src/stage-watchdog.js';
import { buildStagePrompt } from '../src/handoff.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readRunState, runDir, setFcGlobalDir, writeRunState } from '../src/store.js';
import type { StoreState, StageStatus } from '../src/store.js';
import type { Adapter } from '../src/adapters/base.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';

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
  artifact_contract: stageArtifacts(String(raw.id), raw.is_gate === true),
  prompt_template: 'bounded test stage',
  skills: [],
  is_gate: false,
  criterion_refs: [],
  ...raw,
});

const inertAdapter: Adapter = {
  run: async () => ({ output: '', exitCode: 0, duration_ms: 0 }),
};

describe('addressed guidance envelopes', () => {
  it('delivers only exact-target and explicit run-wide entries and quarantines unknown targets', () => {
    const runDir = temporaryRoot();
    appendGuidanceEnvelope({ runDir, target: 'plan', source: 'supervisor', body: 'plan only', knownStageIds: ['plan', 'implement'], createdAt: '2026-01-01T00:00:00.000Z' });
    appendGuidanceEnvelope({ runDir, target: 'implement', source: 'supervisor', body: 'implementation only', knownStageIds: ['plan', 'implement'], createdAt: '2026-01-01T00:00:01.000Z' });
    appendGuidanceEnvelope({ runDir, target: RUN_WIDE_GUIDANCE_TARGET, source: 'operator', body: 'all stages', createdAt: '2026-01-01T00:00:02.000Z' });
    const unknown = appendGuidanceEnvelope({ runDir, target: 'missing', source: 'supervisor', body: 'must not leak', knownStageIds: ['plan', 'implement'], createdAt: '2026-01-01T00:00:03.000Z' });

    const ledger = readFileSync(runRecordPath(runDir, 'supervisor_guidance.md'), 'utf-8');
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
    mkdirSync(runRecordPath(taskRunDir, 'stages', 'implement'), { recursive: true });
    writeFileSync(runRecordPath(taskRunDir, 'supervisor_guidance.md'), '[plan]: legacy plan only\n\n[implement]: legacy implementation\n');
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
      runRecordPath(taskRunDir, 'stages', 'implement', 'guidance.md'),
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
  it('reads authored criterion identities independently of report headings', () => {
    const artifact = extractBriefCriteria("---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Reproduce the guidance leak before and after.\"},{\"id\":\"fixture_2\",\"text\":\"Report direct validation exit codes.\"}]\n---\n# Goal\nChange the engine.\n## What the report must show\n1. Reproduce the guidance leak before and after.\n2. Report direct validation exit codes.\n\nParenthetical examples are illustrative, not criteria.");
    expect(artifact.criteria).toHaveLength(2);
    expect(artifact.criteria[0]).toMatchObject({ line: 1, text: 'Reproduce the guidance leak before and after.' });
    expect(artifact.criteria[0].id).toBe('fixture_1');
  });

  it('preserves terminal outcome identity while allowing ordered authors and repairs', () => {
    const criterionId = 'criterion_report_1_deadbeef';
    const plan = stage({ criterion_refs: [], artifact_contract: artifacts([], [], []), id: 'plan', role: 'planner', depends_on: [], dependency_reasons: {}, scope: [] });
    const work = stage({ artifact_contract: artifacts([], [], []), id: 'work', role: 'coder', depends_on: ['plan'], dependency_reasons: { plan: 'Consumes the admitted plan.' }, scope: ['src/**'], criterion_refs: [criterionId] });
    const gate = stage({ artifact_contract: artifacts([{ id: 'verdict', root: 'run', path: "verdict_verify.json" }], [], []), id: 'verify', role: 'qa', depends_on: ['work'], dependency_reasons: { work: 'Audits the implementation.' }, scope: [], is_gate: true, criterion_refs: [criterionId] });
    const repair = stage({ criterion_refs: [], artifact_contract: artifacts([], [], []), id: 'repair', role: 'coder', depends_on: ['verify'], dependency_reasons: { verify: 'Consumes the rejected verdict.' }, scope: ['src/**'], retry_to: ['verify'] });
    const finalizer = stage({ criterion_refs: [], artifact_contract: artifacts([], [], []), id: 'finalize', role: 'writer', depends_on: ['verify'], dependency_reasons: { verify: 'Consumes the accepted gate evidence.' }, scope: ['docs/final.md', 'dist/**'] });
    const criteria = { version: 1 as const, briefDigest: 'abc', criteria: [{ id: criterionId, text: 'Show the repair proof.', line: 1, section: 'Report' }] };
    const accepted = inspectDispatchAdmission({
      dispatched: [work, gate, repair, finalizer],
      baseStages: [plan],
      dispatchStageId: 'plan',
      criteria,
    });
    expect(accepted.pass, accepted.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toBe(true);

    const badOwner = stage({ ...work, scope: ['src/**', 'docs/final.md'] });
    const shared = inspectDispatchAdmission({
      dispatched: [badOwner, gate, { ...repair, scope: ['src/**', 'docs/final.md'] }, finalizer],
      baseStages: [plan],
      dispatchStageId: 'plan',
      criteria,
    });
    expect(shared.pass, shared.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toBe(true);


  });

  it('assigns conservative coverage and refuses ordinary work without a downstream gate', () => {
    const criterionId = 'criterion_report_1_deadbeef';
    const criteria = { version: 1 as const, briefDigest: 'abc', criteria: [{
      id: criterionId, text: 'Show independently checked work.', line: 1, section: 'Report',
    }] };
    const work = stage({ artifact_contract: artifacts([], [], []),
      id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: ['src/**'],
      criterion_refs: [criterionId],
    });
    const gate = stage({ artifact_contract: artifacts([{ id: 'verdict', root: 'run', path: "verdict_verify.json" }], [], []),
      id: 'verify', role: 'qa', depends_on: ['work'], dependency_reasons: { work: 'Audits work.' },
      scope: [], is_gate: true, criterion_refs: [criterionId],
    });

    const gateOnly = inspectDispatchAdmission({
      dispatched: [{ ...work, criterion_refs: [] }, gate, stage({ id: 'repair', role: 'coder', scope: ['src/**'],
        depends_on: ['verify'], dependency_reasons: { verify: 'Correct rejected work.' }, retry_to: ['verify'], criterion_refs: [] })],
      baseStages: [], dispatchStageId: 'plan', criteria,
    });
    expect(gateOnly.pass).toBe(true);

    const ordinaryWithoutGate = inspectDispatchAdmission({
      dispatched: [work],
      baseStages: [], dispatchStageId: 'plan', criteria,
    });
    expect(ordinaryWithoutGate.pass).toBe(false);
    expect(ordinaryWithoutGate.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('not assigned to a gate');
  });

  it('rejects a malformed dynamic scope declaration', () => {
    expect(() => parseDispatchedStageConfig({id:'work',role:'coder',scope:'src/**'})).toThrow(/scope/);
  });

  it('preserves explicit root dependencies instead of silently wiring them to the planner', () => {
    const root = stage({ criterion_refs: [], artifact_contract: artifacts([], [], []), id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: ['src/**'] });
    resolveDispatchDependencies([root], 'plan');
    expect(root.depends_on).toEqual([]);
    expect(root.dependency_reasons).toEqual({});
  });
});

describe('gate settlement and research evidence', () => {

  it('treats contradictory pass/repair fields and missing criterion evidence as rejection', () => {
    const project = temporaryRoot();
    const docs = join(project, 'docs');
    mkdirSync(docs, { recursive: true });
    writeFileSync(runRecordPath(docs, 'verdict_qa.json'), JSON.stringify({ pass: true, requires_repair: true }));
    expect(readGateEvaluation(project, 'qa')).toMatchObject({ pass: false, reason: expect.stringContaining('contradiction') });

    writeFileSync(runRecordPath(docs, 'dispatch_admission.json'), JSON.stringify({ version: 1, pass: true, terminalOwners: {}, errors: [], checkedAt: 'now', criterionGateRefs: { qa: ['c1'] } }));
    writeFileSync(runRecordPath(docs, 'verdict_qa.json'), JSON.stringify({ pass: true }));
    expect(readGateEvaluation(project, 'qa')).toMatchObject({ pass: false, reason: expect.stringContaining('missing criteria evidence') });
  });

  it('quarantines ambiguous terminal outcomes without selecting a stage to repeat', async () => {
    const projectDir = temporaryRoot();
    const { runId, runDirPath: taskRunDir } = createRun(projectDir, 'test', 'name: test\nstages: []\n', ['finalize'], '---\nterminal_states: {complete: docs/final.md, escalated: docs/escalation.md}\n---\n');
    const startedAt = new Date(Date.now() - 1000).toISOString();
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    mkdirSync(taskRunDir, { recursive: true });
    writeFileSync(join(projectDir, 'docs', 'final.md'), '# complete\n');
    writeFileSync(join(projectDir, 'docs', 'escalation.md'), '# escalated\n');
    writeFileSync(runRecordPath(taskRunDir, 'dispatch_admission.json'), JSON.stringify({
      version: 1, pass: true, checkedAt: new Date().toISOString(), errors: [],
      terminalOwners: { 'docs/final.md': 'finalize', 'docs/escalation.md': 'finalize' },
    }));
    const state = {
      ...readRunState(projectDir, runId),
      runId, workflowName: 'test', projectDir, status: 'running', startedAt,
      terminalArtifactBaselines: {},
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
    writeRunState(projectDir, runId, state);
    const result = await tryTerminateOnTerminalState(state, {
      projectDir, runId, runDirPath: taskRunDir, iteration: 1, stages: [],
    });
    expect(result.decision).toBe('deferred');
    expect(state.status).toBe('running');
    expect(state.stages.finalize.status).toBe('complete');
    expect(existsSync(join(projectDir, 'docs', 'final.md'))).toBe(false);
    expect(existsSync(join(projectDir, 'docs', 'escalation.md'))).toBe(false);
    expect(readdirSync(runRecordPath(taskRunDir, '.')).filter((name) => name.startsWith('ambiguous_terminal_'))).toHaveLength(2);
  });

  it('reports conflicting outcomes to the run without repeating particular writers', async () => {
    const projectDir = temporaryRoot();
    const { runId, runDirPath: taskRunDir } = createRun(projectDir, 'test', 'name: test\nstages: []\n', ['finish', 'escalate'], '---\nterminal_states: {complete: docs/final.md, escalated: docs/escalation.md}\n---\n');
    const startedAt = new Date(Date.now() - 1000).toISOString();
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    mkdirSync(runRecordPath(taskRunDir, 'stages', 'finish', 'placeholder'), { recursive: true });
    mkdirSync(runRecordPath(taskRunDir, 'stages', 'escalate', 'placeholder'), { recursive: true });
    writeFileSync(join(projectDir, 'docs', 'final.md'), '# complete\n');
    writeFileSync(join(projectDir, 'docs', 'escalation.md'), '# escalated\n');
    writeFileSync(runRecordPath(taskRunDir, 'dispatch_admission.json'), JSON.stringify({
      version: 1, pass: true, checkedAt: new Date().toISOString(), errors: [],
      terminalOwners: { 'docs/final.md': 'finish', 'docs/escalation.md': 'escalate' },
    }));
    const complete = (path: string): StageStatus => ({
      status: 'complete', retries: 0,
      attempts: [{ index: 1, status: 'complete', startedAt, writes: [path] }],
    });
    const state = {
      ...readRunState(projectDir, runId),
      runId, workflowName: 'test', projectDir, status: 'running', startedAt,
      terminalArtifactBaselines: {},
      terminalStates: {
        complete: { paths: ['docs/final.md'] },
        escalated: { paths: ['docs/escalation.md'] },
      },
      stages: {
        finish: complete('docs/final.md'),
        escalate: complete('docs/escalation.md'),
      },
    } as StoreState;
    writeRunState(projectDir, runId, state);

    const result = await tryTerminateOnTerminalState(state, {
      projectDir, runId, runDirPath: taskRunDir, iteration: 1, stages: [],
    });

    expect(result.decision).toBe('deferred');
    expect(state.stages.finish.status).toBe('complete');
    expect(state.stages.escalate.status).toBe('complete');
    const guidance = readFileSync(runRecordPath(taskRunDir, 'supervisor_guidance.md'), 'utf-8');
    expect(guidance).toContain('multiple fresh terminal outcomes exist');
    expect(guidance).toContain('"target":"*"');
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

  it('counts a current-attempt command without treating its existence as ongoing work', () => {
    const runDir = temporaryRoot();
    const attemptStartedAt = '2026-01-01T00:00:00.000Z';
    const status: StageStatus = {
      status: 'running', retries: 0,
      attempts: [{ index: 0, status: 'running', startedAt: attemptStartedAt }],
    };
    const tracker = new CommandActivityTracker({ runDir, stageId: 'work', attemptIndex: 0, attemptStartedAt });
    tracker.feed(`${JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test > /tmp/test.log 2>&1' } })}\n`);
    expect(inspectStageExecutionFacts({ runDir, stageId: 'work', status }))
      .toMatchObject({ activeCommandCount: 1, commandActivityValid: true, protectedFromIdleAbort: false });
    tracker.feed(`${JSON.stringify({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution' } })}\n`);
    const completed = inspectStageExecutionFacts({ runDir, stageId: 'work', status });
    expect(completed).toMatchObject({ activeCommandCount: 0, commandActivityValid: true, protectedFromIdleAbort: false });
  });

  it('never grants idle protection for missing or malformed lifecycle evidence', () => {
    const runDir = temporaryRoot();
    const attemptStartedAt = '2026-01-01T00:00:00.000Z';
    const status: StageStatus = {
      status: 'running', retries: 0,
      attempts: [{ index: 0, status: 'running', startedAt: attemptStartedAt }],
    };
    expect(inspectStageExecutionFacts({ runDir, stageId: 'work', status }))
      .toMatchObject({ commandActivityValid: false, activeCommandCount: 0, protectedFromIdleAbort: false });
    mkdirSync(runRecordPath(runDir, 'stages', 'work'), { recursive: true });
    writeFileSync(runRecordPath(runDir, 'stages', 'work', 'command_activity.json'), '{not-json');
    expect(inspectStageExecutionFacts({ runDir, stageId: 'work', status }))
      .toMatchObject({ commandActivityValid: false, activeCommandCount: 0, protectedFromIdleAbort: false });
  });
});

describe('output inventory, reachability, and stage prose', () => {
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
      '  - path: docs/terminal.md',
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
      'outputs:',
      '  - path: docs/result.json',
      '  - {path: docs/reports, type: directory}',
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
    const work = stage({ criterion_refs: [], artifact_contract: artifacts([], [], []), id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: ['docs/generated.json'] });
    const markdown = [
      '## Reality checks',
      '```yaml',
      'checks:',
      '  - name: future file',
      '    type: json-schema-match',
      '    reads: [{id: file, root: project, path: docs/not_owned.json, kind: file, source: {kind: input}}]',
      '    params:',
      '      file: docs/not_owned.json',
      '      schema: {type: object}',
      '```',
    ].join('\n');
    expect(inspectRealityCheckReachability({ markdown, projectDir, stages: [work] }).join('\n')).toContain('ARTIFACT_INPUT_ABSENT');

    const execMarkdown = [
      '## Reality checks',
      '```yaml',
      'checks:',
      '  - name: future script file',
      '    type: exec-script-exit-zero',
      '    reads: [{id: file, root: project, path: docs/not_owned_from_script.json, kind: file, source: {kind: input}}]',
      '    params:',
      '      script: |',
      '        artifact="docs/not_owned_from_script.json"',
      '        test -s "$artifact"',
      '```',
    ].join('\n');
    expect(inspectRealityCheckReachability({ markdown: execMarkdown, projectDir, stages: [work] }).join('\n'))
      .toContain('docs/not_owned_from_script.json');

    const finalizer = stage({ criterion_refs: [], artifact_contract: artifacts([], [], []), id: 'finalize', role: 'writer', depends_on: ['work'], dependency_reasons: { work: 'Consumes work.' }, scope: ['docs/final.md'] });
    const late = stage({ criterion_refs: [], artifact_contract: artifacts([{ id: 'file', root: 'project', path: 'docs/future.json' }]), id: 'late', role: 'writer', depends_on: ['finalize'], dependency_reasons: { finalize: 'Runs too late.' }, scope: ['docs/future.json'] });
    const lateMarkdown = markdown.replaceAll('docs/not_owned.json', 'docs/future.json')
      .replace('source: {kind: input}', 'source: {kind: stage, stage: late, artifact: file}');
    expect(inspectRealityCheckReachability({
      markdown: lateMarkdown,
      projectDir,
      stages: [work, finalizer, late],
      terminalStates: { complete: { paths: ['docs/final.md'] } },
    })).toEqual([]);
    expect(inspectDispatchAdmission({ dispatched: [work, finalizer, late], baseStages: [], dispatchStageId: 'plan',
    }).pass).toBe(true);

    const optionalResultMarkdown = markdown.replaceAll('docs/not_owned.json', 'docs/round.json');
    expect(inspectRealityCheckReachability({
      markdown: optionalResultMarkdown,
      projectDir,
      stages: [work],
      research: { baseline: 0, policy: 'greedy_stack', resultFile: 'docs/round.json', reportDir: 'docs' },
    }).join('\n')).toContain('ARTIFACT_INPUT_ABSENT');
  });
});
