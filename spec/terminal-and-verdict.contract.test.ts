import { describe, expect, it } from 'vitest';
import { isSuccessfulRunStatus } from '../src/store.js';

describe('isSuccessfulRunStatus — research ceiling/ship are successes (exit 0)', () => {
  it('treats complete, shipped, and ceiling_hit as success', () => {
    expect(isSuccessfulRunStatus('complete')).toBe(true);
    expect(isSuccessfulRunStatus('shipped')).toBe(true);
    expect(isSuccessfulRunStatus('ceiling_hit')).toBe(true); // honest negative is a valid deliverable
  });
  it('treats genuine non-successes as failures', () => {
    expect(isSuccessfulRunStatus('failed')).toBe(false);
    expect(isSuccessfulRunStatus('reality_gate_failed')).toBe(false);
    expect(isSuccessfulRunStatus('escalated')).toBe(false);
    expect(isSuccessfulRunStatus('cancelled')).toBe(false);
    expect(isSuccessfulRunStatus('running')).toBe(false);
  });
});
