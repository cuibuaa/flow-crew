import './test-support/policy-runtime.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectBrief } from '../src/brief-preflight.js';
import { publicTaskEntries, readTaskLedger } from '../src/fc-tasks.js';
import { startRpcServer } from '../src/orchestrator-rpc.js';
import { TaskRegistry } from '../src/task-registry.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';

const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
const tsxLoader = import.meta.resolve('tsx');
const brief = '# Ledger registration\n\n## What the report must show\n1. Registration retains its wrap-up obligation.\n';
let root: string;
let project: string;
let engine: string;
let ledger: string;
let registry: TaskRegistry;
let server: Server;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fc-ql-'));
  project = join(root, 'project');
  engine = join(root, 'fc');
  ledger = join(root, 'ledger');
  for (const path of [project, engine, join(root, 'home'), join(root, 'tmp')]) mkdirSync(path, { recursive: true });
  writeReadySetupRecord(project, brief, engine);
  registry = new TaskRegistry({ baseDir: engine });
  // Persist through the real registry so create's link verification exercises
  // the same on-disk evidence as a daemon's acknowledged registration.
  server = await startRpcServer(join(engine, 'daemon.sock'), (request) => {
    if (request.cmd !== 'register') throw new Error('Expected register');
    const task = registry.create(request.task);
    return { id: task.id, unit: task.systemd_unit, pid: process.pid, build: 'ledger-test' };
  });
});

afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

async function quick(args: string[] = [], env: NodeJS.ProcessEnv = {}, input = brief) {
  const child = spawn(process.execPath, [
    '--import', tsxLoader, cli, 'quick', '--background', '--adapter', 'mock',
    '--no-campaign', '--project', project, ...args, '-',
  ], {
    cwd: project,
    env: {
      ...process.env,
      HOME: join(root, 'home'),
      FC_HOME: engine,
      FC_TASKS_ROOT: ledger,
      TMPDIR: join(root, 'tmp'),
      FLOWCREW_DAEMON_SOCKET: join(engine, 'daemon.sock'),
      FLOWCREW_LAUNCH_RESULT_PATH: undefined,
      CLAUDE_CODE_SESSION_ID: undefined,
      CODEX_THREAD_ID: undefined,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 20_000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

describe('quick registration ledger', () => {
  it.each([
    { input: brief, args: [], workflow: 'direct', note: true },
    { input: `---\nworkflow: planner\n---\n${brief}`, args: [], workflow: 'planner', note: false },
    { input: brief, args: ['--workflow', 'planner'], workflow: 'planner', note: false },
    { input: brief, args: ['--workflow', 'default'], workflow: 'planner', note: false },
  ])('records $workflow with auto-selection note=$note for $args', async ({ input, args, workflow, note }) => {
    writeReadySetupRecord(project, input, engine);
    const result = await quick(args, {}, input);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(registry.list()[0].launch_options?.workflow).toBe(workflow);
    expect(result.stderr.includes('auto-selected --workflow')).toBe(note);
  });

  it.each([
    { args: ['--session', 'explicit'], env: { CLAUDE_CODE_SESSION_ID: 'claude', CODEX_THREAD_ID: 'codex' }, session: 'explicit' },
    { args: ['--session=explicit'], env: { CLAUDE_CODE_SESSION_ID: 'claude' }, session: 'explicit' },
    { args: [], env: { CLAUDE_CODE_SESSION_ID: 'claude', CODEX_THREAD_ID: 'codex' }, session: 'claude' },
    { args: [], env: { CODEX_THREAD_ID: 'codex' }, session: 'codex' },
  ])('creates exactly one linked entry for $session via $args / $env', async ({ args, env, session }) => {
    const result = await quick(args, env);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const tasks = registry.list();
    expect(tasks).toHaveLength(1);
    const id = tasks[0].id;
    if (env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID) {
      expect(tasks[0].launcher).toMatchObject({
        frontend: env.CLAUDE_CODE_SESSION_ID ? 'claude' : 'codex', sessionId: session, cwd: project,
      });
    }
    const entries = publicTaskEntries(readTaskLedger(ledger, session));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      flowcrewTaskId: id,
      status: 'in_progress',
      description: `FlowCrew task ${id} is registered; wrap-up remains: read the result, verify it independently, archive unique output, and reclaim the worktree and branch.\nBrief digest: ${inspectBrief(brief).digest}`,
    });
    expect(readdirSync(ledger)).toEqual([session]);
    expect(result.stdout).toContain(`fc_tasks: created ${session}/${entries[0].id}`);
    expect(result.stderr).not.toContain('Warning:');
    expect(tasks[0]).not.toHaveProperty('launch_args');
    expect(tasks[0].launch_options).not.toHaveProperty('session');
  });

  it.each([undefined, ''])('prints a single create hint without a session (%s) and still registers successfully', async (session) => {
    const result = await quick([], { CLAUDE_CODE_SESSION_ID: session, CODEX_THREAD_ID: session });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const tasks = registry.list();
    expect(tasks).toHaveLength(1);
    expect(existsSync(ledger)).toBe(false);
    const hints = result.stdout.split('\n').filter((line) => line.includes('no ledger entry was created'));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("flowcrew 'fc_tasks' 'create'");
    expect(hints[0]).toContain(`'--flowcrew-task-id' '${tasks[0].id}'`);
    expect(hints[0]).toContain("--session '<session-id>'");
    expect(hints[0]).toContain(inspectBrief(brief).digest);
  });

  it('warns on a ledger write failure while preserving registration and exit zero', async () => {
    writeFileSync(ledger, 'A file cannot contain a session ledger.');
    const result = await quick(['--session', 'blocked']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const tasks = registry.list();
    expect(tasks).toHaveLength(1);
    expect(result.stdout).toContain(`Task #${tasks[0].id} registered`);
    expect(result.stderr).toContain(`Warning: task #${tasks[0].id} remains registered, but no ledger entry was created:`);
    expect(result.stderr).toContain('fc_tasks: refused create');
    expect(result.stdout).not.toContain('fc_tasks: created');
  });

  it('reports an invalid session without falling back or undoing registration', async () => {
    const result = await quick(['--session', '../unsafe'], { CODEX_THREAD_ID: 'valid-fallback' });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(registry.list()).toHaveLength(1);
    expect(result.stderr).toContain('session_invalid');
    expect(result.stderr).toContain('Warning:');
    expect(existsSync(ledger)).toBe(false);
  });
});
