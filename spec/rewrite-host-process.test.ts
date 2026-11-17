import { readFile, readdir } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { closeOperation, endOperation, DRAIN_BACKSTOP_MS } from '../dist-rewrite/host/process.js';

vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(), readFile: vi.fn(), readdir: vi.fn(),
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('observes live drainage until ESRCH', async () => {
  // Authored kernel observations: no worker, real process identity or host read.
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot', authority: 'recorded' };
  const fields = Array<string>(20).fill('0'); fields[2] = '42'; fields[19] = 'birth';
  const stat = '42 (fixture) ' + fields.join(' ');
  vi.mocked(readFile).mockResolvedValueOnce(stat).mockResolvedValueOnce('boot')
    .mockResolvedValueOnce(stat).mockResolvedValueOnce('boot');
  const kill = vi.fn().mockReturnValue(true);
  vi.stubGlobal('process', Object.create(process, {
    platform: { value: 'linux' }, kill: { value: kill },
  }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Initial live probe, authenticated signal, four live polls, then empty group.
  kill.mockReturnValueOnce(true).mockReturnValueOnce(true);
  for (let poll = 0; poll < 4; poll++) kill.mockReturnValueOnce(true);
  kill.mockImplementationOnce(() => { throw Object.assign(Error('Empty group'), { code: 'ESRCH' }); });
  const closing = closeOperation(owner);
  await vi.runAllTimersAsync();
  expect(await closing).toEqual({ ok: true, value: 'dead' });
  expect(kill.mock.calls).toEqual([[-42, 0], [-42, 'SIGKILL'],
    [-42, 0], [-42, 0], [-42, 0], [-42, 0], [-42, 0]]);


});

it('one closure owner waits through unavailable post-signal observations for ESRCH', async () => {
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot', authority: 'recorded' };
  const fields = Array<string>(20).fill('0'); fields[2] = '42'; fields[19] = 'birth';
  vi.mocked(readFile).mockResolvedValueOnce('42 (fixture) ' + fields.join(' ')).mockResolvedValueOnce('boot');
  const unavailable = () => { throw Object.assign(Error('Unavailable'), { code: 'EPERM' }); };
  const empty = () => { throw Object.assign(Error('Empty'), { code: 'ESRCH' }); };
  const kill = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true)
    .mockImplementationOnce(unavailable).mockReturnValueOnce(true).mockImplementationOnce(empty);
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' }, kill: { value: kill } }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const closing = endOperation(owner);
  await vi.runAllTimersAsync();
  expect(await closing).toEqual({ ok: true, value: 'dead' });
  expect(kill.mock.calls).toEqual([[-42, 0], [-42, 'SIGKILL'], [-42, 0], [-42, 0], [-42, 0]]);
  // EPERM before authentication never authorizes a signal or retirement.
  vi.mocked(readdir).mockResolvedValue([]);
  kill.mockImplementation(unavailable);
  expect(await endOperation(owner)).toMatchObject({ ok: false, kind: 'unknown' });
  expect(kill.mock.calls.slice(5)).toEqual([[-42, 0]]);
});

it('persistent EPERM after authenticated SIGKILL returns typed unconfirmed closure at the one backstop', async () => {
  const owner = { pid: 42, group: 42, start: 'birth', boot: 'boot', authority: 'recorded' };
  const fields = Array<string>(20).fill('0'); fields[2] = '42'; fields[19] = 'birth';
  vi.mocked(readFile).mockResolvedValueOnce('42 (fixture) ' + fields.join(' ')).mockResolvedValueOnce('boot');
  const kill = vi.fn().mockImplementation(() => { throw Object.assign(Error('Unavailable'), { code: 'EPERM' }); })
    .mockReturnValueOnce(true).mockReturnValueOnce(true);
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' }, kill: { value: kill } }));
  const zombieFields = [...fields]; zombieFields[0] = 'Z'; zombieFields[1] = '1';
  vi.mocked(readFile).mockResolvedValue('42 (fixture) ' + zombieFields.join(' '));
  vi.mocked(readdir).mockResolvedValue(['42'] as any);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const closing = closeOperation(owner);
  await vi.advanceTimersByTimeAsync(DRAIN_BACKSTOP_MS + 10);
  const result = await closing;
  expect(result).toMatchObject({ ok: false, kind: 'unknown', closure: { state: 'not_confirmed_closed',
    owner, observation: 'unknown', members: [{ pid: 42, state: 'Z', parent: 1 }] } });
  expect(result.ok ? '' : result.detail).toContain('The recorded group still holds an unreaped process, which happens when PID 1 does not reap orphans');
  expect(result.ok ? '' : result.detail).toContain('Check process ownership, permissions and the parent reaper; then repeat cancel for a cancelled run, or resume an uncancelled parked run, to retry closure.');
  expect(kill.mock.calls.filter(call => call[1] === 'SIGKILL')).toEqual([[-42, 'SIGKILL']]);
});
