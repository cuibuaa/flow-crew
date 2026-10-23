/** Whole-proposal admission, terminal/criterion topology and role/workflow loaders. Declared-input conflict policy is supplied by its owner. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parseCondition } from '../../condition.js';
import { join } from 'node:path';
import { type AgentConfig } from '../../adapters/base.js';
import { z } from 'zod';
import { type CriterionDischargeRecord, type StoreState, STAGE_STATUS, type TerminalStatesConfig, type ResearchConfig } from '../../store.js';
import { type BriefCriteriaArtifact } from '../../brief-criteria.js';
import { createHash } from 'node:crypto';
import { artifactDeclarationFindings } from '../../artifact-declarations.js';
import { resolveResearchPaths } from '../../research-paths.js';
import { type WorkflowConfig, WorkflowConfigSchema, normalizeStageContracts, type StageConfig, parseDispatchedStageConfig, EMITTED_RESEARCH_DECISIONS, RecordedWorkflowConfigSchema } from './configuration.js';
import { finiteStatusConditionDomainError, researchTerminalConditionExcludesContinue, assessTerminalConditionCoverage } from './condition-coverage.js';
import { normalizedProjectPath, scopeMatchesProjectPath } from './scope-services.js';
import { inspectStageGraph, parseDeclaredScope, parallelScopeAdmissionWarnings, transitivelyDependsOn } from './frontier.js';
import { applySharedRoleContract } from '../sched_policy/prompt-contracts.js';

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
  terminalOwners: Record<string, string>;
  /** Declared finalizer capability that may be touched for validation but may not leave a durable delta. */
  criteriaDigest?: string;
  criterionGateRefs?: Record<string, string[]>;
  criterionTerminalRefs?: Record<string, string[]>;
  /** Engine-derived prior work/gate proofs used by this admission. */
  dischargedCriteria?: CriterionDischargeRecord[];
}

export function readBriefCriteriaForAdmission(runDirPath: string): BriefCriteriaArtifact | undefined {
  const path = join(runDirPath, 'brief_criteria.json');
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as BriefCriteriaArtifact;
  if (parsed.version !== 1 || typeof parsed.briefDigest !== 'string' || !Array.isArray(parsed.criteria)) {
    throw new Error('brief_criteria.json has an invalid shape');
  }
  const briefPath = join(runDirPath, 'task_brief.md');
  if (existsSync(briefPath)) {
    const currentDigest = createHash('sha256').update(readFileSync(briefPath, 'utf-8'), 'utf8').digest('hex');
    if (currentDigest !== parsed.briefDigest) throw new Error('brief_criteria.json digest does not match task_brief.md');
  }
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
      const bytes = readFileSync(join(runDirPath, record.verdictPath));
      if (createHash('sha256').update(bytes).digest('hex') !== record.verdictSha256) return false;
      const verdict = JSON.parse(bytes.toString('utf-8')) as Record<string, unknown>;
      if (verdict.pass !== true || !verdict.criteria || typeof verdict.criteria !== 'object'
          || Array.isArray(verdict.criteria)) return false;
      const criterion = (verdict.criteria as Record<string, unknown>)[record.criterionId];
      if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return false;
      const detail = criterion as Record<string, unknown>;
      return detail.status === 'pass'
        && typeof detail.evidence === 'string'
        && detail.evidence.trim().length > 0;
    } catch {
      return false;
    }
  });
}

export function stageScopeOwnsPath(stage: StageConfig, rawPath: string): boolean {
  const path = normalizedProjectPath(rawPath);
  if (!path || !stage.scope) return false;
  return stage.scope.some((rawScope) => {
    const scope = parseDeclaredScope(rawScope);
    return scope.kind !== 'unknown' && scopeMatchesProjectPath(scope, path);
  });
}

export function createDispatchAdmission() {
  return (function inspectDispatchAdmission(input: {
    dispatched: StageConfig[];
    baseStages: StageConfig[];
    dispatchStageId: string;
    terminalStates?: TerminalStatesConfig;
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
      if (stage.is_gate && !all.some((repair) => !repair.is_gate && !repair.dynamic_dispatch && repair.retry_to?.includes(stage.id))) {
        errors.push(admissionError('stage_retry_to', `${stage.id}: missing repair route; declare an ordinary repair stage with retry_to: [${stage.id}], depends_on: [${stage.id}], and scope for the permitted repairs. The engine bounds repair rounds by gate_retry_loops without re-planning.`, 'retry_to', stage.id));
      }
      if (input.research && stage.id === 'research') {
        errors.push(admissionError('stage_id', `${stage.id}.id: reserved for framework-owned research policy facts; choose a different stage ID`, 'id', stage.id));
      }
      if (stage.condition?.trim()) {
        try {
          const parsed = parseCondition(stage.condition);
          if (!input.research && parsed.stageId === 'research') {
            errors.push(admissionError('stage_condition', `${stage.id}.condition: references framework research facts in a non-research run; remove the condition or declare research mode`, 'condition', stage.id));
          }
          const finiteDomainError = finiteStatusConditionDomainError(stage.id, parsed);
          if (finiteDomainError) errors.push(admissionError('stage_condition', finiteDomainError, 'condition', stage.id));
          if (parsed.stageId === 'research' && parsed.op === '==') {
            if (parsed.field === 'decision') {
              if (typeof parsed.value !== 'string' || !EMITTED_RESEARCH_DECISIONS.has(parsed.value)) {
                errors.push(admissionError('stage_condition', `${stage.id}.condition: research.decision literal ${JSON.stringify(parsed.value)} cannot occur; expected one of ${[...EMITTED_RESEARCH_DECISIONS].join(', ')}`, 'condition', stage.id));
              }
            } else if (parsed.field === 'terminalStatus') {
              const statuses = new Set(Object.keys(input.terminalStates ?? {}));
              if (typeof parsed.value !== 'string' || !statuses.has(parsed.value)) {
                errors.push(admissionError('stage_condition', `${stage.id}.condition: research.terminalStatus literal ${JSON.stringify(parsed.value)} is not declared by terminal_states`, 'condition', stage.id));
              }
            } else if (parsed.field === 'terminalPath') {
              const paths = new Set(Object.values(input.terminalStates ?? {}).flatMap((entry) => entry.paths));
              if (typeof parsed.value !== 'string' || !paths.has(parsed.value)) {
                errors.push(admissionError('stage_condition', `${stage.id}.condition: research.terminalPath literal ${JSON.stringify(parsed.value)} is not declared by terminal_states`, 'condition', stage.id));
              }
            }
          }
        } catch (error) {
          errors.push(admissionError('stage_condition', `${stage.id}.condition: ${error instanceof Error ? error.message : String(error)}`, 'condition', stage.id));
        }
      }
      for (const [index, scope] of (stage.scope ?? []).entries()) {
        const parsed = parseDeclaredScope(scope);
        if (parsed.kind === 'unknown') errors.push(admissionError('stage_scope', `${stage.id}.scope.${index}: ${parsed.reason}`, `scope.${scope}`, stage.id));
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

    const terminalOwners: Record<string, string> = {};
    const ownerIds = new Set<string>();
    const checkedResearchOwnerIds = new Set<string>();
    const terminalDeclarations = Object.entries(input.terminalStates ?? {})
      .flatMap(([status, entry]) => entry.paths.map((path) => ({ status, path })));
    const declarationsByPath = new Map<string, Array<{ status: string; path: string }>>();
    for (const declaration of terminalDeclarations) {
      const normalized = normalizedProjectPath(declaration.path) ?? declaration.path;
      const pathRows = declarationsByPath.get(normalized) ?? [];
      pathRows.push(declaration);
      declarationsByPath.set(normalized, pathRows);
    }
    for (const [path, declarations] of declarationsByPath) {
      if (declarations.length > 1) {
        errors.push(admissionError('terminal_owner', `terminal_states path ${path}: declared more than once (${declarations.map((item) => item.status).join(', ')}); one path cannot encode multiple outcomes`, `terminal_states.${path}`));
      }
    }
    for (const declaration of terminalDeclarations) {
      const rawPath = declaration.path;
        const writers = input.dispatched.filter((stage) => !stage.is_gate && !stage.retry_to?.length && stageScopeOwnsPath(stage, rawPath));
        const owners = writers.filter((stage) => !writers.some((other) => other.id !== stage.id && transitivelyDependsOn(other.id, stage.id, byId)));
        if (owners.length !== 1) {
          errors.push(admissionError('terminal_owner', `terminal_states path ${rawPath}: expected exactly one final producer, found ${owners.length}${owners.length ? ` (${owners.map((stage) => stage.id).join(', ')})` : ''}`, `terminal_states.${rawPath}`));
          continue;
        }
        const owner = owners[0];
        terminalOwners[rawPath] = owner.id;
        ownerIds.add(owner.id);
        if (input.research && !researchTerminalConditionExcludesContinue(owner.condition, declaration)) {
          errors.push(admissionError('terminal_owner_condition', `terminal owner ${owner.id}.condition: must be mechanically false when research.decision is continue; use research.terminalPath == ${JSON.stringify(rawPath)} (preferred), matching research.terminalStatus, or another narrow non-continue equality`, 'condition', owner.id));
        }
        if (input.research && !checkedResearchOwnerIds.has(owner.id)) {
          checkedResearchOwnerIds.add(owner.id);
          const researchPaths = resolveResearchPaths(input.research);
          const resultFile = normalizedProjectPath(researchPaths.resultFile);
          const researchOutputs = [
            resultFile,
            resultFile ? `${resultFile}.no_candidate.json` : undefined,
          ].filter((path): path is string => Boolean(path));
          for (const researchOutput of researchOutputs) {
            if (stageScopeOwnsPath(owner, researchOutput)) {
              errors.push(admissionError('terminal_owner_scope', `terminal owner ${owner.id}.scope: research result producer path ${researchOutput} cannot be owned by a terminal writer; separate measurement from terminalization`, 'scope', owner.id));
            }
          }
        }
    }

    if (terminalDeclarations.length > 0 && Object.keys(terminalOwners).length === terminalDeclarations.length) {
      const coverage = assessTerminalConditionCoverage(all, [...ownerIds]);
      if (coverage.checked && coverage.coversOrdinaryQuiescence === false) {
        const assignment = Object.entries(coverage.uncoveredAssignment ?? {})
          .map(([stageId, status]) => `${stageId}.status=${status}`)
          .join(', ');
        errors.push(admissionError('terminal_owner', `terminal owner conditions do not cover ordinary quiescence${assignment ? ` (${assignment})` : ''}; add a mutually exclusive owner condition that is true after successful required work`, 'terminal_states'));
      }
    }

    const criteria = input.criteria?.criteria ?? [];
    if (input.criteria && criteria.length === 0) {
      errors.push(admissionError('criteria_missing', 'brief_criteria.json contains zero criteria; dispatch cannot prove coverage', 'criteria'));
    }
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
    const criterionTerminalRefs = new Map<string, string[]>();
    for (const criterion of criteria) {
      const workers = input.dispatched.filter((stage) => !stage.is_gate && !stage.retry_to?.length && stage.criterion_refs.includes(criterion.id));
      const terminalWorkers = workers.filter((stage) => ownerIds.has(stage.id));
      const ordinaryWorkers = workers.filter((stage) => !ownerIds.has(stage.id));
      const gates = input.dispatched.filter((stage) => stage.is_gate && stage.criterion_refs.includes(criterion.id));
      if (workers.length === 0 && gates.length === 0 && !discharged.has(criterion.id)) {
        errors.push(admissionError('criterion_coverage', `criterion ${criterion.id}: not assigned to a work stage or gate`, `${criterion.id}`));
      }
      // Review duties need no fictitious author. A gate with project write
      // authority still cannot stand in for the independent product author.
      if (workers.length === 0 && gates.some((gate) => gate.scope?.length)) {
        errors.push(admissionError('criterion_coverage', `criterion ${criterion.id}: product-writing gate requires an independent work stage`, `${criterion.id}`));
      }
      for (const owner of terminalWorkers) {
        const refs = criterionTerminalRefs.get(owner.id) ?? [];
        refs.push(criterion.id);
        criterionTerminalRefs.set(owner.id, refs);
      }
      if (ordinaryWorkers.length > 0 && gates.length === 0) {
        const emptyDownstreamGates = input.dispatched.filter((stage) => (
          stage.is_gate && stage.criterion_refs.length === 0
          && ordinaryWorkers.some((worker) => transitivelyDependsOn(stage.id, worker.id, byId))
        ));
        const hint = emptyDownstreamGates.length === 1
          ? `; downstream ${emptyDownstreamGates[0].id}.criterion_refs is empty — assign this criterion there if that gate is responsible`
          : '';
        errors.push(admissionError('criterion_coverage', `criterion ${criterion.id}: not assigned to a gate${hint}`, `${criterion.id}`));
      } else if (ordinaryWorkers.length > 0 && !gates.some((gate) => ordinaryWorkers.some((worker) => transitivelyDependsOn(gate.id, worker.id, byId)))) {
        errors.push(admissionError('criterion_coverage', `criterion ${criterion.id}: no assigned gate is downstream of an assigned work stage`, `${criterion.id}`));
      }
    }

    return {
      version: 1,
      pass: errors.length === 0,
      checkedAt: new Date().toISOString(),
      errors,
      warnings,
      terminalOwners,
      criterionGateRefs: Object.fromEntries(
        input.dispatched
          .filter((stage) => stage.is_gate && stage.criterion_refs.length > 0)
          .map((stage) => [stage.id, [...stage.criterion_refs]]),
      ),
      criterionTerminalRefs: Object.fromEntries(criterionTerminalRefs),
      dischargedCriteria: [...discharged.values()],
      ...(input.criteria ? { criteriaDigest: input.criteria.briefDigest } : {}),
    };
  });
}
