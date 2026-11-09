import { runRecordPath } from '../../run-layout.js';
import type { ReproductionRecord } from '../../scoped-audit-repair.js';
import { loadEngineDefaults } from '../../config.js';
import { performance } from 'node:perf_hooks';
import { parseBriefFrontmatterDocument } from '../../brief-frontmatter.js';
// Configured validation belongs to authors. Gates only bind and consume facts.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from '../../engine-fs.js';
import { publishJsonCreateOnly } from '../../canonical-json.js';
import { readShipSetupReadyValidationBaseline } from '../../ship-setup-record.js';
import { readStageStatus, runDir, STAGE_STATUS, type GateVerdict } from '../../store.js';
import {
  reconcileProjectValidation, parseValidationCommands, ValidationSelectionSchema, ValidationReviewSchema, projectValidationResult, evaluateValidationDelta, runProjectValidationBaseline, runValidationCommand,
  type ProjectValidationBaseline, type ProjectValidationDependencies, type ValidationDeltaResult, type ValidationCommand,
} from '../../project-validation.js';
import { appendEvidence, captureProjectTree, projectCommit, projectValidationDelta, projectValidationFact, readEvidence, safeEvidencePath, validationForTree, VALIDATION_FACT_VERSION, type ValidationExecution, type ValidationFact } from '../../evidence-ledger.js';
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
  source: 'ship-setup-ready-record' | 'project-declarations' | 'model-selection';
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
    const store = new RollbackContentStore(runRecordPath(base, 'stage_evidence', 'base-inputs'));
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
    source: admitted ? 'ship-setup-ready-record' : 'project-declarations', baseCommit,
    baseInputs: captureBaseInputs(projectDir, exactBrief, base, baseCommit),
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

function completedFailure(result: ProjectValidationBaseline['results'][number]): boolean {
  return Number.isInteger(result.exitCode) && result.exitCode! > 0 && !result.unfinished && result.sourceBound !== false;
}

/** One bounded batch per tree. Prior facts remain append-only, including unknown
 * outcomes, plus a single serial regression confirmation for failed tests. */
export async function recordAttemptValidation(projectDir: string, runId: string, stageId: string,
  dependencies: ProjectValidationDependencies = {},
  requestedBase?: Array<{ role: string; display: string }>): Promise<ValidationFact> {
  const base = runDir(projectDir, runId), plan = readRunValidationBaseline(base);
  const attempt = readStageStatus(projectDir, runId, stageId).attempts?.at(-1);
  if (!attempt || !plan) throw new Error('ATTEMPT_VALIDATION_PLAN_MISSING');
  const treeHash = captureProjectTree(projectDir, briefAt(base)).hash;
  const ledger = readEvidence(base);
  const previous = validationForTree(ledger, treeHash) ?? ledger.find((entry): entry is typeof entry & ValidationFact => entry.kind === 'validation'
    && entry.stageId === stageId && entry.attemptIndex === attempt.index && entry.attemptStartedAt === attempt.startedAt && treeHash === null);
  if (previous && (!requestedBase || previous.baseRequest)) return previous;
  if (requestedBase && !previous) throw new Error('BASE_REQUIRES_CURRENT_ATTEMPT_FACTS');
  let started = performance.now();
  let budgetMs = Math.max(0, Math.min(loadEngineDefaults().validation_timeout_ms, dependencies.remainingMs?.() ?? Infinity));
  const remainingMs = () => Math.max(0, Math.min(budgetMs - (performance.now() - started), dependencies.remainingMs?.() ?? Infinity));
  let abortSignal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.ceil(budgetMs))), ...(dependencies.abortSignal ? [dependencies.abortSignal] : [])]);
  const brief = briefAt(base), executions: ValidationExecution[] = [];
  const regressions: NonNullable<ValidationFact['regressions']> = [...previous?.regressions ?? []];
  const resetHangBound = (timeoutMs: number) => {
    started = performance.now(); budgetMs = Math.min(timeoutMs, dependencies.remainingMs?.() ?? Infinity);
    abortSignal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.ceil(budgetMs))), ...(dependencies.abortSignal ? [dependencies.abortSignal] : [])]);
  };
  const execute = async (cwd: string, target: 'attempt' | 'base', commands: readonly ValidationCommand[], rerun?: true, commit?: string): Promise<ProjectValidationBaseline> => {
    const tree = target === 'attempt' && !rerun ? { hash: treeHash } : captureProjectTree(cwd, brief);
    const measured = await runProjectValidationBaseline(cwd, {
      ...dependencies, remainingMs, abortSignal, ...(rerun ? { timeoutMs: budgetMs } : {}), commands: commands.map(command => {
        // A declared absolute project path follows the isolated base tree.
        // Shell programs are opaque declarations; never parse their text.
        const relocate = (value: string) => {
          const member = relative(projectDir, value);
          return target === 'base' && isAbsolute(value) && member !== '..' && !member.startsWith('../') && !isAbsolute(member)
            ? join(cwd, member) : value;
        };
        return { ...command, command: relocate(command.command), args: command.args.map(relocate),
          ...(command.env ? { env: Object.fromEntries(Object.entries(command.env).map(([name, value]) => [name, value === undefined ? value : relocate(value)])) } : {}) };
      }),
      skipExecution: false,
      runCommand: dependencies.runCommand ?? (request => runValidationCommand({ ...request, runDir: base,
        // Base output must not be attributed as an author's project write.
        ...(target === 'attempt' ? { execution: { stageId, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt } } : {}) })),
    });
    let commandIndex = 0;
    const recordedCommands = measured.results.flatMap(result => {
      const command = measured.discovery.commands.find(item => item.role === result.role && item.display === result.display);
      if (!command) return [];
      const outputPath = relative(base, runRecordPath(base, `stage_evidence/${stageId}/validation-${attempt.index}-${target}-${executions.length}-${commandIndex}.log`));
      mkdirSync(dirname(runRecordPath(base, outputPath)), { recursive: true });
      commandIndex++;
      writeFileSync(runRecordPath(base, outputPath), result.output);
      return [{ ...result, outputPath, command: command.command, args: command.args, ...(command.env ? { env: command.env } : {}) }];
    });
    executions.push({ target, ...(rerun ? { rerun } : {}), cwd, commit, treeHash: tree.hash, treeAfterHash: captureProjectTree(cwd, brief).hash, commands: recordedCommands });
    return measured;
  };
  let baseError: string | undefined;
  const executeBase = async (commands: readonly ValidationCommand[], rerun?: true): Promise<ProjectValidationBaseline | undefined> => {
    const scratch = mkdtempSync(join(tmpdir(), 'flowcrew-base-')), checkout = join(scratch, 'tree');
    let added = false;
    try {
      if (abortSignal.aborted || remainingMs() <= 0) throw new Error('Gate budget ended before requested base evidence');
      if (!plan.baseCommit) throw new Error('No base commit was captured before authoring');
      const result = spawnSync('git', ['worktree', 'add', '--detach', checkout, plan.baseCommit], {
        cwd: projectDir, encoding: 'utf8', timeout: Math.max(1, Math.ceil(Math.min(60_000, remainingMs()))), maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0) throw new Error(`Base worktree exited ${result.status}: ${result.stderr}`);
      added = true;
      if (plan.baseInputs?.error) throw new Error(plan.baseInputs.error);
      if (!plan.baseInputs && parseBriefInputs(brief).references.length) throw new Error('Pre-author materialized input snapshot missing');
      for (const { path, image } of plan.baseInputs?.files ?? []) {
        const restored = restoreProjectPath(checkout, path, image.type === 'directory' ? { ...image, mode: 0o700 } : image);
        if (!restored.restored) throw new Error(restored.failure ?? `Base input restoration failed: ${path}`);
      }
      for (const { path, image } of [...plan.baseInputs?.files ?? []].reverse()) {
        if (image.type === 'directory' && image.mode !== undefined) chmodSync(join(checkout, path), image.mode);
      }
      return await execute(checkout, 'base', commands, rerun, plan.baseCommit);
    } catch (error) {
      baseError = String(error);
      executions.push({ target: 'base', ...(rerun ? { rerun } : {}), cwd: checkout, commit: plan.baseCommit, treeHash: null, treeAfterHash: null,
        commands: commands.map(command => ({ ...command, state: 'unverified', exitCode: null, durationMs: 0, output: '', error: baseError,
          failureIdentifiers: [], failureIdentity: 'unknown' })) });
    }
    finally {
      for (const { path, image } of plan.baseInputs?.files ?? []) if (image.type === 'directory') {
        try {
          const absolute = join(checkout, path);
          if (lstatSync(absolute).isDirectory() && artifactRootContains(realpathSync(checkout), realpathSync(absolute))) chmodSync(absolute, 0o700);
        } catch { /* absent or changed directories are removed by tree cleanup */ }
      }
      if (added) spawnSync('git', ['worktree', 'remove', '--force', checkout], { cwd: projectDir, timeout: 15_000, stdio: 'ignore' });
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  let current: Pick<ProjectValidationBaseline, 'results'>;
  if (requestedBase) {
    executions.push(...previous!.executions);
    current = { results: executions.find(execution => execution.target === 'attempt')!.commands };
    await executeBase(plan.baseline.discovery.commands.filter(command => requestedBase.some(request => request.role === command.role && request.display === command.display)));
  } else {
    current = await execute(projectDir, 'attempt', plan.baseline.discovery.commands);
    // Finish the judged batch first. The scheduler serializes owners of this
    // tree; each confirmation below runs alone, with the same argv on base.
    for (const result of current.results.filter(result => result.role === 'test' && completedFailure(result))) {
      const selected = plan.baseline.discovery.commands.find(command => command.role === result.role && command.display === result.display)!;
      const template = selected.report ? selected.rerun : undefined;
      if (template && !result.failureFiles?.length) continue; // No declared identities to expand.
      const command: ValidationCommand = template ? { ...selected, command: template.command,
        args: template.args.flatMap(arg => arg === '{files}' ? result.failureFiles! : [arg]) } : selected;
      const hangBound = selected.rerun?.timeoutMs ?? Math.max(300_000, loadEngineDefaults().validation_timeout_ms);
      resetHangBound(hangBound);
      const candidate = (await execute(projectDir, 'attempt', [command], true)).results[0];
      if (!completedFailure(candidate)) continue;
      resetHangBound(hangBound);
      const baseline = (await executeBase([command], true))?.results[0];
      const [candidateExecution, baseExecution] = executions.slice(-2);
      if (!baseline || baseline.exitCode !== 0 || baseline.unfinished || !treeHash
        || candidateExecution.treeHash !== treeHash || candidateExecution.treeAfterHash !== treeHash
        || !baseExecution.treeHash || baseExecution.treeAfterHash !== baseExecution.treeHash) continue;
      // Reuse the existing reproduction/repair-closure channel. Explicit env
      // is part of the reproduction, not merely metadata on the first run.
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const reproduction = [...Object.entries(command.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([name, value]) => `${name}=${quote(value)}`), ...[command.command, ...command.args].map(quote)].join(' ');
      const record = appendEvidence(base, { kind: 'command', owner: 'code', stageId, attemptIndex: attempt.index,
        commandId: `validation-regression-${regressions.length}`, command: reproduction, context: { cwd: projectDir, shell: '/bin/sh' },
        exitCode: candidate.exitCode!, timeoutMs: hangBound, outputDigest: createHash('sha256').update(candidate.output).digest('hex'), treeHash, treeAfterHash: treeHash });
      regressions.push({ id: `validation_regression_${record.sequence}`, paths: result.failureFiles?.length ? result.failureFiles : ['.'],
        reason: `Confirmed regression: candidate alone exited ${candidate.exitCode}; base alone exited 0`, criterion_ids: [],
        invalidates_plan: false, repair_role: 'coder', reproduction: record.sequence, record: record as ReproductionRecord });
    }
  }
  const delta = evaluateValidationDelta(undefined, current.results, undefined, plan.baseline.discovery.commands);
  const fact: ValidationFact = { kind: 'validation', validationVersion: VALIDATION_FACT_VERSION, stageId, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt,
    ...(plan.baseInputs ? { baseInputSnapshot: { manifestSha256: createHash('sha256').update(JSON.stringify(plan.baseInputs)).digest('hex'),
      files: plan.baseInputs.files.length, bytes: plan.baseInputs.files.reduce((total, file) => total + (file.image.byteLength ?? 0), 0),
      durationMs: plan.baseInputs.durationMs, ...(plan.baseInputs.error ? { error: plan.baseInputs.error } : {}) } } : {}),
    treeHash, executions, delta, ...(regressions.length ? { regressions } : {}),
    ...(requestedBase ? { baseRequest: { commands: requestedBase, ...(baseError ? { error: baseError } : {}) } } : {}), failures: [], pass: delta.length > 0 && delta.every(entry => entry.state === 'verified') };
  appendEvidence(base, fact);
  return fact;
}

/** Only a valid independent-gate request can obtain base facts. One request
 * batch per judged tree, including unavailable evidence; never retry on red. */
export async function recordRequestedBaseValidation(projectDir: string, runId: string, value: unknown,
  dependencies: ProjectValidationDependencies = {}): Promise<ValidationFact | undefined> {
  const review = ValidationReviewSchema.safeParse(value);
  if (!review.success || !review.data.request_base.length) return undefined;
  const base = runDir(projectDir, runId), fact = validationForTree(readEvidence(base), captureProjectTree(projectDir, briefAt(base)).hash);
  if (!fact) return undefined;
  const current = fact.executions.find(execution => execution.target === 'attempt')?.commands ?? [];
  const requested = review.data.request_base.filter(request => current.some(result => result.role === request.role && result.display === request.display
    && projectValidationResult(result).measurement === 'unverified'));
  if (!requested.length) return undefined;
  return recordAttemptValidation(projectDir, runId, fact.stageId, dependencies, requested);
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
  const tree = captureProjectTree(projectDir, briefAt(base));
  const fact = validationForTree(readEvidence(base), tree.hash);
  const valid = fact?.kind === 'validation' && fact.validationVersion === VALIDATION_FACT_VERSION && tree.hash !== null && fact.treeHash === tree.hash
    && readStageStatus(projectDir, runId, fact.stageId).attempts?.some(attempt => attempt.index === fact.attemptIndex && attempt.startedAt === fact.attemptStartedAt && attempt.status === STAGE_STATUS.COMPLETE);
  const delta: ValidationDeltaResult[] = valid ? fact.delta : [{ role: 'test', state: 'unverified', reason: 'No settled author validation covers the current source tree', newFailureIdentifiers: [] }];
  const artifact: GateValidationDeltaArtifact = { version: 2, stageId, checkedAt: new Date().toISOString(),
    pass: valid ? fact.pass : false, baselineSha256: createHash('sha256').update(readFileSync(runRecordPath(base, RUN_VALIDATION_BASELINE_FILE))).digest('hex'),
    current: valid ? fact.executions[0].commands : [], delta, ...execution, treeHash: tree.hash,
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
  if (!prior || !execution || prior.baselineSha256 !== createHash('sha256').update(readFileSync(runRecordPath(base, RUN_VALIDATION_BASELINE_FILE))).digest('hex') || !prior.treeHash || prior.treeHash !== captureProjectTree(projectDir, briefAt(base)).hash
    || prior.attemptIndex !== execution.attemptIndex || prior.attemptStartedAt !== execution.attemptStartedAt) return false;
  const { current: _current, ...bound } = { ...prior, ...execution };
  bound.immutablePath = `validation_delta_${stageId}_attempt_${execution.attemptIndex}_${createHash('sha256').update(JSON.stringify(bound)).digest('hex').slice(0, 16)}.json`;
  const stored = bound.ledgerSequence === undefined ? { ...bound, current: prior.current } : bound;
  publishJsonCreateOnly(runRecordPath(base, bound.immutablePath), stored);
  writeFileSync(runRecordPath(base, `validation_delta_${stageId}.json`), `${JSON.stringify(stored)}\n`);
  return true;
}
/** Missing or stale facts expose each selected command as unrun. They never
 * prevent independent review or independently decide acceptance. */
export function currentValidationResults(projectDir: string, runId: string): ProjectValidationBaseline['results'] {
  const base = runDir(projectDir, runId), plan = readRunValidationBaseline(base);
  const fact = validationForTree(readEvidence(base), captureProjectTree(projectDir, briefAt(base)).hash);
  const commands = fact ? projectValidationFact(fact).executions.find(execution => execution.target === 'attempt')?.commands ?? [] : [];
  return (plan?.baseline.discovery.commands ?? commands).map(command => {
    const result = commands.find(result => result.role === command.role && result.display === command.display);
    return result ? { ...result, storedState: result.storedState ?? result.state, ...projectValidationResult(result) } : {
      role: command.role, display: command.display, command: command.command, args: command.args, env: command.env, state: 'unverified', exitCode: null,
      durationMs: 0, output: '', failureIdentifiers: [], failureIdentity: 'unknown', reason: 'Selected command did not run on the reviewed tree',
    };
  });
}

/** Only current-tree code-owned confirmations can veto a gate. */
export function currentValidationRegressions(projectDir: string, runId: string): NonNullable<ValidationFact['regressions']> {
  const base = runDir(projectDir, runId);
  const fact = validationForTree(readEvidence(base), captureProjectTree(projectDir, briefAt(base)).hash);
  return fact?.validationVersion === VALIDATION_FACT_VERSION ? fact.regressions ?? [] : [];
}

/** Legacy API only; gate settlement owns the one confirmed-regression veto. */
export function currentAuthorValidationRefusal(_projectDir: string, _runId: string): GateVerdict | undefined { return undefined; }
export function gateValidationRefusal(_projectDir: string, _runId: string, _stageId: string): GateVerdict | undefined { return undefined; }
export async function settleGateValidationEvidence(_projectDir: string, _runId: string, _stageId: string,
  _dependencies: ProjectValidationDependencies = {}): Promise<{ kind: 'unchanged' }> { return { kind: 'unchanged' }; }
