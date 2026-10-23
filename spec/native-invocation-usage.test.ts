import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { writeSession } from '../src/adapter-session.js';
import { NativeUsageAccumulator, normalizeNativeUsage, sumInvocationUsage, usageComplete } from '../src/invocation-usage.js';
import { createRun } from './test-support/create-run.js';
import { completedStageAttemptStatus, fcGlobalDir, interruptedStageStatus, readStageStatus, setFcGlobalDir } from '../src/store.js';
import { runStage } from '../src/worker.js';

const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 };
const modelUsage = { 'fixture-model': { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 80, cacheCreationInputTokens: 20, costUSD: 0.003 } };
const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n');
const roots: string[] = [];
const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const role = { name: 'fixture', description: 'offline', model: 'default', reasoning_effort: 'default', tools: [], prompt: '' };
function nativeCli(provider: 'claude' | 'codex', script: string) {
  const root = mkdtempSync(join(tmpdir(), 'fc-native-ledger-')); roots.push(root);
  const bin = join(root, 'bin'), home = join(root, 'home'), runDir = join(root, 'run');
  for (const dir of [bin, home, runDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, provider), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{${script}\n});\n`, { mode: 0o755 });
  vi.stubEnv('PATH', bin); vi.stubEnv('HOME', home); vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
  vi.stubEnv('CODEX_HOME', join(home, 'codex')); vi.stubEnv('CODEX_PLUGINS_CACHE', join(home, 'plugins')); vi.stubEnv('CODEX_SKILLS_CACHE', join(home, 'skills'));
  return { workDir: root, runDir, timeout_ms: 10_000 };
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('native invocation usage', () => {
  it('G10 normalizes numeric native JSON and ignores printed or invalid counters', () => {
    expect(normalizeNativeUsage(JSON.parse(JSON.stringify(usage)))).toEqual({ tokens_in: 200, tokens_out: 10, tokens_cached: 80, tokens_cache_created: 20 });
    expect(normalizeNativeUsage({ input_tokens: '100', output_tokens: -1, cache_read_input_tokens: NaN })).toEqual({});
    expect(normalizeNativeUsage({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: '80' })).toEqual({ tokens_out: 10 });
    expect(normalizeNativeUsage({ input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: -1 })).toEqual({ tokens_out: 10 });
    expect(normalizeNativeUsage({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: null })).toEqual({ tokens_out: 10 });
    expect(normalizeNativeUsage('input_tokens: 99999 output_tokens: 99999')).toEqual({});
    expect(normalizeNativeUsage({ input_tokens: 0, output_tokens: 0 })).toEqual({ tokens_in: 0, tokens_out: 0 });
    expect(normalizeNativeUsage({ input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: 1 })).toEqual({ tokens_cache_created: 1 });
    expect(normalizeNativeUsage({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 4 })).toEqual({ tokens_in: 100, tokens_out: 10, tokens_cached: 80, tokens_reasoning: 4 });
  });

  it('G11 uses one authoritative terminal total instead of summing cumulative snapshots', () => {
    const counters = new NativeUsageAccumulator();
    counters.observe({ id: 'message', usage: { ...usage, output_tokens: 1 } });
    counters.observe({ id: 'message', usage });
    counters.observe({ usage, cumulative: true, models: modelUsage, costUsd: 0.003 });
    expect(counters.settle(true)).toEqual({ tokens_in: 200, tokens_out: 10, tokens_cached: 80, tokens_cache_created: 20, cost_usd: 0.003, tokenUsage: 'known', costUsage: 'known', models: { 'fixture-model': { tokens_in: 200, tokens_out: 10, tokens_cached: 80, tokens_cache_created: 20, cost_usd: 0.003 } } });
  });

  it('G11 merges message updates by identity and preserves interrupted lower bounds', () => {
    const counters = new NativeUsageAccumulator();
    counters.observe({ id: 'message', usage: { ...usage, output_tokens: 1 } });
    counters.observe({ id: 'message', usage: { output_tokens: 7 } });
    counters.observe({ id: 'child-message', usage: { input_tokens: 3, output_tokens: 2 } });
    expect(counters.settle(false)).toEqual({ tokens_in: 203, tokens_out: 9, tokens_cached: 80, tokens_cache_created: 20, tokenUsage: 'partial', costUsage: 'unknown' });
    expect(new NativeUsageAccumulator().settle(true)).toEqual({ tokenUsage: 'unknown', costUsage: 'unknown' });
    counters.observe({ cumulative: true, usage: { output_tokens: 10 } });
    expect(counters.settle(true)).toMatchObject({ tokens_in: 203, tokens_out: 10, tokenUsage: 'partial' });
    counters.observe({ cumulative: true, usage, models: modelUsage });
    expect(counters.settle(true).tokenUsage).toBe('known');
    counters.observe({ cumulative: true, usage: { output_tokens: 10 } });
    expect(counters.settle(true)).toMatchObject({ tokens_in: 203, tokens_out: 10, tokenUsage: 'partial' });
  });

  it('G11 keeps model totals as a breakdown and diagnoses native disagreement', () => {
    const counters = new NativeUsageAccumulator();
    counters.observe({ usage: { input_tokens: 5, output_tokens: 1 }, cumulative: true, models: modelUsage, costUsd: 0.003 });
    expect(counters.settle(true)).toMatchObject({ tokens_in: 5, tokens_out: 1, cost_usd: 0.003, tokenUsage: 'partial', reason: 'native_model_usage_disagreement' });
    const fallback = new NativeUsageAccumulator();
    fallback.observe({ cumulative: true, models: modelUsage, costUsd: 0.003 });
    expect(fallback.settle(true)).toMatchObject({ tokens_in: 200, tokens_out: 10, tokenUsage: 'known' });
  });

  it('G11 carries cache creation and actual cost through native calls and attempts', () => {
    const total = sumInvocationUsage([{ tokens_in: 200, tokens_out: 10, tokens_cache_created: 20, cost_usd: 0.003, tokenUsage: 'known' }, { tokens_in: 2, tokens_out: 1, tokens_cache_created: 0, cost_usd: 0, tokenUsage: 'known' }]);
    expect(total).toEqual({ tokens_in: 202, tokens_out: 11, tokens_cache_created: 20, cost_usd: 0.003, tokenUsage: 'known', costUsage: 'known' });
    const status = completedStageAttemptStatus(undefined, 0, { ...total, duration_ms: 1, exitCode: 0 });
    expect(status).toMatchObject({ tokens_in: 202, tokens_out: 11, tokens_cache_created: 20, cost_usd: 0.003 });
    expect(status.attempts?.[0]).toMatchObject(total);
  });

  it('requires cost evidence as well as token counters for a complete usage ledger', () => {
    const tokens = { tokens_in: 20, tokens_out: 2, tokenUsage: 'known' as const };
    expect(usageComplete(tokens)).toBe(false);
    expect(usageComplete({ ...tokens, cost_usd: 0, costUsage: 'known' })).toBe(true);
    expect(usageComplete({ ...tokens, cost_usd: 0.1, costUsage: 'partial' })).toBe(false);
    expect(sumInvocationUsage([{ ...tokens, cost_usd: 0.1 }, tokens])).toMatchObject({ tokenUsage: 'known', cost_usd: 0.1, costUsage: 'partial' });
  });

  it('accounts for Claude continuation costs by subtracting the persisted session total across stages', async () => {
    const opts = nativeCli('claude', `
      const fs = require('node:fs'), path = require('node:path');
      const counter = path.join(process.cwd(),'calls.json');
      const calls = fs.existsSync(counter) ? JSON.parse(fs.readFileSync(counter,'utf8')) : 0;
      fs.writeFileSync(counter,JSON.stringify(calls+1));
      const resumed = process.argv.includes('--resume');
      const total = [0.2,0.5,0.7][calls];
      console.log(JSON.stringify({type:'system',subtype:'init',session_id:'${sessionId}'}));
      console.log(JSON.stringify({type:'result',subtype:'success',session_id:'${sessionId}',result:'done',
        usage:{input_tokens:100,output_tokens:10},total_cost_usd:total,
        modelUsage:{fixture:{inputTokens:resumed ? 200 : 100,outputTokens:resumed ? 20 : 10,costUSD:total}}}));
    `);
    const adapter = new ClaudeAdapter();
    const first = await adapter.run('first', role, { ...opts, stageId: 'build' });
    expect(first).toMatchObject({ cost_usd: 0.2, tokenUsage: 'known', costUsage: 'known' });
    const next = await adapter.run('continue', role, { ...opts, stageId: 'continue', resumeSessionId: sessionId, sessionOwnerStageId: 'build' });
    expect(next).toMatchObject({ tokens_in: 100, tokens_out: 10, tokenUsage: 'known', costUsage: 'known' });
    expect(next.cost_usd).toBeCloseTo(0.3);
    expect(next.invocations?.[0].cost_usd).toBeCloseTo(0.3);
    expect(sumInvocationUsage([first, next]).cost_usd).toBeCloseTo(0.5);
    const resumedOwner = await adapter.run('return to owner', role, { ...opts, stageId: 'build', resumeSessionId: sessionId });
    expect(resumedOwner).toMatchObject({ tokenUsage: 'known', costUsage: 'known' });
    expect(resumedOwner.cost_usd).toBeCloseTo(0.2);
    expect(sumInvocationUsage([first, next, resumedOwner]).cost_usd).toBeCloseTo(0.7);
  });

  it('keeps an unknown Claude continuation baseline unknown while retaining its next usable total', async () => {
    const opts = nativeCli('claude', `
      console.log(JSON.stringify({type:'system',subtype:'init',session_id:'${sessionId}'}));
      console.log(JSON.stringify({type:'result',subtype:'success',session_id:'${sessionId}',result:'done',
        usage:{input_tokens:100,output_tokens:10},total_cost_usd:0.5,
        modelUsage:{fixture:{inputTokens:200,outputTokens:20,costUSD:0.5}}}));
    `);
    writeSession(opts.runDir, 'build', { version: 1, sessionId, ownerStageId: 'build', adapter: 'claude', capturedAt: new Date().toISOString() });
    const result = await new ClaudeAdapter().run('continue', role, { ...opts, stageId: 'continue', resumeSessionId: sessionId, sessionOwnerStageId: 'build' });
    expect(result).toMatchObject({ tokens_in: 100, tokens_out: 10, tokenUsage: 'known', costUsage: 'unknown' });
    expect(result.cost_usd).toBeUndefined();
    expect(result.invocations?.[0].cost_usd).toBeUndefined();
    expect(sumInvocationUsage([{ cost_usd: 0.2, tokens_in: 100, tokens_out: 10 }, result])).toMatchObject({ cost_usd: 0.2, costUsage: 'partial' });
    const next = await new ClaudeAdapter().run('continue again', role, { ...opts, stageId: 'continue', resumeSessionId: sessionId });
    expect(next).toMatchObject({ cost_usd: 0, tokenUsage: 'known', costUsage: 'known' });
  });

  it.each(['torn', 'unreadable'] as const)('keeps a %s Claude session cost baseline unknown and atomically replaces it', async failure => {
    const opts = nativeCli('claude', `
      console.log(JSON.stringify({type:'system',subtype:'init',session_id:'${sessionId}'}));
      console.log(JSON.stringify({type:'result',subtype:'success',session_id:'${sessionId}',result:'done',
        usage:{input_tokens:100,output_tokens:10},total_cost_usd:0.5}));
    `);
    const costDir = join(opts.runDir, 'run-history', 'native-session-costs');
    mkdirSync(costDir, { recursive: true });
    const costPath = join(costDir, `${sessionId}.json`);
    writeFileSync(costPath, failure === 'torn' ? '{"cumulativeCostUsd":0.' : JSON.stringify({ cumulativeCostUsd: 0.2 }));
    if (failure === 'unreadable') chmodSync(costPath, 0);
    const adapter = new ClaudeAdapter();
    const result = await adapter.run('continue', role, { ...opts, stageId: 'build', resumeSessionId: sessionId });
    expect(result).toMatchObject({ tokens_in: 100, tokens_out: 10, tokenUsage: 'known', costUsage: 'unknown' });
    expect(result.cost_usd).toBeUndefined();
    expect(result.invocations?.[0]).toMatchObject({ costUsage: 'unknown' });
    expect(result.invocations?.[0].cost_usd).toBeUndefined();
    expect(usageComplete(result)).toBe(false);
    expect(JSON.parse(readFileSync(costPath, 'utf8'))).toEqual({ cumulativeCostUsd: 0.5 });
    const next = await adapter.run('continue again', role, { ...opts, stageId: 'build', resumeSessionId: sessionId });
    expect(next).toMatchObject({ cost_usd: 0, costUsage: 'known' });
  });

  it('uses a verified Codex rollout interval even when continued stdout reports session totals', async () => {
    const opts = nativeCli('codex', `
      const fs = require('node:fs'), path = require('node:path');
      const resumed = process.argv.includes('resume');
      const dir = path.join(process.env.CODEX_HOME,'sessions','2026','10','06');
      fs.mkdirSync(dir,{recursive:true});
      fs.appendFileSync(path.join(dir,'rollout-fixture-${sessionId}.jsonl'),JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:resumed?160:100,output_tokens:resumed?18:10}}}})+'\\n');
      console.log(JSON.stringify({type:'thread.started',thread_id:'${sessionId}'}));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:resumed?160:100,output_tokens:resumed?18:10}}));
    `);
    const adapter = new CodexAdapter();
    await adapter.run('first', role, { ...opts, stageId: 'build', preserveSession: true });
    const next = await adapter.run('continue', role, { ...opts, stageId: 'build', resumeSessionId: sessionId });
    expect(next).toMatchObject({ tokens_in: 60, tokens_out: 8, tokenUsage: 'known', costUsage: 'unknown' });
    expect(next.invocations).toHaveLength(1);
    expect(next.invocations?.[0]).toMatchObject({ source: 'rollout_interval', tokens_in: 60, tokens_out: 8, tokenUsage: 'known' });
  });

  it('retains counters and native invocations already collected on a cancelled attempt', () => {
    const invocation = { startedAt: '2026-10-22T00:00:00.000Z', completedAt: '2026-10-22T00:00:01.000Z', exitCode: 137, source: 'native_stdout' as const, tokens_in: 40, tokens_out: 3, cost_usd: 0.02, tokenUsage: 'partial' as const, costUsage: 'partial' as const };
    const status = completedStageAttemptStatus({ status: 'running', retries: 0, attempts: [{ index: 1, status: 'running', ...invocation, invocations: [invocation] }] }, 0,
      { duration_ms: 1000, exitCode: 137 });
    expect(status).toMatchObject({ status: 'failed', tokens_in: 40, tokens_out: 3, cost_usd: 0.02, costUsage: 'partial' });
    expect(status.attempts?.[0]).toMatchObject({ status: 'failed', tokens_in: 40, tokens_out: 3, cost_usd: 0.02, tokenUsage: 'partial', costUsage: 'partial', invocations: [invocation] });
  });

  it.each(['known', 'partial'] as const)('settles interrupted %s samples as lower bounds without inventing missing usage', tokenUsage => {
    const startedAt = '2026-10-22T00:00:00.000Z', completedAt = '2026-10-22T00:00:01.000Z';
    const invocation = { startedAt, completedAt, exitCode: 0, source: 'native_stdout' as const,
      tokens_in: 40, tokens_out: 3, tokenUsage, costUsage: 'unknown' as const };
    const previous = { status: 'running' as const, retries: 0, attempts: [{ index: 1, status: 'running' as const,
      ...invocation, invocations: [invocation] }] };
    const settled = interruptedStageStatus(previous, completedAt, 'interrupted');
    expect(settled.attempts).toHaveLength(1);
    expect(settled.attempts?.[0]).toMatchObject({ status: 'failed', exitCode: 143, tokens_in: 40, tokens_out: 3,
      tokenUsage: 'partial', costUsage: 'unknown', invocations: [invocation] });
    expect(settled.cost_usd).toBeUndefined();
    expect(sumInvocationUsage(settled.attempts!)).toMatchObject({ tokens_in: 40, tokens_out: 3, tokenUsage: 'partial', costUsage: 'unknown' });
    expect(usageComplete(settled.attempts![0])).toBe(false);
    const missing = interruptedStageStatus({ ...previous, attempts: [{ index: 1, status: 'running', startedAt, tokenUsage }] }, completedAt, 'interrupted');
    expect(missing.attempts?.[0]).toMatchObject({ tokenUsage: 'unknown', costUsage: 'unknown' });
    expect(missing.tokens_in).toBeUndefined();
    expect(missing.tokens_out).toBeUndefined();
    expect(missing.cost_usd).toBeUndefined();
  });

  it('G10/G11 parses the actual ClaudeAdapter stream into the shared native ledger', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-native-usage-')); roots.push(root);
    const bin = join(root, 'bin'), home = join(root, 'home'), runDir = join(root, 'run');
    for (const dir of [bin, home, runDir]) mkdirSync(dir, { recursive: true });
    const stream = jsonl(
      { type: 'assistant', message: { id: 'message', usage, content: [{ type: 'text', text: 'input_tokens: 99999 output_tokens: 99999' }] } },
      { type: 'result', subtype: 'success', result: 'done', usage, modelUsage, total_cost_usd: 0.003 },
    );
    writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(stream)});});\n`, { mode: 0o755 });
    vi.stubEnv('PATH', bin); vi.stubEnv('HOME', home); vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
    const result = await new ClaudeAdapter().run('tiny offline prompt', { name: 'fixture', description: 'offline', model: 'default', reasoning_effort: 'default', tools: [], prompt: '' }, { workDir: root, runDir, stageId: 'work', timeout_ms: 10_000 });
    expect(result).toMatchObject({ tokens_in: 200, tokens_out: 10, tokens_cached: 80, tokens_cache_created: 20, cost_usd: 0.003, tokenUsage: 'known' });
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations?.[0]).toMatchObject({ tokens_in: 200, tokens_out: 10, source: 'native_stdout', tokenUsage: 'known', cost_usd: 0.003, models: { 'fixture-model': { tokens_in: 200 } } });
    const previousStore = fcGlobalDir();
    try {
      setFcGlobalDir(join(root, 'state'));
      const projectDir = join(root, 'project'); mkdirSync(projectDir);
      const created = createRun(projectDir, 'usage-fixture', 'name: usage-fixture\nstages: []\n', ['work']);
      await runStage(new ClaudeAdapter(), { stageId: 'work', role: { name: 'fixture', description: 'offline', model: 'default', reasoning_effort: 'default', tools: [], prompt: '' }, dependsOn: [], promptTemplate: 'tiny offline prompt', projectDir, runDir: created.runDirPath, runId: created.runId, retries: 0, timeout_ms: 10_000,  artifactContract: { version: 1, produces: [], reads: [], groups: [] } });
      const status = readStageStatus(projectDir, created.runId, 'work');
      expect(status).toMatchObject({ tokens_in: 200, tokens_out: 10, tokens_cached: 80, tokens_cache_created: 20, cost_usd: 0.003 });
      expect(status.attempts?.[0]).toMatchObject({ tokens_in: 200, tokens_out: 10, tokens_cached: 80, tokens_cache_created: 20, cost_usd: 0.003, tokenUsage: 'known' });
    } finally { setFcGlobalDir(previousStore); }
  });
});
