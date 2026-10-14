/** Invocation costs are lower bounds unless every contributing call settled
 * with complete native counters. Missing evidence must never become zero cost. */
import { closeSync, openSync } from './engine-fs.js';
import { constants, fstatSync, lstatSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export type TokenUsage = 'known' | 'partial' | 'unknown';
export interface InvocationUsage {
  tokens_in?: number;
  tokens_out?: number;
  tokens_cached?: number;
  tokens_cache_created?: number;
  tokens_reasoning?: number;
  cost_usd?: number;
  tokenUsage?: TokenUsage;
}
export interface NativeInvocationUsage extends InvocationUsage {
  startedAt: string;
  completedAt: string;
  exitCode: number;
  sessionId?: string;
  source: 'rollout_interval' | 'native_stdout' | 'unknown';
  reason?: string;
  models?: Record<string, InvocationUsage>;
}
const fields = ['tokens_in', 'tokens_out', 'tokens_cached', 'tokens_cache_created', 'tokens_reasoning'] as const;
const quantity = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const cost = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** Carry the same evidence through worker, attempt and stage settlement. */
export function invocationUsageFields(value: InvocationUsage | undefined): InvocationUsage {
  return Object.fromEntries([...fields, 'cost_usd', 'tokenUsage'].map(field => [field, value?.[field as keyof InvocationUsage]]));
}
export function usageComplete(value: InvocationUsage): boolean {
  return value.tokenUsage !== 'partial' && value.tokenUsage !== 'unknown'
    && quantity(value.tokens_in) && quantity(value.tokens_out);
}
export function sumInvocationUsage(values: InvocationUsage[]): InvocationUsage {
  const result: InvocationUsage = {};
  for (const field of fields) {
    const counters = values.map(v => v[field]).filter(quantity);
    const total = counters.reduce((n,v) => n+v,0);
    if (counters.length && quantity(total)) result[field] = total;
  }
  const costs = values.map(v => v.cost_usd).filter(cost);
  const totalCost = costs.reduce((n, v) => n + v, 0);
  if (costs.length && cost(totalCost)) result.cost_usd = totalCost;
  result.tokenUsage = values.length > 0 && values.every(usageComplete) && usageComplete(result) ? 'known'
    : fields.some(field => result[field] !== undefined) ? 'partial' : 'unknown';
  return result;
}

/** Native counters only: never interpret numeric-looking assistant prose.
 * Input totals include cache reads/creation where the provider reports these
 * separately; cached-input counters already contained in input stay subsets. */
export function normalizeNativeUsage(value: unknown): InvocationUsage {
  if (!value || typeof value !== 'object') return {};
  const native = value as Record<string, unknown>;
  const result: InvocationUsage = {};
  const input = native.input_tokens ?? native.inputTokens;
  const output = native.output_tokens ?? native.outputTokens;
  const read = native.cache_read_input_tokens !== undefined ? native.cache_read_input_tokens : native.cacheReadInputTokens;
  const created = native.cache_creation_input_tokens !== undefined ? native.cache_creation_input_tokens : native.cacheCreationInputTokens;
  const cached = read ?? native.cached_input_tokens;
  const reasoning = native.reasoning_output_tokens ?? native.reasoningOutputTokens;
  if (quantity(input) && (read === undefined || quantity(read)) && (created === undefined || quantity(created))) {
    const gross = input + (quantity(read) ? read : 0) + (quantity(created) ? created : 0);
    if (quantity(gross)) result.tokens_in = gross;
  }
  if (quantity(output)) result.tokens_out = output;
  if (quantity(cached)) result.tokens_cached = cached;
  if (quantity(created)) result.tokens_cache_created = created;
  if (quantity(reasoning)) result.tokens_reasoning = reasoning;
  if (cost(native.costUSD)) result.cost_usd = native.costUSD;
  return result;
}

/** One invocation can emit updated message counters and a cumulative terminal
 * total. Updates replace the same message; terminal totals replace messages.
 * Model totals are a breakdown, never additional calls to sum into that total. */
export class NativeUsageAccumulator {
  private readonly messages = new Map<string, InvocationUsage>();
  private cumulative?: InvocationUsage;
  private models?: Record<string, InvocationUsage>;

  observe(value: { usage?: unknown; id?: string; cumulative?: boolean; costUsd?: unknown; models?: unknown }): void {
    const usage = normalizeNativeUsage(value.usage);
    if (cost(value.costUsd)) usage.cost_usd = value.costUsd;
    if (value.cumulative) {
      this.cumulative = usage;
      this.models = value.models && typeof value.models === 'object'
        ? Object.fromEntries(Object.entries(value.models).map(([model, counters]) => [model, normalizeNativeUsage(counters)])) : undefined;
    } else if (Object.keys(usage).length) {
      const id = value.id ?? `call-${this.messages.size}`;
      this.messages.set(id, { ...this.messages.get(id), ...usage });
    }
  }

  settle(complete: boolean): InvocationUsage & Pick<NativeInvocationUsage, 'models' | 'reason'> {
    const modelTotal = this.models ? sumInvocationUsage(Object.values(this.models)) : undefined;
    const cumulativeHasTokens = this.cumulative && fields.some(field => this.cumulative?.[field] !== undefined);
    const usage = { ...sumInvocationUsage([...this.messages.values()]), ...modelTotal, ...this.cumulative };
    const mismatch = cumulativeHasTokens && modelTotal && ['tokens_in', 'tokens_out'].some(field => {
      const key = field as 'tokens_in' | 'tokens_out';
      return usage[key] !== undefined && modelTotal[key] !== undefined && usage[key] !== modelTotal[key];
    });
    usage.tokenUsage = complete && (usageComplete(this.cumulative ?? {}) || usageComplete(modelTotal ?? {})) && !mismatch
      && quantity(usage.tokens_in) && quantity(usage.tokens_out) ? 'known'
      : fields.some(field => usage[field] !== undefined) ? 'partial' : 'unknown';
    return { ...usage, ...(this.models ? { models: this.models } : {}),
      ...(mismatch ? { reason: 'native_model_usage_disagreement' } : {}) };
  }
}
/** Legacy printed counters shared by adapters. Native invocation evidence
 * still determines whether these quantities are complete or only a lower bound. */
export function parsePrintedTokenUsage(output: string): InvocationUsage {
  const m = output.match(/[Tt]okens[^:]*:\s*([\d,]+)\s*(?:in(?:put)?)\s*[/,]\s*([\d,]+)\s*(?:out(?:put)?)/);
  if (m) return { tokens_in: parseInt(m[1].replace(/,/g, ''), 10), tokens_out: parseInt(m[2].replace(/,/g, ''), 10) };
  const inM = output.match(/input_tokens\s*[:=]\s*([\d,]+)/);
  const outM = output.match(/output_tokens\s*[:=]\s*([\d,]+)/);
  if (inM || outM) return {
    tokens_in: inM ? parseInt(inM[1].replace(/,/g, ''), 10) : undefined,
    tokens_out: outM ? parseInt(outM[1].replace(/,/g, ''), 10) : undefined,
  };
  return {};
}

interface RolloutCounter {
  path: string;
  identity: string;
  size: number;
  usage?: InvocationUsage;
}
/** Inspect only the date-shaped session namespace, with no followed links.
 * Bounded tails avoid reparsing whole conversation histories on each launch. */
export function captureCodexRollouts(home: string): Map<string, RolloutCounter> {
  const found = new Map<string, RolloutCounter>();
  const root = join(home,'sessions');
  try { if (!lstatSync(home).isDirectory() || !lstatSync(root).isDirectory()) return found; } catch { return found; }
  function scan(dir: string, depth: number): void {
    let entries; try { entries = readdirSync(dir,{withFileTypes:true}); } catch { return; }
    for (const entry of entries) {
      const path = join(dir,entry.name);
      if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) { scan(path,depth+1); continue; }
      const id = entry.name.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
      if (!entry.isFile() || !id) continue;
      let fd: number | undefined;
      try {
        fd = openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
        const stat = fstatSync(fd); if (!stat.isFile()) continue;
        const buffer = Buffer.alloc(Math.min(stat.size,262144));
        const offset = stat.size-buffer.length;
        const bytes = readSync(fd,buffer,0,buffer.length,offset);
        const lines = buffer.subarray(0,bytes).toString('utf8').split(/\r?\n/);
        if (offset > 0) lines.shift();
        let usage: InvocationUsage | undefined;
        for (const line of lines) {
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.type !== 'event_msg' || e.payload?.type !== 'token_count') continue;
          const total = e.payload.info?.total_token_usage;
          if (!total || !quantity(total.input_tokens) || !quantity(total.output_tokens)) continue;
          usage = {tokens_in:total.input_tokens,tokens_out:total.output_tokens,
            ...(quantity(total.cached_input_tokens)?{tokens_cached:total.cached_input_tokens}:{}),
            ...(quantity(total.reasoning_output_tokens)?{tokens_reasoning:total.reasoning_output_tokens}:{})};
        }
        // A duplicate UUID or concurrent file replacement is not a valid interval.
        if (found.has(id)) { found.set(id,{path,identity:'ambiguous',size:stat.size}); continue; }
        found.set(id,{path,identity:`${stat.dev}:${stat.ino}`,size:stat.size,usage});
      } catch { /* absent/unreadable evidence is unknown, never a launch failure */ }
      finally { if(fd!==undefined)closeSync(fd); }
    }
  }
  scan(root,0); return found;
}
export function codexRolloutInterval(before: Map<string, RolloutCounter>, after: Map<string, RolloutCounter>, sessionId: string): {usage?: InvocationUsage; reason?: string} {
  const end = after.get(sessionId), start = before.get(sessionId);
  if (!end?.usage) return {reason:'rollout_counter_unavailable'};
  if (start && (!start.usage || start.identity !== end.identity || start.size >= end.size)) return {reason:'rollout_interval_unverified'};
  const delta: InvocationUsage = {};
  for (const field of fields) {
    const a = start ? start.usage?.[field] : 0, b = end.usage[field];
    if (b === undefined || a === undefined) continue;
    if (b < a) return {reason:'rollout_counter_reset'};
    delta[field] = b-a;
  }
  return {usage:delta};
}
