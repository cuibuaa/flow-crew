import { z } from 'zod';
import { parseBriefFrontmatterDocument } from './brief-frontmatter.js';
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
import { isAbsolute, join, resolve } from 'node:path';
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
  env?: NodeJS.ProcessEnv;
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
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), argument).optional(),
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

/** The independent gate owns these judgments. Omitted, invalid, duplicated or
 * unrelated entries confer no causal authority. Exact role/display identifies
 * a selected command; logs and names are never parsed for a disposition. */
export const ValidationReviewSchema = z.object({
  commands: z.array(z.object({
    role: z.enum(ROLES), display: z.string().min(1),
    disposition: z.enum(['caused_by_change', 'already_failing', 'environment', 'unknown']),
    reason: z.string().trim().min(1),
  }).strict()),
  request_base: z.array(z.object({ role: z.enum(ROLES), display: z.string().min(1) }).strict()),
}).strict();
export const VALIDATION_REVIEW_JSON_SCHEMA = z.toJSONSchema(ValidationReviewSchema) as unknown as Schema;
export function validationDispositions(results: ValidationCommandResult[], value: unknown) {
  const review = ValidationReviewSchema.safeParse(value);
  return results.filter(result => projectValidationResult(result).measurement === 'unverified').map(result => {
    const entries = review.success ? review.data.commands.filter(entry => entry.role === result.role && entry.display === result.display) : [];
    return { role: result.role, display: result.display, disposition: entries.length === 1 ? entries[0].disposition : 'unknown' as const,
      reason: entries.length === 1 ? entries[0].reason : 'Gate disposition unavailable or invalid; command remains unknown and unverified' };
  });
}

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
    && (result.storedState ?? result.state) !== 'launch_error';
  const state = !completed ? 'unverified' : result.exitCode === 0 && !result.error && !result.dependencyPreparationFailed ? 'passed' : 'failed';
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
    if (error instanceof EngineStateError) throw error;
    response = { exitCode: null, error: errorMessage(error) };
  }
  return { ...response, durationMs: Math.max(0, now() - begin), load: { start, end: readSample() } };
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
  role: ValidationRole;
  display?: string;
  state: 'passed' | 'failed' | 'unverified';
  exitCode?: number | null;
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
  if (request.abortSignal?.aborted || (request.timeoutMs !== undefined && request.timeoutMs <= 0)) return { exitCode: null, unfinished: true, error: 'Validation refused: enclosing stage deadline or control abort', durationMs: 0 };
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

/** One batch; reserve an equal share for each remaining command. */
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
  const budgetMs = Math.max(0, Math.min(loadEngineDefaults().validation_timeout_ms, dependencies.remainingMs?.() ?? Infinity));
  for (const [index, command] of discovery.commands.entries()) {
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
    const shareMs = remaining / (discovery.commands.length - index);
    let response: ValidationRunResponse;
    try {
      response = dependencies.abortSignal?.aborted || shareMs <= 0
        ? { exitCode: null, unfinished: true, error: 'Validation budget ended before command execution' }
        : await runner({ ...command, cwd: root,
        timeoutMs: shareMs,
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
    const facts = await failureFacts(command, response, rawOutput, root, dependencies);
    const failureIdentity = response.exitCode === 0
      ? command.report && (facts.owner === 'unknown' || facts.evidence === 'partial') ? 'unknown' : 'none'
      : facts.count !== undefined || facts.identifiers.length > 0 ? 'known' : 'unknown';
    results.push({
      role, command: command.command, args: command.args, ...(command.env ? { env: command.env } : {}),
      identityOwner: facts.owner,
      ...(facts.failures ? { failures: facts.failures } : {}),
      testsRun: facts.testsRun ?? null,
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
    gateCriteria: [], // Legacy field, no code-owned causal criteria are generated.
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
      reason: projectValidationResult(result).measurement === 'verified' ? 'Command completed with exit 0' : 'Command unverified; independent gate owns disposition',
      newFailureIdentifiers: [] })),
    ...missing.map(command => ({ role: command.role, display: command.display, state: 'unverified' as const,
      reason: 'Selected command did not run', newFailureIdentifiers: [] })),
  ];
}
