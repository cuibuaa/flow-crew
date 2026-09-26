import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { parseCodexJsonl } from '../src/adapters/codex.js';
import { createTechnicalRetryBudgetState, transitionTechnicalRetryBudget } from '../src/attempt-deadline.js';
import { loadProjectDefaults } from '../src/config.js';
import { isLiveConstraintExemptPath } from '../src/live-constraint-guard.js';
import { Orchestrator, type GitAdapter } from '../src/orchestrator.js';
import type { RunEvent } from '../src/run-events.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import {
  appendResearchTemporalPathContract,
  assessResearchIterationBudget,
  buildGateDispatchPreamble,
  buildGateReevaluationPreamble,
  configuredValidationCommandRole,
  discoverConfiguredCommandScopes,
  inspectRealityCheckReachability,
  recordSchedulerTechnicalAttemptResult,
} from '../src/scheduler.js';
import { discoverProjectValidation } from '../src/project-validation.js';
import { RUN_STATUS, createRun, fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import {
  compareSupervisorDirectionAcrossStages,
  verifyRepeatedWrongDirection,
  type DirectionEvidenceBinding,
  type DirectionGuidanceFact,
  type SupervisorAssessment,
  type SupervisorStageEvidence,
} from '../src/supervisor.js';
import type { SupervisorBackend, UnitStatus } from '../src/supervision.js';
import { TASK_STATUS, TaskRegistry } from '../src/task-registry.js';
import { ADAPTER_FAILURE_PATTERNS, classifyAdapterFailure, runStage } from '../src/worker.js';
import { scanSource } from './purity.js';

const temporaryRoots: string[] = [];
const role: AgentConfig = {
  name: 'forensic-fixture',
  description: 'fixture',
  model: 'test',
  reasoning_effort: 'low',
  tools: [],
  prompt: 'fixture',
  adapter: 'test',
};

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `flowcrew-${label}-`));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repeatedDirectionFixture(siblingEvidence: SupervisorStageEvidence[]) {
  const stageId = 'accused';
  const attemptIndex = 1;
  const attemptStartedAt = '2026-09-22T18:00:00.000Z';
  const at = (second: number) => `2026-09-22T18:00:${String(second).padStart(2, '0')}.000Z`;
  const evidence = (hex: string): DirectionEvidenceBinding => ({
    version: 1, stageId, attemptIndex, attemptStartedAt, generation: hex.repeat(64),
  });
  const guidance: DirectionGuidanceFact[] = [
    {
      timestamp: at(10), targetAttemptIndex: attemptIndex, source: 'supervisor',
      directionEvidence: evidence('a'),
      assessment: {
        verdict: 'GUIDE', targetStage: stageId, reason: 'home run store input',
        guidance: 'change direction', directionKey: 'using_home_run_store_as_input',
        guidanceId: 'guide-one', evidenceIds: ['ev_aaaaaaaaaaaaaaaaaaaa'],
      },
    },
    {
      timestamp: at(20), targetAttemptIndex: attemptIndex, source: 'supervisor',
      directionEvidence: evidence('b'),
      assessment: {
        verdict: 'GUIDE', targetStage: stageId, reason: 'home run store input',
        guidance: 'change direction', directionKey: 'using_home_run_store_as_input',
        guidanceId: 'guide-two', evidenceIds: ['ev_bbbbbbbbbbbbbbbbbbbb'],
      },
    },
  ];
  const assessment: SupervisorAssessment = {
    verdict: 'ABORT', targetStage: stageId, reason: 'home run store input persists', guidance: null,
    directionKey: 'using_home_run_store_as_input', evidenceIds: ['ev_cccccccccccccccccccc'],
  };
  const delivery = (timestamp: string, invocationIndex: number, guidanceId: string): RunEvent => ({
    type: 'guidance_delivery_checked', runId: 'fixture-run', timestamp, stageId,
    attemptIndex, attemptStartedAt, boundary: 'adapter_invocation', invocationIndex,
    guidanceIds: [guidanceId], delivered: true, source: 'worker',
  });
  return verifyRepeatedWrongDirection({
    stageId, attemptIndex, assessment, currentEvidence: evidence('c'), guidance,
    deliveryEvents: [delivery(at(15), 1, 'guide-one'), delivery(at(25), 2, 'guide-two')],
    assessmentTimestamp: at(30),
    accusedEvidence: {
      version: 1,
      stageId,
      attemptIndex,
      attemptStartedAt,
      rows: [{
        id: 'ev_cccccccccccccccccccc',
        kind: 'command_invocation',
        authority: 'action',
        text: 'using home run store input via fixture command',
      }],
    },
    siblingEvidence,
  });
}

describe('engine-discrimination post-change constructions and controls', () => {
  it('item 1 suppresses a common direction but still verifies a stage-specific repeated direction', () => {
    const sibling = (stageId: string, text: string, authority: 'action' | 'inspection' = 'action'): SupervisorStageEvidence => ({
      version: 1,
      stageId,
      attemptIndex: 1,
      attemptStartedAt: '2026-09-22T17:00:00.000Z',
      rows: [{ id: `ev_${stageId.padEnd(20, '0').slice(0, 20)}`, kind: 'command_invocation', authority, text }],
    });
    const common = repeatedDirectionFixture([
      sibling('sibling_a', ['read /', 'home/operator/.fc/runs/current/input.md'].join(''), 'inspection'),
      sibling('sibling_b', 'npm test'),
    ]);
    const specific = repeatedDirectionFixture([sibling('sibling_b', 'npm test and edit src/output.ts')]);
    const lexicalOverlapOnly = compareSupervisorDirectionAcrossStages({
      accusedStageId: 'accused',
      assessment: {
        verdict: 'ABORT', targetStage: 'accused', reason: 'marker population persists', guidance: null,
        directionKey: 'marker_decidable_primary_population',
      },
      stageEvidence: [sibling('sibling_c', 'rg marker population docs/report.md', 'inspection')],
    });

    console.log(`POST_ITEM_1=${JSON.stringify({ common, specific, lexicalOverlapOnly })}`);
    expect(common).toMatchObject({
      verified: false,
      mode: 'non_discriminating',
      siblingComparison: { denominator: 2, matchingCount: 1, matchingStageIds: ['sibling_a'] },
    });
    expect(specific).toMatchObject({
      verified: true,
      mode: 'delivered_opportunities',
      siblingComparison: { denominator: 1, matchingCount: 0 },
    });
    expect(lexicalOverlapOnly).toMatchObject({ denominator: 1, matchingCount: 0, matchingStageIds: [] });
  });

  it('item 2 projects the exact structured launch refusal without spending a retry', async () => {
    const root = temporaryRoot('launch-refusal');
    const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
    const refusal = 'Launch refused: research.stop.max_rounds (8) exceeds the engine iteration limit (5); units: rounds versus iterations. Adjust the named authored budget or its named engine binding.';
    const refusedTask = registry.create({ brief_text: 'fixture', projectDir: root, status: TASK_STATUS.RUNNING, max_retries: 2 });
    const ordinaryTask = registry.create({ brief_text: 'control', projectDir: root, status: TASK_STATUS.RUNNING, max_retries: 2 });
    const units: SupervisorBackend = {
      async isActive(unit): Promise<UnitStatus> {
        return unit === refusedTask.systemd_unit
          ? { kind: 'terminal', exitCode: 2, launchRefusal: { version: 1, kind: 'launch_refused', message: refusal, refusedAt: '2026-09-22T19:19:17.000Z' } }
          : { kind: 'terminal', exitCode: 2 };
      },
      async runUnit(): Promise<void> {}, async stopUnit(): Promise<void> {}, async journalTail(): Promise<string> { return ''; },
    };
    const git: GitAdapter = {
      async findCommitByPrefix() { return undefined; },
      async hasUncommittedChanges() { return false; },
      async findCommitSince() { return undefined; },
    };
    const orchestrator = new Orchestrator({ registry, systemd: units, git, isProjectBusy: () => null });
    await orchestrator.tickOnce();

    const budget = assessResearchIterationBudget({
      baseline: 0, policy: 'greedy_stack', resultFile: 'docs/result.json', stop: { maxRounds: 8 },
    }, 5);
    console.log(`POST_ITEM_2=${JSON.stringify({ budget, refused: registry.get(refusedTask.id), control: registry.get(ordinaryTask.id) })}`);
    expect(registry.get(refusedTask.id)).toMatchObject({ status: TASK_STATUS.FAILED, attempt: 1, notes: refusal });
    expect(registry.get(ordinaryTask.id)).toMatchObject({ status: TASK_STATUS.DEFERRED, attempt: 1 });
  });

  it('item 3 records capacity as a closed adapter kind while preserving semantic failures', async () => {
    const projectDir = temporaryRoot('capacity-project');
    const stateDir = temporaryRoot('capacity-state');
    const previousStateDir = fcGlobalDir();
    mkdirSync(join(projectDir, 'config'), { recursive: true });
    writeFileSync(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 1000\nadapter: test\nmodel: test\nreasoning_effort: low\n');
    setFcGlobalDir(stateDir);
    try {
      const created = createRun(projectDir, 'capacity-fixture', 'name: capacity-fixture', ['work']);
      const parsed = parseCodexJsonl([
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'mid-work' } }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'Selected model is at capacity.' } }),
      ].join('\n'));
      const adapter: Adapter = { async run() { return {
        output: parsed.output, exitCode: 1, duration_ms: 1,
        adapterError: parsed.adapterFailureKind !== undefined,
        adapterFailureKind: parsed.adapterFailureKind,
      }; } };
      const result = await runStage(adapter, {
        stageId: 'work', role, dependsOn: [], promptTemplate: 'fixture', timeout_ms: 1_000,
        technicalRetry: { delaysMs: [] }, projectDir, runId: created.runId, runDir: created.runDirPath, retries: 0,
      });
      const events = readFileSync(join(created.runDirPath, 'events.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      console.log(`POST_ITEM_3=${JSON.stringify({ result, event: events.find((event) => event.type === 'attempt_failed') })}`);
      expect(result).toMatchObject({ exitCode: 1, adapterError: true, adapterFailureKind: 'capacity' });
      expect(events).toContainEqual(expect.objectContaining({ type: 'attempt_failed', adapterFailure: true, adapterFailureKind: 'capacity' }));
      const quoted = parseCodexJsonl([
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'assertion quoted Selected model is at capacity.' } }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'Stage assertion failed' } }),
      ].join('\n'));
      expect(quoted.adapterFailureKind).toBeUndefined();
      const semanticRun = createRun(projectDir, 'quoted-control', 'name: quoted-control', ['work']);
      const semanticAdapter: Adapter = { async run() { return {
        output: quoted.output, exitCode: 1, duration_ms: 1, adapterError: false,
      }; } };
      const semantic = await runStage(semanticAdapter, {
        stageId: 'work', role, dependsOn: [], promptTemplate: 'fixture', timeout_ms: 1_000,
        technicalRetry: { delaysMs: [] }, projectDir, runId: semanticRun.runId, runDir: semanticRun.runDirPath, retries: 0,
      });
      const semanticEvents = readFileSync(join(semanticRun.runDirPath, 'events.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(semantic.adapterError).toBe(false);
      expect(semanticEvents).toContainEqual(expect.objectContaining({ type: 'attempt_failed', adapterFailure: false }));
      expect(classifyAdapterFailure('assertion mismatch in stage output')).toBeUndefined();
      expect(new Set(ADAPTER_FAILURE_PATTERNS.map(({ kind }) => kind))).toEqual(new Set([
        'forbidden', 'connection_refused', 'connection_reset', 'rate_limited', 'transport_timeout',
        'bad_gateway', 'service_unavailable', 'overloaded', 'capacity',
      ]));
      const recognizerPopulation = [
        ['403 Forbidden', 'forbidden'],
        ['connection refused', 'connection_refused'],
        ['ECONNREFUSED', 'connection_refused'],
        ['ECONNRESET', 'connection_reset'],
        ['rate limit', 'rate_limited'],
        ['ETIMEDOUT', 'transport_timeout'],
        ['429 Too Many', 'rate_limited'],
        ['502 Bad Gateway', 'bad_gateway'],
        ['503 Service Unavailable', 'service_unavailable'],
        ['overloaded', 'overloaded'],
        ['Selected model is at capacity.', 'capacity'],
      ] as const;
      expect(recognizerPopulation.map(([text, expected]) => ({
        text, expected, actual: classifyAdapterFailure(text),
      }))).toEqual(recognizerPopulation.map(([text, expected]) => ({ text, expected, actual: expected })));
      const technicalRetry = createTechnicalRetryBudgetState({ initialBudgetMs: 1_000 });
      const first = transitionTechnicalRetryBudget(technicalRetry, { type: 'prepare_attempt' });
      expect(first).toMatchObject({ type: 'attempt_prepared', budgetMs: 1_000 });
      expect(recordSchedulerTechnicalAttemptResult(technicalRetry, {
        adapterFailureKind: 'capacity',
        timedOut: false,
      }, 1_000)).toBe(true);
      const second = transitionTechnicalRetryBudget(technicalRetry, { type: 'prepare_attempt' });
      expect(second).toMatchObject({ type: 'attempt_prepared', budgetMs: 1_000 });
    } finally { setFcGlobalDir(previousStateDir); }
  });

  it('item 4 derives framing from the durable same-gate archive', () => {
    const runDirPath = temporaryRoot('gate-archive');
    const oldRound = join(runDirPath, 'gate_reevaluation', 'iteration_2', 'round_1');
    mkdirSync(oldRound, { recursive: true });
    const verdict = join(oldRound, 'rejected_verdict_verify_six.json');
    writeFileSync(verdict, '{"pass":false}\n');
    const replanned = buildGateReevaluationPreamble({
      evaluationRound: 1, iteration: 3, repairRound: 1, runDirPath, gateId: 'verify_six', fixStageIds: [],
      roundDiffPath: join(runDirPath, 'gate_reevaluation', 'iteration_3', 'round_1', 'repair_diff.json'),
    });
    const noVerdictRoot = temporaryRoot('gate-no-verdict');
    const interrupted = buildGateDispatchPreamble({ runDirPath: noVerdictRoot, gateId: 'verify_six', evaluationRound: 2, priorAttemptCount: 1 });
    const first = buildGateDispatchPreamble({ runDirPath: noVerdictRoot, gateId: 'new_gate', evaluationRound: 1, priorAttemptCount: 0 });
    writeFileSync(join(noVerdictRoot, 'verdict_passing_gate.json'), '{"pass":true}\n');
    const passing = buildGateDispatchPreamble({ runDirPath: noVerdictRoot, gateId: 'passing_gate', evaluationRound: 2, priorAttemptCount: 1 });
    console.log(`POST_ITEM_4=${JSON.stringify({ replanned: replanned.split('\n')[0], interrupted: interrupted.split('\n')[0], first: first.split('\n')[0], passing: passing.split('\n')[0] })}`);
    expect(replanned).toContain('RE-EVALUATION');
    expect(replanned).toContain(verdict);
    expect(interrupted).toContain('INTERRUPTED EVALUATION');
    expect(interrupted).toContain('initial evaluation');
    expect(first).toContain('FIRST EVALUATION');
    expect(passing).toContain('INITIAL EVALUATION');
    expect(passing).not.toContain('RE-EVALUATION');
  });

  it('item 5 exempts configured generated trees only while untracked', () => {
    const patterns = [
      ...loadProjectDefaults(process.cwd()).live_constraint_exempt_patterns,
      ...discoverConfiguredCommandScopes(process.cwd()),
    ];
    const temporary = ['node_modules', '.vite-temp', 'vitest.config.ts.timestamp-fixture.mjs'].join('/');
    const untracked = isLiveConstraintExemptPath(temporary, patterns, new Set());
    const tracked = isLiveConstraintExemptPath(temporary, patterns, new Set([temporary]));
    const source = isLiveConstraintExemptPath('src/ordinary.ts', patterns, new Set());
    const commands = discoverProjectValidation(process.cwd()).commands;
    const configuredCommand = configuredValidationCommandRole('npm run build', commands);
    const wrappedConfiguredCommand = configuredValidationCommandRole(
      "/bin/bash -lc 'timeout 600 npm run build > /tmp/build.log 2>&1'",
      commands,
    );
    const projectRedirection = configuredValidationCommandRole(
      'npm run build > dist/authored.txt',
      commands,
    );
    const projectAppendRedirection = configuredValidationCommandRole(
      'npm run test >> node_modules/.vite-temp/authored.txt',
      commands,
    );
    const absoluteProjectRedirection = configuredValidationCommandRole(
      `npm run build > ${join(process.cwd(), 'dist', 'authored.txt')}`,
      commands,
    );
    const redirectRoot = temporaryRoot('configured-redirection');
    const redirectProject = join(redirectRoot, 'project');
    const redirectLink = join(redirectRoot, 'external-link');
    mkdirSync(join(redirectProject, 'dist'), { recursive: true });
    symlinkSync(join(redirectProject, 'dist', 'authored.txt'), redirectLink);
    const symlinkProjectRedirection = configuredValidationCommandRole(
      `npm run build > ${redirectLink}`,
      commands,
      redirectProject,
    );
    const authoredCommand = configuredValidationCommandRole('node scripts/author-dist.js', commands);
    const compoundCommand = configuredValidationCommandRole('npm run build && node scripts/author-dist.js', commands);
    console.log(`POST_ITEM_5=${JSON.stringify({ patterns, untracked, tracked, source, configuredCommand, wrappedConfiguredCommand, projectRedirection, projectAppendRedirection, absoluteProjectRedirection, authoredCommand, compoundCommand })}`);
    expect({ untracked, tracked, source }).toEqual({ untracked: true, tracked: false, source: false });
    expect({
      configuredCommand,
      wrappedConfiguredCommand,
      projectRedirection,
      projectAppendRedirection,
      absoluteProjectRedirection,
      symlinkProjectRedirection,
      authoredCommand,
      compoundCommand,
    }).toEqual({
      configuredCommand: 'build',
      wrappedConfiguredCommand: 'build',
      projectRedirection: undefined,
      projectAppendRedirection: undefined,
      absoluteProjectRedirection: undefined,
      symlinkProjectRedirection: undefined,
      authoredCommand: undefined,
      compoundCommand: undefined,
    });
  });

  it('item 6 resolves fragment-built external reads without flagging project-relative controls', () => {
    const external = [
      "import { readFileSync } from 'node:fs';",
      "const root = ['/', 'home', '/operator/', '.fc', '/runs/fixture'].join('');",
      "readFileSync(root, 'utf8');",
    ].join('\n');
    const local = [
      "import { readFileSync } from 'node:fs';",
      "const root = ['spec', 'fixtures', 'local.json'].join('/');",
      "readFileSync(root, 'utf8');",
    ].join('\n');
    const violations = scanSource(external, 'spec/fragment-built.test.ts');
    const control = scanSource(local, 'spec/project-relative.test.ts');
    console.log(`POST_ITEM_6=${JSON.stringify({ violations, control })}`);
    expect(violations).toContainEqual(expect.objectContaining({ rule: 'absolute-home' }));
    expect(control).toEqual([]);
  });

  it('item 7 refuses a current-round gate dependency on the post-consumption manifest', () => {
    const projectDir = temporaryRoot('research-order');
    const research = { baseline: 0, policy: 'greedy_stack' as const, resultFile: 'docs/round_result.json', reportDir: 'docs', stop: { maxRounds: 2 } };
    const check = (path: string) => [
      '## Reality checks', '```yaml', 'checks:', '  - name: temporal_check', '    type: file-exists-nonempty',
      '    params:', `      paths: [${path}]`, '```',
    ].join('\n');
    const refused = inspectRealityCheckReachability({ markdown: check('docs/run_manifest.json'), projectDir, stages: [], research });
    const ordinary = inspectRealityCheckReachability({
      markdown: check('docs/report.json'), projectDir, research,
      stages: [{ id: 'writer', role: 'researcher', depends_on: [], prompt_template: '', skills: [], criterion_refs: [], scope: ['docs/report.json'], is_gate: false }],
    });
    const prompt = appendResearchTemporalPathContract('confirm the round', research, undefined);
    console.log(`POST_ITEM_7=${JSON.stringify({ refused, ordinary, promptLine: prompt.split('\n').find((line) => line.includes('manifest:')) })}`);
    expect(refused.join('\n')).toContain('writes it only after the current round');
    expect(prompt).toContain('post-consumption framework manifest: docs/run_manifest.json');
    expect(prompt).toContain("unavailable to that round's confirmation gates");
    expect(ordinary).toEqual([]);
  });

  it('item 8 preserves terminal authority while unknown nonterminal supervision still fails closed', async () => {
    const root = temporaryRoot('terminal-observation');
    const projectDir = join(root, 'project');
    const runsDir = join(root, 'runs');
    mkdirSync(projectDir, { recursive: true });
    const writeRun = (runId: string, status: string) => {
      mkdirSync(join(runsDir, runId), { recursive: true });
      writeFileSync(join(runsDir, runId, 'run.json'), JSON.stringify({ runId, projectDir, workflowName: 'fixture', status, stages: {}, startedAt: '2026-09-22T00:00:00.000Z' }));
    };
    writeRun('terminal-run', RUN_STATUS.COMPLETE);
    writeRun('running-run', RUN_STATUS.RUNNING);
    const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
    // The registry can lag the authoritative run record during the exact shim
    // exit race: durable terminal run truth must already answer cancellation.
    const terminal = registry.create({ brief_text: 'terminal', projectDir, run_id: 'terminal-run', status: TASK_STATUS.RUNNING });
    const running = registry.create({ brief_text: 'running', projectDir, run_id: 'running-run', status: TASK_STATUS.RUNNING });
    const units: SupervisorBackend = {
      async isActive(): Promise<UnitStatus> { return { kind: 'terminal-unknown', reason: 'shim-died-without-status' }; },
      async runUnit(): Promise<void> {}, async stopUnit(): Promise<void> {}, async journalTail(): Promise<string> { return ''; },
    };
    const coordinator = new RunCancellationCoordinator({ registry, units, runsDir, timeoutMs: 0 });
    const terminalResult = await coordinator.cancelTask(terminal.id);
    const control = await coordinator.cancelTask(running.id);
    console.log(`POST_ITEM_8=${JSON.stringify({ terminalResult, control })}`);
    expect(terminalResult).toMatchObject({ ok: true, status: 'already-terminal', preservedRunStatus: RUN_STATUS.COMPLETE });
    expect(control).toMatchObject({ ok: false, status: 'outcome-unknown' });
  });
});
