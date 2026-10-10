import { artifacts } from './spec_contracts/declared-fixtures.js';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { formatDispatchStageSchemaFailure, StageConfigSchema, parseDispatchedStageConfig, inspectDispatchAdmission, parseBriefFrontmatter, readGateVerdict } from '../src/scheduler.js';
import { fcGlobalDir, setFcGlobalDir, createRun, runDir, updateRunState } from '../src/store.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { decideScopeRevision } from '../src/scheduler/sched_scope/scope-revisions.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { inspectRealityChecks } from '../src/reality-check-preflight.js';
import { parsePlannerPolicySelection, renderPlannerPolicies } from '../src/planner-policies.js';

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
  const defaults = parse(readFileSync(resolve(import.meta.dirname, '..', 'config', 'defaults.yaml'), 'utf-8')) as { planner_policies?: unknown };
  return parsed.prompt + '\n' + renderPlannerPolicies(parsePlannerPolicySelection(defaults.planner_policies));
}

function readShipSkill(): string {
  return readFileSync(SHIP_SKILL_PATH, 'utf-8');
}

const CORE_GUARDS = [
  {
    "id": "missing-scope-is-closed"
  },
  {
    "id": "writable-gate-scope"
  },
  {
    "id": "terminal-path-final-stage-only"
  },
  {
    "id": "raw-validation-exit-forbidden"
  },
  {
    "id": "missing-contracted-metric-refuses-before-repair"
  },
  {
    "id": "metric-verdict-consistency-remains-strict"
  },
  {
    "id": "exact-dependency-graph"
  }
] as const;
function verifyCoreGuard(id: string): void {
  const root = mkdtempSync(join(tmpdir(), 'planner-core-protection-'));
  const project = join(root, 'project'); mkdirSync(project);
  const previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  try {
    const stage = (id: string, extra = {}) => StageConfigSchema.parse({criterion_refs: [], dynamic_dispatch: false, id,role:'coder',scope:['docs/**'],depends_on:[],dependency_reasons:{},prompt_template:'Declared work.',artifact_contract:artifacts([], [], [], []),...extra});
    if (id === 'missing-scope-is-closed') {
      const work = parseDispatchedStageConfig({id:'work',role:'coder'});
      expect(work.scope).toEqual([]);
      work.artifact_contract!.produces.push({id:'output',root:'project',path:'docs/out.md',kind:'file',nonempty:true});
      expect(inspectDispatchAdmission({dispatched:[work],baseStages:[],dispatchStageId:'plan'}).errors.join(';')).toContain('ARTIFACT_OUTPUT_OUTSIDE_SCOPE');
    } else if (id === 'writable-gate-scope') {
      const gate = stage('gate', {role:'qa',is_gate:true,scope:[],artifact_contract:artifacts([{id:'probe',root:'project',path:'spec/qa.test.ts'}], [], [], [])});
      expect(inspectDispatchAdmission({dispatched:[gate],baseStages:[],dispatchStageId:'plan'}).errors.join(';')).toContain('ARTIFACT_OUTPUT_OUTSIDE_SCOPE');
    } else if (id === 'terminal-path-final-stage-only') {
      const terminalStates = parseBriefFrontmatter('---\nterminal_states:\n  complete:\n    paths: [docs/final.md]\n---\n').terminalStates;
      const report = inspectDispatchAdmission({dispatched:[stage('first'),stage('second')],baseStages:[],dispatchStageId:'plan',terminalStates});
      expect(report.pass).toBe(false); expect(report.errors.join(';')).toMatch(/terminal.*owner|owner.*terminal/);
    } else if (id === 'exact-dependency-graph') {
      const reader = parseDispatchedStageConfig({...stage('reader'),depends_on:['producer']});
      expect(inspectDispatchAdmission({dispatched:[reader],baseStages:[],dispatchStageId:'plan'}).errors.join(';')).toContain('unknown stage');
    } else if (id === 'raw-validation-exit-forbidden') {
      const report = inspectRealityChecks('Validation may not add a failing test identity.', '## Reality checks\n\x60\x60\x60yaml\nchecks:\n - name: raw status\n   type: exec-script-exit-zero\n   reads: []\n   params: {script: "node validation.mjs"}\n\x60\x60\x60\n', {validationBaseline:{version:1,projectDir:project,discovery:{state:'partial',configPath:join(project,'package.json'),commands:[{role:'test',command:'node',args:['validation.mjs'],display:'node validation.mjs'}],missingRoles:['build','lint']},results:[{role:'test',display:'node validation.mjs',state:'failed',exitCode:1,durationMs:1,output:'',failureCount:1,failureIdentifiers:['known_failure'],failureIdentity:'known'}],gateCriteria:[{role:'test',rule:'no_regression_from_baseline',baselineFailureCount:1,baselineFailureIdentifiers:['known_failure'],description:'No new failures'}]}});
      expect(report.blockingTierFindings.some((finding)=>finding.code==='hard_check_cannot_pass')).toBe(true);
    } else {
      const runId = createRun(project,'fixture','name: fixture\nstages: []\n',['gate']).runId;
      const directory = runDir(project,runId); mkdirSync(join(directory,'stages/gate'),{recursive:true});
      writeFileSync(join(directory,'verdict_gate.json'), JSON.stringify({pass:true,reason:'Claimed passing verdict'}));
      if (id === 'missing-contracted-metric-refuses-before-repair') {
        writeFileSync(join(directory,'stages/gate/metric.json'),JSON.stringify({hasMetric:false}));
        expect(readGateVerdict(project,'gate',runId,{metric:'quality',threshold:7,higherIsBetter:true})).toMatchObject({pass:false,reason:expect.stringContaining('missing required numeric gate value')});
      } else {
        writeFileSync(join(directory,'stages/gate/metric.json'),JSON.stringify({hasMetric:true,metric:'quality',value:0,threshold:1,pass:false}));
        expect(readGateVerdict(project,'gate',runId)).toMatchObject({pass:false,reason:expect.stringContaining('metric says fail')});
      }
    }
  } finally { setFcGlobalDir(previous); rmSync(root,{recursive:true,force:true}); }
}

describe('planner dispatch contract', () => {
  it('names the invalid dispatch field and a repair action', () => {
    const parsed = StageConfigSchema.safeParse({ criterion_refs: [], artifact_contract: artifacts([], [], [], []), id: 'work', role: 'coder', scope: 'src/**' });
    if (parsed.success) throw new Error('invalid dispatch fixture unexpectedly parsed');

    const message = formatDispatchStageSchemaFailure(parsed.error);
    expect(message).toContain('scope:');
    expect(message).toMatch(/fix the named fields.*regenerate dispatch\.yaml/i);
    expect(() => StageConfigSchema.parse({ criterion_refs: [], artifact_contract: artifacts([], [], [], []), id: 'work', role: 'coder', timeout_ms: 1_000 }))
      .toThrow('config/defaults.yaml::default_timeout_ms');
    expect(readPlannerPrompt()).not.toMatch(/^\s+timeout_(?:total_)?ms:/m);
  });

  it.each(CORE_GUARDS)('enforces $id in the core without a planner sentence', ({ id }) => { verifyCoreGuard(id); });

  it('normalizes small plans and retains independent criterion verification', () => {
    const criteria = {version:1 as const,briefDigest:'fixture',criteria:[{id:'required',text:'Do the task.',line:1,section:'Criteria'}]};
    const work = parseDispatchedStageConfig({id:'work',role:'coder',scope:['src/**']});
    const gate = parseDispatchedStageConfig({id:'audit',role:'qa',is_gate:true,depends_on:['work'],scope:[]});
    const admit = (dispatched: typeof work[]) => inspectDispatchAdmission({dispatched,baseStages:[],dispatchStageId:'plan',criteria});
    expect(admit([work]).errors.join(';')).toContain('not assigned to a gate');
    expect(admit([work,gate]).pass).toBe(true);
    expect(gate.criterion_refs).toEqual(['required']);
    expect(gate.artifact_contract!.produces[0].path).toBe('verdict_audit.json');
    expect(admit([parseDispatchedStageConfig({id:'audit',role:'qa',is_gate:true})]).pass).toBe(true);
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
      expect(admit([audit]).pass).toBe(true);
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
      updateRunState(project, runId, state => { recordAdmittedPlan(state, [planner, work, downstream], directory, 'ordinary independent work', true); state.dispatchedStages = [work, downstream]; });
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

  it.each([{id:'work',role:'coder',scope:'src/**'}, {id:'work',role:'coder',scpoe:[]}, {id:'../escape',role:'coder'}, {id:'work',role:'coder',depends_on:null}])('refuses malformed fields rather than defaulting them', raw => {
    expect(() => parseDispatchedStageConfig(raw)).toThrow();
  });

  it('loads a planner that returns the plan and carries downstream analysis in stage instructions', () => {
    expect(readPlannerPrompt()).toContain('Deliver an admissible plan');
    expect(readPlannerPrompt()).toContain('executable JSON schema');
    expect(readPlannerPrompt()).toContain('engine records and summary do not need a finalizer');
    expect(readPlannerPrompt()).not.toContain('Write {run_dir}/dispatch.yaml');
    expect(readPlannerPrompt()).not.toContain('Write {run_dir}/tech_solution.md');
  });
});

describe('public gate and launch-workspace contract', () => {
  it('documents attempt-fresh metrics, durable verdicts, recursive overlays, and population parity', () => {
    const guide = readFileSync(BRIEF_CONTRACT_PATH, 'utf-8');
    expect(guide).toMatch(/Before each execution, the scheduler replaces any older metric artifact\s+with an engine-owned `hasMetric:false` marker/);
    expect(guide).toMatch(/omission fails the run at that first gate\s+evaluation[\s\S]*before any product repair\s+or outer re-plan is dispatched/);
    expect(guide).toMatch(/Gate prompts\s+receive the exact durable path where a rejection will be archived/);
    expect(guide).toMatch(/setup walks the source directory, materializes missing subdirectories, and\s+copies their files into the target/);
    expect(guide).toMatch(/compares the normalized source and target\s+identity sets—not\s+just their counts—and refuses setup/);
    expect(guide).toMatch(/whether or not the brief remembered to declare the ignored test\s+directory/);
  });
});

describe('ship authoring and operator bookkeeping contract', () => {
  it('requires leading input declarations rather than prose or table references', () => {
    expect(readShipSkill()).toMatch(/Declare every source input in a leading frontmatter `inputs:` block\.[\s\S]*A path in prose or a table is\s+only a reference, not a declaration/);
  });

  it('specifies one exact post-launch wrap-up sentence and lifecycle updates', () => {
    const skill = readShipSkill();
    expect(skill).toContain(LAUNCH_WRAP_UP_SENTENCE);
    expect(skill).toMatch(/After cancellation, update or remove that entry\. After re-shipping, replace its id with the new one\./);
  });

  it('keeps the moving ownership boundary explicit', () => {
    const skill = readShipSkill();
    const section = skill.match(/### 2\.\d+ Divide ownership by whether failure announces itself\n([\s\S]*?)(?=\n### 2\.\d+ )/)?.[0];
    expect(section).toBeDefined();
    expect(section).toMatch(/research loop explores within the question[\s\S]*operator changes the question/);
    expect(section).toMatch(/failure announces itself or returns\s+a plausible value/);
    expect(section).toMatch(/boundary moves/);
  });
});
