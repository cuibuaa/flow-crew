import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { PLAN_SCHEMA, renderPlanInterface } from '../src/plan-interface.js';
import { REPAIR_TOPOLOGY_EXAMPLE } from '../src/repair-topology.js';
import { validate } from '../src/reality-gate/checks/json-schema-match.js';
import { createDispatchAdmission } from '../src/scheduler/sched_admission/dispatch.js';
import { normalizeStageContracts, parseDispatchedStageConfig, RecordedStageConfigSchema, type StageConfig } from '../src/scheduler/sched_admission/configuration.js';
import type { ResearchConfig } from '../src/store.js';

const stage = (id: string, extra: Record<string, unknown> = {}) => parseDispatchedStageConfig({ id, role: 'coder', ...extra });
const criteria = (ids: string[]) => extractBriefCriteria(`---\ncriteria: ${JSON.stringify(ids.map(id => ({ id, text: `Satisfy ${id}.` })))}\n---\nDeclared outcome.\n`);
const ordinary = () => [
  stage('author', { scope: ['source'], skills: ['verification'], task: 'Deliver the declared result.', criterion_refs: ['required'], artifact_contract: {
    version: 1, produces: [{ id: 'output', root: 'project', path: 'source', kind: 'directory', nonempty: true }], reads: [], groups: [],
  } }),
  stage('review', { role: 'qa', is_gate: true, depends_on: ['author'], criterion_refs: ['required'] }),
];
function admit(dispatched: StageConfig[], options: { research?: ResearchConfig; baseStages?: StageConfig[] } = {}) {
  const ids = [...new Set(dispatched.flatMap(s => s.criterion_refs))];
  return createDispatchAdmission()({ dispatched, baseStages: options.baseStages ?? [], dispatchStageId: 'plan', criteria: criteria(ids.length ? ids : ['required']), research: options.research });
}

describe('engine-owned repair topology', () => {
  it.each([1, 2, 3, 4])('admits scrubbed first proposal %s without a planner repair attempt', index => {
    const proposal = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/repair-topology', `first-plan-${index}.json`), 'utf8'));
    expect(proposal.stages).toHaveLength(2);
    const stages = proposal.stages.map(parseDispatchedStageConfig);
    const [author, gate] = stages;
    const first = admit(stages);
    expect(first.errors).toEqual([]);
    expect(first.pass).toBe(true);
    const repair = stages.find(s => s.retry_to?.includes(gate.id))!;
    expect(repair).toBeDefined();
    expect(repair.is_gate).toBe(false);
    expect(repair.dynamic_dispatch).toBe(false);
    expect(repair.depends_on).toEqual([gate.id]);
    expect(repair.retry_to).toEqual([gate.id]);
    expect(repair.role).toBe(author.role);
    expect(repair.scope).toEqual(author.scope);
    expect(repair.skills).toEqual(author.skills);
    expect(repair.prompt_template).toContain(author.prompt_template);
    expect(repair.artifact_contract).toEqual(author.artifact_contract);
    expect(repair.criterion_refs).toEqual(expect.arrayContaining([...author.criterion_refs, ...gate.criterion_refs]));
    expect(first.criterionGateRefs).toEqual({ [gate.id]: gate.criterion_refs });
    // Reinspection of persisted/admitted graphs must not manufacture another repair.
    const count = stages.length;
    expect(admit(stages).errors).toEqual([]);
    expect(stages).toHaveLength(count);
  });

  it('P03 gives planner field mechanics one schema owner while keeping admission and independent judgement', () => {
    const planner = parse(readFileSync(join(import.meta.dirname, '../config/agents/planner.yaml'), 'utf8')).prompt as string;
    for (const duplicate of [
      'decision: {successors:', 'return {successor, reason}', 'is_gate: true',
      'Terminal statuses:', 'gate_reevaluation/iteration_', 'use [] for empty produces/reads',
      'name, type, reads, params', 'Omitting reality_checks inherits admitted checks',
    ]) expect(planner, `planner-field-schema-owner: ${duplicate}`).not.toContain(duplicate);
    expect(planner, 'independent-review judgement').toContain('choosing their own experiments and exploration');
    expect(planner, 'property-equivalence judgement').toContain('equivalent property');
    for (const contract of ['{verdict_contract}', '{artifact_contract_schema}', '{project_contract}']) {
      expect(planner, 'output-schema contracts retained').toContain(contract);
    }
    const illegal = structuredClone(REPAIR_TOPOLOGY_EXAMPLE);
    Object.assign(illegal.stages[1], { retry_to: ['author'] });
    const rejected = admit(illegal.stages.map(parseDispatchedStageConfig));
    expect(rejected.errors, 'gate-return-edge admission catch').toContainEqual(expect.objectContaining({
      code: 'stage_retry_to', stageId: 'review', message: expect.stringContaining('gate stages cannot declare retry_to'),
    }));
  });

  it('P11 leaves full validation with the engine while preserving targeted author checks', () => {
    const planner = parse(readFileSync(join(import.meta.dirname, '../config/agents/planner.yaml'), 'utf8')).prompt as string;
    const coder = parse(readFileSync(join(import.meta.dirname, '../config/agents/coder.yaml'), 'utf8')).prompt as string;
    expect(planner, 'targeted author verification stays assigned').toContain('Implementation includes targeted author verification');
    expect(planner, 'no source-owned full-suite author task').not.toMatch(/(?:run|verify[^.]*with)[^.]*full[- ]suite/i);
    expect(coder.replace(/\s+/g, ' '), 'engine owns configured validation').toContain('The engine runs configured validation after settlement');
    expect(coder.replace(/\s+/g, ' '), 'author full-suite duplication remains prohibited').toContain('Do not run the full suite');
  });

  it('admits the canonical planner-facing example through real admission', () => {
    const example = structuredClone(REPAIR_TOPOLOGY_EXAMPLE);
    expect(renderPlanInterface()).toContain(JSON.stringify(REPAIR_TOPOLOGY_EXAMPLE));
    expect(validate(example, PLAN_SCHEMA, '$')).toEqual([]);
    const stages = example.stages.map(parseDispatchedStageConfig);
    const result = admit(stages);
    expect(result.errors).toEqual([]);
    expect(result.pass).toBe(true);
    const gate = stages.find(s => s.is_gate)!;
    expect(stages.some(s => s.retry_to?.includes(gate.id))).toBe(true);
  });

  it('copies author authority, outputs, inputs and obligations without mutable aliases', () => {
    const stages = ordinary();
    expect(admit(stages).errors).toEqual([]);
    const [author, gate, repair] = stages;
    expect(repair.role).toBe(author.role);
    expect(repair.scope).toEqual(author.scope);
    expect(repair.artifact_contract).toEqual(author.artifact_contract);
    expect(repair.skills).toEqual(author.skills);
    expect(repair.criterion_refs).toEqual(['required']);
    expect(repair.retry_to).toEqual([gate.id]);
    expect(repair.scope).not.toBe(author.scope);
    expect(repair.artifact_contract).not.toBe(author.artifact_contract);
    expect(repair.skills).not.toBe(author.skills);
  });

  it('requires explicit repair ownership for a gate reviewing disjoint authors', () => {
    const stages = ordinary();
    stages.splice(1, 0, stage('other_author', { scope: ['other'], criterion_refs: ['required'], artifact_contract: { version: 1, produces: [{ id: 'other', root: 'project', path: 'other' }], reads: [] } }));
    stages.at(-1)!.depends_on.push('other_author');
    const result = admit(stages);
    expect(result.pass).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'stage_retry_to', stageId: 'review' }));
    expect(stages).toHaveLength(3);
    stages.push(stage('explicit_repair', { depends_on: ['review'], retry_to: ['review'], scope: ['source', 'other'], criterion_refs: ['required'] }));
    expect(admit(stages).errors).toEqual([]);
    expect(stages).toHaveLength(4);
  });

  it('requires explicit repair when a direct author carries an upstream author with disjoint outputs', () => {
    const stages = ordinary();
    stages.unshift(stage('upstream_author', { scope: ['upstream'], criterion_refs: ['required'], artifact_contract: {
      version: 1, produces: [{ id: 'upstream', root: 'project', path: 'upstream' }], reads: [],
    } }));
    stages[1].depends_on.push('upstream_author');
    expect(admit(stages).errors).toContainEqual(expect.objectContaining({ code: 'stage_retry_to', stageId: 'review' }));
    expect(stages).toHaveLength(3);
    stages.push(stage('explicit_repair', { depends_on: ['review'], retry_to: ['review'], scope: ['source', 'upstream'], criterion_refs: ['required'] }));
    expect(admit(stages).errors).toEqual([]);
  });

  it('derives a repair for a gate whose other direct dependency is an earlier gate', () => {
    const stages = [...ordinary().slice(0, 2),
      stage('second', { role: 'coder', depends_on: ['review'] }),
      stage('second_review', { role: 'qa', is_gate: true, depends_on: ['second', 'review'], criterion_refs: ['required'] })];
    expect(admit(stages).errors).toEqual([]);
    expect(stages.find(s => s.retry_to?.includes('second_review'))?.role).toBe('coder');
  });

  it('refuses a gate with no author to return to', () => {
    const stages = [stage('review', { role: 'qa', is_gate: true, criterion_refs: ['required'] })];
    expect(admit(stages).errors).toContainEqual(expect.objectContaining({ code: 'stage_retry_to', stageId: 'review' }));
    expect(stages).toHaveLength(1);
  });

  it('requires an explicit ordinary repair for dynamically dispatched work', () => {
    const stages = ordinary();
    stages[0].dynamic_dispatch = true;
    normalizeStageContracts(stages);
    expect(admit(stages).errors).toContainEqual(expect.objectContaining({ code: 'stage_retry_to', stageId: 'review' }));
    expect(stages).toHaveLength(2);
    stages.push(stage('explicit_repair', { depends_on: ['review'], retry_to: ['review'] }));
    expect(admit(stages).errors).toEqual([]);
  });

  it('leaves the declared research workflow topology unchanged', () => {
    const stages = ordinary();
    const result = admit(stages, { research: {} as ResearchConfig });
    expect(result.errors).toEqual([]);
    expect(stages).toHaveLength(2);
  });

  it.each([false, true])('rejects gate-owned return edges without false criterion coverage failures (implicit refs: %s)', implicit => {
    const stages = ordinary();
    if (implicit) for (const s of stages) s.criterion_refs = [];
    stages[1].retry_to = ['author'];
    const proposal = { stages: stages.map(s => ({ id: s.id, role: s.role, is_gate: s.is_gate, depends_on: s.depends_on, retry_to: s.retry_to, criterion_refs: s.criterion_refs })) };
    expect(validate(proposal, PLAN_SCHEMA, '$').length).toBeGreaterThan(0);
    const result = admit(stages);
    expect(result.pass).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'stage_retry_to', stageId: 'review', message: expect.stringContaining('gate stages cannot declare retry_to') }));
    expect(result.errors.filter(e => e.code === 'criterion_coverage')).toEqual([]);
    expect(result.criterionGateRefs).toEqual({ review: ['required'] });
  });

  it('keeps schema and admission aligned for explicit repairs and archive-only gate returns', () => {
    const explicit = { stages: [
      { id: 'author', role: 'coder' },
      { id: 'review', role: 'qa', is_gate: true, depends_on: ['author'] },
      { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'] },
    ] };
    expect(validate(explicit, PLAN_SCHEMA, '$')).toEqual([]);
    expect(admit(explicit.stages.map(parseDispatchedStageConfig)).errors).toEqual([]);
    const archivedGate = { ...explicit.stages[1], retry_to: ['author'] };
    expect(validate({ stages: [archivedGate] }, PLAN_SCHEMA, '$').length).toBeGreaterThan(0);
    expect(RecordedStageConfigSchema.parse(archivedGate).retry_to).toEqual(['author']);
  });

  it.each([
    { target: 'author', extra: { condition: 'prior.status == complete' } },
    { target: 'author', extra: { decision: { successors: ['review'], default: 'review' } } },
    { target: 'review', extra: { condition: 'author.status == complete' } },
    { target: 'review', extra: { decision: { successors: ['continue'], default: 'continue' } } },
  ])('requires explicit repair for $target with control flow $extra', ({ target, extra }) => {
    const stages = ordinary();
    Object.assign(stages.find(s => s.id === target)!, extra);
    const result = admit(stages);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'stage_retry_to', stageId: 'review' }));
    expect(stages).toHaveLength(2);
  });

  it('keeps explicit old-shape repairs readable and admissible without regeneration', () => {
    const stages = ordinary();
    stages.push(stage('legacy_repair', { role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['source'], criterion_refs: ['required'] }));
    const archived = stages.map(s => RecordedStageConfigSchema.parse(JSON.parse(JSON.stringify(s))));
    const result = admit(archived);
    expect(result.errors).toEqual([]);
    expect(archived.map(s => s.id)).toEqual(['author', 'review', 'legacy_repair']);
    expect(archived[2].retry_to).toEqual(['review']);
  });

  it('avoids stage-id collisions while preserving deterministic reinspection', () => {
    const stages = ordinary();
    stages.push(stage('repair_review'));
    expect(admit(stages).errors).toEqual([]);
    expect(new Set(stages.map(s => s.id)).size).toBe(stages.length);
    const repair = stages.find(s => s.retry_to?.includes('review'))!;
    expect(repair.id).not.toBe('repair_review');
    const ids = stages.map(s => s.id);
    expect(admit(stages).errors).toEqual([]);
    expect(stages.map(s => s.id)).toEqual(ids);
  });
});
