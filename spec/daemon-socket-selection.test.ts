import './test-support/policy-runtime.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { cmdTask } from '../src/cli-task.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { recordRequest } from './test-support/legacy-approvals.js';
import { startRpcServer, type RpcRequest } from '../src/orchestrator-rpc.js';
import { fcGlobalDir, readRunState, setFcGlobalDir, writeRunState } from '../src/store.js';
import { createRun } from './test-support/create-run.js';

let root: string;
let previousStore: string;
const servers: Server[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-socket-'));
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'fc'));
  mkdirSync(fcGlobalDir());
});
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs();
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

it('routes task commands to FC_HOME despite an inherited socket', async () => {
  const received: RpcRequest[] = [];
  const inherited: RpcRequest[] = [];
  servers.push(await startRpcServer(join(fcGlobalDir(), 'daemon.sock'), request => {
    received.push(request);
    return request.cmd === 'register' ? { id: 1, unit: 'fixture.service', acknowledgement: 'persisted' } : { tasks: [] };
  }));
  const otherSocket = join(root, 'inherited.sock');
  servers.push(await startRpcServer(otherSocket, request => { inherited.push(request); return { tasks: [] }; }));
  vi.stubEnv('FLOWCREW_DAEMON_SOCKET', otherSocket);
  const output = new PassThrough();
  expect(await cmdTask(['task', 'list'], { stdout: output, stderr: output })).toBe(0);
  expect(received.map(request => request.cmd)).toEqual(['list']);
  expect(inherited).toEqual([]);
});

it('honours an explicit --socket pointing to a different private endpoint', async () => {
  const received: RpcRequest[] = [];
  const otherSocket = join(root, 'explicit.sock');
  servers.push(await startRpcServer(join(fcGlobalDir(), 'daemon.sock'), () => { throw new Error('wrong endpoint'); }));
  servers.push(await startRpcServer(otherSocket, request => { received.push(request); return { tasks: [] }; }));
  vi.stubEnv('FLOWCREW_DAEMON_SOCKET', join(root, 'unavailable.sock'));
  const output = new PassThrough();
  expect(await cmdTask(['task', 'list', '--socket', otherSocket], { stdout: output, stderr: output })).toBe(0);
  expect(received).toEqual([{ cmd: 'list', filter: { status: 'active' } }]);
});
