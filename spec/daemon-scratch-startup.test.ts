import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdDaemon } from '../src/cli-daemon.js';
import { sweepRunScratch } from '../src/invocation-scratch.js';
import { Orchestrator } from '../src/orchestrator.js';
import { sendRpc } from '../src/orchestrator-rpc.js';
import { fcGlobalDir, runsRoot, setFcGlobalDir } from '../src/store.js';

const startup = vi.hoisted(() => ({ servers: [] as Server[] }));

vi.mock('../src/invocation-scratch.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/invocation-scratch.js')>(),
  sweepRunScratch: vi.fn(),
}));

vi.mock('../src/orchestrator-rpc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orchestrator-rpc.js')>();
  return {
    ...actual,
    startRpcServer: async (...args: Parameters<typeof actual.startRpcServer>) => {
      const server = await actual.startRpcServer(...args);
      startup.servers.push(server);
      return server;
    },
  };
});

let root: string;
let previousFcDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-dss-'));
  previousFcDir = fcGlobalDir();
  setFcGlobalDir(root);
  startup.servers.length = 0;
  // This case owns only startup and RPC transport, without a scheduler tick.
  vi.spyOn(Orchestrator.prototype, 'start').mockImplementation(() => {});
});

afterEach(async () => {
  for (const server of startup.servers) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  setFcGlobalDir(previousFcDir);
  rmSync(root, { recursive: true, force: true });
});

it('binds the status socket then sweeps aliases before starting the orchestrator', async () => {
  const socketPath = join(root, 'daemon.sock');
  const distDir = join(root, 'dist');
  mkdirSync(distDir);
  writeFileSync(join(distDir, 'runtime.js'), 'export const fixture = true;\n');
  const actual = await vi.importActual<typeof import('../src/invocation-scratch.js')>('../src/invocation-scratch.js');
  let boundAtSweep = false;
  let startedAtSweep = false;
  vi.mocked(sweepRunScratch).mockImplementation((runRoot, warn) => {
    boundAtSweep = startup.servers.some((server) => server.listening);
    startedAtSweep = vi.mocked(Orchestrator.prototype.start).mock.calls.length > 0;
    actual.sweepRunScratch(runRoot, warn);
  });
  let errorOutput = '';
  const serving = cmdDaemon(['daemon', 'serve', '--socket', socketPath], {
    distDir,
    stderr: { write: (chunk: string) => { errorOutput += chunk; return true; } } as NodeJS.WriteStream,
  });
  expect(await serving, errorOutput).toBe(0);
  expect(sweepRunScratch).toHaveBeenCalledOnce();
  expect(sweepRunScratch).toHaveBeenCalledWith(runsRoot(), expect.any(Function));
  expect(boundAtSweep, 'alias repair must start after socket binding').toBe(true);
  expect(startedAtSweep, 'alias repair must finish before the orchestrator can activate runs').toBe(false);
  expect(Orchestrator.prototype.start).toHaveBeenCalledOnce();
  const response = await sendRpc(socketPath, { cmd: 'status' });
  expect(response).toMatchObject({ pid: process.pid, socketPath, watched_tasks: 0 });
});
