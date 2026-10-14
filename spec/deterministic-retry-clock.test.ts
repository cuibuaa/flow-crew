import { describe, expect, it } from 'vitest';
import {
  createTechnicalRetryBudgetState,
  nextTechnicalRetryBudget,
  transitionTechnicalRetryBudget,
} from '../src/attempt-deadline.js';

describe('technical retry budgets', () => {
  it('doubles positive safe budgets and refuses overflow or exhaustion without a timeout', () => {
    expect(nextTechnicalRetryBudget(1)).toBe(2);
    expect(nextTechnicalRetryBudget(Math.floor(Number.MAX_SAFE_INTEGER / 2)))
      .toBe(Number.MAX_SAFE_INTEGER - 1);
    for (const budget of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => nextTechnicalRetryBudget(budget)).toThrow();
    }
    expect(() => transitionTechnicalRetryBudget(createTechnicalRetryBudgetState({ initialBudgetMs: 50 }),
      { type: 'retry_exhausted' })).toThrow(/preceding attempt_timed_out/);
  });

  it('grows each timeout retry and settles exhausted retries as timeouts', () => {
    const state = createTechnicalRetryBudgetState({ initialBudgetMs: 50 });
    for (const budgetMs of [50, 100]) {
      expect(transitionTechnicalRetryBudget(state, { type: 'prepare_attempt' }))
        .toMatchObject({ type: 'attempt_prepared', budgetMs });
      transitionTechnicalRetryBudget(state, { type: 'attempt_timed_out', effectiveBudgetMs: budgetMs });
    }
    expect(transitionTechnicalRetryBudget(state, { type: 'retry_exhausted' }))
      .toEqual({ type: 'terminal', terminalDecision: 'attempt_timeout' });
  });
});
