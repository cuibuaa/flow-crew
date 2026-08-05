/**
 * Store-level contracts that do not need a scheduler. Kept machine-independent: no child
 * processes, no network, isolated FC_HOME per test (see spec/purity.ts).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, fcGlobalDir, setFcGlobalDir, writeStageOutput } from '../src/store.js';
describe('R02 stage output keeps the attempt it belongs to', () => {
  it('writes an attempt-scoped copy alongside the latest output', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'r02-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'r02-state-'));
    const previous = fcGlobalDir();
    setFcGlobalDir(stateDir);
    try {
      const created = createRun(projectDir, 'r02', 'name: r02\nstages: []\n', ['work']);
      writeStageOutput(projectDir, created.runId, 'work', 'first attempt transcript', 1);
      // A later attempt overwrites `output.md` — that is its documented meaning — but it must
      // not destroy the earlier attempt, which is what a retry is told to read.
      writeStageOutput(projectDir, created.runId, 'work', 'second attempt transcript', 2);
      const dir = join(created.runDirPath, 'stages', 'work');
      expect(readFileSync(join(dir, 'output_attempt_1.md'), 'utf-8')).toBe('first attempt transcript');
      expect(readFileSync(join(dir, 'output_attempt_2.md'), 'utf-8')).toBe('second attempt transcript');
      expect(readFileSync(join(dir, 'output.md'), 'utf-8')).toBe('second attempt transcript');
    } finally {
      setFcGlobalDir(previous);
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('still writes only the latest output when no attempt index is given', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'r02b-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'r02b-state-'));
    const previous = fcGlobalDir();
    setFcGlobalDir(stateDir);
    try {
      const created = createRun(projectDir, 'r02b', 'name: r02b\nstages: []\n', ['work']);
      writeStageOutput(projectDir, created.runId, 'work', 'no index');
      const dir = join(created.runDirPath, 'stages', 'work');
      expect(readFileSync(join(dir, 'output.md'), 'utf-8')).toBe('no index');
      expect(existsSync(join(dir, 'output_attempt_1.md'))).toBe(false);
    } finally {
      setFcGlobalDir(previous);
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
