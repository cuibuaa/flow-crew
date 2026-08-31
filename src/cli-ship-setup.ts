import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  accessSync,
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  discoverProjectValidation,
  reconcileProjectValidation,
  runValidationCommand,
  runProjectValidationBaseline,
  type BriefValidationCommand,
  type ProjectValidationBaseline,
  type ValidationCommand,
  type ValidationCommandRunner,
  type ValidationRole,
  type ValidationRunRequest,
  type ValidationRunResponse,
} from './project-validation.js';
import {
  verifyBriefInputs,
  inspectBriefOutputs,
  type BriefOutputInventory,
  type BriefInputAssertionResult,
  type BriefInputVerification,
  type ShipInputFileSystem,
} from './ship-inputs.js';
import { fcGlobalDir } from './store.js';
import { shipSetupReadyRecordPath } from './ship-setup-record.js';
import { parseTapOutput } from './tap-output.js';

export { shipSetupReadyRecordPath } from './ship-setup-record.js';

type Writer = { write(chunk: string): unknown };

export interface ShipSetupFileSystem extends ShipInputFileSystem {
  realpath(path: string): string;
  entryExists(path: string): boolean;
  createDirectory(path: string): void;
  createLink(source: string, target: string, type: 'file' | 'dir'): void;
  copyFile(source: string, target: string): void;
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
  lstat: (path) => lstatSync(path),
  readlink: (path) => readlinkSync(path),
  realpath: (path) => realpathSync.native(path),
  entryExists: nodeEntryExists,
  createDirectory: (path) => mkdirSync(path, { recursive: true }),
  createLink: (source, target, type) => symlinkSync(source, target, type),
  copyFile: (source, target) => copyFileSync(source, target),
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
  runTestCollectionCommand?: ValidationCommandRunner;
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
  runTestCollectionCommand: ValidationCommandRunner;
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

export interface ShipSetupCopy {
  path: string;
  source: string;
  target: string;
}

export interface TestPopulationObservation {
  projectDir: string;
  count: number;
  identities: string[];
  digest: string;
  durationMs: number;
}

export interface TestPopulationRunner {
  display: string;
  command: string;
  evidencePath?: string;
}

export type TestPopulationEvidenceMethod = {
  tool: 'vitest' | 'pytest' | 'declared-files';
  display: string;
  evidencePath: string;
} | {
  source: 'baseline_output';
  format: 'tap';
  display: string;
  evidencePath: 'source and target test command output';
};

export interface TestPopulationParity {
  version: 1;
  state: 'matched' | 'mismatched' | 'unverified';
  runner?: {
    source: TestPopulationRunner;
    target: TestPopulationRunner;
  };
  method?: TestPopulationEvidenceMethod;
  source?: TestPopulationObservation;
  target?: TestPopulationObservation;
  missingFromTarget: string[];
  extraInTarget: string[];
  reason?: string;
}

export interface ShipSetupBlocker {
  phase: 'source' | 'worktree' | 'target' | 'validation' | 'record';
  reason: string;
  repair: string;
  input?: string;
  assertion?: BriefInputAssertionResult['kind'];
}

type ShipSetupBlockerInput = Omit<ShipSetupBlocker, 'repair'> & { repair?: string };

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
  copies: ShipSetupCopy[];
  sourceVerification: BriefInputVerification;
  sourceOutputInventory: BriefOutputInventory;
  targetVerification?: BriefInputVerification;
  targetOutputInventory?: BriefOutputInventory;
  testPopulation?: TestPopulationParity;
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
    runTestCollectionCommand: overrides.runTestCollectionCommand
      ?? overrides.runValidationCommand
      ?? runValidationCommand,
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
    'Creates the exact worktree, overlays missing declared-input descendants, records available test-population evidence, rechecks assertions, and records the validation baseline.',
  ].join('\n');
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function verificationBlockers(
  phase: 'source' | 'target',
  verification: BriefInputVerification,
): ShipSetupBlockerInput[] {
  const blockers: ShipSetupBlockerInput[] = verification.unboundAssertions.map((assertion) => ({
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
  blockers: ShipSetupBlockerInput[],
): ShipSetupRefusedReport {
  return {
    ...facts,
    state: 'refused',
    blockers: blockers.map((blocker) => ({
      ...blocker,
      repair: blocker.repair ?? shipSetupBlockerRepair(blocker),
    })),
  };
}

function shipSetupBlockerRepair(blocker: ShipSetupBlockerInput): string {
  const subject = blocker.input ? ` ${JSON.stringify(blocker.input)}` : '';
  if (blocker.phase === 'source') {
    return `Correct or remove the named leading input/assertion${subject}, ensure required source data is readable, then rerun ship-setup.`;
  }
  if (blocker.phase === 'worktree') {
    return 'Inspect the reported Git base, branch, and target; correct the conflicting value or Git failure, then rerun ship-setup with a fresh reachable target.';
  }
  if (blocker.phase === 'target') {
    return `Reconcile the named target input${subject} without overwriting unique data, ensure it stays inside the worktree and is readable, then rerun ship-setup.`;
  }
  if (blocker.phase === 'validation') {
    return 'Correct the named validation declaration, command/environment, or test-population mismatch; run that command successfully from the target, then rerun ship-setup.';
  }
  return 'Restore writable task-state storage or choose the configured writable FC state root, then retry ship-setup so the ready record can be persisted atomically.';
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

export interface BriefValidationParseResult {
  commands: BriefValidationCommand[];
  error?: string;
}

const VALIDATION_ROLES: readonly ValidationRole[] = ['build', 'test', 'lint'];

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) as number;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function validationDeclarationError(briefPath: string, reason: string): BriefValidationParseResult {
  return {
    commands: [],
    error: `Invalid brief validation declaration at ${briefPath}#validation: ${reason}`,
  };
}

/** Parse only a leading frontmatter validation block into shell-free argv declarations. */
export function parseBriefValidationCommands(brief: string, briefPath: string): BriefValidationParseResult {
  const withoutBom = brief.startsWith('\uFEFF') ? brief.slice(1) : brief;
  const openingLength = withoutBom.startsWith('---\r\n') ? 5 : withoutBom.startsWith('---\n') ? 4 : 0;
  if (openingLength === 0) return { commands: [] };
  const afterOpening = withoutBom.slice(openingLength);
  const emptyFrontmatter = afterOpening === '---'
    || afterOpening.startsWith('---\n')
    || afterOpening.startsWith('---\r\n');
  const closingFence = emptyFrontmatter ? undefined : /\r?\n---(?:\r?\n|$)/.exec(afterOpening);
  if (!emptyFrontmatter && !closingFence) {
    return validationDeclarationError(
      briefPath,
      'leading YAML frontmatter fence was opened but never closed',
    );
  }
  const frontmatter = emptyFrontmatter ? '' : afterOpening.slice(0, closingFence?.index);

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter) as unknown;
  } catch (error) {
    return validationDeclarationError(briefPath, `YAML could not be parsed: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { commands: [] };
  const validation = (parsed as Record<string, unknown>).validation;
  if (validation === undefined) return { commands: [] };
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) {
    return validationDeclarationError(briefPath, '`validation` must be a mapping with a `commands` field');
  }
  const validationRecord = validation as Record<string, unknown>;
  const validationFields = Object.keys(validationRecord);
  const unknownValidationField = validationFields.find((field) => field !== 'commands');
  if (unknownValidationField) {
    return validationDeclarationError(
      briefPath,
      `unknown field ${JSON.stringify(unknownValidationField)} under \`validation\``,
    );
  }
  const commands = validationRecord.commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
    return validationDeclarationError(briefPath, '`validation.commands` must be a non-empty role mapping');
  }
  const commandsRecord = commands as Record<string, unknown>;
  const roleNames = Object.keys(commandsRecord);
  if (roleNames.length === 0) {
    return validationDeclarationError(briefPath, '`validation.commands` must declare at least one role');
  }
  const unknownRole = roleNames.find((role) => !VALIDATION_ROLES.includes(role as ValidationRole));
  if (unknownRole) {
    return validationDeclarationError(briefPath, `unknown role ${JSON.stringify(unknownRole)} under \`validation.commands\``);
  }

  const declarations: BriefValidationCommand[] = [];
  for (const role of VALIDATION_ROLES) {
    if (!Object.hasOwn(commandsRecord, role)) continue;
    const value = commandsRecord[role];
    const evidencePath = `${briefPath}#validation.commands.${role}`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return validationDeclarationError(briefPath, `${evidencePath} must be a mapping with \`command\` and \`args\``);
    }
    const commandRecord = value as Record<string, unknown>;
    const unknownField = Object.keys(commandRecord).find((field) => field !== 'command' && field !== 'args');
    if (unknownField) {
      return validationDeclarationError(
        briefPath,
        `unknown field ${JSON.stringify(unknownField)} at ${evidencePath}`,
      );
    }
    if (typeof commandRecord.command !== 'string' || commandRecord.command.trim().length === 0) {
      return validationDeclarationError(briefPath, `${evidencePath}.command must be a non-empty string`);
    }
    if (containsControlCharacter(commandRecord.command)) {
      return validationDeclarationError(briefPath, `${evidencePath}.command must not contain a control character`);
    }
    if (!Array.isArray(commandRecord.args) || !commandRecord.args.every((argument) => typeof argument === 'string')) {
      return validationDeclarationError(briefPath, `${evidencePath}.args must be an array containing only strings`);
    }
    const controlArgument = commandRecord.args.find((argument: string) => containsControlCharacter(argument));
    if (controlArgument !== undefined) {
      return validationDeclarationError(briefPath, `${evidencePath}.args must not contain a control character`);
    }
    declarations.push({
      role,
      command: commandRecord.command,
      args: [...commandRecord.args] as string[],
      evidencePath,
    });
  }
  return { commands: declarations };
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
  sourceOutputInventory: BriefOutputInventory,
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
    copies: [],
    sourceVerification,
    sourceOutputInventory,
  };
}

function worktreeFailureReason(response: GitWorktreeResponse): string {
  const detail = response.error || response.stderr?.trim() || response.stdout?.trim();
  const exit = response.exitCode === null ? 'without an exit code' : `with exit ${response.exitCode}`;
  return `Git worktree creation failed ${exit}${detail ? `: ${detail}` : ''}`;
}

function reconcileInputs(
  sourceVerification: BriefInputVerification,
  projectDir: string,
  targetDir: string,
  fs: ShipSetupFileSystem,
): { links: ShipSetupLink[]; copies: ShipSetupCopy[]; blockers: ShipSetupBlockerInput[] } {
  const links: ShipSetupLink[] = [];
  const copies: ShipSetupCopy[] = [];
  const blockers: ShipSetupBlockerInput[] = [];
  const targetCanonical = fs.realpath(targetDir);
  const normalizedInputPath = (sourcePath: string): string => relative(projectDir, sourcePath)
    .split(sep)
    .join('/');
  const addBlocker = (sourcePath: string, reason: string): void => {
    blockers.push({ phase: 'target', input: normalizedInputPath(sourcePath), reason });
  };
  const createMissingLink = (source: string, target: string, directory: boolean): void => {
    if (fs.entryExists(target)) {
      addBlocker(source, 'Target has an existing unreachable entry and will not be overwritten');
      return;
    }
    fs.createDirectory(dirname(target));
    const parentCanonical = fs.realpath(dirname(target));
    if (!within(targetCanonical, parentCanonical)) {
      addBlocker(source, 'Target parent resolves outside the worktree');
      return;
    }
    fs.createLink(source, target, directory ? 'dir' : 'file');
    links.push({
      path: normalizedInputPath(source),
      source,
      target,
      type: directory ? 'directory' : 'file',
    });
  };
  const copyMissingFile = (source: string, target: string): void => {
    if (fs.entryExists(target)) {
      addBlocker(source, 'Target has an existing unreachable entry and will not be overwritten');
      return;
    }
    fs.createDirectory(dirname(target));
    const parentCanonical = fs.realpath(dirname(target));
    if (!within(targetCanonical, parentCanonical)) {
      addBlocker(source, 'Target parent resolves outside the worktree');
      return;
    }
    fs.copyFile(source, target);
    const sourceBytes = Buffer.from(fs.readBytes(source));
    const targetBytes = Buffer.from(fs.readBytes(target));
    if (!sourceBytes.equals(targetBytes)) {
      addBlocker(source, 'Copied target descendant does not match the declared source bytes');
      return;
    }
    copies.push({ path: normalizedInputPath(source), source, target });
  };

  const reconcileExistingDirectory = (
    sourceDirectory: string,
    targetDirectory: string,
    sourceRootCanonical: string,
    ancestors: Set<string>,
  ): void => {
    let names: string[];
    try {
      names = [...fs.readDirectory(sourceDirectory)].sort();
    } catch (error) {
      addBlocker(sourceDirectory, `Cannot read declared directory contents: ${errorMessage(error)}`);
      return;
    }
    for (const name of names) {
      const source = join(sourceDirectory, name);
      const target = join(targetDirectory, name);
      try {
        if (!fs.exists(source) || !fs.readable(source)) {
          addBlocker(source, 'Source descendant is missing or unreadable');
          continue;
        }
        const sourceCanonical = fs.realpath(source);
        if (!within(sourceRootCanonical, sourceCanonical)) {
          addBlocker(source, 'Source descendant resolves outside the declared directory');
          continue;
        }
        const sourceDirectoryEntry = fs.stat(source).isDirectory();
        if (sourceDirectoryEntry && ancestors.has(sourceCanonical)) {
          addBlocker(source, 'Source directory contains a symlink cycle');
          continue;
        }
        if (!fs.exists(target)) {
          if (!sourceDirectoryEntry) {
            copyMissingFile(source, target);
            continue;
          }
          fs.createDirectory(target);
          const materializedCanonical = fs.realpath(target);
          if (!within(targetCanonical, materializedCanonical)) {
            addBlocker(source, 'Materialized target directory resolves outside the worktree');
            continue;
          }
          reconcileExistingDirectory(
            source,
            target,
            sourceRootCanonical,
            new Set([...ancestors, sourceCanonical]),
          );
          continue;
        }
        if (!fs.readable(target)) {
          addBlocker(source, 'Existing target descendant is not readable');
          continue;
        }
        const targetDirectoryEntry = fs.stat(target).isDirectory();
        if (sourceDirectoryEntry !== targetDirectoryEntry) {
          addBlocker(source, 'Target descendant has a file/directory type collision and will not be overwritten');
          continue;
        }
        const targetEntryCanonical = fs.realpath(target);
        if (!within(targetCanonical, targetEntryCanonical)) {
          addBlocker(
            source,
            targetEntryCanonical === sourceCanonical
              ? 'Existing target descendant is a source symlink; recreate the target so partial-directory files can be copied with target-rooted module paths'
              : 'Existing target descendant resolves outside the worktree and does not reference the declared source',
          );
          continue;
        }
        if (sourceDirectoryEntry) {
          reconcileExistingDirectory(
            source,
            target,
            sourceRootCanonical,
            new Set([...ancestors, sourceCanonical]),
          );
          continue;
        }
        const sourceBytes = Buffer.from(fs.readBytes(source));
        const targetBytes = Buffer.from(fs.readBytes(target));
        if (!sourceBytes.equals(targetBytes)) {
          addBlocker(source, 'Target descendant has a content collision and will not be overwritten');
        }
      } catch (error) {
        addBlocker(source, `Cannot reconcile declared directory descendant: ${errorMessage(error)}`);
      }
    }
  };

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
    try {
      const sourceDirectory = fs.stat(source).isDirectory();
      if (!fs.exists(target)) {
        createMissingLink(source, target, sourceDirectory);
        continue;
      }
      if (!fs.readable(target)) {
        blockers.push({ phase: 'target', input: input.path, reason: 'Existing declared target input is not readable' });
        continue;
      }
      const targetDirectoryEntry = fs.stat(target).isDirectory();
      if (sourceDirectory !== targetDirectoryEntry) {
        blockers.push({ phase: 'target', input: input.path, reason: 'Existing declared target input has a file/directory type collision and will not be overwritten' });
        continue;
      }
      const sourceCanonical = fs.realpath(source);
      const targetEntryCanonical = fs.realpath(target);
      if (!within(targetCanonical, targetEntryCanonical)) {
        if (targetEntryCanonical !== sourceCanonical) {
          blockers.push({ phase: 'target', input: input.path, reason: 'Existing declared target input resolves outside the worktree and does not reference the declared source' });
        }
        continue;
      }
      if (sourceDirectory) {
        reconcileExistingDirectory(source, target, sourceCanonical, new Set([sourceCanonical]));
      } else {
        const sourceBytes = Buffer.from(fs.readBytes(source));
        const targetBytes = Buffer.from(fs.readBytes(target));
        if (!sourceBytes.equals(targetBytes)) {
          blockers.push({ phase: 'target', input: input.path, reason: 'Existing declared target input has a content collision and will not be overwritten' });
        }
      }
    } catch (error) {
      blockers.push({
        phase: 'target',
        input: input.path,
        reason: `Cannot make declared input reachable: ${errorMessage(error)}`,
      });
    }
  }
  return { links, copies, blockers };
}

interface TestPopulationMethod {
  tool: 'vitest' | 'pytest' | 'declared-files';
  display: string;
  evidencePath: string;
  request?: ValidationRunRequest;
  declaredIdentities?: string[];
}

interface TestPopulationDiscovery {
  method?: TestPopulationMethod;
  reason?: string;
  hasConfiguredTests: boolean;
  validationUnknown: boolean;
  testCommand?: ValidationCommand;
  runner?: TestPopulationRunner;
}

interface TestPopulationComparison {
  population?: TestPopulationParity;
  sourceDiscovery: TestPopulationDiscovery;
  targetDiscovery: TestPopulationDiscovery;
}

function normalizedPopulationIdentity(projectDir: string, value: string): string {
  const absolute = resolve(projectDir, value);
  if (!within(projectDir, absolute)) throw new Error(`collector returned a path outside the project: ${value}`);
  const identity = relative(projectDir, absolute).split(sep).join('/');
  if (!identity || identity.startsWith('../')) throw new Error(`collector returned an invalid test identity: ${value}`);
  return identity;
}

function isPythonExecutable(command: string): boolean {
  return /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(basename(command));
}

function discoverTestPopulationMethod(
  projectDir: string,
  fs: ShipSetupFileSystem,
  declaredCommands: readonly BriefValidationCommand[],
): TestPopulationDiscovery {
  const validation = declaredCommands.length === 0
    ? discoverProjectValidation(projectDir, { exists: fs.exists, readText: fs.readText })
    : reconcileProjectValidation(projectDir, declaredCommands, { exists: fs.exists, readText: fs.readText });
  const testCommand = validation.commands.find((command) => command.role === 'test');
  if (!testCommand) {
    return {
      hasConfiguredTests: false,
      validationUnknown: validation.state === 'unknown',
      reason: validation.reason ?? 'No configured test command was discovered',
    };
  }

  let runner: TestPopulationRunner = {
    display: testCommand.display,
    command: testCommand.display,
    ...(testCommand.evidencePath ? { evidencePath: testCommand.evidencePath } : {}),
  };

  const packagePath = join(projectDir, 'package.json');
  if (fs.exists(packagePath)) {
    try {
      const manifest = JSON.parse(fs.readText(packagePath)) as Record<string, unknown>;
      const scripts = manifest.scripts && typeof manifest.scripts === 'object'
        ? manifest.scripts as Record<string, unknown>
        : undefined;
      const testScript = typeof scripts?.test === 'string' ? scripts.test : '';
      if (testScript.trim()) {
        runner = {
          display: testScript.trim(),
          command: testCommand.display,
          evidencePath: `${packagePath}#scripts.test`,
        };
      }
      const flowcrew = manifest.flowcrew && typeof manifest.flowcrew === 'object'
        ? manifest.flowcrew as Record<string, unknown>
        : undefined;
      const population = flowcrew?.testPopulation && typeof flowcrew.testPopulation === 'object'
        ? flowcrew.testPopulation as Record<string, unknown>
        : undefined;
      if (population && Array.isArray(population.files)) {
        if (!population.files.every((file) => typeof file === 'string')) {
          throw new Error('flowcrew.testPopulation.files must contain only strings');
        }
        const identities = [...new Set((population.files as string[])
          .map((file) => normalizedPopulationIdentity(projectDir, file)))].sort();
        for (const identity of identities) {
          const path = join(projectDir, identity);
          if (!fs.exists(path) || !fs.readable(path) || fs.stat(path).isDirectory()) {
            throw new Error(`declared test population member is not a readable file: ${identity}`);
          }
        }
        return {
          hasConfiguredTests: true,
          validationUnknown: false,
          testCommand,
          runner,
          method: {
            tool: 'declared-files',
            display: 'package.json flowcrew.testPopulation.files',
            evidencePath: packagePath,
            declaredIdentities: identities,
          },
        };
      }
      if (/(?:^|[\s;&|()])vitest(?:[\s;&|()]|$)/.test(testScript)) {
        const executable = join(projectDir, 'node_modules', 'vitest', 'vitest.mjs');
        return {
          hasConfiguredTests: true,
          validationUnknown: false,
          testCommand,
          runner,
          method: {
            tool: 'vitest',
            display: 'vitest list --filesOnly --json --passWithNoTests',
            evidencePath: `${packagePath}#scripts.test`,
            request: {
              role: 'test',
              command: process.execPath,
              args: [executable, 'list', '--filesOnly', '--json', '--passWithNoTests'],
              display: 'vitest list --filesOnly --json --passWithNoTests',
              evidencePath: packagePath,
              cwd: projectDir,
            },
          },
        };
      }
    } catch (error) {
      return {
        hasConfiguredTests: true,
        validationUnknown: false,
        testCommand,
        runner,
        reason: `Cannot derive test population from package.json: ${errorMessage(error)}`,
      };
    }
  }

  if (isPythonExecutable(testCommand.command)
      && testCommand.args[0] === '-m'
      && testCommand.args[1] === 'pytest') {
    const collectorArgs = [...testCommand.args, '--collect-only', '-q'];
    return {
      hasConfiguredTests: true,
      validationUnknown: false,
      testCommand,
      runner,
      method: {
        tool: 'pytest',
        display: [testCommand.command, ...collectorArgs].join(' '),
        evidencePath: testCommand.evidencePath ?? join(projectDir, 'pyproject.toml'),
        request: {
          ...testCommand,
          args: collectorArgs,
          display: [testCommand.command, ...collectorArgs].join(' '),
          cwd: projectDir,
        },
      },
    };
  }

  return {
    hasConfiguredTests: true,
    validationUnknown: false,
    testCommand,
    runner,
    reason: `Configured test runner "${runner.display}" (validation command "${runner.command}") has no exact population collector`,
  };
}

function parseCollectedTestIdentities(
  projectDir: string,
  method: TestPopulationMethod,
  response: ValidationRunResponse,
): string[] {
  if (method.declaredIdentities) return method.declaredIdentities;
  const stdout = response.stdout ?? '';
  const identities: string[] = [];
  if (method.tool === 'vitest') {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Vitest collector output is not a JSON array');
    for (const entry of parsed) {
      const file = typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).file === 'string'
          ? (entry as Record<string, unknown>).file as string
          : undefined;
      if (!file) throw new Error('Vitest collector returned an entry without a file path');
      identities.push(normalizedPopulationIdentity(projectDir, file));
    }
  } else if (method.tool === 'pytest') {
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      const nodeId = line.includes('::') ? line.slice(0, line.indexOf('::')) : '';
      if (!nodeId || !/\.py$/i.test(nodeId)) continue;
      identities.push(normalizedPopulationIdentity(projectDir, nodeId));
    }
  }
  return [...new Set(identities)].sort();
}

async function collectTestPopulation(
  projectDir: string,
  method: TestPopulationMethod,
  runner: ValidationCommandRunner,
): Promise<TestPopulationObservation> {
  const started = Date.now();
  let response: ValidationRunResponse;
  if (method.declaredIdentities) {
    response = { exitCode: 0, durationMs: 0 };
  } else {
    try {
      response = await runner(method.request!);
    } catch (error) {
      response = { exitCode: null, error: errorMessage(error) };
    }
  }
  const pytestEmpty = method.tool === 'pytest'
    && response.exitCode === 5
    && /no tests collected/i.test(`${response.stdout ?? ''}\n${response.stderr ?? ''}`);
  if (response.error || response.exitCode === null || (response.exitCode !== 0 && !pytestEmpty)) {
    throw new Error(
      response.error
        ?? `${method.display} exited ${response.exitCode}: ${(response.stderr ?? response.stdout ?? '').trim() || 'no diagnostic output'}`,
    );
  }
  const identities = parseCollectedTestIdentities(projectDir, method, response);
  return {
    projectDir,
    count: identities.length,
    identities,
    digest: createHash('sha256').update(identities.join('\0')).digest('hex'),
    durationMs: response.durationMs ?? Math.max(0, Date.now() - started),
  };
}

async function compareTestPopulations(
  sourceDir: string,
  targetDir: string,
  fs: ShipSetupFileSystem,
  runner: ValidationCommandRunner,
  declaredCommands: readonly BriefValidationCommand[],
): Promise<TestPopulationComparison> {
  const sourceDiscovery = discoverTestPopulationMethod(sourceDir, fs, declaredCommands);
  const targetDiscovery = discoverTestPopulationMethod(targetDir, fs, declaredCommands);
  const discoveries = { sourceDiscovery, targetDiscovery };
  if (!sourceDiscovery.hasConfiguredTests && !targetDiscovery.hasConfiguredTests) return discoveries;
  if (targetDiscovery.validationUnknown) return discoveries;
  if (sourceDiscovery.hasConfiguredTests !== targetDiscovery.hasConfiguredTests) {
    return {
      ...discoveries,
      population: {
        version: 1,
        state: 'mismatched',
        missingFromTarget: [],
        extraInTarget: [],
        reason: sourceDiscovery.hasConfiguredTests
          ? 'The source has a configured test command, but the target does not'
          : 'The target has a configured test command, but the source does not',
      },
    };
  }
  const populationRunner = sourceDiscovery.runner && targetDiscovery.runner
    ? { source: sourceDiscovery.runner, target: targetDiscovery.runner }
    : undefined;
  if (!sourceDiscovery.method || !targetDiscovery.method) {
    const reasons = [...new Set([sourceDiscovery.reason, targetDiscovery.reason].filter(
      (reason): reason is string => Boolean(reason),
    ))];
    return {
      ...discoveries,
      population: {
        version: 1,
        state: 'unverified',
        ...(populationRunner ? { runner: populationRunner } : {}),
        missingFromTarget: [],
        extraInTarget: [],
        reason: reasons.join('; '),
      },
    };
  }
  if (sourceDiscovery.method.tool !== targetDiscovery.method.tool) {
    return {
      ...discoveries,
      population: {
        version: 1,
        state: 'unverified',
        ...(populationRunner ? { runner: populationRunner } : {}),
        missingFromTarget: [],
        extraInTarget: [],
        reason: `Source collector ${sourceDiscovery.method.tool} differs from target collector ${targetDiscovery.method.tool}`,
      },
    };
  }
  try {
    const source = await collectTestPopulation(sourceDir, sourceDiscovery.method, runner);
    const target = await collectTestPopulation(targetDir, targetDiscovery.method, runner);
    const sourceSet = new Set(source.identities);
    const targetSet = new Set(target.identities);
    const missingFromTarget = source.identities.filter((identity) => !targetSet.has(identity));
    const extraInTarget = target.identities.filter((identity) => !sourceSet.has(identity));
    return {
      ...discoveries,
      population: {
        version: 1,
        state: missingFromTarget.length === 0 && extraInTarget.length === 0 ? 'matched' : 'mismatched',
        method: {
          tool: sourceDiscovery.method.tool,
          display: sourceDiscovery.method.display,
          evidencePath: sourceDiscovery.method.evidencePath,
        },
        source,
        target,
        missingFromTarget,
        extraInTarget,
      },
    };
  } catch (error) {
    return {
      ...discoveries,
      population: {
        version: 1,
        state: 'unverified',
        ...(populationRunner ? { runner: populationRunner } : {}),
        method: {
          tool: sourceDiscovery.method.tool,
          display: sourceDiscovery.method.display,
          evidencePath: sourceDiscovery.method.evidencePath,
        },
        missingFromTarget: [],
        extraInTarget: [],
        reason: `Cannot collect exact source/target test populations using ${sourceDiscovery.method.evidencePath}: ${errorMessage(error)}`,
      },
    };
  }
}

interface ObservedValidationRun {
  response: ValidationRunResponse;
  durationMs: number;
}

async function observeValidationRun(
  request: ValidationRunRequest,
  runner: ValidationCommandRunner,
): Promise<ObservedValidationRun> {
  const started = Date.now();
  try {
    const response = await runner(request);
    return {
      response,
      durationMs: response.durationMs ?? Math.max(0, Date.now() - started),
    };
  } catch (error) {
    return {
      response: { exitCode: null, error: errorMessage(error) },
      durationMs: Math.max(0, Date.now() - started),
    };
  }
}

interface TapPopulationParse {
  observation?: TestPopulationObservation;
  reason?: string;
}

function parseTapPopulation(
  projectDir: string,
  observed: ObservedValidationRun | undefined,
): TapPopulationParse {
  if (!observed) return { reason: 'the test command was not observed' };
  const { response, durationMs } = observed;
  if (response.error || response.exitCode === null) {
    return { reason: response.error ?? 'the test command ended without an exit code' };
  }
  const output = [response.stdout, response.stderr]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
  const parsed = parseTapOutput(output);
  if (parsed.state !== 'complete') return { reason: parsed.reason };
  const occurrences = new Map<string, number>();
  const identities = parsed.records.map(({ name }) => {
    const occurrence = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, occurrence);
    return `${occurrence}:${name}`;
  });
  return {
    observation: {
      projectDir,
      count: identities.length,
      identities,
      digest: createHash('sha256').update(identities.join('\0')).digest('hex'),
      durationMs,
    },
  };
}

function derivePopulationFromBaselineOutput(
  initial: TestPopulationParity,
  sourceDir: string,
  targetDir: string,
  sourceRun: ObservedValidationRun | undefined,
  targetRun: ObservedValidationRun | undefined,
): TestPopulationParity {
  const sourceParsed = parseTapPopulation(sourceDir, sourceRun);
  const targetParsed = parseTapPopulation(targetDir, targetRun);
  const collectorReason = initial.reason ?? 'an exact collector was unavailable';
  if (sourceParsed.observation && targetParsed.observation) {
    const sourceSet = new Set(sourceParsed.observation.identities);
    const targetSet = new Set(targetParsed.observation.identities);
    const missingFromTarget = sourceParsed.observation.identities
      .filter((identity) => !targetSet.has(identity));
    const extraInTarget = targetParsed.observation.identities
      .filter((identity) => !sourceSet.has(identity));
    const sourcePlusAdditions = missingFromTarget.length === 0 && extraInTarget.length > 0;
    return {
      version: 1,
      state: missingFromTarget.length === 0 ? 'matched' : 'mismatched',
      ...(initial.runner ? { runner: initial.runner } : {}),
      method: {
        source: 'baseline_output',
        format: 'tap',
        display: 'complete top-level TAP from source and target test executions',
        evidencePath: 'source and target test command output',
      },
      source: sourceParsed.observation,
      target: targetParsed.observation,
      missingFromTarget,
      extraInTarget,
      reason: sourcePlusAdditions
        ? `Exact collection was unavailable (${collectorReason}); SOURCE-PLUS-ADDITIONS: complete target TAP covers every source identity, with additions recorded in extraInTarget.`
        : `Exact collection was unavailable (${collectorReason}); population parity was derived from complete TAP emitted by the source run and target baseline.`,
    };
  }
  const runner = initial.runner?.source.display ?? initial.runner?.source.command ?? 'configured test command';
  return {
    version: 1,
    state: 'unverified',
    ...(initial.runner ? { runner: initial.runner } : {}),
    ...(sourceParsed.observation ? { source: sourceParsed.observation } : {}),
    ...(targetParsed.observation ? { target: targetParsed.observation } : {}),
    missingFromTarget: [],
    extraInTarget: [],
    reason: `Population parity for runner "${runner}" is unverified: exact collection was unavailable (${collectorReason}); source output: ${sourceParsed.reason ?? 'complete TAP parsed'}; target baseline output: ${targetParsed.reason ?? 'complete TAP parsed'}.`,
  };
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
  const declaredValidation = parseBriefValidationCommands(brief, briefPath);
  const sourceVerification = verifyBriefInputs(brief, projectDir, deps.fs);
  const sourceOutputInventory = inspectBriefOutputs(brief, projectDir, deps.fs);
  let facts = setupFacts(
    projectDir,
    targetDir,
    briefPath,
    measuredBrief.digest,
    parsed,
    sourceVerification,
    sourceOutputInventory,
  );
  if (declaredValidation.error) {
    return refused(facts, [{ phase: 'validation', reason: declaredValidation.error }]);
  }
  const sourceBlockers = verificationBlockers('source', sourceVerification);
  if (sourceBlockers.length > 0) return refused(facts, sourceBlockers);
  if (sourceOutputInventory.blocking.length > 0) {
    return refused(facts, sourceOutputInventory.blocking.map((entry) => ({
      phase: 'source' as const,
      input: entry.path,
      reason: entry.reason ?? 'Declared output path is already occupied',
      repair: `Choose a fresh output path, or declare an explicit on_existing disposition when the existing ${entry.entryType} is intentionally consumed.`,
    })));
  }
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

  let reconciled: { links: ShipSetupLink[]; copies: ShipSetupCopy[]; blockers: ShipSetupBlockerInput[] };
  try {
    reconciled = reconcileInputs(sourceVerification, projectDir, targetDir, deps.fs);
  } catch (error) {
    return refused(facts, [{ phase: 'target', reason: `Cannot inspect target worktree: ${errorMessage(error)}` }]);
  }
  facts = { ...facts, links: reconciled.links, copies: reconciled.copies };
  if (reconciled.blockers.length > 0) return refused(facts, reconciled.blockers);

  const targetVerification = verifyBriefInputs(brief, targetDir, deps.fs);
  const targetOutputInventory = inspectBriefOutputs(brief, targetDir, deps.fs);
  facts = { ...facts, targetVerification, targetOutputInventory };
  const targetBlockers = verificationBlockers('target', targetVerification);
  if (targetBlockers.length > 0) return refused(facts, targetBlockers);
  if (targetOutputInventory.blocking.length > 0) {
    return refused(facts, targetOutputInventory.blocking.map((entry) => ({
      phase: 'target' as const,
      input: entry.path,
      reason: entry.reason ?? 'Declared output path is already occupied in the target worktree',
      repair: `Choose a fresh output path, or declare an explicit on_existing disposition when the target ${entry.entryType} is intentionally updated.`,
    })));
  }

  const populationComparison = await compareTestPopulations(
    projectDir,
    targetDir,
    deps.fs,
    deps.runTestCollectionCommand,
    declaredValidation.commands,
  );
  let testPopulation = populationComparison.population;
  if (testPopulation) facts = { ...facts, testPopulation };
  if (testPopulation?.state === 'mismatched') {
    const missing = testPopulation.missingFromTarget.length > 0
      ? `; missing from target: ${testPopulation.missingFromTarget.join(', ')}`
      : '';
    const extra = testPopulation.extraInTarget.length > 0
      ? `; extra in target: ${testPopulation.extraInTarget.join(', ')}`
      : '';
    const reason = testPopulation.reason ? `; ${testPopulation.reason}` : '';
    return refused(facts, [{
      phase: 'validation',
      reason: `Test population mismatch before baseline: source=${testPopulation.source?.count ?? 'unknown'}, target=${testPopulation.target?.count ?? 'unknown'}${missing}${extra}${reason}`,
    }]);
  }

  const needsOutputFallback = testPopulation?.state === 'unverified';
  const baselineRunner = deps.runValidationCommand ?? runValidationCommand;
  let sourceTestRun: ObservedValidationRun | undefined;
  if (needsOutputFallback && populationComparison.sourceDiscovery.testCommand) {
    sourceTestRun = await observeValidationRun({
      ...populationComparison.sourceDiscovery.testCommand,
      cwd: projectDir,
    }, baselineRunner);
  }
  let targetTestRun: ObservedValidationRun | undefined;
  const observingBaselineRunner: ValidationCommandRunner = (request) => {
    if (request.role !== 'test') return baselineRunner(request);
    return observeValidationRun(request, baselineRunner).then((observed) => {
      targetTestRun = observed;
      return observed.response;
    });
  };
  const validationBaseline = await runProjectValidationBaseline(targetDir, {
    fs: { exists: deps.fs.exists, readText: deps.fs.readText },
    ...(needsOutputFallback
      ? { runCommand: observingBaselineRunner }
      : deps.runValidationCommand ? { runCommand: deps.runValidationCommand } : {}),
    declaredCommands: declaredValidation.commands,
  });
  facts = { ...facts, validationBaseline };
  if (needsOutputFallback && testPopulation) {
    testPopulation = derivePopulationFromBaselineOutput(
      testPopulation,
      projectDir,
      targetDir,
      sourceTestRun,
      targetTestRun,
    );
    facts = { ...facts, testPopulation };
  }
  const validationBlockers: ShipSetupBlockerInput[] = validationBaseline.discovery.state === 'unknown'
    ? [{
        phase: 'validation',
        reason: `Validation baseline is unknown: ${validationBaseline.discovery.reason ?? 'no build, test, or lint command could be inferred'}`,
      }]
    : [];
  validationBlockers.push(...validationBaseline.results
    .filter((result) => result.state === 'launch_error')
    .map((result): ShipSetupBlockerInput => {
      const command = validationBaseline.discovery.commands.find((candidate) => candidate.role === result.role);
      const declaration = command?.provenance?.source === 'brief'
        ? ` declared at ${command.provenance.evidencePath}`
        : '';
      return {
        phase: 'validation',
        reason: `Cannot launch ${result.role} baseline${result.display ? ` (${result.display})` : ''}${declaration}: ${result.reason ?? 'command ended without an exit code'}`,
      };
    }));
  if (validationBlockers.length > 0) return refused(facts, validationBlockers);
  if (testPopulation?.state === 'mismatched') {
    const missing = testPopulation.missingFromTarget.length > 0
      ? `; missing from target: ${testPopulation.missingFromTarget.join(', ')}`
      : '';
    const extra = testPopulation.extraInTarget.length > 0
      ? `; extra in target: ${testPopulation.extraInTarget.join(', ')}`
      : '';
    const reason = testPopulation.reason ? `; ${testPopulation.reason}` : '';
    return refused(facts, [{
      phase: 'validation',
      reason: `Test population mismatch from baseline output: source=${testPopulation.source?.count ?? 'unknown'}, target=${testPopulation.target?.count ?? 'unknown'}${missing}${extra}${reason}`,
    }]);
  }
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

function renderOutputInventory(label: string, inventory: BriefOutputInventory, writer: Writer): void {
  writer.write(`${label} outputs: ${inventory.entries.length} checked; ${inventory.blocking.length} blocking\n`);
  for (const entry of inventory.entries) {
    writer.write(`  ${entry.blocking ? 'BLOCKED' : entry.exists ? 'EXISTS-ALLOWED' : 'ABSENT'} ${entry.path} (${entry.entryType}, on_existing=${entry.disposition})${entry.size === undefined ? '' : ` size=${entry.size}`}\n`);
  }
}

function renderVerification(report: ShipSetupReport, writer: Writer): void {
  renderInputVerification('Source', report.sourceVerification, writer);
  renderOutputInventory('Source', report.sourceOutputInventory, writer);
  if (report.targetVerification) renderInputVerification('Target', report.targetVerification, writer);
  if (report.targetOutputInventory) renderOutputInventory('Target', report.targetOutputInventory, writer);
  for (const link of report.links) writer.write(`  LINK ${link.path} -> ${link.source}\n`);
  for (const copy of report.copies) writer.write(`  COPY ${copy.path} <- ${copy.source}\n`);
}

function renderHuman(report: ShipSetupReport, writer: Writer): void {
  writer.write(`Ship setup: ${report.state.toUpperCase()}\n`);
  writer.write(`Project: ${report.projectDir}\nTarget: ${report.targetDir}\n`);
  writer.write(`Brief digest: ${report.briefDigest}\n`);
  writer.write(`Git: branch ${report.branch} at base ${report.base}\n`);
  renderVerification(report, writer);
  if (report.testPopulation) {
    writer.write(
      `Test population: ${report.testPopulation.state.toUpperCase()}`
      + `${report.testPopulation.source ? ` source=${report.testPopulation.source.count}` : ''}`
      + `${report.testPopulation.target ? ` target=${report.testPopulation.target.count}` : ''}\n`,
    );
    if (report.testPopulation.runner) {
      const { source, target } = report.testPopulation.runner;
      writer.write(`  runner: ${source.display}${source.command === source.display ? '' : ` (invoked as ${source.command})`}\n`);
      if (target.display !== source.display || target.command !== source.command) {
        writer.write(`  target runner: ${target.display}${target.command === target.display ? '' : ` (invoked as ${target.command})`}\n`);
      }
    }
    if (report.testPopulation.method) {
      writer.write(`${'tool' in report.testPopulation.method ? '  collector' : '  evidence'}: ${report.testPopulation.method.display}\n`);
    }
    if (report.testPopulation.state === 'matched' && report.testPopulation.extraInTarget.length > 0) {
      writer.write('  relation: SOURCE-PLUS-ADDITIONS\n');
      writer.write(`  extra in target: ${report.testPopulation.extraInTarget.join(', ')}\n`);
    }
    if (report.testPopulation.reason) writer.write(`  reason: ${report.testPopulation.reason}\n`);
  }
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
    writer.write(`    REPAIR [${blocker.phase}]: ${blocker.repair ?? shipSetupBlockerRepair(blocker)}\n`);
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
