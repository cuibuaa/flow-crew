/**
 * Phase-0 safety net — Ledger primitive guard contract.
 *
 * Guard paths (no store fixtures needed): an absent/empty campaign yields 'none', so the planner
 * injection degrades cleanly. The cross-run aggregation (dedup of tried labels + dead-ends) is
 * smoke-validated against real campaign data during the refactor; this pins the safe-fallback
 * contract the injection relies on.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { summarizeLedger } from '../../src/campaign-ledger.js';

describe('Ledger primitive — summarizeLedger guards', () => {
  it('returns "none" when no campaign id is given', () => {
    expect(summarizeLedger('/tmp/does-not-matter', undefined)).toBe('none');
  });

  it('returns "none" for a campaign with no entries (clean fallback for the injection)', () => {
    const unknown = `fc-nonexistent-${randomBytes(6).toString('hex')}`;
    expect(summarizeLedger('/tmp/does-not-matter', unknown)).toBe('none');
  });
});
