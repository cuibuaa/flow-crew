import { artifacts } from './spec_contracts/declared-fixtures.js';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { formatDispatchStageSchemaFailure, StageConfigSchema, parseDispatchedStageConfig, inspectDispatchAdmission } from '../src/scheduler.js';
import { fcGlobalDir, setFcGlobalDir, createRun, runDir, updateRunState } from '../src/store.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { decideScopeRevision } from '../src/scheduler/sched_scope/scope-revisions.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { renderPlannerPolicies } from '../src/planner-policies.js';

const PLANNER_PATH = resolve(import.meta.dirname, '..', 'config', 'agents', 'planner.yaml');
const BRIEF_CONTRACT_PATH = resolve(import.meta.dirname, '..', 'guide', 'brief-contract.md');
const SHIP_SKILL_PATH = resolve(import.meta.dirname, '..', 'skills', 'ship.md');
const LAUNCH_WRAP_UP_SENTENCE = 'FlowCrew task <id> is registered; wrap-up remains: read the result, verify it independently, archive unique output, and reclaim the worktree and branch.';

interface PlannerConfig {
  prompt?: unknown;
}

function readPlannerPrompt(): string {
  const parsed = parse(readFileSync(PLANNER_PATH, 'utf-8')) as PlannerConfig;
  if (typeof parsed.prompt !== 'string') throw new Error('planner.yaml must contain a string prompt');
  return parsed.prompt + '\n' + renderPlannerPolicies(['evidence_statistics']);
}

function readShipSkill(): string {
  return readFileSync(SHIP_SKILL_PATH, 'utf-8');
}

describe('planner dispatch contract', () => {
  it('names the invalid dispatch field and a repair action', () => {
    const parsed = StageConfigSchema.safeParse({ criterion_refs: [], artifact_contract: artifacts([], [], [], []), id: 'work', role: 'coder', scope: 'src/**' });
    if (parsed.success) throw new Error('invalid dispatch fixture unexpectedly parsed');

    const message = formatDispatchStageSchemaFailure(parsed.error);
    expect(message).toContain('scope:');
    expect(message).toMatch(/fix the named fields.*regenerate dispatch\.yaml/i);
    expect(readPlannerPrompt()).not.toMatch(/^\s+timeout_(?:total_)?ms:/m);
  });

  it('normalizes small plans and retains independent criterion verification', () => {
    const criteria = {version:1 as const,briefDigest:'fixture',criteria:[{id:'required',text:'Do the task.',line:1,section:'Criteria'}]};
    const work = parseDispatchedStageConfig({id:'work',role:'coder',scope:['src/**']});
    const gate = parseDispatchedStageConfig({id:'audit',role:'qa',is_gate:true,depends_on:['work'],scope:[]});
    const repair = parseDispatchedStageConfig({id:'repair',role:'coder',depends_on:['audit'],retry_to:['audit'],scope:['src/**']});
    const admit = (dispatched: typeof work[]) => inspectDispatchAdmission({dispatched,baseStages:[],dispatchStageId:'plan',criteria});
    expect(admit([work]).errors.join(';')).toContain('not assigned to a gate');
    expect(admit([work,gate,repair]).pass).toBe(true);
    expect(gate.criterion_refs).toEqual(['required']);
    expect(gate.artifact_contract!.produces[0].path).toBe('verdict_audit.json');
    expect(admit([parseDispatchedStageConfig({id:'audit',role:'qa',is_gate:true}),{...repair,scope:[]}]).pass).toBe(true);
  });

  it('refuses a sole product-authoring gate, including a later scope amendment, while retaining independent audits and repairs', () => {
    const root = mkdtempSync(join(tmpdir(), 'planner-independent-audit-'));
    const project = join(root, 'project'); mkdirSync(project);
    const previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
    try {
      const brief = '# Criteria\n1. Independently check existing work.\n';
      const criteria = extractBriefCriteria(brief);
      const audit = parseDispatchedStageConfig({ id: 'audit', role: 'qa', is_gate: true });
      const repair = parseDispatchedStageConfig({ id: 'repair', role: 'coder', scope: ['src/**'], depends_on: ['audit'], retry_to: ['audit'] });
      const planner = parseDispatchedStageConfig({ id: 'plan', role: 'planner', dynamic_dispatch: true });
      const admit = (dispatched: typeof audit[]) => inspectDispatchAdmission({ dispatched, baseStages: [], dispatchStageId: 'plan', criteria });
      expect(admit([{ ...audit, scope: ['src/**'] }]).errors.join(';')).toContain('not assigned to a capable work/finalizer stage');
      expect(admit([audit, { ...repair, scope: [] }]).pass).toBe(true);
      expect(admit([audit, repair]).pass).toBe(true);
      expect(admit([{ ...audit, scope: ['docs/report.md'] }, repair]).pass).toBe(false);
      const runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['audit', 'repair']).runId;
      const directory = runDir(project, runId);
      writeFileSync(join(directory, 'task_brief.md'), brief);
      writeFileSync(join(directory, 'brief_criteria.json'), JSON.stringify(criteria));
      updateRunState(project, runId, state => { recordAdmittedPlan(state, [planner, audit, repair], directory, 'existing-work audit', true); state.dispatchedStages = [audit, repair]; });
      const revise = (stage: typeof audit, paths: string[]) => decideScopeRevision({
        request: { version: 1, kind: 'scope_revision', requestId: stage.id, runId, stageId: stage.id, attemptIndex: 1, requestedPaths: paths, pathDigest: scopePathDigest(paths), reason: 'Need product capability' },
        stage, priorScope: stage.scope ?? [], activePeers: [], projectDir: project, runId, attemptIndex: 1,
      });
      const denied = revise(audit, ['src/**']);
      expect(denied.accepted).toBe(false);
      expect(denied.rejectionReason).toContain('not assigned to a capable work/finalizer stage');
      expect(revise(repair, ['src/other.js']).accepted).toBe(true);
      const work = parseDispatchedStageConfig({ id: 'work', role: 'coder', scope: ['src/**'] });
      const downstream = { ...audit, depends_on: ['work'] };
      updateRunState(project, runId, state => { recordAdmittedPlan(state, [planner, work, downstream, repair], directory, 'ordinary independent work', true); state.dispatchedStages = [work, downstream, repair]; });
      expect(revise(downstream, ['docs/report.md']).accepted).toBe(true);
      // Base workflow stages are not newly dispatched criterion owners.
      updateRunState(project, runId, state => { recordAdmittedPlan(state, [planner, work, downstream, repair], directory, 'audit after base work', true); state.dispatchedStages = [downstream, repair]; });
      expect(revise(downstream, ['docs/report.md']).accepted).toBe(false);
      // Static workflows and pre-launch library fixtures never acquired the
      // dynamic criterion contract; scope negotiation retains that boundary.
      updateRunState(project, runId, state => { recordAdmittedPlan(state, [audit, repair], directory, 'static workflow', true); });
      expect(revise(audit, ['docs/report.md']).accepted).toBe(true);
      writeFileSync(join(directory, 'brief_criteria.json'), JSON.stringify({ ...criteria, criteria: [] }));
      const legacyAudit = { ...audit, criterion_refs: [] };
      updateRunState(project, runId, state => { recordAdmittedPlan(state, [planner, legacyAudit, repair], directory, 'legacy library fixture', true); state.dispatchedStages = [legacyAudit, repair]; });
      expect(revise(repair, ['src/other.js']).accepted).toBe(true);
    } finally { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  it('loads a planner that authors the plan and carries downstream analysis in stage instructions', () => {
    expect(readPlannerPrompt()).toContain('Deliver an admissible plan');
    expect(readPlannerPrompt()).toContain('executable JSON schema');
    expect(readPlannerPrompt()).toContain('engine records and summary do not need a finalizer');
    expect(readPlannerPrompt()).toContain('stage contract declares the plan output');
    expect(readPlannerPrompt()).not.toContain('engine publishes dispatch.yaml');
    expect(readPlannerPrompt()).not.toContain('Write {run_dir}/tech_solution.md');
  });
});

describe('public gate and launch-workspace contract', () => {
  it('documents binding gate scores, durable verdicts, recursive overlays, and population parity', () => {
    const protocol = readFileSync(resolve(import.meta.dirname, '..', 'guide', 'agent-protocol.md'), 'utf-8').replace(/\s+/g, ' ');
    const operations = readFileSync(resolve(import.meta.dirname, '..', 'guide', 'operations.md'), 'utf-8').replace(/\s+/g, ' ');
    expect(protocol).toContain('no optional campaign principal-metric publication channel');
    expect(protocol).toContain('supply finite numeric evidence when required');
    expect(protocol).toContain('before dispatching ordinary product repair');
    expect(protocol).toContain('Gate rejection archives under the injected');
    expect(protocol).toContain('gate_reevaluation/iteration_<n>/round_<n>/');
    expect(operations).toContain('copies of regular files/directories');
    expect(operations.toLowerCase()).toContain('target-owned');
    expect(operations).toContain('normalized source/target identities');
    expect(operations).toContain('unverified');
    expect(operations).toContain('source suites are not run');
  });
});

describe('ship authoring and operator bookkeeping contract', () => {
  it('requires leading input declarations rather than prose or table references', () => {
    expect(readShipSkill()).toMatch(/Declare every source input in a leading\s+frontmatter `inputs:` block\.[\s\S]*A path in prose or a table is only a reference, not a declaration/);
  });

  it('specifies one exact post-launch wrap-up sentence and lifecycle updates', () => {
    const skill = readShipSkill();
    expect(skill).toContain(LAUNCH_WRAP_UP_SENTENCE);
    expect(skill).toMatch(/After cancellation, update or remove that entry\. After re-shipping, replace its id with the new one\./);
  });

  it('keeps the moving ownership boundary explicit', () => {
    const skill = readShipSkill();
    const section = skill.match(/## Ownership and verification\n([\s\S]*?)(?=\n## Human wrap-up)/)?.[0];
    expect(section).toBeDefined();
    expect(section).toMatch(/research loop within the question[\s\S]*operator changes the question/);
    expect(section).toMatch(/failure announces itself or returns\s+a plausible value/);
    expect(section).toMatch(/boundary moves/);
  });
});
