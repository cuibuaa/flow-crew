// FlowCrew session integration. Installed from this template; no user paths.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const settings = FLOWCREW_SETTINGS;
const input = await new Promise(resolve => {
  let text = '';
  process.stdin.setEncoding('utf8').on('data', chunk => { text += chunk; });
  process.stdin.on('end', () => resolve(text));
});
const statusline = process.argv.includes('--statusline');
const wake = process.argv[2] === 'Wake';
let payload = {};
try { payload = JSON.parse(input || '{}'); } catch { /* CLI reports malformed input */ }
const session = payload.session_id || payload.thread_id || payload['thread-id'] || 'unknown';
function incident(operation, cause) {
  const root = join(process.env.FC_HOME || join(homedir(), '.fc'), 'session-push', 'integration-errors');
  const id = createHash('sha256').update(JSON.stringify([settings.frontend, session, operation, cause])).digest('hex');
  return { root, path: join(root, `${id}.json`) };
}
function clearFailure(operation, cause) {
  const { root, path } = incident(operation, cause);
  try {
    const recovered = JSON.parse(readFileSync(path, 'utf8'));
    appendFileSync(join(root, '..', '..', 'infrastructure-recoveries.jsonl'), JSON.stringify({ at: new Date().toISOString(), component: 'session-read', frontend: settings.frontend, session, operation, recovered }) + '\n', { mode: 0o600, flush: true });
    unlinkSync(path);
    try { unlinkSync(`${path}.shown`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } catch { /* diagnostics cannot break a recovered integration */ }
}
function recordFailure(operation, detail, show = !wake, cause = 'command') {
  const { root, path } = incident(operation, cause);
  const message = `FlowCrew ${operation} unavailable for ${settings.frontend} session ${session}: ${detail}. Session state cannot be checked; inspect the push service.`;
  try {
    mkdirSync(root, { recursive: true });
    try { writeFileSync(path, JSON.stringify({ message, frontend: settings.frontend, session, operation, cause, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (show) {
      try {
        writeFileSync(`${path}.shown`, '', { flag: 'wx', mode: 0o600 });
        process.stdout.write(JSON.stringify({ systemMessage: JSON.parse(readFileSync(path, 'utf8')).message }) + '\n');
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  } catch {
    // If diagnostics cannot be persisted, still keep the warning human-only.
    if (show) process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
  }
}
// A session without tasks or pending events has no engine work. Keep this
// preflight in the small installed shim, before loading the CLI or registry.
let idle = false;
try {
  const payload = JSON.parse(input || '{}');
  const session = payload.session_id || payload.thread_id || payload['thread-id'];
  if (session && /^[\w-]+$/u.test(session)) {
    const root = join(process.env.FC_HOME || join(homedir(), '.fc'), 'session-push');
    const key = createHash('sha256').update(JSON.stringify([settings.frontend, session])).digest('hex');
    const index = join(root, 'task-index', `${key}.json`);
    const tasks = existsSync(index) ? JSON.parse(readFileSync(index, 'utf8')) : [];
    const events = join(root, 'pending', key);
    idle = (existsSync(join(root, 'task-index', 'ready')) && readFileSync(join(root, 'task-index', 'ready'), 'utf8') === '2\n'
      || !existsSync(join(root, '..', 'tasks.jsonl')))
      && (existsSync(join(root, 'pending', 'ready')) || !existsSync(join(root, 'events')))
      && Array.isArray(tasks) && tasks.length === 0 && (!existsSync(events) || readdirSync(events).length === 0);
  }
} catch { /* CLI owns malformed payload/store diagnostics. */ }
if (idle && !statusline) process.exit(0);
if (settings.frontend === 'claude' && !statusline) {
  try {
    const config = JSON.parse(readFileSync(settings.wakeConfigPath, 'utf8'));
    const installed = ['Stop', 'SessionStart'].every(event => (config.hooks?.[event] || []).some(group => isDeepStrictEqual(group, settings.wakeDefinition)));
    if (config.disableAllHooks === true || !installed) {
      recordFailure('wake', 'the installed async wake hook is disabled or missing', false, 'configuration');
      if (wake) process.exit(0);
    } else clearFailure('wake', 'configuration');
  } catch (error) {
    recordFailure('wake', error.message, false, 'configuration');
    if (wake) process.exit(0);
  }
}
const result = spawnSync(process.execPath, [settings.cli, 'session-push',
  ...(wake ? ['wake'] : statusline ? ['statusline', '--json'] : ['hook', '--frontend', settings.frontend, '--event', process.argv[2] || 'Stop']),
], { input, encoding: 'utf8', timeout: wake ? settings.limits.wakeMs : statusline ? settings.limits.statusMs : settings.limits.commandMs, maxBuffer: 2 * 1024 * 1024 });
if (!statusline) {
  if (result.status === 0 || (wake && result.status === 2 && !result.error)) {
    clearFailure(wake ? 'wake' : 'hook', 'command');
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.status;
  } else {
    recordFailure(wake ? 'wake' : 'hook', result.error?.message || result.stderr || `command exit ${result.status}`);
  }
} else {
  let rendering;
  try { rendering = JSON.parse(result.stdout); } catch { rendering = { text: 'FlowCrew: session display unavailable; inspect the push service', covered: false }; }
  process.stdout.write(rendering.text + '\n');
}
