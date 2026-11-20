#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from './ops/main.js';

const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => abort.abort());
const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const home = environment.FC_HOME ?? join(environment.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'flowcrew');
try {
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(), storeRoot: environment.FLOWCREW_STORE_ROOT ?? join(home, 'store'), runtimeRoot: environment.FLOWCREW_RUNTIME_ROOT ?? resolve(import.meta.dirname, '..'),
    home: home, environment, stdin: new Uint8Array(), abort: abort.signal,
    stdout: async bytes => { process.stdout.write(bytes); }, stderr: async bytes => { process.stderr.write(bytes); },
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
