// FlowCrew session integration. Installed from this template; no user paths.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
    const events = join(root, 'events');
    idle = (existsSync(join(root, 'task-index', 'ready')) || !existsSync(join(root, '..', 'tasks.jsonl'))) && Array.isArray(tasks) && tasks.length === 0 && (!existsSync(events) || !readdirSync(events).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).some(name => {
      if (existsSync(join(root, 'acks', name))) return false;
      const event = JSON.parse(readFileSync(join(events, name), 'utf8'));
      return event.target.frontend === settings.frontend && event.target.sessionId === session;
    }));
  }
} catch { /* CLI owns malformed payload/store errors and keeps the gate closed. */ }
if (idle && !statusline) process.exit(0);
if (wake) {
  // Do not advertise coverage when this installation has been disabled or its
  // async definition was removed/changed. Existing foreground gate stays closed.
  const config = JSON.parse(readFileSync(settings.wakeConfigPath, 'utf8'));
  const installed = ['Stop', 'SessionStart'].some(event => (config.hooks?.[event] || []).some(group => isDeepStrictEqual(group, settings.wakeDefinition)));
  if (config.disableAllHooks === true || !installed) process.exit(0);
}
const result = spawnSync(process.execPath, [settings.cli, 'session-push',
  ...(wake ? ['wake'] : statusline ? ['statusline', '--json'] : ['hook', '--frontend', settings.frontend, '--event', process.argv[2] || 'Stop']),
], { input, encoding: 'utf8', timeout: wake ? 3650_000 : 10_000, maxBuffer: 2 * 1024 * 1024 });
if (!statusline) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) process.stderr.write(`FlowCrew hook failed: ${result.error.message}. Inspect pending events and end the turn to renew wake coverage.\n`);
  process.exitCode = result.status === 0 ? 0 : 2;
} else {
  let rendering;
  try { rendering = JSON.parse(result.stdout); } catch { rendering = { text: 'FlowCrew: engine unavailable', covered: false }; }
  let previous = '';
  if (settings.previousStatusLine?.command) {
    const prior = spawnSync(settings.previousStatusLine.command, { shell: true, input, encoding: 'utf8', timeout: 5_000, maxBuffer: 2 * 1024 * 1024 });
    previous = prior.stdout?.trim() || '';
  }
  // The old process-name heuristic cannot recognize engine delivery or a
  // Monitor tool. Suppress only that obsolete warning, with a fresh engine
  // heartbeat for this session. Other operator status output is preserved.
  if (rendering.covered) previous = previous.replaceAll('⚠ 轮次在跑但无 monitor', '').trim();
  const lines = [previous, rendering.text].filter(Boolean).flatMap(text => text.split('\n'));
  process.stdout.write([...new Set(lines)].join('\n') + '\n');
}
