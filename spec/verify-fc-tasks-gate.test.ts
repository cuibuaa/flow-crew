import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stringWidth from 'string-width';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FcTasksRefusal,
  clipToDisplayWidth,
  createTaskEntry,
  renderFcTasks,
  updateTaskEntry,
  type FcTaskEntry,
} from '../src/fc-tasks.js';

let sandboxRoot: string;

beforeEach(() => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'fc-tasks-gate-'));
});

afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});

function entry(id: string, status: FcTaskEntry['status'] = 'pending'): FcTaskEntry {
  return {
    id,
    subject: `主题 ${id}`,
    description: `sandbox description ${id}`,
    activeForm: `正在处理 ${id}`,
    status,
    blocks: [],
    blockedBy: [],
  };
}

function seed(session: string, value: FcTaskEntry, filename = `${value.id}.json`): void {
  const directory = join(sandboxRoot, session);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, filename), `${JSON.stringify(value)}\n`, 'utf-8');
}

describe('fc_tasks gate verification', () => {
  it('still renders an old seven-field hand-written entry', () => {
    seed('legacy', entry('old-entry', 'in_progress'));

    const rendered = renderFcTasks({
      storeRoot: sandboxRoot,
      explicitSession: 'legacy',
      columns: 60,
      lines: 4,
    });

    expect(rendered.state).toBe('active');
    expect(rendered.text).toContain('[old-entry] 正在处理 old-entry');
  });

  it.each([40, 60, 100])('clips CJK output to %i terminal columns', (columns) => {
    seed('wide', {
      ...entry('wide', 'in_progress'),
      activeForm: '正在处理中文任务'.repeat(20),
    });

    const rows = renderFcTasks({
      storeRoot: sandboxRoot,
      explicitSession: 'wide',
      columns,
      lines: 4,
    }).text.trimEnd().split('\n');

    expect(rows.every((row) => stringWidth(row) <= columns)).toBe(true);
  });

  it('keeps every grapheme inside a one-column budget', () => {
    expect(stringWidth(clipToDisplayWidth('中文👩🏽‍💻e\u0301', 1))).toBeLessThanOrEqual(1);
  });

  it('bounds rows and uses the final row for deterministic overflow', () => {
    for (const id of ['d', 'b', 'a', 'c']) seed('crowded', entry(id));

    const rows = renderFcTasks({
      storeRoot: sandboxRoot,
      explicitSession: 'crowded',
      columns: 60,
      lines: 3,
    }).text.trimEnd().split('\n');

    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('[a]');
    expect(rows[2]).toBe('… +3 rows not shown');
  });

  it('retains the overflow notice when forty columns and one row are available', () => {
    for (const id of ['d', 'b', 'a', 'c']) seed('one-row', entry(id));

    const rows = renderFcTasks({
      storeRoot: sandboxRoot,
      explicitSession: 'one-row',
      columns: 40,
      lines: 1,
    }).text.trimEnd().split('\n');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/\+4 rows hidden/u);
  });

  it('prints a nonblank degraded row for malformed front-end JSON', () => {
    const rendered = renderFcTasks({
      storeRoot: sandboxRoot,
      payload: { provided: true, text: '{not-json' },
      columns: 40,
      lines: 2,
    });

    expect(rendered.text.trim()).not.toBe('');
    expect(rendered.issueCodes).toEqual(['payload_not_json']);
  });

  it('publishes no file when create validation refuses a missing dependency', () => {
    expect(() => createTaskEntry({
      storeRoot: sandboxRoot,
      session: 'invalid-create',
      entry: { ...entry('candidate'), blockedBy: ['missing'] },
    })).toThrow(FcTasksRefusal);

    expect(readdirSync(join(sandboxRoot, 'invalid-create'))).toEqual([]);
  });

  it('preserves prior bytes and removes the temporary file after update publication fails', () => {
    seed('failed-update', entry('candidate', 'in_progress'), 'hand-written.json');
    const path = join(sandboxRoot, 'failed-update', 'hand-written.json');
    const before = readFileSync(path);

    expect(() => updateTaskEntry({
      storeRoot: sandboxRoot,
      session: 'failed-update',
      id: 'candidate',
      entry: entry('candidate', 'completed'),
      publication: { update: () => { throw new Error('sandbox publication failure'); } },
    })).toThrow(FcTasksRefusal);

    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(join(sandboxRoot, 'failed-update'))).toEqual(['hand-written.json']);
  });
});
