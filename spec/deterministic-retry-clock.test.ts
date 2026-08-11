import { describe, expect, it } from 'vitest';
import {
  TechnicalChainController,
  createTechnicalRetryBudgetState,
  transitionTechnicalRetryBudget,
  type TechnicalChainClock,
  type TechnicalRetryTerminalDecision,
} from '../src/technical-chain.js';

const EXPECTED_SEMANTIC = {
  expandable: { budgets: [50, 100], terminalDecision: 'soft_timeout' },
  capped: { budgets: [50], terminalDecision: 'hard_cap_exhausted' },
} as const;

type ShapeName = 'default_parallel' | 'single_worker' | 'cpu_load';
type SemanticResult = {
  budgets: number[];
  terminalDecision: TechnicalRetryTerminalDecision;
};

/**
 * The shape changes the deterministic event queue, not host CPU pressure or a
 * wall-clock deadline. Only a semantic event advances the injected clock;
 * queued/load events model scheduler work that must not consume retry budget.
 */
class SchedulingShapeClock implements TechnicalChainClock {
  private monotonicMs = 0;
  private wallMs = Date.parse('2026-01-01T00:00:00.000Z');
  private nextTimerId = 1;
  private readonly timers = new Map<number, { deadlineMs: number; callback: () => void }>();
  processedEvents = 0;

  monotonicNow(): number { return this.monotonicMs; }
  wallNow(): number { return this.wallMs; }

  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextTimerId++;
    this.timers.set(id, { deadlineMs: this.monotonicMs + Math.max(0, delayMs), callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimer(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advanceForShape(shape: ShapeName): void {
    const events = shape === 'default_parallel'
      ? ['semantic']
      : shape === 'single_worker'
        ? ['queued', 'semantic']
        : [...Array.from({ length: 64 }, () => 'load'), 'semantic'];
    for (const event of events) {
      this.processedEvents += 1;
      if (event === 'semantic') this.advance(1);
    }
  }

  advanceLegacyWallTime(elapsedMs: number): void {
    this.advance(elapsedMs);
  }

  private advance(elapsedMs: number): void {
    this.monotonicMs += elapsedMs;
    this.wallMs += elapsedMs;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.deadlineMs <= this.monotonicMs)
      .sort((left, right) => left[1].deadlineMs - right[1].deadlineMs);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
    }
  }
}

function scenario(
  totalMs: number,
  shape: ShapeName,
  legacyElapsedMs?: number,
): { result: SemanticResult; processedEvents: number } {
  const clock = new SchedulingShapeClock();
  const controller = new TechnicalChainController({
    initialBudgetMs: 50,
    hardTotalMs: totalMs,
    clock,
  });
  const retry = createTechnicalRetryBudgetState({ controller });
  const budgets: number[] = [];
  try {
    const first = transitionTechnicalRetryBudget(retry, { type: 'prepare_attempt' });
    if (first.type !== 'attempt_prepared') throw new Error('initial retry budget was not prepared');
    budgets.push(first.budgetMs);
    transitionTechnicalRetryBudget(retry, {
      type: 'attempt_timed_out',
      effectiveBudgetMs: first.budgetMs,
    });
    if (legacyElapsedMs === undefined) clock.advanceForShape(shape);
    else clock.advanceLegacyWallTime(legacyElapsedMs);

    const second = transitionTechnicalRetryBudget(retry, { type: 'prepare_attempt' });
    if (second.type === 'terminal') {
      return {
        result: { budgets, terminalDecision: second.terminalDecision },
        processedEvents: clock.processedEvents,
      };
    }
    if (second.type !== 'attempt_prepared') throw new Error('retry budget transition did not decide');
    budgets.push(second.budgetMs);
    transitionTechnicalRetryBudget(retry, {
      type: 'attempt_timed_out',
      effectiveBudgetMs: second.budgetMs,
    });
    clock.advanceForShape(shape);
    const terminal = transitionTechnicalRetryBudget(retry, { type: 'retry_exhausted' });
    if (terminal.type !== 'terminal') throw new Error('retry exhaustion was not terminal');
    return {
      result: { budgets, terminalDecision: terminal.terminalDecision },
      processedEvents: clock.processedEvents,
    };
  } finally {
    controller.dispose();
  }
}

// This matrix runs entirely in-process, so there is no subprocess exit status
// to assert. Semantics and the legacy counterexample are the contract;
// processed event counts remain diagnostic evidence only.
function runShape(shape: ShapeName) {
  const expandable = scenario(150, shape);
  const capped = scenario(50, shape);
  const legacy = scenario(150, shape, 125).result;
  return {
    semantic: {
      expandable: expandable.result,
      capped: capped.result,
    },
    processedEvents: expandable.processedEvents + capped.processedEvents,
    legacyCounterexampleKilled: legacy.budgets.length === 1
      && legacy.terminalDecision === 'hard_cap_exhausted',
  };
}

describe('scheduling-shape retry matrix', () => {
  it('produces the same semantic sequence and terminal decision in every shape', () => {
    const evidence: Record<ShapeName, ReturnType<typeof runShape>> = {
      default_parallel: runShape('default_parallel'),
      single_worker: runShape('single_worker'),
      cpu_load: runShape('cpu_load'),
    };

    const semanticSequences = Object.values(evidence).map(({ semantic }) => semantic);
    expect(new Set(semanticSequences.map((semantic) => JSON.stringify(semantic))).size).toBe(1);
    expect(semanticSequences[0]).toEqual(EXPECTED_SEMANTIC);
    for (const shape of Object.keys(evidence) as ShapeName[]) {
      expect(evidence[shape].legacyCounterexampleKilled, `${shape} legacy counterexample`).toBe(true);
    }
    process.stdout.write(`M4_MATRIX_EVIDENCE=${JSON.stringify(evidence)}\n`);
    process.stdout.write('C-M4-oracle-stock=0 family=E9-50ms-retry\n');
  });
});
