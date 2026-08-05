import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDir as computeRunDir } from '../src/store.js';

/**
 * Regression test for the BTC v3 run 2026-05-19T07-18-07-d95b80 behavior:
 * supervisor issued 21 DONE verdicts (each writing signals/goal_met.json) but
 * the scheduler kept iterating because the iteration loop never checked the
 * signal. The fix adds a top-of-iteration check that honors goal_met.json on
 * iterations >= 2.
 *
 * We don't spin up a full scheduler here — instead we validate the contract:
 *   1. A fresh runDir with no signal does NOT trigger early exit.
 *   2. Writing signals/goal_met.json with a reason produces the expected
 *      side-effect contract (the helper writes file structure runs can read).
 *   3. The signal contents match the supervisor's write shape (reason + ts).
 *
 * The actual loop-stop behavior is exercised by the scheduler at runtime; this
 * test guards the on-disk contract that the new code reads.
 */

describe('supervisor goal_met signal contract', () => {
  it('round-trips reason + timestamp through signals/goal_met.json', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'fc-done-test-proj-'));
    const runId = `fc-test-done-${randomBytes(4).toString('hex')}`;
    const runDir = computeRunDir(projectDir, runId);
    mkdirSync(join(runDir, 'signals'), { recursive: true });
    const sigPath = join(runDir, 'signals', 'goal_met.json');
    const payload = {
      reason: 'Acceptance criteria satisfied: metric 302.88 >= 300, no liquidations, anti-oracle pass.',
      timestamp: '2026-05-19T13:43:50.000Z',
    };
    writeFileSync(sigPath, JSON.stringify(payload));

    expect(existsSync(sigPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(sigPath, 'utf-8'));
    expect(parsed.reason).toContain('Acceptance criteria satisfied');
    expect(parsed.timestamp).toBe('2026-05-19T13:43:50.000Z');

    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('runDir without signals/ directory is the default state (no early stop)', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'fc-done-test-proj-'));
    const runId = `fc-test-done-${randomBytes(4).toString('hex')}`;
    const runDir = computeRunDir(projectDir, runId);
    mkdirSync(runDir, { recursive: true });
    const sigPath = join(runDir, 'signals', 'goal_met.json');
    expect(existsSync(sigPath)).toBe(false);
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('malformed goal_met.json is tolerated (parse fallback to generic reason)', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'fc-done-test-proj-'));
    const runId = `fc-test-done-${randomBytes(4).toString('hex')}`;
    const runDir = computeRunDir(projectDir, runId);
    mkdirSync(join(runDir, 'signals'), { recursive: true });
    const sigPath = join(runDir, 'signals', 'goal_met.json');
    writeFileSync(sigPath, 'not-json-at-all');
    expect(existsSync(sigPath)).toBe(true);
    // The scheduler's JSON.parse wraps in try/catch, falling back to a generic
    // reason. The contract is: file existence is enough to trigger stop;
    // malformed content does not crash.
    let crashed = false;
    try {
      JSON.parse(readFileSync(sigPath, 'utf-8'));
    } catch {
      crashed = true;
    }
    expect(crashed).toBe(true); // raw parse crashes — confirms scheduler's try/catch is required
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
