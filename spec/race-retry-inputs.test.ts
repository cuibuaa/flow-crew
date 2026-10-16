import './test-support/policy-runtime.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { drainDueTimers } from './test-support/engine-fixtures.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { Adapter } from '../src/adapters/base.js';
import type { AttemptDeadlineClock } from '../src/attempt-deadline.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { appendGuidanceEnvelope } from '../src/guidance.js';
import { loadDefaults, parseDispatchedStageConfig, WorkflowConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { runWorkflow } from '../src/scheduler/sched_loop/run-workflow.js';
import { readStageStatus, runDir } from '../src/store.js';

const agentsDir = join(import.meta.dirname, '../config/agents');
const brief = '# Deliver an answer\n\n## Acceptance criteria\n1. answer.txt contains the new answer.\n';
const criterion = extractBriefCriteria(brief).criteria[0].id;
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'flowcrew-race-retry-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

class ManualAttemptDeadlineClock implements AttemptDeadlineClock {
  private elapsedMs = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { deadlineMs: number; callback: () => void }>();

  monotonicNow(): number { return this.elapsedMs; }
  wallNow(): number { return Date.parse('2030-01-01T00:00:00.000Z') + this.elapsedMs; }
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextTimerId++;
    this.timers.set(id, { deadlineMs: this.elapsedMs + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimer(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }
  advance(elapsedMs: number): void {
    this.elapsedMs += elapsedMs;
    drainDueTimers(this.timers, this.elapsedMs);
  }
}

async function retryFixture(timeout = false) {
  const clock = new ManualAttemptDeadlineClock();
  const project = join(directory, 'project'); mkdirSync(project);
  setEngineDefaults({ stage_technical_retries: timeout ? 1 : 0, gate_retry_loops: 0, ...(timeout ? { timeout_ms: 1800 } : {}) });
  expect(loadDefaults()).toMatchObject({ stage_technical_retries: timeout ? 1 : 0, gate_retry_loops: 0, ...(timeout ? { timeout_ms: 1800 } : {}) });
  writeFileSync(join(project, 'answer.txt'), 'old answer\n');
  isolatedProjectCommand('git', ['init', '-q'], project, directory);
  isolatedProjectCommand('git', ['add', '.'], project, directory);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Input'], project, directory);
  const workflow = WorkflowConfigSchema.parse({ name: 'race_retry', defaults: { max_iterations: 1, max_retries: 1 }, stages: [
    parseDispatchedStageConfig({ id: 'prepare', role: 'coder', scope: [] }),
    parseDispatchedStageConfig({ id: 'work', role: 'coder', depends_on: ['prepare'], scope: ['answer.txt'], race: true, criterion_refs: [criterion] }),
    parseDispatchedStageConfig({ id: 'review', role: 'qa', depends_on: ['work'], is_gate: true, scope: [], criterion_refs: [criterion] }),
    parseDispatchedStageConfig({ id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['answer.txt'] }),
  ] });
  let parentRunDir = '';
  const authors: Array<{ parentAttempt: number; childAttempt: number | undefined; prompt: string; priorOutput?: string }> = [];
  const reviews: string[] = [];
  const record = (summary: string) => JSON.stringify({ status: 'delivered', summary, checks: [], caveats: [] });
  const adapter: Adapter = { async run(prompt, _role, opts) {
    if (opts.stageId === '_summary') return { output: 'Summary.', exitCode: 0, duration_ms: 0 };
    if (opts.stageId === 'prepare') {
      parentRunDir = opts.runDir;
      appendGuidanceEnvelope({ runDir: parentRunDir, target: 'work', source: 'scheduler', attemptIndex: 1,
        body: '# Accepted scope revision\nObsolete first execution notice.', knownStageIds: ['work'] });
      appendGuidanceEnvelope({ runDir: parentRunDir, target: 'work', source: 'operator', attemptIndex: 2,
        body: 'Current retry ruling: use the new answer.', knownStageIds: ['work'] });
      appendGuidanceEnvelope({ runDir: parentRunDir, target: 'work', source: 'operator', attemptIndex: 2,
        body: 'Criterion 1 ruling: inspect the literal contents of answer.txt.', knownStageIds: ['work'], criterionIds: [criterion] });
      return { output: record('Prepared the retry inputs.'), exitCode: 0, duration_ms: 0 };
    }
    if (opts.stageId === 'work') {
      const parentAttempt = JSON.parse(readFileSync(join(parentRunDir, 'stages/work/status.json'), 'utf8')).attempts.at(-1).index;
      const path = join(opts.runDir, 'stages/work/output.md');
      authors.push({ parentAttempt, childAttempt: opts.attemptIndex, prompt,
        priorOutput: existsSync(path) ? readFileSync(path, 'utf8') : undefined });
      if (parentAttempt === 1) {
        if (timeout) await new Promise<void>(resolve => {
          if (opts.abortSignal?.aborted) resolve();
          else opts.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
          // Expire the parent and active candidate together; retries start afresh.
          clock.advance(1800);
        });
        return { output: 'Author could not finish the first execution.', exitCode: 1, duration_ms: 0 };
      }
      writeFileSync(join(opts.workDir, 'answer.txt'), 'new answer\n');
      return { output: record('Delivered the answer after checking prior execution evidence.'), exitCode: 0, duration_ms: 0,
        writes: ['answer.txt'], writeAttribution: 'structured' };
    }
    reviews.push(prompt);
    return { output: JSON.stringify({ pass: true, reason: 'The new answer was inspected.', criteria: { [criterion]: { status: 'pass', evidence: 'answer.txt contains new answer.' } },
      audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 0 };
  } };
  const state = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, agentsDir, undefined, brief, false, undefined, false,
    undefined, () => clock);
  return { state, authors, reviews, parentStatus: readStageStatus(project, state.runId, 'work'), parentRunDir: runDir(project, state.runId) };
}

describe('fresh race candidates after a parent stage retry', () => {
  it('carries readable failed-author evidence and its cause without inheriting the execution ledger', async () => {
    const { state, authors, parentStatus, parentRunDir } = await retryFixture();
    expect(state.status, state.failureReason).toBe('complete');
    expect(parentStatus.attempts).toHaveLength(2);
    const retries = authors.filter(author => author.parentAttempt === 2);
    expect(retries).toHaveLength(1);
    for (const author of retries) {
      expect(author.childAttempt).toBe(1);
      expect(author.priorOutput).toContain('A: Workflow iteration budget exhausted');
      expect(author.priorOutput).toContain('B: Workflow iteration budget exhausted');
      expect(author.prompt).toContain('RETRY (attempt 2)');
      expect(author.prompt).toContain('Previous execution failed');
      expect(author.prompt).not.toContain('Previous attempt timed out');
      expect(author.prompt).not.toContain(parentRunDir);
      expect(author.prompt.match(/# Stage result/g)).toHaveLength(1);
    }
  });

  it('delivers current parent guidance without rebinding obsolete notices to the fresh child attempt', async () => {
    const { state, authors, reviews } = await retryFixture();
    expect(state.status, state.failureReason).toBe('complete');
    for (const author of authors.filter(author => author.parentAttempt === 2)) {
      expect(author.prompt).toContain('Current retry ruling: use the new answer.');
      expect(author.prompt).not.toContain('Obsolete first execution notice.');
      expect(author.prompt.match(/Current retry ruling: use the new answer\./g)).toHaveLength(1);
    }
    expect(reviews).toHaveLength(1);
    for (const prompt of reviews) {
      expect(prompt).toContain('Operator criterion rulings (binding reasoning context)');
      expect(prompt).toContain('Criterion 1 ruling: inspect the literal contents of answer.txt.');
    }
  });

  it('preserves the parent timeout retry context while giving children fresh execution clocks', async () => {
    const { state, authors, parentStatus } = await retryFixture(true);
    expect(state.status, state.failureReason).toBe('complete');
    expect(parentStatus.attempts).toHaveLength(2);
    expect(parentStatus.attempts?.map(attempt => attempt.timeout?.budgetMs)).toEqual([1800, 3600]);
    expect(parentStatus.attempts?.[0].timeout).toMatchObject({ terminationCause: 'attempt_timeout', elapsedMs: 1800, remainingMs: 0 });
    expect(parentStatus.attempts?.[1].timeout).toMatchObject({ terminationCause: 'complete', elapsedMs: 0, remainingMs: 3600 });
    expect(authors.filter(author => author.parentAttempt === 1)).toHaveLength(1);
    const retries = authors.filter(author => author.parentAttempt === 2);
    expect(retries).toHaveLength(1);
    for (const author of retries) {
      expect(author.childAttempt).toBe(1);
      expect(author.prompt).toContain('Previous attempt timed out with an effective budget of 1800ms.');
      expect(author.prompt).toContain('strictly larger immutable budget of 3600ms.');
      expect(author.prompt).toContain('# Execution clock\nExecution 1:');
      expect(author.prompt).toContain('remaining 1800 ms');
    }
  });
});
