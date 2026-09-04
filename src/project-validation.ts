import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTapOutput } from './tap-output.js';
import { loadProjectDefaults } from './config.js';

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

export interface ValidationCommand {
  role: ValidationRole;
  command: string;
  args: string[];
  display: string;
  evidencePath?: string;
  provenance?: ValidationCommandProvenance;
}

export interface BriefValidationCommand {
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
  cwd: string;
  observer?: ValidationProgressObserver;
}

export interface ValidationProgressObserver {
  onCommandStart?: (command: ValidationCommand) => void;
  onCommandOutput?: (command: ValidationCommand, stream: 'stdout' | 'stderr', chunk: string) => void;
  onCommandHeartbeat?: (command: ValidationCommand, elapsedMs: number) => void;
  onCommandFinish?: (command: ValidationCommand, response: ValidationRunResponse) => void;
}

export interface ValidationRunResponse {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs?: number;
}

export type ValidationCommandRunner = (
  request: ValidationRunRequest,
) => Promise<ValidationRunResponse> | ValidationRunResponse;

export interface ValidationCommandResult {
  role: ValidationRole;
  display?: string;
  state: 'passed' | 'failed' | 'launch_error' | 'not_configured' | 'unresolved';
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
  fs?: ValidationFileSystem;
  runCommand?: ValidationCommandRunner;
  declaredCommands?: readonly BriefValidationCommand[];
  now?: () => number;
  maxOutputBytes?: number;
  observer?: ValidationProgressObserver;
  skipExecution?: boolean;
}

export interface ValidationDeltaResult {
  role: ValidationRole;
  state: 'pass' | 'regression' | 'unresolved';
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function commandFor(role: ValidationRole, runner: PackageRunner): ValidationCommand {
  const args = ['run', role];
  return { role, command: runner, args, display: `${runner} ${args.join(' ')}` };
}

function inferredCommand(
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
  const configPaths = [packagePath, makefilePath, pyprojectPath].filter((path) => fs.exists(path));
  const commands = new Map<ValidationRole, ValidationCommand>();
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
      const declaredRunner = packageRunnerFromField(manifest.packageManager);
      const locks = lockfileEvidence(root, fs);
      const lockRunners = [...new Set(locks.map((entry) => entry.runner))];
      if (declaredRunner) {
        runner = declaredRunner;
        runnerEvidence = `package.json packageManager=${String(manifest.packageManager)}`;
      } else if (lockRunners.length === 1) {
        runner = lockRunners[0];
        runnerEvidence = locks.filter((entry) => entry.runner === runner).map((entry) => entry.path).join(', ');
      } else {
        diagnostics.push(lockRunners.length > 1
          ? `Package-manager lockfiles disagree: ${locks.map((entry) => entry.path).join(', ')}`
          : 'No packageManager field or recognized lockfile identifies the package runner');
      }
      if (runner) {
        for (const role of scriptRoles) {
          commands.set(role, { ...commandFor(role, runner), evidencePath: packagePath });
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
        if (commands.has(role) || !new RegExp(`^${role}\\s*:(?!=)`, 'm').test(makefile)) continue;
        commands.set(role, inferredCommand(role, 'make', [role], makefilePath));
      }
    } catch (error) {
      diagnostics.push(`Cannot read Makefile: ${errorMessage(error)}`);
    }
  }

  if (fs.exists(pyprojectPath)) {
    try {
      const pyproject = fs.readText(pyprojectPath);
      const sections = pyprojectSections(pyproject);
      if (!commands.has('build') && sections.has('build-system')) {
        commands.set('build', inferredCommand('build', 'python', ['-m', 'build'], pyprojectPath));
      }
      if (!commands.has('test')
          && ([...sections.keys()].some((section) => /^tool\.pytest(?:\.|$)/.test(section))
            || declaresPythonDependency(sections, 'pytest'))) {
        commands.set('test', inferredCommand('test', 'python', ['-m', 'pytest'], pyprojectPath));
      }
      if (!commands.has('lint')
          && ([...sections.keys()].some((section) => /^tool\.ruff(?:\.|$)/.test(section))
            || declaresPythonDependency(sections, 'ruff'))) {
        commands.set('lint', inferredCommand('lint', 'python', ['-m', 'ruff', 'check', '.'], pyprojectPath));
      }
    } catch (error) {
      diagnostics.push(`Cannot read pyproject.toml: ${errorMessage(error)}`);
    }
  }

  const discoveredCommands = ROLES.flatMap((role) => {
    const command = commands.get(role);
    return command ? [command] : [];
  });
  const unresolvedRoles = ROLES.filter((role) => unresolvedProjectRoles.has(role));
  const missingRoles = ROLES.filter((role) => !commands.has(role));
  const state: ValidationDiscovery['state'] = discoveredCommands.length === 0
    ? 'unknown'
    : missingRoles.length === 0 ? 'configured' : 'partial';
  const defaultReason = configPaths.length === 0
    ? 'No recognized package.json, Makefile, or pyproject.toml validation declarations were found'
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
 * Project commands govern; brief commands fill gaps, exact overlap corroborates,
 * and disagreement makes the whole baseline unknown before anything executes.
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

  const projectByRole = new Map(discovery.commands.map((command) => [command.role, command]));
  const commands: ValidationCommand[] = [];
  for (const role of ROLES) {
    const projectCommand = projectByRole.get(role);
    const declaration = declaredByRole.get(role);
    if (projectCommand && declaration) {
      if (!sameArgv(projectCommand, declaration)) {
        const projectEvidence = projectCommand.evidencePath ?? discovery.configPath;
        return unknownReconciliation(
          discovery,
          `Validation command conflict for ${role}: project declaration at ${projectEvidence} specifies ${JSON.stringify(argv(projectCommand))}, but brief declaration at ${declaration.evidencePath} specifies ${JSON.stringify(argv(declaration))}. Project configuration governs; remove the overlapping brief declaration or make its argv exactly agree.`,
        );
      }
      const projectEvidence = projectCommand.evidencePath ?? discovery.configPath;
      commands.push({
        ...projectCommand,
        provenance: {
          source: 'project',
          evidencePath: projectEvidence,
          corroboratedBy: [declaration.evidencePath],
        },
      });
      continue;
    }
    if (projectCommand) {
      commands.push(projectCommand);
      continue;
    }
    if (declaration) {
      commands.push({
        role,
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

export const runValidationCommand: ValidationCommandRunner = (request) => new Promise((resolveResult) => {
  const started = Date.now();
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timedOut = false;
  // A project's suite grows as rounds add tests, and ship-setup runs it twice.
  // Hardcoding this meant the refusal named the timeout while the cause was the
  // suite's size plus whatever else the machine was doing.
  let timeoutMs = 45 * 60 * 1000;
  try {
    const configured = loadProjectDefaults(request.cwd).validation_timeout_ms;
    if (Number.isFinite(configured) && configured > 0) timeoutMs = configured;
  } catch { /* fall back to the built-in when the project has no defaults file */ }
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  timeout.unref();
  const heartbeat = setInterval(() => {
    try { request.observer?.onCommandHeartbeat?.(request, Date.now() - started); } catch { /* display callbacks cannot change validation */ }
  }, 10_000);
  heartbeat.unref();
  const settle = (exitCode: number | null, signal?: NodeJS.Signals | null, error?: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearInterval(heartbeat);
    resolveResult({
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      ...(error ? { error } : {}),
      ...(!error && timedOut ? { error: `Validation command timed out after ${timeoutMs}ms` } : {}),
      ...(!error && !timedOut && signal ? { error: `Validation process ended by signal ${signal}` } : {}),
    });
  };
  child.stdout?.on('data', (chunk: Buffer | string) => {
    const value = chunk.toString();
    stdout = boundedOutput(stdout + value, 256 * 1024);
    try { request.observer?.onCommandOutput?.(request, 'stdout', value); } catch { /* display callbacks cannot change validation */ }
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    const value = chunk.toString();
    stderr = boundedOutput(stderr + value, 256 * 1024);
    try { request.observer?.onCommandOutput?.(request, 'stderr', value); } catch { /* display callbacks cannot change validation */ }
  });
  child.once('error', (error) => { settle(null, null, error.message); });
  child.once('close', (code, signal) => {
    settle(code, signal);
  });
});

interface FailureFacts {
  count?: number;
  identifiers: string[];
  evidence?: FailureEvidence;
  reason?: string;
}

function legacyFailureFacts(output: string): { count?: number; identifiers: string[] } {
  const identifiers = new Set<string>();
  const lines = output.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    let match = /^(?:FAIL|FAILED)\s+([^\s].*)$/i.exec(line);
    if (match) identifiers.add(match[1].replace(/\s+\[.*$/, '').trim());
    match = /^(?:×|✗|✘)\s+(.+)$/.exec(line);
    if (match) identifiers.add(match[1].replace(/\s+\d+ms$/, '').trim());
    match = /^(.+?\.(?:[cm]?[jt]sx?|json))(?::\d+(?::\d+)?|\(\d+,\d+\))\s*[-:]?\s*error\s+(TS\d+)?/i.exec(line);
    if (match) identifiers.add(`${match[1]}${match[2] ? ` ${match[2]}` : ''}`);
    if (identifiers.size >= 100) break;
  }
  const terminalPytestCount = [...lines].reverse().flatMap((raw) => {
    const line = raw.trim();
    if (!/\bin\s+\d+(?:\.\d+)?s(?:\s|=|$)/i.test(line)) return [];
    const match = /\b(\d+)\s+failed\b/i.exec(line);
    return match ? [Number(match[1])] : [];
  }).find((value) => Number.isSafeInteger(value) && value > 0);
  const countPatterns = [
    /\bTests?\s+(\d+)\s+failed\b/i,
    /\b(\d+)\s+fail(?:ed|ing|ures?)\b/i,
    /\b(\d+)\s+errors?\b/i,
  ];
  const lastReportedCount = [...lines].reverse().flatMap((line) => countPatterns.flatMap((pattern) => {
    const match = pattern.exec(line);
    return match ? [Number(match[1])] : [];
  })).find((value) => Number.isSafeInteger(value) && value > 0);
  const count = terminalPytestCount ?? lastReportedCount ?? (identifiers.size > 0 ? identifiers.size : undefined);
  return { count, identifiers: [...identifiers].sort() };
}

function failureFacts(output: string): FailureFacts {
  if (output.trim().length === 0) {
    return {
      identifiers: [],
      reason: 'Failure identity is unavailable because the validation command produced no output',
    };
  }

  const tap = parseTapOutput(output);
  if (tap.state === 'complete') {
    const failed = tap.records
      .filter((record) => record.status === 'not_ok' && record.directive === undefined);
    if (failed.length === 0) {
      return {
        identifiers: [],
        reason: 'Failure identity is unavailable because complete TAP reported no failing top-level records despite the nonzero exit',
      };
    }
    return {
      count: tap.failureCount,
      identifiers: [...new Set(failed.map((record) => record.name))],
      evidence: 'complete',
    };
  }
  if (tap.state === 'invalid') {
    const legacy = legacyFailureFacts(output);
    if (legacy.count !== undefined || legacy.identifiers.length > 0) {
      return {
        ...legacy,
        evidence: tap.cause === 'truncated' ? 'partial' : 'complete',
        reason: tap.cause === 'truncated'
          ? `Failure identity was recovered from retained lines as partial evidence because validation output was truncated before structural TAP parsing: ${tap.reason}`
          : `Failure identity was recovered from line-oriented output after structural TAP parsing could not conclude: ${tap.reason}`,
      };
    }
    return {
      identifiers: [],
      reason: tap.cause === 'truncated'
        ? `Failure identity is unavailable because validation output was truncated before parsing: ${tap.reason}`
        : `Failure identity is unavailable because TAP output is structurally incomplete or inconsistent: ${tap.reason}`,
    };
  }

  const legacy = legacyFailureFacts(output);
  if (legacy.count !== undefined || legacy.identifiers.length > 0) {
    return { ...legacy, evidence: 'complete' };
  }
  return {
    identifiers: [],
    reason: 'Failure identity is unavailable because the non-TAP output format is not recognized',
  };
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
        : `${result.role} failed at baseline, but its failing identity/count could not be parsed; a later failure is unresolved, never treated as zero. ${result.reason ?? 'Failure identification did not record a cause'}`,
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
  const now = dependencies.now ?? Date.now;
  const maxOutputBytes = dependencies.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const declaredCommands = dependencies.declaredCommands;
  const discovery = declaredCommands === undefined
    ? discoverProjectValidation(root, fs)
    : reconcileProjectValidation(root, declaredCommands, fs);
  const results: ValidationCommandResult[] = [];

  for (const role of ROLES) {
    const command = discovery.commands.find((candidate) => candidate.role === role);
    if (!command) {
      results.push({
        role,
        state: discovery.state === 'unknown' ? 'unresolved' : 'not_configured',
        durationMs: 0,
        output: '',
        failureIdentifiers: [],
        failureIdentity: discovery.state === 'unknown' ? 'unknown' : 'none',
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
        reason: 'Baseline execution was skipped by operator request (--no-baseline)',
      });
      continue;
    }
    const started = now();
    let response: ValidationRunResponse;
    try { dependencies.observer?.onCommandStart?.(command); } catch { /* display callbacks cannot change validation */ }
    try {
      response = await runner({ ...command, cwd: root, observer: dependencies.observer });
    } catch (error) {
      response = { exitCode: null, error: errorMessage(error) };
    }
    try { dependencies.observer?.onCommandFinish?.(command, response); } catch { /* display callbacks cannot change validation */ }
    const durationMs = response.durationMs ?? Math.max(0, now() - started);
    const rawOutput = [response.stdout, response.stderr]
      .filter((value): value is string => Boolean(value))
      .join('\n');
    const output = boundedOutput(rawOutput, maxOutputBytes);
    if (response.error || response.exitCode === null) {
      results.push({
        role,
        display: command.display,
        state: 'launch_error',
        durationMs,
        output,
        failureIdentifiers: [],
        failureIdentity: 'unknown',
        reason: response.error ?? 'Validation command ended without an exit code',
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
        failureIdentifiers: [],
        failureIdentity: 'unknown',
        reason: 'Validation command could not run in the target environment (exit 127)',
      });
      continue;
    }
    const facts: FailureFacts = response.exitCode === 0 ? { identifiers: [] } : failureFacts(rawOutput);
    const failureIdentity = response.exitCode === 0
      ? 'none'
      : facts.count !== undefined || facts.identifiers.length > 0 ? 'known' : 'unknown';
    results.push({
      role,
      display: command.display,
      state: response.exitCode === 0 ? 'passed' : 'failed',
      exitCode: response.exitCode,
      durationMs,
      output,
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
    gateCriteria: results.map(criterionFor),
  };
}

/** Compare a later validation result with its recorded baseline, never assuming unknown means zero. */
export function evaluateValidationDelta(
  baseline: ProjectValidationBaseline,
  current: ValidationCommandResult[],
): ValidationDeltaResult[] {
  return baseline.results.map((prior): ValidationDeltaResult => {
    const next = current.find((result) => result.role === prior.role);
    if (!next) return { role: prior.role, state: 'unresolved', reason: 'Current validation result is missing', newFailureIdentifiers: [] };
    if (prior.state === 'passed') {
      return next.state === 'passed'
        ? { role: prior.role, state: 'pass', reason: 'Green baseline remains green', newFailureIdentifiers: [] }
        : { role: prior.role, state: 'regression', reason: 'A green baseline no longer passes', newFailureIdentifiers: next.failureIdentifiers };
    }
    if (prior.state !== FAILED_VALIDATION_STATE) {
      return { role: prior.role, state: 'unresolved', reason: 'Baseline was not executable/configured', newFailureIdentifiers: [] };
    }
    if (next.state === 'passed') {
      return { role: prior.role, state: 'pass', reason: 'The red baseline improved to green', newFailureIdentifiers: [] };
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
  });
}
