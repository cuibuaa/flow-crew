import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { TaskRegistry } from '../src/task-registry.js';
import { createTaskEntry } from '../src/fc-tasks.js';

vi.hoisted(() => vi.resetModules());
const boundary = vi.hoisted(() => ({
  observe: undefined as (() => void) | undefined,
  procStat: undefined as string | Error | undefined,
}));
vi.mock('../src/engine-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine-fs.js')>();
  const instrument = <T extends (...args: any[]) => any>(operation: T): T => ((...args: Parameters<T>) => {
    const result = operation(...args);
    boundary.observe?.();
    return result;
  }) as T;
  return {
    ...actual,
    openSync: instrument(actual.openSync),
    mkdirSync: instrument(actual.mkdirSync),
    writeFileSync: instrument(actual.writeFileSync),
    linkSync: instrument(actual.linkSync),
    symlinkSync: instrument(actual.symlinkSync),
    unlinkSync: instrument(actual.unlinkSync),
    rmdirSync: instrument(actual.rmdirSync),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
    if (args[0] === `/proc/${process.pid}/stat` && boundary.procStat !== undefined) {
      if (boundary.procStat instanceof Error) throw boundary.procStat;
      return boundary.procStat;
    }
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-owner-publication-'));
  // comm may contain spaces and parentheses; starttime is field 22, not a
  // whitespace index from the beginning of the complete /proc record.
  boundary.procStat = `${process.pid} (owner with ) spaces) S ${Array(18).fill('0').join(' ')} 4242 0 0`;
});
afterEach(() => {
  boundary.observe = undefined;
  boundary.procStat = undefined;
  rmSync(root, { recursive: true, force: true });
});

const session = 'publication-fixture';
const entry = { id: 'work', subject: 'Work', description: '', activeForm: '', status: 'pending' as const, blocks: [], blockedBy: [] };
const ledgerPath = () => join(root, `.fc-tasks-lock-${createHash('sha256').update(session).digest('hex')}`);
const writeLedger = () => createTaskEntry({ storeRoot: root, session, entry, lockTiming: { waitMs: 0, pollMs: 1 } });
const registry = () => new TaskRegistry({ baseDir: root, lockTimeoutMs: 0, lockPollMs: 1, warn: () => {} });

describe('atomic owner publication', () => {
  it.each(['registry', 'ledger'] as const)('%s observers always see complete owners, including at creation and release', (kind) => {
    const path = kind === 'registry' ? join(root, 'tasks.lock') : ledgerPath();
    const ownerPath = kind === 'registry' ? path : join(path, 'owner');
    const incomplete: string[] = [];
    let observations = 0;
    // Observe every filesystem publication boundary, especially the point just
    // after exclusive creation where a killed legacy holder left an empty lock.
    boundary.observe = () => {
      if (!existsSync(path)) return;
      observations += 1;
      try {
        const owner = JSON.parse(readFileSync(ownerPath, 'utf-8'));
        if (owner.pid !== process.pid || owner.processStartTime !== '4242' || typeof owner.token !== 'string') incomplete.push('incomplete owner');
      } catch { incomplete.push('unreadable owner'); }
    };
    if (kind === 'registry') registry().health();
    else writeLedger();
    boundary.observe = undefined;
    expect(observations).toBeGreaterThan(0);
    expect(incomplete).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('registry immediately recovers a dead owner but keeps old live owners and young legacy locks', () => {
    const path = join(root, 'tasks.lock');
    const old = new Date(Date.now() - 60_000);
    for (const processStartTime of [undefined, '4242']) {
      writeFileSync(path, JSON.stringify({ pid: 2_147_483_647, processStartTime, acquiredAt: new Date().toISOString(), token: 'dead' }));
      expect(() => registry().health()).not.toThrow();
    }

    writeFileSync(path, JSON.stringify({ pid: process.pid, acquiredAt: old.toISOString(), token: 'live' }));
    utimesSync(path, old, old);
    expect(() => registry().health()).toThrow(/waiting for task registry lock/u);
    expect(JSON.parse(readFileSync(path, 'utf-8')).token).toBe('live');
    rmSync(path);

    for (const legacy of ['', '{"pid":']) {
      writeFileSync(path, legacy);
      expect(() => registry().health()).toThrow(/owner metadata is unreadable/u);
      expect(readFileSync(path, 'utf-8')).toBe(legacy);
      utimesSync(path, old, old);
      expect(() => registry().health()).not.toThrow();
    }
  });

  it.each(['legacy directory', 'published directory'] as const)('ledger %s immediately recovers a dead owner but keeps live owners and young legacy directories', (shape) => {
    const path = ledgerPath();
    const installOwner = (owner: string) => {
      const directory = shape === 'legacy directory' ? path : `${path}.${randomUUID()}.tmp`;
      mkdirSync(directory);
      writeFileSync(join(directory, 'owner'), owner);
      if (directory !== path) symlinkSync(basename(directory), path, 'dir');
      return directory;
    };
    for (const processStartTime of [undefined, '4242']) {
      const deadDirectory = installOwner(JSON.stringify({ version: 1, pid: 2_147_483_647, processStartTime, token: 'a'.repeat(32) }));
      expect(() => writeLedger()).not.toThrow();
      expect(existsSync(path)).toBe(false);
      expect(existsSync(deadDirectory)).toBe(false);
      rmSync(join(root, session), { recursive: true });
    }

    const liveOwner = JSON.stringify({ version: 1, pid: process.pid, token: 'b'.repeat(32) });
    const liveDirectory = installOwner(liveOwner);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(path, 'owner'), old, old);
    utimesSync(liveDirectory, old, old);
    expect(() => writeLedger()).toThrow(/ledger lock is busy/u);
    expect(readFileSync(join(path, 'owner'), 'utf-8')).toBe(liveOwner);
    rmSync(path, { recursive: true });
    if (liveDirectory !== path) rmSync(liveDirectory, { recursive: true });

    for (const legacy of [undefined, '{"pid":']) {
      mkdirSync(path);
      if (legacy !== undefined) writeFileSync(join(path, 'owner'), legacy);
      const before = lstatSync(path);
      expect(() => writeLedger()).toThrow(/ledger lock is busy/u);
      expect(lstatSync(path).ino).toBe(before.ino);
      expect(readdirSync(path)).toEqual(legacy === undefined ? [] : ['owner']);
      if (legacy !== undefined) utimesSync(join(path, 'owner'), old, old);
      utimesSync(path, old, old);
      expect(() => writeLedger()).not.toThrow();
      rmSync(join(root, session), { recursive: true });
    }
  });
});


describe('lock process identity', () => {
  it.each((['registry', 'legacy ledger', 'published ledger'] as const).flatMap(kind =>
    (['allowed', 'EPERM'] as const).map(probe => ({ kind, probe }))))(
    '$kind recovers a reused pid and keeps the matching owner with signal probe $probe', ({ kind, probe }) => {
      if (probe === 'EPERM') vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('other user process'), { code: 'EPERM' });
      });
      const path = kind === 'registry' ? join(root, 'tasks.lock') : ledgerPath();
      const act = () => kind === 'registry' ? registry().health() : writeLedger();
      const install = (processStartTime?: string) => {
        const owner = JSON.stringify({ version: 1, pid: process.pid, processStartTime,
          acquiredAt: new Date(Date.now() - 60_000).toISOString(), token: 'c'.repeat(32) });
        const directory = kind === 'published ledger' ? `${path}.${randomUUID()}.tmp` : path;
        if (kind === 'registry') writeFileSync(path, owner);
        else {
          mkdirSync(directory);
          writeFileSync(join(directory, 'owner'), owner);
          if (directory !== path) symlinkSync(basename(directory), path, 'dir');
        }
        return directory;
      };
      // A live process with the same pid but a different starttime is not the owner.
      const reused = install('4241');
      expect(act).not.toThrow();
      expect(existsSync(path)).toBe(false);
      expect(existsSync(reused)).toBe(false);
      if (kind !== 'registry') rmSync(join(root, session), { recursive: true });

      const live = install('4242');
      const old = new Date(Date.now() - 60_000);
      const ownerPath = kind === 'registry' ? path : join(path, 'owner');
      utimesSync(ownerPath, old, old);
      utimesSync(live, old, old);
      expect(act).toThrow(/waiting for task registry lock|ledger lock is busy/u);
      expect(JSON.parse(readFileSync(ownerPath, 'utf-8')).processStartTime).toBe('4242');
      rmSync(path, { recursive: true });
      if (live !== path) rmSync(live, { recursive: true });

      // Previous engines omitted starttime, so an old live pid still blocks.
      install();
      expect(act).toThrow(/waiting for task registry lock|ledger lock is busy/u);
    },
  );

  it.each(['registry', 'ledger'] as const)('%s falls back to pid-only when procfs is unavailable', (kind) => {
    boundary.procStat = new Error('procfs unavailable');
    const path = kind === 'registry' ? join(root, 'tasks.lock') : ledgerPath();
    const ownerPath = kind === 'registry' ? path : join(path, 'owner');
    const act = () => kind === 'registry' ? registry().health() : writeLedger();
    const owners: Record<string, unknown>[] = [];
    boundary.observe = () => {
      if (existsSync(ownerPath)) owners.push(JSON.parse(readFileSync(ownerPath, 'utf-8')));
    };
    expect(act).not.toThrow();
    boundary.observe = undefined;
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.every(owner => owner.pid === process.pid && owner.processStartTime === undefined)).toBe(true);
    if (kind !== 'registry') {
      rmSync(join(root, session), { recursive: true });
      mkdirSync(path);
    }
    writeFileSync(ownerPath, JSON.stringify({ version: 1, pid: process.pid, processStartTime: '4241', token: 'd'.repeat(32) }));
    expect(act).toThrow(/waiting for task registry lock|ledger lock is busy/u);
  });
});
