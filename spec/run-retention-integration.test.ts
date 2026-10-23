import './test-support/policy-runtime.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import type { RunOpts, RunResult } from '../src/adapters/base.js';
import { startDashboard } from '../src/dashboard.js';
import { createInvocationScratch } from '../src/invocation-scratch.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { captureEngineCheckpoint } from '../src/restart-recovery.js';
import { pruneRunWorkAreas } from '../src/run-retention.js';
import { readRunStateView } from '../src/run-state-view.js';
import { normalizeStageContracts, runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';
import { beginStageAttempt, completeStageAttempt, fcGlobalDir, readStageStatus, updateRunState } from '../src/store.js';
import { fixtureArtifactContract, fixtureResult } from './test-support/declared-dispatch.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { appendPlannerAdmissionContract } from '../src/scheduler/sched_policy/prompt-contracts.js';

let root: string, project: string, roles: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-retention-integration-'));
  project = join(root, 'project');
  roles = join(root, 'roles');
  mkdirSync(project);
  mkdirSync(roles);
  writeFileSync(join(roles, 'coder.yaml'), 'name: coder\nprompt: Complete the fixture duties.\ntools: []\n');
  setEngineDefaults({ default_timeout_ms: 60000, stage_technical_retries: 0 });
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
    produces: [{ id: 'evidence', root: 'run', path: `stages/${stage.id}/evidence`, kind: 'directory', nonempty: false }],
  };
  return workflow;
}

function completed(opts: RunOpts, summary: string): RunResult {
  return fixtureResult({ exitCode: 0, duration_ms: 1, output: summary }, opts) as RunResult;
}

function workspace(runDirectory: string, stage: string) {
  mkdirSync(join(runDirectory, 'stages', stage, 'evidence'), { recursive: true });
  const directory = join(runDirectory, 'stages', stage, 'build');
  mkdirSync(directory, { recursive: true });
  const bulky = join(directory, 'corpus.bin');
  writeFileSync(bulky, Buffer.alloc(1024 * 1024 + 1, 7));
  return { directory, bulky };
}

const storageGuidance = {
  'planner role': () => parse(readFileSync(new URL('../config/agents/planner.yaml', import.meta.url), 'utf8')).prompt as string,
  'planner admission': () => appendPlannerAdmissionContract('', undefined),
};

describe('run retention at scheduler and continuation boundaries', () => {
  it.each(Object.entries(storageGuidance))('%s directs compiler output and caches to disposable scratch, with declared durable products', (_source, prompt) => {
    const text = prompt().replace(/\s+/g, ' ');
    expect(text).toContain('Put compiler output and caches in $TMPDIR');
    expect(text).toMatch(/declare durable run products in artifact_contract\.produces/i);
    expect(text).toMatch(/copy final.*from scratch to those.*paths before finishing/);
    expect(text).not.toContain('stages/<stage-id>/build');
  });

  it.each(Object.entries(storageGuidance))('R30 follows %s build/cache guidance and preserves declared evidence after terminal scratch retirement', async (_source, guidance) => {
    const workflow = workflowFixture();
    // Forward each real planner storage contract as the fixture author's instructions.
    // The deterministic author understands the current destination and the historical
    // stage-build destination, so reverting either contract changes where it writes.
    for (const stage of workflow.stages) stage.prompt_template = guidance();
    let runDirectory = '';
    const scratchFiles: string[] = [];
    const result = await runWorkflow(workflow, stringify(workflow), project, {
      async run(prompt, _role, opts) {
        runDirectory = opts.runDir;
        const scratch = createInvocationScratch(opts.runDir);
        const buildRoot = prompt.includes('stages/<stage-id>/build')
          ? join(opts.runDir, 'stages', opts.stageId, 'build')
          : prompt.includes('Put compiler output and caches in $TMPDIR') ? scratch.path : undefined;
        if (!buildRoot) throw new Error('Fixture author received no compiler/cache destination.');
        const products = opts.stageId === 'done'
          ? ['vite/dist/assets/bundle.js', 'vite/.vite/deps/_metadata.json']
          : ['pytest/.pytest_cache/v/cache/nodeids', 'pytest/__pycache__/test_fixture.pyc'];
        for (const path of products) {
          const file = join(buildRoot, path);
          mkdirSync(join(file, '..'), { recursive: true });
          writeFileSync(file, `${opts.stageId} disposable build/cache fixture`);
          scratchFiles.push(file);
        }
        if (opts.stageId === 'work') {
          expect(scratchFiles.every(file => existsSync(file)), 'scratch remains available until all stages finish').toBe(true);
          expect(readFileSync(join(opts.runDir, 'stages/done/evidence/result.json'), 'utf8')).toContain('true');
        }
        const evidence = join(opts.runDir, 'stages', opts.stageId, 'evidence');
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, 'result.json'), '{"passed":true}\n');
        expect(readdirSync(join(opts.runDir, 'stages', opts.stageId)).filter(name => ['build', 'scratch'].includes(name))).toEqual([]);
        return completed(opts, `${opts.stageId} completed.`);
      },
    }, new Map(), undefined, roles);
    expect(result.status, result.failureReason).toBe('complete');
    expect(scratchFiles.every(file => !existsSync(file))).toBe(true);
    expect(existsSync(join(runDirectory, 'scratch'))).toBe(false);
    for (const stage of ['done', 'work']) {
      expect(readFileSync(join(runDirectory, 'stages', stage, 'evidence/result.json'), 'utf8')).toContain('true');
      expect(existsSync(join(runDirectory, 'stages', stage, 'build'))).toBe(false);
    }
    expect(readFileSync(join(runDirectory, 'summary.md'), 'utf8')).toContain('done completed.');
    const view = readRunStateView(project, result.runId);
    expect(view.run.status).toBe('complete');
    expect(view.stages.done.attempts).toHaveLength(1);
    expect(view.stages.work.attempts).toHaveLength(1);
    expect(view.artifactContracts.map(contract => contract.stageId)).toEqual(expect.arrayContaining(['done', 'work']));
    expect(view.prompts.invocations.map(input => input.record?.stageId)).toEqual(expect.arrayContaining(['done', 'work']));
    expect(view.prompts.legacyInputs).toEqual([]);
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

  it.each(['incomplete', 'cancelled', 'failed'] as const)('R31 a %s run resumes from historical stage work after invocation scratch retirement', async status => {
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
    // Historical build directories are durable; pruning no longer guesses
    // their contents or removes settled predecessor work.
    mkdirSync(predecessor.directory, { recursive: true });
    writeFileSync(predecessor.bulky, Buffer.alloc(1024 * 1024 + 1, 7));
    const plan = pruneRunWorkAreas(created.runDirPath);
    expect(plan.removeBytes).toBe(0);
    expect(existsSync(predecessor.bulky)).toBe(true);
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
