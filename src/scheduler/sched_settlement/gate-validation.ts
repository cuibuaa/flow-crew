// Configured validation belongs to authors. Gates only bind and consume facts.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from '../../engine-fs.js';
import { publishJsonCreateOnly } from '../../canonical-json.js';
import { readShipSetupReadyValidationBaseline } from '../../ship-setup-record.js';
import { readStageStatus, runDir, STAGE_STATUS, type GateVerdict } from '../../store.js';
import {
  discoverProjectValidation, evaluateValidationDelta, runProjectValidationBaseline, runValidationCommand,
  type ProjectValidationBaseline, type ProjectValidationDependencies, type ValidationDeltaResult,
} from '../../project-validation.js';
import { appendEvidence, captureProjectTree, projectCommit, readEvidence, safeEvidencePath, VALIDATION_FACT_VERSION, type ValidationExecution, type ValidationFact } from '../../evidence-ledger.js';
import { parseBriefInputs } from '../../ship-inputs.js';
import { RollbackContentStore } from '../../rollback-content-store.js';
import { readRepairFileImage, type RepairFileImage } from '../sched_scope/file-images.js';
import { listProjectFilesAt } from '../sched_scope/path-capabilities.js';
import { restoreProjectPath } from '../sched_scope/restore.js';
import { artifactRootContains } from '../../artifact-location.js';
import { RUN_VALIDATION_BASELINE_FILE } from '../sched_policy/terminal.js';

export interface RunValidationBaselineArtifact {
  version: 1;
  capturedAt: string;
  source: 'ship-setup-ready-record' | 'project-declarations';
  baseCommit?: string;
  baseInputs?: { files: Array<{ path: string; image: RepairFileImage }>; durationMs: number; error?: string };
  baseline: ProjectValidationBaseline;
}
/** Retain only declared materializations absent from the base commit. Reuse the
 * existing content-addressed rollback store and verified restoration primitive. */
function captureBaseInputs(projectDir: string, brief: string, base: string, commit?: string): NonNullable<RunValidationBaselineArtifact['baseInputs']> {
  const started = Date.now(), files: NonNullable<RunValidationBaselineArtifact['baseInputs']>['files'] = [];
  try {
    const inputs = parseBriefInputs(brief).references;
    if (!inputs.length) return { files, durationMs: Date.now() - started };
    if (!commit) throw new Error('No base commit for materialized input inventory');
    const inventory = spawnSync('git', ['ls-tree', '-r', '--name-only', '-z', commit], {
      cwd: projectDir, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024,
    });
    if (inventory.status !== 0) throw new Error('Base commit input inventory unavailable');
    const tracked = new Set(inventory.stdout.split('\0').filter(Boolean));
    const paths = new Set<string>();
    for (const input of inputs) {
      if (!safeEvidencePath(input.path)) throw new Error('Credential/control input cannot be captured');
      paths.add(input.path);
      for (const path of listProjectFilesAt(projectDir, input.path, false, { complete: true, skipDirectory: path => !safeEvidencePath(path) })) paths.add(path);
    }
    const store = new RollbackContentStore(join(base, 'stage_evidence', 'base-inputs'));
    for (const path of [...paths].sort()) {
      if (!safeEvidencePath(path) || tracked.has(path)) continue;
      const image = readRepairFileImage(projectDir, path, undefined, { contentStore: store });
      if (image.inspectionFailure || image.materializationFailure || !image.exists || image.symlink && image.text === undefined) {
        throw new Error(image.inspectionFailure ?? image.materializationFailure ?? `Input preimage unavailable: ${path}`);
      }
      const { bytes: _bytes, text, statIdentity: _stat, ...identity } = image;
      files.push({ path, image: { ...identity, ...(image.symlink ? { text } : {}) } });
    }
    return { files, durationMs: Date.now() - started };
  } catch (error) { return { files, durationMs: Date.now() - started, error: String(error) }; }
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
  try { return readFileSync(join(base, 'task_brief.md'), 'utf8'); } catch { return ''; }
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
    const value = JSON.parse(readFileSync(join(base, RUN_VALIDATION_BASELINE_FILE), 'utf8')) as RunValidationBaselineArtifact;
    return value.version === 1 && value.baseline?.version === 1 && Array.isArray(value.baseline.discovery?.commands)
      && Array.isArray(value.baseline.results) ? value : undefined;
  } catch { return undefined; }
}
export function snapshotShipSetupValidationBaseline(projectDir: string, exactBrief: string, base: string): RunValidationBaselineArtifact {
  const admitted = readShipSetupReadyValidationBaseline(projectDir, exactBrief);
  const baseline: ProjectValidationBaseline = admitted ?? { version: 1, execution: 'skipped', projectDir,
    discovery: discoverProjectValidation(projectDir), results: [], gateCriteria: [] };
  const baseCommit = projectCommit(projectDir);
  const artifact: RunValidationBaselineArtifact = { version: 1, capturedAt: new Date().toISOString(),
    source: admitted ? 'ship-setup-ready-record' : 'project-declarations', baseCommit,
    ...(baseline.discovery.commands.length ? { baseInputs: captureBaseInputs(projectDir, exactBrief, base, baseCommit) } : {}),
    // Historical setup measurements are retained for audit, but never decide a new attempt.
    baseline };
  writeFileSync(join(base, RUN_VALIDATION_BASELINE_FILE), `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}
/** Called before an author can write, including low-level runStage callers. */
export function ensureAttemptValidationPlan(projectDir: string, runId: string): RunValidationBaselineArtifact {
  const base = runDir(projectDir, runId);
  const prior = readRunValidationBaseline(base);
  if (prior) return prior;
  return snapshotShipSetupValidationBaseline(projectDir, briefAt(base), base);
}

/** One suite at the closed author boundary, plus one separate base tree only
 * for a red suite. There is no tree cache and no retry on uncertain identity. */
export async function recordAttemptValidation(projectDir: string, runId: string, stageId: string,
  dependencies: ProjectValidationDependencies = {}): Promise<ValidationFact> {
  const base = runDir(projectDir, runId), plan = readRunValidationBaseline(base);
  const attempt = readStageStatus(projectDir, runId, stageId).attempts?.at(-1);
  if (!attempt || !plan) throw new Error('ATTEMPT_VALIDATION_PLAN_MISSING');
  const previous = readEvidence(base).find((entry): entry is ValidationFact & { sequence: number; version: 1; at: string } =>
    entry.kind === 'validation' && entry.stageId === stageId && entry.attemptIndex === attempt.index && entry.attemptStartedAt === attempt.startedAt);
  if (previous) return previous;
  const brief = briefAt(base), executions: ValidationExecution[] = [];
  const execute = async (cwd: string, target: 'attempt' | 'base', commit?: string): Promise<ProjectValidationBaseline> => {
    const tree = captureProjectTree(cwd, brief);
    const commandTrees: Array<{ treeHash: string | null; treeAfterHash: string | null }> = [];
    const measured = await runProjectValidationBaseline(cwd, {
      ...dependencies, commands: plan.baseline.discovery.commands.map(command => {
        // A declared absolute project path follows the isolated base tree.
        // Shell programs are opaque declarations; never parse their text.
        const relocate = (value: string) => {
          const member = relative(projectDir, value);
          return target === 'base' && isAbsolute(value) && member !== '..' && !member.startsWith('../') && !isAbsolute(member)
            ? join(cwd, member) : value;
        };
        return { ...command, command: relocate(command.command), args: command.args.map(relocate) };
      }),
      skipExecution: false,
      runCommand: async request => {
        const before = captureProjectTree(cwd, brief);
        const result = await (dependencies.runCommand ?? (input => runValidationCommand({ ...input, runDir: base,
          // Base output must not be attributed as an author's project write.
          ...(target === 'attempt' ? { execution: { stageId, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt } } : {}) })))(request);
        commandTrees.push({ treeHash: before.hash, treeAfterHash: captureProjectTree(cwd, brief).hash });
        return result;
      },
    });
    let commandIndex = 0;
    const commands = measured.results.flatMap(result => {
      const command = measured.discovery.commands.find(item => item.role === result.role && item.display === result.display);
      if (!command) return [];
      const outputPath = `stage_evidence/${stageId}/validation-${attempt.index}-${target}-${commandIndex}.log`;
      mkdirSync(dirname(join(base, outputPath)), { recursive: true });
      writeFileSync(join(base, outputPath), result.output);
      return [{ ...result, output: '', outputPath, command: command.command, args: command.args,
        ...commandTrees[commandIndex++] }];
    });
    executions.push({ target, cwd, commit, treeHash: tree.hash, treeAfterHash: captureProjectTree(cwd, brief).hash, commands });
    return measured;
  };
  const current = await execute(projectDir, 'attempt');
  let baseline: ProjectValidationBaseline | undefined;
  let baseError: string | undefined;
  if (current.results.some(result => result.state === 'failed' || result.state === 'launch_error')) {
    const scratch = mkdtempSync(join(tmpdir(), 'flowcrew-base-')), checkout = join(scratch, 'tree');
    let added = false;
    try {
      if (dependencies.abortSignal?.aborted || dependencies.remainingMs && dependencies.remainingMs() <= 0) throw new Error('Attempt deadline/control ended before the base comparison');
      if (!plan.baseCommit) throw new Error('No base commit was captured before authoring');
      const result = spawnSync('git', ['worktree', 'add', '--detach', checkout, plan.baseCommit], {
        cwd: projectDir, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0) throw new Error(`Base worktree exited ${result.status}: ${result.stderr}`);
      added = true;
      // A missing old snapshot cannot be reconstructed from authored bytes.
      if (plan.baseInputs?.error) throw new Error(plan.baseInputs.error);
      if (!plan.baseInputs && parseBriefInputs(brief).references.length) throw new Error('Pre-author materialized input snapshot missing');
      for (const { path, image } of plan.baseInputs?.files ?? []) {
        // Materialize children before applying a directory's read-only mode.
        const restored = restoreProjectPath(checkout, path, image.type === 'directory' ? { ...image, mode: 0o700 } : image);
        if (!restored.restored) throw new Error(restored.failure ?? `Base input restoration failed: ${path}`);
      }
      for (const { path, image } of [...plan.baseInputs?.files ?? []].reverse()) {
        if (image.type === 'directory' && image.mode !== undefined) chmodSync(join(checkout, path), image.mode);
      }
      baseline = await execute(checkout, 'base', plan.baseCommit);
    } catch (error) { baseError = String(error); }
    finally {
      // Retire only this checkout's directories, never a replacement alias.
      for (const { path, image } of plan.baseInputs?.files ?? []) if (image.type === 'directory') {
        try {
          const absolute = join(checkout, path);
          if (lstatSync(absolute).isDirectory() && artifactRootContains(realpathSync(checkout), realpathSync(absolute))) chmodSync(absolute, 0o700);
        } catch { /* absent or changed directories are removed by tree cleanup */ }
      }
      if (added) spawnSync('git', ['worktree', 'remove', '--force', checkout], { cwd: projectDir, timeout: 15_000, stdio: 'ignore' });
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  let delta: ValidationDeltaResult[] = baseline ? evaluateValidationDelta(baseline, current.results)
    : current.results.map(result => ({ role: result.role, display: result.display,
      state: result.state === 'passed' || result.state === 'not_configured' ? 'pass' : 'unresolved',
      reason: result.state === 'passed' ? 'Author attempt passed; no base execution required'
        : result.state === 'not_configured' ? 'Role is not configured' : baseError ?? 'Base result unavailable', newFailureIdentifiers: [] }));
  const bindingValid = executions.every(execution => execution.treeHash !== null && execution.treeHash === execution.treeAfterHash);
  if (!bindingValid) {
    delta = delta.map(entry => ({ ...entry, state: 'unresolved', reason: 'Source tree changed or became unreadable during configured validation' }));
  }
  const failures: ValidationFact['failures'] = current.results.filter(result => result.state === 'failed').flatMap(result => {
    const prior = baseline?.results.find(item => item.role === result.role && item.display === result.display);
    return (result.failureIdentifiers.length ? result.failureIdentifiers : [null]).map(identifier => {
      let classification: 'pre-existing' | 'introduced' | 'unknown' = 'unknown';
      if (bindingValid && prior?.state === 'passed') classification = 'introduced';
      else if (bindingValid && identifier !== null && prior?.failureIdentity === 'known' && result.failureIdentity === 'known') {
        // Positive membership is meaningful even in a partial population.
        // Absence proves introduction only when the base population is complete.
        if (prior.failureIdentifiers.includes(identifier)) classification = 'pre-existing';
        else if (prior.failureEvidence !== 'partial') classification = 'introduced';
      }
      return { role: result.role, display: result.display, identifier, classification };
    });
  });
  const fact: ValidationFact = { kind: 'validation', validationVersion: VALIDATION_FACT_VERSION, stageId, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt,
    ...(plan.baseInputs ? { baseInputSnapshot: { manifestSha256: createHash('sha256').update(JSON.stringify(plan.baseInputs)).digest('hex'),
      files: plan.baseInputs.files.length, bytes: plan.baseInputs.files.reduce((total, file) => total + (file.image.byteLength ?? 0), 0),
      durationMs: plan.baseInputs.durationMs, ...(plan.baseInputs.error ? { error: plan.baseInputs.error } : {}) } } : {}),
    treeHash: executions[0].treeAfterHash, executions, delta, failures, pass: delta.every(entry => entry.state === 'pass') };
  appendEvidence(base, fact);
  return fact;
}

export function readValidationDelta(path: string): GateValidationDeltaArtifact | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as GateValidationDeltaArtifact;
    if (value.version !== 2 || typeof value.pass !== 'boolean' || !Array.isArray(value.delta)) return undefined;
    if (value.ledgerSequence !== undefined) {
      const fact = readEvidence(dirname(path)).find(entry => entry.sequence === value.ledgerSequence);
      if (fact?.kind !== 'validation' || fact.validationVersion !== VALIDATION_FACT_VERSION) return undefined;
      value.current = fact.executions.find(execution => execution.target === 'attempt')?.commands ?? [];
    }
    return Array.isArray(value.current) ? value : undefined;
  } catch { return undefined; }
}
/** Bind a reference, not a second copy of the facts. This function executes no suite. */
export async function recordGateValidationDelta(projectDir: string, runId: string, stageId: string,
  _dependencies: ProjectValidationDependencies = {}): Promise<GateValidationDeltaArtifact | undefined> {
  const base = runDir(projectDir, runId), plan = readRunValidationBaseline(base);
  if (!plan || !plan.baseline.discovery.commands.length) return undefined;
  const execution = closedGateValidationExecution(projectDir, runId, stageId) ?? gateExecution(projectDir, runId, stageId, ['running']);
  if (!execution) return undefined;
  const tree = captureProjectTree(projectDir, briefAt(base));
  const fact = readEvidence(base).filter(entry => entry.kind === 'validation').at(-1);
  const valid = fact?.kind === 'validation' && fact.validationVersion === VALIDATION_FACT_VERSION && tree.hash !== null && fact.treeHash === tree.hash
    && readStageStatus(projectDir, runId, fact.stageId).attempts?.at(-1)?.index === fact.attemptIndex;
  const delta: ValidationDeltaResult[] = valid ? fact.delta : [{ role: 'test', state: 'unresolved', reason: 'No settled author validation covers the current source tree', newFailureIdentifiers: [] }];
  const artifact: GateValidationDeltaArtifact = { version: 2, stageId, checkedAt: new Date().toISOString(),
    pass: valid ? fact.pass : false, baselineSha256: createHash('sha256').update(readFileSync(join(base, RUN_VALIDATION_BASELINE_FILE))).digest('hex'),
    current: valid ? fact.executions[0].commands : [], delta, ...execution, treeHash: tree.hash,
    ...(valid ? { ledgerSequence: fact.sequence } : {}), validationAttemptIndex: 1 };
  artifact.immutablePath = `validation_delta_${stageId}_attempt_${execution.attemptIndex}_${createHash('sha256').update(JSON.stringify(artifact)).digest('hex').slice(0, 16)}.json`;
  const { current: _current, ...reference } = artifact;
  const stored = valid ? reference : artifact;
  publishJsonCreateOnly(join(base, artifact.immutablePath), stored);
  writeFileSync(join(base, `validation_delta_${stageId}.json`), `${JSON.stringify(stored)}\n`);
  return artifact;
}
export function bindReviewedGateValidation(projectDir: string, runId: string, stageId: string, _waveStageIds?: string[]): boolean {
  const base = runDir(projectDir, runId), prior = readValidationDelta(join(base, `validation_delta_${stageId}.json`));
  const execution = closedGateValidationExecution(projectDir, runId, stageId);
  if (!prior || !execution || prior.baselineSha256 !== createHash('sha256').update(readFileSync(join(base, RUN_VALIDATION_BASELINE_FILE))).digest('hex') || !prior.treeHash || prior.treeHash !== captureProjectTree(projectDir, briefAt(base)).hash
    || prior.attemptIndex !== execution.attemptIndex || prior.attemptStartedAt !== execution.attemptStartedAt) return false;
  const { current: _current, ...bound } = { ...prior, ...execution };
  bound.immutablePath = `validation_delta_${stageId}_attempt_${execution.attemptIndex}_${createHash('sha256').update(JSON.stringify(bound)).digest('hex').slice(0, 16)}.json`;
  const stored = bound.ledgerSequence === undefined ? { ...bound, current: prior.current } : bound;
  publishJsonCreateOnly(join(base, bound.immutablePath), stored);
  writeFileSync(join(base, `validation_delta_${stageId}.json`), `${JSON.stringify(stored)}\n`);
  return true;
}
/** Shared mechanical interpretation for settled gate and terminal decisions.
 * Mutable aliases cannot replace the append-only author's receipt. */
export function currentAuthorValidationRefusal(projectDir: string, runId: string): GateVerdict | undefined {
  const base = runDir(projectDir, runId);
  const fact = readEvidence(base).filter(entry => entry.kind === 'validation').at(-1);
  const tree = captureProjectTree(projectDir, briefAt(base));
  const owner = fact?.kind === 'validation' ? readStageStatus(projectDir, runId, fact.stageId).attempts?.at(-1) : undefined;
  const refuse = (reason: string): GateVerdict => ({ pass: false, reason, refusal: { kind: 'validation_unresolved' } });
  if (fact?.kind !== 'validation' || fact.validationVersion !== VALIDATION_FACT_VERSION || tree.hash === null || fact.treeHash !== tree.hash
    || owner?.index !== fact.attemptIndex || owner.startedAt !== fact.attemptStartedAt || owner.status !== STAGE_STATUS.COMPLETE) {
    return refuse('No settled author validation covers the changed tree; no suite is rerun by a decision');
  }
  if (fact.pass) return undefined;
  const regressions = fact.delta.filter(entry => entry.state === 'regression');
  if (regressions.length) return { pass: false,
    reason: `Introduced validation failures: ${regressions.map(entry => `${entry.display ?? entry.role}: ${entry.newFailureIdentifiers.join(', ') || entry.reason}`).join('; ')}`,
    refusal: { kind: 'validation_regression' }, repairability: { version: 1, disposition: 'repairable', evidence: `${join(base, 'evidence-ledger.jsonl')}#${fact.sequence}` } };
  return refuse(`Validation identity/evidence is unknown: ${fact.delta.filter(entry => entry.state !== 'pass').map(entry => entry.reason).join('; ')}; no code repair is inferred`);
}

export function gateValidationRefusal(projectDir: string, runId: string, stageId: string): GateVerdict | undefined {
  const base = runDir(projectDir, runId);
  const refuse = (reason: string): GateVerdict => ({ pass: false, reason, refusal: { kind: 'validation_unresolved' } });
  if (!existsSync(join(base, RUN_VALIDATION_BASELINE_FILE))) return undefined;
  const plan = readRunValidationBaseline(base);
  if (!plan) return refuse('Validation declaration is invalid; no configured suite or result can be inferred');
  // No configured command means no mechanical validation obligation. Ordinary
  // verdict, scope and product-review contracts still apply independently.
  if (!plan.baseline.discovery.commands.length) return undefined;
  const delta = readValidationDelta(join(base, `validation_delta_${stageId}.json`));
  if (!delta || !validationDeltaMatchesExecution(delta, closedGateValidationExecution(projectDir, runId, stageId))
    || delta.baselineSha256 !== createHash('sha256').update(readFileSync(join(base, RUN_VALIDATION_BASELINE_FILE))).digest('hex')) {
    return refuse(`Validation receipt for ${stageId} is missing, stale or does not cover this settled execution/tree; no suite is rerun by a decision`);
  }
  const refusal = currentAuthorValidationRefusal(projectDir, runId);
  if (refusal) return refusal;
  return settledGateValidationExecution(projectDir, runId, stageId) ? undefined : refuse('Configured validation passed but gate execution failed');
}
export async function settleGateValidationEvidence(projectDir: string, runId: string, stageId: string,
  _dependencies: ProjectValidationDependencies = {}): Promise<{ kind: 'unchanged' | 'replayed' } | { kind: 'refused'; reason: string }> {
  const refusal = gateValidationRefusal(projectDir, runId, stageId);
  return refusal?.refusal?.kind === 'validation_unresolved' ? { kind: 'refused', reason: refusal.reason ?? 'Validation unresolved' } : { kind: 'unchanged' };
}
