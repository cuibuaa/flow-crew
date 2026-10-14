import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';


import { providerFailureFromEvent } from '../src/provider-result.js';

describe('independent provider attribution', () => {
  const refusal = 'This content was flagged for possible cybersecurity risk.';
  it('ignores native-looking diagnostics inside assistant/tool records', () => {
    const nested = { type: 'item.completed', item: { type: 'agent_message', text: refusal,
      error: { type: 'turn.failed', message: refusal } } };
    expect(providerFailureFromEvent('codex', nested)).toBeUndefined();
  });
  it('redacts display credentials while preserving the original terminal diagnostic hash', () => {
    const message = `${refusal} authorization=synthetic-only-token`;
    const result = providerFailureFromEvent('codex', { type: 'turn.failed', error: { message } });
    expect(result).toMatchObject({ kind: 'refusal', reason: `${refusal} authorization=[redacted]`,
      diagnosticSha256: createHash('sha256').update(message).digest('hex') });
  });
});
