import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { evaluateCondition } from '../src/condition.js';
import {
  inspectDispatchAdmission,
  parseDispatchedStageConfig,
} from '../src/scheduler.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

type AdmissionInput = Parameters<typeof inspectDispatchAdmission>[0];

const makeStage = (raw: Record<string, unknown>) => parseDispatchedStageConfig({
  prompt_template: 'independent QA probe',
  skills: [],
  is_gate: false,
  criterion_refs: [],
  ...raw,
});

function fixture(name: string): { raw: string; input: AdmissionInput } {
  const root = join(import.meta.dirname, 'fixtures', 'dispatch-admission', name);
  const raw = readFileSync(join(root, 'dispatch.yaml'), 'utf8');
  const context = JSON.parse(readFileSync(join(root, 'context.json'), 'utf8')) as {
    source: { dispatchSha256: string; dispatchBytes: number };
    terminalStates?: AdmissionInput['terminalStates'];
    research?: AdmissionInput['research'];
    criteria?: AdmissionInput['criteria'];
  };
  expect(Buffer.byteLength(raw)).toBe(context.source.dispatchBytes);
  expect(createHash('sha256').update(raw).digest('hex')).toBe(context.source.dispatchSha256);
  return {
    raw,
    input: {
      dispatched: (parseYaml(raw) as unknown[]).map((stage) => parseDispatchedStageConfig(stage)),
      baseStages: [],
      dispatchStageId: 'plan',
      terminalStates: context.terminalStates,
      research: context.research,
      criteria: context.criteria,
    },
  };
}

describe('independent dispatch-admission QA probes', () => {
  it('binds every supplied dispatch fixture to its declared bytes and digest', () => {
    for (const name of [
      'research_multi_writer',
      'research_measuring_owner',
      'diagram_extra_dist',
      'diagram_extra_directory',
      'admitted_single_owner',
    ]) fixture(name);

    const recordedResearch = fixture('research_multi_writer').raw;
    expect(Buffer.byteLength(recordedResearch)).toBe(6_857);
    expect(createHash('sha256').update(recordedResearch).digest('hex'))
      .toBe('d817f46b93f50d70bb29ca7dc1cd6d4e8c4282e065058525bc7816f01e6064db');
  });

  it('admits the three recoverable recorded classes and preserves the admitted control', () => {
    for (const name of [
      'research_multi_writer',
      'diagram_extra_dist',
      'diagram_extra_directory',
      'admitted_single_owner',
    ]) {
      const report = inspectDispatchAdmission(fixture(name).input);
      expect(report.pass, `${name}: ${report.errors.join('\n')}`).toBe(true);
    }
  });

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
        research: { baseline: 0, policy: 'best_of_n', resultFile: 'docs/round.json' },
      });
      expect(report.errors.join('\n'), scope.join(',')).toContain('research result producer path docs/round.json');
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
        research: { baseline: 0, policy: 'best_of_n' },
      });
      expect(report.pass, String(condition)).toBe(false);
      expect(report.errors.join('\n')).toContain('must be mechanically false when research.decision is continue');
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
        research: { baseline: 0, policy: 'best_of_n' },
      });
      expect(report.pass, `${condition}: ${report.errors.join('\n')}`).toBe(true);
    }
  });

  it('releases the exact recorded writers when the framework publishes terminal policy facts', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-admission-liveness-'));
    const previousFcRoot = fcGlobalDir();
    setFcGlobalDir(root);
    try {
      const runRoot = join(root, 'runs', 'run');
      mkdirSync(runRoot, { recursive: true });
      const stages = fixture('research_multi_writer').input.dispatched;
      for (const expected of [
        {
          id: 'write_ship',
          decision: 'ship',
          terminalStatus: 'shipped',
          terminalPath: 'docs/happymj_incumbent/ship_report.md',
        },
        {
          id: 'write_ceiling',
          decision: 'stop_ceiling',
          terminalStatus: 'ceiling_hit',
          terminalPath: 'docs/happymj_incumbent/ceiling_report.md',
        },
      ]) {
        writeFileSync(join(runRoot, 'research_decision.json'), JSON.stringify(expected));
        const condition = stages.find((stage) => stage.id === expected.id)?.condition;
        expect(condition, expected.id).toBeTypeOf('string');
        expect(evaluateCondition(condition!, 'unused-project', 'run'), `${expected.id}: ${condition}`).toBe(true);
      }
    } finally {
      setFcGlobalDir(previousFcRoot);
      rmSync(root, { recursive: true, force: true });
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
    expect(report.errors.join('\n')).toContain('expected exactly one scoped owner, found 2');
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
    expect(report.pass, report.errors.join('\n')).toBe(true);
    expect(report.criterionTerminalRefs).toEqual({ finalize: [criterion] });
  });

  it('keeps gate-only and ungated ordinary criterion transport rejected', () => {
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
      dispatched: [{ ...work, criterion_refs: [] }, gate], baseStages: [],
      dispatchStageId: 'plan', criteria,
    });
    expect(gateOnly.errors.join('\n')).toContain('not assigned to a capable work/finalizer stage');

    const ungated = inspectDispatchAdmission({
      dispatched: [work, { ...gate, criterion_refs: [] }], baseStages: [],
      dispatchStageId: 'plan', criteria,
    });
    expect(ungated.errors.join('\n')).toContain('not assigned to a gate');
  });
});
