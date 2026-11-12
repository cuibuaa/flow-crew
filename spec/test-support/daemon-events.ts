import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { onTestFinished } from 'vitest';
import { sendRpc, type RpcRequest, type RpcResponse } from '../../src/orchestrator-rpc.js';

export { waitForPathEvent as daemonPublication } from './wait-for-path-event.js';
import { waitForPathEvent as daemonPublication } from './wait-for-path-event.js';

/** Subscribe to each missing parent before watching the final publication.
 * Avoid recursive watches over the daemon's changing pinned runtime tree. */
export async function daemonFile<T>(path: string, observe: () => T | undefined): Promise<T> {
  const parent = dirname(path);
  if (!existsSync(parent)) await daemonFile(parent, () => existsSync(parent) ? true : undefined);
  return daemonPublication(parent, observe);
}

/** The production client waits on the connection; no fixture clock is needed. */
export function daemonRpc<T extends RpcResponse = RpcResponse>(socket: string, request: RpcRequest): Promise<T> {
  return sendRpc<T>(socket, request);
}

export function daemonClosed(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
}

/** Wait for close (including drained output), with runner-owned hang protection.
 * The caller starts the isolated probe; this only collects its result. */
export async function daemonCommand(child: ChildProcess) {
  child.stdin?.end();
  let stdout = '', stderr = '';
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await daemonClosed(child);
  return { status: child.exitCode, signal: child.signalCode, stdout, stderr };
}
