import { z } from 'zod';
import { rethrowGitNotAnswered } from './git-facts.js';
import { parseBriefDeclarations, argument, commandDeclaration, commandsDeclaration, limitFields, validationDeclaration } from './brief-declarations.js';
import type { Schema } from './reality-gate/checks/json-schema-match.js';
import { stageLiveLogPath } from './stage-live-log.js';
import { errorMessage } from './source_services/cli-inputs.js';
import { appendEngineFile, EngineStateError, withEngineIntegrity } from './engine-integrity.js';
import { CommandActivityTracker } from './command-activity.js';
import { spawnOwnedCommand } from './adapters/base.js';
import { mkdirSync, mkdtempSync, rmSync } from './engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir, cpus, loadavg } from 'node:os';
import { validationEnvironment } from './validation-environment.js';
import { join, resolve } from 'node:path';
import { decodeRunnerReport, identityFacts, type IdentityFacts } from './validation-identity.js';
import { prospectivePhysicalPath, safeEvidencePath } from './engine-owned-carriers.js';
import { statSync } from 'node:fs';

export type ValidationRole = 'build' | 'test' | 'lint';
export type FailureEvidence = 'complete' | 'partial';

export interface ValidationFileSystem {
  exists(path: string): boolean;
  readText(path: string): string;
}

export interface ValidationCommandProvenance {
  source: 'project' | 'brief';
  evidencePath: string;
  corroboratedBy?: string[];
}

export interface ValidationReport {
  format: 'vitest-json';
  /** Omit for a JSON-only stdout reporter. Paths are project-relative, freshly written report files. */
  path?: string;
}

export interface ValidationRerun {
  command: string;
  /** The exact argv token {files} expands to declared structured failure files. */
  args: string[];
  timeoutMs?: number;
}

export interface ValidationCommand {
  rerun?: ValidationRerun;
  /** Explicit non-secret project inputs, carried unchanged into execution and receipts. */
  env?: NodeJS.ProcessEnv;
  report?: ValidationReport;
  role: ValidationRole;
  command: string;
  args: string[];
  display: string;
  evidencePath?: string;
  provenance?: ValidationCommandProvenance;
}

export interface BriefValidationCommand {
  rerun?: ValidationRerun;
  env?: NodeJS.ProcessEnv;
  report?: ValidationReport;
  role: ValidationRole;
  command: string;
  args: string[];
  evidencePath: string;
}

/** Time one execution of the whole batch may take (its commands run in order within it) and the
 * number of executions of an unfinished batch. An absent time limit waits for completion. */
export interface ValidationLimits { timeoutMs?: number; attempts?: number }

export interface ValidationParseResult {
  commands: BriefValidationCommand[];
  limits?: ValidationLimits;
  error?: string;
}

const ROLES = ['build', 'test', 'lint'] as const;
const projectCommandDeclaration = commandDeclaration.extend({ rerun: z.object({
  command: argument.refine(value => value.trim().length > 0), args: z.array(argument),
  timeoutMs: z.number().int().positive().optional(),
}).strict().optional() });
const projectValidationDeclaration = commandsDeclaration.extend({ commands: z.object({
  build: projectCommandDeclaration.optional(), test: projectCommandDeclaration.optional(), lint: projectCommandDeclaration.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'must declare at least one role'), ...limitFields });

/** Fixed model output uses the same command objects as declarations; an empty
 * selection explicitly means no measurement, not a green suite. */
export const ValidationSelectionSchema = z.object({ commands: z.object({
  build: commandDeclaration.optional(), test: commandDeclaration.optional(), lint: commandDeclaration.optional(),
}).strict(), reason: z.string().min(1).max(4096) }).strict();
export const VALIDATION_SELECTION_JSON_SCHEMA = z.toJSONSchema(ValidationSelectionSchema) as unknown as Schema;

const declaredLimits = ({ timeoutMs, attempts }: ValidationLimits): { limits?: ValidationLimits } =>
  timeoutMs === undefined && attempts === undefined ? {}
    : { limits: { ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(attempts !== undefined ? { attempts } : {}) } };

export function parseValidationCommands(validation: unknown, evidencePathRoot: string, project = false): ValidationParseResult {
  if (validation === undefined) return { commands: [] };
  const parsed = (project ? projectValidationDeclaration : validationDeclaration).safeParse(validation);
  if (!parsed.success) return { commands: [], error: `Invalid validation declaration at ${evidencePathRoot}#validation: `
    + parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.code === 'unrecognized_keys'
      ? `unknown ${issue.path.length === 1 && issue.path[0] === 'commands' ? 'role' : 'field'} ${issue.keys.join(', ')}` : issue.message}`).join('; ') };
  return { commands: ROLES.flatMap(role => {
    const command = parsed.data.commands?.[role];
    return command ? [{ role, ...command, evidencePath: `${evidencePathRoot}#validation.commands.${role}` }] : [];
  }), ...declaredLimits(parsed.data) };
}

/** The same declaration parser serves setup and low-level author entry points. */
export function parseBriefValidationCommands(brief: string, briefPath: string): ValidationParseResult {
  try { return parseValidationCommands(parseBriefDeclarations(brief).validation, briefPath); }
  catch (error) { return { commands: [], error: error instanceof Error ? error.message : String(error) }; }
}

export interface ValidationDiscovery {
  state: 'configured' | 'partial' | 'unknown';
  configPath: string;
  configPaths?: string[];
  commands: ValidationCommand[];
  missingRoles: ValidationRole[];
  /** Limits the project's declaration file states; a brief's replace them field by field. */
  limits?: ValidationLimits;
  reason?: string;
}

export interface ValidationRunRequest extends ValidationCommand {
  /** Declared resource allowance; omitted requests wait for completion or cancellation. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  cwd: string;
  priority?: number;
  /** Parent-supplied run anchor; pre-admission validation uses a private one. */
  runDir?: string;
  /** Attempt whose pre-execution prerequisites this configured command serves. */
  execution?: { stageId: string; attemptIndex: number; attemptStartedAt: string };
  /** Ordinary project inputs and explicit home/config reads. Reserved control,
   * credential and executable-injection settings are suppressed with a diagnostic. */
  env?: NodeJS.ProcessEnv;
}

export interface ValidationLoad {
  start: { loadAverage1m: number; cpuCount: number } | null;
  end: { loadAverage1m: number; cpuCount: number } | null;
}
/** Coverage requires a completed raw exit bound to the reviewed source, never
 * a host-load classification. Legacy labels remain readable as provenance. */
export type ValidationMeasurement = 'verified' | 'unverified';
export function projectValidationResult(result: {
  load?: unknown; exitCode?: number | null; error?: unknown;
  unfinished?: boolean; dependencyPreparationFailed?: boolean;
  sourceBound?: boolean;
  state?: string; storedState?: string;
}): { state: ValidationCommandResult['state']; measurement: ValidationMeasurement } {
  const completed = Number.isInteger(result.exitCode) && !result.unfinished && result.sourceBound !== false
;
  const state = !completed ? 'unverified' : result.exitCode === 0 ? 'passed' : 'failed';
  return { state, measurement: state === 'passed' ? 'verified' : 'unverified' };
}
export function validationMeasurement(result: Parameters<typeof projectValidationResult>[0]): ValidationMeasurement {
  return projectValidationResult(result).measurement;
}

/** Sample only: load never delays, suppresses or reclassifies a command. */
export async function withValidationLoad(request: ValidationRunRequest, execute: ValidationCommandRunner,
  dependencies: { sample?: () => ValidationLoad['start']; now?: () => number; wait?: (ms: number) => Promise<void> } = {}): Promise<ValidationRunResponse> {
  const now = dependencies.now ?? (() => performance.now());
  const sample = dependencies.sample ?? (() => ({ loadAverage1m: loadavg()[0], cpuCount: cpus().length }));
  const readSample = () => { try { return sample(); } catch { return null; } };
  const begin = now(), start = readSample();
  let response: ValidationRunResponse;
  try { response = await execute(request); }
  catch (error) {
    rethrowGitNotAnswered(error);
    if (error instanceof EngineStateError) throw error;
    response = { exitCode: null, error: errorMessage(error) };
  }
  return { ...response, durationMs: Math.max(0, now() - begin), load: { start, end: readSample() } };
}

export interface ValidationRunResponse {
  writeGrantFailure?: import('./write-grant.js').WriteGrantFailure;
  writeGrantApplied?: { abi: number; linkedFileCount: 0 };
  load?: ValidationLoad;
  measurement?: ValidationMeasurement;
  report?: string;
  reportError?: string;
  unfinished?: boolean;
  dependencyPreparationFailed?: boolean;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  /** Child stream bytes only; engine diagnostics may also appear in stderr. */
  outputBytes?: { stdout: number; stderr: number };
  error?: string;
  durationMs?: number;
}

export type ValidationCommandRunner = (
  request: ValidationRunRequest,
) => Promise<ValidationRunResponse> | ValidationRunResponse;

export interface ValidationCommandResult extends Pick<ValidationRunResponse, 'report' | 'reportError'> {
  /** False when execution cannot cover the source tree; raw exits are retained. */
  sourceBound?: boolean;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  storedState?: string;
  error?: string;
  unfinished?: boolean;
  dependencyPreparationFailed?: boolean;
  load?: ValidationLoad;
  measurement?: ValidationMeasurement;
  outputBytes?: { stdout: number; stderr: number };
  identityOwner?: IdentityFacts['owner'];
  failures?: import('./validation-identity.js').FailureReading['failures'];
  testsRun?: number | null;
  totals?: IdentityFacts['totals'];
  role: ValidationRole;
  display?: string;
  state: 'passed' | 'failed' | 'unverified';
  exitCode?: number | null;
  durationMs: number;
  output: string;
  /** File identities from the declared reporter, including collection failures. */
  failureFiles?: string[];
  failureCount?: number;
  failureIdentifiers: string[];
  failureIdentity: 'known' | 'unknown' | 'none';
  failureEvidence?: FailureEvidence;
  reason?: string;
}

/** The one rule, as advice: a baseline that already exits nonzero is admitted, never refused. */
export const VALIDATION_ADVICE = '  Advice: the run completes only when every declared validation command exits 0 on the final tree; a command that already exits nonzero at base is admitted, so declare commands that exit 0 at base for failures unrelated to the task.\n';

export interface ProjectValidationBaseline {
  version: 1;
  execution?: 'executed' | 'skipped';
  projectDir: string;
  discovery: ValidationDiscovery;
  results: ValidationCommandResult[];
}

export interface ProjectValidationDependencies {
  priority?: number;
  remainingMs?: () => number;
  abortSignal?: AbortSignal;
  fs?: ValidationFileSystem;
  runCommand?: ValidationCommandRunner;
  declaredCommands?: readonly BriefValidationCommand[];
  /** Exact commands copied from an admitted setup baseline. */
  commands?: readonly ValidationCommand[];
  now?: () => number;
  maxOutputBytes?: number;
  skipExecution?: boolean;
  skipReason?: string;
  /** A serial confirmation uses its hang bound rather than the batch allowance. */
  timeoutMs?: number;
}

export interface ValidationDeltaResult {
  role: ValidationRole;
  display?: string;
  state: 'verified' | 'unverified';
  reason: string;
  newFailureIdentifiers: string[];
}

const DEFAULT_MAX_OUTPUT_BYTES = 24 * 1024;
const nodeValidationFs: ValidationFileSystem = {
  exists: existsSync,
  readText: (path) => readFileSync(path, 'utf-8'),
};

/** Commands come only from the project's explicit, closed declaration. Repository
 * interpretation belongs to a model; this synchronous reader never guesses. */
export function discoverProjectValidation(projectDir: string, fs: ValidationFileSystem = nodeValidationFs): ValidationDiscovery {
  const configPath = join(resolve(projectDir), 'config/validation.json');
  if (!fs.exists(configPath)) return { state: 'unknown', configPath, commands: [], missingRoles: [...ROLES],
    reason: 'No validation declaration; command selection requires a repository-reading model' };
  let parsed: ValidationParseResult;
  try { parsed = parseValidationCommands(JSON.parse(fs.readText(configPath)), configPath, true); }
  catch (error) { throw new Error(`Invalid project validation configuration at ${configPath}: ${errorMessage(error)}`); }
  if (parsed.error) throw new Error(`Invalid project validation configuration at ${configPath}: ${parsed.error}`);
  const commands = parsed.commands.map(command => ({ ...command, display: [command.command, ...command.args].join(' '),
    provenance: { source: 'project' as const, evidencePath: command.evidencePath } }));
  const missingRoles = ROLES.filter(role => !commands.some(command => command.role === role));
  return { state: missingRoles.length ? 'partial' : 'configured', configPath, commands, missingRoles, ...(parsed.limits ? { limits: parsed.limits } : {}) };
}

function argv(command: Pick<ValidationCommand, 'command' | 'args'>): string[] {
  return [command.command, ...command.args];
}

function sameArgv(
  left: Pick<ValidationCommand, 'command' | 'args'>,
  right: Pick<ValidationCommand, 'command' | 'args'>,
): boolean {
  return left.command === right.command
    && left.args.length === right.args.length
    && left.args.every((value, index) => value === right.args[index]);
}

function unknownReconciliation(discovery: ValidationDiscovery, reason: string): ValidationDiscovery {
  return {
    ...discovery,
    state: 'unknown',
    commands: [],
    missingRoles: [...ROLES],
    reason,
  };
}

/**
 * Reconcile operator knowledge with target-owned configuration role by role.
 * Project declarations govern; brief commands replace guesses and fill gaps.
 * Exact overlap corroborates; conflicting declarations make the baseline unknown.
 */
export function reconcileProjectValidation(
  projectDir: string,
  declaredCommands: readonly BriefValidationCommand[],
  fs: ValidationFileSystem = nodeValidationFs,
): ValidationDiscovery {
  const discovery = discoverProjectValidation(projectDir, fs);
  if (declaredCommands.length === 0) return discovery;

  const declaredByRole = new Map<ValidationRole, BriefValidationCommand>();
  for (const declaration of declaredCommands) {
    if (!ROLES.includes(declaration.role)) {
      return unknownReconciliation(
        discovery,
        `Brief validation declaration has unknown role ${JSON.stringify(declaration.role)}`,
      );
    }
    if (declaredByRole.has(declaration.role)) {
      return unknownReconciliation(
        discovery,
        `Brief validation declaration repeats role ${JSON.stringify(declaration.role)}`,
      );
    }
    declaredByRole.set(declaration.role, declaration);
  }

  const commands: ValidationCommand[] = [];
  for (const role of ROLES) {
    const projectCommands = discovery.commands.filter(command => command.role === role);
    const projectCommand = projectCommands[0];
    const declaration = declaredByRole.get(role);
    if (projectCommand && declaration) {
      const matching = projectCommands.find(command => sameArgv(command, declaration));
      if (!matching) {
        const projectEvidence = projectCommand.evidencePath ?? discovery.configPath;
        return unknownReconciliation(
          discovery,
          `Validation command conflict for ${role}: project declaration at ${projectEvidence} specifies ${JSON.stringify(argv(projectCommand))}, but brief declaration at ${declaration.evidencePath} specifies ${JSON.stringify(argv(declaration))}. Project configuration governs; remove the overlapping brief declaration or make its argv exactly agree.`,
        );
      }
      if (JSON.stringify(Object.entries(matching.env ?? {}).sort()) !== JSON.stringify(Object.entries(declaration.env ?? {}).sort())) {
        return unknownReconciliation(discovery, `Validation environment conflict for ${role}: project configuration governs`);
      }
      if (matching.report && declaration.report && (matching.report.format !== declaration.report.format || matching.report.path !== declaration.report.path)) {
        return unknownReconciliation(discovery, `Validation reporter conflict for ${role}: project configuration governs`);
      }
      if (declaration.report) matching.report ??= declaration.report;
      matching.provenance = { source: 'project', evidencePath: matching.evidencePath ?? discovery.configPath, corroboratedBy: [declaration.evidencePath] };
    }
    if (!declaration || projectCommand) {
      commands.push(...projectCommands);
      continue;
    }
    commands.push({
      role,
      ...(declaration.report ? { report: declaration.report } : {}),
      ...(declaration.env ? { env: { ...declaration.env } } : {}),
      command: declaration.command,
      args: [...declaration.args],
      display: argv(declaration).join(' '),
      evidencePath: declaration.evidencePath,
      provenance: {
        source: 'brief',
        evidencePath: declaration.evidencePath,
      },
    });
  }

  const missingRoles = ROLES.filter((role) => !commands.some((command) => command.role === role));
  const resolved: ValidationDiscovery = {
    ...discovery,
    state: missingRoles.length === 0 ? 'configured' : 'partial',
    commands,
    missingRoles,
  };
  delete resolved.reason;
  return resolved;
}

function boundedOutput(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf-8');
  if (bytes.length <= maxBytes) return value;
  return `[... ${bytes.length - maxBytes} earlier bytes omitted ...]\n${bytes.subarray(bytes.length - maxBytes).toString('utf-8')}`;
}

const executeValidationCommand: ValidationCommandRunner = async (request) => {
  if (request.abortSignal?.aborted || (request.timeoutMs !== undefined && request.timeoutMs <= 0)) return { exitCode: null, unfinished: true, error: 'Validation refused: resource deadline or control abort', durationMs: 0 };
  const environmentRoot = mkdtempSync(join(tmpdir(), 'flowcrew-validation-'));
  try {
  const environment = validationEnvironment(environmentRoot, process.env, request.env && { ...process.env, ...request.env });
  // Silently dropping an explicit project input can remove its data isolation.
  // Refuse execution rather than run a different environment.
  const suppressed = environment.removed.filter(name => request.env?.[name] !== undefined);
  if (suppressed.length) return { exitCode: null, error: `Declared validation environment cannot be preserved: ${suppressed.join(', ')}`, durationMs: 0 };
  for (const path of ['home/.fc', 'codex', 'runtime', 'home/.config']) {
    mkdirSync(join(environmentRoot, path), { recursive: true });
  }
  const launch = () => new Promise<ValidationRunResponse>((resolveResult, rejectResult) => {
  const started = Date.now();
  const { child, stop, publication, writeGrantFailure, writeGrantApplied } = spawnOwnedCommand(request.command, request.args, {
    cwd: request.cwd,
    env: environment.env,
    priority: request.priority,
  });
  const activity = request.runDir && request.execution ? new CommandActivityTracker({
    runDir: request.runDir, ...request.execution,
  }) : undefined;
  activity?.bindProcess(child.pid, 'command');
  activity?.started(request.role, request.display);
  const publishOutput = (chunk: string): void => {
    if (request.runDir && request.execution) appendEngineFile(
      stageLiveLogPath(request.runDir, request.execution.stageId, request.execution.attemptIndex, request.execution.attemptStartedAt), chunk,
    );
  };
  let stdout = '';
  const outputBytes = { stdout: 0, stderr: 0 };
  let stderr = environment.removed.length
    ? `FlowCrew validation environment: suppressed engine/control or credential settings: ${environment.removed.join(', ')}. Supply ordinary project inputs through the command environment; reserved settings are isolated.\n`
    : '';
  const stdoutDecoder = new TextDecoder('utf-8', { fatal: true });
  const stderrDecoder = new TextDecoder('utf-8', { fatal: !request.report });
  let outputEncodingError: string | undefined;
  const decodeOutput = (decoder: TextDecoder, chunk?: Buffer | string): string => {
    if (outputEncodingError) return '';
    try { return decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, { stream: chunk !== undefined }); }
    catch { outputEncodingError = 'Validation output is not valid UTF-8'; return ''; }
  };
  let settled = false;
  let timedOut = false;
  let spawnError: string | undefined;
  const timeoutMs = request.timeoutMs;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settle = (exitCode: number | null, signal?: NodeJS.Signals | null, error?: string): void => {
    if (settled) return;
    settled = true;
    activity?.close();
    clearTimeout(timeout);
    request.abortSignal?.removeEventListener('abort', onAbort);
    // Identity publication belongs to this command. Join it before any caller
    // can turn a retired child into validation evidence or start another command.
    void Promise.resolve(publication).then(() => resolveResult({
      exitCode,
      ...(writeGrantFailure() ? { writeGrantFailure: writeGrantFailure() } : {}),
      ...(writeGrantApplied() ? { writeGrantApplied: writeGrantApplied() } : {}),
      ...((timedOut || request.abortSignal?.aborted || signal) ? { unfinished: true } : {}),
      stdout,
      stderr,
      outputBytes,
      ...(outputEncodingError ? { reportError: outputEncodingError } : {}),
      durationMs: Date.now() - started,
      ...(error ? { error } : request.abortSignal?.aborted ? { error: 'Validation budget ended or control aborted' } : {}),
      ...(!error && timedOut ? { error: `Validation command timed out after ${timeoutMs}ms` } : {}),
      ...(!error && !timedOut && signal ? { error: `Validation process ended by signal ${signal}` } : {}),
    }), rejectResult);
  };
  child.stdout?.on('data', (chunk: Buffer | string) => {
    outputBytes.stdout += Buffer.byteLength(chunk);
    const value = decodeOutput(stdoutDecoder, chunk);
    stdout = boundedOutput(stdout + value, request.report && !request.report.path ? 1024 * 1024 : DEFAULT_MAX_OUTPUT_BYTES);
    publishOutput(value);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    outputBytes.stderr += Buffer.byteLength(chunk);
    const value = decodeOutput(stderrDecoder, chunk);
    stderr = boundedOutput(stderr + value, DEFAULT_MAX_OUTPUT_BYTES);
    publishOutput(value);
  });
  child.stdout?.once('end', () => { const value = decodeOutput(stdoutDecoder); stdout += value; if (value) publishOutput(value); });
  child.stderr?.once('end', () => { const value = decodeOutput(stderrDecoder); stderr += value; if (value) publishOutput(value); });
  child.once('error', (error) => { spawnError = error.message; });
  child.once('close', (code, signal) => {
    settle(code, signal, spawnError);
  });
  // The raw owner retains capacity and scratch until its consumers retire.
  const onAbort = () => {
    const retired = stop();
    child.stdout?.destroy(); child.stderr?.destroy();
    void Promise.resolve(retired).then(() => settle(child.exitCode, child.signalCode, spawnError));
  };
  if (timeoutMs !== undefined) {
    timeout = setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);
    timeout.unref();
  }
  request.abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (request.abortSignal?.aborted) onAbort();
  });
  return await launch();
  } finally { rmSync(environmentRoot, { recursive: true, force: true }); }
};

/** Execute exactly the selected command. Dependency preparation, if needed,
 * belongs in that declaration's executable/argv, never a second discovery path. */
export const runValidationCommand: ValidationCommandRunner = (request) => withValidationLoad(request, runProjectCommand);

export const runProjectCommand: ValidationCommandRunner = (request) => withEngineIntegrity({
  projectDir: request.cwd, runDir: request.runDir, stageId: '_validation',
}, async () => {
  const started = Date.now();
  const remaining = () => request.timeoutMs === undefined ? undefined : request.timeoutMs - (Date.now() - started);
  let reportPath: string | undefined;
  let before: string | undefined;
  if (request.report?.path) {
    try {
      if (!safeEvidencePath(request.report.path)) throw new Error('Report path is a credential/control path');
      reportPath = prospectivePhysicalPath(resolve(request.cwd, request.report.path));
      if (!safeEvidencePath(reportPath)) throw new Error('Report resolves to a credential/control path');
      if (!reportPath.startsWith(`${resolve(request.cwd)}/`)) throw new Error('Report path escapes project');
      try { const stat = statSync(reportPath); before = JSON.stringify([stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size]); } catch { /* expected new report */ }
    } catch (error) { return { exitCode: null, error: errorMessage(error) }; }
  }
  const response = await executeValidationCommand({ ...request, timeoutMs: remaining() });
  if (reportPath) {
    try {
      if (prospectivePhysicalPath(resolve(request.cwd, request.report!.path!)) !== reportPath) throw new Error('Report path changed');
      const stat = statSync(reportPath);
      if (!stat.isFile() || stat.size > 1024 * 1024 || before === JSON.stringify([stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size])) throw new Error('Report absent, stale, invalid or exceeds 1 MiB');
      response.report = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(reportPath));
      delete response.reportError; // The declared file, independently decoded, owns identity.
    } catch (error) { response.reportError = errorMessage(error); }
  }
  return { ...response, durationMs: Date.now() - started };
});

/** No test-output rules. Invalid reporter/model evidence remains unknown. */
function validationOutputBytes(response: ValidationRunResponse): { stdout: number; stderr: number } {
  return { stdout: response.outputBytes?.stdout ?? Buffer.byteLength(response.stdout ?? ''),
    stderr: response.outputBytes?.stderr ?? Buffer.byteLength(response.stderr ?? '') };
}

async function failureFacts(command: ValidationCommand, response: ValidationRunResponse, _output: string,
  root: string, _dependencies: ProjectValidationDependencies): Promise<IdentityFacts> {
  if (response.unfinished) return { identifiers: [], owner: 'unknown' };
  const failed = response.exitCode !== 0;
  if (response.reportError) return { identifiers: [], owner: 'unknown', reason: `Invalid validation identity evidence: ${response.reportError}` };
  if (command.report) {
    try {
      const bytes = response.report ?? (command.report.path ? undefined : response.stdout);
      if (bytes === undefined || Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('Structured report missing or exceeds 1 MiB');
      const { files, totals, ...reading } = decodeRunnerReport(bytes, command.report.format, root, failed);
      return { ...identityFacts(reading, 'runner-json', failed), failureFiles: files, totals };
    } catch (error) { return { identifiers: [], owner: 'unknown', reason: `Invalid structured report: ${errorMessage(error)}` }; }
  }
  if (!failed) return { identifiers: [], owner: 'unknown' };
  return { identifiers: [], owner: 'unknown', reason: 'No declared structured reporter; failure identity remains unknown' };
}

/** One batch; commands run in order and each may use what remains of the batch allowance. */
export async function runProjectValidationBaseline(
  projectDir: string,
  dependencies: ProjectValidationDependencies = {},
): Promise<ProjectValidationBaseline> {
  const root = resolve(projectDir);
  const fs = dependencies.fs ?? nodeValidationFs;
  const runner = dependencies.runCommand ?? runValidationCommand;
  const now = dependencies.now ?? (() => performance.now());
  const maxOutputBytes = dependencies.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const declaredCommands = dependencies.declaredCommands;
  const discovery = dependencies.commands
    ? {
        state: 'configured' as const,
        configPath: 'run-local validation_baseline.json',
        commands: dependencies.commands.map((command) => ({ ...command, args: [...command.args] })),
        missingRoles: ROLES.filter((role) => !dependencies.commands!.some((command) => command.role === role)),
      }
    : declaredCommands === undefined
      ? discoverProjectValidation(root, fs)
      : reconcileProjectValidation(root, declaredCommands, fs);
  const results: ValidationCommandResult[] = [];
  const batchStarted = now();
  const budgetMs = Math.max(0, Math.min(dependencies.timeoutMs ?? discovery.limits?.timeoutMs ?? Infinity, dependencies.remainingMs?.() ?? Infinity));
  for (const command of discovery.commands) {
    const role = command.role;
    if (dependencies.skipExecution) {
      results.push({
        role, command: command.command, args: command.args, ...(command.env ? { env: command.env } : {}),
        display: command.display,
        state: 'unverified',
        durationMs: 0,
        output: '',
        failureIdentifiers: [],
        failureIdentity: 'unknown',
        reason: dependencies.skipReason ?? 'Baseline execution was skipped by operator request (--no-baseline)',
      });
      continue;
    }
    const started = now();
    const remaining = Math.max(0, Math.min(budgetMs - (started - batchStarted), dependencies.remainingMs?.() ?? Infinity));
    let response: ValidationRunResponse;
    try {
      response = dependencies.abortSignal?.aborted || remaining <= 0
        ? { exitCode: null, unfinished: true, error: 'Validation budget ended before command execution' }
        : await runner({ ...command, cwd: root,
        timeoutMs: Number.isFinite(remaining) ? remaining : undefined, priority: dependencies.priority,
        ...(dependencies.abortSignal ? { abortSignal: dependencies.abortSignal } : {}) });
    } catch (error) {
      rethrowGitNotAnswered(error);
      response = { exitCode: null, ...(dependencies.abortSignal?.aborted ? { unfinished: true } : {}), error: errorMessage(error) };
    }
    const durationMs = response.durationMs ?? Math.max(0, now() - started);
    const rawOutput = [response.stdout, response.stderr]
      .filter((value): value is string => Boolean(value))
      .join('\n');
    const output = boundedOutput(rawOutput, maxOutputBytes);
    const outputBytes = validationOutputBytes(response);
    const projection = projectValidationResult(response);
    const recorded = { ...(response.report !== undefined ? { report: response.report } : {}),
      ...(response.reportError !== undefined ? { reportError: response.reportError } : {}), ...(response.load ? { load: response.load } : {}),
      ...(response.error ? { error: response.error } : {}),
      ...(response.unfinished ? { unfinished: true } : {}),
      ...(response.dependencyPreparationFailed ? { dependencyPreparationFailed: true } : {}), ...projection };
    const facts = await failureFacts(command, response, rawOutput, root, dependencies);
    const failureIdentity = response.exitCode === 0
      ? command.report && (facts.owner === 'unknown' || facts.evidence === 'partial') ? 'unknown' : 'none'
      : facts.count !== undefined || facts.identifiers.length > 0 ? 'known' : 'unknown';
    results.push({
      role, command: command.command, args: command.args, ...(command.env ? { env: command.env } : {}),
      identityOwner: facts.owner,
      ...(facts.failures ? { failures: facts.failures } : {}),
      ...(facts.failureFiles ? { failureFiles: facts.failureFiles } : {}),
      testsRun: facts.testsRun ?? null,
      ...(facts.totals ? { totals: facts.totals } : {}),
      display: command.display,
      exitCode: response.exitCode,
      durationMs,
      output,
      outputBytes,
      ...recorded,
      ...(facts.count === undefined ? {} : { failureCount: facts.count }),
      failureIdentifiers: facts.identifiers,
      failureIdentity,
      ...(failureIdentity === 'known' ? { failureEvidence: facts.evidence ?? 'complete' } : {}),
      ...(response.unfinished ? { reason: `Validation unfinished: ${response.error ?? 'command did not complete'}` } : response.error ? { reason: response.error } : facts.reason === undefined ? {} : { reason: facts.reason }),
    });
  }

  return {
    version: 1,
    execution: dependencies.skipExecution ? 'skipped' : 'executed',
    projectDir: root,
    discovery,
    results,
  };
}

/** Compatibility API for setup displays: no environment diagnosis is inferred. */
export function unmeasured(result: ValidationCommandResult): boolean {
  return projectValidationResult(result).measurement === 'unverified';
}

/** Compatibility projection for old delta readers. Base facts never decide
 * causation or turn a failing command into a verified command. */
export function evaluateValidationDelta(
  baseline: (Pick<ProjectValidationBaseline, 'results'> & Partial<Pick<ProjectValidationBaseline, 'discovery'>>) | undefined,
  current: ValidationCommandResult[],
  _baseUnavailableReason = 'Base result unavailable',
  expected: readonly { role: ValidationRole; display?: string }[] = baseline?.discovery?.commands ?? [],
): ValidationDeltaResult[] {
  const missing = expected.filter(command => !current.some(result => result.role === command.role && (command.display === undefined || result.display === command.display)));
  return [
    ...current.map(result => ({ role: result.role, display: result.display,
      state: projectValidationResult(result).measurement,
      reason: projectValidationResult(result).measurement === 'verified' ? 'Command completed with exit 0' : 'Command did not complete with exit 0',
      newFailureIdentifiers: [] })),
    ...missing.map(command => ({ role: command.role, display: command.display, state: 'unverified' as const,
      reason: 'Selected command did not run', newFailureIdentifiers: [] })),
  ];
}
