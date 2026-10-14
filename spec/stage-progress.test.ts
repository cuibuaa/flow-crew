import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { beginStageAttempt, createRun, readRunState, readStageStatus, writeRunState } from '../src/store.js';
import { recordGateValidationDelta } from '../src/scheduler/sched_settlement/gate-validation.js';
import { inspectStageExecutionFacts, StageWatchdog } from '../src/stage-watchdog.js';
import { executeSingleStage } from '../src/scheduler/sched_settlement/stage-execution.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { fixtureArtifactContract, fixtureResult } from './test-support/declared-dispatch.js';
import { prepareFixtureRun } from './spec_runtime/run-fixture.js';
import { CommandActivityTracker } from '../src/command-activity.js';
import { writeEngineFile } from '../src/engine-integrity.js';

let project: string, run: ReturnType<typeof createRun>;
const stageId = 'review';
const config = { pollIntervalMs: 100, idleThresholdMs: 600_000 };
const role: AgentConfig = { name: 'qa', description: 'fixture', tools: [], prompt: 'review' };
let cancel: AbortController;
let validation: ReturnType<typeof recordGateValidationDelta> | undefined;

beforeEach(() => {
  project = join(process.env.FLOWCREW_VITEST_ROOT!, 'project');
  mkdirSync(join(project, 'config', 'agents'), { recursive: true });
  rmSync(join(project, 'ready'), { force: true });
  writeFileSync(join(project, 'config', 'agents', 'qa.yaml'), 'name: qa\ndescription: fixture\ntools: []\nprompt: review\n');
  run = createRun(project, 'progress', 'name: progress\nstages: []', [stageId]);
  writeFileSync(join(run.runDirPath, 'task_brief.md'), '# Review the result\n');
  cancel = new AbortController();
  validation = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  cancel.abort();
  await validation;
});

function startAttempt() {
  const status = beginStageAttempt(project, run.runId, stageId, 0);
  const attempt = status.attempts!.at(-1)!;
  const state = readRunState(project, run.runId);
  state.status = 'running';
  state.stages[stageId] = status;
  writeRunState(project, run.runId, state);
  const path = join(run.runDirPath, 'stages', stageId);
  appendFileSync(join(path, 'live.log'), `\n<!-- flowcrew-attempt ${JSON.stringify(attempt)} -->\n`);
  const segmentStart = Buffer.byteLength(readFileSync(join(path, 'live.log')));
  writeFileSync(join(path, 'attempt_generation.json'), JSON.stringify({
    version: 1, stageId, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt, segmentStart,
  }));
  return status;
}

async function startValidation(code: string) {
  const commands = ['build', 'test', 'lint'].map((role, index) => ({
    role, command: process.execPath, args: ['-e', index === 0 ? code : ''],
    display: `fixture ${role}`,
  }));
  writeFileSync(join(run.runDirPath, 'validation_baseline.json'), JSON.stringify({
    version: 1, source: 'ship-setup-ready-record', capturedAt: new Date().toISOString(),
    baseline: { version: 1, discovery: { state: 'configured', commands, missingRoles: [] },
      results: commands.map(command => ({ role: command.role, display: command.display, state: 'passed', exitCode: 0,
        durationMs: 0, output: '', failureIdentifiers: [], failureIdentity: 'none' })) },
  }));
  validation = recordGateValidationDelta(project, run.runId, stageId, { abortSignal: cancel.signal });
  // Wait for the owned fixture to execute, without relying on provider tools.
  for (let count = 0; count < 100 && !existsSync(join(project, 'ready')); count++) await delay(20);
  expect(existsSync(join(project, 'ready'))).toBe(true);
}

function monitor() { return new StageWatchdog(project, run.runId, config); }

function savedProgress() {
  return JSON.parse(readFileSync(join(run.runDirPath, 'stage_watchdog.json'), 'utf8'));
}

describe.skipIf(process.platform !== 'linux')('one progress record for engine work and idle cancellation', () => {
  it('does not count the attempt marker or engine bookkeeping as live/artifact work', () => {
    const status = startAttempt();
    const facts = inspectStageExecutionFacts({ runDir: run.runDirPath, stageId, status, sinceMs: 0 });
    expect(facts.liveProgressThisTick).toBe(false);
    expect(facts.artifactProgressThisTick).toBe(false);
  });

  it('uses the configured silence bound for a sleeping local command', async () => {
    const status = startAttempt();
    await startValidation("require('node:fs').writeFileSync('ready', ''); setInterval(() => {}, 10000)");
    const supervisor = monitor();
    await supervisor.tick();
    await delay(150);
    await supervisor.tick();
    const lastProgressAt = savedProgress().stageProgress[stageId].lastProgressAt;
    const signal = join(run.runDirPath, 'signals', `abort_${stageId}.json`);
    for (const idleMs of [config.pollIntervalMs * 2, config.idleThresholdMs - 1]) {
      vi.spyOn(Date, 'now').mockReturnValue(lastProgressAt + idleMs);
      await supervisor.tick();
      expect(existsSync(signal)).toBe(false);
      expect(savedProgress().stageProgress[stageId]).toMatchObject({ lastProgressAt,
        idleThresholdMs: config.idleThresholdMs, protectedFromIdleAbort: false });
    }
    vi.spyOn(Date, 'now').mockReturnValue(lastProgressAt + config.idleThresholdMs);
    await supervisor.tick();
    expect(existsSync(signal)).toBe(true);
    expect(inspectStageExecutionFacts({ runDir: run.runDirPath, stageId, status, sinceMs: Date.now() }).activeCommandCount).toBe(1);
    expect(JSON.parse(readFileSync(signal, 'utf8'))).toMatchObject({ source: 'watchdog', attemptIndex: 1 });

  });

  it('keeps silent CPU work alive from sampled process facts', async () => {
    const status = startAttempt();
    await startValidation("require('node:fs').writeFileSync('ready', ''); for (;;) Math.sqrt(Math.random())");
    const supervisor = monitor();
    await supervisor.tick();
    const startedAt = savedProgress().stageProgress[stageId].lastProgressAt;
    for (let count = 0; count < 3; count++) {
      await delay(150);
      vi.spyOn(Date, 'now').mockReturnValue(startedAt + (count + 1) * (config.idleThresholdMs + 1));
      await supervisor.tick();
      expect(savedProgress().stageProgress[stageId].lastProgressAt).toBe(Date.now());
    }
    expect(existsSync(join(run.runDirPath, 'signals', `abort_${stageId}.json`))).toBe(false);
    expect(inspectStageExecutionFacts({ runDir: run.runDirPath, stageId, status, sinceMs: Date.now() }).activeCommandCount).toBe(1);
    cancel.abort();
    await validation;
    expect(inspectStageExecutionFacts({ runDir: run.runDirPath, stageId, status, sinceMs: Date.now() }).activeCommandCount).toBe(0);
  });

  it('does not upgrade provider client polling into evidence of remote model work', async () => {
    const status = startAttempt();
    await startValidation("require('node:fs').writeFileSync('ready', ''); for (;;) Math.sqrt(Math.random())");
    const activity = JSON.parse(readFileSync(join(run.runDirPath, 'stages', stageId, 'command_activity.json'), 'utf8'));
    const provider = new CommandActivityTracker({ runDir: run.runDirPath, stageId,
      attemptIndex: status.attempts![0].index, attemptStartedAt: status.attempts![0].startedAt });
    provider.bindProcess(activity.process.pid, 'provider');
    const supervisor = monitor();
    await supervisor.tick();
    await delay(250);
    await supervisor.tick();
    expect(inspectStageExecutionFacts({ runDir: run.runDirPath, stageId, status, sinceMs: Date.now() }).protectedFromIdleAbort).toBe(false);
    expect(existsSync(join(run.runDirPath, 'signals', `abort_${stageId}.json`))).toBe(false);
    provider.close();
  });

  it('retains attempt-bound work observations across a watchdog restart', async () => {
    startAttempt();
    await startValidation("require('node:fs').writeFileSync('ready', ''); setInterval(() => {}, 10000)");
    const supervisor = monitor();
    await supervisor.tick();
    await delay(150);
    await supervisor.tick();
    const saved = savedProgress();
    const { lastProgressAt, processWork } = saved.stageProgress[stageId];
    expect(typeof processWork).toBe('string');
    // A previous engine may have persisted the removed short-bound fields.
    Object.assign(saved.stageProgress[stageId], { processWaiting: true, idleThresholdMs: config.pollIntervalMs * 2 });
    writeEngineFile(join(run.runDirPath, 'stage_watchdog.json'), JSON.stringify(saved));
    vi.spyOn(Date, 'now').mockReturnValue(lastProgressAt + config.pollIntervalMs * 2);
    const restarted = monitor();
    restarted.restoreProgress();
    await restarted.tick();
    expect(existsSync(join(run.runDirPath, 'signals', `abort_${stageId}.json`))).toBe(false);
    expect(savedProgress().stageProgress[stageId]).toMatchObject({ lastProgressAt, processWork,
      idleThresholdMs: config.idleThresholdMs, protectedFromIdleAbort: false });
    vi.spyOn(Date, 'now').mockReturnValue(lastProgressAt + config.idleThresholdMs);
    await restarted.tick();
    expect(existsSync(join(run.runDirPath, 'signals', `abort_${stageId}.json`))).toBe(true);
  });

  it('ends finalization that has a closed stream and no new work', async () => {
    const status = startAttempt();
    const activity = new CommandActivityTracker({ runDir: run.runDirPath, stageId,
      attemptIndex: status.attempts![0].index, attemptStartedAt: status.attempts![0].startedAt });
    activity.close();
    writeFileSync(join(run.runDirPath, 'stages', stageId, 'output.md'), 'result');
    // Establish a frozen artifact before the first millisecond-resolution tick.
    await delay(2);
    const supervisor = monitor();
    await supervisor.tick();
    const lastProgressAt = savedProgress().stageProgress[stageId].lastProgressAt;
    for (const idleMs of [config.pollIntervalMs * 2, config.idleThresholdMs - 1]) {
      vi.spyOn(Date, 'now').mockReturnValue(lastProgressAt + idleMs);
      await supervisor.tick();
      expect(existsSync(join(run.runDirPath, 'signals', `abort_${stageId}.json`))).toBe(false);
    }
    vi.spyOn(Date, 'now').mockReturnValue(lastProgressAt + config.idleThresholdMs);
    await supervisor.tick();
    expect(existsSync(join(run.runDirPath, 'signals', `abort_${stageId}.json`))).toBe(true);
  });

  it('does not make an unchanged terminal artifact immune to idle detection', () => {
    const status = startAttempt();
    writeFileSync(join(run.runDirPath, 'stages', stageId, 'output.md'), 'result');
    const facts = inspectStageExecutionFacts({ runDir: run.runDirPath, stageId, status, sinceMs: Date.now() + 1 });
    expect(facts.outputObserved).toBe(true);
    expect(facts.protectedFromIdleAbort).toBe(false);
  });

  it.each(['batch', 'reevaluation'] as const)('does not retry a verified idle abort in the %s scheduler path', async (path) => {
    const workflow: WorkflowConfig = { name: 'progress', description: '', defaults: { max_iterations: 1, max_retries: 2 },
      stages: [{ id: stageId, role: 'qa', depends_on: [], scope: [], skills: [], dynamic_dispatch: false,
        is_gate: false, criterion_refs: [], prompt_template: 'review', artifact_contract: fixtureArtifactContract(stageId) }] };
    const yaml = 'name: progress\nstages: []';
    run = prepareFixtureRun(project, workflow, yaml);
    let calls = 0;
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 0 }, opts);
      calls++;
      if (calls > 1) return fixtureResult({ output: 'unexpected repeat', exitCode: 0, duration_ms: 0 }, opts);
      mkdirSync(join(opts.runDir, 'signals'), { recursive: true });
      writeFileSync(join(opts.runDir, 'signals', `abort_${stageId}.json`), JSON.stringify({
        version: 1, stageId, attemptIndex: opts.attemptIndex, source: 'watchdog',
        timestamp: new Date().toISOString(), reason: 'Verified idle local command',
      }));
      await new Promise<void>(resolve => opts.abortSignal!.addEventListener('abort', () => resolve(), { once: true }));
      return { output: '', exitCode: 137, duration_ms: 0 };
    } };
    const agents = new Map([['qa', role]]);
    if (path === 'batch') await runWorkflow(workflow, yaml, project, adapter, agents, undefined,
      join(project, 'config', 'agents'), run.runId, 'review', true);
    else await executeSingleStage(workflow.stages[0], project, run.runId, run.runDirPath, workflow,
      adapter, agents, join(project, 'config', 'agents'), readRunState(project, run.runId), workflow.stages);
    expect(calls).toBe(1);
    expect(readStageStatus(project, run.runId, stageId).attempts).toHaveLength(1);
    expect(readStageStatus(project, run.runId, stageId).status).toBe('failed');
  });
});
