import './test-support/policy-runtime.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { admitStageDuration } from '../src/stage-duration.js';
import * as entry from '../src/adapter-input.js';
import { DeclarationRefusal } from '../src/brief-declarations.js';
import * as execution from '../src/scheduler/sched_settlement/stage-execution.js';
import { executeReadyBatch } from '../src/scheduler/sched_loop/stage-batch.js';
import { executeOrdinaryStage } from '../src/scheduler/sched_loop/ordinary-stage.js';
import { prepareWorkflowLaunch } from '../src/scheduler/sched_loop/launch.js';
import { WorkflowConfigSchema } from '../src/scheduler.js';
import { stageRecordSchema } from '../src/handoff.js';
import { runStage } from '../src/worker.js';
import * as deadline from '../src/attempt-deadline.js';
import { createTechnicalRetryBudgetState, type AttemptDeadlineClock } from '../src/attempt-deadline.js';
import { isRetryableAdapterFailure } from '../src/adapters/failure.js';
import { createRun } from './test-support/create-run.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { fcGlobalDir, listRuns, readRunState, readStageStatus, updateRunState, setFcGlobalDir, completedStageAttemptStatus, rependStageStatus, writeStageStatus } from '../src/store.js';
import { releaseLaunchIntent } from '../src/run-lock.js';
import { runRecordPath } from '../src/run-layout.js';
import { writeTaskBrief } from '../src/brief-writer.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { createWatchState, pollWatch } from '../src/watch.js';
import { startDashboard } from '../src/dashboard.js';

vi.mock('../src/evidence-ledger.js', async original => ({
  ...await original<typeof import('../src/evidence-ledger.js')>(), evidenceContext: () => 'Synthetic evidence reference.',
}));
vi.mock('../src/recorded-command.js', () => ({ startCommandRecorder: async () => ({ command: 'fixture-recorder', close: async () => {} }) }));

const role: AgentConfig = { name: 'fixture', description: '', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'System.' };
const contract = { version: 1 as const, produces: [], reads: [], groups: [] };
const limit = 20_000;
const valid = JSON.stringify({ status: 'delivered', summary: 'Done.', caveats: [], remaining_work: [] });
const fields = { criteria: ['Deliver the result.'], constraints: [], inputs: [], assumptions: [], blocking_questions: [] };
let root: string, project: string, prior: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stage-duration-')); project = join(root, 'project'); mkdirSync(project);
  prior = fcGlobalDir(); setFcGlobalDir(join(root, '.fc'));
  setEngineDefaults({ stage_technical_retries: 5 });
});
afterEach(() => { setFcGlobalDir(prior); rmSync(root, { recursive: true, force: true }); });

function clock(): AttemptDeadlineClock {
  return { monotonicNow: () => 0, wallNow: () => Date.parse('2030-01-01T00:00:00Z'),
    setTimer: () => ({} as ReturnType<typeof setTimeout>), clearTimer: () => {} };
}
function workflow(extra: Record<string, unknown> = {}) {
  return WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 2, max_retries: 0 },
    stages: [{ id: 'work', role: 'fixture', scope: [], artifact_contract: contract, ...extra }] });
}
function createdRun(yaml = 'name: fixture\nstages: []\n', declared = true, inputLimit?: number) {
  const brief = `---\n${declared ? `stage_duration_ms: ${limit}\n` : ''}${inputLimit === undefined ? '' : `input_limit_chars: ${inputLimit}\n`}${!declared && inputLimit === undefined ? '{}\n' : ''}---\n`;
  const created = createRun(project, 'fixture', yaml, ['work'], brief);
  updateRunState(project, created.runId, state => { state.stageDurationLimitMs = limit; });
  return created;
}
function gitProject() {
  isolatedProjectCommand('git', ['init', '-q'], project, root);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'], project, root);
}
function numericRefusal(result: Awaited<ReturnType<typeof runStage>>, requested = limit + 1) {
  expect(result).toMatchObject({ exitCode: 1, duration_ms: 0,
    providerFailure: { kind: 'duration_limit', source: 'stage_duration', requestedBudgetMs: requested, limit } });
  expect(typeof result.providerFailure!.limit).toBe('number');
  expect(isRetryableAdapterFailure(result.providerFailure!.kind)).toBe(false);
  // Diagnostic wording has no bearing on either retry policy.
  expect(execution.decideStageRetry({ ...result, friendlyError: 'transient timeout',
    providerFailure: { ...result.providerFailure!, reason: 'temporary capacity, retry now' } }, 0, 9, 9)).toBe('stop');
}

describe('stage duration admission and recorded contract', () => {
  it.each([undefined, 40_000, 20_000])('records only an author-declared allowance (%s)', declared => {
    const brief = declared === undefined ? 'Task' : `---\nstage_duration_ms: ${declared}\n---\nTask`;
    expect(admitStageDuration(brief)).toBe(declared);
    writeReadySetupRecord(project, brief, fcGlobalDir());
    const launch = prepareWorkflowLaunch(workflow(), '', project, undefined, brief);
    try { expect(launch.kind).toBe('ready'); if (launch.kind === 'ready')
      expect(readRunState(project, launch.runId).stageDurationLimitMs).toBe(declared);
    } finally { if (launch.kind === 'ready') { rmSync(launch.schedulerPidPath, { force: true }); releaseLaunchIntent(project, launch.runId); } }
  });
  it.each([0, -1, 1.5, '100', null, {}, [], true].map(declared => ({ declared })))('refuses $declared before reserving a run with both values', ({ declared }) => {
    const before = listRuns(project);
    expect(() => prepareWorkflowLaunch(workflow(), '', project, undefined, `---\nstage_duration_ms: ${JSON.stringify(declared)}\n---\nTask`))
      .toThrow(DeclarationRefusal);
    try { admitStageDuration(`---\nstage_duration_ms: ${JSON.stringify(declared)}\n---\nTask`); }
    catch (error) { expect(error).toMatchObject({ code: 'declaration_invalid', keyPath: 'stage_duration_ms' }); }
    expect(listRuns(project)).toEqual(before);
  });
  it.each(['.nan', '.inf', '-.inf', '9007199254740992', '&cycle {value: *cycle}'])('retains a typed refusal for nonnumeric/unsafe declaration %s', yaml => {
    expect(() => admitStageDuration(`---\nstage_duration_ms: ${yaml}\n---\nTask`)).toThrow(DeclarationRefusal);
  });
  it.each(['failed', 'cancelled', 'parked'] as const)('resumes %s from the recorded allowance or without a default without re-admitting old text', status => {
    for (const legacy of [false, true]) {
      const config = workflow(), created = createdRun(JSON.stringify(config), !legacy);
      updateRunState(project, created.runId, state => {
        state.status = status; state.currentIteration = 1; state.maxIterations = 2;
        state.taskDescription = '---\nstage_duration_ms: retired-invalid-value\n---\nAdmitted';
        if (legacy) delete state.stageDurationLimitMs;
      });
      const launch = prepareWorkflowLaunch(config, '', project, created.runId);
      try {
        expect(launch.kind).toBe('ready');
        expect(readRunState(project, created.runId).stageDurationLimitMs).toBe(legacy ? undefined : limit);
      } finally { if (launch.kind === 'ready') { rmSync(launch.schedulerPidPath, { force: true }); releaseLaunchIntent(project, launch.runId); } }
    }
  });
});

const workerPaths = ['ordinary', 'review', 'planner', 'successor', 'isolated-shape', 'isolated-review', 'isolated-successor', 'timeout-retry', 'resumed-session'] as const;
describe('worker attempt entry', () => {
  it.each(workerPaths)('%s: at-limit enters, above-limit refuses before attempt creation', async path => {
    for (const offset of [0, 1]) {
      const created = createdRun();
      const gate = path === 'review';
      const run = vi.fn<Adapter['run']>(async () => ({ output: gate ? JSON.stringify({ pass: true, reason: 'Checked.', criteria: {}, audit_findings: { version: 1, findings: [] } }) : valid, exitCode: 0, duration_ms: 0 }));
      const result = await runStage({ run }, { ...created, projectDir: project, runDir: created.runDirPath,
        stageId: 'work', role, dependsOn: [], promptTemplate: 'Task', artifactContract: contract,
        timeout_ms: limit + offset, deadlineClock: clock(), retries: path === 'timeout-retry' ? 3 : 0,
        isGate: gate, outputSchema: stageRecordSchema({ isGate: gate }), dynamicDispatch: path === 'planner',
        decisionResult: path === 'successor' || path.startsWith('isolated-'),
        ...(path.startsWith('isolated-') ? { isolatedInput: { system: 'Read only.', user: 'Task' } } : {}),
        ...(path === 'resumed-session' ? { resumeSessionId: '123e4567-e89b-42d3-a456-426614174000' } : {}),
      });
      if (offset === 0) { expect(run).toHaveBeenCalledOnce(); expect(readStageStatus(project, created.runId, 'work').attempts).toHaveLength(1); }
      else { numericRefusal(result); expect(run).not.toHaveBeenCalled(); expect(readStageStatus(project, created.runId, 'work')).toMatchObject({ status: 'failed', providerFailure: result.providerFailure });
        expect(readRunState(project, created.runId).stages.work.attempts ?? []).toHaveLength(0); }
    }
  });
});

const schedulerPaths = ['ordinary', 'planner', 'review', 'shape', 'review-decision', 'code-review-decision', 'successor', 'timeout-retry', 'repair', 're-evaluation', 'research-stage', 'research-review'] as const;
describe('real scheduler routing through the entry owner', () => {
  it.each(schedulerPaths)('%s: at-limit enters, above-limit receives the typed refusal', async path => {
    gitProject();
    if (path === 'code-review-decision') writeFileSync(join(project, 'patch.txt'), 'D'.repeat(400_000));
    const extra = path === 'repair' ? { retry_to: ['review'] } : path === 'planner' ? { dynamic_dispatch: true }
      : ['review', 're-evaluation', 'research-review'].includes(path) ? { is_gate: true }
      : path === 'shape' ? { decision: { kind: 'shape', successors: ['next'], default: 'next' } }
      : path.includes('review-decision') ? { decision: { kind: 'review', successors: ['next', 'full'], default: 'full' } }
      : path === 'successor' ? { decision: { kind: 'successor', successors: ['next'], default: 'next' } } : {};
    const config = workflow(extra), stage = config.stages[0];
    for (const offset of [0, 1]) {
      const created = createdRun(undefined, true, path === 'code-review-decision' ? 100_000 : undefined), state = readRunState(project, created.runId);
      if (path === 'code-review-decision') state.inputLimitChars = 100_000;
      if (path === 'repair' || path === 're-evaluation') state.gateRetryRound = { iteration: 1, round: 1 };
      if (path === 'timeout-retry' || path === 're-evaluation') {
        const previous = completedStageAttemptStatus(state.stages.work, 0, {
          exitCode: path === 'timeout-retry' ? 124 : 0, duration_ms: 1,
          terminationCause: path === 'timeout-retry' ? 'attempt_timeout' : 'exit',
          ...(path === 'timeout-retry' ? { timeout: { attemptId: 'historical', budgetMs: 1e12,
            attemptStartedAt: '2030-01-01T00:00:00Z', deadlineAt: '2030-01-01T00:00:01Z', elapsedMs: 1, remainingMs: 0 } } : {}),
        });
        state.stages.work = rependStageStatus(previous, path === 'timeout-retry' ? 10 : 0);
        writeStageStatus(project, created.runId, 'work', state.stages.work);
      }
      const run = vi.fn<Adapter['run']>(async (_prompt, _role, opts) => ({ output: opts.outputSchema?.anyOf ? JSON.stringify({ pass: true, reason: 'Checked.', criteria: {}, audit_findings: { version: 1, findings: [] } })
        : stage.decision ? JSON.stringify({ successor: 'next', reason: 'Selected.', ...(path === 'shape' ? { assumptions: [] } : path === 'review-decision' ? { risk_areas: [] } : {}) }) : valid, exitCode: 0, duration_ms: 0 }));
      const transition = deadline.transitionTechnicalRetryBudget;
      // Inject an excessive request at budget selection; entry and its comparison stay real.
      const prepare = vi.spyOn(deadline, 'transitionTechnicalRetryBudget').mockImplementation((chain, event) => {
        const next = transition(chain, event);
        return next.type === 'attempt_prepared' ? { ...next, budgetMs: next.budgetMs + offset } : next;
      });
      let result;
      try {
        if (path === 'research-stage' || path === 'research-review') result = await execution.executeSingleStage(stage, project, created.runId, created.runDirPath, config,
          { run }, new Map([['fixture', role]]), join(import.meta.dirname, '../config/agents'), state, config.stages, undefined, undefined, 1,
          undefined, undefined, undefined, clock);
        else {
          const retries = new Map();
          result = (await executeOrdinaryStage(stage, config.stages, state, project, created.runId, created.runDirPath, { run },
            new Map([['fixture', role]]), project, new Map(), retries, undefined, undefined, undefined, clock)).result;
        }
      } finally { prepare.mockRestore(); }
      expect(result).toBeDefined();
      if (offset) { numericRefusal(result!); expect(run).not.toHaveBeenCalled(); }
      else if (path === 'code-review-decision') { expect(result!.exitCode).toBe(0); expect(run).not.toHaveBeenCalled(); expect(JSON.parse(result!.output).successor).toBe('full'); }
      else { expect(run).toHaveBeenCalledOnce(); expect(result!.exitCode).toBe(0);
        if (path === 'repair') expect(run.mock.calls[0][0]).toContain('# Gate repair facts');
        if (path === 'timeout-retry') expect(run.mock.calls[0][0]).toContain('# RETRY facts');
        if (path === 're-evaluation') expect(readStageStatus(project, created.runId, 'work').attempts).toHaveLength(2);
      }
    }
  });
});

it('the batch settles a numeric entry refusal without retrying or inventing an execution', async () => {
  const config = workflow(), created = createdRun();
  const run = vi.fn<Adapter['run']>(async () => ({ output: valid, exitCode: 0, duration_ms: 0 }));
  const retries = new Map([['work', createTechnicalRetryBudgetState({ initialBudgetMs: limit + 1 })]]);
  const batch = await executeReadyBatch(config.stages, readRunState(project, created.runId), project, created.runId, created.runDirPath, config,
    { run }, new Map([['fixture', role]]), project, new Map(), retries, undefined, undefined, undefined, clock);
  expect(batch).toMatchObject({ kind: 'settled', state: { status: 'failed', reasonCode: 'adapter_failure' } });
  expect(run).not.toHaveBeenCalled();
  const status = readStageStatus(project, created.runId, 'work');
  expect(status).toMatchObject({ providerFailure: { kind: 'duration_limit', requestedBudgetMs: limit + 1, limit }, retries: 0 });
  expect(status.attempts ?? []).toHaveLength(0);
});

describe('retry reconstruction', () => {
  it.each([0, 1, 2, 1000])('ignores historical growth after %s timeouts', retries => {
    for (const persisted of [undefined, 1, 1e12, Number.MAX_SAFE_INTEGER]) {
      const chain = execution.createSchedulerTechnicalRetryState(limit, { status: 'pending', retries,
        attempts: [{ terminationCause: 'attempt_timeout', timeout: { budgetMs: persisted } }] } as any, true);
      for (let i = 0; i < 100; i++) {
        const prepared = execution.prepareSchedulerTechnicalAttempt(chain);
        expect(prepared.budgetMs).toBe(limit);
        execution.recordSchedulerTechnicalAttemptResult(chain, { terminationCause: 'attempt_timeout', effectiveTimeoutMs: 1e12 }, prepared.budgetMs);
      }
    }
  });
});

describe('brief writer through the real adapter entry', () => {
  it.each(['initial', 'correction'])('%s: at-limit enters, above-limit refuses with no capture or replay', async path => {
    gitProject();
    const send = entry.runAdapter;
    for (const offset of [0, 1]) {
      let calls = 0;
      const run = vi.fn<Adapter['run']>(async () => ({ output: path === 'correction' && ++calls === 1 ? '{broken' : JSON.stringify(fields), exitCode: 0, duration_ms: 0 }));
      const capture = vi.fn();
      const route = vi.spyOn(entry, 'runAdapter').mockImplementation((adapter, prompt, agent, options, inputLimit, beforeSend, duration) => {
        const target = path === 'correction' && route.mock.calls.length === 1 ? 0 : offset;
        return send(adapter, prompt, agent, { ...options, timeout_ms: options.timeout_ms + target }, inputLimit, () => { capture(); beforeSend?.(); }, duration);
      });
      let result;
      try { result = await writeTaskBrief(`---\nstage_duration_ms: ${limit}\n---\nTask`, { projectDir: project, adapter: 'mock', role, adapterInstance: { run }, replay: false }); }
      finally { route.mockRestore(); }
      if (offset) { expect(capture).toHaveBeenCalledTimes(path === 'correction' ? 1 : 0); expect(run).toHaveBeenCalledTimes(path === 'correction' ? 1 : 0); expect(result).toMatchObject({ outcome: 'duration_limit', refusal: { requestedBudgetMs: limit + 1, limit } }); }
      else { expect(result.outcome, result.reasons.join('\n')).toBe('ready'); expect(run).toHaveBeenCalledTimes(path === 'correction' ? 2 : 1); expect(run.mock.calls[0][2].timeout_ms).toBe(limit); }
    }
  });
  it('rejects an invalid duration declaration before authorship evidence or adapter execution', async () => {
    gitProject(); const run = vi.fn<Adapter['run']>();
    const directory = join(fcGlobalDir(), 'brief-writing');
    const existed = existsSync(directory);
    await expect(writeTaskBrief('---\nstage_duration_ms: -1\n---\nTask', { projectDir: project, adapter: 'mock', role, adapterInstance: { run } }))
      .rejects.toMatchObject({ code: 'declaration_invalid', keyPath: 'stage_duration_ms' });
    expect(run).not.toHaveBeenCalled(); expect(existsSync(directory)).toBe(existed);
  });
});

describe('historical readers', () => {
  it('keeps pre-change records readable and byte exact in status, watch, listing and the UI API', async () => {
    const runId = 'legacy-duration-record', directory = join(fcGlobalDir(), 'runs', runId); mkdirSync(directory, { recursive: true });
    const bytes = JSON.stringify({ runId, workflowName: 'fixture', projectDir: project, status: 'complete', stages: {},
      startedAt: '2030-01-01T00:00:00Z', completedAt: '2030-01-01T00:01:00Z',
      taskDescription: '---\nstage_duration_ms: retired-invalid-value\ninputs: {data: old.csv}\n---\nAdmitted' });
    writeFileSync(join(directory, 'run.json'), bytes);
    expect(readRunState(project, runId)).not.toHaveProperty('stageDurationLimitMs'); expect(listRuns(project)).toContain(runId);
    expect(pollWatch(createWatchState(), { runsRoot: join(fcGlobalDir(), 'runs'), candidateRunIds: () => [runId] }).heartbeat.stats.readableRuns).toBe(1);
    const status = isolatedProjectCommand(process.execPath, ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'src/cli.ts'), 'status', '--project', project], project, root);
    expect(status).toContain(runId); expect(status).toContain('Status: complete');
    const app = await startDashboard(project, 0, { distDir: join(root, 'unused-dist') });
    try { const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
      expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ runId, status: 'complete' });
      expect(response.json()).not.toHaveProperty('stageDurationLimitMs');
    } finally { await app.close(); }
    expect(readFileSync(join(directory, 'run.json'), 'utf8')).toBe(bytes);
  });
});
