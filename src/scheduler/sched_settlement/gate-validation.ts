import { runRecordPath } from '../../run-layout.js';
import { parseBriefFrontmatterDocument } from '../../brief-frontmatter.js';
// Validation execution belongs to the engine. Gates bind record references.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileSync } from '../../engine-fs.js';
import { engineValidation } from '../../engine-validation.js';
import { confirmedRepairFindings } from './gate-archives.js';
import { loadEngineDefaults } from '../../config.js';
import { runProcessAbortSignal } from '../../adapters/base.js';
import { publishJsonCreateOnly } from '../../canonical-json.js';
import { readShipSetupReadyValidationBaseline } from '../../ship-setup-record.js';
import { readStageStatus, readRunState, updateRunState, runDir, RUN_STATUS, STAGE_STATUS, type GateVerdict } from '../../store.js';
import {
  reconcileProjectValidation, parseValidationCommands, ValidationSelectionSchema, projectValidationResult, evaluateValidationDelta, runProjectCommand,
  type ProjectValidationBaseline, type ProjectValidationDependencies, type ValidationLimits, type ValidationDeltaResult, type ValidationCommand,
} from '../../project-validation.js';
import { appendEvidence, captureProjectTree, projectCommit, projectValidationDelta, projectValidationFact, readEvidence, validationBatch, validationForTree, VALIDATION_FACT_VERSION, type ValidationFact } from '../../evidence-ledger.js';
import { RUN_VALIDATION_BASELINE_FILE } from '../sched_policy/terminal.js';

export interface RunValidationBaselineArtifact {
  version: 1;
  capturedAt: string;
  source: 'ship-setup-ready-record' | 'project-declarations' | 'model-selection';
  baseCommit?: string;
  /** The brief's declared validation limits; absent fields use the engine defaults. */
  limits?: ValidationLimits;
  baseline: ProjectValidationBaseline;
}
export interface GateValidationExecutionIdentity {
  attemptIndex: number; attemptStartedAt: string; attemptCompletedAt: string; executionId: string;
}
export interface GateValidationDeltaArtifact extends Partial<GateValidationExecutionIdentity> {
  version: 1 | 2;
  stageId: string;
  checkedAt: string;
  pass: boolean;
  baselineSha256: string;
  current: ProjectValidationBaseline['results'];
  delta: ValidationDeltaResult[];
  immutablePath?: string;
  validationAttemptIndex?: number;
  treeHash?: string | null;
  ledgerSequence?: number;
}

function briefAt(base: string): string {
  try { return readFileSync(runRecordPath(base, 'task_brief.md'), 'utf8'); } catch { return ''; }
}
export function validationExecutionId(runId: string, stageId: string, index: number, start: string, end: string): string {
  return createHash('sha256').update([runId, stageId, String(index), start, end].join('\0')).digest('hex');
}
function gateExecution(projectDir: string, runId: string, stageId: string, statuses: string[]): GateValidationExecutionIdentity | undefined {
  try {
    const stage = readStageStatus(projectDir, runId, stageId), attempt = stage.attempts?.at(-1);
    if (!attempt || stage.continuation || !statuses.includes(attempt.status)) return undefined;
    const end = attempt.status === STAGE_STATUS.RUNNING ? '' : attempt.completedAt;
    if (end === undefined) return undefined;
    return { attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt, attemptCompletedAt: end,
      executionId: validationExecutionId(runId, stageId, attempt.index, attempt.startedAt, end) };
  } catch { return undefined; }
}
export function settledGateValidationExecution(projectDir: string, runId: string, stageId: string): GateValidationExecutionIdentity | undefined {
  return gateExecution(projectDir, runId, stageId, ['complete']);
}
export function closedGateValidationExecution(projectDir: string, runId: string, stageId: string): GateValidationExecutionIdentity | undefined {
  return gateExecution(projectDir, runId, stageId, ['complete', 'failed']);
}
export function validationDeltaMatchesExecution(delta: GateValidationDeltaArtifact, execution: GateValidationExecutionIdentity | undefined): boolean {
  return delta.version === 2 && execution !== undefined && Number.isSafeInteger(delta.attemptIndex)
    && typeof delta.attemptStartedAt === 'string' && typeof delta.attemptCompletedAt === 'string'
    && typeof delta.executionId === 'string' && delta.attemptIndex === execution.attemptIndex
    && delta.attemptStartedAt === execution.attemptStartedAt && delta.attemptCompletedAt === execution.attemptCompletedAt
    && delta.executionId === execution.executionId;
}
export function readRunValidationBaseline(base: string): RunValidationBaselineArtifact | undefined {
  try {
    const value = JSON.parse(readFileSync(runRecordPath(base, RUN_VALIDATION_BASELINE_FILE), 'utf8')) as RunValidationBaselineArtifact;
    return value.version === 1 && value.baseline?.version === 1 && Array.isArray(value.baseline.discovery?.commands)
      && Array.isArray(value.baseline.results) ? value : undefined;
  } catch { return undefined; }
}
export function snapshotShipSetupValidationBaseline(projectDir: string, exactBrief: string, base: string): RunValidationBaselineArtifact {
  const admitted = readShipSetupReadyValidationBaseline(projectDir, exactBrief);
  // Ordinary launch already owns metadata warnings. Validate a decoded
  // declaration here without turning unrelated malformed YAML into admission.
  const metadata = parseBriefFrontmatterDocument(exactBrief)?.value;
  const declaration = parseValidationCommands(metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>).validation : undefined, runRecordPath(base, 'task_brief.md'));
  if (declaration.error) throw new Error(declaration.error);
  const baseline: ProjectValidationBaseline = admitted ?? { version: 1, execution: 'skipped', projectDir,
    discovery: reconcileProjectValidation(projectDir, declaration.commands), results: [], gateCriteria: [] };
  if (baseline.discovery.state === 'unknown' && declaration.commands.length) throw new Error(baseline.discovery.reason ?? 'Validation declarations conflict');
  const baseCommit = projectCommit(projectDir);
  const artifact: RunValidationBaselineArtifact = { version: 1, capturedAt: new Date().toISOString(),
    source: admitted ? 'ship-setup-ready-record' : 'project-declarations', baseCommit, ...(declaration.limits ? { limits: declaration.limits } : {}),
    // Historical setup measurements are retained for audit, but never decide a new attempt.
    baseline };
  writeFileSync(runRecordPath(base, RUN_VALIDATION_BASELINE_FILE), `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}
/** Called before an author can write, including low-level runStage callers. */
export function ensureAttemptValidationPlan(projectDir: string, runId: string): RunValidationBaselineArtifact {
  const base = runDir(projectDir, runId);
  const prior = readRunValidationBaseline(base);
  if (prior) return prior;
  return snapshotShipSetupValidationBaseline(projectDir, briefAt(base), base);
}

/** Settle the first author's schema-bound command selection once. Invalid output stays
 * explicitly unknown and is never replaced by discovery heuristics. */
export function recordValidationSelection(projectDir: string, runId: string, value: unknown): void {
  const base = runDir(projectDir, runId), plan = readRunValidationBaseline(base);
  if (!plan || plan.baseline.discovery.commands.length || plan.source === 'model-selection') return;
  const selected = ValidationSelectionSchema.safeParse(value);
  plan.source = 'model-selection';
  const commands = selected.success && Object.keys(selected.data.commands).length
    ? parseValidationCommands({ commands: selected.data.commands }, 'model-selection').commands : [];
  plan.baseline.discovery = { state: commands.length ? 'partial' : 'unknown', configPath: 'model-selection',
    commands: commands.map(command => ({ ...command, display: [command.command, ...command.args].join(' ') })),
    missingRoles: (['build', 'test', 'lint'] as const).filter(role => !commands.some(command => command.role === role)),
    reason: `Model selection: ${selected.success ? selected.data.reason : 'invalid or unavailable; validation unmeasured'}` };
  // Never reconstruct a missing pre-author input image from authored bytes.
  writeFileSync(runRecordPath(base, RUN_VALIDATION_BASELINE_FILE), `${JSON.stringify(plan, null, 2)}\n`);
}

function validationPlanIdentity(commands: readonly Pick<ValidationCommand, 'role' | 'command' | 'args' | 'env'>[]): string {
  return createHash('sha256').update(JSON.stringify(commands.map(command => [command.role, command.command, command.args,
    Object.entries(command.env ?? {}).filter(([, value]) => value !== undefined).sort()]))).digest('hex');
}

/** The scheduler requests one engine record after settled writes. Gate and resume
 * requests use the same content-addressed owner; they never execute separately. */
export async function recordAttemptValidation(projectDir: string, runId: string, stageId: string,
  dependencies: ProjectValidationDependencies = {}): Promise<ValidationFact> {
  const base = runDir(projectDir, runId), plan = ensureAttemptValidationPlan(projectDir, runId);
  const attempt = readStageStatus(projectDir, runId, stageId).attempts?.at(-1);
  if (!attempt) throw new Error('ATTEMPT_VALIDATION_PLAN_MISSING');
  const tree = captureProjectTree(projectDir, briefAt(base), base), treeHash = tree.hash;
  if (!treeHash) return appendEvidence(base, { kind: 'validation', validationVersion: VALIDATION_FACT_VERSION,
    stageId, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt, treeHash: null, resourceState: 'unfinished',
    recordPath: runRecordPath(base, 'evidence-ledger.jsonl'), executions: [], failures: [], pass: false,
    delta: plan.baseline.discovery.commands.map(command => ({ role: command.role, display: command.display, state: 'unverified',
      reason: tree.reason ?? 'Source tree identity unavailable', newFailureIdentifiers: [] })) }) as ValidationFact;
  const previous = validationForTree(readEvidence(base), treeHash);
  const completed = previous && (previous.validationVersion === undefined || [1, 2, 3].includes(previous.validationVersion)) ? previous.executions.find(execution => execution.target === 'attempt'
    && execution.treeHash === treeHash && execution.treeAfterHash === treeHash
    && validationPlanIdentity(execution.commands) === validationPlanIdentity(plan.baseline.discovery.commands)
    && execution.commands.every(result => Number.isInteger(result.exitCode) && !result.unfinished)) : undefined;
  const record = previous?.validationVersion === VALIDATION_FACT_VERSION && previous.resourceState === 'complete' ? previous : await engineValidation({ projectDir, treeHash, commands: plan.baseline.discovery.commands, limits: plan.limits, completed, run: { projectDir, runId },
    treeAfter: () => captureProjectTree(projectDir, briefAt(base), base).hash, ...dependencies });
  if (record.resourceState === 'complete' && validationPlanIdentity(record.executions.at(-1)!.commands) !== validationPlanIdentity(plan.baseline.discovery.commands)) {
    throw new Error(`VALIDATION_DECLARATION_CONFLICT: requested commands differ from completed engine record ${record.recordPath}; this tree cannot execute another validation`);
  }
  if (record === previous) return previous;
  const fact: ValidationFact = { ...record, kind: 'validation', stageId, attemptIndex: attempt.index,
    attemptStartedAt: attempt.startedAt, delta: evaluateValidationDelta(undefined,
      record.executions.at(-1)?.commands ?? [], undefined, plan.baseline.discovery.commands), failures: [] };
  if (previous && previous.resourceState === record.resourceState && JSON.stringify(previous.executions) === JSON.stringify(record.executions)) return previous;
  const joined = validationForTree(readEvidence(base), treeHash);
  if (joined?.resourceState === 'complete') return joined;
  return appendEvidence(base, fact) as ValidationFact;
}

/** Called at the scheduler boundary, including resume before any decision.
 * Unfinished resource work parks the run and leaves all stage budgets intact. */
export async function validateSettledTree(projectDir: string, runId: string): Promise<boolean> {
  const base = runDir(projectDir, runId), plan = readRunValidationBaseline(base);
  const state = readRunState(projectDir, runId);
  const author = readEvidence(base).filter(entry => {
    if (entry.kind !== 'attempt' || entry.status !== STAGE_STATUS.COMPLETE || entry.continuation || entry.endingCause === 'environment_gap') return false;
    const stage = state.planControl?.stages.find(stage => stage.id === entry.stageId);
    return stage && !stage.is_gate && !stage.dynamic_dispatch && !['shape', 'review'].includes(stage.decision?.kind ?? '');
  }).at(-1);
  if (!author || author.kind !== 'attempt') return true;
  const control = new AbortController();
  const parent = runProcessAbortSignal();
  const abort = () => control.abort();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setInterval(() => {
    if (readRunState(projectDir, runId).status !== RUN_STATUS.RUNNING) abort();
  }, 100);
  const validate = async (): Promise<boolean> => {
    if (plan?.baseline.discovery.commands.length) {
      const fact = await recordAttemptValidation(projectDir, runId, author.stageId, { abortSignal: control.signal });
      updateRunState(projectDir, runId, current => {
        if (current.status !== RUN_STATUS.RUNNING) return;
        current.validation = (validationBatch(fact)?.commands ?? []).map(result => ({ ...result, ...projectValidationResult(result) }));
        if (fact.resourceState === 'complete') return;
        current.status = RUN_STATUS.PARKED;
        current.recovery = { kind: 'resumable', cause: 'unknown', at: new Date().toISOString(), interruptedStages: [],
          reason: `Validation unfinished: ${fact.recordPath}. Resume with sufficient declared resource limits and readable source identity; no review or repair was consumed.` };
      });
      return fact.resourceState === 'complete';
    }
    return true;
  };
  try {
    if (!await validate()) return false;
    const stage = state.planControl?.stages.find(stage => stage.id === author.stageId);
    const findings = stage?.retry_to && state.gateRetryRound ? confirmedRepairFindings(base, stage.retry_to, state.gateRetryRound) : [];
    for (const finding of findings) {
      if (!finding.record.context || control.signal.aborted) continue;
      const before = captureProjectTree(projectDir, briefAt(base), base);
      if (readEvidence(base).some(entry => entry.kind === 'command' && entry.reproductionOf === finding.record.sequence
        && entry.sequence > author.sequence)) continue;
      const replay = await runProjectCommand({ role: 'test', command: finding.record.context.shell,
        args: ['-c', finding.record.command!], display: finding.record.command!, cwd: finding.record.context.cwd, runDir: base,
        timeoutMs: finding.record.timeoutMs ?? loadEngineDefaults().validation_timeout_ms, abortSignal: control.signal });
      appendEvidence(base, { kind: 'command', owner: 'code', stageId: author.stageId, attemptIndex: author.attemptIndex,
        commandId: `closure-${finding.id}`, command: finding.record.command, context: finding.record.context, exitCode: replay.exitCode,
        outputDigest: createHash('sha256').update(JSON.stringify([replay.stdout ?? '', replay.stderr ?? ''])).digest('hex'),
        treeHash: before.hash, treeAfterHash: captureProjectTree(projectDir, briefAt(base), base).hash, reproductionOf: finding.record.sequence });
    }
    // An opaque closure may write; bind its final tree before releasing review.
    return await validate();
  } finally {
    clearInterval(timer);
    parent?.removeEventListener('abort', abort);
  }
}

export function readValidationDelta(path: string): GateValidationDeltaArtifact | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as GateValidationDeltaArtifact;
    if (![1, 2].includes(value.version) || typeof value.pass !== 'boolean' || !Array.isArray(value.delta)) return undefined;
    return projectValidationDelta(dirname(path), value);
  } catch { return undefined; }
}
/** Bind a reference, not a second copy of the facts. This function executes no suite. */
export async function recordGateValidationDelta(projectDir: string, runId: string, stageId: string,
  _dependencies: ProjectValidationDependencies = {}): Promise<GateValidationDeltaArtifact | undefined> {
  const base = runDir(projectDir, runId), plan = readRunValidationBaseline(base);
  if (!plan || !plan.baseline.discovery.commands.length) return undefined;
  const execution = closedGateValidationExecution(projectDir, runId, stageId) ?? gateExecution(projectDir, runId, stageId, ['running']);
  if (!execution) return undefined;
  const tree = captureProjectTree(projectDir, briefAt(base), base);
  const fact = validationForTree(readEvidence(base), tree.hash);
  const projected = fact && projectValidationFact(fact);
  const current = projected && validationBatch(projected);
  const valid = fact && tree.hash !== null && fact.treeHash === tree.hash && current?.treeHash === tree.hash && current.treeAfterHash === tree.hash
    && (fact.resourceState === 'complete' || (fact.validationVersion ?? 1) < VALIDATION_FACT_VERSION)
    && current.commands.length === plan.baseline.discovery.commands.length
    && current.commands.every(command => Number.isInteger(command.exitCode) && !command.unfinished);
  const delta: ValidationDeltaResult[] = valid ? projected!.delta : [{ role: 'test', state: 'unverified', reason: 'No completed engine validation covers the current source tree', newFailureIdentifiers: [] }];
  const artifact: GateValidationDeltaArtifact = { version: 2, stageId, checkedAt: new Date().toISOString(),
    pass: valid ? projected!.pass : false, baselineSha256: createHash('sha256').update(readFileSync(runRecordPath(base, RUN_VALIDATION_BASELINE_FILE))).digest('hex'),
    current: valid ? current!.commands : [], delta, ...execution, treeHash: tree.hash,
    ...(valid ? { ledgerSequence: fact.sequence } : {}), validationAttemptIndex: 1 };
  artifact.immutablePath = `validation_delta_${stageId}_attempt_${execution.attemptIndex}_${createHash('sha256').update(JSON.stringify(artifact)).digest('hex').slice(0, 16)}.json`;
  const { current: _current, ...reference } = artifact;
  const stored = valid ? reference : artifact;
  publishJsonCreateOnly(runRecordPath(base, artifact.immutablePath), stored);
  writeFileSync(runRecordPath(base, `validation_delta_${stageId}.json`), `${JSON.stringify(stored)}\n`);
  return artifact;
}
export function bindReviewedGateValidation(projectDir: string, runId: string, stageId: string, _waveStageIds?: string[]): boolean {
  const base = runDir(projectDir, runId), prior = readValidationDelta(runRecordPath(base, `validation_delta_${stageId}.json`));
  const execution = closedGateValidationExecution(projectDir, runId, stageId);
  if (!prior || !execution || prior.baselineSha256 !== createHash('sha256').update(readFileSync(runRecordPath(base, RUN_VALIDATION_BASELINE_FILE))).digest('hex') || !prior.treeHash || prior.treeHash !== captureProjectTree(projectDir, briefAt(base), base).hash
    || prior.attemptIndex !== execution.attemptIndex || prior.attemptStartedAt !== execution.attemptStartedAt) return false;
  const { current: _current, ...bound } = { ...prior, ...execution };
  bound.immutablePath = `validation_delta_${stageId}_attempt_${execution.attemptIndex}_${createHash('sha256').update(JSON.stringify(bound)).digest('hex').slice(0, 16)}.json`;
  const stored = bound.ledgerSequence === undefined ? { ...bound, current: prior.current } : bound;
  publishJsonCreateOnly(runRecordPath(base, bound.immutablePath), stored);
  writeFileSync(runRecordPath(base, `validation_delta_${stageId}.json`), `${JSON.stringify(stored)}\n`);
  return true;
}
/** Missing or stale facts expose each selected command as unrun. */
export function currentValidationResults(projectDir: string, runId: string): ProjectValidationBaseline['results'] {
  const base = runDir(projectDir, runId), plan = readRunValidationBaseline(base);
  const fact = validationForTree(readEvidence(base), captureProjectTree(projectDir, briefAt(base), base).hash);
  const commands = fact ? validationBatch(projectValidationFact(fact))?.commands ?? [] : [];
  return (plan?.baseline.discovery.commands ?? commands).map(command => {
    const result = commands.find(result => result.role === command.role && result.display === command.display);
    return result ? { ...result, storedState: result.storedState ?? result.state, ...projectValidationResult(result) } : {
      role: command.role, display: command.display, command: command.command, args: command.args, env: command.env, state: 'unverified', exitCode: null,
      durationMs: 0, output: '', failureIdentifiers: [], failureIdentity: 'unknown', reason: 'Selected command did not run on the reviewed tree',
    };
  });
}

/** Completed nonzero exits are repair facts, without another reproduction. */
export function currentValidationRegressions(projectDir: string, runId: string): NonNullable<ValidationFact['regressions']> {
  const base = runDir(projectDir, runId);
  const fact = validationForTree(readEvidence(base), captureProjectTree(projectDir, briefAt(base), base).hash);
  if (fact?.validationVersion !== VALIDATION_FACT_VERSION || fact.resourceState !== 'complete') return [];
  return (fact.executions.at(-1)?.commands ?? []).flatMap((command, index) => {
    if (command.exitCode === 0) return [];
    return [{ id: `validation_${index}`, paths: ['.'], criterion_ids: [], invalidates_plan: false,
      repair_role: 'coder', reason: `Engine validation record ${fact.sequence}: ${command.display} exited ${command.exitCode}`,
      reproduction: fact.sequence, record: { version: 1 as const, sequence: fact.sequence, at: fact.at,
        kind: 'command' as const, commandId: `validation-${index}`, owner: 'code' as const, stageId: fact.stageId, attemptIndex: fact.attemptIndex,
        command: command.display ?? null, exitCode: command.exitCode ?? null, treeHash: fact.treeHash, treeAfterHash: fact.treeHash,
        validationRecord: fact.sequence } }];
  });
}

/** Historical entry points remain read-only. */
export function currentAuthorValidationRefusal(_projectDir: string, _runId: string): GateVerdict | undefined { return undefined; }
export function gateValidationRefusal(_projectDir: string, _runId: string, _stageId: string): GateVerdict | undefined { return undefined; }
export async function settleGateValidationEvidence(_projectDir: string, _runId: string, _stageId: string,
  _dependencies: ProjectValidationDependencies = {}): Promise<{ kind: 'unchanged' }> { return { kind: 'unchanged' }; }
