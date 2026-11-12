import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { classifyAdapterFailure, type ProviderFailureKind } from './adapters/failure.js';

/** An adapter-owned terminal diagnostic, never an assistant or tool message. */
export interface ProviderTerminalDiagnostic {
  provider: 'codex' | 'claude';
  eventType: 'error' | 'turn.failed' | 'result' | 'cli_diagnostic';
  message: string;
  code?: unknown;
  resetAt?: unknown;
}

export interface NativeProviderFailure {
  kind: ProviderFailureKind;
  /** Provider-owned reset instant; never extracted from diagnostic prose. */
  resetAt?: string;
  provider: ProviderTerminalDiagnostic['provider'];
  source: 'native_stdout' | 'cli_diagnostic';
  eventType: ProviderTerminalDiagnostic['eventType'];
  /** Bounded, credential-redacted diagnostic for readers and supervision. */
  reason: string;
  /** Hash of the original diagnostic; bounding/redaction does not change identity. */
  diagnosticSha256: string;
}

/** Engine refusal shares the existing non-replayable size-failure policy. */
export interface InputLimitRefusal {
  kind: 'input_too_large';
  provider: 'engine';
  source: 'input_limit';
  eventType: 'input_limit';
  measuredLength: number;
  limit: number;
  reason: string;
  diagnosticSha256: string;
  resetAt?: never;
}
export type ProviderFailure = NativeProviderFailure | InputLimitRefusal;

export function nativeDiagnostic(event: Record<string, any>): string | undefined {
  const primary = [event.message, typeof event.error === 'string' ? event.error : event.error?.message, event.item?.message]
    .find(value => typeof value === 'string');
  if (primary !== undefined) return primary.trim() || undefined;
  const errors = Array.isArray(event.errors) ? event.errors.map((error: any) => typeof error === 'string' ? error : error?.message) : [];
  const diagnostic = errors.filter((value): value is string => typeof value === 'string' && !!value.trim()).join('\n');
  return diagnostic || (event.type === 'result' && typeof event.result === 'string' ? event.result.trim() || undefined : undefined);
}

/** Bound and redact diagnostics independently of their retry classification. */
export function providerDiagnosticReason(message: string): string {
  const reason = stripVTControlCharacters(message)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|password|authorization)\s*[:=]\s*)[^\s&,;]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .trim();
  return reason.length > 2048 ? `${reason.slice(0, 2033)}... [truncated]` : reason;
}

/** Only classified evidence selects a provider-specific recovery policy. */
export function providerFailureFromDiagnostic(diagnostic: ProviderTerminalDiagnostic): ProviderFailure | undefined {
  const resetMs = typeof diagnostic.resetAt === 'number' ? diagnostic.resetAt * 1000
    : typeof diagnostic.resetAt === 'string' ? Date.parse(diagnostic.resetAt) : NaN;
  const resetAt = Number.isFinite(resetMs) && resetMs > 0 && resetMs <= 8.64e15 ? new Date(resetMs).toISOString() : undefined;
  const quota = ['usage_limit_reached', 'quota_exceeded'].includes(String(diagnostic.code)) && resetAt;
  const kind = quota ? 'quota' : classifyAdapterFailure(diagnostic.message, diagnostic.code);
  if (!kind) return undefined;
  return {
    kind, ...(quota ? { resetAt } : {}), provider: diagnostic.provider, source: diagnostic.eventType === 'cli_diagnostic' ? 'cli_diagnostic' : 'native_stdout', eventType: diagnostic.eventType,
    reason: providerDiagnosticReason(diagnostic.message),
    diagnosticSha256: createHash('sha256').update(diagnostic.message).digest('hex'),
  };
}

/** Read root event diagnostics only. Nested tool/probe output is not authority. */
export function providerFailureFromEvent(provider: ProviderTerminalDiagnostic['provider'], value: unknown): ProviderFailure | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as Record<string, unknown>;
  const type = event.type;
  if (type !== 'error' && !(provider === 'codex' && type === 'turn.failed')
    && !(provider === 'claude' && type === 'result' && (event.is_error === true || typeof event.subtype === 'string' && event.subtype.startsWith('error')))) return undefined;
  const error = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : undefined;
  // Quota and typed authentication cannot recover through an HTTP retry.
  // Other native types retain their position after nested HTTP, before wrappers.
  const nativeKind = classifyAdapterFailure('', error?.type);
  const priorityType = ['usage_limit_reached', 'quota_exceeded'].includes(String(error?.type))
    || nativeKind === 'authentication' ? error?.type : undefined;
  return providerFailureFromDiagnostic({ provider, eventType: type as ProviderTerminalDiagnostic['eventType'],
    message: nativeDiagnostic(event) ?? String(event.subtype ?? type),
    resetAt: error?.reset_at ?? event.reset_at ?? (error?.data as Record<string, unknown> | undefined)?.reset_at,
    code: (error?.data as Record<string, unknown> | undefined)?.input_error_code ?? error?.code ?? priorityType
      ?? error?.status_code ?? error?.status ?? (nativeKind ? error?.type : undefined) ?? event.code ?? event.status_code ?? event.status ?? error?.type });
}

/** Keep the observed exit beside its provider-owned cause. */
export function providerFailureDetail(exitCode: number, failure: ProviderFailure): string {
  return `Exit code ${exitCode} — ${failure.provider} provider ${failure.kind} (${failure.eventType}): ${failure.reason}`;
}
