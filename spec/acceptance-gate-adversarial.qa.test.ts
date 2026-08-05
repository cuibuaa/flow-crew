import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canResumeOwnGateSession,
  captureRepairRoundSnapshot,
  writeRepairRoundDiffArtifact,
  type StageConfig,
} from '../src/scheduler.js';
import type { StageStatus } from '../src/store.js';

const UUID = '33333333-3333-4333-8333-333333333333';
let root: string;
let project: string;
let runDir: string;

const gate = (isGate = true): StageConfig => ({
  id: 'audit_gate', role: 'qa', scope: [], depends_on: [], prompt_template: '', is_gate: isGate, skills: [],
});
const session = (ownerStageId: string) => ({
  version: 1 as const, sessionId: UUID, ownerStageId, capturedAt: '2026-08-01T00:00:00.000Z',
});
const repair: StageConfig = {
  id: 'repair', role: 'coder', scope: ['src'], depends_on: [], prompt_template: '', is_gate: false, skills: [],
};

function status(writes: string[] = []): StageStatus {
  return {
    status: 'complete', retries: 0,
    attempts: [{ index: 1, startedAt: '2026-08-01T00:00:00.000Z', status: 'complete', writes, writeAttribution: 'structured' }],
  };
}

function artifact(snapshot: ReturnType<typeof captureRepairRoundSnapshot>, writes: string[] = []) {
  const path = writeRepairRoundDiffArtifact({
    snapshot, projectDir: project, runDirPath: runDir, iteration: 1, round: 1,
    repairStages: [repair], statuses: { repair: status(writes) },
  });
  return JSON.parse(readFileSync(path, 'utf8')) as {
    truncated: boolean;
    files: Array<{
      path: string;
      status: string;
      preimageAvailable: boolean;
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

describe('adversarial gate-continuation boundaries', () => {
  it('rejects a same-UUID session owned by another stage', () => {
    expect(canResumeOwnGateSession(gate(), session('builder'), false)).toBe(false);
  });

  it('rejects self continuation for a non-gate stage', () => {
    expect(canResumeOwnGateSession(gate(false), session('audit_gate'), false)).toBe(false);
  });

  it('rejects self continuation after a wrong prior verdict', () => {
    expect(canResumeOwnGateSession(gate(), session('audit_gate'), true)).toBe(false);
  });
});

describe('complete repair diff edge cases', () => {
  it('records deletion of a declared-scope text file with its full preimage', () => {
    const file = join(project, 'src', 'deleted.ts');
    writeFileSync(file, 'export const removed = true;\n');
    const before = captureRepairRoundSnapshot(project, [repair]);
    unlinkSync(file);
    const row = artifact(before).files.find((entry) => entry.path === 'src/deleted.ts');
    expect(row).toMatchObject({ status: 'deleted', preimageAvailable: true, before: { exists: true }, after: { exists: false } });
    expect(row?.before.text).toContain('removed = true');
  });

  it('flags an out-of-scope deletion without pretending its preimage content was captured', () => {
    const file = join(project, 'docs', 'outside.md');
    writeFileSync(file, 'outside preimage\n');
    const before = captureRepairRoundSnapshot(project, [repair]);
    unlinkSync(file);
    const row = artifact(before, ['docs/outside.md']).files.find((entry) => entry.path === 'docs/outside.md');
    expect(row).toMatchObject({ status: 'deleted', preimageAvailable: false, before: { exists: true }, after: { exists: false } });
    expect(row?.before.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.before.text).toBeUndefined();
  });

  it('keeps an unchanged but authoritatively reported path in the diff', () => {
    writeFileSync(join(project, 'src', 'reported.ts'), 'export const same = true;\n');
    const before = captureRepairRoundSnapshot(project, [repair]);
    const row = artifact(before, ['src/reported.ts']).files.find((entry) => entry.path === 'src/reported.ts');
    expect(row).toMatchObject({ status: 'reported-touched', preimageAvailable: true });
  });

  it('records a symlink target change without traversing the link', () => {
    writeFileSync(join(project, 'src', 'one.txt'), 'one\n');
    writeFileSync(join(project, 'src', 'two.txt'), 'two\n');
    const link = join(project, 'src', 'current.txt');
    symlinkSync('one.txt', link);
    const before = captureRepairRoundSnapshot(project, [repair]);
    unlinkSync(link);
    symlinkSync('two.txt', link);
    const row = artifact(before).files.find((entry) => entry.path === 'src/current.txt');
    expect(row).toMatchObject({ status: 'modified', before: { symlink: true, text: 'one.txt' }, after: { symlink: true, text: 'two.txt' } });
  });

  it('records an executable-mode-only change as a touched path', () => {
    const file = join(project, 'src', 'tool.sh');
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o644);
    const before = captureRepairRoundSnapshot(project, [repair]);
    chmodSync(file, 0o755);
    const row = artifact(before).files.find((entry) => entry.path === 'src/tool.sh');
    expect(row).toMatchObject({
      status: 'modified',
      before: { type: 'file', mode: '0644' },
      after: { type: 'file', mode: '0755' },
    });
  });

  it('records a regular-file-to-symlink change even when content hashes coincide', () => {
    const file = join(project, 'src', 'current');
    writeFileSync(file, 'target');
    chmodSync(file, 0o777);
    const before = captureRepairRoundSnapshot(project, [repair]);
    unlinkSync(file);
    symlinkSync('target', file);
    const row = artifact(before).files.find((entry) => entry.path === 'src/current');
    expect(row).toMatchObject({
      status: 'modified',
      before: { type: 'file', mode: '0777' },
      after: { type: 'symlink', mode: '0777', symlink: true },
    });
  });
});
