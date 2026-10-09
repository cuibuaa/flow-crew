import { fixtureResult } from './test-support/declared-dispatch.js';
import { artifacts, stageArtifacts  } from './spec_contracts/declared-fixtures.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as yaml } from 'yaml';
import type { Adapter, AgentConfig, RunOpts } from '../src/adapters/base.js';
import { ArtifactContractSchema, inspectArtifactDeclarations, resolveArtifactLocation } from '../src/artifact-declarations.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { inspectDispatchAdmission, inspectRealityCheckReachability, parseDispatchedStageConfig, runWorkflow, StageConfigSchema, type StageConfig } from '../src/scheduler.js';
import { applyPlanRevision, planDigest, recordAdmittedPlan } from '../src/plan-revisions.js';
import { AuditFindingsSchema } from '../src/scoped-audit-repair.js';
import { engineGeneration, reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { readHostBootId } from '../src/restart-recovery.js';
import { readRunStateView } from '../src/run-state-view.js';
import { cmdState } from '../src/run-state-access.js';
import { startDashboard } from '../src/dashboard.js';
import { runStage } from '../src/worker.js';
import { beginStageAttempt, createRun, fcGlobalDir, readRunState, readStageStatus, runDir, setFcGlobalDir, updateRunState, writeStageStatus, type StoreState } from '../src/store.js';
import { parseChecksFromMarkdown } from '../src/reality-gate/index.js';

let root: string, project: string, previousStore: string, runId: string, directory: string;
const empty = () => ArtifactContractSchema.parse({ replays: [], version: 1, produces: [], reads: [] });
function write(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function stage(id: string, extra: Partial<StageConfig> = {}): StageConfig {
  return StageConfigSchema.parse({ criterion_refs: [], id, role: 'coder', scope: ['docs/**'], depends_on: [], dependency_reasons: {}, prompt_template: 'Do the declared work.', artifact_contract: stageArtifacts(id, extra.is_gate === true), ...extra });
}
function agent(name = 'coder'): AgentConfig { return { name, description: name, model: 'fixture-unchanged-model', reasoning_effort: 'default', tools: [], prompt: 'Rendered system instructions.' }; }
function configuredAgents(): Map<string, AgentConfig> {
  const agents = new Map<string, AgentConfig>();
  for (const name of ['coder', 'planner', 'qa']) { const role = agent(name); agents.set(name, role); write(join(project, 'config', 'agents', `${name}.yaml`), yaml(role)); }
  write(join(project, 'config', 'defaults.yaml'), yaml({ default_timeout_ms: 10000, default_max_iterations: 1, default_stage_technical_retries: 0, default_gate_retry_loops: 2 }));
  return agents;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-principles-integration-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['writer', 'pending', 'gate']).runId;
  directory = runDir(project, runId);
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

describe('declared artifacts replace prose authority for versioned stages', () => {
  it('admits a framework read by its exact artifact key and confined location', () => {
    write(join(directory, 'task_brief.md'), 'The exact framework brief.');
    const artifactContract = ArtifactContractSchema.parse({ replays: [], version: 1, produces: [], reads: [{ id: 'task', root: 'run', path: 'task_brief.md', source: { kind: 'framework', artifact: 'task_brief' } }] });
    expect(inspectArtifactDeclarations({ stages: [stage('writer', { artifact_contract: artifactContract })], scopeOwns: () => true, projectDir: project, runDir: directory })).toEqual([]);
    expect(() => ArtifactContractSchema.parse({ replays: [], version: 1, produces: [], reads: [{ id: 'task', root: 'run', path: 'task_brief.md', source: { kind: 'framework', name: 'task_brief' } }] })).toThrow();
  });

  it('refuses malformed versions, duplicate group members and traversal, including physical escapes', () => {
    expect(() => ArtifactContractSchema.parse({ replays: [], version: 2, produces: [], reads: [] })).toThrow();
    expect(() => ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'a', root: 'run', path: 'a.md' }], reads: [], groups: [{ id: 'outcome', mode: 'exactly_one', members: ['a', 'a'] }] })).toThrow();
    expect(() => ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'a', root: 'run', path: '../a.md' }], reads: [] })).toThrow();
    mkdirSync(join(root, 'outside')); symlinkSync(join(root, 'outside'), join(project, 'alias'));
    expect(() => resolveArtifactLocation({ root: 'project', path: 'alias/output.md' }, project, directory)).toThrow('ARTIFACT_PATH_ESCAPE');
  });

  it('admission refuses an unbound read and an output outside scope', () => {
    const candidate = stage('writer', { scope: [], artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'report', root: 'project', path: 'docs/report.md' }], reads: [{ id: 'input', root: 'project', path: 'docs/unowned.md', source: { kind: 'stage', stage: 'missing', artifact: 'report' } }] }) });
    const report = inspectDispatchAdmission({ dispatched: [candidate], baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory });
    expect(report.errors.some((entry) => entry.includes('ARTIFACT_OUTPUT_OUTSIDE_SCOPE'))).toBe(true);
    expect(report.errors.some((entry) => entry.includes('ARTIFACT_READ_UNBOUND'))).toBe(true);
    expect(inspectArtifactDeclarations({ stages: [stage('old', { artifact_contract: undefined })], scopeOwns: () => true })[0]).toContain('ARTIFACT_DECLARATION_REQUIRED');
  });

  it('refuses concurrent run-output owners and engine control outputs', () => {
    const contract = ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'evidence', root: 'run', path: 'evidence.json' }], reads: [] });
    const parallel = [stage('first', { artifact_contract: contract }), stage('second', { artifact_contract: contract })];
    expect(inspectArtifactDeclarations({ stages: parallel, scopeOwns: () => true }).some((error) => error.includes('ARTIFACT_OUTPUT_CONCURRENT_OWNERS'))).toBe(true);
    parallel[1] = stage('second', { depends_on: ['first'], artifact_contract: contract });
    expect(inspectArtifactDeclarations({ stages: parallel, scopeOwns: () => true })).toEqual([]);
    for (const path of ['run.json', 'task_brief.md', 'signals/abort_peer.json', 'audit_findings/rejected.json']) {
      const artifact_contract = ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'bad', root: 'run', path }], reads: [] });
      expect(inspectArtifactDeclarations({ stages: [stage('writer', { artifact_contract })], scopeOwns: () => true })[0]).toContain('ARTIFACT_FRAMEWORK_PATH');
    }
  });

  it('reality reads survive normalization and explicit unreachable input remains refused', () => {
    const markdown = '## Reality checks\n```yaml\n' + yaml({ checks: [{ name: 'check', type: 'exec-script-exit-zero', reads: [{ id: 'report', root: 'project', path: 'docs/unowned.md', source: { kind: 'stage', stage: 'writer', artifact: 'report' } }], params: { script: 'echo "message\\u002ffile.md"' } }] }) + '```\n';
    expect(parseChecksFromMarkdown(markdown)[0]).toHaveProperty('reads');
    expect(inspectRealityCheckReachability({ markdown, projectDir: project, stages: [stage('writer')] }).join(';')).toContain('ARTIFACT_READ_UNREACHABLE');
    const advisory = '## Reality checks\n```yaml\n' + yaml({ checks: [{ name: 'message', type: 'exec-script-exit-zero', reads: [], params: { script: 'echo "message\\u002ffile.md"' } }] }) + '```\n';
    expect(inspectRealityCheckReachability({ markdown: advisory, projectDir: project, stages: [] })).toEqual([]);
    expect(parseChecksFromMarkdown('## Reality checks\n```yaml\nchecks: []')[0]).toHaveProperty('kind', 'invalid');
  });
});

function initializeRevision(): { stages: StageConfig[]; request: Record<string, unknown> } {
  const stages = [stage('writer'), stage('pending', { depends_on: ['writer'], dependency_reasons: { writer: 'Uses outcome' } })];
  const startedAt = new Date().toISOString();
  const status = { status: 'complete' as const, retries: 0, attempts: [{ index: 1, startedAt, completedAt: new Date().toISOString(), status: 'complete' as const, exitCode: 0 }] };
  writeStageStatus(project, runId, 'writer', status);
  const state = updateRunState(project, runId, (state) => { state.stages.writer = status; recordAdmittedPlan(state, stages, directory, 'admitted fixture', true); });
  return { stages, request: { version: 1, requestId: 'revision_1', runId, stageId: 'writer', attemptIndex: 1, attemptStartedAt: startedAt, baseRevision: state.queryState!.planRevision!.revision, baseDigest: planDigest(stages), reason: 'Outcome needs another stage', stages: [...stages, stage('extra', { depends_on: ['writer'], dependency_reasons: { writer: 'Uses settled outcome' } })] } };
}
function revise(request: unknown) {
  return applyPlanRevision({ projectDir: project, runId, request, parseStage: parseDispatchedStageConfig,
    admit: (stages) => inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory }),
    scopeContained: (scope, capabilities) => capabilities.includes(scope),
  });
}
describe('whole-plan admission at each revision', () => {
  it('extends once, retains immutable plan history and rejects stale/conflicting requests', () => {
    const { request } = initializeRevision(); const after = revise(request);
    expect(after.decision.accepted).toBe(true); expect(after.state.queryState!.planHistory).toHaveLength(2);
    expect(after.state.stages.writer.status).toBe('complete'); expect(after.state.stages.extra.status).toBe('pending');
    expect(revise(request).decision).toEqual(after.decision);
    expect(() => revise({ ...request, reason: 'ID collision' })).toThrow('PLAN_REVISION_REQUEST_CONFLICT');
    expect(revise({ ...request, requestId: 'stale' }).decision.errors.join(';')).toContain('PLAN_REVISION_STALE');
    expect(existsSync(join(directory, after.state.queryState!.planRevision!.path!))).toBe(true);
  });
  it.each(['executed', 'scope', 'cycle', 'removed', 'malformed_contract', 'binding'])('refuses %s change without changing the admitted plan', (kind) => {
    const { request, stages } = initializeRevision();
    const extra = stage('extra');
    if (kind === 'executed') stages[0] = { ...stages[0], prompt_template: 'different executed work' };
    if (kind === 'scope') extra.scope = ['elsewhere/**'];
    if (kind === 'cycle') { extra.depends_on = ['extra']; extra.dependency_reasons = { extra: 'cycle' }; }
    if (kind === 'malformed_contract') extra.artifact_contract = {version:2,produces:[],reads:[]} as typeof extra.artifact_contract;
    const after = revise({ ...request, ...(kind === 'binding' ? { attemptIndex: 2 } : {}), stages: [...(kind === 'removed' ? stages.slice(0, 1) : stages), extra] });
    expect(after.decision.accepted).toBe(false); expect(after.decision.errors.length).toBeGreaterThan(0);
    expect(after.state.queryState!.planHistory).toHaveLength(1); expect(after.state.stages.extra).toBeUndefined();
  });
});

describe('worker state, invocation capture and engine resources', () => {
  it('refuses malformed resource paths, duplicate cards and empty declarations at admission', () => {
    for (const resources of [{ gpu_cards: [], disk: [] }, { gpu_cards: ['card', 'card'] }, { disk: [{ root: 'project', path: '../other', bytes: 1 }] }]) {
      expect(() => StageConfigSchema.parse({ criterion_refs: [], artifact_contract: artifacts([], [], [], []), id: 'writer', role: 'coder', resources })).toThrow();
    }
  });
  it('captures exact final role and user input, including adapter internal retries', async () => {
    let received = '', suppliedSystem = '';
    const adapter: Adapter = { async run(prompt, role, opts) {
      received = prompt; suppliedSystem = role.prompt;
      opts.onInvocationInput?.({ userPrompt: prompt, systemPrompt: role.prompt, transport: { kind: 'stdin', payload: prompt } });
      opts.onInvocationInput?.({ userPrompt: `${prompt}\ninternal retry`, systemPrompt: role.prompt });
      return fixtureResult({ output: 'done', exitCode: 0, duration_ms: 1 }, opts);
    } };
    await runStage(adapter, { stageId: 'writer', role: agent(), dependsOn: [], promptTemplate: 'Do the declared work.', artifactContract: empty(), timeout_ms: 10000, projectDir: project, runId, runDir: directory, retries: 0 });
    const view = readRunStateView(project, runId, { includePromptText: true });
    expect(received).toContain('# Engine state query'); expect(view.prompts.invocations).toHaveLength(3);
    expect(view.prompts.invocations[0].record).toMatchObject({ userPrompt: received, systemPrompt: suppliedSystem });
    expect(view.prompts.invocations[2].record?.userPrompt).toBe(`${received}\ninternal retry`);
    expect(view.prompts.invocations.every((entry) => entry.attemptBinding === 'matched')).toBe(true);
    let output = ''; expect(cmdState(['state', '--project', project, '--run', runId, '--prompts'], { write: (text: string) => { output += text; return true; } })).toBe(0);
    expect(JSON.parse(output).prompts.invocations[0].record.userPrompt).toBe(received);
  });

});

describe('proven restart recovery', () => {
  it('reconciles a prior-boot interruption through the public resume entry without editing its run state', async () => {
    const agents = configuredAgents(); let calls = 0;
    const workflow = { name: 'resume', description: 'Resume fixture', defaults: { max_iterations: 4 }, stages: [stage('writer')] };
    runId = createRun(project, 'resume', yaml(workflow), ['writer']).runId;
    directory = runDir(project, runId);
    updateRunState(project, runId, (state) => { recordAdmittedPlan(state, workflow.stages, directory, 'Authentic one-stage checkpoint fixture', true, inspectDispatchAdmission({ dispatched: workflow.stages, baseStages: [], dispatchStageId: 'plan', projectDir: project, runDir: directory })); });
    beginStageAttempt(project, runId, 'writer', 0);
    updateRunState(project, runId, (state) => { state.currentIteration = 2; state.maxIterations = 4; state.engineCheckpoint = { version: 1, runId, projectDir: project, bootId: 'prior-owned-fixture-boot', generation: engineGeneration(), pid: 99999999, at: new Date().toISOString() }; state.stages.writer = readStageStatus(project, runId, 'writer'); });
    const adapter: Adapter = { async run(_prompt, _role, opts) { if (opts.stageId === 'writer') calls++; return fixtureResult({ output: 'resumed', exitCode: 0, duration_ms: 1, tokens_in: 7, tokens_out: 3 }, opts); } };
    const result = await runWorkflow(workflow, yaml(workflow), project, adapter, agents, undefined, undefined, runId);
    expect(result.status).toBe('complete'); expect(calls).toBe(1); expect(result.currentIteration).toBe(2); expect(result.maxIterations).toBe(4);
    expect(result.stages.writer.attempts?.[0]).toMatchObject({ status: 'failed', exitCode: 143 });
    const settled = readRunState(project, runId);
    expect(settled.auxiliaryAttempts?._summary).toBeUndefined();
    expect(readFileSync(join(directory, 'summary.md'), 'utf8')).toContain('writer: delivered — resumed');
    const view = readRunStateView(project, runId, { includePromptText: true });
    expect(view.prompts.invocations.some((entry) => entry.record?.stageId === '_summary')).toBe(false);
    expect(view.prompts.invocations.some((entry) => entry.record?.stageId === 'writer' && entry.integrity === 'verified' && entry.attemptBinding === 'matched')).toBe(true);
  });
  it('refuses same-boot unknown consumers through the public resume entry before invoking an adapter', async () => {
    const agents = configuredAgents(); let calls = 0;
    beginStageAttempt(project, runId, 'writer', 0);
    updateRunState(project, runId, (state) => { state.engineCheckpoint = { version: 1, runId, projectDir: project, bootId: readHostBootId(), generation: engineGeneration(), pid: 99999999, at: new Date().toISOString() }; state.stages.writer = readStageStatus(project, runId, 'writer'); });
    const workflow = { name: 'resume', description: 'Unknown-consumer fixture', defaults: { max_iterations: 1 }, stages: [stage('writer')] };
    const adapter: Adapter = { async run(_record0, _record1, recordOpts: import("../src/adapters/base.js").RunOpts) { calls++; return fixtureResult({ output: 'unsafe', exitCode: 0, duration_ms: 1 }, recordOpts); } };
    await expect(runWorkflow(workflow, yaml(workflow), project, adapter, agents, undefined, undefined, runId)).rejects.toThrow('RECOVERY_FATE_UNKNOWN');
    expect(calls).toBe(0); expect(readRunState(project, runId).recovery?.kind).toBe('blocked');
  });
  it('preserves work, closes interrupted attempts as infrastructure failures and resumes the same budget', () => {
    beginStageAttempt(project, runId, 'writer', 0);
    updateRunState(project, runId, (state) => { state.engineCheckpoint = { version: 1, runId, projectDir: project, bootId: 'previous-test-boot', generation: engineGeneration(), pid: 99999999, at: new Date().toISOString() }; state.currentIteration = 2; state.maxIterations = 4; state.stages.writer = readStageStatus(project, runId, 'writer'); });
    const after = reconcileHostInterruptedRun(project, runId, { currentBootId: 'new-test-boot', currentGeneration: engineGeneration() });
    expect(after.status).toBe('parked'); expect(after.recovery?.kind).toBe('resumable'); expect(after.currentIteration).toBe(2); expect(after.maxIterations).toBe(4);
    expect(after.stages.writer.status).toBe('pending'); expect(after.stages.writer.attempts?.[0]).toMatchObject({ status: 'failed', exitCode: 143 });
  });
  it.each(['same_boot', 'different_generation'])('keeps %s fate blocked, never clean', (kind) => {
    beginStageAttempt(project, runId, 'writer', 0);
    updateRunState(project, runId, (state) => { state.engineCheckpoint = { version: 1, runId, projectDir: project, bootId: 'test-boot', generation: engineGeneration(), pid: 99999999, at: new Date().toISOString() }; state.stages.writer = readStageStatus(project, runId, 'writer'); });
    const after = reconcileHostInterruptedRun(project, runId, { currentBootId: kind === 'same_boot' ? 'test-boot' : 'new-boot', currentGeneration: kind === 'different_generation' ? 'different-generation' : engineGeneration() });
    expect(after.recovery?.kind).toBe('blocked'); expect(after.status).toBe('parked'); expect(after.stages.writer.status).toBe('running');
    expect(after.stages.writer.attempts?.[0].status).toBe('running');
  });
});

describe('real scheduler boundaries', () => {
  it('retains an existing producer execution predicate while admitting a tactic revision', async () => {
    const agents = configuredAgents();
    for (const suppress of [false, true]) {
      let owedCalls = 0;
      const first = stage('first', { scope: [] });
      const owed = stage('owed', { scope: [], depends_on: ['first'], dependency_reasons: { first: 'Produce the admitted outcome after first settles.' }, artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'outcome', root: 'run', path: 'owed.txt' }], reads: [] }) });
      const adapter: Adapter = { async run(_prompt, _role, opts) {
        const writes: string[] = [];
        if (opts.stageId === 'first') {
          const id = opts.runDir.split('/').at(-1)!;
          const state = readRunState(project, id), attempt = readStageStatus(project, id, 'first').attempts!.at(-1)!;
          const candidate = state.planControl!.stages.map((stage) => stage.id === 'owed' ? { ...stage, prompt_template: 'Use the observed outcome to produce the same declared artifact.', ...(suppress ? { condition: 'first.status == failed' } : {}) } : stage);
          write(join(opts.runDir, 'stages/first/plan_revision_request.json'), JSON.stringify({ version: 1, requestId: 'revise_execution', runId: id, stageId: 'first', attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt, baseRevision: state.queryState!.planRevision!.revision, baseDigest: state.queryState!.planRevision!.digest, reason: 'Revise a pending tactic without removing its output duty.', stages: candidate }));
        }
        if (opts.stageId === 'owed') { owedCalls++; write(join(opts.runDir, 'owed.txt'), 'Fresh owed outcome.'); writes.push('run:owed.txt'); }
        return fixtureResult({ output: 'done', exitCode: 0, duration_ms: 1, writes, writeAttribution: 'structured' }, opts);
      } };
      const workflow = { name: 'execution-duty', description: 'Retain existing duties', defaults: { max_iterations: 1 }, stages: [first, owed] };
      const result = await runWorkflow(workflow, yaml(workflow), project, adapter, agents);
      const decision = JSON.parse(readFileSync(join(runDir(project, result.runId), 'stages/first/plan_revision_decision_revise_execution.json'), 'utf8'));
      expect(result.status).toBe('complete'); expect(owedCalls).toBe(1);
      expect(readFileSync(join(runDir(project, result.runId), 'owed.txt'), 'utf8')).toBe('Fresh owed outcome.');
      expect(decision.accepted).toBe(!suppress);
      if (suppress) expect(decision.errors.join(';')).toContain('PLAN_REVISION_EXECUTION_CHANGED');
    }
  });

  it('runs an appended stage without rerunning completed work', async () => {
    const agents = configuredAgents(); let firstCalls = 0, extraCalls = 0;
    const initial = [stage('first')];
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === 'first') {
        firstCalls++; const state = readRunState(project, opts.runDir.split('/').at(-1)!); const attempt = readStageStatus(project, state.runId, 'first').attempts!.at(-1)!;
        write(join(opts.runDir, 'stages/first/plan_revision_request.json'), JSON.stringify({ version: 1, requestId: 'append_work', runId: state.runId, stageId: 'first', attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt, baseRevision: state.queryState!.planRevision!.revision, baseDigest: state.queryState!.planRevision!.digest, reason: 'First outcome requires another stage', stages: [...state.planControl!.stages, stage('extra', { depends_on: ['first'], dependency_reasons: { first: 'Uses first outcome' } })] }));
      } else if (opts.stageId === 'extra') extraCalls++;
      return fixtureResult({ output: 'done', exitCode: 0, duration_ms: 1 }, opts);
    } };
    const workflow = { name: 'rolling', description: 'Rolling-plan fixture', defaults: { max_iterations: 1 }, stages: initial };
    const result = await runWorkflow(workflow, yaml(workflow), project, adapter, agents);
    expect(result.status).toBe('complete'); expect(firstCalls).toBe(1); expect(extraCalls).toBe(1); expect(result.queryState?.planHistory).toHaveLength(2);
  });

  it('uses the admitted repair for structured findings without generating a duplicate route', async () => {
    const agents = configuredAgents(); let writerCalls = 0, gateCalls = 0, repairCalls = 0;
    const writer = stage('report', { artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'report', root: 'project', path: 'docs/report.md' }], reads: [] }) });
    const gate = stage('audit', { role: 'qa', scope: [], depends_on: ['report'], dependency_reasons: { report: 'Audit report' }, is_gate: true, artifact_contract: ArtifactContractSchema.parse({ replays: [], version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_audit.json' }], reads: [{ id: 'report', root: 'project', path: 'docs/report.md', source: { kind: 'stage', stage: 'report', artifact: 'report' } }] }) });
    const repair = stage('repair', { scope: ['docs/report.md'], depends_on: ['audit'], retry_to: ['audit'], artifact_contract: ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'report', root: 'project', path: 'docs/report.md' }], reads: [] }) });
    const plan = stage('plan', { role: 'planner', scope: [], artifact_contract: empty(), dynamic_dispatch: true });
    const adapter: Adapter = { async run(_prompt, _role, opts: RunOpts) {
      const writes: string[] = [];
      if (opts.stageId === 'plan') { write(join(opts.runDir, 'dispatch.yaml'), yaml([writer, gate, repair])); writes.push('run:dispatch.yaml'); }
      if (opts.stageId === 'report') { writerCalls++; write(join(project, 'docs/report.md'), 'needs attribution'); writes.push('docs/report.md'); }
      if (opts.stageId === 'audit') {
        gateCalls++; const pass = readFileSync(join(project, 'docs/report.md'), 'utf8').includes('attribution repaired');
        write(join(opts.runDir, 'verdict_audit.json'), JSON.stringify({ pass, reason: pass ? 'accepted' : 'report attribution missing', audit_findings: { version: 1, findings: pass ? [] : [{ id: 'attribution', paths: ['docs/report.md'], reason: 'Add the missing report attribution.', criterion_ids: [], invalidates_plan: false, repair_role: 'coder' }] } })); writes.push('run:verdict_audit.json');
      }
      if (opts.stageId === 'repair') { repairCalls++; write(join(project, 'docs/report.md'), 'attribution repaired'); writes.push('docs/report.md'); }
      return fixtureResult({ output: 'done', exitCode: 0, duration_ms: 1, writes, writeAttribution: 'structured' }, opts);
    } };
    const workflow = { name: 'repair', description: 'Plan-repair fixture', defaults: { max_iterations: 1 }, stages: [plan] };
    const result = await runWorkflow(workflow, yaml(workflow), project, adapter, agents);
    expect(result.status).toBe('complete'); expect(writerCalls).toBe(1); expect(gateCalls).toBe(2); expect(repairCalls).toBe(1);
    expect(result.planControl!.stages.filter((stage) => stage.retry_to?.length).map(stage => stage.id)).toEqual(['repair']);
    expect(result.currentIteration).toBe(1);
    expect(result.queryState?.planHistory).toHaveLength(1);
  });
});
