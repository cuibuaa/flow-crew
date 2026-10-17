import './test-support/policy-runtime.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { PLAN_SCHEMA, RECORDED_PLAN_SCHEMA, renderPlanInterface } from '../src/plan-interface.js';
import { parseStageRecord } from '../src/handoff.js';
import { parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { StageConfigSchema, RecordedStageConfigSchema, RecordedWorkflowConfigSchema, WorkflowConfigSchema, parseDispatchedStageConfig } from '../src/scheduler/sched_admission/configuration.js';
import { loadWorkflow } from '../src/scheduler/sched_admission/dispatch.js';
import { readRunEvents } from '../src/run-events.js';
import { assertContinuationCompatible } from '../src/engine-continuation.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { captureEngineCheckpoint, persistedPlanErrors } from '../src/restart-recovery.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import { TaskRegistry } from '../src/task-registry.js';
import type { SupervisorBackend } from '../src/supervision.js';
import { beginStageAttempt, completeStageAttempt, createRun, fcGlobalDir, readRunState, readStageStatus, updateRunState, writeStageStatus } from '../src/store.js';
import { runWorkflow, readGateVerdict, normalizeStageContracts } from '../src/scheduler.js';
import { prepareWorkflowLaunch, workflowContinuation } from '../src/scheduler/sched_loop/launch.js';
import type { RunOpts, RunResult } from '../src/adapters/base.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
let root: string, project: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fc-single-author-')); project = join(root, 'project'); mkdirSync(project); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function completed(opts: RunOpts, summary: string): RunResult {
  const refs = opts.outputSchema?.anyOf?.[0].properties?.criteria.required ?? [];
  return opts.outputSchema?.anyOf ? { exitCode: 0, duration_ms: 1, output: JSON.stringify({ pass: true, reason: summary,
      criteria: Object.fromEntries(refs.map(id => [id, { status: 'pass', evidence: 'Synthetic fixture evidence.' }])), audit_findings: { version: 1, findings: [] } }) }
    : fixtureResult({ exitCode: 0, output: summary, duration_ms: 1 }, opts) as RunResult;
}
const units: SupervisorBackend = { isActive: async () => ({ kind: 'absent' }), runUnit: async () => { }, stopUnit: async () => { }, journalTail: async () => '' };
describe('single-author admission and historical competition records', () => {
  it.each([true, false, null, {}, 'yes', 2, [], { candidates: 2 }])('S01 refuses an explicit race request before live workflow/dispatch schemas can strip it (%j)', race => {
    const stage = { id: 'work', role: 'coder', race };
    expect(() => StageConfigSchema.parse(stage)).toThrow('race is no longer supported');
    expect(() => parseDispatchedStageConfig(stage)).toThrow('race is no longer supported');
    expect(() => WorkflowConfigSchema.parse({ name: 'fixture', stages: [stage] })).toThrow('race is no longer supported');
    expect(() => WorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'plan', role: 'planner', dynamic_dispatch: true }], dispatch: [stage] })).toThrow('race is no longer supported');
    expect(parseBriefFrontmatter(`---\nrace: ${JSON.stringify(race)}\n---\nTask.`).frontmatterError).toBeUndefined();
    expect(parseBriefFrontmatter(`---\nworkflow: planner\nplan:\n  stages:\n    - id: work\n      race: ${JSON.stringify(race)}\n---\nTask.`).workflowError).toBeUndefined();
  });
  it('S02 removes competition from generation, implementation and public authoring instructions while retaining explicit historical readers', () => {
    const stage = { id: 'work', role: 'coder', race: true };
    expect(() => parseStageRecord(JSON.stringify({ stages: [stage] }), PLAN_SCHEMA)).toThrow('unknown field');
    expect(parseStageRecord(JSON.stringify({ stages: [stage] }), RECORDED_PLAN_SCHEMA)).toMatchObject({ stages: [stage] });
    expect(RecordedStageConfigSchema.parse(stage).race).toBe(true);
    expect(renderPlanInterface()).not.toContain('race');
    const repository = join(import.meta.dirname, '..');
    expect(existsSync(join(repository, 'src/race.ts'))).toBe(false);
    expect(existsSync(join(repository, 'src/scheduler/sched_loop/stage-race.ts'))).toBe(false);
    expect(readFileSync(join(repository, 'assets/architecture.svg'), 'utf8')).not.toMatch(/race|gated fallback/i);
    expect(existsSync(join(repository, 'assets/architecture.png'))).toBe(true);
    expect(readFileSync(join(repository, 'config/agents/planner.yaml'), 'utf8')).not.toMatch(/\brace\b/);
    expect(readFileSync(join(repository, 'src/scheduler/sched_loop/ordinary-stage.ts'), 'utf8')).not.toContain('stage.race');
  });
  it('S05 refuses competition at direct launch even when a caller bypasses the live parser', () => {
    const workflow = RecordedWorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'work', role: 'coder', race: true }] });
    expect(() => prepareWorkflowLaunch(workflow, stringify(workflow), project)).toThrow('race is no longer supported');
  });
  it('S06 the public CLI resumes a cancelled recorded competition as one author', async () => {
    const workflow = RecordedWorkflowConfigSchema.parse({ name: 'legacy', defaults: { max_iterations: 2 }, stages: [
      { id: 'done', role: 'coder', scope: [] },
      { id: 'work', role: 'coder', scope: [], depends_on: ['done'], race: true },
      { id: 'review', role: 'qa', scope: [], depends_on: ['work'], is_gate: true, criterion_refs: ['criterion_acceptance_criteria_1_b3246557'] },
      { id: 'repair', role: 'coder', scope: [], depends_on: ['review'], retry_to: ['review'] },
    ] });
    normalizeStageContracts(workflow.stages);
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    beginStageAttempt(project, created.runId, 'done', 0);
    completeStageAttempt(project, created.runId, 'done', 0, { exitCode: 0, duration_ms: 1 });
    const done = readStageStatus(project, created.runId, 'done');
    beginStageAttempt(project, created.runId, 'work', 0);
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { cwd: project, encoding: 'utf8', timeout: 3000, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() } }).trim());
    updateRunState(project, created.runId, state => {
      recordAdmittedPlan(state, workflow.stages, created.runDirPath, 'Recorded CLI fixture');
      state.engineCheckpoint = { ...captureEngineCheckpoint(project, created.runId), pid: deadPid, processStart: undefined, processes: [] };
      state.currentIteration = 1; state.maxIterations = 2;
      state.taskDescription = '# Goal\nComplete the deterministic recovery demonstration.\n\n# Acceptance criteria\n1. Both configured stages return their completed result.';
    });
    const cancel = new RunCancellationCoordinator({ registry: new TaskRegistry({ baseDir: join(root, 'registry') }), units, timeoutMs: 0, signalGraceMs: 0, runsDir: join(created.runDirPath, '..') });
    expect(await cancel.cancelRun(created.runId)).toMatchObject({ ok: true, status: 'cancelled' });
    const fixtures = join(root, 'fixtures'); mkdirSync(fixtures);
    writeFileSync(join(fixtures, 'work.json'), JSON.stringify({ output_text: JSON.stringify({ status: 'delivered', summary: 'Retained work completed.', checks: [], caveats: [] }) }));
    writeFileSync(join(fixtures, 'review.json'), JSON.stringify({ output_text: JSON.stringify({ pass: true, reason: 'Retained work inspected.',
      criteria: { criterion_acceptance_criteria_1_b3246557: { status: 'pass', evidence: 'The retained predecessor and new work both completed.' } }, audit_findings: { version: 1, findings: [] } }) }));
    const cli = join(import.meta.dirname, '../dist/cli.js');
    execFileSync(process.execPath, [cli, 'quick', '--existing-run-id', created.runId, '--project', project,
      '--adapter', 'mock', '--no-campaign', '--acknowledge-brief-warnings'], {
      cwd: project, encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir(), MOCK_FIXTURE_DIR: fixtures },
    });
    const resumed = readRunState(project, created.runId);
    expect(resumed.status, resumed.failureReason).toBe('complete');
    expect(resumed.stages.done).toEqual(done);
    expect(resumed.stages.work.attempts?.map(attempt => attempt.status)).toEqual(['failed', 'complete']);
    expect(resumed.planControl?.stages.find(stage => stage.id === 'work')?.race).toBe(true);
  });
  it.each(['Run a race between two implementations.', '---\nrace: true\n---\nRun two competing implementations.'])('S03 gives a visible single-author notice for brief requests and runs one author followed by its independent gate (%s)', async (brief) => {
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 1 }, stages: [{ id: 'work', role: 'coder', scope: [] }, { id: 'review', role: 'qa', is_gate: true, depends_on: ['work'], scope: [] }, { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: [] }] });
    const roles = join(root, 'roles');
    mkdirSync(roles);
    for (const name of ['coder', 'qa'])
      writeFileSync(join(roles, `${name}.yaml`), `name: ${name}\nprompt: Fixture.\ntools: []\n`);
    const calls: string[] = [];
    const result = await runWorkflow(workflow, stringify(workflow), project, { async run(prompt, _role, opts) { calls.push(opts.stageId); expect(prompt).toContain('every authoring stage runs one author'); expect(prompt).toContain('Requests in brief text or frontmatter for competing candidates run as single-author work under this notice'); return completed(opts, 'Complete.'); } }, new Map(), undefined, roles, undefined, brief);
    expect(result.status, result.failureReason).toBe('complete');
    expect(calls).toEqual(['work', 'review']);
    expect(readRunEvents(project, result.runId).find(event => event.type === 'execution_notice')?.detail).toContain('every authoring stage runs one author');
    expect(result.stages.work.attempts).toHaveLength(1);
    expect(result.stages.review.attempts).toHaveLength(1);
  });
  it('S04 continues a serialized mid-competition plan after cancellation without erasing artifacts, ownership, gate provenance or completed work', async () => {
    // The deployed record format, with synthetic identities and no provider or personal history.
    const recorded = { name: 'legacy', defaults: { max_iterations: 2 }, stages: [
        { id: 'done', role: 'coder', scope: [] },
        { id: 'accepted', role: 'qa', is_gate: true, depends_on: ['done'], scope: [] },
        { id: 'work', role: 'coder', race: true, depends_on: ['done'], scope: ['work.txt'] },
        { id: 'review', role: 'qa', is_gate: true, depends_on: ['work'], scope: [] },
      ] };
    const bytes = stringify(recorded);
    const fixturePath = join(root, 'recorded-workflow.yaml');
    writeFileSync(fixturePath, bytes);
    expect(() => loadWorkflow(fixturePath)).toThrow('race is no longer supported');
    const workflow = loadWorkflow(fixturePath, true).config;
    expect(RecordedWorkflowConfigSchema.parse(recorded).stages[2].race).toBe(true);
    const created = createRun(project, 'legacy', bytes, workflow.stages.map(stage => stage.id));
    beginStageAttempt(project, created.runId, 'done', 0);
    completeStageAttempt(project, created.runId, 'done', 0, { exitCode: 0, duration_ms: 1 });
    const accepted = { runId: 'historical-child', verdict: { pass: true, reason: 'Independently accepted' } };
    writeStageStatus(project, created.runId, 'accepted', { status: 'complete', retries: 0, acceptedFrom: accepted });
    beginStageAttempt(project, created.runId, 'work', 0);
    const patches = join(created.runDirPath, 'stages/work');
    const patch = 'Retained candidate patch bytes\n';
    const receipt = JSON.stringify({ version: 3, candidates: [{ label: 'A', runId: 'historical-child', status: 'running' }] }) + '\n';
    writeFileSync(join(patches, 'candidate_1_a.patch'), patch);
    writeFileSync(join(patches, 'race_1.json'), receipt);
    writeFileSync(join(project, 'work.txt'), 'retained unfinished work\n');
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { cwd: project, encoding: 'utf8', timeout: 3000, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() } }).trim());
    updateRunState(project, created.runId, state => { recordAdmittedPlan(state, workflow.stages, created.runDirPath, 'Recorded legacy fixture'); state.engineCheckpoint = { ...captureEngineCheckpoint(project, created.runId), pid: deadPid, processStart: undefined, processes: [] }; state.maxIterations = 2; state.currentIteration = 1; });
    const original = readRunState(project, created.runId);
    const originalDone = readStageStatus(project, created.runId, 'done');
    expect(persistedPlanErrors(original)).toEqual([]);
    const cancel = new RunCancellationCoordinator({ registry: new TaskRegistry({ baseDir: join(root, 'registry') }), units, timeoutMs: 0, signalGraceMs: 0, runsDir: join(created.runDirPath, '..') });
    expect(await cancel.cancelRun(created.runId)).toMatchObject({ ok: true, status: 'cancelled' });
    expect(() => assertContinuationCompatible(project, created.runId)).not.toThrow();
    expect(workflowContinuation(readRunState(project, created.runId), project, created.runId).iteration).toBe(1);
    const roles = join(root, 'roles');
    mkdirSync(roles);
    for (const name of ['coder', 'qa'])
      writeFileSync(join(roles, `${name}.yaml`), `name: ${name}\nprompt: Fixture.\ntools: []\n`);
    const calls: string[] = [];
    const resumed = await runWorkflow(workflow, bytes, project, { async run(prompt, _role, opts) { calls.push(opts.stageId); if (opts.stageId === 'work') {
        expect(prompt).toContain('candidate_1_a.patch');
        expect(prompt).toContain('race_1.json');
        expect(readFileSync(join(project, 'work.txt'), 'utf8')).toContain('unfinished');
        writeFileSync(join(project, 'work.txt'), 'completed from retained work\n');
      } return completed(opts, 'Continued.'); } }, new Map(), undefined, roles, created.runId);
    expect(resumed.status, resumed.failureReason).toBe('complete');
    expect(calls).toEqual(['work', 'review']);
    expect(readStageStatus(project, created.runId, 'done')).toEqual(originalDone);
    expect(resumed.stages.accepted.acceptedFrom).toEqual(accepted);
    expect(readGateVerdict(project, 'accepted', created.runId)).toEqual(accepted.verdict);
    expect(resumed.stages.work.attempts?.map(attempt => attempt.status)).toEqual(['failed', 'complete']);
    expect(readFileSync(join(created.runDirPath, 'workflow.yaml'), 'utf8')).toBe(bytes);
    expect(readFileSync(join(patches, 'candidate_1_a.patch'), 'utf8')).toBe(patch);
    expect(readFileSync(join(patches, 'race_1.json'), 'utf8')).toBe(receipt);
    expect(resumed.queryState?.planRevision?.digest).toBe(original.queryState?.planRevision?.digest);
    expect(resumed.planControl?.stages.find(stage => stage.id === 'work')?.race).toBe(true);
  });
});
