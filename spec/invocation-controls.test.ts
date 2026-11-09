import { requestPath, runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execWithStdin, type Adapter } from '../src/adapters/base.js';
import { appendGuidanceEnvelope, guidanceForExecution } from '../src/guidance.js';
import { CommandActivityTracker } from '../src/command-activity.js';
import { requestStageCommandInterrupt } from '../src/command-interrupt.js';
import { readEvidence } from '../src/evidence-ledger.js';
import { processGroupIsAlive } from '../src/process-liveness.js';
import { readRunEvents } from '../src/run-events.js';
import { runStage } from '../src/worker.js';
import { beginStageAttempt, fcGlobalDir, readStageStatus, setFcGlobalDir } from '../src/store.js';
import { cancelRunStateAtPath } from '../src/scheduler/sched_policy/run-completion.js';
import { cmdEventsWithDeps } from '../src/cli-events.js';
import { SessionPush, wrapUpPrompt } from '../src/session-push.js';
import { TaskRegistry } from '../src/task-registry.js';
import { createRun } from './test-support/create-run.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';

let root: string, projectDir: string, prior: string;
beforeEach(() => {
  prior = fcGlobalDir(); root = mkdtempSync(join(tmpdir(), 'invocation-controls-'));
  projectDir = join(root, 'project'); mkdirSync(projectDir); setFcGlobalDir(join(root, 'state'));
});
afterEach(() => { setFcGlobalDir(prior); rmSync(root, { recursive: true, force: true }); });
const role = { name: 'coder', description: 'fixture', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'Fixture system input' };
function fixture() {
  const run = createRun(projectDir, 'fixture', 'name: fixture\nstages: []\n', ['work']);
  return { run, options: { ...run, runDir: run.runDirPath, projectDir, stageId: 'work', role, dependsOn: [], retries: 0,
    promptTemplate: 'Complete the bounded work.', timeout_ms: 8_000, artifactContract: fixtureArtifactContract('work') } };
}

describe('control reaches the invocation with verified retirement', () => {
  it.each(['guidance', 'interrupt'] as const)('%s stops concurrent children and stays pending until submitted input contains it', async control => {
    const { run, options } = fixture();
    let calls = 0, guidanceId: string | undefined, providerPid: number | undefined;
    let abortedAtFirstCompletion: boolean | undefined, interruptError: unknown;
    let direct: { processExitCode?: number | null; processSignal?: string | null } | undefined;
    const body = 'Use the bounded evidence already available.';
    const adapter: Adapter = { capturesInvocationInput: true, async run(prompt, agent, opts) {
      calls++;
      if (calls === 2) {
        // Reading the queue and retiring a process are not model submission.
        expect(readRunEvents(projectDir, run.runId).filter(event => event.delivered)).toEqual([]);
        expect(readRunEvents(projectDir, run.runId)).toContainEqual(expect.objectContaining({
          type: 'guidance_delivery_checked', delivered: false, detail: expect.stringContaining('pending'),
        }));
        expect(processGroupIsAlive(providerPid!)).toBe(false);
        expect(prompt).toContain(body);
        opts.onInvocationInput?.({ systemPrompt: agent.prompt, userPrompt: 'No envelope was submitted here.' });
        expect(readRunEvents(projectDir, run.runId).filter(event => event.delivered)).toEqual([]);
        opts.onInvocationInput?.({ systemPrompt: agent.prompt, userPrompt: prompt });
        const delivered = readRunEvents(projectDir, run.runId).filter(event => event.delivered);
        expect(delivered).toEqual([expect.objectContaining({ boundary: 'model_submission', invocationIndex: 2,
          retiredCommandIds: control === 'guidance' ? ['long-b'] : ['long-a', 'long-b'] })]);
        expect(readFileSync(runRecordPath(run.runDirPath, 'stages/work/guidance_consumed.md'), 'utf8')).toContain('long-b');
        return { output: 'done', exitCode: 0, duration_ms: 1 };
      }
      opts.onInvocationInput?.({ systemPrompt: agent.prompt, userPrompt: prompt });
      const script = `const {spawn}=require('node:child_process');
        const emit=x=>console.log(JSON.stringify(x));
        const a=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),600)'],{stdio:'ignore'});
        const b=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),30000)'],{stdio:'ignore'});
        emit({type:'item.started',item:{id:'long-a',type:'command_execution',command:'long child a'}});
        emit({type:'item.started',item:{id:'long-b',type:'command_execution',command:'long child b'}});
        a.on('close',code=>emit({type:'item.completed',item:{id:'long-a',type:'command_execution',exit_code:code}}));
        setTimeout(()=>{},30000);`;
      const result = await execWithStdin(process.execPath, ['-e', script], '', { cwd: projectDir, timeout_ms: 5_000,
        abortSignal: opts.abortSignal, execution: { ...opts, onCommandLifecycle: event => {
          opts.onCommandLifecycle?.(event);
          if (event.phase === 'completed' && event.id === 'long-a') abortedAtFirstCompletion = opts.abortSignal?.aborted;
          if (event.phase !== 'started' || event.id !== 'long-b') return;
          if (control === 'guidance') guidanceId = appendGuidanceEnvelope({ runDir: run.runDirPath, target: 'work',
            source: 'operator', knownStageIds: ['work'], body }).id;
          else try { requestStageCommandInterrupt({ runDir: run.runDirPath, stageId: 'work', reason: body }); }
          catch (error) { interruptError = error; }
        } }, onChild: ({ pid }) => { providerPid = pid; }, onStdout: (chunk, activity) => activity?.feed(chunk) });
      direct = result;
      return result;
    } };
    // Leave room for loaded-host startup without injecting scheduler wrap-up
    // guidance into this command-control proof; the child still has a 5s timeout.
    const result = await runStage(adapter, { ...options, timeout_ms: 30_000 });
    expect(interruptError).toBeUndefined();
    if (control === 'guidance') expect(abortedAtFirstCompletion).toBe(true);
    expect(result.exitCode).toBe(0); expect(calls).toBe(2);
    expect(direct).toMatchObject({ exitCode: 137, processSignal: 'SIGTERM' });
    const events = readRunEvents(projectDir, run.runId);
    const delivery = events.find(event => event.delivered)!;
    if (guidanceId) expect(delivery.guidanceIds).toEqual([guidanceId]);
    if (control === 'interrupt') expect(events).toContainEqual(expect.objectContaining({ type: 'stage_command_interrupted',
      commandIds: ['long-a', 'long-b'] }));
    expect(readStageStatus(projectDir, run.runId, 'work').attempts).toHaveLength(1);
  });

  it.each(['attemptIndex', 'attemptStartedAt', 'stageId', 'invocationIndex'] as const)('rejects a wrong %s without stopping the invocation', async field => {
    const { run, options } = fixture();
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      const tracker = new CommandActivityTracker({ runDir: opts.runDir, stageId: opts.stageId,
        attemptIndex: opts.attemptIndex!, attemptStartedAt: opts.attemptStartedAt!, invocationIndex: opts.invocationIndex,
        onLifecycle: opts.onCommandLifecycle });
      // Command text is attribution, not interrupt admission evidence.
      tracker.started('unattributed-a'); tracker.started('unattributed-b');
      const signal = requestStageCommandInterrupt({ runDir: run.runDirPath, stageId: 'work', reason: 'Bounded stop' });
      const changed = { ...signal, [field]: field === 'attemptIndex' || field === 'invocationIndex' ? 2 : 'other' };
      const path = requestPath(run.runDirPath, 'signals/interrupt_work.json');
      writeFileSync(path, JSON.stringify(changed));
      tracker.started('publication-boundary');
      expect(opts.abortSignal?.aborted).toBe(false); expect(existsSync(path)).toBe(false);
      tracker.close(); return { output: 'done', exitCode: 0, duration_ms: 1 };
    } };
    expect((await runStage(adapter, options)).exitCode).toBe(0);
    expect(readRunEvents(projectDir, run.runId).some(event => event.type === 'stage_command_interrupt_requested')).toBe(false);
  });

  it('retains a submitted operator ruling across a retry that never submits model input', async () => {
    const { run, options } = fixture();
    const ruling = appendGuidanceEnvelope({ runDir: run.runDirPath, target: 'work', source: 'operator', attemptIndex: 1,
      body: 'Keep this operator ruling with its original binding.' });
    const submitted: Adapter = { capturesInvocationInput: true, async run(prompt, agent, opts) {
      opts.onInvocationInput?.({ systemPrompt: agent.prompt, userPrompt: prompt });
      return { output: 'done', exitCode: 0, duration_ms: 1 };
    } };
    await runStage(submitted, options);
    const receipt = runRecordPath(run.runDirPath, 'stages/work/guidance_consumed.md');
    const before = readFileSync(receipt, 'utf8');
    const neverSubmitted: Adapter = { capturesInvocationInput: true, async run() { return { output: 'No native input was submitted', exitCode: 1, duration_ms: 1 }; } };
    await runStage(neverSubmitted, options);
    expect(readFileSync(receipt, 'utf8')).toBe(before);
    const prompts: string[] = [];
    await runStage({ async run(prompt) { prompts.push(prompt); return { output: 'done', exitCode: 0, duration_ms: 1 }; } }, options);
    expect(prompts[0]).toContain(ruling.body);
    expect(readRunEvents(projectDir, run.runId)).toContainEqual(expect.objectContaining({ attemptIndex: 3,
      boundary: 'model_submission', delivered: true, guidanceIds: [ruling.id] }));
  });

  it('expires scheduler notices by attempt identity without interpreting their bodies', () => {
    const { run } = fixture();
    const scheduler = appendGuidanceEnvelope({ runDir: run.runDirPath, target: 'work', source: 'scheduler', attemptIndex: 1,
      body: 'An arbitrary notice with no recognized prefix.' });
    const operator = appendGuidanceEnvelope({ runDir: run.runDirPath, target: 'work', source: 'operator', attemptIndex: 1,
      body: 'An operator ruling retained with its original identity.' });
    expect(guidanceForExecution([scheduler, operator], 1)).toEqual([scheduler, operator]);
    expect(guidanceForExecution([scheduler, operator], 2)).toEqual([operator]);
  });

  it('retains native gate facts without trees and tree-binds engine-recorded reproduction', async () => {
    const { run, options } = fixture();
    const adapter: Adapter = { async run(prompt, _agent, opts) {
      opts.onCommandLifecycle?.({ phase: 'started', id: 'native', command: 'true', timestamp: new Date().toISOString() });
      opts.onCommandLifecycle?.({ phase: 'completed', id: 'native', exitCode: 0, output: 'native output', timestamp: new Date().toISOString() });
      const client = prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
      const request = JSON.stringify({ command: 'exit 1', cwd: projectDir, shell: '/bin/sh' });
      const result = await execWithStdin('/bin/sh', ['-c', `${client} '${request}'`], '', { cwd: projectDir, timeout_ms: 3_000 });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output).record).toMatchObject({ exitCode: 1, owner: 'code', treeHash: expect.any(String), treeAfterHash: expect.any(String) });
      return { output: 'Captured facts', exitCode: 1, duration_ms: 1 };
    } };
    await runStage(adapter, { ...options, isGate: true });
    const native = readEvidence(run.runDirPath).find(entry => entry.kind === 'command' && entry.commandId === 'native')!;
    expect(native).toMatchObject({ owner: 'adapter-event', exitCode: 0, outputDigest: expect.any(String) });
    expect(native).not.toHaveProperty('treeHash'); expect(native).not.toHaveProperty('treeAfterHash');
  });
});

describe('cancellation publishes the canonical terminal attempt event', () => {
  it('events and session-push consume cancellation closure once, preserving identity', async () => {
    const { run } = fixture();
    beginStageAttempt(projectDir, run.runId, 'work', 0, '2026-01-01T00:00:00Z', { role: 'coder', iteration: 1 });
    const registry = new TaskRegistry({ baseDir: join(root, 'state') });
    registry.create({ projectDir, run_id: run.runId, status: 'running', name: 'Cancellation fixture',
      launcher: { frontend: 'claude', sessionId: 'fixture-session', cwd: projectDir, ledgerRoot: join(root, 'ledger') } });
    cancelRunStateAtPath(run.runDirPath, '2026-01-01T00:00:01Z');
    cancelRunStateAtPath(run.runDirPath, '2026-01-01T00:00:02Z');
    const terminal = readRunEvents(projectDir, run.runId).filter(event => event.type === 'attempt_failed');
    expect(terminal).toEqual([expect.objectContaining({ stageId: 'work', attemptIndex: 1, attemptStartedAt: '2026-01-01T00:00:00Z',
      role: 'coder', iteration: 1, disposition: 'discarded', status: 'failed', exitCode: 143 })]);
    let output = '';
    expect(await cmdEventsWithDeps(['--run', run.runId, '--type', 'attempt_failed', '--json'], {
      runsRoot: dirname(run.runDirPath), stdout: { write: chunk => { output += chunk; } },
    })).toBe(0);
    expect(output).toContain('attempt_failed'); expect(output).toContain('Cancelled by user');
    const push = new SessionPush(registry, { claude: async () => {}, notify: async () => {} });
    await push.sweep();
    const event = push.events().find(event => event.kind === 'attempt_failed')!;
    expect(event).toMatchObject({ stageId: 'work', attemptIndex: 1, attemptStartedAt: terminal[0].attemptStartedAt });
    expect(push.describe(event).failureIdentity).toBe('exit 143');
    expect(wrapUpPrompt(event, registry.baseDir)).toContain('kind=attempt_failed');
    expect(existsSync(runRecordPath(run.runDirPath, 'events.jsonl'))).toBe(true);
  });
});
