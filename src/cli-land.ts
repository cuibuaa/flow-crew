import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  fcGlobalDir,
  isTerminalRunStatus,
  type StoreState,
} from './store.js';

type Writer = { write(chunk: string): unknown };

export interface LandGitRequest {
  command: 'git';
  args: string[];
  cwd: string;
  operation:
    | 'status'
    | 'ignored'
    | 'unpushed'
    | 'root'
    | 'worktrees'
    | 'branch'
    | 'remove_worktree'
    | 'prune_worktrees'
    | 'delete_branch';
}

export interface LandGitResponse {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type LandGitRunner = (
  request: LandGitRequest,
) => Promise<LandGitResponse> | LandGitResponse;

export interface LandFileSystem {
  exists(path: string): boolean;
  readBytes?(path: string): Uint8Array;
  readText(path: string): string;
  readLink(path: string): string;
  realpath(path: string): string;
  stat(path: string): { isDirectory(): boolean; isFile(): boolean };
  lstat(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  };
}

export interface LandDependencies {
  fs?: LandFileSystem;
  git?: LandGitRunner;
  globalDir?: () => string;
  stdout?: Writer;
  stderr?: Writer;
}

interface ResolvedLandDependencies {
  fs: LandFileSystem;
  git: LandGitRunner;
  globalDir: () => string;
  stdout: Writer;
  stderr: Writer;
}

export interface ParsedLandArgs {
  help: boolean;
  json: boolean;
  remove: boolean;
  run?: string;
}

export interface LandTerminalArtifact {
  status: string;
  path: string;
  projectPath?: string;
  snapshotPath?: string;
  projectPresent: boolean;
  snapshotPresent: boolean;
  present: boolean;
  reason?: string;
}

export interface LandTrackedChange {
  code: string;
  path: string;
  originalPath?: string;
}

export type LandInventoryOrigin = 'untracked' | 'ignored';
export type LandEnumeratedGrade = 'source' | 'data_or_state' | 'symlink' | 'unknown';
export type LandRegenerableGrade = 'build_output' | 'installed_dependency';
export type LandInventoryGrade = LandEnumeratedGrade | LandRegenerableGrade;
export type LandInventoryKind = 'file' | 'directory' | 'symlink' | 'other' | 'missing';

export interface LandEnumeratedItem {
  origin: LandInventoryOrigin;
  path: string;
  grade: LandEnumeratedGrade;
  kind: LandInventoryKind;
  linkTarget?: string;
}

export interface LandRegenerableSummary {
  grade: LandRegenerableGrade;
  count: number;
  origins: Record<LandInventoryOrigin, number>;
}

export interface LandInventory {
  tracked: LandTrackedChange[];
  enumerated: LandEnumeratedItem[];
  regenerable: {
    buildOutputs: LandRegenerableSummary;
    installedDependencies: LandRegenerableSummary;
  };
  gradeCounts: Record<LandInventoryGrade, number>;
  rawPathCounts: Record<LandInventoryOrigin, number>;
  unpushedCommits: string[];
}

export interface LandInspectionIssue {
  operation: LandGitRequest['operation'] | 'state' | 'project' | 'artifact' | 'path';
  reason: string;
}

export interface LandRemovalStep {
  operation: 'remove_worktree' | 'prune_worktrees' | 'delete_branch';
  exitCode: number | null;
  error?: string;
}

export interface LandReport {
  version: 1;
  state: 'audit' | 'refused' | 'removed' | 'removal_failed';
  runId: string;
  runDir: string;
  projectDir: string;
  status: string;
  terminal: boolean;
  artifacts: LandTerminalArtifact[];
  inventory: LandInventory;
  inspectionIssues: LandInspectionIssue[];
  removalRequested: boolean;
  readyForRemoval: boolean;
  refusalReasons: string[];
  branch?: string;
  primaryWorktree?: string;
  removalSteps?: LandRemovalStep[];
}

const nodeLandFileSystem: LandFileSystem = {
  exists: existsSync,
  readBytes: (path) => readFileSync(path),
  readText: (path) => readFileSync(path, 'utf-8'),
  readLink: (path) => readlinkSync(path),
  realpath: (path) => realpathSync.native(path),
  stat: (path) => statSync(path),
  lstat: (path) => lstatSync(path),
};

export interface LandOutputCapture {
  append(chunk: Buffer | string): void;
  finish(): { value: string; complete: boolean; maximum: number };
}

const GIT_STDOUT_MAX_BYTES = 64 * 1024 * 1024;
const GIT_STDERR_MAX_BYTES = 8 * 1024 * 1024;

/** Preserve complete command output up to a declared limit; never return a misleading tail. */
export function createLandOutputCapture(maximum = GIT_STDOUT_MAX_BYTES): LandOutputCapture {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error('land output capture maximum must be a positive safe integer');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  let complete = true;
  return {
    append(chunk): void {
      if (!complete) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8');
      if (length + bytes.length > maximum) {
        complete = false;
        chunks.length = 0;
        length = 0;
        return;
      }
      chunks.push(bytes);
      length += bytes.length;
    },
    finish(): { value: string; complete: boolean; maximum: number } {
      return {
        value: complete ? Buffer.concat(chunks, length).toString('utf-8') : '',
        complete,
        maximum,
      };
    },
  };
}

const runLandGit: LandGitRunner = (request) => new Promise((settle) => {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5 * 60 * 1_000,
  });
  const stdoutCapture = createLandOutputCapture();
  const stderrCapture = createLandOutputCapture(GIT_STDERR_MAX_BYTES);
  let launchError: string | undefined;
  let settled = false;
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdoutCapture.append(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrCapture.append(chunk);
  });
  child.once('error', (error) => {
    launchError = error.message;
  });
  child.once('close', (code, signal) => {
    if (settled) return;
    settled = true;
    const stdout = stdoutCapture.finish();
    const stderr = stderrCapture.finish();
    const captureError = !stdout.complete
      ? `Git stdout exceeded ${stdout.maximum} bytes; inspection output is incomplete`
      : !stderr.complete
        ? `Git stderr exceeded ${stderr.maximum} bytes; inspection output is incomplete`
        : undefined;
    settle({
      exitCode: code,
      stdout: stdout.value,
      stderr: stderr.value,
      ...(launchError || captureError ? { error: launchError ?? captureError } : {}),
      ...(!launchError && !captureError && signal ? { error: `Git ended by signal ${signal}` } : {}),
    });
  });
});

function resolveDependencies(overrides: LandDependencies): ResolvedLandDependencies {
  return {
    fs: overrides.fs ?? nodeLandFileSystem,
    git: overrides.git ?? runLandGit,
    globalDir: overrides.globalDir ?? fcGlobalDir,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function optionValue(args: string[], index: number, option: string): { value: string; consumed: number } {
  const argument = args[index];
  const prefix = `${option}=`;
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length);
    if (!value) throw new Error(`${option} requires a value`);
    return { value, consumed: 1 };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return { value, consumed: 2 };
}

export function parseLandArgs(args: string[]): ParsedLandArgs {
  const parsed: ParsedLandArgs = { help: false, json: false, remove: false };
  let runSeen = false;
  const start = args[0] === 'land' ? 1 : 0;
  for (let index = start; index < args.length;) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      index += 1;
      continue;
    }
    if (argument === '--json') {
      parsed.json = true;
      index += 1;
      continue;
    }
    if (argument === '--remove') {
      parsed.remove = true;
      index += 1;
      continue;
    }
    if (argument === '--run' || argument.startsWith('--run=')) {
      if (runSeen) throw new Error('--run may be specified only once');
      const value = optionValue(args, index, '--run');
      parsed.run = value.value;
      runSeen = true;
      index += value.consumed;
      continue;
    }
    throw new Error(`unknown land option: ${argument}`);
  }
  if (!parsed.help && !parsed.run) throw new Error('--run is required');
  return parsed;
}

export function landUsage(): string {
  return [
    'Usage: flowcrew land --run <run-id> [--remove] [--json]',
    'Audits terminal artifacts and all unique worktree state; proven-regenerable paths are counted, everything else is named.',
    '--remove stays fail-closed until the complete ungraded inventory is empty.',
  ].join('\n');
}

function runDirectory(globalRoot: string, runId: string): string {
  if (!runId || runId === '.' || runId === '..' || basename(runId) !== runId) {
    throw new Error(`invalid run id: ${runId || '(empty)'}`);
  }
  const root = resolve(globalRoot, 'runs');
  const candidate = resolve(root, runId);
  if (!within(root, candidate)) throw new Error(`run id escapes the FlowCrew runs root: ${runId}`);
  return candidate;
}

function readRunState(runDir: string, fs: LandFileSystem): StoreState {
  const statePath = join(runDir, 'run.json');
  if (!fs.exists(statePath)) throw new Error(`run state does not exist: ${statePath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readText(statePath));
  } catch (error) {
    throw new Error(`cannot read run state ${statePath}: ${errorMessage(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`run state is not an object: ${statePath}`);
  const state = parsed as Partial<StoreState>;
  if (typeof state.runId !== 'string' || typeof state.projectDir !== 'string' || typeof state.status !== 'string') {
    throw new Error(`run state lacks string runId, projectDir, or status: ${statePath}`);
  }
  return parsed as StoreState;
}

function safeExistingPath(
  root: string,
  candidate: string,
  fs: LandFileSystem,
): { safe: boolean; present: boolean; canonical?: string; reason?: string } {
  const rootResolved = resolve(root);
  const target = resolve(candidate);
  if (!within(rootResolved, target)) {
    return { safe: false, present: false, reason: 'declared path escapes its allowed root' };
  }
  if (!fs.exists(target)) return { safe: true, present: false };
  try {
    const canonicalRoot = fs.realpath(rootResolved);
    const canonical = fs.realpath(target);
    if (!within(canonicalRoot, canonical)) {
      return { safe: false, present: false, reason: 'declared path resolves outside its allowed root' };
    }
    return { safe: true, present: true, canonical };
  } catch (error) {
    return { safe: false, present: false, reason: `cannot canonicalize path: ${errorMessage(error)}` };
  }
}

function terminalArtifacts(
  state: StoreState,
  projectDir: string,
  runDir: string,
  fs: LandFileSystem,
): LandTerminalArtifact[] {
  const paths = state.terminalStates?.[state.status]?.paths ?? [];
  return paths.map((path) => {
    if (!path || isAbsolute(path)) {
      return {
        status: state.status,
        path,
        projectPresent: false,
        snapshotPresent: false,
        present: false,
        reason: 'terminal artifact paths must be non-empty and project-relative',
      };
    }
    const projectPath = resolve(projectDir, path);
    const snapshotPath = join(runDir, `terminal_${basename(path)}`);
    const project = safeExistingPath(projectDir, projectPath, fs);
    const snapshot = safeExistingPath(runDir, snapshotPath, fs);
    const reasons = [project.reason, snapshot.reason].filter((item): item is string => Boolean(item));
    return {
      status: state.status,
      path,
      projectPath,
      snapshotPath,
      projectPresent: project.present,
      snapshotPresent: snapshot.present,
      present: project.present || snapshot.present,
      ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
    };
  });
}

function gitFailure(request: LandGitRequest, response: LandGitResponse): string {
  const detail = response.error || response.stderr?.trim() || response.stdout?.trim();
  const exit = response.exitCode === null ? 'without an exit code' : `with exit ${response.exitCode}`;
  return `${request.args.join(' ')} failed ${exit}${detail ? `: ${detail}` : ''}`;
}

async function checkedGit(
  request: LandGitRequest,
  git: LandGitRunner,
): Promise<{ ok: true; stdout: string } | { ok: false; issue: LandInspectionIssue }> {
  let response: LandGitResponse;
  try {
    response = await git(request);
  } catch (error) {
    return { ok: false, issue: { operation: request.operation, reason: errorMessage(error) } };
  }
  if (response.exitCode !== 0 || response.error) {
    return { ok: false, issue: { operation: request.operation, reason: gitFailure(request, response) } };
  }
  return { ok: true, stdout: response.stdout ?? '' };
}

/** Parse the NUL form so whitespace, newlines, and rename source paths remain data, never delimiters. */
export function parseGitStatusPorcelain(raw: string): {
  tracked: LandTrackedChange[];
  untracked: string[];
} {
  const records = raw.split('\0');
  const tracked: LandTrackedChange[] = [];
  const untracked: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error(`malformed porcelain status record: ${JSON.stringify(record)}`);
    }
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) throw new Error('porcelain status record has an empty path');
    if (code === '??') {
      untracked.push(path);
      continue;
    }
    if (code === '!!') continue;
    const renamed = /[RC]/.test(code);
    let originalPath: string | undefined;
    if (renamed) {
      originalPath = records[index + 1];
      if (!originalPath) throw new Error(`rename/copy status lacks its original path: ${path}`);
      index += 1;
    }
    tracked.push({ code, path, ...(originalPath ? { originalPath } : {}) });
  }
  return {
    tracked: tracked.sort((left, right) => left.path.localeCompare(right.path)),
    untracked: [...new Set(untracked)].sort(),
  };
}

function nulPaths(raw: string): string[] {
  return [...new Set(raw.split('\0').filter(Boolean))].sort();
}

function unpushedHashes(raw: string): string[] {
  const hashes = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (hashes.some((hash) => !/^[0-9a-f]{7,64}$/i.test(hash))) {
    throw new Error('git rev-list returned a non-object-id record');
  }
  return [...new Set(hashes)];
}

function emptyInventory(): LandInventory {
  return {
    tracked: [],
    enumerated: [],
    regenerable: {
      buildOutputs: {
        grade: 'build_output',
        count: 0,
        origins: { untracked: 0, ignored: 0 },
      },
      installedDependencies: {
        grade: 'installed_dependency',
        count: 0,
        origins: { untracked: 0, ignored: 0 },
      },
    },
    gradeCounts: {
      source: 0,
      data_or_state: 0,
      symlink: 0,
      unknown: 0,
      build_output: 0,
      installed_dependency: 0,
    },
    rawPathCounts: { untracked: 0, ignored: 0 },
    unpushedCommits: [],
  };
}

function inventorySize(inventory: LandInventory): number {
  return inventory.tracked.length
    + inventory.rawPathCounts.untracked
    + inventory.rawPathCounts.ignored
    + inventory.unpushedCommits.length;
}

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|pyi|rb|go|rs|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|cs|swift|scala|sh|bash|zsh|fish|ps1|sql|r|lua|php|ex|exs|erl|hrl|fs|fsx|vue|svelte|css|scss|sass|less|md|mdx|rst|tex)$/i;
const DATA_OR_STATE_EXTENSION = /\.(?:jsonl|ndjson|csv|tsv|parquet|arrow|feather|db|sqlite(?:3)?|pkl|pickle|rds|sav|state|checkpoint|wal|journal|log)$/i;
const BUILD_ROOTS = new Set(['dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.output', 'target']);
const DEPENDENCY_ROOTS = new Set(['node_modules', '.pnpm']);

function pathParts(path: string): string[] {
  return path.replaceAll('\\', '/').split('/').filter(Boolean);
}

function sourceLike(path: string): boolean {
  const name = basename(path);
  return SOURCE_EXTENSION.test(name)
    || /^(?:Makefile|Dockerfile|Containerfile|Justfile)$/i.test(name)
    || /\.(?:ya?ml|toml)$/i.test(name);
}

function dataOrStateLike(path: string): boolean {
  const parts = pathParts(path);
  return parts.includes('.fc')
    || DATA_OR_STATE_EXTENSION.test(basename(path));
}

function sourceCounterpartExists(
  projectDir: string,
  path: string,
  buildRootIndex: number,
  fs: LandFileSystem,
): boolean {
  const parts = pathParts(path);
  const prefix = parts.slice(0, buildRootIndex);
  const output = parts.slice(buildRootIndex + 1).join('/');
  const stem = output
    .replace(/\.d\.[cm]?ts$/i, '')
    .replace(/\.(?:[cm]?js|jsx)$/i, '');
  if (stem === output || !stem) return false;
  const sourceRoot = join(projectDir, ...prefix, 'src');
  return ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
    .some((extension) => fs.exists(join(sourceRoot, `${stem}${extension}`)));
}

function copiedBuildInputMatches(
  projectDir: string,
  path: string,
  buildRootIndex: number,
  fs: LandFileSystem,
): boolean {
  if (!fs.readBytes) return false;
  const parts = pathParts(path);
  const prefix = parts.slice(0, buildRootIndex);
  const output = parts.slice(buildRootIndex + 1);
  const packageRoot = join(projectDir, ...prefix);
  const outputPath = join(projectDir, ...parts);
  let outputBytes: Uint8Array;
  try {
    outputBytes = fs.readBytes(outputPath);
  } catch {
    return false;
  }
  return [join(packageRoot, ...output), join(packageRoot, 'public', ...output)]
    .some((candidate) => {
      if (!fs.exists(candidate)) return false;
      try {
        return Buffer.from(fs.readBytes?.(candidate) ?? []).equals(Buffer.from(outputBytes));
      } catch {
        return false;
      }
    });
}

function viteAssetOutput(
  projectDir: string,
  path: string,
  buildRootIndex: number,
  fs: LandFileSystem,
): boolean {
  const parts = pathParts(path);
  if (parts[buildRootIndex + 1] !== 'assets') return false;
  if (!/^.+-[A-Za-z0-9_-]{8,}\.(?:css|[cm]?js)$/i.test(basename(path))) return false;
  const packageRoot = join(projectDir, ...parts.slice(0, buildRootIndex));
  return ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']
    .some((extension) => fs.exists(join(packageRoot, `vite.config.${extension}`)));
}

function provenBuildOutput(
  projectDir: string,
  path: string,
  kind: LandInventoryKind,
  fs: LandFileSystem,
): boolean {
  if (kind !== 'file') return false;
  const name = basename(path);
  const parts = pathParts(path);
  const buildRootIndex = parts.findIndex((part) => BUILD_ROOTS.has(part));
  if (buildRootIndex < 0) return false;
  if (/\.(?:tsbuildinfo|d\.[cm]?ts\.map|py[co]|class|o|obj|a|lib|so|dylib|dll|exe|wasm|beam|hi)$/i.test(name)) {
    return true;
  }
  if (/\.(?:map|jar|war|whl|gem|crate)$/i.test(name)) {
    return true;
  }
  if (viteAssetOutput(projectDir, path, buildRootIndex, fs)) return true;
  if (copiedBuildInputMatches(projectDir, path, buildRootIndex, fs)) return true;
  if (/\.(?:min|bundle)\.(?:[cm]?js|css)$/i.test(name)) return true;
  if (/\.d\.[cm]?ts$/i.test(name) || /\.(?:[cm]?js|jsx)$/i.test(name)) {
    return sourceCounterpartExists(projectDir, path, buildRootIndex, fs);
  }
  return false;
}

function kindOf(stat: ReturnType<LandFileSystem['lstat']>): LandInventoryKind {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

function gradeInventoryPaths(
  projectDir: string,
  paths: Array<{ origin: LandInventoryOrigin; path: string }>,
  fs: LandFileSystem,
): { inventory: Pick<LandInventory, 'enumerated' | 'regenerable' | 'gradeCounts' | 'rawPathCounts'>; issues: LandInspectionIssue[] } {
  const inventory = emptyInventory();
  const issues: LandInspectionIssue[] = [];

  for (const item of paths) {
    inventory.rawPathCounts[item.origin] += 1;
    const candidate = resolve(projectDir, item.path);
    if (!within(projectDir, candidate)) {
      inventory.enumerated.push({ ...item, grade: 'unknown', kind: 'missing' });
      inventory.gradeCounts.unknown += 1;
      issues.push({ operation: 'path', reason: `${item.origin} ${JSON.stringify(item.path)} escapes the project` });
      continue;
    }

    let kind: LandInventoryKind;
    try {
      kind = kindOf(fs.lstat(candidate));
    } catch (error) {
      inventory.enumerated.push({ ...item, grade: 'unknown', kind: 'missing' });
      inventory.gradeCounts.unknown += 1;
      issues.push({ operation: 'path', reason: `cannot inspect ${item.origin} ${JSON.stringify(item.path)}: ${errorMessage(error)}` });
      continue;
    }

    if (kind === 'symlink') {
      try {
        const linkTarget = fs.readLink(candidate);
        inventory.enumerated.push({ ...item, grade: 'symlink', kind, linkTarget });
        inventory.gradeCounts.symlink += 1;
      } catch (error) {
        inventory.enumerated.push({ ...item, grade: 'unknown', kind });
        inventory.gradeCounts.unknown += 1;
        issues.push({ operation: 'path', reason: `cannot read link ${item.origin} ${JSON.stringify(item.path)}: ${errorMessage(error)}` });
      }
      continue;
    }

    const parts = pathParts(item.path);
    const dependencyPath = parts.some((part) => DEPENDENCY_ROOTS.has(part));
    if (dataOrStateLike(item.path)) {
      inventory.enumerated.push({ ...item, grade: 'data_or_state', kind });
      inventory.gradeCounts.data_or_state += 1;
      continue;
    }
    if (dependencyPath && item.origin === 'untracked' && sourceLike(item.path)) {
      inventory.enumerated.push({ ...item, grade: 'source', kind });
      inventory.gradeCounts.source += 1;
      continue;
    }
    if (dependencyPath) {
      const summary = inventory.regenerable.installedDependencies;
      summary.count += 1;
      summary.origins[item.origin] += 1;
      inventory.gradeCounts.installed_dependency += 1;
      continue;
    }
    if (provenBuildOutput(projectDir, item.path, kind, fs)) {
      const summary = inventory.regenerable.buildOutputs;
      summary.count += 1;
      summary.origins[item.origin] += 1;
      inventory.gradeCounts.build_output += 1;
      continue;
    }

    const grade: LandEnumeratedGrade = sourceLike(item.path)
      ? 'source'
      : dataOrStateLike(item.path) ? 'data_or_state' : 'unknown';
    inventory.enumerated.push({ ...item, grade, kind });
    inventory.gradeCounts[grade] += 1;
  }

  inventory.enumerated.sort((left, right) => (
    left.path.localeCompare(right.path) || left.origin.localeCompare(right.origin)
  ));
  return {
    inventory: {
      enumerated: inventory.enumerated,
      regenerable: inventory.regenerable,
      gradeCounts: inventory.gradeCounts,
      rawPathCounts: inventory.rawPathCounts,
    },
    issues,
  };
}

async function inspectInventory(
  state: StoreState,
  projectDir: string,
  git: LandGitRunner,
  fs: LandFileSystem,
): Promise<{ inventory: LandInventory; issues: LandInspectionIssue[] }> {
  const inventory = emptyInventory();
  const issues: LandInspectionIssue[] = [];
  let untrackedPaths: string[] = [];
  let ignoredPaths: string[] = [];
  const statusRequest: LandGitRequest = {
    command: 'git',
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    cwd: projectDir,
    operation: 'status',
  };
  const status = await checkedGit(statusRequest, git);
  if (status.ok) {
    try {
      const parsed = parseGitStatusPorcelain(status.stdout);
      inventory.tracked = parsed.tracked;
      untrackedPaths = parsed.untracked;
    } catch (error) {
      issues.push({ operation: 'status', reason: errorMessage(error) });
    }
  } else issues.push(status.issue);

  const ignoredRequest: LandGitRequest = {
    command: 'git',
    args: ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
    cwd: projectDir,
    operation: 'ignored',
  };
  const ignored = await checkedGit(ignoredRequest, git);
  if (ignored.ok) ignoredPaths = nulPaths(ignored.stdout);
  else issues.push(ignored.issue);

  if (!state.baseCommit || !/^[0-9a-f]{7,64}$/i.test(state.baseCommit)) {
    issues.push({
      operation: 'unpushed',
      reason: 'run.json has no valid baseCommit, so commits unique to this worktree cannot be bounded',
    });
  } else {
    const unpushedRequest: LandGitRequest = {
      command: 'git',
      args: ['rev-list', '--reverse', `${state.baseCommit}..HEAD`, '--not', '--remotes'],
      cwd: projectDir,
      operation: 'unpushed',
    };
    const unpushed = await checkedGit(unpushedRequest, git);
    if (unpushed.ok) {
      try {
        inventory.unpushedCommits = unpushedHashes(unpushed.stdout);
      } catch (error) {
        issues.push({ operation: 'unpushed', reason: errorMessage(error) });
      }
    } else issues.push(unpushed.issue);
  }
  const graded = gradeInventoryPaths(projectDir, [
    ...untrackedPaths.map((path) => ({ origin: 'untracked' as const, path })),
    ...ignoredPaths.map((path) => ({ origin: 'ignored' as const, path })),
  ], fs);
  inventory.enumerated = graded.inventory.enumerated;
  inventory.regenerable = graded.inventory.regenerable;
  inventory.gradeCounts = graded.inventory.gradeCounts;
  inventory.rawPathCounts = graded.inventory.rawPathCounts;
  issues.push(...graded.issues);
  return { inventory, issues };
}

interface WorktreeRecord {
  path: string;
  branch?: string;
  bare: boolean;
}

export function parseWorktreePorcelain(raw: string): WorktreeRecord[] {
  const fields = raw.includes('\0') ? raw.split('\0') : raw.split(/\r?\n/);
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  const finish = (): void => {
    if (current) records.push(current);
    current = undefined;
  };
  for (const field of fields) {
    if (!field) {
      finish();
      continue;
    }
    if (field.startsWith('worktree ')) {
      finish();
      current = { path: field.slice('worktree '.length), bare: false };
      continue;
    }
    if (!current) continue;
    if (field.startsWith('branch refs/heads/')) current.branch = field.slice('branch refs/heads/'.length);
    if (field === 'bare') current.bare = true;
  }
  finish();
  return records;
}

function refusalReasons(
  terminal: boolean,
  artifacts: LandTerminalArtifact[],
  inventory: LandInventory,
  issues: LandInspectionIssue[],
): string[] {
  const reasons: string[] = [];
  if (!terminal) reasons.push('run has not reached a terminal status');
  const missing = artifacts.filter((artifact) => !artifact.present);
  if (missing.length > 0) reasons.push(`declared terminal artifacts are absent: ${missing.map((item) => item.path).join(', ')}`);
  if (issues.length > 0) reasons.push(`inventory inspection is incomplete (${issues.length} issue${issues.length === 1 ? '' : 's'})`);
  if (inventory.tracked.length > 0) reasons.push(`${inventory.tracked.length} tracked worktree change${inventory.tracked.length === 1 ? ' remains' : 's remain'}`);
  if (inventory.rawPathCounts.untracked > 0) reasons.push(`${inventory.rawPathCounts.untracked} untracked path${inventory.rawPathCounts.untracked === 1 ? ' remains' : 's remain'}`);
  if (inventory.rawPathCounts.ignored > 0) reasons.push(`${inventory.rawPathCounts.ignored} ignored path${inventory.rawPathCounts.ignored === 1 ? ' remains' : 's remain'}`);
  if (inventory.unpushedCommits.length > 0) reasons.push(`${inventory.unpushedCommits.length} commit${inventory.unpushedCommits.length === 1 ? ' is' : 's are'} absent from every remote ref`);
  return reasons;
}

function projectDirectory(state: StoreState, fs: LandFileSystem): string {
  const requested = resolve(state.projectDir);
  if (!fs.exists(requested)) throw new Error(`run project directory does not exist: ${requested}`);
  if (!fs.stat(requested).isDirectory()) throw new Error(`run project path is not a directory: ${requested}`);
  return fs.realpath(requested);
}

async function removalContext(
  projectDir: string,
  deps: ResolvedLandDependencies,
): Promise<{
  branch?: string;
  primaryWorktree?: string;
  reasons: string[];
  issues: LandInspectionIssue[];
}> {
  const issues: LandInspectionIssue[] = [];
  const reasons: string[] = [];
  let canonicalTop: string | undefined;
  const rootRequest: LandGitRequest = {
    command: 'git', args: ['rev-parse', '--show-toplevel'], cwd: projectDir, operation: 'root',
  };
  const rootResult = await checkedGit(rootRequest, deps.git);
  if (!rootResult.ok) issues.push(rootResult.issue);
  else {
    try {
      canonicalTop = deps.fs.realpath(rootResult.stdout.trim());
      if (canonicalTop !== projectDir) reasons.push(`run project resolves to ${projectDir}, but Git reports worktree root ${canonicalTop}`);
    } catch (error) {
      issues.push({ operation: 'root', reason: `cannot canonicalize Git worktree root: ${errorMessage(error)}` });
    }
  }

  const worktreeRequest: LandGitRequest = {
    command: 'git', args: ['worktree', 'list', '--porcelain'], cwd: projectDir, operation: 'worktrees',
  };
  const worktreeResult = await checkedGit(worktreeRequest, deps.git);
  let primaryWorktree: string | undefined;
  let selected: WorktreeRecord | undefined;
  if (!worktreeResult.ok) issues.push(worktreeResult.issue);
  else {
    try {
      const records = parseWorktreePorcelain(worktreeResult.stdout);
      if (records.length === 0) reasons.push('Git reported no worktrees');
      else {
        primaryWorktree = deps.fs.realpath(records[0].path);
        selected = records.find((record) => {
          try { return deps.fs.realpath(record.path) === projectDir; } catch { return false; }
        });
        if (!selected) reasons.push('run project is not present in `git worktree list`');
        if (primaryWorktree === projectDir || selected?.bare) reasons.push('the primary or bare worktree cannot be removed by `flowcrew land`');
      }
    } catch (error) {
      issues.push({ operation: 'worktrees', reason: `cannot parse worktree inventory: ${errorMessage(error)}` });
    }
  }

  const branchRequest: LandGitRequest = {
    command: 'git', args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: projectDir, operation: 'branch',
  };
  const branchResult = await checkedGit(branchRequest, deps.git);
  let branch: string | undefined;
  if (!branchResult.ok) issues.push(branchResult.issue);
  else {
    branch = branchResult.stdout.trim();
    if (!branch) reasons.push('worktree is detached or has an empty branch name');
    if (selected?.branch && branch && selected.branch !== branch) {
      reasons.push(`worktree list branch ${selected.branch} disagrees with symbolic branch ${branch}`);
    }
  }
  if (canonicalTop && canonicalTop !== projectDir) branch = undefined;
  return { branch, primaryWorktree, reasons, issues };
}

async function destructiveStep(
  request: LandGitRequest,
  git: LandGitRunner,
): Promise<{ step: LandRemovalStep; passed: boolean }> {
  let response: LandGitResponse;
  try {
    response = await git(request);
  } catch (error) {
    response = { exitCode: null, error: errorMessage(error) };
  }
  const error = response.exitCode === 0 && !response.error
    ? undefined
    : gitFailure(request, response);
  return {
    step: {
      operation: request.operation as LandRemovalStep['operation'],
      exitCode: response.exitCode,
      ...(error ? { error } : {}),
    },
    passed: !error,
  };
}

/**
 * Audit and optionally land one explicit run. Operational refusals are structured results;
 * no removal request is issued until every read-only precondition has passed.
 */
export async function runLand(
  args: string[],
  overrides: LandDependencies = {},
): Promise<LandReport> {
  const parsed = parseLandArgs(args);
  if (parsed.help) throw new Error('help does not execute land');
  const deps = resolveDependencies(overrides);
  const runDir = runDirectory(deps.globalDir(), parsed.run as string);
  const state = readRunState(runDir, deps.fs);
  if (state.runId !== parsed.run) {
    throw new Error(`run id mismatch: requested ${parsed.run}, run.json records ${state.runId}`);
  }
  const projectDir = projectDirectory(state, deps.fs);
  const artifacts = terminalArtifacts(state, projectDir, runDir, deps.fs);
  const artifactIssues: LandInspectionIssue[] = artifacts
    .filter((artifact) => artifact.reason)
    .map((artifact) => ({ operation: 'artifact', reason: `${artifact.path}: ${artifact.reason}` }));
  const inspected = await inspectInventory(state, projectDir, deps.git, deps.fs);
  const inspectionIssues = [...artifactIssues, ...inspected.issues];
  const terminal = isTerminalRunStatus(state.status);
  let reasons = refusalReasons(terminal, artifacts, inspected.inventory, inspectionIssues);
  const baseReport: LandReport = {
    version: 1,
    state: 'audit',
    runId: state.runId,
    runDir,
    projectDir,
    status: state.status,
    terminal,
    artifacts,
    inventory: inspected.inventory,
    inspectionIssues,
    removalRequested: parsed.remove,
    readyForRemoval: reasons.length === 0,
    refusalReasons: reasons,
  };
  if (!parsed.remove) return baseReport;
  if (reasons.length > 0) return { ...baseReport, state: 'refused' };

  const context = await removalContext(projectDir, deps);
  inspectionIssues.push(...context.issues);
  reasons = [...context.reasons];
  if (context.issues.length > 0) reasons.push(`removal context inspection is incomplete (${context.issues.length} issue${context.issues.length === 1 ? '' : 's'})`);
  if (!context.branch) reasons.push('a checked-out local branch could not be proven');
  if (!context.primaryWorktree) reasons.push('the primary worktree could not be proven');
  const contextual: LandReport = {
    ...baseReport,
    inspectionIssues,
    readyForRemoval: reasons.length === 0,
    refusalReasons: reasons,
    ...(context.branch ? { branch: context.branch } : {}),
    ...(context.primaryWorktree ? { primaryWorktree: context.primaryWorktree } : {}),
  };
  if (reasons.length > 0 || !context.branch || !context.primaryWorktree) {
    return { ...contextual, state: 'refused' };
  }

  const removalSteps: LandRemovalStep[] = [];
  const remove = await destructiveStep({
    command: 'git',
    args: ['worktree', 'remove', '--', projectDir],
    cwd: context.primaryWorktree,
    operation: 'remove_worktree',
  }, deps.git);
  removalSteps.push(remove.step);
  if (!remove.passed) return { ...contextual, state: 'removal_failed', removalSteps };

  const prune = await destructiveStep({
    command: 'git', args: ['worktree', 'prune'], cwd: context.primaryWorktree, operation: 'prune_worktrees',
  }, deps.git);
  removalSteps.push(prune.step);
  if (!prune.passed) return { ...contextual, state: 'removal_failed', removalSteps };

  const branch = await destructiveStep({
    command: 'git',
    args: ['branch', '-d', '--', context.branch],
    cwd: context.primaryWorktree,
    operation: 'delete_branch',
  }, deps.git);
  removalSteps.push(branch.step);
  if (!branch.passed) return { ...contextual, state: 'removal_failed', removalSteps };
  return { ...contextual, state: 'removed', removalSteps };
}

function displayPath(path: string): string {
  return JSON.stringify(path);
}

function renderLandHuman(report: LandReport, writer: Writer): void {
  writer.write(`Land: ${report.state.toUpperCase()}\n`);
  writer.write(`Run: ${report.runId}\nStatus: ${report.status} (${report.terminal ? 'terminal' : 'not terminal'})\n`);
  writer.write(`Worktree: ${report.projectDir}\n`);
  if (report.artifacts.length === 0) writer.write('Declared artifacts for this status: none\n');
  for (const artifact of report.artifacts) {
    writer.write(`  ${artifact.present ? 'PRESENT' : 'ABSENT'} ${displayPath(artifact.path)} `
      + `(project=${artifact.projectPresent ? 'yes' : 'no'}, snapshot=${artifact.snapshotPresent ? 'yes' : 'no'})\n`);
  }
  writer.write(`Unique inventory: ${inventorySize(report.inventory)} item(s)\n`);
  writer.write('Path grades:'
    + ` build_output=${report.inventory.gradeCounts.build_output}`
    + ` installed_dependency=${report.inventory.gradeCounts.installed_dependency}`
    + ` source=${report.inventory.gradeCounts.source}`
    + ` data_or_state=${report.inventory.gradeCounts.data_or_state}`
    + ` symlink=${report.inventory.gradeCounts.symlink}`
    + ` unknown=${report.inventory.gradeCounts.unknown}\n`);
  for (const summary of [
    report.inventory.regenerable.buildOutputs,
    report.inventory.regenerable.installedDependencies,
  ]) {
    writer.write(`  REGENERABLE ${summary.grade.toUpperCase()} ${summary.count} item(s)`
      + ` (untracked=${summary.origins.untracked}, ignored=${summary.origins.ignored})\n`);
  }
  for (const item of report.inventory.tracked) {
    writer.write(`  TRACKED ${item.code} ${displayPath(item.path)}${item.originalPath ? ` <- ${displayPath(item.originalPath)}` : ''}\n`);
  }
  for (const item of report.inventory.enumerated) {
    const kind = item.grade === 'symlink' ? '' : ` ${item.kind.toUpperCase()}`;
    writer.write(`  ${item.origin.toUpperCase()} ${item.grade.toUpperCase()}${kind} ${displayPath(item.path)}`
      + `${item.linkTarget === undefined ? '' : ` -> ${displayPath(item.linkTarget)}`}\n`);
  }
  for (const hash of report.inventory.unpushedCommits) writer.write(`  UNPUSHED ${hash}\n`);
  for (const issue of report.inspectionIssues) writer.write(`  UNKNOWN [${issue.operation}] ${issue.reason}\n`);
  for (const reason of report.refusalReasons) writer.write(`  REFUSED ${reason}\n`);
  for (const step of report.removalSteps ?? []) {
    writer.write(`  ${step.error ? 'FAILED' : 'DONE'} ${step.operation}${step.error ? `: ${step.error}` : ''}\n`);
  }
  if (!report.removalRequested) {
    writer.write(report.readyForRemoval
      ? 'Audit complete: rerun with --remove after independently judging and archiving the result.\n'
      : 'Audit complete: account for every listed item before requesting removal.\n');
  }
}

export async function cmdLandWithDeps(
  args: string[],
  overrides: LandDependencies,
): Promise<number> {
  const deps = resolveDependencies(overrides);
  let parsed: ParsedLandArgs;
  try {
    parsed = parseLandArgs(args);
    if (parsed.help) {
      deps.stdout.write(`${landUsage()}\n`);
      return 0;
    }
    const report = await runLand(args, overrides);
    const writer = report.state === 'audit' || report.state === 'removed' ? deps.stdout : deps.stderr;
    if (parsed.json) writer.write(`${JSON.stringify(report, null, 2)}\n`);
    else renderLandHuman(report, writer);
    if (report.state === 'refused' || report.state === 'removal_failed') return 1;
    return report.inspectionIssues.length === 0 ? 0 : 1;
  } catch (error) {
    deps.stderr.write(`land: ${errorMessage(error)}\n`);
    deps.stderr.write(`${landUsage()}\n`);
    return 1;
  }
}

export async function cmdLand(args: string[]): Promise<number> {
  return cmdLandWithDeps(args, {});
}
