import { appendEvidence, captureProjectTree, changedTreeFiles, type ProjectTree } from '../src/evidence-ledger.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRepairRoundDiffArtifact, type StageConfig } from '../src/scheduler.js';
import type { StageStatus } from '../src/store.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
let root: string;
let project: string;
let runDir: string;
const repair: StageConfig = {
  id: 'repair', role: 'coder', scope: ['src'], depends_on: [], prompt_template: '', is_gate: false, skills: [],
};

function status(writes: string[] = []): StageStatus {
  return {
    status: 'complete', retries: 0,
    attempts: [{ index: 1, startedAt: '2026-08-01T00:00:00.000Z', status: 'complete', writes, writeAttribution: 'structured' }],
  };
}

function artifact(before: ProjectTree, writes: string[] = []) {
  const after = captureProjectTree(project);
  appendEvidence(runDir, { kind: 'attempt', stageId: 'repair', attemptIndex: 1, attemptStartedAt: '2026-08-01T00:00:00.000Z',
    exitCode: 0, status: 'complete', treeHash: after.hash, files: changedTreeFiles(before, after),
    measurements: { inputTokens: null, outputTokens: null, durationMs: 1, provenance: 'adapter-reported' } });
  const path = writeRepairRoundDiffArtifact({ runDirPath: runDir, iteration: 1, round: 1,
    repairStages: [repair], statuses: { repair: status(writes) },
  });
  return JSON.parse(readFileSync(path, 'utf8')) as {
    truncated: boolean;
    files: Array<{
      path: string;
      status: string;
      before: { exists: boolean; sha256?: string; text?: string; symlink?: boolean; type?: string; mode?: string };
      after: { exists: boolean; sha256?: string; text?: string; symlink?: boolean; type?: string; mode?: string };
    }>;
  };
}

beforeEach(() => {
  root = join(tmpdir(), `flowcrew-e7-qa-${randomBytes(6).toString('hex')}`);
  project = join(root, 'project');
  runDir = join(root, 'run');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'docs'), { recursive: true });
  mkdirSync(runDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('complete repair diff edge cases', () => {
  it('records deletion of a declared-scope text file with its content identity', () => {
    const file = join(project, 'src', 'deleted.ts');
    writeFileSync(file, 'export const removed = true;\n');
    const before = captureProjectTree(project);
    unlinkSync(file);
    const row = artifact(before).files.find((entry) => entry.path === 'src/deleted.ts');
    expect(row).toMatchObject({ status: 'deleted', after: { state: 'absent' } });
  });

  it('reports a deletion outside the estimate with the captured identity', () => {
    const file = join(project, 'docs', 'outside.md');
    writeFileSync(file, 'outside preimage\n');
    const before = captureProjectTree(project);
    unlinkSync(file);
    const row = artifact(before, ['docs/outside.md']).files.find((entry) => entry.path === 'docs/outside.md');
    expect(row).toMatchObject({ status: 'deleted', after: { state: 'absent' } });
  });

  it('does not turn an unchanged reported path into an actual content delta', () => {
    writeFileSync(join(project, 'src', 'reported.ts'), 'export const same = true;\n');
    const before = captureProjectTree(project);
    const row = artifact(before, ['src/reported.ts']).files.find((entry) => entry.path === 'src/reported.ts');
    expect(row).toBeUndefined();
  });

  it('records a symlink target change without traversing the link', () => {
    writeFileSync(join(project, 'src', 'one.txt'), 'one\n');
    writeFileSync(join(project, 'src', 'two.txt'), 'two\n');
    const link = join(project, 'src', 'current.txt');
    symlinkSync('one.txt', link);
    const before = captureProjectTree(project);
    unlinkSync(link);
    symlinkSync('two.txt', link);
    const row = artifact(before).files.find((entry) => entry.path === 'src/current.txt');
    expect(row).toMatchObject({ status: 'changed', after: { type: 'symlink', sha256: sha256('two.txt') } });
  });

  it('records an executable-mode-only change as a touched path', () => {
    const file = join(project, 'src', 'tool.sh');
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o644);
    const before = captureProjectTree(project);
    chmodSync(file, 0o755);
    const row = artifact(before).files.find((entry) => entry.path === 'src/tool.sh');
    expect(row).toMatchObject({
      status: 'changed', mode: 0o755, after: { type: 'file' },
    });
  });

  it('records a regular-file-to-symlink change even when content hashes coincide', () => {
    const file = join(project, 'src', 'current');
    writeFileSync(file, 'target');
    chmodSync(file, 0o777);
    const before = captureProjectTree(project);
    unlinkSync(file);
    symlinkSync('target', file);
    const row = artifact(before).files.find((entry) => entry.path === 'src/current');
    // The point of this case is that `type` carries the change when the content
    // hash cannot. A symlink's own mode is deliberately not asserted: Linux pins
    // it at 0777 regardless of umask, while BSD/macOS gives symlinks real
    // permissions, so an exact value here only tests which kernel ran the suite.
    expect(row).toMatchObject({
      status: 'changed', after: { type: 'symlink' },
    });
    expect(row?.after.sha256).toBe(sha256('target'));
  });
});

it('keeps missing repair execution identities unknown rather than claiming an empty diff', () => {
  const path = writeRepairRoundDiffArtifact({ runDirPath: runDir, iteration: 1, round: 1, repairStages: [], statuses: {} });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ available: false, files: null });
});
