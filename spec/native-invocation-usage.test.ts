import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { NativeUsageAccumulator, normalizeNativeUsage, sumInvocationUsage } from '../src/invocation-usage.js';
import { completedStageAttemptStatus, createRun, fcGlobalDir, readStageStatus, setFcGlobalDir } from '../src/store.js';
import { runStage } from '../src/worker.js';

const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 };
const modelUsage = { 'fixture-model': { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 80, cacheCreationInputTokens: 20, costUSD: 0.003 } };
const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n');
const roots: string[] = [];
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
    expect(counters.settle(true)).toEqual({ tokens_in: 200, tokens_out: 10, tokens_cached: 80, tokens_cache_created: 20, cost_usd: 0.003, tokenUsage: 'known', models: { 'fixture-model': { tokens_in: 200, tokens_out: 10, tokens_cached: 80, tokens_cache_created: 20, cost_usd: 0.003 } } });
  });

  it('G11 merges message updates by identity and preserves interrupted lower bounds', () => {
    const counters = new NativeUsageAccumulator();
    counters.observe({ id: 'message', usage: { ...usage, output_tokens: 1 } });
    counters.observe({ id: 'message', usage: { output_tokens: 7 } });
    counters.observe({ id: 'child-message', usage: { input_tokens: 3, output_tokens: 2 } });
    expect(counters.settle(false)).toEqual({ tokens_in: 203, tokens_out: 9, tokens_cached: 80, tokens_cache_created: 20, tokenUsage: 'partial' });
    expect(new NativeUsageAccumulator().settle(true)).toEqual({ tokenUsage: 'unknown' });
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
    expect(total).toEqual({ tokens_in: 202, tokens_out: 11, tokens_cache_created: 20, cost_usd: 0.003, tokenUsage: 'known' });
    const status = completedStageAttemptStatus(undefined, 0, { ...total, duration_ms: 1, exitCode: 0 });
    expect(status).toMatchObject({ tokens_in: 202, tokens_out: 11, tokens_cache_created: 20, cost_usd: 0.003 });
    expect(status.attempts?.[0]).toMatchObject(total);
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
      await runStage(new ClaudeAdapter(), { stageId: 'work', role: { name: 'fixture', description: 'offline', model: 'default', reasoning_effort: 'default', tools: [], prompt: '' }, dependsOn: [], promptTemplate: 'tiny offline prompt', projectDir, runDir: created.runDirPath, runId: created.runId, retries: 0, timeout_ms: 10_000, projectWriteScope: [], artifactContract: { version: 1, produces: [], reads: [], groups: [], replays: [] } });
      const status = readStageStatus(projectDir, created.runId, 'work');
      expect(status).toMatchObject({ tokens_in: 200, tokens_out: 10, tokens_cached: 80, tokens_cache_created: 20, cost_usd: 0.003 });
      expect(status.attempts?.[0]).toMatchObject({ tokens_in: 200, tokens_out: 10, tokens_cached: 80, tokens_cache_created: 20, cost_usd: 0.003, tokenUsage: 'known' });
    } finally { setFcGlobalDir(previousStore); }
  });
});
