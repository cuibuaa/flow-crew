/** Invocation costs are lower bounds unless every contributing call settled
 * with complete native counters. Missing evidence must never become zero cost. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export type TokenUsage = 'known' | 'partial' | 'unknown';
export interface InvocationUsage {
  tokens_in?: number;
  tokens_out?: number;
  tokens_cached?: number;
  tokens_reasoning?: number;
  tokenUsage?: TokenUsage;
}
export interface NativeInvocationUsage extends InvocationUsage {
  startedAt: string;
  completedAt: string;
  exitCode: number;
  sessionId?: string;
  source: 'rollout_interval' | 'native_stdout' | 'unknown';
  reason?: string;
}
const fields = ['tokens_in', 'tokens_out', 'tokens_cached', 'tokens_reasoning'] as const;
const quantity = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
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
  result.tokenUsage = values.length > 0 && values.every(usageComplete) && usageComplete(result) ? 'known'
    : fields.some(field => result[field] !== undefined) ? 'partial' : 'unknown';
  return result;
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
