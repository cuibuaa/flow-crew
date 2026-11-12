import { describe, expect, it } from 'vitest';
import {
  createTechnicalRetryBudgetState,
  transitionTechnicalRetryBudget,
} from '../src/attempt-deadline.js';

describe('technical retry budgets', () => {
  it('refuses invalid initial budgets or exhaustion without a timeout', () => {
    for (const budget of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => createTechnicalRetryBudgetState({ initialBudgetMs: budget })).toThrow();
    expect(() => transitionTechnicalRetryBudget(createTechnicalRetryBudgetState({ initialBudgetMs: 50 }),
      { type: 'retry_exhausted' })).toThrow(/preceding attempt_timed_out/);
  });

  it('retains the admitted budget on every timeout retry and settles exhausted retries as timeouts', () => {
    const state = createTechnicalRetryBudgetState({ initialBudgetMs: 50 });
    for (const budgetMs of Array(100).fill(50)) {
      expect(transitionTechnicalRetryBudget(state, { type: 'prepare_attempt' }))
        .toMatchObject({ type: 'attempt_prepared', budgetMs });
      transitionTechnicalRetryBudget(state, { type: 'attempt_timed_out', effectiveBudgetMs: budgetMs });
    }
    expect(transitionTechnicalRetryBudget(state, { type: 'retry_exhausted' }))
      .toEqual({ type: 'terminal', terminalDecision: 'attempt_timeout' });
  });
});
