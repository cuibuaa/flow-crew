import { changedProjectPathsSinceSnapshot } from '../src/scheduler/sched_scope/snapshots.js';
import { closeRepairRoundSnapshot } from './test-support/close-repair-snapshot.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureRepairRoundSnapshot,
  type StageConfig,
} from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';

import { settleProjectWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { compareRepairFileContents } from '../src/scheduler/sched_scope/file-images.js';

function stage(...scope: string[]): StageConfig {
  return { id: 'writer', role: 'coder', depends_on: [], scope };
}

describe('snapshot comparison and frozen-content reconciliation', () => {
  it('compares identities across metadata churn while preserving independent writer snapshots', () => {
    const projectDir = join(process.env.FLOWCREW_VITEST_ROOT!, 'shared-preimages');
    mkdirSync(projectDir, { recursive: true });
    const target = join(projectDir, 'model.bin');
    writeFileSync(target, Buffer.alloc(1024 * 1024, 0x41));
    const created = createRun(projectDir, 'preimages', 'name: preimages', ['writer']);
    const first = captureRepairRoundSnapshot(projectDir, [stage('model.bin')], { runDirPath: created.runDirPath });
    try {
      const original = first.files.get('model.bin')!;
      chmodSync(target, 0o600);
      const second = captureRepairRoundSnapshot(projectDir, [stage('model.bin')], { runDirPath: created.runDirPath });
      const metadata = second.files.get('model.bin')!;
      expect(compareRepairFileContents(original, metadata)).toBe('equal');
      expect(metadata.mode).toBe(0o600);
      expect(metadata.statIdentity).not.toEqual(original.statIdentity);
      expect(second.rollbackBaseline.images.get('model.bin')).toBe(metadata);
      expect(first.files.get('model.bin')).toBe(original);
      writeFileSync(target, Buffer.alloc(1024 * 1024, 0x42));
      const third = captureRepairRoundSnapshot(projectDir, [stage('model.bin')], { runDirPath: created.runDirPath });
      expect(compareRepairFileContents(original, third.files.get('model.bin')!)).toBe('different');
      expect(first.files.get('model.bin')).toBe(original);
    } finally { closeRepairRoundSnapshot(first); }
  });

  it('restores a frozen large file after detecting a same-size replacement at settlement', async () => {
    const projectDir = join(process.env.FLOWCREW_VITEST_ROOT!, 'ignored-project');
    mkdirSync(projectDir, { recursive: true });
    const target = join(projectDir, 'model.bin');
    const original = Buffer.alloc(4 * 1024 * 1024, 0x41);
    writeFileSync(target, original);
    const created = createRun(projectDir, 'ignored-content', 'name: ignored-content', ['writer']);
    writeFileSync(join(created.runDirPath, 'task_brief.md'), '---\ninputs: [{path: model.bin, frozen: true}]\n---\n');
    const snapshot = captureRepairRoundSnapshot(projectDir, [stage('model.bin')], { runDirPath: created.runDirPath });
    try {
      const before = snapshot.rollbackBaseline.frozenImages.get('model.bin')!;
      expect(before.byteLength).toBe(original.byteLength);
      expect(before.bytes).toBeUndefined();
      expect(before.text).toBeUndefined();
      expect(before.backingPath).toBeTruthy();
      expect(before.backingPath!.startsWith(projectDir)).toBe(false);
      expect(existsSync(before.backingPath!)).toBe(true);

      snapshot.rollbackBaseline.reliable = false;
      expect(changedProjectPathsSinceSnapshot(snapshot, projectDir)).toEqual([]);

      writeFileSync(target, Buffer.alloc(original.byteLength, 0x42));
      expect(changedProjectPathsSinceSnapshot(snapshot, projectDir)).toContain('model.bin');
      expect(settleProjectWrites({ projectDir, snapshot, rawWrites: ['model.bin'], definiteWrites: new Set(['model.bin']) }))
        .toMatchObject({ rolledBackWrites: ['model.bin'], rollbackFailures: [],
          violations: [{ path: 'model.bin', certainty: 'definite', reason: 'task-frozen evidence content changed' }] });
      expect(readFileSync(target).equals(original)).toBe(true);
    } finally {
      closeRepairRoundSnapshot(snapshot);
    }
  });

  it('retains byte-based judgment for metadata-only churn and fails closed when frozen backing is missing', async () => {
    const projectDir = join(process.env.FLOWCREW_VITEST_ROOT!, 'metadata-project');
    mkdirSync(projectDir, { recursive: true });
    const target = join(projectDir, 'weights.bin');
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x23));
    const created = createRun(projectDir, 'metadata-control', 'name: metadata-control', ['writer']);
    writeFileSync(join(created.runDirPath, 'task_brief.md'), '---\ninputs: [{path: weights.bin, frozen: true}]\n---\n');
    const snapshot = captureRepairRoundSnapshot(projectDir, [stage('weights.bin')], { runDirPath: created.runDirPath });
    try {
      const before = snapshot.rollbackBaseline.frozenImages.get('weights.bin')!;
      snapshot.rollbackBaseline.reliable = false;
      chmodSync(target, 0o744);
      const future = new Date(Date.now() + 60_000);
      utimesSync(target, future, future);
      expect(changedProjectPathsSinceSnapshot(snapshot, projectDir)).toEqual([]);

      rmSync(before.backingPath!, { force: true });
      writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x24));
      const settled = settleProjectWrites({ projectDir, snapshot, rawWrites: ['weights.bin'], definiteWrites: new Set(['weights.bin']) });
      expect(settled.rolledBackWrites).toEqual([]);
      expect(settled.rollbackFailures).toEqual(['weights.bin']);
      expect(settled.rollbackFailureReasons['weights.bin']).toMatch(/could not restore|ENOENT/i);
      expect(readFileSync(target)[0]).toBe(0x24);
    } finally {
      closeRepairRoundSnapshot(snapshot);
    }
  });

  it('compares a resolvable symlink as a link and still detects a changed link target', async () => {
    const projectDir = join(process.env.FLOWCREW_VITEST_ROOT!, 'symlink-project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'first.txt'), 'first target\n');
    writeFileSync(join(projectDir, 'second.txt'), 'second target\n');
    const link = join(projectDir, 'link.txt');
    symlinkSync('first.txt', link);
    const created = createRun(projectDir, 'symlink-control', 'name: symlink-control', ['writer']);
    const snapshot = captureRepairRoundSnapshot(projectDir, [stage('link.txt')], { runDirPath: created.runDirPath });
    try {
      snapshot.rollbackBaseline.reliable = false;
      expect(snapshot.files.get('link.txt')).toMatchObject({
        exists: true,
        type: 'symlink',
        symlink: true,
      });
      expect(changedProjectPathsSinceSnapshot(snapshot, projectDir)).toEqual([]);

      writeFileSync(join(projectDir, 'first.txt'), 'changed referent\n');
      const referentChange = changedProjectPathsSinceSnapshot(snapshot, projectDir);
      expect(referentChange).toContain('first.txt');
      expect(referentChange).not.toContain('link.txt');

      unlinkSync(link);
      symlinkSync('second.txt', link);
      expect(changedProjectPathsSinceSnapshot(snapshot, projectDir)).toContain('link.txt');
    } finally {
      closeRepairRoundSnapshot(snapshot);
    }
  });
});
