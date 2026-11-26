import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = join(import.meta.dirname, '../..');
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
    'for await (const line of createInterface({ input: process.stdin })) {',
    ' const request = JSON.parse(line); if (!request.id) continue;',
    ' console.log(JSON.stringify({ id: request.id, result: {} }));',
    '}',
  ].join('\n'));
  chmodSync(join(bin, 'codex'), 0o755);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nconsole.log('2.1.308 (Claude Code)');\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(join(home, 'runner.mjs'), [
    "import { spawnSync } from 'node:child_process';",
    "import { readFileSync } from 'node:fs';",
    'const [file, ...args] = process.argv.slice(2);',
    "const result = spawnSync(file, args, { env: process.env, input: readFileSync(0), encoding: 'utf8', timeout: 26 * 60_000, killSignal: 'SIGKILL' });",
    "process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || result.error?.message || '');",
    'process.exit(result.status ?? 1);',
  ].join('\n'));
  return { root, home, codexHome, project, bin, env };
}
function command(file: string, args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(process.execPath, [join(env.HOME!, 'runner.mjs'), file, ...args], {
    cwd: packageRoot, env: { ...env, HOME: env.HOME, FC_HOME: env.FC_HOME }, input, encoding: 'utf8', timeout: 26 * 60_000, killSignal: 'SIGKILL',
  });
}
function integrate(action: string, frontend: string, root: string, env: NodeJS.ProcessEnv) {
  return command(process.execPath, [integration, action, frontend, root, packageRoot], env);
}
describe('installer configuration ownership', () => {
  it('installs Codex skills without creating a second session integration or editing hook trust', () => {
    const f = fixture();
    const executable = join(f.bin, 'codex');
    writeFileSync(executable, [
      `#!${process.execPath}`,
      "import { createInterface } from 'node:readline';",
      "import { join } from 'node:path';",
      'for await (const line of createInterface({ input: process.stdin })) {',
      ' const request = JSON.parse(line);',
      ' if (!request.id) continue;',
      " const result = request.method === 'skills/list' ? { data: [{ skills: ['ship', 'fc-status'].map(name => ({ name, path: join(process.env.HOME, '.agents', 'skills', name, 'SKILL.md'), enabled: true })) }] } : {};",
      " console.log(JSON.stringify({ id: request.id, result }));",
      '}',
    ].join('\n'));
    chmodSync(executable, 0o755);
    const other = '[hooks.state."other-hook"]\ntrusted_hash = "other-trusted-hash"\n';
    writeFileSync(join(f.codexHome, 'config.toml'), other);
    const result = command('/bin/bash', [installer, '--codex', '--global'], f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('skills/list enumerated');
    expect(existsSync(join(f.codexHome, 'hooks.json'))).toBe(false);
    expect(existsSync(join(f.codexHome, 'hooks'))).toBe(false);
    expect(readFileSync(join(f.codexHome, 'config.toml'), 'utf8')).toContain(other);
    const removed = command('/bin/bash', [installer, '--codex', '--global', '--uninstall'], f.env);
    expect(removed.status, removed.stderr).toBe(0);
    expect(readFileSync(join(f.codexHome, 'config.toml'), 'utf8').trim()).toBe(other.trim());
  });

  it('refuses malformed user settings without overwriting either the config or hooks', () => {
    const f = fixture();
    writeFileSync(join(f.home, 'settings.json'), '{malformed');
    expect(integrate('install', 'claude', f.home, f.env).status).not.toBe(0);
    expect(readFileSync(join(f.home, 'settings.json'), 'utf8')).toBe('{malformed');
    expect(existsSync(join(f.codexHome, 'hooks', 'flowcrew-session.mjs'))).toBe(false);
  });

});

it('registers and upgrades the standalone Claude Wake timeout without duplicating hooks or changing user settings', () => {
  const f = fixture(), copy = join(f.root, 'package');
  mkdirSync(join(copy, 'dist-rewrite'), { recursive: true });
  writeFileSync(join(copy, 'dist-rewrite', 'cli.js'), 'throw Error("check must not invoke the CLI")');
  writeFileSync(join(copy, 'dist-rewrite', 'flowcrew-session.mjs'), 'throw Error("check must not run a hook")');
  const settings = { statusLine: { type: 'command', command: 'user-status' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } };
  writeFileSync(join(f.home, 'settings.json'), JSON.stringify(settings));
  const run = action => command(process.execPath, [integration, action, 'claude', f.home, copy], f.env);
  for (const action of ['install', 'install', 'check']) { const result = run(action); expect(result.status, result.stderr).toBe(0); }
  const config = JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8'));
  expect(config.statusLine).toEqual(settings.statusLine);
  expect(config.hooks.Stop).toHaveLength(3);
  for (const event of ['Stop', 'SessionStart']) {
    const wakes = config.hooks[event].flatMap(group => group.hooks).filter(handler => handler.asyncRewake);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].timeout).toBe(86400);
  }
  // Reproduce v0.12.0 registrations: same owned command, no explicit timeout.
  const legacy = JSON.parse(JSON.stringify(config));
  for (const event of ['Stop', 'SessionStart'])
    for (const group of legacy.hooks[event]) for (const handler of group.hooks)
      if (handler.asyncRewake) delete handler.timeout;
  writeFileSync(join(f.home, 'settings.json'), JSON.stringify(legacy));
  expect(run('check').status).toBe(1);
  for (const action of ['install', 'install', 'check']) {
    const result = run(action); expect(result.status, result.stderr).toBe(0);
  }
  expect(JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8'))).toEqual(config);
  expect(JSON.stringify(config)).toContain('dist-rewrite');
  expect(JSON.stringify(config)).not.toContain('session-push');
  expect(existsSync(join(f.home, 'hooks'))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.home, 'flowcrew-session.json'), 'utf8'))).toEqual({
    storeRoots: [join(f.env.FC_HOME!, 'store')], tasksRoot: join(f.home, 'tasks') });
  const removed = run('remove'); expect(removed.status, removed.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8'))).toEqual(settings);
});

it('keeps each frontend configuration through package rebuild/replacement and runs the registered hook', () => {
  const f = fixture(), copy = join(f.root, "package with ' quote"), dist = join(copy, 'dist-rewrite');
  const replace = () => {
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    cpSync(join(packageRoot, 'dist-rewrite', 'flowcrew-session.mjs'), join(dist, 'flowcrew-session.mjs'));
    writeFileSync(join(dist, 'cli.js'), 'throw Error("must not run the CLI")');
  };
  replace();
  const run = action => command(process.execPath, [integration, action, 'claude', f.home, copy], f.env);
  expect(run('install').status).toBe(0);
  const configPath = join(f.home, 'flowcrew-session.json');
  expect(existsSync(configPath)).toBe(true);
  const config = { storeRoots: [join(f.root, 'custom-store')], tasksRoot: join(f.root, 'custom-tasks') };
  writeFileSync(configPath, JSON.stringify(config));
  replace();
  expect(run('check').status).toBe(0);
  expect(run('install').status).toBe(0);
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(config);
  expect(existsSync(join(dist, 'flowcrew-session.json'))).toBe(false);
  const settings = JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8'));
  const hook = command('/bin/sh', ['-c', settings.hooks.Stop[0].hooks[0].command], { ...f.env, PATH: `${f.env.PATH}${delimiter}/usr/bin` }, '{"session_id":"SurvivesUpgrade"}');
  expect(hook.status, hook.stderr).toBe(0);
  expect(hook.stderr).toBe('');
  expect(existsSync(join(config.tasksRoot, 'SurvivesUpgrade', '.flowcrew-state'))).toBe(true);
});

// Closed installer grammar from 376be84 (shared shim) and 8448e99 (packaged hook).
it.each(['install', 'remove'])('retires every historical hook/status command on %s without matching user lookalikes', action => {
  const f = fixture();
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const bases = [
    `${quote(process.execPath)} ${quote(join(f.home, 'hooks', 'flowcrew-session.mjs'))}`,
    `nice -n 19 ${quote(process.execPath)} ${quote(join(packageRoot, 'dist-rewrite', 'flowcrew-session.mjs'))}`,
  ];
  const old = bases.flatMap(base => ['Stop', 'SessionStart', 'Wake', '--statusline'].map(event => `${base} ${event}`));
  const user = old.map(command => ({ type: 'command', command: command + ' --user' }));
  for (const statusCommand of bases.map(base => `${base} --statusline`)) {
    const settings = { hooks: Object.fromEntries(['Stop', 'SessionStart'].map(event => [event,
      [{ matcher: '*', hooks: [...old.map(command => ({ type: 'command', command })), ...user] }]])),
      statusLine: { type: 'command', command: statusCommand } };
    writeFileSync(join(f.home, 'settings.json'), JSON.stringify(settings));
    const result = integrate(action, 'claude', f.home, f.env);
    expect(result.status, result.stderr).toBe(0);
    const after = JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8'));
    for (const event of ['Stop', 'SessionStart']) {
      expect(after.hooks[event][0]).toEqual({ matcher: '*', hooks: user });
      expect(after.hooks[event]).toHaveLength(action === 'install' ? 3 : 1);
    }
    if (action === 'remove') expect(after.statusLine).toBeUndefined();
    else expect(old).not.toContain(after.statusLine.command);
  }
});


it.each(['install', 'remove'])('uses the recorded command from another Node installation on %s, without guessing other commands', action => {
  const f = fixture();
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const recorded = `${quote('/opt/previous-node/bin/node')} ${quote(join(f.home, 'hooks', 'flowcrew-session.mjs'))}`;
  const guessed = `${quote(process.execPath)} ${quote(join(f.home, 'hooks', 'flowcrew-session.mjs'))} Stop`;
  const old = ['Stop', 'SessionStart', 'Wake', '--statusline'].map(event => `${recorded} ${event}`);
  const user = [...old.map(command => ({ type: 'command', command: command + ' --user' })), { type: 'command', command: guessed }];
  mkdirSync(join(f.home, 'hooks'));
  writeFileSync(join(f.home, 'hooks', 'flowcrew-session.json'), JSON.stringify({ command: recorded }));
  writeFileSync(join(f.home, 'settings.json'), JSON.stringify({
    hooks: Object.fromEntries(['Stop', 'SessionStart'].map(event => [event,
      [{ matcher: '*', hooks: [...old.map(command => ({ type: 'command', command })), ...user] }]])),
    statusLine: { type: 'command', command: `${recorded} --statusline` },
  }));
  const result = integrate(action, 'claude', f.home, f.env);
  expect(result.status, result.stderr).toBe(0);
  const after = JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8'));
  for (const event of ['Stop', 'SessionStart']) {
    expect(after.hooks[event][0]).toEqual({ matcher: '*', hooks: user });
    expect(after.hooks[event]).toHaveLength(action === 'install' ? 3 : 1);
  }
  if (action === 'remove') expect(after.statusLine).toBeUndefined();
  else expect(old).not.toContain(after.statusLine.command);
});

it.each(['remove', 'install-remove', 'install-user-edit-remove'])('returns the old installer’s saved user status line through %s', sequence => {
  const f = fixture();
  const recorded = `'${process.execPath}' '${join(f.home, 'hooks', 'flowcrew-session.mjs')}'`;
  const original = { type: 'command', command: 'user-status --full', padding: 3, extra: { preserved: true } };
  const edited = { type: 'command', command: 'new-user-status', padding: 7 };
  mkdirSync(join(f.home, 'hooks'));
  writeFileSync(join(f.home, 'hooks', 'flowcrew-session.json'), JSON.stringify({ command: recorded, previousStatusLine: original }));
  writeFileSync(join(f.home, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `${recorded} --statusline` } }));
  if (sequence !== 'remove') {
    for (const action of ['install', 'install', 'check']) {
      const result = integrate(action, 'claude', f.home, f.env); expect(result.status, result.stderr).toBe(0);
    }
  }
  if (sequence === 'install-user-edit-remove') {
    const settings = JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8'));
    writeFileSync(join(f.home, 'settings.json'), JSON.stringify({ ...settings, statusLine: edited }));
  }
  const result = integrate('remove', 'claude', f.home, f.env);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8')).statusLine).toEqual(sequence === 'install-user-edit-remove' ? edited : original);
  expect(existsSync(join(f.home, 'hooks', 'flowcrew-session.json'))).toBe(false);
  // A consumed receipt must not resurrect the old status on a later fresh installation.
  writeFileSync(join(f.home, 'settings.json'), '{}');
  for (const action of ['install', 'remove']) expect(integrate(action, 'claude', f.home, f.env).status).toBe(0);
  expect(JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8')).statusLine).toBeUndefined();
});


it.each([null, [], {}, { command: 7 }].map(record => [record]))('refuses an invalid installation record without rewriting settings: %j', record => {
  const f = fixture();
  mkdirSync(join(f.home, 'hooks'));
  const settings = JSON.stringify({ statusLine: { type: 'command', command: 'user-status' } });
  writeFileSync(join(f.home, 'settings.json'), settings);
  const saved = JSON.stringify(record);
  writeFileSync(join(f.home, 'hooks', 'flowcrew-session.json'), saved);
  for (const action of ['install', 'remove', 'check']) {
    expect(integrate(action, 'claude', f.home, f.env).status).not.toBe(0);
    expect(readFileSync(join(f.home, 'settings.json'), 'utf8')).toBe(settings);
    expect(readFileSync(join(f.home, 'hooks', 'flowcrew-session.json'), 'utf8')).toBe(saved);
  }
});
