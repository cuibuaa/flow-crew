import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const PLAN_RETRY_STATE_FILE = 'plan_retry_state.json';
const PLAN_RETRY_EVIDENCE_DIR = 'plan_retry';

export type PlanRetryFindingSource = 'admission' | 'preflight' | 'structure';

export interface PlanRetryRequirement {
  id: string;
  detail: string;
  source: PlanRetryFindingSource;
}

export interface PlanRetryPair {
  dispatch: string;
  realityChecks?: string;
}

interface PlanRetryPairRef {
  pairDigest: string;
  dispatchPath: string;
  dispatchSha256: string;
  realityChecksPath?: string;
  realityChecksSha256?: string;
}

interface PlanRetryAttemptRecord {
  attemptIndex: number;
  proposed: PlanRetryPairRef;
  effective: PlanRetryPairRef;
  observationDigest: string;
  unsatisfied: PlanRetryRequirement[];
  satisfied: PlanRetryRequirement[];
  disposition: 'incumbent_initialized' | 'incumbent_advanced' | 'regression_quarantined' | 'identical_refusal' | 'cycle_refusal' | 'admitted';
  resolvedRequirementIds: string[];
  regressedRequirementIds: string[];
}

export interface MonotonePlanRetryState {
  version: 1;
  stageId: string;
  iteration: number;
  maxAttempts: number;
  incumbent: PlanRetryPairRef;
  unsatisfied: PlanRetryRequirement[];
  satisfied: PlanRetryRequirement[];
  attempts: PlanRetryAttemptRecord[];
  terminal?: {
    disposition: 'identical_refusal' | 'cycle_refusal' | 'attempts_exhausted' | 'admitted';
    reason: string;
  };
}

export interface PreparedPlanRetryCandidate {
  stageId: string;
  iteration: number;
  attemptIndex: number;
  proposed: PlanRetryPair;
  effective: PlanRetryPair;
  proposedPairDigest: string;
  effectivePairDigest: string;
  retainedStageIds: string[];
  retainedRealityChecks: boolean;
}

export interface PlanRetryRefusalResult {
  state: MonotonePlanRetryState;
  stop: boolean;
  reason?: string;
  disposition: PlanRetryAttemptRecord['disposition'];
}

interface DispatchDocument {
  wrapper: boolean;
  root: Record<string, unknown>;
  stages: Record<string, unknown>[];
  removeStageIds: Set<string>;
}

interface RealityCheckDocument {
  original: string;
  root: Record<string, unknown>;
  checks: unknown[];
  prefix?: string;
  suffix?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function planRetryPairDigest(pair: PlanRetryPair): string {
  const checks = pair.realityChecks;
  return sha256([
    `dispatch:${Buffer.byteLength(pair.dispatch, 'utf8')}`,
    pair.dispatch,
    checks === undefined ? 'reality-checks:absent' : `reality-checks:${Buffer.byteLength(checks, 'utf8')}\n${checks}`,
  ].join('\n'));
}

function boundedSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 160) || 'unnamed';
}

/**
 * Convert admission prose into a stable obligation identity. The diagnostic is
 * retained separately; identity is deliberately tied to the governed object,
 * not to incidental counts or the exact wording of a later validation phase.
 */
export function planRetryRequirement(
  detail: string,
  source: PlanRetryFindingSource = 'admission',
  structuredId?: string,
): PlanRetryRequirement {
  if (structuredId) return { id: structuredId, detail, source };
  const check = /^reality check\s+"([^"]+)"/i.exec(detail);
  if (check) return { id: `reality-check:${boundedSlug(check[1])}`, detail, source };
  const terminalPath = /^terminal_states path\s+(.+?):/i.exec(detail);
  if (terminalPath) return { id: `terminal-owner:${boundedSlug(terminalPath[1])}`, detail, source };
  const criterion = /^criterion\s+(\S+):/i.exec(detail);
  if (criterion) return { id: `criterion:${boundedSlug(criterion[1])}`, detail, source };
  const terminalOwner = /^terminal owner\s+([a-z][a-z0-9_]*)(?:\.([a-z_]+))?:/i.exec(detail);
  if (terminalOwner) {
    return {
      id: `stage:${boundedSlug(terminalOwner[1])}${terminalOwner[2] ? `:${boundedSlug(terminalOwner[2])}` : ''}`,
      detail,
      source,
    };
  }
  const stageField = /^([a-z][a-z0-9_]*)\.([a-z_]+)(?:\.\d+)?:/i.exec(detail);
  if (stageField) {
    return { id: `stage:${boundedSlug(stageField[1])}:${boundedSlug(stageField[2])}`, detail, source };
  }
  if (/dispatch\.yaml could not be parsed|dispatch contains no stages|contained no stages|no dispatch\.yaml/i.test(detail)) {
    return { id: 'dispatch:structure', detail, source };
  }
  if (/unknown role/i.test(detail)) {
    const stage = /(?:^|\s)([a-z][a-z0-9_]*)\s*:\s*unknown role/i.exec(detail);
    return { id: stage ? `stage:${boundedSlug(stage[1])}:role` : 'dispatch:role', detail, source };
  }
  return { id: `admission:${sha256(detail.replace(/\d+/g, '#')).slice(0, 16)}`, detail, source };
}

export function planRetryPreflightRequirement(input: {
  code: string;
  checkName: string;
  checkIndex: number;
  detail: string;
}): PlanRetryRequirement {
  const name = input.checkName.trim()
    ? boundedSlug(input.checkName)
    : `item-${Math.max(1, Math.floor(input.checkIndex))}`;
  return planRetryRequirement(
    input.detail,
    'preflight',
    `reality-check:${name}:${boundedSlug(input.code)}`,
  );
}

function parseDispatchDocument(markdown: string): DispatchDocument | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(markdown);
  } catch {
    return undefined;
  }
  const wrapper = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  const root = wrapper ? parsed as Record<string, unknown> : {};
  const rawStages = Array.isArray(parsed)
    ? parsed
    : wrapper && Array.isArray(root.stages)
      ? root.stages
      : undefined;
  if (!rawStages || rawStages.some((stage) => !stage || typeof stage !== 'object' || Array.isArray(stage))) {
    return undefined;
  }
  const retry = wrapper && root.retry && typeof root.retry === 'object' && !Array.isArray(root.retry)
    ? root.retry as Record<string, unknown>
    : undefined;
  const removeStages = wrapper && Array.isArray(root.retry_remove_stages)
    ? root.retry_remove_stages
    : Array.isArray(retry?.remove_stages)
      ? retry.remove_stages
      : [];
  return {
    wrapper,
    root,
    stages: rawStages as Record<string, unknown>[],
    removeStageIds: new Set(removeStages.filter((id): id is string => typeof id === 'string')),
  };
}

function parseRealityCheckDocument(markdown: string | undefined): RealityCheckDocument | undefined {
  if (markdown === undefined) return undefined;
  const fence = /^(?<prefix>[\s\S]*?```(?:ya?ml)?[^\n]*\n)(?<body>[\s\S]*?)(?<suffix>\n```[\s\S]*)$/i.exec(markdown);
  const body = fence?.groups?.body ?? markdown;
  let parsed: unknown;
  try {
    parsed = parseYaml(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.checks)) return undefined;
  return {
    original: markdown,
    root,
    checks: root.checks,
    ...(fence?.groups?.prefix ? { prefix: fence.groups.prefix } : {}),
    ...(fence?.groups?.suffix ? { suffix: fence.groups.suffix } : {}),
  };
}

function realityCheckKey(check: unknown, index: number): string {
  if (check && typeof check === 'object' && !Array.isArray(check)) {
    const name = (check as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return boundedSlug(name);
  }
  return `item-${index + 1}`;
}

function renderRealityCheckDocument(document: RealityCheckDocument, checks: unknown[]): string {
  const root = { ...document.root, checks };
  const body = stringifyYaml(root).trimEnd();
  return document.prefix !== undefined && document.suffix !== undefined
    ? `${document.prefix}${body}${document.suffix}`
    : `${body}\n`;
}

/**
 * A check repair unlocks only the named failing check(s). Passing declarations
 * remain scheduler-owned even when the planner omits or rewrites them while
 * repairing a neighbour. Exact proposed bytes are retained when their locked
 * declarations are already semantically unchanged; otherwise the scheduler
 * reconstructs the list from the incumbent definitions plus the repairs.
 */
function mergeRealityChecks(
  incumbent: string | undefined,
  proposed: string | undefined,
  unsatisfied: readonly PlanRetryRequirement[],
): { markdown?: string; retained: boolean } {
  const unlocked = new Set(unsatisfied.flatMap((requirement) => {
    const match = /^reality-check:([^:]+)(?::|$)/.exec(requirement.id);
    return match ? [match[1]] : [];
  }));
  if (unlocked.size === 0) return { ...(incumbent === undefined ? {} : { markdown: incumbent }), retained: incumbent !== undefined };

  const incumbentDocument = parseRealityCheckDocument(incumbent);
  const proposedDocument = parseRealityCheckDocument(proposed);
  if (!incumbentDocument) return { ...(proposed === undefined ? {} : { markdown: proposed }), retained: false };
  if (!proposedDocument) {
    if (proposed !== undefined) return { markdown: incumbentDocument.original, retained: true };
    const locked = incumbentDocument.checks.filter((check, index) => !unlocked.has(realityCheckKey(check, index)));
    if (locked.length === 0) return { retained: false };
    return {
      markdown: locked.length === incumbentDocument.checks.length
        ? incumbentDocument.original
        : renderRealityCheckDocument(incumbentDocument, locked),
      retained: true,
    };
  }

  const proposedByKey = new Map<string, Array<{ check: unknown; index: number }>>();
  proposedDocument.checks.forEach((check, index) => {
    const key = realityCheckKey(check, index);
    const entries = proposedByKey.get(key) ?? [];
    entries.push({ check, index });
    proposedByKey.set(key, entries);
  });
  const consumedProposedIndexes = new Set<number>();
  const merged: unknown[] = [];
  let retained = false;
  incumbentDocument.checks.forEach((check, index) => {
    const key = realityCheckKey(check, index);
    const replacement = proposedByKey.get(key)?.find((entry) => !consumedProposedIndexes.has(entry.index));
    if (replacement) consumedProposedIndexes.add(replacement.index);
    if (unlocked.has(key)) {
      if (replacement) merged.push(replacement.check);
      return;
    }
    merged.push(check);
    retained = true;
  });
  proposedDocument.checks.forEach((check, index) => {
    if (!consumedProposedIndexes.has(index)) merged.push(check);
  });
  if (JSON.stringify(merged) === JSON.stringify(proposedDocument.checks)) {
    return { markdown: proposedDocument.original, retained };
  }
  return { markdown: renderRealityCheckDocument(proposedDocument, merged), retained };
}

function uniqueStrings(left: unknown, right: unknown): string[] | undefined {
  const values = [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]
    .filter((item): item is string => typeof item === 'string');
  if (values.length === 0 && !Array.isArray(left) && !Array.isArray(right)) return undefined;
  return [...new Set(values)];
}

function implicatedStageFields(requirements: readonly PlanRetryRequirement[]): {
  fields: Map<string, Set<string>>;
  criterionRepair: boolean;
  terminalOwnerRepair: boolean;
  dependencyRepair: boolean;
  dispatchRepair: boolean;
} {
  const fields = new Map<string, Set<string>>();
  let criterionRepair = false;
  let terminalOwnerRepair = false;
  let dependencyRepair = false;
  let dispatchRepair = false;
  for (const requirement of requirements) {
    if (requirement.id.startsWith('reality-check:')) continue;
    dispatchRepair = true;
    if (requirement.id.startsWith('criterion:')) criterionRepair = true;
    if (requirement.id.startsWith('terminal-owner:')) {
      terminalOwnerRepair = true;
      // Duplicate-owner diagnostics name every stage whose scope contributes
      // to the refusal. Those stages' scope fields (and only those fields) are
      // valid repair targets, including explicit stage removal. A found-zero
      // diagnostic has no incumbent owner to unlock; adding the missing scope
      // remains possible through the additive terminal-owner merge below.
      const listedOwners = /found\s+\d+\s+\(([^)]+)\)/i.exec(requirement.detail)?.[1];
      for (const owner of listedOwners?.split(',') ?? []) {
        const id = owner.trim();
        if (!/^[a-z][a-z0-9_]*$/i.test(id)) continue;
        const current = fields.get(boundedSlug(id)) ?? new Set<string>();
        current.add('scope');
        fields.set(boundedSlug(id), current);
      }
    }
    if (/ancestor|dependency|depends_on|DAG sink/i.test(requirement.detail)) dependencyRepair = true;
    const match = /^stage:([^:]+)(?::([^:]+))?$/.exec(requirement.id);
    if (!match) continue;
    const current = fields.get(match[1]) ?? new Set<string>();
    // The diagnostic's field identifies the failing component, but a coherent
    // repair can require adjacent fields on the same stage (for example,
    // separating a terminal writer changes both scope and condition). Other
    // stages remain locked, and the complete admission oracle rejects any new
    // failure introduced by this stage-level replacement.
    current.add('*');
    fields.set(match[1], current);
  }
  return { fields, criterionRepair, terminalOwnerRepair, dependencyRepair, dispatchRepair };
}

function mergeStage(
  incumbent: Record<string, unknown>,
  proposed: Record<string, unknown>,
  unlocked: ReturnType<typeof implicatedStageFields>,
): Record<string, unknown> {
  const id = typeof incumbent.id === 'string' ? boundedSlug(incumbent.id) : '';
  const fields = unlocked.fields.get(id) ?? new Set<string>();
  const all = fields.has('*');
  const merged: Record<string, unknown> = { ...incumbent };

  // Prompt/skill changes do not establish admission facts, so a retry may
  // improve them without weakening locked topology.
  for (const field of ['prompt_template', 'task', 'skills']) {
    if (field in proposed) merged[field] = proposed[field];
  }
  if (all) {
    return { ...proposed };
  }
  for (const field of fields) {
    if (field in proposed) merged[field] = proposed[field];
    else delete merged[field];
  }
  if (unlocked.criterionRepair) {
    merged.criterion_refs = uniqueStrings(incumbent.criterion_refs, proposed.criterion_refs) ?? [];
    merged.depends_on = uniqueStrings(incumbent.depends_on, proposed.depends_on) ?? [];
    merged.dependency_reasons = {
      ...(incumbent.dependency_reasons && typeof incumbent.dependency_reasons === 'object'
        ? incumbent.dependency_reasons as Record<string, unknown>
        : {}),
      ...(proposed.dependency_reasons && typeof proposed.dependency_reasons === 'object'
        ? proposed.dependency_reasons as Record<string, unknown>
        : {}),
    };
    if (proposed.is_gate === true) merged.is_gate = true;
  }
  if (unlocked.terminalOwnerRepair && !fields.has('scope')) {
    merged.scope = uniqueStrings(incumbent.scope, proposed.scope) ?? [];
  }
  if (unlocked.dependencyRepair) {
    merged.depends_on = uniqueStrings(incumbent.depends_on, proposed.depends_on) ?? [];
    merged.dependency_reasons = {
      ...(incumbent.dependency_reasons && typeof incumbent.dependency_reasons === 'object'
        ? incumbent.dependency_reasons as Record<string, unknown>
        : {}),
      ...(proposed.dependency_reasons && typeof proposed.dependency_reasons === 'object'
        ? proposed.dependency_reasons as Record<string, unknown>
        : {}),
    };
  }
  return merged;
}

export function mergePlanRetryPair(
  incumbent: PlanRetryPair,
  proposed: PlanRetryPair,
  unsatisfied: readonly PlanRetryRequirement[],
  satisfied: readonly PlanRetryRequirement[] = [],
): { pair: PlanRetryPair; retainedStageIds: string[]; retainedRealityChecks: boolean } {
  const unlocked = implicatedStageFields(unsatisfied);
  let dispatch = incumbent.dispatch;
  const retainedStageIds: string[] = [];
  if (unlocked.dispatchRepair) {
    const incumbentDocument = parseDispatchDocument(incumbent.dispatch);
    const proposedDocument = parseDispatchDocument(proposed.dispatch);
    if (!incumbentDocument || !proposedDocument) {
      // A structurally invalid incumbent must be replaceable; an invalid repair
      // remains visible to the unchanged parser instead of being hidden.
      dispatch = proposed.dispatch;
    } else {
      const incumbentSemantic = JSON.stringify(incumbentDocument.stages);
      const proposedById = new Map(proposedDocument.stages
        .filter((stage) => typeof stage.id === 'string')
        .map((stage) => [stage.id as string, stage]));
      const mergedStages: Record<string, unknown>[] = [];
      const consumed = new Set<string>();
      for (const prior of incumbentDocument.stages) {
        const id = typeof prior.id === 'string' ? prior.id : undefined;
        const replacement = id ? proposedById.get(id) : undefined;
        const implicated = id ? unlocked.fields.has(boundedSlug(id)) : false;
        const explicitRemoval = Boolean(id && proposedDocument.removeStageIds.has(id) && implicated);
        if (explicitRemoval) {
          consumed.add(id!);
          continue;
        }
        if (!replacement) {
          mergedStages.push(prior);
          if (id) retainedStageIds.push(id);
          continue;
        }
        consumed.add(id!);
        const merged = mergeStage(prior, replacement, unlocked);
        mergedStages.push(merged);
        if (JSON.stringify(merged) === JSON.stringify(prior) && id) retainedStageIds.push(id);
      }
      for (const stage of proposedDocument.stages) {
        const id = typeof stage.id === 'string' ? stage.id : undefined;
        if (!id || !consumed.has(id)) mergedStages.push(stage);
      }
      const terminalOwnerIds = new Set(satisfied.flatMap((requirement) => {
        if (!requirement.id.startsWith('terminal-owner:')) return [];
        const owner = /retains scoped owner\s+([a-z][a-z0-9_]*)/i.exec(requirement.detail)?.[1];
        return owner ? [owner] : [];
      }));
      const incumbentIds = new Set(incumbentDocument.stages
        .map((stage) => typeof stage.id === 'string' ? stage.id : undefined)
        .filter((id): id is string => Boolean(id)));
      const byId = new Map(mergedStages
        .filter((stage) => typeof stage.id === 'string')
        .map((stage) => [stage.id as string, stage]));
      const dependsOn = (stageId: string, ancestorId: string): boolean => {
        const seen = new Set<string>();
        const queue = Array.isArray(byId.get(stageId)?.depends_on)
          ? [...byId.get(stageId)!.depends_on as string[]]
          : [];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current === ancestorId) return true;
          if (seen.has(current)) continue;
          seen.add(current);
          const dependencies = byId.get(current)?.depends_on;
          if (Array.isArray(dependencies)) queue.push(...dependencies.filter((item): item is string => typeof item === 'string'));
        }
        return false;
      };
      const newMandatoryIds = mergedStages.flatMap((stage) => {
        const id = typeof stage.id === 'string' ? stage.id : undefined;
        if (!id || incumbentIds.has(id) || stage.condition) return [];
        if (Array.isArray(stage.retry_to) && stage.retry_to.length > 0 && stage.is_gate !== true) return [];
        return [id];
      });
      for (const ownerId of terminalOwnerIds) {
        const owner = byId.get(ownerId);
        if (!owner || proposedById.has(ownerId)) continue;
        const dependencies = new Set(Array.isArray(owner.depends_on)
          ? owner.depends_on.filter((item): item is string => typeof item === 'string')
          : []);
        const reasons = owner.dependency_reasons && typeof owner.dependency_reasons === 'object'
          ? { ...owner.dependency_reasons as Record<string, unknown> }
          : {};
        for (const mandatoryId of newMandatoryIds) {
          if (mandatoryId === ownerId || dependsOn(mandatoryId, ownerId)) continue;
          dependencies.add(mandatoryId);
          reasons[mandatoryId] ??= 'Monotone retry dependency: retained terminal owners run only after newly repaired mandatory work and gates.';
        }
        owner.depends_on = [...dependencies];
        owner.dependency_reasons = reasons;
      }
      const root: Record<string, unknown> = proposedDocument.wrapper
        ? { ...proposedDocument.root, stages: mergedStages }
        : { stages: mergedStages };
      delete root.retry;
      delete root.retry_remove_stages;
      dispatch = JSON.stringify(mergedStages) === incumbentSemantic
        ? incumbent.dispatch
        : stringifyYaml(root);
    }
  }

  const mergedChecks = mergeRealityChecks(incumbent.realityChecks, proposed.realityChecks, unsatisfied);
  return {
    pair: { dispatch, ...(mergedChecks.markdown === undefined ? {} : { realityChecks: mergedChecks.markdown }) },
    retainedStageIds,
    retainedRealityChecks: mergedChecks.retained,
  };
}

function statePath(runDirPath: string): string {
  return join(runDirPath, PLAN_RETRY_STATE_FILE);
}

function safeRunRelativePath(runDirPath: string, path: string): string {
  const absolute = resolve(runDirPath, path);
  const rel = relative(resolve(runDirPath), absolute);
  if (!rel || rel.startsWith('..') || rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`plan retry evidence path escapes the run directory: ${path}`);
  }
  return absolute;
}

function readState(runDirPath: string): MonotonePlanRetryState | undefined {
  const path = statePath(runDirPath);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as MonotonePlanRetryState;
  if (parsed.version !== 1
    || !parsed.incumbent
    || !Array.isArray(parsed.attempts)
    || !Number.isSafeInteger(parsed.maxAttempts)
    || parsed.maxAttempts < 1) {
    throw new Error(`${PLAN_RETRY_STATE_FILE} has an invalid shape`);
  }
  return parsed;
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function writeCreateOnly(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== bytes) throw new Error(`immutable plan retry evidence changed at ${path}`);
    return;
  }
  writeFileSync(path, bytes, { encoding: 'utf8', flag: 'wx' });
}

function snapshotPair(runDirPath: string, relativeRoot: string, label: string, pair: PlanRetryPair): PlanRetryPairRef {
  const dispatchPath = join(relativeRoot, `${label}_dispatch.yaml`);
  writeCreateOnly(safeRunRelativePath(runDirPath, dispatchPath), pair.dispatch);
  let realityChecksPath: string | undefined;
  if (pair.realityChecks !== undefined) {
    realityChecksPath = join(relativeRoot, `${label}_reality_checks.md`);
    writeCreateOnly(safeRunRelativePath(runDirPath, realityChecksPath), pair.realityChecks);
  }
  return {
    pairDigest: planRetryPairDigest(pair),
    dispatchPath,
    dispatchSha256: sha256(pair.dispatch),
    ...(realityChecksPath && pair.realityChecks !== undefined
      ? { realityChecksPath, realityChecksSha256: sha256(pair.realityChecks) }
      : {}),
  };
}

function readPairRef(runDirPath: string, ref: PlanRetryPairRef): PlanRetryPair {
  const dispatch = readFileSync(safeRunRelativePath(runDirPath, ref.dispatchPath), 'utf8');
  if (sha256(dispatch) !== ref.dispatchSha256) throw new Error('plan retry incumbent dispatch digest mismatch');
  let realityChecks: string | undefined;
  if (ref.realityChecksPath) {
    realityChecks = readFileSync(safeRunRelativePath(runDirPath, ref.realityChecksPath), 'utf8');
    if (sha256(realityChecks) !== ref.realityChecksSha256) {
      throw new Error('plan retry incumbent reality-check digest mismatch');
    }
  }
  const pair = { dispatch, ...(realityChecks === undefined ? {} : { realityChecks }) };
  if (planRetryPairDigest(pair) !== ref.pairDigest) throw new Error('plan retry incumbent pair digest mismatch');
  return pair;
}

export function materializePlanRetryIncumbent(runDirPath: string, state: MonotonePlanRetryState): void {
  const incumbent = readPairRef(runDirPath, state.incumbent);
  writeFileSync(join(runDirPath, 'dispatch.yaml'), incumbent.dispatch, 'utf8');
  const checksPath = join(runDirPath, 'reality_checks.md');
  if (incumbent.realityChecks === undefined) {
    try {
      if (existsSync(checksPath)) unlinkSync(checksPath);
    } catch {
      // A later read/digest check still fails closed if a stale file survives.
    }
  } else {
    writeFileSync(checksPath, incumbent.realityChecks, 'utf8');
  }
}

export function preparePlanRetryCandidate(input: {
  runDirPath: string;
  stageId: string;
  iteration: number;
  attemptIndex: number;
}): PreparedPlanRetryCandidate {
  const dispatchPath = join(input.runDirPath, 'dispatch.yaml');
  const proposed: PlanRetryPair = {
    dispatch: existsSync(dispatchPath) ? readFileSync(dispatchPath, 'utf8') : '',
    ...(existsSync(join(input.runDirPath, 'reality_checks.md'))
      ? { realityChecks: readFileSync(join(input.runDirPath, 'reality_checks.md'), 'utf8') }
      : {}),
  };
  const state = readState(input.runDirPath);
  const sameActiveChain = state
    && state.stageId === input.stageId
    && state.iteration === input.iteration
    && !state.terminal;
  // The run-local ledger is authoritative across scheduler restarts. An
  // in-memory retry counter may resume at zero, but cannot reuse an attempt
  // coordinate or extend the persisted bound.
  const attemptIndex = sameActiveChain
    ? Math.max(input.attemptIndex, state.attempts.length + 1)
    : input.attemptIndex;
  let effective = proposed;
  let retainedStageIds: string[] = [];
  let retainedRealityChecks = false;
  if (sameActiveChain) {
    const merged = mergePlanRetryPair(
      readPairRef(input.runDirPath, state.incumbent),
      proposed,
      state.unsatisfied,
      state.satisfied,
    );
    effective = merged.pair;
    retainedStageIds = merged.retainedStageIds;
    retainedRealityChecks = merged.retainedRealityChecks;
    writeFileSync(dispatchPath, effective.dispatch, 'utf8');
    const checksPath = join(input.runDirPath, 'reality_checks.md');
    if (effective.realityChecks === undefined) {
      try {
        if (existsSync(checksPath)) unlinkSync(checksPath);
      } catch {
        // Validation observes any surviving file and remains fail-closed.
      }
    } else {
      writeFileSync(checksPath, effective.realityChecks, 'utf8');
    }
  }
  return {
    stageId: input.stageId,
    iteration: input.iteration,
    attemptIndex,
    proposed,
    effective,
    proposedPairDigest: planRetryPairDigest(proposed),
    effectivePairDigest: planRetryPairDigest(effective),
    retainedStageIds,
    retainedRealityChecks,
  };
}

function dedupeRequirements(requirements: readonly PlanRetryRequirement[]): PlanRetryRequirement[] {
  const byId = new Map<string, PlanRetryRequirement>();
  for (const requirement of requirements) byId.set(requirement.id, requirement);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function observationDigest(requirements: readonly PlanRetryRequirement[]): string {
  // Requirement identity, not presentation text, defines a repeat. Validators
  // may improve or enrich a diagnostic without granting another planner call
  // for the same effective bytes and the same stable obligations.
  return sha256(JSON.stringify(dedupeRequirements(requirements).map(({ id }) => id)));
}

function isRegressionAgainstIncumbent(
  requirement: PlanRetryRequirement,
  priorSatisfied: ReadonlySet<string>,
): boolean {
  // Mere component presence is not evidence that every validator phase has
  // observed it passing. A newly exposed obligation on a never-admitted stage
  // may advance the incumbent; once that stable ID is actually resolved, the
  // satisfied ledger makes any later recurrence a mechanical regression.
  return priorSatisfied.has(requirement.id);
}

function unresolvedSummary(requirements: readonly PlanRetryRequirement[]): string {
  if (requirements.length === 0) return 'no stable unsatisfied requirement was recorded';
  return requirements.map((requirement) => `${requirement.id} — ${requirement.detail}`).join('; ');
}

export function recordPlanRetryRefusal(input: {
  runDirPath: string;
  prepared: PreparedPlanRetryCandidate;
  maxAttempts: number;
  unsatisfied: readonly PlanRetryRequirement[];
  satisfied?: readonly PlanRetryRequirement[];
  /** Last atomically admitted check bytes may seed a rejected amendment's incumbent. */
  incumbentOverride?: PlanRetryPair;
  /** Preserve legacy preflight three-strike escalation while dispatch refusals stop on repeats. */
  stopOnRepeat?: boolean;
}): PlanRetryRefusalResult {
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error(`plan retry maxAttempts must be a positive safe integer, received ${input.maxAttempts}`);
  }
  const unsatisfied = dedupeRequirements(input.unsatisfied);
  const satisfied = dedupeRequirements(input.satisfied ?? []);
  const prior = readState(input.runDirPath);
  const sameChain = prior
    && prior.stageId === input.prepared.stageId
    && prior.iteration === input.prepared.iteration;
  const previous = sameChain ? prior : undefined;
  if (previous?.terminal) {
    return {
      state: previous,
      stop: true,
      reason: previous.terminal.reason,
      disposition: previous.attempts.at(-1)?.disposition ?? 'identical_refusal',
    };
  }
  const root = join(
    PLAN_RETRY_EVIDENCE_DIR,
    `iteration_${input.prepared.iteration}`,
    `attempt_${input.prepared.attemptIndex}_${input.prepared.proposedPairDigest.slice(0, 12)}`,
  );
  const proposedRef = snapshotPair(input.runDirPath, root, 'proposed', input.prepared.proposed);
  const effectiveRef = snapshotPair(input.runDirPath, root, 'effective', input.prepared.effective);
  const priorUnsatisfied = new Set(previous?.unsatisfied.map((requirement) => requirement.id) ?? []);
  const currentUnsatisfied = new Set(unsatisfied.map((requirement) => requirement.id));
  const resolved = [...priorUnsatisfied].filter((id) => !currentUnsatisfied.has(id)).sort();
  const priorSatisfied = new Set(previous?.satisfied.map((requirement) => requirement.id) ?? []);
  const regressed = previous
    ? unsatisfied
      .filter((requirement) => !priorUnsatisfied.has(requirement.id)
        && isRegressionAgainstIncumbent(requirement, priorSatisfied))
      .map((requirement) => requirement.id)
      .sort()
    : [];
  const key = `${effectiveRef.pairDigest}:${observationDigest(unsatisfied)}`;
  const matchingIndexes = (previous?.attempts ?? [])
    .map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt }) => `${attempt.effective.pairDigest}:${attempt.observationDigest}` === key)
    .map(({ index }) => index);
  const lastIndex = (previous?.attempts.length ?? 0) - 1;
  const repeated = matchingIndexes.length > 0;
  const identical = repeated && matchingIndexes.includes(lastIndex);
  const cycled = repeated && !identical;

  let disposition: PlanRetryAttemptRecord['disposition'];
  let incumbent = !previous && input.incumbentOverride
    ? snapshotPair(input.runDirPath, root, 'incumbent', input.incumbentOverride)
    : effectiveRef;
  let nextUnsatisfied = unsatisfied;
  let nextSatisfied = dedupeRequirements(satisfied);
  if (!previous) {
    disposition = 'incumbent_initialized';
  } else if (identical) {
    disposition = 'identical_refusal';
    incumbent = previous.incumbent;
    nextUnsatisfied = previous.unsatisfied;
    nextSatisfied = previous.satisfied;
  } else if (cycled) {
    disposition = 'cycle_refusal';
    incumbent = previous.incumbent;
    nextUnsatisfied = previous.unsatisfied;
    nextSatisfied = previous.satisfied;
  } else if (regressed.length > 0) {
    disposition = 'regression_quarantined';
    incumbent = previous.incumbent;
    nextUnsatisfied = previous.unsatisfied;
    nextSatisfied = previous.satisfied;
  } else {
    disposition = 'incumbent_advanced';
    nextSatisfied = dedupeRequirements([
      ...previous.satisfied,
      ...previous.unsatisfied
        .filter((requirement) => resolved.includes(requirement.id))
        .map((requirement) => ({
          ...requirement,
          detail: `retained repair: ${requirement.detail}`,
        })),
      // A direct passing observation is the strongest support record and must
      // win over the historical failure prose for the same stable identity.
      ...satisfied,
    ]);
  }

  const attempt: PlanRetryAttemptRecord = {
    attemptIndex: input.prepared.attemptIndex,
    proposed: proposedRef,
    effective: effectiveRef,
    observationDigest: observationDigest(unsatisfied),
    unsatisfied,
    satisfied,
    disposition,
    resolvedRequirementIds: resolved,
    regressedRequirementIds: regressed,
  };
  const attempts = [...(previous?.attempts ?? []), attempt];
  // The first refusal fixes the chain's immutable total-call bound. A later
  // caller may report a different configured value, but cannot extend (or
  // silently shrink) an already persisted retry transaction.
  const maxAttempts = previous?.maxAttempts ?? input.maxAttempts;
  let terminal: MonotonePlanRetryState['terminal'];
  if ((identical || cycled) && input.stopOnRepeat !== false) {
    const cycleKind = identical ? 'identical_refusal' : 'cycle_refusal';
    terminal = {
      disposition: cycleKind,
      reason: `Plan retry stopped on an ${identical ? 'identical' : 'cycling'} refused candidate. Unsatisfied requirement(s): ${unresolvedSummary(nextUnsatisfied)}`,
    };
  } else if (attempts.length >= maxAttempts) {
    terminal = {
      disposition: 'attempts_exhausted',
      reason: `Plan retry exhausted ${maxAttempts} bounded attempts. Unsatisfied requirement(s): ${unresolvedSummary(nextUnsatisfied)}`,
    };
  }
  const state: MonotonePlanRetryState = {
    version: 1,
    stageId: input.prepared.stageId,
    iteration: input.prepared.iteration,
    maxAttempts,
    incumbent,
    unsatisfied: nextUnsatisfied,
    satisfied: nextSatisfied,
    attempts,
    ...(terminal ? { terminal } : {}),
  };
  atomicWriteJson(join(input.runDirPath, root, 'observation.json'), attempt);
  atomicWriteJson(statePath(input.runDirPath), state);
  if (!terminal) materializePlanRetryIncumbent(input.runDirPath, state);
  return { state, stop: Boolean(terminal), reason: terminal?.reason, disposition };
}

export function recordPlanRetryAdmission(input: {
  runDirPath: string;
  prepared: PreparedPlanRetryCandidate;
  satisfied?: readonly PlanRetryRequirement[];
}): void {
  const prior = readState(input.runDirPath);
  if (!prior
    || prior.stageId !== input.prepared.stageId
    || prior.iteration !== input.prepared.iteration
    || prior.terminal) return;
  const root = join(
    PLAN_RETRY_EVIDENCE_DIR,
    `iteration_${input.prepared.iteration}`,
    `attempt_${input.prepared.attemptIndex}_${input.prepared.proposedPairDigest.slice(0, 12)}`,
  );
  const proposed = snapshotPair(input.runDirPath, root, 'proposed', input.prepared.proposed);
  const effective = snapshotPair(input.runDirPath, root, 'effective', input.prepared.effective);
  const attempt: PlanRetryAttemptRecord = {
    attemptIndex: input.prepared.attemptIndex,
    proposed,
    effective,
    observationDigest: observationDigest([]),
    unsatisfied: [],
    satisfied: dedupeRequirements(input.satisfied ?? []),
    disposition: 'admitted',
    resolvedRequirementIds: prior.unsatisfied.map((requirement) => requirement.id).sort(),
    regressedRequirementIds: [],
  };
  const state: MonotonePlanRetryState = {
    ...prior,
    incumbent: effective,
    unsatisfied: [],
    satisfied: dedupeRequirements([
      ...prior.satisfied,
      ...prior.unsatisfied.map((requirement) => ({
        ...requirement,
        detail: `retained repair: ${requirement.detail}`,
      })),
      ...(input.satisfied ?? []),
    ]),
    attempts: [...prior.attempts, attempt],
    terminal: { disposition: 'admitted', reason: 'The monotone incumbent passed complete plan admission.' },
  };
  atomicWriteJson(join(input.runDirPath, root, 'observation.json'), attempt);
  atomicWriteJson(statePath(input.runDirPath), state);
}

export function readMonotonePlanRetryState(
  runDirPath: string,
  stageId?: string,
  iteration?: number,
): MonotonePlanRetryState | undefined {
  const state = readState(runDirPath);
  if (stageId && state?.stageId !== stageId) return undefined;
  if (iteration !== undefined && state?.iteration !== iteration) return undefined;
  return state;
}

export function buildMonotonePlanRetryContext(
  runDirPath: string,
  stageId: string,
  iteration?: number,
): string | undefined {
  const state = readMonotonePlanRetryState(runDirPath, stageId, iteration);
  if (!state || state.terminal) return undefined;
  // Reading through the digest verifier makes a corrupt/stale incumbent fail
  // before its paths are advertised to another planner attempt.
  readPairRef(runDirPath, state.incumbent);
  const used = state.attempts.length;
  const remaining = Math.max(0, state.maxAttempts - used);
  const lines = [
    'MONOTONE PLAN-RETRY INCUMBENT (scheduler-owned, digest-bound):',
    `- dispatch edit base: ${join(runDirPath, state.incumbent.dispatchPath)} (sha256 ${state.incumbent.dispatchSha256})`,
    state.incumbent.realityChecksPath
      ? `- reality-check edit base: ${join(runDirPath, state.incumbent.realityChecksPath)} (sha256 ${state.incumbent.realityChecksSha256})`
      : '- reality-check edit base: absent',
    `- effective pair digest: ${state.incumbent.pairDigest}`,
    `- remaining planner calls in this bounded chain: ${remaining}`,
    'Still-unsatisfied requirements (repair these cumulatively):',
    ...state.unsatisfied.map((requirement) => `- ${requirement.id}: ${requirement.detail}`),
    'Already-satisfied requirements locked by the scheduler:',
    ...(state.satisfied.length > 0
      ? state.satisfied.map((requirement) => `- ${requirement.id}: ${requirement.detail}`)
      : ['- the incumbent components not named by an unsatisfied requirement']),
    `The scheduler has materialized this incumbent at ${join(runDirPath, 'dispatch.yaml')}${state.incumbent.realityChecksPath ? ` and ${join(runDirPath, 'reality_checks.md')}` : ''}. Repair that materialized base; do not recompose the proposal pair from scratch. Omission does not delete a locked stage or a passing check. An implicated stage may be explicitly removed with top-level retry_remove_stages: [stage_id]; the complete effective pair still has to pass every unchanged admission rule.`,
  ];
  return lines.join('\n');
}
