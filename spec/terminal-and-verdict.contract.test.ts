/**
 * Phase-0 safety net — regression contracts for two bugs surfaced by the live
 * beat-derisk1230 validation run (2026-06-15):
 *
 *   1. The CLI exited non-zero for `ceiling_hit`/`shipped`, so a research run that
 *      honestly found no beat (a VALID deliverable) reported as "failed" — and the
 *      campaign outer loop's execSync would read every normal ceiling as a crash.
 *      Pinned by isSuccessfulRunStatus.
 *
 *   2. The gate verdict/metric.json consistency check re-rejected a closeout/ceiling
 *      audit (metric.pass=false because no beat, verdict.pass=true because the negative
 *      deliverable is valid) whenever the QA's metric.json omitted phase-completion
 *      metadata — even though the verdict itself carried it. This thrashed the loop for
 *      extra iterations. Pinned by validateVerdictAgainstMetricFile honoring the signal
 *      from EITHER file.
 */
import { describe, expect, it } from 'vitest';
import { isSuccessfulRunStatus } from '../src/store.js';
import { validateVerdictAgainstMetricFile } from '../src/scheduler.js';

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
    expect(isSuccessfulRunStatus('stopped')).toBe(false);
    expect(isSuccessfulRunStatus('running')).toBe(false);
  });
});

describe('validateVerdictAgainstMetricFile — closeout audit passes while beat-metric fails', () => {
  const failingBeatMetric = { pass: false, metric: 'forward_oos_calmar_5bps', value: 8.26, threshold: 15 };

  it('rejects a bare pass-over-fail with NO phase-completion signal anywhere', () => {
    const verdict = { pass: true, reason: 'looks good' };
    expect(validateVerdictAgainstMetricFile(verdict, failingBeatMetric))
      .toBe('verdict/metric.json mismatch: metric says fail, verdict says pass');
  });

  it('allows the pass when the metric.json carries phaseComplete (pre-existing escape hatch)', () => {
    const verdict = { pass: true };
    const metric = { ...failingBeatMetric, phaseComplete: true };
    expect(validateVerdictAgainstMetricFile(verdict, metric)).toBeNull();
  });

  it('allows the pass when only the VERDICT carries phaseComplete (the fix)', () => {
    const verdict = { pass: true, phaseComplete: true, nextPhase: 'operator_decision_or_closeout', metric: 'failing_checks' };
    expect(validateVerdictAgainstMetricFile(verdict, failingBeatMetric)).toBeNull();
  });

  it('allows the pass when only the VERDICT carries nextPhase (the fix)', () => {
    const verdict = { pass: true, nextPhase: 'operator_decision_or_closeout' };
    expect(validateVerdictAgainstMetricFile(verdict, failingBeatMetric)).toBeNull();
  });

  it('still passes a clean agreeing verdict (no false positive)', () => {
    const verdict = { pass: true, metric: 'forward_oos_calmar_5bps', threshold: 15 };
    const metric = { pass: true, metric: 'forward_oos_calmar_5bps', value: 16, threshold: 15 };
    expect(validateVerdictAgainstMetricFile(verdict, metric)).toBeNull();
  });
});
