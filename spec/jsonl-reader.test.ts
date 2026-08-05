import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getItem, recordRequest, resolveRequest } from '../src/inbox.js';
import { readJsonlFile, readJsonlFileWithDiagnostics } from '../src/jsonl.js';
import { appendRunEvent, readRunEvents } from '../src/run-events.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { TaskRegistry } from '../src/task-registry.js';

describe('tolerant shared JSONL reader', () => {
  let tempDir: string;
  let previousFcDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flowcrew-jsonl-'));
    previousFcDir = fcGlobalDir();
    setFcGlobalDir(join(tempDir, 'fc-home'));
  });

  afterEach(() => {
    setFcGlobalDir(previousFcDir);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps ordered valid rows around malformed middle and truncated tail rows', () => {
    const path = join(tempDir, 'events.jsonl');
    writeFileSync(path, [
      JSON.stringify({ id: 1 }),
      '{malformed middle',
      JSON.stringify({ id: 2 }),
      '{"id":',
    ].join('\n'), 'utf-8');

    expect(readJsonlFile<{ id: number }>(path)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(readJsonlFileWithDiagnostics<{ id: number }>(path)).toEqual({
      rows: [{ id: 1 }, { id: 2 }],
      unreadableRecords: 2,
    });

    appendFileSync(path, `\n${JSON.stringify({ id: 3 })}\n`, 'utf-8');
    expect(readJsonlFile<{ id: number }>(path)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(readJsonlFileWithDiagnostics<{ id: number }>(path).unreadableRecords).toBe(2);
  });

  it('returns no rows for an empty file and leaves missing-file policy to callers', () => {
    const emptyPath = join(tempDir, 'empty.jsonl');
    writeFileSync(emptyPath, '', 'utf-8');
    expect(readJsonlFile(emptyPath)).toEqual([]);
    expect(() => readJsonlFile(join(tempDir, 'missing.jsonl'))).toThrow();
  });

  it('keeps run-event history when a bad row is followed by a later valid append', () => {
    const projectDir = join(tempDir, 'project');
    const runId = 'events-run';
    appendRunEvent(projectDir, runId, {
      type: 'iteration_completed',
      runId,
      timestamp: '2026-07-01T00:00:00.000Z',
    });
    const path = join(fcGlobalDir(), 'runs', runId, 'events.jsonl');
    appendFileSync(path, '{"type":\n', 'utf-8');
    appendRunEvent(projectDir, runId, {
      type: 'run_completed',
      runId,
      timestamp: '2026-07-01T00:01:00.000Z',
    });

    expect(readRunEvents(projectDir, runId).map((event) => event.type)).toEqual([
      'iteration_completed',
      'run_completed',
    ]);
    expect(readRunEvents(projectDir, 'missing-run')).toEqual([]);
  });

  it('keeps task registry rows before and after a corrupt append', () => {
    const registry = new TaskRegistry({ baseDir: join(tempDir, 'registry') });
    const first = registry.create({ projectDir: tempDir, name: 'first' });
    appendFileSync(registry.registryPath, '{"id":\n', 'utf-8');
    const second = registry.create({ projectDir: tempDir, name: 'second' });

    expect(registry.get(first.id)?.name).toBe('first');
    expect(registry.get(second.id)?.name).toBe('second');
  });

  it('preserves inbox first-resolution-wins folding', () => {
    const runId = 'approval-run';
    const projectDir = join(tempDir, 'project');
    recordRequest({
      runId,
      projectDir,
      requestId: 'deploy-prod',
      action: 'deploy',
      risk: 'external',
      target: 'production',
      title: 'Deploy production',
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const first = resolveRequest(projectDir, runId, 'deploy-prod', 'approve', { by: 'alice' });
    const second = resolveRequest(projectDir, runId, 'deploy-prod', 'deny', { by: 'bob' });

    expect(first.won).toBe(true);
    expect(second.won).toBe(false);
    expect(getItem(runId, 'deploy-prod')?.resolution).toMatchObject({ decision: 'approve', by: 'alice' });
  });
});
