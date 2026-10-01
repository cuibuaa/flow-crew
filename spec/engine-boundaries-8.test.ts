import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { execWithStdin } from '../src/adapters/base.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { prepareValidationWriteGuard, type ValidationWriteGuard } from '../src/cli-ship-preflight.js';
import { parseChecksFromMarkdown } from '../src/reality-gate/index.js';
import { inspectRealityCheckReachability } from '../src/scheduler.js';
import { runValidationCommand } from '../src/project-validation.js';

const roots: string[] = [];
const initialPath = process.env.PATH;
const uuid = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-boundaries-8-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  if (initialPath === undefined) delete process.env.PATH;
  else process.env.PATH = initialPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function codexFixture(mode: string) {
  const root = fixture();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-fixture 1'); process.exit(0); }
let input = ''; process.stdin.on('data', b => input += b);
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.EB8_CALLS, JSON.stringify(process.argv.slice(2)) + '\n');
  fs.writeFileSync(process.env.EB8_STARTED, 'started');
  if (process.env.EB8_MODE === 'silent') return setTimeout(() => process.exit(1), 150);
  if (process.env.EB8_MODE === 'dead') {
    process.stderr.write('Error: thread/resume: no rollout found for thread id (code -32600)\n');
    return process.exit(1);
  }
  console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:
    process.env.EB8_MODE === 'prose' ? 'thread/resume: no rollout found for thread id (code -32600)' : 'interim agent text'}}));
  process.stderr.write(process.env.EB8_MODE === 'prose' ? 'controlled task failure\n' : 'Error: 403 Forbidden [controlled]\n');
  process.exit(1);
});
`, { mode: 0o755 });
  process.env.PATH = bin;
  for (const [key, value] of Object.entries({
    HOME: root, USERPROFILE: root, FC_HOME: join(root, 'state'),
    CODEX_HOME: join(root, 'user-codex'), CODEX_PLUGINS_CACHE: join(root, 'plugins'),
    CODEX_SKILLS_CACHE: join(root, 'skills'), EB8_MODE: mode,
    EB8_CALLS: join(root, 'calls.jsonl'), EB8_STARTED: join(root, 'started'),
  })) vi.stubEnv(key, value);
  return {
    root, bin,
    run: () => new CodexAdapter().run('controlled offline prompt', {
      name: 'coder', description: 'fixture', model: 'default', reasoning_effort: 'default', tools: [], prompt: '',
    }, { workDir: root, runDir: join(root, 'run'), stageId: 'subject', timeout_ms: 2500,
      resumeSessionId: uuid, sessionOwnerStageId: 'owner', preserveSession: true }),
    calls: () => readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]),
  };
}

async function failedLaunchSignalProbe(root: string, mode: 'cancel' | 'hard-stop') {
  const bin = join(root, 'probe-bin'); mkdirSync(bin);
  const script = `
    import { ChildProcess } from 'node:child_process';
    import { join } from 'node:path';
    import { execWithStdin } from ${JSON.stringify(new URL('../dist/adapters/base.js', import.meta.url).href)};
    import { CodexAdapter } from ${JSON.stringify(new URL('../dist/adapters/codex.js', import.meta.url).href)};
    const watchdog = setTimeout(() => process.exit(99), 5000);
    const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)}, killCalls = [];
    const original = ChildProcess.prototype.kill;
    ChildProcess.prototype.kill = function(signal) {
      killCalls.push({ pid: this.pid ?? null, signal });
      if (this.pid === undefined) return false;
      throw new Error('Failed-launch fixture unexpectedly owns a child to signal');
    };
    try {
      let result;
      if (mode === 'cancel') {
        const abort = new AbortController(); abort.abort();
        result = await new CodexAdapter().run('controlled offline prompt', {
          name: 'coder', description: 'fixture', model: 'default', reasoning_effort: 'default', tools: [], prompt: '',
        }, { workDir: root, runDir: join(root, 'run'), stageId: 'subject', timeout_ms: 2000, abortSignal: abort.signal });
      } else {
        result = await execWithStdin(join(root, 'absent-executable'), [], '', {
          cwd: root, timeout_ms: 2000, onChild: ({ kill }) => kill(),
        });
      }
      console.log(JSON.stringify({ result, killCalls }));
    } finally { ChildProcess.prototype.kill = original; clearTimeout(watchdog); }
  `;
  const response = await runValidationCommand({
    role: 'test', command: process.execPath, args: ['--input-type=module', '-e', script],
    cwd: root, display: 'bounded failed-launch signal observation',
    env: { ...process.env, PATH: bin, HOME: root, USERPROFILE: root, FC_HOME: join(root, 'state') },
  });
  expect(response.exitCode, response.stderr).toBe(0);
  return JSON.parse(response.stdout ?? '') as {
    result: { exitCode: number; output: string; spawnError?: { code?: string }; friendlyError?: string };
    killCalls: { pid: number | null; signal: string }[];
  };
}

describe('boundary 55: evidence from the launched process', () => {
  it('keeps separate raw streams opt-in for callers of the shared helper', async () => {
    const root = fixture();
    const args = ['-e', "process.stdout.write('controlled stdout');process.stderr.write('controlled stderr')"];
    const defaults = await execWithStdin(process.execPath, args, '', { cwd: root, timeout_ms: 2000 });
    expect(defaults.exitCode).toBe(0);
    expect(defaults.output).toContain('controlled stdout');
    expect(defaults.output).toContain('controlled stderr');
    expect(defaults).not.toHaveProperty('stdout');
    expect(defaults).not.toHaveProperty('stderr');
    const requested = await execWithStdin(process.execPath, args, '', { cwd: root, timeout_ms: 2000, captureStreams: true });
    expect(requested).toMatchObject({ exitCode: 0, stdout: 'controlled stdout', stderr: 'controlled stderr' });
  });

  it('preserves ENOENT for both an absent executable and an absent cwd without inferring installation', async () => {
    const root = fixture();
    for (const [command, cwd] of [[join(root, 'absent-command'), root], [process.execPath, join(root, 'absent-cwd')]]) {
      const liveLogPath = join(root, 'live.log');
      const result = await execWithStdin(command, [], '', { cwd, timeout_ms: 2000, liveLogPath });
      expect(result).toMatchObject({ exitCode: 1, spawnError: { code: 'ENOENT', cwd } });
      expect(result.output).toContain('ENOENT');
      expect(result.output).toContain(cwd);
      expect(result.output).not.toContain('Command not found');
      expect(readFileSync(liveLogPath, 'utf8')).toContain(result.output);
    }
  });

  it.skipIf(process.platform === 'win32')('keeps EACCES distinct from missing executable diagnostics', async () => {
    const root = fixture();
    const executable = join(root, 'denied');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o644);
    const result = await execWithStdin(executable, [], '', { cwd: root, timeout_ms: 2000 });
    expect(result).toMatchObject({ exitCode: 1, spawnError: { code: 'EACCES' } });
    expect(result.output).toContain('EACCES');
  });

  it('keeps an existing cancellation authoritative when launch also fails', async () => {
    const f = codexFixture('mixed');
    rmSync(join(f.bin, 'codex'));
    const { result, killCalls } = await failedLaunchSignalProbe(f.root, 'cancel');
    expect(result.exitCode).toBe(137);
    expect(result.output).toContain('[stage cancelled by control plane]');
    expect(result.spawnError?.code).toBe('ENOENT');
    expect(result.friendlyError).toBeUndefined();
    expect(existsSync(join(f.root, 'calls.jsonl'))).toBe(false);
    expect(killCalls).toEqual([]);
  });

  it('does not signal a failed launch from its immediate hard-stop handle', async () => {
    const root = fixture();
    const { result, killCalls } = await failedLaunchSignalProbe(root, 'hard-stop');
    expect(result).toMatchObject({ exitCode: 1, spawnError: { code: 'ENOENT' } });
    expect(killCalls).toEqual([]);
  });

  it('keeps stderr beside JSONL messages and classifies the diagnostic separately', async () => {
    const f = codexFixture('mixed');
    const result = await f.run();
    expect(result).toMatchObject({ exitCode: 1, adapterError: true, adapterFailureKind: 'forbidden', sessionId: uuid });
    expect(result.output).toContain('interim agent text');
    expect(result.output).toContain('403 Forbidden [controlled]');
    expect(result).not.toHaveProperty('stdout');
    expect(result).not.toHaveProperty('stderr');
    expect(f.calls()).toHaveLength(1);
  });

  it('does not recover a session from an agent message quoting a CLI error', async () => {
    const f = codexFixture('prose');
    expect((await f.run()).exitCode).toBe(1);
    expect(f.calls()).toHaveLength(1);
  });

  it('does not diagnose a launched silent failure by searching PATH after exit', async () => {
    const f = codexFixture('silent');
    const emptyBin = join(f.root, 'empty-bin');
    mkdirSync(emptyBin);
    const timer = setInterval(() => {
      if (existsSync(join(f.root, 'started'))) process.env.PATH = emptyBin;
    }, 5);
    try {
      const result = await f.run();
      expect(result).toMatchObject({ exitCode: 1, output: '' });
      expect(result.friendlyError).toBeUndefined();
      expect(result.spawnError).toBeUndefined();
      expect(process.env.PATH).toBe(emptyBin);
      expect(f.calls()).toHaveLength(1);
    } finally { clearInterval(timer); }
  });

  it('still fails after one attested fresh-session recovery when both invocations fail', async () => {
    const f = codexFixture('dead');
    const result = await f.run();
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('no rollout found');
    const calls = f.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(uuid);
    expect(calls[1]).not.toContain('resume');
  });
});

function markdown(script: string) {
  return '## Reality checks\n```yaml\n' + stringify({ checks: [{
    name: 'check', type: 'exec-script-exit-zero', params: { script },
  }] }) + '```';
}
function admission(script: string) {
  return inspectRealityCheckReachability({ markdown: markdown(script), projectDir: fixture(), stages: [] });
}
describe('boundary 56: printf format operands', () => {
  it.each([
    String.raw`printf '%s\n' diagnostic`, String.raw`printf "%s\n" diagnostic`,
    String.raw`printf -- '%s\n' diagnostic`, String.raw`printf -v result '%s\n' diagnostic`,
    String.raw`/usr/bin/printf '%s\n' diagnostic`, String.raw`command printf '%s\n' diagnostic`,
    String.raw`env MARKER=x printf '%s\n' diagnostic`, String.raw`MARKER=x printf '%s\n' diagnostic`,
    String.raw`if true; then printf '%s\n' diagnostic; fi`,
    String.raw`printf 'docs/unowned.txt\n' diagnostic`,
  ])('does not invent a file from the format in %s', script => {
    expect(admission(script)).toEqual([]);
  });

  it.each([
    String.raw`printf '%s\n' diagnostic; cat '%s\n'`,
    String.raw`printf '%s\n' diagnostic > '%s\n'`,
    String.raw`printf '%s\n' diagnostic; test -s docs/unowned.txt`,
    String.raw`sed -e's/foo/bar/' docs/unowned.txt`,
  ])('still rejects an unproduced file in %s', script => {
    expect(admission(script).join('\n')).toMatch(/references absent (?:%s\/n|docs\/unowned.txt)/);
  });

  it('keeps an empty format distinct from a following path-like data operand', () => {
    expect(admission("printf '' 'docs/unowned.txt'").join('\n')).toContain('references absent docs/unowned.txt');
  });
});

describe('boundary 58: one complete declaration', () => {
  const payload = 'checks:\n  - name: artifact\n    type: file-exists-nonempty\n    params: { paths: [artifact.txt] }';
  const fence = '```yaml\n' + payload + '\n```';
  it.each(['before', 'after', 'both'])('accepts explanation %s the fence', placement => {
    const body = [placement !== 'after' ? 'Explanation.\n' : '', fence, placement !== 'before' ? '\nExplanation.' : ''].join('\n');
    expect(parseChecksFromMarkdown('## Reality checks\n' + body)).toEqual([
      { name: 'artifact', type: 'file-exists-nonempty', params: { paths: ['artifact.txt'] } },
    ]);
  });
  it('allows an unrelated complete text fence before the YAML declaration', () => {
    expect(parseChecksFromMarkdown('## Reality checks\n```text\nExplanation\n```\n' + fence)[0].kind).not.toBe('invalid');
  });
  it.each([
    'Explanation\n```yaml\nchecks: [unterminated\n```',
    'Explanation\n```yaml\nchecks:\n  - name: missing-type\n```',
    'Explanation\n```yaml\n' + payload,
    fence + '\n```yaml\nchecks: [unterminated\n```',
    'checks: [unterminated\n' + fence,
    'checks: [unterminated\n## Reality checks\n' + fence,
    '```json\n{"checks":[]}\n```',
  ])('rejects malformed or competing declarations: %s', body => {
    expect(parseChecksFromMarkdown('## Reality checks\n' + body)[0].kind).toBe('invalid');
  });
  it('does not extract a declaration from the following section', () => {
    expect(parseChecksFromMarkdown('## Reality checks\n```yaml\n' + payload + '\n## Next section\n```')[0].kind).toBe('invalid');
  });
});

function guardFixture() {
  const root = fixture();
  const engine = join(root, 'engine');
  const project = join(root, 'project');
  mkdirSync(join(engine, 'dist'), { recursive: true });
  mkdirSync(project);
  const runtime = join(engine, 'dist', 'runtime.js');
  writeFileSync(runtime, 'protected generation\n');
  return { root, engine, project, runtime };
}
function guardOrSkip(context: TestContext, f: ReturnType<typeof guardFixture>): ValidationWriteGuard {
  try { return prepareValidationWriteGuard(f.project, f.engine); }
  catch (error) {
    if (/Landlock|unsupported Linux syscall architecture|spawnSync python3 ENOENT/.test(String(error))) context.skip();
    throw error;
  }
}
function guarded(guard: ValidationWriteGuard, project: string, script: string, env = process.env) {
  const request = guard.wrap({ role: 'test', command: process.execPath, args: ['-e', script], cwd: project,
    display: 'controlled node fixture', env: { ...env, HOME: env.HOME ?? project, FC_HOME: join(project, 'state') } });
  return runValidationCommand(request);
}
describe.skipIf(process.platform !== 'linux')('boundary 57: protected generation aliases and HOME', () => {
  it('admits closed generation links while denying descendant writes through protected paths and symlinks', async context => {
    const f = guardFixture();
    const generation = join(f.engine, '.cache', 'build-generations', 'previous');
    mkdirSync(generation, { recursive: true });
    linkSync(f.runtime, join(generation, 'runtime.js'));
    symlinkSync(f.runtime, join(f.project, 'alias'));
    const guard = guardOrSkip(context, f);
    try {
      const script = `const fs=require('fs'); const cp=require('child_process');
        const child=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(f.runtime)},'bad')`)}],{encoding:'utf8'});
        let alias;try{fs.writeFileSync('alias','bad');alias='ALLOWED'}catch(e){alias=e.code}
        fs.writeFileSync('owned-output','ok');console.log(JSON.stringify({child:child.status,error:child.stderr,alias}));`;
      const result = await guarded(guard, f.project, script);
      expect(result.exitCode, result.stderr).toBe(0);
      const observation = JSON.parse(result.stdout ?? '');
      expect(observation.child).toBe(1);
      expect(observation.error).toContain('EACCES');
      expect(observation.alias).toBe('EACCES');
      expect(readFileSync(f.runtime, 'utf8')).toBe('protected generation\n');
      expect(readFileSync(join(generation, 'runtime.js'), 'utf8')).toBe('protected generation\n');
    } finally { guard.cleanup(); }
  });

  it.each(['project', 'unknown'])('refuses an existing %s hard-link alias before command execution', (where, context) => {
    const f = guardFixture();
    const capability = guardOrSkip(context, f); capability.cleanup();
    linkSync(f.runtime, join(where === 'project' ? f.project : f.root, 'alias'));
    expect(() => prepareValidationWriteGuard(f.project, f.engine)).toThrow('unaccounted hard links');
    expect(readFileSync(f.runtime, 'utf8')).toBe('protected generation\n');
  });

  it('preserves home and config reads, denies ambient home writes, and supplies a writable private cache', async context => {
    const f = guardFixture();
    const home = join(f.root, 'ambient-home');
    const config = join(home, 'config'); mkdirSync(config, { recursive: true });
    writeFileSync(join(home, 'marker'), 'home marker');
    writeFileSync(join(config, 'marker'), 'config marker');
    const guard = guardOrSkip(context, f);
    try {
      const result = await guarded(guard, f.project, String.raw`
        const fs=require('fs'),path=require('path');
        const home=fs.readFileSync(path.join(process.env.HOME,'marker'),'utf8');
        const config=fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME,'marker'),'utf8');
        let write;try{fs.writeFileSync(path.join(process.env.HOME,'forbidden'),'bad');write='ALLOWED'}catch(e){write=e.code}
        fs.mkdirSync(process.env.XDG_CACHE_HOME,{recursive:true});fs.writeFileSync(path.join(process.env.XDG_CACHE_HOME,'owned-cache'),'ok');
        console.log(JSON.stringify({home,config,write}));
      `, { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout ?? '')).toEqual({ home: 'home marker', config: 'config marker', write: 'EACCES' });
      expect(existsSync(join(home, 'forbidden'))).toBe(false);
    } finally { guard.cleanup(); }
  });
});
