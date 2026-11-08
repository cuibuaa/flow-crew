import './test-support/policy-runtime.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTaskEntry, readOpenTaskLedger, readTaskLedger, refreshOpenTaskLedger, updateTaskEntry } from '../src/fc-tasks.js';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }, 60_000);

it.each(['create', 'update', 'refresh', 'unchanged'])('a redirected open-view directory refuses %s before modifying either ledger representation', operation => {
  const root = mkdtempSync(join(tmpdir(), 'fc-view-redirect-')); roots.push(root);
  const storeRoot = join(root, 'ledger');
  const session = 'own-session';
  const entry = { id: 'work', subject: 'Synthetic work', description: '', activeForm: '', status: 'pending' as const, blocks: [], blockedBy: [] };
  if (operation !== 'create') createTaskEntry({ storeRoot, session, entry });
  else mkdirSync(storeRoot);
  const before = readTaskLedger(storeRoot, session);
  const view = join(storeRoot, '.flowcrew-open');
  rmSync(view, { recursive: true, force: true });
  const outside = join(root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, `${session}.json`), 'KEEP ORIGINAL');
  writeFileSync(join(outside, `${session}.json.dirty`), 'KEEP DIRTY');
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
  const root = mkdtempSync(join(tmpdir(), 'fc-open-view-')); roots.push(root);
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
    const root = mkdtempSync(join(tmpdir(), 'fc-agent-view-')); roots.push(root);
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
      env: { ...process.env, HOME: root, USERPROFILE: root, FC_HOME: join(root, 'fc'), FC_TASKS_ROOT: ledger, AGENT_TASK_ROOT: agents,
        FLOWCREW_DAEMON_SOCKET: join(root, 'daemon.sock'), SESSION_COST_FIXTURE: fixture, SESSION_COST_OPERATION: 'statusline', SESSION_COST_IO: io, NODE_OPTIONS: '' },
      input: JSON.stringify({ session_id: 'cost-session' }), encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).text).toContain('Working independently');
    counts.push(JSON.parse(readFileSync(io, 'utf8')).files);
  }
  expect(counts).toEqual([1, 1]);
}, 60_000);
