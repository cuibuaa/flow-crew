import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

// Authored child/identity observations exercise the real native worker entry.
vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(), readFile: vi.fn(),
}));
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawn: vi.fn(),
}));
afterEach(() => { vi.unstubAllGlobals(); });

it('exec reports native identity failure while the child is alive through the recorded result protocol', async () => {
  vi.resetModules();
  const bus = new EventEmitter(), child = Object.assign(new EventEmitter(), {
    pid: 43, exitCode: null, signalCode: null,
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const fields = Array<string>(20).fill('0'); fields[2] = '42'; fields[19] = 'birth';
  vi.mocked(readFile).mockResolvedValueOnce('42 (fixture) ' + fields.join(' ')).mockResolvedValueOnce('boot')
    .mockRejectedValueOnce(Object.assign(Error('Identity observation denied'), { code: 'EACCES' }));
  const send = vi.fn(), chdir = vi.fn();
  vi.stubGlobal('process', Object.create(process, {
    platform: { value: 'linux' }, pid: { value: 42 }, argv: { value: ['node', 'process.js', '--operation'] },
    connected: { value: true }, send: { value: send }, chdir: { value: chdir },
    once: { value: bus.once.bind(bus) }, on: { value: bus.on.bind(bus) },
    removeListener: { value: bus.removeListener.bind(bus) },
  }));
  await import('../../dist-rewrite/host/process.js');
  expect(send.mock.calls[0][0]).toMatchObject({ pid: 42, start: 'birth' });
  // Invoke the real exec entry handler. No exit has occurred; it must already
  // consume and report the registration rejection, rather than wait for exit.
  await bus.listeners('message')[0]({ exec: { argv: ['synthetic-child'], env: {}, cwd: '/workspace' } });
  expect(spawn).toHaveBeenCalledWith('synthetic-child', [], { cwd: '/workspace', env: {}, stdio: 'inherit' });
  expect(child.exitCode).toBeNull();
  expect(send.mock.calls.at(-1)?.[0]).toEqual({ result: { ok: false, kind: 'unknown',
    detail: 'Error: Identity observation denied' } });
});
