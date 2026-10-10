import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';
import { execWithStdin } from '../src/adapters/base.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter, parseCodexJsonl } from '../src/adapters/codex.js';
import { resetConfigCache, type SupervisorConfig } from '../src/config.js';
import { providerFailureFromEvent, providerRefusal } from '../src/provider-result.js';
import { clearAttemptSummaryRefreshDebounce, readRunEvents, recordRunEvent } from '../src/run-events.js';
import { readRunStateView } from '../src/run-state-view.js';
import { createRun, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';
import { createSupervisorEvent, type SupervisorEventCandidate } from '../src/supervisor-events.js';
import { runStage } from '../src/worker.js';

const message = 'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.';
const refusalEvent = { type: 'turn.failed', error: { message } };
const failure = providerFailureFromEvent('codex', refusalEvent)!;
const role: AgentConfig = {
  name: 'offline', description: 'deterministic native provider fixture', model: 'default',
  reasoning_effort: 'default', tools: [], prompt: 'offline fixture',
};
const supervisorConfig: SupervisorConfig = {
  enabled: true, adapter: 'mock', model: 'default', reasoningEffort: 'low',
  pollIntervalMs: 30_000, cooldownAfterActionMs: 0,
  maxAssessmentsPerIteration: 20, tailBytes: 16_384, minDeltaBytes: 4096, stuckThresholdMs: 600_000,
};
const jsonl = (...events: unknown[]): string => events.map(e => JSON.stringify(e)).join('\n') + '\n';
let root: string, projectDir: string, runId: string, runDir: string, fixture: string, previousStore: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-provider-spec-'));
  projectDir = join(root, 'project');
  const bin = join(root, 'bin'), home = join(root, 'home');
  for (const dir of [projectDir, bin, home]) mkdirSync(dir, { recursive: true });
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'state'));
  ({ runId, runDirPath: runDir } = createRun(projectDir, 'offline-provider', 'name: offline-provider\nstages: []\n', ['work']));
  writeFileSync(join(runDir, 'task_brief.md'), 'Offline provider result trial');
  fixture = join(root, 'fixture.json');
  const fakeCli = `#!${process.execPath}\nconst fs=require('node:fs');const f=JSON.parse(fs.readFileSync(process.env.FC_PROVIDER_SPEC_FIXTURE,'utf8'));process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(f.stdout||'');process.exit(f.exitCode??1)});\n`;
  for (const name of ['codex', 'claude']) writeFileSync(join(bin, name), fakeCli, { mode: 0o755 });
  vi.stubEnv('PATH', bin);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CODEX_HOME', join(home, '.codex'));
  vi.stubEnv('CODEX_PLUGINS_CACHE', join(root, 'plugins'));
  vi.stubEnv('CODEX_SKILLS_CACHE', join(root, 'skills'));
  vi.stubEnv('FC_PROVIDER_SPEC_FIXTURE', fixture);
  mkdirSync(join(home, '.codex'), { recursive: true });
});

afterEach(() => {
  clearAttemptSummaryRefreshDebounce();
  setFcGlobalDir(previousStore);
  vi.unstubAllEnvs();
  resetConfigCache();
  rmSync(root, { recursive: true, force: true });
});

async function invoke(adapter: Adapter, stdout: string, exitCode = 1): Promise<RunResult> {
  writeFileSync(fixture, JSON.stringify({ stdout, exitCode }));
  return adapter.run('offline trial', role, { workDir: projectDir, runDir, stageId: 'work', timeout_ms: 10_000 });
}

async function stage(adapter: Adapter, retries = 0): Promise<RunResult> {
  const result = await runStage(adapter, {
    stageId: 'work', role, dependsOn: [], promptTemplate: 'offline trial', projectDir, runId, runDir, retries,
    timeout_ms: 60_000, projectWriteScope: [], technicalRetry: { delaysMs: [0] },
    artifactContract: { version: 1, produces: [], reads: [], groups: [], replays: [] },
  });
  updateRunState(projectDir, runId, state => { state.stages.work = readStageStatus(projectDir, runId, 'work'); return state; });
  return result;
}

function candidates(supervisor: Supervisor): SupervisorEventCandidate[] {
  const method = Reflect.get(supervisor, 'eventCandidates');
  return method.call(supervisor, {
    state: readRunState(projectDir, runId), runningStages: [], transitionParts: [], recentArtifacts: [],
    userInput: null, now: Date.now(),
  });
}

describe('provider-owned refusal contract', () => {
  it('attributes a Codex root failure with its original diagnostic hash', () => {
    const parsed = parseCodexJsonl(jsonl({ type: 'error', message }, refusalEvent));
    expect(parsed.providerFailure).toEqual({
      kind: 'refusal', provider: 'codex', source: 'native_stdout', eventType: 'turn.failed', reason: message,
      diagnosticSha256: createHash('sha256').update(message).digest('hex'),
    });
    expect(parsed.adapterFailureKind).toBeUndefined();
  });

  it.each([
    { type: 'item.completed', item: { type: 'agent_message', text: message } },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: jsonl(refusalEvent) } },
    { type: 'item.completed', item: { type: 'error', message } },
    { type: 'message', role: 'assistant', content: jsonl(refusalEvent) },
  ])('excludes agent, tool and probe text (%j)', event => {
    expect(parseCodexJsonl(jsonl(event)).providerFailure).toBeUndefined();
    expect(providerFailureFromEvent('codex', event)).toBeUndefined();
  });

  it('clears refusal attribution after success or a different terminal failure', () => {
    expect(parseCodexJsonl(jsonl(refusalEvent, { type: 'turn.completed' })).providerFailure).toBeUndefined();
    expect(parseCodexJsonl(jsonl(refusalEvent, { type: 'turn.failed', error: { message: 'ordinary failure' } })).providerFailure).toBeUndefined();
    expect(parseCodexJsonl(jsonl(refusalEvent, { type: 'turn.failed' })).providerFailure).toBeUndefined();
  });

  it('rejects unknown wording and terminal events from the other provider grammar', () => {
    expect(providerFailureFromEvent('codex', { type: 'turn.failed', error: { message: 'I cannot help.' } })).toBeUndefined();
    expect(providerFailureFromEvent('claude', refusalEvent)).toBeUndefined();
    expect(providerFailureFromEvent('codex', { type: 'result', is_error: true, result: message })).toBeUndefined();
    expect(providerFailureFromEvent('claude', { type: 'result', is_error: false, result: message })).toBeUndefined();
  });

  it('bounds and redacts the surfaced reason while retaining diagnostic identity', () => {
    const raw = `${message}\n\u001b[31mBearer synthetic-token api_key=synthetic-key https://user:synthetic-password@example.invalid/ ${'x'.repeat(3000)}`;
    const cause = providerRefusal({ provider: 'codex', eventType: 'error', message: raw })!;
    expect(cause.reason.length).toBeLessThanOrEqual(2048);
    expect(cause.reason).not.toMatch(/synthetic-token|synthetic-key|synthetic-password|\u001b|\n/);
    expect(cause.reason).toContain('[redacted]');
    expect(cause.diagnosticSha256).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('retains the direct process close beside an adapter outcome', async () => {
    const result = await execWithStdin(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(7))'], '', { cwd: projectDir, timeout_ms: 10_000 });
    expect(result).toMatchObject({ exitCode: 7, processExitCode: 7, processSignal: null });
  });

  it('preserves signal/timeout precedence over observed child close', async () => {
    const result = await execWithStdin(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], '', { cwd: projectDir, timeout_ms: 50, terminationTiming: { graceMs: 100, pollMs: 5 } });
    expect(result).toMatchObject({ exitCode: 124, timedOut: true, processExitCode: null, processSignal: 'SIGTERM' });
    expect(result.providerFailure).toBeUndefined();
  });

  it('captures the native refusal in both actual offline adapters', async () => {
    const codex = await invoke(new CodexAdapter(), jsonl(refusalEvent));
    expect(codex).toMatchObject({ exitCode: 1, processExitCode: 1, adapterError: false, providerFailure: failure });
    for (const stdout of [jsonl({ type: 'error', message }), JSON.stringify({ type: 'result', is_error: true, subtype: 'error', result: message })]) {
      const claude = await invoke(new ClaudeAdapter(), stdout);
      expect(claude).toMatchObject({ exitCode: 1, processExitCode: 1, adapterError: false, providerFailure: { kind: 'refusal', provider: 'claude', reason: message } });
    }
  });

  it('clears a recovered Claude error and retains its effective success override and raw exit', async () => {
    const result = await invoke(new ClaudeAdapter(), jsonl({ type: 'error', message }, { type: 'result', subtype: 'success', is_error: false, result: 'done' }), 1);
    expect(result).toMatchObject({ exitCode: 0, processExitCode: 1, adapterError: false, output: 'done' });
    expect(result.providerFailure).toBeUndefined();
  });

  it('keeps transport and capacity classification independent', async () => {
    for (const [message, kind] of [['502 Bad Gateway', 'bad_gateway'], ['Selected model is at capacity', 'capacity']]) {
      const result = await invoke(new CodexAdapter(), jsonl({ type: 'turn.failed', error: { message } }));
      expect(result).toMatchObject({ exitCode: 1, processExitCode: 1, adapterError: true, adapterFailureKind: kind });
      expect(result.providerFailure).toBeUndefined();
    }
  });

  it('persists reason, provenance and exit in attempts, events and the unchanged state reader', async () => {
    let calls = 0;
    const result = await stage({ run: async () => { calls++; return { output: message, exitCode: 1, processExitCode: 1, processSignal: null, duration_ms: 1, providerFailure: failure }; } });
    expect(calls).toBe(1);
    expect(result.providerFailure).toEqual(failure);
    const status = readStageStatus(projectDir, runId, 'work');
    expect(status.error).toContain('codex provider refusal (turn.failed)');
    expect(status.error).toContain(message);
    expect(status).toMatchObject({ exitCode: 1, processExitCode: 1, providerFailure: failure });
    expect(status.attempts?.at(-1)).toMatchObject({ exitCode: 1, processExitCode: 1, providerFailure: failure, tokenUsage: 'unknown' });
    const event = readRunEvents(projectDir, runId).find(e => e.type === 'attempt_failed');
    expect(event).toMatchObject({ exitCode: 1, processExitCode: 1, providerFailure: failure, adapterFailure: false });
    const view = readRunStateView(projectDir, runId);
    expect(view.stages.work.providerFailure).toEqual(failure);
    expect(view.events.rows.find(e => e.type === 'attempt_failed')?.providerFailure).toEqual(failure);
    expect(view.budget.tokens.complete).toBe(false);
  });

  it('retains past refusal facts but clears latest attribution on a successful new attempt', async () => {
    await stage({ run: async () => ({ output: message, exitCode: 1, processExitCode: 1, duration_ms: 1, providerFailure: failure }) });
    await stage({ run: async () => ({ output: 'done', exitCode: 0, processExitCode: 0, duration_ms: 1 }) }, 1);
    const status = readStageStatus(projectDir, runId, 'work');
    expect(status.providerFailure).toBeUndefined();
    expect(status.error).toBeUndefined();
    expect(status.attempts?.[0].providerFailure).toEqual(failure);
    expect(status.attempts?.[1].providerFailure).toBeUndefined();
  });

  it('keeps transport retries and clears stale provider cause on a timeout', async () => {
    let calls = 0;
    await stage({ run: async () => ++calls === 1
      ? { output: 'capacity', exitCode: 1, duration_ms: 1, adapterError: true, adapterFailureKind: 'capacity' }
      : { output: 'done', exitCode: 0, duration_ms: 1 } });
    expect(calls).toBe(2);
    await stage({ run: async () => ({ output: message, exitCode: 124, processExitCode: 1, duration_ms: 1, timedOut: true, providerFailure: failure }) }, 1);
    const status = readStageStatus(projectDir, runId, 'work');
    expect(status.error).toMatch(/^timed out after/);
    expect(status.providerFailure).toBeUndefined();
    expect(status.processExitCode).toBe(1);
  });

  it('gives supervision typed refusal evidence without marking transport failure', async () => {
    await stage({ run: async () => ({ output: message, exitCode: 1, processExitCode: 1, duration_ms: 1, providerFailure: failure }) });
    const supervisor = new Supervisor(projectDir, runId, { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) }, supervisorConfig, 'offline trial');
    const candidate = candidates(supervisor).find(c => c.type === 'adapter_failure')!;
    expect(candidate.quantities).toMatchObject({ failedExitCode: 1, processExitCode: 1, providerFailure: failure });
    expect(candidate.quantities.failureDetail).toContain(message);
    const trigger = createSupervisorEvent(candidate);
    const ownRefusal = new Supervisor(projectDir, runId, { run: async () => ({ output: message, exitCode: 1, processExitCode: 1, duration_ms: 1, providerFailure: failure }) }, supervisorConfig, 'offline trial');
    expect(await Reflect.get(ownRefusal, 'assess').call(ownRefusal, 'offline assessment', trigger)).toBeNull();
    const attempt = readRunState(projectDir, runId).supervisor?.attempts.at(-1);
    expect(attempt).toMatchObject({ status: 'failed', exitCode: 1, processExitCode: 1, providerFailure: failure });
    expect(attempt?.error).toContain(message);
    expect(readRunStateView(projectDir, runId).histories.supervisor?.attempts.at(-1)?.providerFailure).toEqual(failure);
  });

  it('does not upgrade a quoted refusal in an ordinary failure event to provider authority', () => {
    recordRunEvent(projectDir, runId, { type: 'attempt_failed', runId, timestamp: new Date().toISOString(), stageId: 'work', exitCode: 1, detail: `Exit code 1: ${message}`, adapterFailure: false, source: 'worker' });
    const supervisor = new Supervisor(projectDir, runId, { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) }, supervisorConfig, 'offline trial');
    expect(candidates(supervisor).filter(c => c.type === 'adapter_failure')).toEqual([]);
  });
});
