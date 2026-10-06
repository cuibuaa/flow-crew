/** Private trial lifecycle shared by the workflow and recovery trials.
 * Callers own fixture scenarios; this unit owns child identity, bounded polling,
 * private registration and coherent evidence copies. It never selects a model.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { ProcessStartToken } from '../src/run-lock.js';
import { sha256 } from './engine-principles-inputs.js';

export interface OwnedTrialProcess { pid: number; token: ProcessStartToken | undefined; label: string }

/** A refused launch intent has no unit exit record. Require its exact reason
 * and run binding; callers additionally check unchanged history and no work.
 */
export function cancelledContinuationRefused(response: any, runId: string): boolean {
  const task = response.task;
  const terminal = ['failed', 'cancelled', 'stuck', 'stopped'].includes(task?.status);
  const refusedBeforeLaunch = task?.run_id === runId && task.status === 'stopped'
    && typeof task.notes === 'string'
    && task.notes.includes(`RUN_CANCELLED: run ${runId} has acknowledged cancellation`)
    && response.unit_status?.kind !== 'running';
  return terminal && (response.unit_status?.kind === 'terminal' || refusedBeforeLaunch);
}

export function createPrivateTrialSupport(input: {
  root: string; storeRoot: string; dist: string; out: string; socket: string;
  brief: string; admission: unknown;
  processStartToken: (pid: number) => ProcessStartToken | undefined;
  sendRpc: (socket: string, request: any) => Promise<any>;
  readRunStateView: (project: string, run: string, options: any) => any;
  engineGeneration: () => string;
}) {
  const { root, storeRoot, dist, out, socket, brief, admission,
    processStartToken, sendRpc, readRunStateView, engineGeneration } = input;
  const tracked: OwnedTrialProcess[] = [];
  function own(pid: number, label: string, expected?: ProcessStartToken): void {
    const token = processStartToken(pid);
    if (expected && JSON.stringify(token) !== JSON.stringify(expected)) return;
    if (!tracked.some(entry => entry.pid === pid)) tracked.push({ pid, token, label });
  }
  function stopOwned(entry: OwnedTrialProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    const current = processStartToken(entry.pid);
    if (!entry.token || !current || JSON.stringify(entry.token) !== JSON.stringify(current)) return;
    try { process.kill(entry.pid, signal); } catch { /* already exited */ }
  }
  // Native confinement intentionally forbids fixtures from appending telemetry
  // outside their stage. Read the receipts the engine captures from stdout.
  function fixtureCalls(): any[] {
    const calls: any[] = [], runs = join(storeRoot, 'runs');
    if (!existsSync(runs)) return calls;
    for (const runId of readdirSync(runs)) {
      const run = join(runs, runId), stages = join(run, 'stages');
      if (!existsSync(stages)) continue;
      for (const stage of readdirSync(stages)) {
        const log = join(stages, stage, 'live.log'); if (!existsSync(log)) continue;
        for (const line of readFileSync(log, 'utf8').split('\n')) {
          if (!line.startsWith('{"type":"flowcrew_private_fixture",') || !line.endsWith('}')) continue;
          const call = JSON.parse(line);
          if (call.run === run && call.stage === stage) calls.push(call);
        }
      }
    }
    return calls;
  }
  function discoverOwned(): void {
    for (const call of fixtureCalls()) own(call.pid, `fixture ${call.stage}`, call.token);
    const supervise = join(storeRoot, 'supervise');
    if (existsSync(supervise)) for (const name of readdirSync(supervise)) {
      const file = join(supervise, name, 'running.json'); if (!existsSync(file)) continue;
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (!record.command?.includes(dist)) throw new Error('Foreign child in private supervision store');
      if (record.agentToken) own(record.agentPid, 'private portable agent', record.agentToken);
      if (record.shimToken) own(record.shimPid, 'private portable shim', record.shimToken);
    }
    const runs = join(storeRoot, 'runs');
    if (existsSync(runs)) for (const name of readdirSync(runs)) {
      const file = join(runs, name, 'run.json'); if (!existsSync(file)) continue;
      const state = JSON.parse(readFileSync(file, 'utf8'));
      if (state.engineCheckpoint?.processStart && state.projectDir.startsWith(root + sep)) {
        own(state.engineCheckpoint.pid, 'private scheduler', state.engineCheckpoint.processStart);
      }
    }
  }
  async function poll<T>(label: string, check: () => T | undefined | Promise<T | undefined>, timeout = 60000): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      discoverOwned(); const value = await check(); if (value !== undefined) return value;
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`TRIAL_TIMEOUT: ${label}`);
  }
  async function register(dir: string, runId?: string): Promise<any> {
    return sendRpc(socket, { cmd: 'register', task: { name: dirname(dir).split(sep).at(-1), projectDir: dir,
      brief_text: brief, brief_admission: admission, max_retries: 0,
      launch_args: ['--workflow', 'trial', '--adapter', 'codex'], ...(runId ? { run_id: runId } : {}) } });
  }
  async function preserve(label: string, dir: string, runId: string, state: any): Promise<any> {
    const run = join(storeRoot, 'runs', runId), target = join(out, 'trial-evidence', label);
    const view = await poll('coherent state observation', () => {
      try { return readRunStateView(dir, runId, { includePromptText: true }); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'STATE_VIEW_UNSTABLE') return undefined;
        throw error;
      }
    }, 10000);
    mkdirSync(target, { recursive: true });
    cpSync(run, join(target, 'run'), { recursive: true, dereference: false });
    cpSync(dir, join(target, 'project'), { recursive: true, dereference: false });
    if (sha256(readFileSync(join(target, 'run/run.json'), 'utf8')) !== view.snapshot.runStateSha256) {
      throw new Error('TRIAL_COPY_UNSTABLE: copied run projection differs from the coherent observation');
    }
    writeFileSync(join(target, 'state-view.json'), JSON.stringify(view, null, 2));
    const calls = fixtureCalls().filter(entry => entry.run === run);
    writeFileSync(join(target, 'fixture-calls.json'), JSON.stringify(calls, null, 2));
    return { label, projectDir: dir, runId, evidence: target, status: state.status, iteration: state.currentIteration,
      maxIterations: state.maxIterations, planHistory: state.queryState?.planHistory, findings: state.queryState?.findings,
      stages: state.stages, fixtureCalls: calls.map(({ stage, inputSha256 }: any) => ({ stage, inputSha256 })),
      promptCoverage: view.prompts.coverage, generation: engineGeneration() };
  }
  return { tracked, own, stopOwned, discoverOwned, poll, register, preserve, fixtureCalls };
}
