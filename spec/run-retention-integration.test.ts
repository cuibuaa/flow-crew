import './test-support/policy-runtime.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { RunOpts, RunResult } from '../src/adapters/base.js';
import { startDashboard } from '../src/dashboard.js';
import { createInvocationScratch } from '../src/invocation-scratch.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { captureEngineCheckpoint } from '../src/restart-recovery.js';
import { pruneRunWorkAreas } from '../src/run-retention.js';
import { readRunStateView } from '../src/run-state-view.js';
import { normalizeStageContracts, runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { beginStageAttempt, completeStageAttempt, createRun, fcGlobalDir, readStageStatus, updateRunState } from '../src/store.js';
import { fixtureArtifactContract, fixtureResult } from './test-support/declared-dispatch.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

let root: string, project: string, roles: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-retention-integration-'));
  project = join(root, 'project');
  roles = join(root, 'roles');
  mkdirSync(project);
  mkdirSync(roles);
  writeFileSync(join(roles, 'coder.yaml'), 'name: coder\nprompt: Complete the fixture duties.\ntools: []\n');
  setEngineDefaults({ timeout_ms: 60000, stage_technical_retries: 0 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function workflowFixture() {
  const workflow = WorkflowConfigSchema.parse({
    name: 'retention-fixture', defaults: { max_iterations: 2, max_retries: 0 },
    stages: [
      { id: 'done', role: 'coder', scope: [] },
      { id: 'work', role: 'coder', depends_on: ['done'], scope: [] },
    ],
  });
  normalizeStageContracts(workflow.stages);
  for (const stage of workflow.stages) stage.artifact_contract = {
    ...fixtureArtifactContract(stage.id),
    produces: [{ id: 'workspace', root: 'run', path: `stages/${stage.id}/build`, kind: 'directory', nonempty: false }],
  };
  return workflow;
}

function completed(opts: RunOpts, summary: string): RunResult {
  return fixtureResult({ exitCode: 0, duration_ms: 1, output: summary }, opts) as RunResult;
}

function workspace(runDirectory: string, stage: string) {
  const directory = join(runDirectory, 'stages', stage, 'build');
  mkdirSync(directory, { recursive: true });
  const bulky = join(directory, 'corpus.bin');
  writeFileSync(bulky, Buffer.alloc(1024 * 1024 + 1, 7));
  return { directory, bulky };
}

describe('run retention at scheduler and continuation boundaries', () => {
  it('R30 prunes a settled predecessor before its successor runs and preserves readable dashboard records', async () => {
    const workflow = workflowFixture();
    let runDirectory = '';
    let predecessorBulky = '';
    let temporaryFile = '';
    const result = await runWorkflow(workflow, stringify(workflow), project, {
      async run(_prompt, _role, opts) {
        runDirectory = opts.runDir;
        const area = workspace(opts.runDir, opts.stageId);
        if (opts.stageId === 'done') {
          predecessorBulky = area.bulky;
          const evidence = join(area.directory, 'evidence');
          mkdirSync(evidence);
          writeFileSync(join(evidence, 'result.json'), '{"passed":true}\n');
          writeFileSync(join(opts.runDir, 'stages', 'done', 'change.patch'), 'fixture patch\n');
          const scratch = createInvocationScratch(opts.runDir);
          temporaryFile = join(scratch.path, 'temporary.bin');
          writeFileSync(temporaryFile, Buffer.alloc(1024 * 1024 + 1, 8));
        } else {
          expect(existsSync(predecessorBulky), 'settled work must be retired before downstream execution').toBe(false);
          expect(existsSync(temporaryFile), 'run scratch remains available through unfinished stages').toBe(true);
          expect(readFileSync(join(opts.runDir, 'stages/done/build/evidence/result.json'), 'utf8')).toContain('true');
        }
        return completed(opts, `${opts.stageId} completed.`);
      },
    }, new Map(), undefined, roles);
    expect(result.status, result.failureReason).toBe('complete');
    expect(existsSync(join(runDirectory, 'stages/work/build/corpus.bin'))).toBe(false);
    expect(existsSync(join(runDirectory, 'scratch'))).toBe(false);
    expect(readFileSync(join(runDirectory, 'stages/done/change.patch'), 'utf8')).toBe('fixture patch\n');
    expect(readFileSync(join(runDirectory, 'stages/done/build/evidence/result.json'), 'utf8')).toContain('true');
    expect(readFileSync(join(runDirectory, 'summary.md'), 'utf8')).toContain('done completed.');
    const view = readRunStateView(project, result.runId);
    expect(view.run.status).toBe('complete');
    expect(view.stages.done.attempts).toHaveLength(1);
    expect(view.stages.work.attempts).toHaveLength(1);
    expect(view.artifactContracts.map(contract => contract.stageId)).toEqual(expect.arrayContaining(['done', 'work']));
    expect(view.prompts.legacyInputs.map(input => input.stageId)).toEqual(expect.arrayContaining(['done', 'work']));
    expect(view.events.malformedRecords).toBe(0);
    const app = await startDashboard(project, 0, { listTasks: async () => [] });
    try {
      const displayed = await app.inject({ method: 'GET', url: `/api/runs/${result.runId}` });
      expect(displayed.statusCode).toBe(200);
      expect(displayed.json()).toMatchObject({ status: 'complete', stages: expect.arrayContaining([
        expect.objectContaining({ id: 'done', attempts: [expect.objectContaining({ status: 'complete' })] }),
      ]) });
      const output = await app.inject({ method: 'GET', url: `/api/runs/${result.runId}/stages/done/output` });
      expect(output.statusCode).toBe(200);
      expect(output.body).toContain('done completed.');
      const summary = await app.inject({ method: 'GET', url: `/api/tasks/${result.runId}/summary` });
      expect(summary.statusCode).toBe(200);
      expect(summary.json().content).toContain('done completed.');
    } finally { await app.close(); }
  });

  it.each(['incomplete', 'stopped', 'failed'] as const)('R31 a pruned %s run resumes from stage work after invocation scratch retirement', async status => {
    const workflow = workflowFixture();
    const bytes = stringify(workflow);
    const created = createRun(project, workflow.name, bytes, workflow.stages.map(stage => stage.id));
    const predecessor = workspace(created.runDirPath, 'done');
    const unfinished = workspace(created.runDirPath, 'work');
    writeFileSync(join(unfinished.directory, 'resume.txt'), 'retained unfinished experiment\n');
    const scratch = createInvocationScratch(created.runDirPath);
    const temporaryFile = join(scratch.path, 'unfinished.bin');
    writeFileSync(temporaryFile, Buffer.alloc(1024 * 1024 + 1, 9));
    beginStageAttempt(project, created.runId, 'done', 0);
    const done = completeStageAttempt(project, created.runId, 'done', 0, { exitCode: 0, duration_ms: 1 });
    beginStageAttempt(project, created.runId, 'work', 0);
    const failed = completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 1, duration_ms: 1, error: 'Fixture interruption.' });
    writeFileSync(join(created.runDirPath, 'stages/done/output_attempt_1.md'), '{"status":"delivered","summary":"Recorded predecessor.","checks":[],"caveats":[]}');
    writeFileSync(join(created.runDirPath, 'stages/work/output_attempt_1.md'), 'Recorded interrupted experiment.');
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], {
      cwd: project, encoding: 'utf8', timeout: 3000,
      env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() },
    }).trim());
    updateRunState(project, created.runId, state => {
      recordAdmittedPlan(state, workflow.stages, created.runDirPath, 'Recorded retention fixture.');
      state.plan = workflow.stages;
      state.stages.done = done;
      state.stages.work = failed;
      state.engineCheckpoint = { ...captureEngineCheckpoint(project, created.runId), pid: deadPid, processStart: undefined, processes: [] };
      state.currentIteration = 1;
      state.maxIterations = 2;
      state.status = status;
      state.completedAt = new Date().toISOString();
    });
    const before = readStageStatus(project, created.runId, 'done');
    // Populate an archived work area after publication so this exercises the
    // operator command even when terminal publication also retires work.
    mkdirSync(predecessor.directory, { recursive: true });
    writeFileSync(predecessor.bulky, Buffer.alloc(1024 * 1024 + 1, 7));
    const plan = pruneRunWorkAreas(created.runDirPath);
    expect(plan.removeBytes).toBeGreaterThan(1024 * 1024);
    expect(existsSync(predecessor.bulky)).toBe(false);
    expect(existsSync(unfinished.bulky)).toBe(true);
    expect(existsSync(temporaryFile), 'terminal publication retires invocation scratch').toBe(false);
    expect(existsSync(join(created.runDirPath, 'scratch'))).toBe(false);
    const archived = readRunStateView(project, created.runId);
    expect(archived.run.status).toBe(status);
    expect(archived.stages.done).toEqual(before);
    expect(archived.plan.stages).toHaveLength(2);
    const calls: string[] = [];
    const resumed = await runWorkflow(workflow, bytes, project, {
      async run(_prompt, _role, opts) {
        calls.push(opts.stageId);
        expect(opts.stageId).toBe('work');
        expect(readFileSync(join(unfinished.directory, 'resume.txt'), 'utf8')).toContain('unfinished experiment');
        expect(existsSync(temporaryFile)).toBe(false);
        const freshScratch = createInvocationScratch(opts.runDir);
        expect(freshScratch.path).not.toBe(scratch.path);
        const freshPayload = join(freshScratch.path, 'resumed.txt');
        writeFileSync(freshPayload, readFileSync(join(unfinished.directory, 'resume.txt')));
        expect(readFileSync(freshPayload, 'utf8')).toContain('unfinished experiment');
        return completed(opts, 'Resumed retained experiment.');
      },
    }, new Map(), undefined, roles, created.runId);
    expect(resumed.status, resumed.failureReason).toBe('complete');
    expect(calls).toEqual(['work']);
    expect(readStageStatus(project, created.runId, 'done')).toEqual(before);
    expect(resumed.stages.work.attempts?.map(attempt => attempt.status)).toEqual(['failed', 'complete']);
    expect(readFileSync(join(created.runDirPath, 'stages/work/output_attempt_1.md'), 'utf8')).toContain('interrupted experiment');
    expect(readRunStateView(project, created.runId).run.status).toBe('complete');
  });
});
