import { mkdirSync } from './engine-fs.js';
import { realpathSync } from 'node:fs';

import { join } from 'node:path';

/** Project commands need executable/project inputs, not the scheduler's control
 * channels or a provider's credentials. Keep unknown project inputs and name
 * every suppressed setting without printing its value. Explicit HOME/config
 * reads remain supported; engine integrity checks validate the result. */
export function validationEnvironment(
  root: string,
  inherited: NodeJS.ProcessEnv,
  explicit?: NodeJS.ProcessEnv,
): { env: NodeJS.ProcessEnv; removed: string[] } {
  // Keep the fuse short for invocation scratch aliases. This private endpoint
  // is never a bind target, so an overlong root must not refuse a command.
  // Actual daemon clients still validate socket paths before I/O.
  const socket = join(root, 's');
  const env = { ...(explicit ?? inherited) };
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (/^(?:FLOWCREW_|FC_|CODEX_|CLAUDE_|OPENAI_|ANTHROPIC_)/i.test(name)
        || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i.test(name)
        || /^(?:CLAUDECODE|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|DBUS_SESSION_BUS_PID|DBUS_SESSION_BUS_WINDOWID|SSH_AUTH_SOCK|SSH_AGENT_PID)$/i.test(name)) {
      if (env[name] !== undefined) removed.push(name);
      delete env[name];
    }
  }
  // Keep the admitted temporary directory, using its physical spelling so
  // child write guards never have to traverse a caller's scratch symlink.
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) {
    if (env[name]) try { env[name] = realpathSync(env[name]!); } catch { /* retain an unavailable project input */ }
  }
  const home = join(root, 'home');
  const fcHome = join(home, '.fc');
  const codexHome = join(root, 'codex');
  const runtime = join(root, 'runtime');
  for (const directory of [fcHome, codexHome, runtime, join(home, '.config')]) mkdirSync(directory, { recursive: true });
  Object.assign(env, {
    HOME: explicit?.HOME ?? home,
    USERPROFILE: explicit?.USERPROFILE ?? explicit?.HOME ?? home,
    FC_HOME: fcHome,
    CODEX_HOME: codexHome,
    FLOWCREW_DAEMON_SOCKET: socket,
    XDG_RUNTIME_DIR: runtime,
    XDG_CONFIG_HOME: explicit?.XDG_CONFIG_HOME ?? join(home, '.config'),
  });
  return { env, removed: removed.sort() };
}
