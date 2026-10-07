import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleDaemonRegistrationRequest } from '../src/cli-daemon.js';
import { TaskRegistry } from '../src/task-registry.js';
import { Orchestrator, type SupervisorBackend, type GitAdapter } from '../src/orchestrator.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { sendRpc, startRpcServer, type RegisterRpcResponse } from '../src/orchestrator-rpc.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'daemon-surface-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const git: GitAdapter = {
  async findCommitByPrefix() { return undefined; },
  async findCommitSince() { return undefined; },
  async hasUncommittedChanges() { return false; },
};
function input() {
  const brief = '# Goal\nAn admitted deterministic queue task.\n';
  return { projectDir: root, brief_text: brief, brief_admission: createBriefAdmission(inspectBrief(brief), {
    kind: 'explicit' as const, source: 'cli_current_input_flag' as const, at: '2026-01-01T00:00:00.000Z',
  }), launch_args: ['--adapter', 'mock'] };
}
function backend(run = async () => {}): SupervisorBackend {
  let launched = false;
  return {
    async runUnit() { launched = true; await run(); },
    async isActive() { return launched ? { kind: 'active' } : { kind: 'absent' }; },
    async stopUnit() { throw new Error('unexpected stop'); },
    async journalTail() { return ''; },
  };
}

describe('durable registration queue', () => {
  it('acknowledges persistence while the launch remains unresolved', async () => {
    const registry = new TaskRegistry({ baseDir: root });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const systemd = backend(() => gate);
    const orchestrator = new Orchestrator({ registry, systemd, git, isProjectBusy: () => null });
    const socket = join(root, 'daemon.sock');
    let drain: Promise<void> | undefined;
    const server = await startRpcServer(socket, req => {
      if (req.cmd !== 'register') throw new Error('unexpected request');
      return handleDaemonRegistrationRequest(orchestrator, req, { pid: process.pid, build: { algorithm: 'sha256', hash: 'fixture', files: 1, newestMtimeMs: 0 } });
    }, { onResponse: () => { drain = orchestrator.tickOnce(); } });
    try {
      const response = await sendRpc<RegisterRpcResponse>(socket, { cmd: 'register', task: input(), acknowledgement: 'persisted' });
      expect(response.acknowledgement).toBe('persisted');
      expect(registry.get(response.id)?.status).toBe('running');
      expect(readFileSync(registry.registryPath, 'utf8')).toContain('"brief_admission"');
    } finally {
      release(); await drain; orchestrator.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(socket, { force: true });
    }
  });

  it('restarts a persisted queue without duplicate submission or retry consumption', async () => {
    const registry = new TaskRegistry({ baseDir: root });
    const first = new Orchestrator({ registry, systemd: backend(), git, isProjectBusy: () => null });
    const task = first.enqueue(input());
    expect(task.status).toBe('pending');
    expect(task.run_id).toBeUndefined();
    const calls = vi.fn(async () => {});
    const second = new Orchestrator({ registry: new TaskRegistry({ baseDir: root }), systemd: backend(calls), git, isProjectBusy: () => null });
    await second.tickOnce(); await second.tickOnce();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get(task.id)).toMatchObject({ status: 'running', attempt: 1 });
    expect(registry.get(task.id)?.run_id).toBeTruthy();
  });

  it('keeps admission, cancellation, busy-project and bound-resume boundaries', async () => {
    const registry = new TaskRegistry({ baseDir: root });
    const calls = vi.fn(async () => {});
    const orchestrator = new Orchestrator({ registry, systemd: backend(calls), git, isProjectBusy: () => 'busy-run' });
    expect(() => orchestrator.enqueue({ ...input(), brief_text: 'changed after admission' })).toThrow();
    expect(() => orchestrator.enqueue({ ...input(), run_id: 'existing' })).toThrow('existing-run resume');
    expect(registry.list()).toHaveLength(0);
    const cancelled = orchestrator.enqueue(input()); registry.update(cancelled.id, { status: 'cancelled' });
    const waiting = orchestrator.enqueue(input()); await orchestrator.tickOnce();
    expect(registry.get(cancelled.id)?.status).toBe('cancelled');
    expect(registry.get(waiting.id)).toMatchObject({ status: 'deferred', attempt: 1, defer_kind: 'wait' });
    expect(calls).not.toHaveBeenCalled();
  });
});

describe('registry selection before mutable copies', () => {
  it('clones only selected tasks and leaves cached payloads isolated', () => {
    const registry = new TaskRegistry({ baseDir: root });
    const done = registry.create({ projectDir: root, brief_text: 'done', status: 'done' });
    const active = registry.create({ projectDir: root, brief_text: 'active', launch_args: ['--adapter', 'mock'] });
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const selected = registry.list({ status: 'active', limit: 1 });
    expect(clone).toHaveBeenCalledTimes(1);
    expect(selected[0].id).toBe(active.id);
    selected[0].launch_args!.push('mutated'); selected[0].status = 'done';
    expect(registry.get(active.id)?.launch_args).toEqual(['--adapter', 'mock']);
    expect(registry.list({ status: 'active' }).map(task => task.id)).toEqual([active.id]);
    expect(registry.list({ status: 'done' })[0].id).toBe(done.id);
    expect(registry.cacheDiagnostics().lastBytesParsed).toBe(0);
  });

  it('keeps active transitions and unterminated overlays coherent across external writes', () => {
    const registry = new TaskRegistry({ baseDir: root });
    const task = registry.create({ projectDir: root, brief_text: 'active' });
    appendFileSync(registry.registryPath, JSON.stringify({ ...task, status: 'done' }));
    expect(registry.list({ status: 'active' })).toHaveLength(0);
    expect(registry.metrics().activeTasks).toBe(0);
    appendFileSync(registry.registryPath, '\n' + JSON.stringify({ ...task, status: 'running' }) + '\n');
    expect(registry.list({ status: 'active' })[0].status).toBe('running');
    expect(registry.metrics().activeTasks).toBe(1);
    writeFileSync(registry.registryPath, JSON.stringify({ ...task, status: 'cancelled' }) + '\n');
    expect(registry.list({ status: 'active' })).toHaveLength(0);
    expect(registry.list()).toHaveLength(1);
    appendFileSync(registry.registryPath, '{torn');
    expect(() => registry.update(task.id, { status: 'running' })).toThrow('integrity check failed');
  });
});
