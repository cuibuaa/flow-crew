import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';

const roots: string[] = [];

function fixture(makefile: string, extra?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'engine-boundaries-5-verify-'));
  roots.push(root);
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'reports'));
  writeFileSync(join(root, 'Makefile'), makefile);
  writeFileSync(join(root, 'tests', 'test_ok.py'), 'def test_ok():\n    assert True\n');
  if (extra) writeFileSync(join(root, 'override.mk'), extra);
  writeFileSync(join(root, 'reports', 'replay.md'),
    '# Replay\n\nReplay command: `pytest tests/test_ok.py -q`\n');
  return root;
}

function audit(projectDir: string) {
  return inspectStageArtifactContract({
    stageId: 'work', template: 'Write reports/replay.md.',
    projectDir, runDir: join(projectDir, 'run'), writes: ['reports/replay.md'],
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Makefile replay trust boundary', () => {
  it('recognizes a simple configured recipe', () => {
    const project = fixture('test:\n\tpython3 -m pytest tests/ -q\n');
    const result = audit(project);
    expect(result.replayExecutions[0]).toMatchObject({
      runner: 'pytest', targetPaths: [join(project, 'tests', 'test_ok.py')],
    });
  });

  it('refuses an included Makefile that overrides the inspected test recipe', () => {
    const project = fixture(
      'test:\n\tpython3 -m pytest tests/ -q\ninclude override.mk\n',
      'test:\n\tfalse\n',
    );
    const result = audit(project);
    expect(result.replayExecutions[0].status).toBe('not_run');
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('refuses an environment override of a conditional Python variable', () => {
    const project = fixture('PY ?= python3\ntest:\n\t$(PY) -m pytest tests/ -q\n');
    const previous = process.env.PY;
    try {
      process.env.PY = 'false';
      const result = audit(project);
      expect(result.replayExecutions[0].status).toBe('not_run');
      expect(result.violations.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.PY;
      else process.env.PY = previous;
    }
  });

  it('refuses a higher-priority GNUmakefile recipe', () => {
    const project = fixture('test:\n\tpython3 -m pytest tests/ -q\n');
    writeFileSync(join(project, 'GNUmakefile'), 'test:\n\tfalse\n');
    const result = audit(project);
    expect(result.replayExecutions[0].status).toBe('not_run');
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('refuses inherited pytest options that the targeted replay would clear', () => {
    const project = fixture('test:\n\tpython3 -m pytest tests/ -q\n');
    const previous = process.env.PYTEST_ADDOPTS;
    try {
      process.env.PYTEST_ADDOPTS = '-k no_such_test';
      const result = audit(project);
      expect(result.replayExecutions[0].status).toBe('not_run');
      expect(result.violations.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.PYTEST_ADDOPTS;
      else process.env.PYTEST_ADDOPTS = previous;
    }
  });
});
