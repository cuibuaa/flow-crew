import { bindFrozenInputs, restoreFrozenInput } from '../src/scheduler/sched_scope/frozen-inputs.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { runRecordPath } from '../src/run-layout.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectBrief } from '../src/brief-preflight.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readRunState, setFcGlobalDir } from '../src/store.js';
import { configureWorkflowBrief } from '../src/scheduler/sched_loop/brief.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { createContentSettlementContext } from '../src/scheduler/sched_scope/frozen-inputs.js';
import { settleProjectWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { StageWatchdog } from '../src/stage-watchdog.js';
import { runStage } from '../src/worker.js';
import { stageLiveLogPath } from '../src/stage-live-log.js';
import { CommandActivityTracker } from '../src/command-activity.js';
import { appendEngineFile } from '../src/engine-integrity.js';

let root: string, project: string, run: string, runId: string, previous: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'batch-regression-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'state'));
  ({ runId, runDirPath: run } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']));
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true });
});
it('preflight leaves domain wording and supplied-number expectations opaque', () => {
  const findings = (body: string) => inspectBrief('# Goal\n' + body).findings.filter(x => x.code === 'operator_figure_anti_anchoring_missing');
  expect(findings('Implement operator cutover (run deploy.sh between hands) and satisfy criteria 1–4.')).toEqual([]);
  expect(findings('The operator has a hand in release 2.')).toEqual([]);
  for (const text of ['The operator supplied an expected value of 42.', 'The operator handed us 42.', 'The operator hands us 42.', 'Our expected value is 42.']) {
    expect(findings(text), text).toEqual([]);
  }
});

it.each([false, true])('replaces an outward leaf alias without following its target during rollback (project alias=%s)', projectAlias => {
  const path = 'value.txt', outside = join(root, 'outside.txt');
  writeFileSync(join(project, path), 'Admitted bytes.');
  isolatedProjectCommand('git', ['init', '-q'], project, root);
  isolatedProjectCommand('git', ['add', '.'], project, root);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=' + ['fixture', 'example.invalid'].join('@'), 'commit', '-qm', 'Pinned frozen input'], project, root);
  const created = createRun(project, 'frozen-alias', '', [], '---\ninputs: [{path: value.txt, frozen: true}]\n---\n');
  const before = bindFrozenInputs(project, created.runDirPath);
  rmSync(join(project, path)); writeFileSync(outside, 'Outside bytes.');
  symlinkSync(outside, join(project, path));
  const restoreRoot = projectAlias ? join(root, 'project-alias') : project;
  if (projectAlias) symlinkSync(project, restoreRoot, 'dir');
  expect(restoreFrozenInput(restoreRoot, before, path)).toBeUndefined();
  expect(readFileSync(outside, 'utf8')).toBe('Outside bytes.');
  expect(readFileSync(join(project, path), 'utf8')).toBe('Admitted bytes.');
});

it('observes stream growth and current command identity during rollback without counting unchanged bytes again', async () => {
  const start = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
  const watchdog = new StageWatchdog(project, runId, { idleThresholdMs: 1000 });
  const saved = () => JSON.parse(readFileSync(runRecordPath(run, 'stage_watchdog.json'), 'utf8')).stageProgress.work;
  const result = await runStage({ async run(_prompt, _role, opts) {
    await watchdog.tick();
    const before = saved();
    vi.setSystemTime(start - 1500);
    const stream = stageLiveLogPath(run, 'work');
    appendEngineFile(stream, 'new native output\n'); utimesSync(stream, (start - 1500) / 1000, (start - 1500) / 1000);
    const tracker = new CommandActivityTracker({ runDir: run, stageId: 'work', attemptIndex: opts.attemptIndex!, attemptStartedAt: opts.attemptStartedAt! });
    tracker.feed(JSON.stringify({ type: 'item.started', item: { id: 'cmd', type: 'command_execution', command: 'fixture' } }) + '\n');
    await watchdog.tick();
    expect(saved()).toMatchObject({ liveProgressThisTick: true, activeCommandCount: 1, commandActivityValid: true, lastProgressAt: start - 1500 });
    expect(saved().liveLogBytes).toBeGreaterThan(before.liveLogBytes);
    vi.setSystemTime(start - 1000); await watchdog.tick();
    expect(saved()).toMatchObject({ liveProgressThisTick: false, lastProgressAt: start - 1500 });
    expect(existsSync(runRecordPath(run, 'signals/abort_work.json'))).toBe(false);
    tracker.feed(JSON.stringify({ type: 'item.completed', item: { id: 'cmd', type: 'command_execution' } }) + '\n');
    return { exitCode: 0, output: 'Complete', duration_ms: 1 };
  } }, { stageId: 'work', projectDir: project, runDir: run, runId, role: { name: 'fixture', description: '', model: 'default', reasoning_effort: 'low', tools: [], prompt: '' }, dependsOn: [], promptTemplate: 'Complete work', timeout_ms: 5000, retries: 0, artifactContract: { version: 1, produces: [], reads: [], groups: [] } });
  watchdog.stop(); expect(result.exitCode, result.output).toBe(0);
});
