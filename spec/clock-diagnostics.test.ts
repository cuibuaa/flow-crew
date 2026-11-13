import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { commandSucceeds, detectSupervisorBackend } from '../src/cli-doctor.js';
import { claudeWakeCapability } from '../src/session-wake.js';
import { cmdDashboard, requestDashboardStatus } from '../src/cli-dashboard.js';

const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: commands.run }));
vi.mock('node:http', async original => ({ ...await original<typeof import('node:http')>(), get: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const day = 86_400_000;

function completedCommand(delay: number, failure = false) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  commands.run.mockImplementation((_command, _args, options) => {
    // Model the native command's timeout contract at the actual subprocess boundary.
    const timeout = (options as { timeout?: number } | undefined)?.timeout;
    vi.advanceTimersByTime(delay);
    if (timeout && delay >= timeout) throw Object.assign(new Error('command stopped'), { status: null, signal: 'SIGTERM' });
    if (failure) throw Object.assign(new Error('command exited'), { status: 17, signal: null });
    return '2.1.308\n';
  });
}

describe('diagnostic commands use completed observations', () => {
  it.each([0, day])('P03 tool/auth and version results agree after %s virtual ms', delay => {
    completedCommand(delay);
    expect(commandSucceeds('fixture', ['auth'])).toBe(true);
    expect(claudeWakeCapability()).toMatchObject({ supported: true, detail: 'Claude 2.1.308; wake requires >= 2.1.308' });
  });
  it('P03 completed command failures still report unavailable', () => {
    completedCommand(0, true);
    expect(commandSucceeds('fixture', ['auth'])).toBe(false);
    expect(claudeWakeCapability()).toMatchObject({ supported: false });
  });
  it.each([0, day])('P04 user manager capability agrees after %s virtual ms', delay => {
    completedCommand(delay);
    expect(detectSupervisorBackend({ findCommand: command => `/fixture/${command}` }).kind).toBe('systemd-user');
  });
  it('P04 completed manager error still selects the portable diagnostic', () => {
    completedCommand(0, true);
    expect(detectSupervisorBackend({ findCommand: command => `/fixture/${command}` }).kind).toBe('portable-shim');
  });
});

function httpPeer() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let receive: (res: typeof response) => void = () => {};
  const request = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
  const response = Object.assign(new EventEmitter(), { statusCode: 200, complete: false, setEncoding: vi.fn() });
  vi.mocked(http.get).mockImplementation((_url, _options, listener) => {
    receive = listener as typeof receive;
    const signal = (_options as { signal?: AbortSignal }).signal;
    signal?.addEventListener('abort', () => request.emit('error', new Error('fixture observation aborted')), { once: true });
    return request as unknown as http.ClientRequest;
  });
  // If the production fetch hunk is restored, model its abort signal without
  // connecting to any service. The same peer controls the completed response.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(delay => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), delay);
    return controller.signal;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((resolve, reject) => {
    let text = '';
    options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    response.on('data', chunk => { text += chunk; });
    response.on('end', () => resolve(new Response(text, { status: response.statusCode })));
  }));
  return { request, response, headers: () => receive(response), finish: (text: string) => {
    response.emit('data', text); response.complete = true; response.emit('end'); response.emit('close'); request.emit('close');
  } };
}
const identity = { pid: 123, startedAt: 'fixture', freshness: 'fresh', loadedBuild: { hash: 'same' }, diskBuild: { hash: 'same' } };

describe('U01 HTTP identity waits for response completion', () => {
  it.each([0, day])('status has the same successful result after %s virtual ms before headers and body', async delay => {
    const peer = httpPeer(); let output = '', finished = false;
    const pending = cmdDashboard(['dashboard', 'status'], { stdout: { write: text => { output += text; } } });
    void pending.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(delay);
    expect(finished).toBe(false);
    peer.headers(); peer.response.emit('data', '{"pid":');
    await vi.advanceTimersByTimeAsync(delay);
    expect(finished).toBe(false); expect(peer.request.setTimeout).not.toHaveBeenCalled();
    peer.finish(JSON.stringify(identity).slice('{"pid":'.length));
    expect(await pending).toBe(0); expect(output).toContain('FRESH:');
  });
  it('explicit dashboard allowance expires as unfinished and launches no second request', async () => {
    const peer = httpPeer(); let output = '';
    const pending = cmdDashboard(['dashboard', 'status'], { timeoutMs: 100, stdout: { write: text => { output += text; } } });
    peer.headers(); peer.response.emit('data', '{');
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(5); expect(output).toContain('UNFINISHED:');
    expect(http.get).toHaveBeenCalledOnce();
  });
  it.each(['request-error', 'request-close', 'response-error', 'response-close'] as const)('completed %s is still caught', async event => {
    const peer = httpPeer();
    const pending = requestDashboardStatus('http://127.0.0.1:3000/api/dashboard/status');
    const rejected = expect(pending).rejects.toThrow();
    if (event.startsWith('response')) peer.headers();
    if (event === 'request-error') peer.request.emit('error', new Error('fixture transport error'));
    if (event === 'request-close') peer.request.emit('close');
    if (event === 'response-error') peer.response.emit('error', new Error('fixture response error'));
    if (event === 'response-close') peer.response.emit('close');
    await rejected;
  });
  it.each([503, 'invalid-json', 'incomplete-identity'] as const)('completed %s remains unverified', async outcome => {
    const peer = httpPeer(); let output = '';
    const pending = cmdDashboard(['dashboard', 'status'], { stdout: { write: text => { output += text; } } });
    peer.response.statusCode = typeof outcome === 'number' ? outcome : 200;
    peer.headers(); peer.finish(outcome === 'invalid-json' ? '{' : '{}');
    expect(await pending).toBe(2); expect(output).toContain('UNVERIFIED:');
  });
});
