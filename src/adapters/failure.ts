/** `input_too_large`: the provider refused the input by size; the same input fails again, so it is never replayed. */
export type ProviderFailureKind = 'refusal' | 'authentication' | 'transient' | 'input_too_large';

/** A CLI that prints its error as `... (code N), data: {json}` carries the provider's reason code in that object. */
export function diagnosticDataCode(diagnostic: string): unknown {
  const at = diagnostic.lastIndexOf(', data: {');
  if (at < 0) return undefined;
  try { return JSON.parse(diagnostic.slice(at + 8).trim().split('\n')[0])?.input_error_code; } catch { return undefined; }
}

/** Text is fallback evidence only when the provider supplies no error code. */
export function classifyAdapterFailure(diagnostic: string, code?: unknown): ProviderFailureKind | undefined {
  if (diagnosticDataCode(diagnostic) === 'input_too_large') return 'input_too_large';
  if (code !== undefined && code !== null) {
    if ([401, '401', 'authentication', 'authentication_error', 'invalid_api_key', 'unauthorized'].includes(code as string)) return 'authentication';
    if (code === 'input_too_large') return 'input_too_large';
    if (['refusal', 'content_policy_violation', 'safety_violation'].includes(String(code))) return 'refusal';
    // Provider error types and HTTP status codes: only known temporary failures replay.
    if (/^(?:429|5\d{2})$/.test(String(code)) || ['overloaded_error', 'rate_limit_error', 'api_error', 'timeout', 'timeout_error',
      'server_error', 'service_unavailable_error', 'server_is_overloaded', 'rate_limit_exceeded', 'slow_down'].includes(String(code))) return 'transient';
    return undefined;
  }
  if (/\b(?:not logged in|unauthorized|authentication[ _-](?:error|failed|failure|required)|invalid[ _-](?:api[ _-])?(?:key|token)|401)\b/i.test(diagnostic)) return 'authentication';
  if (/^This content was flagged for possible cybersecurity risk\./.test(diagnostic.trim())) return 'refusal';
  if (/workspace routing discovery failed|403 Forbidden|connection refused|ECONNREFUSED|ECONNRESET|connection reset|rate limit|429 Too Many|ETIMEDOUT|502 Bad Gateway|503 Service Unavailable|overloaded|(?:selected\s+)?model\s+is\s+at\s+capacity/i.test(diagnostic)) return 'transient';
  return undefined;
}

/** Operator intervention and provider refusals cannot recover by replay. */
export function isRetryableAdapterFailure(kind: ProviderFailureKind | undefined): boolean {
  return kind !== 'authentication' && kind !== 'refusal' && kind !== 'input_too_large';
}
