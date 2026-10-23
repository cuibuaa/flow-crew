import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorSessionIntegration } from '../src/session-integration.js';
import { createTaskEntry } from '../src/fc-tasks.js';
import { TaskRegistry } from '../src/task-registry.js';
import { createServer } from 'node:net';
import { SessionPush } from '../src/session-push.js';
import { hasClaudeWakeWaiter } from '../src/session-wake.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { processIsAlive } from '../src/process-liveness.js';
import { fakeCodexHookRequest } from './test-support/fake-codex-hooks.mjs';

const packageRoot = join(import.meta.dirname, '..');
const integration = join(packageRoot, 'skills', 'session-integration.mjs');
const installer = join(packageRoot, 'skills', 'install.sh');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fc-hooks-'));
  roots.push(root);
  const home = join(root, 'home');
  const codexHome = join(root, 'codex');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  for (const p of [home, codexHome, project, bin]) mkdirSync(p, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, FC_HOME: join(root, 'fc'), CLAUDE_CONFIG_DIR: undefined, PATH: `${bin}${delimiter}${dirname(process.execPath)}` };
  writeFileSync(join(bin, 'codex'), [
    `#!${process.execPath}`,
    "import { createInterface } from 'node:readline';",
    `import { fakeCodexHookRequest } from ${JSON.stringify(new URL('./test-support/fake-codex-hooks.mjs', import.meta.url).href)};`,
    'for await (const line of createInterface({ input: process.stdin })) {',
    ' const request = JSON.parse(line); if (!request.id) continue;',
    ' console.log(JSON.stringify({ id: request.id, result: fakeCodexHookRequest(request, process.env.CODEX_HOME, process.env.HOME) || {} }));',
    '}',
  ].join('\n'));
  chmodSync(join(bin, 'codex'), 0o755);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nconsole.log('2.1.308 (Claude Code)');\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(join(home, 'runner.mjs'), [
    "import { spawnSync } from 'node:child_process';",
    "import { readFileSync } from 'node:fs';",
    'const [file, ...args] = process.argv.slice(2);',
    "const result = spawnSync(file, args, { env: process.env, input: readFileSync(0), encoding: 'utf8', timeout: 15000 });",
    "process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || result.error?.message || '');",
    'process.exit(result.status ?? 1);',
  ].join('\n'));
  return { root, home, codexHome, project, bin, env };
}
function command(file: string, args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(process.execPath, [join(env.HOME!, 'runner.mjs'), file, ...args], {
    cwd: packageRoot, env: { ...env, HOME: env.HOME, FC_HOME: env.FC_HOME }, input, encoding: 'utf8', timeout: 20_000,
  });
}
function integrate(action: string, frontend: string, root: string, env: NodeJS.ProcessEnv) {
  return command(process.execPath, [integration, action, frontend, root, packageRoot], env);
}
function fixtureTrust(root: string, codexHome: string) {
  const path = join(root, 'hooks', 'flowcrew-session.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.codexTrust = fakeCodexHookRequest({ method: 'hooks/list', params: { cwds: [] } }, codexHome)
    .data[0].hooks.map((hook: { key: string; currentHash: string }) => ({ key: hook.key, hash: hook.currentHash }));
  writeFileSync(path, JSON.stringify(manifest));
  writeFileSync(join(codexHome, 'config.toml'), manifest.codexTrust.map((record: { key: string; hash: string }) => `[hooks.state.${JSON.stringify(record.key)}]\ntrusted_hash = ${JSON.stringify(record.hash)}\n`).join('\n'));
}

describe('installer-owned front-end integration', () => {
  it('an interrupted native hook loses coverage immediately and its worker retires without leaving a background process', async () => {
    const f = fixture();
    const root = join(f.home, '.claude');
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    const registry = new TaskRegistry({ baseDir: f.env.FC_HOME });
    registry.create({ projectDir: f.project, status: 'running', launcher: {
      frontend: 'claude', sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    const push = new SessionPush(registry);
    const child = spawn(process.execPath, [join(root, 'hooks', 'flowcrew-session.mjs'), 'Wake'], {
      cwd: f.project, env: { ...f.env, HOME: f.home, FC_HOME: f.env.FC_HOME }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
    });
    const done = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', () => resolve()); });
    child.stdin.end(JSON.stringify({ session_id: 'own-session' }));
    let worker: number | undefined;
    try {
      for (let i = 0; i < 100 && !hasClaudeWakeWaiter(push.root, 'own-session'); i++) await sleep(20);
      expect(hasClaudeWakeWaiter(push.root, 'own-session')).toBe(true);
      const directory = join(push.root, 'waiters');
      worker = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8')).pid;
      child.kill('SIGTERM'); // fake Claude's native timeout/session cancellation
      await done;
      expect(hasClaudeWakeWaiter(push.root, 'own-session')).toBe(false);
      for (let i = 0; i < 100 && readdirSync(directory).length; i++) await sleep(20);
      expect(readdirSync(directory)).toEqual([]);
      for (let i = 0; i < 100 && processIsAlive(worker!); i++) await sleep(20);
      expect(processIsAlive(worker!)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await done;
      // The worker observes host death itself; no PID guessing or broad signals.
      if (worker) for (let i = 0; i < 100 && processIsAlive(worker); i++) await sleep(20);
    }
  });

  it.each([
    ...['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'].map(mode => [mode, 'Stop']),
    ['bypassPermissions', 'SessionStart'],
  ])('the installed async hook wakes the exact launcher in %s mode at %s without permission settings', async (mode, eventName) => {
    const f = fixture();
    const root = join(f.home, '.claude');
    expect(command('/bin/bash', [installer, '--claude', '--global'], f.env).status).toBe(0);
    const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
    const wake = settings.hooks[eventName].flatMap((group: { hooks: unknown[] }) => group.hooks).find((hook: { asyncRewake?: boolean }) => hook.asyncRewake);
    expect(wake).toMatchObject({ timeout: 3660, asyncRewake: true });
    expect(settings.permissions).toBeUndefined();
    expect(settings.crossSessionInbound).toBeUndefined();
    const registry = new TaskRegistry({ baseDir: f.env.FC_HOME });
    const task = registry.create({ projectDir: f.project, status: 'running', launcher: {
      frontend: 'claude', sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    const push = new SessionPush(registry);
    const input = JSON.stringify({ session_id: 'own-session', hook_event_name: eventName, permission_mode: mode });
    const hook = join(root, 'hooks', 'flowcrew-session.mjs');
    const child = spawn(process.execPath, [hook, 'Wake'], {
      cwd: f.project, env: { ...f.env, HOME: f.home, FC_HOME: f.env.FC_HOME }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    child.stdin.end(input);
    try {
      for (let i = 0; i < 100 && !hasClaudeWakeWaiter(push.root, 'own-session'); i++) await sleep(20);
      expect(hasClaudeWakeWaiter(push.root, 'own-session')).toBe(true);
      // A second ordinary turn starts another Stop; it retires silently while
      // the original async waiter continues to cover the launching session.
      expect(command(process.execPath, [hook, 'Wake'], f.env, input).status).toBe(0);
      const stop = command(process.execPath, [hook, 'Stop'], f.env, input);
      expect(stop.status, stop.stderr).toBe(0);
      expect(stop.stdout).toBe('');
      const event = push.enqueue(task, { type: 'operator_wrap_up_required', runId: 'fixture-run', timestamp: new Date().toISOString() })!;
      await push.deliver(event);
      expect(await done, output).toBe(2);
      expect(output).toContain(`event=${event.eventId}`);
      expect(output).toContain(`--session 'own-session'`);
      expect(push.pending()).toHaveLength(1);
      push.acknowledge(event.eventId, 'own-session');
      expect(push.pending()).toEqual([]);
      expect(hasClaudeWakeWaiter(push.root, 'own-session')).toBe(false);
    } finally {
      // Only this fixture's child; the timeout bounds recovery even on failure.
      if (child.exitCode === null) child.kill('SIGTERM');
      await done;
    }
  });

  it('doctor checks wake capability without creating an engine store', () => {
    const f = fixture();
    expect(integrate('install', 'claude', join(f.home, '.claude'), f.env).status).toBe(0);
    expect(existsSync(f.env.FC_HOME!)).toBe(false);
    expect(doctorSessionIntegration('claude', f.project, packageRoot, f.env).status).toBe('ok');
    expect(existsSync(f.env.FC_HOME!)).toBe(false);
  });

  it.each(['Stop', 'Wake'])('an unrelated session exits before starting the CLI for %s and never reads the registry', event => {
    const f = fixture();
    const root = join(f.home, '.claude');
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    const registry = new TaskRegistry({ baseDir: f.env.FC_HOME });
    registry.create({ projectDir: f.project, launcher: {
      frontend: 'claude', sessionId: 'other-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    // An unreadable registry and unavailable CLI would both fail if visited.
    rmSync(registry.registryPath);
    mkdirSync(registry.registryPath);
    const hook = join(root, 'hooks', 'flowcrew-session.mjs');
    writeFileSync(hook, readFileSync(hook, 'utf8').replace(JSON.stringify(join(packageRoot, 'dist', 'cli.js')), JSON.stringify(join(f.root, 'missing-cli.js'))));
    const result = command(process.execPath, [hook, event], f.env, JSON.stringify({ session_id: 'own-session' }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('');
  });

  it('keeps standalone fc_tasks entries visible in an otherwise idle session statusline', () => {
    const f = fixture();
    const root = join(f.home, '.claude');
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    const ledgerRoot = join(f.root, 'ledger');
    createTaskEntry({ storeRoot: ledgerRoot, session: 'own-session', entry: {
      id: 'personal', subject: 'Independent ledger work', description: '', activeForm: 'Working independently',
      status: 'in_progress', blocks: [], blockedBy: [],
    } });
    const result = command(process.execPath, [join(root, 'hooks', 'flowcrew-session.mjs'), '--statusline'],
      { ...f.env, FC_TASKS_ROOT: ledgerRoot }, JSON.stringify({ session_id: 'own-session' }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Working independently');
  });

  it('bootstraps legacy launcher rows before allowing an own session to stop, without a daemon', () => {
    const f = fixture();
    const root = join(f.home, '.claude');
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    new TaskRegistry({ baseDir: f.env.FC_HOME }).create({ projectDir: f.project, launcher: {
      frontend: 'claude', sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    // Partial bootstrap (directory exists, completion marker does not) is legacy state too.
    rmSync(join(f.env.FC_HOME, 'session-push', 'task-index'), { recursive: true });
    mkdirSync(join(f.env.FC_HOME, 'session-push', 'task-index'));
    const hook = join(root, 'hooks', 'flowcrew-session.mjs');
    const result = command(process.execPath, [hook, 'Stop'], f.env, JSON.stringify({ session_id: 'own-session' }));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe('block');
    expect(existsSync(join(f.env.FC_HOME, 'session-push', 'task-index', 'ready'))).toBe(true);
    writeFileSync(hook, readFileSync(hook, 'utf8').replace(JSON.stringify(join(packageRoot, 'dist', 'cli.js')), JSON.stringify(join(f.root, 'missing-cli.js'))));
    const unrelated = command(process.execPath, [hook, 'Stop'], f.env, JSON.stringify({ session_id: 'unrelated' }));
    expect(unrelated.status, unrelated.stderr).toBe(0);
    expect(unrelated.stdout).toBe('');
  });

  it('a pending event still starts the CLI even when its task index is absent', () => {
    const f = fixture();
    const root = join(f.home, '.claude');
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    const registry = new TaskRegistry({ baseDir: f.env.FC_HOME });
    const task = registry.create({ projectDir: f.project, launcher: {
      frontend: 'claude', sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    const push = new SessionPush(registry);
    push.enqueue(task, { type: 'operator_wrap_up_required', runId: 'fixture-run', timestamp: new Date().toISOString() });
    rmSync(join(push.root, 'task-index'), { recursive: true });
    const result = command(process.execPath, [join(root, 'hooks', 'flowcrew-session.mjs'), 'Stop'], f.env, JSON.stringify({ session_id: 'own-session' }));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe('block');
  });

  it.each(['Stop', 'Wake'])('missing CLI errors fail closed for the installed %s hook', event => {
    const f = fixture();
    const root = join(f.home, '.claude');
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    new TaskRegistry({ baseDir: f.env.FC_HOME }).create({ projectDir: f.project, launcher: {
      frontend: 'claude', sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    const path = join(root, 'hooks', 'flowcrew-session.mjs');
    writeFileSync(path, readFileSync(path, 'utf8').replace(JSON.stringify(join(packageRoot, 'dist', 'cli.js')), JSON.stringify(join(f.root, 'missing-cli.js'))));
    const result = command(process.execPath, [path, event], f.env, JSON.stringify({ session_id: 'own-session' }));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing-cli.js');
  });

  it('upgrades pre-wake installations in place, preserves inbound policy, and repairs hook drift', () => {
    const f = fixture();
    const root = join(f.home, '.claude');
    mkdirSync(root, { recursive: true });
    const path = join(root, 'settings.json');
    const original = { crossSessionInbound: 'refuse', permissions: { defaultMode: 'bypassPermissions' }, hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }],
    }, statusLine: { type: 'command', command: 'user-status' } };
    writeFileSync(path, JSON.stringify(original));
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    const legacy = JSON.parse(readFileSync(path, 'utf8'));
    legacy.hooks.Stop = legacy.hooks.Stop.filter((group: { hooks: { asyncRewake?: boolean }[] }) => !group.hooks.some(hook => hook.asyncRewake));
    writeFileSync(path, JSON.stringify(legacy));
    expect(doctorSessionIntegration('claude', f.project, packageRoot, f.env)).toMatchObject({ status: 'warn', message: expect.stringContaining('missing or outdated asyncRewake hook') });
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    expect(doctorSessionIntegration('claude', f.project, packageRoot, f.env).status).toBe('ok');
    const installed = JSON.parse(readFileSync(path, 'utf8'));
    expect(installed.crossSessionInbound).toBe('refuse');
    expect(installed.permissions).toEqual(original.permissions);
    installed.hooks.Stop.find((group: { hooks: { asyncRewake?: boolean }[] }) => group.hooks.some(hook => hook.asyncRewake)).hooks[0].timeout = 5;
    writeFileSync(path, JSON.stringify(installed));
    expect(doctorSessionIntegration('claude', f.project, packageRoot, f.env).message).toContain('--claude --global');
    expect(integrate('remove', 'claude', root, f.env).status).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(original);
  });

  it.each(['2.1.287 (Claude Code)', 'unknown'])('doctor reports unsupported Claude %s and the installed hook retains foreground blocking', version => {
    const f = fixture();
    writeFileSync(join(f.bin, 'claude'), `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`);
    const root = join(f.home, '.claude');
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    expect(doctorSessionIntegration('claude', f.project, packageRoot, f.env)).toMatchObject({ status: 'warn', message: expect.stringContaining('claude update') });
    const task = new TaskRegistry({ baseDir: f.env.FC_HOME }).create({ projectDir: f.project, status: 'running', launcher: {
      frontend: 'claude', sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    expect(task.id).toBeGreaterThan(0);
    const hook = join(root, 'hooks', 'flowcrew-session.mjs');
    const input = JSON.stringify({ session_id: 'own-session' });
    expect(command(process.execPath, [hook, 'Wake'], f.env, input).status).toBe(0);
    expect(JSON.parse(command(process.execPath, [hook, 'Stop'], f.env, input).stdout).decision).toBe('block');
  });

  it.each(['claude', 'codex'])('merges %s hooks idempotently, preserves adjacent hooks and restores the status line on uninstall', frontend => {
    const f = fixture();
    const root = frontend === 'claude' ? join(f.home, '.claude') : f.codexHome;
    mkdirSync(root, { recursive: true });
    const path = join(root, frontend === 'claude' ? 'settings.json' : 'hooks.json');
    const old = { hooks: { Stop: [{ matcher: 'existing', hooks: [{ type: 'command', command: 'existing-hook' }] }] }, custom: true, statusLine: { type: 'command', command: 'printf existing' } };
    writeFileSync(path, JSON.stringify(old));
    expect(integrate('install', frontend, root, f.env).status).toBe(0);
    const once = readFileSync(path, 'utf8');
    const shim = readFileSync(join(root, 'hooks', 'flowcrew-session.mjs'), 'utf8');
    expect(integrate('install', frontend, root, f.env).status).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(once);
    expect(readFileSync(join(root, 'hooks', 'flowcrew-session.mjs'), 'utf8')).toBe(shim);
    const installed = JSON.parse(once);
    expect(installed.hooks.Stop).toHaveLength(frontend === 'claude' ? 3 : 2);
    expect(installed.hooks.Stop[0]).toEqual(old.hooks.Stop[0]);
    expect(installed.hooks.SessionStart).toHaveLength(frontend === 'claude' ? 2 : 1);
    if (frontend === 'codex') {
      expect(integrate('check', frontend, root, f.env).status).toBe(1);
      fixtureTrust(root, f.codexHome);
    }
    expect(integrate('check', frontend, root, f.env).status).toBe(0);
    expect(integrate('remove', frontend, root, f.env).status).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(old);
    expect(existsSync(join(root, 'hooks', 'flowcrew-session.mjs'))).toBe(false);
    expect(integrate('remove', frontend, root, f.env).status).toBe(0);
  });

  it('runs through FlowCrew install.sh for a detected CLI using only a temporary home', () => {
    const f = fixture();
    const fake = join(f.bin, 'claude');
    writeFileSync(fake, `#!${process.execPath}\nconsole.log('2.1.308 (Claude Code)');\n`);
    chmodSync(fake, 0o755);
    const result = command('/bin/bash', [installer, '--claude', '--global'], f.env);
    expect(result.status, result.stderr).toBe(0);
    const root = join(f.home, '.claude');
    expect(existsSync(join(root, 'skills', 'ship', 'SKILL.md'))).toBe(true);
    expect(integrate('check', 'claude', root, f.env).status).toBe(0);
    const uninstalled = command('/bin/bash', [installer, '--claude', '--global', '--uninstall'], f.env);
    expect(uninstalled.status, uninstalled.stderr).toBe(0);
    expect(existsSync(join(root, 'skills', 'ship', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(root, 'hooks', 'flowcrew-session.mjs'))).toBe(false);
  });

  it('detects missing, outdated, removed and modified hooks with an exact repair command', () => {
    const f = fixture();
    expect(doctorSessionIntegration('codex', f.project, packageRoot, f.env)).toMatchObject({ status: 'warn', message: expect.stringContaining('--codex --global') });
    expect(integrate('install', 'codex', f.codexHome, f.env).status).toBe(0);
    fixtureTrust(f.codexHome, f.codexHome);
    expect(doctorSessionIntegration('codex', f.project, packageRoot, f.env).status).toBe('ok');
    writeFileSync(join(f.codexHome, 'hooks', 'flowcrew-session.mjs'), '// outdated');
    expect(doctorSessionIntegration('codex', f.project, packageRoot, f.env)).toMatchObject({ status: 'warn', message: expect.stringContaining('outdated shared hook') });
    expect(integrate('install', 'codex', f.codexHome, f.env).status).toBe(0);
    writeFileSync(join(f.codexHome, 'hooks.json'), JSON.stringify({ hooks: {} }));
    expect(doctorSessionIntegration('codex', f.project, packageRoot, f.env).message).toContain('missing Stop hook');
  });

  it('enrolls only its Codex hashes through native config edits, preserves other trust, and removes its own trust on uninstall', () => {
    const f = fixture();
    const executable = join(f.bin, 'codex');
    writeFileSync(executable, [
      `#!${process.execPath}`,
      "import { createInterface } from 'node:readline';",
      "import { join } from 'node:path';",
      `import { fakeCodexHookRequest } from ${JSON.stringify(new URL('./test-support/fake-codex-hooks.mjs', import.meta.url).href)};`,
      'for await (const line of createInterface({ input: process.stdin })) {',
      ' const request = JSON.parse(line);',
      ' if (!request.id) continue;',
      " const result = request.method === 'skills/list' ? { data: [{ skills: ['ship', 'fc-status'].map(name => ({ name, path: join(process.env.HOME, '.agents', 'skills', name, 'SKILL.md'), enabled: true })) }] } : fakeCodexHookRequest(request, process.env.CODEX_HOME, process.env.HOME) || {};",
      " console.log(JSON.stringify({ id: request.id, result }));",
      '}',
    ].join('\n'));
    chmodSync(executable, 0o755);
    const other = '[hooks.state."other-hook"]\ntrusted_hash = "other-trusted-hash"\n';
    writeFileSync(join(f.codexHome, 'config.toml'), other);
    const result = command('/bin/bash', [installer, '--codex', '--global'], f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('trusts only the two installed FlowCrew hook definitions');
    expect(readFileSync(join(f.codexHome, 'config.toml'), 'utf8')).toContain(other);
    expect(doctorSessionIntegration('codex', f.project, packageRoot, f.env).status).toBe('ok');
    const removed = command('/bin/bash', [installer, '--codex', '--global', '--uninstall'], f.env);
    expect(removed.status, removed.stderr).toBe(0);
    expect(readFileSync(join(f.codexHome, 'config.toml'), 'utf8').trim()).toBe(other.trim());
  });

  it.each(['neighbor', 'timeout', 'disabled', 'unavailable'])('doctor rejects current native Codex hook drift (%s) without changing configuration', drift => {
    const f = fixture();
    expect(integrate('install', 'codex', f.codexHome, f.env).status).toBe(0);
    fixtureTrust(f.codexHome, f.codexHome);
    expect(doctorSessionIntegration('codex', f.project, packageRoot, f.env).status).toBe('ok');
    const path = join(f.codexHome, 'hooks.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (drift === 'neighbor') config.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'other-hook' }] });
    if (drift === 'timeout') config.hooks.Stop[0].hooks[0].timeout = 99;
    writeFileSync(path, JSON.stringify(config));
    const trustPath = join(f.codexHome, 'config.toml');
    if (drift === 'disabled') writeFileSync(trustPath, readFileSync(trustPath, 'utf8') + 'enabled = false\n');
    if (drift === 'unavailable') rmSync(join(f.bin, 'codex'));
    const before = [readFileSync(path, 'utf8'), readFileSync(trustPath, 'utf8')];
    const result = doctorSessionIntegration('codex', f.project, packageRoot, f.env);
    expect(result).toMatchObject({ status: 'warn', message: expect.stringContaining('--codex --global') });
    expect([readFileSync(path, 'utf8'), readFileSync(trustPath, 'utf8')]).toEqual(before);
    if (drift !== 'unavailable') {
      // The same installer enrollment repairs positional and definition drift.
      expect(integrate('install', 'codex', f.codexHome, f.env).status).toBe(0);
      fixtureTrust(f.codexHome, f.codexHome);
      expect(doctorSessionIntegration('codex', f.project, packageRoot, f.env).status).toBe('ok');
    }
  });

  it('refuses malformed user settings without overwriting either the config or hooks', () => {
    const f = fixture();
    writeFileSync(join(f.codexHome, 'hooks.json'), '{malformed');
    expect(integrate('install', 'codex', f.codexHome, f.env).status).not.toBe(0);
    expect(readFileSync(join(f.codexHome, 'hooks.json'), 'utf8')).toBe('{malformed');
    expect(existsSync(join(f.codexHome, 'hooks', 'flowcrew-session.mjs'))).toBe(false);
  });

  it('keeps existing status output, renders engine progress and suppresses the old monitor warning only with live delivery coverage', async () => {
    const f = fixture();
    const root = join(f.home, '.claude');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: "printf 'existing output ⚠ 轮次在跑但无 monitor'" } }));
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    const socket = join(f.root, 'inbox.sock');
    const server = createServer();
    await new Promise<void>(resolve => server.listen(socket, resolve));
    try {
      const registry = new TaskRegistry({ baseDir: f.env.FC_HOME });
      const task = registry.create({ projectDir: f.project, status: 'running', launcher: {
        frontend: 'claude', sessionId: 'own-session', cwd: f.project, socket, ledgerRoot: join(f.root, 'ledger'),
      } });
      await new SessionPush(registry).ensureDisplay(task, { status: 'running', startedAt: new Date(Date.now() - 10_000).toISOString(), stages: { work: { status: 'running' } } });
      const hook = join(root, 'hooks', 'flowcrew-session.mjs');
      const input = JSON.stringify({ session_id: 'own-session' });
      const covered = command(process.execPath, [hook, '--statusline'], f.env, input);
      expect(covered.status, covered.stderr).toBe(0);
      expect(covered.stdout).toContain('existing output');
      expect(covered.stdout).toContain('remaining unknown');
      expect(covered.stdout).not.toContain('无 monitor');
      await new Promise<void>(resolve => server.close(() => resolve()));
      const uncovered = command(process.execPath, [hook, '--statusline'], f.env, input);
      expect(uncovered.stdout).toContain('无 monitor');
    } finally {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['claude', 'codex'])('the installed %s hook reads its payload and invokes the same gate; stop_hook_active is no bypass', frontend => {
    const f = fixture();
    const root = frontend === 'claude' ? join(f.home, '.claude') : f.codexHome;
    expect(integrate('install', frontend, root, f.env).status).toBe(0);
    const hook = join(root, 'hooks', 'flowcrew-session.mjs');
    const start = command(process.execPath, [hook, 'SessionStart'], f.env, JSON.stringify({ session_id: 'own-session', hook_event_name: 'SessionStart' }));
    expect(start.status, start.stderr).toBe(0);
    const missing = command(process.execPath, [hook, 'Stop'], f.env, JSON.stringify({ hook_event_name: 'Stop' }));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('no session identifier');
    new TaskRegistry({ baseDir: f.env.FC_HOME }).create({ projectDir: f.project, status: 'running', launcher: {
      frontend: frontend as 'claude' | 'codex', sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    const stop = command(process.execPath, [hook, 'Stop'], f.env, JSON.stringify({ session_id: 'own-session', hook_event_name: 'Stop', stop_hook_active: true }));
    expect(stop.status, stop.stderr).toBe(0);
    expect(JSON.parse(stop.stdout)).toMatchObject({ decision: 'block', reason: expect.stringContaining('wrap-up is open') });
  });
});
