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

  it('admits multiple authorized stages without choosing a terminal owner', () => {
    const first = makeStage({
      id: 'first', role: 'writer', scope: ['docs/final.md'], depends_on: [], dependency_reasons: {},
    });
    const second = makeStage({
      id: 'second', role: 'writer', scope: ['docs/final.md'], depends_on: [], dependency_reasons: {},
    });
    const legacyProposal = {
      terminalStates: { complete: { paths: ['docs/final.md'] } },
      dispatched: [first, second], baseStages: [], dispatchStageId: 'plan',
    };
    const report = inspectDispatchAdmission(legacyProposal);
    expect(report.pass, JSON.stringify(report.errors)).toBe(true);
    expect(report).not.toHaveProperty('terminalOwners');
  });

  it('requires the same independent criterion review for a terminal report as for other work', () => {
    const criterion = 'criterion_terminal_1_deadbeef';
    const owner = makeStage({
      id: 'finalize', role: 'writer', scope: ['docs/final.md'], depends_on: [],
      dependency_reasons: {}, criterion_refs: [criterion],
    });
    const legacyProposal = {
      terminalStates: { complete: { paths: ['docs/final.md'] } },
      dispatched: [owner], baseStages: [], dispatchStageId: 'plan',
      criteria: { version: 1 as const, briefDigest: 'qa', criteria: [
        { id: criterion, text: 'Choose the truthful terminal path.', line: 1, section: 'Report' },
      ] },
    };
    const report = inspectDispatchAdmission(legacyProposal);
    expect(report.pass).toBe(false);
    expect(report.errors.map(error => error.message).join('\n')).toContain('not assigned to a gate');
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
