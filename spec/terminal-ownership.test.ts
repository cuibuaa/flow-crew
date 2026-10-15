import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admittedTerminalOwner, stageAttemptWroteProjectPath, terminalProductWrites } from '../src/scheduler/sched_policy/terminal-ownership.js';
import { type StageAttempt, type StageConstraintAuditSummary, type StageStatus, type StoreState } from '../src/store.js';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-ownership-'));
  temporary.push(directory);
  return directory;
}
const terminalPath = 'results/report.md';
const at = '2026-01-01T00:00:00.000Z';
function attempt(status: 'complete' | 'failed', writes: string[]): StageAttempt {
  return { index: 1, startedAt: at, completedAt: at, status, writes };
}
function state(projectDir: string, owner: StageStatus): StoreState {
  return { runId: 'fixture', workflowName: 'fixture', projectDir, status: 'running', startedAt: at, stages: { owner } };
}
function audit(violationCount: number, unresolvedViolationCount?: number): StageConstraintAuditSummary {
  return {
    path: 'stages/owner/constraint_audit_attempt_1.json', declaredScope: [terminalPath], effectiveScope: [terminalPath],
    acceptedRevisionCount: 0, rejectedRevisionCount: 0, mismatchCount: 0, unverifiedCount: 0,
    violationCount, ...(unresolvedViolationCount === undefined ? {} : { unresolvedViolationCount }),
  };
}

describe('terminal ownership follows the current admitted plan', () => {
  it.each([
    { label: 'replacement owner', pass: true, terminalOwners: { [terminalPath]: 'current_owner' }, expected: 'current_owner' },
    { label: 'removed owner', pass: true, terminalOwners: {}, expected: undefined },
    { label: 'refused admission', pass: false, terminalOwners: { [terminalPath]: 'current_owner' }, expected: undefined },
  ])('prefers $label over a stale dispatch projection', ({ pass, terminalOwners, expected }) => {
    const directory = fixture();
    writeFileSync(join(directory, 'dispatch_admission.json'), JSON.stringify({ pass: true, terminalOwners: { [terminalPath]: 'stale_owner' } }));
    writeFileSync(join(directory, 'run.json'), JSON.stringify({ queryState: { planRevision: { path: 'current_plan.json' } } }));
    writeFileSync(join(directory, 'current_plan.json'), JSON.stringify({ admission: { pass, terminalOwners } }));
    expect(admittedTerminalOwner(directory, terminalPath)).toBe(expected);
  });

  it.each(['no run record', 'no revision', 'revision without admission'] as const)('retains legacy projection fallback with %s', shape => {
    const directory = fixture();
    writeFileSync(join(directory, 'dispatch_admission.json'), JSON.stringify({ pass: true, terminalOwners: { [terminalPath]: 'legacy_owner' } }));
    if (shape === 'no revision') writeFileSync(join(directory, 'run.json'), '{}');
    if (shape === 'revision without admission') {
      writeFileSync(join(directory, 'run.json'), JSON.stringify({ queryState: { planRevision: { path: 'current_plan.json' } } }));
      writeFileSync(join(directory, 'current_plan.json'), '{}');
    }
    expect(admittedTerminalOwner(directory, terminalPath)).toBe('legacy_owner');
  });
});

describe('terminal provenance belongs to eligible settled attempts', () => {
  it.each(['complete', 'failed'] as const)('accepts the actual path written by a clean %s attempt', status => {
    const project = fixture();
    const owner: StageStatus = { status, retries: 0, attempts: [attempt(status, [join(project, terminalPath)])] };
    expect(stageAttemptWroteProjectPath(project, state(project, owner), 'owner', terminalPath, status)).toBe(true);
    expect(stageAttemptWroteProjectPath(project, state(project, owner), 'owner', 'results/unwritten.md', status)).toBe(false);
  });

  it('never uses failed-attempt writes as successful provenance', () => {
    const project = fixture();
    const owner: StageStatus = { status: 'failed', retries: 0, writes: [terminalPath], attempts: [attempt('failed', [terminalPath])] };
    expect(stageAttemptWroteProjectPath(project, state(project, owner), 'owner', terminalPath)).toBe(false);
  });

  it('does not borrow a completed attempt write from the failed stage aggregate', () => {
    const project = fixture();
    const owner: StageStatus = {
      status: 'failed', retries: 0, writes: [terminalPath, 'results/other.md'],
      attempts: [attempt('complete', [terminalPath]), { ...attempt('failed', ['results/other.md']), index: 2 }],
    };
    expect(stageAttemptWroteProjectPath(project, state(project, owner), 'owner', terminalPath, 'failed')).toBe(false);
  });

  it.each(['complete', 'failed'] as const)('retains legacy %s write attribution when there is no attempt ledger', status => {
    const project = fixture();
    const owner: StageStatus = { status, retries: 0, writes: [terminalPath] };
    expect(stageAttemptWroteProjectPath(project, state(project, owner), 'owner', terminalPath, status)).toBe(true);
  });

  it.each([
    { label: 'unresolved refusal', status: 'complete' as const, audit: audit(1, 1) },
    { label: 'restored failed violation', status: 'failed' as const, audit: audit(1, 0) },
    { label: 'legacy failed violation', status: 'failed' as const, audit: audit(1) },
  ])('refuses $label even with an older completed write', ({ status, audit: constraintAudit }) => {
    const project = fixture();
    const owner: StageStatus = {
      status, retries: 0, constraintAudit,
      attempts: [attempt('complete', [terminalPath]), { ...attempt(status, [terminalPath]), index: 2, constraintAudit }],
    };
    const run = state(project, owner);
    run.stageEvidence = [{
      stageId: 'owner', iteration: 1, status: { status: 'complete', retries: 0, attempts: [attempt('complete', [terminalPath])] },
      statusPath: 'iterations/1/stages/owner/status.json', attemptOutputPaths: [],
    }];
    expect(stageAttemptWroteProjectPath(project, run, 'owner', terminalPath)).toBe(false);
    expect(stageAttemptWroteProjectPath(project, run, 'owner', terminalPath, 'failed')).toBe(false);
  });

  it('refuses a restored violation on the attempt even if the current summary is clean', () => {
    const project = fixture();
    const owner: StageStatus = {
      status: 'failed', retries: 0, constraintAudit: audit(0, 0), writes: [terminalPath],
      attempts: [{ ...attempt('failed', [terminalPath]), constraintAudit: audit(1, 0) }],
    };
    expect(stageAttemptWroteProjectPath(project, state(project, owner), 'owner', terminalPath, 'failed')).toBe(false);
  });
});


describe('terminal product deltas use existing content and ownership evidence', () => {
  it.each(['absent', 'legacy', 'unchanged', 'changed'] as const)('uses %s scope audit evidence without confusing run artifacts with product', shape => {
    const project = fixture();
    const completed = attempt('complete', [terminalPath, 'run:notes.md', '../state/notes.md', '.git/index', join(project, 'value.json')]);
    const owner: StageStatus = { status: 'complete', retries: 0, attempts: [completed] };
    const run = state(project, owner);
    run.terminalStates = { complete: { paths: [terminalPath] } };
    writeFileSync(join(project, 'dispatch_admission.json'), JSON.stringify({ pass: true, terminalOwners: { [terminalPath]: 'owner' } }));
    if (shape !== 'absent') {
      completed.constraintAudit = { ...audit(0, 0), path: 'audit.json' };
      writeFileSync(join(project, 'audit.json'), JSON.stringify(shape === 'legacy' ? {} : { durableWrites: shape === 'unchanged' ? [terminalPath] : [terminalPath, 'value.json'] }));
    }
    expect(terminalProductWrites(project, run, 'owner')).toEqual(shape === 'unchanged' ? [] : [{ path: 'value.json', completedAt: Date.parse(at) }]);
  });

  it.each(['owner', 'other'] as const)('uses a round evidence glob only for its %s terminal producer', evidenceOwner => {
    const project = fixture();
    const run = state(project, { status: 'complete', retries: 0, attempts: [attempt('complete', [terminalPath, 'round/result.json'])] });
    run.terminalStates = {
      complete: { paths: [terminalPath] },
      escalated: { paths: ['results/blocker.md'], stageGlob: 'round/**', floor: { minAttemptedStages: 1 } },
    };
    writeFileSync(join(project, 'dispatch_admission.json'), JSON.stringify({ pass: true, terminalOwners: { [terminalPath]: 'owner', 'results/blocker.md': evidenceOwner } }));
    expect(terminalProductWrites(project, run, 'owner')).toEqual(evidenceOwner === 'owner' ? [] : [{ path: 'round/result.json', completedAt: Date.parse(at) }]);
  });
});
