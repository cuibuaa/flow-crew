/** The single owner of adapter input admission, before input capture or execution. */
import { refuseStageDuration, stageDurationLimit } from './stage-duration.js';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import type { Adapter, AgentConfig, RunOpts, RunResult } from './adapters/base.js';
import { loadEngineDefaults } from './config.js';
import { parseBriefFrontmatterDocument } from './brief-frontmatter.js';
import type { InputLimitRefusal } from './provider-result.js';

/** Space for sections added after inline evidence/review routing is selected. */
export const INPUT_RESERVE_CHARS = 65_536;

/** A run ceiling can only tighten the actual adapter's configured ceiling. */
export function adapterInputLimit(adapter?: Pick<Adapter, 'sessionKind'>, admittedLimit?: number): number {
  const limits = loadEngineDefaults().adapter_input_limit_chars;
  const configured = limits[adapter?.sessionKind as keyof typeof limits] ?? Math.min(...Object.values(limits));
  return Math.min(configured, admittedLimit ?? configured);
}

export class InputLimitDeclarationError extends Error {
  readonly code = 'input_limit_declaration';
  constructor(readonly declaredLimit: unknown, readonly engineLimit: number) {
    super(`input_limit_chars must be a positive integer at most the engine limit: declared ${inspect(declaredLimit, { depth: 1, customInspect: false })}, engine ${engineLimit}`);
  }
}

/** New admissions only. Resume reads the recorded ceiling, never reparses a brief. */
export function admitInputLimit(brief: string, engineLimit: number): number {
  const document = parseBriefFrontmatterDocument(brief);
  if (document?.error) throw new Error(document.error);
  const metadata = document?.value;
  if (!metadata || typeof metadata !== 'object' || !Object.hasOwn(metadata, 'input_limit_chars')) return engineLimit;
  const declared = (metadata as Record<string, unknown>).input_limit_chars;
  if (!Number.isSafeInteger(declared) || Number(declared) <= 0 || Number(declared) > engineLimit) {
    throw new InputLimitDeclarationError(declared, engineLimit);
  }
  return Number(declared);
}

/** UTF-16 characters, including the system instructions supplied with the user input. */
export function adapterInputLength(system: string, user: string): number { return system.length + user.length; }

export async function runAdapter(
  adapter: Adapter, prompt: string, role: AgentConfig, options: RunOpts,
  admittedLimit?: number, beforeSend?: () => void,
  duration?: { limit?: number; attemptBudgetMs?: number },
): Promise<RunResult> {
  const refusal = refuseStageDuration(duration?.attemptBudgetMs ?? options.timeout_ms, duration?.limit ?? stageDurationLimit());
  if (refusal) return refusal;
  const limit = adapterInputLimit(adapter, admittedLimit);
  const measuredLength = adapterInputLength(role.prompt, prompt);
  if (measuredLength > limit) {
    const reason = `Adapter input refused: ${measuredLength} characters exceeds limit ${limit}.`;
    const providerFailure: InputLimitRefusal = { kind: 'input_too_large', provider: 'engine', source: 'input_limit',
      eventType: 'input_limit', measuredLength, limit, reason,
      diagnosticSha256: createHash('sha256').update(reason).digest('hex') };
    return { output: '', exitCode: 1, duration_ms: 0, providerFailure, friendlyError: reason };
  }
  beforeSend?.();
  return adapter.run(prompt, role, options);
}
