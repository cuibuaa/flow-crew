import net, { type Server, type Socket } from 'node:net';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdDaemon, mergeTaskWithRunState, type DaemonProcessControls } from '../src/cli-daemon.js';
import {
  STALE_DAEMON_MESSAGE,
  computeBuildFingerprint,
  createDaemonIdentity,
  writeDaemonIdentity,
  type DaemonIdentity,
} from '../src/daemon-identity.js';
import { sendRpc, startRpcServer, type DaemonStatusRpcResponse, type RpcResponse } from '../src/orchestrator-rpc.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { TaskRegistry } from '../src/task-registry.js';

interface TrackedServer {
  server: Server;
  sockets: Set<Socket>;
}

describe('daemon status local diagnosis', () => {
  let tempDir: string;
  let previousFcDir: string;
  let trackedServers: TrackedServer[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flowcrew-daemon-status-'));
    previousFcDir = fcGlobalDir();
    setFcGlobalDir(tempDir);
    trackedServers = [];
  });

  afterEach(async () => {
    setFcGlobalDir(previousFcDir);
    for (const tracked of trackedServers) {
      for (const socket of tracked.sockets) socket.destroy();
      if (tracked.server.listening) {
        await new Promise<void>((resolve) => tracked.server.close(() => resolve()));
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('falls back to owner, persisted build, disk build, and registry scale when a listener never replies', async () => {
    const socketPath = join(tempDir, 'daemon.sock');
    const distDir = createDist(tempDir, 'recorded build');
    const identity = createDaemonIdentity({
      socketPath,
      distDir,
      pid: process.pid,
      startedAt: '2026-07-31T13:37:08.261Z',
    });
    writeDaemonIdentity(socketPath, identity);
    writeFileSync(join(distDir, 'runtime.js'), 'export const build = "disk build";\n', 'utf-8');
    const diskBuild = computeBuildFingerprint(distDir);
    const registryBytes = seedRegistry(tempDir);
    await listenSilently(socketPath);

    const output = new Capture();
    const code = await cmdDaemon(
      ['daemon', 'status', '--socket', socketPath],
      {
        stdout: output.stdout as never,
        stderr: output.stderr as never,
        distDir,
        controls: { sendRpc: shortRpc },
      },
    );

    expect(code, output.error()).toBe(2);
    expect(output.output()).toContain('NONRESPONSIVE:');
    expect(output.output()).toContain(`owner_pid: ${process.pid}`);
    expect(output.output()).toContain(`recorded_build: ${identity.build.hash}`);
    expect(output.output()).toContain(`disk_build: ${diskBuild.hash}`);
    expect(output.output()).toContain(STALE_DAEMON_MESSAGE);
    expect(output.output()).toContain(`registry_bytes: ${registryBytes}`);
    expect(output.output()).toContain('registry_records: 3');
    expect(output.output()).toContain('registry_tasks: 2');
    expect(output.output()).not.toContain('daemon not running');
    expect(output.output()).not.toContain('flowcrew daemon status');
    expect(output.error()).toBe('');
  });

  it('classifies a missing socket owner as no listener with exit code 1', async () => {
    const socketPath = join(tempDir, 'absent.sock');
    const distDir = createDist(tempDir, 'unused build');
    const registryBytes = seedRegistry(tempDir);
    const output = new Capture();

    const code = await cmdDaemon(
      ['daemon', 'status', '--socket', socketPath],
      {
        stdout: output.stdout as never,
        stderr: output.stderr as never,
        distDir,
        controls: { sendRpc: shortRpc },
      },
    );

    expect(code, output.error()).toBe(1);
    expect(output.output()).toContain('NO LISTENER:');
    expect(output.output()).not.toContain('NONRESPONSIVE:');
    expect(output.output()).toContain(`registry_bytes: ${registryBytes}`);
    expect(output.output()).toContain('registry_records: 3');
    expect(output.output()).toContain('registry_tasks: 2');
    expect(output.error()).toBe('');
  });

  it('keeps responsive fresh and stale outcomes distinct while reporting registry scale', async () => {
    const socketPath = join(tempDir, 'daemon.sock');
    const distDir = createDist(tempDir, 'fresh build');
    const identity = createDaemonIdentity({
      socketPath,
      distDir,
      pid: process.pid,
      startedAt: '2026-07-31T14:00:00.000Z',
    });
    writeDaemonIdentity(socketPath, identity);
    const registryBytes = seedRegistry(tempDir);
    await listenWithStatus(socketPath, statusResponse(identity));

    const fresh = new Capture();
    const freshCode = await cmdDaemon(
      ['daemon', 'status', '--socket', socketPath],
      { stdout: fresh.stdout as never, stderr: fresh.stderr as never, distDir },
    );

    expect(freshCode, fresh.error()).toBe(0);
    expect(fresh.output()).toContain('RESPONSIVE:');
    expect(fresh.output()).toContain('FRESH: disk dist matches the build loaded by the running daemon.');
    expect(fresh.output()).toContain(`registry_bytes: ${registryBytes}`);
    expect(fresh.output()).toContain('registry_records: 3');
    expect(fresh.output()).toContain('registry_tasks: 2');

    writeFileSync(join(distDir, 'runtime.js'), 'export const build = "changed build";\n', 'utf-8');
    const stale = new Capture();
    const staleCode = await cmdDaemon(
      ['daemon', 'status', '--socket', socketPath],
      { stdout: stale.stdout as never, stderr: stale.stderr as never, distDir },
    );

    expect(staleCode, stale.error()).toBe(2);
    expect(stale.output()).toContain('RESPONSIVE:');
    expect(stale.output()).toContain(STALE_DAEMON_MESSAGE);
    expect(stale.output()).not.toContain('FRESH:');
  });

  it('treats a responsive listener with no provable owner as unverified', async () => {
    const socketPath = join(tempDir, 'daemon.sock');
    const distDir = createDist(tempDir, 'fresh build');
    const identity = createDaemonIdentity({ socketPath, distDir, pid: process.pid });
    writeDaemonIdentity(socketPath, identity);
    await listenWithStatus(socketPath, statusResponse(identity));
    const output = new Capture();

    const code = await cmdDaemon(
      ['daemon', 'status', '--socket', socketPath],
      {
        stdout: output.stdout as never,
        stderr: output.stderr as never,
        distDir,
        controls: { findSocketOwnerPid: () => undefined },
      },
    );

    expect(code, output.error()).toBe(2);
    expect(output.output()).toContain('RESPONSIVE:');
    expect(output.output()).toContain(`socket owner pid=none does not match RPC pid=${process.pid}`);
    expect(output.output()).not.toContain('NO LISTENER:');
    expect(output.output()).not.toContain('NONRESPONSIVE:');
  });

  it('points corruption refusal to dry-run and apply registry repair without contacting a daemon', async () => {
    const baseDir = join(tempDir, 'corrupt');
    const socketPath = join(baseDir, 'daemon.sock');
    const registry = new TaskRegistry({ baseDir });
    registry.create({ projectDir: tempDir, name: 'readable task' });
    appendFileSync(registry.registryPath, '{damaged evidence\n', 'utf-8');
    const output = new Capture();
    const forbiddenControls: Partial<DaemonProcessControls> = {
      sendRpc: async () => { throw new Error('restart must fail before RPC'); },
      findSocketOwnerPid: () => { throw new Error('restart must fail before owner lookup'); },
    };

    const code = await cmdDaemon(
      ['daemon', 'restart', '--force', '--socket', socketPath],
      { stdout: output.stdout as never, stderr: output.stderr as never, controls: forbiddenControls },
    );

    expect(code).toBe(3);
    expect(output.error()).toContain('flowcrew doctor --repair-registry\n');
    expect(output.error()).toContain('flowcrew doctor --repair-registry --apply');
    expect(output.error()).toContain('--force does not bypass registry corruption');
  });

  it('merges authoritative terminal run fields without mutating the stale registry entry', () => {
    const registry = new TaskRegistry({ baseDir: tempDir });
    const runRoot = join(tempDir, 'runs');
    const runId = 'terminal-run';
    const runPath = join(runRoot, runId);
    mkdirSync(runPath, { recursive: true });
    const task = registry.create({
      projectDir: tempDir,
      name: 'stale task',
      run_id: runId,
      status: 'running',
    });
    writeFileSync(join(runPath, 'run.json'), JSON.stringify({
      runId,
      status: 'complete',
      completedAt: '2026-08-06T20:00:00.000Z',
      verdict: 'PASS',
      failureReason: 'retained diagnostic',
      terminalArtifact: 'escalation_note.md',
      terminalStates: {
        complete: { paths: ['docs/parity_verification.md'] },
        escalated: { paths: ['docs/front_end_parity/escalation_note.md'] },
      },
    }), 'utf-8');

    const merged = mergeTaskWithRunState(task, runRoot);

    expect(merged).toMatchObject({
      id: task.id,
      status: 'complete',
      completed_at: '2026-08-06T20:00:00.000Z',
      run_verdict: 'PASS',
      failure_reason: 'retained diagnostic',
      terminal_status_mismatch: {
        lifecycle_status: 'complete',
        terminal_status: 'escalated',
        terminal_artifact: 'escalation_note.md',
      },
    });
    expect(merged.operational?.drift?.rows).toHaveLength(6);
    expect(merged.operational?.drift?.rows.map((row) => row.id)).toEqual([
      'research_dose',
      'first_plan_admission',
      'supervisor_rejections',
      'engine_overhead',
      'registry_growth',
      'log_growth',
    ]);
    expect(registry.get(task.id)).toMatchObject({ status: 'running' });
    expect(registry.get(task.id)?.completed_at).toBeUndefined();
  });

  it('projects a fresh terminal artifact mismatch while preserving a running lifecycle', () => {
    const registry = new TaskRegistry({ baseDir: tempDir });
    const runRoot = join(tempDir, 'runs');
    const runId = 'settled-running-run';
    const runPath = join(runRoot, runId);
    const projectDir = join(tempDir, 'project');
    mkdirSync(join(runPath), { recursive: true });
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    writeFileSync(join(projectDir, 'docs', 'final_verification.md'), '# verified\n', 'utf-8');
    const task = registry.create({
      projectDir,
      name: 'settled but stale lifecycle',
      run_id: runId,
      status: 'running',
    });
    writeFileSync(join(runPath, 'run.json'), JSON.stringify({
      runId,
      projectDir,
      status: 'running',
      startedAt: '2000-01-01T00:00:00.000Z',
      stages: {
        implementation: { status: 'complete' },
        verification: { status: 'complete' },
      },
      terminalStates: {
        complete: { paths: ['docs/final_verification.md'] },
        escalated: { paths: ['docs/escalation_note.md'] },
      },
    }), 'utf-8');

    const merged = mergeTaskWithRunState(task, runRoot);

    expect(merged).toMatchObject({
      id: task.id,
      status: 'running',
      terminal_status_mismatch: {
        lifecycle_status: 'running',
        terminal_status: 'complete',
        terminal_artifact: 'final_verification.md',
      },
    });
    expect(merged.completed_at).toBeUndefined();
    expect(registry.get(task.id)).toMatchObject({ status: 'running' });
  });

  async function listenSilently(socketPath: string): Promise<void> {
    const sockets = new Set<Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => { /* deliberately never reply */ });
    });
    await listen(server, socketPath);
    trackedServers.push({ server, sockets });
  }

  async function listenWithStatus(socketPath: string, response: DaemonStatusRpcResponse): Promise<void> {
    const server = await startRpcServer(socketPath, (request): RpcResponse => (
      request.cmd === 'status' ? response : { error: 'unexpected request' }
    ));
    trackedServers.push({ server, sockets: new Set() });
  }
});

function createDist(baseDir: string, content: string): string {
  const distDir = join(baseDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'runtime.js'), `export const build = ${JSON.stringify(content)};\n`, 'utf-8');
  return distDir;
}

function seedRegistry(baseDir: string): number {
  const raw = [
    { id: 1, status: 'pending' },
    { id: 1, status: 'running' },
    { id: 2, status: 'done' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(join(baseDir, 'tasks.jsonl'), raw, 'utf-8');
  return Buffer.byteLength(raw);
}

function statusResponse(identity: DaemonIdentity): DaemonStatusRpcResponse {
  return {
    uptime: 42,
    watched_tasks: 1,
    registry_unreadable_records: 0,
    pid: identity.pid,
    startedAt: identity.startedAt,
    socketPath: identity.socketPath,
    build: identity.build.hash,
    buildFiles: identity.build.files,
    buildNewestMtimeMs: identity.build.newestMtimeMs,
  };
}

function shortRpc(socketPath: string, request: Parameters<DaemonProcessControls['sendRpc']>[1]): Promise<RpcResponse> {
  return sendRpc(socketPath, request, 100);
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

class Capture {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];

  constructor() {
    this.stdout.on('data', (chunk) => this.stdoutChunks.push(Buffer.from(chunk)));
    this.stderr.on('data', (chunk) => this.stderrChunks.push(Buffer.from(chunk)));
  }

  output(): string {
    return Buffer.concat(this.stdoutChunks).toString('utf-8');
  }

  error(): string {
    return Buffer.concat(this.stderrChunks).toString('utf-8');
  }
}
