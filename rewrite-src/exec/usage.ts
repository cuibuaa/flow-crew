import type { Ref } from '../contract/brief.js';
import type { Journal, Role, Usage } from '../contract/runtime.js';
import { readEvidence } from '../records/evidence.js';
import { protocolDecoder } from './transport.js';

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const cost = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Project observed native counters, choosing cumulative totals over message deltas. */
export async function readUsage(journal: Journal, backend: Role['backend'], raw: readonly Ref[]): Promise<Usage> {
  type Counters = Omit<Usage, 'raw' | 'state'>;
  const records: Counters[] = [];
  const messages = new Map<string, Counters>();
  let total: Counters | undefined;
  let observedCost: number | undefined;
  let corrupt = false;
  let terminal = false;
  let incomplete = false;
  const normalized = (value: unknown): Counters => {
    const u = object(value);
    if (backend === 'codex') return { input: count(u.input_tokens), output: count(u.output_tokens), cached: count(u.cached_input_tokens) };
    const fresh = count(u.input_tokens), read = count(u.cache_read_input_tokens), created = count(u.cache_creation_input_tokens);
    if (fresh === undefined || read === undefined || created === undefined) incomplete = true;
    const observed = [fresh, read, created].filter((n): n is number => n !== undefined);
    return { input: observed.length ? count(observed.reduce((sum, n) => sum + n, 0)) : undefined,
      output: count(u.output_tokens), cached: read };
  };
  // The caller supplies native stdout refs only; never scrape transcripts or credential homes.
  for (const ref of raw.filter((ref, i) => raw.findIndex(v => v.path === ref.path && v.sha256 === ref.sha256) === i)) {
    const bytes = await readEvidence(journal, ref);
    if (!bytes.ok) { corrupt = true; continue; }
    const decoder = protocolDecoder(event => {
      if (backend === 'claude' && event.parent_tool_use_id) return;
      if (backend === 'codex' && (event.type === 'turn.completed' || event.type === 'turn.failed')) {
        const native = normalized(event.usage);
        records.push(native); terminal = event.type === 'turn.completed';
        if (native.input === undefined || native.output === undefined) incomplete = true;
      }
      if (backend === 'claude' && event.type === 'assistant') {
        const message = object(event.message);
        if (typeof message.id === 'string') messages.set(message.id, normalized(message.usage));
      }
      if (backend === 'claude' && event.type === 'result') {
        incomplete = false; // Cumulative totals supersede incomplete message updates.
        const native = normalized(event.usage);
        if (Object.values(native).some(value => value !== undefined)) total = native;
        const reportedCost = cost(event.total_cost_usd);
        if (reportedCost !== undefined) observedCost = reportedCost;
        terminal = true;
      }
    });
    decoder.write(bytes.value);
    if (decoder.finish().malformed) corrupt = true;
  }
  const sum = (values: readonly Counters[]): Counters => {
    const result: { input?: number; output?: number; cached?: number; costUsd?: number } = {};
    for (const key of ['input', 'output', 'cached', 'costUsd'] as const) {
      const observed = values.map(value => value[key]).filter((n): n is number => n !== undefined);
      if (!observed.length) continue;
      const n = observed.reduce((sum, value) => sum + value, 0);
      const valid = key === 'costUsd' ? cost(n) : count(n);
      if (valid !== undefined) result[key] = valid;
    }
    return result;
  };
  const counters = backend === 'codex' ? sum(records) : total ?? sum([...messages.values()]);
  const present = Object.values(counters).some(v => v !== undefined) || observedCost !== undefined;
  const complete = counters.input !== undefined && counters.output !== undefined && !corrupt && !incomplete && terminal;
  return { ...counters, ...(observedCost !== undefined ? { costUsd: observedCost } : {}), state: complete ? 'known' : present ? 'partial' : 'unknown', raw };
}
