import { createRun } from './test-support/create-run.js';
import { reconcileDecisionEvents } from '../src/scheduler/sched_loop/decisions.js';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import * as revisions from '../src/plan-revisions.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Adapter, RunOpts } from '../src/adapters/base.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { loadWorkflow, runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, setFcGlobalDir, runDir, readRunState, writeRunState } from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { decisionSchema, validateDecision, emptyDecisionGraph, declareReviewChoices } from '../src/decision-graph.js';
import { parseBriefFrontmatter, entryWorkflow } from '../src/scheduler/sched_admission/brief-contract.js';
import { parseCommandArgs } from '../src/cli-args.js';
import { resolveRequest } from '../src/inbox.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { inspectBrief, createBriefAdmission } from '../src/brief-preflight.js';
import { createReadyFinder, isStageInSkippedBranch } from '../src/scheduler/sched_admission/frontier.js';

let root: string, project: string, old: string;
const agents = join(import.meta.dirname, '../config/agents');
const contract = { version: 1, produces: [], reads: [] };
const delivered = JSON.stringify({ status: 'delivered', summary: 'Verified.', checks: [], caveats: [], remaining_work: [] });
const choice = (successor: string, reason = 'Selected from the declared set.') => JSON.stringify({ successor, reason });
const task = '# Coherent change\n\n## Acceptance criteria\n1. Produce docs/report.md with a greeting.\n';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'decision-graph-')); project = join(root, 'project'); mkdirSync(project);
  old = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  setEngineDefaults({ gate_retry_loops: 3, plan_stage_retries: 1, max_iterations: 1 });
});
afterEach(() => {
  vi.restoreAllMocks();
  setFcGlobalDir(old); rmSync(root, { recursive: true, force: true });
});
async function execute(raw: unknown, adapter: Adapter, brief = '') {
  const workflow = WorkflowConfigSchema.parse(raw);
  const state = await runWorkflow(workflow, JSON.stringify(workflow), project, adapter, new Map(), undefined, agents, undefined, brief, true);
  return state;
}
function gate(opts: RunOpts, pass = true) {
  const criteria = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
  return JSON.stringify({ pass, reason: pass ? 'Independent experiment accepted.' : 'Concrete defect.',
    criteria: Object.fromEntries(criteria.map(c => [c.id, { status: pass ? 'pass' : 'fail', evidence: 'Independent experiment on the produced output.' }])),
    audit_findings: { version: 1, findings: [] }, remaining_work: [],
    ...(!pass ? { repairability: { version: 1, disposition: 'repairable', evidence: 'Repair is available.' } } : {}) });
}
function decisionStage(id: string, successors: string[], fallback: string, depends_on: string[] = []) {
  return { id, role: 'coder', scope: [], depends_on, decision: { successors, default: fallback }, artifact_contract: contract };
}

describe('declared successor execution', () => {
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
  it('removes both routing overrides with one legacy-field diagnostic', () => {
    expect(() => parseCommandArgs('quick', ['--workflow', 'direct'])).toThrow(/unknown/i);
    for (const value of ['direct', 'planner', 'anything']) {
      const parsed = parseBriefFrontmatter(`---\nworkflow: ${value}\n---\nTask`);
      expect(entryWorkflow(parsed)).toMatchObject({ workflow: 'entry', error: expect.stringContaining('field no longer exists') });
    }
    expect(entryWorkflow(parseBriefFrontmatter(task)).workflow).toBe('entry');
  });

  it('pauses on exact model questions, records an answer declaration, and reruns the chooser', async () => {
    const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const questions = [{ missing: 'scope of migration', question: 'Does this include existing stored rows or only new writes?' }];
    const inputs: string[] = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
      inputs.push(prompt);
      return { output: opts.stageId === 'choose' ? JSON.stringify({ successor: 'implement', reason: 'Scope needs a declaration.', metric_search: false, questions: inputs.length === 1 ? questions : [] }) : delivered, exitCode: 0, duration_ms: 1 };
    } };
    const paused = await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, undefined, task, true);
    expect(paused.status).toBe('parked');
    expect(paused.decisionGraph!.pendingQuestion!.questions).toEqual(questions);
    expect(Object.keys(paused.stages)).toEqual(['choose', 'plan']);
    const request = paused.decisionGraph!.pendingQuestion!.requestId;
    const pausedBytes = readFileSync(join(runDir(project, paused.runId), 'run.json'), 'utf8');
    const stillPaused = await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, paused.runId, task, true);
    expect(stillPaused.status).toBe('parked');
    expect(stillPaused.decisionGraph!.pendingQuestion!.questions).toEqual(questions);
    expect(readFileSync(join(runDir(project, paused.runId), 'run.json'), 'utf8')).toBe(pausedBytes);
    expect(inputs).toHaveLength(1);
    expect(resolveRequest(project, paused.runId, request, 'approve', { reason: 'Only new writes; existing rows are out of scope.' }).won).toBe(true);
    // The second chooser's successor is inspected even though this intentionally incomplete author cannot satisfy the product duty.
    const resumed = await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, paused.runId, task, true);
    expect(resumed.decisionGraph!.declarations).toEqual([{ requestId: request, answer: 'Only new writes; existing rows are out of scope.' }]);
    expect(inputs[1]).toContain('Only new writes');
    expect(resumed.decisionGraph!.records.some(record => record.stageId === 'choose' && record.outcome === 'chosen')).toBe(true);
  });

  it('turns invalid chooser output into a concrete question without a rule fallback', async () => {
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const state = await execute(config, new ScriptedAdapter({ choose: { output: '{}' } }), task);
    expect(state.status).toBe('parked');
    expect(state.decisionGraph!.pendingQuestion!.questions[0].missing).toBe('valid shape decision');
    expect(state.stages).not.toHaveProperty('implement');
  });

  it('asks for author-owned research fields on a model-identified metric search', async () => {
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const state = await execute(config, new ScriptedAdapter({ choose: { output: JSON.stringify({ successor: 'plan', reason: 'Optimize a measured objective.', metric_search: true, questions: [] }) } }), task);
    expect(state.status).toBe('parked');
    expect(state.decisionGraph!.pendingQuestion!.questions[0].missing).toBe('research.baseline, research.policy, research.stop');
    expect(state.stages.plan.attempts ?? []).toHaveLength(0);
  });

  it.each([
    { stop: { max_rounds: 2 }, refused: true },
    { stop: { max_wall_hours: 1000 }, refused: true },
    { stop: { max_rounds: 1 }, refused: false },
  ])('admits operator research through the same budget boundary ($stop)', async ({ stop, refused }) => {
    const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    config.defaults.max_iterations = 1;
    const research = { baseline: 0.5, policy: 'greedy_stack', stop };
    const calls: string[] = [];
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      calls.push(opts.stageId);
      return { output: opts.stageId === 'choose' ? JSON.stringify({ successor: 'implement', reason: 'A measured search needs author declarations.', metric_search: true, questions: [] }) : delivered, exitCode: 0, duration_ms: 1 };
    } };
    const admission = (brief: string) => createBriefAdmission(inspectBrief(brief), { kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString() });
    if (refused) {
      const initial = `---\n${JSON.stringify({ research })}\n---\n${task}`;
      const baseline = await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, undefined, initial, true, undefined, true, admission(initial));
      expect(baseline.status).toBe('failed');
      expect(baseline.failureReason).toContain('Research budget admission refused');
      expect(calls).toEqual([]);
    }
    const paused = await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, undefined, task, true, undefined, true, admission(task));
    expect(paused.status).toBe('parked');
    const answer = JSON.stringify({ research });
    expect(resolveRequest(project, paused.runId, paused.decisionGraph!.pendingQuestion!.requestId, 'approve', { reason: answer }).won).toBe(true);
    const resumed = await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, paused.runId, task, true, undefined, true, admission(task));
    expect(resumed.decisionGraph!.declarations.at(-1)?.answer).toBe(answer);
    expect(resumed.startedAt).toBe(paused.startedAt);
    expect(resumed.maxIterations).toBe(1);
    if (refused) {
      expect(resumed.status).toBe('failed');
      expect(resumed.failureReason).toContain('Research budget admission refused');
      expect(calls).toEqual(['choose']);
      expect(resumed.research).toBeUndefined();
      expect(resumed.decisionGraph!.pendingQuestion).toBeUndefined();
      expect(readRunEvents(project, resumed.runId).map(event => event.type)).toEqual(expect.arrayContaining(['decision_declaration', 'admission_rejected']));
    } else {
      expect(calls).toContain('implement');
      expect(resumed.research?.stop?.maxRounds).toBe(1);
      expect(resumed.researchInputGeneration?.startedAt).toBe(paused.startedAt);
    }
  });
});

describe('independent post-author routing', () => {
  it('checks the rendered router and focused reviewer inputs, closed risk schema and full alternative', async () => {
    execFileSync(process.execPath, ['--input-type=module', '-e', `import {execFileSync} from 'node:child_process'; for (const args of [['init','-q'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','base']]) execFileSync('git', args);`], { cwd: project, env: { ...process.env, HOME: root, FC_HOME: join(root, 'fc') }, timeout: 5000 });
    const seen: Record<string, string> = {};
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const adapter: Adapter = { async run(user, role, opts) {
      seen[opts.stageId] = role.prompt + '\n' + user;
      let output = delivered;
      if (opts.stageId === 'choose') output = JSON.stringify({ successor: 'implement', reason: 'One coherent change.', metric_search: false, questions: [] });
      if (opts.stageId === 'implement') { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Actual diff greeting.\n'); output = JSON.stringify({ status: 'delivered', summary: 'AUTHOR_TRANSCRIPT_SECRET_MARKER', checks: [], caveats: [], remaining_work: [] }); }
      if (opts.stageId === 'assess') output = JSON.stringify({ successor: 'review', reason: 'One bounded output.', risk_areas: [{ file: 'docs/report.md', risk: 'Greeting content could be wrong.', experiment: 'Read output and compare it to task.' }] });
      if (opts.stageId === 'review') output = gate(opts);
      return { output, exitCode: 0, duration_ms: 1 };
    } };
    const state = await execute(config, adapter, task);
    expect(state.status, state.failureReason).toBe('complete');
    for (const id of ['assess', 'review']) {
      expect(seen[id]).toContain('Coherent change'); expect(seen[id]).toContain('Actual diff greeting');
      expect(seen[id]).toContain('validation'); expect(seen[id]).not.toContain('AUTHOR_TRANSCRIPT_SECRET_MARKER');
      expect(seen[id]).not.toContain('output_attempt_'); expect(seen[id]).not.toContain('handoff_implement');
      expect(seen[id]).not.toContain('Context from stage:');
      expect(seen[id]).not.toContain('Engine state query');
      expect(seen[id]).not.toContain('flowcrew state');
    }
    expect(seen.review).toContain('Greeting content could be wrong.');
    expect(seen.review).toContain('Read output and compare it to task.');
    expect(state.stages.review_full.status).toBe('skipped');
    const assess = state.planControl!.stages.find(stage => stage.id === 'assess')!;
    expect(decisionSchema(assess).additionalProperties).toBe(false);
    expect(assess.decision!.successors).toEqual(['review', 'review_full']);
    expect(validateDecision(assess, JSON.stringify({ successor: 'review', reason: 'Bad file.', risk_areas: [{ file: 'elsewhere.ts', risk: 'risk', experiment: 'probe' }] }), ['docs/report.md'])).toMatchObject({ successor: 'review_full', outcome: 'defaulted' });
    expect(validateDecision(assess, JSON.stringify({ successor: 'done', reason: 'skip', risk_areas: [] }), ['docs/report.md'])).toMatchObject({ successor: 'review_full', outcome: 'refused' });
  });
});

describe('in-iteration replanning through the revision authority', () => {
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
      if (opts.stageId === 'choose') output = JSON.stringify({ successor: 'plan', reason: 'Distinct execution and review duties.', metric_search: false, questions: [] });
      else if (opts.stageId === 'plan') {
        plans++;
        if (plans === 1) { startedAt = readRunState(project, opts.runDir.split('/').at(-1)!).startedAt; writeFileSync(join(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages })); }
        else {
          const before = readRunState(project, opts.runDir.split('/').at(-1)!);
          firstPath = join(opts.runDir, before.queryState!.planHistory![0].path);
          expect(createHash('sha256').update(readFileSync(firstPath)).digest('hex')).toBe(firstHash);
          expect(before.startedAt).toBe(startedAt); expect(before.currentIteration).toBe(1);
          // Full candidate retains every executed identity and all result obligations.
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages: before.planControl!.stages.filter(stage => !stage.dynamic_dispatch && stage.decision?.kind !== 'shape') }));
        }
      } else if (opts.stageId === 'work') {
        const before = readRunState(project, opts.runDir.split('/').at(-1)!);
        firstPath = join(opts.runDir, before.queryState!.planHistory![0].path);
        firstHash = createHash('sha256').update(readFileSync(firstPath)).digest('hex');
        output = choice('replan', 'Reread progress and confirm the remaining plan.');
      }
      else if (opts.stageId === 'review_assess') output = JSON.stringify({ successor: 'review_full', reason: 'Explore the admitted revision independently.', risk_areas: [] });
      else if (['review', 'review_full'].includes(opts.stageId)) output = gate(opts);
      return { output, exitCode: 0, duration_ms: 1, tokens_in: 2, tokens_out: 3,
        ...(opts.stageId === 'plan' ? { writes: ['run:dispatch.yaml'], writeAttribution: 'structured' as const } : {}) };
    } };
    const state = await execute(workflow, adapter, '# Replan progress\n\n## Acceptance criteria\n1. Retain and independently verify the plan revision.\n');
    if (legacyGap) expect(requests[1]).toEqual(requests[0]);
    expect(state.status, state.failureReason).toBe('complete');
    expect(plans).toBe(2); expect(state.currentIteration).toBe(1); expect(state.maxIterations).toBe(1);
    expect(state.startedAt).toBe(startedAt);
    expect(state.queryState!.planHistory).toHaveLength(2);
    expect(createHash('sha256').update(readFileSync(firstPath)).digest('hex')).toBe(firstHash);
    const firstStages = JSON.parse(readFileSync(firstPath, 'utf8')).stages;
    expect(state.planControl!.stages.find(stage => stage.id === 'choose')).toEqual(firstStages.find((stage: { id: string }) => stage.id === 'choose'));
    expect(state.stages.plan.attempts).toHaveLength(2);
    expect(state.stages.work.attempts).toHaveLength(1);
    expect(state.decisionGraph!.visits['1/replan']).toBe(1);
    expect(state.stages.review_full.status).toBe('complete');
    expect(state.decisionGraph!.records.find(record => record.stageId === 'work')).toMatchObject({ successor: 'replan', planRevision: 0 });
    expect(committedWithoutPendingChoice).toBe(true);
    expect(acceptedCalls).toBe(legacyGap ? 2 : 1);
  });
});

describe('decision descendants and joins', () => {
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
    const ends = (id: string) => ({ id: `${id}_end`, role: 'coder', scope: [], depends_on: [id], artifact_contract: { ...contract, produces: [{ id: 'result', root: 'run', path: `${id}-result.md`, nonempty: true }] } });
    const stages = [decisionStage('route', ['left', 'right'], 'left'),
      { id: 'left', role: 'coder', scope: ['docs/'], depends_on: ['route'], artifact_contract: contract }, ends('left'),
      { id: 'right', role: 'coder', scope: ['docs/'], depends_on: ['route'], artifact_contract: contract }, ends('right'),
      { id: 'review', role: 'qa', scope: [], depends_on: ['left_end', 'right_end'], is_gate: true, artifact_contract: contract },
      { id: 'repair', role: 'coder', scope: [], depends_on: ['review'], retry_to: ['review'], artifact_contract: contract }];
    const calls: string[] = [];
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      calls.push(opts.stageId);
      let output = delivered;
      if (opts.stageId === 'choose') output = JSON.stringify({ successor: 'plan', reason: 'Declare alternatives and their shared independent review.', metric_search: false, questions: [] });
      if (opts.stageId === 'plan') writeFileSync(join(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages }));
      if (opts.stageId === 'route') output = choice(selected);
      if (opts.stageId === selected) { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Greeting.\n'); }
      if (opts.stageId === `${selected}_end` && !missing) writeFileSync(join(opts.runDir, `${selected}-result.md`), 'Selected result.');
      if (opts.stageId === 'review_assess') output = JSON.stringify({ successor: 'review', reason: 'Independently check the selected branch.', risk_areas: [] });
      if (opts.stageId === 'review') output = gate(opts);
      return { output, exitCode: 0, duration_ms: 1, ...(opts.stageId === 'plan' ? { writes: ['run:dispatch.yaml'], writeAttribution: 'structured' as const } : {}) };
    } };
    const state = await execute(config, adapter, task);
    const other = selected === 'left' ? 'right' : 'left';
    expect(state.stages[other].status).toBe('skipped');
    expect(state.stages[`${other}_end`].status).toBe('skipped');
    expect(calls).not.toContain(other); expect(calls).not.toContain(`${other}_end`);
    if (missing) {
      expect(state.status).not.toBe('complete');
      expect(state.stages[`${selected}_end`].status).not.toBe('skipped');
      expect(calls).not.toContain('review_assess'); expect(calls).not.toContain('review');
    } else {
      expect(state.status, state.failureReason).toBe('complete');
      expect(calls.filter(id => !id.startsWith('_'))).toEqual(['choose', 'plan', 'route', selected, `${selected}_end`, 'review_assess', 'review']);
    }
  });
});

describe('new review branches retain write isolation', () => {
  it('restores a focused reviewer write and refuses acceptance', async () => {
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      let output = delivered;
      if (opts.stageId === 'choose') output = JSON.stringify({ successor: 'implement', reason: 'One coherent change.', metric_search: false, questions: [] });
      if (opts.stageId === 'implement') { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Author output.\n'); }
      if (opts.stageId === 'assess') output = JSON.stringify({ successor: 'review', reason: 'Focused review sufficient.', risk_areas: [] });
      if (opts.stageId === 'review') { writeFileSync(join(project, 'docs/report.md'), 'Reviewer attempted repair.\n'); output = gate(opts); }
      return { output, exitCode: 0, duration_ms: 1, writes: opts.stageId === 'review' ? ['docs/report.md'] : [], writeAttribution: 'structured' };
    } };
    const state = await execute(config, adapter, task);
    expect(state.status).not.toBe('complete');
    expect(readFileSync(join(project, 'docs/report.md'), 'utf8')).toBe('Author output.\n');
    expect(state.stages.review.attempts?.some(attempt => attempt.constraintAudit?.violationCount)).toBe(true);
  });
});

describe('model-selected decomposition', () => {
  it('admits a separately planned shape and still routes every review through assessment', async () => {
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const calls: string[] = [];
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      calls.push(opts.stageId);
      let output = delivered;
      if (opts.stageId === 'choose') output = JSON.stringify({ successor: 'plan', reason: 'Importer and migration need separately assigned duties.', metric_search: false, questions: [] });
      if (opts.stageId === 'plan') writeFileSync(join(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages: [
        { id: 'implement', role: 'coder', scope: ['docs/'], depends_on: ['plan'], artifact_contract: contract },
        { id: 'review', role: 'qa', scope: [], depends_on: ['implement'], is_gate: true, artifact_contract: contract },
        { id: 'repair', role: 'coder', scope: ['docs/'], depends_on: ['review'], retry_to: ['review'], artifact_contract: contract },
      ] }));
      if (opts.stageId === 'implement') { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Greeting.\n'); }
      if (opts.stageId === 'review_assess') output = JSON.stringify({ successor: 'review', reason: 'Bounded produced output.', risk_areas: [] });
      if (opts.stageId === 'review') output = gate(opts);
      return { output, exitCode: 0, duration_ms: 1, ...(opts.stageId === 'plan' ? { writes: ['run:dispatch.yaml'], writeAttribution: 'structured' as const } : {}) };
    } };
    const state = await execute(config, adapter, task);
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls.filter(id => !id.startsWith('_'))).toEqual(['choose', 'plan', 'implement', 'review_assess', 'review']);
    expect(state.decisionGraph!.records[0]).toMatchObject({ successor: 'plan', reason: 'Importer and migration need separately assigned duties.' });
    expect(state.planControl!.stages.find(stage => stage.id === 'review_full')?.scope).toEqual([]);
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

describe('full review remains an independent successor', () => {
  it('defaults an invalid risk file to full review and supplies current facts without reusing stale risks', async () => {
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    let fullInput = '';
    const adapter: Adapter = { async run(user, role, opts) {
      let output = delivered;
      if (opts.stageId === 'choose') output = JSON.stringify({ successor: 'implement', reason: 'One coherent task.', metric_search: false, questions: [] });
      if (opts.stageId === 'implement') { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Greeting.\n'); }
      if (opts.stageId === 'assess') output = JSON.stringify({ successor: 'review', reason: 'Invalid reference.', risk_areas: [{ file: 'absent.ts', risk: 'STALE_RISK_MARKER', experiment: 'Probe an absent file.' }] });
      if (opts.stageId === 'review_full') { fullInput = role.prompt + '\n' + user; output = gate(opts); }
      return { output, exitCode: 0, duration_ms: 1 };
    } };
    const state = await execute(config, adapter, task);
    expect(state.status, state.failureReason).toBe('complete');
    expect(state.stages.review.status).toBe('skipped');
    expect(state.decisionGraph!.records.find(record => record.stageId === 'assess')).toMatchObject({ outcome: 'defaulted', successor: 'review_full' });
    expect(fullInput).toContain('Independent review facts'); expect(fullInput).toContain('validation');
    expect(fullInput).toContain('"risk_areas":[]'); expect(fullInput).not.toContain('STALE_RISK_MARKER');
    expect(fullInput).toContain('full independent review');
  });
});


describe('review alternatives preserve result duties and joins', () => {
  it.each([{ selected: 'review', omit: false }, { selected: 'review_full', omit: false }, { selected: 'review_full', omit: true }])('retains declared run outputs and downstream work through $selected (missing=$omit)', async ({ selected, omit }) => {
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const proposal = [
      { id: 'work', role: 'coder', scope: ['docs/'], depends_on: ['plan'], artifact_contract: contract },
      { id: 'review', role: 'qa', scope: [], depends_on: ['work'], is_gate: true,
        artifact_contract: { version: 1, produces: [{ id: 'note', root: 'run', path: 'review-note.md', kind: 'file', nonempty: true }], reads: [] } },
      { id: 'publish', role: 'coder', scope: [], depends_on: ['review'], artifact_contract: contract,
        reality_checks: [{ name: 'Selected independent note', type: 'file-exists-nonempty', params: { paths: ['review-note.md'] }, reads: [
          { id: 'note_read', root: 'run', path: 'review-note.md', kind: 'file', source: { kind: 'stage', stage: 'review', artifact: 'note' } },
        ] }] },
      { id: 'repair', role: 'coder', scope: ['docs/'], depends_on: ['review'], retry_to: ['review'], artifact_contract: contract },
    ];
    let reviewerInput = '', published = false;
    const adapter: Adapter = { async run(user, role, opts) {
      let output = delivered;
      if (opts.stageId === 'choose') output = JSON.stringify({ successor: 'plan', reason: 'Separate author, review and publication duties.', metric_search: false, questions: [] });
      if (opts.stageId === 'plan') writeFileSync(join(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages: proposal }));
      if (opts.stageId === 'work') { mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Greeting.\n'); }
      if (opts.stageId === 'review_assess') output = JSON.stringify({ successor: selected, reason: 'Independent declared review.', risk_areas: [] });
      if (opts.stageId === selected) { reviewerInput = role.prompt + '\n' + user; if (!omit) writeFileSync(join(opts.runDir, 'review-note.md'), 'Independent review note.'); output = gate(opts); }
      if (opts.stageId === 'publish') { expect(readFileSync(join(opts.runDir, 'review-note.md'), 'utf8')).toContain('Independent review'); published = true; }
      return { output, exitCode: 0, duration_ms: 1,
        writes: opts.stageId === 'plan' ? ['run:dispatch.yaml'] : opts.stageId === selected ? ['run:review-note.md'] : [], writeAttribution: 'structured' };
    } };
    const state = await execute(config, adapter, task);
    if (omit) { expect(state.status).not.toBe('complete'); expect(state.stages.publish.attempts ?? []).toHaveLength(0); }
    else { expect(state.status, state.failureReason).toBe('complete'); expect(state.stages.publish.status).toBe('complete'); }
    expect(published).toBe(!omit);
    expect(state.planControl!.stages.find(stage => stage.id === selected)!.artifact_contract!.produces).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'review-note.md', nonempty: true })]));
    expect(reviewerInput).toContain('review-note.md'); expect(reviewerInput).toContain('required_outputs');
  });

  it('translates only the framework verdict name and retains independent artifact predicates', () => {
    const stages = WorkflowConfigSchema.parse({ name: 'duties', stages: [{ id: 'review', role: 'qa', depends_on: [], scope: [], is_gate: true,
      artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_review.json' }, { id: 'report', root: 'run', path: 'audit.md', nonempty: true }], reads: [] } }] }).stages;
    declareReviewChoices(stages);
    expect(stages.find(stage => stage.id === 'review_full')!.artifact_contract!.produces).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'verdict_review_full.json' }), expect.objectContaining({ path: 'audit.md', nonempty: true }),
    ]));
  });
});
