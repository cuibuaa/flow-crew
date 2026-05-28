import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import type { Server } from 'node:net';
import type { TaskCreateInput, TaskEntry, TaskListFilter } from './task-registry.js';

export class DaemonUnavailableError extends Error {
  constructor(message = 'daemon not running. Start with: flowcrew daemon start') {
    super(message);
    this.name = 'DaemonUnavailableError';
  }
}

export type RpcRequest =
  | { cmd: 'register'; task: TaskCreateInput }
  | { cmd: 'list'; filter?: TaskListFilter }
  | { cmd: 'show'; id: number }
  | { cmd: 'cancel'; id: number }
  | { cmd: 'retry'; id: number }
  | { cmd: 'tail'; id: number; lines?: number; follow?: boolean }
  | { cmd: 'status' }
  | { cmd: 'stop' };

export type RpcResponse =
  | { id: number; unit: string }
  | { tasks: TaskEntry[] }
  | { task: TaskEntry; recent_ticks: string[] }
  | { ok: true }
  | { new_attempt: number; unit: string }
  | { output: string }
  | { uptime: number; watched_tasks: number }
  | { error: string };

export function defaultSocketPath(): string {
  return join(homedir(), '.fc', 'daemon.sock');
}

export async function sendRpc<T extends RpcResponse = RpcResponse>(socketPath: string, request: RpcRequest, timeoutMs = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let raw = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new DaemonUnavailableError());
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(JSON.stringify(request));
    });
    socket.on('data', (chunk) => { raw += chunk.toString('utf-8'); });
    socket.on('error', () => {
      clearTimeout(timer);
      reject(new DaemonUnavailableError());
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(raw) as T;
        if ('error' in parsed) reject(new Error(parsed.error));
        else resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
  });
}

export async function startRpcServer(socketPath: string, handler: (request: RpcRequest) => Promise<RpcResponse> | RpcResponse): Promise<Server> {
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) {
    const live = await probeSocket(socketPath);
    if (live) throw new Error(`daemon socket already active: ${socketPath}`);
    rmSync(socketPath, { force: true });
  }

  const server = net.createServer((socket) => {
    let raw = '';
    let handled = false;
    socket.on('data', (chunk) => { raw += chunk.toString('utf-8'); });
    socket.on('data', async () => {
      if (handled) return;
      try {
        const req = JSON.parse(raw) as RpcRequest;
        handled = true;
        const res = await handler(req);
        socket.end(JSON.stringify(res));
      } catch (err) {
        if (err instanceof SyntaxError) return;
        socket.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

async function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
