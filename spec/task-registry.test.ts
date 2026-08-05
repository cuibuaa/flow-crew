import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TaskRegistry } from '../src/task-registry.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), `flowcrew-tasks-${randomBytes(4).toString('hex')}-`));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('TaskRegistry', () => {
  it('creates, lists, and updates append-only entries', () => {
    const registry = new TaskRegistry({ baseDir: tempDir });
    const task = registry.create({ brief_text: '# Ship it', projectDir: tempDir });

    expect(task.id).toBe(1);
    expect(task.systemd_unit).toBe('flowcrew-task-1.service');
    expect(registry.list()).toHaveLength(1);

    const updated = registry.update(task.id, { status: 'running', run_id: 'run-1' });

    expect(updated.status).toBe('running');
    expect(registry.get(task.id)?.run_id).toBe('run-1');
    expect(readFileSync(join(tempDir, 'tasks.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(2);
  });

  it('reports corrupt lines and fails closed before appending an update from stale state', () => {
    const registry = new TaskRegistry({ baseDir: tempDir });
    const task = registry.create({ brief_text: 'task', projectDir: tempDir });
    appendFileSync(join(tempDir, 'tasks.jsonl'), '{bad json\n', 'utf-8');

    expect(registry.get(task.id)?.name).toBe('task');
    expect(registry.list()).toHaveLength(1);
    expect(registry.health()).toEqual({ unreadableRecords: 1 });
    expect(() => registry.update(task.id, { status: 'running', run_id: 'must-not-be-written' }))
      .toThrow(/integrity check failed.*1 unreadable record/i);
    expect(readFileSync(join(tempDir, 'tasks.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(2);
  });

  it('allocates monotonic ids under concurrent creates', async () => {
    const registry = new TaskRegistry({ baseDir: tempDir });

    const tasks = await Promise.all(Array.from({ length: 12 }, (_, i) => (
      new Promise((resolve) => setImmediate(() => resolve(registry.create({ brief_text: `task ${i}`, projectDir: tempDir }))))
    )));

    expect(tasks.map((task: any) => task.id).sort((a: number, b: number) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(readFileSync(join(tempDir, 'tasks-seq'), 'utf-8').trim()).toBe('12');
  });

  it('writes and reads recent tick logs', () => {
    const registry = new TaskRegistry({ baseDir: tempDir });
    const task = registry.create({ brief_text: 'task', projectDir: tempDir });

    registry.appendTick(task.id, { ts: '2026-01-01T00:00:00.000Z', status: 'active', message: 'ok' });
    registry.appendTick(task.id, { ts: '2026-01-01T00:00:01.000Z', status: 'done' });

    expect(existsSync(task.tick_log_path)).toBe(true);
    expect(registry.readRecentTicks(task.id, 1)).toEqual(['- 2026-01-01T00:00:01.000Z status=done']);
  });
});
