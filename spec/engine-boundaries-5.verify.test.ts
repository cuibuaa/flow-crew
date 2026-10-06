import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { configuredPytest } from '../src/declared-replay-config.js';
import { verifyStageArtifactContract } from '../src/stage-artifact-contract.js';

const roots: string[] = [];

function fixture(makefile: string, extra?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'engine-boundaries-5-verify-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(join(project, 'tests'), { recursive: true });
  mkdirSync(join(root, 'run'));
  writeFileSync(join(project, 'Makefile'), makefile);
  writeFileSync(join(project, 'tests', 'test_ok.py'), 'def test_ok():\n    assert True\n');
  if (extra) writeFileSync(join(project, 'override.mk'), extra);
  return project;
}

function audit(projectDir: string) {
  return verifyStageArtifactContract({
    stageId: 'work', template: 'Verify the declared target.', projectDir, runDir: join(projectDir, '..', 'run'),
    artifactContract: ArtifactContractSchema.parse({ version: 1, produces: [],
      reads: [{ id: 'target', root: 'project', path: 'tests/test_ok.py', source: { kind: 'input' } }],
      replays: [{ id: 'evidence', runner: 'pytest', targets: ['target'], argv: ['-q'],
        expected: { exit_code: 0, failures: [] } }],
    }),
  }, { remainingMs: () => 30_000 });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Makefile replay trust boundary', () => {
  it('recognizes a simple configured recipe for the exact declared target', async () => {
    const project = fixture('test:\n\tpython3 -m pytest tests/ -q\n');
    expect(configuredPytest(project)).toEqual({ pythonExecutable: 'python3', environment: {}, fromMakefile: true });
    const result = await audit(project);
    expect(result.replayExecutions[0]).toMatchObject({
      runner: 'pytest', targetPaths: [join(project, 'tests', 'test_ok.py')],
    });
  });

  it('refuses an included Makefile that overrides the inspected test recipe', async () => {
    const project = fixture(
      'test:\n\tpython3 -m pytest tests/ -q\ninclude override.mk\n',
      'test:\n\tfalse\n',
    );
    const result = await audit(project);
    expect(result.replayExecutions[0].status).toBe('not_run');
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('refuses an environment override of a conditional Python variable', async () => {
    const project = fixture('PY ?= python3\ntest:\n\t$(PY) -m pytest tests/ -q\n');
    const previous = process.env.PY;
    try {
      process.env.PY = 'false';
      const result = await audit(project);
      expect(result.replayExecutions[0].status).toBe('not_run');
      expect(result.violations.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.PY;
      else process.env.PY = previous;
    }
  });

  it('refuses a higher-priority GNUmakefile recipe', async () => {
    const project = fixture('test:\n\tpython3 -m pytest tests/ -q\n');
    writeFileSync(join(project, 'GNUmakefile'), 'test:\n\tfalse\n');
    const result = await audit(project);
    expect(result.replayExecutions[0].status).toBe('not_run');
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('refuses inherited pytest options that the targeted replay would clear', async () => {
    const project = fixture('test:\n\tpython3 -m pytest tests/ -q\n');
    const previous = process.env.PYTEST_ADDOPTS;
    try {
      process.env.PYTEST_ADDOPTS = '-k no_such_test';
      const result = await audit(project);
      expect(result.replayExecutions[0].status).toBe('not_run');
      expect(result.violations.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.PYTEST_ADDOPTS;
      else process.env.PYTEST_ADDOPTS = previous;
    }
  });
});
