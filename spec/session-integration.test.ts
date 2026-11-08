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
import { hasClaudeWakeWaiter, sessionWaiterPath, wakeUnavailablePath } from '../src/session-wake.js';
import { processStartToken } from '../src/run-lock.js';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { linuxProcessStartTimeTicks, processIsAlive } from '../src/process-liveness.js';
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
  it('generates the loaded-host command limits from one installer definition', () => {
    const f = fixture();
    const root = join(f.home, '.claude');
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    const config = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(root, 'hooks', 'flowcrew-session.json'), 'utf8'));
    expect(manifest.limits).toEqual({ commandMs: 40_000, hookSeconds: 45, statusMs: 10_000, wakeMs: 3650_000, wakeSeconds: 3660 });
    for (const event of ['Stop', 'SessionStart']) {
      expect(config.hooks[event].map((group: { hooks: unknown[] }) => group.hooks[0])).toEqual([
        { type: 'command', command: `${manifest.command} ${event}`, timeout: 45 },
        { type: 'command', command: `${manifest.command} Wake`, timeout: 3660, asyncRewake: true },
      ]);
    }
    expect(config.statusLine).toEqual({ type: 'command', command: `${manifest.command} --statusline` });
    const shim = readFileSync(join(root, 'hooks', 'flowcrew-session.mjs'), 'utf8');
    expect(shim).toContain(JSON.stringify(manifest.limits));
    expect(shim).toContain('settings.limits.statusMs');
    expect(shim).toContain('settings.limits.commandMs');
    expect(shim).toContain('settings.limits.wakeMs');
  });

  it.each(['claude', 'codex'] as const)('%s generated Stop hook separates the documented human warning and model continuation; list/watch use the human text', frontend => {
    const f = fixture();
    const frontendRoot = frontend === 'claude' ? join(f.home, '.claude') : f.codexHome;
    expect(integrate('install', frontend, frontendRoot, f.env).status).toBe(0);
    const registry = new TaskRegistry({ baseDir: f.env.FC_HOME });
    const task = registry.create({ name: 'Readable task', projectDir: f.project, status: 'parked', run_id: 'fixture-run', launcher: {
      frontend, sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    const requests = join(f.env.FC_HOME!, 'runs/fixture-run/approvals'); mkdirSync(requests, { recursive: true });
    writeFileSync(join(requests, 'request.request.json'), JSON.stringify({ title: 'Download public checkpoint', target: 'huggingface.co' }));
    const push = new SessionPush(registry);
    const event = push.enqueue(task, { type: 'operator_wrap_up_required', runId: 'fixture-run', timestamp: '2026-11-06T01:23:04.190Z' })!;
    const hook = join(frontendRoot, 'hooks/flowcrew-session.mjs');
    const stop = command(process.execPath, [hook, 'Stop'], f.env, JSON.stringify({ session_id: 'own-session', hook_event_name: 'Stop' }));
    expect(stop.status, stop.stderr).toBe(0);
    const output = JSON.parse(stop.stdout);
    const evidence = process.env.PUSH_AUTH_EVIDENCE ? join(process.env.PUSH_AUTH_EVIDENCE, 'frontends', frontend) : undefined;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, 'stop.json'), JSON.stringify(output, null, 2));
      writeFileSync(join(evidence, 'installed-template.mjs'), readFileSync(hook));
    }
    // Claude: systemMessage "Warning message shown to the user."; reason
    // "Tells Claude why it should continue." (code.claude.com/docs/en/hooks).
    // Codex: systemMessage "Surfaced as a warning in the UI or event stream";
    // Stop uses reason as the continuation prompt (developers.openai.com/codex/hooks/).
    expect(output.systemMessage).toContain('Readable task: wrap-up required.');
    expect(output.systemMessage).not.toContain('flowcrew inbox');
    expect(output.systemMessage).not.toMatch(/[a-f0-9]{64}/u);
    expect(output.systemMessage).not.toContain('Read the report and run state');
    expect(output.reason).toContain(`event=${event.eventId}`);
    expect(output.reason).toContain(`FC_HOME='${f.env.FC_HOME}' flowcrew session-push ack --event ${event.eventId} --session 'own-session'`);
    expect(output.reason).toContain('Deduplicate by event id');
    for (const args of [['session-push', 'list', '--session', 'own-session'], ['watch', '--once']]) {
      const result = command(process.execPath, [join(packageRoot, 'dist/cli.js'), ...args], f.env);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(output.systemMessage);
      expect(result.stdout).not.toContain(event.eventId);
      expect(result.stdout).not.toContain('Deduplicate by event id');
      if (evidence) writeFileSync(join(evidence, args[0] === 'watch' ? 'watch.txt' : 'list.txt'), result.stdout);
    }
    const ack = command(process.execPath, [join(packageRoot, 'dist/cli.js'), 'session-push', 'ack', '--event', event.eventId, '--session', 'own-session'], f.env);
    expect(ack.status, ack.stderr).toBe(0);
    expect(push.acknowledged(event.eventId)).toBe(true);
    const observed = command(process.execPath, [join(packageRoot, 'dist/cli.js'), 'watch', '--once'], f.env);
    expect(observed.status, observed.stderr).toBe(0);
    expect(observed.stdout).not.toContain('Readable task: wrap-up required.');

  });
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
      cwd: f.project, env: { ...f.env, HOME: f.home, FC_HOME: f.env.FC_HOME }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
    });
    const done = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', () => resolve()); });
    child.stdin.end(JSON.stringify({ session_id: 'own-session' }));
    let worker: number | undefined;
    try {
      for (let i = 0; i < 500 && !hasClaudeWakeWaiter(push.root, 'own-session'); i++) await sleep(20);
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
      cwd: f.project, env: { ...f.env, HOME: f.home, FC_HOME: f.env.FC_HOME }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    child.stdin.end(input);
    try {
      for (let i = 0; i < 500 && !hasClaudeWakeWaiter(push.root, 'own-session'); i++) await sleep(20);
      expect(hasClaudeWakeWaiter(push.root, 'own-session'), output).toBe(true);
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
  }, 60_000);

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

  it('reports legacy views to the operator on every call and lets a service writer rebuild them before reads resume', () => {
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
    expect(JSON.parse(result.stdout)).toEqual({ systemMessage: expect.stringContaining('Session task view unavailable') });
    expect(existsSync(join(f.env.FC_HOME, 'session-push', 'task-index', 'ready'))).toBe(false);
    expect(JSON.parse(command(process.execPath, [hook, 'Stop'], f.env, JSON.stringify({ session_id: 'own-session' })).stdout)).toEqual(JSON.parse(result.stdout));
    new TaskRegistry({ baseDir: f.env.FC_HOME }).ensureSessionTaskIndexes();
    expect(JSON.parse(command(process.execPath, [hook, 'Stop'], f.env, JSON.stringify({ session_id: 'own-session' })).stdout).decision).toBe('block');
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

  it.each(['Stop', 'Wake'])('a missing CLI is shown to the operator on every %s and never blocks the model', event => {
    const f = fixture();
    const root = join(f.home, '.claude');
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    new TaskRegistry({ baseDir: f.env.FC_HOME }).create({ projectDir: f.project, launcher: {
      frontend: 'claude', sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    const path = join(root, 'hooks', 'flowcrew-session.mjs');
    writeFileSync(path, readFileSync(path, 'utf8').replace(JSON.stringify(join(packageRoot, 'dist', 'cli.js')), JSON.stringify(join(f.root, 'missing-cli.js'))));
    for (let call = 0; call < 2; call++) {
      const result = command(process.execPath, [path, event], f.env, JSON.stringify({ session_id: 'own-session' }));
      expect(result.status).toBe(0); // a non-blocking exit: no loop of model turns
      if (event === 'Stop') {
        expect(JSON.parse(result.stdout)).toEqual({ systemMessage: expect.stringContaining('missing-cli.js') });
        expect(result.stderr).toBe('');
      } else {
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('missing-cli.js');
      }
    }
    expect(existsSync(join(f.env.FC_HOME, 'session-push', 'integration-errors'))).toBe(false);
  });

  it('a disabled or missing wake hook is shown to the operator on every call, is never asked of the model, and a pending event still blocks', () => {
    const f = fixture();
    const root = join(f.home, '.claude');
    expect(integrate('install', 'claude', root, f.env).status).toBe(0);
    const configPath = join(root, 'settings.json');
    const original = readFileSync(configPath, 'utf8');
    const config = JSON.parse(original);
    const registry = new TaskRegistry({ baseDir: f.env.FC_HOME });
    const task = registry.create({ projectDir: f.project, status: 'running', launcher: {
      frontend: 'claude', sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    const hook = join(root, 'hooks', 'flowcrew-session.mjs');
    const input = JSON.stringify({ session_id: 'own-session' });
    for (const event of ['Stop', 'SessionStart']) {
      config.hooks[event] = config.hooks[event].filter((group: { hooks: { asyncRewake?: boolean }[] }) => !group.hooks.some(hook => hook.asyncRewake));
    }
    writeFileSync(configPath, JSON.stringify(config));
    const gate = (event: string) => JSON.parse(command(process.execPath, [hook, event], f.env, input).stdout);
    const disabled = { systemMessage: expect.stringContaining('async wake hook is disabled or missing') };
    // Coverage that cannot be registered is not renewable: operator notice only, on each call.
    for (let call = 0; call < 2; call++) expect(gate('Stop')).toEqual(disabled);
    const event = new SessionPush(registry).enqueue(task, { type: 'operator_wrap_up_required', runId: 'fixture-run', timestamp: new Date().toISOString() })!;
    const withEvent = gate('Stop');
    expect(withEvent).toMatchObject({ decision: 'block', reason: expect.stringContaining(event.eventId), ...disabled });
    expect(withEvent.reason).not.toContain('disabled or missing');
    const wake = command(process.execPath, [hook, 'Wake'], f.env, input);
    expect(wake.status).toBe(0);
    expect(wake.stderr).toContain('async wake hook is disabled or missing');
    writeFileSync(configPath, original);
    expect(gate('Stop').systemMessage).not.toContain('disabled or missing');
  }, 60_000);

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

  it.each(['2.1.287 (Claude Code)', 'unknown'])('doctor and the installed hook report unsupported Claude %s without an empty-turn loop', version => {
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
    const wake = command(process.execPath, [hook, 'Wake'], f.env, input);
    expect(wake.status).toBe(0);
    expect(wake.stderr).toContain('wake requires');
    const warning = JSON.parse(command(process.execPath, [hook, 'Stop'], f.env, input).stdout);
    expect(warning).toEqual({ systemMessage: expect.stringContaining('unsupported_version') });
    // Shown again on each Stop while the condition lasts, still without a decision or reason.
    expect(JSON.parse(command(process.execPath, [hook, 'Stop'], f.env, input).stdout)).toEqual(warning);
  });

  describe('wake coverage that cannot be registered', () => {
    // Faults are injected into the wake CLI only (never the Stop CLI), by a preload the generated shim passes on.
    const preload = [
      "import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';",
      "const kind = process.env.FIXTURE_FAIL;",
      "if (/cli\\.js$/u.test(process.argv[1] || '')) {",
      "  const deny = () => Object.assign(new Error('fixture fault'), { code: 'EACCES' });",
      "  if (kind === 'crash') process.exit(7);",
      "  const read = fs.readFileSync, mkdir = fs.mkdirSync, link = fs.linkSync;",
      "  if (kind === 'identity') fs.readFileSync = function(path, ...args) { if (String(path).endsWith('/boot_id')) throw deny(); return read.call(this, path, ...args); };",
      "  if (kind === 'register') fs.mkdirSync = function(path, ...args) { if (String(path).endsWith('/waiters')) throw deny(); return mkdir.call(this, path, ...args); };",
      "  if (kind === 'lock') fs.linkSync = function(from, to, ...args) { if (String(to).endsWith('tasks.lock')) throw deny(); return link.call(this, from, to, ...args); };",
      "  syncBuiltinESMExports();",
      "}",
    ].join('\n');
    const setup = () => {
      const f = fixture();
      const root = join(f.home, '.claude');
      expect(integrate('install', 'claude', root, f.env).status).toBe(0);
      new TaskRegistry({ baseDir: f.env.FC_HOME }).create({ projectDir: f.project, status: 'running', launcher: {
        frontend: 'claude', sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
      } });
      const file = join(f.root, 'fail-preload.mjs');
      writeFileSync(file, preload);
      const push = join(f.env.FC_HOME, 'session-push');
      return { f, root, push, hook: join(root, 'hooks', 'flowcrew-session.mjs'), input: JSON.stringify({ session_id: 'own-session' }),
        failing: (kind: string) => ({ ...f.env, NODE_OPTIONS: `--import ${pathToFileURL(file).href}`, FIXTURE_FAIL: kind }) };
    };
    const claude = (f: ReturnType<typeof fixture>, version: string) => writeFileSync(join(f.bin, 'claude'), `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`);
    const cases: { code: string; kind: string; arrange?: (s: ReturnType<typeof setup>) => { heal: () => void } }[] = [
      { code: 'unsupported_version', kind: 'none', arrange: s => { claude(s.f, '2.1.287 (Claude Code)'); return { heal: () => claude(s.f, '2.1.308 (Claude Code)') }; } },
      { code: 'identity_unavailable', kind: 'identity' },
      { code: 'registration_failed', kind: 'register' },
      { code: 'lock_unavailable', kind: 'lock' },
      { code: 'wake_cli_failed', kind: 'crash' },
      { code: 'owner_unverifiable', kind: 'none', arrange: s => {
        // A live lease owner whose host is gone: neither stale nor a verifiable waiter.
        const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
        const start = processStartToken(owner.pid!);
        mkdirSync(join(s.push, 'waiters'), { recursive: true });
        const path = sessionWaiterPath(s.push, 'own-session');
        writeFileSync(path, JSON.stringify({ pid: owner.pid, processStartTime: linuxProcessStartTimeTicks(owner.pid!), token: 'fixture-owner', session: 'own-session', start,
          host: Number(gone.stdout), hostStart: start, expiresAt: Date.now() + 3_600_000, bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }));
        return { heal: () => { owner.kill('SIGKILL'); rmSync(path); } };
      } },
    ];
    it.each(cases.filter(c => process.platform === 'linux' || !['identity_unavailable', 'owner_unverifiable'].includes(c.code)))('a $code wake never makes three Stops block, names the code each time, and a later registration restores renewal', async ({ code, kind, arrange }) => {
      const s = setup();
      const spawned: ReturnType<typeof spawn>[] = [];
      try {
        const armed = arrange?.(s);
        const wake = command(process.execPath, [s.hook, 'Wake'], kind === 'none' ? s.f.env : s.failing(kind), s.input);
        expect(wake.status, wake.stderr).toBe(0);
        expect(JSON.parse(readFileSync(wakeUnavailablePath(s.push, 'own-session'), 'utf8'))).toMatchObject({ reason: code });
        for (let call = 0; call < 3; call++) {
          const stop = command(process.execPath, [s.hook, 'Stop'], s.f.env, s.input);
          expect(stop.status, stop.stderr).toBe(0);
          const verdict = JSON.parse(stop.stdout);
          expect(verdict.decision).toBeUndefined();
          expect(verdict.reason).toBeUndefined();
          expect(verdict.systemMessage).toContain(code);
        }
        armed?.heal();
        // A healthy wake registers a waiter: the fact is deleted and the session is covered.
        const healthy = spawn(process.execPath, [s.hook, 'Wake'], { env: s.f.env, stdio: ['pipe', 'ignore', 'ignore'] });
        spawned.push(healthy);
        healthy.stdin!.end(s.input);
        for (let i = 0; i < 300 && !(existsSync(sessionWaiterPath(s.push, 'own-session')) && hasClaudeWakeWaiter(s.push, 'own-session') && !existsSync(wakeUnavailablePath(s.push, 'own-session'))); i++) await sleep(50);
        expect(hasClaudeWakeWaiter(s.push, 'own-session')).toBe(true);
        expect(existsSync(wakeUnavailablePath(s.push, 'own-session'))).toBe(false);
        expect(command(process.execPath, [s.hook, 'Stop'], s.f.env, s.input).stdout).toBe('');
        // Coverage gone with the fact gone: the gate asks for renewal again.
        healthy.kill('SIGKILL');
        process.kill(JSON.parse(readFileSync(sessionWaiterPath(s.push, 'own-session'), 'utf8')).pid, 'SIGKILL');
        for (let i = 0; i < 100 && hasClaudeWakeWaiter(s.push, 'own-session'); i++) await sleep(50);
        const renewal = JSON.parse(command(process.execPath, [s.hook, 'Stop'], s.f.env, s.input).stdout);
        expect(renewal).toMatchObject({ decision: 'block', reason: expect.stringContaining('must be renewed') });
      } finally { for (const child of spawned) child.kill('SIGKILL'); }
    }, 90_000);

    it('a disabled wake hook is named hook_disabled on three Stops without blocking, and enabling it restores renewal', () => {
      const s = setup();
      const configPath = join(s.root, 'settings.json');
      const original = readFileSync(configPath, 'utf8');
      const config = JSON.parse(original);
      config.disableAllHooks = true;
      writeFileSync(configPath, JSON.stringify(config));
      for (let call = 0; call < 3; call++) {
        const verdict = JSON.parse(command(process.execPath, [s.hook, 'Stop'], s.f.env, s.input).stdout);
        expect(verdict).toEqual({ systemMessage: expect.stringContaining('hook_disabled') });
      }
      writeFileSync(configPath, original);
      expect(JSON.parse(command(process.execPath, [s.hook, 'Stop'], s.f.env, s.input).stdout)).toMatchObject({ decision: 'block', reason: expect.stringContaining('must be renewed') });
    }, 60_000);
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

  it('renders scoped engine progress and saves the previous status definition for restoration without executing it', async () => {
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
      expect(covered.stdout).not.toContain('existing output');
      expect(JSON.parse(readFileSync(join(root, 'hooks', 'flowcrew-session.json'), 'utf8')).previousStatusLine.command).toContain('existing output');
      expect(covered.stdout).toContain('remaining unknown');
      expect(covered.stdout).not.toContain('无 monitor');
      await new Promise<void>(resolve => server.close(() => resolve()));
      const uncovered = command(process.execPath, [hook, '--statusline'], f.env, input);
      expect(uncovered.stdout).not.toContain('无 monitor');
      expect(uncovered.stdout).toContain('push target unavailable');
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
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout)).toEqual({ systemMessage: expect.stringContaining('no session identifier') });
    expect(missing.stderr).toBe('');
    const registry = new TaskRegistry({ baseDir: f.env.FC_HOME });
    const task = registry.create({ projectDir: f.project, status: 'running', launcher: {
      frontend: frontend as 'claude' | 'codex', sessionId: 'own-session', cwd: f.project, ledgerRoot: join(f.root, 'ledger'),
    } });
    new SessionPush(registry).enqueue(task, { type: 'operator_wrap_up_required', runId: 'fixture-run', timestamp: new Date().toISOString() });
    const stop = command(process.execPath, [hook, 'Stop'], f.env, JSON.stringify({ session_id: 'own-session', hook_event_name: 'Stop', stop_hook_active: true }));
    expect(stop.status, stop.stderr).toBe(0);
    expect(JSON.parse(stop.stdout)).toMatchObject({ decision: 'block', reason: expect.stringContaining('wrap-up is open') });
  });
});
