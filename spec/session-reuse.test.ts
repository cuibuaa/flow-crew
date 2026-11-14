import { runRecordPath } from '../src/run-layout.js';
import { stageSessionHome } from '../src/adapter-session.js';
import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCodexRollouts, codexRolloutInterval, sumInvocationUsage } from '../src/invocation-usage.js';
import {
  buildCodexExecArgs,
  parseCodexJsonl,
} from '../src/adapters/codex.js';
import {
  StageConfigSchema,
  type StageConfig,
} from '../src/scheduler.js';
import { clearGateContinuationsForStages } from '../src/scheduler/sched_admission/sessions.js';

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
    expect(sumInvocationUsage([{}, {tokens_in:20,tokens_out:2,tokenUsage:'known'}])).toEqual({tokens_in:20,tokens_out:2,tokenUsage:'partial',costUsage:'unknown'});
    expect(sumInvocationUsage([{},{}])).toEqual({tokenUsage:'unknown',costUsage:'unknown'});
    expect(sumInvocationUsage([{tokens_in:Number.MAX_SAFE_INTEGER,tokens_out:1},{tokens_in:1,tokens_out:1}])).toEqual({tokens_out:2,tokenUsage:'partial',costUsage:'unknown'});
  });
});

function stage(id: string, input: Partial<StageConfig> = {}): StageConfig {
  return StageConfigSchema.parse({ id, role: 'coder', scope: [`${id}.ts`], ...input });
}

describe('UUID-only Codex sessions', () => {
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
    '403 Forbidden',
    'Selected model is at capacity. Please try a different model.',
    'workspace routing discovery failed',
  ])('retains a transient terminal failure after progress: %s', message => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: 'thread.started', thread_id: UUID }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stage was already mid-work' } }),
      JSON.stringify({ type: 'error', message }),
      JSON.stringify({ type: 'turn.failed', error: { message } }),
    ].join('\n'));

    expect(parsed.output).toContain('stage was already mid-work');
    expect(parsed.providerFailure).toMatchObject({ kind: 'transient', reason: message });
  });

  it('does not preserve a recovered error past a completed turn', () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: 'error', message: 'Selected model is at capacity.' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'recovered result' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n'));

    expect(parsed.output).toBe('recovered result');
    expect(parsed.providerFailure).toBeUndefined();
  });
});


describe('repair session cleanup', () => {
  it('retires author session storage after the repair loop', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-repair-session-'));
    try {
      const implement = stage('implement');
      const review = stage('review', { role: 'qa', is_gate: true, depends_on: ['implement'] });
      const repair = stage('repair', { depends_on: ['review'], retry_to: ['review'] });
      const all = [implement, review, repair];
      mkdirSync(stageSessionHome(root, 'implement'), { recursive: true });
      writeFileSync(runRecordPath(root, 'stages', 'implement', 'session.json'), JSON.stringify({ version: 1, sessionId: UUID, ownerStageId: 'implement', capturedAt: new Date().toISOString() }));

      clearGateContinuationsForStages(root, all);
      expect(existsSync(stageSessionHome(root, 'implement'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
