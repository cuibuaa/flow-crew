import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

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
}

export interface PlanRetryRefusalResult {
  state: MonotonePlanRetryState;
  stop: boolean;
  reason?: string;
  disposition: PlanRetryAttemptRecord['disposition'];
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
export function planRetryRealityCheckName(detail: string): string | undefined {
  const match = /^(?:[A-Z][A-Z0-9_]*:\s+)?reality check\s+("(?:\\.|[^"\\])*")/i.exec(detail);
  if (!match) return undefined;
  try { return JSON.parse(match[1]) as string; } catch { return undefined; }
}

export function planRetryRequirement(
  detail: string,
  source: PlanRetryFindingSource = 'admission',
  structuredId?: string,
): PlanRetryRequirement {
  if (structuredId) return { id: structuredId, detail, source };
  const check = planRetryRealityCheckName(detail);
  if (check !== undefined) return { id: `reality-check:${boundedSlug(check)}`, detail, source };
  const artifactStage = /^(?:([a-z][a-z0-9_]*): invalid schema at )?(?:ARTIFACT|REPLAY)_[A-Z_]+:\s+([a-z][a-z0-9_]*)\./i.exec(detail);
  if (artifactStage && (!artifactStage[1] || artifactStage[1] === artifactStage[2])) {
    return { id: `stage:${boundedSlug(artifactStage[2])}:artifact_contract`, detail, source };
  }
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
  // Verify retained evidence, but never rewrite a complete replacement proposal.
  // Ordinary admission examines its exact bytes independently of prior refusals.
  if (sameActiveChain) readPairRef(input.runDirPath, state.incumbent);
  const effective = proposed;
  return {
    stageId: input.stageId,
    iteration: input.iteration,
    attemptIndex,
    proposed,
    effective,
    proposedPairDigest: planRetryPairDigest(proposed),
    effectivePairDigest: planRetryPairDigest(effective),
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
  // for the same proposed bytes and the same stable obligations.
  return sha256(JSON.stringify(dedupeRequirements(requirements).map(({ id }) => id)));
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
  const currentIds = new Set(unsatisfied.map((requirement) => requirement.id));
  const resolved = (previous?.unsatisfied ?? []).filter((requirement) => !currentIds.has(requirement.id)).map((requirement) => requirement.id).sort();
  const key = `${proposedRef.pairDigest}:${observationDigest(unsatisfied)}`;
  const matchingIndexes = (previous?.attempts ?? [])
    .map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt }) => `${attempt.proposed.pairDigest}:${attempt.observationDigest}` === key)
    .map(({ index }) => index);
  const lastIndex = (previous?.attempts.length ?? 0) - 1;
  const identical = matchingIndexes.includes(lastIndex) && lastIndex >= 0;
  const cycled = matchingIndexes.length > 0 && !identical;
  const disposition = identical ? 'identical_refusal' : cycled ? 'cycle_refusal'
    : previous ? 'incumbent_advanced' : 'incumbent_initialized';
  const attempt: PlanRetryAttemptRecord = {
    attemptIndex: input.prepared.attemptIndex, proposed: proposedRef, effective: effectiveRef,
    observationDigest: observationDigest(unsatisfied), unsatisfied, satisfied, disposition,
    resolvedRequirementIds: resolved, regressedRequirementIds: [],
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
      reason: `Plan retry stopped on an ${identical ? 'identical' : 'cycling'} refused candidate. Unsatisfied requirement(s): ${unresolvedSummary(unsatisfied)}`,
    };
  } else if (attempts.length >= maxAttempts) {
    terminal = {
      disposition: 'attempts_exhausted',
      // The retained incumbent ledger is useful history, but it is not the
      // cause of the final refusal. Report the requirements observed on the
      // attempt which actually exhausted the budget.
      reason: `Plan retry exhausted ${maxAttempts} bounded attempts. Unsatisfied requirement(s): ${unresolvedSummary(unsatisfied)}`,
    };
  }
  const state: MonotonePlanRetryState = {
    version: 1,
    stageId: input.prepared.stageId,
    iteration: input.prepared.iteration,
    maxAttempts,
    incumbent: effectiveRef,
    unsatisfied,
    satisfied,
    attempts,
    ...(terminal ? { terminal } : {}),
  };
  atomicWriteJson(join(input.runDirPath, root, 'observation.json'), attempt);
  atomicWriteJson(statePath(input.runDirPath), state);
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
    satisfied: dedupeRequirements(input.satisfied ?? []),
    attempts: [...prior.attempts, attempt],
    terminal: { disposition: 'admitted', reason: 'The complete replacement proposal passed plan admission.' },
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
  return [
    'PLAN-RETRY OBSERVATION (scheduler-owned, digest-bound):',
    `- last refused dispatch: ${join(runDirPath, state.incumbent.dispatchPath)} (sha256 ${state.incumbent.dispatchSha256})`,
    `- last observed pair digest: ${state.incumbent.pairDigest}`,
    `- remaining planner calls in this bounded chain: ${remaining}`,
    'Observed refusal requirements:',
    ...state.unsatisfied.map((requirement) => `- ${requirement.id}: ${requirement.detail}`),
    'Write a complete replacement dispatch.yaml and reality_checks.md pair. Each replacement passes every admission rule independently; no prior component is merged or locked. Do not repeat the same refused bytes and requirements.',
  ].join('\n');
}
