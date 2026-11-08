import { z } from 'zod';
import { parseBriefFrontmatterDocument } from './brief-frontmatter.js';
import type { Schema } from './reality-gate/checks/json-schema-match.js';
import { stageLiveLogPath } from './stage-live-log.js';
import { errorMessage } from './source_services/cli-inputs.js';
import { appendEngineFile, withEngineIntegrity } from './engine-integrity.js';
import { CommandActivityTracker } from './command-activity.js';
import { spawnOwnedCommand } from './adapters/base.js';
import { mkdirSync, mkdtempSync, rmSync } from './engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir, cpus, loadavg } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { validationEnvironment } from './validation-environment.js';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { decodeRunnerReport, identityFacts, type IdentityFacts } from './validation-identity.js';
import { prospectivePhysicalPath, safeEvidencePath } from './engine-owned-carriers.js';
import { statSync } from 'node:fs';
import { loadEngineDefaults } from './config.js';

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

export interface ValidationCommand {
  report?: ValidationReport;
  role: ValidationRole;
  command: string;
  args: string[];
  display: string;
  evidencePath?: string;
  provenance?: ValidationCommandProvenance;
}

export interface BriefValidationCommand {
  report?: ValidationReport;
  role: ValidationRole;
  command: string;
  args: string[];
  evidencePath: string;
}

export interface ValidationParseResult {
  commands: BriefValidationCommand[];
  error?: string;
}

const ROLES = ['build', 'test', 'lint'] as const;
const argument = z.string().refine(value => ![...value].some(character => {
  const code = character.codePointAt(0)!;
  return code <= 0x1f || code >= 0x7f && code <= 0x9f;
}), 'must not contain a control character');
const commandDeclaration = z.object({
  command: argument.refine(value => value.trim().length > 0, 'must be a non-empty string'),
  args: z.array(argument),
  report: z.object({ format: z.literal('vitest-json'), path: argument.refine(value => value.length > 0
    && !isAbsolute(value) && !value.split('/').includes('..'), 'must be a project-relative file').optional() }).strict().optional(),
}).strict();
const validationDeclaration = z.object({ commands: z.object({
  build: commandDeclaration.optional(), test: commandDeclaration.optional(), lint: commandDeclaration.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'must declare at least one role') }).strict();

/** Fixed model output uses the same command objects as declarations; an empty
 * selection explicitly means no measurement, not a green suite. */
export const ValidationSelectionSchema = z.object({ commands: z.object({
  build: commandDeclaration.optional(), test: commandDeclaration.optional(), lint: commandDeclaration.optional(),
}).strict(), reason: z.string().min(1).max(4096) }).strict();
export const VALIDATION_SELECTION_JSON_SCHEMA = z.toJSONSchema(ValidationSelectionSchema) as unknown as Schema;

/** One closed declaration contract for project config and brief frontmatter. */
export function parseValidationCommands(validation: unknown, evidencePathRoot: string): ValidationParseResult {
  if (validation === undefined) return { commands: [] };
  const parsed = validationDeclaration.safeParse(validation);
  if (!parsed.success) return { commands: [], error: `Invalid validation declaration at ${evidencePathRoot}#validation: `
    + parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.code === 'unrecognized_keys'
      ? `unknown ${issue.path.length === 1 && issue.path[0] === 'commands' ? 'role' : 'field'} ${issue.keys.join(', ')}` : issue.message}`).join('; ') };
  return { commands: ROLES.flatMap(role => {
    const command = parsed.data.commands[role];
    return command ? [{ role, ...command, evidencePath: `${evidencePathRoot}#validation.commands.${role}` }] : [];
  }) };
}

/** The same declaration parser serves setup and low-level author entry points. */
export function parseBriefValidationCommands(brief: string, briefPath: string): ValidationParseResult {
  const frontmatter = parseBriefFrontmatterDocument(brief);
  if (frontmatter?.error) return { commands: [], error: frontmatter.error };
  return parseValidationCommands(frontmatter?.value && typeof frontmatter.value === 'object'
    ? (frontmatter.value as Record<string, unknown>).validation : undefined, briefPath);
}

export interface ValidationDiscovery {
  state: 'configured' | 'partial' | 'unknown';
  configPath: string;
  configPaths?: string[];
  commands: ValidationCommand[];
  missingRoles: ValidationRole[];
  reason?: string;
}

export interface ValidationRunRequest extends ValidationCommand {
  /** An enclosing stage may narrow the configured command deadline. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  cwd: string;
  /** Parent-supplied run anchor; pre-admission validation uses a private one. */
  runDir?: string;
  /** Attempt whose pre-execution prerequisites this configured command serves. */
  execution?: { stageId: string; attemptIndex: number; attemptStartedAt: string };
  /** Ordinary project inputs and explicit home/config reads. Reserved control,
   * credential and executable-injection settings are suppressed with a diagnostic. */
  env?: NodeJS.ProcessEnv;
}

export interface ValidationLoad {
  start: { loadAverage1m: number; cpuCount: number };
  end: { loadAverage1m: number; cpuCount: number };
  ceilingPerCpu: number;
  waitBoundSeconds: number;
  waitedSeconds: number;
}
export type ValidationMeasurement = 'measured' | 'not_measured' | 'load_unknown';
const VALIDATION_STATES = ['passed', 'failed', 'launch_error', 'not_configured', 'unresolved', 'not_measured'] as const;
/** One interpretation of raw command facts, including historical receipts whose
 * stored labels predate current load rules. No reader may use a cached label. */
export function projectValidationResult(result: {
  load?: ValidationLoad; exitCode?: number | null; error?: unknown;
  unfinished?: boolean;
  dependencyPreparationFailed?: boolean; state?: string; storedState?: string;
}): { state: ValidationCommandResult['state']; measurement: ValidationMeasurement } {
  if (result.unfinished) return { state: 'not_measured', measurement: 'not_measured' };
  const value = result.load;
  const validLoad = value && [value.ceilingPerCpu, value.waitBoundSeconds, value.waitedSeconds,
    value.start?.loadAverage1m, value.start?.cpuCount, value.end?.loadAverage1m, value.end?.cpuCount].every(Number.isFinite)
    && value.ceilingPerCpu > 0 && value.ceilingPerCpu <= 100 && value.waitBoundSeconds >= 0 && value.waitBoundSeconds <= 300
    && value.waitedSeconds >= 0 && value.waitedSeconds <= Number.MAX_SAFE_INTEGER
    && [value.start, value.end].every(sample => Number.isSafeInteger(sample.cpuCount) && sample.cpuCount > 0 && sample.loadAverage1m >= 0 && sample.loadAverage1m <= Number.MAX_SAFE_INTEGER);
  // Preserve legacy runner-error evidence when a reader projects the state again.
  const recordedState = result.storedState ?? result.state;
  const launchError = Boolean(result.error) || result.dependencyPreparationFailed || result.exitCode === 127 || recordedState === 'launch_error';
  const failed = result.exitCode !== 0 || launchError;
  const measurement = !validLoad ? 'load_unknown'
    : failed && value.start.loadAverage1m / value.start.cpuCount > value.ceilingPerCpu ? 'not_measured' : 'measured';
  const state = measurement === 'not_measured' ? 'not_measured' : launchError ? 'launch_error'
    : Number.isInteger(result.exitCode) ? result.exitCode === 0 ? 'passed' : 'failed'
    : result.exitCode === null ? 'launch_error' : VALIDATION_STATES.find(state => state === recordedState) ?? 'unresolved';
  return { state, measurement };
}

export function validationMeasurement(result: Parameters<typeof projectValidationResult>[0]): ValidationMeasurement {
  return projectValidationResult(result).measurement;
}

/** One load boundary around a configured command, including its preparation.
 * The wait spends the command's enclosing deadline, never adds to it. */
export async function withValidationLoad(request: ValidationRunRequest, execute: ValidationCommandRunner,
  dependencies: { sample?: () => ValidationLoad['start']; now?: () => number; wait?: (ms: number) => Promise<void> } = {}): Promise<ValidationRunResponse> {
  const defaults = loadEngineDefaults(), now = dependencies.now ?? (() => performance.now());
  const sample = dependencies.sample ?? (() => ({ loadAverage1m: loadavg()[0], cpuCount: cpus().length }));
  const begin = now();
  const bound = Math.min(defaults.validation_load_wait_seconds, Math.max(0, (request.timeoutMs ?? Infinity) / 1000));
  const wait = dependencies.wait ?? (ms => delay(ms, undefined, { signal: request.abortSignal }));
  let start = sample(), waitedMs = 0;
  while (start.loadAverage1m / start.cpuCount > defaults.validation_load_ceiling_per_cpu && (now() - begin) / 1000 < bound && !request.abortSignal?.aborted) {
    const waitingAt = now();
    await wait(Math.min(1000, bound * 1000 - (now() - begin)));
    waitedMs += Math.max(0, now() - waitingAt);
    start = sample();
  }
  const elapsed = Math.max(0, now() - begin);
  const load = { start, end: start, ceilingPerCpu: defaults.validation_load_ceiling_per_cpu,
    waitBoundSeconds: bound, waitedSeconds: waitedMs / 1000 };
  const response = await execute({ ...request, ...(request.timeoutMs === undefined ? {} : { timeoutMs: Math.max(0, request.timeoutMs - elapsed) }) });
  load.end = sample();
  return { ...response, durationMs: Math.max(0, now() - begin), load, measurement: validationMeasurement({ ...response, load }) };
}

export interface ValidationRunResponse {
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

export interface ValidationCommandResult {
  storedState?: ValidationCommandResult['state'];
  error?: string;
  unfinished?: boolean;
  dependencyPreparationFailed?: boolean;
  load?: ValidationLoad;
  measurement?: ValidationMeasurement;
  outputBytes?: { stdout: number; stderr: number };
  identityOwner?: IdentityFacts['owner'];
  failures?: import('./validation-identity.js').FailureReading['failures'];
  testsRun?: number | null;
  role: ValidationRole;
  display?: string;
  state: 'passed' | 'failed' | 'launch_error' | 'not_configured' | 'unresolved' | 'not_measured';
  exitCode?: number;
  durationMs: number;
  output: string;
  failureCount?: number;
  failureIdentifiers: string[];
  failureIdentity: 'known' | 'unknown' | 'none';
  failureEvidence?: FailureEvidence;
  reason?: string;
}

export interface ValidationGateCriterion {
  role: ValidationRole;
  display?: string;
  rule: 'must_remain_green' | 'no_regression_from_baseline' | 'baseline_unresolved' | 'not_configured';
  baselineFailureCount?: number;
  baselineFailureIdentifiers: string[];
  baselineFailureEvidence?: FailureEvidence;
  description: string;
}

export interface ProjectValidationBaseline {
  version: 1;
  execution?: 'executed' | 'skipped';
  projectDir: string;
  discovery: ValidationDiscovery;
  results: ValidationCommandResult[];
  gateCriteria: ValidationGateCriterion[];
}

export interface ProjectValidationDependencies {
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
}

export interface ValidationDeltaResult {
  role: ValidationRole;
  display?: string;
  state: 'pass' | 'regression' | 'unresolved' | 'not_measured';
  reason: string;
  newFailureIdentifiers: string[];
}

const FAILED_VALIDATION_STATE: ValidationCommandResult['state'] = 'failed';
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
  try { parsed = parseValidationCommands(JSON.parse(fs.readText(configPath)), configPath); }
  catch (error) { throw new Error(`Invalid project validation configuration at ${configPath}: ${errorMessage(error)}`); }
  if (parsed.error) throw new Error(`Invalid project validation configuration at ${configPath}: ${parsed.error}`);
  const commands = parsed.commands.map(command => ({ ...command, display: [command.command, ...command.args].join(' '),
    provenance: { source: 'project' as const, evidencePath: command.evidencePath } }));
  const missingRoles = ROLES.filter(role => !commands.some(command => command.role === role));
  return { state: missingRoles.length ? 'partial' : 'configured', configPath, commands, missingRoles };
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
  if (request.abortSignal?.aborted || (request.timeoutMs !== undefined && request.timeoutMs <= 0)) return { exitCode: null, unfinished: true, error: 'Validation refused: enclosing stage deadline or control abort', durationMs: 0 };
  const environmentRoot = mkdtempSync(join(tmpdir(), 'flowcrew-validation-'));
  try {
  const environment = validationEnvironment(environmentRoot, process.env, request.env);
  for (const path of ['home/.fc', 'codex', 'runtime', 'home/.config']) {
    mkdirSync(join(environmentRoot, path), { recursive: true });
  }
  const launch = () => new Promise<ValidationRunResponse>((resolveResult) => {
  const started = Date.now();
  const { child, stop } = spawnOwnedCommand(request.command, request.args, {
    cwd: request.cwd,
    env: environment.env,
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
  // Keep the configured suite bound; the enclosing attempt may narrow it.
  let timeoutMs = 60_000;
  try {
    const configured = loadEngineDefaults().validation_timeout_ms;
    if (Number.isFinite(configured) && configured > 0) timeoutMs = configured;
  } catch { /* retain the built-in bound if engine configuration is unavailable */ }
  if (request.timeoutMs !== undefined) timeoutMs = Math.min(timeoutMs, Math.max(1, request.timeoutMs));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settle = (exitCode: number | null, signal?: NodeJS.Signals | null, error?: string): void => {
    if (settled) return;
    settled = true;
    activity?.close();
    clearTimeout(timeout);
    request.abortSignal?.removeEventListener('abort', onAbort);
    resolveResult({
      exitCode,
      ...((timedOut || request.abortSignal?.aborted || signal) ? { unfinished: true } : {}),
      stdout,
      stderr,
      outputBytes,
      ...(outputEncodingError ? { reportError: outputEncodingError } : {}),
      durationMs: Date.now() - started,
      ...(error ? { error } : request.abortSignal?.aborted ? { error: 'Validation budget ended or control aborted' } : {}),
      ...(!error && timedOut ? { error: `Validation command timed out after ${timeoutMs}ms` } : {}),
      ...(!error && !timedOut && signal ? { error: `Validation process ended by signal ${signal}` } : {}),
    });
  };
  child.stdout?.on('data', (chunk: Buffer | string) => {
    outputBytes.stdout += Buffer.byteLength(chunk);
    const value = decodeOutput(stdoutDecoder, chunk);
    stdout += value;
    publishOutput(value);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    outputBytes.stderr += Buffer.byteLength(chunk);
    const value = decodeOutput(stderrDecoder, chunk);
    stderr += value;
    publishOutput(value);
  });
  child.stdout?.once('end', () => { const value = decodeOutput(stdoutDecoder); stdout += value; if (value) publishOutput(value); });
  child.stderr?.once('end', () => { const value = decodeOutput(stderrDecoder); stderr += value; if (value) publishOutput(value); });
  child.once('error', (error) => { spawnError = error.message; });
  child.once('close', (code, signal) => {
    settle(code, signal, spawnError);
  });
  // Pipes can outlive the executable (for example a detached worker inherited
  // them). Deadline settlement must not depend on a transport close event.
  const onAbort = () => {
    stop();
    child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    settle(child.exitCode, child.signalCode, spawnError);
  };
  timeout = setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);
  timeout.unref();
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
  const failed = response.exitCode !== 0;
  if (response.reportError) return { identifiers: [], owner: 'unknown', reason: `Invalid validation identity evidence: ${response.reportError}` };
  if (command.report) {
    try {
      const bytes = response.report ?? (command.report.path ? undefined : response.stdout);
      if (bytes === undefined || Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('Structured report missing or exceeds 1 MiB');
      return identityFacts(decodeRunnerReport(bytes, command.report.format, root, failed), 'runner-json', failed);
    } catch (error) { return { identifiers: [], owner: 'unknown', reason: `Invalid structured report: ${errorMessage(error)}` }; }
  }
  if (!failed) return { identifiers: [], owner: 'unknown' };
  return { identifiers: [], owner: 'unknown', reason: 'No declared structured reporter; failure identity remains unknown' };
}

function criterionFor(recorded: ValidationCommandResult): ValidationGateCriterion {
  const result = { ...recorded, ...projectValidationResult(recorded) };
  if (result.state === 'passed' && !invalidSuccessfulIdentity(result)) {
    return {
      role: result.role,
      rule: 'must_remain_green',
      baselineFailureIdentifiers: [],
      description: `${result.role} passed at baseline and must remain green`,
    };
  }
  if (result.state === FAILED_VALIDATION_STATE) {
    const failureEvidence = result.failureEvidence ?? 'complete';
    return {
      role: result.role,
      rule: 'no_regression_from_baseline',
      ...(result.failureCount === undefined ? {} : { baselineFailureCount: result.failureCount }),
      baselineFailureIdentifiers: result.failureIdentifiers,
      ...(result.failureEvidence === undefined
        ? {}
        : { baselineFailureEvidence: result.failureEvidence }),
      description: result.failureIdentity === 'known'
        ? failureEvidence === 'partial'
          ? `${result.role} failed with partial evidence: retained failing identifiers are a lower bound and any observed count is not a proven whole-run count; a later failure remains unresolved because red-to-red comparisons require complete evidence. ${result.reason ?? 'Validation output was incomplete'}`
          : `${result.role} may improve, but may not add a failing identifier or exceed the baseline failure count${result.reason ? `. ${result.reason}` : ''}`
        : `${result.role} failed at baseline, but its failing identity/count could not be parsed; a later failure with identifiable failures is unresolved, never treated as zero, and one that again has none cannot show a regression. ${result.reason ?? 'Failure identification did not record a cause'}`,
    };
  }
  return {
    role: result.role,
    rule: result.state === 'not_configured' ? 'not_configured' : 'baseline_unresolved',
    baselineFailureIdentifiers: [],
    description: result.reason ?? `${result.role} baseline is unresolved`,
  };
}

/** Run the selected validation set and record delta-based gate criteria. */
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
  for (const command of discovery.commands) {
    const role = command.role;
    if (dependencies.skipExecution) {
      results.push({
        role,
        display: command.display,
        state: 'unresolved',
        durationMs: 0,
        output: '',
        failureIdentifiers: [],
        failureIdentity: 'unknown',
        reason: dependencies.skipReason ?? 'Baseline execution was skipped by operator request (--no-baseline)',
      });
      continue;
    }
    const started = now();
    let response: ValidationRunResponse;
    try {
      response = dependencies.abortSignal?.aborted || dependencies.remainingMs && dependencies.remainingMs() <= 0
        ? { exitCode: null, unfinished: true, error: 'Validation budget ended before command execution' }
        : await runner({ ...command, cwd: root,
        ...(dependencies.remainingMs ? { timeoutMs: dependencies.remainingMs() } : {}),
        ...(dependencies.abortSignal ? { abortSignal: dependencies.abortSignal } : {}) });
    } catch (error) {
      response = { exitCode: null, ...(dependencies.abortSignal?.aborted ? { unfinished: true } : {}), error: errorMessage(error) };
    }
    const durationMs = response.durationMs ?? Math.max(0, now() - started);
    const rawOutput = [response.stdout, response.stderr]
      .filter((value): value is string => Boolean(value))
      .join('\n');
    const output = boundedOutput(rawOutput, maxOutputBytes);
    const outputBytes = validationOutputBytes(response);
    const projection = projectValidationResult(response);
    const recorded = { ...(response.load ? { load: response.load } : {}),
      ...(response.error ? { error: response.error } : {}),
      ...(response.unfinished ? { unfinished: true } : {}),
      ...(response.dependencyPreparationFailed ? { dependencyPreparationFailed: true } : {}), ...projection };
    if (response.unfinished || projectValidationResult({ ...response, load: undefined }).state === 'launch_error') {
      results.push({ role, display: command.display, ...recorded, durationMs, output, outputBytes,
        ...(response.exitCode === null ? {} : { exitCode: response.exitCode }), failureIdentifiers: [], failureIdentity: 'unknown',
        reason: response.unfinished ? `Validation unfinished: ${response.error ?? 'command did not complete'}` : projection.state === 'not_measured'
          ? 'Validation not measured: host load exceeded the declared ceiling; neither pass nor failure, no author action required'
          : response.dependencyPreparationFailed && response.exitCode !== null ? `Dependency preparation exited with code ${response.exitCode}`
          : response.error ?? (response.exitCode === 127 ? 'Validation command could not run in the target environment (exit 127)' : 'Validation command ended without an exit code') });
      continue;
    }
    // Load withholds a measurement, not a declared runner's bounded facts.
    // An unmeasured command needs no additional model judgment.
    const facts: IdentityFacts = projection.state === 'not_measured' && !command.report
      ? { identifiers: [], owner: 'unknown' } : await failureFacts(command, response, rawOutput, root, dependencies);
    const failureIdentity = response.exitCode === 0
      ? command.report && (facts.owner === 'unknown' || facts.evidence === 'partial') ? 'unknown' : 'none'
      : facts.count !== undefined || facts.identifiers.length > 0 ? 'known' : 'unknown';
    results.push({
      role,
      identityOwner: facts.owner,
      ...(facts.failures ? { failures: facts.failures } : {}),
      testsRun: facts.testsRun ?? null,
      display: command.display,
      exitCode: response.exitCode!,
      durationMs,
      output,
      outputBytes,
      ...recorded,
      ...(facts.count === undefined ? {} : { failureCount: facts.count }),
      failureIdentifiers: facts.identifiers,
      failureIdentity,
      ...(failureIdentity === 'known' ? { failureEvidence: facts.evidence ?? 'complete' } : {}),
      ...(projection.state === 'not_measured' ? { reason: 'Validation not measured: host load exceeded the declared ceiling; neither pass nor failure, no author action required' }
        : facts.reason === undefined ? {} : { reason: facts.reason }),
    });
  }

  return {
    version: 1,
    execution: dependencies.skipExecution ? 'skipped' : 'executed',
    projectDir: root,
    discovery,
    results,
    gateCriteria: results.map(result => ({ ...criterionFor(result), ...(result.display ? { display: result.display } : {}) })),
  };
}

/** A run of a configured command that produced nothing to compare: it could not launch, or failed unidentifiably. */
export function unmeasured(result: ValidationCommandResult): boolean {
  const { state } = projectValidationResult(result);
  return state === 'not_measured' || (state === FAILED_VALIDATION_STATE || state === 'launch_error') && result.failureIdentity === 'unknown';
}

function invalidSuccessfulIdentity(result: ValidationCommandResult): boolean {
  // Legacy exit-0 receipts had no reporter owner. Their unknown failure IDs
  // do not imply a declared report was invalid; keep the raw exit meaningful.
  return result.state === 'passed' && result.failureIdentity === 'unknown' && result.identityOwner !== undefined;
}

export function evaluateValidationDelta(
  baseline: (Pick<ProjectValidationBaseline, 'results'> & Partial<Pick<ProjectValidationBaseline, 'discovery'>>) | undefined,
  current: ValidationCommandResult[],
  baseUnavailableReason = 'Base result unavailable',
  expected = baseline?.discovery?.commands ?? [],
): ValidationDeltaResult[] {
  // The declared selection owns required coverage, never the population of
  // unrelated base results. A missing selected command remains unmeasured.
  const missing = expected.filter(command => !current.some(result => result.role === command.role && result.display === command.display))
    .map(command => ({ role: command.role, display: command.display, state: 'not_measured' as const,
      reason: 'Declared command has no final result', newFailureIdentifiers: [] }));
  if (missing.length) return [...evaluateValidationDelta(baseline, current, baseUnavailableReason, []), ...missing];
  if (!baseline) return current.map(recorded => {
    const projected = { ...recorded, ...projectValidationResult(recorded) };
    const { state } = projected;
    const invalidIdentity = invalidSuccessfulIdentity(projected);
    return { role: recorded.role, display: recorded.display,
      state: invalidIdentity ? 'unresolved' : state === 'not_measured' ? 'not_measured' : state === 'passed' ? 'pass' : state === 'not_configured' ? 'not_measured' : 'unresolved',
      reason: recorded.unfinished ? recorded.reason ?? 'Validation unfinished' : invalidIdentity ? 'Declared structured report is incomplete, invalid or contradicts the command exit; comparison remains unknown' : state === 'not_measured' ? 'Validation not measured: host load exceeded the declared ceiling; neither pass nor failure, no author action required'
        : state === 'passed' ? 'Author attempt passed; no base execution required' : state === 'not_configured' ? 'Role is not configured' : baseUnavailableReason,
      newFailureIdentifiers: [],
    };
  });
  const priorResults = baseline.results.map(result => ({ ...result, ...projectValidationResult(result) }));
  const nextResults = current.map(result => ({ ...result, ...projectValidationResult(result) }));
  return nextResults.map((next): ValidationDeltaResult => {
    const prior = priorResults.find(result => result.role === next.role && (result.display === next.display || result.display === undefined));
    if (next.state === 'passed' && !invalidSuccessfulIdentity(next)) return { role: next.role, display: next.display, state: 'pass', reason: 'Author command passed; base failures are irrelevant', newFailureIdentifiers: [] };
    if (!prior) return evaluateValidationDelta(undefined, [next], baseUnavailableReason)[0];
    if (prior.state === 'not_measured' || next.state === 'not_measured') return {
      role: prior.role, state: 'not_measured', reason: 'Validation not measured: host load exceeded the declared ceiling; neither pass nor failure, no author action required', newFailureIdentifiers: [],
    };
    if (invalidSuccessfulIdentity(prior) || invalidSuccessfulIdentity(next)) return { role: prior.role, state: 'unresolved',
      reason: 'Declared structured report is incomplete, invalid or contradicts the command exit; comparison remains unknown', newFailureIdentifiers: [] };
    if (prior.state === 'passed') {
      if (next.state === 'passed') {
        return { role: prior.role, state: 'pass', reason: 'Green baseline remains green', newFailureIdentifiers: [] };
      }
      if (next.state !== FAILED_VALIDATION_STATE) {
        return {
          role: prior.role,
          state: 'unresolved',
          reason: `Current validation did not execute to a comparable pass/fail result (${next.state})`,
          newFailureIdentifiers: [],
        };
      }
      return {
        role: prior.role,
        state: 'regression',
        reason: 'A green baseline no longer passes',
        newFailureIdentifiers: next.failureIdentifiers,
      };
    }
    if (prior.state === 'not_configured' && next.state === 'not_configured') {
      // Historical absent-role slots are not a measured command pass.
      return { role: prior.role, state: 'not_measured', reason: 'Role is not configured; no result was measured', newFailureIdentifiers: [] };
    }
    if (next.state === 'passed') {
      return { role: prior.role, state: 'pass', reason: 'The red baseline improved to green', newFailureIdentifiers: [] };
    }
    if (prior.state !== FAILED_VALIDATION_STATE) {
      return { role: prior.role, state: 'unresolved', reason: 'Baseline was not executable/configured', newFailureIdentifiers: [] };
    }
    if (next.state !== FAILED_VALIDATION_STATE || next.failureIdentity === 'unknown') {
      return { role: prior.role, state: 'unresolved', reason: 'Current failure identity/count is unavailable', newFailureIdentifiers: [] };
    }
    if (prior.failureIdentity === 'unknown') {
      return { role: prior.role, state: 'unresolved', reason: 'Baseline failure identity/count was unavailable', newFailureIdentifiers: [] };
    }
    if (prior.failureEvidence === 'partial' || next.failureEvidence === 'partial') {
      return {
        role: prior.role,
        state: 'unresolved',
        reason: 'Baseline or current failure evidence is partial; red-to-red identifier and count comparisons require complete evidence',
        newFailureIdentifiers: [],
      };
    }
    if (!prior.failureIdentifiers.length || !next.failureIdentifiers.length) return { role: prior.role, state: 'unresolved', reason: 'Failure identities are missing', newFailureIdentifiers: [] };
    const priorIds = new Set(prior.failureIdentifiers);
    const newFailureIdentifiers = next.failureIdentifiers.filter((identifier) => !priorIds.has(identifier));
    const countIncreased = prior.failureCount !== undefined
      && next.failureCount !== undefined
      && next.failureCount > prior.failureCount;
    return newFailureIdentifiers.length > 0 || countIncreased
      ? {
          role: prior.role,
          state: 'regression',
          reason: newFailureIdentifiers.length > 0 ? 'New failing identifiers appeared' : 'Known failure count increased',
          newFailureIdentifiers,
        }
      : { role: prior.role, state: 'pass', reason: 'No new failure and no known count increase', newFailureIdentifiers: [] };
  }).map((result, index) => ({ ...result, ...(current[index].display ? { display: current[index].display } : {}) }));
}
