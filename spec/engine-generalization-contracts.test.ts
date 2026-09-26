import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyFrameworkScopeReservations,
  assessResearchIterationBudget,
  checkGates,
  decideScopeRevision,
  deriveCriterionDischarges,
  inspectDispatchAdmission,
  parseBriefFrontmatter,
  parseDispatchedStageConfig,
  resolveDeclaredInputWriteBindings,
  type StageConfig,
} from '../src/scheduler.js';
import { scopePathDigest, type ScopeRevisionRequestV1 } from '../src/runtime-negotiation.js';
import {
  STAGE_STATUS,
  fcGlobalDir,
  runDir,
  setFcGlobalDir,
  type StoreState,
} from '../src/store.js';

const roots: string[] = [];
const originalFcRoot = fcGlobalDir();

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-engine-generalization-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  setFcGlobalDir(originalFcRoot);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stage(raw: Record<string, unknown>): StageConfig {
  return parseDispatchedStageConfig({
    role: 'worker',
    prompt_template: 'bounded contract fixture',
    scope: [],
    depends_on: [],
    dependency_reasons: {},
    skills: [],
    is_gate: false,
    criterion_refs: [],
    ...raw,
  });
}

function researchConfig(maxRounds = 5, maxWallHours?: number) {
  const parsed = parseBriefFrontmatter([
    '---',
    'research:',
    '  baseline: 0',
    '  policy: greedy_stack',
    '  result_file: artifacts/round.json',
    '  report_dir: artifacts',
    '  stop:',
    `    max_rounds: ${maxRounds}`,
    ...(maxWallHours === undefined ? [] : [`    max_wall_hours: ${maxWallHours}`]),
    '---',
    '# Contract fixture',
  ].join('\n'));
  if (!parsed.research) throw new Error('fixture research config did not parse');
  return parsed.research;
}

function admission(stages: StageConfig[], extra: Partial<Parameters<typeof inspectDispatchAdmission>[0]> = {}) {
  return inspectDispatchAdmission({
    dispatched: stages,
    baseStages: [],
    dispatchStageId: 'plan',
    ...extra,
  });
}

describe('engine generalization binding contracts', () => {
  it('1 — reserves the framework research manifest at every stage binding while retaining outcome producers', () => {
    const research = researchConfig();
    const ordinary = admission([
      stage({ id: 'ordinary', scope: ['artifacts/run_manifest.json'] }),
    ], { research });
    const nonSubtractable = admission([
      stage({ id: 'broad_writer', scope: ['artifacts/'] }),
    ], { research });
    const terminal = admission([
      stage({
        id: 'finish',
        scope: ['docs/final.md', 'artifacts/run_manifest.json'],
        condition: 'research.terminalPath == "docs/final.md"',
      }),
    ], {
      research,
      terminalStates: { complete: { paths: ['docs/final.md'] } },
    });
    const resultProducer = admission([
      stage({ id: 'measure', scope: ['artifacts/round.json', 'artifacts/round.json.no_candidate.json'] }),
    ], { research });
    const unrelated = admission([
      stage({ id: 'write_report', scope: ['docs/report.md'] }),
    ], { research });

    expect(ordinary.pass).toBe(true);
    expect(ordinary.frameworkReservedScopes).toEqual({
      ordinary: ['artifacts/run_manifest.json'],
    });
    const effectiveOrdinary = stage({ id: 'ordinary', scope: ['artifacts/run_manifest.json'] });
    applyFrameworkScopeReservations([effectiveOrdinary], ordinary.frameworkReservedScopes);
    expect(effectiveOrdinary.scope).toEqual([]);
    expect(nonSubtractable.pass).toBe(false);
    expect(nonSubtractable.errors.join('\n')).toContain('contains framework-owned research manifest');
    expect(terminal.pass).toBe(false);
    expect(terminal.errors.join('\n')).toContain('cannot be owned by a terminal writer');
    expect(resultProducer.pass, resultProducer.errors.join('\n')).toBe(true);
    expect(unrelated.pass, unrelated.errors.join('\n')).toBe(true);
  });

  it('3 — compares and reports rounds, wall capacity, and every attempt deadline in explicit units', () => {
    const binding = { attemptTimeoutMs: 3 * 3_600_000, technicalRetries: 1 };
    const overWall = assessResearchIterationBudget(researchConfig(5, 16), 5, binding);
    const exactWall = assessResearchIterationBudget(researchConfig(5, 15), 5, binding);
    const overRounds = assessResearchIterationBudget(researchConfig(6, 15), 5, binding);
    const ordinaryControl = assessResearchIterationBudget(researchConfig(4, 12), 5, binding);

    expect(overWall).toMatchObject({
      pass: false,
      maxRounds: 5,
      maxIterations: 5,
      maxWallHours: 16,
      maxWallMs: 57_600_000,
      iterationWallCeilingHours: 15,
      iterationWallCeilingMs: 54_000_000,
    });
    expect(overWall.reason).toContain('default_timeout_ms × max_iterations');
    expect(overWall.attemptDeadlines).toEqual([
      { attempt: 1, kind: 'base', budgetMs: 10_800_000, budgetHours: 3 },
      { attempt: 2, kind: 'technical_retry', budgetMs: 21_600_000, budgetHours: 6 },
    ]);
    expect(exactWall.pass).toBe(true);
    expect(ordinaryControl).toMatchObject({
      pass: true,
      maxRounds: 4,
      maxWallHours: 12,
      iterationWallCeilingHours: 15,
    });
    expect(overRounds.pass).toBe(false);
    expect(overRounds.reason).toContain('max_rounds (6) exceeds');
    expect(overRounds.reason).toContain('units: rounds versus iterations');
  });

  it('4 — keeps a declared but skipped gate non-passing and unable to discharge its criterion', () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    const taskRunDir = join(root, 'run');
    mkdirSync(taskRunDir, { recursive: true });
    const criterionId = 'criterion_fixture';
    const work = stage({ id: 'work', criterion_refs: [criterionId] });
    const gate = stage({
      id: 'qa', role: 'qa', is_gate: true, criterion_refs: [criterionId],
      depends_on: ['work'], dependency_reasons: { work: 'Judges the completed work.' },
    });
    const criteria = {
      version: 1 as const,
      briefDigest: 'fixture-digest',
      criteria: [{ id: criterionId, text: 'Judge the work.', line: 1, section: 'Report' }],
    };
    const admitted = admission([work, gate], { criteria });
    const noWorker = admission([{ ...gate, depends_on: [], dependency_reasons: {} }], { criteria });
    const noGate = admission([work], { criteria });
    const state: StoreState = {
      runId: 'fixture-run', workflowName: 'fixture', projectDir, status: 'running',
      stages: {
        work: { status: STAGE_STATUS.COMPLETE, retries: 0 },
        qa: { status: STAGE_STATUS.SKIPPED, retries: 0 },
      },
      startedAt: new Date(0).toISOString(),
    };
    writeFileSync(join(taskRunDir, 'dispatch_admission.json'), `${JSON.stringify({
      version: 1,
      pass: true,
      checkedAt: new Date(0).toISOString(),
      errors: [],
      warnings: [],
      terminalOwners: {},
      criteriaDigest: 'fixture-digest',
      criterionGateRefs: { qa: [criterionId] },
    })}\n`);

    expect(admitted.pass, admitted.errors.join('\n')).toBe(true);
    expect(noWorker.errors.join('\n')).toContain('not assigned to a capable work/finalizer stage');
    expect(noGate.errors.join('\n')).toContain('not assigned to a gate');
    expect(checkGates([work, gate], state, projectDir, state.runId)).toEqual({
      allPass: false,
      failedGateIds: ['qa'],
    });
    expect(deriveCriterionDischarges({
      projectDir,
      runId: state.runId,
      runDirPath: taskRunDir,
      iteration: 1,
      stages: [work, gate],
      state,
      evidence: [],
    })).toEqual([]);
  });

  it('5 — rejects terminal condition sets that omit ordinary successful quiescence', () => {
    const work = stage({ id: 'work' });
    const failed = stage({
      id: 'on_failed', scope: ['docs/failure.md'], condition: 'work.status == failed',
      depends_on: ['work'], dependency_reasons: { work: 'Reports a failed worker.' },
    });
    const skipped = stage({
      id: 'on_skipped', scope: ['docs/skipped.md'], condition: 'work.status == skipped',
      depends_on: ['work'], dependency_reasons: { work: 'Reports a skipped worker.' },
    });
    const incomplete = admission([work, failed, skipped], {
      terminalStates: {
        failed: { paths: ['docs/failure.md'] },
        escalated: { paths: ['docs/skipped.md'] },
      },
    });
    const complete = stage({
      id: 'on_complete', scope: ['docs/complete.md'], condition: 'work.status == complete',
      depends_on: ['work'], dependency_reasons: { work: 'Reports successful work.' },
    });
    const covering = admission([work, failed, skipped, complete], {
      terminalStates: {
        failed: { paths: ['docs/failure.md'] },
        escalated: { paths: ['docs/skipped.md'] },
        complete: { paths: ['docs/complete.md'] },
      },
    });
    const impossible = admission([work, { ...complete, condition: 'work.status == invented' }], {
      terminalStates: { complete: { paths: ['docs/complete.md'] } },
    });

    expect(incomplete.pass).toBe(false);
    expect(incomplete.errors.join('\n')).toContain('do not cover ordinary quiescence (work.status=complete)');
    expect(covering.pass, covering.errors.join('\n')).toBe(true);
    expect(impossible.pass).toBe(false);
    expect(impossible.errors.join('\n')).toContain('status literal "invented" cannot occur');
  });

  it('11 — intersects exact, tree, glob, alias, and revised write capabilities with declared inputs', () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    const frozenDir = join(root, 'frozen-recordings');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(frozenDir, { recursive: true });
    writeFileSync(join(frozenDir, 'real.csv'), 'recorded\n');
    symlinkSync(frozenDir, join(projectDir, 'recordings'));
    symlinkSync(frozenDir, join(projectDir, 'alias'));
    const brief = [
      '---',
      'inputs:',
      '  - recordings/real.csv',
      '---',
      '# Frozen input fixture',
    ].join('\n');
    const declaredInputs = resolveDeclaredInputWriteBindings(projectDir, brief);
    const inspect = (scope: string) => admission([
      stage({ id: 'writer', scope: [scope] }),
    ], { declaredInputs, projectDir });

    for (const scope of ['recordings/real.csv', 'recordings/', 'recordings/**', 'alias/real.csv']) {
      const report = inspect(scope);
      expect(report.pass, `${scope}: ${report.errors.join('\n')}`).toBe(false);
      expect(report.errors.join('\n')).toContain('declared read-only input recordings/real.csv');
    }
    expect(inspect('artifacts/result.json').pass).toBe(true);
    expect(inspect('*.ts').pass).toBe(true);
    expect(admission([stage({ id: 'reader', scope: [] })], { declaredInputs, projectDir }).pass).toBe(true);

    const declaredTree = resolveDeclaredInputWriteBindings(projectDir, [
      '---',
      'inputs:',
      '  - recordings',
      '---',
      '# Frozen input tree fixture',
    ].join('\n'));
    const manufacturedChild = admission([
      stage({ id: 'tree_writer', scope: ['recordings/manufactured.csv'] }),
    ], { declaredInputs: declaredTree, projectDir });
    expect(declaredTree).toEqual([expect.objectContaining({ path: 'recordings', kind: 'tree' })]);
    expect(manufacturedChild.pass).toBe(false);
    expect(manufacturedChild.errors.join('\n')).toContain('declared read-only input recordings (tree');

    const stateRoot = join(root, 'state');
    setFcGlobalDir(stateRoot);
    const runId = 'scope-fixture';
    const taskRunDir = runDir(projectDir, runId);
    mkdirSync(taskRunDir, { recursive: true });
    writeFileSync(join(taskRunDir, 'task_brief.md'), brief);
    const state: StoreState = {
      runId,
      workflowName: 'research',
      projectDir,
      status: 'running',
      research: researchConfig(),
      stages: { writer: { status: STAGE_STATUS.RUNNING, retries: 0 } },
      startedAt: new Date(0).toISOString(),
    };
    writeFileSync(join(taskRunDir, 'run.json'), `${JSON.stringify(state)}\n`);
    const writer = stage({ id: 'writer', scope: [] });
    const revise = (requestedPath: string, requestId: string) => {
      const request: ScopeRevisionRequestV1 = {
        version: 1,
        kind: 'scope_revision',
        requestId,
        runId,
        stageId: writer.id,
        attemptIndex: 1,
        requestedBy: 'stage',
        requestedPaths: [requestedPath],
        pathDigest: scopePathDigest([requestedPath]),
        reason: 'Exercise the bounded scope-revision contract.',
      };
      return decideScopeRevision({
        request,
        stage: writer,
        priorScope: [],
        activePeers: [],
        projectDir,
        runId,
        attemptIndex: 1,
      });
    };

    const revisedInput = revise('recordings/**', 'input-overlap');
    const revisedAlias = revise('alias/real.csv', 'alias-overlap');
    const revisedManifest = revise('artifacts/run_manifest.json', 'manifest-overlap');
    const revisedOutput = revise('artifacts/result.json', 'disjoint-output');
    expect(revisedInput).toMatchObject({ accepted: false, decision: 'rejected' });
    expect(revisedInput.rejectionReason).toContain('declared read-only input');
    expect(revisedAlias).toMatchObject({ accepted: false, decision: 'rejected' });
    expect(revisedAlias.rejectionReason).toContain('resolved_identity');
    expect(revisedManifest).toMatchObject({ accepted: false, decision: 'rejected' });
    expect(revisedManifest.rejectionReason).toContain('framework-owned research manifest');
    expect(revisedOutput).toMatchObject({ accepted: true, decision: 'accepted' });
  });
});
