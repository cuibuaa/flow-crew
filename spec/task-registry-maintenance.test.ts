import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  REGISTRY_COMPACTION_THRESHOLDS,
  TaskRegistry,
  type TaskEntry,
} from '../src/task-registry.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), `flowcrew-registry-maintenance-${randomBytes(4).toString('hex')}-`));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function registry(): TaskRegistry {
  return new TaskRegistry({
    baseDir: tempDir,
    now: () => new Date('2026-08-01T12:34:56.789Z'),
  });
}

function completeRow(base: TaskEntry, overrides: Partial<TaskEntry>): TaskEntry {
  return { ...base, ...overrides, id: base.id, created_at: base.created_at, tick_log_path: base.tick_log_path };
}

describe('TaskRegistry repair', () => {
  it('dry-runs without mutation, then backup-first repairs a same-id torn prefix while preserving the complete final row', () => {
    const tasks = registry();
    const created = tasks.create({ brief_text: '# repair me', projectDir: tempDir });
    const running = tasks.update(created.id, { status: 'running', run_id: 'run-final' });
    const intendedFinal = completeRow(running, { status: 'done', notes: 'the complete suffix is authoritative' });
    // A torn append often has no final newline. Repair must not preserve that
    // shape or the next ordinary update would concatenate two JSON objects.
    appendFileSync(tasks.registryPath, `{"id":${created.id},"name":"truncated${JSON.stringify(intendedFinal)}`, 'utf-8');
    const original = readFileSync(tasks.registryPath);

    const preview = tasks.repair();

    expect(preview).toMatchObject({
      operation: 'repair', applied: false, changed: true,
      repairedRecords: 1, quarantinedRecords: 0,
    });
    expect(preview.actions).toEqual([
      expect.objectContaining({ kind: 'repair', line: 3, taskId: created.id }),
    ]);
    expect(readFileSync(tasks.registryPath)).toEqual(original);
    expect(preview.backupPath).toBeTruthy();
    expect(existsSync(preview.backupPath!)).toBe(false);

    const applied = tasks.repair({ apply: true });

    expect(applied.applied).toBe(true);
    expect(existsSync(applied.backupPath!)).toBe(true);
    expect(readFileSync(applied.backupPath!)).toEqual(original);
    expect(readFileSync(tasks.registryPath, 'utf-8')).toMatch(/\n$/);
    expect(tasks.health()).toEqual({ unreadableRecords: 0 });
    expect(tasks.get(created.id)).toEqual(intendedFinal);
    expect(tasks.update(created.id, { notes: 'updates work after repair' }).notes).toBe('updates work after repair');
    expect(tasks.health()).toEqual({ unreadableRecords: 0 });
  });

  it('moves an unprovable unreadable row to quarantine and reports its exact line without silent loss', () => {
    const tasks = registry();
    const created = tasks.create({ brief_text: '# preserve me', projectDir: tempDir });
    const damaged = 'this row cannot be reconstructed { at all';
    appendFileSync(tasks.registryPath, `${damaged}\n`, 'utf-8');
    const original = readFileSync(tasks.registryPath);

    const applied = tasks.repair({ apply: true });

    expect(applied).toMatchObject({ repairedRecords: 0, quarantinedRecords: 1, removedRecords: 1 });
    expect(applied.actions).toEqual([
      expect.objectContaining({ kind: 'quarantine', line: 2 }),
    ]);
    expect(existsSync(applied.backupPath!)).toBe(true);
    expect(readFileSync(applied.backupPath!)).toEqual(original);
    expect(existsSync(applied.quarantinePath!)).toBe(true);
    expect(JSON.parse(readFileSync(applied.quarantinePath!, 'utf-8').trim())).toEqual({ line: 2, raw: damaged });
    expect(tasks.health()).toEqual({ unreadableRecords: 0 });
    expect(tasks.get(created.id)).toEqual(created);
  });

  it('verifies its evidence backup against original bytes before quarantining invalid UTF-8', () => {
    const tasks = registry();
    const created = tasks.create({ brief_text: '# preserve binary evidence', projectDir: tempDir });
    appendFileSync(tasks.registryPath, Buffer.from([0xff, 0x0a]));
    const original = readFileSync(tasks.registryPath);

    const applied = tasks.repair({ apply: true });

    expect(applied).toMatchObject({ repairedRecords: 0, quarantinedRecords: 1, removedRecords: 1 });
    expect(existsSync(applied.backupPath!)).toBe(true);
    expect(readFileSync(applied.backupPath!)).toEqual(original);
    expect(existsSync(applied.quarantinePath!)).toBe(true);
    expect(tasks.health()).toEqual({ unreadableRecords: 0 });
    expect(tasks.get(created.id)).toEqual(created);
  });
});

describe('TaskRegistry compaction', () => {
  it('retains exactly the last row per id with deep-equal latest semantics, evidence backup, and untouched tick logs', () => {
    const tasks = registry();
    const first = tasks.create({ brief_text: '# first', projectDir: tempDir });
    const second = tasks.create({ brief_text: '# second', projectDir: tempDir });
    tasks.update(first.id, { status: 'running', run_id: 'run-1' });
    tasks.update(second.id, { status: 'deferred', notes: 'queued' });
    tasks.update(first.id, { status: 'done', notes: 'final first' });
    tasks.appendTick(first.id, { ts: '2026-08-01T12:00:00.000Z', status: 'done', message: 'independent tick' });
    const withoutFinalNewline = readFileSync(tasks.registryPath, 'utf-8').replace(/\n$/, '');
    writeFileSync(tasks.registryPath, withoutFinalNewline, 'utf-8');
    const beforeLatest = tasks.snapshot().tasks;
    const beforeRegistry = readFileSync(tasks.registryPath);
    const tickPath = beforeLatest.find((task) => task.id === first.id)!.tick_log_path;
    const beforeTick = readFileSync(tickPath);

    const preview = tasks.compact();

    expect(preview).toMatchObject({ applied: false, changed: true, removedRecords: 3 });
    expect(preview.before.records).toBe(5);
    expect(preview.after.records).toBe(2);
    expect(preview.after.tasks).toBe(2);
    expect(preview.actions.filter((action) => action.kind === 'drop-obsolete')).toHaveLength(3);
    expect(readFileSync(tasks.registryPath)).toEqual(beforeRegistry);
    expect(existsSync(preview.backupPath!)).toBe(false);

    const applied = tasks.compact({ apply: true });

    expect(applied.applied).toBe(true);
    expect(existsSync(applied.backupPath!)).toBe(true);
    expect(readFileSync(applied.backupPath!)).toEqual(beforeRegistry);
    expect(readFileSync(tasks.registryPath, 'utf-8')).toMatch(/\n$/);
    expect(readFileSync(tasks.registryPath, 'utf-8').trim().split('\n')).toHaveLength(2);
    expect(tasks.snapshot().tasks).toEqual(beforeLatest);
    expect(tasks.metrics()).toMatchObject({ records: 2, tasks: 2, unreadableRecords: 0 });
    expect(readFileSync(tickPath)).toEqual(beforeTick);
    expect(tasks.update(first.id, { notes: 'append-safe after compact' }).notes).toBe('append-safe after compact');
    expect(tasks.health()).toEqual({ unreadableRecords: 0 });
  });

  it('publishes the 64 MiB or 10,000-record trigger without requiring automatic mutation', () => {
    expect(REGISTRY_COMPACTION_THRESHOLDS).toEqual({ bytes: 64 * 1024 * 1024, records: 10_000 });
    const tasks = registry();
    const task = tasks.create({ brief_text: '# threshold', projectDir: tempDir });
    const row = `${JSON.stringify(task)}\n`;
    for (let index = 1; index < REGISTRY_COMPACTION_THRESHOLDS.records; index += 1) {
      appendFileSync(tasks.registryPath, row, 'utf-8');
    }

    expect(tasks.metrics()).toMatchObject({
      records: REGISTRY_COMPACTION_THRESHOLDS.records,
      tasks: 1,
      compactRecommended: true,
    });
  });
});
