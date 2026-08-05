import { describe, expect, it } from 'vitest';
import {
  detectParallelWriteConflicts,
  selectRunnableBatch,
  StageConfigSchema,
  type StageConfig,
} from '../src/scheduler.js';
import type { StageStatus, WriteAttribution } from '../src/store.js';

function stage(id: string, scope: string[]): StageConfig {
  return StageConfigSchema.parse({ id, role: 'coder', scope });
}

function completedWithWrite(path: string, writeAttribution: WriteAttribution): StageStatus {
  return {
    status: 'complete',
    retries: 0,
    attempts: [{
      index: 1,
      startedAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:01.000Z',
      status: 'complete',
      duration_ms: 1_000,
      exitCode: 0,
      writes: [path],
      writeAttribution,
    }],
  };
}

describe('round-three acceptance: conservative scope aliases', () => {
  it('serializes an explicit directory spelling against the equivalent bare literal', () => {
    const batch = selectRunnableBatch([
      stage('explicit_tree', ['packages/core/']),
      stage('bare_literal', ['packages/core']),
    ]);

    expect(batch.selected.map((item) => item.id)).toEqual(['explicit_tree']);
    expect(batch.deferred).toHaveLength(1);
  });

  it('serializes a dot-segment directory alias against a nested file', () => {
    const batch = selectRunnableBatch([
      stage('dot_alias', ['packages/core/.']),
      stage('nested_file', ['packages/core/index.ts']),
    ]);

    expect(batch.selected.map((item) => item.id)).toEqual(['dot_alias']);
    expect(batch.deferred).toHaveLength(1);
  });

  it('keeps similarly prefixed sibling path segments parallel', () => {
    const batch = selectRunnableBatch([
      stage('core', ['packages/core']),
      stage('core_ui', ['packages/core-ui/index.ts']),
    ]);

    expect(batch.selected.map((item) => item.id)).toEqual(['core', 'core_ui']);
    expect(batch.deferred).toEqual([]);
  });
});

describe('round-three acceptance: factual conflict visibility', () => {
  it('warns when snapshot-attributed stages record the same run artifact outside the project', () => {
    const shared = '../fc-home/runs/example/knowledge_graph.json';
    const conflicts = detectParallelWriteConflicts(
      ['left', 'right'],
      {
        left: completedWithWrite(shared, 'snapshot'),
        right: completedWithWrite(shared, 'snapshot'),
      },
    );

    expect(conflicts).toEqual([{
      stageIds: ['left', 'right'],
      files: [shared],
      attribution: ['snapshot', 'snapshot'],
    }]);
  });
});
