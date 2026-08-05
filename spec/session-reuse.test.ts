import { afterEach, describe, expect, it } from 'vitest';
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
import type { StageStatus } from '../src/store.js';
import { isSessionReuseEnabled } from '../src/config.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

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

  it('builds an explicit UUID resume command and never selects global recency', () => {
    const args = buildCodexExecArgs('continue', UUID);
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(args).toContain(UUID);
    expect(args).not.toContain(['--', 'last'].join(''));
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
