import { describe, expect, it } from 'vitest';
import { validateVerdictAgainstMetricFile } from '../src/scheduler.js';

/**
 * The metric-name branch of this guard had no tests. Every existing case sets
 * `metric.pass === false`, which returns at the first branch and never reaches
 * the name comparison — so the combination that actually breaks a run was never
 * constructed: verdict.pass=true, metric.json NOT reporting failure, names
 * differing.
 *
 * Observed cost: a gate wrote `verdict.metric = "failing_checks"` (its own
 * health metric, 0 checks failing) beside `metric.json.metric =
 * "max_abs_train_spearman_to_vanilla_momentum"` (the domain metric its brief
 * asked it to report). Both files agreed the gate passed. The engine rejected
 * every one of the four audits for the naming difference alone, making the gate
 * unpassable regardless of the work; the run escaped only when the repair budget
 * ran out, after ~2.5h of repair rounds that had nothing to repair.
 *
 * The rename is evidence of self-deception only when there is a failure for it
 * to hide, so both directions are asserted: it must stay silent when the metric
 * file reports no failure, and must still fire when a rename could mask one.
 */

const DOMAIN = 'max_abs_train_spearman_to_vanilla_momentum';
const GATE_HEALTH = 'failing_checks';

describe('validateVerdictAgainstMetricFile — metric name differences', () => {
  it('accepts differing names when the metric file reports no failure — the regression', () => {
    const verdict = { pass: true, metric: GATE_HEALTH, threshold: 0 };
    const metric = { pass: true, metric: DOMAIN, value: 0.5597562228772136 };

    expect(validateVerdictAgainstMetricFile(verdict, metric)).toBeNull();
  });

  it('accepts differing names when the metric file carries no pass and no threshold', () => {
    const verdict = { pass: true, metric: GATE_HEALTH };
    const metric = { metric: DOMAIN, value: 0.3368457558559925 };

    expect(validateVerdictAgainstMetricFile(verdict, metric)).toBeNull();
  });

  it('accepts differing names when the numeric metric satisfies its own threshold', () => {
    const verdict = { pass: true, metric: GATE_HEALTH };
    const metric = { metric: DOMAIN, value: 20, threshold: 15 };

    expect(validateVerdictAgainstMetricFile(verdict, metric)).toBeNull();
  });

  it('still rejects a rename when the numeric metric misses its threshold', () => {
    // This is the case the guard exists for: the domain metric failed, and the
    // verdict reports a different, passing metric instead.
    const verdict = { pass: true, metric: GATE_HEALTH };
    const metric = { metric: 'forward_oos_calmar_5bps', value: 8.26, threshold: 15 };

    const violation = validateVerdictAgainstMetricFile(verdict, metric);
    expect(violation).toContain('metric name redefined');
  });

  it('still rejects a rename when the metric misses a lower-is-better threshold', () => {
    const verdict = { pass: true, metric: GATE_HEALTH };
    const metric = { metric: 'tracking_error', value: 9, threshold: 5, higherIsBetter: false };

    expect(validateVerdictAgainstMetricFile(verdict, metric)).toContain('metric name redefined');
  });

  it('names both sides in the violation, so the clash is diagnosable from the message alone', () => {
    const verdict = { pass: true, metric: GATE_HEALTH };
    const metric = { metric: 'forward_oos_calmar_5bps', value: 8.26, threshold: 15 };

    const violation = validateVerdictAgainstMetricFile(verdict, metric) ?? '';
    expect(violation).toContain('forward_oos_calmar_5bps');
    expect(violation).toContain(GATE_HEALTH);
  });

  it('leaves the pre-existing metric-says-fail branch untouched', () => {
    const verdict = { pass: true, reason: 'looks good' };
    const metric = { pass: false, metric: 'forward_oos_calmar_5bps', value: 8.26, threshold: 15 };

    expect(validateVerdictAgainstMetricFile(verdict, metric))
      .toBe('verdict/metric.json mismatch: metric says fail, verdict says pass');
  });

  it('leaves the phase-completion escape hatch untouched', () => {
    const verdict = { pass: true, phaseComplete: true, metric: GATE_HEALTH };
    const metric = { pass: false, metric: 'forward_oos_calmar_5bps', value: 8.26, threshold: 15 };

    expect(validateVerdictAgainstMetricFile(verdict, metric)).toBeNull();
  });

  it('leaves threshold-downgrade detection untouched', () => {
    const verdict = { pass: true, metric: DOMAIN, threshold: 5 };
    const metric = { metric: DOMAIN, threshold: 15 };

    expect(validateVerdictAgainstMetricFile(verdict, metric)).toBe('threshold downgraded');
  });
});
