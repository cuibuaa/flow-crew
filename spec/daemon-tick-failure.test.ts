import './test-support/policy-runtime.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { cmdDaemon } from '../src/cli-daemon.js';
import { sendRpc } from '../src/orchestrator-rpc.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, child: ChildProcess, diagnostics: () => string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      throw new Error(`daemon did not reach checkpoint: ${diagnostics()}`);
    }
    await delay(20);
  }
}

it.each(['startup', 'interval', 'response'])(
  'survives a real registry lock timeout from the %s tick and runs the next tick', async source => {
    const root = mkdtempSync(join(tmpdir(), 'fc-tick-'));
    const home = join(root, 'fc');
    const dist = join(root, 'dist');
    const socket = join(home, 'daemon.sock');
    const arm = join(root, 'arm');
    const failed = join(root, 'failed');
    const succeeded = join(root, 'succeeded');
    const runner = join(root, 'serve.mjs');
    mkdirSync(home); mkdirSync(dist);
    writeFileSync(join(dist, 'runtime.js'), 'export const fixture = true;\n');
    if (source === 'startup') writeFileSync(arm, 'arm');
    // Exercise the real daemon entry points and real five-second lock timeout.
    // Only shorten the producer interval; the filesystem and failure stay real.
    writeFileSync(runner, `
import fs from 'node:fs';
const interval = globalThis.setInterval;
globalThis.setInterval = (callback, ms, ...args) => interval(callback, ${source === 'response' ? 'ms' : '100'}, ...args);
const { Orchestrator } = await import(${JSON.stringify(pathToFileURL(resolve('src/orchestrator.ts')).href)});
const tick = Orchestrator.prototype.tickOnce;
Orchestrator.prototype.tickOnce = function() {
  if (fs.existsSync(${JSON.stringify(arm)})) {
    fs.rmSync(${JSON.stringify(arm)});
    const lock = ${JSON.stringify(join(home, 'tasks.lock'))};
    fs.writeFileSync(lock, '');
    return tick.call(this).finally(() => {
      fs.rmSync(lock, { force: true });
      fs.writeFileSync(${JSON.stringify(failed)}, 'failed');
    });
  }
  return tick.call(this).then(() => fs.writeFileSync(${JSON.stringify(succeeded)}, 'succeeded'));
};
const { cmdDaemon } = await import(${JSON.stringify(pathToFileURL(resolve('src/cli-daemon.ts')).href)});
process.exitCode = await cmdDaemon(['daemon', 'serve', '--socket', ${JSON.stringify(socket)}], { distDir: ${JSON.stringify(dist)} });
`);
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), runner], {
      cwd: root,
      env: { ...process.env, HOME: process.env.HOME, FC_HOME: home, FLOWCREW_DAEMON_SOCKET: socket },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
    try {
      await waitFor(() => existsSync(socket), child, () => errors);
      if (source !== 'startup') {
        await waitFor(() => existsSync(succeeded), child, () => errors);
        rmSync(succeeded);
        writeFileSync(arm, 'arm');
        if (source === 'response') await sendRpc(socket, { cmd: 'hold' });
      }
      await waitFor(() => existsSync(failed) && errors.includes('Timed out after 5000ms'), child, () => errors);
      let output = '';
      const stream = { write: (chunk: string) => { output += String(chunk); return true; } };
      expect(await cmdDaemon(['daemon', 'status', '--socket', socket], {
        distDir: dist, stdout: stream as never, stderr: stream as never,
      }), output).toBe(0);
      expect(output).toContain('FRESH:');
      if (source === 'response') await sendRpc(socket, { cmd: 'hold' });
      await waitFor(() => existsSync(succeeded), child, () => errors);
      expect(readFileSync(succeeded, 'utf8')).toBe('succeeded');
      expect(errors).toContain('daemon tick failed:');
      expect(errors).toContain('owner metadata is unreadable');
      expect(errors).toContain('TaskRegistry.health');
      await sendRpc(socket, { cmd: 'stop' });
      await closed;
      expect(child.exitCode, errors).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
