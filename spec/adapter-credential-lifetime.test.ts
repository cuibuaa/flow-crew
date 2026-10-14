import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as adapterHome from '../src/adapter-home.js';
import { CodexAdapter, readCodexSession, stageCodexHome, writeCodexConfig } from '../src/adapters/codex.js';
import type { AgentConfig, RunOpts } from '../src/adapters/base.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';

const names = ['auth.json', 'credentials.json', 'installation_id'];
const uuid = '11111111-1111-4111-8111-111111111111';
const role: AgentConfig = { name: 'fixture', description: 'fixture', model: 'fixture', reasoning_effort: 'low', tools: [], prompt: 'fixture' };
let root: string, source: string, project: string, runDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-credential-lifetime-'));
  source = join(root, 'source'); project = join(root, 'project'); runDir = join(root, 'run');
  const bin = join(root, 'bin');
  for (const directory of [source, project, runDir, bin, join(root, 'plugins'), join(root, 'skills')]) mkdirSync(directory);
  // These are deliberately invalid fixture bytes. No operator credentials are used.
  for (const name of names) writeFileSync(join(source, name), 'fake-credential-fixture');
  vi.stubEnv('CODEX_HOME', source);
  vi.stubEnv('CODEX_PLUGINS_CACHE', join(root, 'plugins'));
  vi.stubEnv('CODEX_SKILLS_CACHE', join(root, 'skills'));
  vi.stubEnv('PATH', bin);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), path = require('node:path');
process.stdin.resume();
process.stdin.on('end', () => {
  const home = process.env.CODEX_HOME;
  const present = () => ['auth.json', 'credentials.json', 'installation_id'].every(name => fs.existsSync(path.join(home, name)));
  if (!present()) throw Error('fixture credentials missing during execution');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', 'conversation'), 'fixture conversation');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' }));
  const mode = process.env.FC_CREDENTIAL_FIXTURE_MODE;
  const counter = path.join(home, 'calls');
  const calls = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
  fs.writeFileSync(counter, String(calls));
  if (mode === 'descendant') require('node:child_process').spawn(process.execPath, ['-e', [
    "const fs = require('node:fs'), path = require('node:path'), home = process.env.CODEX_HOME;",
    "process.on('SIGTERM', () => {",
    "  const present = ['auth.json', 'credentials.json', 'installation_id'].every(name => fs.existsSync(path.join(home, name)));",
    "  fs.writeFileSync(path.join(home, 'descendant-closed'), present ? 'present' : 'missing');",
    "  process.exit(0);",
    "});",
    "fs.writeFileSync(path.join(home, 'descendant-ready'), 'ready');",
    "setInterval(() => {}, 1000);",
  ].join('\n')], { stdio: 'ignore' });
  if (mode === 'abort-kill') process.on('SIGTERM', () => {
    if (!present()) throw Error('fixture credentials removed before child stopped');
    fs.writeFileSync(path.join(home, 'term'), 'present');
  });
  if (mode === 'abort') process.on('SIGTERM', () => {
    if (!present()) throw Error('fixture credentials removed before graceful cleanup');
    fs.writeFileSync(path.join(home, 'term'), 'present');
    process.exit(0);
  });
  fs.writeFileSync(path.join(home, 'ready'), 'present');
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(home, 'release'))) return;
    if (mode === 'descendant' && !fs.existsSync(path.join(home, 'descendant-ready'))) return;
    clearInterval(timer);
    if (!present()) throw Error('fixture credentials removed while child was live');
    if (mode === 'kill') process.kill(process.pid, 'SIGKILL');
    else if (mode === 'failure') process.exit(1);
    else if (mode === 'repair' && calls === 1) {
      process.stderr.write('error: reasoning effort is not supported with tools for this model\n');
      process.exit(1);
    }
    else {
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture done' } }));
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }));
      process.exit(0);
    }
  }, 10);
});
`, { mode: 0o700 });
});

afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function credentials(home: string, present: boolean): void {
  for (const name of names) expect(existsSync(join(home, name)), name).toBe(present);
}

async function ready(home: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!existsSync(join(home, 'ready'))) {
    if (Date.now() >= deadline) throw new Error('fixture did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function run(stageId = 'work', overrides: Partial<RunOpts> = {}) {
  return withEngineIntegrity({ projectDir: project, runDir, stageId,
    artifactContract: { version: 1, produces: [], reads: [], groups: [], replays: [] } },
  () => new CodexAdapter().run('fixture', role, { workDir: project, runDir, stageId, timeout_ms: 10_000, ...overrides }));
}

describe('execution owns copied credentials', () => {
  it('prepares session/config/cache state without copying credentials', () => {
    const home = stageCodexHome(runDir, 'work');
    writeCodexConfig(home, role);
    credentials(home, false);
    credentials(source, true);
  });

  it.each([
    ['success', 0], ['failure', 1], ['abort', 137], ['abort-kill', 137], ['timeout', 124], ['kill', 1],
  ] as const)('has credentials during %s and removes them at terminal close', async (mode, code) => {
    vi.stubEnv('FC_CREDENTIAL_FIXTURE_MODE', mode);
    const controller = new AbortController();
    const home = stageCodexHome(runDir, 'work');
    const execution = run('work', { abortSignal: controller.signal });
    try {
      await ready(home);
      credentials(home, true);
      if (mode.startsWith('abort')) controller.abort();
      else if (mode !== 'timeout') writeFileSync(join(home, 'release'), 'go');
      const result = await execution;
      expect(result.exitCode, result.output).toBe(code);
      if (mode === 'timeout') expect(result.timedOut).toBe(true);
      if (mode === 'kill' || mode === 'abort-kill') expect(result.processSignal).toBe('SIGKILL');
      credentials(home, false);
      credentials(source, true);
      if (code !== 0) {
        expect(readFileSync(join(home, 'sessions', 'conversation'), 'utf8')).toBe('fixture conversation');
        if (mode.startsWith('abort')) expect(readFileSync(join(home, 'term'), 'utf8')).toBe('present');
      } else expect(existsSync(home)).toBe(false);
    } finally { controller.abort(); await execution; }
  });

  it('retains a resumable home without credentials and reacquires them for the next attempt', async () => {
    const home = stageCodexHome(runDir, 'work');
    for (const mode of ['failure', 'success', 'success']) {
      vi.stubEnv('FC_CREDENTIAL_FIXTURE_MODE', mode);
      rmSync(join(home, 'ready'), { force: true }); rmSync(join(home, 'release'), { force: true });
      const controller = new AbortController();
      const execution = run('work', { preserveSession: true, abortSignal: controller.signal,
        ...(mode === 'success' ? { resumeSessionId: uuid, sessionOwnerStageId: 'work' } : {}) });
      try {
        await ready(home); credentials(home, true);
        writeFileSync(join(home, 'release'), 'go');
        expect((await execution).exitCode).toBe(mode === 'failure' ? 1 : 0);
        credentials(home, false);
        expect(readCodexSession(runDir, 'work')?.sessionId).toBe(uuid);
        expect(readFileSync(join(home, 'sessions', 'conversation'), 'utf8')).toBe('fixture conversation');
      } finally { controller.abort(); await execution; }
    }
  });

  it('does not retire another live execution when a concurrent stage finishes', async () => {
    const a = stageCodexHome(runDir, 'first'), b = stageCodexHome(runDir, 'second');
    const controller = new AbortController();
    const first = run('first', { abortSignal: controller.signal });
    const second = run('second', { abortSignal: controller.signal });
    try {
      await Promise.all([ready(a), ready(b)]);
      credentials(a, true); credentials(b, true);
      writeFileSync(join(b, 'release'), 'go');
      expect((await second).exitCode).toBe(0);
      credentials(b, false); credentials(a, true);
      writeFileSync(join(a, 'release'), 'go');
      expect((await first).exitCode).toBe(0); credentials(a, false);
    } finally { controller.abort(); await Promise.all([first, second]); }
  });

  it('keeps credentials until an owned descendant retires after the leader exits', async () => {
    vi.stubEnv('FC_CREDENTIAL_FIXTURE_MODE', 'descendant');
    const home = stageCodexHome(runDir, 'work');
    const controller = new AbortController();
    const execution = run('work', { preserveSession: true, abortSignal: controller.signal });
    try {
      await ready(home); credentials(home, true);
      writeFileSync(join(home, 'release'), 'go');
      expect((await execution).exitCode).toBe(0);
      expect(readFileSync(join(home, 'descendant-closed'), 'utf8')).toBe('present');
      credentials(home, false);
    } finally { controller.abort(); await execution; }
  });

  it('retires and reacquires credentials for each internal parameter retry', async () => {
    vi.stubEnv('FC_CREDENTIAL_FIXTURE_MODE', 'repair');
    const home = stageCodexHome(runDir, 'work');
    const controller = new AbortController();
    const credentialStates: boolean[][] = [];
    const execution = run('work', { preserveSession: true, abortSignal: controller.signal,
      onInvocationInput: () => { credentialStates.push(names.map(name => existsSync(join(home, name)))); } });
    try {
      await ready(home); credentials(home, true);
      writeFileSync(join(home, 'release'), 'go');
      const result = await execution;
      expect(result.exitCode, result.output).toBe(0);
      expect(credentialStates).toEqual([[false, false, false], [false, false, false]]);
      expect(result.invocations).toHaveLength(2);
      credentials(home, false);
    } finally { controller.abort(); await execution; }
  });

  it('removes credentials when execution throws before returning a result', async () => {
    const home = stageCodexHome(runDir, 'work'); writeCodexConfig(home, role);
    await expect(adapterHome.withAdapterCredentials(home, source, async () => {
      credentials(home, true); throw new Error('fixture launch exception');
    })).rejects.toThrow('fixture launch exception');
    credentials(home, false); expect(existsSync(home)).toBe(true);
  });

  it('launch failure retires credentials while retaining the home', async () => {
    rmSync(join(root, 'bin', 'codex')); vi.stubEnv('PATH', join(root, 'bin'));
    const result = await run();
    expect(result.spawnError?.code).toBe('ENOENT');
    const home = stageCodexHome(runDir, 'work');
    credentials(home, false); expect(existsSync(home)).toBe(true);
  });

  it('pins cleanup to the execution home when its pathname is replaced', async () => {
    const home = stageCodexHome(runDir, 'work'); writeCodexConfig(home, role);
    const moved = join(root, 'moved');
    await adapterHome.withAdapterCredentials(home, source, async () => {
      credentials(home, true); renameSync(home, moved); symlinkSync(source, home, 'dir');
    });
    credentials(moved, false); credentials(source, true);
  });

  it('refuses an aliased credential source without deleting any source entries', async () => {
    const alias = join(root, 'alias'); symlinkSync(source, alias, 'dir');
    await expect(adapterHome.withAdapterCredentials(source, alias, async () => {})).rejects.toThrow('source must be separate');
    credentials(source, true);
  });
});
