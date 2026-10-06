import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCodexRollouts, codexRolloutInterval, sumInvocationUsage } from '../src/invocation-usage.js';
import {
  buildCodexExecArgs,
  parseCodexJsonl,
  type CodexSessionMetadata,
} from '../src/adapters/codex.js';
import {
  canReuseCodexSession,
  StageConfigSchema,
  type StageConfig,
} from '../src/scheduler.js';
import type { StageStatus, StoreState } from '../src/store.js';
import { sessionResumeForStage } from '../src/scheduler/sched_admission/sessions.js';
import { isSessionReuseEnabled } from '../src/config.js';
import { classifyAdapterFailure } from '../src/worker.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('native invocation cost evidence', () => {
  it('subtracts resumed cumulative counters, retains cached/reasoning counts and rejects resets', () => {
    const home = mkdtempSync(join(tmpdir(),'fc-usage-'));
    try {
      const dir = join(home,'sessions','2026','10','06'); mkdirSync(dir,{recursive:true});
      const file = join(dir,`rollout-test-${UUID}.jsonl`);
      const counter = (input: number, output: number, cached: number, reasoning: number) => JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:output,cached_input_tokens:cached,reasoning_output_tokens:reasoning}}}})+'\n';
      writeFileSync(file,counter(100,10,50,3));
      const before = captureCodexRollouts(home);
      expect(codexRolloutInterval(before,before,UUID)).toEqual({reason:'rollout_interval_unverified'});
      appendFileSync(file,counter(160,18,90,5));
      const after = captureCodexRollouts(home);
      expect(codexRolloutInterval(before,after,UUID).usage).toEqual({tokens_in:60,tokens_out:8,tokens_cached:40,tokens_reasoning:2});
      appendFileSync(file,counter(1,1,0,0));
      expect(codexRolloutInterval(after,captureCodexRollouts(home),UUID)).toEqual({reason:'rollout_counter_reset'});
      expect(sumInvocationUsage([{tokens_in:60,tokens_out:8,tokenUsage:'partial'},{}])).toMatchObject({tokens_in:60,tokens_out:8,tokenUsage:'partial'});
    } finally { rmSync(home,{recursive:true,force:true}); }
  });
  it('does not turn missing retry usage into a complete aggregate', () => {
    expect(sumInvocationUsage([{}, {tokens_in:20,tokens_out:2,tokenUsage:'known'}])).toEqual({tokens_in:20,tokens_out:2,tokenUsage:'partial'});
    expect(sumInvocationUsage([{},{}])).toEqual({tokenUsage:'unknown'});
    expect(sumInvocationUsage([{tokens_in:Number.MAX_SAFE_INTEGER,tokens_out:1},{tokens_in:1,tokens_out:1}])).toEqual({tokens_out:2,tokenUsage:'partial'});
  });
});

function stage(id: string, input: Partial<StageConfig> = {}): StageConfig {
  return StageConfigSchema.parse({ id, role: 'coder', scope: [`${id}.ts`], ...input });
}

function successfulStatus(overrides: Partial<StageStatus> = {}): StageStatus {
  return {
    status: 'complete',
    retries: 0,
    reruns: 0,
    attempts: [{
      index: 1,
      startedAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:01.000Z',
      status: 'complete',
      exitCode: 0,
      duration_ms: 1000,
    }],
    ...overrides,
  };
}

const session: CodexSessionMetadata = {
  version: 1,
  sessionId: UUID,
  ownerStageId: 'build',
  capturedAt: '2026-07-31T00:00:01.000Z',
};

describe('UUID-only Codex sessions', () => {
  const originalOverride = process.env.FC_SESSION_REUSE;

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.FC_SESSION_REUSE;
    else process.env.FC_SESSION_REUSE = originalOverride;
  });

  it('defaults to cold stages after the below-threshold A/B and remains explicitly opt-in', () => {
    delete process.env.FC_SESSION_REUSE;
    expect(isSessionReuseEnabled()).toBe(false);
    process.env.FC_SESSION_REUSE = '1';
    expect(isSessionReuseEnabled()).toBe(true);
    process.env.FC_SESSION_REUSE = '0';
    expect(isSessionReuseEnabled()).toBe(false);
  });

  it('builds an explicit UUID resume command with a stdin sentinel and never selects global recency', () => {
    const args = buildCodexExecArgs('continue', UUID);
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(args).toContain(UUID);
    expect(args).not.toContain(['--', 'last'].join(''));
    // Prompt presence in argv became obsolete when large prompts moved to stdin.
    expect(args).not.toContain('continue');
    expect(args.slice(-2)).toEqual(['--', '-']);
    expect(() => buildCodexExecArgs('continue', 'not-a-uuid')).toThrow(/explicit UUID/);
  });

  it('captures thread UUID, usage, final message, and structured file changes from JSONL', () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: 'thread.started', thread_id: UUID }),
      JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/project/src/a.ts', kind: 'update' }] } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, output_tokens: 45 } }),
    ].join('\n'), '/project');
    expect(parsed).toMatchObject({ sessionId: UUID, output: 'done', tokens_in: 120, tokens_out: 45 });
    expect(parsed.writes).toEqual(['src/a.ts']);
  });

  it.each([
    ['403 Forbidden', 'forbidden'],
    ['connection refused', 'connection_refused'],
    ['ECONNRESET', 'connection_reset'],
    ['429 Too Many Requests', 'rate_limited'],
    ['ETIMEDOUT', 'transport_timeout'],
    ['502 Bad Gateway', 'bad_gateway'],
    ['503 Service Unavailable', 'service_unavailable'],
    ['service overloaded', 'overloaded'],
    ['Selected model is at capacity. Please try a different model.', 'capacity'],
  ] as const)('retains terminal adapter error %s after a mid-work agent message', (message, kind) => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: 'thread.started', thread_id: UUID }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stage was already mid-work' } }),
      JSON.stringify({ type: 'error', message }),
      JSON.stringify({ type: 'turn.failed', error: { message } }),
    ].join('\n'));

    expect(parsed.output).toContain('stage was already mid-work');
    expect(classifyAdapterFailure(parsed.output)).toBe(kind);
    expect(parsed.adapterFailureKind).toBe(kind);
  });

  it('does not preserve a recovered error past a completed turn', () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: 'error', message: 'Selected model is at capacity.' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'recovered result' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n'));

    expect(parsed.output).toBe('recovered result');
    expect(classifyAdapterFailure(parsed.output)).toBeUndefined();
    expect(parsed.adapterFailureKind).toBeUndefined();
  });

  it('resumes only one successful non-validation dependency edge', () => {
    const build = stage('build');
    const continueStage = stage('continue', { depends_on: ['build'] });
    expect(canReuseCodexSession({
      stage: continueStage,
      predecessor: build,
      allStages: [build, continueStage],
      predecessorStatus: successfulStatus(),
      destinationStatus: { status: 'pending', retries: 0 },
      session,
    })).toBe(true);
  });

  it('forces cold start for validation roles and failed/retried predecessors', () => {
    const build = stage('build');
    const qa = stage('verify_release', { role: 'qa', is_gate: true, depends_on: ['build'] });
    expect(canReuseCodexSession({
      stage: qa,
      predecessor: build,
      allStages: [build, qa],
      predecessorStatus: successfulStatus(),
      destinationStatus: { status: 'pending', retries: 0 },
      session,
    })).toBe(false);

    const next = stage('next', { depends_on: ['build'] });
    expect(canReuseCodexSession({
      stage: next,
      predecessor: build,
      allStages: [build, next],
      predecessorStatus: successfulStatus({ retries: 1 }),
      destinationStatus: { status: 'pending', retries: 0 },
      session,
    })).toBe(false);
    expect(canReuseCodexSession({
      stage: next,
      predecessor: build,
      allStages: [build, next],
      predecessorStatus: successfulStatus({ status: 'failed' }),
      destinationStatus: { status: 'pending', retries: 0 },
      session,
    })).toBe(false);
  });

  it('forces cold start for multiple predecessors, multiple reusable successors, or a rerun destination', () => {
    const build = stage('build');
    const sibling = stage('sibling', { depends_on: ['build'] });
    const next = stage('next', { depends_on: ['build'] });
    const multi = stage('multi', { depends_on: ['build', 'sibling'] });
    const base = {
      predecessor: build,
      predecessorStatus: successfulStatus(),
      destinationStatus: { status: 'pending', retries: 0 } as StageStatus,
      session,
    };
    expect(canReuseCodexSession({ ...base, stage: next, allStages: [build, next, sibling] })).toBe(false);
    expect(canReuseCodexSession({ ...base, stage: multi, allStages: [build, sibling, multi] })).toBe(false);
    expect(canReuseCodexSession({
      ...base,
      stage: next,
      allStages: [build, next],
      destinationStatus: successfulStatus(),
    })).toBe(false);
  });
});


describe('own-stage continuation', () => {
  it('retains a settled stage UUID independently of predecessor reuse, without inheriting foreign or gate reasoning', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-own-session-'));
    try {
      const subject = stage('work');
      const state = { stages: { work: successfulStatus({ status: 'pending', retries: 1 }) } } as StoreState;
      const writeSession = (record: object) => { mkdirSync(join(root, 'stages', 'work'), { recursive: true }); writeFileSync(join(root, 'stages', 'work', 'session.json'), JSON.stringify(record)); };
      writeSession({ version: 1, sessionId: UUID, ownerStageId: 'work', capturedAt: new Date().toISOString() });
      expect(sessionResumeForStage(subject, [subject], state, root, false)).toBeUndefined();
      mkdirSync(join(root, 'stages', 'work', 'codex_home'), { recursive: true });
      expect(sessionResumeForStage(subject, [subject], state, root, false)).toEqual({ sessionId: UUID, ownerStageId: 'work' });
      expect(sessionResumeForStage({ ...subject, is_gate: true }, [subject], state, root, false)).toBeUndefined();
      writeSession({ version: 1, sessionId: UUID, ownerStageId: 'builder', capturedAt: new Date().toISOString() });
      expect(sessionResumeForStage(subject, [subject], state, root, false)).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
