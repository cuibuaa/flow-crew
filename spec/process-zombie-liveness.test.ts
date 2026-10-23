import { expect, it, vi } from 'vitest';
vi.hoisted(() => vi.resetModules());
const processObservation = vi.hoisted(() => ({ state: 'S', unreadable: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
    if (String(path) === '/proc/31337/stat') {
      if (processObservation.unreadable) throw Object.assign(new Error('unobservable process'), { code: 'EACCES' });
      return `31337 (fixture controller) ${processObservation.state} ${Array(18).fill('0').join(' ')} 4242 0 0`;
    }
    return Reflect.apply(actual.readFileSync, undefined, [path, ...args]);
  } };
});
import { processIsAlive, processLiveness } from '../src/process-liveness.js';

it.skipIf(process.platform !== 'linux').each(['Z', 'X'])('treats observed Linux state %s as no remaining execution', state => {
  processObservation.state = state; processObservation.unreadable = false;
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  expect(processIsAlive(31337)).toBe(false);
});

it.skipIf(process.platform !== 'linux')('keeps an inaccessible process live when signal-zero has not proved death', () => {
  processObservation.unreadable = true;
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  expect(processIsAlive(31337)).toBe(true);
});

it.each(['EPERM', 'EIO'])('reports %s as unknown without granting death evidence', code => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('probe unavailable'), { code }); });
  expect(processLiveness(31337)).toBe('unknown');
});

it.skipIf(process.platform !== 'linux').each(['allowed', 'EPERM'])(
  'compares recorded start tokens for an existing pid with signal probe %s', probe => {
    processObservation.state = 'S'; processObservation.unreadable = false;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (probe === 'EPERM') throw Object.assign(new Error('other user process'), { code: 'EPERM' });
      return true;
    });
    expect(processLiveness(31337, { kind: 'linux', value: '4242' })).toBe('alive');
    expect(processLiveness(31337, { kind: 'linux', value: '4241' })).toBe('dead');
    expect(processLiveness(31337, { kind: 'linux', value: 'malformed' })).toBe('unknown');
  },
);

it.skipIf(process.platform !== 'linux').each(['EPERM', 'EIO'])(
  'keeps a recorded owner unknown when the %s probe cannot verify its start token', code => {
    processObservation.state = 'S'; processObservation.unreadable = true;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('unavailable observation'), { code });
    });
    expect(processLiveness(31337, { kind: 'linux', value: '4241' })).toBe('unknown');
  },
);
