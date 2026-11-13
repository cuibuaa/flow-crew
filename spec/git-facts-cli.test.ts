import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import './test-support/policy-runtime.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { GitStandIn, success } from './test-support/git-stand-in.js';

const fixture = vi.hoisted(() => ({
  git: undefined as unknown as GitStandIn, authored: 0, refusals: [] as string[], error: undefined as unknown,
  pushes: [] as string[], backendCalls: 0,
}));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual,
    spawnSync: (file: string, args: string[], options: object) => file === 'git'
      ? fixture.git.sync(args, options) : actual.spawnSync(file, args, options),
    execFileSync: (file: string, args: string[], options: object) => file === 'git'
      ? fixture.git.exec(args, options) : actual.execFileSync(file, args, options),
  };
});
vi.mock('../src/adapters/loader.js', async original => ({ ...await original<typeof import('../src/adapters/loader.js')>(),
  loadAdapterByName: async () => ({ run: () => { fixture.backendCalls++; throw new Error('No backend'); } }) }));
vi.mock('../src/session-push.js', async original => ({ ...await original<typeof import('../src/session-push.js')>(),
  captureLauncher: () => ({ frontend: 'codex', sessionId: 'fixture', cwd: process.env.FLOWCREW_VITEST_ROOT!,
    ledgerRoot: join(process.env.FLOWCREW_VITEST_ROOT!, 'ledger') }),
  SessionPush: class {
    constructor(private registry: { get(id: number): { status: string } | undefined }) {}
    async sweep(id: number) { fixture.pushes.push(this.registry.get(id)!.status); }
  },
}));
vi.mock('../src/rehearse.js', () => ({ rehearseBrief: async () => ({ findings: [] }) }));
vi.mock('../src/brief-writer.js', async original => ({
  ...await original<typeof import('../src/brief-writer.js')>(),
  writeTaskBrief: async () => {
    fixture.authored++;
    return { brief: 'Fixture', digest: 'fixture', outcome: 'blocking_questions', questions: ['Fixture question'], reasons: [] };
  },
}));
vi.mock('../src/supervision.js', async original => ({
  ...await original<typeof import('../src/supervision.js')>(),
  recordLaunchRefusal: (reason: string) => { fixture.refusals.push(reason); },
}));
vi.mock('../src/orchestrator-rpc.js', async original => ({
  ...await original<typeof import('../src/orchestrator-rpc.js')>(),
  rpcErrorExitCode: (error: unknown) => { fixture.error = error; return 1; },
}));

let root: string, project: string, argv: string[], exitCode: typeof process.exitCode;
let stdoutErrors: ReturnType<typeof process.stdout.listeners>;
let stderrErrors: ReturnType<typeof process.stderr.listeners>, exitListeners: ReturnType<typeof process.listeners>;
const exit = new Error('fixture process exit');
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  root = mkdtempSync(join(process.env.FLOWCREW_VITEST_ROOT!, 'git-cli-')); project = join(root, 'project'); mkdirSync(project);
  argv = process.argv; exitCode = process.exitCode;
  process.argv = [process.execPath, 'fixture-cli', 'brief', 'Do work', '--project', project, '--adapter', 'mock'];
  stdoutErrors = process.stdout.listeners('error'); stderrErrors = process.stderr.listeners('error'); exitListeners = process.listeners('exit');
  fixture.authored = 0; fixture.refusals = []; fixture.error = undefined; fixture.git = new GitStandIn();
  fixture.pushes = []; fixture.backendCalls = 0;
  fixture.git.answer = args => success(args.includes('--show-toplevel') ? project : args.includes('HEAD') ? 'a'.repeat(40) : '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => { throw exit; });
});
afterEach(() => {
  for (const listener of process.stdout.listeners('error')) if (!stdoutErrors.includes(listener)) process.stdout.removeListener('error', listener);
  for (const listener of process.stderr.listeners('error')) if (!stderrErrors.includes(listener)) process.stderr.removeListener('error', listener);
  for (const listener of process.listeners('exit')) if (!exitListeners.includes(listener)) process.removeListener('exit', listener);
  process.argv = argv; process.exitCode = exitCode;
  vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
});

it.each([false, true])('raw-task CLI admission waits for root, HEAD and status (held=%s)', async held => {
  fixture.git.held = held;
  fixture.git.onHold = release => {
    vi.advanceTimersByTime(10 ** 10); expect(fixture.authored).toBe(0); release();
  };
  await import('../src/cli.js');
  expect(fixture.git.calls).toEqual([
    ['rev-parse', '--show-toplevel'], ['rev-parse', '--verify', 'HEAD'], ['status', '--porcelain', '--untracked-files=normal'],
  ]);
  expect(fixture.authored).toBe(1); expect(fixture.refusals).toEqual([]);
});

it.each(['--show-toplevel', 'HEAD', 'status'])('raw-task CLI preserves typed termination of %s without a launch refusal', async target => {
  const answer = fixture.git.answer;
  fixture.git.answer = (args, options) => args.includes(target) ? { status: null, signal: 'SIGTERM' } : answer(args, options);
  await expect(import('../src/cli.js')).rejects.toBe(exit);
  const { GitNotAnswered } = await import('../src/git-facts.js');
  expect(fixture.error).toBeInstanceOf(GitNotAnswered);
  expect(fixture.authored).toBe(0); expect(fixture.refusals).toEqual([]);
});

it('raw-task CLI retains its existing refusal for a real Git error', async () => {
  fixture.git.answer = () => ({ status: 128 });
  await import('../src/cli.js');
  expect(fixture.authored).toBe(0);
  expect(fixture.refusals).toEqual([expect.stringContaining('automatic setup requires a Git working tree')]);
});

it('foreground scheduler termination preserves the running task and never sends a terminal push', async () => {
  const store = await import('../src/store.js');
  const { GitNotAnswered } = await import('../src/git-facts.js');
  const { WorkflowConfigSchema } = await import('../src/scheduler.js');
  const directory = join(store.runsRoot(), 'prior');
  mkdirSync(join(directory, 'engine', 'stages', 'work'), { recursive: true });
  mkdirSync(join(directory, 'work'), { recursive: true });
  // This control interrupts Git before author dispatch; no independent review criterion is assigned.
  const brief = '# Goal\nComplete the work.\n';
  const workflow = WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 3, max_retries: 0 },
    stages: [{ id: 'work', role: 'coder', depends_on: [], scope: [], artifact_contract: { version: 1, produces: [], reads: [] } }] });
  writeFileSync(join(directory, 'run.json'), JSON.stringify({ storageLayout: 2, briefAdmission: createBriefAdmission(inspectBrief(brief), { kind: 'not_required' }), runId: 'prior', projectDir: project,
    workflowName: workflow.name, status: 'incomplete', startedAt: '2000-01-01T00:00:00Z', currentIteration: 1,
    maxIterations: 3, maxRetries: 0, baseCommit: 'a'.repeat(40), taskDescription: brief, briefConfigured: true,
    stages: { work: { status: 'pending', retries: 0 } } }));
  writeFileSync(join(directory, 'engine', 'workflow.yaml'), stringify(workflow));
  writeFileSync(join(directory, 'engine', 'task_brief.md'), brief);
  process.argv = [process.execPath, 'fixture-cli', 'quick', '--project', project, '--existing-run-id', 'prior',
    '--adapter', 'mock', '--no-campaign', '--acknowledge-brief-warnings'];
  fixture.git.answer = args => args[0] === 'diff' && args.includes('--binary')
    ? { status: null, signal: 'SIGTERM' } : args[0] === 'rev-parse'
      ? success(args.includes('--show-toplevel') ? project : 'a'.repeat(40))
      : args[0] === 'config' ? { status: 1 } : success();
  await expect(import('../src/cli.js')).rejects.toBe(exit);
  expect(fixture.error).toBeInstanceOf(GitNotAnswered);
  expect(fixture.backendCalls).toBe(0);
  const { TaskRegistry, TASK_LIST_STATUS } = await import('../src/task-registry.js');
  const tasks = new TaskRegistry().list({ status: TASK_LIST_STATUS.ALL });
  expect(tasks).toHaveLength(1); expect(tasks[0].status).toBe('running');
  expect(fixture.pushes).toEqual(['running']);
});
