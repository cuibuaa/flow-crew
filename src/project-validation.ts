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
import { dirname, join, resolve } from 'node:path';
import { decodeRunnerReport, identityFacts, type FailureReader, type IdentityFacts } from './validation-identity.js';
import { prospectivePhysicalPath, safeEvidencePath } from './engine-owned-carriers.js';
import { statSync } from 'node:fs';
import { loadEngineDefaults } from './config.js';
import { spawnSync } from 'node:child_process';
import { listProjectFiles } from './scheduler/sched_scope/path-capabilities.js';

function readPackageManifest(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch { return undefined; }
}

/** Dependency preparation uses project-owned manifests rather
 * than guessing package roots from command spelling. Git excludes installed
 * packages and generated copies; non-Git projects use the existing inventory. */
function discoverConfiguredPackages(projectDir: string): Array<{ root: string; manifest: Record<string, unknown> }> {
  const projectRoot = resolve(projectDir);
  const inventory = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'package.json', '**/package.json'], {
    cwd: projectRoot, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
  });
  const paths = inventory.status === 0 ? inventory.stdout.split('\0') : listProjectFiles(projectRoot, {
    skipDirectory: path => path.split('/').includes('node_modules'),
  });
  return [...new Set(['package.json', ...paths])].flatMap(path => {
    if (path.split('/').includes('node_modules') || !/(?:^|\/)package\.json$/.test(path)) return [];
    const manifest = readPackageManifest(join(projectRoot, path));
    return manifest ? [{ root: dirname(join(projectRoot, path)), manifest }] : [];
  });
}

export type ValidationRole = 'build' | 'test' | 'lint';
export type PackageRunner = 'npm' | 'pnpm' | 'yarn' | 'bun';
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

export interface ValidationDiscovery {
  state: 'configured' | 'partial' | 'unknown';
  configPath: string;
  configPaths?: string[];
  runner?: PackageRunner;
  runnerEvidence?: string;
  commands: ValidationCommand[];
  missingRoles: ValidationRole[];
  reason?: string;
}

export interface ValidationRunRequest extends ValidationCommand {
  /** Prepare current lockfiles before this validation batch's first command. */
  prepareDependencies?: boolean;
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
/** Legacy or malformed readings cannot manufacture a measured result. Raw
 * command exits remain evidence, but overload is neither pass nor failure. */
export function validationMeasurement(result: { load?: ValidationLoad }): ValidationMeasurement {
  const value = result.load;
  if (!value || ![value.ceilingPerCpu, value.waitBoundSeconds, value.waitedSeconds,
    value.start?.loadAverage1m, value.start?.cpuCount, value.end?.loadAverage1m, value.end?.cpuCount].every(Number.isFinite)
    || value.ceilingPerCpu <= 0 || value.ceilingPerCpu > 100 || value.waitBoundSeconds < 0 || value.waitBoundSeconds > 300
    || value.waitedSeconds < 0 || value.waitedSeconds > Number.MAX_SAFE_INTEGER
    || ![value.start, value.end].every(sample => Number.isSafeInteger(sample.cpuCount) && sample.cpuCount > 0 && sample.loadAverage1m >= 0 && sample.loadAverage1m <= Number.MAX_SAFE_INTEGER)) return 'load_unknown';
  return [value.start, value.end].some(sample => sample.loadAverage1m / sample.cpuCount > value.ceilingPerCpu)
    ? 'not_measured' : 'measured';
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
  return { ...response, durationMs: Math.max(0, now() - begin), load, measurement: validationMeasurement({ load }) };
}

export interface ValidationRunResponse {
  load?: ValidationLoad;
  measurement?: ValidationMeasurement;
  report?: string;
  reportError?: string;
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
  readFailureIdentity?: FailureReader;
}

export interface ValidationDeltaResult {
  role: ValidationRole;
  display?: string;
  state: 'pass' | 'regression' | 'unresolved' | 'not_measured';
  reason: string;
  newFailureIdentifiers: string[];
}

const ROLES: readonly ValidationRole[] = ['build', 'test', 'lint'];
const FAILED_VALIDATION_STATE: ValidationCommandResult['state'] = 'failed';
const DEFAULT_MAX_OUTPUT_BYTES = 24 * 1024;
const nodeValidationFs: ValidationFileSystem = {
  exists: existsSync,
  readText: (path) => readFileSync(path, 'utf-8'),
};

function packageRunnerFromField(value: unknown): PackageRunner | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().split('@')[0];
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : undefined;
}

function lockfileEvidence(projectDir: string, fs: ValidationFileSystem): Array<{ runner: PackageRunner; path: string }> {
  const candidates: Array<{ runner: PackageRunner; path: string }> = [
    { runner: 'npm', path: 'package-lock.json' },
    { runner: 'npm', path: 'npm-shrinkwrap.json' },
    { runner: 'pnpm', path: 'pnpm-lock.yaml' },
    { runner: 'yarn', path: 'yarn.lock' },
    { runner: 'bun', path: 'bun.lock' },
    { runner: 'bun', path: 'bun.lockb' },
  ];
  return candidates.filter((candidate) => fs.exists(join(projectDir, candidate.path)));
}

function discoverPackageRunner(manifest: Record<string, unknown>, root: string, fs: ValidationFileSystem): Pick<ValidationDiscovery, 'runner' | 'runnerEvidence' | 'reason'> {
  const declared = packageRunnerFromField(manifest.packageManager);
  const locks = lockfileEvidence(root, fs);
  const runners = [...new Set(locks.map(entry => entry.runner))];
  if (declared) return { runner: declared, runnerEvidence: `package.json packageManager=${String(manifest.packageManager)}` };
  if (runners.length === 1) return { runner: runners[0], runnerEvidence: locks.map(entry => entry.path).join(', ') };
  return { reason: runners.length > 1
    ? `Package-manager lockfiles disagree: ${locks.map(entry => entry.path).join(', ')}`
    : 'No packageManager field or recognized lockfile identifies the package runner' };
}

function commandFor(role: ValidationRole, runner: PackageRunner): ValidationCommand {
  const args = ['run', role];
  return { role, command: runner, args, display: `${runner} ${args.join(' ')}` };
}

function configuredCommand(
  role: ValidationRole,
  command: string,
  args: string[],
  evidencePath: string,
): ValidationCommand {
  return { role, command, args, display: [command, ...args].join(' '), evidencePath };
}

interface TomlAssignment {
  key: string;
  value: string;
}

/** Remove comments and multiline prose without mistaking their contents for TOML declarations. */
function declarationTomlLines(text: string): string[] {
  let multiline: '"""' | "'''" | undefined;
  return text.split(/\r?\n/).map((line) => {
    let cleaned = '';
    let quote: '"' | "'" | undefined;
    let escaping = false;
    for (let index = 0; index < line.length;) {
      if (multiline) {
        const end = line.indexOf(multiline, index);
        if (end < 0) return cleaned;
        index = end + multiline.length;
        multiline = undefined;
        continue;
      }
      const triple = line.slice(index, index + 3);
      if (!quote && (triple === '"""' || triple === "'''")) {
        multiline = triple;
        index += 3;
        continue;
      }
      const character = line[index];
      if (quote) {
        cleaned += character;
        if (escaping) escaping = false;
        else if (character === '\\' && quote === '"') escaping = true;
        else if (character === quote) quote = undefined;
        index += 1;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        cleaned += character;
        index += 1;
        continue;
      }
      if (character === '#') break;
      cleaned += character;
      index += 1;
    }
    return cleaned;
  });
}

function pyprojectSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let section = '';
  for (const line of declarationTomlLines(text)) {
    const trimmed = line.trim();
    const header = trimmed.startsWith('[') && trimmed.endsWith(']') && !trimmed.startsWith('[[')
      ? trimmed.slice(1, -1)
      : undefined;
    if (header && !header.includes('[') && !header.includes(']')) {
      section = header.trim().toLowerCase();
      if (!sections.has(section)) sections.set(section, []);
      continue;
    }
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)?.push(line);
  }
  return sections;
}

function arrayDepth(value: string): number {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaping = false;
  for (const character of value) {
    if (quote) {
      if (escaping) escaping = false;
      else if (character === '\\' && quote === '"') escaping = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '[') depth += 1;
    else if (character === ']') depth -= 1;
  }
  return depth;
}

function tomlAssignments(lines: string[]): TomlAssignment[] {
  const assignments: TomlAssignment[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    let value = match[2];
    let depth = arrayDepth(value);
    while (depth > 0 && index + 1 < lines.length) {
      index += 1;
      value += `\n${lines[index]}`;
      depth += arrayDepth(lines[index]);
    }
    assignments.push({ key: match[1].replace(/^(?:"|')|(?:"|')$/g, ''), value });
  }
  return assignments;
}

function normalizedPythonPackage(value: string): string | undefined {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(value);
  return match?.[1].toLowerCase().replace(/[._-]+/g, '-');
}

function requirementStrings(value: string): string[] {
  return [...value.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)]
    .map((match) => match[1] ?? match[2] ?? '');
}

function declaresPythonDependency(sections: Map<string, string[]>, packageName: string): boolean {
  const wanted = normalizedPythonPackage(packageName);
  const valueDeclares = (value: string) => requirementStrings(value)
    .some((requirement) => normalizedPythonPackage(requirement) === wanted);

  for (const [section, lines] of sections) {
    const assignments = tomlAssignments(lines);
    if (section === 'project') {
      if (assignments.some(({ key, value }) => key === 'dependencies' && valueDeclares(value))) return true;
      continue;
    }
    if (section === 'project.optional-dependencies'
        || section === 'dependency-groups'
        || section === 'tool.pdm.dev-dependencies') {
      if (assignments.some(({ value }) => valueDeclares(value))) return true;
      continue;
    }
    if (section === 'tool.uv' || /^tool\.hatch\.envs(?:\.|$)/.test(section)) {
      if (assignments.some(({ key, value }) => /dependencies$/.test(key) && valueDeclares(value))) return true;
      continue;
    }
    if (section === 'tool.poetry.dependencies' || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)) {
      if (assignments.some(({ key }) => normalizedPythonPackage(key) === wanted)) return true;
    }
  }
  return false;
}

interface ValidationDiscoveryDetails {
  discovery: ValidationDiscovery;
  projectDeclarations: Set<ValidationCommand>;
  unresolvedProjectRoles: ValidationRole[];
}

function discoverProjectValidationDetails(
  projectDir: string,
  fs: ValidationFileSystem = nodeValidationFs,
): ValidationDiscoveryDetails {
  const root = resolve(projectDir);
  const packagePath = join(root, 'package.json');
  const makefilePath = join(root, 'Makefile');
  const pyprojectPath = join(root, 'pyproject.toml');
  const toxPath = join(root, 'tox.ini');
  const pytestPath = join(root, 'pytest.ini');
  const configPaths = [packagePath, makefilePath, pyprojectPath, toxPath, pytestPath].filter((path) => fs.exists(path));
  const commands: ValidationCommand[] = [];
  const projectDeclarations = new Set<ValidationCommand>();
  const declareCommand = (command: ValidationCommand): void => {
    commands.push(command);
    projectDeclarations.add(command);
  };
  const hasRole = (role: ValidationRole): boolean => commands.some(command => command.role === role);
  const unresolvedProjectRoles = new Set<ValidationRole>();
  const diagnostics: string[] = [];
  let runner: PackageRunner | undefined;
  let runnerEvidence: string | undefined;

  if (fs.exists(packagePath)) {
    try {
      const parsed = JSON.parse(fs.readText(packagePath)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root value is not an object');
      const manifest = parsed as Record<string, unknown>;
      const scripts = manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
        ? manifest.scripts as Record<string, unknown>
        : {};
      const scriptRoles = ROLES.filter((role) => typeof scripts[role] === 'string' && Boolean((scripts[role] as string).trim()));
      const manager = discoverPackageRunner(manifest, root, fs);
      runner = manager.runner;
      runnerEvidence = manager.runnerEvidence;
      if (manager.reason) diagnostics.push(manager.reason);
      if (runner) {
        for (const role of scriptRoles) {
          declareCommand({ ...commandFor(role, runner), evidencePath: packagePath });
        }
      } else {
        scriptRoles.forEach((role) => unresolvedProjectRoles.add(role));
      }
    } catch (error) {
      diagnostics.push(`Cannot parse package.json: ${errorMessage(error)}`);
    }
  }

  if (fs.exists(makefilePath)) {
    try {
      const makefile = fs.readText(makefilePath);
      for (const role of ROLES) {
        if (hasRole(role) || !new RegExp(`^${role}\\s*:(?!=)`, 'm').test(makefile)) continue;
        declareCommand(configuredCommand(role, 'make', [role], makefilePath));
      }
    } catch (error) {
      diagnostics.push(`Cannot read Makefile: ${errorMessage(error)}`);
    }
  }

  if (fs.exists(pyprojectPath)) {
    try {
      const pyproject = fs.readText(pyprojectPath);
      const sections = pyprojectSections(pyproject);
      if (sections.has('build-system')) {
        commands.push(configuredCommand('build', 'python', ['-m', 'build'], pyprojectPath));
      }
      if (([...sections.keys()].some((section) => /^tool\.pytest(?:\.|$)/.test(section))
            || declaresPythonDependency(sections, 'pytest'))) {
        commands.push(configuredCommand('test', 'python', ['-m', 'pytest'], pyprojectPath));
      }
      if (([...sections.keys()].some((section) => /^tool\.ruff(?:\.|$)/.test(section))
            || declaresPythonDependency(sections, 'ruff'))) {
        commands.push(configuredCommand('lint', 'python', ['-m', 'ruff', 'check', '.'], pyprojectPath));
      }
    } catch (error) {
      diagnostics.push(`Cannot read pyproject.toml: ${errorMessage(error)}`);
    }
  }

  // Legacy Python projects declare the runner in INI files. setup.py alone
  // describes packaging, not a test recipe; do not guess one from its presence.
  for (const path of [toxPath, pytestPath]) {
    if (!fs.exists(path)) continue;
    try {
      const text = fs.readText(path);
      if (/^\s*\[testenv(?::[^\]]+)?\]/m.test(text) && /^\s*commands\s*=/m.test(text)) {
        declareCommand(configuredCommand('test', 'tox', [], path));
      } else if (/^\s*\[pytest\]/m.test(text) && !commands.some(command => command.command === 'python' && command.args.join(' ') === '-m pytest')) {
        commands.push(configuredCommand('test', 'python', ['-m', 'pytest'], path));
      }
    } catch (error) { diagnostics.push(`Cannot read ${path}: ${errorMessage(error)}`); }
  }
  const discoveredCommands = ROLES.flatMap(role => commands.filter(command => command.role === role));
  const unresolvedRoles = ROLES.filter((role) => unresolvedProjectRoles.has(role));
  const missingRoles = ROLES.filter((role) => !hasRole(role));
  const state: ValidationDiscovery['state'] = discoveredCommands.length === 0
    ? 'unknown'
    : missingRoles.length === 0 ? 'configured' : 'partial';
  const defaultReason = configPaths.length === 0
    ? 'No recognized Node, Make, or Python validation declarations were found'
    : 'Recognized project configuration declares no inferable build, test, or lint command';
  return {
    discovery: {
      state,
      configPath: configPaths[0] ?? packagePath,
      configPaths,
      ...(runner ? { runner } : {}),
      ...(runnerEvidence ? { runnerEvidence } : {}),
      commands: discoveredCommands,
      missingRoles,
      ...(state === 'unknown' ? { reason: [...diagnostics, defaultReason].join('; ') } : {}),
    },
    projectDeclarations,
    unresolvedProjectRoles: unresolvedRoles,
  };
}

/** Discover validation commands from the repository's Node, Make, and Python declarations. */
export function discoverProjectValidation(
  projectDir: string,
  fs: ValidationFileSystem = nodeValidationFs,
): ValidationDiscovery {
  return discoverProjectValidationDetails(projectDir, fs).discovery;
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
  const details = discoverProjectValidationDetails(projectDir, fs);
  const discovery = details.discovery;
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

  if (details.unresolvedProjectRoles.length > 0) {
    const roles = details.unresolvedProjectRoles.join(', ');
    const briefEvidence = declaredCommands.map((declaration) => declaration.evidencePath).join(', ');
    return unknownReconciliation(
      discovery,
      `Project validation declaration at ${discovery.configPath} has an unresolved command for ${roles}: ${discovery.reason ?? 'the project command cannot be determined'}. Brief validation at ${briefEvidence} cannot replace an unresolved target-owned declaration.`,
    );
  }

  const commands: ValidationCommand[] = [];
  for (const role of ROLES) {
    const projectCommands = discovery.commands.filter(command => command.role === role);
    const projectCommand = projectCommands.find(command => details.projectDeclarations.has(command));
    const declaration = declaredByRole.get(role);
    if (projectCommand && declaration) {
      const matching = projectCommands.find(command => details.projectDeclarations.has(command) && sameArgv(command, declaration));
      if (!matching) {
        const projectEvidence = projectCommand.evidencePath ?? discovery.configPath;
        return unknownReconciliation(
          discovery,
          `Validation command conflict for ${role}: project declaration at ${projectEvidence} specifies ${JSON.stringify(argv(projectCommand))}, but brief declaration at ${declaration.evidencePath} specifies ${JSON.stringify(argv(declaration))}. Project configuration governs; remove the overlapping brief declaration or make its argv exactly agree.`,
        );
      }
      if (declaration.report) matching.report = declaration.report;
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
  if (request.abortSignal?.aborted || (request.timeoutMs !== undefined && request.timeoutMs <= 0)) return { exitCode: null, error: 'Validation refused: enclosing stage deadline or control abort', durationMs: 0 };
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
  const stderrDecoder = new TextDecoder('utf-8', { fatal: true });
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
  let timeoutMs = 45 * 60 * 1000;
  try {
    const configured = loadEngineDefaults().validation_timeout_ms;
    if (Number.isFinite(configured) && configured > 0) timeoutMs = configured;
  } catch { /* retain the built-in bound if engine configuration is unavailable */ }
  if (request.timeoutMs !== undefined) timeoutMs = Math.min(timeoutMs, Math.max(1, request.timeoutMs));
  const onAbort = () => stop();
  request.abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (request.abortSignal?.aborted) onAbort();
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  timeout.unref();
  const settle = (exitCode: number | null, signal?: NodeJS.Signals | null, error?: string): void => {
    if (settled) return;
    settled = true;
    activity?.close();
    clearTimeout(timeout);
    request.abortSignal?.removeEventListener('abort', onAbort);
    resolveResult({
      exitCode,
      stdout,
      stderr,
      outputBytes,
      ...(outputEncodingError ? { reportError: outputEncodingError } : {}),
      durationMs: Date.now() - started,
      ...(error ? { error } : request.abortSignal?.aborted ? { error: 'Validation cancelled by enclosing stage' } : {}),
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
  });
  return await launch();
  } finally { rmSync(environmentRoot, { recursive: true, force: true }); }
};

/** One dependency recipe supplies execution and baseline identity. */
export function dependencyPreparation(projectDir: string): Array<{
  root: string; manifest: Record<string, unknown>; runner: PackageRunner; inputs: string[];
}> {
  return discoverConfiguredPackages(projectDir).flatMap(({ root, manifest }) => {
    const lockfiles = lockfileEvidence(root, nodeValidationFs).map(item => join(root, item.path));
    if (!lockfiles.length) return [];
    const manager = discoverPackageRunner(manifest, root, nodeValidationFs);
    if (!manager.runner) throw new Error(manager.reason);
    return [{ root, manifest, runner: manager.runner, inputs: [join(root, 'package.json'), ...lockfiles] }];
  });
}

/** This command boundary owns the dependency environment, using current project
 * lockfiles even when validation commands come from the setup ready record.
 * Never infer readiness from an existing dependency directory. */
export const runValidationCommand: ValidationCommandRunner = (request) => withValidationLoad(request, runProjectCommand);

export const runProjectCommand: ValidationCommandRunner = (request) => withEngineIntegrity({
  projectDir: request.cwd, runDir: request.runDir, stageId: '_validation',
}, async () => {
  const started = Date.now();
  const remaining = () => request.timeoutMs === undefined ? undefined : request.timeoutMs - (Date.now() - started);
  if (request.prepareDependencies) {
    try {
      for (const { root, manifest, runner } of dependencyPreparation(request.cwd)) {
        const frozenArgs: Record<PackageRunner, string[]> = {
          npm: ['ci'], pnpm: ['install', '--frozen-lockfile'],
          yarn: ['install', runner === 'yarn' && (manifest.packageManager
            ? !/^yarn@1(?:\.|$)/.test(String(manifest.packageManager))
            : /\b__metadata:/.test(nodeValidationFs.readText(join(root, 'yarn.lock'))))
            ? '--immutable' : '--frozen-lockfile'],
          bun: ['install', '--frozen-lockfile'],
        };
        const args = frozenArgs[runner];
        const display = [runner, ...args].join(' ');
        const response = await executeValidationCommand({ ...request, cwd: root,
          command: runner, args, display, timeoutMs: remaining() });
        if (response.exitCode !== 0 || response.error) return {
          ...response, dependencyPreparationFailed: true, durationMs: Date.now() - started,
          stderr: `Dependency preparation failed: ${display} in ${root}\n${response.stderr ?? ''}`,
        };
      }
    } catch (error) {
      return { exitCode: null, dependencyPreparationFailed: true,
        error: `Dependency preparation refused: ${errorMessage(error)}`, durationMs: Date.now() - started };
    }
  }
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
    } catch (error) { response.reportError = errorMessage(error); }
  }
  return { ...response, durationMs: Date.now() - started };
});

/** No test-output rules. Invalid reporter/model evidence remains unknown. */
function validationOutputBytes(response: ValidationRunResponse): { stdout: number; stderr: number } {
  return { stdout: response.outputBytes?.stdout ?? Buffer.byteLength(response.stdout ?? ''),
    stderr: response.outputBytes?.stderr ?? Buffer.byteLength(response.stderr ?? '') };
}

async function failureFacts(command: ValidationCommand, response: ValidationRunResponse, output: string,
  root: string, dependencies: ProjectValidationDependencies): Promise<IdentityFacts> {
  const failed = response.exitCode !== 0;
  if (response.reportError) return { identifiers: [], owner: 'unknown', reason: `Invalid validation identity evidence: ${response.reportError}` };
  if (command.report) {
    try {
      const bytes = response.report ?? (command.report.path ? undefined : response.stdout);
      if (bytes === undefined || Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('Structured report missing or exceeds 1 MiB');
      const facts = identityFacts(decodeRunnerReport(bytes, command.report.format, root), 'runner-json', failed);
      // A reporter cannot account for diagnostics carried outside its JSON.
      // Withhold completeness using transport metadata, never message spelling.
      const sizes = validationOutputBytes(response);
      const extraOutput = sizes.stderr > 0 || Boolean(command.report.path || response.report !== undefined) && sizes.stdout > 0;
      return failed && facts.owner !== 'unknown' && extraOutput ? { ...facts, evidence: 'partial',
        reason: 'Additional unstructured output is not accounted for by the structured report' } : facts;
    } catch (error) { return { identifiers: [], owner: 'unknown', reason: `Invalid structured report: ${errorMessage(error)}` }; }
  }
  if (!failed) return { identifiers: [], owner: 'unknown' };
  if (!dependencies.readFailureIdentity) return { identifiers: [], owner: 'unknown', reason: 'No structured report or closed-schema model reading is available' };
  const bounded = boundedOutput(output, dependencies.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const truncated = bounded !== output;
  try {
    return identityFacts(await dependencies.readFailureIdentity({ command: command.display,
      exitCode: response.exitCode!, output: bounded, truncated }), 'closed-schema-model', true, truncated);
  } catch (error) { return { identifiers: [], owner: 'unknown', reason: `Invalid model reading: ${errorMessage(error)}` }; }
}

function criterionFor(result: ValidationCommandResult): ValidationGateCriterion {
  if (result.state === 'passed') {
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

/** Run the discovered validation set and record delta-based gate criteria. */
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
  // Nothing discovered and nothing declared leaves the engine without validation for this project, recorded as not
  // configured like a project without a lint command; only an operator declaration that cannot be honoured is unresolved.
  const unresolved = discovery.state === 'unknown' && (declaredCommands?.length ?? 0) > 0;
  let preparation: ValidationRunResponse | undefined;
  let prepared = false;

  for (const command of ROLES.flatMap<ValidationCommand | Pick<ValidationCommand, 'role'>>(role => {
    const configured = discovery.commands.filter(candidate => candidate.role === role);
    return configured.length ? configured : [{ role }];
  })) {
    const role = command.role;
    if (!('display' in command)) {
      results.push({
        role,
        state: unresolved ? 'unresolved' : 'not_configured',
        durationMs: 0,
        output: '',
        failureIdentifiers: [],
        failureIdentity: unresolved ? 'unknown' : 'none',
        reason: discovery.state === 'unknown'
          ? discovery.reason ?? 'Validation baseline is unknown'
          : declaredCommands && declaredCommands.length > 0
            ? `No ${role} command was declared by project configuration or the brief`
            : `No ${role} command was inferred from the recognized project configuration`,
      });
      continue;
    }
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
      response = preparation ?? await runner({ ...command, cwd: root,
        prepareDependencies: !prepared,
        ...(dependencies.remainingMs ? { timeoutMs: dependencies.remainingMs() } : {}),
        ...(dependencies.abortSignal ? { abortSignal: dependencies.abortSignal } : {}) });
    } catch (error) {
      response = { exitCode: null, error: errorMessage(error) };
    }
    // A failed preparation cannot fall through to later commands on stale deps.
    if (response.dependencyPreparationFailed) preparation = response;
    prepared = true;
    const durationMs = response.durationMs ?? Math.max(0, now() - started);
    const rawOutput = [response.stdout, response.stderr]
      .filter((value): value is string => Boolean(value))
      .join('\n');
    const output = boundedOutput(rawOutput, maxOutputBytes);
    const outputBytes = validationOutputBytes(response);
    const measurement = { ...(response.load ? { load: response.load } : {}), measurement: validationMeasurement(response) };
    if (measurement.measurement === 'not_measured') {
      results.push({ role, display: command.display, state: 'not_measured', durationMs, output, outputBytes, ...measurement,
        ...(response.exitCode === null ? {} : { exitCode: response.exitCode }), failureIdentifiers: [], failureIdentity: 'unknown',
        reason: 'Validation not measured: host load exceeded the declared ceiling; neither pass nor failure, no author action required' });
      continue;
    }
    if (response.dependencyPreparationFailed || response.error || response.exitCode === null) {
      results.push({
        role,
        display: command.display,
        state: 'launch_error',
        durationMs,
        output,
        outputBytes,
        ...measurement,
        failureIdentifiers: [],
        failureIdentity: 'unknown',
        exitCode: response.exitCode ?? undefined,
        reason: response.dependencyPreparationFailed && response.exitCode !== null
          ? `Dependency preparation exited with code ${response.exitCode}`
          : response.error ?? 'Validation command ended without an exit code',
      });
      continue;
    }
    if (response.exitCode === 127) {
      results.push({
        role,
        display: command.display,
        state: 'launch_error',
        exitCode: response.exitCode,
        durationMs,
        output,
        outputBytes,
        ...measurement,
        failureIdentifiers: [],
        failureIdentity: 'unknown',
        reason: 'Validation command could not run in the target environment (exit 127)',
      });
      continue;
    }
    const facts = await failureFacts(command, response, rawOutput, root, dependencies);
    const failureIdentity = response.exitCode === 0
      ? 'none'
      : facts.count !== undefined || facts.identifiers.length > 0 ? 'known' : 'unknown';
    results.push({
      role,
      identityOwner: facts.owner,
      ...(facts.failures ? { failures: facts.failures } : {}),
      testsRun: facts.testsRun ?? null,
      display: command.display,
      state: response.exitCode === 0 ? 'passed' : 'failed',
      exitCode: response.exitCode,
      durationMs,
      output,
      outputBytes,
      ...measurement,
      ...(facts.count === undefined ? {} : { failureCount: facts.count }),
      failureIdentifiers: facts.identifiers,
      failureIdentity,
      ...(failureIdentity === 'known' ? { failureEvidence: facts.evidence ?? 'complete' } : {}),
      ...(facts.reason === undefined ? {} : { reason: facts.reason }),
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
  return validationMeasurement(result) === 'not_measured' || (result.state === FAILED_VALIDATION_STATE || result.state === 'launch_error') && result.failureIdentity === 'unknown';
}

export function evaluateValidationDelta(
  baseline: ProjectValidationBaseline,
  current: ValidationCommandResult[],
): ValidationDeltaResult[] {
  return baseline.results.map((prior): ValidationDeltaResult => {
    const siblings = baseline.results.filter(result => result.role === prior.role);
    const next = current.find(result => result.role === prior.role && (siblings.length === 1 || result.display === prior.display));
    if (!next) return { role: prior.role, state: 'unresolved', reason: 'Current validation result is missing', newFailureIdentifiers: [] };
    if (validationMeasurement(prior) === 'not_measured' || validationMeasurement(next) === 'not_measured') return {
      role: prior.role, state: 'not_measured', reason: 'Validation not measured: host load exceeded the declared ceiling; neither pass nor failure, no author action required', newFailureIdentifiers: [],
    };
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
      // Nothing was ever measured for this role, so nothing can regress; treating it as
      // unresolved made every gate on a build-less/lint-less project unpassable.
      return { role: prior.role, state: 'pass', reason: 'Role is not configured in the baseline or now', newFailureIdentifiers: [] };
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
  }).map((result, index) => ({ ...result, ...(baseline.results[index].display ? { display: baseline.results[index].display } : {}) }));
}
