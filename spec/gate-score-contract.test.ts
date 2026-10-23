import { describe, expect, it } from 'vitest';
import { validateVerdictAgainstContract } from '../src/scheduler/sched_settlement/gate-contract.js';

const contract = { metric: 'quality', metricSynonyms: ['audit_quality'], threshold: 7 };
describe('binding gate scores', () => {
  it.each([
    [{ pass: true, metric: 'quality', value: 7, threshold: 7 }, null],
    [{ pass: true, metric: 'audit_quality', score: 8, threshold: 8 }, null],
    [{ pass: true, metric: 'other', score: 8 }, 'does not match contract.metric'],
    [{ pass: true, metric: 'quality', score: 6 }, 'does not satisfy contract'],
    [{ pass: true, metric: 'quality', score: Infinity }, 'finite numeric'],
    [{ pass: true, metric: 'quality' }, 'missing required numeric'],
    [{ pass: false, reason: 'No usable measurement was produced.' }, null],
  ])('checks the declared quantity and finite threshold mechanically: %j', (verdict, reason) => {
    const violation = validateVerdictAgainstContract(verdict, null, contract, 'gate');
    if (reason === null) expect(violation).toBeNull();
    else expect(violation?.reason).toContain(reason);
  });
  it('preserves lower-is-better thresholds and gate-specific applicability', () => {
    const lower = { metric: 'errors', threshold: 2, higherIsBetter: false, appliesToGates: ['audit'] };
    expect(validateVerdictAgainstContract({ pass: true, metric: 'errors', score: 3 }, null, lower, 'audit')?.reason).toContain('does not satisfy');
    expect(validateVerdictAgainstContract({ pass: true }, null, lower, 'other')).toBeNull();
  });

});
