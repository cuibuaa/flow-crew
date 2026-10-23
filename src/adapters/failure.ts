export type ProviderFailureKind = 'refusal' | 'authentication' | 'transient';

/** Text is fallback evidence only when the provider supplies no error code. */
export function classifyAdapterFailure(diagnostic: string, code?: unknown): ProviderFailureKind | undefined {
  if (code !== undefined && code !== null) {
    if ([401, '401', 'authentication', 'authentication_error', 'invalid_api_key', 'unauthorized'].includes(code as string)) return 'authentication';
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
  return kind !== 'authentication' && kind !== 'refusal';
}
