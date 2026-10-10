/** Whole-proposal admission, terminal/criterion topology and role/workflow loaders. Declared-input conflict policy is supplied by its owner. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parseCondition } from '../../condition.js';
import { join, posix } from 'node:path';
import { type AgentConfig } from '../../adapters/base.js';
import { z } from 'zod';
import { type CriterionDischargeRecord, type StoreState, STAGE_STATUS, type TerminalStatesConfig, type ResearchConfig } from '../../store.js';
import type { RealityCheckPreflightReport } from '../../reality-check-preflight.js';
import { type BriefCriteriaArtifact } from '../../brief-criteria.js';
import { createHash } from 'node:crypto';
import { inspectArtifactDeclarations } from '../../artifact-declarations.js';
import { resolveResearchPaths } from '../../research-paths.js';
import { discoverProjectValidation } from '../../project-validation.js';
import { type WorkflowConfig, WorkflowConfigSchema, normalizeRetryGateRelationships, type StageConfig, parseDispatchedStageConfig, EMITTED_RESEARCH_DECISIONS } from './configuration.js';
import { finiteStatusConditionDomainError, researchTerminalConditionExcludesContinue, assessTerminalConditionCoverage } from './condition-coverage.js';
import { normalizedProjectPath, scopeMatchesProjectPath } from './scope-services.js';
import { parseDeclaredScope, parallelScopeAdmissionWarnings, transitivelyDependsOn } from './frontier.js';
import { discoverConfiguredCommandScopes, configuredCommandRolesForStage } from './project-capabilities.js';
import type { DeclaredInputScopeServices } from './scope-services.js';
import type { DeclaredInputWriteBinding } from '../../scheduler.js';

export function loadWorkflow(yamlPath: string): { config: WorkflowConfig; raw: string } {
  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = parseYaml(raw);
  const config = WorkflowConfigSchema.parse(parsed);
  for (const stage of config.stages) {
    if (!stage.condition?.trim()) continue;
    const condition = parseCondition(stage.condition);
    const domainError = finiteStatusConditionDomainError(stage.id, condition);
    if (domainError) throw new Error(domainError);
  }
  normalizeRetryGateRelationships(config.stages);
  return { config, raw };
}

/** Load _base.md from agents dir and prepend to agent prompt */
export function loadBasePrompt(agentsDir: string): string {
  try {
    return readFileSync(join(agentsDir, '_base.md'), 'utf-8');
  } catch { return ''; }
}

export function applyBasePrompt(agent: AgentConfig, basePrompt: string): AgentConfig {
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

export interface DispatchAdmissionReport {
  version: 1;
  pass: boolean;
  checkedAt: string;
  errors: string[];
  warnings: string[];
  proposalDigest?: string;
  terminalOwners: Record<string, string>;
  /** Declared finalizer capability that may be touched for validation but may not leave a durable delta. */
  terminalValidationScopes?: Record<string, string[]>;
  criteriaDigest?: string;
  criterionGateRefs?: Record<string, string[]>;
  criterionTerminalRefs?: Record<string, string[]>;
  /** Engine-derived prior work/gate proofs used by this admission. */
  dischargedCriteria?: CriterionDischargeRecord[];
  /** Exact framework-owned entries removed from admitted stage write scopes. */
  frameworkReservedScopes?: Record<string, string[]>;
  /** Closed planning-time relation between configured-command runners and generated outputs. */
  configuredCommandScopes?: string[];
  configuredCommandStageRoles?: Record<string, string[]>;
  /** Same candidate's structured check findings; no second refusal pipeline. */
  realityPreflight?: RealityCheckPreflightReport;
}

/** Materialize the admitted scope after subtracting exact framework-owned
 * reservations. The admission artifact retains the subtraction as evidence. */
export function applyFrameworkScopeReservations(
  stages: readonly StageConfig[],
  reservations: Readonly<Record<string, readonly string[]>> = {},
): void {
  for (const stage of stages) {
    const reserved = new Set(reservations[stage.id] ?? []);
    if (reserved.size > 0) stage.scope = (stage.scope ?? []).filter((scope) => !reserved.has(scope));
  }
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

function dispatchGlobRegex(raw: string): RegExp | undefined {
  const normalized = normalizedProjectPath(raw);
  if (!normalized) return undefined;
  const globstarSentinel = '__FLOWCREW_GLOBSTAR__';
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, globstarSentinel)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll(globstarSentinel, '.*');
  try { return new RegExp(`^${escaped}$`); } catch { return undefined; }
}

export function stageScopeOwnsPath(stage: StageConfig, rawPath: string): boolean {
  const path = normalizedProjectPath(rawPath);
  if (!path || !stage.scope) return false;
  return stage.scope.some((rawScope) => {
    const scope = parseDeclaredScope(rawScope);
    return scope.kind !== 'unknown' && scopeMatchesProjectPath(scope, path);
  });
}

export function createDispatchAdmission(firstDeclaredInputScopeConflict: DeclaredInputScopeServices['firstDeclaredInputScopeConflict']) {
  return (function inspectDispatchAdmission(input: {
    dispatched: StageConfig[];
    baseStages: StageConfig[];
    dispatchStageId: string;
    terminalStates?: TerminalStatesConfig;
    research?: ResearchConfig;
    criteria?: BriefCriteriaArtifact;
    criterionDischarges?: CriterionDischargeRecord[];
    declaredInputs?: readonly DeclaredInputWriteBinding[];
    projectDir?: string;
    runDir?: string;
  }): DispatchAdmissionReport {
    const errors: string[] = [];
    const warnings = parallelScopeAdmissionWarnings(input.dispatched);
    const all = [...input.baseStages, ...input.dispatched];
    const byId = new Map(all.map((stage) => [stage.id, stage]));
    errors.push(...inspectArtifactDeclarations({
      stages: all,
      scopeOwns: (stage, path) => stageScopeOwnsPath(byId.get(stage.id)!, path),
      projectDir: input.projectDir,
      runDir: input.runDir,
    }));
    const knownIds = new Set(byId.keys());
    const frameworkReservedScopes = new Map<string, string[]>();
    const frameworkManifest = input.research
      ? normalizedProjectPath(resolveResearchPaths(input.research).manifestFile)
      : undefined;

    for (const stage of input.dispatched) {
      if (input.research && stage.id === 'research') {
        errors.push(`${stage.id}.id: reserved for framework-owned research policy facts; choose a different stage ID`);
      }
      if (stage.condition?.trim()) {
        try {
          const parsed = parseCondition(stage.condition);
          if (!input.research && parsed.stageId === 'research') {
            errors.push(`${stage.id}.condition: references framework research facts in a non-research run; remove the condition or declare research mode`);
          }
          const finiteDomainError = finiteStatusConditionDomainError(stage.id, parsed);
          if (finiteDomainError) errors.push(finiteDomainError);
          if (parsed.stageId === 'research' && parsed.op === '==') {
            if (parsed.field === 'decision') {
              if (typeof parsed.value !== 'string' || !EMITTED_RESEARCH_DECISIONS.has(parsed.value)) {
                errors.push(`${stage.id}.condition: research.decision literal ${JSON.stringify(parsed.value)} cannot occur; expected one of ${[...EMITTED_RESEARCH_DECISIONS].join(', ')}`);
              }
            } else if (parsed.field === 'terminalStatus') {
              const statuses = new Set(Object.keys(input.terminalStates ?? {}));
              if (typeof parsed.value !== 'string' || !statuses.has(parsed.value)) {
                errors.push(`${stage.id}.condition: research.terminalStatus literal ${JSON.stringify(parsed.value)} is not declared by terminal_states`);
              }
            } else if (parsed.field === 'terminalPath') {
              const paths = new Set(Object.values(input.terminalStates ?? {}).flatMap((entry) => entry.paths));
              if (typeof parsed.value !== 'string' || !paths.has(parsed.value)) {
                errors.push(`${stage.id}.condition: research.terminalPath literal ${JSON.stringify(parsed.value)} is not declared by terminal_states`);
              }
            }
          }
        } catch (error) {
          errors.push(`${stage.id}.condition: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const [index, scope] of (stage.scope ?? []).entries()) {
        const parsed = parseDeclaredScope(scope);
        if (parsed.kind === 'unknown') errors.push(`${stage.id}.scope.${index}: ${parsed.reason}`);
      }
      if (frameworkManifest && stageScopeOwnsPath(stage, frameworkManifest)) {
        const matchingScopes = (stage.scope ?? []).filter((rawScope) => (
          scopeMatchesProjectPath(parseDeclaredScope(rawScope), frameworkManifest)
        ));
        const exactReservations = matchingScopes.filter((rawScope) => {
          const parsed = parseDeclaredScope(rawScope);
          return parsed.kind === 'exact' && parsed.value === frameworkManifest;
        });
        const nonSubtractable = matchingScopes.filter((rawScope) => !exactReservations.includes(rawScope));
        if (nonSubtractable.length > 0) {
          errors.push(`${stage.id}.scope: write capability ${JSON.stringify(nonSubtractable[0])} contains framework-owned research manifest ${frameworkManifest}; use narrower scopes because the scheduler rewrites that path between rounds`);
        }
        if (exactReservations.length > 0) frameworkReservedScopes.set(stage.id, exactReservations);
      }
      const inputConflict = firstDeclaredInputScopeConflict(
        stage.scope ?? [],
        input.declaredInputs ?? [],
        input.projectDir,
      );
      if (inputConflict) {
        errors.push(`${stage.id}.scope: write capability ${JSON.stringify(inputConflict.scope)} overlaps declared read-only input ${inputConflict.inputPath} (${inputConflict.inputKind}, ${inputConflict.comparison})`);
      }
      for (const dependency of stage.depends_on) {
        if (dependency === stage.id) errors.push(`${stage.id}.depends_on: self dependency is forbidden`);
        else if (!knownIds.has(dependency)) {
          errors.push(`${stage.id}.depends_on: unknown stage ${JSON.stringify(dependency)}`);
        }
      }
      if (stage.retry_to?.length) {
        const retrySet = new Set(stage.retry_to);
        for (const gateId of retrySet) {
          const gate = byId.get(gateId);
          if (!gate) errors.push(`${stage.id}.retry_to: unknown gate ${JSON.stringify(gateId)}`);
          else if (gate.is_gate !== true) errors.push(`${stage.id}.retry_to: ${gateId} is not declared is_gate: true`);
          if (!stage.depends_on.includes(gateId)) errors.push(`${stage.id}.depends_on: missing retry gate ${gateId}`);
        }
        const retryGateDeps = stage.depends_on.filter((dependency) => byId.get(dependency)?.is_gate === true);
        for (const gateId of retryGateDeps) {
          if (!retrySet.has(gateId)) errors.push(`${stage.id}.retry_to: missing gate dependency ${gateId}`);
        }
      }
    }

    const configuredCommands = input.projectDir
      ? discoverProjectValidation(input.projectDir).commands
      : [];
    const configuredCommandScopes = input.projectDir && configuredCommands.length > 0
      ? discoverConfiguredCommandScopes(input.projectDir)
      : [];
    const configuredCommandStageRoles = new Map<string, string[]>();
    if (configuredCommands.length > 0) {
      for (const stage of input.dispatched) {
        const roles = configuredCommandRolesForStage(stage, configuredCommands);
        if (roles.length === 0) continue;
        configuredCommandStageRoles.set(stage.id, roles);
      }
    }

    // Refuse cycles instead of rewriting their edges.
    for (const stage of input.dispatched) {
      if (transitivelyDependsOn(stage.id, stage.id, byId)) errors.push(`${stage.id}.depends_on: dependency cycle detected`);
    }

    const terminalOwners: Record<string, string> = {};
    const ownerIds = new Set<string>();
    const terminalValidationScopeSets = new Map<string, Set<string>>();
    const checkedResearchOwnerIds = new Set<string>();
    const terminalDeclarations = Object.entries(input.terminalStates ?? {})
      .flatMap(([status, entry]) => entry.paths.map((path) => ({ status, path })));
    const declaredTerminalPaths = new Set(terminalDeclarations
      .map((entry) => normalizedProjectPath(entry.path))
      .filter((path): path is string => Boolean(path)));
    const declaredTerminalEvidenceGlobs = Object.values(input.terminalStates ?? {}).flatMap((entry) => {
      if (entry.floor?.minAttemptedStages === undefined) return [];
      if (entry.stageGlob) return [entry.stageGlob];
      const first = entry.paths[0];
      if (!first) return [];
      const normalized = normalizedProjectPath(first);
      if (!normalized) return [];
      const directory = posix.dirname(normalized);
      return [`${directory === '.' ? '' : `${directory}/`}stage_*_verdict.md`];
    });
    const declarationsByPath = new Map<string, Array<{ status: string; path: string }>>();
    const declarationsByBasename = new Map<string, Array<{ status: string; path: string }>>();
    for (const declaration of terminalDeclarations) {
      const normalized = normalizedProjectPath(declaration.path) ?? declaration.path;
      const pathRows = declarationsByPath.get(normalized) ?? [];
      pathRows.push(declaration);
      declarationsByPath.set(normalized, pathRows);
      const basename = posix.basename(normalized.replace(/\\/g, '/'));
      const basenameRows = declarationsByBasename.get(basename) ?? [];
      basenameRows.push(declaration);
      declarationsByBasename.set(basename, basenameRows);
    }
    for (const [path, declarations] of declarationsByPath) {
      if (declarations.length > 1) {
        errors.push(`terminal_states path ${path}: declared more than once (${declarations.map((item) => item.status).join(', ')}); one path cannot encode multiple outcomes`);
      }
    }
    for (const [basename, declarations] of declarationsByBasename) {
      const paths = [...new Set(declarations.map((item) => normalizedProjectPath(item.path) ?? item.path))];
      if (paths.length > 1) {
        errors.push(`terminal_states snapshot basename ${basename}: collides across ${paths.join(', ')}; terminal recovery requires unique basenames`);
      }
    }
    for (const declaration of terminalDeclarations) {
      const rawPath = declaration.path;
        const owners = input.dispatched.filter((stage) => stageScopeOwnsPath(stage, rawPath));
        if (owners.length !== 1) {
          errors.push(`terminal_states path ${rawPath}: expected exactly one scoped owner, found ${owners.length}${owners.length ? ` (${owners.map((stage) => stage.id).join(', ')})` : ''}`);
          continue;
        }
        const owner = owners[0];
        terminalOwners[rawPath] = owner.id;
        ownerIds.add(owner.id);
        if (owner.is_gate || owner.retry_to?.length) errors.push(`terminal owner ${owner.id}: must be a non-gate, non-repair stage`);
        const nonTerminalScopes = (owner.scope ?? []).filter((scope) => {
          const normalized = normalizedProjectPath(scope);
          if (!normalized || declaredTerminalPaths.has(normalized)) return !normalized;
          return !declaredTerminalEvidenceGlobs.some((glob) => {
            const normalizedGlob = normalizedProjectPath(glob);
            if (!normalizedGlob) return false;
            if (normalized === normalizedGlob) return true;
            return !/[?*]/.test(normalized) && dispatchGlobRegex(glob)?.test(normalized) === true;
          });
        });
        if (nonTerminalScopes.length > 0) {
          const existing = terminalValidationScopeSets.get(owner.id) ?? new Set<string>();
          for (const scope of nonTerminalScopes) existing.add(scope);
          terminalValidationScopeSets.set(owner.id, existing);
        }
        const dependents = input.dispatched.filter((stage) => stage.depends_on.includes(owner.id));
        if (dependents.length > 0) errors.push(`terminal owner ${owner.id}: must be a DAG sink; depended on by ${dependents.map((stage) => stage.id).join(', ')}`);
        if (input.research && !researchTerminalConditionExcludesContinue(owner.condition, declaration)) {
          errors.push(`terminal owner ${owner.id}.condition: must be mechanically false when research.decision is continue; use research.terminalPath == ${JSON.stringify(rawPath)} (preferred), matching research.terminalStatus, or another narrow non-continue equality`);
        }
        if (input.research && !checkedResearchOwnerIds.has(owner.id)) {
          checkedResearchOwnerIds.add(owner.id);
          const researchPaths = resolveResearchPaths(input.research);
          const resultFile = normalizedProjectPath(researchPaths.resultFile);
          const researchOutputs = [
            resultFile,
            resultFile ? `${resultFile}.no_candidate.json` : undefined,
            normalizedProjectPath(researchPaths.manifestFile),
          ].filter((path): path is string => Boolean(path));
          for (const researchOutput of researchOutputs) {
            if (stageScopeOwnsPath(owner, researchOutput)) {
              errors.push(`terminal owner ${owner.id}.scope: research result producer path ${researchOutput} cannot be owned by a terminal writer; separate measurement from terminalization`);
            }
          }
        }
        for (const required of input.dispatched) {
          if (required.id === owner.id || required.condition?.trim() || (!required.is_gate && required.retry_to?.length)) continue;
          if (!transitivelyDependsOn(owner.id, required.id, byId)) {
            errors.push(`terminal owner ${owner.id}.depends_on: mandatory stage ${required.id} is not an ancestor`);
          }
        }
    }

    if (terminalDeclarations.length > 0 && Object.keys(terminalOwners).length === terminalDeclarations.length) {
      const coverage = assessTerminalConditionCoverage(all, [...ownerIds]);
      if (coverage.checked && coverage.coversOrdinaryQuiescence === false) {
        const assignment = Object.entries(coverage.uncoveredAssignment ?? {})
          .map(([stageId, status]) => `${stageId}.status=${status}`)
          .join(', ');
        errors.push(`terminal owner conditions do not cover ordinary quiescence${assignment ? ` (${assignment})` : ''}; add a mutually exclusive owner condition that is true after successful required work`);
      }
    }

    const criteria = input.criteria?.criteria ?? [];
    if (input.criteria && criteria.length === 0) {
      errors.push('brief_criteria.json contains zero criteria; dispatch cannot prove coverage');
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
    // Existing-work audits cannot author the product they certify. Repairs
    // remain separate authors whose retry gates independently check the change.
    const auditOnly = input.dispatched.every(stage => stage.is_gate ? !stage.scope?.length : stage.retry_to?.length);
    for (const stage of input.dispatched) {
      for (const ref of stage.criterion_refs ?? []) {
        if (!criterionIds.has(ref)) errors.push(`${stage.id}.criterion_refs: unknown criterion ${JSON.stringify(ref)}`);
      }
    }
    const criterionTerminalRefs = new Map<string, string[]>();
    for (const criterion of criteria) {
      const workers = input.dispatched.filter((stage) => !stage.is_gate && !stage.retry_to?.length && stage.criterion_refs.includes(criterion.id));
      const terminalWorkers = workers.filter((stage) => ownerIds.has(stage.id));
      const ordinaryWorkers = workers.filter((stage) => !ownerIds.has(stage.id));
      const gates = input.dispatched.filter((stage) => stage.is_gate && stage.criterion_refs.includes(criterion.id));
      if (workers.length === 0 && !discharged.has(criterion.id) && !(auditOnly && gates.length > 0)) {
        errors.push(`criterion ${criterion.id}: not assigned to a capable work/finalizer stage`);
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
        errors.push(`criterion ${criterion.id}: not assigned to a gate${hint}`);
      } else if (ordinaryWorkers.length > 0 && !gates.some((gate) => ordinaryWorkers.some((worker) => transitivelyDependsOn(gate.id, worker.id, byId)))) {
        errors.push(`criterion ${criterion.id}: no assigned gate is downstream of an assigned work stage`);
      } else if (ordinaryWorkers.length === 0 && terminalWorkers.length > 0 && gates.length > 0) {
        for (const gate of gates) {
          const unreachableOwners = terminalWorkers.filter((owner) => !transitivelyDependsOn(owner.id, gate.id, byId));
          if (unreachableOwners.length > 0) {
            errors.push(`criterion ${criterion.id}: assigned gate ${gate.id} must be an ancestor of terminal owner(s) ${unreachableOwners.map((owner) => owner.id).join(', ')}`);
          }
        }
      }
    }

    return {
      version: 1,
      pass: errors.length === 0,
      checkedAt: new Date().toISOString(),
      errors,
      warnings,
      terminalOwners,
      terminalValidationScopes: Object.fromEntries(
        [...terminalValidationScopeSets].map(([ownerId, scopes]) => [ownerId, [...scopes]]),
      ),
      criterionGateRefs: Object.fromEntries(
        input.dispatched
          .filter((stage) => stage.is_gate && stage.criterion_refs.length > 0)
          .map((stage) => [stage.id, [...stage.criterion_refs]]),
      ),
      criterionTerminalRefs: Object.fromEntries(criterionTerminalRefs),
      dischargedCriteria: [...discharged.values()],
      frameworkReservedScopes: Object.fromEntries(frameworkReservedScopes),
      configuredCommandScopes,
      configuredCommandStageRoles: Object.fromEntries(configuredCommandStageRoles),
      ...(input.criteria ? { criteriaDigest: input.criteria.briefDigest } : {}),
    };
  });
}
