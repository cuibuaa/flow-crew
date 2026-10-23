import { errorMessage, within } from './source_services/cli-inputs.js';
import { CliUsageError, commandUsage, parseCommandArgs } from './cli-args.js';
import { createHash } from 'node:crypto';
import { hashRollbackFileSync } from './rollback-content-store.js';
import { spawn } from 'node:child_process';
import { atomicWrite, copyFileSync, mkdirSync, rmSync, symlinkSync } from './engine-fs.js';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseBriefFrontmatterDocument } from './brief-frontmatter.js';
import { briefDeclarationFailures } from './brief-preflight.js';
import {
  reconcileProjectValidation,
  runProjectValidationBaseline,
  unmeasured,
  type BriefValidationCommand,
  type ProjectValidationBaseline,
  type ValidationCommandRunner,
  type ValidationRole,
} from './project-validation.js';
import {
  verifyDeclaredBriefInputs,
  inspectBriefOutputs,
  type BriefOutputInventory,
  type BriefInputVerification,
  type ShipInputFileSystem,
} from './ship-inputs.js';
import { loadEngineDefaults } from './config.js';
import { fcGlobalDir } from './store.js';
import { reuseShipSetupBaseline, shipSetupReadyRecordPath } from './ship-setup-record.js';
import { requireDiskCapacity } from './disk-admission.js';

export { shipSetupReadyRecordPath } from './ship-setup-record.js';

type Writer = { write(chunk: string): unknown };

export interface ShipSetupFileSystem extends ShipInputFileSystem {
  realpath(path: string): string;
  entryExists(path: string): boolean;
  createDirectory(path: string): void;
  /** Reserve a previously absent directory; throw instead of adopting it. */
  createDirectoryExclusive(path: string): void;
  createLink(source: string, target: string, type: 'file' | 'dir'): void;
  copyFile(source: string, target: string): void;
  filesEqual(source: string, target: string): boolean;
  removeEntry(path: string): void;
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

export const nodeShipSetupFileSystem: ShipSetupFileSystem = {
  exists: existsSync,
  readable: nodeReadable,
  readText: (path) => readFileSync(path, 'utf-8'),
  readBytes: (path) => readFileSync(path),
  hashFile: hashRollbackFileSync,
  readDirectory: (path) => readdirSync(path),
  stat: (path) => statSync(path),
  lstat: (path) => lstatSync(path),
  readlink: (path) => readlinkSync(path),
  realpath: (path) => realpathSync.native(path),
  entryExists: nodeEntryExists,
  createDirectory: (path) => mkdirSync(path, { recursive: true }),
  createDirectoryExclusive: (path) => {
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(path);
  },
  createLink: (source, target, type) => symlinkSync(source, target, type),
  copyFile: (source, target) => copyFileSync(source, target, constants.COPYFILE_EXCL),
  filesEqual: (source, target) => {
    const sourceHash = hashRollbackFileSync(source);
    const targetHash = hashRollbackFileSync(target);
    return sourceHash.byteLength === targetHash.byteLength && sourceHash.sha256 === targetHash.sha256;
  },
  removeEntry: (path) => rmSync(path, { recursive: true, force: true }),
  writeAtomic: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    // Setup briefs and configuration must survive before setup reports success.
    atomicWrite(path, contents, { durability: 'durable' });
  },
};

export interface GitCommandProgress {
  elapsedMs: number;
  message: string;
}

export interface GitWorktreeRequest {
  projectDir: string;
  targetDir: string;
  base: string;
  branch: string;
  /** The managed setup transaction atomically created this branch already. */
  branchAlreadyCreated?: boolean;
  timeoutMs?: number;
  onProgress?: (progress: GitCommandProgress) => void;
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
  timeoutMs?: number;
  onProgress?: (progress: GitCommandProgress) => void;
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
  const startedAt = Date.now();
  const child = spawn(
    request.command,
    request.args,
    {
      cwd: request.cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: request.timeoutMs ?? 5 * 60 * 1_000,
    },
  );
  let stdout = '';
  let stderr = '';
  let launchError: string | undefined;
  let settled = false;
  const reportProgress = (): void => request.onProgress?.({
    elapsedMs: Math.max(0, Date.now() - startedAt),
    message: `${request.args.slice(0, 2).join(' ')} still running`,
  });
  reportProgress();
  const progressTimer = setInterval(reportProgress, 15_000);
  progressTimer.unref();
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
    clearInterval(progressTimer);
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
    args: request.branchAlreadyCreated
      ? ['worktree', 'add', '--', request.targetDir, request.branch.replace(/^refs\/heads\//, '')]
      : ['worktree', 'add', '-b', request.branch, '--', request.targetDir, request.base],
    cwd: request.projectDir,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.onProgress ? { onProgress: request.onProgress } : {}),
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
  managedWorktreeCreation: boolean;
  runGitCommand: GitCommandRunner;
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

export interface ShipSetupCopy {
  path: string;
  source: string;
  target: string;
}

export interface ShipSetupBlocker {
  phase: 'source' | 'worktree' | 'target' | 'validation' | 'record';
  code?: string;
  reason: string;
  repair: string;
  input?: string;
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
  worktreeReused: boolean;
  links: ShipSetupLink[];
  copies: ShipSetupCopy[];
  sourceVerification: BriefInputVerification;
  sourceOutputInventory: BriefOutputInventory;
  targetVerification?: BriefInputVerification;
  targetOutputInventory?: BriefOutputInventory;
  validationBaseline?: ProjectValidationBaseline;
  baselineReuse?: { state: 'executed' | 'reused'; id?: string };
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
  ready: false;
  createdAt: string;
  readyRecordPath?: string;
}

export type ShipSetupReport = ShipSetupReadyReport | ShipSetupRefusedReport;

function resolveDependencies(overrides: ShipSetupDependencies): ResolvedShipSetupDependencies {
  const git = overrides.runGitCommand ?? runGitCommand;
  return {
    cwd: resolve(overrides.cwd ?? process.cwd()),
    fs: overrides.fs ?? nodeShipSetupFileSystem,
    createWorktree: overrides.createWorktree
      ?? ((request) => createGitWorktree(request, git)),
    managedWorktreeCreation: overrides.createWorktree === undefined,
    runGitCommand: git,
    ...(overrides.runValidationCommand ? { runValidationCommand: overrides.runValidationCommand } : {}),
    globalDir: overrides.globalDir ?? fcGlobalDir,
    timestamp: overrides.timestamp ?? (() => new Date().toISOString()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
  };
}

export function parseShipSetupArgs(args: string[]): ParsedShipSetupArgs {
  const { help, flags, values } = parseCommandArgs('ship-setup', args);
  return {
    help,
    json: flags.has('--json'),
    brief: values.get('--brief'),
    target: values.get('--target'),
    base: values.get('--base'),
    branch: values.get('--branch'),
    project: values.get('--project'),
  };
}

export function shipSetupUsage(): string {
  return [
    commandUsage('ship-setup'),
    'Creates the exact worktree, overlays missing declared-input descendants, verifies declared inputs, and records the validation baseline.',
  ].join('\n');
}

function verificationBlockers(
  phase: 'source' | 'target',
  verification: BriefInputVerification,
): ShipSetupBlockerInput[] {
  const blockers: ShipSetupBlockerInput[] = verification.unresolvedInputs.map((input) => ({
    phase, input: input.value,
    reason: `Unresolved explicit input at line ${input.line}: ${input.reason}`,
  }));
  for (const input of verification.inputs) {
    if (!input.exists) blockers.push({
      phase,
      input: input.path,
      reason: `Declared input does not exist${input.checkedLocations?.length ? `; checked ${input.checkedLocations.join(' and ')}` : ''}`,
    });
    else if (!input.readable) blockers.push({ phase, input: input.path, reason: 'Declared input is not readable' });
  }
  return blockers;
}

async function verifyDeclaredInputsAgainstSourceAndBase(
  brief: string,
  projectDir: string,
  base: string,
  fs: ShipSetupFileSystem,
  runner: GitCommandRunner,
): Promise<BriefInputVerification> {
  const source = verifyDeclaredBriefInputs(brief, projectDir, fs);
  const inputs = await Promise.all(source.inputs.map(async (input) => {
    const sourceLocation = `source working tree ${projectDir}`;
    if (input.exists) {
      return {
        ...input,
        sourceExists: true,
        checkedLocations: [sourceLocation],
      };
    }
    let response: GitWorktreeResponse;
    try {
      response = await runner({
        command: 'git',
        args: ['cat-file', '-e', `${base}:${input.path}`],
        cwd: projectDir,
      });
    } catch (error) {
      response = { exitCode: null, error: errorMessage(error) };
    }
    const baseRefExists = response.exitCode === 0 && !response.error;
    return {
      ...input,
      // Reachability through the exact checkout base is sufficient for source
      // admission. Target verification performs the readable/content checks
      // after Git materializes the worktree.
      exists: baseRefExists,
      readable: baseRefExists,
      sourceExists: false,
      baseRefExists,
      checkedLocations: [sourceLocation, `base ref ${base}`],
    };
  }));
  return { ...source, inputs };
}

function refused(
  facts: Omit<ShipSetupFacts, 'blockers'>,
  blockers: ShipSetupBlockerInput[],
): ShipSetupRefusedReport {
  return {
    ...facts,
    state: 'refused',
    ready: false,
    createdAt: new Date().toISOString(),
    blockers: blockers.map((blocker) => ({
      ...blocker,
      repair: blocker.repair ?? shipSetupBlockerRepair(blocker),
    })),
  };
}

function persistRefused(
  facts: Omit<ShipSetupFacts, 'blockers'>,
  blockers: ShipSetupBlockerInput[],
  targetDir: string,
  deps: ResolvedShipSetupDependencies,
): ShipSetupRefusedReport {
  let report = { ...refused(facts, blockers), createdAt: deps.timestamp() };
  try {
    if (!deps.fs.entryExists(targetDir) || !deps.fs.stat(targetDir).isDirectory()) return report;
    const targetCanonicalDir = deps.fs.realpath(targetDir);
    const readyRecordPath = shipSetupReadyRecordPath(targetCanonicalDir, facts.briefDigest, deps.globalDir());
    report = { ...report, targetCanonicalDir, readyRecordPath };
    deps.fs.writeAtomic(readyRecordPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    report.blockers.push({
      phase: 'record',
      reason: `Cannot atomically persist the refused setup record: ${errorMessage(error)}`,
      repair: 'Repair the FC-global setup record directory, then rerun ship-setup.',
    });
  }
  return report;
}

function shipSetupBlockerRepair(blocker: ShipSetupBlockerInput): string {
  const subject = blocker.input ? ` ${JSON.stringify(blocker.input)}` : '';
  if (blocker.phase === 'source') {
    return `Correct or remove the named leading input${subject}, ensure required source data is readable, then rerun ship-setup.`;
  }
  if (blocker.phase === 'worktree') {
    return 'Inspect the reported Git base, branch, and target; correct the conflicting value or Git failure, then rerun ship-setup with a fresh reachable target.';
  }
  if (blocker.phase === 'target') {
    return `Reconcile the named target input${subject} without overwriting unique data, ensure it stays inside the worktree and is readable, then rerun ship-setup.`;
  }
  if (blocker.phase === 'validation') {
    return 'Correct the named validation declaration, command/environment; run that command successfully from the target, then rerun ship-setup.';
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
  const frontmatter = parseBriefFrontmatterDocument(brief);
  if (!frontmatter) return { commands: [] };
  if (frontmatter.error) return { commands: [], error: frontmatter.error };
  const parsed = frontmatter.value;
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
    worktreeReused: false,
    links: [],
    copies: [],
    sourceVerification,
    sourceOutputInventory,
  };
}

/** Count declared input destinations once, including overlapping input roots.
 * Existing targets are reconciled later; admission never authorizes overwrites.
 * Logical sizes also cover copies that cannot use sparse files or reflinks. */
async function estimateInputCopyBytes(
  verification: BriefInputVerification, projectDir: string, targetDir: string,
  deps: ResolvedShipSetupDependencies,
): Promise<number> {
  const fs = deps.fs;
  const files = new Map<string, number>();
  const count = (path: string, bytes: number): void => { files.set(path, Math.max(files.get(path) ?? 0, bytes)); };
  const add = (source: string, root: string, ancestors: Set<string>, explicit: boolean): void => {
    const path = relative(projectDir, source).split(sep).join('/');
    const info = fs.lstat ? fs.lstat(source) : fs.stat(source);
    const canonical = fs.realpath(source);
    // Nested symlinks are recreated, not recursively flattened by reconciliation.
    if (!explicit && info.isSymbolicLink?.() && !fs.exists(resolve(targetDir, path))) {
      count(path, info.size ?? Buffer.byteLength(fs.readlink?.(source) ?? ''));
      return;
    }
    if (!within(root, canonical)) throw new Error(`Cannot estimate input outside declared directory: ${path}`);
    const stat = fs.stat(source);
    if (stat.isDirectory()) {
      if (ancestors.has(canonical)) throw new Error(`Cannot estimate cyclic input: ${path}`);
      const next = new Set([...ancestors, canonical]);
      for (const name of fs.readDirectory(source)) add(join(source, name), root, next, false);
    } else if (!fs.entryExists(resolve(targetDir, path))) {
      count(path, stat.size ?? fs.readBytes(source).byteLength);
    }
  };
  for (const input of verification.inputs) {
    if (input.sourceExists === false && input.baseRefExists === true) continue;
    const source = resolve(projectDir, input.path);
    add(source, fs.realpath(source), new Set(), true);
  }
  return [...files.values()].reduce((sum, bytes) => sum + bytes, 0);
}

function worktreeFailureReason(response: GitWorktreeResponse): string {
  const detail = response.error || response.stderr?.trim() || response.stdout?.trim();
  const exit = response.exitCode === null ? 'without an exit code' : `with exit ${response.exitCode}`;
  return `Git worktree creation failed ${exit}${detail ? `: ${detail}` : ''}`;
}

interface WorktreeIdentity {
  path: string;
  head?: string;
  branch?: string;
}

function parseWorktreeIdentities(raw: string): WorktreeIdentity[] {
  const fields = raw.includes('\0') ? raw.split('\0') : raw.split(/\r?\n/);
  const records: WorktreeIdentity[] = [];
  let current: WorktreeIdentity | undefined;
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
      current = { path: field.slice('worktree '.length) };
      continue;
    }
    if (!current) continue;
    if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length);
    else if (field.startsWith('branch refs/heads/')) current.branch = field.slice('branch refs/heads/'.length);
  }
  finish();
  return records;
}

interface ManagedWorktreeOwnership {
  targetReserved: true;
  branchRef: string;
  branchOid: string;
}

interface ManagedWorktreePreparation {
  request?: GitWorktreeRequest;
  ownership?: ManagedWorktreeOwnership;
  failureReason?: string;
  cleanup: string[];
}

function gitOperationFailure(action: string, response: GitWorktreeResponse): string {
  const detail = response.error || response.stderr?.trim() || response.stdout?.trim();
  const exit = response.exitCode === null ? 'without an exit code' : `with exit ${response.exitCode}`;
  return `${action} failed ${exit}${detail ? `: ${detail}` : ''}`;
}

/**
 * Establish resources with invocation-specific ownership before checkout:
 * an OS-exclusive target directory and an atomic zero-old-value branch ref.
 */
async function prepareManagedWorktree(
  request: GitWorktreeRequest,
  runner: GitCommandRunner,
  fs: ShipSetupFileSystem,
): Promise<ManagedWorktreePreparation> {
  let base: GitWorktreeResponse;
  try {
    base = await runner({
      command: 'git',
      args: ['rev-parse', '--verify', '--end-of-options', `${request.base}^{commit}`],
      cwd: request.projectDir,
    });
  } catch (error) {
    base = { exitCode: null, error: errorMessage(error) };
  }
  if (base.exitCode !== 0 || base.error) {
    return { cleanup: [], failureReason: gitOperationFailure(`Git base resolution for ${request.base}`, base) };
  }
  const branchOid = (base.stdout ?? '').trim().split(/\r?\n/, 1)[0];
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(branchOid)) {
    return { cleanup: [], failureReason: `Git base resolution for ${request.base} returned no commit object ID` };
  }

  try {
    fs.createDirectoryExclusive(request.targetDir);
  } catch (error) {
    return {
      cleanup: [],
      failureReason: `Target could not be reserved exclusively at ${request.targetDir}: ${errorMessage(error)}`,
    };
  }

  const branchRef = `refs/heads/${request.branch.replace(/^refs\/heads\//, '')}`;
  let branch: GitWorktreeResponse;
  try {
    branch = await runner({
      command: 'git',
      args: ['update-ref', '--create-reflog', branchRef, branchOid, '0'.repeat(branchOid.length)],
      cwd: request.projectDir,
    });
  } catch (error) {
    branch = { exitCode: null, error: errorMessage(error) };
  }
  if (branch.exitCode !== 0 || branch.error) {
    const cleanup: string[] = [];
    try {
      if (fs.entryExists(request.targetDir)) fs.removeEntry(request.targetDir);
      cleanup.push('removed exclusively reserved target');
    } catch (error) {
      cleanup.push(`could not remove exclusively reserved target: ${errorMessage(error)}`);
    }
    return {
      cleanup,
      failureReason: gitOperationFailure(`Atomic branch creation for ${branchRef}`, branch),
    };
  }

  return {
    cleanup: [],
    ownership: { targetReserved: true, branchRef, branchOid },
    request: { ...request, branchAlreadyCreated: true },
  };
}

async function rollbackOwnedFailedWorktree(
  request: GitWorktreeRequest,
  ownership: ManagedWorktreeOwnership,
  runner: GitCommandRunner,
  fs: ShipSetupFileSystem,
): Promise<string[]> {
  const diagnostics: string[] = [];
  let registered = false;
  let inventoryKnown = false;
  try {
    const inventory = await runner({
      command: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: request.projectDir,
    });
    if (inventory.exitCode === 0 && !inventory.error) {
      inventoryKnown = true;
      const expectedBranch = request.branch.replace(/^refs\/heads\//, '');
      registered = parseWorktreeIdentities(inventory.stdout ?? '').some((identity) => (
        resolve(identity.path) === resolve(request.targetDir) && identity.branch === expectedBranch
      ));
    }
  } catch (error) {
    diagnostics.push(`could not inspect worktree residue: ${errorMessage(error)}`);
  }

  let registrationRemoved = !registered;
  if (registered) {
    try {
      const removed = await runner({
        command: 'git',
        args: ['worktree', 'remove', '--force', '--', request.targetDir],
        cwd: request.projectDir,
      });
      registrationRemoved = removed.exitCode === 0 && !removed.error;
      diagnostics.push(registrationRemoved
        ? 'removed registered partial worktree'
        : `Git could not remove registered partial worktree: ${worktreeFailureReason(removed)}`);
    } catch (error) {
      diagnostics.push(`Git could not remove registered partial worktree: ${errorMessage(error)}`);
    }
  }
  // The exclusive mkdir, not an absence-before observation, proves ownership.
  if (ownership.targetReserved && inventoryKnown && registrationRemoved && fs.entryExists(request.targetDir)) {
    try {
      fs.removeEntry(request.targetDir);
      diagnostics.push('removed invocation-owned partial target');
    } catch (error) {
      diagnostics.push(`could not remove invocation-owned partial target: ${errorMessage(error)}`);
    }
  }

  if (!inventoryKnown || !registrationRemoved) {
    diagnostics.push('branch rollback skipped because worktree registration cleanup was not proven');
  } else try {
    const deleted = await runner({
      command: 'git',
      args: ['update-ref', '-d', ownership.branchRef, ownership.branchOid],
      cwd: request.projectDir,
    });
    diagnostics.push(deleted.exitCode === 0 && !deleted.error
      ? 'removed the exact invocation-created branch ref'
      : `branch changed or could not be compare-deleted; left in place: ${gitOperationFailure('Git branch rollback', deleted)}`);
  } catch (error) {
    diagnostics.push(`could not compare-delete invocation-created branch: ${errorMessage(error)}`);
  }
  return diagnostics;
}

async function verifyReusableWorktree(
  request: GitWorktreeRequest,
  runner: GitCommandRunner,
  fs: ShipSetupFileSystem,
): Promise<{ reusable: true } | { reusable: false; reason: string }> {
  let inventory: GitWorktreeResponse;
  try {
    inventory = await runner({
      command: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: request.projectDir,
    });
  } catch (error) {
    return { reusable: false, reason: `cannot inspect Git worktree inventory: ${errorMessage(error)}` };
  }
  if (inventory.exitCode !== 0 || inventory.error) {
    return { reusable: false, reason: worktreeFailureReason(inventory) };
  }
  let targetCanonical: string;
  try {
    targetCanonical = fs.realpath(request.targetDir);
  } catch (error) {
    return { reusable: false, reason: `cannot canonicalize the existing target: ${errorMessage(error)}` };
  }
  const selected = parseWorktreeIdentities(inventory.stdout ?? '').find((record) => {
    try {
      return fs.realpath(record.path) === targetCanonical;
    } catch {
      return false;
    }
  });
  if (!selected) return { reusable: false, reason: 'the target is not registered in `git worktree list`' };
  const expectedBranch = request.branch.replace(/^refs\/heads\//, '');
  if (selected.branch !== expectedBranch) {
    return {
      reusable: false,
      reason: `registered branch ${selected.branch ?? '(detached)'} does not match requested branch ${expectedBranch}`,
    };
  }

  let base: GitWorktreeResponse;
  try {
    base = await runner({
      command: 'git',
      args: ['rev-parse', '--verify', '--end-of-options', `${request.base}^{commit}`],
      cwd: request.projectDir,
    });
  } catch (error) {
    return { reusable: false, reason: `cannot resolve the requested base: ${errorMessage(error)}` };
  }
  if (base.exitCode !== 0 || base.error) {
    return { reusable: false, reason: `cannot resolve requested base ${request.base}: ${worktreeFailureReason(base)}` };
  }
  const baseCommit = (base.stdout ?? '').trim().split(/\r?\n/, 1)[0];
  if (!baseCommit || selected.head !== baseCommit) {
    return {
      reusable: false,
      reason: `registered HEAD ${selected.head ?? '(unknown)'} does not match requested base ${request.base} (${baseCommit || 'unknown'})`,
    };
  }
  return { reusable: true };
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
  const createTargetDirectory = (directory: string): void => {
    let ancestor = directory;
    while (!fs.entryExists(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    if (!within(targetCanonical, fs.realpath(ancestor))) {
      throw new Error('Target parent resolves outside the worktree');
    }
    fs.createDirectory(directory);
    if (!within(targetCanonical, fs.realpath(directory))) {
      throw new Error('Materialized target directory resolves outside the worktree');
    }
  };
  const copyMissingFile = (source: string, target: string): void => {
    if (fs.entryExists(target)) {
      addBlocker(source, 'Target has an existing unreachable entry and will not be overwritten');
      return;
    }
    createTargetDirectory(dirname(target));
    const parentCanonical = fs.realpath(dirname(target));
    if (!within(targetCanonical, parentCanonical)) {
      addBlocker(source, 'Target parent resolves outside the worktree');
      return;
    }
    if (fs.stat(source).isFile?.() === false) {
      addBlocker(source, 'Declared source entry is not a regular file or directory');
      return;
    }
    fs.copyFile(source, target);
    if (!fs.filesEqual(source, target)) {
      addBlocker(source, 'Copied target descendant does not match the declared source bytes');
      return;
    }
    copies.push({ path: normalizedInputPath(source), source, target });
  };

  const reconcileExistingDirectory = (
    sourceDirectory: string,
    targetDirectory: string,
    sourceRootCanonical: string,
    targetRoot: string,
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
          // Preserve internal module/link topology in the target namespace.
          // Flattening .bin links changes where relative imports resolve.
          if (fs.lstat?.(source).isSymbolicLink?.()) {
            if (fs.entryExists(target)) {
              addBlocker(source, 'Target has an existing unreachable entry and will not be overwritten');
              continue;
            }
            createTargetDirectory(dirname(target));
            const mappedSource = resolve(targetRoot, relative(sourceRootCanonical, sourceCanonical));
            fs.createLink(relative(dirname(target), mappedSource) || '.', target, sourceDirectoryEntry ? 'dir' : 'file');
            links.push({ path: normalizedInputPath(source), source: mappedSource, target,
              type: sourceDirectoryEntry ? 'directory' : 'file' });
            continue;
          }

          if (!sourceDirectoryEntry) {
            copyMissingFile(source, target);
            continue;
          }
          if (fs.entryExists(target)) {
            addBlocker(source, 'Target has an existing unreachable entry and will not be overwritten');
            continue;
          }
          createTargetDirectory(target);
          const materializedCanonical = fs.realpath(target);
          if (!within(targetCanonical, materializedCanonical)) {
            addBlocker(source, 'Materialized target directory resolves outside the worktree');
            continue;
          }
          reconcileExistingDirectory(
            source,
            target,
            sourceRootCanonical,
            targetRoot,
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
            targetRoot,
            new Set([...ancestors, sourceCanonical]),
          );
          continue;
        }
        if (!fs.filesEqual(source, target)) {
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
    // Git materializes inputs that exist only on the selected base. There is no
    // source-checkout path to link, and target verification below remains the
    // authoritative readable/content check.
    if (input.sourceExists === false && input.baseRefExists === true) continue;
    const source = resolve(projectDir, input.path);
    const target = resolve(targetDir, input.path);
    if (!within(resolve(targetDir), target)) {
      blockers.push({ phase: 'target', input: input.path, reason: 'Declared target path escapes the worktree' });
      continue;
    }
    try {
      const sourceDirectory = fs.stat(source).isDirectory();
      if (!fs.exists(target)) {
        if (!sourceDirectory) {
          copyMissingFile(source, target);
        } else if (fs.entryExists(target)) {
          addBlocker(source, 'Target has an existing unreachable entry and will not be overwritten');
        } else {
          createTargetDirectory(target);
          if (!within(targetCanonical, fs.realpath(target))) {
            addBlocker(source, 'Materialized target directory resolves outside the worktree');
            continue;
          }
          const sourceCanonical = fs.realpath(source);
          reconcileExistingDirectory(source, target, sourceCanonical, target, new Set([sourceCanonical]));
        }
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
        blockers.push({ phase: 'target', input: input.path,
          reason: 'Existing declared target input resolves outside the worktree; recreate the target to materialize target-owned inputs' });
        continue;
      }
      if (sourceDirectory) {
        reconcileExistingDirectory(source, target, sourceCanonical, target, new Set([sourceCanonical]));
      } else {
        if (!fs.filesEqual(source, target)) {
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
  const sourceVerification = await verifyDeclaredInputsAgainstSourceAndBase(
    brief,
    projectDir,
    parsed.base as string,
    deps.fs,
    deps.runGitCommand,
  );
  const sourceOutputInventory = inspectBriefOutputs(brief, projectDir, deps.fs, { stateRoot: deps.globalDir(), launchProject: targetDir });
  let facts = setupFacts(
    projectDir,
    targetDir,
    briefPath,
    measuredBrief.digest,
    parsed,
    sourceVerification,
    sourceOutputInventory,
  );
  const refuse = (blockers: ShipSetupBlockerInput[]): ShipSetupRefusedReport => (
    persistRefused(facts, blockers, targetDir, deps)
  );
  const contractErrors = briefDeclarationFailures(brief);
  if (contractErrors.length) return refuse(contractErrors.map(finding => ({
    phase: finding.code === 'frontmatter_invalid' ? 'validation' : 'source', code: finding.code, reason: finding.message,
  })));
  if (declaredValidation.error) {
    return refuse([{ phase: 'validation', reason: declaredValidation.error }]);
  }
  const sourceBlockers = verificationBlockers('source', sourceVerification);
  if (sourceBlockers.length > 0) return refuse(sourceBlockers);
  if (sourceOutputInventory.blocking.length > 0) {
    return refuse(sourceOutputInventory.blocking.map((entry) => ({
      phase: 'source' as const,
      input: entry.path,
      reason: entry.reason ?? 'Declared output path is already occupied',
      repair: `Choose a fresh output path, or declare an explicit on_existing disposition when the existing ${entry.entryType} is intentionally consumed.`,
    })));
  }
  const worktreeRequest: GitWorktreeRequest = {
    projectDir,
    targetDir,
    base: parsed.base as string,
    branch: parsed.branch as string,
  };
  try {
    const bytes = await estimateInputCopyBytes(sourceVerification, projectDir, targetDir, deps);
    if (bytes > 0) requireDiskCapacity(bytes);
  } catch (error) {
    return refuse([{ phase: 'target', reason: errorMessage(error),
      repair: 'Resolve the disk admission or input estimate refusal, then rerun ship-setup. No worktree or input copy was started.' }]);
  }
  if (deps.fs.entryExists(targetDir)) {
    const existing = await verifyReusableWorktree(worktreeRequest, deps.runGitCommand, deps.fs);
    if (!existing.reusable) {
      return refuse([{
        phase: 'worktree',
        reason: `Target already exists but cannot be safely reused: ${targetDir}; ${existing.reason}`,
      }]);
    }
    facts = { ...facts, worktreeReused: true };
  } else {
    const configured = deps.managedWorktreeCreation ? loadEngineDefaults() : undefined;
    let ownership: ManagedWorktreeOwnership | undefined;
    let preparedRequest = worktreeRequest;
    if (deps.managedWorktreeCreation) {
      const prepared = await prepareManagedWorktree(worktreeRequest, deps.runGitCommand, deps.fs);
      if (!prepared.request || !prepared.ownership || prepared.failureReason) {
        return refuse([{
          phase: 'worktree',
          reason: `${prepared.failureReason ?? 'Git worktree preparation failed'}`
            + (prepared.cleanup.length ? `; cleanup: ${prepared.cleanup.join('; ')}` : ''),
        }]);
      }
      preparedRequest = prepared.request;
      ownership = prepared.ownership;
    }
    const creationRequest: GitWorktreeRequest = deps.managedWorktreeCreation
      ? {
          ...preparedRequest,
          timeoutMs: configured?.git_worktree_add_timeout_ms,
          onProgress: (progress) => {
            deps.stderr.write(`${progress.message} (${Math.floor(progress.elapsedMs / 1_000)}s elapsed)\n`);
          },
        }
      : preparedRequest;
    let git: GitWorktreeResponse;
    try {
      git = await deps.createWorktree(creationRequest);
    } catch (error) {
      git = { exitCode: null, error: errorMessage(error) };
    }
    if (git.exitCode !== 0 || git.error) {
      const cleanup = deps.managedWorktreeCreation
        ? await rollbackOwnedFailedWorktree(
            worktreeRequest,
            ownership as ManagedWorktreeOwnership,
            deps.runGitCommand,
            deps.fs,
          )
        : [];
      return refuse([{
        phase: 'worktree',
        reason: `${worktreeFailureReason(git)}${cleanup.length ? `; cleanup: ${cleanup.join('; ')}` : ''}`,
      }]);
    }
    facts = { ...facts, worktreeCreated: true };
  }
  const targetIsDirectory = (() => {
    try {
      return deps.fs.exists(targetDir) && deps.fs.stat(targetDir).isDirectory();
    } catch {
      return false;
    }
  })();
  if (!targetIsDirectory) {
    return refuse([{
      phase: 'worktree',
      reason: 'Git reported success but the target worktree directory is not reachable',
    }]);
  }
  let targetCanonicalDir: string;
  try {
    targetCanonicalDir = deps.fs.realpath(targetDir);
    facts = { ...facts, targetCanonicalDir };
  } catch (error) {
    return refuse([{
      phase: 'target',
      reason: `Cannot canonicalize target worktree: ${errorMessage(error)}`,
    }]);
  }

  // Input materialization owns target collisions and path confinement. A live
  // source may advance independently; setup cannot attribute that change to a
  // command, and does not promise an immutable experiment snapshot.
  let reconciled: { links: ShipSetupLink[]; copies: ShipSetupCopy[]; blockers: ShipSetupBlockerInput[] };
  try {
    reconciled = reconcileInputs(sourceVerification, projectDir, targetDir, deps.fs);
  } catch (error) {
    return refuse([{ phase: 'target', reason: `Cannot inspect target worktree: ${errorMessage(error)}` }]);
  }
  facts = { ...facts, links: reconciled.links, copies: reconciled.copies };
  if (reconciled.blockers.length > 0) return refuse(reconciled.blockers);

  const targetVerification = verifyDeclaredBriefInputs(brief, targetDir, deps.fs);
  const targetOutputInventory = inspectBriefOutputs(brief, targetDir, deps.fs, { stateRoot: deps.globalDir() });
  facts = { ...facts, targetVerification, targetOutputInventory };
  const targetBlockers = verificationBlockers('target', targetVerification);
  if (targetBlockers.length > 0) return refuse(targetBlockers);
  if (targetOutputInventory.blocking.length > 0) {
    return refuse(targetOutputInventory.blocking.map((entry) => ({
      phase: 'target' as const,
      input: entry.path,
      reason: entry.reason ?? 'Declared output path is already occupied in the target worktree',
      repair: `Choose a fresh output path, or declare an explicit on_existing disposition when the target ${entry.entryType} is intentionally updated.`,
    })));
  }

  const validationFs = { exists: deps.fs.exists, readText: deps.fs.readText };
  const discovery = reconcileProjectValidation(targetDir, declaredValidation.commands, validationFs);
  const { validationBaseline, baselineReuse } = await reuseShipSetupBaseline(
    projectDir, targetDir, parsed.base as string, discovery,
    targetVerification.inputs.map(input => input.path), deps.globalDir(),
    () => runProjectValidationBaseline(targetDir, {
      fs: validationFs,
      ...(deps.runValidationCommand ? { runCommand: deps.runValidationCommand } : {}),
      declaredCommands: declaredValidation.commands,
    }),
  );
  facts = { ...facts, validationBaseline, baselineReuse };

  const validationBlockers: ShipSetupBlockerInput[] = validationBaseline.discovery.state === 'unknown'
      && declaredValidation.commands.length > 0
    ? [{
        phase: 'validation',
        reason: `Validation baseline is unknown: ${validationBaseline.discovery.reason ?? 'no build, test, or lint command could be inferred'}`,
      }]
    : [];
  // Inferred unmeasurable commands record an environment gap; explicit declarations must be measurable.
  validationBlockers.push(...validationBaseline.results.flatMap((result): ShipSetupBlockerInput[] => {
    const command = validationBaseline.discovery.commands
      .find(candidate => candidate.role === result.role && candidate.display === result.display);
    if (!unmeasured(result) || command?.provenance?.source !== 'brief') return [];
    return [{
      phase: 'validation',
      reason: `Cannot measure ${result.role} baseline${result.display ? ` (${result.display})` : ''} declared at ${command.provenance.evidencePath}: ${result.reason ?? 'command ended without an exit code'}`,
    }];
  }));
  if (validationBlockers.length > 0) return refuse(validationBlockers);
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
    return refuse([{
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
  }
  for (const input of verification.unresolvedInputs) {
    writer.write(`  UNRESOLVED DECLARED ${JSON.stringify(input.value)} at line ${input.line}: ${input.reason}\n`);
  }
}

function renderOutputInventory(label: string, inventory: BriefOutputInventory, writer: Writer): void {
  writer.write(`${label} outputs: ${inventory.entries.length} checked; ${inventory.blocking.length} blocking\n`);
  for (const entry of inventory.entries) {
    writer.write(`  ${entry.blocking ? 'BLOCKED' : entry.exists ? 'EXISTS-ALLOWED' : 'ABSENT'} ${entry.path} (${entry.entryType}, on_existing=${entry.disposition})${entry.size === undefined ? '' : ` size=${entry.size}`}${entry.reason ? ` — ${entry.reason}` : ''}\n`);
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
  if (report.state === 'ready') {
    writer.write(`Validation baseline: ${report.validationBaseline.discovery.state.toUpperCase()}\n`);
    for (const result of report.validationBaseline.results) {
      writer.write(`  ${result.role}: ${unmeasured(result) ? 'ENVIRONMENT GAP' : result.state.toUpperCase()}${result.exitCode === undefined ? '' : ` exit=${result.exitCode}`}\n`);
    }
    for (const criterion of report.validationBaseline.gateCriteria) {
      writer.write(`  gate ${criterion.role}: ${criterion.rule} — ${criterion.description}\n`);
    }
    writer.write(`Ready record: ${report.readyRecordPath}\n`);
    return;
  }
  for (const blocker of report.blockers) {
    const subject = blocker.input ? ` ${blocker.input}` : '';
    writer.write(`  REFUSED [${blocker.phase}]${subject}: ${blocker.reason}\n`);
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
    if (!(error instanceof CliUsageError)) deps.stderr.write(`${shipSetupUsage()}\n`);
    return 1;
  }
}

export async function cmdShipSetup(args: string[]): Promise<number> {
  return cmdShipSetupWithDeps(args, {});
}
