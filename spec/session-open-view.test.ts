import './test-support/policy-runtime.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTaskEntry, openTaskLedgerPath, readOpenTaskLedger, readTaskLedger, refreshOpenTaskLedger, updateTaskEntry } from '../src/fc-tasks.js';
import { spawnSync } from 'node:child_process';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

const originalFcHome = fcGlobalDir();
const roots: string[] = [];
afterEach(() => { setFcGlobalDir(originalFcHome); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }, 60_000);

it.each(['create', 'update', 'refresh', 'unchanged'])('a redirected open-view directory refuses %s before modifying either ledger representation', operation => {
  const root = mkdtempSync(join(tmpdir(), 'fc-view-redirect-')); roots.push(root); setFcGlobalDir(join(root, 'fc'));
  const storeRoot = join(root, 'ledger');
  const session = 'own-session';
  const entry = { id: 'work', subject: 'Synthetic work', description: '', activeForm: '', status: 'pending' as const, blocks: [], blockedBy: [] };
  if (operation !== 'create') createTaskEntry({ storeRoot, session, entry });
  else mkdirSync(storeRoot);
  const before = readTaskLedger(storeRoot, session);
  const view = dirname(openTaskLedgerPath(storeRoot, session));
  rmSync(view, { recursive: true, force: true });
  const outside = join(root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, `${session}.json`), 'KEEP ORIGINAL');
  writeFileSync(join(outside, `${session}.json.dirty`), 'KEEP DIRTY');
  mkdirSync(dirname(view), { recursive: true });
  symlinkSync(outside, view, 'dir');
  const action = () => operation === 'create' ? createTaskEntry({ storeRoot, session, entry })
    : operation === 'refresh' ? refreshOpenTaskLedger(storeRoot, session)
      : updateTaskEntry({ storeRoot, session, id: entry.id, entry: operation === 'unchanged' ? entry : { status: 'in_progress' }, skipUnchanged: operation === 'unchanged' });
  expect(action).toThrow(/real directory/);
  expect(readTaskLedger(storeRoot, session).entries).toEqual(before.entries);
  expect(readFileSync(join(outside, `${session}.json`), 'utf8')).toBe('KEEP ORIGINAL');
  expect(readFileSync(join(outside, `${session}.json.dirty`), 'utf8')).toBe('KEEP DIRTY');
  expect(readdirSync(outside).sort()).toEqual([`${session}.json`, `${session}.json.dirty`]);
  expect(existsSync(join(storeRoot, session, 'work.json'))).toBe(operation !== 'create');
});

it('the service rebuilds an open view at 10x session history without weakening the default manual census bound', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-open-view-')); roots.push(root); setFcGlobalDir(join(root, 'fc'));
  const session = 'large-history';
  mkdirSync(join(root, session));
  for (let n = 0; n < 8850; n++) writeFileSync(join(root, session, `${n}.json`), JSON.stringify({
    id: String(n), subject: 'Synthetic work', description: '', activeForm: '',
    status: n < 2 ? 'in_progress' : 'completed', blocks: [], blockedBy: [],
  }));
  expect(readTaskLedger(root, session)).toMatchObject({ state: 'unavailable', issues: [{ code: 'scan_limit_exceeded' }] });
  expect(refreshOpenTaskLedger(root, session).issues).toEqual([]);
  expect(readOpenTaskLedger(root, session)).toMatchObject({
    state: 'ready', completedCount: 8848, entries: [{ id: '0' }, { id: '1' }], issues: [],
  });
  // The existing explicit larger census also permits a deliberate writer to
  // update a large historical store; its byte/file/graph protections remain.
  createTaskEntry({ storeRoot: root, session, maxEntries: 10_000, entry: {
    id: 'new', subject: 'New open work', description: '', activeForm: '', status: 'pending', blocks: [], blockedBy: [],
  } });
  expect(readOpenTaskLedger(root, session).entries.map(entry => entry.id)).toEqual(['0', '1', 'new']);
  expect(readTaskLedger(root, session).state).toBe('unavailable');
}, 120_000);

it('session status never parses agent descriptions or scans unrelated agent history for ETA', () => {
  const counts: number[] = [];
  for (const size of [10, 100]) {
    const root = mkdtempSync(join(tmpdir(), 'fc-agent-view-')); roots.push(root); setFcGlobalDir(join(root, 'fc'));
    const agents = join(root, 'agents');
    const live = join(agents, '20260101T000000Z-live'); mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'route.json'), JSON.stringify({ backend: 'codex', effort: 'high' }));
    writeFileSync(join(live, 'progress.json'), JSON.stringify({ phase: 'running' }));
    for (let n = 0; n < size; n++) {
      const old = join(agents, `20260101T000000Z-old-${n}`); mkdirSync(old);
      writeFileSync(join(old, 'route.json'), JSON.stringify({ backend: 'codex', effort: 'high' }));
      writeFileSync(join(old, 'DONE'), 'done');
    }
    const ledger = join(root, 'ledger');
    createTaskEntry({ storeRoot: ledger, session: 'cost-session', entry: {
      id: 'independent', subject: 'Independent work', activeForm: 'Working independently', status: 'in_progress', blocks: [], blockedBy: [],
      description: `Backend codex task; record ${live}. Wrap-up remains: verify`,
    } });
    const fixture = join(root, 'fixture.json'); writeFileSync(fixture, JSON.stringify({ root }));
    const io = join(root, 'io.json');
    const result = spawnSync(process.execPath, ['--import', join(import.meta.dirname, 'test-support/session-cost-io-preload.mjs'),
      join(import.meta.dirname, '../dist/cli.js'), 'session-push', 'statusline', '--json'], {
      cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, FC_HOME: join(root, 'fc'), FC_TASKS_ROOT: ledger, AGENT_TASK_ROOT: agents,
        FLOWCREW_DAEMON_SOCKET: join(root, 'daemon.sock'), SESSION_COST_FIXTURE: fixture, SESSION_COST_OPERATION: 'statusline', SESSION_COST_IO: io, NODE_OPTIONS: '' },
      input: JSON.stringify({ session_id: 'cost-session' }), encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).text).toContain('Working independently');
    counts.push(JSON.parse(readFileSync(io, 'utf8')).files);
  }
  expect(counts).toEqual([1, 1]);
}, 60_000);

it('open views live in engine state and distinguish ledger roots and sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-view-location-')); roots.push(root); setFcGlobalDir(join(root, 'fc'));
  const ledgerA = join(root, 'ledger-a');
  const ledgerB = join(root, 'ledger-b');
  const entry = (id: string) => ({ id, subject: id, description: '', activeForm: '', status: 'pending' as const, blocks: [], blockedBy: [] });
  createTaskEntry({ storeRoot: ledgerA, session: 'shared', entry: entry('a') });
  createTaskEntry({ storeRoot: ledgerB, session: 'shared', entry: entry('b') });
  createTaskEntry({ storeRoot: ledgerA, session: 'other', entry: entry('c') });
  expect(readOpenTaskLedger(ledgerA, 'shared').entries.map(entry => entry.id)).toEqual(['a']);
  expect(readOpenTaskLedger(ledgerB, 'shared').entries.map(entry => entry.id)).toEqual(['b']);
  expect(readOpenTaskLedger(ledgerA, 'other').entries.map(entry => entry.id)).toEqual(['c']);
  expect(openTaskLedgerPath(ledgerA, 'shared').startsWith(join(root, 'fc') + sep)).toBe(true);
  expect(openTaskLedgerPath(join(ledgerA, '.'), 'shared')).toBe(openTaskLedgerPath(resolve(ledgerA), 'shared'));
  expect(readdirSync(ledgerA).sort()).toEqual(['other', 'shared']);
  expect(readdirSync(ledgerB)).toEqual(['shared']);
  expect(readdirSync(join(ledgerA, 'shared'))).toEqual(['a.json']);
});


it('a symlinked FC_HOME supports create, update and service refresh from its canonical root', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-home-alias-')); roots.push(root);
  const home = join(root, 'state'); mkdirSync(home);
  const alias = join(root, 'fc'); symlinkSync(home, alias, 'dir'); setFcGlobalDir(alias);
  const storeRoot = join(root, 'ledger');
  const session = 'alias-session';
  createTaskEntry({ storeRoot, session, entry: {
    id: 'work', subject: 'Work', description: '', activeForm: '', status: 'pending', blocks: [], blockedBy: [],
  } });
  const path = openTaskLedgerPath(storeRoot, session);
  expect(path.startsWith(home + sep)).toBe(true);
  expect(existsSync(path)).toBe(true);
  updateTaskEntry({ storeRoot, session, id: 'work', entry: { status: 'in_progress' } });
  expect(readOpenTaskLedger(storeRoot, session).entries[0].status).toBe('in_progress');
  rmSync(path);
  expect(refreshOpenTaskLedger(storeRoot, session).state).toBe('ready');
  expect(existsSync(path)).toBe(true);
  expect(readOpenTaskLedger(storeRoot, session).entries[0].status).toBe('in_progress');
});

it.each(['absent', 'cached'])('an unwritable FC_HOME with %s view never blocks ledger writes or refresh and readers fall back within one session', mode => {
  const root = mkdtempSync(join(tmpdir(), 'fc-home-readonly-')); roots.push(root);
  const home = join(root, 'fc'); mkdirSync(home); setFcGlobalDir(home);
  const storeRoot = join(root, 'ledger');
  const session = 'readonly-session';
  const entry = (id: string) => ({ id, subject: id, description: '', activeForm: '', status: 'pending' as const, blocks: [], blockedBy: [] });
  if (mode === 'cached') createTaskEntry({ storeRoot, session, entry: entry('old') });
  const path = openTaskLedgerPath(storeRoot, session);
  const cached = mode === 'cached' ? readFileSync(path, 'utf8') : undefined;
  const directories = mode === 'cached' ? [dirname(path), dirname(dirname(path)), home] : [home];
  for (const directory of directories) chmodSync(directory, 0o500);
  try {
    createTaskEntry({ storeRoot, session, entry: entry('new') });
    updateTaskEntry({ storeRoot, session, id: 'new', entry: { status: 'completed' } });
    updateTaskEntry({ storeRoot, session, id: 'new', entry: { status: 'completed' }, skipUnchanged: true });
    expect(refreshOpenTaskLedger(storeRoot, session).state).toBe('ready');
    if (cached) expect(readFileSync(path, 'utf8')).toBe(cached);
    else expect(existsSync(path)).toBe(false);
    // An unreadable unrelated session must not enter the fallback census.
    symlinkSync(join(root, 'missing'), join(storeRoot, 'unrelated'), 'dir');
    expect(readOpenTaskLedger(storeRoot, session)).toMatchObject({ state: 'ready', completedCount: 1,
      entries: mode === 'cached' ? [{ id: 'old' }] : [], issues: [] });
  } finally { for (const directory of directories.reverse()) chmodSync(directory, 0o700); }
  // Restoring permissions cannot resurrect the stale cached contents.
  expect(readOpenTaskLedger(storeRoot, session).completedCount).toBe(1);
  refreshOpenTaskLedger(storeRoot, session);
  expect(readOpenTaskLedger(storeRoot, session).completedCount).toBe(1);
});

it('canonical ledger paths share one view, including absent roots under an aliased parent, while writers reject a symlinked store root', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-ledger-alias-')); roots.push(root); setFcGlobalDir(join(root, 'fc'));
  const parent = join(root, 'real'); mkdirSync(parent);
  const alias = join(root, 'alias'); symlinkSync(parent, alias, 'dir');
  const storeRoot = join(parent, 'ledger');
  const viaParent = join(alias, 'ledger');
  const session = 'shared';
  const before = openTaskLedgerPath(viaParent, session);
  expect(before).toBe(openTaskLedgerPath(storeRoot, session));
  const entry = { id: 'work', subject: 'Work', description: '', activeForm: '', status: 'pending' as const, blocks: [], blockedBy: [] };
  createTaskEntry({ storeRoot: viaParent, session, entry });
  const link = join(root, 'ledger-link'); symlinkSync(storeRoot, link, 'dir');
  expect(openTaskLedgerPath(link, session)).toBe(before);
  expect(readOpenTaskLedger(link, session).entries.map(entry => entry.id)).toEqual(['work']);
  expect(() => createTaskEntry({ storeRoot: link, session, entry: { ...entry, id: 'other' } })).toThrow(/ledger store must be a real directory/);
  expect(() => updateTaskEntry({ storeRoot: link, session, id: 'work', entry: { status: 'completed' } })).toThrow(/ledger store must be a real directory/);
  expect(() => refreshOpenTaskLedger(link, session)).toThrow(/ledger store must be a real directory/);
  expect(readTaskLedger(storeRoot, session).entries.map(entry => entry.id)).toEqual(['work']);
});

it('a missing view falls back to the default bounded census rather than scanning large history', () => {
  const root = mkdtempSync(join(tmpdir(), 'fc-view-bounded-')); roots.push(root); setFcGlobalDir(join(root, 'fc'));
  const session = 'large'; mkdirSync(join(root, session));
  for (let n = 0; n < 1001; n++) writeFileSync(join(root, session, `${n}.json`), '{}');
  expect(readOpenTaskLedger(root, session)).toMatchObject({ state: 'unavailable', issues: [{ code: 'scan_limit_exceeded' }] });
});
