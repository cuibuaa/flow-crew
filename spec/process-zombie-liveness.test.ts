import { expect, it, vi } from 'vitest';
vi.hoisted(() => vi.resetModules());
const processObservation = vi.hoisted(() => ({ state: 'S', unreadable: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
    if (String(path) === '/proc/31337/stat') {
      if (processObservation.unreadable) throw Object.assign(new Error('unobservable process'), { code: 'EACCES' });
      return `31337 (fixture controller) ${processObservation.state} 1 31337 31337 0 0`;
    }
    return Reflect.apply(actual.readFileSync, undefined, [path, ...args]);
  } };
});
import { processIsAlive } from '../src/process-liveness.js';

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
