import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { handleDaemonListRequest, mergeTaskWithRunState } from '../src/cli-daemon.js';
import { readRunIndexRecords, upsertRunIndex } from '../src/run-index.js';
import { fcGlobalDir, setFcGlobalDir, type StoreState } from '../src/store.js';
import { TaskRegistry } from '../src/task-registry.js';

const accesses = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
      accesses.push(String(args[0]));
      return original.readFileSync(...args);
    },
    openSync: (...args: Parameters<typeof original.openSync>) => {
      accesses.push(String(args[0]));
      return original.openSync(...args);
    },
  };
});
vi.mock('../src/engine-fs.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/engine-fs.js')>();
  return {
    ...original,
    openSync: (...args: Parameters<typeof original.openSync>) => {
      accesses.push(String(args[0]));
      return original.openSync(...args);
    },
  };
});

let root: string | undefined;
const originalFcDir = fcGlobalDir();
afterEach(() => {
  setFcGlobalDir(originalFcDir);
  if (root) rmSync(root, { recursive: true, force: true });
});

it('lists registry rows with indexed status without opening run evidence, while show keeps detail', () => {
  root = mkdtempSync(join(tmpdir(), 'fc-m9-list-'));
  setFcGlobalDir(root);
  const runId = 'scrubbed-f341a0';
  const runPath = join(root, 'runs', runId);
  mkdirSync(runPath, { recursive: true });
  const state = { runId, status: 'complete', workflowName: 'fixture', startedAt: '2026-08-01T00:00:00Z', stages: {}, failureReason: 'retained show detail' } as unknown as StoreState;
  writeFileSync(join(runPath, 'run.json'), JSON.stringify(state));
  writeFileSync(join(runPath, 'events.jsonl'), `${JSON.stringify({ type: 'run_started', runId, timestamp: state.startedAt })}\n`);
  upsertRunIndex(root, state);
  const registry = new TaskRegistry({ baseDir: root });
  const bound = registry.create({ projectDir: root, run_id: runId, status: 'failed' });
  const waiting = registry.create({ projectDir: root, status: 'deferred' });
  registry.update(waiting.id, { defer_reason: 'waiting for project', defer_kind: 'wait' });

  accesses.length = 0;
  readRunIndexRecords(root);
  expect(accesses.filter(path => path.endsWith('events.jsonl'))).toHaveLength(0);
  accesses.length = 0;
  const response = handleDaemonListRequest(registry, { cmd: 'list', filter: { status: 'all' } });
  for (let call = 0; call < 100; call++) handleDaemonListRequest(registry, { cmd: 'list', filter: { status: 'all' } });
  expect(response.tasks.find(task => task.id === bound.id)).toMatchObject({ status: 'failed', run: { status: 'complete' } });
  expect(response.tasks.find(task => task.id === waiting.id)).toMatchObject({ status: 'deferred', defer_reason: 'waiting for project' });
  expect(accesses.filter(path => path.endsWith('events.jsonl'))).toHaveLength(0);
  expect(accesses.filter(path => path.endsWith('run.json'))).toHaveLength(0);
  expect(response.tasks.find(task => task.id === bound.id)).not.toHaveProperty('operational');
  expect(handleDaemonListRequest(registry, { cmd: 'list', filter: { status: 'complete' } }).tasks.map(task => task.id)).toEqual([bound.id]);
  expect(handleDaemonListRequest(registry, { cmd: 'list', filter: { status: 'failed' } }).tasks).toEqual([]);
  expect(handleDaemonListRequest(registry, { cmd: 'list', filter: { status: 'deferred' } }).tasks.map(task => task.id)).toEqual([waiting.id]);
  accesses.length = 0;
  expect(mergeTaskWithRunState(bound)).toMatchObject({
    status: 'failed', run: { status: 'complete', failureReason: 'retained show detail' }, operational: { sourceCoverage: { events: 'read' } },
  });
  expect(accesses).toContain(join(runPath, 'events.jsonl'));
  expect(accesses).toContain(join(runPath, 'run.json'));
});
