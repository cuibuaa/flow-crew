import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { connect } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from '../src/dashboard.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const plugin = vi.hoisted(() => ({ enter: () => {}, wait: Promise.resolve(), fail: false }));
vi.mock('@fastify/static', () => ({ default: async () => {
  plugin.enter(); await plugin.wait;
  if (plugin.fail) throw new Error('fixture plugin rejected');
} }));
let app: FastifyInstance | undefined, root: string | undefined;
afterEach(async () => { vi.useRealTimers(); await app?.close(); app = undefined; if (root) rmSync(root, { recursive: true, force: true }); });

describe('U02 production HTTP listeners wait for protocol and plugin events', () => {
  it.each([0, 86_400_000])('plugin startup succeeds after %s virtual ms and listeners carry no elapsed limits', async delay => {
    root = mkdtempSync(join(tmpdir(), 'http-clock-'));
    const entered = deferred(), release = deferred();
    plugin.enter = entered.resolve; plugin.wait = release.promise; plugin.fail = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let settled = false;
    const pending = startDashboard(root, 0);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(delay);
      expect(settled).toBe(false);
    } finally { release.resolve(); }
    app = await pending;
    expect(app.initialConfig.pluginTimeout).toBe(0);
    expect(app.server.headersTimeout).toBe(0);
    expect(app.server.requestTimeout).toBe(0);
    expect(app.server.keepAliveTimeout).toBe(0);
    expect(app.server.timeout).toBe(0);
    expect((await app.inject('/api/dashboard/status')).statusCode).toBe(200);
  });
  it.each([0, 86_400_000])('incomplete headers wait %s virtual ms, then the completed request succeeds', async delay => {
    root = mkdtempSync(join(tmpdir(), 'http-clock-'));
    plugin.enter = () => {}; plugin.wait = Promise.resolve(); plugin.fail = false;
    app = await startDashboard(root, 0);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('fixture listener missing');
    const headerReceived = new Promise<void>(resolve => app!.server.once('connection', socket => socket.once('data', () => resolve())));
    const socket = connect(address.port, '127.0.0.1');
    const closed = once(socket, 'close');
    let response = '';
    socket.setEncoding('utf8'); socket.on('data', text => { response += text; });
    try {
      await once(socket, 'connect');
      socket.write('GET /api/dashboard/status HTTP/1.1\r\nHost: fixture');
      await headerReceived;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      await vi.advanceTimersByTimeAsync(delay);
      expect(response).toBe(''); expect(socket.destroyed).toBe(false);
      expect(app.server.headersTimeout).toBe(0);
      socket.write('\r\nConnection: close\r\n\r\n');
      await closed;
      expect(response).toContain('HTTP/1.1 200 OK');
      expect(response).toContain('"freshness":');
    } finally { socket.destroy(); await closed; }
  });
  it('completed malformed headers still produce a protocol rejection', async () => {
    root = mkdtempSync(join(tmpdir(), 'http-clock-'));
    plugin.enter = () => {}; plugin.wait = Promise.resolve(); plugin.fail = false;
    app = await startDashboard(root, 0);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('fixture listener missing');
    const socket = connect(address.port, '127.0.0.1'), closed = once(socket, 'close');
    let response = '';
    socket.setEncoding('utf8'); socket.on('data', text => { response += text; });
    try {
      await once(socket, 'connect');
      socket.write('GET / HTTP/1.1\r\ninvalid header\r\n\r\n');
      await closed;
      expect(response).toContain('HTTP/1.1 400 Bad Request');
    } finally { socket.destroy(); await closed; }
  });
  it('completed plugin rejection is still reported without a second listener', async () => {
    root = mkdtempSync(join(tmpdir(), 'http-clock-'));
    plugin.enter = () => {}; plugin.wait = Promise.resolve(); plugin.fail = true;
    await expect(startDashboard(root, 0)).rejects.toThrow('fixture plugin rejected');
  });
});
