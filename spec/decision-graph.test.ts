import { plannerReply } from './test-support/planner-entry.js';
import './test-support/policy-runtime.js';
import { runWorkflow } from './test-support/stage-deadline.js';
import { runRecordPath, stageWorkPath } from '../src/run-layout.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import { createRun } from './test-support/create-run.js';
import { executeReadyBatch } from '../src/scheduler/sched_loop/stage-batch.js';
import { reconcileDecisionEvents } from '../src/scheduler/sched_loop/decisions.js';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import * as revisions from '../src/plan-revisions.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createHash } from 'node:crypto';
import type { Adapter, RunOpts } from '../src/adapters/base.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { loadWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, setFcGlobalDir, runDir, readRunState, writeRunState, writeStageStatus } from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { emptyDecisionGraph } from '../src/decision-graph.js';
import { parseBriefFrontmatter, entryWorkflow } from '../src/scheduler/sched_admission/brief-contract.js';
import { parseCommandArgs } from '../src/cli-args.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

import { createReadyFinder, isStageInSkippedBranch } from '../src/scheduler/sched_admission/frontier.js';
import { readEvidence, VALIDATION_FACT_VERSION } from '../src/evidence-ledger.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';

let root: string, project: string, old: string;
const executions = new Set<Promise<unknown>>();
const agents = join(import.meta.dirname, '../config/agents');
const contract = { version: 1, produces: [], reads: [] };
const delivered = JSON.stringify({ status: 'delivered', summary: 'Verified.', checks: [], caveats: [], remaining_work: [] });
const choice = (successor: string, reason = 'Selected from the declared set.') => JSON.stringify({ successor, reason });
const task = "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Produce docs/report.md with a greeting.\"}]\n---\n# Coherent change\n\n## Acceptance criteria\n1. Produce docs/report.md with a greeting.\n";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'decision-graph-')); project = join(root, 'project'); mkdirSync(project);
  old = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  // Independent reviewers receive the real patch from the private fixture repository.
  isolatedProjectCommand('git', ['init', '-q'], project, root);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'base'], project, root);
  setEngineDefaults({ gate_retry_loops: 3, plan_stage_retries: 1, max_iterations: 1 });
});
async function settleExecutions() {
  while (executions.size) await Promise.allSettled([...executions]);
}
afterEach(async () => {
  // A Vitest timeout leaves the test promise running. Retire its workers and
  // integrity guards before deleting their carriers or changing shared fixtures.
  // Capture this test's fixtures first: if the wait outlives the hook timeout,
  // the next beforeEach reassigns root/old and must not be cleaned up here.
  const ownRoot = root, ownOld = old;
  await settleExecutions();
  vi.restoreAllMocks();
  setFcGlobalDir(ownOld); rmSync(ownRoot, { recursive: true, force: true });
});
function trackExecution<T>(pending: Promise<T>): Promise<T> {
  const execution = pending.finally(() => { executions.delete(execution); });
  executions.add(execution);
  return execution;
}
function execute(raw: unknown, adapter: Adapter, brief = '') {
  const workflow = WorkflowConfigSchema.parse(raw);
  return trackExecution(runWorkflow(workflow, JSON.stringify(workflow), project, withConfirmedRejections(adapter), new Map(), undefined, agents, undefined, brief, true));
}
function gate(opts: RunOpts, pass = true) {
  const criteria = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
  return JSON.stringify({ pass, reason: pass ? 'Independent experiment accepted.' : 'Concrete defect.',
    criteria: Object.fromEntries(criteria.map(c => [c.id, { status: pass ? 'pass' : 'fail', evidence: 'Independent experiment on the produced output.' }])),
    audit_findings: { version: 1, findings: [] }, remaining_work: [],
    ...(!pass ? { repairability: { version: 1, disposition: 'repairable', evidence: 'Repair is available.' } } : {}) });
}
function decisionStage(id: string, successors: string[], fallback: string, depends_on: string[] = []) {
  return { id, role: 'coder', scope: [], depends_on, decision: { successors, default: fallback }, artifact_contract: contract };
}

describe('declared successor execution', () => {
  it('retires unfinished and chained fixture work before deleting its engine carriers', async () => {
    let started!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    let finish!: () => void;
    const release = new Promise<void>(resolve => { finish = resolve; });
    let carrierAvailableAtRetirement = false;
    const workflow = { name: 'fixture-retirement', stages: [
      { id: 'work', role: 'coder', scope: [], depends_on: [], artifact_contract: contract },
    ] };
    const execution = execute(workflow, { async run(_prompt, _role, opts) {
      started();
      await release;
      carrierAvailableAtRetirement = readRunState(project, opts.runDir.split('/').at(-1)!).stages.work.status === 'running';
      return { output: '', exitCode: 1, duration_ms: 1 };
    } }).then(() => execute(workflow, new ScriptedAdapter({ work: { output: delivered } })));
    await active;
    let settled = false;
    const retirement = settleExecutions().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await retirement;
    expect((await execution).status).toBe('complete');
    expect(carrierAvailableAtRetirement).toBe(true);
    expect(executions.size).toBe(0);
  });

  it('records valid, invalid-default and outside-set refusal in one real scheduler run', async () => {
    const adapter = new ScriptedAdapter({
      first: { output: choice('second') }, second: { output: '{}' }, third: { output: choice('escape') }, finish: { output: delivered },
    });
    const state = await execute({ name: 'edges', stages: [decisionStage('first', ['second'], 'second'), decisionStage('second', ['third'], 'third', ['first']), decisionStage('third', ['finish'], 'finish', ['second']), { id: 'finish', role: 'coder', scope: [], depends_on: ['third'], artifact_contract: contract }] }, adapter);
    expect(state.status, state.failureReason).toBe('complete');
    expect(adapter.calls.map(call => call.stageId).filter(id => !id.startsWith('_'))).toEqual(['first', 'second', 'third', 'finish']);
    expect(state.decisionGraph!.records.map(record => record.outcome)).toEqual(['chosen', 'defaulted', 'refused']);
    expect(readRunEvents(project, state.runId).map(event => event.type)).toEqual(expect.arrayContaining(['decision_chosen', 'decision_defaulted', 'decision_refused']));
    expect(state.stages).not.toHaveProperty('escape');
  });

  it('bounds a self edge without resetting attempts or the iteration budget', async () => {
    const state = await execute({ name: 'bounded', stages: [decisionStage('loop', ['loop'], 'loop')] }, new ScriptedAdapter({ loop: { output: choice('loop') } }));
    expect(state.stages.loop.attempts).toHaveLength(4);
    expect(state.status).toBe('incomplete');
    expect(state.currentIteration).toBe(1);
    expect(state.decisionGraph!.records.at(-1)).toMatchObject({ outcome: 'refused' });
  });

  it('rejects a default outside the declared set at configuration admission', () => {
    expect(() => WorkflowConfigSchema.parse({ name: 'bad', stages: [decisionStage('one', ['two'], 'outside')] })).toThrow('default must be a declared successor');
  });
});

describe('one entry and concrete clarification', () => {
  it('refuses the CLI override and legacy workflow declaration keys', () => {
    expect(() => parseCommandArgs('quick', ['--workflow', 'direct'])).toThrow(/unknown/i);
    for (const value of ['direct', 'planner', 'anything']) {
      const parsed = parseBriefFrontmatter(`---\nworkflow: ${value}\n---\nTask`);
      expect(entryWorkflow(parsed)).toMatchObject({ workflow: 'entry', error: expect.stringContaining('workflow') });
      expect(parsed.stripped).toBe('Task');
    }
    expect(entryWorkflow(parseBriefFrontmatter(task)).workflow).toBe('entry');
  });
});

describe('independent post-author review', () => {
  it('supplies the full reviewer with the brief, engine facts and patch without the author transcript', async () => {
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    let input = '';
    const calls: string[] = [];
    const adapter: Adapter = { async run(user, role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'plan') return plannerReply(opts);
      if (opts.stageId === 'implement') {
        mkdirSync(join(project, 'docs'));
        writeFileSync(join(project, 'docs/report.md'), 'Greeting.\n');
        return { output: JSON.stringify({ status: 'delivered', summary: 'PRIVATE_AUTHOR_TRANSCRIPT', caveats: [], remaining_work: [], blocks: null }), exitCode: 0, duration_ms: 1 };
      }
      input = role.prompt + '\n' + user;
      return { output: gate(opts), exitCode: 0, duration_ms: 1 };
    } };
    const state = await execute(config, adapter, task);
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls).toEqual(['plan', 'implement', 'review']);
    expect(input).toContain('## Review contract');
    expect(input).toContain('Engine state query');
    expect(input).toContain('brief_criteria.json');
    expect(input).toContain('Greeting.');
    expect(input).not.toContain('PRIVATE_AUTHOR_TRANSCRIPT');
    expect(input).not.toContain('Context from stage:');
    expect(input).not.toContain('handoff_implement');
    expect(state.stages.repair.status).toBe('skipped');
    expect(state.planControl!.stages.filter(stage => stage.is_gate).map(stage => stage.id)).toEqual(['review']);
  });

  it('settles repaired work through one read-only review, retaining the rejection', async () => {
    isolatedProjectCommand('git', ['init', '-q'], project, root);
    isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'base'], project, root);
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const calls: string[] = [];
    const adapter: Adapter = { async run(_user, _role, opts) {
      calls.push(opts.stageId);
      let output = delivered;
      if (opts.stageId === 'plan') return plannerReply(opts);
      if (opts.stageId === 'implement') { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Wrong greeting.\n'); }
      if (opts.stageId === 'repair') { writeFileSync(join(project, 'docs/report.md'), 'Required greeting.\n'); output = choice('review'); }
      if (opts.stageId === 'review') {
        output = gate(opts, readFileSync(join(project, 'docs/report.md'), 'utf8') === 'Required greeting.\n');
      }
      return { output, exitCode: 0, duration_ms: 1 };
    } };
    const state = await execute(config, adapter, task);
    expect(state.status, state.failureReason).toBe('complete');
    expect(readFileSync(join(project, 'docs/report.md'), 'utf8')).toBe('Required greeting.\n');
    expect(calls).toEqual(['plan', 'implement', 'review', 'repair', 'review']);
    const directory = runDir(project, state.runId);
    const preimage = runRecordPath(directory, 'gate_reevaluation/iteration_1/round_1/repair_preimage.json');
    expect(existsSync(preimage), 'generic repair preimages are retired').toBe(false);
    expect(existsSync(join(directory, 'gate_reevaluation/iteration_1/round_1/repair_preimage.json'))).toBe(false);
    const frozenManifest = runRecordPath(directory, 'frozen_inputs.json');
    const trustedPreimage = readFileSync(frozenManifest, 'utf8');
    await expect(withEngineIntegrity({ projectDir: project, runDir: directory, stageId: 'repair' }, async () => {
      writeFileSync(frozenManifest, 'forged frozen identity');
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(readFileSync(frozenManifest, 'utf8')).toBe(trustedPreimage);
    const rejection = JSON.parse(readFileSync(runRecordPath(directory, `gate_reevaluation/iteration_1/round_1/rejected_verdict_review.json`), 'utf8'));
    expect(rejection).toMatchObject({ pass: false, reason: 'Concrete defect.' });
    expect(state.stages.review.attempts![0]).toMatchObject({ status: 'complete', exitCode: 0 });
    expect(state.stages.review.gate?.pass).toBe(true);
  });

});

describe('in-iteration replanning through the revision authority', () => {
  it.each(['default', 'replan'])('lets a retry_to-only planner repair choose its gate or replan (choice=%s)', async selection => {
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const proposal = [
      { id: 'implement', role: 'coder', scope: [], artifact_contract: contract },
      { id: 'review', role: 'qa', scope: [], depends_on: ['implement'], is_gate: true, artifact_contract: contract },
      { id: 'repair', role: 'coder', scope: [], retry_to: ['review'], artifact_contract: contract },
    ];
    const calls: string[] = [];
    let repaired = false;
    const state = await execute(config, { async run(_user, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'plan') {
        const current = readRunState(project, opts.runDir.split('/').at(-1)!);
        return plannerReply(opts, current.planControl?.stages.filter(stage => !stage.dynamic_dispatch) ?? proposal);
      }
      let output = delivered;
      if (opts.stageId === 'review') output = gate(opts, repaired);
      if (opts.stageId === 'repair') {
        expect(opts.outputSchema).toMatchObject({ properties: { successor: { enum: ['review', 'replan'] } } });
        repaired = true;
        output = selection === 'default' ? '{}' : choice('replan');
      }
      return { output, exitCode: 0, duration_ms: 0 };
    } }, task);
    // An unchanged revision retains the rejected gate; replanning cannot accept it.
    expect(state.status, state.failureReason).toBe(selection === 'replan' ? 'incomplete' : 'complete');
    expect(calls).toEqual(['plan', 'implement', 'review', 'repair', selection === 'replan' ? 'plan' : 'review']);
    expect(state.planControl!.stages.find(stage => stage.id === 'repair')!.decision).toEqual({
      successors: ['review', 'replan'], default: 'review', kind: 'successor',
    });
    expect(state.decisionGraph!.records.find(record => record.stageId === 'repair')).toMatchObject({
      successor: selection === 'default' ? 'review' : 'replan', outcome: selection === 'default' ? 'defaulted' : 'chosen',
    });
    expect(state.queryState!.planRevision!.revision).toBe(selection === 'replan' ? 1 : 0);
    expect(state.stages.review.attempts).toHaveLength(selection === 'replan' ? 1 : 2);
    expect(state.decisionGraph!.records.some(record => record.gateAccepted)).toBe(selection === 'default');
  });

  it.each([false, true])('validates only authors and repairs across decisions and a replan, and binds gates to their final trees (declared ignored output=%s)', async ignored => {
    if (ignored) writeFileSync(join(project, '.gitignore'), 'docs/\n');
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'decision-ledger-fixture', version: '1.0.0', scripts: { build: 'node check.cjs', test: 'node check.cjs', lint: 'node check.cjs' } }));
    writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ name: 'decision-ledger-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'decision-ledger-fixture', version: '1.0.0' } } }));
    writeFileSync(join(project, 'check.cjs'), "console.log('configured check passed');\n");
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']]) isolatedProjectCommand('git', args, project, root);
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const proposal = [
      { ...decisionStage('work', ['replan', 'review'], 'review', ['plan']), scope: ['docs/'] },
      { id: 'review', role: 'qa', scope: [], depends_on: ['work'], is_gate: true, artifact_contract: contract },
      { id: 'repair', role: 'coder', scope: ['docs/'], depends_on: ['review'], retry_to: ['review'], artifact_contract: contract },
    ];
    let plans = 0;
    const calls: string[] = [];
    const gateReceipts: Array<{ gate: string; sequence: number; treeHash: string | null }> = [];
    const adapter: Adapter = { async run(user, _role, opts) {
      calls.push(opts.stageId);
      let output = delivered;
      if (opts.stageId === 'plan') {
        const candidate = ++plans === 1 ? proposal : readRunState(project, opts.runDir.split('/').at(-1)!).planControl!.stages.filter(stage => !stage.dynamic_dispatch);
        writeFileSync(stageWorkPath(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages: candidate }));
      }
      if (opts.stageId === 'work') { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Wrong greeting.\n'); output = choice('replan'); }
      if (opts.stageId === 'repair') { writeFileSync(join(project, 'docs/report.md'), 'Required greeting.\n'); output = choice('review'); }
      if (opts.stageId === 'review') {
        const reference = JSON.parse(readFileSync(runRecordPath(opts.runDir, `validation_delta_${opts.stageId}.json`), 'utf8'));
        gateReceipts.push({ gate: opts.stageId, sequence: reference.ledgerSequence, treeHash: reference.treeHash });
        output = gate(opts, readFileSync(join(project, 'docs/report.md'), 'utf8') === 'Required greeting.\n');
      }
      return { output, exitCode: 0, duration_ms: 1,
        ...(opts.stageId === 'plan' ? { writes: ['run:work/dispatch.yaml'], writeAttribution: 'structured' as const } : {}) };
    } };
    // Each role runs the same real check directly; package/lockfile dependency
    // preparation and all routing/receipt assertions retain their normal owner.
    const validation = { commands: Object.fromEntries(['build', 'test', 'lint'].map(role => [role,
      { command: process.execPath, args: ['check.cjs'] }])) };
    const state = await execute(config, adapter, `---\nvalidation: ${JSON.stringify(validation)}\noutputs: [docs/report.md]\n---\n${task}`);
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls).toEqual(['plan', 'work', 'plan', 'review', 'repair', 'review']);
    expect(plans).toBe(2); expect(state.queryState!.planRevision!.revision).toBe(1);
    const ledger = readEvidence(runDir(project, state.runId));
    const validations = ledger.filter(entry => entry.kind === 'validation');
    expect(validations.map(entry => [entry.stageId, entry.attemptIndex])).toEqual([['work', 1], ['repair', 1]]);
    expect(validations[0].treeHash).not.toBe(validations[1].treeHash);
    for (const [index, receipt] of gateReceipts.entries()) {
      const validation = validations[index];
      expect(validation).toMatchObject({ validationVersion: VALIDATION_FACT_VERSION, sequence: receipt.sequence, treeHash: receipt.treeHash, pass: true });
      expect(validation.executions).toHaveLength(1);
      expect(validation.executions[0].commands.map(command => [command.role, command.exitCode])).toEqual([['build', 0], ['test', 0], ['lint', 0]]);
      for (const id of [validation.stageId, receipt.gate]) {
        expect(ledger.find(entry => entry.kind === 'attempt' && entry.stageId === id && entry.attemptIndex === (id === receipt.gate ? index + 1 : 1))).toMatchObject({ treeHash: receipt.treeHash });
      }
    }
  });

  it.each([false, true])('appends a revision without changing prior bytes, iterations, spent attempts or executed duties (legacy committed gap=%s)', async legacyGap => {
    const { config: workflow } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const stages = [
      decisionStage('work', ['replan', 'review'], 'review', ['plan']),
      { id: 'review', role: 'qa', depends_on: ['work'], scope: [], is_gate: true, artifact_contract: contract },
      { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: [], artifact_contract: contract },
    ];
    let plans = 0, firstPath = '', firstHash = '', startedAt = '';
    const apply = revisions.applyPlanRevision;
    let committedWithoutPendingChoice = false;
    let restoredLegacyGap = false, acceptedCalls = 0;
    const requests: unknown[] = [];
    vi.spyOn(revisions, 'applyPlanRevision').mockImplementation(input => {
      requests.push(structuredClone(input.request));
      const pending = readRunState(input.projectDir, input.runId).decisionGraph?.replan;
      const result = apply(input);
      if (result.decision.accepted) {
        acceptedCalls++;
        // Observe the authority before the injector can publish workflow aliases.
        const committed = readRunState(input.projectDir, input.runId);
        committedWithoutPendingChoice = committed.queryState?.planRevision?.revision === 1 && !committed.decisionGraph?.replan;
        if (legacyGap && !restoredLegacyGap && pending) {
          // Emulate the projection left by the old transaction, preserving the
          // exact admitted request, revision bytes and completed plan attempt.
          restoredLegacyGap = true;
          result.state.decisionGraph!.replan = pending;
          writeRunState(input.projectDir, input.runId, result.state);
        }
      }
      return result;
    });
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      let output = delivered;
      if (opts.stageId === 'plan') {
        plans++;
        if (plans === 1) { startedAt = readRunState(project, opts.runDir.split('/').at(-1)!).startedAt; writeFileSync(stageWorkPath(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages })); }
        else {
          const before = readRunState(project, opts.runDir.split('/').at(-1)!);
          firstPath = runRecordPath(opts.runDir, before.queryState!.planHistory![0].path);
          expect(createHash('sha256').update(readFileSync(firstPath)).digest('hex')).toBe(firstHash);
          expect(before.startedAt).toBe(startedAt); expect(before.currentIteration).toBe(1);
          // Full candidate retains every executed identity and all result obligations.
          writeFileSync(stageWorkPath(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages: before.planControl!.stages.filter(stage => !stage.dynamic_dispatch) }));
        }
      } else if (opts.stageId === 'work') {
        const before = readRunState(project, opts.runDir.split('/').at(-1)!);
        firstPath = runRecordPath(opts.runDir, before.queryState!.planHistory![0].path);
        firstHash = createHash('sha256').update(readFileSync(firstPath)).digest('hex');
        output = choice('replan', 'Reread progress and confirm the remaining plan.');
      }
      else if (opts.stageId === 'review') output = gate(opts);
      return { output, exitCode: 0, duration_ms: 1, tokens_in: 2, tokens_out: 3,
        ...(opts.stageId === 'plan' ? { writes: ['run:work/dispatch.yaml'], writeAttribution: 'structured' as const } : {}) };
    } };
    const state = await execute(workflow, adapter, "---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Retain and independently verify the plan revision.\"}]\n---\n# Replan progress\n\n## Acceptance criteria\n1. Retain and independently verify the plan revision.\n");
    if (legacyGap) expect(requests[1]).toEqual(requests[0]);
    expect(state.status, state.failureReason).toBe('complete');
    expect(plans).toBe(2); expect(state.currentIteration).toBe(1); expect(state.maxIterations).toBe(1);
    expect(state.startedAt).toBe(startedAt);
    expect(state.queryState!.planHistory).toHaveLength(2);
    expect(createHash('sha256').update(readFileSync(firstPath)).digest('hex')).toBe(firstHash);
    const firstStages = JSON.parse(readFileSync(firstPath, 'utf8')).stages;
    expect(state.planControl!.stages.find(stage => stage.id === 'plan')).toEqual(firstStages.find((stage: { id: string }) => stage.id === 'plan'));
    expect(state.stages.plan.attempts).toHaveLength(2);
    expect(state.stages.work.attempts).toHaveLength(1);
    expect(state.decisionGraph!.visits['1/replan']).toBe(1);
    expect(state.stages.review.status).toBe('complete');
    expect(state.decisionGraph!.records.find(record => record.stageId === 'work')).toMatchObject({ successor: 'replan', planRevision: 0 });
    expect(committedWithoutPendingChoice).toBe(true);
    expect(acceptedCalls).toBe(legacyGap ? 2 : 1);
  });
});

describe('decision descendants and joins', () => {
  it('keeps completed rejections and failed work required when a later generic choice changes branches', () => {
    const stages = WorkflowConfigSchema.parse({ name: 'review-settlement', stages: [
      decisionStage('route', ['left', 'right'], 'left'),
      { id: 'left', role: 'qa', depends_on: ['route'], scope: [], is_gate: true },
      { id: 'right', role: 'qa', depends_on: ['route'], scope: [], is_gate: true },
      { id: 'tail', role: 'coder', depends_on: ['right'], scope: [] },
      { id: 'join', role: 'coder', depends_on: ['left', 'right'], scope: [] },
    ] }).stages;
    const created = createRun(project, 'review-settlement', 'name: review-settlement', stages.map(stage => stage.id));
    const state = readRunState(project, created.runId);
    for (const id of ['route', 'left', 'right']) state.stages[id].status = 'complete';
    state.decisionGraph = { ...emptyDecisionGraph(), records: [{ key: 'current', stageId: 'route', iteration: 1, successor: 'left', outcome: 'chosen', reason: 'Review repaired work.' }] };
    const byId = new Map(stages.map(stage => [stage.id, stage]));
    expect(isStageInSkippedBranch('right', byId, state)).toBe(false);
    for (const id of ['right', 'tail', 'join']) expect(isStageInSkippedBranch(id, byId, state)).toBe(false);
    const ready = createReadyFinder({ loadGateContract: () => null, readGateEvaluation: (_project, id) => ({ pass: id !== 'right' }) })(stages, state);
    expect(ready).toEqual([]);
    state.stages.right.status = 'failed';
    expect(isStageInSkippedBranch('right', byId, state)).toBe(false);
    state.stages.right.status = 'complete'; byId.get('right')!.scope = ['docs/'];
    expect(isStageInSkippedBranch('right', byId, state)).toBe(false);
    byId.get('right')!.scope = []; byId.get('route')!.decision!.kind = 'successor';
    expect(isStageInSkippedBranch('right', byId, state)).toBe(false);
  });

  it('does not discard executed branch duties when a later choice selects another alternative', () => {
    const stages = WorkflowConfigSchema.parse({ name: 'retained-work', stages: [
      decisionStage('route', ['left', 'right'], 'left'),
      { id: 'left', role: 'coder', depends_on: ['route'], scope: [] },
      { id: 'right', role: 'coder', depends_on: ['route'], scope: [] },
      { id: 'right_end', role: 'coder', depends_on: ['right'], scope: [] },
      { id: 'join', role: 'coder', depends_on: ['left', 'right_end'], scope: [] },
    ] }).stages;
    const created = createRun(project, 'retained-work', 'name: retained-work', stages.map(stage => stage.id));
    const state = readRunState(project, created.runId);
    state.stages.route.status = 'complete'; state.stages.left.status = 'complete';
    state.stages.right.status = 'failed';
    state.decisionGraph = { ...emptyDecisionGraph(), records: [{ key: 'later-choice', stageId: 'route', iteration: 1, successor: 'left', outcome: 'chosen', reason: 'A later choice cannot erase real work.' }] };
    const byId = new Map(stages.map(stage => [stage.id, stage]));
    expect(isStageInSkippedBranch('right', byId, state)).toBe(false);
    expect(isStageInSkippedBranch('right_end', byId, state)).toBe(false);
    const ready = createReadyFinder({ loadGateContract: () => null, readGateEvaluation: () => null })(stages, state);
    expect(ready.map(stage => stage.id)).not.toContain('join');
  });

  it.each([{ selected: 'left', missing: false }, { selected: 'right', missing: false }, { selected: 'left', missing: true }])('settles deep alternatives without hiding unfinished selected work ($selected, missing=$missing)', async ({ selected, missing }) => {
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const ends = (id: string) => ({ id: `${id}_end`, role: 'coder', scope: [], depends_on: [id], artifact_contract: { ...contract, produces: [{ id: 'result', root: 'run', path: `work/${id}-result.md`, nonempty: true }] } });
    const stages = [decisionStage('route', ['left', 'right'], 'left'),
      { id: 'left', role: 'coder', scope: ['docs/'], depends_on: ['route'], artifact_contract: contract }, ends('left'),
      { id: 'right', role: 'coder', scope: ['docs/'], depends_on: ['route'], artifact_contract: contract }, ends('right'),
      { id: 'review', role: 'qa', scope: [], depends_on: ['left_end', 'right_end'], is_gate: true, artifact_contract: contract },
      { id: 'repair', role: 'coder', scope: [], depends_on: ['review'], retry_to: ['review'], artifact_contract: contract }];
    const calls: string[] = [];
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      calls.push(opts.stageId);
      let output = delivered;
      if (opts.stageId === 'plan') writeFileSync(stageWorkPath(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages }));
      if (opts.stageId === 'route') output = choice(selected);
      if (opts.stageId === selected) { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Greeting.\n'); }
      if (opts.stageId === `${selected}_end` && !missing) writeFileSync(stageWorkPath(opts.runDir, `${selected}-result.md`), 'Selected result.');
      if (opts.stageId === 'review') output = gate(opts);
      return { output, exitCode: 0, duration_ms: 1, ...(opts.stageId === 'plan' ? { writes: ['run:work/dispatch.yaml'], writeAttribution: 'structured' as const } : {}) };
    } };
    const state = await execute(config, adapter, task);
    const other = selected === 'left' ? 'right' : 'left';
    expect(state.stages[other].status).toBe('skipped');
    expect(state.stages[`${other}_end`].status).toBe('skipped');
    expect(calls).not.toContain(other); expect(calls).not.toContain(`${other}_end`);
    if (missing) {
      expect(state.status).not.toBe('complete');
      expect(state.stages[`${selected}_end`].status).not.toBe('skipped');
      expect(calls).not.toContain('review');
    } else {
      expect(state.status, state.failureReason).toBe('complete');
      expect(calls.filter(id => !id.startsWith('_'))).toEqual(['plan', 'route', selected, `${selected}_end`, 'review']);
    }
  });
});

describe('independent review retains write isolation', () => {
  it('fails an independent reviewer write without restoring it or accepting a clean retry', async () => {
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      let output = delivered;
      if (opts.stageId === 'plan') return plannerReply(opts);
      if (opts.stageId === 'implement') { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Author output.\n'); }
      if (opts.stageId === 'review') { writeFileSync(join(project, 'docs/report.md'), 'Reviewer attempted repair.\n'); output = gate(opts); }
      return { output, exitCode: 0, duration_ms: 1, writes: opts.stageId === 'review' ? ['docs/report.md'] : [], writeAttribution: 'structured' };
    } };
    const state = await execute(config, adapter, task);
    expect(state.status).not.toBe('complete');
    expect(readFileSync(join(project, 'docs/report.md'), 'utf8')).toBe('Reviewer attempted repair.\n');
    expect(state.stages.review.attempts?.some(attempt => attempt.constraintAudit?.violationCount)).toBe(true);
  });
});

describe('planner-authored decomposition', () => {
  it.each([false, true])('honors the gate repair edge with a planner repair condition (initial pass=%s)', async initialPass => {
    isolatedProjectCommand('git', ['init', '-q'], project, root);
    isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'base'], project, root);
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const proposal = [
      { id: 'implement', role: 'coder', scope: ['docs/'], depends_on: ['plan'], artifact_contract: contract },
      { id: 'review', role: 'qa', scope: [], depends_on: ['implement'], is_gate: true, artifact_contract: contract },
      { id: 'repair', role: 'coder', scope: ['docs/'], depends_on: ['review'], retry_to: ['review'],
        condition: 'review.pass == false', artifact_contract: contract },
    ];
    const calls: string[] = [];
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      calls.push(opts.stageId);
      let output = delivered;
      if (opts.stageId === 'plan') writeFileSync(stageWorkPath(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages: proposal }));
      if (opts.stageId === 'implement') {
        mkdirSync(join(project, 'docs'));
        writeFileSync(join(project, 'docs/report.md'), initialPass ? 'Required greeting.\n' : 'Wrong greeting.\n');
      }
      if (opts.stageId === 'review') output = gate(opts, readFileSync(join(project, 'docs/report.md'), 'utf8') === 'Required greeting.\n');
      if (opts.stageId === 'repair') {
        const current = readRunState(project, opts.runDir.split('/').at(-1)!);
        expect(isStageInSkippedBranch('review', new Map(current.planControl!.stages.map(stage => [stage.id, stage])), current)).toBe(false);
        expect(current.stages.review.attempts ?? []).toHaveLength(1);
        expect(current.decisionGraph!.records.at(-1)).toMatchObject({ stageId: 'review', successor: 'repair', gateAccepted: false });
        const rejection = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'verdict_review.json'), 'utf8'));
        expect(rejection.repairability.disposition).toBe('repairable');
        expect(rejection.audit_findings.findings).toHaveLength(1);
        const confirmation = readEvidence(opts.runDir).find(entry => entry.sequence === rejection.audit_findings.findings[0].reproduction);
        expect(confirmation).toMatchObject({ stageId: 'review', exitCode: 1 });
        writeFileSync(join(project, 'docs/report.md'), 'Required greeting.\n');
        output = delivered;
      }
      return { output, exitCode: 0, duration_ms: 1,
        ...(opts.stageId === 'plan' ? { writes: ['run:work/dispatch.yaml'], writeAttribution: 'structured' as const } : {}) };
    } };
    const state = await execute(config, adapter, task);
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls).toEqual(['plan', 'implement', 'review',
      ...(initialPass ? [] : ['repair', 'review'])]);
    expect(state.planControl!.stages.find(stage => stage.id === 'repair')).toMatchObject({ condition: 'review.pass == false', depends_on: ['review'] });
    expect(state.stages.review.status).toBe('complete');
    expect(state.stages.repair.attempts ?? []).toHaveLength(initialPass ? 0 : 1);
    expect(state.decisionGraph!.records.filter(record => record.stageId === 'review').map(record => record.successor)).toEqual(initialPass ? ['continue'] : ['repair', 'continue']);
    if (!initialPass) expect(state.decisionGraph!.visits['1/repair']).toBe(1);
  });

  it('dispatches the recorded repair grant without spending it twice', async () => {
    const workflow = WorkflowConfigSchema.parse({ name: 'repair-grant-replay', stages: [
      { id: 'review', role: 'qa', scope: [], is_gate: true, artifact_contract: contract },
      { id: 'repair', role: 'coder', scope: [], depends_on: ['review'], retry_to: ['review'], condition: 'review.pass == false', artifact_contract: contract },
    ] });
    const created = createRun(project, workflow.name, JSON.stringify(workflow), workflow.stages.map(stage => stage.id));
    const state = readRunState(project, created.runId);
    state.stages.review = { status: 'complete', retries: 0 };
    writeStageStatus(project, created.runId, 'review', state.stages.review);
    state.decisionGraph = { ...emptyDecisionGraph(), enabled: { repair: 'review' }, visits: { '1/repair': 1 }, records: [
      { key: 'gate', stageId: 'review', iteration: 1, successor: 'repair', gateAccepted: false, outcome: 'chosen', reason: 'Confirmed repairable finding.' },
    ] };
    writeRunState(project, created.runId, state);
    const result = await trackExecution(executeReadyBatch(workflow.stages, state, project, created.runId, created.runDirPath,
      workflow, new ScriptedAdapter({ repair: { output: delivered } }), new Map(), agents, new Map(), new Map()));
    expect(result.state.stages.repair.status).toBe('complete');
    expect(result.state.stages.repair.attempts).toHaveLength(1);
    expect(result.state.decisionGraph!.visits['1/repair']).toBe(1);
  });

  it('uses a graph grant for an ordinary successor regardless of its condition', async () => {
    const adapter = new ScriptedAdapter({ route: { output: choice('selected') }, selected: { output: delivered } });
    const state = await execute({ name: 'graph-condition', stages: [
      decisionStage('route', ['selected'], 'selected'),
      { id: 'selected', role: 'coder', scope: [], depends_on: ['route'], condition: 'route.status == failed', artifact_contract: contract },
    ] }, adapter);
    expect(state.status, state.failureReason).toBe('complete');
    expect(state.stages.selected.attempts).toHaveLength(1);
    expect(state.stages.selected.status).toBe('complete');
  });

  it('keeps ordinary DAG conditions active without a graph grant', async () => {
    const adapter = new ScriptedAdapter({ source: { output: delivered }, met: { output: delivered } });
    const state = await execute({ name: 'ordinary-conditions', stages: [
      { id: 'source', role: 'coder', scope: [], depends_on: [], artifact_contract: contract },
      ...['met', 'unmet'].map(id => ({ id, role: 'coder', scope: [], depends_on: ['source'],
        condition: `source.status == ${id === 'met' ? 'complete' : 'failed'}`, artifact_contract: contract })),
    ] }, adapter);
    expect(state.status, state.failureReason).toBe('complete');
    expect(state.stages.met.status).toBe('complete');
    expect(state.stages.met.attempts).toHaveLength(1);
    expect(state.stages.unmet.status).toBe('skipped');
    expect(state.stages.unmet.attempts ?? []).toHaveLength(0);
  });

  it('admits a separately planned shape with exactly one independent review', async () => {
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const calls: string[] = [];
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      calls.push(opts.stageId);
      let output = delivered;
      if (opts.stageId === 'plan') writeFileSync(stageWorkPath(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages: [
        { id: 'implement', role: 'coder', scope: ['docs/'], depends_on: ['plan'], artifact_contract: contract },
        { id: 'review', role: 'qa', scope: [], depends_on: ['implement'], is_gate: true, artifact_contract: contract },
        { id: 'repair', role: 'coder', scope: ['docs/'], depends_on: ['review'], retry_to: ['review'], artifact_contract: contract },
      ] }));
      if (opts.stageId === 'implement') { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Greeting.\n'); }
      if (opts.stageId === 'review') output = gate(opts);
      return { output, exitCode: 0, duration_ms: 1, ...(opts.stageId === 'plan' ? { writes: ['run:work/dispatch.yaml'], writeAttribution: 'structured' as const } : {}) };
    } };
    const state = await execute(config, adapter, task);
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls.filter(id => !id.startsWith('_'))).toEqual(['plan', 'implement', 'review']);
    expect(state.planControl!.stages.filter(stage => stage.is_gate)).toHaveLength(1);
  });
});

describe('durable choice authority', () => {
  it('retains committed choices and spent budgets across stale projections and repairs only missing events', () => {
    const created = createRun(project, 'choice-authority', 'name: choice-authority', ['choice']);
    const state = readRunState(project, created.runId);
    state.decisionGraph = { ...emptyDecisionGraph(), maxVisits: 3, visits: { '1/choice': 1 }, records: [
      { key: 'first', stageId: 'choice', iteration: 1, successor: 'continue', reason: 'First committed choice.', outcome: 'chosen' },
    ] };
    writeRunState(project, created.runId, state);
    const stale = JSON.parse(JSON.stringify(state));
    state.decisionGraph.records.push({ key: 'second', stageId: 'choice', iteration: 1, successor: 'continue', reason: 'Second committed choice.', outcome: 'chosen' });
    state.decisionGraph.visits['1/choice'] = 2; state.decisionGraph.maxVisits = 2;
    writeRunState(project, created.runId, state);
    writeRunState(project, created.runId, stale);
    const recovered = readRunState(project, created.runId);
    expect(recovered.decisionGraph!.records).toHaveLength(2);
    expect(recovered.decisionGraph!.visits['1/choice']).toBe(2);
    expect(recovered.decisionGraph!.maxVisits).toBe(2);
    reconcileDecisionEvents(recovered, project, created.runId);
    reconcileDecisionEvents(recovered, project, created.runId);
    expect(readRunEvents(project, created.runId).filter(event => event.type === 'decision_chosen')).toHaveLength(2);
    recovered.decisionGraph!.records[0].reason = 'Attempted history rewrite.';
    expect(() => writeRunState(project, created.runId, recovered)).toThrow('append-only decisionGraph.records');
    expect(readRunState(project, created.runId).decisionGraph!.records[0].reason).toBe('First committed choice.');
  });
});

describe('review preserves result duties and joins', () => {
  it.each([false, true])('retains declared run outputs and downstream work (missing=%s)', async omit => {
    const selected = 'review';
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const proposal = [
      { id: 'work', role: 'coder', scope: ['docs/'], depends_on: ['plan'], artifact_contract: contract },
      { id: 'review', role: 'qa', scope: [], depends_on: ['work'], is_gate: true,
        artifact_contract: { version: 1, produces: [{ id: 'note', root: 'run', path: 'work/review-note.md', kind: 'file', nonempty: true }], reads: [] } },
      { id: 'publish', role: 'coder', scope: [], depends_on: ['review'], artifact_contract: contract,
        reality_checks: [{ name: 'Selected independent note', type: 'file-exists-nonempty', params: { paths: ['work/review-note.md'] }, reads: [
          { id: 'note_read', root: 'run', path: 'work/review-note.md', kind: 'file', source: { kind: 'stage', stage: 'review', artifact: 'note' } },
        ] }] },
      { id: 'repair', role: 'coder', scope: ['docs/'], depends_on: ['review'], retry_to: ['review'], artifact_contract: contract },
    ];
    let reviewerInput = '', published = false;
    const adapter: Adapter = { async run(user, role, opts) {
      let output = delivered;
      if (opts.stageId === 'plan') writeFileSync(stageWorkPath(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages: proposal }));
      if (opts.stageId === 'work') { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Greeting.\n'); }
      if (opts.stageId === selected) { reviewerInput = role.prompt + '\n' + user; if (!omit) writeFileSync(stageWorkPath(opts.runDir, 'review-note.md'), 'Independent review note.'); output = gate(opts); }
      if (opts.stageId === 'publish') { expect(readFileSync(stageWorkPath(opts.runDir, 'review-note.md'), 'utf8')).toContain('Independent review'); published = true; }
      return { output, exitCode: 0, duration_ms: 1,
        writes: opts.stageId === 'plan' ? ['run:work/dispatch.yaml'] : opts.stageId === selected ? ['run:review-note.md'] : [], writeAttribution: 'structured' };
    } };
    const state = await execute(config, adapter, task);
    if (omit) { expect(state.status).not.toBe('complete'); expect(state.stages.publish.attempts ?? []).toHaveLength(0); }
    else { expect(state.status, state.failureReason).toBe('complete'); expect(state.stages.publish.status).toBe('complete'); }
    expect(published).toBe(!omit);
    expect(state.planControl!.stages.find(stage => stage.id === selected)!.artifact_contract!.produces).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'work/review-note.md', nonempty: true })]));
    expect(reviewerInput).toContain('work/review-note.md'); expect(reviewerInput).toContain('# Declared output and input locations');
  });

  it('retains the framework verdict name and independent artifact predicates', () => {
    const stages = WorkflowConfigSchema.parse({ name: 'duties', stages: [{ id: 'review', role: 'qa', depends_on: [], scope: [], is_gate: true,
      artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'work/verdict_review.json' }, { id: 'report', root: 'run', path: 'work/audit.md', nonempty: true }], reads: [] } }] }).stages;
    expect(stages.find(stage => stage.id === 'review')!.artifact_contract!.produces).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'work/verdict_review.json' }), expect.objectContaining({ path: 'work/audit.md', nonempty: true }),
    ]));
  });
});
