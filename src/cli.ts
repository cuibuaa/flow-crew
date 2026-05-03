#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const args = process.argv.slice(2);
const command = args[0];

function detectProjectDir(): string {
  return process.env.PROJECT_DIR || process.cwd();
}

function detectAdapter(): string {
  const checks: [string, string][] = [
    ['codex', 'codex'],
    ['claude', 'claude'],
  ];
  for (const [cmd, name] of checks) {
    try {
      execSync(`which ${cmd}`, { stdio: 'ignore' });
      return name;
    } catch { /* not found */ }
  }
  return 'codex';
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

  // Create .fc directory
  mkdirSync(join(projectDir, '.fc', 'runs'), { recursive: true });

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
    ['codex', 'OpenAI Codex CLI', 'Install: npm i -g @openai/codex'],
    ['claude', 'Claude Code CLI', 'Install: npm i -g @anthropic/claude-code'],
  ];
  let anyAdapter = false;
  for (const [cmd, label, installHint] of adapters) {
    try {
      execSync(`which ${cmd}`, { stdio: 'ignore' });
      checks.push({ name: label, status: 'ok', message: 'installed' });
      anyAdapter = true;
    } catch {
      checks.push({ name: label, status: 'warn', message: `not found. ${installHint}` });
    }
  }
  if (!anyAdapter) {
    checks.push({ name: 'Any adapter CLI', status: 'fail', message: 'No adapter CLI found. Install Codex or Claude.' });
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
        } catch {
          checks.push({ name: `Configured adapter (${adapter})`, status: 'fail', message: `${cmd} not found. Install it or change adapter in config/defaults.yaml` });
        }
      }
    } catch {
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
  } catch {
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
  } catch {
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

  // Build UI if dist doesn't exist
  const uiDist = join(import.meta.dirname ?? '.', '..', 'ui', 'dist', 'index.html');
  if (!existsSync(uiDist)) {
    const uiDir = join(import.meta.dirname ?? '.', '..', 'ui');
    if (existsSync(join(uiDir, 'package.json'))) {
      console.log('Building UI...');
      try {
        execSync('npm run build', { cwd: uiDir, stdio: 'inherit' });
      } catch {
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
        } catch {
          // Configured adapter not found — try to auto-detect
          const detected = detectAdapter();
          if (detected !== adapter) {
            console.log(`⚠️  Configured adapter "${adapter}" (${cmd}) not found. Auto-detected: ${detected}`);
            parsed.adapter = detected;
            writeFileSync(defaultsPath, stringifyYaml(parsed), 'utf-8');
          } else {
            console.error(`❌ No adapter CLI found. Install Codex or Claude`);
            console.error('   npm i -g @openai/codex');
            console.error('   npm i -g @anthropic/claude-code');
            process.exit(1);
          }
        }
      }
    } catch { /* ignore parse errors, let dashboard handle it */ }
  }

  const { startDashboard } = await import('./dashboard.js');
  await startDashboard(projectDir, port);
}

function printUsage() {
  console.log(`
FlowCrew — Multi-agent orchestration platform

Usage: flowcrew <command>

Commands:
  init      Initialize FlowCrew in the current project
  doctor    Check system requirements and configuration
  start     Start the FlowCrew dashboard server
  version   Show version

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
  case 'doctor':
    cmdDoctor().catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'start':
    cmdStart();
    break;
  case 'version':
  case '--version':
  case '-v': {
    const pkgPath = join(import.meta.dirname ?? '.', '..', 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      console.log(`flowcrew ${pkg.version}`);
    } catch {
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
