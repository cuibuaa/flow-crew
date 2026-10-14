import { writeFileSync } from '../../engine-fs.js';

// Boundary: Setup baseline capture, attempt-bound validation delta and guarded configured command execution; no gate repair or topology changes.
import { ProjectValidationBaseline, ProjectValidationDependencies, ValidationCommandRunner, ValidationDeltaResult, evaluateValidationDelta, runProjectValidationBaseline, runValidationCommand } from '../../project-validation.js';
import { publishJsonCreateOnly } from '../../runtime-negotiation.js';
import { readShipSetupReadyValidationBaseline } from '../../ship-setup-record.js';
import { GateVerdict, STAGE_STATUS, readStageStatus, runDir } from '../../store.js';
import { RUN_VALIDATION_BASELINE_FILE } from '../sched_policy/terminal.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RunValidationBaselineArtifact {
  version: 1;
  capturedAt: string;
  source: 'ship-setup-ready-record';
  baseline: ProjectValidationBaseline;
}

export interface GateValidationDeltaArtifact {
  version: 1 | 2;
  stageId: string;
  checkedAt: string;
  pass: boolean;
  baselineSha256: string;
  current: ProjectValidationBaseline['results'];
  delta: ValidationDeltaResult[];
  attemptIndex?: number;
  attemptStartedAt?: string;
  attemptCompletedAt?: string;
  executionId?: string;
  immutablePath?: string;
  /** Mechanical executions for this settled gate/baseline, including retries. */
  validationAttemptIndex?: number;
}

export interface GateValidationExecutionIdentity {
  attemptIndex: number;
  attemptStartedAt: string;
  attemptCompletedAt: string;
  executionId: string;
}

function readValidationDelta(path: string): GateValidationDeltaArtifact | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as GateValidationDeltaArtifact;
    if (value.version !== 2 || typeof value.pass !== 'boolean' || !Array.isArray(value.current) || !Array.isArray(value.delta)
      || new Set(value.delta.map(entry => JSON.stringify([entry.role, entry.display ?? null]))).size !== value.delta.length
      || value.delta.some((entry) => !['build', 'test', 'lint'].includes(entry.role)
        || !['pass', 'regression', 'unresolved'].includes(entry.state) || typeof entry.reason !== 'string'
        || (entry.display !== undefined && (typeof entry.display !== 'string' || !entry.display)))
      || (value.validationAttemptIndex !== undefined && (!Number.isSafeInteger(value.validationAttemptIndex) || value.validationAttemptIndex < 1))) return undefined;
    return value;
  } catch { return undefined; }
}

export function validationExecutionId(
  runId: string,
  stageId: string,
  attemptIndex: number,
  attemptStartedAt: string,
  attemptCompletedAt: string,
): string {
  return createHash('sha256')
    .update([runId, stageId, String(attemptIndex), attemptStartedAt, attemptCompletedAt].join('\0'), 'utf8')
    .digest('hex');
}

function gateValidationExecution(projectDir: string, runId: string, stageId: string, status: 'running' | 'complete' | 'failed'): GateValidationExecutionIdentity | undefined {
  try {
    const attempt = readStageStatus(projectDir, runId, stageId).attempts?.at(-1);
    if (attempt?.status !== status || (status !== STAGE_STATUS.RUNNING && !attempt.completedAt)) return undefined;
    const completedAt = status === STAGE_STATUS.RUNNING ? '' : attempt.completedAt!;
    return { attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt, attemptCompletedAt: completedAt,
      executionId: validationExecutionId(runId, stageId, attempt.index, attempt.startedAt, completedAt) };
  } catch { return undefined; }
}

export function settledGateValidationExecution(projectDir: string, runId: string, stageId: string): GateValidationExecutionIdentity | undefined {
  return gateValidationExecution(projectDir, runId, stageId, STAGE_STATUS.COMPLETE);
}

function closedGateValidationExecution(projectDir: string, runId: string, stageId: string): GateValidationExecutionIdentity | undefined {
  return settledGateValidationExecution(projectDir, runId, stageId)
    ?? gateValidationExecution(projectDir, runId, stageId, STAGE_STATUS.FAILED);
}

/** Compare the receipt to an execution chosen by its consumer. Deleting this
 * binding would permit a passing receipt from another settled attempt. */
export function validationDeltaMatchesExecution(
  delta: GateValidationDeltaArtifact,
  execution: GateValidationExecutionIdentity | undefined,
): boolean {
  // Historical ledger rows can be malformed; equal scalar values alone are
  // insufficient to establish a typed execution identity.
  return delta.version === 2 && execution !== undefined
    && typeof delta.attemptIndex === 'number'
    && typeof delta.attemptStartedAt === 'string'
    && typeof delta.attemptCompletedAt === 'string'
    && typeof delta.executionId === 'string'
    && execution.attemptIndex === delta.attemptIndex
    && execution.attemptStartedAt === delta.attemptStartedAt
    && execution.attemptCompletedAt === delta.attemptCompletedAt
    && execution.executionId === delta.executionId;
}

/** Verdict readers and settlement share the same receipt reader and execution
 * binding. Only this owner interprets mechanical validation; authored verdicts
 * cannot substitute another attempt or setup baseline for a passing receipt. */
export function gateValidationRefusal(projectDir: string, runId: string, stageId: string): GateVerdict | undefined {
  const base = runDir(projectDir, runId);
  const baselinePath = join(base, RUN_VALIDATION_BASELINE_FILE);
  if (!existsSync(baselinePath)) return undefined;
  const execution = closedGateValidationExecution(projectDir, runId, stageId);
  const prefix = `Validation baseline delta for gate ${stageId}`;
  const refuse = (reason: string): GateVerdict => ({ pass: false, reason });
  if (!execution) return refuse(`${prefix} cannot be matched to a settled gate execution; run configured validation for the current gate attempt`);
  const delta = readValidationDelta(join(base, `validation_delta_${stageId}.json`));
  if (!delta) return refuse(`${prefix} is missing for current execution ${execution.executionId}; run configured validation for this gate attempt`);
  if (delta.stageId !== stageId || !validationDeltaMatchesExecution(delta, execution)) {
    return refuse(`${prefix} belongs to execution ${delta.executionId ?? 'unknown'} (attempt ${String(delta.attemptIndex ?? 'unknown')}), not current execution ${execution.executionId} (attempt ${execution.attemptIndex}); run configured validation for the current gate attempt`);
  }
  if (delta.baselineSha256 !== createHash('sha256').update(readFileSync(baselinePath)).digest('hex')) {
    return refuse(`${prefix} used a different setup baseline for current execution ${execution.executionId}; rerun configured validation against the admitted setup baseline`);
  }
  if (delta.pass === true) return settledGateValidationExecution(projectDir, runId, stageId)
    ? undefined : refuse(`${prefix} passed configured validation, but the gate execution failed`);
  const regressions = delta.delta.filter(entry => entry.state === 'regression');
  if (regressions.length) {
    const named = regressions.map(entry => `${entry.role}: ${entry.newFailureIdentifiers.join(', ') || entry.reason}`).join('; ');
    return { ...refuse(`${prefix} recorded regressions for current execution ${execution.executionId} (${named}); repair the named failures, then rerun configured validation`),
      repairability: { version: 1, disposition: 'repairable', evidence: join(base, delta.immutablePath ?? `validation_delta_${stageId}.json`) } };
  }
  const unresolved = delta.delta.filter(entry => entry.state !== 'pass').map(entry => `${entry.role}: ${entry.reason}`).join('; ');
  return refuse(`${prefix} recorded no regression but could not be resolved for current execution ${execution.executionId} (${unresolved}); this is not a code failure to repair`);
}

/** Adopt pre-review results only after the entire wave is known to have avoided
 * project writes. Include earlier peer attempts: a failed/suspended child may
 * write before its last, read-only continuation. Unknown attribution reruns. */
export function bindReviewedGateValidation(projectDir: string, runId: string, stageId: string, waveStageIds: string[] = [stageId]): boolean {
  const base = runDir(projectDir, runId), prior = readValidationDelta(join(base, `validation_delta_${stageId}.json`));
  const execution = closedGateValidationExecution(projectDir, runId, stageId);
  if (!prior || !execution || prior.stageId !== stageId || prior.attemptCompletedAt !== ''
    || prior.attemptIndex !== execution.attemptIndex || prior.attemptStartedAt !== execution.attemptStartedAt
    || prior.executionId !== validationExecutionId(runId, stageId, execution.attemptIndex, execution.attemptStartedAt, '')
    || prior.baselineSha256 !== createHash('sha256').update(readFileSync(join(base, RUN_VALIDATION_BASELINE_FILE))).digest('hex')) return false;
  for (const id of new Set([stageId, ...waveStageIds])) {
    const attempts = readStageStatus(projectDir, runId, id).attempts;
    if (!attempts?.length || attempts.some(attempt =>
      attempt.status === STAGE_STATUS.RUNNING || !Array.isArray(attempt.writes) || attempt.writeAttribution === 'unknown'
      || attempt.writes.some(path => !path.startsWith('run:')) || attempt.validationGeneratedWrites?.length)) return false;
  }
  const bound = { ...prior, ...execution };
  bound.immutablePath = `validation_delta_${stageId}_attempt_${execution.attemptIndex}_${createHash('sha256').update(JSON.stringify(bound)).digest('hex').slice(0, 16)}.json`;
  publishJsonCreateOnly(join(base, bound.immutablePath), bound);
  writeFileSync(join(base, `validation_delta_${stageId}.json`), `${JSON.stringify(bound)}\n`);
  return true;
}

export function readRunValidationBaseline(runDirPath: string): RunValidationBaselineArtifact | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(runDirPath, RUN_VALIDATION_BASELINE_FILE), 'utf-8')) as RunValidationBaselineArtifact;
    if (parsed.version !== 1 || parsed.source !== 'ship-setup-ready-record'
        || !parsed.baseline || parsed.baseline.version !== 1) return undefined;
    return parsed;
  } catch { return undefined; }
}

export function snapshotShipSetupValidationBaseline(
  projectDir: string,
  exactBrief: string,
  runDirPath: string,
): RunValidationBaselineArtifact | undefined {
  const baseline = readShipSetupReadyValidationBaseline(projectDir, exactBrief);
  if (!baseline) return undefined;
  const artifact: RunValidationBaselineArtifact = {
    version: 1,
    capturedAt: new Date().toISOString(),
    source: 'ship-setup-ready-record',
    baseline,
  };
  writeFileSync(join(runDirPath, RUN_VALIDATION_BASELINE_FILE), `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  return artifact;
}

/** Execute and persist the baseline comparison at the gate consumer boundary. */
export async function recordGateValidationDelta(
  projectDir: string,
  runId: string,
  stageId: string,
  dependencies: ProjectValidationDependencies = {},
): Promise<GateValidationDeltaArtifact | undefined> {
  const base = runDir(projectDir, runId);
  const snapshot = readRunValidationBaseline(base);
  if (!snapshot) return undefined;
  const validationStartedAt = new Date().toISOString();
  const runningExecution = gateValidationExecution(projectDir, runId, stageId, STAGE_STATUS.RUNNING);
  const executionOwner = runningExecution ? { stageId, attemptIndex: runningExecution.attemptIndex,
    attemptStartedAt: runningExecution.attemptStartedAt } : undefined;
  const guardedRunner: ValidationCommandRunner = dependencies.runCommand ?? (request =>
    runValidationCommand({ ...request, runDir: base, execution: executionOwner }));
  const current = await runProjectValidationBaseline(projectDir, {
    ...dependencies,
    commands: snapshot.baseline.discovery.commands,
    runCommand: guardedRunner,
  });
  const delta = evaluateValidationDelta(snapshot.baseline, current.results);
  const baselineBytes = readFileSync(join(base, RUN_VALIDATION_BASELINE_FILE));
  const checkedAt = new Date().toISOString();
  const execution = closedGateValidationExecution(projectDir, runId, stageId)
    ?? gateValidationExecution(projectDir, runId, stageId, STAGE_STATUS.RUNNING) ?? {
    attemptIndex: 0,
    attemptStartedAt: validationStartedAt,
    attemptCompletedAt: checkedAt,
    executionId: validationExecutionId(runId, stageId, 0, validationStartedAt, checkedAt),
  };
  const artifact: GateValidationDeltaArtifact = {
    version: 2,
    stageId,
    checkedAt,
    pass: delta.every((entry) => entry.state === 'pass'),
    baselineSha256: createHash('sha256').update(baselineBytes).digest('hex'),
    current: current.results,
    delta,
    ...execution,
    immutablePath: '',
  };
  const previous = readValidationDelta(join(base, `validation_delta_${stageId}.json`));
  artifact.validationAttemptIndex = previous?.executionId === execution.executionId
    && previous.baselineSha256 === artifact.baselineSha256
    ? (previous.validationAttemptIndex ?? 1) + 1 : 1;
  const validationDigest = createHash('sha256')
    .update(JSON.stringify({ checkedAt, executionId: execution.executionId, validationAttemptIndex: artifact.validationAttemptIndex, current: artifact.current, delta }), 'utf8')
    .digest('hex');
  const immutablePath = `validation_delta_${stageId}_attempt_${execution.attemptIndex}_${validationDigest.slice(0, 16)}.json`;
  artifact.immutablePath = immutablePath;
  publishJsonCreateOnly(join(base, immutablePath), artifact);
  writeFileSync(join(base, `validation_delta_${stageId}.json`), `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  return artifact;
}

/** Resolve missing/incomplete evidence once, before review or after project
 * writes. Both receipts stay immutable; unknown evidence never authorizes work. */
export async function settleGateValidationEvidence(
  projectDir: string,
  runId: string,
  stageId: string,
  dependencies: ProjectValidationDependencies = {},
): Promise<{ kind: 'unchanged' | 'replayed' } | { kind: 'refused'; reason: string }> {
  const base = runDir(projectDir, runId);
  if (!readRunValidationBaseline(base)) return { kind: 'unchanged' };
  const execution = closedGateValidationExecution(projectDir, runId, stageId)
    ?? gateValidationExecution(projectDir, runId, stageId, STAGE_STATUS.RUNNING);
  if (!execution) return { kind: 'refused', reason: `Validation settlement for ${stageId} requires a current execution` };
  const previous = readValidationDelta(join(base, `validation_delta_${stageId}.json`));
  const digest = createHash('sha256').update(readFileSync(join(base, RUN_VALIDATION_BASELINE_FILE))).digest('hex');
  const bound = previous?.version === 2 && previous.stageId === stageId
    && validationDeltaMatchesExecution(previous, execution) && previous.baselineSha256 === digest;
  if (previous && bound && (previous.pass === true || previous.delta.some((entry) => entry.state === 'regression'))) return { kind: 'unchanged' };
  const refuse = (delta?: GateValidationDeltaArtifact) => ({ kind: 'refused' as const,
    reason: `Validation settlement for ${stageId} remains unresolved after its mechanical retry. Evidence: ${join(base, delta?.immutablePath ?? `validation_delta_${stageId}.json`)}. ${delta?.delta.filter((entry) => entry.state !== 'pass').map((entry) => `${entry.display ?? entry.role}: ${entry.reason}`).join('; ') ?? 'No comparable validation receipt'}` });
  if (previous && bound && (previous.validationAttemptIndex ?? 1) >= 2) return refuse(previous);
  const next = await recordGateValidationDelta(projectDir, runId, stageId, dependencies);
  if (!next || !validationDeltaMatchesExecution(next, execution)) return refuse(next);
  if (next.pass === true) return { kind: 'replayed' };
  // A measured regression still follows the established gate/repair route.
  if (next.delta.some((entry) => entry.state === 'regression')) return { kind: 'unchanged' };
  return refuse(next);
}
