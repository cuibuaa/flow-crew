import { describe, expect, it } from 'vitest';
import { HANDOFF_SCHEMA, parseStageRecord, stageRecordSchema } from '../src/handoff.js';
import { PLAN_SCHEMA, RECORDED_PLAN_SCHEMA } from '../src/plan-interface.js';
import { parseDispatchedStageConfig, StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { createDispatchAdmission } from '../src/scheduler/sched_admission/dispatch.js';
import { firstDeclaredInputScopeConflict } from '../src/scheduler/sched_scope/path-capabilities.js';
import { inspectStageGraph, topoSort } from '../src/scheduler/sched_admission/frontier.js';

const minimalPlan = () => ({ stages: [
  { id: 'work', role: 'coder', scope: ['src/'], prompt_template: 'Implement the brief.' },
  { id: 'review', role: 'qa', scope: [], depends_on: ['work'], is_gate: true, prompt_template: 'Review independently.' },
  { id: 'repair', role: 'coder', scope: ['src/'], depends_on: ['review'], retry_to: ['review'], condition: 'review.pass == false' },
] });

describe('planner results contain consumed dispatch fields', () => {
  it.each([
    { id: '../escape' }, { id: 'bad/name' }, { id: `a${'b'.repeat(64)}` }, { role: '' },
    { scope: 'src/**' }, { depends_on: 'work' }, { depends_on: null }, { is_gate: 1 },
  ])('refuses malformed consumed stage fields through the shared runtime owner (%j)', invalid => {
    for (const parse of [StageConfigSchema.parse.bind(StageConfigSchema), parseDispatchedStageConfig]) {
      expect(() => parse({ id: 'work', role: 'coder', ...invalid })).toThrow(Object.keys(invalid)[0]);
    }
  });

  it('uses the same complete graph inspection for proposal admission and workflow sorting', () => {
    const stages = [
      parseDispatchedStageConfig({ id: 'work', role: 'coder', depends_on: ['missing', 'review'] }),
      parseDispatchedStageConfig({ id: 'review', role: 'qa', is_gate: true, depends_on: ['work'] }),
    ];
    const graph = inspectStageGraph(stages);
    expect(graph.errors).toEqual([
      'work.depends_on: unknown stage "missing"',
      'work.depends_on: dependency cycle detected',
      'review.depends_on: dependency cycle detected',
    ]);
    expect(() => topoSort(stages)).toThrow(graph.errors.join('; '));
    const admission = createDispatchAdmission(firstDeclaredInputScopeConflict)({ dispatched: stages, baseStages: [], dispatchStageId: 'plan' });
    expect(admission.errors).toEqual(expect.arrayContaining(graph.errors));
    stages[0].depends_on = [];
    expect(inspectStageGraph(stages).errors).toEqual([]);
    expect(topoSort(stages.reverse()).map(stage => stage.id)).toEqual(['work', 'review']);
  });

  it('admits a minimal author, gate and repair plan through the real validators', () => {
    const plan = minimalPlan();
    expect(parseDispatchedStageConfig({ id: 'closed', role: 'coder' }).scope).toEqual([]);
    expect(parseStageRecord(JSON.stringify(plan), PLAN_SCHEMA)).toEqual(plan);
    expect(stageRecordSchema({})).toBe(HANDOFF_SCHEMA);
    expect(() => parseStageRecord(JSON.stringify(plan), stageRecordSchema({}))).toThrow();
    const stages = plan.stages.map(parseDispatchedStageConfig);
    const admission = createDispatchAdmission(firstDeclaredInputScopeConflict)({
      dispatched: stages, dispatchStageId: 'plan',
      baseStages: [StageConfigSchema.parse({ id: 'plan', role: 'planner', dynamic_dispatch: true,
        artifact_contract: { version: 1, produces: [], reads: [] } })],
    });
    expect(admission.errors).toEqual([]);
    expect(admission.pass).toBe(true);
    expect(stages[1].artifact_contract?.produces).toContainEqual(expect.objectContaining({ path: 'verdict_review.json' }));
  });

  it.each([
    ['dependency_reasons', { work: 'Uses the implementation.' }],
    ['max_retries', 2],
  ])('response schema rejects unread %s', (field, value) => {
    const plan = minimalPlan();
    Object.assign(plan.stages[1], { [field as string]: value });
    expect(() => parseStageRecord(JSON.stringify(plan), PLAN_SCHEMA)).toThrow('unknown field');
  });

  it('refuses an unread top-level plan-check report while retaining scope deferrals', () => {
    expect(() => parseStageRecord(JSON.stringify({ ...minimalPlan(), plan_check: { pass: true } }), PLAN_SCHEMA)).toThrow('unknown field');
    const deferred = { ...minimalPlan(), scope_negotiation: { defer: ['pending_digest'] } };
    expect(parseStageRecord(JSON.stringify(deferred), PLAN_SCHEMA)).toEqual(deferred);
    expect(() => parseStageRecord(JSON.stringify({ ...minimalPlan(), scope_negotiation: { report: 'unused' } }), PLAN_SCHEMA)).toThrow('unknown field');
  });

  it('keeps recorded plans readable and their task alias and retry migration semantics intact', () => {
    const recorded = { stages: [{ id: 'work', role: 'coder', scope: ['src/'], task: 'Implement the brief.',
      dependency_reasons: {}, max_retries: 2 }], plan_check: { pass: true } };
    expect(parseStageRecord(JSON.stringify(recorded), RECORDED_PLAN_SCHEMA)).toEqual(recorded);
    expect(parseDispatchedStageConfig(recorded.stages[0])).toMatchObject({ prompt_template: 'Implement the brief.', dependency_reasons: {} });
    expect(parseDispatchedStageConfig(recorded.stages[0])).not.toHaveProperty('max_retries');
  });
});
