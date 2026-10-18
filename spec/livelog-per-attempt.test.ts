import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { parseStreamJsonToText, startDashboard } from '../src/dashboard.js';
import { readOperationalProjection } from '../src/cli-events.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { beginStageAttempt, completeStageAttempt, createRun, fcGlobalDir, readRunState, readStageStatus,
  resetStageLiveAttemptAliases, setFcGlobalDir, writeRunState, writeStageStatus } from '../src/store.js';
import { stageLiveLogPath, readStageLiveLogPath } from '../src/stage-live-log.js';
import { inspectStageExecutionFacts } from '../src/stage-watchdog.js';
import { beginAttemptEvidenceGeneration } from '../src/worker.js';
import { createWatchState, pollWatch } from '../src/watch.js';
import { declaredDispatch, fixtureArtifactContract, fixtureResult } from './test-support/declared-dispatch.js';

let root: string, project: string, priorStore: string;
let priorPath: string | undefined;
let app: FastifyInstance | undefined;
const session = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  root = mkdtempSync(join(process.env.FLOWCREW_VITEST_ROOT ?? tmpdir(), 'native-attempts-'));
  project = join(root, 'project');
  for (const directory of ['project', 'bin', 'source', 'plugins', 'skills']) mkdirSync(join(root, directory));
  priorStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  priorPath = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}:${priorPath ?? ''}`;
  vi.stubEnv('CODEX_HOME', join(root, 'source'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'source'));
  vi.stubEnv('CODEX_PLUGINS_CACHE', join(root, 'plugins'));
  vi.stubEnv('CODEX_SKILLS_CACHE', join(root, 'skills'));
  vi.stubEnv('FC_NATIVE_ATTEMPT_COUNTER', join(root, 'counter'));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
  if (priorPath === undefined) delete process.env.PATH;
  else process.env.PATH = priorPath;
  setFcGlobalDir(priorStore);
  rmSync(root, { recursive: true, force: true });
});

function fakeExecutable(kind: 'claude' | 'codex'): void {
  writeFileSync(join(root, 'bin', kind), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  const counter = process.env.FC_NATIVE_ATTEMPT_COUNTER;
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
  fs.writeFileSync(counter, String(n));
  const result = JSON.stringify({pass:n > 1, reason:'native attempt ' + n, criteria:{},
    audit_findings:{version:1,findings:[]},
    ...(n === 1 ? {repairability:{version:1,disposition:'repairable',evidence:'native attempt 1'}} : {})});
  const emit = event => console.log(JSON.stringify(event));
  process.stderr.write('native stderr attempt ' + n + '\n');
` + (kind === 'claude' ? `
  emit({type:'system',subtype:'init',session_id:${JSON.stringify(session)},model:'fixture-model'});
  emit({type:'result',subtype:'success',session_id:${JSON.stringify(session)},is_error:false,
    result,usage:{input_tokens:n*10,output_tokens:n*20},total_cost_usd:n/100});
` : `
  emit({type:'thread.started',thread_id:${JSON.stringify(session)}});
  emit({type:'item.completed',item:{type:'agent_message',text:result}});
  emit({type:'turn.completed',usage:{input_tokens:n*10,output_tokens:n*20}});
`) + '\n});\n', { mode: 0o755 });
}

function gateWorkflow(): { config: WorkflowConfig; yaml: string; agentsDir: string } {
  const agentsDir = join(project, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'qa', 'repair']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`, 'description: fixture', 'model: default', 'reasoning_effort: default', 'tools: []', 'prompt: fixture',
    ].join('\n'));
  }
  return {
    agentsDir,
    yaml: 'name: native-attempts\ndefaults: {max_iterations: 1, max_retries: 0}\nstages:\n  - id: plan\n    role: planner\n    dynamic_dispatch: true\n    artifact_contract: {version: 1, produces: [], reads: [], replays: []}\n',
    config: { name: 'native-attempts', description: '', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{ id: 'plan', role: 'planner', dynamic_dispatch: true, depends_on: [], skills: [], criterion_refs: [],
        is_gate: false, prompt_template: '', artifact_contract: fixtureArtifactContract('plan') }] },
  };
}

describe('native logs belong to scheduler attempts', () => {
  it.each(['claude', 'codex'] as const)('%s preserves the rejected gate stream after repair and re-evaluation', async kind => {
    fakeExecutable(kind);
    const { config, yaml, agentsDir } = gateWorkflow();
    const created = createRun(project, config.name, yaml, ['plan']);
    writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
    const initial = readRunState(project, created.runId);
    initial.autoApprove = true;
    writeRunState(project, created.runId, initial);
    const native = kind === 'claude' ? new ClaudeAdapter() : new CodexAdapter();
    const results: RunResult[] = [];
    let firstStream: string | undefined;
    const adapter: Adapter = {
      async run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === 'review') {
          if (opts.attemptIndex === 2) {
            // Check at the start of the next adapter call, after gate-loop cleanup.
            expect(readFileSync(stageLiveLogPath(opts.runDir, 'review', 1), 'utf8')).toBe(firstStream);
            expect(readOperationalProjection(opts.runDir).activeStages).toContainEqual(
              expect.objectContaining({ id: 'review', execution: 2 }));
          }
          const result = await native.run(prompt, role, opts);
          results.push(result);
          if (opts.attemptIndex === 1) firstStream = readFileSync(stageLiveLogPath(opts.runDir, 'review', 1), 'utf8');
          return result;
        }
        if (opts.stageId === 'plan') writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
          'stages:',
          '  - id: review', '    role: qa', '    scope: []', '    depends_on: [plan]',
          '    dependency_reasons: {plan: "review the plan"}', '    is_gate: true', '    task: verify fixture',
          '  - id: repair', '    role: repair', '    scope: [fixture.txt]', '    depends_on: [review]',
          '    dependency_reasons: {review: "repair the rejected fixture"}', '    retry_to: [review]', '    task: repair fixture',
        ].join('\n')));
        return fixtureResult({ output: 'fixture complete', exitCode: 0, duration_ms: 1 }, opts);
      },
    };
    const state = await runWorkflow(config, yaml, project, adapter, new Map(), undefined, agentsDir,
      created.runId, 'verify synthetic fixture', true);
    expect(state.status, JSON.stringify({ stages: state.stages, results })).toBe('complete');
    const status = readStageStatus(project, created.runId, 'review');
    expect(status.attempts).toHaveLength(2);
    expect(status).toMatchObject({ tokens_in: 30, tokens_out: 60 });
    expect(results.map(result => result.tokenUsage)).toEqual(['known', 'known']);
    expect(results.map(result => JSON.parse(result.output))).toMatchObject([
      { pass: false, reason: 'native attempt 1' },
      { pass: true, reason: 'native attempt 2' },
    ]);
    // Claude's resumed session cost is cumulative; only the first call's cost
    // is independently attributable. Both raw native totals must still survive.
    if (kind === 'claude') expect(status.cost_usd).toBeCloseTo(0.01);
    for (const n of [1, 2]) {
      const stream = readFileSync(stageLiveLogPath(created.runDirPath, 'review', n), 'utf8');
      expect(stream).toContain(`native stderr attempt ${n}`);
      expect(stream).toContain(`native attempt ${n}`);
      const terminal = stream.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
        .find(event => event.type === (kind === 'claude' ? 'result' : 'turn.completed'));
      expect(terminal.usage).toMatchObject({ input_tokens: n * 10, output_tokens: n * 20 });
      if (kind === 'claude') expect(terminal.total_cost_usd).toBe(n / 100);
      expect(stream).not.toContain(`native stderr attempt ${n === 1 ? 2 : 1}`);
    }
    expect(readFileSync(stageLiveLogPath(created.runDirPath, 'review', 1), 'utf8')).toBe(firstStream);
    expect(stageLiveLogPath(created.runDirPath, 'review')).toBe(stageLiveLogPath(created.runDirPath, 'review', 2));
    expect(readStageLiveLogPath(created.runDirPath, 'review', 1)).toBe(stageLiveLogPath(created.runDirPath, 'review', 1));
    const transcript = parseStreamJsonToText(readFileSync(stageLiveLogPath(created.runDirPath, 'review'), 'utf8'));
    expect(transcript).toContain('native attempt 2');
    expect(transcript).not.toContain('native attempt 1');
    expect(readFileSync(join(created.runDirPath, 'stages', 'review', 'output.md'), 'utf8')).toContain('native attempt 2');
    expect(readFileSync(join(created.runDirPath, 'summary.md'), 'utf8')).toContain('native attempt 2');
  });

  it('reads legacy logs and observes only the current attempt in the watchdog', () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    const legacy = join(created.runDirPath, 'stages', 'work', 'live.log');
    writeFileSync(legacy, 'legacy native result\n');
    // Materialize an old build's ledger without calling the new attempt writer.
    writeStageStatus(project, created.runId, 'work', { status: 'complete', retries: 0,
      attempts: [{ index: 1, status: 'complete', startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z', exitCode: 0, duration_ms: 1 }] });
    expect(stageLiveLogPath(created.runDirPath, 'work')).toBe(legacy);
    expect(readStageLiveLogPath(created.runDirPath, 'work', 1)).toBe(legacy);
    const status = beginStageAttempt(project, created.runId, 'work', 0, '2026-01-02T00:00:00.000Z');
    const attempt = status.attempts!.at(-1)!;
    expect(stageLiveLogPath(created.runDirPath, 'work')).toBe(stageLiveLogPath(created.runDirPath, 'work', attempt.index));
    beginAttemptEvidenceGeneration(created.runDirPath, 'work', attempt.index, attempt.startedAt);
    const current = stageLiveLogPath(created.runDirPath, 'work', attempt.index);
    expect(stageLiveLogPath(created.runDirPath, 'work')).toBe(current);
    let previousLiveLogBytes: number | undefined;
    const facts = () => inspectStageExecutionFacts({ runDir: created.runDirPath, stageId: 'work',
      status, sinceMs: 0, previousLiveLogBytes });
    expect(facts().liveProgressThisTick).toBe(false);
    appendFileSync(legacy, 'late historical bytes\n');
    appendFileSync(stageLiveLogPath(created.runDirPath, 'work', 1), 'late prior-attempt bytes\n');
    expect(facts()).toMatchObject({ liveProgressThisTick: false, artifactProgressThisTick: false,
      protectedFromIdleAbort: false });
    appendFileSync(current, 'current native bytes\n');
    const progress = facts();
    expect(progress.liveProgressThisTick).toBe(true);
    previousLiveLogBytes = progress.liveLogBytes;
    expect(readFileSync(legacy, 'utf8')).toContain('legacy native result');
    utimesSync(current, 1, 1);
    expect(facts().liveProgressThisTick).toBe(false);
    appendFileSync(current, 'more current native bytes\n');
    utimesSync(current, 1, 1);
    expect(facts().liveProgressThisTick).toBe(true);
  });

  it('retains native evidence when a later DAG reuses attempt index one', () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    let status = beginStageAttempt(project, created.runId, 'work', 0, '2026-01-01T00:00:00.000Z');
    let attempt = status.attempts!.at(-1)!;
    beginAttemptEvidenceGeneration(created.runDirPath, 'work', attempt.index, attempt.startedAt);
    const previous = stageLiveLogPath(created.runDirPath, 'work', 1);
    appendFileSync(previous, 'earlier DAG native result\n');
    const original = readFileSync(previous, 'utf8');
    completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 0, duration_ms: 1 });
    resetStageLiveAttemptAliases(project, created.runId, 'work', { status: 'pending', retries: 0 });
    status = beginStageAttempt(project, created.runId, 'work', 0, '2026-01-02T00:00:00.000Z');
    attempt = status.attempts!.at(-1)!;
    expect(attempt.index).toBe(1);
    beginAttemptEvidenceGeneration(created.runDirPath, 'work', attempt.index, attempt.startedAt);
    const current = stageLiveLogPath(created.runDirPath, 'work', 1);
    appendFileSync(current, 'later DAG native result\n');
    expect(current).not.toBe(previous);
    expect(readFileSync(previous, 'utf8')).toBe(original);
    expect(readFileSync(stageLiveLogPath(created.runDirPath, 'work'), 'utf8')).toContain('later DAG native result');
    expect(readFileSync(current, 'utf8')).not.toContain('earlier DAG native result');
  });

  it('uses the current native stream as the task watch activity clock', () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    beginStageAttempt(project, created.runId, 'work', 0, '2026-01-01T00:00:00.000Z');
    beginAttemptEvidenceGeneration(created.runDirPath, 'work', 1, '2026-01-01T00:00:00.000Z');
    const previous = stageLiveLogPath(created.runDirPath, 'work', 1);
    completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 0, duration_ms: 1 });
    beginStageAttempt(project, created.runId, 'work', 0, '2026-01-02T00:00:00.000Z');
    beginAttemptEvidenceGeneration(created.runDirPath, 'work', 2, '2026-01-02T00:00:00.000Z');
    const current = stageLiveLogPath(created.runDirPath, 'work', 2);
    appendFileSync(current, 'current native result\n');
    completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 0, duration_ms: 1 });
    writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
    const state = readRunState(project, created.runId);
    state.status = 'running';
    state.terminalStates = { complete: { paths: ['final.txt'] } };
    writeRunState(project, created.runId, state);
    let currentMtime = 1_900_000;
    const inspected: string[] = [];
    const poll = () => pollWatch(createWatchState(), {
      nowMs: () => 2_000_000,
      candidateRunIds: () => [created.runId],
      isProcessAlive: () => true,
      readPathMetadata(path) {
        inspected.push(path);
        try {
          const stat = lstatSync(path);
          return { kind: stat.isDirectory() ? 'directory' : 'file',
            mtimeMs: path === current ? currentMtime : path === previous ? 2_000_000 : 1 };
        } catch { return undefined; }
      },
    });
    expect(poll().alerts.some(alert => alert.kind === 'terminal_indecision')).toBe(false);
    expect(inspected).toContain(current);
    expect(inspected).not.toContain(previous);
    currentMtime = 1;
    expect(poll().alerts.some(alert => alert.kind === 'terminal_indecision')).toBe(true);
  });

  it('keeps an open dashboard stream following a shorter second attempt', async () => {
    const created = createRun(project, 'fixture', 'name: fixture', ['work']);
    let status = beginStageAttempt(project, created.runId, 'work', 0);
    let attempt = status.attempts!.at(-1)!;
    beginAttemptEvidenceGeneration(created.runDirPath, 'work', attempt.index, attempt.startedAt);
    appendFileSync(stageLiveLogPath(created.runDirPath, 'work', 1), 'first native stream with a longer message\n');
    app = await startDashboard(project, 0, { isProjectBusy: () => null, listTasks: async () => [] });
    const address = app.server.address() as { port: number };
    await new Promise<void>((resolve, reject) => {
      let seenFirst = false;
      const request = get({ host: '127.0.0.1', port: address.port,
        path: `/api/tasks/${created.runId}/stages/work/live` }, response => {
        response.on('data', chunk => {
          try {
            const text = String(chunk);
            if (!seenFirst && text.includes('first native stream')) {
              seenFirst = true;
              completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 0, duration_ms: 1 });
              status = beginStageAttempt(project, created.runId, 'work', 0);
              attempt = status.attempts!.at(-1)!;
              beginAttemptEvidenceGeneration(created.runDirPath, 'work', attempt.index, attempt.startedAt);
              appendFileSync(stageLiveLogPath(created.runDirPath, 'work', 2), 'second native\n');
            } else if (text.includes('second native')) {
              expect(seenFirst).toBe(true);
              expect(text).not.toContain('first native stream');
              response.destroy(); request.destroy(); resolve();
            }
          } catch (error) { response.destroy(); request.destroy(); reject(error); }
        });
        response.once('error', reject);
      });
      request.setTimeout(5000, () => { request.destroy(); reject(new Error('dashboard did not follow the next attempt')); });
      request.once('error', reject);
    });
    expect(readFileSync(stageLiveLogPath(created.runDirPath, 'work', 1), 'utf8')).toContain('first native stream');
  });
});
