#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, lstatSync, statSync, renameSync as fsRenameSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parse as parseYaml, parseDocument } from 'yaml';
import {
  campaignDir,
  extractTaskTitle,
  isPausedRunStatus,
  isRunningRunStatus,
  isSuccessfulRunStatus,
  isTerminalRunStatus,
  RUN_STATUS,
  runsRoot,
  STAGE_STATUS,
} from './store.js';
import { campaignBaseDirectory, ensureProjectDefaultsFile, loadProjectDefaults } from './config.js';
import { loadCampaignConfig, runCampaign, stopCampaign } from './campaign.js';
import { diffVersions, readHead, rollback } from './brief-versioning.js';
import { consumePendingReview, readPendingReviews, ReviewConflictError, summarizePatch } from './campaign-review.js';
import { AVAILABLE_ADAPTER_NAMES, loadAdapterByName, normalizeAdapterName } from './adapters/loader.js';
import {
  ADAPTER_CLI,
  ADAPTER_INSTALL_HINT,
  findExecutableOnPath,
  installedAdapters,
  RECOMMENDED,
  resolveAdapterChoice,
  type AdapterName,
  type AdapterResolution,
} from './adapters/availability.js';
import { detectSupervisorBackend } from './cli-doctor.js';
import type { RegisterRpcResponse } from './orchestrator-rpc.js';
import type { TaskCreateInput } from './task-registry.js';
import type { BriefAdmissionRecord } from './brief-preflight.js';
import {
  isLiveFlowcrewSchedulerForRun,
  parseSchedulerPidMarker,
} from './run-lock.js';
import {
  formatTerminalArtifactStatusMismatch,
  terminalArtifactStatusMismatch,
} from './terminal-artifact-status.js';

const args = process.argv.slice(2);
const command = args[0];
const CAMPAIGN_PENDING_SUBCOMMAND = 'pending';

function encodeBriefAdmission(record: BriefAdmissionRecord): string {
  return Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
}

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

function readAdapterSetting(projectDir: string): AdapterSetting {
  const path = join(projectDir, 'config', 'defaults.yaml');
  if (!existsSync(path)) return { exists: false };
  try {
    const parsed = parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown> | null;
    const raw = parsed?.adapter;
    if (raw === undefined) return { exists: true };
    if (typeof raw !== 'string' || !raw.trim()) {
      return { exists: true, error: 'config/defaults.yaml adapter must be a non-empty string' };
    }
    return { exists: true, value: raw.trim() };
  } catch (error) {
    return {
      exists: true,
      error: `config/defaults.yaml YAML parsing failed: ${error instanceof Error ? error.message : String(error)}`,
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
      reason: `Selected mock from the ${explicit ? 'explicit --adapter choice' : 'project configuration'}; it is the deterministic in-process test adapter and needs no external CLI.`,
    };
  }
  return resolveAdapterChoice(opts, installed);
}

function writeAdapterSetting(projectDir: string, adapter: AdapterName | 'auto'): string {
  const path = ensureProjectDefaultsFile(projectDir);
  const document = parseDocument(readFileSync(path, 'utf-8'));
  if (document.errors.length > 0) {
    throw new Error(`Cannot update ${path}: ${document.errors[0].message}`);
  }
  document.set('adapter', adapter);
  writeFileSync(path, String(document), 'utf-8');
  return path;
}

async function registerBackgroundTask(task: TaskCreateInput): Promise<void> {
  const { defaultSocketPath, formatDaemonRegistration, sendRpc } = await import('./orchestrator-rpc.js');
  const socketPath = process.env.FLOWCREW_DAEMON_SOCKET ?? defaultSocketPath();
  const response = await sendRpc<RegisterRpcResponse>(socketPath, { cmd: 'register', task });
  console.log(formatDaemonRegistration(response));
}

async function chooseInitialAdapter(): Promise<AdapterName | 'auto'> {
  const installed = installedAdapters();
  if (installed.length === 0) {
    console.log('⚠️  No adapter CLI is installed; keeping adapter: auto.');
    console.log(`   Install Codex: ${ADAPTER_INSTALL_HINT.codex}`);
    console.log(`   Install Claude Code: ${ADAPTER_INSTALL_HINT.claude}`);
    console.log('   After installation, set an explicit choice with `flowcrew adapter codex` or `flowcrew adapter claude`.');
    return 'auto';
  }
  if (installed.length === 1) {
    console.log(`ℹ️  Selected ${installed[0]} because it is the only installed adapter CLI.`);
    return installed[0];
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`ℹ️  Both adapter CLIs are installed; non-interactive init selected recommended execution backend ${RECOMMENDED}.`);
    return RECOMMENDED;
  }

  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await input.question(`Choose adapter [${RECOMMENDED}/claude] (${RECOMMENDED}): `)).trim().toLowerCase();
      const selected = answer || RECOMMENDED;
      if (selected === 'codex' || selected === 'claude') return selected;
      console.log('Please enter `codex` or `claude`.');
    }
  } finally {
    input.close();
  }
}

async function cmdInit() {
  const projectDir = detectProjectDir();
  const configDir = join(projectDir, 'config');
  const agentsDir = join(configDir, 'agents');
  const workflowsDir = join(configDir, 'workflows');
  const skillsDir = join(configDir, 'skills');

  // Scaffold directories
  for (const dir of [configDir, agentsDir, workflowsDir, skillsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // Create defaults.yaml if missing
  const defaultsPath = join(configDir, 'defaults.yaml');
  if (!existsSync(defaultsPath)) {
    const adapter = await chooseInitialAdapter();
    ensureProjectDefaultsFile(projectDir);
    if (adapter !== 'auto') writeAdapterSetting(projectDir, adapter);
    console.log(`✅ Created ${defaultsPath} (adapter: ${adapter})`);
  } else {
    console.log(`⏭️  ${defaultsPath} already exists`);
  }

  // Create default workflow if missing
  const defaultWf = join(workflowsDir, 'default.yaml');
  if (!existsSync(defaultWf)) {
    writeFileSync(defaultWf, 'name: default\nstages:\n  - id: plan\n    role: planner\n    dynamic_dispatch: true\n', 'utf-8');
    console.log(`✅ Created ${defaultWf}`);
  } else {
    console.log(`⏭️  ${defaultWf} already exists`);
  }

  // Copy agent configs from flowcrew's own config if they don't exist
  const srcAgentsDir = join(import.meta.dirname ?? '.', '..', 'config', 'agents');
  if (existsSync(srcAgentsDir)) {
    try {
      for (const f of readdirSync(srcAgentsDir)) {
        const dest = join(agentsDir, f);
        if (!existsSync(dest)) {
          writeFileSync(dest, readFileSync(join(srcAgentsDir, f), 'utf-8'), 'utf-8');
          console.log(`✅ Created ${dest}`);
        }
      }
    } catch { /* best effort */ }
  }

  // Create global ~/.fc/runs/ directory (all runs stored centrally)
  const globalFcDir = runsRoot(projectDir);
  mkdirSync(globalFcDir, { recursive: true });
  console.log(`✅ Global runs directory: ${globalFcDir}`);

  // Create project-local .fc/runs symlink pointing to global dir (for backward compat)
  const localFcRuns = join(projectDir, '.fc', 'runs');
  const localFcDir = join(projectDir, '.fc');
  mkdirSync(localFcDir, { recursive: true });
  if (resolve(localFcRuns) !== resolve(globalFcDir)) {
    try {
      const stat = lstatSync(localFcRuns);
      if (!stat.isSymbolicLink()) {
        // Existing real directory — migrate contents to global, replace with symlink
        for (const f of readdirSync(localFcRuns)) {
          try { fsRenameSync(join(localFcRuns, f), join(globalFcDir, f)); } catch { /* skip conflicts */ }
        }
        rmSync(localFcRuns, { recursive: true, force: true });
        symlinkSync(globalFcDir, localFcRuns);
      }
    } catch { /* expected - optional resource */
      // No existing dir — create symlink
      try { symlinkSync(globalFcDir, localFcRuns); } catch { /* non-critical */ }
    }
  }

  // Add .fc/ to .gitignore if not already present
  const gitignorePath = join(projectDir, '.gitignore');
  try {
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
    if (!existing.split('\n').some(line => line.trim() === '.fc/' || line.trim() === '.fc')) {
      const entry = existing.endsWith('\n') || !existing ? '.fc/\n' : '\n.fc/\n';
      writeFileSync(gitignorePath, existing + entry, 'utf-8');
      console.log(`✅ Added .fc/ to ${gitignorePath}`);
    }
  } catch { /* best effort */ }

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
          ship: join(projectDir, '.claude', 'commands', 'ship.md'),
          'fc-status': join(projectDir, '.claude', 'commands', 'fc-status.md'),
        },
      },
      ...(home ? [{
        label: 'global' as const,
        files: {
          ship: join(home, '.claude', 'commands', 'ship.md'),
          'fc-status': join(home, '.claude', 'commands', 'fc-status.md'),
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
    sourceContent.set(name, readFileSync(sourceFiles[name], 'utf-8'));
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
      if (installedContent === expectedContent) {
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
  const projectDir = detectProjectDir();
  // Take the first positional argument, not args[1]: a leading flag such as the
  // documented --project would otherwise be read as the adapter name and rejected
  // with a usage error that says nothing about the real problem.
  const positional = args.slice(1).filter((a) => !a.startsWith('-'));
  const requested = positional[0]?.trim().toLowerCase();
  if (!requested) {
    const setting = readAdapterSetting(projectDir);
    const current = setting.error
      ? `invalid (${setting.error})`
      : setting.exists
        ? (setting.value ?? 'auto')
        : '(config/defaults.yaml is missing)';
    const installed = installedAdapters();
    console.log(`Current adapter: ${current}`);
    console.log(`Installed adapters: ${installed.length > 0 ? installed.join(', ') : 'none'}`);
    console.log(`Recommended adapter: ${RECOMMENDED}`);
    // Every other message in this surface ends in a command the reader can run;
    // these two states used to end in a statement of the problem alone.
    if (!setting.exists) console.log('Next: run `flowcrew init` to create it.');
    else if (setting.error) console.log('Next: fix the file by hand, or run `flowcrew adapter <auto|codex|claude>` to rewrite the adapter line.');
    else if (installed.length === 0) console.log(`Next: install an adapter CLI — ${ADAPTER_INSTALL_HINT[RECOMMENDED]}`);
    if (setting.error) process.exitCode = 1;
    return;
  }
  if (positional.length > 1 || (requested !== 'auto' && requested !== 'codex' && requested !== 'claude')) {
    console.error('Usage: flowcrew adapter [auto|codex|claude]');
    process.exitCode = 1;
    return;
  }
  if (requested !== 'auto' && !installedAdapters().includes(requested)) {
    console.error(`Cannot select ${requested}: its CLI is not installed or visible on PATH.`);
    console.error(`Install it first: ${ADAPTER_INSTALL_HINT[requested]}`);
    process.exitCode = 1;
    return;
  }
  const path = writeAdapterSetting(projectDir, requested);
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
  const setting = readAdapterSetting(projectDir);
  if (!setting.exists) {
    checks.push({ name: 'config/defaults.yaml', status: 'fail', message: 'Missing. Run `flowcrew init` to create it.' });
  } else if (setting.error) {
    checks.push({ name: 'config/defaults.yaml', status: 'fail', message: `${setting.error}. Run \`flowcrew init\` to regenerate it.` });
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
  const agentsDir = join(projectDir, 'config', 'agents');
  if (existsSync(agentsDir)) {
    const agents = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
    checks.push({ name: 'Agent configs', status: agents.length > 0 ? 'ok' : 'warn', message: `${agents.length} agents found` });
    const requiredAgents = ['planner'];
    for (const name of requiredAgents) {
      if (!agents.includes(`${name}.yaml`)) {
        checks.push({ name: `Agent: ${name}`, status: 'warn', message: `config/agents/${name}.yaml missing. Run \`flowcrew init\` to create it.` });
      }
    }
    // Check for _base.md (shared prompt prepended to all agents)
    const baseMdPath = join(agentsDir, '_base.md');
    if (existsSync(baseMdPath)) {
      const size = readFileSync(baseMdPath, 'utf-8').trim().length;
      checks.push({ name: 'Base prompt (_base.md)', status: size > 0 ? 'ok' : 'warn', message: size > 0 ? `${size} chars` : 'empty — agents will run without shared guidelines' });
    } else {
      checks.push({ name: 'Base prompt (_base.md)', status: 'warn', message: 'missing — agents will run without shared guidelines. Run `flowcrew init` to create it.' });
    }
  } else {
    checks.push({ name: 'Agent configs', status: 'fail', message: 'config/agents/ missing. Run `flowcrew init`.' });
  }

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
    process.exit(1);
  } else if (hasWarning) {
    console.log('Some checks need attention before a live run. Review the warnings above.');
  } else {
    console.log('All checks passed! 🎉');
  }
}

async function cmdStart() {
  const projectDir = detectProjectDir();
  const port = parseInt(process.env.PORT || '3000', 10);
  const setting = readAdapterSetting(projectDir);
  if (setting.error) throw new Error(setting.error);
  const resolution = resolveRuntimeAdapter({ configured: setting.value ?? 'auto' });
  if (!resolution.ok) {
    console.error(`❌ ${resolution.hint}`);
    process.exitCode = 1;
    return;
  }
  const adapterInstance = await loadAdapterByName(resolution.adapter);
  console.log(`Adapter: ${resolution.adapter} — ${resolution.reason}`);

  const net = await import('node:net');
  const portAvailable = await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
  if (!portAvailable) {
    console.error(`❌ Port ${port} is already in use. Either stop the other process or use a different port:`);
    console.error(`   PORT=${port + 1} flowcrew start`);
    process.exit(1);
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

  const { startDashboard } = await import('./dashboard.js');
  await startDashboard(projectDir, port, { adapter: adapterInstance });
}

async function cmdQuick() {
  let projectDir = detectProjectDir();
  let task = '';
  let adapter = '';
  let workflow = 'default';
  let workflowExplicit = false; // true once the user passes --workflow, so we don't override their choice
  let maxIterations: number | undefined;
  let timeout: number | undefined;
  let supervise = true; // supervisor brain on by default; opt out with --no-supervise
  let campaignArg: string | undefined; // --campaign <name> wins over defaults.yaml; --no-campaign forces undefined
  let campaignDisabled = false;
  let inheritCampaignContext = true; // Context is independent from campaign ownership; legacy alias maps to skip.
  let existingRunId: string | undefined; // dashboard rerun/execute path passes this to spawn a detached scheduler
  let background = false;
  let acknowledgementPresent = false;
  let acknowledgementDigest: string | undefined;
  let transportedAdmission: BriefAdmissionRecord | undefined;
  let storedAdmission: BriefAdmissionRecord | undefined;
  let taskSupplied = false;
  const launchArgs: string[] = [];
  const taskParts: string[] = [];

  if (args.includes('--help') || args.includes('-h')) { args.length = 0; } // trigger usage

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) { projectDir = resolve(args[++i]); continue; }
    if (args[i] === '--adapter' && args[i + 1]) { adapter = args[++i]; launchArgs.push('--adapter', adapter); continue; }
    if (args[i] === '--workflow' && args[i + 1]) { workflow = args[++i]; workflowExplicit = true; launchArgs.push('--workflow', workflow); continue; }
    if (args[i] === '--max-iterations' && args[i + 1]) { maxIterations = parseInt(args[++i], 10); launchArgs.push('--max-iterations', String(maxIterations)); continue; }
    if (args[i] === '--timeout' && args[i + 1]) { timeout = parseInt(args[++i], 10); launchArgs.push('--timeout', String(timeout)); continue; }
    if (args[i] === '--supervise') { supervise = true; launchArgs.push('--supervise'); continue; }
    if (args[i] === '--no-supervise') { supervise = false; launchArgs.push('--no-supervise'); continue; }
    if (args[i] === '--campaign' && args[i + 1]) { campaignArg = args[++i]; launchArgs.push('--campaign', campaignArg); continue; }
    if (args[i] === '--no-campaign') { campaignDisabled = true; launchArgs.push('--no-campaign'); continue; }
    if (args[i].startsWith('--campaign-context=')) {
      const mode = args[i].slice('--campaign-context='.length);
      if (mode !== 'inherit' && mode !== 'skip') {
        throw new Error(`Invalid --campaign-context value "${mode}"; expected inherit or skip.`);
      }
      inheritCampaignContext = mode === 'inherit';
      launchArgs.push(args[i]);
      continue;
    }
    if (args[i] === '--campaign-context') {
      throw new Error('Invalid --campaign-context syntax; use --campaign-context=inherit or --campaign-context=skip.');
    }
    if (args[i] === '--no-inherit-campaign') { inheritCampaignContext = false; launchArgs.push('--no-inherit-campaign'); continue; }
    if (args[i] === '--task' && args[i + 1]) { task = args[++i]; taskSupplied = true; continue; }
    if (args[i] === '--brief-input-base64' && args[i + 1]) {
      try {
        task = Buffer.from(args[++i], 'base64url').toString('utf8');
        taskSupplied = true;
      } catch {
        throw new Error('Invalid internal brief input');
      }
      continue;
    }
    if (args[i] === '--existing-run-id' && args[i + 1]) { existingRunId = args[++i]; continue; }
    if (args[i] === '--background') { background = true; continue; }
    if (args[i] === '--acknowledge-brief-warnings') { acknowledgementPresent = true; continue; }
    if (args[i].startsWith('--acknowledge-brief-warnings=')) {
      acknowledgementPresent = true;
      acknowledgementDigest = args[i].slice('--acknowledge-brief-warnings='.length);
      continue;
    }
    if (args[i] === '--brief-admission-record' && args[i + 1]) {
      transportedAdmission = decodeBriefAdmission(args[++i]);
      continue;
    }
    if (args[i] === '-') { task = readFileSync(0, 'utf-8'); taskSupplied = true; continue; }
    taskParts.push(args[i]);
  }
  if (!task && taskParts.length > 0) {
    task = taskParts.join(' ');
    taskSupplied = true;
  }

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
    console.error('Usage: flowcrew quick "task description" [options]');
    console.error('');
    console.error('Options:');
    console.error('  --adapter auto|codex|claude|mock  Agent backend (defaults to config/defaults.yaml)');
    console.error('  --workflow <name>       Workflow to use (default: default)');
    console.error('  --max-iterations <n>    Override config/defaults.yaml for this run');
    console.error('  --timeout <ms>          Override config/defaults.yaml for this run');
    console.error('  --supervise             Enable supervisor brain (default: ON)');
    console.error('  --no-supervise          Disable supervisor brain (opt-out)');
    console.error('  --campaign <name>       Attach run to campaign (default: defaults.yaml::campaign or slug of the main worktree)');
    console.error('  --no-campaign           Run un-attached to any campaign (opt-out)');
    console.error('  --campaign-context=inherit|skip  Planner history context; skip preserves campaign ownership (default: inherit)');
    console.error('  --project <path>        Project directory (default: cwd)');
    console.error('  --task "text"           Task description as flag');
    console.error('  --background            Register and launch under the flowcrew daemon');
    console.error('  --acknowledge-brief-warnings[=<digest>]  Continue after reviewing consequential findings (never skips inspection)');
    console.error('  -                       Read task from stdin');
    console.error('  --existing-run-id <id>  Resume an existing run (reads task from <run_dir>/task_brief.md)');
    process.exit(1);
  }

  const {
    createBriefAdmission,
    formatBriefPreflightReport,
    inspectBrief,
    verifyBriefAdmission,
  } = await import('./brief-preflight.js');
  const { projectBriefPreflightContext } = await import('./rehearse.js');
  const preflightContext = projectBriefPreflightContext(projectDir, task);
  const preflight = inspectBrief(task, preflightContext);
  console.log(`${formatBriefPreflightReport(preflight)}\n`);

  if (acknowledgementDigest !== undefined && acknowledgementDigest !== preflight.digest) {
    console.error(`Brief acknowledgement digest mismatch: received ${acknowledgementDigest || '(empty)'}, current digest is ${preflight.digest}.`);
    console.error(`Review the report and rerun with --acknowledge-brief-warnings=${preflight.digest}`);
    process.exit(2);
  }

  const transportedExistingRun = Boolean(existingRunId && taskSupplied && transportedAdmission);
  const transportedVerification = transportedAdmission
    ? verifyBriefAdmission(task, transportedAdmission, preflightContext)
    : undefined;
  const storedVerification = storedAdmission
    ? verifyBriefAdmission(task, storedAdmission, preflightContext)
    : undefined;
  const transportedContinuationIsBound = transportedExistingRun
    && transportedVerification?.status === 'valid'
    && storedVerification?.status === 'valid'
    && transportedAdmission!.digest === storedAdmission!.digest;
  // A first launch of a daemon-registered task always arrives with BOTH a
  // pre-allocated --existing-run-id and a transported record, but the reserved run
  // has no run.json yet — so storedAdmission is ABSENT, not conflicting. Requiring
  // a stored record here threw away a valid transported admission and paused every
  // backgrounded brief that needed acknowledgement, with exit 2 asking for a flag
  // the orchestrator deliberately strips. An absent stored record is not evidence
  // of a mismatch; a PRESENT one that disagrees still is, and keeps failing closed
  // — that is the TOCTOU guard, and it must survive this.
  const priorAdmission = transportedExistingRun
    ? (transportedContinuationIsBound
        ? transportedAdmission
        : (storedAdmission ?? (transportedVerification?.status === 'valid' ? transportedAdmission : undefined)))
    : (transportedAdmission ?? storedAdmission);
  const priorVerification = priorAdmission
    ? verifyBriefAdmission(task, priorAdmission, preflightContext)
    : undefined;
  let briefAdmission: BriefAdmissionRecord;
  if (priorVerification?.status === 'valid') {
    briefAdmission = priorAdmission!;
  } else {
    const continuationNeedsFreshDecision = Boolean(existingRunId || transportedAdmission);
    if ((preflight.requiresAcknowledgement || continuationNeedsFreshDecision) && !acknowledgementPresent) {
      const reason = priorVerification
        ? ` Stored admission status: ${priorVerification.status}.`
        : '';
      console.error(`Launch paused before run creation.${reason}`);
      console.error('Review the complete report above, then explicitly continue this exact brief with:');
      console.error(`  --acknowledge-brief-warnings=${preflight.digest}`);
      console.error('For deterministic CI/cron policy, the bare --acknowledge-brief-warnings flag accepts the current inspected input without prompting.');
      process.exit(2);
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

  // Auto-select the research workflow only after the shared report is visible.
  // The canonical frontmatter parser owns this decision; quick has no YAML regex.
  const { parseBriefFrontmatter } = await import('./scheduler.js');
  if (!workflowExplicit && workflow === 'default' && parseBriefFrontmatter(task).research) {
    workflow = 'research';
    launchArgs.push('--workflow', 'research');
    console.error('Note: brief has a `research:` block -> auto-selected --workflow research (pass --workflow to override).');
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
      configured: loadProjectDefaults(projectDir).adapter,
    });
    if (!backgroundResolution.ok) {
      console.error(`❌ ${backgroundResolution.hint}`);
      process.exitCode = 1;
      return;
    }
    try {
      await registerBackgroundTask({
        kind: 'quick',
        name: extractTaskTitle(task) || 'Quick task',
        brief_text: task,
        brief_admission: briefAdmission,
        projectDir,
        launch_args: launchArgs,
      });
      return;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      const { rpcErrorExitCode } = await import('./orchestrator-rpc.js');
      process.exit(rpcErrorExitCode(err));
    }
  }

  const configuredAdapter = loadProjectDefaults(projectDir).adapter;
  const adapterResolution = resolveRuntimeAdapter({
    explicit: adapter || undefined,
    configured: configuredAdapter,
  });
  if (!adapterResolution.ok) {
    console.error(`❌ ${adapterResolution.hint}`);
    process.exitCode = 1;
    return;
  }
  adapter = adapterResolution.adapter;
  console.log(`Adapter resolution: ${adapter} — ${adapterResolution.reason}`);
  adapter = normalizeAdapterName(adapter);

  const configRoot = join(import.meta.dirname ?? '.', '..', 'config', 'workflows');
  const localRoot = join(projectDir, 'config', 'workflows');
  let workflowPath = join(localRoot, `${workflow}.yaml`);
  if (!existsSync(workflowPath)) workflowPath = join(configRoot, `${workflow}.yaml`);
  if (!existsSync(workflowPath)) {
    console.error(`Workflow not found: ${workflow}.yaml`);
    const available = existsSync(localRoot) ? readdirSync(localRoot).filter(f => f.endsWith('.yaml')).map(f => f.replace('.yaml', '')) : [];
    if (available.length > 0) console.error(`  Available: ${available.join(', ')}`);
    else console.error(`  Run \`flowcrew init\` first.`);
    process.exit(1);
  }

  const { loadWorkflow, runWorkflow } = await import('./scheduler.js');
  const { config, raw } = loadWorkflow(workflowPath);
  if (maxIterations) config.defaults.max_iterations = maxIterations;
  if (timeout) config.defaults.timeout_ms = timeout;

  const agentsDir = join(projectDir, 'config', 'agents');
  const fallbackAgentsDir = join(import.meta.dirname ?? '.', '..', 'config', 'agents');
  const resolvedAgentsDir = existsSync(agentsDir) ? agentsDir : fallbackAgentsDir;
  const agents = new Map<string, unknown>();

  const adapterInstance = await loadAdapterByName(adapter);

  // Only write docs/task_brief.md on a fresh ship. For --existing-run-id path
  // the brief already lives in <run_dir>/task_brief.md; rewriting docs/ would
  // also stomp a sibling project's brief if multiple are reusing the same docs.
  if (!existingRunId) {
    const docsDir = join(projectDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    const taskBriefPath = join(docsDir, 'task_brief.md');
    if (existsSync(taskBriefPath) && readFileSync(taskBriefPath, 'utf-8') !== task) {
      console.warn(`⚠️  Overwriting existing brief with different content: ${taskBriefPath}`);
    }
    writeFileSync(taskBriefPath, task, 'utf-8');
  }

  console.log(`FlowCrew: shipping task with workflow "${config.name}"...`);
  console.log(`Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);
  console.log(`Project: ${projectDir}`);
  console.log(`Adapter: ${adapter}`);
  const projectDefaults = loadProjectDefaults(projectDir);
  console.log(`Max iterations: ${config.defaults.max_iterations ?? projectDefaults.max_iterations}`);
  console.log(`Stage timeout: ${config.defaults.timeout_ms ?? projectDefaults.timeout_ms}ms`);
  console.log(`Supervisor: ${supervise ? 'enabled' : 'disabled'}`);
  // Resolve campaign id: explicit --campaign > defaults.yaml::campaign > slug(basename(campaignBaseDirectory)).
  // --no-campaign forces undefined (run stays untagged).
  const campaignFromDefaults = projectDefaults.campaign;
  const campaignBaseDir = campaignBaseDirectory(projectDir);
  const campaignBaseSlug = (campaignBaseDir.split(/[\\/]/).filter(Boolean).pop() ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const resolvedCampaign = campaignDisabled
    ? undefined
    : (campaignArg || campaignFromDefaults || campaignBaseSlug || undefined);
  console.log(`Campaign: ${resolvedCampaign ?? '(none — --no-campaign)'}`);
  if (!campaignDisabled && !campaignArg && !campaignFromDefaults && campaignBaseDir !== projectDir) {
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

  const finalState = await runWorkflow(config, raw, projectDir, adapterInstance as any, agents as any, undefined, resolvedAgentsDir, existingRunId, task, true, supervise, resolvedCampaign, inheritCampaignContext, briefAdmission);
  clearInterval(progressTimer);

  // Desktop notification
  try {
    const title = finalState.status === RUN_STATUS.COMPLETE ? 'FlowCrew: Task Complete'
      : isPausedRunStatus(finalState.status) ? 'FlowCrew: Awaiting Your Approval'
      : isSuccessfulRunStatus(finalState.status) ? `FlowCrew: ${finalState.status}`
      : 'FlowCrew: Task Failed';
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
  process.exitCode = (succeeded || parked) ? 0 : 1;
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
  projectDir?: string;
}

interface StatusRun {
  id: string;
  directory: string;
  state: {
    projectDir?: string;
    taskDescription?: string;
    status?: string;
    currentIteration?: number;
    maxIterations?: number;
    stages?: Record<string, { status?: string; duration_ms?: number }>;
    terminalArtifact?: string;
    terminalStates?: Record<string, { paths?: string[] }>;
  };
}

function printStatusUsage(): void {
  console.log('Usage: flowcrew status [--all | --project <path>]');
  console.log('');
  console.log('Shows the latest run for the current project by default.');
  console.log('  --all              Show the latest run across all projects');
  console.log('  --project <path>   Show the latest run for another project');
}

function parseStatusSelection(): StatusSelection | undefined {
  let all = false;
  let project: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const value = args[index];
    if (value === '--help' || value === '-h') {
      printStatusUsage();
      return undefined;
    }
    if (value === '--all') {
      all = true;
      continue;
    }
    if (value === '--project') {
      const selected = args[index + 1];
      if (!selected || selected.startsWith('--')) {
        console.error('--project requires a path.');
        printStatusUsage();
        process.exitCode = 1;
        return undefined;
      }
      project = selected;
      index++;
      continue;
    }
    if (value.startsWith('--project=')) {
      project = value.slice('--project='.length);
      if (!project) {
        console.error('--project requires a path.');
        printStatusUsage();
        process.exitCode = 1;
        return undefined;
      }
      continue;
    }
    console.error(`Unknown status option: ${value}`);
    printStatusUsage();
    process.exitCode = 1;
    return undefined;
  }
  if (all && project !== undefined) {
    console.error('--all and --project cannot be used together.');
    printStatusUsage();
    process.exitCode = 1;
    return undefined;
  }
  return all
    ? { all: true }
    : { all: false, projectDir: canonicalProjectPath(project ?? detectProjectDir()) };
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
      if (selection.all || matchesProject) return { id, directory, state };
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
  const mismatch = terminalArtifactStatusMismatch(state);
  if (mismatch) console.log(`Status mismatch: ${formatTerminalArtifactStatusMismatch(mismatch)}`);

  // Show summary.md if generated (best overview of what was done)
  const summaryPath = join(runDir, 'summary.md');
  if (existsSync(summaryPath)) { console.log(readFileSync(summaryPath, 'utf-8')); printResearchProgress(runDir); return; }

  // Show progress.md if supervisor generated one
  const progressPath = join(runDir, 'progress.md');
  if (!isTerminalRunStatus(state.status ?? '') && existsSync(progressPath)) {
    console.log(readFileSync(progressPath, 'utf-8'));
    printResearchProgress(runDir);
    return;
  }

  // Fallback: show run.json summary
  console.log(`# Run: ${id}\n`);
  console.log(`Goal: ${extractTaskTitle(state.taskDescription) || '(no description)'}`);
  console.log(`Status: ${state.status}`);
  console.log(`Iteration: ${state.currentIteration ?? '?'}/${state.maxIterations ?? '?'}\n`);
  console.log('## Stages');
  for (const [id, ss] of Object.entries(state.stages ?? {})) {
    const dur = ss.duration_ms ? ` (${(ss.duration_ms / 1000).toFixed(0)}s)` : '';
    const icon = ss.status === STAGE_STATUS.COMPLETE ? '✓' : ss.status === STAGE_STATUS.RUNNING ? '⟳' : ss.status === STAGE_STATUS.FAILED ? '✗' : '·';
    console.log(`  ${icon} ${id}: ${ss.status}${dur}`);
  }
  printResearchProgress(runDir);
}

function cmdList() {

  const root = runsRoot();
  if (!existsSync(root)) { console.log('No runs found. Run `flowcrew quick "task"` first.'); return; }
  const limitArg = args.find((a, i) => args[i - 1] === '--limit');
  const limit = limitArg ? parseInt(limitArg, 10) : 10;
  const runs = runIdsByRecency(root).slice(0, limit);
  if (runs.length === 0) { console.log('No runs found.'); return; }
  console.log(`\nRecent runs (${runs.length}):\n`);
  console.log('  Status     Duration  Run ID                          Task');
  console.log('  ' + '─'.repeat(75));
  for (const runId of runs) {
    try {
      const state = JSON.parse(readFileSync(join(root, runId, 'run.json'), 'utf-8'));
      const mismatch = terminalArtifactStatusMismatch(state);
      const lifecycle = state.status === RUN_STATUS.COMPLETE ? '✓ complete' : state.status === RUN_STATUS.FAILED ? '✗ failed  ' : state.status === RUN_STATUS.RUNNING ? '⟳ running ' : '· ' + state.status.padEnd(8);
      const status = mismatch ? `${lifecycle} [terminal artifact says ${mismatch.terminalStatus}]` : lifecycle;
      const startMs = new Date(state.startedAt).getTime();
      const endMs = state.completedAt ? new Date(state.completedAt).getTime() : Date.now();
      const duration = `${Math.round((endMs - startMs) / 1000)}s`.padEnd(8);
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
}

function printGuideUsage(): void {
  console.log('Usage: flowcrew guide [--run <run-id>] "your guidance message"');
  console.log('');
  console.log('Omit --run only when exactly one run is currently executing.');
}

function guideArgumentError(message: string): never {
  console.error(message);
  console.error('Usage: flowcrew guide [--run <run-id>] "your guidance message"');
  process.exit(1);
}

function parseGuideArguments(): { message: string; targetRunId?: string } {
  const messageParts: string[] = [];
  let targetRunId: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const value = args[index];
    if (value === '--run') {
      const selected = args[index + 1];
      if (!selected || selected.startsWith('--')) guideArgumentError('--run requires a run id.');
      if (targetRunId !== undefined) guideArgumentError('--run may be specified only once.');
      targetRunId = selected;
      index++;
      continue;
    }
    if (value.startsWith('--run=')) {
      const selected = value.slice('--run='.length);
      if (!selected) guideArgumentError('--run requires a run id.');
      if (targetRunId !== undefined) guideArgumentError('--run may be specified only once.');
      targetRunId = selected;
      continue;
    }
    messageParts.push(value);
  }
  const message = messageParts.join(' ').trim();
  if (!message) guideArgumentError('Guidance message must not be empty.');
  return { message, targetRunId };
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
    };
    if (state.runId !== undefined && state.runId !== runId) return undefined;
    return {
      id: runId,
      status: typeof state.status === 'string' ? state.status : '',
      title: extractTaskTitle(state.taskDescription) || state.workflowName || '(untitled task)',
    };
  } catch {
    return undefined;
  }
}

function cmdGuide() {
  if (args.includes('--help') || args.includes('-h')) {
    printGuideUsage();
    return;
  }
  const { message, targetRunId } = parseGuideArguments();
  const root = runsRoot();
  if (!existsSync(root)) { console.error('No runs found.'); process.exit(1); }
  const runs = runIdsByRecency(root);
  if (runs.length === 0) { console.error('No runs found.'); process.exit(1); }

  let selected: GuideRunCandidate;
  if (targetRunId !== undefined) {
    if (!safeGuideRunId(targetRunId) || !runs.includes(targetRunId)) {
      console.error(`Run "${targetRunId}" was not found; guidance was not sent.`);
      process.exit(1);
    }
    const candidate = readGuideCandidate(root, targetRunId);
    if (!candidate) {
      console.error(`Run "${targetRunId}" is unreadable or unsafe; guidance was not sent.`);
      process.exit(1);
    }
    if (!isRunningRunStatus(candidate.status)) {
      console.error(`Run "${targetRunId}" is ${candidate.status || 'in an unknown state'}, not running; guidance was not sent.`);
      process.exit(1);
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
      process.exit(1);
    }
    if (running.length > 1) {
      console.error('Multiple runs are currently executing; guidance was not sent. Choose one explicitly:');
      for (const candidate of running) {
        console.error(`  flowcrew guide --run ${candidate.id} "message"  # ${candidate.title}`);
      }
      process.exit(1);
    }
    selected = running[0];
  }

  writeFileSync(join(root, selected.id, 'user_input.md'), message, 'utf-8');
  console.log(`Guidance sent to run ${selected.id}:`);
  console.log(`  "${message}"`);
  console.log(`\nThe supervisor will pick this up on its next tick (within 15s).`);
}

function cmdClean() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: flowcrew clean [--keep N]');
    console.log('');
    console.log('Deletes oldest runs, keeping N most recent runs (default: 5).');
    return;
  }
  const root = runsRoot();
  if (!existsSync(root)) { console.log('Nothing to clean.'); return; }
  const keepArg = args.find((a, i) => args[i - 1] === '--keep');
  const keep = keepArg ? parseInt(keepArg, 10) : 5;
  const runs = readdirSync(root).sort().reverse();
  const toDelete = runs.slice(keep);
  if (toDelete.length === 0) { console.log(`Nothing to clean (${runs.length} runs, keeping ${keep}).`); return; }
  let skippedLive = 0;
  let cleaned = 0;
  for (const runId of toDelete) {
    try {
      const runPath = join(root, runId);
      const pid = parseSchedulerPidMarker(readFileSync(join(runPath, 'scheduler.pid'), 'utf-8'));
      if (pid !== null && isLiveFlowcrewSchedulerForRun(pid, runId, runPath)) {
        skippedLive += 1;
        continue;
      }
    } catch { /* no validated live scheduler; historical run is cleanable */ }
    try {
      rmSync(join(root, runId), { recursive: true, force: true });
      cleaned += 1;
    } catch { /* non-critical */ }
  }
  console.log(`Cleaned ${cleaned} old runs (kept ${keep} most recent).`);
  if (skippedLive > 0) console.log(`Skipped ${skippedLive} live run(s); stop them before cleaning their history.`);
}

function cmdExport() {

  const root = runsRoot();
  if (!existsSync(root)) { console.error('No runs found.'); process.exit(1); }
  const runId = args[1] || readdirSync(root).sort().reverse()[0];
  if (!runId) { console.error('No runs found.'); process.exit(1); }
  const runDir = join(root, runId);
  if (!existsSync(runDir)) { console.error(`Run not found: ${runId}\nRun \`flowcrew list\` to see available runs.`); process.exit(1); }

  const bundle: Record<string, unknown> = { runId, exportedAt: new Date().toISOString() };
  try { bundle.state = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8')); } catch { /* non-critical */ }
  const stagesDir = join(runDir, 'stages');
  if (existsSync(stagesDir)) {
    const stages: Record<string, unknown> = {};
    for (const stageId of readdirSync(stagesDir)) {
      const sd = join(stagesDir, stageId);
      const stage: Record<string, unknown> = { id: stageId };
      try { stage.status = JSON.parse(readFileSync(join(sd, 'status.json'), 'utf-8')); } catch { /* non-critical */ }
      try { stage.input = readFileSync(join(sd, 'input.md'), 'utf-8'); } catch { /* non-critical */ }
      try { stage.output = readFileSync(join(sd, 'output.md'), 'utf-8'); } catch { /* non-critical */ }
      stages[stageId] = stage;
    }
    bundle.stages = stages;
  }
  try { bundle.knowledgeGraph = JSON.parse(readFileSync(join(runDir, 'knowledge_graph.json'), 'utf-8')); } catch { /* non-critical */ }
  try { bundle.supervisorLog = readFileSync(join(runDir, 'supervisor_log.md'), 'utf-8'); } catch { /* non-critical */ }
  try { bundle.progress = readFileSync(join(runDir, 'progress.md'), 'utf-8'); } catch { /* non-critical */ }
  try { bundle.dispatch = readFileSync(join(runDir, 'dispatch.yaml'), 'utf-8'); } catch { /* non-critical */ }

  const outputPath = `flowcrew-export-${runId}.json`;
  writeFileSync(outputPath, JSON.stringify(bundle, null, 2), 'utf-8');
  console.log(`Exported run ${runId} to ${outputPath}`);
  const size = (JSON.stringify(bundle).length / 1024).toFixed(1);
  console.log(`  ${Object.keys((bundle.stages as object) || {}).length} stages, ${size}KB`);
}

async function cmdCampaign() {
  const subcommand = args[1];
  if (subcommand === CAMPAIGN_PENDING_SUBCOMMAND) {
    const id = args[2];
    if (!id || args.includes('--help') || args.includes('-h')) {
      console.log('Usage: flowcrew campaign pending <campaign_id>');
      return;
    }
    const entries = readPendingReviews(id);
    console.log(`Pending review: ${entries.length}`);
    entries.forEach((entry, index) => {
      console.log(`${index}: [${entry.severity ?? 'medium'}] ${entry.reason}`);
      console.log(`   ${summarizePatch(entry.patch)}`);
    });
    return;
  }

  if (subcommand === 'review') {
    const id = args[2];
    if (!id || args.includes('--help') || args.includes('-h')) {
      console.log('Usage: flowcrew campaign review <campaign_id>');
      console.log('Interactively accept, reject, skip, or quit pending brief patches.');
      return;
    }
    const scriptedAnswers = process.stdin.isTTY ? null : readFileSync(0, 'utf-8').split(/\r?\n/);
    const rl = scriptedAnswers ? null : createInterface({ input: process.stdin, output: process.stdout });
    try {
      let index = 0;
      let answerIndex = 0;
      while (true) {
        const entries = readPendingReviews(id);
        if (index >= entries.length) {
          console.log('No more pending reviews.');
          break;
        }
        const entry = entries[index];
        console.log(`${index}: [${entry.severity ?? 'medium'}] ${entry.reason}`);
        console.log(`   ${summarizePatch(entry.patch)}`);
        const answer = (scriptedAnswers
          ? (scriptedAnswers[answerIndex++] ?? 'q')
          : await rl!.question('[a]ccept | [r]eject | [s]kip | [q]uit: ')).trim().toLowerCase();
        if (answer === 'q' || answer === 'quit') break;
        if (answer === 's' || answer === 'skip' || answer === '') {
          index++;
          continue;
        }
        if (answer === 'a' || answer === 'accept' || answer === 'r' || answer === 'reject') {
          const decision = answer.startsWith('a') ? 'accept' : 'reject';
          try {
            const result = await consumePendingReview(id, index, decision);
            console.log(`${decision === 'accept' ? 'Accepted' : 'Rejected'} review ${index}${result.version ? ` -> ${result.version}` : ''}`);
          } catch (err) {
            if (err instanceof ReviewConflictError) console.error(err.message);
            else throw err;
          }
          continue;
        }
        console.log('Unrecognized choice.');
      }
    } finally {
      rl?.close();
    }
    return;
  }

  if (subcommand === 'run') {
    const configPath = args[2];
    if (!configPath || args.includes('--help') || args.includes('-h')) {
      console.error('Usage: flowcrew campaign run <config.yaml> [--dry-run] [--background]');
      process.exit(1);
    }
    if (args.includes('--background')) {
      try {
        const launchArgs = args.slice(3).filter((arg) => arg !== '--background');
        await registerBackgroundTask({
          kind: 'campaign',
          name: `Campaign ${configPath}`,
          config_path: resolve(configPath),
          projectDir: detectProjectDir(),
          launch_args: launchArgs,
        });
        return;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        const { rpcErrorExitCode } = await import('./orchestrator-rpc.js');
        process.exit(rpcErrorExitCode(err));
      }
    }
    const cfg = await loadCampaignConfig(resolve(configPath));
    const result = await runCampaign(cfg, { dryRun: args.includes('--dry-run') });
    console.log(`Campaign ${cfg.id}: ${result.status}`);
    return;
  }

  if (subcommand === 'status') {
    const id = args[2];
    if (!id || args.includes('--help') || args.includes('-h')) {
      console.error('Usage: flowcrew campaign status <campaign_id>');
      process.exit(1);
    }
    const dir = campaignDir(id);
    const summaryPath = join(dir, 'summary.json');
    const logPath = join(dir, 'iteration_log.jsonl');
    const activePath = join(dir, 'active.json');
    console.log(`# Campaign: ${id}`);
    if (!existsSync(dir)) {
      console.log('Status: not found');
      return;
    }
    if (existsSync(summaryPath)) {
      try {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
        console.log(`Status: ${summary.status ?? 'unknown'}`);
        if (summary.iter !== undefined) console.log(`Iterations: ${summary.iter}`);
      } catch {
        console.log('Status: summary unreadable');
      }
    } else if (existsSync(activePath)) {
      try {
        const active = JSON.parse(readFileSync(activePath, 'utf-8'));
        console.log(`Status: running`);
        console.log(`Iteration: ${active.iter ?? '?'}`);
        console.log(`Unit: ${active.systemdUnit ?? '?'}`);
      } catch {
        console.log('Status: running');
      }
    } else {
      console.log('Status: initialized');
    }
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
      console.log(`Log entries: ${lines.length}`);
      const last = lines.at(-1);
      if (last) console.log(`Last: ${last}`);
    }
    return;
  }

  if (subcommand === 'stop') {
    const id = args[2];
    if (!id || args.includes('--help') || args.includes('-h')) {
      console.error('Usage: flowcrew campaign stop <campaign_id>');
      process.exit(1);
    }
    await stopCampaign(id);
    console.log(`Campaign ${id}: stop requested`);
    return;
  }

  console.error('Usage: flowcrew campaign run|status|stop|pending|review ...');
  process.exit(1);
}

function cmdBrief() {
  const subcommand = args[1];
  const briefDir = args[2] ? resolve(args[2]) : undefined;

  if (subcommand === 'head') {
    if (!briefDir || args.includes('--help') || args.includes('-h')) {
      console.error('Usage: flowcrew brief head <briefDir>');
      process.exit(1);
    }
    const head = readHead(briefDir);
    console.log(`${head.version} ${head.path}`);
    return;
  }

  if (subcommand === 'diff') {
    const fromVersion = args[3];
    const toVersion = args[4];
    if (!briefDir || !fromVersion || !toVersion || args.includes('--help') || args.includes('-h')) {
      console.error('Usage: flowcrew brief diff <briefDir> <fromVersion> <toVersion>');
      process.exit(1);
    }
    process.stdout.write(diffVersions(briefDir, fromVersion, toVersion));
    return;
  }

  if (subcommand === 'rollback') {
    const version = args[3];
    if (!briefDir || !version || args.includes('--help') || args.includes('-h')) {
      console.error('Usage: flowcrew brief rollback <briefDir> <version>');
      process.exit(1);
    }
    const head = rollback(briefDir, version, `cli rollback to ${version}`);
    console.log(`${head.version} ${head.path}`);
    return;
  }

  if (subcommand === 'log') {
    if (!briefDir || args.includes('--help') || args.includes('-h')) {
      console.error('Usage: flowcrew brief log <briefDir>');
      process.exit(1);
    }
    const logPath = join(briefDir, 'revisions.jsonl');
    if (!existsSync(logPath)) {
      console.log('No revisions.');
      return;
    }
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      console.log('No revisions.');
      return;
    }
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { ts?: string; from?: string; to?: string; reason?: string };
        console.log(`${entry.ts ?? '?'} ${entry.from ?? '?'} -> ${entry.to ?? '?'} ${entry.reason ?? ''}`.trim());
      } catch {
        console.log(line);
      }
    }
    return;
  }

  console.error('Usage: flowcrew brief head|diff|rollback|log ...');
  process.exit(1);
}

function printUsage() {
  console.log(`
FlowCrew — Multi-agent orchestration platform

Usage: flowcrew <command>

Commands:
  init      Initialize FlowCrew in the current project
  adapter   Show or set the project adapter choice
  quick     Inspect, then run or enqueue an authored brief (no server needed)
  status    Show the latest run for this project (--all/--project for others)
  list      Show all recent runs with status and duration
  guide     Send guidance to the running supervisor
  clean     Delete old runs (keeps 5 most recent by default)
  export    Export a run as JSON bundle
  campaign  Run, inspect, or stop an outer-loop research campaign
  campaign-loop  Run the long-lived autonomous research direction loop
  daemon    Operate the background orchestrator (restart/status; serve is foreground/internal)
  dashboard Query the running web dashboard (status)
  task      List and manage background tasks
  audit-reality  Run declared checks against task history
  inbox     Review and resolve approval requests that parked a run
  ship-preflight  Gather prior-run, campaign, build, and brief-input facts before shipping
  ship-setup  Create a launch worktree, link declared inputs, and baseline validation
  land      Audit terminal artifacts and every unique worktree item before safe removal
  audit-report  Re-derive supported numeric and path-bearing claims from a terminal report
  watch     Report edge-triggered stall judgements for live runs
  rehearse  Wind-tunnel a research brief pre-launch: real scheduler + scripted fake agent, 0 tokens
  brief     Inspect, diff, or roll back versioned briefs
  doctor    Check system requirements; repair/compact the task registry (dry-run by default)
  start     Start the web dashboard (this is NOT the background orchestrator daemon)
  version   Show version

Examples:
  flowcrew adapter
  flowcrew adapter claude
  flowcrew quick "refactor auth module"
  flowcrew quick "task" --supervise --max-iterations 3
  flowcrew status
  flowcrew status --all
  flowcrew status --project ../another-project
  flowcrew list --limit 20
  flowcrew daemon status
  flowcrew daemon restart
  flowcrew dashboard status
  flowcrew doctor --repair-registry
  flowcrew doctor --repair-registry --apply
  flowcrew doctor --compact-registry
  flowcrew start  # web dashboard only
  flowcrew task list
  flowcrew guide --run <run-id> "try a different approach"
  flowcrew clean --keep 3
  flowcrew campaign run examples/example_campaign.yaml --dry-run
  flowcrew ship-preflight --brief docs/task_brief.md
  flowcrew ship-setup --brief docs/task_brief.md --target ../task-worktree --base HEAD --branch task-work
  flowcrew land --run <run-id>
  flowcrew audit-report --report docs/final.md --run-dir <run-dir>
  flowcrew watch --once
  flowcrew brief head docs/brief

Options:
  --help    Show this help message

Environment:
  PORT          Server port (default: 3000)
  PROJECT_DIR   Project directory (default: current directory)
`);
}

/**
 * P3 autonomous outer loop: campaign_planner proposes a direction → a full inner research run
 * explores it → the same policy decides → repeat until the policy ships/ceilings or the planner
 * runs dry. Each direction is a real ~45min inner run, so this command runs for hours.
 */
async function cmdCampaignLoop(): Promise<void> {
  let projectDir = detectProjectDir();
  let campaignArg: string | undefined;
  let task = '';
  let maxDirections: number | undefined;
  let noScout = false;
  let acknowledgementPresent = false;
  let acknowledgementDigest: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) { projectDir = resolve(args[++i]); continue; }
    if (args[i] === '--campaign' && args[i + 1]) { campaignArg = args[++i]; continue; }
    if (args[i] === '--max-directions' && args[i + 1]) { maxDirections = parseInt(args[++i], 10); continue; }
    if (args[i] === '--no-scout') { noScout = true; continue; } // skip the up-front literature scout
    if (args[i] === '--task' && args[i + 1]) { task = args[++i]; continue; }
    if (args[i] === '--acknowledge-brief-warnings') { acknowledgementPresent = true; continue; }
    if (args[i].startsWith('--acknowledge-brief-warnings=')) {
      acknowledgementPresent = true;
      acknowledgementDigest = args[i].slice('--acknowledge-brief-warnings='.length);
      continue;
    }
    if (args[i] === '-') { task = readFileSync(0, 'utf-8'); continue; }
  }
  if (!task.trim() || !campaignArg) {
    console.error('Usage: flowcrew campaign-loop - --project <dir> --campaign <name> [--max-directions N] [--acknowledge-brief-warnings[=<digest>]]');
    console.error('  Autonomous outer loop: proposes a NEW direction, runs a full inner research loop on it, repeats until frontier/ship.');
    process.exit(1); return;
  }
  const {
    canDeriveBriefAdmission,
    createBriefAdmission,
    formatBriefPreflightReport,
    inspectBrief,
  } = await import('./brief-preflight.js');
  const parentReport = inspectBrief(task);
  console.log(`${formatBriefPreflightReport(parentReport)}\n`);
  if (acknowledgementDigest !== undefined && acknowledgementDigest !== parentReport.digest) {
    console.error(`Brief acknowledgement digest mismatch: received ${acknowledgementDigest || '(empty)'}, current digest is ${parentReport.digest}.`);
    process.exit(2); return;
  }
  if (parentReport.requiresAcknowledgement && !acknowledgementPresent) {
    console.error('Campaign launch paused before adapter or proposer loading. Review the report above, then rerun with:');
    console.error(`  --acknowledge-brief-warnings=${parentReport.digest}`);
    process.exit(2); return;
  }
  const parentAdmission = createBriefAdmission(
    parentReport,
    acknowledgementPresent
      ? {
          kind: 'explicit',
          source: acknowledgementDigest === undefined ? 'cli_current_input_flag' : 'cli_digest_flag',
          at: new Date().toISOString(),
        }
      : { kind: 'not_required' },
  );
  const { parseBriefFrontmatter } = await import('./scheduler.js');
  const { research } = parseBriefFrontmatter(task);
  if (!research) { console.error('campaign-loop needs a brief with a research:/objective: block (baseline + policy + stop).'); process.exit(1); return; }
  const objective = { ...research, stop: { ...(research.stop ?? {}), ...(maxDirections !== undefined ? { maxRounds: maxDirections } : {}) } };

  const cfgRole = join(import.meta.dirname ?? '.', '..', 'config', 'agents', 'campaign_planner.yaml');
  const localRole = join(projectDir, 'config', 'agents', 'campaign_planner.yaml');
  const proposeRole = parseYaml(readFileSync(existsSync(localRole) ? localRole : cfgRole, 'utf-8')) as { name: string; description: string; model: string; reasoning_effort: string; tools: string[]; prompt: string };

  const projDefaults = loadProjectDefaults(projectDir);
  // The inner `quick` runs get the project's model via the scheduler, but this propose
  // call hits the adapter directly — apply the project default here too so both paths
  // resolve identically. ('default' now inherits the user's global codex config in the
  // adapter; the historical hazard was the CLI built-in default drifting to a model the
  // account lacked — gpt-5.3-codex, HTTP 400 — and the failed propose masquerading as a frontier.)
  if ((!proposeRole.model || proposeRole.model === 'default') && projDefaults.model) proposeRole.model = projDefaults.model;
  const campaignAdapterResolution = resolveRuntimeAdapter({ configured: projDefaults.adapter });
  if (!campaignAdapterResolution.ok) {
    console.error(`❌ ${campaignAdapterResolution.hint}`);
    process.exitCode = 1;
    return;
  }
  const adapterName = normalizeAdapterName(campaignAdapterResolution.adapter);
  console.log(`Adapter resolution: ${adapterName} — ${campaignAdapterResolution.reason}`);
  const adapterInstance = await loadAdapterByName(adapterName);

  const cliPath = process.argv[1];
  const proposeDir = join(runsRoot(), `campaign-loop-propose-${process.pid}`);
  mkdirSync(proposeDir, { recursive: true });

  const { runLiveCampaign, scoutDirections } = await import('./campaign-loop-live.js');

  // LITERATURE SCOUT (before exploring): web_search the external literature for methods not in the
  // ledger that are expressible on the on-disk assets, and EXPAND the portfolio with them — so the
  // campaign can autonomously discover breakthroughs outside the brief's static list (and a frontier
  // is literature-backed, not confabulated from the ledger alone). Merged into objective.directions,
  // which the deterministic coverage floor then forces to be tried before any frontier.
  if (!noScout) {
    const scoutCfg = join(import.meta.dirname ?? '.', '..', 'config', 'agents', 'campaign_scout.yaml');
    const scoutLocal = join(projectDir, 'config', 'agents', 'campaign_scout.yaml');
    const scoutPath = existsSync(scoutLocal) ? scoutLocal : scoutCfg;
    if (existsSync(scoutPath)) {
      const scoutRole = parseYaml(readFileSync(scoutPath, 'utf-8')) as { name: string; description: string; model: string; reasoning_effort: string; tools: string[]; prompt: string };
      if ((!scoutRole.model || scoutRole.model === 'default') && projDefaults.model) scoutRole.model = projDefaults.model;
      console.log('Campaign-loop: running the literature scout (web_search) to expand the portfolio before exploring...');
      try {
        const found = await scoutDirections({
          projectDir, campaignId: campaignArg, objective,
          scoutRole, adapter: adapterInstance as unknown as import('./adapters/base.js').Adapter,
          runOpts: { timeout_ms: 600000, workDir: proposeDir, runDir: proposeDir, stageId: 'campaign_scout' },
          briefContext: task,
        });
        const existing = new Set((objective.directions ?? []).map((d) => d.toLowerCase()));
        const fresh = found.filter((d) => !existing.has(d.toLowerCase()));
        if (fresh.length) {
          objective.directions = [...(objective.directions ?? []), ...fresh];
          console.log(`Scout added ${fresh.length} literature-found direction(s) to the portfolio: ${fresh.join(', ')}`);
        } else {
          console.log('Scout found no new literature-expressible direction beyond the ledger/portfolio.');
        }
      } catch (e) {
        console.error(`Scout failed (proceeding with the brief portfolio): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  console.log(`Campaign-loop: autonomous outer loop on '${campaignArg}' (adapter=${adapterName}). Each direction spawns a full inner run — this runs for hours.`);
  const result = await runLiveCampaign({
    projectDir, campaignId: campaignArg, objective,
    proposeRole, adapter: adapterInstance as unknown as import('./adapters/base.js').Adapter,
    proposeRunOpts: { timeout_ms: 600000, workDir: proposeDir, runDir: proposeDir, stageId: 'campaign_propose' },
    briefContext: task, // give the proposer the campaign brief (goal + gates + historical ledger) so it does not re-propose dead directions
    launchInner: async (direction) => {
      const seeded = task + `\n\n## OUTER-LOOP DIRECTIVE\nFocus this entire run on ONE direction: ${direction}\n`;
      const childReport = inspectBrief(seeded);
      console.log(`${formatBriefPreflightReport(childReport)}\n`);
      if (!canDeriveBriefAdmission(parentAdmission, parentReport, childReport)) {
        console.error(`Generated brief ${childReport.digest} has a new consequential finding or degraded contract readiness.`);
        console.error(`Review it and launch explicitly with --acknowledge-brief-warnings=${childReport.digest}`);
        throw new Error(`inner run for '${direction}' stopped before reservation because its exact brief was not admitted`);
      }
      const childAdmission = createBriefAdmission(childReport, {
        kind: 'derived',
        source: 'campaign_loop',
        at: new Date().toISOString(),
        parentDigest: parentReport.digest,
        transformation: 'outer_loop_directive_v1',
      });
      let out: string;
      try {
        out = execFileSync(process.execPath, [
          cliPath,
          'quick',
          '-',
          '--project', projectDir,
          '--campaign', campaignArg,
          '--campaign-context=skip',
          '--brief-admission-record', encodeBriefAdmission(childAdmission),
        ], { input: seeded, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
      } catch (e) { out = String((e as { stdout?: string }).stdout ?? '') + String((e as { stderr?: string }).stderr ?? ''); }
      const m = /"runId":"([^"]+)"/.exec(out);
      if (!m) throw new Error(`inner run for '${direction}' produced no runId`);
      console.log(`  ↳ direction '${direction}' → run ${m[1]}`);
      return m[1];
    },
    readBest: (runId) => {
      try {
        const j = JSON.parse(readFileSync(join(runsRoot(), runId, 'research_journal.json'), 'utf-8')) as { rounds?: { result?: number }[] };
        const rs = (j.rounds ?? []).map((r) => r.result).filter((v): v is number => typeof v === 'number');
        if (!rs.length) return objective.baseline;
        return objective.higherIsBetter === false ? Math.min(...rs) : Math.max(...rs);
      } catch { return objective.baseline; }
    },
    readRunStatus: (runId) => {
      // The inner run's terminal verdict. A reality_gate_failed run had its claim rejected by the
      // inner safety net — the outer loop must not ship its journaled number.
      try {
        const r = JSON.parse(readFileSync(join(runsRoot(), runId, 'run.json'), 'utf-8')) as { status?: string };
        return typeof r.status === 'string' ? r.status : 'complete';
      } catch { return 'complete'; }
    },
  });
  console.log(`Campaign-loop ${result.decision}: ${result.reason}`);
  console.log(`Directions explored: ${result.outcomes.map((o) => `${o.direction}=${o.rejected ? `REJECTED(${o.status})` : o.bestResult}`).join(', ') || '(none)'}`);
}

// Main
switch (command) {
  case 'init':
    cmdInit().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
    break;
  case 'adapter':
    try { cmdAdapter(); } catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); }
    break;
  case 'quick':
    cmdQuick().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
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
  case 'clean':
    cmdClean();
    break;
  case 'export':
    cmdExport();
    break;
  case 'campaign':
    cmdCampaign().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
    break;
  case 'campaign-loop':
    cmdCampaignLoop().catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'daemon':
    import('./cli-daemon.js').then(({ cmdDaemon }) => cmdDaemon(args)).then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'dashboard':
    import('./cli-dashboard.js').then(({ cmdDashboard }) => cmdDashboard(args)).then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'task':
    import('./cli-task.js').then(({ cmdTask }) => cmdTask(args)).then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'audit-reality':
    import('./reality-gate/audit-reality.js').then(({ cmdAuditReality }) => cmdAuditReality(args)).then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'inbox':
    import('./cli-inbox.js').then(({ cmdInbox }) => cmdInbox(args)).then((code) => { process.exitCode = code; }).catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'ship-preflight':
    import('./cli-ship-preflight.js').then(({ cmdShipPreflight }) => cmdShipPreflight(args))
      .then((code) => { process.exitCode = code; })
      .catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'ship-setup':
    import('./cli-ship-setup.js').then(({ cmdShipSetup }) => cmdShipSetup(args))
      .then((code) => { process.exitCode = code; })
      .catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'land':
    import('./cli-land.js').then(({ cmdLand }) => cmdLand(args))
      .then((code) => { process.exitCode = code; })
      .catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'audit-report':
    import('./cli-audit-report.js').then(({ cmdAuditReport }) => cmdAuditReport(args))
      .then((code) => { process.exitCode = code; })
      .catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'watch':
    import('./cli-watch.js').then(({ cmdWatch }) => cmdWatch(args))
      .then((code) => { process.exitCode = code; })
      .catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'rehearse':
    import('./rehearse.js').then(({ cmdRehearse }) => cmdRehearse(args.slice(1))).catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'brief':
    try { cmdBrief(); } catch (err) { console.error(err); process.exit(1); }
    break;
  case 'doctor':
    if (args.includes('--repair-registry') || args.includes('--compact-registry') || args.includes('--apply')) {
      import('./cli-doctor.js')
        .then(({ cmdDoctorMaintenance }) => { process.exitCode = cmdDoctorMaintenance(args); })
        .catch((err) => { console.error(err); process.exit(1); });
    } else {
      cmdDoctor().catch((err) => { console.error(err); process.exit(1); });
    }
    break;
  case 'start':
    cmdStart().catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'version':
  case '--version':
  case '-v': {
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
    process.exit(1);
}
