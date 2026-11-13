/** One numeric admission rule for stage attempts, independent of deadline timers. */
import { createHash } from 'node:crypto';
import { parseBriefDeclarations } from './brief-declarations.js';
import type { RunResult } from './adapters/base.js';

/** Only a recorded work declaration supplies an allowance; absence is unbounded. */
export function stageDurationLimit(recorded?: number): number | undefined { return recorded; }

/** Only new admissions parse declarations. Existing runs retain their recorded number. */
export function admitStageDuration(brief: string): number | undefined {
  return parseBriefDeclarations(brief).stage_duration_ms;
}

/** The sole runtime comparison. Refuse before creating an attempt or invoking an adapter. */
export function refuseStageDuration(requestedBudgetMs: number | undefined, limit: number | undefined): RunResult | undefined {
  if (limit !== undefined && requestedBudgetMs !== undefined && requestedBudgetMs > limit) {
    const reason = `Stage duration refused: requested ${requestedBudgetMs} ms exceeds limit ${limit} ms.`;
    return { output: '', exitCode: 1, duration_ms: 0, friendlyError: reason,
      providerFailure: { kind: 'duration_limit', provider: 'engine', source: 'stage_duration', eventType: 'stage_duration',
        requestedBudgetMs, limit, reason, diagnosticSha256: createHash('sha256').update(reason).digest('hex') } };
  }
}
