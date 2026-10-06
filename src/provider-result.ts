import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

/** An adapter-owned terminal diagnostic, never an assistant or tool message. */
export type ProviderTerminalDiagnostic =
  | { provider: 'codex'; eventType: 'error' | 'turn.failed'; message: string }
  | { provider: 'claude'; eventType: 'error' | 'result'; message: string };

export interface ProviderFailure {
  kind: 'refusal';
  provider: ProviderTerminalDiagnostic['provider'];
  source: 'native_stdout';
  eventType: ProviderTerminalDiagnostic['eventType'];
  /** Bounded, credential-redacted diagnostic for readers and supervision. */
  reason: string;
  /** Hash of the original diagnostic; bounding/redaction does not change identity. */
  diagnosticSha256: string;
}

/** Recognise the recorded refusal family only at the native provider boundary.
 * Unknown wording remains an ordinary failure; transport recovery is separate. */
export function providerRefusal(diagnostic: ProviderTerminalDiagnostic): ProviderFailure | undefined {
  if (!/^This content was flagged for possible cybersecurity risk\./.test(diagnostic.message.trim())) return undefined;
  const reason = stripVTControlCharacters(diagnostic.message)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|password|authorization)\s*[:=]\s*)[^\s&,;]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .trim();
  return {
    kind: 'refusal', provider: diagnostic.provider, source: 'native_stdout', eventType: diagnostic.eventType,
    reason: reason.length > 2048 ? `${reason.slice(0, 2033)}... [truncated]` : reason,
    diagnosticSha256: createHash('sha256').update(diagnostic.message).digest('hex'),
  };
}

/** Read root event diagnostics only. Nested tool/probe output is not authority. */
export function providerFailureFromEvent(provider: ProviderFailure['provider'], value: unknown): ProviderFailure | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as Record<string, unknown>;
  const type = event.type;
  if (type !== 'error' && !(provider === 'codex' && type === 'turn.failed')
    && !(provider === 'claude' && type === 'result' && (event.is_error === true || event.subtype === 'error'))) return undefined;
  const error = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : undefined;
  const message = typeof event.message === 'string' ? event.message
    : typeof event.error === 'string' ? event.error
      : typeof error?.message === 'string' ? error.message
        : provider === 'claude' && type === 'result' && typeof event.result === 'string' ? event.result : undefined;
  if (!message) return undefined;
  if (provider === 'codex' && (type === 'error' || type === 'turn.failed')) {
    return providerRefusal({ provider, eventType: type, message });
  }
  if (provider === 'claude' && (type === 'error' || type === 'result')) {
    return providerRefusal({ provider, eventType: type, message });
  }
  return undefined;
}

/** Keep the observed exit beside its provider-owned cause. */
export function providerFailureDetail(exitCode: number, failure: ProviderFailure): string {
  return `Exit code ${exitCode} — ${failure.provider} provider refusal (${failure.eventType}): ${failure.reason}`;
}
