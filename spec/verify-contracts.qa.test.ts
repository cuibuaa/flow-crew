import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runShipSetup,
  type GitWorktreeCreator,
} from '../src/cli-ship-setup.js';
import type { ValidationCommandRunner } from '../src/project-validation.js';
import { readGateVerdict } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';

const GATE_ID = 'qa_contract_gate';
const RUN_ID = 'qa-contract-run';

let root: string;
let projectDir: string;
let previousGlobalDir: string;

function writeGateVerdict(value: Record<string, unknown>): void {
  const directory = runDir(projectDir, RUN_ID);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `verdict_${GATE_ID}.json`), `${JSON.stringify(value)}\n`);
}

function writeGateMetric(contents: string): void {
  const directory = join(runDir(projectDir, RUN_ID), 'stages', GATE_ID);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'metric.json'), contents);
}

function writeNodeProject(): void {
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    scripts: { build: 'fixture-build', test: 'vitest run', lint: 'fixture-lint' },
  }));
  writeFileSync(join(projectDir, 'package-lock.json'), '{}');
}

function setupArgs(briefPath: string, targetDir: string): string[] {
  return [
    'ship-setup', '--brief', briefPath, '--project', projectDir,
    '--target', targetDir, '--base', 'fixture-base', '--branch', 'fixture-branch',
  ];
}

function copyManifest(targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(projectDir, 'package.json'), join(targetDir, 'package.json'));
  copyFileSync(join(projectDir, 'package-lock.json'), join(targetDir, 'package-lock.json'));
}

const collectTests: ValidationCommandRunner = (request) => {
  const identities: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.test\.tsx?$/.test(entry.name)) identities.push(path);
    }
  };
  visit(request.cwd);
  return { exitCode: 0, stdout: JSON.stringify(identities.sort().map((file) => ({ file }))) };
};

beforeEach(() => {
  previousGlobalDir = fcGlobalDir();
  root = join(tmpdir(), `flowcrew-verify-contracts-${randomBytes(6).toString('hex')}`);
  projectDir = join(root, 'source');
  setFcGlobalDir(join(root, 'fc-home'));
});

afterEach(() => {
  setFcGlobalDir(previousGlobalDir);
  rmSync(root, { recursive: true, force: true });
});

describe('gate evidence contract QA probe', () => {
  it('accepts a qualitative verdict when no metric file exists', () => {
    writeGateVerdict({ pass: true, reason: 'qualitative evidence is sufficient' });

    expect(readGateVerdict(projectDir, GATE_ID, RUN_ID)).toEqual({
      pass: true,
      reason: 'qualitative evidence is sufficient',
    });
  });

  it('rejects a current passing verdict that contradicts its failing metric', () => {
    writeGateVerdict({ pass: true, reason: 'claimed pass' });
    writeGateMetric(JSON.stringify({ hasMetric: true, metric: 'quality', value: 0, threshold: 1, pass: false }));

    expect(readGateVerdict(projectDir, GATE_ID, RUN_ID)).toEqual({
      pass: false,
      reason: 'verdict/metric.json mismatch: metric says fail, verdict says pass',
    });
  });

  it('names the missing value and threshold when a scored contract has no current numeric evidence', () => {
    writeGateVerdict({ pass: true, metric: 'quality', reason: 'unmeasured claim' });
    writeGateMetric(JSON.stringify({ hasMetric: false, source: { kind: 'engine_attempt_default' } }));

    expect(readGateVerdict(projectDir, GATE_ID, RUN_ID, {
      metric: 'quality', threshold: 7, higherIsBetter: true,
    })).toEqual({
      pass: false,
      reason: expect.stringMatching(/missing required numeric gate value[\s\S]*metric="quality"[\s\S]*threshold=7/),
    });
  });

  it('rejects an overflowing JSON number instead of treating Infinity as finite metric evidence', () => {
    const directory = runDir(projectDir, RUN_ID);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `verdict_${GATE_ID}.json`),
      '{"pass":true,"metric":"quality","value":1e400,"threshold":7}\n',
    );
    writeGateMetric(JSON.stringify({ hasMetric: false, source: { kind: 'engine_attempt_default' } }));

    expect(readGateVerdict(projectDir, GATE_ID, RUN_ID, {
      metric: 'quality', threshold: 7, higherIsBetter: true,
    })).toEqual({
      pass: false,
      reason: expect.stringMatching(/finite numeric|missing required numeric/),
    });
  });
});

describe('launch-workspace population QA probe', () => {
  it('refuses equal-sized source and target populations when their identities differ', async () => {
    writeNodeProject();
    mkdirSync(join(projectDir, 'spec'), { recursive: true });
    writeFileSync(join(projectDir, 'spec', 'source.test.ts'), 'export {};\n');
    const briefPath = join(projectDir, 'brief.md');
    writeFileSync(briefPath, '# Goal\nRun the configured test population.\n');
    const targetDir = join(root, 'target');
    const createWorktree = vi.fn<GitWorktreeCreator>((request) => {
      copyManifest(request.targetDir);
      mkdirSync(join(request.targetDir, 'spec'), { recursive: true });
      writeFileSync(join(request.targetDir, 'spec', 'target.test.ts'), 'export {};\n');
      return { exitCode: 0 };
    });
    const baseline = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0 }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree,
      runTestCollectionCommand: collectTests,
      runValidationCommand: baseline,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'refused',
      testPopulation: {
        state: 'mismatched',
        source: { count: 1 },
        target: { count: 1 },
        missingFromTarget: ['spec/source.test.ts'],
        extraInTarget: ['spec/target.test.ts'],
      },
    });
    expect(baseline).not.toHaveBeenCalled();
  });

  it('refuses a declared target directory that resolves outside the launch workspace', async () => {
    writeNodeProject();
    mkdirSync(join(projectDir, 'tests'), { recursive: true });
    writeFileSync(join(projectDir, 'tests', 'private.test.ts'), 'export {};\n');
    const briefPath = join(projectDir, 'brief.md');
    writeFileSync(briefPath, '---\ninputs:\n  - tests\n---\n# Goal\nRun all tests.\n');
    const targetDir = join(root, 'target');
    const outside = join(root, 'outside-target');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'sentinel.txt'), 'unchanged\n');
    const createWorktree = vi.fn<GitWorktreeCreator>((request) => {
      copyManifest(request.targetDir);
      symlinkSync(outside, join(request.targetDir, 'tests'), 'dir');
      return { exitCode: 0 };
    });
    const baseline = vi.fn<ValidationCommandRunner>(() => ({ exitCode: 0 }));

    const report = await runShipSetup(setupArgs(briefPath, targetDir), {
      createWorktree,
      runTestCollectionCommand: collectTests,
      runValidationCommand: baseline,
      globalDir: () => join(root, 'state'),
    });

    expect(report).toMatchObject({
      state: 'refused',
      blockers: [expect.objectContaining({
        phase: 'target',
        input: 'tests',
        reason: expect.stringContaining('resolves outside the worktree'),
      })],
    });
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf-8')).toBe('unchanged\n');
    expect(baseline).not.toHaveBeenCalled();
  });
});
