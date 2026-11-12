import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunOpts } from '../src/adapters/base.js';
import * as inputOwner from '../src/adapter-input.js';
import { loadEngineDefaults } from '../src/config.js';
import { runStage, type StageOpts } from '../src/worker.js';
import { stageRecordSchema } from '../src/handoff.js';
import { stageWrapUpTiming, type AttemptDeadlineClock } from '../src/attempt-deadline.js';
import { appendGuidanceEnvelope } from '../src/guidance.js';
import { fcGlobalDir, listRuns, readRunState, readStageOutput, readStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { latestInvocationInput } from '../src/run-state-view.js';
import { createRun } from './test-support/create-run.js';
import { writeTaskBrief } from '../src/brief-writer.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { prepareWorkflowLaunch } from '../src/scheduler/sched_loop/launch.js';
import { WorkflowConfigSchema, runWorkflow } from '../src/scheduler.js';
import { invalidateRunLockCache, releaseLaunchIntent, writeSchedulerProcessIdentity } from '../src/run-lock.js';
import { executeReadyBatch } from '../src/scheduler/sched_loop/stage-batch.js';
import { startDashboard } from '../src/dashboard.js';
import { createWatchState, pollWatch } from '../src/watch.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import * as adapterLoader from '../src/adapters/loader.js';

// Keep assembly deterministic without git-diff cost or random recorder paths.
// The production owner, worker, input capture and attempt settlement remain real.
vi.mock('../src/evidence-ledger.js', async original => ({
  ...await original<typeof import('../src/evidence-ledger.js')>(), evidenceContext: () => 'Synthetic ledger reference.',
}));
vi.mock('../src/recorded-command.js', () => ({ startCommandRecorder: async () => ({ command: 'fixture-recorder', close: async () => {} }) }));

const role: AgentConfig = { name: 'fixture', description: '', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'System 🌿\r\n' };
const contract = { version: 1 as const, produces: [], reads: [], groups: [] };
const valid = JSON.stringify({ status: 'delivered', summary: 'Done.', caveats: [], remaining_work: [] });
let root: string, project: string, prior: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'input-boundary-')); project = join(root, 'project'); mkdirSync(project);
  prior = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
});
afterEach(() => { setFcGlobalDir(prior); rmSync(root, { recursive: true, force: true }); });

function clock() {
  let elapsed = 0;
  const started = Date.parse('2030-01-01T00:00:00.000Z');
  const timers = new Map<object, { at: number; callback: () => void }>();
  const value: AttemptDeadlineClock = { monotonicNow: () => elapsed, wallNow: () => started + elapsed,
    setTimer(callback, delay) { const timer = {}; timers.set(timer, { at: elapsed + delay, callback }); return timer as ReturnType<typeof setTimeout>; },
    clearTimer(timer) { timers.delete(timer); } };
  return { value, advanceTo(at: number) { elapsed = at; for (const [id, timer] of [...timers]) if (timer.at <= at) { timers.delete(id); timer.callback(); } } };
}

describe('the single adapter input owner', () => {
  it.each(['codex', 'claude', undefined])('sends the exact fitting input and refuses before capture (%s)', async sessionKind => {
    const limit = inputOwner.adapterInputLimit({ sessionKind });
    expect(limit).toBe(sessionKind ? loadEngineDefaults().adapter_input_limit_chars[sessionKind as 'codex' | 'claude']
      : Math.min(...Object.values(loadEngineDefaults().adapter_input_limit_chars)));
    for (const offset of [-1, 0, 1]) {
      const prompt = '原\r\n🌿' + 'x'.repeat(limit + offset - role.prompt.length - 5);
      expect(inputOwner.adapterInputLength(role.prompt, prompt)).toBe(limit + offset);
      const run = vi.fn<Adapter['run']>(async () => ({ output: '', exitCode: 0, duration_ms: 0 }));
      const capture = vi.fn();
      const result = await inputOwner.runAdapter({ sessionKind, run }, prompt, role, {} as RunOpts, undefined, capture);
      if (offset <= 0) { expect(run).toHaveBeenCalledExactlyOnceWith(prompt, role, {}); expect(capture).toHaveBeenCalledOnce(); }
      else { expect(run.mock.calls.length).toBe(0); expect(capture.mock.calls.length).toBe(0);
        expect(result.providerFailure).toMatchObject({ kind: 'input_too_large', source: 'input_limit', measuredLength: limit + 1, limit }); }
    }
  });

  it('caps role-selected adapters by both the run contract and actual adapter configuration', async () => {
    const engine = loadEngineDefaults().adapter_input_limit_chars;
    expect(inputOwner.adapterInputLimit({ sessionKind: 'codex' }, 100)).toBe(100);
    expect(inputOwner.adapterInputLimit({ sessionKind: 'claude' }, engine.codex)).toBe(engine.claude);
    expect(inputOwner.adapterInputLimit({ sessionKind: 'codex' }, engine.claude)).toBe(engine.claude);
  });
});

const paths = ['ordinary', 'gate', 'planner', 'successor', 'isolated-shape', 'isolated-review', 'isolated-successor', 'correction', 'guidance', 'wrap-up'] as const;
type SendingPath = typeof paths[number];

async function worker(path: SendingPath, limit = 500_000, capturesInvocationInput = false) {
  const created = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']);
  updateRunState(project, created.runId, state => { state.inputLimitChars = limit; });
  const time = clock(), seen: Array<{ prompt: string; system: string }> = [];
  const adapter: Adapter = { sessionKind: 'codex', capturesInvocationInput, async run(prompt, agent, opts) {
    seen.push({ prompt, system: agent.prompt });
    if (capturesInvocationInput) opts.onInvocationInput?.({ userPrompt: prompt, systemPrompt: agent.prompt });
    if (seen.length === 1 && path === 'guidance') {
      opts.onCommandLifecycle?.({ phase: 'started', id: 'tool', timestamp: new Date().toISOString() });
      appendGuidanceEnvelope({ runDir: created.runDirPath, target: 'work', source: 'operator', body: 'G'.repeat(5000), knownStageIds: ['work'] });
      opts.onCommandLifecycle?.({ phase: 'completed', id: 'tool', timestamp: new Date().toISOString() });
    }
    if (seen.length === 1 && path === 'wrap-up') time.advanceTo(stageWrapUpTiming(10_000).warningAfterMs);
    return { output: seen.length === 1 && path === 'correction' ? '{"unexpected":true}' : valid,
      exitCode: opts.abortSignal?.aborted ? 137 : path === 'gate' ? 1 : 0, duration_ms: 1 };
  } };
  const options: StageOpts = { ...created, runDir: created.runDirPath, projectDir: project, stageId: 'work', role,
    dependsOn: [], promptTemplate: 'P'.repeat(100_000), timeout_ms: 10_000, deadlineClock: time.value, retries: 0,
    artifactContract: contract, technicalRetry: { delaysMs: [0, 0] },
    isGate: path === 'gate', dynamicDispatch: path === 'planner',
    outputSchema: path === 'correction' ? stageRecordSchema({}) : undefined,
    decisionResult: path === 'successor' || path.startsWith('isolated-') };
  if (path.startsWith('isolated-')) options.isolatedInput = { system: 'Isolated system.', user: 'I'.repeat(100_000) };
  const result = await runStage(adapter, options);
  return { ...created, result, seen };
}

describe('every worker sending path at the assembled boundary', () => {
  it.each(paths)('%s: just under passes unchanged; just over has no call, capture or replay', async path => {
    const calibration = await worker(path);
    const target = ['correction', 'guidance', 'wrap-up'].includes(path) ? 1 : 0;
    expect(calibration.seen).toHaveLength(target + 1);
    const candidate = calibration.seen[target];
    const measured = inputOwner.adapterInputLength(candidate.system, candidate.prompt);
    for (const captures of [false, true]) for (const offset of [-1, 1]) {
      const observed = await worker(path, measured - offset, captures);
      if (offset < 0) {
        expect(observed.result.providerFailure).toBeUndefined();
        expect(observed.seen).toHaveLength(target + 1);
        expect(inputOwner.adapterInputLength(observed.seen[target].system, observed.seen[target].prompt)).toBe(measured);
        // The unmodified template survives all assembly and sending.
        expect(observed.seen[target].prompt).toContain((path.startsWith('isolated-') ? 'I' : 'P').repeat(100_000));
      } else {
        expect(observed.seen).toHaveLength(target);
        expect(observed.result.providerFailure).toMatchObject({ kind: 'input_too_large', provider: 'engine', measuredLength: measured, limit: measured - 1 });
        const stored = readStageStatus(project, observed.runId, 'work');
        expect(stored.attempts).toHaveLength(1);
        expect(stored.attempts![0].providerFailure).toEqual(observed.result.providerFailure);
        const input = latestInvocationInput(observed.runDirPath, 'work');
        if (target === 0) { expect(input).toBeUndefined(); expect(existsSync(runRecordPath(observed.runDirPath, 'stages/work/invocations'))).toBe(false); }
        else { expect(input?.record.invocationIndex).toBe(1); }
      }
    }
  });
});

function gitProject() {
  isolatedProjectCommand('git', ['init', '-q'], project, root);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'], project, root);
}
const fields = { criteria: ['Deliver the result.'], constraints: [], inputs: [], assumptions: [], blocking_questions: [] };

describe('pre-admission brief writer', () => {
  it('uses the resolved brief-writer adapter rather than the requested run adapter for its ceiling', async () => {
    gitProject();
    setEngineDefaults({ adapter_input_limit_chars: { codex: 100_000, claude: 20_000 } });
    const run = vi.fn<Adapter['run']>();
    const load = vi.spyOn(adapterLoader, 'loadAdapterByName').mockResolvedValue({ sessionKind: 'claude', run });
    const written = await writeTaskBrief('T'.repeat(30_000), { projectDir: project, adapter: 'codex', role: { ...role, adapter: 'claude' } });
    expect(load).toHaveBeenCalledExactlyOnceWith('claude'); expect(run.mock.calls.length).toBe(0);
    expect(written).toMatchObject({ outcome: 'input_too_large', refusal: { limit: 20_000 } });
    expect(existsSync(join(fcGlobalDir(), 'brief-writing'))).toBe(false);
  });

  it.each([0, -1, 1.5, '100', null, 2_000_000].map(declared => ({ declared })))('refuses invalid declaration $declared before authorship evidence', async ({ declared }) => {
    gitProject();
    const run = vi.fn<Adapter['run']>();
    const brief = `---\ninput_limit_chars: ${JSON.stringify(declared)}\n---\nTask`;
    await expect(writeTaskBrief(brief, { projectDir: project, adapter: 'mock', role, adapterInstance: { sessionKind: 'codex', run } }))
      .rejects.toMatchObject({ declaredLimit: declared, engineLimit: inputOwner.adapterInputLimit({ sessionKind: 'codex' }) });
    expect(run).not.toHaveBeenCalled(); expect(existsSync(join(fcGlobalDir(), 'brief-writing'))).toBe(false);
  });

  it.each(['initial', 'correction'])('%s: just under is unchanged; just over persists no refused input and does not replay', async path => {
    gitProject();
    const original = 'Task 🌿\r\n' + 'T'.repeat(10_000);
    const all = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? all(join(dir, entry.name)) : [join(dir, entry.name)]) : [];
    async function author(limit: number) {
      setEngineDefaults({ adapter_input_limit_chars: { codex: limit, claude: limit } });
      const calls: string[] = [];
      const adapter: Adapter = { sessionKind: 'codex', async run(prompt, _role, opts) {
        calls.push(prompt); opts.onInvocationInput?.({ userPrompt: prompt, systemPrompt: role.prompt });
        return { output: path === 'correction' && calls.length === 1 ? '{broken' : JSON.stringify(fields), exitCode: 0, duration_ms: 0 };
      } };
      const written = await writeTaskBrief(original, { projectDir: project, adapter: 'mock', adapterInstance: adapter, role, replay: false });
      return { written, calls };
    }
    const calibration = await author(100_000), target = path === 'correction' ? 1 : 0;
    expect(calibration.calls).toHaveLength(target + 1);
    const measured = inputOwner.adapterInputLength(role.prompt, calibration.calls[target]);
    const under = await author(measured + 1);
    expect(under.calls[target]).toBe(calibration.calls[target]); expect(under.written.outcome).toBe('ready');
    const beforeRefusal = new Set(all(join(fcGlobalDir(), 'brief-writing')));
    const over = await author(measured - 1);
    expect(over.calls).toHaveLength(target); expect(over.written).toMatchObject({ outcome: 'input_too_large', refusal: { measuredLength: measured, limit: measured - 1 } });
    const added = all(join(fcGlobalDir(), 'brief-writing')).filter(file => !beforeRefusal.has(file));
    if (target === 0) expect(added).toEqual([]);
    else { expect(added.filter(file => file.endsWith('.invocation.json'))).toHaveLength(1);
      expect(added.filter(file => /\.native-/.test(file))).toHaveLength(1); }
    const refused = all(join(fcGlobalDir(), 'brief-writing')).filter(path => path.endsWith('.invocation.json'))
      .map(path => JSON.parse(readFileSync(path, 'utf8'))).filter(record => record.inputLimitChars === measured - 1);
    expect(refused).toHaveLength(target);
    expect(refused.some(record => record.prompt === calibration.calls[target])).toBe(false);
  });
});

describe('admitted numeric contract and resume', () => {
  it.each(['codex', 'claude'].flatMap(sessionKind => [false, true].map(lower => ({ sessionKind, lower }))))('admits the engine number or a lower declared number ($sessionKind, lower=$lower)', async ({ sessionKind, lower }) => {
    const engine = inputOwner.adapterInputLimit({ sessionKind });
    expect(inputOwner.admitInputLimit('Opaque text.', engine)).toBe(engine);
    expect(inputOwner.admitInputLimit('---\ninput_limit_chars: 100000\n---\nTask', engine)).toBe(100_000);
    const run = vi.fn<Adapter['run']>(async () => ({ output: '', exitCode: 1, duration_ms: 0 }));
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 1, max_retries: 0 }, stages: [{ id: 'work', role: 'fixture', scope: [], artifact_contract: contract }] });
    const state = await runWorkflow(workflow, '', project, { sessionKind, run }, new Map([['fixture', role]]), undefined,
      join(import.meta.dirname, '../config/agents'), undefined, lower ? '---\ninput_limit_chars: 100000\n---\nTask' : 'Task');
    expect(state.inputLimitChars).toBe(lower ? 100_000 : engine);
    expect(readRunState(project, state.runId).inputLimitChars).toBe(lower ? 100_000 : engine);
  });

  it.each([0, -1, 1.5, '100', null, {}, [], true, 2_000_000].map(declared => ({ declared })))('refuses declaration $declared before run creation with declared and engine values', ({ declared }) => {
    const engine = 500_000, brief = `---\ninput_limit_chars: ${JSON.stringify(declared)}\n---\nTask`;
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'work', role: 'fixture', scope: [] }] });
    const before = listRuns(project);
    let error: unknown;
    try { prepareWorkflowLaunch(workflow, '', project, undefined, brief, undefined, engine); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(inputOwner.InputLimitDeclarationError);
    expect(error).toMatchObject({ code: 'input_limit_declaration', declaredLimit: declared, engineLimit: engine });
    expect(listRuns(project)).toEqual(before);
  });

  it.each([false, true])('resume reads the persisted number, or engine configuration for a legacy admission (legacy=%s)', async legacy => {
    setEngineDefaults({ adapter_input_limit_chars: { codex: 333_333, claude: 333_333 } });
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'work', role: 'fixture', scope: [] }] });
    const created = createRun(project, 'fixture', JSON.stringify(workflow), ['work']);
    updateRunState(project, created.runId, state => {
      state.taskDescription = '---\ninput_limit_chars: invalid-old-value\n---\nAdmitted task';
      state.status = 'failed';
      if (!legacy) state.inputLimitChars = 123_456;
    });
    const launch = prepareWorkflowLaunch(workflow, '', project, created.runId, undefined, undefined, 333_333);
    expect(launch.kind).toBe('ready');
    expect(readRunState(project, created.runId).inputLimitChars).toBe(legacy ? 333_333 : 123_456);
    const run = vi.fn<Adapter['run']>(async () => ({ output: valid, exitCode: 0, duration_ms: 0 }));
    const result = await runStage({ sessionKind: 'codex', run }, { projectDir: project, runId: created.runId, runDir: created.runDirPath,
      stageId: 'work', role, dependsOn: [], promptTemplate: 'P'.repeat(400_000), timeout_ms: 10_000, retries: 0, artifactContract: contract });
    expect(run.mock.calls.length).toBe(0);
    expect(result.providerFailure).toMatchObject({ source: 'input_limit', limit: legacy ? 333_333 : 123_456 });
    if (launch.kind === 'ready') { rmSync(launch.schedulerPidPath, { force: true }); releaseLaunchIntent(project, created.runId); }
  });

  it.each(['.nan', '.inf', '-.inf', '9007199254740992'])('refuses non-finite or unsafe declared number %s', number => {
    expect(() => inputOwner.admitInputLimit(`---\ninput_limit_chars: ${number}\n---\nTask`, 500_000))
      .toThrow(inputOwner.InputLimitDeclarationError);
  });

  it('retains invalid numeric and cyclic declaration values in typed admission diagnostics', () => {
    for (const [yaml, display] of [['.nan', 'NaN'], ['.inf', 'Infinity'], ['&cycle {value: *cycle}', 'Circular']]) {
      let error: unknown;
      try { inputOwner.admitInputLimit(`---\ninput_limit_chars: ${yaml}\n---\nTask`, 500_000); } catch (value) { error = value; }
      expect(error).toBeInstanceOf(inputOwner.InputLimitDeclarationError);
      expect(error).toMatchObject({ engineLimit: 500_000, message: expect.stringContaining(display) });
    }
  });

  it('uses the actual role-selected adapter and stops scheduler retries after numeric refusal', async () => {
    setEngineDefaults({ adapter_input_limit_chars: { codex: 250_000, claude: 150_000 }, stage_technical_retries: 2 });
    const run = vi.fn<Adapter['run']>(async () => ({ output: '', exitCode: 1, duration_ms: 0 }));
    const selected: Adapter = { sessionKind: 'claude', run };
    const load = vi.spyOn(adapterLoader, 'loadAdapterByName').mockResolvedValue(selected);
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 1, max_retries: 2 },
      stages: [{ id: 'work', role: 'fixture', scope: [], prompt_template: 'P'.repeat(160_000), artifact_contract: contract }] });
    const created = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']);
    updateRunState(project, created.runId, state => { state.inputLimitChars = 250_000; });
    await executeReadyBatch(workflow.stages, readRunState(project, created.runId), project, created.runId, created.runDirPath, workflow,
      { sessionKind: 'codex', run }, new Map([['fixture', { ...role, adapter: 'claude' }]]), project,
      new Map([['fixture', { name: 'fixture', description: '' }]]), new Map());
    const state = readRunState(project, created.runId);
    expect(load, JSON.stringify(state)).toHaveBeenCalledWith('claude'); expect(run.mock.calls.length).toBe(0);
    expect(state).toMatchObject({ status: 'failed', reasonCode: 'input_too_large', inputLimitChars: 250_000 });
    expect(state.stages.work.attempts).toHaveLength(1);
    expect(state.stages.work.attempts![0].providerFailure).toMatchObject({ source: 'input_limit', limit: 150_000 });
  });

  it('routes an oversized review diff using the lower admitted ceiling before any model call', async () => {
    gitProject(); writeFileSync(join(project, 'change.txt'), 'D'.repeat(50_000));
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'assess', role: 'fixture', scope: [], artifact_contract: contract,
      decision: { kind: 'review', successors: ['review', 'review_full'], default: 'review_full' } }] });
    const created = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['assess']);
    updateRunState(project, created.runId, state => { state.inputLimitChars = 100_000; });
    const run = vi.fn<Adapter['run']>();
    await executeReadyBatch(workflow.stages, readRunState(project, created.runId), project, created.runId, created.runDirPath, workflow,
      { sessionKind: 'codex', run }, new Map([['fixture', role]]), project,
      new Map([['fixture', { name: 'fixture', description: '' }]]), new Map());
    expect(run.mock.calls.length).toBe(0);
    expect(JSON.parse(readStageOutput(project, created.runId, 'assess'))).toMatchObject({ successor: 'review_full',
      reason: expect.stringContaining('against adapter limit 100000') });
    expect(latestInvocationInput(created.runDirPath, 'assess')).toBeUndefined();
  });

  it('reads old records in CLI status, watch, listing and the UI API without adding a limit or re-admitting the brief', async () => {
    setFcGlobalDir(join(root, '.fc'));
    const runId = 'legacy-input-record', directory = join(fcGlobalDir(), 'runs', runId); mkdirSync(directory, { recursive: true });
    const state = { runId, workflowName: 'fixture', projectDir: project, status: 'complete', stages: {},
      startedAt: '2030-01-01T00:00:00Z', completedAt: '2030-01-01T00:01:00Z',
      taskDescription: '---\ninput_limit_chars: retired-value\ninputs: {dataset: old.csv}\n---\nAdmitted task' };
    const bytes = JSON.stringify(state); writeFileSync(join(directory, 'run.json'), bytes);
    expect(readRunState(project, runId)).not.toHaveProperty('inputLimitChars');
    expect(listRuns(project)).toContain(runId);
    expect(pollWatch(createWatchState(), { runsRoot: join(fcGlobalDir(), 'runs'), candidateRunIds: () => [runId] }).heartbeat.stats.readableRuns).toBe(1);
    const status = isolatedProjectCommand(process.execPath, ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'src/cli.ts'), 'status', '--project', project], project, root);
    expect(status).toContain(runId); expect(status).toContain('Status: complete');
    const app = await startDashboard(project, 0, { distDir: join(root, 'unused-dist') });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
      expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ runId, status: 'complete' });
      expect(response.json()).not.toHaveProperty('inputLimitChars');
    } finally { await app.close(); }
    expect(readFileSync(join(directory, 'run.json'), 'utf8')).toBe(bytes);
  });

  it.each([false, true])('preserves the selected adapter ceiling through deterministic review substitution (role override=%s)', async override => {
    gitProject(); writeFileSync(join(project, 'patch.txt'), 'D'.repeat(400_000));
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'assess', role: 'fixture', scope: [], artifact_contract: contract,
      decision: { kind: 'review', successors: ['review', 'review_full'], default: 'review_full' } }] });
    const run = vi.fn<Adapter['run']>();
    const selected: Adapter = { sessionKind: 'codex', run };
    const load = vi.spyOn(adapterLoader, 'loadAdapterByName').mockResolvedValue(selected);
    const send = vi.spyOn(inputOwner, 'runAdapter');
    async function assess(limit: number) {
      const created = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['assess']);
      updateRunState(project, created.runId, state => { state.inputLimitChars = limit; state.taskDescription = 'T'.repeat(700_000); });
      await executeReadyBatch(workflow.stages, readRunState(project, created.runId), project, created.runId, created.runDirPath, workflow,
        override ? { sessionKind: 'claude', run } : selected, new Map([['fixture', override ? { ...role, adapter: 'codex' } : role]]), project,
        new Map([['fixture', { name: 'fixture', description: '' }]]), new Map(), undefined, undefined, undefined, () => clock().value);
      expect(run).not.toHaveBeenCalled();
      expect(latestInvocationInput(created.runDirPath, 'assess')).toBeUndefined();
      const args = send.mock.calls.at(-1)!;
      expect(args[0].sessionKind).toBe('codex');
      return { ...created, state: readRunState(project, created.runId), measured: inputOwner.adapterInputLength(args[2].prompt, args[1]) };
    }
    // Keep the same bounded diff facts while calibrating the final assembled input.
    const calibration = await assess(750_000);
    expect(calibration.state.stages.assess.status).toBe('complete');
    expect(JSON.parse(readStageOutput(project, calibration.runId, 'assess')).successor).toBe('review_full');
    const under = await assess(calibration.measured + 1);
    expect(under.measured).toBe(calibration.measured);
    expect(under.state.stages.assess.status).toBe('complete');
    expect(JSON.parse(readStageOutput(project, under.runId, 'assess')).successor).toBe('review_full');
    const over = await assess(calibration.measured - 1);
    expect(over.measured).toBe(calibration.measured);
    expect(over.state).toMatchObject({ status: 'failed', reasonCode: 'input_too_large' });
    expect(over.state.stages.assess.attempts).toHaveLength(1);
    expect(over.state.stages.assess.attempts![0].providerFailure).toMatchObject({ measuredLength: over.measured, limit: over.measured - 1 });
    if (override) expect(load).toHaveBeenCalledWith('codex');
  });

  it.each((['cancelled', 'parked'] as const).flatMap(status => [false, true].map(recorded => ({ status, recorded }))))(
    'persists the limit with the admitted $status resume transition (recorded=$recorded)', ({ status, recorded }) => {
      const workflow = WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 3 },
        stages: [{ id: 'work', role: 'fixture', scope: [], artifact_contract: contract }] });
      const created = createRun(project, workflow.name, JSON.stringify(workflow), ['work']);
      updateRunState(project, created.runId, state => {
        state.status = status; state.currentIteration = 1; state.maxIterations = 3;
        state.completedAt = '2030-01-01T00:00:00Z';
        state.taskDescription = '---\ninput_limit_chars: retired-value\n---\nPreviously admitted';
        if (recorded) state.inputLimitChars = 123_456;
      });
      const launch = prepareWorkflowLaunch(workflow, '', project, created.runId, undefined, undefined, 333_333);
      try {
        expect(launch.kind).toBe('ready');
        expect(readRunState(project, created.runId)).toMatchObject({ status: 'running', inputLimitChars: recorded ? 123_456 : 333_333 });
      } finally {
        if (launch.kind === 'ready') { rmSync(launch.schedulerPidPath, { force: true }); releaseLaunchIntent(project, created.runId); }
      }
    });

  it.each([false, true])('keeps a sibling-blocked parked admission byte exact (recorded=%s)', recorded => {
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 3 },
      stages: [{ id: 'work', role: 'fixture', scope: [], artifact_contract: contract }] });
    const created = createRun(project, workflow.name, JSON.stringify(workflow), ['work']);
    updateRunState(project, created.runId, state => {
      state.status = 'parked'; state.taskDescription = 'Previously admitted'; state.currentIteration = 1; state.maxIterations = 3;
      state.parked = { requestId: 'fixture', action: 'deploy', target: 'project', reason: 'Fixture', atIteration: 1,
        requestedAt: '2030-01-01T00:00:00Z', pausedAt: '2030-01-01T00:00:01Z' };
      if (recorded) state.inputLimitChars = 123_456;
    });
    const sibling = createRun(project, 'sibling', 'name: sibling\nstages: []\n', []);
    const siblingPid = runRecordPath(sibling.runDirPath, 'scheduler.pid');
    writeFileSync(siblingPid, String(process.pid));
    writeSchedulerProcessIdentity(sibling.runDirPath, sibling.runId, process.pid);
    const before = readFileSync(runRecordPath(created.runDirPath, 'run.json'), 'utf8');
    try {
      const launch = prepareWorkflowLaunch(workflow, '', project, created.runId, undefined, undefined, 333_333);
      expect(launch.kind).toBe('settled');
      expect(readFileSync(runRecordPath(created.runDirPath, 'run.json'), 'utf8')).toBe(before);
      expect(existsSync(runRecordPath(created.runDirPath, 'scheduler.pid'))).toBe(false);
    } finally { rmSync(siblingPid, { force: true }); invalidateRunLockCache(); }
  });
});
