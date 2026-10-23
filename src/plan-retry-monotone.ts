import { type DispatchAdmissionError } from './scheduler/sched_admission/dispatch.js';
import { createHash } from 'node:crypto';
import { atomicWrite, mkdirSync, writeFileSync } from './engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const PLAN_RETRY_STATE_FILE = 'plan_retry_state.json';
const PLAN_RETRY_EVIDENCE_DIR = 'plan_retry';

export type PlanRetryFindingSource = 'admission' | 'structure';

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
  unsatisfied: PlanRetryRequirement[];
  satisfied: PlanRetryRequirement[];
  disposition: 'incumbent_initialized' | 'incumbent_advanced' | 'regression_quarantined' | 'admitted';
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
    disposition: 'attempts_exhausted' | 'admitted';
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

/** Identity comes from the producer's fields; prose is diagnostic only.
 * Old recorded reports are read as opaque findings, never interpreted as rules. */
export function planRetryRequirement(
  error: DispatchAdmissionError | string,
  source: PlanRetryFindingSource = 'admission',
): PlanRetryRequirement {
  const detail = typeof error === 'string' ? error : error.message;
  const id = typeof error === 'string'
    ? `legacy:${sha256(error).slice(0, 16)}`
    : [error.code, error.stageId, error.field].filter(value => value !== undefined).join(':');
  return { id, detail, source };
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
  // Incumbent/attempt decisions are recovery authority for the retry budget.
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, { durability: 'durable' });
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
      disposition: previous.attempts.at(-1)?.disposition ?? 'incumbent_initialized',
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
  const disposition = previous ? 'incumbent_advanced' : 'incumbent_initialized';
  const attempt: PlanRetryAttemptRecord = {
    attemptIndex: input.prepared.attemptIndex, proposed: proposedRef, effective: effectiveRef,
    unsatisfied, satisfied, disposition,
    resolvedRequirementIds: resolved, regressedRequirementIds: [],
  };
  const attempts = [...(previous?.attempts ?? []), attempt];
  // The first refusal fixes the chain's immutable total-call bound. A later
  // caller may report a different configured value, but cannot extend (or
  // silently shrink) an already persisted retry transaction.
  const maxAttempts = previous?.maxAttempts ?? input.maxAttempts;
  let terminal: MonotonePlanRetryState['terminal'];
  if (attempts.length >= maxAttempts) {
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
    'Write a complete replacement dispatch.yaml, including its reality_checks. Each replacement passes every admission rule independently; no prior component is merged or locked.',
  ].join('\n');
}
