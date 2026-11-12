/** One numeric admission rule for stage attempts, independent of deadline timers. */
import { inspect } from 'node:util';
import { createHash } from 'node:crypto';
import { loadEngineDefaults } from './config.js';
import { parseBriefFrontmatterDocument } from './brief-frontmatter.js';
import type { RunResult } from './adapters/base.js';

/** Historical records have no number; resume adopts the installed engine number. */
export function stageDurationLimit(recorded?: number): number {
  return recorded ?? loadEngineDefaults().default_timeout_ms;
}

export class StageDurationDeclarationError extends Error {
  readonly code = 'stage_duration_declaration';
  constructor(readonly declaredLimit: unknown, readonly engineLimit: number) {
    super(`stage_duration_ms must be a positive safe integer at most the engine limit: declared ${inspect(declaredLimit, { depth: 1, customInspect: false })}, engine ${engineLimit}`);
  }
}

/** Only new admissions parse declarations. Existing runs retain their recorded number. */
export function admitStageDuration(brief: string, engineLimit = stageDurationLimit()): number {
  const document = parseBriefFrontmatterDocument(brief);
  if (document?.error) throw new Error(document.error);
  const metadata = document?.value;
  if (!metadata || typeof metadata !== 'object' || !Object.hasOwn(metadata, 'stage_duration_ms')) return engineLimit;
  const declared = (metadata as Record<string, unknown>).stage_duration_ms;
  if (!Number.isSafeInteger(declared) || Number(declared) <= 0 || Number(declared) > engineLimit)
    throw new StageDurationDeclarationError(declared, engineLimit);
  return Number(declared);
}

/** The sole runtime comparison. Refuse before creating an attempt or invoking an adapter. */
export function refuseStageDuration(requestedBudgetMs: number, limit: number): RunResult | undefined {
  if (requestedBudgetMs > limit) {
    const reason = `Stage duration refused: requested ${requestedBudgetMs} ms exceeds limit ${limit} ms.`;
    return { output: '', exitCode: 1, duration_ms: 0, friendlyError: reason,
      providerFailure: { kind: 'duration_limit', provider: 'engine', source: 'stage_duration', eventType: 'stage_duration',
        requestedBudgetMs, limit, reason, diagnosticSha256: createHash('sha256').update(reason).digest('hex') } };
  }
}
