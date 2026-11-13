import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as owner from '../src/adapters/base.js';
import * as homes from '../src/adapter-home.js';
import * as liveness from '../src/process-liveness.js';
import * as gitFacts from '../src/git-facts.js';
import * as rehearsal from '../src/rehearse.js';
import { writeTaskBrief } from '../src/brief-writer.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { AttemptDeadlineController } from '../src/attempt-deadline.js';
import { providerFailureFromDiagnostic } from '../src/provider-result.js';
import { admitStageDuration } from '../src/stage-duration.js';
import { runStage } from '../src/worker.js';
import { EngineStateError } from '../src/engine-integrity.js';
import { readStageStatus, updateRunState } from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { createRun } from './test-support/create-run.js';
import { manualResearchClock } from './test-support/research-clock.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { stageRecordSchema } from '../src/handoff.js';

const native = vi.hoisted(() => ({ spawn: vi.fn(), helper: vi.fn() }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  native.spawn = vi.fn(actual.spawn); native.helper = vi.fn(actual.spawnSync);
  return { ...actual, spawn: native.spawn, spawnSync: native.helper };
});

const role: owner.AgentConfig = { name: 'fixture', description: '', model: 'fixture', reasoning_effort: 'low', tools: [], prompt: 'Complete finite work.' };
const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'attempt-clock-')); roots.push(value); return value; };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(budget?: number) {
  const project = root(), created = createRun(project, 'fixture', 'name: fixture\nstages: []', ['work']);
  if (budget !== undefined) updateRunState(project, created.runId, state => { state.stageDurationLimitMs = budget; });
  const time = manualResearchClock();
  const options = { stageId: 'work', role, dependsOn: [], promptTemplate: 'Complete finite work.',
    artifactContract: fixtureArtifactContract('work'), outputSchema: stageRecordSchema({}),
    projectDir: project, runId: created.runId, runDir: created.runDirPath, retries: 0, deadlineClock: time.clock };
  return { ...created, project, time, options, status: () => readStageStatus(project, created.runId, 'work') };
}
const completed = (): owner.RunResult => ({ exitCode: 0, duration_ms: 1,
  output: JSON.stringify({ status: 'delivered', summary: 'Finite work completed.', caveats: [], remaining_work: [] }) });

describe('stage attempt clock facts', () => {
  it('T02 a slow result before the declared allowance uses the same single invocation as a fast one', async () => {
    for (const elapsed of [1, 19_999]) {
      const f = fixture(20_000), run = vi.fn<owner.Adapter['run']>(async (_prompt, _role, opts) => {
        f.time.advanceTo(elapsed);
        expect(opts.abortSignal?.aborted).toBe(false);
        expect(opts.timeout_ms).toBeUndefined(); // one attempt owner, no earlier native clock
        return completed();
      });
      const result = await runStage({ run }, f.options);
      expect(result).toMatchObject({ exitCode: 0, endingCause: 'complete' });
      expect(result.continuation).toBeUndefined(); expect(run).toHaveBeenCalledOnce();
      expect(readRunEvents(f.project, f.runId).filter(e => e.type.startsWith('stage_wrap_up'))).toEqual([]);
      expect(f.time.timers.size).toBe(0);
    }
  });

  it('T01 an undeclared stage finishes identically beyond the former engine default', async () => {
    expect(admitStageDuration('Finite task')).toBeUndefined();
    expect(admitStageDuration('---\nstage_duration_ms: 21600000\n---\nFinite task')).toBe(21_600_000);
    for (const elapsed of [1, 21_600_000]) {
      const f = fixture();
      const result = await runStage({ async run(_p, _r, opts) {
        f.time.advanceTo(elapsed); expect(opts.abortSignal?.aborted).toBe(false); return completed();
      } }, f.options);
      expect(result).toMatchObject({ exitCode: 0, endingCause: 'complete' }); expect(result.continuation).toBeUndefined();
      expect(f.status().timeout?.deadlineAt).toBeUndefined(); expect(f.time.timers.size).toBe(0);
    }
  });

  it('T01 a declared allowance beyond calendar representation still waits for its event', () => {
    const time = manualResearchClock(), budgetMs = Number.MAX_SAFE_INTEGER;
    expect(admitStageDuration(`---\nstage_duration_ms: ${budgetMs}\n---\nFinite task`)).toBe(budgetMs);
    const deadline = new AttemptDeadlineController({ budgetMs, clock: time.clock });
    try { time.advanceTo(21_600_000); expect(deadline.signal.aborted).toBe(false); expect(deadline.remainingMs()).toBeGreaterThan(0); }
    finally { deadline.dispose(); }
    expect(time.timers.size).toBe(0);
  });

  it.each([40, 20_000])('T01 exact declared allowance %s retains unfinished files and hands on without a failure verdict', async budget => {
    const f = fixture(budget), ready = deferred(), closed = deferred<owner.RunResult>();
    const pending = runStage({ run(_p, _r, opts) {
      writeFileSync(join(f.project, 'retained.txt'), 'partial unit');
      opts.abortSignal!.addEventListener('abort', () => closed.resolve({ exitCode: 137, output: '', duration_ms: budget }), { once: true });
      ready.resolve(); return closed.promise;
    } }, { ...f.options, scope: ['.'] });
    await Promise.race([ready.promise, pending.then(() => { throw new Error('Stage settled before entering the adapter'); })]); f.time.advanceTo(budget - 1); expect(f.status().status).toBe('running');
    f.time.advanceTo(budget);
    expect(await pending).toMatchObject({ exitCode: 0, terminationCause: 'exit', endingCause: 'work_unfinished', continuation: { reason: 'stage_budget', forced: true } });
    expect(readFileSync(join(f.project, 'retained.txt'), 'utf8')).toBe('partial unit');
    expect(f.status().attempts?.at(-1)).toMatchObject({ endingCause: 'work_unfinished', timeout: { budgetMs: budget, childClosedAt: expect.any(String) } });
    expect(f.time.timers.size).toBe(0);
  });

  it('T03 slow closure acknowledgement after an explicit stop stays running until the real close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    for (const closureDelay of [1, 60_000]) {
      const f = fixture(), entered = deferred(), close = deferred<owner.RunResult>(), cancel = new AbortController();
      let settled = false;
      const pending = owner.withRunProcessOwnership(f.project, f.runId, () => runStage({ run(_p, _r, opts) {
        expect(opts.abortSignal?.aborted).toBe(false); entered.resolve(); return close.promise;
      } }, f.options), cancel.signal).then(value => { settled = true; return value; });
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Stage settled before entering the adapter'); })]);
      try {
        cancel.abort(); await vi.advanceTimersByTimeAsync(closureDelay);
        expect(settled).toBe(false); expect(f.status().status).toBe('running');
        expect(f.status().timeout?.childClosedAt).toBeUndefined();
      } finally { close.resolve({ exitCode: 137, output: '', duration_ms: closureDelay }); }
      expect(await pending).toMatchObject({ exitCode: 137, endingCause: 'cancelled' });
      expect(f.status().timeout?.childClosedAt).toEqual(expect.any(String));
    }
  });

  it('T03 an explicit integrity refusal still voids the attempt', async () => {
    const f = fixture();
    const result = await runStage({ async run() { throw new EngineStateError('Explicit integrity evidence'); } }, f.options);
    expect(result).toMatchObject({ exitCode: 125, engineVoid: true, endingCause: 'engine_void' });
  });

  it('T05 a healthy retry waits its cadence across the former early wrap-up boundary', async () => {
    const f = fixture(20_000), sleeping = deferred();
    const setTimer = f.time.clock.setTimer;
    f.time.clock.setTimer = (callback, delay) => {
      const timer = setTimer(callback, delay);
      if (delay === 15_000) sleeping.resolve();
      return timer;
    };
    const run = vi.fn<owner.Adapter['run']>(async () => run.mock.calls.length === 1
      ? { output: 'provider overload', exitCode: 1, duration_ms: 1,
          providerFailure: providerFailureFromDiagnostic({ provider: 'codex', eventType: 'error', message: '429 Too Many Requests' }) }
      : completed());
    const pending = runStage({ run }, { ...f.options, technicalRetry: { delaysMs: [15_000] } });
    try {
      await Promise.race([sleeping.promise, pending.then(() => { throw new Error('Stage ended before retry backoff'); })]);
      f.time.advanceTo(12_500); // Former warning under this exact 20-second declaration.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(run).toHaveBeenCalledTimes(1);
      f.time.advanceTo(15_000);
      expect(await pending).toMatchObject({ exitCode: 0, endingCause: 'complete' });
      expect(run).toHaveBeenCalledTimes(2);
    } finally { f.time.advanceTo(20_000); await pending.catch(() => undefined); }
    expect(f.time.timers.size).toBe(0);
  });

  it('T05 retry cadence survives a long wait without a declaration; a declared allowance interrupts the wait', async () => {
    for (const budget of [undefined, 100]) {
      const time = manualResearchClock(), deadline = new AttemptDeadlineController({ budgetMs: budget, clock: time.clock });
      try {
        const pending = deadline.boundedSleep(120_000);
        time.advanceTo(budget ?? 120_000);
        expect(await pending).toBe(budget === undefined);
        expect(deadline.signal.aborted).toBe(budget !== undefined);
      } finally { deadline.dispose(); }
      expect(time.timers.size).toBe(0);
    }
  });
});

function child() {
  const c = Object.assign(new EventEmitter(), { pid: 42_424_242, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  c.kill.mockImplementation((signal: NodeJS.Signals) => { c.emit('close', null, signal); return true; });
  vi.spyOn(liveness, 'processGroupIsAlive').mockReturnValue(false);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => { expect(pid).toBe(-c.pid); return c.kill(signal); });
  native.spawn.mockReturnValue(c as unknown as owner.ChildProcess);
  return c;
}
describe('native child and preparation lifecycle', () => {
  it.each([undefined, 2000])('T06 native timeout=%s waits for close or the declared stop', async timeout_ms => {
    vi.useFakeTimers(); const c = child();
    const pending = owner.execWithStdin('fixture', [], '', { cwd: root(), timeout_ms });
    await vi.advanceTimersByTimeAsync(timeout_ms ?? 21_600_000);
    if (timeout_ms === undefined) expect(c.kill).not.toHaveBeenCalled();
    else expect(c.kill).toHaveBeenCalledWith('SIGTERM');
    c.emit('close', timeout_ms === undefined ? 0 : null, timeout_ms === undefined ? null : 'SIGTERM');
    expect(await pending).toMatchObject({ exitCode: timeout_ms === undefined ? 0 : 124, timedOut: timeout_ms !== undefined });
  });

  it.each([false, true])('T08 Claude retains post-result close facts after slow shutdown (failure=%s)', async failure => {
    vi.useFakeTimers(); const c = child(), runDir = root(), entered = deferred();
    vi.spyOn(homes, 'prepareAdapterHome').mockImplementation(({ home }) => mkdirSync(home, { recursive: true }));
    vi.spyOn(homes, 'withAdapterCredentials').mockImplementation(async (_home, _source, execute) => execute());
    c.stdin.once('finish', () => entered.resolve());
    const pending = new ClaudeAdapter().run('Finite work.', role, { workDir: root(), runDir, stageId: 'work' });
    await entered.promise;
    c.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n');
    try { await vi.advanceTimersByTimeAsync(60_000); expect(c.kill).not.toHaveBeenCalled(); }
    finally { c.emit('close', failure ? 7 : 0, null); }
    expect(await pending).toMatchObject({ exitCode: failure ? 7 : 0, processExitCode: failure ? 7 : 0, processSignal: null, output: 'done' });
  });

  it.each(['home', 'copy'] as const)('P01/P02 slow %s helper completes; actual helper failure still refuses', async mode => {
    vi.useFakeTimers(); const home = root(), source = root();
    const helper = native.helper;
    for (const elapsed of [1, 31_000]) {
      helper.mockImplementation((_cmd, _args, options) => {
        vi.advanceTimersByTime(elapsed);
        return (options?.timeout && options.timeout < elapsed
          ? { status: null, stderr: '', error: new Error('fixture helper timeout') }
          : { status: 0, stderr: '' }) as never;
      });
      if (mode === 'home') homes.prepareAdapterHome({ home });
      else expect(await homes.withAdapterCredentials(home, source, async () => 'copied')).toBe('copied');
    }
    helper.mockReturnValue({ status: 125, stderr: 'explicit helper failure' } as never);
    if (mode === 'home') expect(() => homes.prepareAdapterHome({ home })).toThrow('explicit helper failure');
    else await expect(homes.withAdapterCredentials(home, source, async () => 'unreachable')).rejects.toThrow('explicit helper failure');
  });
});


it.each([undefined, 2000])('T06 brief writing timeout=%s uses only the declaration and hands unfinished facts on', async budget => {
  vi.useFakeTimers();
  vi.spyOn(gitFacts, 'gitSync').mockReturnValue('synthetic-head');
  vi.spyOn(rehearsal, 'rehearseBrief').mockResolvedValue({ findings: [] } as unknown as Awaited<ReturnType<typeof rehearsal.rehearseBrief>>);
  const run = vi.fn<owner.Adapter['run']>(async (_p, _r, options) => {
    expect(options.timeout_ms).toBe(budget);
    await vi.advanceTimersByTimeAsync(budget ?? 21_600_000);
    return budget === undefined ? { exitCode: 0, duration_ms: 21_600_000, output: JSON.stringify({
      criteria: ['Complete finite work.'], constraints: [], inputs: [], assumptions: [], blocking_questions: [],
    }) } : { exitCode: 124, timedOut: true, output: 'partial brief evidence', duration_ms: budget };
  });
  const result = await writeTaskBrief(budget === undefined ? 'Finite task' : `---\nstage_duration_ms: ${budget}\n---\nFinite task`,
    { projectDir: root(), role, adapter: 'fixture', adapterInstance: { run }, replay: false });
  expect(result.outcome).toBe(budget === undefined ? 'ready' : 'unfinished');
  expect(run).toHaveBeenCalledOnce();
});
