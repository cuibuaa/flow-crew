import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter, AgentConfig, RunOpts } from '../src/adapters/base.js';
import { execWithStdin } from '../src/adapters/base.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { createInvocationScratch, retireRunScratch } from '../src/invocation-scratch.js';
import { processStartToken } from '../src/run-lock.js';

const role: AgentConfig = { name: 'fixture', description: '', model: 'fixture', reasoning_effort: 'low', tools: ['Bash'], prompt: 'Write test evidence in private scratch.' };
let root: string, runDir: string, project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-scratch-spec-'));
  runDir = join(root, 'control', 'runs', 'fixture'); project = join(root, 'project');
  for (const directory of ['bin', 'project', 'home', 'source', 'plugins', 'skills']) mkdirSync(join(root, directory));
  mkdirSync(runDir, { recursive: true });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('USERPROFILE', join(root, 'home'));
  vi.stubEnv('CODEX_HOME', join(root, 'source'));
  vi.stubEnv('CODEX_PLUGINS_CACHE', join(root, 'plugins'));
  vi.stubEnv('CODEX_SKILLS_CACHE', join(root, 'skills'));
  vi.stubEnv('PATH', join(root, 'bin'));
  for (const name of ['claude', 'codex']) writeFileSync(join(root, 'bin', name), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const emit = text => {
    if (path.basename(process.argv[1]) === 'claude') console.log(JSON.stringify({ type: 'result', subtype: 'success', result: text }));
    else {
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }));
    }
  };
  if (request.action === 'read') {
    const evidence = fs.readFileSync(request.citation, 'utf8');
    if (evidence !== 'tests passed\n') throw Error('evidence corrupted');
    emit('readable: ' + request.citation);
    return;
  }
  if (process.env.TMPDIR !== process.env.TMP || process.env.TMPDIR !== process.env.TEMP) throw Error('temporary environment differs');
  const citation = path.join(process.env.TMPDIR, 'test.log');
  const finish = () => {
    fs.writeFileSync(citation, 'tests passed\n');
    if (request.ready) fs.writeFileSync(request.ready, citation);
    if (request.action === 'hang') setInterval(() => {}, 1000);
    else emit(citation);
  };
  if (!request.socket) { finish(); return; }
  const server = net.createServer();
  server.on('error', error => { throw error; });
  server.listen(path.join(process.env.TMPDIR, 'validation-service.sock'), () => server.close(finish));
});
`, { mode: 0o700 });
});

afterEach(() => {
  try { retireRunScratch(runDir); }
  finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});

function invoke(adapter: Adapter, stageId: string, request: object, options: Partial<RunOpts> = {}) {
  return adapter.run(JSON.stringify(request), role, { workDir: project, runDir, stageId, timeout_ms: 10_000, ...options });
}

function retire(citation: string): void {
  // The alias and its bytes have the same retention boundary as the run report.
  retireRunScratch(runDir);
  rmSync(runDir, { recursive: true, force: true });
  expect(existsSync(citation)).toBe(false);
  expect(existsSync(runDir)).toBe(false);
}

function clean(): string {
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), new URL('../src/cli.ts', import.meta.url).pathname, 'clean', '--keep', '0'], {
    cwd: project, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, HOME: join(root, 'home'), FC_HOME: join(root, 'control'), PROJECT_DIR: project },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('invocation scratch lifetime without provider calls', () => {
  it.each([
    ['Claude', () => new ClaudeAdapter()],
    ['Codex', () => new CodexAdapter()],
  ] as const)('%s preserves author evidence for later gates, repairs and the final report', async (_name, createAdapter) => {
    const adapter = createAdapter();
    const authors = await Promise.all(['author-a', 'author-b'].map(stageId => invoke(adapter, stageId, { action: 'write' })));
    for (const author of authors) expect(author.exitCode, author.output).toBe(0);
    const citations = authors.map(author => author.output.trim());
    expect(dirname(citations[0])).not.toBe(dirname(citations[1]));
    for (const citation of citations) {
      for (const stageId of ['gate', 'repair', 'final-report']) {
        const reader = await invoke(adapter, stageId, { action: 'read', citation });
        expect(reader.exitCode, reader.output).toBe(0);
        expect(reader.output).toBe(`readable: ${citation}`);
      }
      expect(realpathSync(citation)).toContain(join(runDir, 'scratch'));
      expect(readFileSync(citation, 'utf8')).toBe('tests passed\n');
    }
    const payloads = citations.map(citation => realpathSync(citation));
    retire(citations[0]);
    for (const path of [...citations, ...payloads]) expect(existsSync(path)).toBe(false);
  });

  it.each([
    ['Claude', () => new ClaudeAdapter()],
    ['Codex', () => new CodexAdapter()],
  ] as const)('%s supplies a short TMPDIR that can bind a validation Unix socket', async (_name, createAdapter) => {
    const author = await invoke(createAdapter(), 'socket-author', { action: 'write', socket: true });
    expect(author.exitCode, author.output).toBe(0);
    const citation = author.output.trim();
    expect(Buffer.byteLength(join(dirname(citation), 'validation-service.sock'))).toBeLessThan(108);
    expect(readFileSync(citation, 'utf8')).toBe('tests passed\n');
  });

  it.each([
    ['Claude', () => new ClaudeAdapter()],
    ['Codex', () => new CodexAdapter()],
  ] as const)('%s retains cancellation evidence until run retirement', async (_name, createAdapter) => {
    const controller = new AbortController();
    const ready = join(root, 'ready');
    const running = invoke(createAdapter(), 'author', { action: 'hang', ready }, { abortSignal: controller.signal });
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 8_000 });
      const citation = readFileSync(ready, 'utf8');
      controller.abort();
      expect((await running).exitCode).toBe(137);
      expect(readFileSync(citation, 'utf8')).toBe('tests passed\n');
      const payload = realpathSync(citation);
      retire(citation);
      expect(existsSync(payload)).toBe(false);
    } finally { controller.abort(); await running; }
  });

  it('recovers scratch ownership after abrupt process death and retires every payload', () => {
    const ready = join(root, 'crashed-citation');
    const moduleUrl = new URL('../src/invocation-scratch.ts', import.meta.url).href;
    const crash = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { createInvocationScratch } from ${JSON.stringify(moduleUrl)};
      const scratch = createInvocationScratch(${JSON.stringify(runDir)});
      const citation = join(scratch.path, 'test.log');
      writeFileSync(citation, 'tests passed\\n');
      writeFileSync(${JSON.stringify(ready)}, citation);
      process.kill(process.pid, 'SIGKILL');
    `], {
      cwd: project, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: join(root, 'home'), FC_HOME: join(root, 'control') },
    });
    expect(crash.signal, crash.stderr).toBe('SIGKILL');
    const citation = readFileSync(ready, 'utf8');
    const payload = realpathSync(citation);
    expect(readFileSync(citation, 'utf8')).toBe('tests passed\n');
    // Recovery can allocate again without disowning the crashed invocation.
    const recovered = createInvocationScratch(runDir);
    expect(recovered.path).not.toBe(dirname(citation));
    recovered.cleanup();
    expect(existsSync(citation)).toBe(true);
    const recoveredPayload = realpathSync(recovered.path);
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ runId: 'fixture', status: 'failed' }));
    expect(clean()).toContain('Cleaned 1');
    for (const path of [payload, recovered.path, recoveredPayload]) expect(existsSync(path)).toBe(false);
  });

  it('keeps a nested run\'s short scratch independent of its parent run lifetime', () => {
    const parentRunDir = join(root, 'parent-run');
    try {
      const parent = createInvocationScratch(parentRunDir);
      vi.stubEnv('TMPDIR', parent.path);
      const child = createInvocationScratch(runDir);
      const citation = join(child.path, 'test.log');
      writeFileSync(citation, 'tests passed\n');
      expect(dirname(dirname(child.path))).toBe(dirname(dirname(parent.path)));
      expect(Buffer.byteLength(child.path)).toBe(Buffer.byteLength(parent.path));
      retireRunScratch(parentRunDir);
      rmSync(parentRunDir, { recursive: true, force: true });
      expect(readFileSync(citation, 'utf8')).toBe('tests passed\n');
      const payload = realpathSync(citation);
      retire(citation);
      expect(existsSync(payload)).toBe(false);
    } finally {
      retireRunScratch(parentRunDir);
      rmSync(parentRunDir, { recursive: true, force: true });
    }
  });

  it('clean preserves a crashed controller\'s live owned consumer, then retires its history', async () => {
    const scratch = createInvocationScratch(runDir);
    const citation = join(scratch.path, 'test.log');
    writeFileSync(citation, 'tests passed\n');
    const payload = realpathSync(citation);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: project, detached: true, stdio: 'ignore',
      env: { ...process.env, HOME: join(root, 'home'), FC_HOME: join(root, 'control') },
    });
    await once(child, 'spawn');
    const exited = once(child, 'exit');
    try {
      writeFileSync(join(runDir, 'run.json'), JSON.stringify({
        runId: 'fixture', status: 'failed',
        engineCheckpoint: { version: 2, processes: [{ pid: child.pid, processStart: processStartToken(child.pid!) }] },
      }));
      expect(clean()).toContain('Skipped 1 live run(s)');
      expect(readFileSync(citation, 'utf8')).toBe('tests passed\n');
      child.kill('SIGKILL');
      await exited;
      expect(clean()).toContain('Cleaned 1');
      for (const path of [citation, payload, runDir]) expect(existsSync(path)).toBe(false);
    } finally { child.kill('SIGKILL'); await exited; }
  });

  it('still retires scratch immediately for commands without a run owner', async () => {
    const result = await execWithStdin(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => console.log(process.env.TMPDIR))'], '', { cwd: project, timeout_ms: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(existsSync(result.output.trim())).toBe(false);
  });
});
