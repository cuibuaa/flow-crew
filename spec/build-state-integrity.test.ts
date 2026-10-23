import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fcGlobalDir, setFcGlobalDir, type StoreState } from '../src/store.js';
import * as ownership from '../src/run-lock.js';
import { listOperationalRunIdsFromIndex, readRunIndexRecords, rebuildRunIndex, setRunSchedulerActive, upsertRunIndex } from '../src/run-index.js';

let root: string;
let previous: string;
function record(id: string, status: StoreState['status'] = 'complete'): StoreState {
  const state = { runId: id, projectDir: root, workflowName: 'fixture', status, stages: {}, startedAt: '2000-01-01T00:00:00.000Z' };
  mkdirSync(join(root, 'runs', id), { recursive: true });
  writeFileSync(join(root, 'runs', id, 'run.json'), JSON.stringify(state));
  writeFileSync(join(root, 'runs', id, 'scheduler.pid'), '123');
  return state;
}
beforeEach(() => {
  previous = fcGlobalDir(); root = mkdtempSync(join(tmpdir(), 'fc-index-integrity-'));
  setFcGlobalDir(root);
});
afterEach(() => {
  setFcGlobalDir(previous);
  rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks();
});

describe('scheduler candidate derivation', () => {
  it.each(['missing', 'dead', 'reused', 'live', 'corrupt', 'unverifiable'] as const)('inserts and rebuilds %s observations conservatively', kind => {
    const state = record('run');
    vi.spyOn(ownership, 'inspectRunScheduler').mockReturnValue({ kind, pid: 123, detail: 'fixture' } as ownership.RunSchedulerObservation);
    const expected = !['missing', 'dead', 'reused'].includes(kind);
    upsertRunIndex('', state);
    expect(readRunIndexRecords('')?.[0].schedulerActive).toBe(expected);
    expect(rebuildRunIndex('')).toBe(1);
    expect(readRunIndexRecords('')?.[0].schedulerActive).toBe(expected);
    expect(listOperationalRunIdsFromIndex('')?.includes('run')).toBe(expected);
  });

  it('keeps explicit claim/removal ordering on ordinary state writes', () => {
    const state = record('run');
    const observation = vi.spyOn(ownership, 'inspectRunScheduler').mockReturnValue({ kind: 'live', pid: 123 });
    upsertRunIndex('', state); setRunSchedulerActive('', 'run', false);
    upsertRunIndex('', state);
    expect(readRunIndexRecords('')?.[0].schedulerActive).toBe(false);
    setRunSchedulerActive('', 'run', true);
    observation.mockReturnValue({ kind: 'dead', pid: 123 });
    upsertRunIndex('', state);
    expect(readRunIndexRecords('')?.[0].schedulerActive).toBe(true);
    rebuildRunIndex('');
    expect(readRunIndexRecords('')?.[0].schedulerActive).toBe(false);
  });

  it('keeps missing-scheduler running records operational without rewriting their status', () => {
    const state = record('run', 'running');
    vi.spyOn(ownership, 'inspectRunScheduler').mockReturnValue({ kind: 'missing' });
    upsertRunIndex('', state); rebuildRunIndex('');
    expect(readRunIndexRecords('')?.[0]).toMatchObject({ status: 'running', schedulerActive: false });
    expect(listOperationalRunIdsFromIndex('')).toEqual(['run']);
  });

  it('hydrates restored and removed runs only when directory membership changes', () => {
    const first = record('first');
    upsertRunIndex('', first);
    expect(readRunIndexRecords('')?.map((row) => row.runId)).toEqual(['first']);
    const observation = vi.spyOn(ownership, 'inspectRunScheduler').mockReturnValue({ kind: 'missing' });
    for (let index = 0; index < 100; index += 1) readRunIndexRecords('');
    expect(observation).not.toHaveBeenCalled();
    record('restored');
    expect(readRunIndexRecords('')?.map((row) => row.runId)).toEqual(['first', 'restored']);
    observation.mockClear();
    rmSync(join(root, 'runs', 'first'), { recursive: true });
    expect(readRunIndexRecords('')?.map((row) => row.runId)).toEqual(['restored']);
    expect(observation).toHaveBeenCalledTimes(1);
  });

  it('discovers a restore made between index readers in separate processes', () => {
    upsertRunIndex('', record('before'));
    expect(readRunIndexRecords('')?.map((row) => row.runId)).toEqual(['before']);
    record('restored');
    const entry = new URL('../dist/run-index.js', import.meta.url).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { readRunIndexRecords } from ${JSON.stringify(entry)};
       console.log(JSON.stringify(readRunIndexRecords('').map(row => row.runId)));`], {
      cwd: root, env: { ...process.env, HOME: root, FC_HOME: root }, encoding: 'utf8',
    });
    expect(JSON.parse(output)).toEqual(['before', 'restored']);
  });

  it('serializes an external ownership update after the rebuild transaction', async () => {
    const state = record('run');
    vi.spyOn(ownership, 'inspectRunScheduler').mockReturnValue({ kind: 'dead', pid: 123 });
    upsertRunIndex('', state); rebuildRunIndex('');
    const database = new DatabaseSync(join(root, 'run-index.sqlite'));
    database.exec('BEGIN IMMEDIATE');
    const entry = new URL('../dist/run-index.js', import.meta.url).href;
    const childEnv = { ...process.env, HOME: root, USERPROFILE: root, FC_HOME: root,
      CODEX_HOME: join(root, 'codex'), XDG_RUNTIME_DIR: join(root, 'runtime'),
      FLOWCREW_DAEMON_SOCKET: join(root, 'absent.sock') };
    for (const directory of [childEnv.CODEX_HOME, childEnv.XDG_RUNTIME_DIR]) mkdirSync(directory);
    delete childEnv.DBUS_SESSION_BUS_ADDRESS;
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { setRunSchedulerActive } from ${JSON.stringify(entry)};
       process.stdout.write('trying\\n');
       setRunSchedulerActive('', 'run', true); process.stdout.write('done\\n');`], {
      cwd: root, env: { ...childEnv, HOME: root, FC_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ownership writer did not start')), 3000);
        child.stdout.on('data', () => { if (stdout.includes('trying')) { clearTimeout(timer); resolve(); } });
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(stdout).not.toContain('done');
      database.exec('COMMIT');
      expect(await closed, stderr).toBe(0);
      expect(stdout).toContain('done');
      expect(readRunIndexRecords('')?.[0].schedulerActive).toBe(true);
    } finally {
      try { database.exec('ROLLBACK'); } catch { /* transaction already committed */ }
      database.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  });
});
