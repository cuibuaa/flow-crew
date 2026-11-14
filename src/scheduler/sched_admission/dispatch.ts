import { runRecordPath } from '../../run-layout.js';
/** Whole-proposal admission, criterion topology and role/workflow loaders. Declared-input conflict policy is supplied by its owner. */
import { readFileSync, readdirSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parseCondition } from '../../condition.js';
import { join } from 'node:path';
import { type AgentConfig } from '../../adapters/base.js';
import { z } from 'zod';
import { type CriterionDischargeRecord, type StoreState, STAGE_STATUS, type ResearchConfig } from '../../store.js';
import { readAdmittedContract, readBriefCriteriaArtifact, type BriefCriteriaArtifact } from '../../brief-criteria.js';
import { createHash } from 'node:crypto';
import { artifactDeclarationFindings } from '../../artifact-declarations.js';
import { type WorkflowConfig, WorkflowConfigSchema, normalizeStageContracts, type StageConfig, parseDispatchedStageConfig, RecordedWorkflowConfigSchema } from './configuration.js';
import { inspectStageGraph, parallelScopeAdmissionWarnings, transitivelyDependsOn } from './frontier.js';
import { applySharedRoleContract } from '../sched_policy/prompt-contracts.js';

function finiteStatusConditionDomainError(
  stageId: string,
  parsed: ReturnType<typeof parseCondition>,
): string | undefined {
  if (parsed.field !== 'status') return undefined;
  const allowed = new Set<string>(Object.values(STAGE_STATUS));
  if (typeof parsed.value === 'string' && allowed.has(parsed.value)) return undefined;
  return `${stageId}.condition: status literal ${JSON.stringify(parsed.value)} cannot occur; expected one of ${[...allowed].join(', ')}`;
}

export function loadWorkflow(yamlPath: string, recorded = false): { config: WorkflowConfig; raw: string } {
  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = parseYaml(raw);
  const config = (recorded ? RecordedWorkflowConfigSchema : WorkflowConfigSchema).parse(parsed);
  if (config.name === 'default') config.name = 'planner';
  for (const stage of config.stages) {
    if (!stage.condition?.trim()) continue;
    const condition = parseCondition(stage.condition);
    const domainError = finiteStatusConditionDomainError(stage.id, condition);
    if (domainError) throw new Error(domainError);
  }
  normalizeStageContracts(config.stages);
  return { config, raw };
}

/** Load _base.md from agents dir and prepend to agent prompt */
export function loadBasePrompt(agentsDir: string): string {
  try {
    return readFileSync(join(agentsDir, '_base.md'), 'utf-8');
  } catch { return ''; }
}

export function applyBasePrompt(agent: AgentConfig, basePrompt: string): AgentConfig {
  agent = applySharedRoleContract(agent);
  if (!basePrompt) return agent;
  return { ...agent, prompt: basePrompt + '\n\n' + agent.prompt };
}

export function buildRoleRegistry(agentsDir: string): Map<string, { name: string; description: string }> {
  const registry = new Map<string, { name: string; description: string }>();
  try {
    const files = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));
    for (const f of files) {
      try {
        const parsed = parseYaml(readFileSync(join(agentsDir, f), 'utf-8'));
        if (parsed?.name) registry.set(parsed.name, { name: parsed.name, description: parsed.description ?? '' });
      } catch { /* skip malformed file */ }
    }
  } catch { /* agents dir may not exist */ }
  return registry;
}

/** List available skills from config/skills/, surfacing each skill's self-described
 * `description:` front-matter (like roles) so the planner sees WHAT each skill is for,
 * not just its name. Falls back to name-only when a skill has no front-matter. */
export function listAvailableSkills(projectDir: string): string {
  const skillsDir = join(projectDir, 'config', 'skills');
  try {
    const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) return 'none';
    return files.map(f => {
      const name = f.replace('.md', '');
      let desc = '';
      try {
        const head = readFileSync(join(skillsDir, f), 'utf-8').slice(0, 800);
        const fm = head.match(/^---\s*\n([\s\S]*?)\n---/);
        const m = (fm?.[1] ?? '').match(/(?:^|\n)description:\s*(.+)/);
        if (m) desc = m[1].trim().replace(/^["']|["']$/g, '');
      } catch { /* name-only */ }
      return desc ? `- ${name}: ${desc}` : `- ${name}`;
    }).join('\n');
  } catch { return 'none'; }
}

export function resolveDispatchDependencies(dispatched: StageConfig[], _dispatchStageId: string): void {
  // Compatibility export retained for callers compiled against older builds.
  // Dynamic dependencies are now admitted exactly as authored; the framework
  // no longer expands pseudo-edges or inserts planner edges behind the plan's
  // back. Strict parsing/admission reports malformed or unknown dependencies.
  void dispatched;
}

/** Collect all stage IDs that transitively depend on the given stage */
export function collectTransitiveDependents(stageId: string, stages: StageConfig[]): Set<string> {
  const dependents = new Set<string>();
  const queue = [stageId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const s of stages) {
      if (!dependents.has(s.id) && s.id !== stageId && s.depends_on.includes(current)) {
        dependents.add(s.id);
        queue.push(s.id);
      }
    }
  }
  return dependents;
}

/** A copy of a schema-invalid stage without the top-level fields its issues name, if that parses. */
export function shadowStageWithoutInvalidFields(item: Record<string, unknown>, error: unknown): StageConfig | undefined {
  if (!(error instanceof z.ZodError)) return undefined;
  const fields = new Set(error.issues.map((issue) => issue.path[0]).filter((key): key is string => typeof key === 'string'));
  if (fields.size === 0 || fields.has('id') || fields.has('role')) return undefined;
  const shadow = { ...item };
  for (const field of fields) delete shadow[field];
  try {
    return parseDispatchedStageConfig(shadow);
  } catch {
    return undefined;
  }
}

/** Preserve all Zod paths and a repair action in planner-facing schema refusals. */
export function formatDispatchStageSchemaFailure(error: unknown): string {
  const issues = error instanceof z.ZodError
    ? error.issues.map((issue) =>
        `${issue.path.length > 0 ? issue.path.join('.') : '(stage root)'}: ${issue.message}`)
    : [error instanceof Error ? error.message : String(error)];
  return `invalid schema at ${issues.join('; ')}; fix the named fields and regenerate dispatch.yaml`;
}

export interface DispatchAdmissionError {
  code: string;
  message: string;
  stageId?: string;
  field?: string;
}

export function admissionError(code: string, message: string, field?: string, stageId?: string): DispatchAdmissionError {
  return { code, message, ...(stageId ? { stageId } : {}), ...(field ? { field } : {}) };
}

export interface DispatchAdmissionReport {
  version: 1;
  pass: boolean;
  checkedAt: string;
  errors: DispatchAdmissionError[];
  warnings: string[];
  proposalDigest?: string;
  criteriaDigest?: string;
  criterionGateRefs?: Record<string, string[]>;
  /** Engine-derived prior work/gate proofs used by this admission. */
  dischargedCriteria?: CriterionDischargeRecord[];
}

export function readBriefCriteriaForAdmission(runDirPath: string): BriefCriteriaArtifact | undefined {
  readAdmittedContract(runDirPath);
  const parsed = readBriefCriteriaArtifact(runDirPath);
  if (!parsed) return;
  return parsed;
}

export function validatedCriterionDischarges(
  runDirPath: string,
  state: StoreState,
  briefDigest: string | undefined,
): CriterionDischargeRecord[] {
  if (!briefDigest) return [];
  return (state.criterionDischarges ?? []).filter((record) => {
    if (record.briefDigest !== briefDigest) return false;
    const gateEvidence = state.stageEvidence?.find((entry) =>
      entry.iteration === record.iteration
      && entry.stageId === record.gateStageId
      && entry.verdictPath === record.verdictPath
      && entry.status.status === STAGE_STATUS.COMPLETE);
    const workEvidence = state.stageEvidence?.find((entry) =>
      entry.iteration === record.iteration
      && entry.stageId === record.workStageId
      && entry.status.status === STAGE_STATUS.COMPLETE);
    if (!gateEvidence || !workEvidence) return false;
    try {
      const bytes = readFileSync(runRecordPath(runDirPath, record.verdictPath));
      if (createHash('sha256').update(bytes).digest('hex') !== record.verdictSha256) return false;
      const verdict = JSON.parse(bytes.toString('utf-8')) as Record<string, unknown>;
      if (verdict.pass !== true || !verdict.criteria || typeof verdict.criteria !== 'object'
          || Array.isArray(verdict.criteria)) return false;
      const criterion = (verdict.criteria as Record<string, unknown>)[record.criterionId];
      if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return false;
      const detail = criterion as Record<string, unknown>;
      return ['pass', 'carried'].includes(detail.status as string)
        && typeof detail.evidence === 'string'
        && detail.evidence.trim().length > 0;
    } catch {
      return false;
    }
  });
}

export function createDispatchAdmission() {
  return (function inspectDispatchAdmission(input: {
    dispatched: StageConfig[];
    baseStages: StageConfig[];
    dispatchStageId: string;
    research?: ResearchConfig;
    criteria?: BriefCriteriaArtifact;
    criterionDischarges?: CriterionDischargeRecord[];
    projectDir?: string;
    runDir?: string;
  }): DispatchAdmissionReport {
    const errors: DispatchAdmissionError[] = [];
    const all = [...input.baseStages, ...input.dispatched];
    const byId = new Map(all.map(stage => [stage.id, stage]));
    const warnings = parallelScopeAdmissionWarnings(input.dispatched);
    errors.push(...artifactDeclarationFindings({ stages: all, projectDir: input.projectDir, runDir: input.runDir }));
    errors.push(...inspectStageGraph(all).errors);
    for (const stage of input.dispatched) {
      if (stage.decision) {
        for (const successor of stage.decision.successors) if (!['continue', 'replan'].includes(successor) && !byId.has(successor)) {
          errors.push(admissionError('stage_graph', `${stage.id}.decision: unknown successor ${successor}`, 'decision.successors', stage.id));
        }
      }
      if (stage.is_gate && !input.research && !all.some((repair) => !repair.is_gate && !repair.dynamic_dispatch && repair.retry_to?.includes(stage.id))) {
        errors.push(admissionError('stage_retry_to', `${stage.id}: missing repair route; declare an ordinary repair stage with retry_to: [${stage.id}], depends_on: [${stage.id}]. The engine bounds repair rounds by gate_retry_loops without re-planning.`, 'retry_to', stage.id));
      }
      if (stage.condition?.trim()) {
        try {
          const parsed = parseCondition(stage.condition);
          if (!byId.has(parsed.stageId)) errors.push(admissionError('stage_condition', `${stage.id}.condition: unknown stage ${parsed.stageId}; conditions require a declared stage fact`, 'condition', stage.id));
          const finiteDomainError = finiteStatusConditionDomainError(stage.id, parsed);
          if (finiteDomainError) errors.push(admissionError('stage_condition', finiteDomainError, 'condition', stage.id));
        } catch (error) {
          errors.push(admissionError('stage_condition', `${stage.id}.condition: ${error instanceof Error ? error.message : String(error)}`, 'condition', stage.id));
        }
      }
      if (stage.retry_to?.length) {
        const retrySet = new Set(stage.retry_to);
        for (const gateId of retrySet) {
          const gate = byId.get(gateId);
          if (!gate) errors.push(admissionError('stage_retry_to', `${stage.id}.retry_to: unknown gate ${JSON.stringify(gateId)}`, `retry_to.${gateId}`, stage.id));
          else if (gate.is_gate !== true) errors.push(admissionError('stage_retry_to', `${stage.id}.retry_to: ${gateId} is not declared is_gate: true`, `retry_to.${gateId}`, stage.id));
          if (!stage.depends_on.includes(gateId)) errors.push(admissionError('stage_depends_on', `${stage.id}.depends_on: missing retry gate ${gateId}`, `depends_on.${gateId}`, stage.id));
        }
      }
    }

    const criteria = input.criteria?.criteria ?? [];
    const discharged = new Map(
      (input.criterionDischarges ?? [])
        .filter((record) => record.briefDigest === input.criteria?.briefDigest)
        .map((record) => [record.criterionId, record]),
    );
    const criterionIds = new Set(criteria.map((criterion) => criterion.id));
    // Empty refs mean conservative whole-brief responsibility. Explicit subsets
    // keep large plans precise without making small plans repeat generated IDs.
    for (const stage of input.dispatched) {
      if (!stage.dynamic_dispatch && !stage.retry_to?.length && !stage.criterion_refs?.length) stage.criterion_refs = [...criterionIds];
    }
    for (const stage of input.dispatched) {
      for (const ref of stage.criterion_refs ?? []) {
        if (!criterionIds.has(ref)) errors.push(admissionError('stage_criterion_refs', `${stage.id}.criterion_refs: unknown criterion ${JSON.stringify(ref)}`, `criterion_refs.${ref}`, stage.id));
      }
    }
    for (const criterion of criteria) {
      const workers = input.dispatched.filter((stage) => !stage.is_gate && !stage.retry_to?.length && stage.criterion_refs.includes(criterion.id));
      const gates = input.dispatched.filter((stage) => stage.is_gate && stage.criterion_refs.includes(criterion.id));
      if (workers.length === 0 && gates.length === 0 && !discharged.has(criterion.id)) {
        errors.push(admissionError('criterion_coverage', `criterion ${criterion.id}: not assigned to a work stage or gate`, `${criterion.id}`));
      }
      if (workers.length > 0 && gates.length === 0) {
        const emptyDownstreamGates = input.dispatched.filter((stage) => (
          stage.is_gate && stage.criterion_refs.length === 0
          && workers.some((worker) => transitivelyDependsOn(stage.id, worker.id, byId))
        ));
        const hint = emptyDownstreamGates.length === 1
          ? `; downstream ${emptyDownstreamGates[0].id}.criterion_refs is empty — assign this criterion there if that gate is responsible`
          : '';
        errors.push(admissionError('criterion_coverage', `criterion ${criterion.id}: not assigned to a gate${hint}`, `${criterion.id}`));
      } else if (workers.length > 0 && !gates.some((gate) => workers.some((worker) => transitivelyDependsOn(gate.id, worker.id, byId)))) {
        errors.push(admissionError('criterion_coverage', `criterion ${criterion.id}: no assigned gate is downstream of an assigned work stage`, `${criterion.id}`));
      }
    }

    return {
      version: 1,
      pass: errors.length === 0,
      checkedAt: new Date().toISOString(),
      errors,
      warnings,
      criterionGateRefs: Object.fromEntries(
        input.dispatched
          .filter((stage) => stage.is_gate && stage.criterion_refs.length > 0)
          .map((stage) => [stage.id, [...stage.criterion_refs]]),
      ),
      dischargedCriteria: [...discharged.values()],
      ...(input.criteria ? { criteriaDigest: input.criteria.briefDigest } : {}),
    };
  });
}
