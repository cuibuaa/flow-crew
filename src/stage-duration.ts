/** One numeric admission rule for stage attempts, independent of deadline timers. */
import { inspect } from 'node:util';
import { createHash } from 'node:crypto';
import { parseBriefFrontmatterDocument } from './brief-frontmatter.js';
import type { RunResult } from './adapters/base.js';

/** Only a recorded work declaration supplies an allowance; absence is unbounded. */
export function stageDurationLimit(recorded?: number): number | undefined { return recorded; }

export class StageDurationDeclarationError extends Error {
  readonly code = 'stage_duration_declaration';
  constructor(readonly declaredLimit: unknown) {
    super(`stage_duration_ms must be a positive safe integer: declared ${inspect(declaredLimit, { depth: 1, customInspect: false })}`);
  }
}

/** Only new admissions parse declarations. Existing runs retain their recorded number. */
export function admitStageDuration(brief: string): number | undefined {
  const document = parseBriefFrontmatterDocument(brief);
  if (document?.error) throw new Error(document.error);
  const metadata = document?.value;
  if (!metadata || typeof metadata !== 'object' || !Object.hasOwn(metadata, 'stage_duration_ms')) return undefined;
  const declared = (metadata as Record<string, unknown>).stage_duration_ms;
  if (!Number.isSafeInteger(declared) || Number(declared) <= 0)
    throw new StageDurationDeclarationError(declared);
  return Number(declared);
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
