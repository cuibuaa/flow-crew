import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { runWorkflow, StageConfigSchema, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, readRunState, readStageStatus, runDir, setFcGlobalDir } from '../src/store.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let root: string, project: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'repair-plan-revision-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  setEngineDefaults({ gate_retry_loops: 1 });
  writeFileSync(join(project, 'sample.txt'), 'baseline sample\n');
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

async function scenario(options: { denied?: boolean; failed?: boolean; rejectAgain?: boolean; repeat?: boolean; shared?: boolean } = {}) {
  if (options.repeat) setEngineDefaults({ gate_retry_loops: 2 });
  const stage = (id: string, extra: Record<string, unknown> = {}) => StageConfigSchema.parse({
    id, role: 'coder', scope: ['report.txt'], depends_on: [], criterion_refs: [],
    prompt_template: 'Produce the declared outcome.',
    artifact_contract: { version: 1, produces: [], reads: [], groups: [] }, ...extra,
  });
  const workflow = WorkflowConfigSchema.parse({ name: 'repair-plan-revision', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
    stage('author', { scope: ['report.txt', 'sample.txt', 'final.txt'] }),
    stage('review', { role: 'qa', scope: [], depends_on: ['author'], is_gate: true,
      artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_review.json' }], reads: [] } }),
    stage('repair', { depends_on: ['review'], retry_to: ['review'] }),
  ] });
  const agents = new Map<string, AgentConfig>();
  const agentsDir = join(project, 'config/agents'); mkdirSync(agentsDir, { recursive: true });
  for (const name of ['coder', 'qa']) {
    const role = { name, description: 'Fixture', model: 'fixture-local', reasoning_effort: 'default', tools: [], prompt: 'Local fixture.' };
    agents.set(name, role); writeFileSync(join(agentsDir, name + '.yaml'), stringify(role));
  }
  const calls: string[] = [];
  let round = 0;
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    calls.push(opts.stageId);
    const writes: string[] = [];
    let output = 'Local fixture completed.', exitCode = 0;
    if (opts.stageId === 'author') {
      writeFileSync(join(project, 'report.txt'), 'Needs measurement.\n'); writes.push('report.txt');
    } else if (opts.stageId === 'repair') {
      round++;
      const state = readRunState(project, basename(opts.runDir));
      const attempt = readStageStatus(project, state.runId, 'repair').attempts!.at(-1)!;
      const shared = options.shared ? ['report.txt'] : [];
      const measure = stage('measure', { scope: [options.denied ? 'outside.txt' : 'sample.txt', ...shared], depends_on: ['review', 'repair'], retry_to: ['review'] });
      const publish = stage('publish', { scope: ['final.txt', ...shared], depends_on: ['review', 'measure'], retry_to: ['review'] });
      if (round === 1) writeFileSync(join(opts.runDir!, 'stages/repair/plan_revision_request.json'), JSON.stringify({
        version: 1, requestId: 'measurement_continuation', runId: state.runId, stageId: 'repair',
        attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt,
        baseRevision: state.queryState!.planRevision!.revision, baseDigest: state.queryState!.planRevision!.digest,
        reason: 'Finish the missing measurements before the same independent review.',
        stages: [...state.planControl!.stages, measure, publish],
      }));
      if (options.repeat) await new Promise(resolve => setTimeout(resolve, 30));
      writeFileSync(join(project, 'report.txt'), options.repeat ? `Repair ${round}.\n` : 'Repair prepared.\n'); writes.push('report.txt');
    } else if (opts.stageId === 'measure') {
      expect(calls.filter(id => id === 'repair')).toHaveLength(round);
      expect(readFileSync(join(project, 'report.txt'), 'utf8')).toBe(options.repeat ? `Repair ${round}.\n` : 'Repair prepared.\n');
      if (options.repeat) await new Promise(resolve => setTimeout(resolve, 20));
      writeFileSync(join(project, 'sample.txt'), options.repeat ? `measured ${round}\n` : 'measured\n'); writes.push('sample.txt');
      if (options.failed) exitCode = 7;
    } else if (opts.stageId === 'publish') {
      expect(readFileSync(join(project, 'sample.txt'), 'utf8')).toBe(options.repeat ? `measured ${round}\n` : 'measured\n');
      writeFileSync(join(project, 'final.txt'), 'measurement reported\n'); writes.push('final.txt');
    } else if (opts.stageId === 'review') {
      const pass = existsSync(join(project, 'final.txt')) && !options.rejectAgain && (!options.repeat || round === 2);
      output = JSON.stringify({ pass, reason: pass ? 'Measurement independently verified.' : 'Required measured outcome remains unverified.',
        criteria: {}, audit_findings: { version: 1, findings: [] },
        ...(!pass ? { repairability: { version: 1, disposition: 'repairable', evidence: 'Complete measurement and return to this review.' } } : {}) });
    }
    return fixtureResult({ output, exitCode, duration_ms: 1, writes, writeAttribution: 'structured' }, opts);
  } };
  const state = await runWorkflow(workflow, stringify(workflow), project, adapter, agents, undefined, agentsDir, undefined, undefined, true);
  const directory = runDir(project, state.runId);
  const decisionPath = join(directory, 'stages/repair/plan_revision_decision_measurement_continuation.json');
  return { state, calls, directory, decision: existsSync(decisionPath) ? JSON.parse(readFileSync(decisionPath, 'utf8')) : undefined };
}

it('admits and finishes dependent repair slices at the last repair boundary before re-review', async () => {
  const result = await scenario();
  expect(result.decision).toMatchObject({ accepted: true, revision: 1 });
  expect(result.state.status, result.state.failureReason).toBe('complete');
  expect(result.calls).toEqual(['author', 'review', 'repair', 'measure', 'publish', 'review']);
  const archive = join(result.directory, 'gate_reevaluation/iteration_1/round_1');
  expect(JSON.parse(readFileSync(join(archive, 'rejected_verdict_review.json'), 'utf8')).pass).toBe(false);
  const diff = JSON.parse(readFileSync(join(archive, 'repair_diff.json'), 'utf8'));
  expect(diff.repairStageIds).toEqual(['repair', 'measure', 'publish']);
  expect(diff.effectiveScopes).toEqual(Object.fromEntries(result.state.planControl!.stages
    .filter(stage => diff.repairStageIds.includes(stage.id)).map(stage => [stage.id, stage.scope ?? []])));
  expect(diff.files.find((file: { path: string }) => file.path === 'sample.txt')).toMatchObject({ before: { sha256: sha256('baseline sample\n') }, after: { sha256: sha256('measured\n') } });
  expect(diff.files.find((file: { path: string }) => file.path === 'final.txt')).toMatchObject({ before: { exists: false }, after: { sha256: sha256('measurement reported\n') } });
});

it('admits changed path estimates without a capability-union veto', async () => {
  const result = await scenario({ denied: true });
  expect(result.decision).toMatchObject({ accepted: true });
  expect(result.decision.errors).toEqual([]);
  expect(result.state.queryState!.planRevision!.revision).toBe(1);
});

it('does not release a failed slice to its successor or re-review', async () => {
  const result = await scenario({ failed: true });
  expect(result.decision.accepted).toBe(true);
  expect(result.state.status).not.toBe('complete');
  expect(result.calls).toEqual(['author', 'review', 'repair', 'measure']);
  expect(result.state.stages.measure.exitCode).toBe(7);
  expect(result.state.stages.publish.attempts ?? []).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(result.directory, 'verdict_review.json'), 'utf8')).pass).toBe(false);
});

it('preserves the same gate and repair budget when review rejects the measured result', async () => {
  const result = await scenario({ rejectAgain: true });
  expect(result.decision.accepted).toBe(true);
  expect(result.state.status).toBe('incomplete');
  expect(result.calls).toEqual(['author', 'review', 'repair', 'measure', 'publish', 'review']);
  expect(result.state.stages.repair.attempts).toHaveLength(1);
  expect(result.state.stages.review.attempts).toHaveLength(2);
});

it.each([false, true])('reruns dependent repair work with current inputs and fresh guard preimages (shared scopes: %s)', async shared => {
  const result = await scenario({ repeat: true, shared });
  expect(result.state.status, result.state.failureReason).toBe('complete');
  expect(result.calls).toEqual(['author', 'review', 'repair', 'measure', 'publish', 'review', 'repair', 'measure', 'publish', 'review']);
  expect(result.state.stages.repair.attempts).toHaveLength(2);
  expect(result.state.stages.review.attempts).toHaveLength(3);
  expect(readFileSync(join(project, 'sample.txt'), 'utf8')).toBe('measured 2\n');
  const diff = JSON.parse(readFileSync(join(result.directory, 'gate_reevaluation/iteration_1/round_2/repair_diff.json'), 'utf8'));
  expect(diff.repairStageIds).toEqual(['repair', 'measure', 'publish']);
  expect(diff.effectiveScopes).toEqual(Object.fromEntries(result.state.planControl!.stages
    .filter(stage => diff.repairStageIds.includes(stage.id)).map(stage => [stage.id, stage.scope ?? []])));
  expect(diff.files.find((file: { path: string }) => file.path === 'sample.txt')).toMatchObject({ before: { sha256: sha256('measured 1\n') }, after: { sha256: sha256('measured 2\n') } });
  for (const id of ['repair', 'measure', 'publish']) {
    const audit = JSON.parse(readFileSync(join(result.directory, `stages/${id}/constraint_audit_attempt_2.json`), 'utf8'));
    expect(audit.violations).toEqual([]);
    expect(audit).not.toHaveProperty('liveIncidents');
    expect(audit.rolledBackWrites).toEqual([]);
  }
});
