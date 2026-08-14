import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateCondition } from '../src/condition.js';
import { fcGlobalDir, runDir, setFcGlobalDir, stageDir } from '../src/store.js';

/**
 * Operator-written replacement for the guarding spec that shipped with the
 * scheduler dependency fix and was lost before it reached version control. It
 * covers the condition-resolution half of that defect, which is what turned a
 * satisfied gate into a skipped measurement: the condition referenced a gate
 * fact that lives in the stage's verdict file rather than its status file, the
 * lookup read only the status file, and a stringly-typed comparison turned the
 * resulting `undefined` into `false` instead of surfacing it.
 *
 * The scheduler half — that a skipped producer no longer releases its
 * dependents — is not covered here; it needs the engine harness.
 */
describe('condition facts resolve from the producing stage only', () => {
  const runId = 'run-under-test';
  let sandbox: string;
  let previousFcDir: string;

  const writeStage = (stageId: string, status: Record<string, unknown>) => {
    mkdirSync(stageDir(sandbox, runId, stageId), { recursive: true });
    writeFileSync(join(stageDir(sandbox, runId, stageId), 'status.json'), JSON.stringify(status));
  };
  const writeVerdict = (stageId: string, verdict: Record<string, unknown>) => {
    mkdirSync(runDir(sandbox, runId), { recursive: true });
    writeFileSync(join(runDir(sandbox, runId), `verdict_${stageId}.json`), JSON.stringify(verdict));
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'fc-condition-'));
    previousFcDir = fcGlobalDir();
    setFcGlobalDir(join(sandbox, 'fc-home'));
  });
  afterEach(() => {
    setFcGlobalDir(previousFcDir);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('reads a gate fact from the stage\'s own verdict when status.json does not carry it', () => {
    writeStage('audit', { status: 'complete', retries: 0 });
    writeVerdict('audit', { pass: true, score: 0, metric: 'failing_checks', threshold: 0 });

    expect(evaluateCondition('audit.pass == true', sandbox, runId)).toBe(true);
  });

  it('does not satisfy a gate condition from a sibling stage\'s verdict', () => {
    writeStage('audit', { status: 'complete', retries: 0 });
    writeVerdict('other_gate', { pass: true });

    expect(evaluateCondition('audit.pass == true', sandbox, runId)).toBe(false);
  });

  it('rejects a quoted boolean, so a malformed verdict cannot satisfy pass == true', () => {
    writeStage('audit', { status: 'complete', retries: 0 });
    writeVerdict('audit', { pass: 'true' });

    expect(evaluateCondition('audit.pass == true', sandbox, runId)).toBe(false);
  });

  it('keeps status.json authoritative for process facts', () => {
    writeStage('work', { status: 'complete', retries: 0 });
    writeVerdict('work', { status: 'failed' });

    expect(evaluateCondition('work.status == complete', sandbox, runId)).toBe(true);
  });

  it('treats a passing gate and a failing gate as opposite dependency facts', () => {
    writeStage('gate_a', { status: 'complete', retries: 0 });
    writeVerdict('gate_a', { pass: true });
    writeStage('gate_b', { status: 'complete', retries: 0 });
    writeVerdict('gate_b', { pass: false });

    expect(evaluateCondition('gate_a.pass == true', sandbox, runId)).toBe(true);
    expect(evaluateCondition('gate_b.pass == true', sandbox, runId)).toBe(false);
  });

  it('writes nothing into the real run archive', () => {
    writeStage('audit', { status: 'complete', retries: 0 });
    writeVerdict('audit', { pass: true });

    expect(runDir(sandbox, runId).startsWith(sandbox)).toBe(true);
  });
});
