#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { main, exitOf } from './ops/main.js';
import { pathToFileURL } from 'node:url';
import { cooperativeAbort } from './host/process.js';

const abort = cooperativeAbort();
const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const home = environment.FC_HOME ?? join(environment.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'flowcrew');
const runtimeRoot = resolve(environment.FLOWCREW_RUNTIME_ROOT ?? resolve(import.meta.dirname, '..'));
// Select the setup frontend before it decodes anything; that frontend pins its own installation.
let entry: typeof main | undefined = main;
if (process.argv[2] === 'setup' && runtimeRoot !== resolve(import.meta.dirname, '..')) {
  try {
    entry = (await import(pathToFileURL(join(runtimeRoot, 'dist-rewrite', 'ops', 'main.js')).href)).main;
    if (typeof entry !== 'function') throw new Error('Selected installation has no setup entry');
  }
  catch (error) {
    const failure = { ok: false as const, kind: 'invalid' as const, detail: String(error) };
    process.stderr.write(JSON.stringify(failure) + '\n');
    process.exitCode = exitOf(failure.kind); entry = undefined;
  }
}
if (entry) try {
  process.exitCode = await entry(process.argv.slice(2), {
    cwd: process.cwd(), storeRoot: environment.FLOWCREW_STORE_ROOT ?? join(home, 'store'), runtimeRoot,
    home: home, environment, stdin: new Uint8Array(), abort,
    stdout: async bytes => { process.stdout.write(bytes); }, stderr: async bytes => { process.stderr.write(bytes); },
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
