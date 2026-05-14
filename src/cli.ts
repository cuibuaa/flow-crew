#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, symlinkSync, lstatSync, renameSync as fsRenameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runsRoot } from './store.js';
import { loadProjectDefaults } from './config.js';

const args = process.argv.slice(2);
const command = args[0];

function detectProjectDir(): string {
  return process.env.PROJECT_DIR || process.cwd();
}

function detectAdapter(): string {
  const checks: [string, string][] = [
    ['claude', 'claude'],
    ['codex', 'codex'],
  ];
  for (const [cmd, name] of checks) {
    try {
      execSync(`which ${cmd}`, { stdio: 'ignore' });
      return name;
    } catch { /* not found */ }
  }
  return 'claude';
}

function cmdInit() {
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
    const adapter = detectAdapter();
    const defaults = {
      default_timeout_ms: 1800000,
      default_max_iterations: 5,
      default_gate_retry_loops: 3,
      default_stage_technical_retries: 1,
      adapter,
      model: 'default',
      reasoning_effort: 'default',
      paths: { runs: '.fc/runs', agents: 'config/agents', workflows: 'config/workflows' },
      campaign_triggers: { enabled: true, regression_after: 2, plateau_after: 3, plateau_threshold: 5, repeated_failure_after: 3 },
    };
    writeFileSync(defaultsPath, stringifyYaml(defaults), 'utf-8');
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
  const globalFcDir = join(homedir(), '.fc', 'runs');
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

  console.log('\n🎉 FlowCrew initialized! Run `flowcrew start` or `flowcrew doctor` next.');
}

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

async function cmdDoctor() {
  const projectDir = detectProjectDir();
  const checks: DoctorCheck[] = [];

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

  // Adapter CLIs
  const adapters: [string, string, string][] = [
    ['claude', 'Claude Code CLI', 'Install: npm i -g @anthropic/claude-code'],
    ['codex', 'OpenAI Codex CLI', 'Install: npm i -g @openai/codex'],
  ];
  let anyAdapter = false;
  for (const [cmd, label, installHint] of adapters) {
    try {
      execSync(`which ${cmd}`, { stdio: 'ignore' });
      checks.push({ name: label, status: 'ok', message: 'installed' });
      anyAdapter = true;
    } catch { /* expected - optional resource */
      checks.push({ name: label, status: 'warn', message: `not found. ${installHint}` });
    }
  }
  if (!anyAdapter) {
    checks.push({ name: 'Any adapter CLI', status: 'fail', message: 'No adapter CLI found. Install Claude Code or Codex.' });
  }

  // Config files
  const defaultsPath = join(projectDir, 'config', 'defaults.yaml');
  if (existsSync(defaultsPath)) {
    try {
      const raw = readFileSync(defaultsPath, 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown>;
      const adapter = parsed.adapter as string;
      checks.push({ name: 'config/defaults.yaml', status: 'ok', message: `adapter: ${adapter}` });

      // Check if configured adapter is installed
      const adapterCmd: Record<string, string> = { codex: 'codex', claude: 'claude' };
      const cmd = adapterCmd[adapter];
      if (cmd) {
        try {
          execSync(`which ${cmd}`, { stdio: 'ignore' });
        } catch { /* expected - optional resource */
          checks.push({ name: `Configured adapter (${adapter})`, status: 'fail', message: `${cmd} not found. Install it or change adapter in config/defaults.yaml` });
        }
      }
    } catch { /* expected - optional resource */
      checks.push({ name: 'config/defaults.yaml', status: 'fail', message: 'Invalid YAML. Run `flowcrew init` to regenerate.' });
    }
  } else {
    checks.push({ name: 'config/defaults.yaml', status: 'fail', message: 'Missing. Run `flowcrew init` to create it.' });
  }

  // Agents directory
  const agentsDir = join(projectDir, 'config', 'agents');
  if (existsSync(agentsDir)) {
    const agents = readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
    checks.push({ name: 'Agent configs', status: agents.length > 0 ? 'ok' : 'warn', message: `${agents.length} agents found` });
    // Check for required agents
    const requiredAgents = ['discussion', 'planner'];
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

  // node-pty (optional but recommended for interactive discussion)
  try {
    await import('node-pty');
    checks.push({ name: 'node-pty', status: 'ok', message: 'available (full PTY support for discussion)' });
  } catch { /* expected - optional resource */
    checks.push({ name: 'node-pty', status: 'warn', message: 'not available — discussion will use fallback mode (no TUI rendering)' });
  }

  // Port availability
  const port = parseInt(process.env.PORT || '3000', 10);
  try {
    const http = await import('node:http');
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://localhost:${port}/api/settings`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    checks.push({ name: `Port ${port}`, status: 'ok', message: 'FlowCrew server is running' });
  } catch { /* expected - optional resource */
    checks.push({ name: `Port ${port}`, status: 'warn', message: 'Server not running. Start with `flowcrew start`.' });
  }

  // UI build
  const uiDist = join(import.meta.dirname ?? '.', '..', 'ui', 'dist', 'index.html');
  checks.push({
    name: 'UI build',
    status: existsSync(uiDist) ? 'ok' : 'warn',
    message: existsSync(uiDist) ? 'built' : 'Not built. Run: cd ui && npm run build',
  });

  // Print results
  console.log('\n🩺 FlowCrew Doctor\n');
  let hasFailure = false;
  for (const c of checks) {
    const icon = c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️ ' : '❌';
    console.log(`  ${icon} ${c.name}: ${c.message}`);
    if (c.status === 'fail') hasFailure = true;
  }
  console.log('');
  if (hasFailure) {
    console.log('Some checks failed. Fix the issues above and run `flowcrew doctor` again.');
    process.exit(1);
  } else {
    console.log('All checks passed! 🎉');
  }
}

async function cmdStart() {
  const projectDir = detectProjectDir();
  const port = parseInt(process.env.PORT || '3000', 10);

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

  // Auto-detect adapter if defaults.yaml doesn't exist
  const defaultsPath = join(projectDir, 'config', 'defaults.yaml');
  if (existsSync(defaultsPath)) {
    try {
      const raw = readFileSync(defaultsPath, 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown>;
      const adapter = parsed.adapter as string;
      const adapterCmd: Record<string, string> = { codex: 'codex', claude: 'claude' };
      const cmd = adapterCmd[adapter];
      if (cmd) {
        try {
          execSync(`which ${cmd}`, { stdio: 'ignore' });
        } catch { /* expected - optional resource */
          // Configured adapter not found — try to auto-detect
          const detected = detectAdapter();
          if (detected !== adapter) {
            console.log(`⚠️  Configured adapter "${adapter}" (${cmd}) not found. Auto-detected: ${detected}`);
            parsed.adapter = detected;
            writeFileSync(defaultsPath, stringifyYaml(parsed), 'utf-8');
          } else {
            console.error(`❌ No adapter CLI found. Install Claude Code or Codex`);
            console.error('   npm i -g @anthropic/claude-code');
            console.error('   npm i -g @openai/codex');
            process.exit(1);
          }
        }
      }
    } catch { /* ignore parse errors, let dashboard handle it */ }
  }

  const { startDashboard } = await import('./dashboard.js');
  await startDashboard(projectDir, port);
}

async function cmdQuick() {
  let projectDir = detectProjectDir();
  let task = '';
  let adapter = '';
  let workflow = 'default';
  let maxIterations: number | undefined;
  let timeout: number | undefined;
  let supervise = true; // supervisor brain on by default; opt out with --no-supervise
  let campaignArg: string | undefined; // --campaign <name> wins over defaults.yaml; --no-campaign forces undefined
  let campaignDisabled = false;
  let existingRunId: string | undefined; // dashboard rerun/execute path passes this to spawn a detached scheduler
  const taskParts: string[] = [];

  if (args.includes('--help') || args.includes('-h')) { args.length = 0; } // trigger usage

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) { projectDir = resolve(args[++i]); continue; }
    if (args[i] === '--adapter' && args[i + 1]) { adapter = args[++i]; continue; }
    if (args[i] === '--workflow' && args[i + 1]) { workflow = args[++i]; continue; }
    if (args[i] === '--max-iterations' && args[i + 1]) { maxIterations = parseInt(args[++i], 10); continue; }
    if (args[i] === '--timeout' && args[i + 1]) { timeout = parseInt(args[++i], 10); continue; }
    if (args[i] === '--supervise') { supervise = true; continue; }
    if (args[i] === '--no-supervise') { supervise = false; continue; }
    if (args[i] === '--campaign' && args[i + 1]) { campaignArg = args[++i]; continue; }
    if (args[i] === '--no-campaign') { campaignDisabled = true; continue; }
    if (args[i] === '--task' && args[i + 1]) { task = args[++i]; continue; }
    if (args[i] === '--existing-run-id' && args[i + 1]) { existingRunId = args[++i]; continue; }
    if (args[i] === '-') { task = readFileSync(0, 'utf-8').trim(); continue; }
    taskParts.push(args[i]);
  }
  if (!task && taskParts.length > 0) task = taskParts.join(' ');

  // --existing-run-id path: dashboard handing off a rerun/execute to a detached
  // scheduler process. Reuse the existing run state and read the task brief
  // from the run dir instead of requiring --task.
  if (existingRunId && !task) {
    const { runsRoot: getRunsRoot } = await import('./store.js');
    const briefPath = join(getRunsRoot(), existingRunId, 'task_brief.md');
    if (existsSync(briefPath)) {
      try { task = readFileSync(briefPath, 'utf-8'); } catch { /* ignore */ }
    }
    if (!task) {
      // Fall back to taskDescription in run.json
      try {
        const runJson = JSON.parse(readFileSync(join(getRunsRoot(), existingRunId, 'run.json'), 'utf-8'));
        if (typeof runJson.taskDescription === 'string') task = runJson.taskDescription;
      } catch { /* ignore */ }
    }
  }

  if (!task) {
    console.error('Usage: flowcrew quick "task description" [options]');
    console.error('');
    console.error('Options:');
    console.error('  --adapter claude|codex  Agent backend (Claude Code preferred if omitted)');
    console.error('  --workflow <name>       Workflow to use (default: default)');
    console.error('  --max-iterations <n>    Max plan-execute-review cycles (default: 5)');
    console.error('  --timeout <ms>          Per-stage timeout in ms (default: 300000)');
    console.error('  --supervise             Enable supervisor brain (default: ON)');
    console.error('  --no-supervise          Disable supervisor brain (opt-out)');
    console.error('  --campaign <name>       Attach run to campaign (default: defaults.yaml::campaign or slug(basename(projectDir)))');
    console.error('  --no-campaign           Run un-attached to any campaign (opt-out)');
    console.error('  --project <path>        Project directory (default: cwd)');
    console.error('  --task "text"           Task description as flag');
    console.error('  -                       Read task from stdin');
    console.error('  --existing-run-id <id>  Resume an existing run (reads task from <run_dir>/task_brief.md)');
    process.exit(1);
  }

  if (!adapter) {
    const fromDefaults = loadProjectDefaults(projectDir).adapter;
    adapter = fromDefaults || detectAdapter();
  }

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

  let adapterInstance: unknown;
  if (adapter === 'claude') {
    const { ClaudeAdapter } = await import('./adapters/claude.js');
    adapterInstance = new ClaudeAdapter();
  } else {
    const { CodexAdapter } = await import('./adapters/codex.js');
    adapterInstance = new CodexAdapter();
  }

  // Only write docs/task_brief.md on a fresh ship. For --existing-run-id path
  // the brief already lives in <run_dir>/task_brief.md; rewriting docs/ would
  // also stomp a sibling project's brief if multiple are reusing the same docs.
  if (!existingRunId) {
    const docsDir = join(projectDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'task_brief.md'), task, 'utf-8');
  }

  console.log(`FlowCrew: shipping task with workflow "${config.name}"...`);
  console.log(`Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);
  console.log(`Project: ${projectDir}`);
  console.log(`Adapter: ${adapter}`);
  console.log(`Max iterations: ${config.defaults.max_iterations ?? 5}`);
  console.log(`Stage timeout: ${config.defaults.timeout_ms ?? 300000}ms`);
  console.log(`Supervisor: ${supervise ? 'enabled' : 'disabled'}`);
  // Resolve campaign id: explicit --campaign > defaults.yaml::campaign > slug(basename(projectDir)).
  // --no-campaign forces undefined (run stays untagged).
  const campaignFromDefaults = loadProjectDefaults(projectDir).campaign;
  const campaignBaseSlug = (projectDir.split(/[\\/]/).filter(Boolean).pop() ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const resolvedCampaign = campaignDisabled
    ? undefined
    : (campaignArg || campaignFromDefaults || campaignBaseSlug || undefined);
  console.log(`Campaign: ${resolvedCampaign ?? '(none — --no-campaign)'}`);
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
        if (ss.status === 'running') process.stdout.write(`  [${elapsed}s] ⟳ ${id} started\n`);
        else if (ss.status === 'complete') { const dur = ss.duration_ms ? `${(ss.duration_ms / 1000).toFixed(0)}s` : ''; process.stdout.write(`  [${elapsed}s] ✓ ${id} complete${dur ? ' (' + dur + ')' : ''}\n`); }
        else if (ss.status === 'failed') process.stdout.write(`  [${elapsed}s] ✗ ${id} failed${ss.error ? ': ' + ss.error : ''}\n`);
        else if (ss.status === 'skipped') process.stdout.write(`  [${elapsed}s] ⊘ ${id} skipped\n`);
      }
    } catch { /* non-critical */ }
  }, 2000);

  const finalState = await runWorkflow(config, raw, projectDir, adapterInstance as any, agents as any, undefined, resolvedAgentsDir, existingRunId, task, true, supervise, resolvedCampaign);
  clearInterval(progressTimer);

  // Desktop notification
  try {
    const title = finalState.status === 'complete' ? 'FlowCrew: Task Complete' : 'FlowCrew: Task Failed';
    const body = task.slice(0, 80);
    if (process.platform === 'darwin') {
      const { execSync: es } = await import('node:child_process');
      es(`osascript -e 'display notification "${body}" with title "${title}"'`, { stdio: 'ignore' });
    }
  } catch { /* non-critical */ }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
  const icon = finalState.status === 'complete' ? '✓' : '✗';
  console.log(`\n${icon} Workflow "${config.name}" ${finalState.status} (${totalTime}s total)`);
  for (const [id, st] of Object.entries(finalState.stages) as [string, { status: string; duration_ms?: number }][]) {
    const si = st.status === 'complete' ? '✓' : st.status === 'failed' ? '✗' : st.status === 'skipped' ? '⊘' : '·';
    console.log(`  ${si} ${id}: ${st.status}${st.duration_ms ? ` (${(st.duration_ms / 1000).toFixed(1)}s)` : ''}`);
  }
  process.exitCode = finalState.status === 'complete' ? 0 : 1;
}

function cmdStatus() {

  const root = runsRoot();
  if (!existsSync(root)) { console.log('No runs found. Run `flowcrew quick "task"` first.'); return; }
  const runs = readdirSync(root).sort().reverse();
  if (runs.length === 0) { console.log('No runs found.'); return; }
  const runDir = join(root, runs[0]);

  // Show summary.md if generated (best overview of what was done)
  const summaryPath = join(runDir, 'summary.md');
  if (existsSync(summaryPath)) { console.log(readFileSync(summaryPath, 'utf-8')); return; }

  // Show progress.md if supervisor generated one
  const progressPath = join(runDir, 'progress.md');
  if (existsSync(progressPath)) { console.log(readFileSync(progressPath, 'utf-8')); return; }

  // Fallback: show run.json summary
  const state = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'));
  console.log(`# Run: ${runs[0]}\n`);
  console.log(`Goal: ${state.taskDescription?.slice(0, 200) ?? '(no description)'}`);
  console.log(`Status: ${state.status}`);
  console.log(`Iteration: ${state.currentIteration ?? '?'}/${state.maxIterations ?? '?'}\n`);
  console.log('## Stages');
  for (const [id, ss] of Object.entries(state.stages) as [string, any][]) {
    const dur = ss.duration_ms ? ` (${(ss.duration_ms / 1000).toFixed(0)}s)` : '';
    const icon = ss.status === 'complete' ? '✓' : ss.status === 'running' ? '⟳' : ss.status === 'failed' ? '✗' : '·';
    console.log(`  ${icon} ${id}: ${ss.status}${dur}`);
  }
}

function cmdList() {

  const root = runsRoot();
  if (!existsSync(root)) { console.log('No runs found. Run `flowcrew quick "task"` first.'); return; }
  const limitArg = args.find((a, i) => args[i - 1] === '--limit');
  const limit = limitArg ? parseInt(limitArg, 10) : 10;
  const runs = readdirSync(root).sort().reverse().slice(0, limit);
  if (runs.length === 0) { console.log('No runs found.'); return; }
  console.log(`\nRecent runs (${runs.length}):\n`);
  console.log('  Status     Duration  Run ID                          Task');
  console.log('  ' + '─'.repeat(75));
  for (const runId of runs) {
    try {
      const state = JSON.parse(readFileSync(join(root, runId, 'run.json'), 'utf-8'));
      const status = state.status === 'complete' ? '✓ complete' : state.status === 'failed' ? '✗ failed  ' : state.status === 'running' ? '⟳ running ' : '· ' + state.status.padEnd(8);
      const startMs = new Date(state.startedAt).getTime();
      const endMs = state.completedAt ? new Date(state.completedAt).getTime() : Date.now();
      const duration = `${Math.round((endMs - startMs) / 1000)}s`.padEnd(8);
      const taskDesc = (state.taskDescription || state.workflowName || '').slice(0, 40);
      console.log(`  ${status}  ${duration}  ${runId}  ${taskDesc}`);
    } catch { /* non-critical */ console.log(`  ? unknown   —         ${runId}`); }
  }
  console.log('');
}

function cmdGuide() {

  const message = args.slice(1).join(' ');
  if (!message) { console.error('Usage: flowcrew guide "your guidance message"'); process.exit(1); }
  const root = runsRoot();
  if (!existsSync(root)) { console.error('No runs found.'); process.exit(1); }
  const runs = readdirSync(root).sort().reverse();
  if (runs.length === 0) { console.error('No runs found.'); process.exit(1); }
  writeFileSync(join(root, runs[0], 'user_input.md'), message, 'utf-8');
  console.log(`Guidance sent to run ${runs[0]}:`);
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
  for (const runId of toDelete) {
    try { rmSync(join(root, runId), { recursive: true, force: true }); } catch { /* non-critical */ }
  }
  console.log(`Cleaned ${toDelete.length} old runs (kept ${keep} most recent).`);
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

function printUsage() {
  console.log(`
FlowCrew — Multi-agent orchestration platform

Usage: flowcrew <command>

Commands:
  init      Initialize FlowCrew in the current project
  quick     Ship a task directly from the CLI (no server needed)
  status    Show progress of the latest run
  list      Show all recent runs with status and duration
  guide     Send guidance to the running supervisor
  clean     Delete old runs (keeps 5 most recent by default)
  export    Export a run as JSON bundle
  doctor    Check system requirements and configuration
  start     Start the FlowCrew dashboard server
  version   Show version

Examples:
  flowcrew quick "refactor auth module"
  flowcrew quick "task" --supervise --max-iterations 3
  flowcrew status
  flowcrew list --limit 20
  flowcrew guide "try a different approach"
  flowcrew clean --keep 3

Options:
  --help    Show this help message

Environment:
  PORT          Server port (default: 3000)
  PROJECT_DIR   Project directory (default: current directory)
`);
}

// Main
switch (command) {
  case 'init':
    cmdInit();
    break;
  case 'quick':
    cmdQuick().catch((err) => { console.error(err); process.exit(1); });
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
  case 'doctor':
    cmdDoctor().catch((err) => { console.error(err); process.exit(1); });
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
