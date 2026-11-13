import './test-support/policy-runtime.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import RunDetail from '../ui/src/components/RunDetail.js';
import type { FastifyInstance } from 'fastify';
import { stringify } from 'yaml';
import { cmdState } from '../src/run-state-access.js';
import { createWatchState, pollWatch } from '../src/watch.js';
import { startDashboard } from '../src/dashboard.js';
import { fcGlobalDir, listRuns, readRunState, readStageStatus, runsRoot, setFcGlobalDir } from '../src/store.js';
import { runWorkflow } from './test-support/stage-deadline.js';
import { runRecordPath } from '../src/run-layout.js';
import { WorkflowConfigSchema } from '../src/scheduler.js';
import { stageAttemptLedger, runStatusDescription, runUsageTotal } from '../ui/src/components/run/model.js';
import type { RunDetailData } from '../ui/src/types.js';

// Compatibility checks exercise readers and continuation, with a non-repository
// answer rather than host processes or a model backend.
vi.mock('../src/git-facts.js', async original => ({
  ...await original<typeof import('../src/git-facts.js')>(),
  gitSync: () => { throw Object.assign(new Error('non-repository'), { status: 128 }); },
  gitResultSync: () => ({ status: 128, signal: null, stdout: '', stderr: '' }),
}));

let root: string, project: string, previous: string, app: FastifyInstance | undefined;
const startedAt = '2000-01-01T00:00:00.000Z';
const completedAt = '2000-01-01T00:01:00.000Z';
beforeEach(() => {
  root = mkdtempSync(join(process.env.FLOWCREW_VITEST_ROOT!, 'git-records-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
});
afterEach(async () => {
  await app?.close(); app = undefined;
  setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true });
});

it('reads a literal pre-change record through status, watch, listing and the UI data model without migration', async () => {
  const runId = 'baseline-record', directory = join(runsRoot(), runId);
  mkdirSync(join(directory, 'stages', 'work'), { recursive: true });
  const work = { status: 'complete', retries: 0, tokens_in: 7, tokens_out: 3,
    attempts: [{ index: 1, startedAt, completedAt, status: 'complete', exitCode: 0,
      tokens_in: 7, tokens_out: 3, tokenUsage: 'known' }] };
  // Literal baseline-format bytes: deliberately never passed to today's writer.
  const bytes = JSON.stringify({ runId, projectDir: project, workflowName: 'planner', status: 'complete',
    startedAt, completedAt, stages: { work }, taskDescription: '# Retained result',
    baseCommit: 'a'.repeat(40) });
  writeFileSync(join(directory, 'run.json'), bytes);
  writeFileSync(join(directory, 'stages', 'work', 'status.json'), JSON.stringify(work));
  writeFileSync(join(directory, 'workflow.yaml'), 'name: planner\nstages: [{id: work, role: coder}]\n');
  let output = '', errors = '';
  expect(cmdState(['--project', project, '--run', runId, '--summary'],
    { write: text => { output += text; return true; } }, { write: text => { errors += text; return true; } })).toBe(0);
  expect(errors).toBe(''); expect(JSON.parse(output)).toMatchObject({ run: { runId, status: 'complete' }, stages: { work: { status: 'complete', attempt: 1 } } });
  const runtime = join(root, 'tmp'); mkdirSync(runtime);
  const status = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'),
    new URL('../src/cli.ts', import.meta.url).pathname, 'status', '--project', project], {
    cwd: project, encoding: 'utf8', env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(),
      FLOWCREW_DAEMON_SOCKET: join(root, 'git-facts.sock'), TMPDIR: runtime, TMP: runtime, TEMP: runtime,
      TSX_DISABLE_CACHE: '1', NO_COLOR: '1' },
  });
  expect(status.status, status.stderr).toBe(0); expect(status.stdout).toContain(runId);
  expect(status.stdout).toContain('Retained result');
  const watch = pollWatch(createWatchState(), { runsRoot: runsRoot(), candidateRunIds: () => [runId], nowMs: () => Date.parse(completedAt) });
  expect(watch.stats.readableRuns).toBe(1); expect(watch.stats.unreadableRuns).toBe(0);
  expect(listRuns(project)).toContain(runId);
  app = await startDashboard(project, 0, { listTasks: async () => [], distDir: root });
  const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
  expect(response.statusCode).toBe(200);
  const ui = response.json<RunDetailData>();
  expect(ui).toMatchObject({ runId, status: 'complete', stages: [{ id: 'work', status: 'complete' }] });
  expect(runStatusDescription(ui.status)).toBeTruthy();
  expect(stageAttemptLedger(ui.stages[0]).rows).toHaveLength(1);
  expect(runUsageTotal(ui).tokens).toBe(10);
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(RunDetail, { run: ui })));
  expect(html).toContain('Run result'); expect(html).toContain(runId); expect(html).toContain('work');
  expect(readFileSync(join(directory, 'run.json'), 'utf8')).toBe(bytes);
});

it('resumes a literal pre-change admitted separated run through the scheduler and a stub author', async () => {
  const runId = 'baseline-admitted', directory = join(runsRoot(), runId);
  const brief = '---\ncriteria: [{id: result, text: Complete the admitted work.}]\n---\n# Goal\nComplete the work.\n';
  const workflow = WorkflowConfigSchema.parse({ name: 'baseline-admission', defaults: { max_iterations: 3, max_retries: 0 },
    stages: [{ id: 'work', role: 'coder', depends_on: [], scope: [], prompt_template: 'Complete the admitted work.',
      artifact_contract: { version: 1, produces: [], reads: [] } }] });
  const yaml = stringify(workflow);
  mkdirSync(join(directory, 'engine', 'stages', 'work'), { recursive: true });
  mkdirSync(join(directory, 'work'), { recursive: true });
  const stage = { status: 'failed', retries: 0, attempts: [{ index: 1, status: 'failed', exitCode: 1, startedAt, completedAt, duration_ms: 0 }] };
  writeFileSync(join(directory, 'run.json'), JSON.stringify({ storageLayout: 2, runId, projectDir: project,
    workflowName: workflow.name, status: 'incomplete', startedAt, completedAt, currentIteration: 1, maxIterations: 3, maxRetries: 0,
    taskDescription: brief, briefConfigured: true, stages: { work: stage } }));
  writeFileSync(runRecordPath(directory, 'workflow.yaml'), yaml);
  writeFileSync(runRecordPath(directory, 'task_brief.md'), brief);
  writeFileSync(runRecordPath(directory, 'stages', 'work', 'status.json'), JSON.stringify(stage));
  const calls: string[] = [];
  const role = { name: 'coder', description: '', model: 'fixture', reasoning_effort: 'low', tools: [], prompt: 'Fixture' };
  const result = await runWorkflow(workflow, yaml, project, { capturesInvocationInput: true, async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    return { output: JSON.stringify({ status: 'delivered', summary: 'Admitted work completed.', caveats: [], remaining_work: [], blocks: null }), exitCode: 0, duration_ms: 0 };
  } }, new Map([['coder', role]]), undefined, undefined, runId);
  expect(calls).toEqual(['work']);
  expect(result.runId).toBe(runId); expect(readRunState(project, runId).taskDescription).toBe(brief);
  expect(readStageStatus(project, runId, 'work').attempts).toMatchObject([
    { index: 1, status: 'failed', exitCode: 1 }, { index: 2, status: 'complete', exitCode: 0 },
  ]);
  expect(readFileSync(runRecordPath(directory, 'workflow.yaml'), 'utf8')).toBe(yaml);
  expect(readFileSync(runRecordPath(directory, 'task_brief.md'), 'utf8')).toBe(brief);
});
