#!/usr/bin/env node
import { CliUsageError, commandName, commandUsage, parseCommandArgs } from './cli-args.js';
import { EXIT_CODE } from './exit-code.js';
import type { RetiredStageUsage, RunStatus } from './store.js';
import type { AdapterName, AdapterResolution } from './adapters/availability.js';
import type { RegisterRpcResponse } from './orchestrator-rpc.js';
import type { TaskCreateInput } from './task-registry.js';
import type { BriefAdmissionRecord } from './brief-preflight.js';

function handleOutputError(error: NodeJS.ErrnoException): never {
  if (error.code === 'EPIPE') process.exit(EXIT_CODE.completed);
  throw error;
}

process.stdout.on('error', handleOutputError);
process.stderr.on('error', handleOutputError);
process.on('exit', () => {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.errored) handleOutputError(stream.errored);
  }
});

const bootstrapArgs = process.argv.slice(2);
const bootstrapName = commandName(bootstrapArgs);
const bootstrapHelp = !bootstrapArgs.length || bootstrapArgs.some(arg => arg === '--help' || arg === '-h')
  ? commandUsage(bootstrapName) || undefined
  : undefined;
// A status surface invokes this path repeatedly. Keep it ahead of the orchestration imports so
// rendering does not pay to initialize the scheduler, dashboard, YAML, and adapter modules.
if (bootstrapHelp !== undefined) {
  process.stdout.write(`${bootstrapHelp}\n`);
  process.exitCode = EXIT_CODE.completed;
} else if (bootstrapArgs[0] === 'fc_tasks') {
  try {
    const { cmdFcTasks } = await import('./cli-fc-tasks.js');
    process.exitCode = cmdFcTasks(bootstrapArgs);
  } catch (error) {
    process.stdout.write(`fc_tasks: degraded[internal_error] · command failed to load: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_CODE.failed;
  }
} else if (bootstrapArgs[0] === 'session-push') {
  const { cmdSessionPush } = await import('./cli-session-push.js');
  process.exitCode = await cmdSessionPush(bootstrapArgs.slice(1));
} else if (bootstrapArgs[0] === 'prune' || bootstrapArgs[0] === 'clean') {
  const { cmdPrune } = await import('./run-retention.js');
  process.exitCode = cmdPrune(bootstrapArgs);
} else if (bootstrapArgs[0] === 'plan-check') {
  const { cmdPlanCheck } = await import('./plan-interface.js');
  process.exitCode = await cmdPlanCheck(bootstrapArgs);
} else if (bootstrapArgs[0] === 'state') {
  const { cmdState } = await import('./run-state-access.js');
  process.exitCode = cmdState(bootstrapArgs);
} else {
const [
  fsModule,
  pathModule,
  childProcessModule,
  yamlModule,
  storeModule,
  configModule,
  campaignsModule,
  campaignHygieneModule,
  adapterLoaderModule,
  adapterAvailabilityModule,
  cliDoctorModule,
  terminalArtifactStatusModule,
  cliEventsModule,
  guidanceModule,
  commandInterruptModule,
  supervisionModule,
  runStateViewModule,
] = await Promise.all([
  import('./engine-fs.js'),
  import('node:path'),
  import('node:child_process'),
  import('yaml'),
  import('./store.js'),
  import('./config.js'),
  import('./campaigns.js'),
  import('./campaign-hygiene.js'),
  import('./adapters/loader.js'),
  import('./adapters/availability.js'),
  import('./cli-doctor.js'),
  import('./terminal-artifact-status.js'),
  import('./cli-events.js'),
  import('./guidance.js'),
  import('./command-interrupt.js'),
  import('./supervision.js'),
  import('./run-state-view.js'),
]);

const {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  lstatSync,
  statSync,
} = fsModule;
const { join, relative, resolve } = pathModule;
const { execFileSync, execSync } = childProcessModule;
const { parse: parseYaml, parseDocument } = yamlModule;
const { projectRunStageHistory } = runStateViewModule;
const {
  extractTaskTitle,
  isPausedRunStatus,
  isRunningRunStatus,
  isSuccessfulRunStatus,
  resolveRunStatus,
  readRunState,
  readArchivedRunState,
  readStageInput,
  RUN_STATUS,
  runsRoot,
  STAGE_STATUS,
} = storeModule;
const { campaignBaseDirectory, engineConfigDir, loadEngineDefaults } = configModule;
const { readCampaignEntries, resolveCampaignStorageKey } = campaignsModule;
const { assessCampaignHygiene } = campaignHygieneModule;
const { AVAILABLE_ADAPTER_NAMES, loadAdapterByName, normalizeAdapterName } = adapterLoaderModule;
const {
  ADAPTER_CLI,
  ADAPTER_INSTALL_HINT,
  findExecutableOnPath,
  installedAdapters,
  RECOMMENDED,
  resolveAdapterChoice,
} = adapterAvailabilityModule;
const { detectSupervisorBackend } = cliDoctorModule;
const { formatTerminalArtifactStatusMismatch, terminalArtifactStatusMismatch } = terminalArtifactStatusModule;
const {
  formatHumanDuration,
  formatOperationalReason,
  formatRunDriftProjection,
  readOperationalProjection,
} = cliEventsModule;
const { queueOperatorGuidance, RUN_WIDE_GUIDANCE_TARGET } = guidanceModule;
const { requestStageCommandInterrupt } = commandInterruptModule;
const { recordLaunchRefusal } = supervisionModule;

const args = bootstrapArgs;
const command = args[0];

interface CliRunStatusPresentation {
  listLabel: string;
  notificationTitle: string;
}

/** Every known lifecycle value has an explicit operator-facing CLI consequence. */
const CLI_RUN_STATUS_PRESENTATION = {
  [RUN_STATUS.PENDING]: { listLabel: '· pending ', notificationTitle: 'FlowCrew: Task Failed' },
  [RUN_STATUS.RUNNING]: { listLabel: '⟳ running ', notificationTitle: 'FlowCrew: Task Failed' },
  [RUN_STATUS.PARKED]: { listLabel: '· parked  ', notificationTitle: 'FlowCrew: Awaiting Your Approval' },
  [RUN_STATUS.COMPLETE]: { listLabel: '✓ complete', notificationTitle: 'FlowCrew: Task Complete' },
  [RUN_STATUS.FAILED]: { listLabel: '✗ failed  ', notificationTitle: 'FlowCrew: Task Failed' },
  [RUN_STATUS.SHIPPED]: { listLabel: '· shipped ', notificationTitle: 'FlowCrew: shipped' },
  [RUN_STATUS.CEILING_HIT]: { listLabel: '· ceiling_hit', notificationTitle: 'FlowCrew: ceiling_hit' },
  [RUN_STATUS.ESCALATED]: { listLabel: '· escalated', notificationTitle: 'FlowCrew: Task Failed' },
  [RUN_STATUS.REALITY_GATE_FAILED]: { listLabel: '· reality_gate_failed', notificationTitle: 'FlowCrew: Task Failed' },
  [RUN_STATUS.CANCELLED]: { listLabel: '· cancelled ', notificationTitle: 'FlowCrew: Task Failed' },
  [RUN_STATUS.INCOMPLETE]: { listLabel: '· incomplete', notificationTitle: 'FlowCrew: Task Failed' },
} as const satisfies Record<RunStatus, CliRunStatusPresentation>;

function decodeBriefAdmission(value: string): BriefAdmissionRecord {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as BriefAdmissionRecord;
  } catch {
    throw new Error('Invalid internal brief admission record');
  }
}

function detectProjectDir(): string {
  return process.env.PROJECT_DIR || process.cwd();
}

interface AdapterSetting {
  exists: boolean;
  value?: string;
  error?: string;
}

type RuntimeAdapterResolution = AdapterResolution | {
  ok: true;
  adapter: 'mock';
  reason: string;
};

function readAdapterSetting(): AdapterSetting {
  const path = join(engineConfigDir, 'defaults.yaml');
  if (!existsSync(path)) return { exists: false };
  try {
    const parsed = parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown> | null;
    const raw = parsed?.adapter;
    if (raw === undefined) return { exists: true };
    if (typeof raw !== 'string' || !raw.trim()) {
      return { exists: true, error: 'Engine config/defaults.yaml adapter must be a non-empty string' };
    }
    return { exists: true, value: raw.trim() };
  } catch (error) {
    return {
      exists: true,
      error: `Engine config/defaults.yaml YAML parsing failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function resolveRuntimeAdapter(
  opts: { explicit?: string; configured?: string },
  installed: readonly AdapterName[] = installedAdapters(),
): RuntimeAdapterResolution {
  const explicit = opts.explicit?.trim();
  const configured = opts.configured?.trim();
  const effective = explicit || configured;
  if (effective === 'mock') {
    return {
      ok: true,
      adapter: 'mock',
      reason: `Selected mock from the ${explicit ? 'explicit --adapter choice' : 'engine configuration'}; it is the deterministic in-process test adapter and needs no external CLI.`,
    };
  }
  return resolveAdapterChoice(opts, installed);
}

function writeAdapterSetting(adapter: AdapterName | 'auto'): string {
  const path = join(engineConfigDir, 'defaults.yaml');
  const document = parseDocument(readFileSync(path, 'utf-8'));
  if (document.errors.length > 0) {
    throw new Error(`Cannot update ${path}: ${document.errors[0].message}`);
  }
  document.set('adapter', adapter);
  writeFileSync(path, String(document), 'utf-8');
  return path;
}

async function registerBackgroundTask(task: TaskCreateInput): Promise<RegisterRpcResponse> {
  const { commandSocketPath, formatDaemonRegistration, sendRpc } = await import('./orchestrator-rpc.js');
  const socketPath = commandSocketPath();
  const response = await sendRpc<RegisterRpcResponse>(socketPath, { cmd: 'register', task, acknowledgement: 'persisted' });
  console.log(formatDaemonRegistration(response));
  return response;
}

async function registerLaunchLedger(id: number, task: string, digest: string, session?: string): Promise<void> {
  const entry = {
    id: `flowcrew-${id}`,
    subject: `FlowCrew task ${id}: ${extractTaskTitle(task) || 'Quick task'}`,
    description: `FlowCrew task ${id} is registered; wrap-up remains: read the result, verify it independently, archive unique output, and reclaim the worktree and branch.\nBrief digest: ${digest}`,
    activeForm: `Wrapping up FlowCrew task ${id}`,
    status: 'in_progress',
    blocks: [],
    blockedBy: [],
  };
  const createArgs = ['fc_tasks', 'create', '--flowcrew-task-id', String(id), '--entry', JSON.stringify(entry)];
  if (session === undefined) {
    console.log(`No session id is known; no ledger entry was created. Create it with: flowcrew ${createArgs.map(shellQuote).join(' ')} --session '<session-id>'`);
  } else {
    // Registration is durable. Ledger failures must never turn it into a failed launch.
    try {
      const { cmdFcTasks } = await import('./cli-fc-tasks.js');
      let diagnostic = '';
      const code = cmdFcTasks([...createArgs, '--session', session], {
        stderr: { write: (chunk) => { diagnostic += chunk; } },
      });
      if (code !== 0) throw new Error(diagnostic.trim());
    } catch (error) {
      console.warn(`Warning: task #${id} remains registered, but no ledger entry was created: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function cmdInit() {
  const projectDir = detectProjectDir();
  const skillsDir = join(projectDir, 'config', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  console.log(`✅ Project skills directory: ${skillsDir}`);

  // Create global ~/.fc/runs/ directory (all runs stored centrally)
  const globalFcDir = runsRoot(projectDir);
  mkdirSync(globalFcDir, { recursive: true });
  console.log(`✅ Global runs directory: ${globalFcDir}`);

  // `start` refuses without an adapter CLI, so pointing an agentless newcomer at it
  // would dead-end them one command later. Send them to what actually works instead:
  // doctor names what is missing, and rehearse runs for free with no CLI at all.
  console.log(installedAdapters().length > 0
    ? '\n🎉 FlowCrew initialized! Run `flowcrew start` or `flowcrew doctor` next.'
    : '\n🎉 FlowCrew initialized! No adapter CLI is installed yet, so a live run cannot start.'
      + '\n   Run `flowcrew doctor` to see what is missing, or `flowcrew rehearse <brief.md>` to try the engine for free.');
}

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

interface DoctorSkillLocation {
  label: 'project' | 'global';
  files: Record<'ship' | 'fc-status', string>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function repositoryCloneUrl(packageRoot: string): string {
  let repositoryUrl = 'git+https://github.com/cuibuaa/flow-crew.git';
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as {
      repository?: string | { url?: string };
    };
    const configured = typeof manifest.repository === 'string'
      ? manifest.repository
      : manifest.repository?.url;
    if (configured?.trim()) repositoryUrl = configured.trim();
  } catch { /* retain the canonical repository URL */ }
  return repositoryUrl.replace(/^git\+/, '');
}

function skillSourceRepairCommand(
  packageRoot: string,
  installer: string,
  adapter: AdapterName,
  scope: DoctorSkillLocation['label'],
  missingSources: string[],
): string {
  if (existsSync(join(packageRoot, '.git'))) {
    const restorePaths = missingSources
      .map((path) => shellQuote(relative(packageRoot, path)))
      .join(' ');
    return `git -C ${shellQuote(packageRoot)} restore --source=HEAD -- ${restorePaths} && bash ${shellQuote(installer)} --${adapter} --${scope}`;
  }
  const cloneUrl = repositoryCloneUrl(packageRoot);
  return `FLOWCREW_SKILL_REPAIR_DIR=$(mktemp -d) && git clone --depth 1 ${shellQuote(cloneUrl)} "$FLOWCREW_SKILL_REPAIR_DIR/flow-crew" && bash "$FLOWCREW_SKILL_REPAIR_DIR/flow-crew/skills/install.sh" --${adapter} --${scope}`;
}

function skillRevision(content: string): string | undefined {
  return /<!--\s*flowcrew-skill-revision:\s*([^\s]+)\s*-->/.exec(content)?.[1];
}

function skillReferencesMatch(packageRoot: string, skillPath: string, content: string): boolean {
  const guideDir = join(packageRoot, 'guide');
  const referencesDir = join(pathModule.dirname(skillPath), 'references');
  const visited = new Set<string>();
  const links = /\[([^\]]+)\]\(([^\s)]+)\)/g;
  const check = (source: string): boolean => {
    if (visited.has(source)) return true;
    visited.add(source);
    const installed = join(referencesDir, relative(guideDir, source));
    if (!existsSync(source) || !existsSync(installed)) return false;
    const dependencies: string[] = [];
    const expected = readFileSync(source, 'utf8').replace(links, (link, label: string, href: string) => {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return link;
      const target = resolve(pathModule.dirname(source), href.split('#')[0]);
      if (target.startsWith(guideDir + pathModule.sep)) {
        dependencies.push(target);
        return link; // The relative layout within guide/ is preserved in references/.
      }
      return `${label} (\`${href}\`)`;
    });
    return readFileSync(installed, 'utf8') === expected && dependencies.every(check);
  };
  return [...content.matchAll(/\]\(references\/([^#)]+)/g)]
    .every(([, path]) => check(resolve(guideDir, path)));
}

function addDoctorSkillCheck(
  checks: DoctorCheck[],
  adapter: AdapterName,
  projectDir: string,
  packageRoot: string,
): void {
  const agentLabel = adapter === 'codex' ? 'Codex' : 'Claude Code';
  const sourceFiles: Record<'ship' | 'fc-status', string> = {
    ship: join(packageRoot, 'skills', 'ship.md'),
    'fc-status': join(packageRoot, 'skills', 'fc-status.md'),
  };
  const home = process.env.HOME;
  const locations: DoctorSkillLocation[] = adapter === 'codex'
    ? [
      {
        label: 'project',
        files: {
          ship: join(projectDir, '.agents', 'skills', 'ship', 'SKILL.md'),
          'fc-status': join(projectDir, '.agents', 'skills', 'fc-status', 'SKILL.md'),
        },
      },
      ...(home ? [{
        label: 'global' as const,
        files: {
          ship: join(home, '.agents', 'skills', 'ship', 'SKILL.md'),
          'fc-status': join(home, '.agents', 'skills', 'fc-status', 'SKILL.md'),
        },
      }] : []),
    ]
    : [
      {
        label: 'project',
        files: {
          ship: join(projectDir, '.claude', 'skills', 'ship', 'SKILL.md'),
          'fc-status': join(projectDir, '.claude', 'skills', 'fc-status', 'SKILL.md'),
        },
      },
      ...(home ? [{
        label: 'global' as const,
        files: {
          ship: join(home, '.claude', 'skills', 'ship', 'SKILL.md'),
          'fc-status': join(home, '.claude', 'skills', 'fc-status', 'SKILL.md'),
        },
      }] : []),
    ];
  const installer = join(packageRoot, 'skills', 'install.sh');
  const repairCommand = (scope: DoctorSkillLocation['label']) => (
    `bash ${shellQuote(installer)} --${adapter} --${scope}`
  );
  const names = Object.keys(sourceFiles) as Array<keyof typeof sourceFiles>;
  const preferredScope: DoctorSkillLocation['label'] = locations.some((location) => (
    location.label === 'project' && names.some((name) => existsSync(location.files[name]))
  ))
    ? 'project'
    : home ? 'global' : 'project';
  const missingSources = names
    .map((name) => sourceFiles[name])
    .filter((path) => !existsSync(path));
  if (missingSources.length > 0) {
    checks.push({
      name: `${agentLabel} skills`,
      status: 'warn',
      message: `repository skill source ${missingSources.join(', ')} is missing. Restore and install: ${skillSourceRepairCommand(packageRoot, installer, adapter, preferredScope, missingSources)}`,
    });
    return;
  }
  const sourceContent = new Map<string, string>();
  for (const name of names) {
    sourceContent.set(name, readFileSync(sourceFiles[name], 'utf-8').replaceAll('](../guide/', '](references/'));
  }

  const issues: string[] = [];
  const current: string[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    const existing = names.filter((name) => existsSync(location.files[name]));
    if (existing.length === 0) continue;
    const missing = names.filter((name) => !existsSync(location.files[name]));
    if (missing.length > 0) {
      issues.push(`${location.label} install is incomplete (missing ${missing.join(', ')}). Run: ${repairCommand(location.label)}`);
    }
    for (const name of existing) {
      seen.add(name);
      const installedContent = readFileSync(location.files[name], 'utf-8');
      const expectedContent = sourceContent.get(name)!;
      if (installedContent === expectedContent && skillReferencesMatch(packageRoot, location.files[name], expectedContent)) {
        current.push(`${name} (${location.label})`);
        continue;
      }
      const installedRevision = skillRevision(installedContent);
      const expectedRevision = skillRevision(expectedContent) ?? 'unknown';
      const versionDetail = installedRevision
        ? `revision ${installedRevision}; repository revision ${expectedRevision}`
        : `unversioned; repository revision ${expectedRevision}`;
      issues.push(`${name} (${location.label}) is outdated or locally changed (${versionDetail}). Run: ${repairCommand(location.label)}`);
    }
  }

  const entirelyMissing = names.filter((name) => !seen.has(name));
  if (entirelyMissing.length > 0) {
    issues.push(`missing ${entirelyMissing.join(', ')}. Run: ${repairCommand(preferredScope)}`);
  }

  checks.push(issues.length > 0
    ? { name: `${agentLabel} skills`, status: 'warn', message: issues.join('\n') }
    : {
      name: `${agentLabel} skills`,
      status: 'ok',
      message: `current repository copies found: ${current.join(', ')}`,
    });
}

function commandSucceeds(commandName: string, commandArgs: string[]): boolean {
  try {
    execFileSync(commandName, commandArgs, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function cmdAdapter(): void {
  // Flags are not adapter names.
  const positional = parseCommandArgs('adapter', args).positionals;
  const requested = positional[0]?.trim().toLowerCase();
  if (!requested) {
    const setting = readAdapterSetting();
    const current = setting.error
      ? `invalid (${setting.error})`
      : setting.exists
        ? (setting.value ?? 'auto')
        : '(engine config/defaults.yaml is missing)';
    const installed = installedAdapters();
    console.log(`Current adapter: ${current}`);
    console.log(`Installed adapters: ${installed.length > 0 ? installed.join(', ') : 'none'}`);
    console.log(`Recommended adapter: ${RECOMMENDED}`);
    // Every other message in this surface ends in a command the reader can run;
    // these two states used to end in a statement of the problem alone.
    if (!setting.exists) console.log('Next: reinstall FlowCrew to restore its engine configuration.');
    else if (setting.error) console.log('Next: fix the file by hand, or run `flowcrew adapter <auto|codex|claude>` to rewrite the adapter line.');
    else if (installed.length === 0) console.log(`Next: install an adapter CLI — ${ADAPTER_INSTALL_HINT[RECOMMENDED]}`);
    if (setting.error) process.exitCode = EXIT_CODE.failed;
    return;
  }
  if (positional.length > 1 || (requested !== 'auto' && requested !== 'codex' && requested !== 'claude')) {
    console.error(commandUsage('adapter'));
    process.exitCode = EXIT_CODE.failed;
    return;
  }
  if (requested !== 'auto' && !installedAdapters().includes(requested)) {
    console.error(`Cannot select ${requested}: its CLI is not installed or visible on PATH.`);
    console.error(`Install it first: ${ADAPTER_INSTALL_HINT[requested]}`);
    process.exitCode = EXIT_CODE.failed;
    return;
  }
  const path = writeAdapterSetting(requested);
  console.log(`Adapter set to ${requested} in ${path}`);
}

async function cmdDoctor() {
  const projectDir = detectProjectDir();
  const checks: DoctorCheck[] = [];
  const packageRoot = resolve(import.meta.dirname ?? '.', '..');
  const skillPackageRoot = resolve(process.env.FLOWCREW_DOCTOR_SKILL_ROOT || packageRoot);

  const flowcrewPath = findExecutableOnPath('flowcrew');
  const expectedCliPath = join(packageRoot, 'dist', 'cli.js');
  let resolvedFlowcrewPath: string | undefined;
  let resolvedExpectedCliPath: string | undefined;
  try { if (flowcrewPath) resolvedFlowcrewPath = realpathSync(flowcrewPath); } catch { /* unresolvable PATH entry */ }
  try { resolvedExpectedCliPath = realpathSync(expectedCliPath); } catch { /* build may be absent */ }
  if (!flowcrewPath) {
    checks.push({ name: 'flowcrew CLI', status: 'warn', message: 'not found on PATH. Run `npm link` from this repository.' });
  } else if (!resolvedFlowcrewPath || !resolvedExpectedCliPath) {
    checks.push({
      name: 'flowcrew CLI',
      status: 'warn',
      message: `A PATH entry exists at ${flowcrewPath}, but whether it serves this install could not be confirmed.`,
    });
  } else if (resolvedFlowcrewPath === resolvedExpectedCliPath) {
    checks.push({ name: 'flowcrew CLI', status: 'ok', message: `This install is available on PATH (${flowcrewPath}).` });
  } else {
    checks.push({
      name: 'flowcrew CLI',
      status: 'warn',
      message: `PATH points to a different install: ${resolvedFlowcrewPath}. This install's CLI is ${resolvedExpectedCliPath}.`,
    });
  }

  // Node.js version
  const nodeVersion = process.version;
  const [, majorRaw, minorRaw] = /^v(\d+)\.(\d+)\./.exec(nodeVersion) ?? [];
  const major = parseInt(majorRaw ?? '0', 10);
  const minor = parseInt(minorRaw ?? '0', 10);
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  checks.push({
    name: 'Node.js',
    status: nodeOk ? 'ok' : 'fail',
    message: nodeOk ? `${nodeVersion}` : `${nodeVersion} - Node.js 22.5+ required. Install from https://nodejs.org/`,
  });

  const supervision = detectSupervisorBackend();
  checks.push({
    name: 'Process supervision',
    status: 'ok',
    message: supervision.message,
  });

  // Adapter CLIs
  const installed = installedAdapters();
  const installedSet = new Set(installed);
  checks.push({
    name: 'Installed adapters',
    status: installed.length > 0 ? 'ok' : 'warn',
    message: installed.length > 0 ? installed.join(', ') : 'none',
  });
  const adapterDiagnostics: Record<AdapterName, { label: string; authArgs: string[]; loginHint: string }> = {
    codex: { label: 'OpenAI Codex CLI', authArgs: ['login', 'status'], loginHint: 'Run `codex login`.' },
    claude: { label: 'Claude Code CLI', authArgs: ['auth', 'status'], loginHint: 'Run `claude auth login`.' },
  };
  for (const adapter of Object.keys(ADAPTER_CLI) as AdapterName[]) {
    const cmd = ADAPTER_CLI[adapter];
    const diagnostic = adapterDiagnostics[adapter];
    if (installedSet.has(adapter)) {
      const authenticated = commandSucceeds(cmd, diagnostic.authArgs);
      checks.push({
        name: diagnostic.label,
        status: authenticated ? 'ok' : 'warn',
        message: authenticated ? 'installed and logged in' : `installed, but login was not confirmed. ${diagnostic.loginHint}`,
      });
    } else {
      checks.push({ name: diagnostic.label, status: 'warn', message: `not found. Install: ${ADAPTER_INSTALL_HINT[adapter]}` });
    }
  }
  for (const adapter of installed) {
    addDoctorSkillCheck(checks, adapter, projectDir, skillPackageRoot);
    const { doctorSessionIntegration } = await import('./session-integration.js');
    checks.push(doctorSessionIntegration(adapter, projectDir, skillPackageRoot, process.env));
  }
  if (installed.length === 0) {
    checks.push({ name: 'Any adapter CLI', status: 'warn', message: 'No agent CLI found. Install and log in to Claude Code or Codex before a live run.' });
  }
  // Only hand out `flowcrew adapter <name>` when that CLI is actually installed:
  // the command refuses an absent CLI, so suggesting it on a box without one would
  // be advice that cannot be followed.
  checks.push(installedSet.has(RECOMMENDED)
    ? {
      name: 'Recommended adapter',
      status: 'ok',
      message: `${RECOMMENDED}. Select it with: flowcrew adapter ${RECOMMENDED}`,
    }
    : {
      name: 'Recommended adapter',
      status: 'warn',
      message: installed.length > 0
        ? `${RECOMMENDED} is recommended but not installed; ${installed.join(' and ')} will be used. Install it with: ${ADAPTER_INSTALL_HINT[RECOMMENDED]}`
        : `${RECOMMENDED}, once an adapter CLI exists. Install it with: ${ADAPTER_INSTALL_HINT[RECOMMENDED]}`,
    });

  // Config files
  const setting = readAdapterSetting();
  if (!setting.exists) {
    checks.push({ name: 'config/defaults.yaml', status: 'fail', message: 'Engine defaults missing. Reinstall FlowCrew to restore them.' });
  } else if (setting.error) {
    checks.push({ name: 'config/defaults.yaml', status: 'fail', message: `${setting.error}. Fix the engine configuration or reinstall FlowCrew.` });
  } else {
    const configured = setting.value ?? 'auto';
    checks.push({ name: 'config/defaults.yaml', status: 'ok', message: `adapter: ${configured}` });
    if (configured === 'mock') {
      checks.push({ name: 'Configured adapter (mock)', status: 'ok', message: 'deterministic in-process test adapter; no external CLI is required' });
    } else if (configured === 'auto' || configured === 'codex' || configured === 'claude') {
      const resolution = resolveAdapterChoice({ configured }, installed);
      if (resolution.ok) {
        const fellBack = configured !== 'auto' && configured !== resolution.adapter;
        checks.push({
          name: `Configured adapter (${configured})`,
          status: fellBack ? 'warn' : 'ok',
          message: `${resolution.reason} Set explicitly with: flowcrew adapter ${resolution.adapter}`,
        });
      } else {
        checks.push({
          name: `Configured adapter (${configured})`,
          status: 'warn',
          message: resolution.hint,
        });
      }
    } else {
      checks.push({
        name: `Configured adapter (${configured})`,
        status: 'fail',
        message: `Unknown adapter. Available values: auto, ${AVAILABLE_ADAPTER_NAMES.join(', ')}. Set one with: flowcrew adapter ${RECOMMENDED}`,
      });
    }
  }

  // Agents directory
  const agentsDir = join(engineConfigDir, 'agents');
  if (existsSync(agentsDir)) {
    const agents = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
    checks.push({ name: 'Agent configs', status: agents.length > 0 ? 'ok' : 'warn', message: `${agents.length} agents found` });
    const requiredAgents = ['planner'];
    for (const name of requiredAgents) {
      if (!agents.includes(`${name}.yaml`)) {
        checks.push({ name: `Agent: ${name}`, status: 'warn', message: `Engine config/agents/${name}.yaml missing. Reinstall FlowCrew to restore it.` });
      }
    }
    // Check for _base.md (shared prompt prepended to all agents)
    const baseMdPath = join(agentsDir, '_base.md');
    if (existsSync(baseMdPath)) {
      const size = readFileSync(baseMdPath, 'utf-8').trim().length;
      checks.push({ name: 'Base prompt (_base.md)', status: size > 0 ? 'ok' : 'warn', message: size > 0 ? `${size} chars` : 'empty — agents will run without shared guidelines' });
    } else {
      checks.push({ name: 'Base prompt (_base.md)', status: 'warn', message: 'missing — agents will run without shared guidelines. Reinstall FlowCrew to restore it.' });
    }
  } else {
    checks.push({ name: 'Agent configs', status: 'fail', message: 'Engine config/agents/ missing. Reinstall FlowCrew to restore it.' });
  }
  const workflowsDir = join(engineConfigDir, 'workflows');
  const workflows = existsSync(workflowsDir) ? readdirSync(workflowsDir).filter(f => f.endsWith('.yaml')) : [];
  checks.push({ name: 'Workflow configs', status: workflows.length > 0 ? 'ok' : 'fail', message: `${workflows.length} engine workflows found` });

  // Port occupancy is not the same fact as "your dashboard is running". The previous probe
  // resolved on any response at all — a 404 from an unrelated server counted, and so did a
  // FlowCrew dashboard serving a different checkout. On a machine with a real dashboard
  // already up, a fresh install was told its own server was running.
  const port = parseInt(process.env.PORT || '3000', 10);
  const packageRootForPort = resolve(import.meta.dirname ?? '.', '..');
  try {
    const http = await import('node:http');
    const body = await new Promise<string>((resolve_, reject) => {
      const req = http.get(`http://localhost:${port}/api/dashboard/status`, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`status ${res.statusCode}`));
          return;
        }
        let text = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => { text += chunk; });
        res.on('end', () => resolve_(text));
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    let identity: { pid?: number; loadedBuild?: { algorithm?: string } } | undefined;
    try { identity = JSON.parse(body) as typeof identity; } catch { /* not JSON */ }
    if (!identity?.loadedBuild?.algorithm) {
      checks.push({
        name: `Port ${port}`,
        status: 'warn',
        message: 'Something is listening, but it does not answer as a FlowCrew dashboard.',
      });
    } else {
      // The status payload names the pid, so /proc resolves which checkout it serves. Where
      // /proc is unavailable, say the install is unconfirmed rather than claim it is this one.
      let servedRoot: string | undefined;
      if (identity.pid !== undefined) {
        try { servedRoot = realpathSync(`/proc/${identity.pid}/cwd`); } catch { /* not readable */ }
      }
      if (servedRoot === undefined) {
        checks.push({
          name: `Port ${port}`,
          status: 'warn',
          message: `A FlowCrew dashboard is running (pid ${identity.pid ?? 'unknown'}), but which install it serves could not be confirmed.`,
        });
      } else if (servedRoot === realpathSync(packageRootForPort)) {
        checks.push({ name: `Port ${port}`, status: 'ok', message: `This install's dashboard is running (pid ${identity.pid}).` });
      } else {
        checks.push({
          name: `Port ${port}`,
          status: 'warn',
          message: `The port is held by a FlowCrew dashboard for a different install: ${servedRoot} (pid ${identity.pid}). Start this one on another port with PORT=<n> flowcrew start.`,
        });
      }
    }
  } catch { /* expected - optional resource */
    checks.push({ name: `Port ${port}`, status: 'warn', message: 'Server not running. Start with `flowcrew start`.' });
  }

  // Engine and UI builds
  const engineDist = join(packageRoot, 'dist', 'cli.js');
  checks.push({
    name: 'Engine build',
    status: existsSync(engineDist) ? 'ok' : 'warn',
    message: existsSync(engineDist) ? 'built' : 'Not built. Run: npm run build',
  });
  const uiDist = join(packageRoot, 'ui', 'dist', 'index.html');
  checks.push({
    name: 'UI build',
    status: existsSync(uiDist) ? 'ok' : 'warn',
    message: existsSync(uiDist) ? 'built' : 'Not built. Run: npm run build:ui',
  });

  // Print results
  console.log('\n🩺 FlowCrew Doctor\n');
  let hasFailure = false;
  let hasWarning = false;
  for (const c of checks) {
    const icon = c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️ ' : '❌';
    // Multi-line messages carry the install guidance for a machine with no adapter
    // CLI — the one audience doctor exists for. Indent continuation lines instead of
    // collapsing them into an unusable run-on line.
    const [head, ...rest] = c.message.split('\n');
    console.log(`  ${icon} ${c.name}: ${head}`);
    for (const line of rest) console.log(`       ${line}`);
    if (c.status === 'fail') hasFailure = true;
    if (c.status === 'warn') hasWarning = true;
  }
  console.log('');
  if (hasFailure) {
    console.log('Some checks failed. Fix the issues above and run `flowcrew doctor` again.');
    process.exit(EXIT_CODE.failed);
  } else if (hasWarning) {
    console.log('Some checks need attention before a live run. Review the warnings above.');
  } else {
    console.log('All checks passed! 🎉');
  }
}

async function cmdStart() {
  const projectDir = detectProjectDir();
  const port = parseInt(process.env.PORT || '3000', 10);
  const { dashboardListenHosts, startDashboard } = await import('./dashboard.js');
  const net = await import('node:net');
  // Preserve refusal before the optional UI build writes anything. The actual
  // listeners still arbitrate races; the probe uses their same authority set.
  for (const host of dashboardListenHosts()) {
    const portAvailable = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, host);
    });
    if (!portAvailable) {
      console.error(`❌ Port ${port} is already in use. Either stop the other process or use a different port:`);
      console.error(`   PORT=${port + 1} flowcrew start`);
      process.exit(EXIT_CODE.failed);
    }
  }

  // Build UI if dist doesn't exist
  const uiDist = join(import.meta.dirname ?? '.', '..', 'ui', 'dist', 'index.html');
  if (!existsSync(uiDist)) {
    const uiDir = join(import.meta.dirname ?? '.', '..', 'ui');
    if (existsSync(join(uiDir, 'package.json'))) {
      console.log('Building UI...');
      try {
        execSync('npm run build', { cwd: uiDir, stdio: 'inherit' });
      } catch { /* expected - optional resource */
        console.warn('⚠️  UI build failed. Dashboard will start without the web interface.');
      }
    }
  }

  await startDashboard(projectDir, port);
}

async function cmdQuick() {
  const parsed = parseCommandArgs('quick', args);
  const value = (name: string) => parsed.values.get(`--${name}`);
  const has = (name: string) => parsed.flags.has(`--${name}`);
  const projectDir = value('project') ? resolve(value('project')!) : detectProjectDir();
  let task = value('task') ?? '';
  let adapter = value('adapter') ?? '';
  let workflow = value('workflow') ?? 'planner';
  const workflowExplicit = value('workflow') !== undefined;
  const maxIterations = value('max-iterations') === undefined ? undefined : Number(value('max-iterations'));
  const campaignArg = value('campaign');
  const campaignDisabled = has('no-campaign');
  const context = parsed.order.lastIndexOf('--no-inherit-campaign') > parsed.order.lastIndexOf('--campaign-context')
    ? 'skip' : value('campaign-context');
  let inheritCampaignContext = context !== 'skip';
  const campaignContextExplicit = context !== undefined;
  let existingRunId = value('existing-run-id');
  const background = has('background');
  const session = value('session') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || undefined;
  const acknowledgementPresent = has('acknowledge-brief-warnings') || value('acknowledge-brief-warnings') !== undefined;
  const acknowledgementDigest = value('acknowledge-brief-warnings');
  let transportedAdmission: BriefAdmissionRecord | undefined;
  let storedAdmission: BriefAdmissionRecord | undefined;
  let taskSupplied = value('task') !== undefined;
  const launchOptions: import('./task-registry.js').TaskLaunchOptions = {
    ...(adapter ? { adapter } : {}),
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(campaignArg === undefined ? {} : { campaign: campaignArg }),
    ...(campaignDisabled ? { noCampaign: true } : {}),
    ...(context === undefined ? {} : { campaignContext: context as 'inherit' | 'skip' }),
  };
  const transport = parsed.order.filter(name => ['--task', '--brief-input-base64', '-'].includes(name)).at(-1);
  if (transport === '--brief-input-base64') {
    task = Buffer.from(value('brief-input-base64')!, 'base64url').toString('utf8');
    taskSupplied = true;
  }
  if (value('brief-admission-record') !== undefined) transportedAdmission = decodeBriefAdmission(value('brief-admission-record')!);
  if (transport === '-') { task = readFileSync(0, 'utf-8'); taskSupplied = true; }
  if (!task && parsed.positionals.length) { task = parsed.positionals.join(' '); taskSupplied = true; }

  // --existing-run-id path: dashboard handing off a rerun/execute to a detached
  // scheduler process. Reuse the existing run state and read the task brief
  // from the run dir unless an internal launcher transported the already
  // admitted exact bytes and record together.
  if (existingRunId) {
    const { runsRoot: getRunsRoot } = await import('./store.js');
    let storedTaskDescription: string | undefined;
    try {
      const runJson = JSON.parse(readFileSync(join(getRunsRoot(), existingRunId, 'run.json'), 'utf-8'));
      if (typeof runJson.taskDescription === 'string') storedTaskDescription = runJson.taskDescription;
      storedAdmission = runJson.briefAdmission as BriefAdmissionRecord | undefined;
    } catch { /* an uninitialized reservation has no run state yet */ }

    const hasTransportedExactTask = taskSupplied && transportedAdmission !== undefined;
    const briefPath = join(getRunsRoot(), existingRunId, 'task_brief.md');
    if (!hasTransportedExactTask && existsSync(briefPath)) {
      try { task = readFileSync(briefPath, 'utf-8'); } catch { /* ignore */ }
    }
    if (!task.trim() && storedTaskDescription !== undefined) task = storedTaskDescription;
  }

  if (!task.trim()) {
    console.error(commandUsage('quick'));
    console.error('');
    console.error('Options:');
    console.error('  --adapter auto|codex|claude|mock  Agent backend (defaults to engine config/defaults.yaml)');
    console.error('  --workflow <name>       Workflow to use (default: direct; research/program use planner loops)');
    console.error('  --max-iterations <n>    Override engine config/defaults.yaml for this run');
    console.error('  --campaign <name>       Attach run to campaign (default: slug of the main worktree)');
    console.error('  --no-campaign           Run un-attached to any campaign (opt-out)');
    console.error('  --campaign-context=inherit|skip  Planner history context; no flag skips after 3 recent adverse endings');
    console.error('  --project <path>        Project directory (default: cwd)');
    console.error('  --task "text"           Task description as flag');
    console.error('  --background            Register and launch under the flowcrew daemon');
    console.error('  --session <id>          Session ledger for registration (default: CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID)');
    console.error('  --acknowledge-brief-warnings[=<digest>]  Confirm changed-run continuation (never skips inspection)');
    console.error('  -                       Read task from stdin');
    console.error('  --existing-run-id <id>  Resume an existing run (reads task from <run_dir>/task_brief.md)');
    process.exit(EXIT_CODE.failed);
  }

  const {
    briefDeclarationFailures,
    createBriefAdmission,
    formatBriefPreflightReport,
    inspectBrief,
    verifyBriefAdmission,
  } = await import('./brief-preflight.js');
  const preflight = inspectBrief(task);
  console.log(`${formatBriefPreflightReport(preflight)}\n`);
  const { parseBriefFrontmatter, autoSelectedWorkflow } = await import('./scheduler/sched_admission/brief-contract.js');
  const parsedBrief = parseBriefFrontmatter(task);
  const auto = autoSelectedWorkflow(parsedBrief, workflowExplicit ? workflow : undefined);
  // Nothing about the brief matters if nothing can execute it. A newcomer whose
  // adapter CLI is not installed must be told the install command, not sent to
  // fix a brief they cannot run either way, so environment refusals precede
  // content refusals. The authoritative resolution still happens below.
  if (background) {
    const earlyResolution = resolveRuntimeAdapter({
      explicit: adapter?.trim() || undefined,
      configured: loadEngineDefaults().adapter,
    });
    if (!earlyResolution.ok) {
      console.error(`❌ ${earlyResolution.hint}`);
      process.exitCode = EXIT_CODE.failed;
      return;
    }
  }

  const refusalFindings = briefDeclarationFailures(task, preflight);
  if (refusalFindings.length) {
    const refusal = refusalFindings.map(finding => `[${finding.code}] ${finding.message}`).join('\n');
    recordLaunchRefusal(refusal);
    console.error(refusal);
    process.exitCode = EXIT_CODE.failed;
    return;
  }

  if (auto.error) {
    const refusal = `Launch refused: ${auto.error}.`;
    recordLaunchRefusal(refusal);
    console.error(refusal);
    process.exitCode = EXIT_CODE.failed;
    return;
  }

  if (acknowledgementDigest !== undefined && acknowledgementDigest !== preflight.digest) {
    console.error(`Brief acknowledgement digest mismatch: received ${acknowledgementDigest || '(empty)'}, current digest is ${preflight.digest}.`);
    console.error(`Review the report and rerun with --acknowledge-brief-warnings=${preflight.digest}`);
    process.exit(EXIT_CODE.failed);
  }

  const transportedExistingRun = Boolean(existingRunId && taskSupplied && transportedAdmission);
  const transportedVerification = transportedAdmission
    ? verifyBriefAdmission(task, transportedAdmission)
    : undefined;
  const storedVerification = storedAdmission
    ? verifyBriefAdmission(task, storedAdmission)
    : undefined;
  const transportedContinuationIsBound = transportedExistingRun
    && transportedVerification?.status === 'valid'
    && storedVerification?.status === 'valid'
    && transportedAdmission!.digest === storedAdmission!.digest;
  // A reserved first launch has no stored admission yet. A present record
  // still owns continuation identity and must agree with transported input.
  const priorAdmission = transportedExistingRun
    ? (transportedContinuationIsBound
        ? transportedAdmission
        : (storedAdmission ?? (transportedVerification?.status === 'valid' ? transportedAdmission : undefined)))
    : (transportedAdmission ?? storedAdmission);
  const priorVerification = priorAdmission
    ? verifyBriefAdmission(task, priorAdmission)
    : undefined;
  let briefAdmission: BriefAdmissionRecord;
  if (priorVerification?.status === 'valid') {
    briefAdmission = priorAdmission!;
  } else {
    const continuationNeedsFreshDecision = Boolean(existingRunId || transportedAdmission);
    if (continuationNeedsFreshDecision && !acknowledgementPresent) {
      const reason = priorVerification
        ? ` Stored admission status: ${priorVerification.status}.`
        : '';
      console.error(`Launch paused before run creation.${reason}`);
      console.error('Review the complete report above, then explicitly continue this exact brief with:');
      console.error(`  --acknowledge-brief-warnings=${preflight.digest}`);
      console.error('For deterministic CI/cron policy, the bare --acknowledge-brief-warnings flag accepts the current inspected input without prompting.');
      process.exit(EXIT_CODE.failed);
    }
    briefAdmission = createBriefAdmission(
      preflight,
      acknowledgementPresent
        ? {
            kind: 'explicit',
            source: acknowledgementDigest === undefined ? 'cli_current_input_flag' : 'cli_digest_flag',
            at: new Date().toISOString(),
          }
        : { kind: 'not_required' },
    );
  }

  // Auto-select the workflow only after the shared report is visible. The canonical frontmatter parser owns this
  // decision, quick has no YAML regex, and rehearse reports the same choice.
  workflow = auto.workflow;
  launchOptions.workflow = workflow;
  if (!workflowExplicit && workflow !== 'planner') {
    console.error(`Note: ${auto.reason} -> auto-selected --workflow ${workflow} (pass --workflow to override).`);
  }

  const initializedContinuation = Boolean(existingRunId && existsSync(join((await import('./store.js')).runsRoot(), existingRunId, 'run.json')));
  if (!initializedContinuation) {
    const { inspectShipSetupRecord } = await import('./ship-setup-record.js');
    const setup = inspectShipSetupRecord(projectDir, task);
    if (setup.state !== 'ready') {
      const detail = setup.state === 'missing'
        ? `no exact setup record exists at ${setup.recordPath}`
        : setup.state === 'refused'
          ? `ship-setup refused this exact target and brief: ${setup.reason}`
          : `the exact setup record is invalid: ${setup.reason}`;
      const refusal = `Launch refused: ${detail}. Run flowcrew ship-setup successfully for this target and exact brief, then retry.`;
      recordLaunchRefusal(refusal);
      console.error(refusal);
      process.exitCode = EXIT_CODE.failed;
      return;
    }
  }

  const defaults = loadEngineDefaults();
  const campaignBaseDir = campaignBaseDirectory(projectDir);
  const campaignBaseSlug = resolveCampaignStorageKey({ campaignName: campaignBaseDir.split(/[\\/]/).filter(Boolean).pop(), projectDir: campaignBaseDir });
  const resolvedCampaign = campaignDisabled
    ? undefined
    : (campaignArg || campaignBaseSlug || undefined);

  if (!campaignContextExplicit && initializedContinuation && existingRunId) {
    try {
      const continuation = readRunState(projectDir, existingRunId);
      inheritCampaignContext = continuation.inheritCampaignContext !== false;
      if (background) launchOptions.campaignContext = inheritCampaignContext ? 'inherit' : 'skip';
    } catch { /* scheduler remains authoritative for an unreadable continuation */ }
  } else if (!campaignContextExplicit && resolvedCampaign) {
    try {
      const hygiene = assessCampaignHygiene(readCampaignEntries(projectDir, resolvedCampaign));
      if (hygiene.suggestContextSkip) {
        inheritCampaignContext = false;
        launchOptions.campaignContext = 'skip';
        console.error(
          `Note: campaign ${resolvedCampaign} has ${hygiene.recentAdverse}/${hygiene.recentEnded} recent adverse endings; defaulted planner context to skip (pass --campaign-context=inherit to override).`,
        );
      }
    } catch { /* unreadable hygiene preserves the established inherit default */ }
  }

  if (background) {
    if (adapter) {
      const candidate = adapter.trim();
      if (candidate !== 'auto' && !AVAILABLE_ADAPTER_NAMES.includes(candidate as typeof AVAILABLE_ADAPTER_NAMES[number])) {
        throw new Error(`Unknown adapter "${adapter}". Available adapters: auto, ${AVAILABLE_ADAPTER_NAMES.join(', ')}`);
      }
      adapter = candidate;
    }
    // A background submit hands the run to the daemon, which resolves the
    // adapter in a child process minutes or hours later. Validate availability
    // HERE as well: registering a task whose adapter CLI is not installed
    // prints a Task id and then fails out of sight, which is the worst place
    // for someone to discover they never finished setting up. The child still
    // performs the authoritative resolution; this only fails fast.
    const backgroundResolution = resolveRuntimeAdapter({
      explicit: adapter || undefined,
      configured: loadEngineDefaults().adapter,
    });
    if (!backgroundResolution.ok) {
      console.error(`❌ ${backgroundResolution.hint}`);
      process.exitCode = EXIT_CODE.failed;
      return;
    }
    try {
      const { id } = await registerBackgroundTask({
        launcher: (await import('./session-push.js')).captureLauncher(process.env, process.cwd(), session),
        kind: 'quick',
        name: extractTaskTitle(task) || 'Quick task',
        brief_text: task,
        brief_admission: briefAdmission,
        projectDir,
        ...(existingRunId ? { run_id: existingRunId } : {}),
        launch_options: launchOptions,
      });
      await registerLaunchLedger(id, task, briefAdmission.digest, session);
      return;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      const { rpcErrorExitCode } = await import('./orchestrator-rpc.js');
      process.exit(rpcErrorExitCode(err));
    }
  }

  const configuredAdapter = loadEngineDefaults().adapter;
  const adapterResolution = resolveRuntimeAdapter({
    explicit: adapter || undefined,
    configured: configuredAdapter,
  });
  if (!adapterResolution.ok) {
    console.error(`❌ ${adapterResolution.hint}`);
    process.exitCode = EXIT_CODE.failed;
    return;
  }
  adapter = adapterResolution.adapter;
  console.log(`Adapter resolution: ${adapter} — ${adapterResolution.reason}`);
  adapter = normalizeAdapterName(adapter);

  const workflowsDir = join(engineConfigDir, 'workflows');
  const workflowPath = initializedContinuation
    ? join((await import('./store.js')).runsRoot(), existingRunId!, 'workflow.yaml')
    : join(workflowsDir, `${workflow}.yaml`);
  if (!existsSync(workflowPath)) {
    console.error(`Workflow not found: ${workflow}.yaml`);
    const available = existsSync(workflowsDir) ? readdirSync(workflowsDir).filter(f => f.endsWith('.yaml')).map(f => f.replace('.yaml', '')) : [];
    if (available.length > 0) console.error(`  Available: ${available.join(', ')}`);
    else console.error('  Reinstall FlowCrew to restore its engine workflows.');
    process.exit(EXIT_CODE.failed);
  }

  const { assessResearchIterationBudget, loadWorkflow, runWorkflow } = await import('./scheduler.js');
  const { config, raw } = loadWorkflow(workflowPath, initializedContinuation);
  if (maxIterations && !initializedContinuation) config.defaults.max_iterations = maxIterations;
  if (!initializedContinuation) {
    const budgetDefaults = loadEngineDefaults();
    const budgetAssessment = assessResearchIterationBudget(
      parsedBrief.research,
      config.defaults.max_iterations ?? budgetDefaults.max_iterations,
      {
        attemptTimeoutMs: budgetDefaults.default_timeout_ms,
        technicalRetries: budgetDefaults.stage_technical_retries,
      },
    );
    if (!budgetAssessment.pass) {
      const refusal = `Launch refused: ${budgetAssessment.reason}. Adjust the named authored budget or its named engine binding.`;
      recordLaunchRefusal(refusal);
      console.error(refusal);
      process.exitCode = EXIT_CODE.failed;
      return;
    }
  }

  const resolvedAgentsDir = join(engineConfigDir, 'agents');
  const agents = new Map<string, unknown>();

  const adapterInstance = await loadAdapterByName(adapter);

  // Background workers already have a durable task→run binding. A foreground
  // launch records the same obligation without handing execution to the daemon.
  const { TaskRegistry, TASK_LIST_STATUS } = await import('./task-registry.js');
  const { SessionPush, captureLauncher } = await import('./session-push.js');
  const registry = new TaskRegistry();
  const boundTask = existingRunId ? registry.list({ status: TASK_LIST_STATUS.ALL })
    .find(entry => entry.run_id === existingRunId && entry.projectDir === projectDir) : undefined;
  const launcher = captureLauncher(process.env, process.cwd(), session);
  let foregroundTask;
  if (launcher && boundTask?.foregroundOwner && boundTask.launcher?.sessionId === launcher.sessionId
      && boundTask.launcher.frontend === launcher.frontend) {
    const { hasLiveForegroundOwner } = await import('./task-registry.js');
    if (hasLiveForegroundOwner(boundTask)) throw new Error(`Task #${boundTask.id} still has a live foreground owner; refusing concurrent continuation`);
    const { processStartToken } = await import('./run-lock.js');
    foregroundTask = registry.update(boundTask.id, {
      foregroundOwner: { pid: process.pid, processStart: processStartToken(process.pid) },
      launcher, status: 'running', completed_at: undefined,
    });
  } else if (launcher && !boundTask) {
    const { reserveRun } = await import('./store.js');
    const { processStartToken } = await import('./run-lock.js');
    existingRunId ??= reserveRun(projectDir).runId;
    foregroundTask = registry.create({
      launcher, foregroundOwner: { pid: process.pid, processStart: processStartToken(process.pid) },
      kind: 'quick', name: extractTaskTitle(task) || 'Quick task', brief_text: task,
      brief_admission: briefAdmission, projectDir, run_id: existingRunId, status: 'running', launch_options: launchOptions,
    });
    console.log(`Task #${foregroundTask.id} registered (foreground execution).`);
    await registerLaunchLedger(foregroundTask.id, task, briefAdmission.digest, session);
  }
  const push = foregroundTask ? new SessionPush(registry) : undefined;
  let activePush: Promise<void> | undefined;
  const refreshPush = () => activePush ??= push!.sweep(foregroundTask!.id)
    .catch(error => console.warn(`Warning: foreground session delivery remains pending: ${String(error)}`))
    .finally(() => { activePush = undefined; });
  const pushTimer = push ? setInterval(() => { void refreshPush(); }, 2000) : undefined;

  console.log(`FlowCrew: shipping task with workflow "${config.name}"...`);
  console.log(`Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);
  console.log(`Project: ${projectDir}`);
  console.log(`Adapter: ${adapter}`);
  console.log(`Max iterations: ${config.defaults.max_iterations ?? defaults.max_iterations}`);
  console.log(`Stage timeout: ${defaults.default_timeout_ms}ms (engine config/defaults.yaml::default_timeout_ms)`);
  // Resolve campaign id: explicit --campaign > slug(basename(campaignBaseDirectory)).
  // --no-campaign forces undefined (run stays untagged).
  console.log(`Campaign: ${resolvedCampaign ?? '(none — --no-campaign)'}`);
  if (!campaignDisabled && !campaignArg && campaignBaseDir !== projectDir) {
    // Only reachable inside a linked worktree. Say so, because the name does
    // not match the directory the user is standing in.
    console.log(`Campaign source: main worktree of this repository (${campaignBaseDir})`);
  }
  if (resolvedCampaign && !inheritCampaignContext) {
    console.log('Campaign context: skipped (campaign ownership preserved)');
  }
  console.log(`Auto-approve: true\n`);

  // Live progress reporter
  const { runsRoot } = await import('./store.js');
  const seenStatus = new Map<string, string>();
  const startTime = Date.now();
  const progressTimer = setInterval(() => {
    try {
      const runs = readdirSync(runsRoot()).sort().reverse();
      if (runs.length === 0) return;
      const stateFile = join(runsRoot(), runs[0], 'run.json');
      if (!existsSync(stateFile)) return;
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      for (const [id, ss] of Object.entries(state.stages) as [string, { status: string; duration_ms?: number; error?: string }][]) {
        const prev = seenStatus.get(id);
        if (prev === ss.status) continue;
        seenStatus.set(id, ss.status);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        if (ss.status === STAGE_STATUS.RUNNING) process.stdout.write(`  [${elapsed}s] ⟳ ${id} started\n`);
        else if (ss.status === STAGE_STATUS.COMPLETE) { const dur = ss.duration_ms ? `${(ss.duration_ms / 1000).toFixed(0)}s` : ''; process.stdout.write(`  [${elapsed}s] ✓ ${id} complete${dur ? ' (' + dur + ')' : ''}\n`); }
        else if (ss.status === STAGE_STATUS.FAILED) process.stdout.write(`  [${elapsed}s] ✗ ${id} failed${ss.error ? ': ' + ss.error : ''}\n`);
        else if (ss.status === STAGE_STATUS.SKIPPED) process.stdout.write(`  [${elapsed}s] ⊘ ${id} skipped\n`);
      }
    } catch { /* non-critical */ }
  }, 2000);

  let finalState;
  try {
    if (push) await refreshPush();
    finalState = await runWorkflow(config, raw, projectDir, adapterInstance as any, agents as any, undefined, resolvedAgentsDir, existingRunId, task, true, resolvedCampaign, inheritCampaignContext, briefAdmission);
  } finally {
    clearInterval(progressTimer);
    clearInterval(pushTimer);
    if (push && foregroundTask) {
      await activePush;
      registry.update(foregroundTask.id, {
        status: !finalState ? 'failed' : isPausedRunStatus(finalState.status) ? 'deferred' : 'done',
        completed_at: finalState?.completedAt,
      });
      await refreshPush();
    }
  }
  console.log(`FlowCrew run: ${finalState.runId}`);

  // Desktop notification
  try {
    const finalStatus = resolveRunStatus(finalState.status);
    const title = finalStatus.kind === 'known'
      ? CLI_RUN_STATUS_PRESENTATION[finalStatus.status].notificationTitle
      : `FlowCrew: Unrecognized status ${finalStatus.display}`;
    const body = task.slice(0, 80);
    if (process.platform === 'darwin') {
      const { execSync: es } = await import('node:child_process');
      es(`osascript -e 'display notification "${body}" with title "${title}"'`, { stdio: 'ignore' });
    }
  } catch { /* non-critical */ }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
  const succeeded = isSuccessfulRunStatus(finalState.status);
  const parked = isPausedRunStatus(finalState.status);
  const icon = succeeded ? '✓' : parked ? '⏸' : '✗';
  console.log(`\n${icon} Workflow "${config.name}" ${finalState.status} (${totalTime}s total)`);
  if (parked && finalState.parked) {
    console.log(`  ⏸ awaiting approval: ${finalState.parked.action}${finalState.parked.target ? ` → ${finalState.parked.target}` : ''}`);
    console.log(`     resolve with: flowcrew inbox approve ${finalState.parked.requestId}   (or: flowcrew inbox deny ${finalState.parked.requestId})`);
  }
  for (const [id, st] of Object.entries(finalState.stages) as [string, { status: string; duration_ms?: number; error?: string }][]) {
    const si = st.status === STAGE_STATUS.COMPLETE ? '✓' : st.status === STAGE_STATUS.FAILED ? '✗' : st.status === STAGE_STATUS.SKIPPED ? '⊘' : '·';
    console.log(`  ${si} ${id}: ${st.status}${st.duration_ms ? ` (${(st.duration_ms / 1000).toFixed(1)}s)` : ''}`);
  }
  if (!succeeded && !parked && finalState.failureReason) {
    console.log(`  Failure reason: ${finalState.failureReason.replace(/\s+/g, ' ').trim()}`);
  }
  if (!succeeded && !parked) {
    for (const [id, stage] of Object.entries(finalState.stages) as [string, { status: string; error?: string }][]) {
      if (stage.status === STAGE_STATUS.FAILED && stage.error) {
        console.log(`  Failed stage ${id}: ${stage.error.replace(/\s+/g, ' ').trim()}`);
      }
    }
  }
  // A research ceiling (honest negative) and a shipped beat are successes, not failures —
  // exit 0 so a spawning parent (campaign outer loop's execSync) doesn't read it as a crash.
  // A PARK is likewise not a failure: exiting non-zero would make systemd report
  // the unit failed, and the daemon would relaunch the brief as a BRAND-NEW run —
  // i.e. re-run the very consequential action that is waiting for approval.
  process.exitCode = (succeeded || parked) ? EXIT_CODE.completed : EXIT_CODE.failed;
}

/**
 * Run IDs that have a readable run.json, ordered newest-first by run.json mtime.
 * Resolving by mtime (not lexicographic name) so named/test run dirs like
 * `trace-run-001` can't hijack "latest", and dirs without run.json are skipped.
 */
function runIdsByRecency(root: string): string[] {
  return readdirSync(root)
    .map((id) => {
      try { return { id, mtime: statSync(join(root, id, 'run.json')).mtimeMs }; }
      catch { return null; }
    })
    .filter((x): x is { id: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.id);
}

function printResearchProgress(runDir: string): void {
  const journalPath = join(runDir, 'research_journal.json');
  if (!existsSync(journalPath)) return;
  let journal: { rounds?: { label?: string; result?: number; wallHoursCumulative?: number }[] };
  try { journal = JSON.parse(readFileSync(journalPath, 'utf-8')); } catch { return; }
  const rounds = Array.isArray(journal.rounds) ? journal.rounds : [];
  console.log('\n## Research progress');
  if (rounds.length === 0) {
    console.log('  (no rounds journaled yet — agent is working on the first direction)');
  } else {
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      const wall = typeof r.wallHoursCumulative === 'number' ? ` @ ${r.wallHoursCumulative.toFixed(1)}h` : '';
      console.log(`  ${i + 1}. ${r.label ?? '?'} = ${r.result ?? '?'}${wall}`);
    }
  }
  const decisionPath = join(runDir, 'research_decision.json');
  if (existsSync(decisionPath)) {
    try {
      const d = JSON.parse(readFileSync(decisionPath, 'utf-8'));
      console.log(`  → running-best ${d.runningBest} | kept: ${(d.keptLabels ?? []).join(', ') || 'none'} | decision: ${d.decision} (${d.reason})`);
    } catch { /* non-critical */ }
  }
}

interface StatusSelection {
  all: boolean;
  details: boolean;
  projectDir?: string;
}

interface StatusRun {
  id: string;
  directory: string;
  history?: RetiredStageUsage[];
  historyError?: string;
  state: {
    projectDir?: string;
    taskDescription?: string;
    status?: string;
    currentIteration?: number;
    maxIterations?: number;
    startedAt?: string;
    completedAt?: string;
    failureReason?: string;
    stages?: Record<string, { status?: string; duration_ms?: number; startedAt?: string; retries?: number; attempts?: unknown[] }>;
    terminalArtifact?: string;
    terminalStates?: Record<string, { paths?: string[] }>;
  };
}

function printStatusUsage() { console.log(commandUsage('status')); }

function parseStatusSelection(): StatusSelection | undefined {
  const parsed = parseCommandArgs('status', args);
  const all = parsed.flags.has('--all');
  const details = parsed.flags.has('--details');
  const project = parsed.values.get('--project');
  if (all && project !== undefined) {
    console.error('--all and --project cannot be used together.');
    printStatusUsage();
    process.exitCode = EXIT_CODE.failed;
    return undefined;
  }
  return all
    ? { all: true, details }
    : { all: false, details, projectDir: canonicalProjectPath(project ?? detectProjectDir()) };
}

function canonicalProjectPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync.native(absolute); } catch { return absolute; }
}

function latestStatusRun(root: string, runIds: string[], selection: StatusSelection): StatusRun | undefined {
  for (const id of runIds) {
    const directory = join(root, id);
    try {
      const state = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf-8')) as StatusRun['state'];
      const matchesProject = typeof state.projectDir === 'string'
        && canonicalProjectPath(state.projectDir) === selection.projectDir;
      if (selection.all || matchesProject) {
        try {
          const diagnostics: string[] = [];
          const history = projectRunStageHistory(readArchivedRunState('', id).state,
            diagnostic => diagnostics.push(`${diagnostic.code}: ${diagnostic.path}: ${diagnostic.detail}`));
          return { id, directory, state, history,
            ...(diagnostics.length ? { historyError: diagnostics.join('; ') } : {}) };
        } catch (error) {
          // Keep the previously readable active projection when an archived
          // prefix is absent or damaged; never silently hide the selected run.
          return { id, directory, state, historyError: error instanceof Error ? error.message : String(error) };
        }
      }
    } catch { /* malformed or concurrently removed run: try the next one */ }
  }
  return undefined;
}

function cmdStatus() {
  const selection = parseStatusSelection();
  if (!selection) return;
  const root = runsRoot();
  if (!existsSync(root)) {
    console.log(selection.all ? 'No runs found.' : `No runs found for project: ${selection.projectDir}`);
    return;
  }
  const runs = runIdsByRecency(root);
  const selected = latestStatusRun(root, runs, selection);
  if (!selected) {
    console.log(selection.all ? 'No runs found.' : `No runs found for project: ${selection.projectDir}`);
    return;
  }
  const { id, directory: runDir, state } = selected;
  const statusResolution = resolveRunStatus(state.status);
  const mismatch = terminalArtifactStatusMismatch(state, { runDir });
  const operational = readOperationalProjection(runDir, { state });
  console.log(`Run: ${id}`);
  console.log(`Goal: ${extractTaskTitle(state.taskDescription) || '(no description)'}`);
  console.log(`Status: ${statusResolution.kind === 'known' ? statusResolution.status : `unrecognized ${statusResolution.display}`}`);
  console.log(`Project: ${state.projectDir ?? 'unknown'}`);
  console.log(`Elapsed: ${formatHumanDuration(operational.runElapsedMs)}`);
  if (operational.activeStages.length === 0) console.log('Now: no stage executing');
  else for (const stage of operational.activeStages) {
    console.log(`Now: ${stage.id} · execution ${stage.execution} · ${formatHumanDuration(stage.elapsedMs)}`);
  }
  if (operational.latestReason) console.log(`Latest reason ${formatOperationalReason(operational.latestReason)}`);
  if (operational.lastRejection) console.log(`Latest rejection ${formatOperationalReason(operational.lastRejection)}`);
  if (operational.lastGuidance) console.log(`Latest guidance ${formatOperationalReason(operational.lastGuidance)}`);
  for (const pending of operational.pendingScope) console.log(`Pending scope: ${pending.requestId}${pending.stageId ? ` · ${pending.stageId}` : ''}`);
  if (operational.pendingApproval) console.log(`Pending approval: ${operational.pendingApproval.detail}`);
  for (const line of formatRunDriftProjection(operational.drift)) console.log(line);
  console.log(`Evidence: state ${operational.sourceCoverage.runState}; events ${operational.sourceCoverage.events}; ${operational.sourceCoverage.stageCount} stages`);
  if (mismatch) console.log(`Status mismatch: ${formatTerminalArtifactStatusMismatch(mismatch)}`);
  console.log(`Iteration: ${state.currentIteration ?? '?'}/${state.maxIterations ?? '?'}`);
  console.log('Stages:');
  for (const [id, ss] of Object.entries(state.stages ?? {})) {
    const dur = ss.duration_ms ? ` (${formatHumanDuration(ss.duration_ms)})` : '';
    const icon = ss.status === STAGE_STATUS.COMPLETE ? '✓' : ss.status === STAGE_STATUS.RUNNING ? '⟳' : ss.status === STAGE_STATUS.FAILED ? '✗' : '·';
    console.log(`  ${icon} ${id}: ${ss.status}${dur}`);
  }
  for (const { stageId, iteration, status } of selected.history ?? []) {
    const dur = status.duration_ms ? ` (${formatHumanDuration(status.duration_ms)})` : '';
    console.log(`  ${stageId} [iteration ${iteration}, archived]: ${status.status}${dur}`);
  }
  if (selected.historyError) console.log(`History unavailable: ${selected.historyError}`);
  if (selection.details) {
    const summaryPath = join(runDir, 'summary.md');
    if (existsSync(summaryPath)) console.log(`\n${readFileSync(summaryPath, 'utf-8').trimEnd()}`);
    printResearchProgress(runDir);
  }
}

function cmdList() {
  const limit = Number(parseCommandArgs('list', args).values.get('--limit'));
  const root = runsRoot();
  if (!existsSync(root)) { console.log('No runs found. Run `flowcrew quick "task"` first.'); return; }
  const runs = runIdsByRecency(root).slice(0, limit);
  if (runs.length === 0) { console.log('No runs found.'); return; }
  console.log(`\nRecent runs (${runs.length}):\n`);
  console.log('  Status     Duration  Run ID                          Task');
  console.log('  ' + '─'.repeat(75));
  for (const runId of runs) {
    try {
      const state = JSON.parse(readFileSync(join(root, runId, 'run.json'), 'utf-8'));
      const mismatch = terminalArtifactStatusMismatch(state, { runDir: join(root, runId) });
      const statusResolution = resolveRunStatus(state.status);
      const lifecycle = statusResolution.kind === 'unknown'
        ? `? unrecognized ${statusResolution.display}`
        : CLI_RUN_STATUS_PRESENTATION[statusResolution.status].listLabel;
      const status = mismatch ? `${lifecycle} [terminal artifact says ${mismatch.terminalStatus}]` : lifecycle;
      const startMs = new Date(state.startedAt).getTime();
      const endMs = state.completedAt ? new Date(state.completedAt).getTime() : Date.now();
      const duration = formatHumanDuration(endMs - startMs).padEnd(8);
      const taskDesc = (extractTaskTitle(state.taskDescription) || state.workflowName || '').slice(0, 40);
      console.log(`  ${status}  ${duration}  ${runId}  ${taskDesc}`);
    } catch { /* non-critical */ console.log(`  ? unknown   —         ${runId}`); }
  }
  console.log('');
}

interface GuideRunCandidate {
  id: string;
  title: string;
  status: string;
  stageIds: string[];
}

function printGuideUsage() { console.log(commandUsage('guide')); }

function guideArgumentError(message: string): never {
  console.error(message);
  console.error(commandUsage('guide'));
  process.exit(EXIT_CODE.failed);
}

function parseGuideArguments(): { message: string; targetRunId?: string; targetStageId?: string } {
  const parsed = parseCommandArgs(command!, args);
  return { message: parsed.positionals.join(' ').trim(), targetRunId: parsed.values.get('--run'), targetStageId: parsed.values.get('--stage') };
}

function safeGuideRunId(runId: string): boolean {
  return runId.length > 0
    && runId.length <= 255
    && runId !== '.'
    && runId !== '..'
    && !runId.includes('/')
    && !runId.includes('\\')
    && !runId.includes('\0');
}

function readGuideCandidate(root: string, runId: string): GuideRunCandidate | undefined {
  if (!safeGuideRunId(runId)) return undefined;
  try {
    const directory = join(root, runId);
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return undefined;
    const state = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf-8')) as {
      runId?: string;
      status?: string;
      taskDescription?: string;
      workflowName?: string;
      stages?: unknown;
    };
    if (state.runId !== undefined && state.runId !== runId) return undefined;
    return {
      id: runId,
      status: typeof state.status === 'string' ? state.status : '',
      title: extractTaskTitle(state.taskDescription) || state.workflowName || '(untitled task)',
      stageIds: state.stages && typeof state.stages === 'object' && !Array.isArray(state.stages)
        ? Object.keys(state.stages as Record<string, unknown>)
        : [],
    };
  } catch {
    return undefined;
  }
}

function cmdGuide() {
  const { message, targetRunId, targetStageId } = parseGuideArguments();
  if (!message) guideArgumentError('Guidance message must not be empty.');
  const root = runsRoot();
  if (!existsSync(root)) { console.error('No runs found.'); process.exit(EXIT_CODE.failed); }
  const runs = runIdsByRecency(root);
  if (runs.length === 0) { console.error('No runs found.'); process.exit(EXIT_CODE.failed); }

  let selected: GuideRunCandidate;
  if (targetRunId !== undefined) {
    if (!safeGuideRunId(targetRunId) || !runs.includes(targetRunId)) {
      console.error(`Run "${targetRunId}" was not found; guidance was not sent.`);
      process.exit(EXIT_CODE.failed);
    }
    const candidate = readGuideCandidate(root, targetRunId);
    if (!candidate) {
      console.error(`Run "${targetRunId}" is unreadable or unsafe; guidance was not sent.`);
      process.exit(EXIT_CODE.failed);
    }
    const statusResolution = resolveRunStatus(candidate.status);
    if (statusResolution.kind === 'unknown') {
      console.error(`Run "${targetRunId}" has unrecognized archived status ${statusResolution.display}; guidance was not sent.`);
      process.exit(EXIT_CODE.failed);
    }
    if (!isRunningRunStatus(candidate.status)) {
      console.error(`Run "${targetRunId}" is ${candidate.status || 'in an unknown state'}, not running; guidance was not sent.`);
      process.exit(EXIT_CODE.failed);
    }
    selected = candidate;
  } else {
    const running = runs
      .map((runId) => readGuideCandidate(root, runId))
      .filter((candidate): candidate is GuideRunCandidate => (
        candidate !== undefined && isRunningRunStatus(candidate.status)
      ));
    if (running.length === 0) {
      console.error('No running runs found; guidance was not sent.');
      process.exit(EXIT_CODE.failed);
    }
    if (running.length > 1) {
      console.error('Multiple runs are currently executing; guidance was not sent. Choose one explicitly:');
      for (const candidate of running) {
        console.error(`  flowcrew guide --run ${candidate.id} "message"  # ${candidate.title}`);
      }
      process.exit(EXIT_CODE.failed);
    }
    selected = running[0];
  }

  if (targetStageId !== undefined && !selected.stageIds.includes(targetStageId)) {
    console.error(`Stage "${targetStageId}" is not part of run "${selected.id}"; guidance was not sent.`);
    process.exit(EXIT_CODE.failed);
  }
  const target = targetStageId ?? RUN_WIDE_GUIDANCE_TARGET;
  const envelope = queueOperatorGuidance({
    runDir: join(root, selected.id),
    target,
    body: message,
    knownStageIds: selected.stageIds,
  });
  if (envelope.quarantined) {
    console.error(`Guidance ${envelope.id} quarantined: ${envelope.quarantineReason}; not queued for delivery.`);
    process.exit(EXIT_CODE.failed);
  }
  console.log(`Guidance ${envelope.id} queued for ${targetStageId ? 'stage ' + targetStageId : 'all stages'} in run ${selected.id}:`);
  console.log(`  "${message}"`);
  console.log('\nDelivery is not yet confirmed; a guidance_delivery_checked receipt will identify the consuming execution.');
}

function cmdInterrupt() {
  const { message: reason, targetRunId, targetStageId } = parseGuideArguments();
  if (!targetRunId || !targetStageId) {
    console.error('Both --run and --stage are required for a command interrupt.');
    console.error(commandUsage('interrupt'));
    process.exit(EXIT_CODE.failed);
  }
  const root = runsRoot();
  if (!safeGuideRunId(targetRunId)) {
    console.error(`Run "${targetRunId}" is unsafe; no command was interrupted.`);
    process.exit(EXIT_CODE.failed);
  }
  const candidate = readGuideCandidate(root, targetRunId);
  if (!candidate || !isRunningRunStatus(candidate.status)) {
    console.error(`Run "${targetRunId}" is not running; no command was interrupted.`);
    process.exit(EXIT_CODE.failed);
  }
  if (!candidate.stageIds.includes(targetStageId)) {
    console.error(`Stage "${targetStageId}" is not part of run "${targetRunId}"; no command was interrupted.`);
    process.exit(EXIT_CODE.failed);
  }
  try {
    const signal = requestStageCommandInterrupt({
      runDir: join(root, targetRunId),
      stageId: targetStageId,
      reason,
    });
    console.log(`Interrupt ${signal.requestId} sent to stage ${targetStageId} in run ${targetRunId}.`);
    console.log(`Command: ${signal.command}`);
    console.log('The engine will validate the interrupt and record its reason as operator guidance before stopping the command.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(EXIT_CODE.failed);
  }
}

function cmdExport() {
  const selected = parseCommandArgs('export', args).positionals[0];
  const root = runsRoot();
  if (!existsSync(root)) { console.error('No runs found.'); process.exit(EXIT_CODE.failed); }
  const runId = selected || readdirSync(root).sort().reverse()[0];
  if (!runId) { console.error('No runs found.'); process.exit(EXIT_CODE.failed); }
  const runDir = join(root, runId);
  if (!existsSync(runDir)) { console.error(`Run not found: ${runId}\nRun \`flowcrew list\` to see available runs.`); process.exit(EXIT_CODE.failed); }

  const bundle: Record<string, unknown> = { runId, exportedAt: new Date().toISOString() };
  // v2 run.json is intentionally a compact projection. Export the hydrated
  // state so acknowledged append-only history does not disappear from bundles.
  try { bundle.state = readRunState('', runId); } catch { /* non-critical */ }
  const stagesDir = join(runDir, 'stages');
  if (existsSync(stagesDir)) {
    const stages: Record<string, unknown> = {};
    for (const stageId of readdirSync(stagesDir)) {
      const sd = join(stagesDir, stageId);
      const stage: Record<string, unknown> = { id: stageId };
      try { stage.status = JSON.parse(readFileSync(join(sd, 'status.json'), 'utf-8')); } catch { /* non-critical */ }
      stage.input = readStageInput('', runId, stageId);
      try { stage.output = readFileSync(join(sd, 'output.md'), 'utf-8'); } catch { /* non-critical */ }
      stages[stageId] = stage;
    }
    bundle.stages = stages;
  }
  try { bundle.progress = readFileSync(join(runDir, 'summary.md'), 'utf-8'); } catch { /* non-critical */ }
  try { bundle.dispatch = readFileSync(join(runDir, 'dispatch.yaml'), 'utf-8'); } catch { /* non-critical */ }

  const outputPath = `flowcrew-export-${runId}.json`;
  writeFileSync(outputPath, JSON.stringify(bundle, null, 2), 'utf-8');
  console.log(`Exported run ${runId} to ${outputPath}`);
  const size = (JSON.stringify(bundle).length / 1024).toFixed(1);
  console.log(`  ${Object.keys((bundle.stages as object) || {}).length} stages, ${size}KB`);
}

function printUsage() { console.log(commandUsage()); }

// Main
try {
switch (command) {
  case 'init':
    parseCommandArgs('init', args);
    await cmdInit();
    break;
  case 'adapter':
    cmdAdapter();
    break;
  case 'quick':
    await cmdQuick();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'list':
    cmdList();
    break;
  case 'guide':
    cmdGuide();
    break;
  case 'interrupt':
    cmdInterrupt();
    break;
  case 'export':
    cmdExport();
    break;
  case 'campaign':
    console.error(`Unknown campaign subcommand: ${args[1] ?? ''}`);
    process.exitCode = EXIT_CODE.failed;
    break;
  case 'daemon':
    process.exitCode = await (await import('./cli-daemon.js')).cmdDaemon(args);
    break;
  case 'dashboard':
    process.exitCode = await (await import('./cli-dashboard.js')).cmdDashboard(args);
    break;
  case 'task':
    process.exitCode = await (await import('./cli-task.js')).cmdTask(args);
    break;
  case 'audit-reality':
    process.exitCode = await (await import('./reality-gate/audit-reality.js')).cmdAuditReality(args);
    break;
  case 'inbox':
    process.exitCode = await (await import('./cli-inbox.js')).cmdInbox(args);
    break;
  case 'ship-preflight':
    process.exitCode = await (await import('./cli-ship-preflight.js')).cmdShipPreflight(args);
    break;
  case 'ship-setup':
    process.exitCode = await (await import('./cli-ship-setup.js')).cmdShipSetup(args);
    break;
  case 'land':
    process.exitCode = await (await import('./cli-land.js')).cmdLand(args);
    break;
  case 'watch':
    process.exitCode = await (await import('./cli-watch.js')).cmdWatch(args);
    break;
  case 'events':
    process.exitCode = await (await import('./cli-events.js')).cmdEvents(args);
    break;
  case 'rehearse':
    await (await import('./rehearse.js')).cmdRehearse(args.slice(1));
    break;
  case 'doctor':
    parseCommandArgs('doctor', args);
    if (args.includes('--repair-registry') || args.includes('--compact-registry') || args.includes('--apply')) {
      process.exitCode = (await import('./cli-doctor.js')).cmdDoctorMaintenance(args);
    } else {
      await cmdDoctor();
    }
    break;
  case 'start':
    parseCommandArgs('start', args);
    await cmdStart();
    break;
  case 'version':
  case '--version':
  case '-v': {
    parseCommandArgs('version', ['version', ...args.slice(1)]);
    const pkgPath = join(import.meta.dirname ?? '.', '..', 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      console.log(`flowcrew ${pkg.version}`);
    } catch { /* expected - optional resource */
      console.log('flowcrew (version unknown)');
    }
    break;
  }
  case '--help':
  case '-h':
  case undefined:
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(EXIT_CODE.failed);
}
} catch (error) {
  console.error(error instanceof CliUsageError
    ? error.message[0].toUpperCase() + error.message.slice(1)
    : error instanceof Error ? error.message : String(error));
  process.exit((await import('./orchestrator-rpc.js')).rpcErrorExitCode(error));
}
}
