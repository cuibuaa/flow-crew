import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { cmdTask } from '../src/cli-task.js';
import { startRpcServer, type RpcRequest, type RpcResponse } from '../src/orchestrator-rpc.js';
import type { TaskEntry } from '../src/task-registry.js';
import type { CancellationResult } from '../src/run-control.js';

let tempDir: string;
let socketPath: string;
let server: Server | undefined;
let requests: RpcRequest[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), `flowcrew-cli-task-${randomBytes(4).toString('hex')}-`));
  socketPath = join(tempDir, 'daemon.sock');
  requests = [];
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('cmdTask', () => {
  it('lists tasks with status filter and limit', async () => {
    server = await startRpcServer(socketPath, (req) => {
      requests.push(req);
      return { tasks: [task({ id: 2, status: 'running' })] };
    });

    const out = new Capture();
    const code = await cmdTask(['task', 'list', '--status', 'all', '--limit', '5', '--port', socketPath], { stdout: out.stream as any, stderr: out.err as any });

    expect(code).toBe(0);
    expect(requests[0]).toMatchObject({ cmd: 'list', filter: { status: 'all', limit: 5 } });
    expect(out.text()).toContain('flowcrew-task-2.service');
  });

  it('surfaces unreadable registry records instead of silently hiding them', async () => {
    server = await startRpcServer(socketPath, () => ({
      tasks: [task({ id: 2, status: 'running' })],
      registry_unreadable_records: 3,
    }));
    const out = new Capture();

    const code = await cmdTask(
      ['task', 'list', '--port', socketPath],
      { stdout: out.stream as any, stderr: out.err as any },
    );

    expect(code).toBe(0);
    expect(out.errorText()).toContain('registry has 3 unreadable records');
  });

  it('shows task details and recent ticks', async () => {
    server = await startRpcServer(socketPath, () => ({ task: task({ id: 3, status: 'done' }), recent_ticks: ['- tick'] }));
    const out = new Capture();

    const code = await cmdTask(['task', 'show', '3', '--port', socketPath], { stdout: out.stream as any, stderr: out.err as any });

    expect(code).toBe(0);
    expect(out.text()).toContain('Task #3');
    expect(out.text()).toContain('- tick');
  });

  it('shows summary verdict and one-liner at the top of task details', async () => {
    server = await startRpcServer(socketPath, () => ({
      task: task({
        id: 3,
        status: 'done',
        summary_verdict: 'PASS',
        summary_one_liner: 'The daemon now surfaces task outcomes.',
        summary_full: '# Task Summary\n',
      }),
      recent_ticks: [],
    }));
    const out = new Capture();

    const code = await cmdTask(['task', 'show', '3', '--port', socketPath], { stdout: out.stream as any, stderr: out.err as any });

    expect(code).toBe(0);
    expect(out.text().split(/\r?\n/).slice(0, 4)).toEqual([
      'Task #3: Task 3',
      'Verdict: PASS',
      'Summary: The daemon now surfaces task outcomes.',
      'Status: done',
    ]);
  });

  it('lists tasks with summary excerpts when requested', async () => {
    server = await startRpcServer(socketPath, (req) => {
      requests.push(req);
      return { tasks: [task({ id: 2, status: 'done', summary_one_liner: 'A'.repeat(100) })] };
    });
    const out = new Capture();

    const code = await cmdTask(['task', 'list', '--status', 'all', '--with-summary', '--port', socketPath], { stdout: out.stream as any, stderr: out.err as any });

    expect(code).toBe(0);
    expect(out.text()).toContain('Summary');
    expect(out.text()).toContain('A'.repeat(80));
    expect(out.text()).not.toContain('A'.repeat(81));
  });

  it('prints only summary markdown with --summary-only', async () => {
    const summary = '# Task Summary\n\n**Verdict**: PASS\n';
    server = await startRpcServer(socketPath, () => ({ task: task({ id: 3, status: 'done', summary_full: summary }), recent_ticks: ['- tick'] }));
    const out = new Capture();

    const code = await cmdTask(['task', 'show', '3', '--summary-only', '--port', socketPath], { stdout: out.stream as any, stderr: out.err as any });

    expect(code).toBe(0);
    expect(out.text()).toBe(summary);
  });

  it('round-trips cancel, retry, and tail commands', async () => {
    server = await startRpcServer(socketPath, (req): RpcResponse => {
      requests.push(req);
      if (req.cmd === 'show') return { task: task({ id: req.id }), recent_ticks: [] };
      if (req.cmd === 'cancel') return cancelledTask(req.id);
      if (req.cmd === 'retry') return { new_attempt: 2, unit: 'flowcrew-task-1-attempt-2.service' };
      if (req.cmd === 'tail') return { output: 'journal\n' };
      return { ok: true };
    });
    const out = new Capture();

    expect(await cmdTask(['task', 'cancel', '1', '--port', socketPath], { stdout: out.stream as any, stderr: out.err as any })).toBe(0);
    expect(await cmdTask(['task', 'retry', '1', '--port', socketPath], { stdout: out.stream as any, stderr: out.err as any })).toBe(0);
    expect(await cmdTask(['task', 'tail', '1', '--tail', '3', '--port', socketPath], { stdout: out.stream as any, stderr: out.err as any })).toBe(0);

    expect(requests.map((r) => r.cmd)).toEqual(['show', 'cancel', 'retry', 'tail']);
    expect(out.text()).toContain('journal');
  });

  it('reports missing daemon clearly', async () => {
    const out = new Capture();
    const code = await cmdTask(['task', 'list', '--port', socketPath], { stdout: out.stream as any, stderr: out.err as any });

    expect(code).toBe(1);
    expect(out.errorText()).toContain('daemon not running. Start with: flowcrew daemon start');
  });
});

function task(overrides: Partial<TaskEntry>): TaskEntry {
  const id = overrides.id ?? 1;
  return {
    id,
    name: `Task ${id}`,
    kind: 'quick',
    brief_text: 'brief',
    projectDir: tempDir,
    systemd_unit: `flowcrew-task-${id}.service`,
    status: 'running',
    attempt: 1,
    max_retries: 2,
    created_at: '2026-01-01T00:00:00.000Z',
    tick_log_path: join(tempDir, 'tasks', String(id), 'tick_log.md'),
    ...overrides,
  };
}

function cancelledTask(taskId: number): CancellationResult {
  return {
    ok: true,
    status: 'cancelled',
    taskId,
    observation: {
      unit: `flowcrew-task-${taskId}.service`,
      unitState: 'inactive',
      runReadable: true,
      schedulerPid: null,
      schedulerAlive: false,
      launchInFlight: false,
    },
    message: 'confirmed',
  };
}

class Capture {
  stream = new PassThrough();
  err = new PassThrough();
  private chunks: Buffer[] = [];
  private errChunks: Buffer[] = [];

  constructor() {
    this.stream.on('data', (chunk) => this.chunks.push(Buffer.from(chunk)));
    this.err.on('data', (chunk) => this.errChunks.push(Buffer.from(chunk)));
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf-8');
  }

  errorText(): string {
    return Buffer.concat(this.errChunks).toString('utf-8');
  }
}
