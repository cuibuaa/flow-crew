import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type ValidationRole = 'build' | 'test' | 'lint';
export type PackageRunner = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface ValidationFileSystem {
  exists(path: string): boolean;
  readText(path: string): string;
}

export interface ValidationCommand {
  role: ValidationRole;
  command: string;
  args: string[];
  display: string;
  evidencePath?: string;
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
  reason?: string;
}

export interface ValidationGateCriterion {
  role: ValidationRole;
  rule: 'must_remain_green' | 'no_regression_from_baseline' | 'baseline_unresolved' | 'not_configured';
  baselineFailureCount?: number;
  baselineFailureIdentifiers: string[];
  description: string;
}

export interface ProjectValidationBaseline {
  version: 1;
  projectDir: string;
  discovery: ValidationDiscovery;
  results: ValidationCommandResult[];
  gateCriteria: ValidationGateCriterion[];
}

export interface ProjectValidationDependencies {
  fs?: ValidationFileSystem;
  runCommand?: ValidationCommandRunner;
  now?: () => number;
  maxOutputBytes?: number;
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

/** Discover validation commands from the repository's Node, Make, and Python declarations. */
export function discoverProjectValidation(
  projectDir: string,
  fs: ValidationFileSystem = nodeValidationFs,
): ValidationDiscovery {
  const root = resolve(projectDir);
  const packagePath = join(root, 'package.json');
  const makefilePath = join(root, 'Makefile');
  const pyprojectPath = join(root, 'pyproject.toml');
  const configPaths = [packagePath, makefilePath, pyprojectPath].filter((path) => fs.exists(path));
  const commands = new Map<ValidationRole, ValidationCommand>();
  const diagnostics: string[] = [];
  let runner: PackageRunner | undefined;
  let runnerEvidence: string | undefined;

  if (fs.exists(packagePath)) {
    try {
      const parsed = JSON.parse(fs.readText(packagePath)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root value is not an object');
      const manifest = parsed as Record<string, unknown>;
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
        const scripts = manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
          ? manifest.scripts as Record<string, unknown>
          : {};
        for (const role of ROLES) {
          if (typeof scripts[role] !== 'string' || !(scripts[role] as string).trim()) continue;
          commands.set(role, { ...commandFor(role, runner), evidencePath: packagePath });
        }
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
  const missingRoles = ROLES.filter((role) => !commands.has(role));
  const state: ValidationDiscovery['state'] = discoveredCommands.length === 0
    ? 'unknown'
    : missingRoles.length === 0 ? 'configured' : 'partial';
  const defaultReason = configPaths.length === 0
    ? 'No recognized package.json, Makefile, or pyproject.toml validation declarations were found'
    : 'Recognized project configuration declares no inferable build, test, or lint command';
  return {
    state,
    configPath: configPaths[0] ?? packagePath,
    configPaths,
    ...(runner ? { runner } : {}),
    ...(runnerEvidence ? { runnerEvidence } : {}),
    commands: discoveredCommands,
    missingRoles,
    ...(state === 'unknown' ? { reason: [...diagnostics, defaultReason].join('; ') } : {}),
  };
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
    timeout: 15 * 60 * 1000,
  });
  let stdout = '';
  let stderr = '';
  let launchError: string | undefined;
  let settled = false;
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout = boundedOutput(stdout + chunk.toString(), 256 * 1024);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = boundedOutput(stderr + chunk.toString(), 256 * 1024);
  });
  child.once('error', (error) => { launchError = error.message; });
  child.once('close', (code, signal) => {
    if (settled) return;
    settled = true;
    resolveResult({
      exitCode: code,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      ...(launchError ? { error: launchError } : {}),
      ...(!launchError && signal ? { error: `Validation process ended by signal ${signal}` } : {}),
    });
  });
});

function failureFacts(output: string): { count?: number; identifiers: string[] } {
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
  const countPatterns = [
    /\bTests?\s+(\d+)\s+failed\b/i,
    /\b(\d+)\s+fail(?:ed|ing|ures?)\b/i,
    /\b(\d+)\s+errors?\b/i,
  ];
  const counts = countPatterns.flatMap((pattern) => {
    const match = pattern.exec(output);
    return match ? [Number(match[1])] : [];
  }).filter((value) => Number.isSafeInteger(value) && value > 0);
  const count = counts.length > 0 ? Math.max(...counts) : identifiers.size > 0 ? identifiers.size : undefined;
  return { count, identifiers: [...identifiers].sort() };
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
    return {
      role: result.role,
      rule: 'no_regression_from_baseline',
      ...(result.failureCount === undefined ? {} : { baselineFailureCount: result.failureCount }),
      baselineFailureIdentifiers: result.failureIdentifiers,
      description: result.failureIdentity === 'known'
        ? `${result.role} may improve, but may not add a failing identifier or exceed the baseline failure count`
        : `${result.role} failed at baseline, but its failing identity/count could not be parsed; a later failure is unresolved, never treated as zero`,
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
  const discovery = discoverProjectValidation(root, fs);
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
          : `No ${role} command was inferred from the recognized project configuration`,
      });
      continue;
    }
    const started = now();
    let response: ValidationRunResponse;
    try {
      response = await runner({ ...command, cwd: root });
    } catch (error) {
      response = { exitCode: null, error: errorMessage(error) };
    }
    const durationMs = response.durationMs ?? Math.max(0, now() - started);
    const output = boundedOutput(
      [response.stdout, response.stderr].filter((value): value is string => Boolean(value)).join('\n'),
      maxOutputBytes,
    );
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
    const facts = response.exitCode === 0 ? { identifiers: [] as string[] } : failureFacts(output);
    results.push({
      role,
      display: command.display,
      state: response.exitCode === 0 ? 'passed' : 'failed',
      exitCode: response.exitCode,
      durationMs,
      output,
      ...(facts.count === undefined ? {} : { failureCount: facts.count }),
      failureIdentifiers: facts.identifiers,
      failureIdentity: response.exitCode === 0 ? 'none' : facts.count !== undefined || facts.identifiers.length > 0 ? 'known' : 'unknown',
    });
  }

  return {
    version: 1,
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
