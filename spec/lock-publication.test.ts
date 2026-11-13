import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, linkSync, readlinkSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { TaskRegistry } from '../src/task-registry.js';
import { createTaskEntry } from '../src/fc-tasks.js';
import { withRunStateLock, RUN_STATE_LOCK_FILE } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import * as liveness from '../src/process-liveness.js';
import { readLockWaits, lockOwnerIdentity, type LockOwner } from '../src/lock-publication.js';

vi.hoisted(() => vi.resetModules());
const boundary = vi.hoisted(() => ({
  observe: undefined as (() => void) | undefined,
  procStat: undefined as string | Error | undefined,
  boot: undefined as Error | undefined,
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
    renameSync: instrument(actual.renameSync),
    unlinkSync: instrument(actual.unlinkSync),
    rmdirSync: instrument(actual.rmdirSync),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
    if (args[0] === '/proc/sys/kernel/random/boot_id' && boundary.boot) throw boundary.boot;
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
  boundary.boot = undefined;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const session = 'publication-fixture';
const entry = { id: 'work', subject: 'Work', description: '', activeForm: '', status: 'pending' as const, blocks: [], blockedBy: [] };
const ledgerPath = () => join(root, `.fc-tasks-lock-${createHash('sha256').update(session).digest('hex')}`);
const writeLedger = () => createTaskEntry({ storeRoot: root, session, entry });
const registry = () => new TaskRegistry({ baseDir: root, warn: () => {} });

const pathFor = (kind: 'run-state' | 'registry' | 'ledger') => kind === 'run-state' ? runRecordPath(root, RUN_STATE_LOCK_FILE) : kind === 'registry' ? join(root, 'tasks.lock') : ledgerPath();
const actFor = (kind: 'run-state' | 'registry' | 'ledger') => kind === 'run-state'
  ? withRunStateLock(root, () => writeFileSync(join(root, 'mutated'), 'yes'))
  : kind === 'registry' ? registry().create({ projectDir: root }) : writeLedger();
const ownerPathFor = (kind: 'run-state' | 'registry' | 'ledger') => kind === 'ledger' ? join(pathFor(kind), 'owner') : pathFor(kind);
function install(kind: 'run-state' | 'registry' | 'ledger', raw: string | undefined, published = false): string {
  const path = pathFor(kind);
  mkdirSync(dirname(path), { recursive: true });
  const directory = kind === 'ledger' && published ? `${path}.${randomUUID()}.tmp` : path;
  if (kind === 'ledger') {
    mkdirSync(directory);
    if (raw !== undefined) writeFileSync(join(directory, 'owner'), raw);
    if (published) symlinkSync(basename(directory), path, 'dir');
  } else writeFileSync(path, raw ?? '');
  return directory;
}
function remove(kind: 'run-state' | 'registry' | 'ledger', directory = pathFor(kind)): void {
  rmSync(pathFor(kind), { recursive: true, force: true });
  if (directory !== pathFor(kind)) rmSync(directory, { recursive: true, force: true });
}

describe('atomic owner publication', () => {
  it.each(['run-state', 'registry', 'ledger'] as const)('%s observers always see complete owners at creation and release', kind => {
    const path = pathFor(kind);
    const incomplete: string[] = [];
    let observations = 0;
    boundary.observe = () => {
      // Choosing and waiting are published on this same atomic carrier.
      for (const name of readdirSync(dirname(path)).filter(name => name.startsWith(`${basename(path)}.wait-`) && name.endsWith('.json'))) {
        try {
          const contender = JSON.parse(readFileSync(join(dirname(path), name), 'utf8'));
          if (contender.owner?.pid !== process.pid || contender.owner.startToken?.value !== '4242') incomplete.push('incomplete contender');
        } catch { incomplete.push('unreadable contender'); }
      }
      if (!existsSync(path)) return;
      observations += 1;
      try {
        const owner = JSON.parse(readFileSync(ownerPathFor(kind), 'utf-8'));
        if (owner.pid !== process.pid || owner.processStartTime !== '4242' || owner.startToken?.value !== '4242'
            || typeof owner.bootId !== 'string' || typeof owner.token !== 'string') incomplete.push('incomplete owner');
      } catch { incomplete.push('unreadable owner'); }
    };
    actFor(kind);
    boundary.observe = undefined;
    expect(observations).toBeGreaterThan(0);
    expect(incomplete).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dirname(path)).filter(name => name.includes('.wait-') || name.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['run-state', 'registry', 'ledger'] as const)('%s waits beyond every former threshold for a live legacy holder and completes on release', kind => {
    let clock = 1;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => BigInt(clock) * 1_000_000n);
    const raw = JSON.stringify({ version: 1, pid: process.pid, token: 'b'.repeat(32), acquiredAt: '1970-01-01T00:00:00.000Z' });
    install(kind, raw);
    let observations = 0;
    vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      const waiting = readLockWaits(pathFor(kind));
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({ kind: 'lock_wait', holder: { pid: process.pid }, reason: 'holder' });
      expect(readFileSync(ownerPathFor(kind), 'utf8')).toBe(raw);
      if (++observations === 1) clock = 1_000_000_000_000_000;
      else remove(kind);
      return 'ok';
    });
    actFor(kind);
    expect(observations).toBe(2);
    expect(readLockWaits(pathFor(kind))).toEqual([]);
  });

  it.each(['run-state', 'registry', 'ledger'] as const)('%s never removes old or young owner-less legacy locks, and proceeds after their writer releases', kind => {
    for (const raw of [undefined, '{"pid":', '{}']) for (const at of [new Date(0), new Date(8_000_000_000_000_000)]) {
      const directory = install(kind, raw);
      utimesSync(pathFor(kind), at, at);
      const inode = lstatSync(pathFor(kind)).ino;
      let waited = false;
      const pause = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
        expect(readLockWaits(pathFor(kind))).toEqual([expect.objectContaining({ holder: null, reason: 'legacy_owner_unavailable' })]);
        expect(lstatSync(pathFor(kind)).ino).toBe(inode);
        waited = true;
        remove(kind, directory);
        return 'ok';
      });
      actFor(kind);
      pause.mockRestore();
      expect(waited).toBe(true);
      if (kind === 'ledger') rmSync(join(root, session), { recursive: true });
    }
  });
});

describe('lock process identity', () => {
  it.each((['run-state', 'registry', 'ledger'] as const).flatMap(kind =>
    (['allowed', 'EPERM'] as const).map(probe => ({ kind, probe }))))(
    '$kind recovers death and reused identity without advancing a clock ($probe)', ({ kind, probe }) => {
      vi.spyOn(Date, 'now').mockReturnValue(1);
      vi.spyOn(process.hrtime, 'bigint').mockReturnValue(1n);
      const kill = process.kill.bind(process);
      vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (probe === 'EPERM' && pid === process.pid) throw Object.assign(new Error('other user process'), { code: 'EPERM' });
        return kill(pid, signal);
      });
      const pause = vi.spyOn(Atomics, 'wait').mockImplementation(() => { throw new Error('death needs no poll'); });
      for (const published of kind === 'ledger' ? [false, true] : [false]) {
        for (const owner of [
          { pid: 2_147_483_647 },
          { pid: process.pid, processStartTime: '4241' },
          { ...lockOwnerIdentity(), bootId: 'previous-boot' },
        ]) {
          const directory = install(kind, JSON.stringify({ ...owner, version: 1, token: 'c'.repeat(32) }), published);
          actFor(kind);
          expect(existsSync(pathFor(kind))).toBe(false);
          expect(existsSync(directory)).toBe(false);
          if (kind === 'ledger') rmSync(join(root, session), { recursive: true });
        }
      }
      expect(pause).not.toHaveBeenCalled();
    },
  );

  it.each(['run-state', 'registry', 'ledger'] as const)('%s preserves an identity when the process observation becomes unavailable', kind => {
    install(kind, JSON.stringify({ pid: process.pid, processStartTime: '4241', version: 1, token: 'd'.repeat(32) }));
    // Obtain this caller's identity first; then make observation of the recorded owner unknown.
    let observed = false;
    boundary.observe = () => { if (!observed) { observed = true; boundary.procStat = new Error('procfs unavailable'); } };
    vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      expect(readLockWaits(pathFor(kind))[0]).toMatchObject({ holder: { pid: process.pid }, reason: 'owner_unobservable' });
      remove(kind);
      return 'ok';
    });
    actFor(kind);
  });

  it.each(['run-state', 'registry', 'ledger'] as const)('%s waits for its own identity instead of publishing incomplete ownership or refusing', kind => {
    vi.spyOn(liveness, 'processStartToken').mockReturnValueOnce(undefined).mockReturnValue({ kind: 'linux', value: '4242' });
    const pause = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      expect(existsSync(pathFor(kind))).toBe(false);
      expect(readdirSync(dirname(pathFor(kind))).some(name => name.includes('.wait-'))).toBe(false);
      return 'ok';
    });
    actFor(kind);
    expect(pause).toHaveBeenCalledOnce();
  });

  it('publishes the existing portable process token when procfs cannot supply one', () => {
    boundary.procStat = new Error('procfs unavailable');
    boundary.boot = new Error('procfs unavailable');
    const owners: LockOwner[] = [];
    boundary.observe = () => {
      const path = pathFor('registry');
      if (existsSync(path)) owners.push(JSON.parse(readFileSync(path, 'utf8')));
    };
    actFor('registry');
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.every(owner => owner.startToken?.kind === 'posix-lstart' && owner.pid === process.pid)).toBe(true);
  });

  it.each(['run-state', 'registry', 'ledger'] as const)('%s compares a POSIX holder identity even after procfs returns', kind => {
    const stat = boundary.procStat;
    boundary.procStat = new Error('procfs unavailable');
    boundary.boot = new Error('procfs unavailable');
    const portable = lockOwnerIdentity();
    expect(portable.startToken?.kind).toBe('posix-lstart');
    boundary.procStat = stat;
    boundary.boot = undefined;
    install(kind, JSON.stringify({ ...portable, token: 'live' }));
    const pause = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      expect(readLockWaits(pathFor(kind))[0]).toMatchObject({ holder: { startToken: portable.startToken }, reason: 'holder' });
      remove(kind); return 'ok';
    });
    actFor(kind);
    expect(pause).toHaveBeenCalledOnce(); pause.mockRestore();
    if (kind === 'ledger') rmSync(join(root, session), { recursive: true });
    install(kind, JSON.stringify({ ...portable, startToken: { ...portable.startToken, value: 'different process birth' }, token: 'reused' }));
    const noPoll = vi.spyOn(Atomics, 'wait').mockImplementation(() => { throw new Error('reuse evidence needs no poll'); });
    actFor(kind);
    expect(noPoll).not.toHaveBeenCalled();
  });

  it.each(['run-state', 'registry', 'ledger'] as const)('%s refuses an ownership replacement at the publication boundary', kind => {
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement', processStartTime: '4242' });
    let replaced = false;
    boundary.observe = () => {
      if (!replaced && existsSync(pathFor(kind))) {
        replaced = true;
        writeFileSync(ownerPathFor(kind), replacement);
      }
    };
    expect(() => actFor(kind)).toThrow(/ownership changed/);
    expect(replaced).toBe(true);
    expect(readFileSync(ownerPathFor(kind), 'utf8')).toBe(replacement);
  });
  it.each(['run-state', 'registry', 'ledger'] as const)('%s releases both carriers and preserves an action failure', kind => {
    const fail = () => { throw new Error('action failure'); };
    const act = () => kind === 'run-state' ? withRunStateLock(root, fail)
      : kind === 'registry' ? new TaskRegistry({ baseDir: root, syncFile: fail }).create({ projectDir: root })
      : createTaskEntry({ storeRoot: root, session, entry, publication: { create: fail } });
    expect(act).toThrow('action failure');
    expect(existsSync(pathFor(kind))).toBe(false);
    expect(readLockWaits(pathFor(kind))).toEqual([]);
    expect(() => actFor(kind)).not.toThrow();
  });

  it.each(['run-state', 'registry', 'ledger'] as const)('%s release cannot unlink a replacement installed during its action', kind => {
    const path = pathFor(kind);
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement' });
    const replace = () => {
      rmSync(path, { recursive: true });
      if (kind === 'ledger') mkdirSync(path);
      writeFileSync(ownerPathFor(kind), replacement);
    };
    const act = () => kind === 'run-state' ? withRunStateLock(root, replace)
      : kind === 'registry' ? new TaskRegistry({ baseDir: root, syncFile: replace }).create({ projectDir: root })
      : createTaskEntry({ storeRoot: root, session, entry, publication: { create: (from, to) => { replace(); linkSync(from, to); } } });
    expect(act).toThrow(/ownership changed/);
    expect(readFileSync(ownerPathFor(kind), 'utf8')).toBe(replacement);
  });

  it('detaches a legacy ledger directory before deleting its owner metadata during recovery', () => {
    install('ledger', JSON.stringify({ version: 1, pid: 2_147_483_647, token: 'a'.repeat(32) }));
    const incomplete: string[] = [];
    boundary.observe = () => {
      if (existsSync(ledgerPath())) {
        try { if (!JSON.parse(readFileSync(join(ledgerPath(), 'owner'), 'utf8')).pid) incomplete.push('missing owner'); }
        catch { incomplete.push('unreadable owner'); }
      }
    };
    writeLedger();
    expect(incomplete).toEqual([]);
  });

  it('ledger release preserves a replaced owner directory even if its metadata was copied exactly', () => {
    let directory = '';
    let owner = '';
    const act = () => createTaskEntry({ storeRoot: root, session, entry, publication: { create: (from, to) => {
      directory = join(root, readlinkSync(ledgerPath()));
      owner = readFileSync(join(directory, 'owner'), 'utf8');
      renameSync(directory, `${directory}.retired`);
      mkdirSync(directory);
      writeFileSync(join(directory, 'owner'), owner);
      linkSync(from, to);
    } } });
    expect(act).toThrow(/ownership changed/);
    expect(readFileSync(join(directory, 'owner'), 'utf8')).toBe(owner);
    expect(readlinkSync(ledgerPath())).toBe(basename(directory));
  });

});
