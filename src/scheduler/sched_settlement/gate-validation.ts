// Boundary: Setup baseline capture, attempt-bound validation delta and guarded configured command execution; no gate repair or topology changes.
import { ProjectValidationBaseline, ProjectValidationDependencies, ValidationCommandRunner, ValidationDeltaResult, evaluateValidationDelta, outwardProjectSymlinks, runProjectValidationBaseline, runValidationCommand } from '../../project-validation.js';
import { publishJsonCreateOnly } from '../../runtime-negotiation.js';
import { readShipSetupReadyValidationBaseline } from '../../ship-setup-record.js';
import { STAGE_STATUS, readStageStatus, runDir } from '../../store.js';
import { RUN_VALIDATION_BASELINE_FILE } from '../sched_policy/terminal.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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
      || value.delta.length < 3 || new Set(value.delta.map((entry) => entry.role)).size !== 3
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

function gateValidationExecution(projectDir: string, runId: string, stageId: string, status: 'running' | 'complete'): GateValidationExecutionIdentity | undefined {
  try {
    const attempt = readStageStatus(projectDir, runId, stageId).attempts?.at(-1);
    if (attempt?.status !== status || (status === STAGE_STATUS.COMPLETE && !attempt.completedAt)) return undefined;
    const completedAt = status === STAGE_STATUS.COMPLETE ? attempt.completedAt! : '';
    return { attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt, attemptCompletedAt: completedAt,
      executionId: validationExecutionId(runId, stageId, attempt.index, attempt.startedAt, completedAt) };
  } catch { return undefined; }
}

export function settledGateValidationExecution(projectDir: string, runId: string, stageId: string): GateValidationExecutionIdentity | undefined {
  return gateValidationExecution(projectDir, runId, stageId, STAGE_STATUS.COMPLETE);
}

export function validationDeltaMatchesCurrentExecution(
  projectDir: string,
  runId: string,
  delta: GateValidationDeltaArtifact,
): boolean {
  if (delta.version !== 2
      || typeof delta.attemptIndex !== 'number'
      || typeof delta.attemptStartedAt !== 'string'
      || typeof delta.attemptCompletedAt !== 'string'
      || typeof delta.executionId !== 'string') return false;
  if (validationExecutionId(
    runId,
    delta.stageId,
    delta.attemptIndex,
    delta.attemptStartedAt,
    delta.attemptCompletedAt,
  ) !== delta.executionId) return false;

  // Terminal revalidation is an engine-owned execution rather than a worker
  // attempt, and therefore uses the reserved synthetic attempt index.
  if (delta.attemptIndex === 0) return delta.stageId.startsWith('terminal_');
  const current = settledGateValidationExecution(projectDir, runId, delta.stageId);
  return current?.attemptIndex === delta.attemptIndex
    && current.attemptStartedAt === delta.attemptStartedAt
    && current.attemptCompletedAt === delta.attemptCompletedAt
    && current.executionId === delta.executionId;
}

/** Adopt pre-review results only after the entire wave is known to have avoided
 * project writes. Include earlier peer attempts: a failed/suspended child may
 * write before its last, read-only continuation. Unknown attribution reruns. */
export function bindReviewedGateValidation(projectDir: string, runId: string, stageId: string, waveStageIds: string[] = [stageId]): boolean {
  const base = runDir(projectDir, runId), prior = readValidationDelta(join(base, `validation_delta_${stageId}.json`));
  const execution = settledGateValidationExecution(projectDir, runId, stageId);
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
  const guardedRunner: ValidationCommandRunner = dependencies.runCommand ?? ((request) => {
    const links = outwardProjectSymlinks(projectDir);
    if (links.length === 0) return runValidationCommand({ ...request, runDir: base });
    const projectRoot = realpathSync(projectDir);
    const refuse = (reason: string) => ({ exitCode: null, durationMs: 0,
      error: `Gate validation replay refused: ${reason}` });
    // A bind mount of a directory does not make a nested mount or a symlink's
    // separate referent read-only. Refuse those shapes instead of trusting them.
    const mountPoints = readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
      .map((line) => line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8))))
      .filter((path): path is string => Boolean(path));
    for (const link of links) {
      if (!link.target) return refuse(`project path ${relative(projectDir, link.path)} could not be inspected`);
      let target: string;
      try { target = realpathSync(link.path); }
      catch { return refuse(`project symlink ${relative(projectDir, link.path)} has no readable target`); }
      const pending = [target];
      let visited = 0;
      while (pending.length > 0) {
        const path = pending.pop()!;
        if (++visited > 50_000) return refuse(`linked input ${relative(projectDir, link.path)} exceeds the isolation scan limit`);
        let entries;
        try {
          if (!lstatSync(path).isDirectory()) continue;
          entries = readdirSync(path, { withFileTypes: true });
        } catch { return refuse(`linked input ${relative(projectDir, link.path)} could not be inspected`); }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) return refuse(`linked input ${relative(projectDir, link.path)} contains another symlink`);
          if (entry.isDirectory()) pending.push(join(path, entry.name));
        }
      }
      if (mountPoints.some((point) => point !== target && point.startsWith(`${target}${sep}`))) {
        return refuse(`linked input ${relative(projectDir, link.path)} contains a separate mount`);
      }
    }
    // The common positive write policy resolves each open's physical inode,
    // so external linked inputs stay readable without gaining write authority.
    return runValidationCommand({ ...request, runDir: base });
  });
  const current = await runProjectValidationBaseline(projectDir, {
    ...dependencies,
    commands: snapshot.baseline.discovery.commands,
    runCommand: guardedRunner,
  });
  const delta = evaluateValidationDelta(snapshot.baseline, current.results);
  const baselineBytes = readFileSync(join(base, RUN_VALIDATION_BASELINE_FILE));
  const checkedAt = new Date().toISOString();
  const execution = settledGateValidationExecution(projectDir, runId, stageId)
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

/** A validation failure is not a new authored review. Re-run missing/incomplete
 * mechanical evidence once, preserving both immutable receipts. Reuse is not
 * inferred from Git visibility: arbitrary commands can read ignored inputs.
 * Deleting delta enforcement would lose fail-closed settlement; a separate
 * mechanical phase is needed because a model cannot repair censored output.
 */
export async function settleGateValidationEvidence(
  projectDir: string,
  runId: string,
  stageId: string,
  dependencies: ProjectValidationDependencies = {},
): Promise<{ kind: 'unchanged' | 'replayed' } | { kind: 'refused'; reason: string }> {
  const base = runDir(projectDir, runId);
  if (!readRunValidationBaseline(base)) return { kind: 'unchanged' };
  const execution = settledGateValidationExecution(projectDir, runId, stageId);
  if (!execution) return { kind: 'refused', reason: `Validation settlement for ${stageId} requires a settled complete execution` };
  const previous = readValidationDelta(join(base, `validation_delta_${stageId}.json`));
  const digest = createHash('sha256').update(readFileSync(join(base, RUN_VALIDATION_BASELINE_FILE))).digest('hex');
  const bound = previous?.version === 2 && previous.stageId === stageId
    && validationDeltaMatchesCurrentExecution(projectDir, runId, previous) && previous.baselineSha256 === digest;
  if (previous && bound && (previous.pass === true || previous.delta.some((entry) => entry.state === 'regression'))) return { kind: 'unchanged' };
  const refuse = (delta?: GateValidationDeltaArtifact) => ({ kind: 'refused' as const,
    reason: `Validation settlement for ${stageId} remains unresolved after its mechanical retry; authored review is preserved. ${delta?.delta.filter((entry) => entry.state !== 'pass').map((entry) => `${entry.display ?? entry.role}: ${entry.reason}`).join('; ') ?? 'No comparable validation receipt'}` });
  if (previous && bound && (previous.validationAttemptIndex ?? 1) >= 2) return refuse(previous);
  const next = await recordGateValidationDelta(projectDir, runId, stageId, dependencies);
  if (!next || !validationDeltaMatchesCurrentExecution(projectDir, runId, next)) return refuse(next);
  if (next.pass === true) return { kind: 'replayed' };
  // A measured regression still follows the established gate/repair route.
  if (next.delta.some((entry) => entry.state === 'regression')) return { kind: 'unchanged' };
  return refuse(next);
}
