import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectBrief } from '../src/brief-preflight.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readRunState, setFcGlobalDir } from '../src/store.js';
import { configureWorkflowBrief } from '../src/scheduler/sched_loop/brief.js';
import { captureResearchGateCandidate } from '../src/research-candidate.js';
import { createResearchAdvancer } from '../src/scheduler/sched_policy/research.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { createScopeBatchContext } from '../src/scheduler/sched_scope/scope-batch.js';
import { settleProjectWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { restoreProjectPath } from '../src/scheduler/sched_scope/restore.js';
import { readRepairFileImage } from '../src/scheduler/sched_scope/file-images.js';
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
  vi.useRealTimers(); vi.restoreAllMocks(); closeRollbackBaseline(project, run);
  setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true });
});
it('preflight accepts domain hands while retaining supplied-number anti-anchoring', () => {
  const findings = (body: string) => inspectBrief('# Goal\n' + body).findings.filter(x => x.code === 'operator_figure_anti_anchoring_missing');
  expect(findings('Implement operator cutover (run deploy.sh between hands) and satisfy criteria 1–4.')).toEqual([]);
  expect(findings('The operator has a hand in release 2.')).toEqual([]);
  for (const text of ['The operator supplied an expected value of 42.', 'The operator handed us 42.', 'The operator hands us 42.', 'Our expected value is 42.']) {
    expect(findings(text), text).toHaveLength(1);
  }
});

it.each([false, true])('replaces an outward leaf alias without following its target during rollback (project alias=%s)', projectAlias => {
  const path = 'value.txt', outside = join(root, 'outside.txt');
  writeFileSync(join(project, path), 'Admitted bytes.');
  const before = readRepairFileImage(project, path);
  rmSync(join(project, path)); writeFileSync(outside, 'Outside bytes.');
  symlinkSync(outside, join(project, path));
  const restoreRoot = projectAlias ? join(root, 'project-alias') : project;
  if (projectAlias) symlinkSync(project, restoreRoot, 'dir');
  expect(restoreProjectPath(restoreRoot, path, before)).toEqual({ restored: true });
  expect(readFileSync(outside, 'utf8')).toBe('Outside bytes.');
  expect(readFileSync(join(project, path), 'utf8')).toBe('Admitted bytes.');
});

const researchBrief = '---\nresearch:\n  baseline: 0\n  policy: greedy_stack\n  result_file: docs/round.json\n  report_dir: docs\n  stop: {beat: 100, max_rounds: 3}\n---\n# Goal\nMeasure independent rounds.\n';
function admitResearch(resuming = false) {
  const configured = configureWorkflowBrief({ name: 'research', description: '', defaults: {}, stages: [] }, project, runId, run, 3, resuming, researchBrief);
  expect(configured.kind).toBe('configured');
}
function publish(relative: string, value: unknown, mtime: number) {
  const path = join(project, relative); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value)); utimesSync(path, mtime / 1000, mtime / 1000);
}
async function advance(files: string[] = []) {
  const state = readRunState(project, runId);
  await createResearchAdvancer({ listProjectFilesAt: () => files, settleFrameworkRollbackPath() {}, writeCampaignEntry() {} })
    .tryAdvanceResearch(state, { projectDir: project, runId, runDirPath: run, iteration: 1, adapter: { async run() { throw new Error('Unexpected confirmation'); } } });
}

it.each(['measured', 'no_candidate'] as const)('ingests a new %s round after a stepped-back clock, exactly once', async kind => {
  const start = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
  admitResearch();
  vi.setSystemTime(start - 1500);
  const path = 'docs/round.json' + (kind === 'no_candidate' ? '.no_candidate.json' : '');
  publish(path, kind === 'measured' ? { label: 'round-one', result: 1 } : { label: 'round-one', outcome: 'no_candidate', reason: 'No admissible improvement' }, start - 1500);
  expect(statSync(join(project, path)).mtimeMs).toBeLessThan(Date.parse(readRunState(project, runId).startedAt));
  expect(captureResearchGateCandidate(project, run, 'review').kind).toBe(kind);
  await advance(); await advance();
  const journal = JSON.parse(readFileSync(join(run, 'research_journal.json'), 'utf8'));
  expect(journal.rounds).toHaveLength(1);
  expect(journal.rounds[0].outcome).toBe(kind);
  expect(captureResearchGateCandidate(project, run, 'review').kind).toBe(kind);
});

it('rejects old and unchanged results regardless of mtime and preserves the admission snapshot on resume', async () => {
  const value = { label: 'old-round', result: 1 }, future = Date.now() + 60_000;
  publish('docs/round.json', value, future); admitResearch();
  expect(captureResearchGateCandidate(project, run).kind).toBe('absent');
  publish('docs/round.json', value, future + 10_000);
  expect(captureResearchGateCandidate(project, run).kind).toBe('absent');
  await advance(); expect(existsSync(join(run, 'research_journal.json'))).toBe(false);
  publish('docs/round.json', { label: 'new-round', result: 2 }, Date.now() - 1500);
  const generation = readRunState(project, runId).researchInputGeneration;
  admitResearch(true);
  expect(readRunState(project, runId).researchInputGeneration).toEqual(generation);
  expect(captureResearchGateCandidate(project, run).kind).toBe('measured');
  await advance();
  expect(JSON.parse(readFileSync(join(run, 'research_journal.json'), 'utf8')).rounds).toHaveLength(1);
});

it('rejects simultaneously published measured and no-candidate outcomes after rollback', async () => {
  admitResearch(); const rolledBack = Date.now() - 1500;
  publish('docs/round.json', { label: 'measured', result: 1 }, rolledBack);
  publish('docs/round.json.no_candidate.json', { label: 'none', outcome: 'no_candidate', reason: 'none' }, rolledBack);
  expect(captureResearchGateCandidate(project, run).kind).toBe('invalid');
  await advance(); expect(existsSync(join(run, 'research_journal.json'))).toBe(false);
  expect(readFileSync(join(run, 'research_round_input_error.json'), 'utf8')).toContain('ambiguous_measured_and_no_candidate');
});

it.each([false, true])('links inferred evidence only when its content was published in this run (changed=%s)', async changed => {
  publish('docs/evidence.json', { label: 'round-one', result: 1 }, Date.now() + 60_000);
  admitResearch();
  const rolledBack = Date.now() - 1500;
  publish('docs/round.json', { label: 'round-one', result: 1 }, rolledBack);
  if (changed) publish('docs/evidence.json', { label: 'round-one', result: 1, measurement: 'independent paired observation' }, rolledBack);
  await advance(['docs/evidence.json']);
  const round = JSON.parse(readFileSync(join(run, 'research_journal.json'), 'utf8')).rounds[0];
  expect(round.evidence).toBe(changed ? 'docs/evidence.json' : undefined);
});

it('observes stream growth and current command identity during rollback without counting unchanged bytes again', async () => {
  const start = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
  const watchdog = new StageWatchdog(project, runId, { idleThresholdMs: 1000 });
  const saved = () => JSON.parse(readFileSync(join(run, 'stage_watchdog.json'), 'utf8')).stageProgress.work;
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
    expect(existsSync(join(run, 'signals/abort_work.json'))).toBe(false);
    tracker.feed(JSON.stringify({ type: 'item.completed', item: { id: 'cmd', type: 'command_execution' } }) + '\n');
    return { exitCode: 0, output: 'Complete', duration_ms: 1 };
  } }, { stageId: 'work', projectDir: project, runDir: run, runId, role: { name: 'fixture', description: '', model: 'default', reasoning_effort: 'low', tools: [], prompt: '' }, dependsOn: [], promptTemplate: 'Complete work', timeout_ms: 5000, retries: 0, artifactContract: { version: 1, produces: [], reads: [], groups: [] } });
  watchdog.stop(); expect(result.exitCode, result.output).toBe(0);
});
