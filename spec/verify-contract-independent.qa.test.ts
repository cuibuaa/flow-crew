import './test-support/policy-runtime.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { describe, expect, it } from 'vitest';
import {
  inspectDispatchAdmission,
  parseDispatchedStageConfig,
} from '../src/scheduler.js';


const makeStage = (raw: Record<string, unknown>) => parseDispatchedStageConfig({
  artifact_contract: fixtureArtifactContract(String(raw.id), raw.is_gate === true),
  prompt_template: 'independent QA probe',
  skills: [],
  is_gate: false,
  criterion_refs: [],
  ...raw,
});

describe('independent dispatch-admission QA probes', () => {
  it('rejects terminal ownership of research output through exact, tree, and glob scopes', () => {
    for (const scope of [
      ['docs/round.json', 'docs/final.md'],
      ['docs/', 'docs/final.md'],
      ['docs/**'],
    ]) {
      const owner = makeStage({
        id: 'measure', role: 'researcher', scope, depends_on: [], dependency_reasons: {},
        condition: 'research.decision != continue',
      });
      const report = inspectDispatchAdmission({
        dispatched: [owner], baseStages: [], dispatchStageId: 'plan',
        terminalStates: { complete: { paths: ['docs/final.md'] } },
        research: { baseline: 0, policy: 'greedy_stack', resultFile: 'docs/round.json' },
      });
      expect(report.errors.map(error => typeof error === 'string' ? error : error.message).join('\n'), scope.join(',')).toContain('research result producer path docs/round.json');
    }
  });

  it('rejects every tested predicate that can be true or is unproved on continue', () => {
    for (const condition of [
      undefined,
      'research.decision == continue',
      'research.decision != shipped',
      'audit.decision != continue',
    ]) {
      const owner = makeStage({
        id: 'finalize', role: 'writer', scope: ['docs/final.md'], depends_on: [],
        dependency_reasons: {}, condition,
      });
      const report = inspectDispatchAdmission({
        dispatched: [owner], baseStages: [], dispatchStageId: 'plan',
        terminalStates: { complete: { paths: ['docs/final.md'] } },
        research: { baseline: 0, policy: 'greedy_stack' },
      });
      expect(report.pass, String(condition)).toBe(false);
      expect(report.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('must be mechanically false when research.decision is continue');
    }
  });

  it('admits only tested narrow predicates that are false on continue', () => {
    for (const condition of [
      'research.decision != continue',
      'research.decision == shipped',
      'research.terminalPath == docs/final.md',
      'research.terminalStatus == complete',
    ]) {
      const owner = makeStage({
        id: 'finalize', role: 'writer', scope: ['docs/final.md'], depends_on: [],
        dependency_reasons: {}, condition,
      });
      const report = inspectDispatchAdmission({
        dispatched: [owner], baseStages: [], dispatchStageId: 'plan',
        terminalStates: { complete: { paths: ['docs/final.md'] } },
        research: { baseline: 0, policy: 'greedy_stack' },
      });
      expect(report.pass, `${condition}: ${report.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')}`).toBe(true);
    }
  });

  it('rejects duplicate ownership independently for each terminal path', () => {
    const first = makeStage({
      id: 'first', role: 'writer', scope: ['docs/final.md'], depends_on: [], dependency_reasons: {},
    });
    const second = makeStage({
      id: 'second', role: 'writer', scope: ['docs/final.md'], depends_on: [], dependency_reasons: {},
    });
    const report = inspectDispatchAdmission({
      dispatched: [first, second], baseStages: [], dispatchStageId: 'plan',
      terminalStates: { complete: { paths: ['docs/final.md'] } },
    });
    expect(report.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('expected exactly one final producer, found 2');
  });

  it('transports a terminal-only criterion without requiring an impossible downstream gate', () => {
    const criterion = 'criterion_terminal_1_deadbeef';
    const owner = makeStage({
      id: 'finalize', role: 'writer', scope: ['docs/final.md'], depends_on: [],
      dependency_reasons: {}, criterion_refs: [criterion],
    });
    const report = inspectDispatchAdmission({
      dispatched: [owner], baseStages: [], dispatchStageId: 'plan',
      terminalStates: { complete: { paths: ['docs/final.md'] } },
      criteria: { version: 1, briefDigest: 'qa', criteria: [
        { id: criterion, text: 'Choose the truthful terminal path.', line: 1, section: 'Report' },
      ] },
    });
    expect(report.pass, report.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toBe(true);
    expect(report.criterionTerminalRefs).toEqual({ finalize: [criterion] });
  });

  it('accepts audit-only coverage while refusing ungated ordinary work', () => {
    const criterion = 'criterion_work_1_deadbeef';
    const criteria = { version: 1 as const, briefDigest: 'qa', criteria: [
      { id: criterion, text: 'Audit the produced work.', line: 1, section: 'Report' },
    ] };
    const work = makeStage({
      id: 'work', role: 'coder', scope: ['src/**'], depends_on: [], dependency_reasons: {},
      criterion_refs: [criterion],
    });
    const gate = makeStage({
      id: 'verify', role: 'qa', scope: [], depends_on: ['work'],
      dependency_reasons: { work: 'Audits the work output.' }, is_gate: true,
      criterion_refs: [criterion],
    });

    const gateOnly = inspectDispatchAdmission({
      dispatched: [{ ...work, criterion_refs: [] }, gate, makeStage({ id: 'repair', role: 'coder', scope: ['src/**'],
        depends_on: ['verify'], dependency_reasons: { verify: 'Correct rejected work.' }, retry_to: ['verify'], criterion_refs: [] })], baseStages: [],
      dispatchStageId: 'plan', criteria,
    });
    expect(gateOnly.pass, gateOnly.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toBe(true);

    const ungated = inspectDispatchAdmission({
      dispatched: [work], baseStages: [],
      dispatchStageId: 'plan', criteria,
    });
    expect(ungated.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('not assigned to a gate');
  });
});
