// FlowCrew session integration. Installed from this template; no user paths.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
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
// Diagnostics are for the operator only: Stop's systemMessage, or stderr of a
// non-blocking wake exit. They never reach the model-visible decision/reason.
const notices = [];
let wakeUnavailable = false; // coverage cannot be registered: the CLI must not ask the model to renew it
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
    if (config.disableAllHooks === true || !installed) wakeUnavailable = true;
    if (wakeUnavailable) notices.push(`FlowCrew wake coverage unavailable (hook_disabled) for session ${session}: the installed async wake hook is disabled or missing.`);
  } catch (error) { wakeUnavailable = true; notices.push(`FlowCrew wake coverage unavailable (hook_disabled) for session ${session}: ${error.message}.`); }
  if (wake && notices.length) { process.stderr.write(`${notices.join('\n')}\n`); process.exit(0); }
}
const result = spawnSync(process.execPath, [settings.cli, 'session-push',
  ...(wake ? ['wake'] : statusline ? ['statusline', '--json'] : ['hook', '--frontend', settings.frontend, '--event', process.argv[2] || 'Stop', ...(wakeUnavailable ? ['--wake-unavailable'] : [])]),
], { input, encoding: 'utf8', timeout: wake ? settings.limits.wakeMs : statusline ? settings.limits.statusMs : settings.limits.commandMs, maxBuffer: 2 * 1024 * 1024 });
if (statusline) {
  let rendering;
  try { rendering = JSON.parse(result.stdout); } catch { rendering = { text: 'FlowCrew: session display unavailable; inspect the push service', covered: false }; }
  process.stdout.write(rendering.text + '\n');
} else {
  const ran = result.status === 0 || (wake && result.status === 2 && !result.error);
  if (!ran) notices.push(`FlowCrew ${wake ? 'wake' : 'hook'} unavailable for ${settings.frontend} session ${session}: ${result.error?.message || result.stderr || `command exit ${result.status}`}. Session state cannot be checked; inspect the push service.`);
  if (wake) {
    // A wake CLI that crashed or hung registered nothing; leave the same fact the
    // CLI leaves, so Stop does not ask the model to renew what cannot be renewed.
    // Own tmp+rename: the CLI is what failed, and the shim imports nothing from dist.
    if (!ran) try {
      const dir = join(process.env.FC_HOME || join(homedir(), '.fc'), 'session-push', 'wake-unavailable');
      const file = join(dir, `${createHash('sha256').update(session).digest('hex')}.json`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.tmp.${process.pid}`, `${JSON.stringify({ reason: 'wake_cli_failed', at: new Date().toISOString() })}\n`, { mode: 0o600 });
      renameSync(`${file}.tmp.${process.pid}`, file);
    } catch { /* the operator notice below is all that can be said */ }
    // asyncRewake: stderr of exit 2 is the model's prompt; of exit 0, the operator's.
    process.stderr.write(ran ? result.stderr : `${notices.join('\n')}\n`);
    process.exitCode = ran ? result.status : 0;
  } else {
    // The CLI's decision/reason is the whole model-visible result.
    let verdict = {};
    try { if (ran) verdict = JSON.parse(result.stdout || '{}'); } catch { notices.push('FlowCrew hook output unreadable; inspect the push service.'); }
    if (notices.length) verdict = { ...verdict, systemMessage: [verdict.systemMessage, ...notices].filter(Boolean).join('\n') };
    if (Object.keys(verdict).length) process.stdout.write(`${JSON.stringify(verdict)}\n`);
    process.exitCode = 0;
  }
}
