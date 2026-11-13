import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorSessionIntegration } from '../src/session-integration.js';

const host = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:child_process', () => host);
const packageRoot = join(import.meta.dirname, '..');
let root: string;
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let output: string;
let native: EventEmitter & { pid: number; stdin: Writable; stdout: PassThrough; stderr: PassThrough };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'fc-verification-'));
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((text: any) => { output += String(text); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((text: any) => { output += String(text); return true; });
  vi.stubEnv('HOME', root);
  vi.stubEnv('FC_HOME', join(root, 'fc'));
  vi.stubEnv('CODEX_HOME', join(root, '.codex'));
  vi.stubEnv('FLOWCREW_CODEX_VERIFY_TIMEOUT_MS', undefined);
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

// The child and all observation time are owned by the fixture. No real agent runs.
function nativeHost(delay: number, negative?: 'response' | 'close' | 'error') {
  const command = 'fixture hook';
  const hash = 'sha256:' + 'a'.repeat(64);
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks.json'), '{}');
  writeFileSync(join(root, 'hooks/flowcrew-session.json'), JSON.stringify({ command,
    codexTrust: ['sessionStart', 'stop'].map(key => ({ key, hash })),
  }));
  native = Object.assign(new EventEmitter(), { pid: 424242, stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line);
        if (!request.id) continue;
        const respond = () => {
          if (negative === 'close') { native.emit('close', 1); return; }
          if (negative === 'error') { native.emit('error', new Error('fixture spawn rejection')); return; }
          const result = request.method === 'hooks/list' ? { data: [{ hooks: ['sessionStart', 'stop'].map(key => ({
            key, currentHash: hash, sourcePath: join(root, 'hooks.json'), eventName: key,
            command: `${command} ${key === 'stop' ? 'Stop' : 'SessionStart'}`, enabled: true, trustStatus: 'trusted',
          })) }] } : {};
          native.stdout.write(JSON.stringify({ id: request.id, ...(negative === 'response' ? { error: { code: 1 } } : { result }) }) + '\n');
        };
        // Delay only the initial observation, then finish with immediate responses.
        if (request.method === 'initialize') setTimeout(respond, delay);
        else queueMicrotask(respond);
      }
      callback();
    } }),
  });
  host.spawn.mockReturnValue(native);
  vi.spyOn(process, 'kill').mockImplementation(() => { native.emit('close', null); return true; });
  process.argv = [process.execPath, 'codex-verify.mjs', 'check', 'fixture-agent', root, '', '', root];
}
async function verify() {
  // @ts-expect-error Shipped native JavaScript has no declaration file.
  return import('../skills/codex-verify.mjs');
}
async function integrate(action = 'check', frontend = 'claude') {
  process.argv = [process.execPath, 'session-integration.mjs', action, frontend, root, packageRoot];
  // @ts-expect-error Shipped native JavaScript has no declaration file.
  await import('../skills/session-integration.mjs');
}

describe('verification observation contract', () => {
  it.each([undefined, '30000'])('slow healthy native observation verifies with allowance %s', async allowance => {
    nativeHost(25_000);
    vi.stubEnv('FLOWCREW_CODEX_VERIFY_TIMEOUT_MS', allowance);
    let settled = false;
    const pending = verify().then(() => { settled = true; });
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(20_001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(process.exitCode ?? 0).toBe(0);
    expect(output).toContain('verification verified');
    expect(process.kill).toHaveBeenCalledWith(-native.pid, 'SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['response', 'close', 'error'] as const)('a completed negative %s is unavailable', async observation => {
    nativeHost(100, observation);
    const pending = verify();
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(process.exitCode).toBe(1);
    expect(output).toContain('verification unavailable');
  });

  it('declared expiry is unfinished and retires the owned native host', async () => {
    nativeHost(25_000);
    vi.stubEnv('FLOWCREW_CODEX_VERIFY_TIMEOUT_MS', '20000');
    const pending = verify();
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(process.exitCode).toBe(5);
    expect(output).toContain('verification unfinished');
    expect(output).not.toContain('unavailable');
    expect(process.kill).toHaveBeenCalledWith(-native.pid, 'SIGKILL');
  });

  it('an operator interrupt retires the detached probe', async () => {
    nativeHost(25_000);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const pending = verify();
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalled());
    process.emit('SIGINT');
    await pending;
    expect(exit).toHaveBeenCalledWith(130);
    expect(process.kill).toHaveBeenCalledWith(-native.pid, 'SIGKILL');
  });

  it('Claude capability waits for a slow healthy observation without an invented allowance', async () => {
    await integrate('install');
    vi.resetModules();
    host.spawnSync.mockImplementation((_file, _args, options) => options.timeout && options.timeout < 25_000
      ? { status: null, error: Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }) }
      : { status: 0, stdout: 'supported' });
    await integrate();
    expect(process.exitCode).toBe(0);
    expect(output).toContain('verified:');
    expect(host.spawnSync.mock.calls[0][2].timeout).toBeUndefined();
  });

  it.each([0, 1, 5])('integration passes native result %s without outer deadlines', async status => {
    await integrate('install', 'codex');
    vi.resetModules();
    host.spawnSync.mockReturnValue({ status, stderr: status === 5 ? 'unfinished: declared allowance expired' : 'completed negative observation' });
    await integrate('check', 'codex');
    expect(process.exitCode).toBe(status);
    expect(output).toContain(`${status === 0 ? 'verified' : status === 1 ? 'unavailable' : 'unfinished'}:`);
    const [, args, options] = host.spawnSync.mock.calls[0];
    expect(args.at(-1)).toBe(root);
    expect(options.timeout).toBeUndefined();
  });

  it.each([0, 1, 5])('doctor exposes closed result for checker exit %s', status => {
    host.execFileSync.mockImplementation((_file, _args, options) => {
      // A completed healthy observation takes 25s of controlled host time.
      if (options.timeout && options.timeout < 25_000) throw { status: null };
      if (status) throw { status, stdout: status === 5 ? 'unfinished: declared allowance expired' : 'unavailable: completed negative observation' };
      return 'verified';
    });
    const result = doctorSessionIntegration('codex', root, packageRoot, process.env);
    expect(result.result).toBe(status === 0 ? 'verified' : status === 1 ? 'unavailable' : 'unfinished');
    expect(result.status).toBe(status === 0 ? 'ok' : 'warn');
    if (status === 5) expect(result.message).not.toContain('Repair:');
    expect(host.execFileSync.mock.calls[0][2].timeout).toBeUndefined();
  });

  it('a completed local negative takes precedence over unfinished native verification', async () => {
    await integrate('install', 'codex');
    writeFileSync(join(root, 'hooks.json'), '{}');
    vi.resetModules();
    host.spawnSync.mockReturnValue({ status: 5, stderr: 'unfinished: declared allowance expired' });
    await integrate('check', 'codex');
    expect(process.exitCode).toBe(1);
    expect(output).toContain('unavailable:');
  });
});
