import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter, AgentConfig, RunResult } from '../src/adapters/base.js';
import { execWithStdin } from '../src/adapters/base.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter, parseCodexJsonl } from '../src/adapters/codex.js';

import { NativeEventSummary, normalizeNativeEvent } from '../src/adapters/native-events.js';
import { providerFailureFromEvent, providerFailureFromDiagnostic } from '../src/provider-result.js';
import { finalizeSessionHome, finalizeStageSessions, readSession, settleSession, stageSessionHome } from '../src/adapter-session.js';
import { readRunEvents } from '../src/run-events.js';
import { readRunStateView } from '../src/run-state-view.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import { runStage } from '../src/worker.js';

const message = 'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.';
const refusalEvent = { type: 'turn.failed', error: { message } };
const failure = providerFailureFromEvent('codex', refusalEvent)!;
const role: AgentConfig = {
  name: 'offline', description: 'deterministic native provider fixture', model: 'default',
  reasoning_effort: 'default', tools: [], prompt: 'offline fixture',
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
  const fakeCli = `#!${process.execPath}
const fs=require('node:fs'),p=process.env.FC_PROVIDER_SPEC_FIXTURE,f=JSON.parse(fs.readFileSync(p,'utf8'));
const calls=fs.existsSync(p+'.calls')?fs.readFileSync(p+'.calls','utf8').trim().split('\\n').length:0;
let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
  fs.appendFileSync(p+'.calls',JSON.stringify({argv:process.argv.slice(2),input})+'\\n');
  const response=f.responses?.[Math.min(calls,f.responses.length-1)]||f;
  process.stdout.write(response.stdout||'');process.exit(response.exitCode??1);
});`;
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
  setFcGlobalDir(previousStore);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function invoke(adapter: Adapter, stdout: string, exitCode = 1): Promise<RunResult> {
  writeFileSync(fixture, JSON.stringify({ stdout, exitCode }));
  return adapter.run('offline trial', role, { workDir: projectDir, runDir, stageId: 'work', timeout_ms: 10_000 });
}

async function stage(adapter: Adapter, retries = 0): Promise<RunResult> {
  const result = await runStage(adapter, {
    stageId: 'work', role, dependsOn: [], promptTemplate: 'offline trial', projectDir, runId, runDir, retries,
    timeout_ms: 60_000,  technicalRetry: { delaysMs: [0] },
    artifactContract: { version: 1, produces: [], reads: [], groups: [] },
  });
  updateRunState(projectDir, runId, state => { state.stages.work = readStageStatus(projectDir, runId, 'work'); return state; });
  return result;
}

describe('provider-owned terminal failure contract', () => {
  it('settles the Claude terminal record separately from streamed author progress', async () => {
    const record = JSON.stringify({ status: 'delivered', summary: 'Delivered.', files_modified: [], checks: [], caveats: [] });
    const stdout = jsonl(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'I am checking the candidate build.\n' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: record }] } },
      { type: 'result', subtype: 'success', is_error: false, result: record },
    );
    const result = await invoke(new ClaudeAdapter(), stdout, 0);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(record);
  });

  it('settles a Claude terminal record without a trailing newline', async () => {
    const record = JSON.stringify({ choice: 'A', reason: 'Verified candidate.' });
    const result = await invoke(new ClaudeAdapter(), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: record }), 0);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(record);
  });

  it('attributes a Codex root failure with its original diagnostic hash', () => {
    const parsed = parseCodexJsonl(jsonl({ type: 'error', message }, refusalEvent));
    expect(parsed.providerFailure).toEqual({
      kind: 'refusal', provider: 'codex', source: 'native_stdout', eventType: 'turn.failed', reason: message,
      diagnosticSha256: createHash('sha256').update(message).digest('hex'),
    });
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

  it.each([new CodexAdapter(), new ClaudeAdapter()])('does not elevate a nested probe error into provider failure (%j)', async adapter => {
    const result = await invoke(adapter, jsonl({ type: 'item.completed', item: { type: 'error', message } }));
    expect(result.providerFailure).toBeUndefined();
  });

  it.each([new CodexAdapter(), new ClaudeAdapter()])('retains root authentication through a later nested probe error (%j)', async adapter => {
    const error = { code: 401, message: 'provider requires authentication' };
    const rootFailure = adapter.sessionKind === 'codex' ? { type: 'turn.failed', error } : { type: 'result', is_error: true, error };
    writeFileSync(fixture, JSON.stringify({ stdout: jsonl(rootFailure,
      { type: 'item.completed', item: { type: 'error', message: 'unrelated probe output' } }) }));
    const result = await adapter.run('continue', role, { workDir: projectDir, runDir, stageId: 'work', timeout_ms: 10_000,
      resumeSessionId: '11111111-1111-4111-8111-111111111111' });
    expect(result.providerFailure).toMatchObject({ kind: 'authentication', reason: error.message });
    expect(readFileSync(fixture + '.calls', 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('clears refusal attribution on success and replaces it on a classified terminal failure', () => {
    expect(parseCodexJsonl(jsonl(refusalEvent, { type: 'turn.completed' })).providerFailure).toBeUndefined();
    expect(parseCodexJsonl(jsonl(refusalEvent, { type: 'turn.failed', error: { message: 'ordinary failure' } })).providerFailure).toEqual(failure);
    expect(parseCodexJsonl(jsonl(refusalEvent, { type: 'turn.failed' })).providerFailure).toEqual(failure);
    expect(parseCodexJsonl(jsonl(refusalEvent, { type: 'turn.failed', error: { code: 401, message: 'new authentication failure' } })).providerFailure)
      .toMatchObject({ kind: 'authentication', reason: 'new authentication failure' });
  });

  describe.each(['codex', 'claude'] as const)('%s classified root failure precedence', provider => {
    it.each([['authentication', 401], ['refusal', 'content_policy_violation'], ['transient', 503]] as const)
    ('keeps %s evidence through an unclassified root failure until explicit success', (kind, code) => {
      const summary = new NativeEventSummary();
      const envelope = provider === 'codex' ? { type: 'turn.failed' } : { type: 'result', is_error: true };
      summary.observe(normalizeNativeEvent({ ...envelope, error: { code, message: 'classified cause' } }, provider));
      const classified = summary.providerFailure;
      expect(classified).toMatchObject({ kind, reason: 'classified cause' });
      summary.observe(normalizeNativeEvent({ ...envelope, error: { message: 'later ordinary failure' } }, provider));
      expect(summary.completed).toBe(false);
      expect(summary.diagnostic).toBe('later ordinary failure');
      expect(summary.providerFailure).toEqual(classified);
      summary.observe(normalizeNativeEvent(provider === 'codex' ? { type: 'turn.completed' }
        : { type: 'result', subtype: 'success', result: 'recovered' }, provider));
      expect(summary.completed).toBe(true);
      expect(summary.providerFailure).toBeUndefined();
      expect(summary.diagnostic).toBeUndefined();
    });
  });

  it.each([new CodexAdapter(), new ClaudeAdapter()])('does not replay authentication followed by an unclassified root failure (%j)', async adapter => {
    const envelope = adapter.sessionKind === 'codex' ? { type: 'turn.failed' } : { type: 'result', is_error: true };
    writeFileSync(fixture, JSON.stringify({ stdout: jsonl(
      { ...envelope, error: { type: 'authentication_error', message: 'credentials rejected' } },
      { ...envelope, error: { message: 'later ordinary failure' } },
    ) }));
    const result = await stage(adapter);
    expect(result.providerFailure).toMatchObject({ kind: 'authentication', reason: 'credentials rejected' });
    expect(readFileSync(fixture + '.calls', 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readStageStatus(projectDir, runId, 'work').attempts).toMatchObject([{ providerFailure: { kind: 'authentication' } }]);
  });

  describe.each(['codex', 'claude'] as const)('%s typed provider codes', provider => {
    const envelope = provider === 'codex' ? { type: 'turn.failed' } : { type: 'result', is_error: true };
    it.each(['overloaded_error', 'rate_limit_error', 'api_error', 'timeout', 'timeout_error', 'server_error',
      'service_unavailable_error', 'server_is_overloaded', 'rate_limit_exceeded', 'slow_down', 429, '429', 500, '502', 503, 504, 529, 599])
    ('classifies known temporary code %s ahead of conflicting text', code => {
      expect(providerFailureFromEvent(provider, { ...envelope, error: { type: code, message: 'not logged in' } }))
        .toMatchObject({ kind: 'transient' });
    });
    it.each(['invalid_request_error', 'not_found_error', 'permission_error', 'billing_error', 'request_too_large',
      'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded',
      'organization_usage_limit_exceeded', 'unknown_future_error', 400, 403, 404, 413, 499, 600, '503.5'])
    ('keeps non-temporary or unknown code %s on the base path despite transient wording', code => {
      expect(providerFailureFromEvent(provider, { ...envelope, error: { type: code, message: 'overloaded; not logged in' } }))
        .toBeUndefined();
    });
    it.each(['invalid_request_error', 'not_found_error', 'permission_error'])
    ('does not back off or mark adapter failure for %s in the actual worker', async code => {
      const reason = 'request cannot be processed';
      writeFileSync(fixture, JSON.stringify({ stdout: jsonl({ ...envelope, error: { type: code, message: reason } }) }));
      const result = await stage(provider === 'codex' ? new CodexAdapter() : new ClaudeAdapter());
      expect(result.exitCode).toBe(1);
      expect(result.providerFailure).toBeUndefined();
      expect(readFileSync(fixture + '.calls', 'utf8').trim().split('\n')).toHaveLength(1);
      const status = readStageStatus(projectDir, runId, 'work');
      expect(status).toMatchObject({ status: 'failed', retries: 0 });
      expect(status.attempts).toHaveLength(1);
      expect(status.attempts?.[0].error).toContain(reason);
      expect(readRunEvents(projectDir, runId).find(e => e.type === 'attempt_failed')?.providerFailure).toBeUndefined();
    });
  });

  it('keeps unknown terminal wording unclassified and excludes the other provider grammar', () => {
    expect(providerFailureFromEvent('codex', { type: 'turn.failed', error: { message: 'I cannot help.' } })).toBeUndefined();
    expect(providerFailureFromEvent('claude', refusalEvent)).toBeUndefined();
    expect(providerFailureFromEvent('codex', { type: 'result', is_error: true, result: message })).toBeUndefined();
    expect(providerFailureFromEvent('claude', { type: 'result', is_error: false, result: message })).toBeUndefined();
  });

  it('bounds and redacts the surfaced reason while retaining diagnostic identity', () => {
    const raw = `${message}\n\u001b[31mBearer synthetic-token api_key=synthetic-key https://user:synthetic-password@example.invalid/ ${'x'.repeat(3000)}`;
    const cause = providerFailureFromDiagnostic({ provider: 'codex', eventType: 'error', message: raw })!;
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
    expect(codex).toMatchObject({ exitCode: 1, processExitCode: 1, providerFailure: failure });
    for (const stdout of [jsonl({ type: 'error', message }), JSON.stringify({ type: 'result', is_error: true, subtype: 'error', result: message })]) {
      const claude = await invoke(new ClaudeAdapter(), stdout);
      expect(claude).toMatchObject({ exitCode: 1, processExitCode: 1, providerFailure: { kind: 'refusal', provider: 'claude', reason: message } });
    }
  });

  it('clears a recovered Claude error while preserving an unrelated failed process exit', async () => {
    const result = await invoke(new ClaudeAdapter(), jsonl({ type: 'error', message }, { type: 'result', subtype: 'success', is_error: false, result: 'done' }), 1);
    expect(result).toMatchObject({ exitCode: 1, processExitCode: 1, output: 'done' });
    expect(result.providerFailure).toBeUndefined();
  });

  it('unifies transport and capacity as transient provider failures', async () => {
    for (const message of ['502 Bad Gateway', 'Selected model is at capacity']) {
      const result = await invoke(new CodexAdapter(), jsonl({ type: 'turn.failed', error: { message } }));
      expect(result).toMatchObject({ exitCode: 1, processExitCode: 1, providerFailure: { kind: 'transient' } });
    }
  });

  it('records the known routing discovery failure as transient with an actionable attempt error', async () => {
    const message = 'workspace routing discovery failed';
    writeFileSync(fixture, JSON.stringify({ stdout: jsonl({ type: 'error', message }, { type: 'turn.failed', error: { message } }) }));
    const result = await stage(new CodexAdapter());
    expect(result.providerFailure).toMatchObject({ kind: 'transient', reason: message });
    expect(readStageStatus(projectDir, runId, 'work').attempts?.at(-1)?.error).toContain(message);
    expect(readRunEvents(projectDir, runId).find(e => e.type === 'attempt_failed')).toMatchObject({ providerFailure: { kind: 'transient', reason: message } });
  });

  it.each([
    ['codex', { type: 'turn.failed', error: { message: 'Stage assertion failed' } }, 'Stage assertion failed'],
    ['codex', { type: 'error' }, 'error'],
    ['claude', { type: 'result', subtype: 'error_max_turns' }, 'error_max_turns'],
    ['claude', { type: 'error' }, 'error'],
    ['claude', { type: 'result', is_error: true, errors: ['task checks did not pass'] }, 'task checks did not pass'],
  ] as const)('keeps uncoded %s failure %j on the base path with its reason', async (provider, event, reason) => {
    writeFileSync(fixture, JSON.stringify({ stdout: jsonl(event) }));
    const result = await stage(provider === 'codex' ? new CodexAdapter() : new ClaudeAdapter());
    expect(result.exitCode).toBe(1);
    expect(result.providerFailure).toBeUndefined();
    expect(readFileSync(fixture + '.calls', 'utf8').trim().split('\n')).toHaveLength(1);
    const status = readStageStatus(projectDir, runId, 'work');
    expect(status).toMatchObject({ status: 'failed', retries: 0 });
    expect(status.attempts).toHaveLength(1);
    expect(status.attempts?.[0].error).toContain(reason);
    expect(readRunEvents(projectDir, runId).find(e => e.type === 'attempt_failed')?.providerFailure).toBeUndefined();
  });

  it.each([new CodexAdapter(), new ClaudeAdapter()])('retains an unclassified native failure when the child closes zero (%j)', async adapter => {
    const event = adapter.sessionKind === 'codex' ? { type: 'turn.failed', error: { message: 'Stage assertion failed' } }
      : { type: 'result', subtype: 'error_max_turns' };
    const result = await invoke(adapter, jsonl(event), 0);
    expect(result).toMatchObject({ exitCode: 1, processExitCode: 0 });
    expect(result.providerFailure).toBeUndefined();
    expect(result.friendlyError).toBe(adapter.sessionKind === 'codex' ? 'Stage assertion failed' : 'error_max_turns');
    expect(readFileSync(fixture + '.calls', 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it.each([new CodexAdapter(), new ClaudeAdapter()])('redacts and bounds unclassified attempt reasons (%j)', async adapter => {
    const reason = `Task checks failed: Bearer synthetic-token api_key=synthetic-key https://user:synthetic-password@example.invalid/ ${'x'.repeat(3000)}`;
    const event = adapter.sessionKind === 'codex' ? { type: 'turn.failed', error: { message: reason } }
      : { type: 'result', is_error: true, errors: [reason] };
    writeFileSync(fixture, JSON.stringify({ stdout: jsonl(event) }));
    const result = await stage(adapter);
    expect(result.providerFailure).toBeUndefined();
    const error = readStageStatus(projectDir, runId, 'work').attempts?.[0].error;
    expect(error).toContain('Task checks failed: Bearer [redacted]');
    expect(error).not.toMatch(/synthetic-token|synthetic-key|synthetic-password/);
    expect(result.friendlyError!.length).toBeLessThanOrEqual(2048);
    expect(result.friendlyError).toContain('[truncated]');
  });

  it.each(['codex', 'claude'] as const)('retires only %s metadata owned by the retired home across adapter switches', adapter => {
    const other = adapter === 'codex' ? 'claude' : 'codex';
    const metadata = { version: 1 as const, sessionId: '11111111-1111-4111-8111-111111111111',
      ownerStageId: 'work', capturedAt: '2026-10-23T00:00:00Z', adapter };
    settleSession(runDir, 'work', { exitCode: 0 }, metadata.sessionId, undefined, undefined, { adapter });
    const sessionPath = join(runDir, 'stages', 'work', 'session.json');
    const before = readFileSync(sessionPath, 'utf8');
    const leftover = stageSessionHome(runDir, 'work', other);
    mkdirSync(leftover, { recursive: true });
    finalizeSessionHome(leftover, 0);
    expect(existsSync(leftover)).toBe(false);
    expect(readFileSync(sessionPath, 'utf8')).toBe(before);
    expect(readSession(runDir, 'work', adapter)?.sessionId).toBe(metadata.sessionId);
    mkdirSync(leftover, { recursive: true });
    finalizeStageSessions(runDir, 'work');
    expect(existsSync(leftover)).toBe(false);
    expect(readFileSync(sessionPath, 'utf8')).toBe(before);
    const ownHome = stageSessionHome(runDir, 'work', adapter);
    mkdirSync(ownHome, { recursive: true });
    finalizeSessionHome(ownHome, 0, true);
    expect(readFileSync(sessionPath, 'utf8')).toBe(before);
    finalizeSessionHome(ownHome, 1);
    expect(readFileSync(sessionPath, 'utf8')).toBe(before);
    finalizeStageSessions(runDir, 'work');
    expect(existsSync(ownHome)).toBe(false);
    expect(readSession(runDir, 'work', adapter)).toBeUndefined();
    expect(existsSync(sessionPath)).toBe(false);
  });

  it('treats legacy session metadata as Codex-owned during home retirement', () => {
    const sessionPath = join(runDir, 'stages', 'work', 'session.json');
    writeFileSync(sessionPath, JSON.stringify({ version: 1, sessionId: '11111111-1111-4111-8111-111111111111',
      ownerStageId: 'work', capturedAt: '2026-10-23T00:00:00Z' }));
    finalizeSessionHome(stageSessionHome(runDir, 'work', 'claude'), 0);
    expect(readSession(runDir, 'work', 'codex')?.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    finalizeSessionHome(stageSessionHome(runDir, 'work', 'codex'), 0);
    expect(existsSync(sessionPath)).toBe(false);
  });

  it('keeps all four recorded capacity failures on the bounded backoff route', async () => {
    const message = 'Selected model is at capacity. Please try a different model.';
    const capacity = { stdout: jsonl({ type: 'error', message }, { type: 'turn.failed', error: { message } }), exitCode: 1 };
    for (const failures of [2, 1, 1]) {
      rmSync(fixture + '.calls', { force: true });
      writeFileSync(fixture, JSON.stringify({ responses: [...Array(failures).fill(capacity),
        { stdout: jsonl({ type: 'turn.completed' }), exitCode: 0 }] }));
      const result = await runStage(new CodexAdapter(), {
        stageId: 'work', role, dependsOn: [], promptTemplate: 'capacity replay', projectDir, runId, runDir, retries: 0,
        timeout_ms: 60_000, technicalRetry: { delaysMs: [0, 0] },
        artifactContract: { version: 1, produces: [], reads: [], groups: [] },
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(fixture + '.calls', 'utf8').trim().split('\n')).toHaveLength(failures + 1);
    }
  });

  it.each(['codex', 'claude'] as const)('trusts %s terminal error codes before conflicting text', provider => {
    const envelope = provider === 'codex' ? { type: 'turn.failed' } : { type: 'result', is_error: true };
    expect(providerFailureFromEvent(provider, { ...envelope, error: { code: 401, message: 'new wording' } })).toMatchObject({ kind: 'authentication' });
    expect(providerFailureFromEvent(provider, { ...envelope, error: { code: 'server_error', message: 'not logged in' } })).toMatchObject({ kind: 'transient' });
    expect(providerFailureFromEvent(provider, { ...envelope, error: { code: 'content_policy_violation', message: 'new wording' } })).toMatchObject({ kind: 'refusal' });
  });

  it('starts a new Codex session immediately after retiring its home', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const home = stageSessionHome(runDir, 'work');
    mkdirSync(home, { recursive: true });
    settleSession(runDir, 'work', { exitCode: 0 }, sessionId, undefined, undefined, { adapter: 'codex' });
    expect(readSession(runDir, 'work', 'codex')?.adapter).toBe('codex');
    finalizeSessionHome(home, 0);
    expect(existsSync(home)).toBe(false);
    expect(readSession(runDir, 'work', 'codex')).toBeUndefined();
    writeFileSync(fixture, JSON.stringify({ stdout: jsonl({ type: 'turn.completed' }), exitCode: 0 }));
    const result = await new CodexAdapter().run('fresh duties', role, {
      workDir: projectDir, runDir, stageId: 'work', timeout_ms: 10_000,
      resumeSessionId: readSession(runDir, 'work', 'codex')?.sessionId,
    });
    expect(result.exitCode).toBe(0);
    const calls = readFileSync(fixture + '.calls', 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).not.toContain('resume');
  });

  it.each([new CodexAdapter(), new ClaudeAdapter()])('recovers one unattested resume failure with full fresh duties (%j)', async adapter => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const failed = adapter.sessionKind === 'codex' ? { type: 'turn.failed', error: { message: 'unavailable conversation' } }
      : { type: 'result', is_error: true, errors: ['unavailable conversation'] };
    const succeeded = adapter.sessionKind === 'codex' ? { type: 'turn.completed' } : { type: 'result', result: 'done' };
    writeFileSync(fixture, JSON.stringify({ responses: [{ stdout: jsonl(failed) }, { stdout: jsonl(succeeded), exitCode: 0 }] }));
    const result = await adapter.run('correction', role, { workDir: projectDir, runDir, stageId: 'work', timeout_ms: 10_000,
      resumeSessionId: sessionId, freshSessionPrompt: 'full fresh duties' });
    expect(result.exitCode).toBe(0);
    const calls = readFileSync(fixture + '.calls', 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[0].argv).toContain(sessionId);
    expect(calls[1].argv).not.toContain(sessionId);
    expect(calls[1].input).toBe('full fresh duties');
    expect(result.invocations).toHaveLength(2);
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
    expect(event).toMatchObject({ exitCode: 1, processExitCode: 1, providerFailure: failure });
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

  it('keeps transport retries and clears stale provider cause on forced budget continuation', async () => {
    let calls = 0;
    await stage({ run: async () => ++calls === 1
      ? { output: 'capacity', exitCode: 1, duration_ms: 1, providerFailure: providerFailureFromEvent('codex', { type: 'error', message: 'Selected model is at capacity' }) }
      : { output: 'done', exitCode: 0, duration_ms: 1 } });
    expect(calls).toBe(2);
    await stage({ run: async () => ({ output: message, exitCode: 124, processExitCode: 1, duration_ms: 1, timedOut: true, providerFailure: failure }) }, 1);
    const status = readStageStatus(projectDir, runId, 'work');
    expect(status.error).toBeUndefined();
    expect(status.continuation).toMatchObject({ forced: true });
    expect(status.status).toBe('complete');
    expect(status.providerFailure).toBeUndefined();
    expect(status.processExitCode).toBe(1);
  });

});
