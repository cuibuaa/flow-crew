/** Reuse the native CLI's dependency graph, but evaluate its real entry point
 * afresh for every request. Each fixture has its own FC_HOME and socket. */
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { setFcGlobalDir } from '../../dist/store.js';

let invocation = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { root, project, args } = JSON.parse(line);
  Object.assign(process.env, { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    FC_HOME: join(root, 'fc'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    FLOWCREW_DAEMON_SOCKET: join(root, 'daemon.sock'), FC_DAEMON_SOCKET: join(root, 'daemon.sock') });
  setFcGlobalDir(join(root, 'fc'));
  process.chdir(project);
  process.argv = [process.execPath, new URL('../../dist/cli.js', import.meta.url).pathname, ...args];
  const listeners = [process, process.stdout, process.stderr].map(emitter => ({ emitter,
    events: new Map(emitter.eventNames().map(event => [event, emitter.listeners(event)])) }));
  const stdout = process.stdout.write, stderr = process.stderr.write;
  let output = '', errors = '';
  process.stdout.write = chunk => { output += chunk; return true; };
  process.stderr.write = chunk => { errors += chunk; return true; };
  process.exitCode = 0;
  try {
    await import(`../../dist/cli.js?invocation=${++invocation}`);
  } catch (error) {
    errors += error.stack;
    process.exitCode = 1;
  } finally {
    process.stdout.write = stdout; process.stderr.write = stderr;
    for (const { emitter, events } of listeners) for (const event of emitter.eventNames()) {
      for (const listener of emitter.listeners(event)) {
        if (!events.get(event)?.includes(listener)) emitter.removeListener(event, listener);
      }
    }
  }
  process.stdout.write(JSON.stringify({ status: process.exitCode, stdout: output, stderr: errors }) + '\n');
  process.exitCode = 0;
}
