import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMonotonePlanRetryContext, planRetryRequirement, preparePlanRetryCandidate, readMonotonePlanRetryState, recordPlanRetryAdmission, recordPlanRetryRefusal } from '../src/plan-retry-monotone.js';
import { inspectDispatchAdmission, parseDispatchedStageConfig } from '../src/scheduler.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string { const root = mkdtempSync(join(tmpdir(), 'fc-plan-retry-')); roots.push(root); return root; }
const requirement = planRetryRequirement('work.scope: refused');
function pair(root: string, scope: string, attemptIndex: number, checks?: string) {
  const dispatch = stringify({ stages: [{ id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: [scope], artifact_contract: { version: 1, produces: [], reads: [], replays: [] } }] });
  writeFileSync(join(root, 'dispatch.yaml'), dispatch);
  if (checks !== undefined) writeFileSync(join(root, 'reality_checks.md'), checks);
  return preparePlanRetryCandidate({ runDirPath: root, stageId: 'plan', iteration: 1, attemptIndex });
}
function refuse(root: string, scope: string, index: number, maxAttempts = 3, detail = requirement) {
  return recordPlanRetryRefusal({ runDirPath: root, prepared: pair(root, scope, index), maxAttempts, unsatisfied: [detail] });
}

describe('complete proposal retries', () => {
  it('examines a full replacement independently instead of locking unrelated fields or check bytes', () => {
    const root = directory();
    refuse(root, 'docs/old.md', 1);
    const checks = '## Reality checks\n```yaml\nchecks: []\n```\n';
    const candidate = pair(root, 'docs/new.md', 2, checks);
    expect(candidate.effective).toEqual(candidate.proposed);
    expect(readFileSync(join(root, 'dispatch.yaml'), 'utf8')).toBe(candidate.proposed.dispatch);
    expect(readFileSync(join(root, 'reality_checks.md'), 'utf8')).toBe(checks);
    const stage = parseDispatchedStageConfig({ id: 'replacement', role: 'coder', scope: [], depends_on: [], dependency_reasons: {}, artifact_contract: { version: 1, produces: [], reads: [], replays: [] } });
    expect(inspectDispatchAdmission({ dispatched: [stage], baseStages: [], dispatchStageId: 'plan' }).pass).toBe(true);
    recordPlanRetryAdmission({ runDirPath: root, prepared: candidate });
    expect(readMonotonePlanRetryState(root)?.terminal?.disposition).toBe('admitted');
  });

  it('never calls differing bytes identical, even when the same requirement remains', () => {
    const root = directory();
    expect(refuse(root, 'docs/first.md', 1).stop).toBe(false);
    expect(refuse(root, 'docs/second.md', 2)).toMatchObject({ stop: false, disposition: 'incumbent_advanced' });
  });

  it('stops identical refused bytes with stable requirements despite refreshed diagnostic wording', () => {
    const root = directory();
    refuse(root, 'docs/same.md', 1);
    expect(refuse(root, 'docs/same.md', 2, 3, { ...requirement, detail: 'updated wording' })).toMatchObject({ stop: true, disposition: 'identical_refusal' });
  });

  it('stops a genuine A/B/A cycle inside the persisted bound', () => {
    const root = directory();
    refuse(root, 'docs/a.md', 1); refuse(root, 'docs/b.md', 2);
    expect(refuse(root, 'docs/a.md', 3)).toMatchObject({ stop: true, disposition: 'cycle_refusal' });
  });

  it('keeps the first call ceiling after restart even when a later caller requests more attempts', () => {
    const root = directory();
    refuse(root, 'docs/a.md', 1, 2);
    const resumed = pair(root, 'docs/b.md', 1);
    expect(resumed.attemptIndex).toBe(2);
    const result = recordPlanRetryRefusal({ runDirPath: root, prepared: resumed, maxAttempts: 99, unsatisfied: [requirement] });
    expect(result.state.maxAttempts).toBe(2);
    expect(result.state.terminal?.disposition).toBe('attempts_exhausted');
  });

  it('records new failures directly instead of quarantining a changed complete candidate', () => {
    const root = directory();
    refuse(root, 'docs/a.md', 1);
    const second = pair(root, 'docs/b.md', 2);
    const different = planRetryRequirement('work.role: unknown');
    const result = recordPlanRetryRefusal({ runDirPath: root, prepared: second, maxAttempts: 3, unsatisfied: [different] });
    expect(result.state.unsatisfied).toEqual([different]);
    expect(result.disposition).toBe('incumbent_advanced');
    expect(buildMonotonePlanRetryContext(root, 'plan')).toContain('complete replacement');
  });

  it('still refuses corrupted retained evidence without materializing it over a replacement', () => {
    const root = directory();
    const result = refuse(root, 'docs/a.md', 1);
    writeFileSync(join(root, result.state.incumbent.dispatchPath), 'tampered');
    expect(() => pair(root, 'docs/b.md', 2)).toThrow('incumbent dispatch digest mismatch');
    expect(readFileSync(join(root, 'dispatch.yaml'), 'utf8')).toContain('docs/b.md');
  });

  it('reports the actual exhausting candidate requirements rather than a previous refusal', () => {
    const root = directory();
    refuse(root, 'docs/a.md', 1, 2);
    const latest = planRetryRequirement('replacement.role: unknown');
    const result = refuse(root, 'docs/b.md', 2, 2, latest);
    expect(result.reason).toContain(latest.detail);
    expect(result.reason).not.toContain(requirement.detail);
    expect(() => recordPlanRetryRefusal({ runDirPath: root, prepared: pair(directory(), 'docs/x.md', 1), maxAttempts: 0, unsatisfied: [] })).toThrow('positive safe integer');
  });
});
