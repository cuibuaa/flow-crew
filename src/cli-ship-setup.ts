import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  runProjectValidationBaseline,
  type ProjectValidationBaseline,
  type ValidationCommandRunner,
} from './project-validation.js';
import {
  verifyBriefInputs,
  type BriefInputAssertionResult,
  type BriefInputVerification,
  type ShipInputFileSystem,
} from './ship-inputs.js';
import { fcGlobalDir } from './store.js';

type Writer = { write(chunk: string): unknown };

export interface ShipSetupFileSystem extends ShipInputFileSystem {
  realpath(path: string): string;
  entryExists(path: string): boolean;
  createDirectory(path: string): void;
  createLink(source: string, target: string, type: 'file' | 'dir'): void;
  writeAtomic(path: string, contents: string): void;
}

function nodeReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function nodeEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function nodeAtomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: 'utf-8', flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup; the original atomic-write error is authoritative.
    }
    throw error;
  }
}

export const nodeShipSetupFileSystem: ShipSetupFileSystem = {
  exists: existsSync,
  readable: nodeReadable,
  readText: (path) => readFileSync(path, 'utf-8'),
  readBytes: (path) => readFileSync(path),
  readDirectory: (path) => readdirSync(path),
  stat: (path) => statSync(path),
  realpath: (path) => realpathSync.native(path),
  entryExists: nodeEntryExists,
  createDirectory: (path) => mkdirSync(path, { recursive: true }),
  createLink: (source, target, type) => symlinkSync(source, target, type),
  writeAtomic: nodeAtomicWrite,
};

export interface GitWorktreeRequest {
  projectDir: string;
  targetDir: string;
  base: string;
  branch: string;
}

export interface GitWorktreeResponse {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type GitWorktreeCreator = (
  request: GitWorktreeRequest,
) => Promise<GitWorktreeResponse> | GitWorktreeResponse;

export interface GitCommandRequest {
  command: 'git';
  args: string[];
  cwd: string;
}

export type GitCommandRunner = (
  request: GitCommandRequest,
) => Promise<GitWorktreeResponse> | GitWorktreeResponse;

function bounded(value: string, maximum = 24 * 1024): string {
  const bytes = Buffer.from(value, 'utf-8');
  if (bytes.length <= maximum) return value;
  return `[... ${bytes.length - maximum} earlier bytes omitted ...]\n${bytes.subarray(bytes.length - maximum).toString('utf-8')}`;
}

const runGitCommand: GitCommandRunner = (request) => new Promise((settle) => {
  const child = spawn(
    request.command,
    request.args,
    {
      cwd: request.cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60 * 1_000,
    },
  );
  let stdout = '';
  let stderr = '';
  let launchError: string | undefined;
  let settled = false;
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout = bounded(stdout + chunk.toString());
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = bounded(stderr + chunk.toString());
  });
  child.once('error', (error) => {
    launchError = error.message;
  });
  child.once('close', (code, signal) => {
    if (settled) return;
    settled = true;
    settle({
      exitCode: code,
      stdout,
      stderr,
      ...(launchError ? { error: launchError } : {}),
      ...(!launchError && signal ? { error: `Git ended by signal ${signal}` } : {}),
    });
  });
});

/** Map the declared setup identity to one argv-safe Git operation. */
export function createGitWorktree(
  request: GitWorktreeRequest,
  runner: GitCommandRunner = runGitCommand,
): Promise<GitWorktreeResponse> | GitWorktreeResponse {
  return runner({
    command: 'git',
    args: ['worktree', 'add', '-b', request.branch, '--', request.targetDir, request.base],
    cwd: request.projectDir,
  });
}

export interface ShipSetupDependencies {
  cwd?: string;
  fs?: ShipSetupFileSystem;
  createWorktree?: GitWorktreeCreator;
  runGitCommand?: GitCommandRunner;
  runValidationCommand?: ValidationCommandRunner;
  globalDir?: () => string;
  timestamp?: () => string;
  stdout?: Writer;
  stderr?: Writer;
}

interface ResolvedShipSetupDependencies {
  cwd: string;
  fs: ShipSetupFileSystem;
  createWorktree: GitWorktreeCreator;
  runValidationCommand?: ValidationCommandRunner;
  globalDir: () => string;
  timestamp: () => string;
  stdout: Writer;
  stderr: Writer;
}

export interface ParsedShipSetupArgs {
  help: boolean;
  json: boolean;
  brief?: string;
  target?: string;
  base?: string;
  branch?: string;
  project?: string;
}

export interface ShipSetupLink {
  path: string;
  source: string;
  target: string;
  type: 'file' | 'directory';
}

export interface ShipSetupBlocker {
  phase: 'source' | 'worktree' | 'target' | 'validation' | 'record';
  reason: string;
  input?: string;
  assertion?: BriefInputAssertionResult['kind'];
}

interface ShipSetupFacts {
  version: 1;
  projectDir: string;
  targetDir: string;
  targetCanonicalDir?: string;
  briefPath: string;
  briefDigest: string;
  base: string;
  branch: string;
  worktreeCreated: boolean;
  links: ShipSetupLink[];
  sourceVerification: BriefInputVerification;
  targetVerification?: BriefInputVerification;
  validationBaseline?: ProjectValidationBaseline;
  blockers: ShipSetupBlocker[];
}

export interface ShipSetupReadyReport extends ShipSetupFacts {
  state: 'ready';
  ready: true;
  createdAt: string;
  readyRecordPath: string;
  targetVerification: BriefInputVerification;
  validationBaseline: ProjectValidationBaseline;
}

export interface ShipSetupRefusedReport extends ShipSetupFacts {
  state: 'refused';
}

export type ShipSetupReport = ShipSetupReadyReport | ShipSetupRefusedReport;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveDependencies(overrides: ShipSetupDependencies): ResolvedShipSetupDependencies {
  return {
    cwd: resolve(overrides.cwd ?? process.cwd()),
    fs: overrides.fs ?? nodeShipSetupFileSystem,
    createWorktree: overrides.createWorktree
      ?? ((request) => createGitWorktree(request, overrides.runGitCommand ?? runGitCommand)),
    ...(overrides.runValidationCommand ? { runValidationCommand: overrides.runValidationCommand } : {}),
    globalDir: overrides.globalDir ?? fcGlobalDir,
    timestamp: overrides.timestamp ?? (() => new Date().toISOString()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
  };
}

function optionValue(args: string[], index: number, option: string): { value: string; consumed: number } {
  const current = args[index];
  const prefix = `${option}=`;
  if (current.startsWith(prefix)) {
    const value = current.slice(prefix.length);
    if (!value) throw new Error(`${option} requires a value`);
    return { value, consumed: 1 };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return { value, consumed: 2 };
}

export function parseShipSetupArgs(args: string[]): ParsedShipSetupArgs {
  const parsed: ParsedShipSetupArgs = { help: false, json: false };
  const values = new Set<'brief' | 'target' | 'base' | 'branch' | 'project'>();
  const start = args[0] === 'ship-setup' ? 1 : 0;
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
    const name = (['brief', 'target', 'base', 'branch', 'project'] as const)
      .find((candidate) => argument === `--${candidate}` || argument.startsWith(`--${candidate}=`));
    if (!name) throw new Error(`unknown ship-setup option: ${argument}`);
    if (values.has(name)) throw new Error(`--${name} may be specified only once`);
    const value = optionValue(args, index, `--${name}`);
    parsed[name] = value.value;
    values.add(name);
    index += value.consumed;
  }
  if (!parsed.help) {
    for (const required of ['brief', 'target', 'base', 'branch'] as const) {
      if (!parsed[required]) throw new Error(`--${required} is required`);
    }
  }
  return parsed;
}

export function shipSetupUsage(): string {
  return [
    'Usage: flowcrew ship-setup --brief <path> --target <path> --base <ref> --branch <name> [--project <path>] [--json]',
    'Creates the exact worktree, links absent declared inputs, rechecks their asserted properties, and records the validation baseline.',
  ].join('\n');
}

/** Content-addressed FC-global path for one canonical target and measured brief. */
export function shipSetupReadyRecordPath(
  canonicalTargetDir: string,
  briefDigest: string,
  globalRoot = fcGlobalDir(),
): string {
  if (!/^[a-f0-9]{64}$/.test(briefDigest)) throw new Error('brief digest must be a lowercase SHA-256');
  const identity = createHash('sha256')
    .update(resolve(canonicalTargetDir))
    .update('\0')
    .update(briefDigest)
    .digest('hex');
  return join(resolve(globalRoot), 'ship-setups', `${identity}.json`);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function verificationBlockers(
  phase: 'source' | 'target',
  verification: BriefInputVerification,
): ShipSetupBlocker[] {
  const blockers: ShipSetupBlocker[] = verification.unboundAssertions.map((assertion) => ({
    phase,
    assertion: assertion.kind,
    reason: `${assertion.state}: ${assertion.reason} (line ${assertion.line})`,
  }));
  blockers.push(...verification.unresolvedInputs.map((input) => ({
    phase,
    input: input.value,
    reason: `Unresolved explicit input at line ${input.line}: ${input.reason}`,
  })));
  for (const input of verification.inputs) {
    if (!input.exists) blockers.push({ phase, input: input.path, reason: 'Declared input does not exist' });
    else if (!input.readable) blockers.push({ phase, input: input.path, reason: 'Declared input is not readable' });
    for (const assertion of input.assertions) {
      if (assertion.state !== 'confirmed') {
        blockers.push({
          phase,
          input: input.path,
          assertion: assertion.kind,
          reason: `${assertion.state}: ${assertion.reason}`,
        });
      }
    }
  }
  return blockers;
}

function refused(
  facts: Omit<ShipSetupFacts, 'blockers'>,
  blockers: ShipSetupBlocker[],
): ShipSetupRefusedReport {
  return { ...facts, state: 'refused', blockers };
}

function safeReadBrief(path: string, fs: ShipSetupFileSystem): { text: string; digest: string } {
  if (!fs.exists(path)) throw new Error(`requested brief does not exist: ${path}`);
  if (!fs.readable(path)) throw new Error(`requested brief is not readable: ${path}`);
  try {
    const bytes = fs.readBytes(path);
    return {
      text: Buffer.from(bytes).toString('utf-8'),
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    throw new Error(`cannot read requested brief ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

function canonicalProject(path: string, fs: ShipSetupFileSystem): string {
  if (!fs.exists(path)) throw new Error(`source project does not exist: ${path}`);
  if (!fs.readable(path)) throw new Error(`source project is not readable: ${path}`);
  try {
    if (!fs.stat(path).isDirectory()) throw new Error('path is not a directory');
    return fs.realpath(path);
  } catch (error) {
    throw new Error(`cannot canonicalize source project ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

function setupFacts(
  projectDir: string,
  targetDir: string,
  briefPath: string,
  briefDigest: string,
  parsed: ParsedShipSetupArgs,
  sourceVerification: BriefInputVerification,
): Omit<ShipSetupFacts, 'blockers'> {
  return {
    version: 1,
    projectDir,
    targetDir,
    briefPath,
    briefDigest,
    base: parsed.base as string,
    branch: parsed.branch as string,
    worktreeCreated: false,
    links: [],
    sourceVerification,
  };
}

function worktreeFailureReason(response: GitWorktreeResponse): string {
  const detail = response.error || response.stderr?.trim() || response.stdout?.trim();
  const exit = response.exitCode === null ? 'without an exit code' : `with exit ${response.exitCode}`;
  return `Git worktree creation failed ${exit}${detail ? `: ${detail}` : ''}`;
}

function linkInputs(
  sourceVerification: BriefInputVerification,
  projectDir: string,
  targetDir: string,
  fs: ShipSetupFileSystem,
): { links: ShipSetupLink[]; blockers: ShipSetupBlocker[] } {
  const links: ShipSetupLink[] = [];
  const blockers: ShipSetupBlocker[] = [];
  const targetCanonical = fs.realpath(targetDir);
  const inputs = [...sourceVerification.inputs].sort((left, right) => {
    const depth = (path: string): number => path.split('/').length;
    return depth(left.path) - depth(right.path) || left.path.localeCompare(right.path);
  });

  for (const input of inputs) {
    const source = resolve(projectDir, input.path);
    const target = resolve(targetDir, input.path);
    if (!within(resolve(targetDir), target)) {
      blockers.push({ phase: 'target', input: input.path, reason: 'Declared target path escapes the worktree' });
      continue;
    }
    if (fs.exists(target)) continue;
    if (fs.entryExists(target)) {
      blockers.push({ phase: 'target', input: input.path, reason: 'Target has an existing unreachable entry and will not be overwritten' });
      continue;
    }
    try {
      fs.createDirectory(dirname(target));
      const parentCanonical = fs.realpath(dirname(target));
      if (!within(targetCanonical, parentCanonical)) {
        blockers.push({ phase: 'target', input: input.path, reason: 'Target parent resolves outside the worktree' });
        continue;
      }
      const directory = fs.stat(source).isDirectory();
      fs.createLink(source, target, directory ? 'dir' : 'file');
      links.push({ path: input.path, source, target, type: directory ? 'directory' : 'file' });
    } catch (error) {
      blockers.push({
        phase: 'target',
        input: input.path,
        reason: `Cannot make declared input reachable: ${errorMessage(error)}`,
      });
    }
  }
  return { links, blockers };
}

/** Execute setup without rendering; operational refusals are returned as structured facts. */
export async function runShipSetup(
  args: string[],
  overrides: ShipSetupDependencies = {},
): Promise<ShipSetupReport> {
  const parsed = parseShipSetupArgs(args);
  if (parsed.help) throw new Error('help does not execute ship setup');
  const deps = resolveDependencies(overrides);
  const requestedProject = resolve(deps.cwd, parsed.project ?? '.');
  const projectDir = canonicalProject(requestedProject, deps.fs);
  const targetDir = resolve(deps.cwd, parsed.target as string);
  const briefPath = resolve(isAbsolute(parsed.brief as string)
    ? parsed.brief as string
    : join(projectDir, parsed.brief as string));
  const measuredBrief = safeReadBrief(briefPath, deps.fs);
  const brief = measuredBrief.text;
  const sourceVerification = verifyBriefInputs(brief, projectDir, deps.fs);
  let facts = setupFacts(
    projectDir,
    targetDir,
    briefPath,
    measuredBrief.digest,
    parsed,
    sourceVerification,
  );
  const sourceBlockers = verificationBlockers('source', sourceVerification);
  if (sourceBlockers.length > 0) return refused(facts, sourceBlockers);
  if (deps.fs.entryExists(targetDir)) {
    return refused(facts, [{
      phase: 'worktree',
      reason: `Target already exists and will not be overwritten: ${targetDir}`,
    }]);
  }

  let git: GitWorktreeResponse;
  try {
    git = await deps.createWorktree({
      projectDir,
      targetDir,
      base: parsed.base as string,
      branch: parsed.branch as string,
    });
  } catch (error) {
    git = { exitCode: null, error: errorMessage(error) };
  }
  if (git.exitCode !== 0 || git.error) {
    return refused(facts, [{ phase: 'worktree', reason: worktreeFailureReason(git) }]);
  }
  facts = { ...facts, worktreeCreated: true };
  const targetIsDirectory = (() => {
    try {
      return deps.fs.exists(targetDir) && deps.fs.stat(targetDir).isDirectory();
    } catch {
      return false;
    }
  })();
  if (!targetIsDirectory) {
    return refused(facts, [{
      phase: 'worktree',
      reason: 'Git reported success but the target worktree directory is not reachable',
    }]);
  }
  let targetCanonicalDir: string;
  try {
    targetCanonicalDir = deps.fs.realpath(targetDir);
    facts = { ...facts, targetCanonicalDir };
  } catch (error) {
    return refused(facts, [{
      phase: 'target',
      reason: `Cannot canonicalize target worktree: ${errorMessage(error)}`,
    }]);
  }

  let linked: { links: ShipSetupLink[]; blockers: ShipSetupBlocker[] };
  try {
    linked = linkInputs(sourceVerification, projectDir, targetDir, deps.fs);
  } catch (error) {
    return refused(facts, [{ phase: 'target', reason: `Cannot inspect target worktree: ${errorMessage(error)}` }]);
  }
  facts = { ...facts, links: linked.links };
  if (linked.blockers.length > 0) return refused(facts, linked.blockers);

  const targetVerification = verifyBriefInputs(brief, targetDir, deps.fs);
  facts = { ...facts, targetVerification };
  const targetBlockers = verificationBlockers('target', targetVerification);
  if (targetBlockers.length > 0) return refused(facts, targetBlockers);

  const validationBaseline = await runProjectValidationBaseline(targetDir, {
    fs: { exists: deps.fs.exists, readText: deps.fs.readText },
    ...(deps.runValidationCommand ? { runCommand: deps.runValidationCommand } : {}),
  });
  facts = { ...facts, validationBaseline };
  const validationBlockers: ShipSetupBlocker[] = validationBaseline.discovery.state === 'unknown'
    ? [{
        phase: 'validation',
        reason: `Validation baseline is unknown: ${validationBaseline.discovery.reason ?? 'no build, test, or lint command could be inferred'}`,
      }]
    : [];
  validationBlockers.push(...validationBaseline.results
    .filter((result) => result.state === 'launch_error')
    .map((result): ShipSetupBlocker => ({
      phase: 'validation',
      reason: `Cannot launch ${result.role} baseline${result.display ? ` (${result.display})` : ''}: ${result.reason ?? 'command ended without an exit code'}`,
    })));
  if (validationBlockers.length > 0) return refused(facts, validationBlockers);
  const readyRecordPath = shipSetupReadyRecordPath(
    targetCanonicalDir,
    measuredBrief.digest,
    deps.globalDir(),
  );
  const report: ShipSetupReadyReport = {
    ...facts,
    state: 'ready',
    ready: true,
    createdAt: deps.timestamp(),
    blockers: [],
    readyRecordPath,
    targetVerification,
    validationBaseline,
  };
  try {
    deps.fs.writeAtomic(readyRecordPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    return refused(facts, [{
      phase: 'record',
      reason: `Cannot atomically persist the FC-global ready record: ${errorMessage(error)}`,
    }]);
  }
  return report;
}

function renderInputVerification(label: string, verification: BriefInputVerification, writer: Writer): void {
  writer.write(`${label} inputs: ${verification.inputs.length} checked\n`);
  for (const input of verification.inputs) {
    const reachability = input.exists ? (input.readable ? 'READABLE' : 'UNREADABLE') : 'MISSING';
    writer.write(`  ${reachability} ${input.path}\n`);
    for (const assertion of input.assertions) {
      writer.write(`    ${assertion.state.toUpperCase()} ${assertion.kind}: ${assertion.reason}\n`);
    }
  }
  for (const assertion of verification.unboundAssertions) {
    writer.write(`  NOT_CHECKABLE ${assertion.kind}: ${assertion.reason}\n`);
  }
  for (const input of verification.unresolvedInputs) {
    writer.write(`  UNRESOLVED DECLARED ${JSON.stringify(input.value)} at line ${input.line}: ${input.reason}\n`);
  }
}

function renderVerification(report: ShipSetupReport, writer: Writer): void {
  renderInputVerification('Source', report.sourceVerification, writer);
  if (report.targetVerification) renderInputVerification('Target', report.targetVerification, writer);
  for (const link of report.links) writer.write(`  LINK ${link.path} -> ${link.source}\n`);
}

function renderHuman(report: ShipSetupReport, writer: Writer): void {
  writer.write(`Ship setup: ${report.state.toUpperCase()}\n`);
  writer.write(`Project: ${report.projectDir}\nTarget: ${report.targetDir}\n`);
  writer.write(`Brief digest: ${report.briefDigest}\n`);
  writer.write(`Git: branch ${report.branch} at base ${report.base}\n`);
  renderVerification(report, writer);
  if (report.state === 'ready') {
    writer.write(`Validation baseline: ${report.validationBaseline.discovery.state.toUpperCase()}\n`);
    for (const result of report.validationBaseline.results) {
      writer.write(`  ${result.role}: ${result.state.toUpperCase()}${result.exitCode === undefined ? '' : ` exit=${result.exitCode}`}\n`);
    }
    for (const criterion of report.validationBaseline.gateCriteria) {
      writer.write(`  gate ${criterion.role}: ${criterion.rule} — ${criterion.description}\n`);
    }
    writer.write(`Ready record: ${report.readyRecordPath}\n`);
    return;
  }
  for (const blocker of report.blockers) {
    const subject = blocker.input ? ` ${blocker.input}` : '';
    const assertion = blocker.assertion ? ` ${blocker.assertion}` : '';
    writer.write(`  REFUSED [${blocker.phase}]${subject}${assertion}: ${blocker.reason}\n`);
  }
}

export async function cmdShipSetupWithDeps(
  args: string[],
  overrides: ShipSetupDependencies,
): Promise<number> {
  const deps = resolveDependencies(overrides);
  let parsed: ParsedShipSetupArgs;
  try {
    parsed = parseShipSetupArgs(args);
    if (parsed.help) {
      deps.stdout.write(`${shipSetupUsage()}\n`);
      return 0;
    }
    const report = await runShipSetup(args, overrides);
    const writer = report.state === 'ready' ? deps.stdout : deps.stderr;
    if (parsed.json) writer.write(`${JSON.stringify(report, null, 2)}\n`);
    else renderHuman(report, writer);
    return report.state === 'ready' ? 0 : 1;
  } catch (error) {
    deps.stderr.write(`ship-setup: ${errorMessage(error)}\n`);
    deps.stderr.write(`${shipSetupUsage()}\n`);
    return 1;
  }
}

export async function cmdShipSetup(args: string[]): Promise<number> {
  return cmdShipSetupWithDeps(args, {});
}
