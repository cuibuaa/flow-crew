import { readEvidence } from '../src/evidence-ledger.js';
import { parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import './test-support/policy-runtime.js';
import * as contractProbe from '../src/stage-artifact-contract.js';
import { providerFailureFromEvent, providerFailureFromDiagnostic } from '../src/provider-result.js';
import { atomicWrite } from '../src/engine-fs.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { withRunProcessOwnership } from '../src/adapters/base.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { ATTEMPT_CLOSE_OBSERVATION_TOLERANCE_MS, stageWrapUpTiming, type AttemptDeadlineClock } from '../src/attempt-deadline.js';
import { HANDOFF_SCHEMA, RECORDED_HANDOFF_SCHEMA, parseStageRecord, stageRecordSchema } from '../src/handoff.js';
import { createRun } from './test-support/create-run.js';
import { beginStageAttempt, completeStageAttempt, attachStageConstraintAudit, isContinuingStage, runDir, readRunState, readStageStatus, updateRunState, writeStageStatus } from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { WorkflowConfigSchema, normalizeStageContracts, findAllReady, tryTerminateOnTerminalState, runWorkflow } from '../src/scheduler.js';
import { StageWatchdog } from '../src/stage-watchdog.js';
import { recordGateValidationDelta, settledGateValidationExecution } from '../src/scheduler/sched_settlement/gate-validation.js';
import { RUN_VALIDATION_BASELINE_FILE } from '../src/scheduler/sched_policy/terminal.js';
import { decideStageRetry, executeSingleStage } from '../src/scheduler/sched_settlement/stage-execution.js';
import { executeIteration } from '../src/scheduler/sched_loop/iteration.js';
import { readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { prepareWorkflowIteration } from '../src/scheduler/sched_loop/iteration-setup.js';
import { prepareWorkflowLaunch, workflowContinuation } from '../src/scheduler/sched_loop/launch.js';
import { runStage } from '../src/worker.js';
import { fixtureArtifactContract, fixtureResult } from './test-support/declared-dispatch.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
const role: AgentConfig = { name: 'coder', description: '', model: 'fixture', reasoning_effort: 'default', tools: ['default'], prompt: 'Complete the declared duties.' };
const budget = 20000;
function manualClock() {
  let elapsed = 0;
  const started = Date.now();
  const timers = new Map<ReturnType<typeof setTimeout>, {
    at: number;
    callback: () => void;
  }>();
  const clock: AttemptDeadlineClock = { monotonicNow: () => elapsed, wallNow: () => started + elapsed,
    setTimer(callback, delay) { const timer = {} as ReturnType<typeof setTimeout>; timers.set(timer, { at: elapsed + delay, callback }); return timer; },
    clearTimer(timer) { timers.delete(timer); } };
  return { clock, timers, advanceTo(value: number) {
      elapsed = value;
      for (const [timer, entry] of [...timers])
        if (entry.at <= elapsed) {
          timers.delete(timer);
          entry.callback();
        }
    } };
}
let root: string, project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-stage-budget-'));
  project = join(root, 'project');
  mkdirSync(project);
  setEngineDefaults({ default_timeout_ms: budget, stage_technical_retries: 1 });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function options(created: {
  runId: string;
  runDirPath: string;
}, time = manualClock()) {
  return { stageId: 'work', role, dependsOn: [], promptTemplate: 'Complete two units and retain unit 1 for continuation.',
    artifactContract: fixtureArtifactContract('work'), outputSchema: HANDOFF_SCHEMA,
    timeout_ms: budget, deadlineClock: time.clock, projectDir: project, runId: created.runId, runDir: created.runDirPath,
    retries: 0, };
}
const completed = (opts: RunOpts, summary = 'Done: unit 1. Remaining: unit 2.'): RunResult => {
  const refs = opts.outputSchema?.anyOf?.[0].properties?.criteria.required ?? [];
  return opts.outputSchema?.anyOf ? { exitCode: 0, duration_ms: 1, output: JSON.stringify({ pass: true, reason: summary,
      criteria: Object.fromEntries(refs.map(id => [id, { status: 'pass', evidence: 'Synthetic fixture evidence.' }])), audit_findings: { version: 1, findings: [] } }) }
    : fixtureResult({ exitCode: 0, output: summary, duration_ms: 1 }, opts) as RunResult;
};
/** Actual CLI transports, with deterministic local executables and empty provider homes. */
function nativeFixture(provider: 'codex' | 'claude', time: ReturnType<typeof manualClock>, mode: 'cooperate' | 'ignore', session: boolean) {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const name of ['provider', 'plugins', 'skills'])
    mkdirSync(join(root, name));
  vi.stubEnv('CODEX_HOME', join(root, 'provider'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'provider'));
  vi.stubEnv('CODEX_PLUGINS_CACHE', join(root, 'plugins'));
  vi.stubEnv('CODEX_SKILLS_CACHE', join(root, 'skills'));
  vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
  vi.stubEnv('FC_BUDGET_CALLS', join(root, 'calls.jsonl'));
  vi.stubEnv('FC_BUDGET_MODE', mode);
  vi.stubEnv('FC_BUDGET_SESSION', String(session));
  writeFileSync(join(bin, provider), `#!${process.execPath}\n` + String.raw `
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('fixture 1.0'); process.exit(0); }
let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk=>input+=chunk);
process.stdin.on('end',()=>{
  const calls=process.env.FC_BUDGET_CALLS;
  const count=fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').length:0;
  fs.appendFileSync(calls,JSON.stringify({argv:process.argv.slice(2),input})+'\n');
  const claude=require('node:path').basename(process.argv[1])==='claude';
  const emit=event=>console.log(JSON.stringify(event));
  const id='11111111-1111-4111-8111-111111111111';
  if(process.env.FC_BUDGET_SESSION==='true') emit(claude?{type:'system',subtype:'init',session_id:id}:{type:'thread.started',thread_id:id});
  if(count===0) fs.writeFileSync('work.txt','unit 1\n');
  if(count>0 && input.includes('# Stage budget wrap-up') && process.env.FC_BUDGET_MODE==='cooperate') {
  fs.writeFileSync('handoff.txt','Done: unit 1. Remaining: unit 2.');
  const text=JSON.stringify({status:'delivered',summary:'Done: unit 1. Remaining: unit 2.',checks:[],caveats:[]});
  if(claude) emit({type:'result',subtype:'success',is_error:false,result:text});
  else {emit({type:'item.completed',item:{type:'agent_message',text}});emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});}
  return;
  }
  if(claude) emit({type:'assistant',message:{content:[{type:'tool_use',id:'unit',name:'Bash',input:{command:'bounded-unit'}}]}});
  else emit({type:'item.started',item:{type:'command_execution',id:'unit',command:'bounded-unit'}});
  setInterval(()=>{},1000);
});
`, { mode: 0o700 });
  const native = provider === 'codex' ? new CodexAdapter() : new ClaudeAdapter();
  let invocations = 0;
  const deliveredRemaining: number[] = [];
  const adapter: Adapter = { sessionKind: native.sessionKind, capturesInvocationInput: true,
    run(prompt, agent, opts) {
      invocations++;
      if (invocations === 2)
        deliveredRemaining.push(opts.timeout_ms);
      return native.run(prompt, agent, { ...opts, onCommandLifecycle(event) {
          opts.onCommandLifecycle?.(event);
          if (event.phase === 'started')
            time.advanceTo(invocations === 1
              ? stageWrapUpTiming(budget).warningAfterMs : stageWrapUpTiming(budget).hardLimitMs);
        } });
    } };
  return { adapter, deliveredRemaining, calls: () => readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
      argv: string[];
      input: string;
    }) };
}
describe('stage budget delivery through the shared guidance boundary', () => {
  it.each(['codex', 'claude'] as const)('B01 %s delivers a finishing turn before budget expiry with a retained handoff, without cross-stage session reuse', async (provider) => {
    const time = manualClock();
    const fixture = nativeFixture(provider, time, 'cooperate', false);
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const result = await runStage(fixture.adapter, options(created, time));
    const status = readStageStatus(project, created.runId, 'work');
    expect(result, result.output).toMatchObject({ exitCode: 0, timedOut: false, continuation: { reason: 'stage_budget', forced: false } });
    expect(status.status).toBe('complete');
    expect(status.attempts).toHaveLength(1);
    expect(status.attempts?.at(-1)?.terminationCause).toBe('exit');
    expect(status.timeout).toMatchObject({ finishingMs: 2000 });
    expect(Date.parse(status.timeout!.wrapUpDeliveredAt!)).toBeLessThan(Date.parse(status.timeout!.budgetDeadlineAt!));
    expect(fixture.deliveredRemaining[0]).toBeGreaterThanOrEqual(stageWrapUpTiming(budget).finishingMs);
    const calls = fixture.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1].input).toContain('# Stage budget wrap-up');
    expect(calls[1].input).toContain('done/remaining');
    expect(calls[1].input).toContain('Complete two units');
    expect(calls[1].argv).not.toContain('--resume');
    expect(calls[1].argv).not.toContain('resume');
    expect(readFileSync(join(project, 'work.txt'), 'utf8')).toBe('unit 1\n');
    expect(readFileSync(join(project, 'handoff.txt'), 'utf8')).toContain('Remaining: unit 2');
    expect(parseStageRecord(result.output, RECORDED_HANDOFF_SCHEMA).summary).toContain('Done: unit 1');
    expect(readFileSync(join(created.runDirPath, result.continuation!.handoff), 'utf8')).toBe(result.output);
    expect(result.continuation?.summary).toContain('Remaining:');
    expect(readRunEvents(project, created.runId).map(event => event.type)).toEqual(expect.arrayContaining(['stage_wrap_up_requested', 'stage_wrap_up_delivered', 'stage_wrap_up_completed']));
    expect(time.timers.size).toBe(0);
  });
  it('B37 records no wrap-up delivery when a native adapter fails before reporting submitted input', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    let calls = 0;
    const adapter: Adapter = { capturesInvocationInput: true, async run() {
      if (++calls === 1) {
        time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
        return { exitCode: 137, duration_ms: 1, output: 'Retired first child.' };
      }
      return { exitCode: 1, duration_ms: 1, output: 'Native input unavailable.', friendlyError: 'Native input unavailable.' };
    } };
    const result = await runStage(adapter, options(created, time));
    expect(calls).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(readStageStatus(project, created.runId, 'work').timeout?.wrapUpDeliveredAt).toBeUndefined();
    expect(readRunEvents(project, created.runId).some(event => event.type === 'stage_wrap_up_delivered')).toBe(false);
  });
  it.each(['codex', 'claude'] as const)('B02 %s starts a cold wrap-up even when the preceding child attested a UUID', async (provider) => {
    const time = manualClock();
    const fixture = nativeFixture(provider, time, 'cooperate', true);
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const retainedHome = join(created.runDirPath, 'stages', 'work', `${provider}_home`);
    mkdirSync(retainedHome, { recursive: true });
    writeFileSync(join(retainedHome, 'retained-session.txt'), 'unfinished session evidence');
    expect((await runStage(fixture.adapter, options(created, time))).exitCode).toBe(0);
    const calls = fixture.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1].argv).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(calls[1].argv).not.toContain('resume');
    expect(calls[1].argv).not.toContain('--resume');
    expect(calls[1].input).toContain('Complete two units and retain unit 1 for continuation.');
    expect(calls[1].input).toContain('# Previous invocation record');
    expect(calls[1].input).toContain('# Stage budget wrap-up');
    expect(readFileSync(join(retainedHome, 'retained-session.txt'), 'utf8')).toBe('unfinished session evidence');
  });
  it.each(['codex', 'claude'] as const)('B03 %s bounds a stage that ignores the delivered warning and retains forced work', async (provider) => {
    const time = manualClock();
    const fixture = nativeFixture(provider, time, 'ignore', true);
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const result = await runStage(fixture.adapter, options(created, time));
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, continuation: { forced: true } });
    const status = readStageStatus(project, created.runId, 'work');
    expect(status.attempts?.at(-1)?.terminationCause).toBe('exit');
    expect(status.timeout?.childClosedAt).toBeTruthy();
    expect(status.attempts).toHaveLength(1);
    expect(fixture.calls()).toHaveLength(2);
    expect(readFileSync(join(project, 'work.txt'), 'utf8')).toBe('unit 1\n');
    expect(parseStageRecord(result.output, RECORDED_HANDOFF_SCHEMA).summary).toContain('Remaining:');
    expect(readFileSync(join(created.runDirPath, result.continuation!.handoff), 'utf8')).toBe(result.output);
    expect(result.continuation?.summary).toContain('work.txt');
    expect(readRunEvents(project, created.runId).some(event => event.type === 'stage_wrap_up_forced')).toBe(true);
    expect(time.timers.size).toBe(0);
  });
  it('B04 preserves a genuine gate rejection returned at the warning boundary without another invocation', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    let calls = 0;
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (++calls > 1) return completed(opts, 'Replacement answer must not erase a genuine rejection.');
      time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
      return { exitCode: 0, duration_ms: 1, output: JSON.stringify({ pass: false, reason: 'Actual defect', criteria: {}, audit_findings: { version: 1, findings: [] }, repairability: { version: 1, disposition: 'repairable', evidence: 'fixture' } }) };
    } };
    const result = await runStage(adapter, { ...options(created, time), isGate: true, outputSchema: stageRecordSchema({ isGate: true }), artifactContract: fixtureArtifactContract('work', true) });
    expect(result.exitCode).toBe(0);
    expect(result.continuation).toBeUndefined();
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(join(created.runDirPath, 'verdict_work.json'), 'utf8'))).toMatchObject({ pass: false, reason: 'Actual defect' });
  });
  it.each(['watchdog', 'parent'] as const)('B05 keeps %s cancellation authoritative over a budget boundary', async (source) => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const parent = new AbortController();
    const adapter: Adapter = { async run(_prompt, _role, opts) {
        time.advanceTo(stageWrapUpTiming(budget).hardLimitMs + 1);
        if (source === 'parent')
          parent.abort('cancelled');
        else {
          mkdirSync(join(opts.runDir, 'signals'), { recursive: true });
          atomicWrite(join(opts.runDir, 'signals', 'abort_work.json'), JSON.stringify({ version: 1, stageId: 'work', attemptIndex: 1, reason: 'Actual abort', timestamp: new Date().toISOString(), source: 'watchdog' }));
        }
        return { exitCode: 0, duration_ms: budget + 1, output: 'cancelled' };
      } };
    const result = await withRunProcessOwnership(project, created.runId, () => runStage(adapter, options(created, time)), parent.signal);
    expect(result.exitCode).toBe(137);
    expect(result.continuation).toBeUndefined();
    expect(readStageStatus(project, created.runId, 'work').status).toBe('failed');
  });
  it('B06 never promotes a guard refusal into retained success at the hard stop', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { async run() { time.advanceTo(stageWrapUpTiming(budget).hardLimitMs); return { engineVoid: true, terminationCause: 'engine_void', exitCode: 125, duration_ms: budget, output: 'ENGINE_STATE_REFUSED: fixture', friendlyError: 'ENGINE_STATE_REFUSED: fixture' }; } };
    const result = await runStage(adapter, options(created, time));
    expect(result.exitCode).not.toBe(0);
    expect(result.continuation).toBeUndefined();
  });
  it('B07 retains technical backoff under the same hard stop and disposes every timer', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    let calls = 0;
    const adapter: Adapter = { async run(_prompt, _role, opts) { calls++; if (calls === 1) {
        time.advanceTo(stageWrapUpTiming(budget).hardLimitMs);
        return { exitCode: 1, duration_ms: budget, output: 'capacity', providerFailure: providerFailureFromDiagnostic({ provider: 'codex', eventType: 'error', code: 429, message: 'capacity' }) };
      } return completed(opts); } };
    const result = await runStage(adapter, { ...options(created, time), technicalRetry: { delaysMs: [1, 1] } });
    expect(calls).toBe(1);
    expect(result.continuation?.forced).toBe(true);
    expect(time.timers.size).toBe(0);
  });
  it('B39 warning interrupts provider backoff and keeps subsequent finishing retries finite', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const calls: Array<{ prompt: string; remainingMs: number }> = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push({ prompt, remainingMs: opts.timeout_ms });
      if (calls.length < 3) return { exitCode: 1, duration_ms: 1, output: 'capacity', providerFailure: providerFailureFromDiagnostic({ provider: 'codex', eventType: 'error', code: 429, message: 'capacity' }) };
      return completed(opts);
    } };
    const execution = runStage(adapter, { ...options(created, time), technicalRetry: { delaysMs: [30000, 30000] } });
    let result: RunResult | undefined;
    try {
      await vi.waitFor(() => expect(time.timers.size).toBe(2));
      time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
      await vi.waitFor(() => expect(calls).toHaveLength(3));
      result = await execution;
    } finally {
      time.advanceTo(stageWrapUpTiming(budget).hardLimitMs);
      await execution;
    }
    expect(result?.continuation).toMatchObject({ forced: false });
    for (const call of calls.slice(1)) {
      expect(call.prompt).toContain('# Stage budget wrap-up');
      expect(call.remainingMs).toBeGreaterThanOrEqual(stageWrapUpTiming(budget).finishingMs);
    }
    expect(time.timers.size).toBe(0);
  });
  it('B08 keeps timer-starved expiry bounded while preserving work and recording missing delivery honestly', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { async run() { writeFileSync(join(project, 'work.txt'), 'unit 1\n'); time.advanceTo(stageWrapUpTiming(budget).hardLimitMs + 1); return { exitCode: 0, duration_ms: budget, output: 'late' }; } };
    const result = await runStage(adapter, options(created, time));
    expect(result.continuation?.forced).toBe(true);
    expect(existsSync(join(project, 'work.txt'))).toBe(true);
    expect(readStageStatus(project, created.runId, 'work').timeout?.wrapUpDeliveredAt).toBeUndefined();
  });
  it('B14 refuses continuation when an adapter never acknowledges owned-child closure', { timeout: 15000 }, async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    let calls = 0;
    const adapter: Adapter = { run() { calls++; writeFileSync(join(project, 'work.txt'), 'retained'); time.advanceTo(stageWrapUpTiming(budget).hardLimitMs); return new Promise(() => { }); } };
    const result = await runStage(adapter, options(created, time));
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(125);
    expect(result.friendlyError).toContain('child closure is unverified');
    expect(result.continuation).toBeUndefined();
    expect(readStageStatus(project, created.runId, 'work').timeout?.childClosedAt).toBeUndefined();
    expect(readFileSync(join(project, 'work.txt'), 'utf8')).toBe('retained');
  });
  it('B15 still stops actual lack of progress through the idle watchdog before budget wrap-up', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { async run(_prompt, _role, opts) {
        const stopped = new Promise<RunResult>(resolve => opts.abortSignal!.addEventListener('abort', () => resolve({ exitCode: 137, output: 'idle', duration_ms: 1 }), { once: true }));
        const watchdog = new StageWatchdog(project, created.runId, { idleThresholdMs: 1000 });
        await watchdog.tick();
        const initial = JSON.parse(readFileSync(join(created.runDirPath, 'stage_watchdog.json'), 'utf8')).stageProgress.work.lastProgressAt;
        const now = vi.spyOn(Date, 'now').mockReturnValue(initial + 1000);
        try {
          await watchdog.tick();
        }
        finally {
          now.mockRestore();
        }
        return stopped;
      } };
    const result = await runStage(adapter, options(created, time));
    expect(result.exitCode).toBe(137);
    expect(result.continuation).toBeUndefined();
    expect(readStageStatus(project, created.runId, 'work').attempts?.at(-1)?.terminationCause).toBe('stage_abort');
    expect(readRunEvents(project, created.runId).some(event => event.type === 'stage_wrap_up_delivered')).toBe(false);
  });
  it('B18 reserves the whole finishing interval after worst-case bounded child retirement', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    let calls = 0;
    let finishingBudget = 0;
    const timing = stageWrapUpTiming(budget);
    const adapter: Adapter = { async run(_prompt, _role, opts) {
        if (calls++) {
          finishingBudget = opts.timeout_ms;
          return completed(opts);
        }
        return new Promise(resolve => {
          opts.abortSignal!.addEventListener('abort', () => { time.advanceTo(timing.warningAfterMs + ATTEMPT_CLOSE_OBSERVATION_TOLERANCE_MS); resolve({ exitCode: 137, output: 'retained', duration_ms: 1 }); }, { once: true });
          time.advanceTo(timing.warningAfterMs);
          expect(opts.abortSignal!.aborted).toBe(true);
        });
      } };
    const result = await runStage(adapter, options(created, time));
    expect(result.continuation).toMatchObject({ forced: false });
    expect(finishingBudget).toBeGreaterThanOrEqual(timing.finishingMs);
    expect(finishingBudget).toBeLessThanOrEqual(timing.hardLimitMs - timing.warningAfterMs - ATTEMPT_CLOSE_OBSERVATION_TOLERANCE_MS);
    expect(calls).toBe(2);
  });
  it('B35 forced finishing counts each invocation once while the attempt clock remains authoritative', async () => {
    const time = manualClock(); const created = createRun(project, 'fixture', 'name: fixture', ['work']); let calls = 0;
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (++calls === 1) return new Promise(resolve => {
        opts.abortSignal!.addEventListener('abort', () => resolve({ exitCode: 137, output: 'retained first unit', duration_ms: 7 }), { once: true });
        time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
      });
      time.advanceTo(stageWrapUpTiming(budget).hardLimitMs);
      return { ...withRemaining(completed(opts, 'Complete.'), []), exitCode: 124, timedOut: true, duration_ms: 11 };
    } };
    const result = await runStage(adapter, options(created, time));
    expect(result).toMatchObject({ exitCode: 0, duration_ms: 18, continuation: { forced: true } });
    const status = readStageStatus(project, created.runId, 'work');
    expect(status.duration_ms).toBe(18); expect(status.timeout?.elapsedMs).toBe(budget); expect(calls).toBe(2);
  });
  it.each([undefined, ['Finish the independent review.']])('B17 a wrapping gate cannot publish acceptance with unknown or remaining work (%j)', async remaining => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const carrier = join(created.runDirPath, 'verdict_work.json');
    const trusted = remaining ? '{"pass":false,"reason":"trusted previous verdict"}\n' : undefined;
    if (trusted) atomicWrite(carrier, trusted);
    let calls = 0;
    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (++calls > 1) {
        expect(prompt).toContain('# Stage budget wrap-up');
        expect(existsSync(carrier) ? readFileSync(carrier, 'utf8') : undefined).toBe(trusted);
      }
      writeFileSync(carrier, '{"pass":true,"reason":"counterfeit unfinished review"}');
      time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
      const partial = completed(opts, 'Review still needs another unit.');
      return remaining ? withRemaining(partial, remaining) : partial;
    } };
    const result = await runStage(adapter, { ...options(created, time), isGate: true, outputSchema: stageRecordSchema({ isGate: true }), artifactContract: fixtureArtifactContract('work', true) });
    expect(result).toMatchObject({ exitCode: 0, continuation: { reason: 'stage_budget', forced: false } });
    expect(result.engineVoid).not.toBe(true);
    expect(calls).toBe(2);
    expect(parseStageRecord(result.output, stageRecordSchema({ isGate: true })).pass).toBe(true);
    expect(result.continuation?.summary).toContain('unfinished duties are not certified complete');
    expect(existsSync(carrier) ? readFileSync(carrier, 'utf8') : undefined).toBe(trusted);
    expect(readRunEvents(project, created.runId)).toContainEqual(expect.objectContaining({
      type: 'execution_notice', level: 'warning', stageId: 'work', files: [carrier],
      detail: expect.stringContaining('engine-published carrier'),
    }));
    expect(readRunEvents(project, created.runId).some(event => event.detail?.includes('ENGINE_STATE_TAMPERED'))).toBe(false);
  });
});
function workflowFixture(maxIterations = 2) {
  const roles = join(root, 'roles');
  mkdirSync(roles);
  for (const name of ['coder', 'qa'])
    writeFileSync(join(roles, `${name}.yaml`), `name: ${name}\nprompt: Fixture.\ntools: []\n`);
  const workflow = WorkflowConfigSchema.parse({ name: 'budget-workflow', defaults: { max_iterations: maxIterations, max_retries: 0 }, stages: [
      { id: 'done', role: 'coder', scope: [] },
      { id: 'work', role: 'coder', depends_on: ['done'], scope: ['work.txt'] },
      { id: 'review', role: 'qa', is_gate: true, depends_on: ['work'], scope: [] },
      { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['work.txt'] },
    ] });
  normalizeStageContracts(workflow.stages);
  return { roles, workflow };
}
/** Explicit authored completion; prose alone cannot settle a warned stage. */
function withRemaining(result: RunResult, remaining_work: string[]): RunResult {
  return { ...result, output: JSON.stringify({ ...JSON.parse(result.output), remaining_work }) };
}
async function finishWorkflowAtWrap(stageId: 'work' | 'review', duringWrap: boolean, maxIterations = 2) {
  const { roles, workflow } = workflowFixture(maxIterations);
  workflow.stages.find(stage => stage.id === 'work')!.artifact_contract = {
    ...fixtureArtifactContract('work'), produces: [{ id: 'units', root: 'project', path: 'work.txt' }],
  };
  let time = manualClock();
  const calls: string[] = [];
  const adapter: Adapter = { async run(prompt, _role, opts) {
    calls.push(`${opts.stageId}:${opts.attemptIndex}`);
    if (opts.stageId === stageId && !prompt.includes('# Stage budget wrap-up')) {
      time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
      if (duringWrap) return { exitCode: 137, duration_ms: 1, output: 'Closed at warning.' };
    }
    if (opts.stageId === 'work') writeFileSync(join(project, 'work.txt'), 'unit 1\nunit 2\n');
    if (opts.stageId === 'review') {
      expect(prompt).toContain('evidence-ledger.jsonl');
      expect(prompt).not.toContain('Both units and all assigned checks are complete.');
      expect(readFileSync(join(project, 'work.txt'), 'utf8')).toContain('unit 2');
    }
    return withRemaining(completed(opts, 'Both units and all assigned checks are complete.'), []);
  } };
  const result = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter), new Map(), undefined, roles,
    undefined, undefined, false, undefined, false, undefined, () => { time = manualClock(); return time.clock; });
  return { result, calls };
}
describe('authored completion at the budget boundary', () => {
  it.each([false, true])('B40 an author finishing at wrap-up reaches its gate in the same iteration (finishing turn: %s)', async duringWrap => {
    const { result, calls } = await finishWorkflowAtWrap('work', duringWrap);
    expect(result.status, result.failureReason).toBe('complete');
    expect(result.currentIteration).toBe(1);
   expect(calls).toEqual(['done:1', 'work:1', ...(duringWrap ? ['work:1'] : []), 'review:1']);
    expect(result.stages.work.attempts).toHaveLength(1);
    expect(result.stages.work.attempts?.[0].continuation).toBeUndefined();
    expect(result.stages.work.continuation).toBeUndefined();
    expect(result.stages.work.attempts?.at(-1)?.terminationCause).toBe('exit');
    expect(result.stages.work.timeout).toMatchObject({ wrapUpRequestedAt: expect.any(String) });
  });
  it.each([false, true])('B41 a gate passing at wrap-up publishes its verdict in the same iteration (finishing turn: %s)', async duringWrap => {
    const { result, calls } = await finishWorkflowAtWrap('review', duringWrap);
    expect(result.status, result.failureReason).toBe('complete');
    expect(result.currentIteration).toBe(1);
   expect(calls).toEqual(['done:1', 'work:1', 'review:1', ...(duringWrap ? ['review:1'] : [])]);
    expect(result.stages.review.attempts).toHaveLength(1);
    expect(result.stages.review.attempts?.[0].continuation).toBeUndefined();
    expect(readGateEvaluation(project, 'review', result.runId)).toMatchObject({ pass: true });
    expect(result.stages.review.attempts?.at(-1)?.terminationCause).toBe('exit');
    expect(result.stages.review.timeout).toMatchObject({ wrapUpRequestedAt: expect.any(String) });
  });
  it('B42 an author reporting remaining work retains its authored handoff and spends the next iteration', async () => {
    const { roles, workflow } = workflowFixture();
    let time = manualClock();
    const calls: string[] = [];
    let handoff = '';
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push(`${opts.stageId}:${opts.attemptIndex}`);
      if (opts.stageId === 'work') {
        if (opts.attemptIndex === 1) {
          if (!prompt.includes('# Stage budget wrap-up')) {
            writeFileSync(join(project, 'work.txt'), 'unit 1\n');
            time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
            return { exitCode: 137, duration_ms: 1, output: 'Closed at warning.' };
          }
          const partial = withRemaining(completed(opts), ['Complete unit 2 and its checks.']);
          handoff = partial.output;
          return partial;
        }
        expect(prompt).toContain('Own-stage continuation evidence');
        expect(readFileSync(join(opts.runDir, 'stages/work/output_attempt_1.md'), 'utf8')).toBe(handoff);
        expect(readFileSync(join(project, 'work.txt'), 'utf8')).toBe('unit 1\n');
        writeFileSync(join(project, 'work.txt'), 'unit 1\nunit 2\n');
      }
      return withRemaining(completed(opts, 'Complete.'), []);
    } };
    const result = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter), new Map(), undefined, roles,
      undefined, undefined, false, undefined, false, undefined, () => { time = manualClock(); return time.clock; });
    expect(result.status, result.failureReason).toBe('complete');
    expect(result.currentIteration).toBe(2);
   expect(calls).toEqual(['done:1', 'work:1', 'work:1', 'work:2', 'review:1']);
    expect(result.stages.work.attempts?.[0].continuation).toMatchObject({ reason: 'stage_budget', forced: false });
    expect(result.stages.work.continuation).toBeUndefined();
  });
  it('B44 explicit completion at wrap-up still enforces the author artifact contract', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    let calls = 0;
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      calls++;
      time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
      return withRemaining(completed(opts, 'All work complete.'), []);
    } };
    const result = await runStage(adapter, { ...options(created, time), artifactContract: {
      ...fixtureArtifactContract('work'), produces: [{ id: 'units', root: 'project', path: 'work.txt' }],
    } });
    expect(result.exitCode).toBe(1);
    expect(result.friendlyError).toContain('Stage settlement refused:');
    expect(result.continuation).toBeUndefined();
    expect(calls).toBe(1);
  });
  it('B45 completion lists are optional for compatibility but malformed lists cannot certify completion', () => {
    for (const schema of [RECORDED_HANDOFF_SCHEMA, stageRecordSchema({ isGate: true })]) {
      const base = schema === RECORDED_HANDOFF_SCHEMA
        ? { status: 'delivered', summary: 'Complete.', checks: [], caveats: [] }
        : { pass: true, reason: 'Complete.', criteria: {}, audit_findings: { version: 1, findings: [] } };
      expect(() => parseStageRecord(JSON.stringify(base), schema)).not.toThrow();
      expect(() => parseStageRecord(JSON.stringify({ ...base, remaining_work: [] }), schema)).not.toThrow();
      for (const remaining_work of [null, false, 'none', [''], ['   '], [1]]) {
        expect(() => parseStageRecord(JSON.stringify({ ...base, remaining_work }), schema)).toThrow('remaining_work');
      }
    }
  });
  it('B46 a blocked author with an empty completion list still retains its handoff', async () => {
    const time = manualClock();
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { async run() {
      time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
      return { exitCode: 0, duration_ms: 1, output: JSON.stringify({ status: 'blocked', summary: 'Blocked on a declared duty.',
        checks: [], caveats: [], remaining_work: [] }) };
    } };
    const result = await runStage(adapter, { ...options(created, time), gateReviewed: true });
    expect(result.exitCode, result.friendlyError).toBe(0);
    expect(result.continuation).toMatchObject({ reason: 'stage_budget', forced: false });
  });
  it.each([
    ['work', false], ['work', true], ['review', false], ['review', true],
  ] as const)('B43 max_iterations 1 completes when %s finishes at wrap-up (finishing turn: %s)', async (stageId, duringWrap) => {
    const { result, calls } = await finishWorkflowAtWrap(stageId, duringWrap, 1);
    expect(result.status, result.failureReason).toBe('complete');
    expect(result.currentIteration).toBe(1);
    expect(calls.filter(call => call.startsWith(`${stageId}:`))).toHaveLength(duringWrap ? 2 : 1);
    expect(result.stages[stageId].attempts).toHaveLength(1);
    expect(result.stages[stageId].continuation).toBeUndefined();
  });
});
describe('durable bounded continuation', () => {
  it('B36 child closure persists the budget handoff in both history and projection before final settlement', () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']); beginStageAttempt(project, created.runId, 'work', 0);
    const continuation = { reason: 'stage_budget' as const, forced: false, handoff: 'stages/work/output_attempt_1.md' };
    const closed = completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 0, duration_ms: 1, continuation });
    expect(closed.continuation).toEqual(continuation);
    expect(closed.attempts?.at(-1)?.continuation).toEqual(continuation);
    expect(readStageStatus(project, created.runId, 'work').continuation).toEqual(continuation);
    expect(readRunState(project, created.runId).stages.work.continuation).toEqual(continuation);
  });
  it('B09 continues the same admitted DAG and files in the next iteration; post-author review gets a full independent budget', async () => {
    const { roles, workflow } = workflowFixture();
    let time = manualClock();
    const calls: string[] = [];
    const prompts: string[] = [];
    const gateBudgets: number[] = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
        calls.push(`${opts.stageId}:${opts.attemptIndex}`);
        prompts.push(prompt);
        if (opts.stageId === 'work' && opts.attemptIndex === 1) {
          if (!prompt.includes('# Stage budget wrap-up')) {
            writeFileSync(join(project, 'work.txt'), 'unit 1\n');
            return new Promise(resolve => { opts.abortSignal!.addEventListener('abort', () => resolve({ exitCode: 137, output: 'unit 1', duration_ms: 1 }), { once: true }); time.advanceTo(stageWrapUpTiming(budget).warningAfterMs); });
          }
          return completed(opts);
        }
        if (opts.stageId === 'work') {
          expect(readFileSync(join(project, 'work.txt'), 'utf8')).toBe('unit 1\n');
          expect(prompt).toContain('Own-stage continuation evidence');
          expect(prompt).not.toContain('# Stage budget wrap-up');
          writeFileSync(join(project, 'work.txt'), 'unit 1\nunit 2\n');
        }
        if (opts.stageId === 'review') {
          gateBudgets.push(opts.timeout_ms);
          expect(readFileSync(join(project, 'work.txt'), 'utf8')).toContain('unit 2');
        }
        return completed(opts, 'Complete.');
      } };
    const result = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter), new Map(), undefined, roles, undefined, undefined, false, undefined, false, undefined, () => { time = manualClock(); return time.clock; });
    expect(result.status, result.failureReason).toBe('complete');
    expect(result.currentIteration).toBe(2);
   expect(calls).toEqual(['done:1', 'work:1', 'work:1', 'work:2', 'review:1']);
    expect(result.stages.work.attempts?.map(attempt => attempt.status)).toEqual(['complete', 'complete']);
    expect(result.stages.work.attempts?.[0].continuation).toMatchObject({ forced: false });
    expect(result.stages.work.continuation).toBeUndefined();
    expect(gateBudgets).toEqual([budget]);
    expect(prompts.at(-1)).toContain('Independent gates have their own stage budgets');
  });
  it('B10 repeated wrap-ups exhaust iterations without growing budgets or reporting a stage failure', async () => {
    const { roles, workflow } = workflowFixture(2);
    let time = manualClock();
    const budgets: number[] = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
        if (opts.stageId !== 'work')
          return completed(opts, 'Complete.');
        budgets.push(opts.timeout_ms);
        if (prompt.includes('# Stage budget wrap-up'))
          return completed(opts);
        return new Promise(resolve => { opts.abortSignal!.addEventListener('abort', () => resolve({ exitCode: 137, output: 'slice', duration_ms: 1 }), { once: true }); time.advanceTo(stageWrapUpTiming(budget).warningAfterMs); });
      } };
    const result = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter), new Map(), undefined, roles, undefined, undefined, false, undefined, false, undefined, () => { time = manualClock(); return time.clock; });
    expect(result.status).toBe('incomplete');
    expect(result.failureReason).toContain('iteration budget');
    expect(result.currentIteration).toBe(2);
    expect(result.stages.work.attempts).toHaveLength(2);
    expect(result.stages.work.attempts?.every(attempt => attempt.exitCode === 0)).toBe(true);
    expect(result.stages.review.attempts).toBeUndefined();
    expect(budgets).toEqual([budget, budget - stageWrapUpTiming(budget).warningAfterMs, budget, budget - stageWrapUpTiming(budget).warningAfterMs]);
    expect(() => workflowContinuation(result, project, result.runId, workflow)).toThrow('iteration budget exhausted');
  });
  it.each(['complete', 'pending'] as const)('B11 cancel/resume spends the next iteration for a settled budget handoff and refuses a reset beyond the ceiling (%s)', status => {
    const { workflow } = workflowFixture(2);
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    updateRunState(project, created.runId, state => { state.status = 'cancelled'; state.currentIteration = 1; state.maxIterations = 2; state.stages.work = { status, retries: 0, continuation: { reason: 'stage_budget', forced: false, handoff: 'stages/work/output_attempt_1.md' } }; });
    const state = readRunState(project, created.runId);
    expect(workflowContinuation(state, project, created.runId, workflow).iteration).toBe(2);
    state.currentIteration = 2;
    expect(() => workflowContinuation(state, project, created.runId, workflow)).toThrow('iteration budget exhausted');
  });
  it('B12 applies a research wall ceiling to repeated budget boundaries', async () => {
    const { roles, workflow } = workflowFixture(5);
    let time = manualClock();
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    updateRunState(project, created.runId, state => { state.currentIteration = 1; state.maxIterations = 5; state.research = { stop: { maxWallHours: 0 } } as typeof state.research; });
    const adapter: Adapter = { async run(prompt, _role, opts) { if (opts.stageId !== 'work' || prompt.includes('# Stage budget wrap-up'))
        return completed(opts); return new Promise(resolve => { opts.abortSignal!.addEventListener('abort', () => resolve({ exitCode: 137, output: 'slice', duration_ms: 1 }), { once: true }); time.advanceTo(stageWrapUpTiming(budget).warningAfterMs); }); } };
    const result = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter), new Map(), undefined, roles, created.runId, undefined, false, undefined, false, undefined, () => { time = manualClock(); return time.clock; });
    expect(result.status).toBe('incomplete');
    expect(result.failureReason).toContain('research wall budget');
    expect(result.currentIteration).toBe(1);
  });
  it('B13 rejects an infinite or nonpositive live iteration allowance', () => {
    for (const max_iterations of [Infinity, NaN, 0, -1, 1.5])
      expect(() => WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations }, stages: [{ id: 'work', role: 'coder' }] })).toThrow();
    expect(ATTEMPT_CLOSE_OBSERVATION_TOLERANCE_MS).toBe(5500);
  });
  it('B33 direct launch enforces the finite iteration bound before allocating a run', () => {
    const { workflow } = workflowFixture();
    for (const maxIterations of [Infinity, NaN, 0, -1, 1.5]) {
      workflow.defaults.max_iterations = maxIterations;
      expect(() => prepareWorkflowLaunch(workflow, stringify(workflow), project)).toThrow('max_iterations must be a finite positive integer');
    }
  });
  it('B16 a repair wrap-up retains the rejected gate and spends no technical retry or larger budget', async () => {
    const { roles, workflow } = workflowFixture(2);
    const time = manualClock();
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    const rejected = JSON.stringify({ pass: false, reason: 'Retained defect' });
    writeFileSync(join(created.runDirPath, 'verdict_review.json'), rejected);
    const stage = workflow.stages.find(stage => stage.id === 'repair')!;
    let calls = 0;
    const adapter: Adapter = { async run(prompt, _role, opts) {
        calls++;
        if (prompt.includes('# Stage budget wrap-up'))
          return completed(opts);
        writeFileSync(join(project, 'work.txt'), 'partial repair');
        return new Promise(resolve => { opts.abortSignal!.addEventListener('abort', () => resolve({ exitCode: 137, output: 'partial repair', duration_ms: 1 }), { once: true }); time.advanceTo(stageWrapUpTiming(budget).warningAfterMs); });
      } };
    const result = await executeSingleStage(stage, project, created.runId, created.runDirPath, workflow, adapter, new Map(), roles, readRunState(project, created.runId), workflow.stages, undefined, undefined, 0, undefined, undefined, undefined, () => time.clock);
    expect(result?.continuation, result?.friendlyError ?? result?.output).toMatchObject({ forced: false });
    expect(calls).toBe(2);
    const status = readStageStatus(project, created.runId, 'repair');
    expect(status.attempts).toHaveLength(1);
    expect(status.timeout?.budgetMs).toBe(budget);
    expect(readFileSync(join(project, 'work.txt'), 'utf8')).toBe('partial repair');
    expect(readFileSync(join(created.runDirPath, 'verdict_review.json'), 'utf8')).toBe(rejected);
  });
  it('B19 repair execution refuses unknown child closure before any retry can launch', { timeout: 15000 }, async () => {
    const { roles, workflow } = workflowFixture(2);
    const time = manualClock();
    const stage = workflow.stages.find(stage => stage.id === 'repair')!;
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    let calls = 0;
    const adapter: Adapter = { run() { calls++; time.advanceTo(stageWrapUpTiming(budget).hardLimitMs); return new Promise(() => { }); } };
    await expect(executeSingleStage(stage, project, created.runId, created.runDirPath, workflow, adapter, new Map(), roles, readRunState(project, created.runId), workflow.stages, undefined, undefined, 0, undefined, undefined, undefined, () => time.clock)).rejects.toThrow('child closure is unverified');
    expect(calls).toBe(1);
    expect(readStageStatus(project, created.runId, 'repair').exitCode).toBe(125);
  });
  it('B20 a planner wrap-up cannot resurrect a retired dynamic DAG from immutable history', async () => {
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 4 }, stages: [{ id: 'plan', role: 'planner', dynamic_dispatch: true }] });
    normalizeStageContracts(workflow.stages);
    const retired = WorkflowConfigSchema.parse({ name: 'old', stages: [{ id: 'retired_work', role: 'coder', scope: [] }] });
    normalizeStageContracts(retired.stages);
    const created = createRun(project, workflow.name, stringify(workflow), ['plan']);
    writeStageStatus(project, created.runId, 'plan', { status: 'complete', retries: 0, continuation: { reason: 'stage_budget', forced: false, handoff: 'stages/plan/output_attempt_1.md' } });
    updateRunState(project, created.runId, state => { recordAdmittedPlan(state, [...workflow.stages, ...retired.stages], created.runDirPath, 'Prior completed iteration'); state.currentIteration = 2; state.dispatchedStages = undefined; });
    const prepared = await prepareWorkflowIteration(3, 1, false, project, created.runId, created.runDirPath, { async run() { throw new Error('No execution expected'); } }, workflow.stages, stringify(workflow));
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready')
      return;
    expect(prepared.sorted.map(stage => stage.id)).toEqual(['plan']);
    expect(prepared.state.stages.retired_work).toBeUndefined();
    expect(prepared.state.stages.plan.status).toBe('pending');
    expect(prepared.state.planControl?.stages.map(stage => stage.id)).toEqual(['plan', 'retired_work']);
  });
  it('B21 a dynamic budget continuation retains its admitted dispatch without invoking the planner again', async () => {
    const roles = join(root, 'roles');
    mkdirSync(roles);
    for (const name of ['planner', 'coder', 'qa'])
      writeFileSync(join(roles, `${name}.yaml`), `name: ${name}\nprompt: Fixture.\ntools: []\n`);
    const workflow = WorkflowConfigSchema.parse({ name: 'direct', defaults: { max_iterations: 2, max_retries: 0 }, stages: [{ id: 'plan', role: 'planner', dynamic_dispatch: true }], dispatch: [
        { id: 'work', role: 'coder', scope: ['work.txt'] }, { id: 'review', role: 'qa', is_gate: true, scope: [], depends_on: ['work'] }, { id: 'repair', role: 'coder', scope: ['work.txt'], depends_on: ['review'], retry_to: ['review'] },
      ] });
    let time = manualClock();
    const calls: string[] = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
        calls.push(`${opts.stageId}:${opts.attemptIndex}`);
        if (opts.stageId === 'work' && opts.attemptIndex === 1 && !prompt.includes('# Stage budget wrap-up')) {
          writeFileSync(join(project, 'work.txt'), 'retained dynamic work');
          return new Promise(resolve => { opts.abortSignal!.addEventListener('abort', () => resolve({ exitCode: 137, output: 'slice', duration_ms: 1 }), { once: true }); time.advanceTo(stageWrapUpTiming(budget).warningAfterMs); });
        }
        if (opts.stageId === 'work' && opts.attemptIndex === 2)
          expect(readFileSync(join(project, 'work.txt'), 'utf8')).toBe('retained dynamic work');
        return completed(opts, 'Complete.');
      } };
    const result = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter), new Map(), undefined, roles, undefined, undefined, false, undefined, false, undefined, () => { time = manualClock(); return time.clock; });
    expect(result.status, result.failureReason).toBe('complete');
    expect(result.currentIteration).toBe(2);
   expect(calls).toEqual(['work:1', 'work:1', 'work:2', 'review:1']);
    expect(result.queryState?.planHistory).toHaveLength(1);
    expect(result.dispatchedStages?.map((stage: unknown) => (stage as {
      id: string;
    }).id)).toEqual(['work', 'review', 'repair']);
  });
  it('B22 a completed budget slice cannot satisfy dependencies or expose a stale accepted gate', () => {
    const { workflow } = workflowFixture(2);
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    const continuation = { reason: 'stage_budget' as const, forced: false, handoff: 'stages/work/output_attempt_1.md' };
    updateRunState(project, created.runId, state => { state.stages.done = { status: 'complete', retries: 0 }; state.stages.work = { status: 'complete', retries: 0, continuation }; });
    const state = readRunState(project, created.runId);
    expect(findAllReady(workflow.stages, state)).toEqual([]);
    writeStageStatus(project, created.runId, 'review', { status: 'complete', retries: 0, continuation, acceptedFrom: { runId: 'old-child', verdict: { pass: true, reason: 'Old acceptance' } } });
    expect(readGateEvaluation(project, 'review', created.runId)).toBeNull();
  });
  it('B23 a persisted budget boundary stops independent pending authors in the same iteration', async () => {
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'work', role: 'coder', scope: [] }, { id: 'other', role: 'coder', scope: [] }] });
    normalizeStageContracts(workflow.stages);
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    writeStageStatus(project, created.runId, 'work', { status: 'complete', retries: 0, continuation: { reason: 'stage_budget', forced: false, handoff: 'stages/work/output_attempt_1.md' } });
    updateRunState(project, created.runId, state => recordAdmittedPlan(state, workflow.stages, created.runDirPath, 'Admitted fixture'));
    const calls: string[] = [];
    const adapter: Adapter = { async run(_prompt, _role, opts) { calls.push(opts.stageId); return completed(opts); } };
    const result = await executeIteration(workflow.stages, project, created.runId, created.runDirPath, workflow, adapter, new Map([['coder', role]]), root, new Map([['coder', { name: 'coder', description: '' }]]), new Set(), new Map());
   expect(calls).toEqual([]);
    expect(result.stages.other.status).toBe('pending');
  });
  it('B24 terminal settlement defers retained budget work at every entrance, including the next iteration', async () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    writeFileSync(join(project, 'report.md'), 'Unfinished terminal document.');
    updateRunState(project, created.runId, state => { state.terminalStates = { complete: { paths: ['report.md'] } }; state.stages.work = { status: 'complete', retries: 0, continuation: { reason: 'stage_budget', forced: false, handoff: 'stages/work/output_attempt_1.md' } }; });
    const result = await tryTerminateOnTerminalState(readRunState(project, created.runId), { projectDir: project, runId: created.runId, runDirPath: created.runDirPath, iteration: 2, adapter: { async run() { throw new Error('No terminal execution is authorized yet'); } } });
    expect(result).toEqual({ decision: 'deferred', reasons: ['retained stage budget work must continue before terminal settlement'] });
    expect(readRunState(project, created.runId).status).toBe('running');
  });
  it('B25 repair wrap-up defers gate re-evaluation until its retained files are finished in the next iteration', async () => {
    const { roles, workflow } = workflowFixture(2);
    let time = manualClock();
    let reviews = 0;
    const adapter: Adapter = { async run(prompt, _role, opts) {
        if (opts.stageId === 'work')
          writeFileSync(join(project, 'work.txt'), 'original');
        if (opts.stageId === 'review') {
          if (++reviews === 1)
            return { exitCode: 0, duration_ms: 1, output: JSON.stringify({ pass: false, reason: 'Repair required', criteria: {}, audit_findings: { version: 1, findings: [] }, repairability: { version: 1, disposition: 'repairable', evidence: 'fixture defect' } }) };
          expect(readFileSync(join(project, 'work.txt'), 'utf8')).toBe('repair finished');
        }
        if (opts.stageId === 'repair') {
          if (opts.attemptIndex === 1 && !prompt.includes('# Stage budget wrap-up')) {
            writeFileSync(join(project, 'work.txt'), 'partial repair');
            return new Promise(resolve => { opts.abortSignal!.addEventListener('abort', () => resolve({ exitCode: 137, output: 'partial repair', duration_ms: 1 }), { once: true }); time.advanceTo(stageWrapUpTiming(budget).warningAfterMs); });
          }
          if (opts.attemptIndex === 2) {
            expect(readFileSync(join(project, 'work.txt'), 'utf8')).toBe('partial repair');
            writeFileSync(join(project, 'work.txt'), 'repair finished');
          }
        }
        return completed(opts, 'Complete.');
      } };
    const result = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter), new Map(), undefined, roles, undefined, undefined, false, undefined, false, undefined, () => { time = manualClock(); return time.clock; });
    expect(result.status, result.failureReason).toBe('complete');
    expect(result.currentIteration).toBe(2);
    expect(reviews).toBe(2);
    expect(result.stages.repair.attempts).toHaveLength(2);
    expect(result.stages.repair.attempts?.[0].continuation).toMatchObject({ forced: false });
    expect(result.stages.review.attempts?.map(attempt => attempt.timeout?.budgetMs)).toEqual([budget, budget]);
  });
  it('B26 publishes the documented default and very-short-budget finishing bounds', () => {
    expect(stageWrapUpTiming(10_800_000)).toEqual({ warningAfterMs: 10_494_500, finishingMs: 300_000, hardLimitMs: 10_800_000 });
    expect(stageWrapUpTiming(10_000)).toEqual({ warningAfterMs: 3_500, finishingMs: 1_000, hardLimitMs: 10_000 });
    expect(stageWrapUpTiming(400)).toEqual({ warningAfterMs: 0, finishingMs: 40, hardLimitMs: 5_540 });
    for (const value of [0, -1, 0.5, Infinity, NaN]) expect(() => stageWrapUpTiming(value)).toThrow();
  });

  it('B27 a wrapped gate cannot spend post-author validation time or bind its receipt as a completed review', async () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    beginStageAttempt(project, created.runId, 'work', 0);
    completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 0, duration_ms: 1,
      continuation: { reason: 'stage_budget', forced: false, handoff: 'stages/work/output_attempt_1.md' } });
    atomicWrite(join(created.runDirPath, RUN_VALIDATION_BASELINE_FILE), JSON.stringify({ version: 1,
      capturedAt: new Date().toISOString(), source: 'ship-setup-ready-record', baseline: { version: 1,
        projectDir: project, discovery: { state: 'not_configured', commands: [], missingRoles: ['build', 'test', 'lint'] }, results: [], gateCriteria: [] } }));
    expect(settledGateValidationExecution(project, created.runId, 'work')).toBeUndefined();
    expect(await recordGateValidationDelta(project, created.runId, 'work')).toBeUndefined();
    expect(existsSync(join(created.runDirPath, 'validation_delta_work.json'))).toBe(false);
  });

  it('B29 a final settlement refusal cannot leave a retained-success marker', async () => {
    const time = manualClock(); const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { async run(_prompt, _role, opts) { time.advanceTo(stageWrapUpTiming(budget).warningAfterMs); return completed(opts); } };
    await expect(runStage(adapter, { ...options(created, time), settlementBoundary: async phase => { if (phase === 'attempt_closed') throw new Error('Actual settlement refusal'); return false; } })).rejects.toThrow('Actual settlement refusal');
    const status = readStageStatus(project, created.runId, 'work'); expect(status.status).toBe('failed'); expect(status.continuation).toBeUndefined(); expect(status.attempts?.at(-1)?.continuation).toBeUndefined();
    expect(readEvidence(created.runDirPath)).toContainEqual(expect.objectContaining({ kind: 'attempt', exitCode: 1, endingCause: 'work_failed', continuation: false }));
  });

  it('B30 a scope audit refusal removes the budget marker from both history and projection', () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']); beginStageAttempt(project, created.runId, 'work', 0);
    completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 0, duration_ms: 1, continuation: { reason: 'stage_budget', forced: false, handoff: 'stages/work/output_attempt_1.md' } });
    const status = attachStageConstraintAudit(project, created.runId, 'work', 1, { path: 'stages/work/audit.json', declaredScope: [], effectiveScope: [], violationCount: 1, unverifiedCount: 0 }, 'Actual scope refusal');
    expect(status.status).toBe('failed'); expect(status.continuation).toBeUndefined(); expect(status.attempts?.at(-1)?.continuation).toBeUndefined();
    expect(status.attempts?.at(-1)?.endingCause).toBe('work_failed');
  });

  it('B32 returns a durable final refusal without a success continuation', async () => {
    const time = manualClock(); const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { async run(_prompt, _role, opts) { time.advanceTo(stageWrapUpTiming(budget).warningAfterMs); return completed(opts); } };
    const result = await runStage(adapter, { ...options(created, time), settlementBoundary: async phase => {
      if (phase === 'attempt_closed') attachStageConstraintAudit(project, created.runId, 'work', 1,
        { path: 'stages/work/audit.json', declaredScope: [], effectiveScope: [], violationCount: 1, unverifiedCount: 0 }, 'Actual settlement refusal');
      return false;
    } });
    expect(result.exitCode).toBe(1); expect(result.continuation).toBeUndefined();
    expect(result.endingCause).toBe('work_failed');
    expect(readEvidence(created.runDirPath)).toContainEqual(expect.objectContaining({ kind: 'attempt', exitCode: 1, endingCause: 'work_failed', continuation: false }));
    expect(readStageStatus(project, created.runId, 'work').status).toBe('failed');
  });

});


describe('cause-owned budget handoff', () => {
  it('SI an unreviewed environment gap remains negative without spending another attempt', async () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const adapter: Adapter = { run: vi.fn(async () => ({ exitCode: 0, duration_ms: 1, output: JSON.stringify({
      status: 'environment_gap', summary: 'Required renderer is unavailable.', caveats: [], remaining_work: ['Obtain rendering evidence.'] }) })) };
    const result = await runStage(adapter, options(created));
    expect(result.exitCode).toBe(1);
    expect(result.endingCause).toBe('environment_gap');
    expect(decideStageRetry(result, 0, 5, 5)).toBe('stop');
    expect(adapter.run).toHaveBeenCalledTimes(1);
    expect(readEvidence(created.runDirPath)).toContainEqual(expect.objectContaining({ kind: 'attempt', exitCode: 1,
      endingCause: 'environment_gap', environmentGap: { reason: 'Required renderer is unavailable.' } }));
  });

  it.each([true, false])('SI environment gap reaches an independent gate once (accept=%s)', async accept => {
    const { roles, workflow } = workflowFixture(5);
    workflow.defaults.max_retries = 3;
    let time = manualClock();
    const calls: string[] = [];
    const gap = { reason: 'The fixture has no renderer; rendering evidence remains unmeasured.' };
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'work') {
        time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
        return { exitCode: 0, duration_ms: 1, output: JSON.stringify({ status: 'environment_gap', summary: gap.reason,
          caveats: [], remaining_work: ['Obtain rendering evidence in a capable environment.'] }) };
      }
      if (opts.stageId === 'review') {
        expect(prompt).toContain(gap.reason);
        expect(prompt).toContain('environment_gap');
        expect(workflow.stages.find(stage => stage.id === 'review')!.scope).toEqual([]);
        if (!accept) return { exitCode: 0, duration_ms: 1, output: JSON.stringify({ pass: false, reason: 'The required evidence is absent.', criteria: {},
          audit_findings: { version: 1, findings: [] }, repairability: { version: 1, disposition: 'irreparable', evidence: gap.reason } }) };
      }
      return withRemaining(completed(opts, 'Complete.'), []);
    } };
    const result = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, roles,
      undefined, undefined, false, undefined, false, undefined, () => { time = manualClock(); return time.clock; });
   expect(calls).toEqual(['done', 'work', 'review']);
    expect(result.status, result.failureReason).toBe(accept ? 'complete' : 'escalated');
    expect(result.stages.work.attempts).toHaveLength(1);
    expect(result.stages.work.attempts![0].endingCause).toBe('environment_gap');
    expect(result.stages.work.continuation).toBeUndefined();
    expect(readEvidence(runDir(project, result.runId))).toContainEqual(expect.objectContaining({ kind: 'attempt', stageId: 'work', endingCause: 'environment_gap', environmentGap: gap }));
  });

  it.each([0, 1, 4, undefined])('SI unfinished work obeys the declaration or default ceiling (%s)', async declared => {
    const { roles, workflow } = workflowFixture(3);
    let time = manualClock();
    const calls: string[] = [];
    const brief = declared === undefined ? '# Finish the research.' : `---\nmax_continuations: ${declared}\n---\n# Finish the research.`;
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'work') {
        time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
        return withRemaining(completed(opts), ['Research the remaining cases, even with no product diff.']);
      }
      return withRemaining(completed(opts, 'Complete.'), []);
    } };
    const result = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, roles,
      undefined, brief, false, undefined, false, undefined, () => { time = manualClock(); return time.clock; });
    const attempts = declared === undefined ? 3 : declared + 1;
    expect(result.status).toBe('incomplete');
    expect(result.currentIteration).toBe(declared === undefined ? attempts : 1);
    expect(result.stages.work.attempts).toHaveLength(attempts);
    expect(result.stages.done.attempts).toHaveLength(1);
    expect(result.stages.work.attempts!.every(attempt => attempt.endingCause === 'work_unfinished')).toBe(true);
    expect(calls.filter(id => id === 'review')).toHaveLength(0);
    expect(result.stages.work.continuation?.summary).toContain('Research the remaining cases');
    expect(result.failureReason).toContain(declared === undefined ? 'iteration budget' : 'declared continuation budget');
    expect(() => workflowContinuation(result, project, result.runId, workflow)).toThrow('budget exhausted');
  });

  it('SI rejects malformed continuation declarations instead of silently using a different allowance', async () => {
    for (const value of [-1, 1.5, 'one', null, '.inf'])
      expect(parseBriefFrontmatter(`---\nmax_continuations: ${value}\n---\n# Task`).workflowError).toContain('max_continuations');
    const { roles, workflow } = workflowFixture(3);
    const run = vi.fn();
    const result = await runWorkflow(workflow, stringify(workflow), project, { run }, new Map(), undefined, roles,
      undefined, '---\nmax_continuations: -1\n---\n# Task', false, undefined, false);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('max_continuations');
    expect(readRunState(project, result.runId).status).toBe('failed');
    expect(run).not.toHaveBeenCalled();
  });

  it('SI declared continuations retain the work failure ceiling for their iteration', async () => {
    const { roles, workflow } = workflowFixture(3);
    workflow.defaults.max_retries = 1;
    let time = manualClock();
    const workAttempts = new Set<number>();
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId !== 'work') return withRemaining(completed(opts, 'Complete.'), []);
      workAttempts.add(opts.attemptIndex ?? 0);
      if (opts.attemptIndex === 2) {
        time.advanceTo(stageWrapUpTiming(budget).warningAfterMs);
        return withRemaining(completed(opts), ['Finish the retained work.']);
      }
      return { exitCode: 1, duration_ms: 1, output: 'Controlled work failure.' };
    } };
    const result = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, roles,
      undefined, '---\nmax_continuations: 1\n---\n# Finish retained work.', false, undefined, false, undefined,
      () => { time = manualClock(); return time.clock; });
    expect([...workAttempts]).toEqual([1, 2, 3]);
    expect(result.stages.work.retries).toBe(1);
    expect(result.stages.work.attempts?.map(attempt => attempt.endingCause)).toEqual(['work_failed', 'work_unfinished', 'work_failed']);
    expect(result.currentIteration).toBe(1);
    expect(result.stages.done.attempts).toHaveLength(1);
    expect(result.status).toBe('incomplete');
  });
});


it('SI typed provider quota parks without retries and resumes the same stage after its reset', async () => {
  const { roles, workflow } = workflowFixture(3);
  const reset = Date.now() + 60_000;
  const quota = providerFailureFromEvent('codex', { type: 'turn.failed', error: {
    code: 'usage_limit_reached', reset_at: new Date(reset).toISOString(), message: 'Opaque provider diagnostic.' } })!;
  const calls: string[] = [];
  let stopped = false;
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'work' && !stopped) {
      stopped = true;
      return { exitCode: 1, duration_ms: 1, output: '', providerFailure: quota };
    }
    return withRemaining(completed(opts, 'Complete.'), []);
  } };
  const run = (existing?: string) => runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, roles,
    existing, undefined, false, undefined, false);
  const parked = await run();
  expect(parked.status, parked.failureReason).toBe('parked');
  expect(calls).toEqual(['done', 'work']);
  expect(parked.stages.work).toMatchObject({ status: 'pending', retries: 0 });
  expect(parked.stages.work.attempts).toHaveLength(1);
  expect(parked.stages.work.attempts![0].endingCause).toBe('provider_quota');
  expect(parked.recovery).toMatchObject({ cause: 'provider_quota', notBefore: new Date(reset).toISOString() });
  expect((await run(parked.runId)).status).toBe('parked');
  expect(calls).toEqual(['done', 'work']);
  vi.spyOn(Date, 'now').mockReturnValue(reset + 1);
  const resumed = await run(parked.runId);
  expect(resumed.status, resumed.failureReason).toBe('complete');
  expect(calls).toEqual(['done', 'work', 'work', 'review']);
  expect(resumed.currentIteration).toBe(1);
  expect(resumed.stages.work.retries).toBe(0);
  expect(resumed.stages.done.attempts).toHaveLength(1);
});


it.each([true, false])('SI process deaths are bounded separately from repeated work failures (crash=%s)', async crash => {
  const { roles, workflow } = workflowFixture(3);
  workflow.defaults.max_retries = 1;
  const calls: string[] = [];
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    return opts.stageId === 'work' ? { exitCode: crash ? 137 : 1, duration_ms: 1, output: 'Fixture failure.',
      ...(crash ? { processSignal: 'SIGKILL' as const, processExitCode: null } : {}) }
      : withRemaining(completed(opts, 'Complete.'), []);
  } };
  const result = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, roles,
    undefined, undefined, false, undefined, false);
  expect(calls.filter(id => id === 'work')).toHaveLength(2);
  expect(result.stages.work.attempts).toHaveLength(2);
  expect(result.stages.work.attempts!.every(attempt => attempt.endingCause === (crash ? 'process_death' : 'work_failed'))).toBe(true);
  expect(result.stages.work.retries).toBe(crash ? 0 : 1);
  expect(result.status).toBe('incomplete');
});


it('SI verified success after provider cleanup is complete and never starts a crash retry', async () => {
  const { roles, workflow } = workflowFixture(3);
  const calls: string[] = [];
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    return { ...withRemaining(completed(opts, 'Complete.'), []),
      ...(opts.stageId === 'work' ? { processSignal: 'SIGKILL' as const, processExitCode: null } : {}) };
  } };
  const result = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, roles,
    undefined, undefined, false, undefined, false);
  expect(result.status, result.failureReason).toBe('complete');
  expect(calls).toEqual(['done', 'work', 'review']);
  expect(result.stages.work.attempts).toHaveLength(1);
  expect(result.stages.work.attempts![0]).toMatchObject({ endingCause: 'complete', exitCode: 0, processSignal: 'SIGKILL' });
});


it.each([false, true])('SI a gate rejection cannot spend another attempt on a declared environment gap even with a confirmed finding (repair discovers=%s)', async repairDiscovers => {
  const { roles, workflow } = workflowFixture(3);
  const calls: string[] = [];
  const gap = { reason: 'Renderer unavailable; visual evidence cannot be supplied in this environment.' };
  const adapter: Adapter = { async run(prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === (repairDiscovers ? 'repair' : 'work')) return { exitCode: 0, duration_ms: 1, output: JSON.stringify({
      status: 'environment_gap', summary: gap.reason, caveats: [], remaining_work: ['Obtain the required visual evidence.'] }) };
    if (opts.stageId === 'review') {
      if (!repairDiscovers && calls.filter(id => id === 'review').length > 1) return withRemaining(completed(opts, 'Complete.'), []);
      if (!repairDiscovers || calls.filter(id => id === 'review').length > 1) expect(prompt).toContain(gap.reason);
      return { exitCode: 0, duration_ms: 1, output: JSON.stringify({ pass: false, reason: gap.reason, criteria: {},
        audit_findings: { version: 1, findings: [{ id: 'missing_visual', paths: ['work.txt'], reason: gap.reason, criterion_ids: [], invalidates_plan: false, repair_role: 'coder' }] }, repairability: { version: 1, disposition: 'repairable', evidence: gap.reason } }) };
    }
    return withRemaining(completed(opts, 'Complete.'), []);
  } };
  const result = await runWorkflow(workflow, stringify(workflow), project, withConfirmedRejections(adapter, 20_000), new Map(), undefined, roles,
    undefined, undefined, false, undefined, false, undefined, () => manualClock().clock);
  expect(calls).toEqual(repairDiscovers ? ['done', 'work', 'review', 'repair', 'review'] : ['done', 'work', 'review']);
  expect(result.status, result.failureReason).toBe('incomplete');
  expect(readGateEvaluation(project, 'review', result.runId)?.findings?.confirmed).toHaveLength(1);
  expect(result.stages.repair.attempts ?? []).toHaveLength(repairDiscovers ? 1 : 0);
  expect(result.decisionGraph?.records.filter(record => record.stageId === 'review').at(-1)?.reason).toContain(`Environment gap already reported by ${repairDiscovers ? 'repair' : 'work'}`);
}, 60_000);


it.each(['gap', 'refusal', 'cancellation'] as const)('SI repair a validated gap at deadline preserves %s precedence', async disposition => {
  const created = createRun(project, 'fixture', 'name: fixture', ['work']);
  const time = manualClock();
  const cancellation = new AbortController();
  const adapter: Adapter = { async run() {
    return { exitCode: 0, duration_ms: 1, output: JSON.stringify({status:'environment_gap', summary:'Renderer missing.', caveats:[], remaining_work:['Obtain visual evidence.']}) };
  } };
  const inspect = contractProbe.inspectStageArtifactContract;
  vi.spyOn(contractProbe,'inspectStageArtifactContract').mockImplementation((...args) => {
    const audit = inspect(...args);
    time.advanceTo(stageWrapUpTiming(budget).hardLimitMs + 1);
    if (disposition === 'refusal') audit.violations.push({ kind: 'declared_artifact', source: 'declaration', mention: 'work.txt', path: join(project, 'work.txt'), reason: 'Fixture settlement refused.' });
    if (disposition === 'cancellation') cancellation.abort();
    return audit;
  });
  const result = await withRunProcessOwnership(project, created.runId,
    () => runStage(adapter, { ...options(created, time), gateReviewed: true }), cancellation.signal);
  expect(contractProbe.inspectStageArtifactContract).toHaveBeenCalled();
  const endingCause = disposition === 'gap' ? 'environment_gap' : disposition === 'refusal' ? 'work_failed' : 'cancelled';
  expect(result.endingCause).toBe(endingCause);
  expect(result.continuation).toBeUndefined();
  expect(readStageStatus(project, created.runId, 'work').attempts!.at(-1)!.endingCause).toBe(endingCause);
  expect(readEvidence(created.runDirPath)).toContainEqual(expect.objectContaining({ kind: 'attempt', endingCause, continuation: false }));
});

function withTextReproduction(adapter: Adapter): Adapter {
 return { async run(prompt,role,opts) {
  const result=await adapter.run(prompt,role,opts);
  if(result.exitCode || !opts.outputSchema?.anyOf)return result;
  const verdict=JSON.parse(result.output);
  if(verdict.pass!==false)return result;
  const client=prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
  const snippet="process.exit(require('node:fs').readFileSync('work.txt','utf8')==='correct text'?0:1)";
  const command=JSON.stringify(process.execPath)+' -e '+"'"+snippet.replaceAll("'", "'\\''")+"'";
  const request=JSON.stringify({command,cwd:opts.workDir,shell:'/bin/sh'});
  const {runProjectCommand}=await import('../src/project-validation.js');
  const response=await runProjectCommand({role:'test',command:'/bin/sh',args:['-c',`${client} '${request.replaceAll("'", "'\\''")}'`],display:'Independently reproduce wrong work.txt',cwd:opts.workDir,runDir:opts.runDir,timeoutMs:20000});
  const recorded=JSON.parse(response.stdout!).record;
  expect(response.exitCode).toBe(0);expect(recorded.exitCode).toBe(1);
  verdict.audit_findings.findings=verdict.audit_findings.findings.map((finding:Record<string,unknown>)=>({...finding,reproduction:recorded.sequence}));
  return {...result,output:JSON.stringify(verdict)};
 }};
}

it.each((['disjoint','absent','broad','narrow'] as const).flatMap(mapping =>
  (['narrow','broad','absent'] as const).map(otherMapping => ({mapping,otherMapping}))))(
  'SI repair text finding after gap with author=$mapping other=$otherMapping', async ({mapping,otherMapping}) => {
  const {roles,workflow} = workflowFixture(3);
  const brief='---\noutputs: [work.txt]\n---\n# Produce text with an optional renderer\n\n## Requirements\n1. A missing optional renderer may be accepted using textual evidence.\n2. work.txt contains correct text.';
  const {extractBriefCriteria}=await import('../src/brief-criteria.js');
  const refs=extractBriefCriteria(brief).criteria.map(c=>c.id);expect(refs).toHaveLength(2);
  workflow.stages.find(s=>s.id==='review')!.criterion_refs=refs;
  workflow.stages.find(s=>s.id==='repair')!.criterion_refs=[refs[1]];
  workflow.stages.find(s=>s.id==='work')!.scope = mapping === 'disjoint' ? [] : ['work.txt'];
  if (mapping === 'broad' || mapping === 'narrow') workflow.stages.find(s=>s.id==='work')!.criterion_refs = mapping === 'broad' ? refs : [refs[0]];
  const text={...workflow.stages[1],id:'text',scope:['work.txt'],depends_on:['work']};
  if(otherMapping==='absent')delete text.criterion_refs;else text.criterion_refs=otherMapping==='broad'?refs:[refs[1]];
  workflow.stages.splice(2,0,text);
  workflow.stages.find(s=>s.id==='review')!.depends_on=['text'];
  normalizeStageContracts(workflow.stages);
  const calls:string[]=[];
  const adapter:Adapter={async run(_prompt,_role,opts){
    calls.push(opts.stageId);
    if(opts.stageId==='work') return {exitCode:0,duration_ms:1,output:JSON.stringify({status:'environment_gap',summary:'Optional renderer missing; textual evidence can satisfy the brief.',caveats:[],remaining_work:['Optional visual evidence unavailable.']})};
    if(opts.stageId==='text') writeFileSync(join(project,'work.txt'),'wrong text');
    if(opts.stageId==='repair') writeFileSync(join(project,'work.txt'),'correct text');
    if(opts.stageId==='review' && !calls.includes('repair')) return {exitCode:0,duration_ms:1,output:JSON.stringify({pass:false,reason:'Renderer gap accepted under criteria; independently reproduced text typo must be fixed.',criteria:{[refs[0]]:{status:'pass',evidence:'The stated optional renderer gap is accepted using delivered textual evidence.'},[refs[1]]:{status:'fail',evidence:'work.txt contains wrong text.'}},audit_findings:{version:1,findings:[{id:'text_typo',paths:['work.txt'],reason:'Text is wrong; renderer is unrelated.',criterion_ids:[refs[1]],invalidates_plan:false,repair_role:'coder'}]},repairability:{version:1,disposition:'repairable',evidence:'Repair work.txt only; no renderer invocation or gap reopening.'}})};
    return withRemaining(completed(opts,'Complete.'),[]);
  }};
  const result=await runWorkflow(workflow,stringify(workflow),project,withTextReproduction(adapter),new Map(),undefined,roles,undefined,brief,false,undefined,false,undefined,()=>manualClock().clock);
  // Broad/absent responsibility leaves gap identity unknown: the record has
  // no criterion/resource binding for the gap. Prose cannot grant independence.
  const independent=mapping==='disjoint'||mapping==='narrow';
  expect(calls).toEqual(independent?['done','work','text','review','repair','review']:['done','work','text','review']);
  expect(result.status).toBe(independent?'complete':'incomplete');
  expect(readFileSync(join(project,'work.txt'),'utf8')).toBe(independent?'correct text':'wrong text');
  expect(result.stages.work.attempts).toHaveLength(1);
  expect(result.stages.repair.attempts??[]).toHaveLength(independent?1:0);
  if(!independent){
    expect(readGateEvaluation(project,'review',result.runId)?.findings?.confirmed).toHaveLength(1);
    expect(result.decisionGraph?.records.find(record=>record.stageId==='review')?.reason).toContain('recorded facts do not establish an independent repair');
  }
});

function withRendererReproduction(adapter: Adapter): Adapter {
 return {async run(prompt,role,opts) {
  const result=await adapter.run(prompt,role,opts);
  if(result.exitCode || !opts.outputSchema?.anyOf)return result;
  const verdict=JSON.parse(result.output);if(verdict.pass!==false)return result;
  const client=prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
  const request=JSON.stringify({command:'/bin/sh -c \'test -x ./renderer\'',cwd:opts.workDir,shell:'/bin/sh'});
  const {runProjectCommand}=await import('../src/project-validation.js');
  const response=await runProjectCommand({role:'test',command:'/bin/sh',args:['-c',`${client} '${request.replaceAll("'", "'\\''")}'`],display:'Reproduce same missing renderer capability',cwd:opts.workDir,runDir:opts.runDir,timeoutMs:20000});
  expect(response.exitCode).toBe(0);const record=JSON.parse(response.stdout!).record;expect(record.exitCode).toBe(1);
  verdict.audit_findings.findings=verdict.audit_findings.findings.map((f:Record<string,unknown>)=>({...f,reproduction:record.sequence}));
  return {...result,output:JSON.stringify(verdict)};
 }};
}

it.each((['narrow','broad','absent'] as const).flatMap(authorMapping =>
 (['narrow','broad','absent'] as const).map(otherMapping => ({authorMapping,otherMapping}))))(
 'SI repair shared ownership cannot reopen the same renderer gap with author=$authorMapping other=$otherMapping',async ({authorMapping,otherMapping})=>{
 const {roles,workflow}=workflowFixture(3);
 const brief='---\noutputs: [work.txt]\n---\n# Renderer work\n\n## Requirements\n1. The renderer executable supplies visual evidence.\n2. work.txt contains correct text.';
 const {extractBriefCriteria}=await import('../src/brief-criteria.js');const refs=extractBriefCriteria(brief).criteria.map(c=>c.id);expect(refs).toHaveLength(2);
 workflow.stages.find(s=>s.id==='work')!.scope=['renderer','work.txt'];
 if(authorMapping==='absent')delete workflow.stages.find(s=>s.id==='work')!.criterion_refs;
 else workflow.stages.find(s=>s.id==='work')!.criterion_refs=authorMapping==='broad'?refs:[refs[0]];
 workflow.stages.find(s=>s.id==='repair')!.scope=['renderer','work.txt'];
 workflow.stages.find(s=>s.id==='repair')!.criterion_refs=[refs[0]];
 workflow.stages.find(s=>s.id==='review')!.criterion_refs=refs;
 const text={...workflow.stages[1],id:'text',scope:['renderer','work.txt'],depends_on:['work']};
 if(otherMapping==='absent')delete text.criterion_refs;else text.criterion_refs=otherMapping==='broad'?refs:[refs[1]];
 workflow.stages.splice(2,0,text);workflow.stages.find(s=>s.id==='review')!.depends_on=['text'];normalizeStageContracts(workflow.stages);
 const calls:string[]=[],rendererProbes:string[]=[];
 const adapter:Adapter={async run(_prompt,_role,opts){
  calls.push(opts.stageId);
  if(opts.stageId==='work'||opts.stageId==='repair') {
   rendererProbes.push(opts.stageId);expect(existsSync(join(project,'renderer'))).toBe(false);
   return {exitCode:0,duration_ms:1,output:JSON.stringify({status:'environment_gap',summary:'The required renderer executable is unavailable in this environment.',caveats:[],remaining_work:['Supply visual evidence with renderer.']})};
  }
  if(opts.stageId==='text')writeFileSync(join(project,'work.txt'),'correct text');
  if(opts.stageId==='review')return {exitCode:0,duration_ms:1,output:JSON.stringify({pass:false,reason:'The renderer is absent; text is correct.',criteria:{[refs[0]]:{status:'fail',evidence:'Renderer unavailable.'},[refs[1]]:{status:'pass',evidence:'Correct text exists.'}},audit_findings:{version:1,findings:[{id:'missing_renderer',paths:['renderer'],reason:'Same renderer capability missing.',criterion_ids:[refs[0]],invalidates_plan:false,repair_role:'coder'}]},repairability:{version:1,disposition:'repairable',evidence:'The renderer is absent.'}})};
  return withRemaining(completed(opts,'Complete.'),[]);
 }};
 const result=await runWorkflow(workflow,stringify(workflow),project,withRendererReproduction(adapter),new Map(),undefined,roles,undefined,brief,false,undefined,false,undefined,()=>manualClock().clock);
 expect(rendererProbes).toEqual(['work']);
 expect(calls).toEqual(['done','work','text','review']);
 expect(result.status).toBe('incomplete');
 expect(result.stages.work.attempts).toHaveLength(1);
 expect(result.stages.repair.attempts ?? []).toHaveLength(0);
 expect(readGateEvaluation(project,'review',result.runId)?.findings?.confirmed).toHaveLength(1);
 expect(result.decisionGraph?.records.find(record => record.stageId === 'review')?.reason).toContain('Environment gap already reported by work');
});
