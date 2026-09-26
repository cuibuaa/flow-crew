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
  changedProjectPathsSinceSnapshotCooperatively,
  closeRepairRoundSnapshot,
  restoreProjectPath,
  type StageConfig,
} from '../src/scheduler.js';
import { createRun } from '../src/store.js';

function stage(): StageConfig {
  return { id: 'writer', role: 'coder', depends_on: [], scope: [] };
}

describe('ignored-content rollback reconciliation', () => {
  it('keeps a large preimage outside the project, skips unchanged bytes, and restores a same-size replacement', async () => {
    const projectDir = join(process.env.FLOWCREW_VITEST_ROOT!, 'ignored-project');
    mkdirSync(projectDir, { recursive: true });
    const target = join(projectDir, 'model.bin');
    const original = Buffer.alloc(4 * 1024 * 1024, 0x41);
    writeFileSync(target, original);
    const created = createRun(projectDir, 'ignored-content', 'name: ignored-content', ['writer']);
    const snapshot = captureRepairRoundSnapshot(projectDir, [stage()], { runDirPath: created.runDirPath });
    try {
      const before = snapshot.allFileImages.get('model.bin')!;
      expect(before.byteLength).toBe(original.byteLength);
      expect(before.bytes).toBeUndefined();
      expect(before.text).toBeUndefined();
      expect(before.backingPath).toBeTruthy();
      expect(before.backingPath!.startsWith(projectDir)).toBe(false);
      expect(existsSync(before.backingPath!)).toBe(true);

      snapshot.rollbackBaseline.reliable = false;
      expect(await changedProjectPathsSinceSnapshotCooperatively(snapshot, projectDir)).toEqual([]);

      writeFileSync(target, Buffer.alloc(original.byteLength, 0x42));
      expect(await changedProjectPathsSinceSnapshotCooperatively(snapshot, projectDir)).toContain('model.bin');
      expect(restoreProjectPath(projectDir, 'model.bin', before)).toEqual({ restored: true });
      expect(readFileSync(target).equals(original)).toBe(true);
    } finally {
      closeRepairRoundSnapshot(snapshot);
    }
  });

  it('retains byte-based judgment for metadata-only churn and fails closed when backing is missing', async () => {
    const projectDir = join(process.env.FLOWCREW_VITEST_ROOT!, 'metadata-project');
    mkdirSync(projectDir, { recursive: true });
    const target = join(projectDir, 'weights.bin');
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x23));
    const created = createRun(projectDir, 'metadata-control', 'name: metadata-control', ['writer']);
    const snapshot = captureRepairRoundSnapshot(projectDir, [stage()], { runDirPath: created.runDirPath });
    try {
      const before = snapshot.allFileImages.get('weights.bin')!;
      snapshot.rollbackBaseline.reliable = false;
      chmodSync(target, 0o744);
      const future = new Date(Date.now() + 60_000);
      utimesSync(target, future, future);
      expect(await changedProjectPathsSinceSnapshotCooperatively(snapshot, projectDir)).toEqual([]);
      expect(before.verifiedStatIdentity).toBeDefined();
      expect(before.verifiedStatIdentity).not.toEqual(before.statIdentity);
      expect(await changedProjectPathsSinceSnapshotCooperatively(snapshot, projectDir)).toEqual([]);

      rmSync(before.backingPath!, { force: true });
      writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x24));
      const restored = restoreProjectPath(projectDir, 'weights.bin', before);
      expect(restored.restored).toBe(false);
      expect(restored.failure).toMatch(/could not restore|ENOENT/i);
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
    const snapshot = captureRepairRoundSnapshot(projectDir, [stage()], { runDirPath: created.runDirPath });
    try {
      snapshot.rollbackBaseline.reliable = false;
      expect(snapshot.allFileImages.get('link.txt')).toMatchObject({
        exists: true,
        type: 'symlink',
        symlink: true,
        text: 'first.txt',
      });
      expect(await changedProjectPathsSinceSnapshotCooperatively(snapshot, projectDir)).toEqual([]);

      writeFileSync(join(projectDir, 'first.txt'), 'changed referent\n');
      const referentChange = await changedProjectPathsSinceSnapshotCooperatively(snapshot, projectDir);
      expect(referentChange).toContain('first.txt');
      expect(referentChange).not.toContain('link.txt');

      unlinkSync(link);
      symlinkSync('second.txt', link);
      expect(await changedProjectPathsSinceSnapshotCooperatively(snapshot, projectDir)).toContain('link.txt');
    } finally {
      closeRepairRoundSnapshot(snapshot);
    }
  });
});
