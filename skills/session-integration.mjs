import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const [action, frontend, rootArg, packageArg] = process.argv.slice(2);
if (!['install', 'remove', 'check'].includes(action) || !['claude', 'codex'].includes(frontend) || !rootArg || !packageArg) {
  throw new Error('Usage: session-integration.mjs install|remove|check claude|codex <frontend-root> <package-root>');
}
const root = resolve(rootArg);
const packageRoot = resolve(packageArg);
const configPath = join(root, frontend === 'claude' ? 'settings.json' : 'hooks.json');
const shimPath = join(root, 'hooks', 'flowcrew-session.mjs');
const manifestPath = join(root, 'hooks', 'flowcrew-session.json');
const template = readFileSync(join(packageRoot, 'skills', 'session-hook.mjs'), 'utf8');
const sourceDigest = createHash('sha256').update(template).update(readFileSync(new URL(import.meta.url)))
  .update(readFileSync(join(packageRoot, 'skills', 'codex-verify.mjs'))).digest('hex');
const quote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
const command = `${quote(process.execPath)} ${quote(shimPath)}`;
const parse = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + `.tmp.${process.pid}`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
};
const config = parse(configPath);
const previous = parse(manifestPath);
if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Invalid hook configuration: ${configPath}`);
if (config.hooks && (typeof config.hooks !== 'object' || Array.isArray(config.hooks))) throw new Error(`Invalid hooks: ${configPath}`);

const owned = handler => handler?.type === 'command' && typeof handler.command === 'string'
  && ['Stop', 'SessionStart', 'Wake'].some(event => handler.command === `${command} ${event}`
    || (previous.command && handler.command === `${previous.command} ${event}`));
const definition = event => ({ hooks: [{ type: 'command', command: `${command} ${event}`, timeout: 15 }] });
// The worker rolls over at 3600s; its shim has a 3650s safety deadline, before
// Claude's own 3660s deadline. Expiry therefore wakes instead of going silent.
const wakeDefinition = { hooks: [{ type: 'command', command: `${command} Wake`, timeout: 3660, asyncRewake: true }] };
const present = event => (config.hooks?.[event] || []).some(group => isDeepStrictEqual(group, definition(event)));
const statusCommand = `${command} --statusline`;
const settings = {
  cli: join(packageRoot, 'dist', 'cli.js'), frontend,
  ...(frontend === 'claude' ? { wakeConfigPath: configPath, wakeDefinition } : {}),
  previousStatusLine: previous.previousStatusLine ?? (config.statusLine?.command === statusCommand ? undefined : config.statusLine),
};
const expectedShim = template.replace('FLOWCREW_SETTINGS', JSON.stringify(settings));
if (action === 'check') {
  const issues = [];
  if (!existsSync(settings.cli)) issues.push('engine CLI is missing; run npm run build');
  if (previous.sourceDigest !== sourceDigest || previous.cli !== settings.cli) issues.push('missing or outdated installation manifest');
  if (!existsSync(shimPath) || readFileSync(shimPath, 'utf8') !== expectedShim) issues.push('missing or outdated shared hook');
  for (const event of ['Stop', 'SessionStart']) if (!present(event)) issues.push(`missing ${event} hook`);
  if (frontend === 'claude') {
    for (const event of ['Stop', 'SessionStart']) if (!(config.hooks?.[event] || []).some(group => isDeepStrictEqual(group, wakeDefinition))) issues.push(`missing or outdated asyncRewake hook (${event})`);
    if (config.disableAllHooks === true) issues.push('Claude hooks are disabled; enable hooks in Claude Code if desired');
    if (existsSync(settings.cli)) {
      const capability = spawnSync(process.execPath, [settings.cli, 'session-push', 'wake-check'], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (capability.status !== 0) issues.push(capability.stdout?.trim() || 'Claude wake capability unavailable; upgrade Claude Code');
    }
  }
  if (frontend === 'claude' && config.statusLine?.command !== statusCommand) issues.push('missing status line integration');
  if (frontend === 'codex') {
    // Native keys depend on the effective configuration (including neighboring
    // hook positions). Saved trust records alone cannot establish current trust.
    const result = spawnSync(process.execPath, [join(packageRoot, 'skills', 'codex-verify.mjs'),
      'check', 'codex', process.cwd(), '', '', root, '3000'], {
      encoding: 'utf8', timeout: 6500, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) issues.push(result.stderr?.trim() || 'Codex hook trust could not be verified');
  }
  process.stdout.write(issues.join('; ') || 'shared Stop/SessionStart hooks and progress integration are current');
  process.exitCode = issues.length ? 1 : 0;
} else {
  const hooks = config.hooks ?? {};
  for (const event of ['Stop', 'SessionStart']) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups) || groups.some(group => !Array.isArray(group.hooks))) throw new Error(`Invalid ${event} hook groups`);
    hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(handler => !owned(handler)) }))
      .filter(group => group.hooks.length > 0);
    if (action === 'install') hooks[event].push(definition(event));
    if (action === 'install' && frontend === 'claude') hooks[event].push(wakeDefinition);
    if (!hooks[event].length) delete hooks[event];
  }
  config.hooks = hooks;
  if (frontend === 'claude') {
    if (action === 'install') config.statusLine = { type: 'command', command: statusCommand };
    else if (config.statusLine?.command === statusCommand) {
      if (previous.previousStatusLine) config.statusLine = previous.previousStatusLine;
      else delete config.statusLine;
    }
  }
  if (action === 'install') {
    write(shimPath, expectedShim);
    write(manifestPath, JSON.stringify({ sourceDigest, command, ...settings, ...(previous.codexTrust ? { codexTrust: previous.codexTrust } : {}) }, null, 2) + '\n');
  }
  write(configPath, JSON.stringify(config, null, 2) + '\n');
  if (action === 'remove') {
    for (const path of [shimPath, manifestPath]) if (existsSync(path)) unlinkSync(path);
  }
  process.stdout.write(`FlowCrew ${frontend} session integration ${action === 'install' ? 'installed' : 'removed'}.\n`);
}
