import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  canonicalCampaignStorageKey,
  readCampaignEntries,
  type CampaignHistoryEntry,
} from './campaigns.js';
import {
  computeBuildFingerprint,
  findUnixSocketOwnerPid,
  readDaemonIdentity,
} from './daemon-identity.js';
import {
  defaultSocketPath,
  sendRpc,
  type DaemonStatusRpcResponse,
  type RpcResponse,
} from './orchestrator-rpc.js';
import {
  runProjectValidationBaseline,
  type ProjectValidationBaseline,
  type ValidationCommandRunner,
} from './project-validation.js';
import {
  verifyBriefInputs,
  type BriefInputAssertionResult,
  type ShipInputStat,
  type UnresolvedBriefInputDeclaration,
  type VerifiedBriefInput,
} from './ship-inputs.js';
import {
  resolveRunStatus,
  RUN_STATUS,
  runsRoot,
  type RunStatus,
  type StoreState,
} from './store.js';

export { extractBriefInputPaths } from './ship-inputs.js';

type Writer = { write(chunk: string): unknown };

interface FileStat extends ShipInputStat {
  mtimeMs: number;
}

export interface DaemonLoadedBuildProbe {
  state: 'fresh' | 'stale' | 'unavailable' | 'unverified';
  loadedBuild?: string;
  diskBuild?: string;
  reason?: string;
}

export interface ShipPreflightDependencies {
  projectDir?: string;
  packageRoot?: string;
  stdout?: Writer;
  stderr?: Writer;
  runsRoot?: () => string;
  readDirectory?: (path: string) => string[];
  readText?: (path: string) => string;
  readBytes?: (path: string) => Uint8Array;
  stat?: (path: string) => FileStat;
  exists?: (path: string) => boolean;
  readable?: (path: string) => boolean;
  realpath?: (path: string) => string;
  readGitCommonDir?: (projectDir: string) => string;
  readCampaignEntries?: (projectDir: string, campaignId: string) => CampaignHistoryEntry[];
  probeDaemon?: (distDir: string) => Promise<DaemonLoadedBuildProbe>;
  runValidationCommand?: ValidationCommandRunner;
}

interface ResolvedDependencies {
  projectDir: string;
  packageRoot: string;
  stdout: Writer;
  stderr: Writer;
  runsRoot: () => string;
  readDirectory: (path: string) => string[];
  readText: (path: string) => string;
  readBytes: (path: string) => Uint8Array;
  stat: (path: string) => FileStat;
  exists: (path: string) => boolean;
  readable: (path: string) => boolean;
  realpath: (path: string) => string;
  readGitCommonDir: (projectDir: string) => string;
  readCampaignEntries: (projectDir: string, campaignId: string) => CampaignHistoryEntry[];
  probeDaemon: (distDir: string) => Promise<DaemonLoadedBuildProbe>;
  runValidationCommand?: ValidationCommandRunner;
}

export interface PreviousRunEvidence {
  source: 'terminal_artifact' | 'failure_reason';
  path?: string;
  text: string;
}

export interface PreviousRunReport {
  state: 'found' | 'none';
  id?: string;
  status?: string;
  statusReason?: string;
  runDir?: string;
  evidence?: PreviousRunEvidence;
  realityGate?: {
    source: 'artifact' | 'run_json';
    path?: string;
    evidence: unknown;
  };
  scan: {
    entries: number;
    readable: number;
    unreadable: number;
    missingState: number;
    invalidState: number;
    canonicalFallbacks: number;
  };
}

export interface CampaignHygieneReport {
  state: 'resolved' | 'unknown';
  name?: string;
  storageKey?: string;
  source?: 'explicit' | 'defaults' | 'repository';
  reason?: string;
  totalEntries?: number;
  totalEnded?: number;
  recentEnded?: number;
  recentAdverse?: number;
  suggestContextSkip?: boolean;
}

export interface SourceDistFreshnessReport {
  state: 'current' | 'stale' | 'unknown';
  sourceFiles: number;
  pairedOutputs: number;
  stalePaths: string[];
  reason?: string;
}

export type BriefInputReport = VerifiedBriefInput;

export interface ShipPreflightReport {
  version: 1;
  project: {
    requestedPath: string;
    canonicalPath: string;
    usedCanonicalFallback: boolean;
  };
  previousRun: PreviousRunReport;
  campaign: CampaignHygieneReport;
  daemonFreshness: {
    daemonToDist: DaemonLoadedBuildProbe;
    sourceToDist: SourceDistFreshnessReport;
    caveat: string;
  };
  briefInputs: {
    state: 'checked' | 'not_requested';
    briefPath?: string;
    inputs: BriefInputReport[];
    unresolvedInputs: UnresolvedBriefInputDeclaration[];
    unboundAssertions: BriefInputAssertionResult[];
  };
  validationBaseline: ProjectValidationBaseline;
}

interface ParsedArgs {
  json: boolean;
  help: boolean;
  project?: string;
  campaign?: string;
  brief?: string;
}

type PriorRunEvidenceAction = 'clean' | 'inspect';

/** Whether ship preflight must surface prior-run failure evidence. */
const PRIOR_RUN_EVIDENCE_ACTIONS = {
  [RUN_STATUS.PENDING]: 'inspect',
  [RUN_STATUS.RUNNING]: 'inspect',
  [RUN_STATUS.PARKED]: 'inspect',
  [RUN_STATUS.COMPLETE]: 'clean',
  [RUN_STATUS.FAILED]: 'inspect',
  [RUN_STATUS.AWAITING_APPROVAL]: 'inspect',
  [RUN_STATUS.SHIPPED]: 'clean',
  [RUN_STATUS.CEILING_HIT]: 'inspect',
  [RUN_STATUS.ESCALATED]: 'inspect',
  [RUN_STATUS.REALITY_GATE_FAILED]: 'inspect',
  [RUN_STATUS.PHASE_COMPLETE]: 'inspect',
  [RUN_STATUS.STOPPED]: 'inspect',
  [RUN_STATUS.INCOMPLETE]: 'inspect',
} as const satisfies Record<RunStatus, PriorRunEvidenceAction>;

const CAMPAIGN_HYGIENE_ADVERSE = {
  [RUN_STATUS.PENDING]: false,
  [RUN_STATUS.RUNNING]: false,
  [RUN_STATUS.PARKED]: false,
  [RUN_STATUS.COMPLETE]: false,
  [RUN_STATUS.FAILED]: true,
  [RUN_STATUS.AWAITING_APPROVAL]: false,
  [RUN_STATUS.SHIPPED]: false,
  [RUN_STATUS.CEILING_HIT]: true,
  [RUN_STATUS.ESCALATED]: true,
  [RUN_STATUS.REALITY_GATE_FAILED]: true,
  [RUN_STATUS.PHASE_COMPLETE]: false,
  [RUN_STATUS.STOPPED]: true,
  [RUN_STATUS.INCOMPLETE]: true,
} as const satisfies Record<RunStatus, boolean>;
const DAEMON_CAVEAT = 'Daemon freshness compares the running daemon with dist, not src with dist. A dist build that is behind src can still report FRESH; inspect sourceToDist too.';

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveDependencies(overrides: ShipPreflightDependencies): ResolvedDependencies {
  return {
    projectDir: overrides.projectDir ?? process.cwd(),
    packageRoot: overrides.packageRoot ?? resolve(import.meta.dirname ?? '.', '..'),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    runsRoot: overrides.runsRoot ?? runsRoot,
    readDirectory: overrides.readDirectory ?? ((path) => readdirSync(path)),
    readText: overrides.readText ?? ((path) => readFileSync(path, 'utf-8')),
    readBytes: overrides.readBytes ?? ((path) => readFileSync(path)),
    stat: overrides.stat ?? ((path) => statSync(path) as Stats),
    exists: overrides.exists ?? existsSync,
    readable: overrides.readable ?? ((path) => {
      try {
        accessSync(path, constants.R_OK);
        return true;
      } catch {
        return false;
      }
    }),
    realpath: overrides.realpath ?? ((path) => realpathSync.native(path)),
    readGitCommonDir: overrides.readGitCommonDir ?? ((projectDir) => execFileSync(
      'git',
      ['rev-parse', '--git-common-dir'],
      { cwd: projectDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
    )),
    readCampaignEntries: overrides.readCampaignEntries ?? readCampaignEntries,
    probeDaemon: overrides.probeDaemon ?? probeRunningDaemon,
    runValidationCommand: overrides.runValidationCommand,
  };
}

function optionValue(args: string[], index: number, name: string): { value: string; consumed: number } {
  const arg = args[index];
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) {
    const value = arg.slice(prefix.length);
    if (!value) throw new Error(`${name} requires a value`);
    return { value, consumed: 1 };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return { value, consumed: 2 };
}

function parseArgs(args: string[]): ParsedArgs {
  const input = args[0] === 'ship-preflight' ? args.slice(1) : [...args];
  const parsed: ParsedArgs = { json: false, help: false };
  for (let index = 0; index < input.length;) {
    const arg = input[index];
    if (arg === '--json') {
      parsed.json = true;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      index += 1;
      continue;
    }
    if (arg === '--project' || arg.startsWith('--project=')) {
      const found = optionValue(input, index, '--project');
      parsed.project = found.value;
      index += found.consumed;
      continue;
    }
    if (arg === '--campaign' || arg.startsWith('--campaign=')) {
      const found = optionValue(input, index, '--campaign');
      parsed.campaign = found.value;
      index += found.consumed;
      continue;
    }
    if (arg === '--brief' || arg.startsWith('--brief=')) {
      const found = optionValue(input, index, '--brief');
      parsed.brief = found.value;
      index += found.consumed;
      continue;
    }
    throw new Error(`Unknown ship-preflight option: ${arg}`);
  }
  return parsed;
}

function canonicalize(path: string, deps: ResolvedDependencies): { path: string; fallback: boolean } {
  const absolute = resolve(path);
  try {
    return { path: deps.realpath(absolute), fallback: false };
  } catch {
    return { path: absolute, fallback: true };
  }
}

function validateProject(path: string, deps: ResolvedDependencies): void {
  let stat: FileStat;
  try {
    stat = deps.stat(path);
  } catch (error) {
    throw new Error(`Cannot inspect project directory ${path}: ${errorMessage(error)}`, { cause: error });
  }
  if (!stat.isDirectory()) throw new Error(`Project path is not a directory: ${path}`);
  if (!deps.readable(path)) throw new Error(`Project directory is not readable: ${path}`);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function priorRunEvidence(
  runPath: string,
  state: Partial<StoreState>,
  deps: ResolvedDependencies,
): PreviousRunEvidence | undefined {
  const artifact = typeof state.terminalArtifact === 'string'
    ? basename(state.terminalArtifact)
    : '';
  for (const name of artifact ? [`terminal_${artifact}`, artifact] : []) {
    try {
      const text = deps.readText(join(runPath, name));
      if (!text) continue;
      return {
        source: 'terminal_artifact',
        path: join(runPath, name),
        text,
      };
    } catch {
      // The failure reason below is the durable fallback when no snapshot exists.
    }
  }
  return typeof state.failureReason === 'string' && state.failureReason.length > 0
    ? { source: 'failure_reason', text: state.failureReason }
    : undefined;
}

function priorRealityGate(
  runPath: string,
  state: Partial<StoreState>,
  deps: ResolvedDependencies,
): PreviousRunReport['realityGate'] {
  const artifactPath = join(runPath, '.reality-gate.json');
  try {
    return {
      source: 'artifact',
      path: artifactPath,
      evidence: safeJson(deps.readText(artifactPath)),
    };
  } catch {
    return state.realityGate
      ? { source: 'run_json', evidence: state.realityGate }
      : undefined;
  }
}

function scanPreviousRun(project: string, deps: ResolvedDependencies): PreviousRunReport {
  const root = deps.runsRoot();
  let ids: string[];
  try {
    // This is deliberately the only directory enumeration of the runs root.
    ids = deps.readDirectory(root);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return {
        state: 'none',
        scan: {
          entries: 0,
          readable: 0,
          unreadable: 0,
          missingState: 0,
          invalidState: 0,
          canonicalFallbacks: 0,
        },
      };
    }
    throw new Error(`Cannot enumerate FlowCrew runs at ${root}: ${errorMessage(error)}`, { cause: error });
  }

  const scan = {
    entries: ids.length,
    readable: 0,
    unreadable: 0,
    missingState: 0,
    invalidState: 0,
    canonicalFallbacks: 0,
  };
  let latest: { id: string; path: string; state: Partial<StoreState>; mtimeMs: number } | undefined;

  for (const id of ids) {
    const runPath = join(root, id);
    const statePath = join(runPath, 'run.json');
    try {
      const state = JSON.parse(deps.readText(statePath)) as Partial<StoreState>;
      if (typeof state.projectDir !== 'string' || typeof state.status !== 'string') {
        throw new Error('run.json lacks string projectDir/status');
      }
      const runProject = canonicalize(state.projectDir, deps);
      if (runProject.fallback) scan.canonicalFallbacks += 1;
      const mtimeMs = deps.stat(statePath).mtimeMs;
      scan.readable += 1;
      if (runProject.path !== project) continue;
      if (!latest || mtimeMs > latest.mtimeMs || (mtimeMs === latest.mtimeMs && id > latest.id)) {
        latest = { id, path: runPath, state, mtimeMs };
      }
    } catch (error) {
      scan.unreadable += 1;
      if (isNodeError(error, 'ENOENT')) scan.missingState += 1;
      else scan.invalidState += 1;
    }
  }

  if (!latest) return { state: 'none', scan };
  const status = latest.state.status as string;
  const statusResolution = resolveRunStatus(status);
  const evidenceAction = statusResolution.kind === 'known'
    ? PRIOR_RUN_EVIDENCE_ACTIONS[statusResolution.status]
    : 'inspect';
  return {
    state: 'found',
    id: latest.id,
    status,
    ...(statusResolution.kind === 'unknown' ? { statusReason: statusResolution.reason } : {}),
    runDir: latest.path,
    ...(evidenceAction === 'inspect'
      ? {
          evidence: priorRunEvidence(latest.path, latest.state, deps),
          realityGate: priorRealityGate(latest.path, latest.state, deps),
        }
      : {}),
    scan,
  };
}

function parsedYamlObject(text: string, label: string): Record<string, unknown> {
  const parsed = parseYaml(text) as unknown;
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a YAML mapping`);
  }
  return parsed as Record<string, unknown>;
}

function repositoryCampaign(
  project: string,
  deps: ResolvedDependencies,
): { name: string; source: 'repository' } | { reason: string } {
  try {
    const commonDir = deps.readGitCommonDir(project).trim();
    if (!commonDir) return { reason: 'Git returned an empty common directory' };
    const repository = dirname(resolve(project, commonDir));
    const name = basename(repository);
    if (!name) return { reason: `Git common directory did not identify a repository name: ${commonDir}` };
    return { name, source: 'repository' };
  } catch (error) {
    return { reason: `Cannot resolve a repository campaign: ${errorMessage(error)}` };
  }
}

function resolveCampaign(
  project: string,
  explicit: string | undefined,
  deps: ResolvedDependencies,
): Omit<CampaignHygieneReport, 'totalEntries' | 'totalEnded' | 'recentEnded' | 'recentAdverse' | 'suggestContextSkip'> {
  let name: string;
  let source: 'explicit' | 'defaults' | 'repository';

  if (explicit !== undefined) {
    name = explicit.trim();
    source = 'explicit';
  } else {
    const defaultsPath = join(project, 'config', 'defaults.yaml');
    if (deps.exists(defaultsPath)) {
      try {
        const defaults = parsedYamlObject(deps.readText(defaultsPath), defaultsPath);
        if (defaults.campaign === null || defaults.campaign === undefined) {
          const repository = repositoryCampaign(project, deps);
          if ('reason' in repository) return { state: 'unknown', reason: repository.reason };
          ({ name, source } = repository);
        } else if (typeof defaults.campaign === 'string' && defaults.campaign.trim()) {
          name = defaults.campaign.trim();
          source = 'defaults';
        } else {
          return {
            state: 'unknown',
            reason: `Cannot resolve campaign from ${defaultsPath}: campaign must be a non-empty string or null`,
          };
        }
      } catch (error) {
        return { state: 'unknown', reason: `Cannot resolve campaign from ${defaultsPath}: ${errorMessage(error)}` };
      }
    } else {
      const repository = repositoryCampaign(project, deps);
      if ('reason' in repository) return { state: 'unknown', reason: repository.reason };
      ({ name, source } = repository);
    }
  }

  const storageKey = canonicalCampaignStorageKey(name);
  if (!storageKey) return { state: 'unknown', reason: `Campaign name could not be canonicalized: ${JSON.stringify(name)}` };
  return { state: 'resolved', name, storageKey, source };
}

function campaignHygiene(
  project: string,
  explicit: string | undefined,
  deps: ResolvedDependencies,
): CampaignHygieneReport {
  const resolution = resolveCampaign(project, explicit, deps);
  if (resolution.state === 'unknown' || !resolution.storageKey) return resolution;
  try {
    const entries = deps.readCampaignEntries(project, resolution.storageKey);
    const ended = entries.filter((entry) => entry.kind === 'task_ended' && typeof entry.status === 'string');
    const recent = ended.slice(-10);
    const recentAdverse = recent.filter((entry) => {
      const status = resolveRunStatus(entry.status);
      return status.kind === 'unknown' || CAMPAIGN_HYGIENE_ADVERSE[status.status];
    }).length;
    return {
      ...resolution,
      totalEntries: entries.length,
      totalEnded: ended.length,
      recentEnded: recent.length,
      recentAdverse,
      suggestContextSkip: recentAdverse >= 3,
    };
  } catch (error) {
    return {
      ...resolution,
      state: 'unknown',
      reason: `Campaign ${resolution.storageKey} resolved, but its hygiene could not be read: ${errorMessage(error)}`,
    };
  }
}

function daemonStatus(response: RpcResponse): DaemonStatusRpcResponse | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const candidate = response as Partial<DaemonStatusRpcResponse>;
  return Number.isInteger(candidate.pid) && (candidate.pid ?? 0) > 0
    && typeof candidate.startedAt === 'string'
    && typeof candidate.socketPath === 'string'
    && typeof candidate.build === 'string' && /^[a-f0-9]{64}$/.test(candidate.build)
    && Number.isInteger(candidate.buildFiles) && (candidate.buildFiles ?? -1) >= 0
    && typeof candidate.buildNewestMtimeMs === 'number'
    && typeof candidate.uptime === 'number'
    && typeof candidate.watched_tasks === 'number'
    && typeof candidate.registry_unreadable_records === 'number'
    ? candidate as DaemonStatusRpcResponse
    : undefined;
}

async function probeRunningDaemon(distDir: string): Promise<DaemonLoadedBuildProbe> {
  const socketPath = defaultSocketPath();
  let diskBuild: string | undefined;
  try {
    diskBuild = computeBuildFingerprint(distDir).hash;
  } catch (error) {
    return { state: 'unverified', reason: `Cannot fingerprint dist: ${errorMessage(error)}` };
  }
  let response: RpcResponse;
  try {
    response = await sendRpc(socketPath, { cmd: 'status' });
  } catch (error) {
    return { state: 'unavailable', diskBuild, reason: errorMessage(error) };
  }
  const status = daemonStatus(response);
  if (!status) return { state: 'unverified', diskBuild, reason: 'Daemon returned an incomplete status identity' };
  let ownerPid: number | undefined;
  try {
    ownerPid = findUnixSocketOwnerPid(socketPath);
  } catch (error) {
    return { state: 'unverified', loadedBuild: status.build, diskBuild, reason: `Cannot prove daemon socket ownership: ${errorMessage(error)}` };
  }
  if (ownerPid !== status.pid) {
    return {
      state: 'unverified',
      loadedBuild: status.build,
      diskBuild,
      reason: `Socket owner pid=${ownerPid ?? 'none'} does not match daemon pid=${status.pid}`,
    };
  }
  try {
    const identity = readDaemonIdentity(socketPath);
    const resolvedSocket = resolve(socketPath);
    if (!identity
      || identity.pid !== status.pid
      || identity.startedAt !== status.startedAt
      || identity.socketPath !== resolvedSocket
      || resolve(status.socketPath) !== resolvedSocket
      || identity.build.hash !== status.build
      || identity.build.files !== status.buildFiles
      || identity.build.newestMtimeMs !== status.buildNewestMtimeMs) {
      return { state: 'unverified', loadedBuild: status.build, diskBuild, reason: 'Persisted daemon identity does not match the socket responder' };
    }
  } catch (error) {
    return { state: 'unverified', loadedBuild: status.build, diskBuild, reason: `Cannot verify persisted daemon identity: ${errorMessage(error)}` };
  }
  return {
    state: status.build === diskBuild ? 'fresh' : 'stale',
    loadedBuild: status.build,
    diskBuild,
  };
}

function collectSourceFiles(root: string, deps: ResolvedDependencies): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of deps.readDirectory(directory)) {
      const path = join(directory, name);
      const stat = deps.stat(path);
      if (stat.isDirectory()) visit(path);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) files.push(path);
    }
  };
  visit(root);
  return files;
}

function sourceDistFreshness(packageRoot: string, deps: ResolvedDependencies): SourceDistFreshnessReport {
  const sourceRoot = join(packageRoot, 'src');
  const distRoot = join(packageRoot, 'dist');
  if (!deps.exists(sourceRoot)) {
    return { state: 'unknown', sourceFiles: 0, pairedOutputs: 0, stalePaths: [], reason: 'Source tree is not present in this installation' };
  }
  let sources: string[];
  try {
    sources = collectSourceFiles(sourceRoot, deps);
  } catch (error) {
    return { state: 'unknown', sourceFiles: 0, pairedOutputs: 0, stalePaths: [], reason: `Cannot inspect source tree: ${errorMessage(error)}` };
  }
  if (sources.length === 0) {
    return { state: 'unknown', sourceFiles: 0, pairedOutputs: 0, stalePaths: [], reason: 'No TypeScript source files were found' };
  }

  const stalePaths: string[] = [];
  let pairedOutputs = 0;
  for (const source of sources) {
    const sourceRelative = relative(sourceRoot, source);
    const outputRelative = sourceRelative.replace(/\.ts$/, '.js');
    const output = join(distRoot, outputRelative);
    if (!deps.exists(output)) {
      stalePaths.push(outputRelative.split(sep).join('/'));
      continue;
    }
    try {
      pairedOutputs += 1;
      if (deps.stat(source).mtimeMs > deps.stat(output).mtimeMs) {
        stalePaths.push(outputRelative.split(sep).join('/'));
      }
    } catch (error) {
      stalePaths.push(`${outputRelative.split(sep).join('/')} (${errorMessage(error)})`);
    }
  }
  return {
    state: stalePaths.length > 0 ? 'stale' : 'current',
    sourceFiles: sources.length,
    pairedOutputs,
    stalePaths,
  };
}

function inspectBriefInputs(
  project: string,
  briefArgument: string | undefined,
  deps: ResolvedDependencies,
): ShipPreflightReport['briefInputs'] {
  if (!briefArgument) return {
    state: 'not_requested', inputs: [], unresolvedInputs: [], unboundAssertions: [],
  };
  const requested = isAbsolute(briefArgument) ? briefArgument : join(project, briefArgument);
  const briefPath = resolve(requested);
  let brief: string;
  try {
    brief = deps.readText(briefPath);
  } catch (error) {
    throw new Error(`Cannot read requested brief ${briefPath}: ${errorMessage(error)}`, { cause: error });
  }
  const verification = verifyBriefInputs(brief, project, {
    exists: deps.exists,
    readable: deps.readable,
    readText: deps.readText,
    readBytes: deps.readBytes,
    readDirectory: deps.readDirectory,
    stat: deps.stat,
    realpath: deps.realpath,
  });
  return { state: 'checked', briefPath, ...verification };
}
export async function collectShipPreflight(
  args: string[],
  overrides: ShipPreflightDependencies = {},
): Promise<{ report: ShipPreflightReport; json: boolean; help: boolean }> {
  const parsed = parseArgs(args);
  const deps = resolveDependencies(overrides);
  const requestedProject = resolve(parsed.project ?? deps.projectDir);
  validateProject(requestedProject, deps);
  const canonicalProject = canonicalize(requestedProject, deps);
  const previousRun = scanPreviousRun(canonicalProject.path, deps);
  const campaign = campaignHygiene(canonicalProject.path, parsed.campaign, deps);
  const distDir = join(deps.packageRoot, 'dist');
  const [daemonToDist] = await Promise.all([deps.probeDaemon(distDir)]);
  const sourceToDist = sourceDistFreshness(deps.packageRoot, deps);
  const briefInputs = inspectBriefInputs(canonicalProject.path, parsed.brief, deps);
  const validationBaseline = await runProjectValidationBaseline(canonicalProject.path, {
    fs: { exists: deps.exists, readText: deps.readText },
    ...(deps.runValidationCommand ? { runCommand: deps.runValidationCommand } : {}),
  });

  return {
    json: parsed.json,
    help: parsed.help,
    report: {
      version: 1,
      project: {
        requestedPath: requestedProject,
        canonicalPath: canonicalProject.path,
        usedCanonicalFallback: canonicalProject.fallback,
      },
      previousRun,
      campaign,
      daemonFreshness: { daemonToDist, sourceToDist, caveat: DAEMON_CAVEAT },
      briefInputs,
      validationBaseline,
    },
  };
}

function renderEvidence(writer: Writer, label: string, evidence: unknown): void {
  const text = typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2);
  writer.write(`  ${label}:\n${text}${text.endsWith('\n') ? '' : '\n'}`);
}

function renderHuman(report: ShipPreflightReport, writer: Writer): void {
  writer.write(`Ship preflight: ${report.project.canonicalPath}\n`);
  if (report.project.usedCanonicalFallback) {
    writer.write(`  Path warning: realpath failed; comparison used resolved path ${report.project.requestedPath}\n`);
  }
  const prior = report.previousRun;
  if (prior.state === 'none') writer.write('Previous run: none found for this project\n');
  else {
    writer.write(`Previous run: ${prior.id} — ${prior.status}${prior.statusReason ? ` [UNRECOGNIZED: ${prior.statusReason}]` : ''}\n`);
    if (prior.evidence) renderEvidence(writer, prior.evidence.source === 'terminal_artifact' ? 'terminal evidence' : 'failure reason', prior.evidence.text);
    if (prior.realityGate) renderEvidence(writer, 'Reality-Gate evidence', prior.realityGate.evidence);
  }
  writer.write(
    `Run scan: ${prior.scan.readable}/${prior.scan.entries} readable, ${prior.scan.unreadable} unreadable `
    + `(missing run.json ${prior.scan.missingState}, invalid/unreadable state ${prior.scan.invalidState})\n`,
  );

  const campaign = report.campaign;
  if (campaign.state === 'unknown') writer.write(`Campaign hygiene: UNKNOWN — ${campaign.reason}\n`);
  else {
    writer.write(
      `Campaign: ${campaign.storageKey} (${campaign.source}) — ${campaign.totalEntries} entries, `
      + `${campaign.totalEnded} ended; recent adverse ${campaign.recentAdverse}/${campaign.recentEnded}; `
      + `context skip ${campaign.suggestContextSkip ? 'SUGGESTED' : 'not suggested'}\n`,
    );
  }

  const daemon = report.daemonFreshness.daemonToDist;
  const daemonBuilds = daemon.loadedBuild || daemon.diskBuild
    ? ` (loaded=${daemon.loadedBuild ?? 'unknown'}, disk=${daemon.diskBuild ?? 'unknown'})`
    : '';
  writer.write(`Daemon → dist: ${daemon.state.toUpperCase()}${daemonBuilds}${daemon.reason ? ` — ${daemon.reason}` : ''}\n`);
  const source = report.daemonFreshness.sourceToDist;
  writer.write(`Source → dist: ${source.state.toUpperCase()} — ${source.pairedOutputs}/${source.sourceFiles} paired outputs`);
  if (source.stalePaths.length) writer.write(`; stale/missing: ${source.stalePaths.join(', ')}`);
  if (source.reason) writer.write(` — ${source.reason}`);
  writer.write('\n');
  writer.write(`Freshness caveat: ${report.daemonFreshness.caveat}\n`);

  if (report.briefInputs.state === 'not_requested') {
    writer.write('Brief inputs: not checked (pass --brief <path>)\n');
  } else if (report.briefInputs.inputs.length === 0 && report.briefInputs.unresolvedInputs.length === 0) {
    writer.write('Brief inputs: no workspace-relative input references detected\n');
  } else {
    writer.write(`Brief inputs: ${report.briefInputs.inputs.length}\n`);
    for (const input of report.briefInputs.inputs) {
      const state = input.exists ? (input.readable ? 'READABLE' : 'UNREADABLE') : 'MISSING';
      writer.write(`  ${state} ${input.path} -> ${input.resolvedPath}\n`);
      for (const assertion of input.assertions) {
        const observed = assertion.observed === undefined ? '' : ` observed=${JSON.stringify(assertion.observed)}`;
        writer.write(`    ${assertion.state.toUpperCase()} ${assertion.kind} expected=${JSON.stringify(assertion.expected)}${observed} — ${assertion.reason}\n`);
      }
    }
  }
  for (const input of report.briefInputs.unresolvedInputs) {
    writer.write(`  UNRESOLVED DECLARED ${JSON.stringify(input.value)} at line ${input.line} — ${input.reason}\n`);
  }
  for (const assertion of report.briefInputs.unboundAssertions) {
    writer.write(`  NOT_CHECKABLE ${assertion.kind} at line ${assertion.line} — ${assertion.reason}\n`);
  }

  writer.write(`Validation baseline: ${report.validationBaseline.discovery.state.toUpperCase()}\n`);
  for (const result of report.validationBaseline.results) {
    const exit = result.exitCode === undefined ? '' : ` exit=${result.exitCode}`;
    writer.write(`  ${result.role}: ${result.state.toUpperCase()}${exit}${result.display ? ` — ${result.display}` : ''}${result.reason ? ` — ${result.reason}` : ''}\n`);
  }
  for (const criterion of report.validationBaseline.gateCriteria) {
    writer.write(`  gate ${criterion.role}: ${criterion.rule} — ${criterion.description}\n`);
  }
}

function usage(): string {
  return [
    'Usage: flowcrew ship-preflight [--json] [--project <path>] [--campaign <name>] [--brief <path>]',
    'Gathers prior-run evidence, campaign hygiene, freshness, declared inputs/assertions, and the untouched validation baseline.',
  ].join('\n');
}

export async function cmdShipPreflightWithDeps(
  args: string[],
  overrides: ShipPreflightDependencies,
): Promise<number> {
  const deps = resolveDependencies(overrides);
  try {
    const parsed = parseArgs(args);
    if (parsed.help) {
      deps.stdout.write(`${usage()}\n`);
      return 0;
    }
    const { report, json } = await collectShipPreflight(args, overrides);
    if (json) deps.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else renderHuman(report, deps.stdout);
    return 0;
  } catch (error) {
    deps.stderr.write(`ship-preflight: ${errorMessage(error)}\n`);
    return 1;
  }
}

export async function cmdShipPreflight(args: string[]): Promise<number> {
  return cmdShipPreflightWithDeps(args, {});
}
