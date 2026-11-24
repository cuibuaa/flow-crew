// Registration only. The packaged standalone Claude hook owns session integration.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const [action, frontend, rootArg, packageArg] = process.argv.slice(2);
if (!['install', 'remove', 'check'].includes(action) || frontend !== 'claude' || !rootArg || !packageArg)
  throw new Error('Usage: session-integration.mjs install|remove|check claude <frontend-root> <package-root>');
const root = resolve(rootArg), packageRoot = resolve(packageArg);
const cli = join(packageRoot, 'dist-rewrite', 'cli.js');
const hook = join(packageRoot, 'dist-rewrite', 'flowcrew-session.mjs');
const configPath = join(root, 'settings.json');
// The frontend owns persistent configuration; package replacement only replaces executable code.
const hookConfig = join(root, 'flowcrew-session.json');
const manifestPath = join(root, 'hooks', 'flowcrew-session.json');
const quote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
const command = `nice -n 19 ${quote(process.execPath)} ${quote(hook)}`;
const read = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + `.tmp.${process.pid}`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
};
const config = read(configPath);
const previous = existsSync(manifestPath) ? read(manifestPath) : undefined;
if (previous !== undefined && (!previous || typeof previous !== 'object' || Array.isArray(previous)
  || typeof previous.command !== 'string')) throw new Error(`Invalid installation record: ${manifestPath}`);
if (!config || typeof config !== 'object' || Array.isArray(config)
  || config.hooks && (typeof config.hooks !== 'object' || Array.isArray(config.hooks)))
  throw new Error(`Invalid hook configuration: ${configPath}`);
const registered = event => `${command} ${event} ${quote(hookConfig)}`;
// Closed historical grammar: 376be84 introduced the quoted shared shim;
// 8448e99 replaced it with the nice-prefixed packaged hook, without a config argument.
// The old installer recorded what it wrote, including the Node path at that time.
// Reconstruct the closed historical list only when no installation record exists.
const previousCommands = previous === undefined
  ? [command, `${quote(process.execPath)} ${quote(join(root, 'hooks', 'flowcrew-session.mjs'))}`] : [previous.command];
const ownedCommands = new Set(['Stop', 'SessionStart', 'Wake', '--statusline'].flatMap(event =>
  [registered(event), ...previousCommands.map(base => `${base} ${event}`)]));
const owned = handler => handler?.type === 'command' && ownedCommands.has(handler.command);
const definition = event => ({ hooks: [{ type: 'command', command: registered(event) }] });
const wake = { hooks: [{ type: 'command', command: registered('Wake'), asyncRewake: true }] };
const status = { type: 'command', command: registered('--statusline') };
const hooks = config.hooks ?? {};
for (const event of ['Stop', 'SessionStart']) {
  const groups = hooks[event] ?? [];
  if (!Array.isArray(groups) || groups.some(group => !Array.isArray(group.hooks))) throw new Error(`Invalid ${event} hook groups`);
}
if (action === 'check') {
  const issues = [];
  if (!existsSync(cli) || !existsSync(hook)) issues.push('rewritten package entry is missing; run npm run build');
  if (!existsSync(hookConfig)) issues.push('standalone hook configuration is missing');
  for (const event of ['Stop', 'SessionStart']) for (const expected of [definition(event), wake])
    if (!(hooks[event] ?? []).some(group => isDeepStrictEqual(group, expected))) issues.push(`missing ${event} hook`);
  if (config.disableAllHooks === true) issues.push('Claude hooks are disabled');
  process.stdout.write(`${issues.length ? 'unavailable' : 'verified'}: ${issues.join('; ') || 'standalone Claude session integration is current'}\n`);
  process.exitCode = issues.length ? 1 : 0;
} else {
  if (action === 'install' && (!existsSync(cli) || !existsSync(hook))) throw new Error('Run npm run build before installing session integration');
  for (const event of ['Stop', 'SessionStart']) {
    hooks[event] = (hooks[event] ?? []).map(group => ({ ...group, hooks: group.hooks.filter(handler => !owned(handler)) }))
      .filter(group => group.hooks.length);
    if (action === 'install') hooks[event].push(definition(event), wake);
    if (!hooks[event].length) delete hooks[event];
  }
  config.hooks = hooks;
  // Preserve a user status line; only fill an unclaimed slot or remove our own definition.
  if (action === 'install' && (!config.statusLine || owned(config.statusLine))) config.statusLine = status;
  if (action === 'remove' && owned(config.statusLine)) {
    if (Object.hasOwn(previous ?? {}, 'previousStatusLine')) config.statusLine = previous.previousStatusLine;
    else delete config.statusLine;
  }
  if (action === 'install' && !existsSync(hookConfig)) write(hookConfig, {
    storeRoots: [resolve(process.env.FLOWCREW_STORE_ROOT ?? join(process.env.FC_HOME
      ?? join(process.env.XDG_STATE_HOME ?? join(process.env.HOME, '.local', 'state'), 'flowcrew'), 'store'))],
    tasksRoot: join(root, 'tasks'),
  });
  write(configPath, config);
  // Reinstalls retain the original backup; consumption follows successful settings publication.
  if (action === 'remove' && previous !== undefined) unlinkSync(manifestPath);
  process.stdout.write(`FlowCrew Claude session integration ${action === 'install' ? 'installed' : 'removed'}.\n`);
}
