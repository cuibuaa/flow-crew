import { chmodSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRun } from './test-support/create-run.js';
import { bindFrozenInputs, changedContentMembers, frozenChanges, projectContentMembers } from '../src/scheduler/sched_scope/frozen-inputs.js';
import { settleProjectWrites } from '../src/scheduler/sched_scope/write-enforcement.js';

function fixture(name: string, path: string, size: number, frozen = false) {
  const projectDir = join(process.env.FLOWCREW_VITEST_ROOT!, name);
  mkdirSync(projectDir, { recursive: true }); writeFileSync(join(projectDir, path), Buffer.alloc(size, 0x41));
  const created = createRun(projectDir, 'identities', 'name: identities', ['writer'], frozen ? `---\ninputs: [{path: ${path}, frozen: true}]\n---\n` : '');
  return { projectDir, target: join(projectDir, path), context: { frozen: bindFrozenInputs(projectDir, created.runDirPath) } };
}
describe('content comparison and frozen-content reconciliation', () => {
  it('compares identities across metadata churn without changing an earlier observation', () => {
    const { projectDir, target } = fixture('shared-identities', 'model.bin', 1024 * 1024);
    const before = projectContentMembers(projectDir);
    chmodSync(target, 0o600);
    expect(changedContentMembers(before, projectContentMembers(projectDir))).toEqual([]);
    writeFileSync(target, Buffer.alloc(1024 * 1024, 0x42));
    expect(changedContentMembers(before, projectContentMembers(projectDir))).toEqual(['model.bin']);
  });
  it('detects a same-size frozen replacement and reports non-Git bytes unrestored', () => {
    const { projectDir, target, context } = fixture('ignored-project', 'model.bin', 4 * 1024 * 1024, true);
    expect(frozenChanges(projectDir, context.frozen)).toEqual([]);
    writeFileSync(target, Buffer.alloc(4 * 1024 * 1024, 0x42));
    const settled = settleProjectWrites({ projectDir, context, rawWrites: [], appliedWrites: ['model.bin'] });
    expect(settled).toMatchObject({ rolledBackWrites: [], rollbackFailures: ['model.bin'],
      violations: [{ path: 'model.bin', kind: 'immutable_evidence_violation' }] });
    expect(readFileSync(target)[0]).toBe(0x42);
  });
  it('ignores metadata-only churn but never relearns corrupted frozen content on retry', () => {
    const { projectDir, target, context } = fixture('metadata-project', 'weights.bin', 2 * 1024 * 1024, true);
    chmodSync(target, 0o744); const future = new Date(Date.now() + 60_000); utimesSync(target, future, future);
    expect(frozenChanges(projectDir, context.frozen)).toEqual([]);
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x24));
    for (let index = 0; index < 2; index++) {
      const result = settleProjectWrites({ projectDir, context, rawWrites: [], appliedWrites: [] });
      expect(result.rollbackFailures).toEqual(['weights.bin']);
      expect(result.violations).toHaveLength(1);
    }
  });
  it('compares a symlink as a link and separately detects changed referent bytes', () => {
    const { projectDir } = fixture('symlink-project', 'first.txt', 5);
    writeFileSync(join(projectDir, 'second.txt'), 'second'); symlinkSync('first.txt', join(projectDir, 'link.txt'));
    const before = projectContentMembers(projectDir);
    writeFileSync(join(projectDir, 'first.txt'), 'changed');
    expect(changedContentMembers(before, projectContentMembers(projectDir))).toEqual(['first.txt']);
    unlinkSync(join(projectDir, 'link.txt')); symlinkSync('second.txt', join(projectDir, 'link.txt'));
    expect(changedContentMembers(before, projectContentMembers(projectDir))).toContain('link.txt');
  });
});
