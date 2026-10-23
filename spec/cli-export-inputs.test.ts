import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { recordInvocationInput, type RunStateView } from '../src/run-state-view.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, writeStageStatus } from '../src/store.js';

let project: string | undefined;
afterEach(() => {
  if (project) rmSync(project, { recursive: true, force: true });
});

it('exports and queries immutable stage inputs without an input.md copy', () => {
  project = mkdtempSync(join(tmpdir(), 'flowcrew-cli-inputs-'));
  const { runId, runDirPath } = createRun(project, 'inputs-fixture', 'name: inputs-fixture\nstages: []\n', ['writer']);
  const startedAt = '2030-01-01T00:00:00.000Z';
  writeStageStatus(project, runId, 'writer', {
    status: 'running', retries: 0, startedAt,
    attempts: [{ index: 1, status: 'running', startedAt }],
  });
  const prompts = ['Original stage task.\n', 'Final stage task.\n\nGuidance: preserve Unicode 🌿 and the trailing newline.\n'];
  for (const [index, userPrompt] of prompts.entries()) {
    recordInvocationInput(runDirPath, {
      runId, stageId: 'writer', attemptIndex: 1, attemptStartedAt: startedAt,
      invocationIndex: index + 1, boundary: 'adapter', adapter: 'fixture', model: 'fixture',
      systemPrompt: 'Fixture role instructions.', userPrompt,
    });
  }
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const invoke = (args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd: project, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: project, FC_HOME: fcGlobalDir() },
  });
  expect(existsSync(join(runDirPath, 'stages', 'writer', 'input.md'))).toBe(false);

  const exported = invoke(['export', runId]);
  expect(exported.error).toBeUndefined();
  expect(exported.status, exported.stderr).toBe(0);
  const bundle = JSON.parse(readFileSync(join(project, `flowcrew-export-${runId}.json`), 'utf8'));
  expect(bundle.stages.writer.input).toBe(prompts[1]);

  const queried = invoke(['state', '--project', project, '--run', runId, '--prompts']);
  expect(queried.error).toBeUndefined();
  expect(queried.status, queried.stderr).toBe(0);
  const state = JSON.parse(queried.stdout) as RunStateView;
  expect(state.prompts.coverage).toBe('recorded');
  expect(state.prompts.invocations.map(({ record }) => record?.userPrompt)).toEqual(prompts);
  expect(state.prompts.invocations.every(({ integrity, attemptBinding }) => integrity === 'verified' && attemptBinding === 'matched')).toBe(true);
  expect(state.prompts.legacyInputs).toEqual([]);
  expect(existsSync(join(runDirPath, 'stages', 'writer', 'input.md'))).toBe(false);
});
