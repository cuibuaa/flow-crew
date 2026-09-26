import type { AdapterFailureKind } from './base.js';

export const ADAPTER_FAILURE_PATTERNS: ReadonlyArray<{
  kind: AdapterFailureKind;
  pattern: RegExp;
}> = [
  { kind: 'forbidden', pattern: /403 Forbidden/i },
  { kind: 'connection_refused', pattern: /connection refused|ECONNREFUSED/i },
  { kind: 'connection_reset', pattern: /ECONNRESET|connection reset/i },
  { kind: 'rate_limited', pattern: /rate limit|429 Too Many/i },
  { kind: 'transport_timeout', pattern: /ETIMEDOUT/i },
  { kind: 'bad_gateway', pattern: /502 Bad Gateway/i },
  { kind: 'service_unavailable', pattern: /503 Service Unavailable/i },
  { kind: 'overloaded', pattern: /overloaded/i },
  { kind: 'capacity', pattern: /(?:selected\s+)?model\s+is\s+at\s+capacity/i },
];

/** Classify adapter-owned diagnostics only. A stage's final message is not evidence. */
export function classifyAdapterFailure(diagnostic: string): AdapterFailureKind | undefined {
  const tail = diagnostic.length > 2048 ? diagnostic.slice(-2048) : diagnostic;
  return ADAPTER_FAILURE_PATTERNS.find(({ pattern }) => pattern.test(tail))?.kind;
}
