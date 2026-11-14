import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import './test-support/policy-runtime.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { WrittenBrief } from '../src/brief-writer.js';
import type { BriefAdmissionRecord } from '../src/brief-admission.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';
import { GitStandIn, success } from './test-support/git-stand-in.js';

const fixture = vi.hoisted(() => ({
  git: undefined as unknown as GitStandIn, authored: 0, refusals: [] as string[], error: undefined as unknown,
  pushes: [] as string[], backendCalls: 0, generated: undefined as WrittenBrief | undefined,
  setupExit: 1, emptySetup: false, setupCalls: [] as string[][], launches: [] as BriefAdmissionRecord[],
}));
// The CLI and scheduler are in-process policy stubs here. Keep the new runtime
// boundary on that same module graph; native pinning has separate process tests.
vi.mock('../src/build-manifest.js', async original => ({
  ...await original<typeof import('../src/build-manifest.js')>(),
  selectTaskRuntime: () => ({generation:'f'.repeat(64),cliPath:new URL('../src/cli.js',import.meta.url).pathname}),
  validateTaskRuntime: (runtime: {cliPath:string}) => runtime.cliPath,
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
  loadAdapterByName: async () => ({ run: () => { fixture.backendCalls++; if (!fixture.generated) throw new Error('No backend');
    return { output: 'Controlled adapter completed.', exitCode: 0, duration_ms: 0 }; } }) }));
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
    if (fixture.generated) return fixture.generated;
    return { brief: 'Fixture', digest: 'fixture', outcome: 'blocking_questions', questions: ['Fixture question'], reasons: [] };
  },
}));
// Stub setup's commands and downstream execution, retaining real record reads,
// measured identities and both launch assertions. No elapsed-time wait is used.
vi.mock('../src/cli-ship-setup.js', () => ({
  runShipSetup: async (args: string[]) => {
    fixture.setupCalls.push(args);
    const target = args[args.indexOf('--target') + 1];
    mkdirSync(target, { recursive: true });
    const { fcGlobalDir } = await import('../src/store.js');
    const path = writeReadySetupRecord(target, fixture.generated!.brief, fcGlobalDir());
    const setup = JSON.parse(readFileSync(path, 'utf8'));
    const command = setup.validationBaseline.discovery.commands[0];
    setup.validationBaseline.discovery.commands = ['build', 'test', 'lint'].map(role => ({ ...command, role, display: `stub ${role}` }));
    setup.validationBaseline.results = setup.validationBaseline.discovery.commands.map((command: object) => ({
      ...setup.validationBaseline.results[0], ...command, exitCode: fixture.setupExit, durationMs: 0,
    }));
    if (fixture.emptySetup) { setup.validationBaseline.discovery.commands = []; setup.validationBaseline.results = []; }
    writeFileSync(path, JSON.stringify(setup));
    return setup;
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
  fixture.pushes = []; fixture.backendCalls = 0; fixture.generated = undefined;
  fixture.setupExit = 1; fixture.emptySetup = false; fixture.setupCalls = []; fixture.launches = [];
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
  const {TaskRegistry: Registry}=await import('../src/task-registry.js');
  new Registry().create({projectDir:project,run_id:'prior',status:'failed',brief_text:brief,
    brief_admission:createBriefAdmission(inspectBrief(brief),{kind:'not_required'}),
    runtime:{generation:'f'.repeat(64),cliPath:new URL('../src/cli.js',import.meta.url).pathname},
    foregroundOwner:{pid:2147483647},launcher:{frontend:'codex',sessionId:'fixture',cwd:process.env.FLOWCREW_VITEST_ROOT!,
      ledgerRoot:join(process.env.FLOWCREW_VITEST_ROOT!,'ledger')}});
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

const generatedBrief = '---\ncriteria: [{id: fixture_1, text: Preserve launch permission.}]\n---\n# Generated launch';
async function quick(target: string, extra: string[] = []) {
  vi.resetModules();
  const { setFcGlobalDir } = await import('../src/store.js');
  setFcGlobalDir(join(root, 'fc'));
  process.exitCode = 0;
  if (fixture.generated) {
    const scheduler = await import('../src/scheduler.js');
    vi.spyOn(scheduler, 'runWorkflow').mockImplementation(async (...args) => {
      const { assertMeasuredSetupLaunch } = await import('../src/ship-setup-record.js');
      assertMeasuredSetupLaunch(args[2], args[8]!, args[11]);
      fixture.launches.push(args[11]!);
      await args[3].run('Controlled work', {} as never, {} as never);
      return { runId: 'controlled', status: 'complete', stages: {} } as Awaited<ReturnType<typeof scheduler.runWorkflow>>;
    });
  }
  process.argv = [process.execPath, 'fixture-cli', 'quick', '--task', generatedBrief,
    '--project', target, '--adapter', 'mock', '--no-campaign', ...extra];
  await import('../src/cli.js');
}
function generated() {
  const evidenceDir = join(root, 'brief-writing'); mkdirSync(evidenceDir);
  fixture.generated = { brief: generatedBrief, digest: inspectBrief(generatedBrief).digest,
    outcome: 'ready', questions: [], reasons: [], evidenceDir };
  writeFileSync(join(evidenceDir, 'brief.md'), generatedBrief);
}

it('generated brief with red setup and a pre-measurement bare flag is held before any adapter starts; repeating with the flag launches', async () => {
  generated();
  await quick(project, ['--acknowledge-brief-warnings']);
  expect(process.exitCode).toBe(1);
  expect(fixture.backendCalls).toBe(0); expect(fixture.launches).toHaveLength(0);
  expect(fixture.setupCalls).toHaveLength(1);
  expect(fixture.refusals).toEqual([expect.stringContaining('setup_acknowledgement_required')]);
  const output = vi.mocked(console.error).mock.calls.flat().join('\n');
  for (const role of ['build', 'test', 'lint']) expect(output).toContain(`${role}: stub ${role} exit=1`);
  expect(output).toContain('Setup acknowledgement: REQUIRED');
  // Repeat the identical command; its generated target already has the measurement.
  const args = fixture.setupCalls[0]; const target = args[args.indexOf('--target') + 1];
  const { inspectShipSetupRecord, measuredSetupFacts } = await import('../src/ship-setup-record.js');
  const setup = inspectShipSetupRecord(target, generatedBrief);
  expect(setup.state).toBe('ready');
  await quick(project, ['--acknowledge-brief-warnings']);
  expect(process.exitCode).toBe(0); expect(fixture.backendCalls).toBe(1);
  expect(fixture.setupCalls).toHaveLength(1); expect(fixture.launches).toHaveLength(1);
  expect(fixture.launches[0].acknowledgement).toMatchObject({ kind: 'explicit',
    measuredSetupIdentity: measuredSetupFacts((setup as Extract<typeof setup, {state: 'ready'}>).validationBaseline).identity });
});

it.each(['green', 'empty'] as const)('generated brief with %s setup launches in the measurement invocation', async scenario => {
  generated(); fixture.setupExit = 0; fixture.emptySetup = scenario === 'empty';
  await quick(project);
  expect(process.exitCode).toBe(0); expect(fixture.setupCalls).toHaveLength(1);
  expect(fixture.backendCalls).toBe(1); expect(fixture.launches).toHaveLength(1);
  expect(fixture.refusals).toEqual([]);
});

it.each(['changed results', 'changed target', 'skipped', 'absent'] as const)('foreground CLI refuses %s measured consent before any adapter starts', async scenario => {
  fixture.generated = { brief: generatedBrief, digest: inspectBrief(generatedBrief).digest, outcome: 'ready', questions: [], reasons: [] };
  const { fcGlobalDir, setFcGlobalDir } = await import('../src/store.js');
  setFcGlobalDir(join(root, 'fc'));
  const { measuredSetupFacts } = await import('../src/ship-setup-record.js');
  const path = writeReadySetupRecord(project, generatedBrief, fcGlobalDir());
  const setup = JSON.parse(readFileSync(path, 'utf8')); setup.validationBaseline.results[0].exitCode = 1;
  const receipt = createBriefAdmission(inspectBrief(generatedBrief), { kind: 'explicit', source: 'cli_current_input_flag',
    at: '2030-01-01T00:00:00Z', measuredSetupIdentity: measuredSetupFacts(setup.validationBaseline).identity });
  let target = project;
  if (scenario === 'changed results') setup.validationBaseline.results[0].exitCode = 2;
  if (scenario === 'skipped') setup.validationBaseline.execution = 'skipped';
  if (scenario === 'absent') delete setup.validationBaseline.execution;
  writeFileSync(path, JSON.stringify(setup));
  if (scenario === 'changed target') {
    target = join(root, 'another'); mkdirSync(target);
    const anotherPath = writeReadySetupRecord(target, generatedBrief, fcGlobalDir());
    const another = JSON.parse(readFileSync(anotherPath, 'utf8')); another.validationBaseline.results[0].exitCode = 1;
    writeFileSync(anotherPath, JSON.stringify(another));
  }
  await quick(target, ['--brief-admission-record', Buffer.from(JSON.stringify(receipt)).toString('base64url'),
    ...(scenario === 'skipped' || scenario === 'absent' ? ['--acknowledge-brief-warnings'] : [])]);
  expect(process.exitCode).toBe(1); expect(fixture.backendCalls).toBe(0);
  expect(fixture.refusals).toEqual([expect.stringContaining(scenario === 'skipped' || scenario === 'absent'
    ? 'setup_unmeasured' : 'setup_acknowledgement_required')]);
});
