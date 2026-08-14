import { describe, expect, it } from 'vitest';
import {
  createTechnicalRetryBudgetState,
  transitionTechnicalRetryBudget,
  type TechnicalRetryTerminalDecision,
} from '../src/attempt-deadline.js';

const EXPECTED_SEMANTIC = {
  budgets: [50, 100],
  terminalDecision: 'attempt_timeout',
} as const;

type ShapeName = 'default_parallel' | 'single_worker' | 'cpu_load';
type SemanticResult = {
  budgets: number[];
  terminalDecision: TechnicalRetryTerminalDecision;
};

function applySchedulingShape(shape: ShapeName): number {
  const events = shape === 'default_parallel'
    ? ['semantic']
    : shape === 'single_worker'
      ? ['queued', 'semantic']
      : [...Array.from({ length: 64 }, () => 'load'), 'semantic'];
  return events.length;
}

function scenario(shape: ShapeName): { result: SemanticResult; processedEvents: number } {
  const retry = createTechnicalRetryBudgetState({ initialBudgetMs: 50 });
  const budgets: number[] = [];
  const first = transitionTechnicalRetryBudget(retry, { type: 'prepare_attempt' });
  if (first.type !== 'attempt_prepared') throw new Error('initial retry budget was not prepared');
  budgets.push(first.budgetMs);
  transitionTechnicalRetryBudget(retry, {
    type: 'attempt_timed_out',
    effectiveBudgetMs: first.budgetMs,
  });

  let processedEvents = applySchedulingShape(shape);
  const second = transitionTechnicalRetryBudget(retry, { type: 'prepare_attempt' });
  if (second.type !== 'attempt_prepared') throw new Error('timeout retry budget was not prepared');
  budgets.push(second.budgetMs);
  transitionTechnicalRetryBudget(retry, {
    type: 'attempt_timed_out',
    effectiveBudgetMs: second.budgetMs,
  });
  processedEvents += applySchedulingShape(shape);
  const terminal = transitionTechnicalRetryBudget(retry, { type: 'retry_exhausted' });
  if (terminal.type !== 'terminal') throw new Error('retry exhaustion was not terminal');
  return {
    result: { budgets, terminalDecision: terminal.terminalDecision },
    processedEvents,
  };
}

describe('scheduling-shape retry matrix', () => {
  it('always prepares a strictly larger timeout retry without an aggregate balance', () => {
    const evidence: Record<ShapeName, ReturnType<typeof scenario>> = {
      default_parallel: scenario('default_parallel'),
      single_worker: scenario('single_worker'),
      cpu_load: scenario('cpu_load'),
    };

    for (const shape of Object.keys(evidence) as ShapeName[]) {
      expect(evidence[shape].result).toEqual(EXPECTED_SEMANTIC);
    }
    expect(new Set(Object.values(evidence).map(({ result }) => JSON.stringify(result))).size).toBe(1);
    process.stdout.write(`SINGLE_TIMEOUT_RETRY_MATRIX=${JSON.stringify(evidence)}\n`);
  });
});
