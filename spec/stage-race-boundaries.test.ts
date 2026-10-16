import './test-support/policy-runtime.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import * as engineFs from '../src/engine-fs.js';
import { buildStagePrompt } from '../src/handoff.js';
import { stageRaceAdapter } from '../src/scheduler/sched_loop/stage-race.js';
import type { GateRuntimeFacts } from '../src/scheduler/sched_settlement/gate-recovery.js';
import { parseDispatchedStageConfig, type StageConfig, type WorkflowConfig } from '../src/scheduler/sched_admission/configuration.js';
import { initializeReservedRun, readRunState, reserveRun, runDir, updateRunState, writeStageOutput, writeStageStatus } from '../src/store.js';
import type { Adapter, AgentConfig, RunOpts } from '../src/adapters/base.js';
import { StageWatchdog } from '../src/stage-watchdog.js';
import { stageLiveLogPath } from '../src/stage-live-log.js';
import * as processLiveness from '../src/process-liveness.js';

const workflowMock = vi.hoisted(() => vi.fn());
vi.mock('../src/scheduler/sched_loop/run-workflow.js', () => ({ runWorkflow: workflowMock }));
vi.mock('../src/scheduler/sched_settlement/gate-recovery.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/scheduler/sched_settlement/gate-recovery.js')>(),
  collectGateRuntimeFacts: (stages: StageConfig[], state: { status: string }): GateRuntimeFacts => {
    const verdict = { pass: state.status === 'complete', reason: 'Fixture independent gate result.' };
    const gates = stages.filter(stage => stage.is_gate);
    const rejectedGateIds = verdict.pass ? [] : gates.map(stage => stage.id);
    return { allPass: verdict.pass, failedGateIds: rejectedGateIds, rejectedGateIds, contractRefusals: [],
      evaluations: gates.map(stage => ({ id: stage.id, status: 'complete', attempts: 1,
        authoredVerdict: verdict, effectiveVerdict: verdict })) };
  },
}));
const role: AgentConfig = { name: 'coder', description: 'Fixture author', model: 'default', reasoning_effort: 'high', tools: ['write'], prompt: 'Author.' };
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'flowcrew-race-boundary-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** Isolate stage snapshot/integration from the workflow runner; the real runner and
 * executable independent gate are exercised in planner-race and race-workflow specs. */
async function fixture(options: { fail?: boolean; ignored?: boolean; dependency?: boolean; movingPeer?: boolean; contract?: boolean; firstFail?: boolean;
  visibility?: 'full' | 'minimal' | 'none';
  attemptStartedAt?: string;
  beforeRace?: () => void;
  onAuthor?: (project: string, parent: ReturnType<typeof reserveRun>, target: string, id: string) => Promise<void> } = {}) {
  const project = join(directory, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'input.md'), 'frozen predecessor input\n');
  writeFileSync(join(project, 'answer.txt'), 'old answer\n');
  if (options.ignored) {
    writeFileSync(join(project, '.gitignore'), 'ignored*.txt\n');
    writeFileSync(join(project, 'ignored-old.txt'), 'old ignored content\n');
  }
  execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { execFileSync } from 'node:child_process'; execFileSync('git', ['init', '-q']);"],
  { cwd: project, env: { ...process.env, HOME: directory, FC_HOME: join(directory, '.fc') } });
  const stage = parseDispatchedStageConfig({ id: 'work', role: 'coder', scope: ['answer.txt', 'ignored-old.txt', 'ignored-new.txt'], race: true,
    depends_on: options.dependency ? ['prepare'] : [] });
  const gate = parseDispatchedStageConfig({ id: 'review', role: 'qa', depends_on: ['work'], is_gate: true, scope: [] });
  const parent = reserveRun(project); initializeReservedRun(project, parent.runId, 'fixture', 'name: fixture\nstages: []\n', ['work', 'review', 'prepare']);
  writeFileSync(join(parent.runDirPath, 'task_brief.md'), '# Goal\nDeliver the new answer.\n');
  if (options.contract) writeFileSync(join(parent.runDirPath, 'gate_contract.json'), JSON.stringify({ metric: 'quality', threshold: 1 }));
  const fullContext = 'upstream context '.repeat(1500);
  if (options.dependency) {
    mkdirSync(join(parent.runDirPath, 'stages/prepare'), { recursive: true });
    writeFileSync(join(parent.runDirPath, 'stages/prepare/status.json'), JSON.stringify({ status: 'complete' }));
    writeStageOutput(project, parent.runId, 'prepare', fullContext);
  }
  const prompt = buildStagePrompt({ stageId: 'work', dependsOn: stage.depends_on, promptTemplate: 'Deliver the new answer.',
    projectDir: project, runId: parent.runId, runDir: parent.runDirPath });
  const inputs: string[] = [];
  const scores: string[] = [];
  const workflowCalls: Array<{ target: string; args: unknown[] }> = [];
  workflowMock.mockImplementation(async (workflow: WorkflowConfig, _yaml: string, target: string, _adapter: Adapter,
    _agents: unknown, _skills: unknown, _agentsDir: unknown, id: string, ...args: unknown[]) => {
    workflowCalls.push({ target, args });
    initializeReservedRun(target, id, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    await options.onAuthor?.(project, parent, target, id);
    inputs.push(readFileSync(join(target, 'input.md'), 'utf8'));
    if (options.dependency) {
      if (options.visibility === 'none') expect(workflow.stages[0].prompt_template).not.toContain('Context from stage: prepare');
      else if (options.visibility === 'minimal') {
        expect(workflow.stages[0].prompt_template).toContain('Previous stage: prepare');
        expect(workflow.stages[0].prompt_template).not.toContain('upstream context');
      } else expect(workflow.stages[0].prompt_template).toContain('Complete predecessor stage directory:');
      expect(readFileSync(join(runDir(target, id), 'stages/prepare/output.md'), 'utf8')).toBe(fullContext);
      expect(JSON.parse(readFileSync(join(runDir(target, id), 'stages/prepare/status.json'), 'utf8')).status).toBe('complete');
    }
    const failed = options.fail || ((options.contract || options.firstFail) && basename(target) === 'a');
    writeFileSync(join(target, 'answer.txt'), failed ? 'wrong answer\n' : 'new answer\n');
    if (options.ignored) {
      writeFileSync(join(target, 'ignored-old.txt'), 'changed ignored content\n');
      writeFileSync(join(target, 'ignored-new.txt'), 'new ignored content\n');
    }
    writeStageOutput(target, id, 'work', JSON.stringify({ status: 'delivered', summary: 'Delivered.', files_modified: ['answer.txt'], checks: [], caveats: [] }));
    if (options.contract) {
      const path = join(runDir(target, id), 'gate_contract.json');
      const threshold = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).threshold : undefined;
      scores.push(`${basename(target)}:${threshold}`);
    }
    return updateRunState(target, id, state => {
      state.status = failed ? 'incomplete' : 'complete';
      state.stages.work = { status: 'complete', retries: 0, attempts: [{ index: 1, startedAt: new Date().toISOString(), status: 'complete', tokens_in: 3, tokens_out: 7, tokenUsage: 'known' }] };
    });
  });
  if (options.movingPeer) {
    const copy = engineFs.cpSync;
    vi.spyOn(engineFs, 'cpSync').mockImplementation((...args) => {
      const result = copy(...args);
      if (args[0] === project) writeFileSync(join(project, 'input.md'), 'concurrent peer input\n');
      return result;
    });
  }
  const adapter: Adapter = { run: vi.fn(async () => { throw new Error('Candidate execution belongs to the workflow runner'); }) };
  const parentOptions: RunOpts = { timeout_ms: 30000, workDir: project, runDir: parent.runDirPath, stageId: 'work', attemptIndex: 1,
    attemptStartedAt: options.attemptStartedAt ?? new Date().toISOString(), abortSignal: new AbortController().signal,
    onInvocationInput: vi.fn(), onCommandLifecycle: vi.fn(), resumeSessionId: '00000000-0000-4000-8000-000000000000',
    sessionOwnerStageId: 'prepare', preserveSession: true, freshSessionPrompt: 'Continue the author task.' };
  options.beforeRace?.();
  const result = await stageRaceAdapter({ stage, stages: [stage, gate], adapter, agentsDir: join(directory, 'agents'),
    projectDir: project, runDirPath: parent.runDirPath, state: readRunState(project, parent.runId) }).run(prompt, { ...role, handoff_visibility: options.visibility },
    parentOptions);
  return { result, project, parent, inputs, scores, workflowCalls, adapter };
}

describe('stage race boundaries', () => {
  it.each(['live', 'artifact', 'socket', 'silent'] as const)('binds verified child %s progress to the parent idle clock', async signal => {
    const wallClock = Date.now;
    const startedAt = new Date().toISOString();
    const baseline = Date.parse(startedAt);
    let now = baseline;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let bytes = '100';
    vi.spyOn(processLiveness, 'processGroupWork').mockImplementation(() => ({
      startTimeTicks: '1', fingerprint: bytes, readWork: JSON.stringify([['1', bytes]]), ioObserved: true, members: [],
    }));
    let checked = false;
    await fixture({ attemptStartedAt: startedAt, onAuthor: async (project, parent, target, id) => {
      if (basename(target) !== 'a') return;
      const running = { status: 'running' as const, retries: 0,
        attempts: [{ index: 1, startedAt, status: 'running' as const }] };
      for (const [location, run] of [[project, parent.runId], [target, id]]) {
        updateRunState(location, run, state => { state.stages.work = running; });
        writeStageStatus(location, run, 'work', running);
      }
      const parentWatchdog = new StageWatchdog(project, parent.runId, { idleThresholdMs: 600_000 });
      const childWatchdog = new StageWatchdog(target, id, { idleThresholdMs: 600_000 });
      const childRoot = join(runDir(target, id), 'stages/work');
      writeFileSync(join(childRoot, 'command_activity.json'), JSON.stringify({
        version: 1, stageId: 'work', attemptIndex: 1, attemptStartedAt: startedAt, updatedAt: startedAt,
        active: [], completedCount: 0, streamClosed: false, process: { pid: 1, startTimeTicks: '1', kind: 'provider' },
      }));
      now = wallClock();
      await parentWatchdog.tick();
      await childWatchdog.tick();
      now += 600_001;
      if (signal === 'socket') bytes = '200';
      if (signal === 'live' || signal === 'artifact') {
        const path = signal === 'live' ? stageLiveLogPath(runDir(target, id), 'work', 1, startedAt) : join(childRoot, 'evidence.txt');
        writeFileSync(path, 'Verified current-attempt work.\n');
        utimesSync(path, now / 1000, now / 1000);
      }
      await childWatchdog.tick();
      await parentWatchdog.tick();
      expect(existsSync(join(parent.runDirPath, 'signals/abort_work.json'))).toBe(signal === 'silent');
      checked = true;
      parentWatchdog.stop(); childWatchdog.stop();
    } });
    expect(checked).toBe(true);
  });
  it('runs one complete workflow when the first candidate passes', async () => {
    const { result, workflowCalls, adapter } = await fixture();
    expect(result.exitCode, result.output).toBe(0);
    expect(workflowCalls.map(call => basename(call.target))).toEqual(['a']);
    // The runner receives its ordinary arguments through the deadline factory.
    expect(workflowCalls[0].args).toHaveLength(6);
    expect(adapter.run).not.toHaveBeenCalled();
    expect(result.tokens_in).toBe(3); expect(result.tokens_out).toBe(7); expect(result.tokenUsage).toBe('known');
  });
  it('carries ignored artifacts in patches without staging or committing them', async () => {
    const git = (project: string, ...args: string[]) => isolatedProjectCommand('git', args, project, directory);
    const { result, project, parent } = await fixture({ ignored: true, onAuthor: async (_project, _parent, target) => {
      expect(git(target, 'ls-files', '-ci', '--exclude-standard')).toBe('');
      expect(git(target, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('ignored-old.txt');
    } });
    expect(result.exitCode, result.output).toBe(0);
    expect(readFileSync(join(project, 'ignored-old.txt'), 'utf8')).toBe('changed ignored content\n');
    expect(readFileSync(join(project, 'ignored-new.txt'), 'utf8')).toBe('new ignored content\n');
    expect(result.writes).toEqual(['answer.txt', 'ignored-new.txt', 'ignored-old.txt']);
    expect(git(project, 'ls-files', '-ci', '--exclude-standard')).toBe('');
    expect(existsSync(join(project, '.git/index'))).toBe(false);
    const patch = readFileSync(join(parent.runDirPath, 'stages/work/candidate_1_a.patch'), 'utf8');
    expect(patch).toContain('-old ignored content\n+changed ignored content');
    expect(patch).toContain('+new ignored content');
    git(project, 'add', '-A');
    git(project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Delivered answer');
    expect(git(project, 'ls-files', '-ci', '--exclude-standard')).toBe('');
    expect(git(project, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('ignored-');
  });
  it('confines race Git writes when inherited variables point at another repository', async () => {
    const foreign = join(directory, 'foreign'); mkdirSync(foreign);
    writeFileSync(join(foreign, 'sentinel.txt'), 'preserved\n');
    const git = (...args: string[]) => isolatedProjectCommand('git', args, foreign, directory);
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Sentinel');
    const index = readFileSync(join(foreign, '.git/index')), head = git('rev-parse', 'HEAD');
    let result;
    try {
      ({ result } = await fixture({ ignored: true, beforeRace: () => {
        vi.stubEnv('GIT_DIR', join(foreign, '.git'));
        vi.stubEnv('GIT_WORK_TREE', foreign);
        vi.stubEnv('GIT_INDEX_FILE', join(foreign, '.git/index'));
      } }));
    } finally { vi.unstubAllEnvs(); }
    expect(result.exitCode, result.output).toBe(0);
    expect(readFileSync(join(foreign, '.git/index'))).toEqual(index);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(foreign, 'sentinel.txt'), 'utf8')).toBe('preserved\n');
  });
  it('keeps both failed candidate costs in the parent attempt', async () => {
    const { result, workflowCalls } = await fixture({ fail: true });
    expect(result.exitCode).toBe(1);
    expect(workflowCalls.map(call => basename(call.target))).toEqual(['a', 'b']);
    expect(result.tokens_in).toBe(6); expect(result.tokens_out).toBe(14); expect(result.tokenUsage).toBe('known');
  });
  it('accounts for a rejected first candidate and integrates the passing alternative', async () => {
    const { result, project, workflowCalls } = await fixture({ firstFail: true });
    expect(result.exitCode, result.output).toBe(0);
    expect(workflowCalls.map(call => basename(call.target))).toEqual(['a', 'b']);
    expect(readFileSync(join(project, 'answer.txt'), 'utf8')).toBe('new answer\n');
    expect(result.tokens_in).toBe(6); expect(result.tokens_out).toBe(14); expect(result.tokenUsage).toBe('known');
  });
  it('preserves complete predecessor handoffs when inline context overflows', async () => {
    const { result } = await fixture({ dependency: true });
    expect(result.exitCode, result.output).toBe(0);
  });
  it.each(['minimal', 'none'] as const)('preserves the author role handoff visibility of %s', async visibility => {
    const { result } = await fixture({ dependency: true, visibility });
    expect(result.exitCode, result.output).toBe(0);
  });
  it('derives both candidates from the same snapshot despite a concurrent peer write', async () => {
    const { result, inputs, project } = await fixture({ movingPeer: true, firstFail: true });
    expect(result.exitCode, result.output).toBe(0);
    expect(inputs).toEqual(['frozen predecessor input\n', 'frozen predecessor input\n']);
    expect(readFileSync(join(project, 'input.md'), 'utf8')).toBe('concurrent peer input\n');
  });
  it('inherits the parent gate contract in both attempted candidates', async () => {
    const { result, scores } = await fixture({ contract: true });
    expect(result.exitCode, result.output).toBe(0);
    expect(scores).toEqual(['a:1', 'b:1']);
  });
});
