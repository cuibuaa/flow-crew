import './test-support/policy-runtime.js';
import { firstImmutableEvidenceConflict } from '../src/scheduler/sched_scope/path-capabilities.js';
import { artifacts, stageArtifacts  } from './spec_contracts/declared-fixtures.js';
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
import { assessResearchIterationBudget, checkGates, deriveCriterionDischarges, inspectDispatchAdmission, findAllRetryToStages, parseBriefFrontmatter, parseDispatchedStageConfig, resolveImmutableEvidenceBindings, scopeContainsPath, StageConfigSchema, normalizeStageContracts, type StageConfig } from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';
import {
  STAGE_STATUS,
  fcGlobalDir,
  updateRunState,
  runDir,
  setFcGlobalDir,
  type StoreState,
} from '../src/store.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';

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
  return parseDispatchedStageConfig({ artifact_contract: stageArtifacts(String(raw.id), raw.is_gate === true),
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
  it('keeps retry target dependencies while allowing independent accepting prerequisites', () => {
    const review = stage({ id: 'review', role: 'qa', is_gate: true });
    const accepted = stage({ id: 'accepted', role: 'qa', is_gate: true });
    const repair = stage({ id: 'repair', depends_on: ['review', 'accepted'], retry_to: ['review'] });
    const repairAccepted = stage({ id: 'repair_accepted', depends_on: ['accepted'], retry_to: ['accepted'] });
    const stages = [review, accepted, repair, repairAccepted];
    expect(admission(stages).pass).toBe(true);
    expect(findAllRetryToStages(stages, ['review'])).toEqual([repair]);
    expect(findAllRetryToStages(stages, ['accepted'])).toEqual([repairAccepted]);
    expect(admission([review, accepted, { ...repair, depends_on: ['accepted'] }, repairAccepted]).errors.map(error => typeof error === 'string' ? error : error.message).join(';')).toContain('missing retry gate review');
    expect(admission([stage({ id: 'work' }), { ...repair, depends_on: ['work'], retry_to: ['work'] }]).errors.map(error => typeof error === 'string' ? error : error.message).join(';')).toContain('work is not declared is_gate: true');
  });

  it('keeps terminal production with an ordinary finalizer rather than a gate or repair', () => {
    const work = stage({ id: 'work', role: 'coder', scope: ['src/work.ts'] });
    const review = stage({ id: 'review', role: 'qa', is_gate: true, depends_on: ['work'] });
    const repair = stage({ id: 'repair', scope: ['src/work.ts'], depends_on: ['review'], retry_to: ['review'] });
    const finish = stage({ id: 'finish', scope: ['docs/final.md'], depends_on: ['work', 'review'] });
    const terminalStates = { complete: { paths: ['docs/final.md'] } };
    const ordinary = admission([work, review, repair, finish], { terminalStates });
    expect(ordinary.pass, ordinary.errors.map(error => typeof error === 'string' ? error : error.message).join(';')).toBe(true);
    expect(ordinary.terminalOwners).toEqual({ 'docs/final.md': 'finish' });
    for (const owner of [
      stage({ ...finish, role: 'qa', is_gate: true }),
      { ...finish, retry_to: ['review'] },
    ]) {
      const rejected = admission([work, review, repair, owner], { terminalStates });
      expect(rejected.pass).toBe(false);
      expect(rejected.errors.map(error => typeof error === 'string' ? error : error.message).join(';')).toContain('expected exactly one final producer, found 0');
    }
  });

  it('derives canonical gate production for static, dynamic and retry-promoted gates while requiring the published verdict', () => {
    const empty = { version: 1, produces: [], reads: [], groups: [] };
    const dynamic = parseDispatchedStageConfig({ id: 'audit', role: 'qa', is_gate: true, artifact_contract: empty });
    const omitted = parseDispatchedStageConfig({ id: 'audit', role: 'qa', is_gate: true });
    const configured = normalizeStageContracts([StageConfigSchema.parse({ id: 'audit', role: 'qa', is_gate: true, artifact_contract: empty })])[0];
    const promoted = stage({ id: 'audit', role: 'qa', artifact_contract: empty });
    const repair = stage({ id: 'repair', depends_on: ['audit'], retry_to: ['audit'] });
    normalizeStageContracts([promoted, repair]);
    for (const gate of [dynamic, omitted, configured, promoted]) {
      expect(gate.artifact_contract?.produces).toEqual([{ id: 'verdict', root: 'run', path: 'verdict_audit.json', kind: 'file', nonempty: false }]);
      expect(admission([gate, repair]).pass).toBe(true);
    }
    const collisions = parseDispatchedStageConfig({ id: 'audit', role: 'qa', is_gate: true, artifact_contract: {
      ...empty, produces: [{ id: 'verdict', root: 'project', path: 'docs/report.md' }, { id: 'verdict_1', root: 'run', path: 'notes.md' }],
    } });
    expect(collisions.artifact_contract?.produces.at(-1)?.id).toBe('verdict_2');
    expect(admission([collisions, repair]).pass).toBe(true);
    const reader = stage({ id: 'reader', depends_on: ['audit'], artifact_contract: artifacts([], [{ id: 'review', root: 'run', path: 'verdict_audit.json', source: { kind: 'stage', stage: 'audit', artifact: 'verdict' } }]) });
    expect(admission([dynamic, repair, reader]).pass).toBe(true);
    const root = temporaryRoot(), projectDir = join(root, 'project'), runDir = join(root, 'run');
    mkdirSync(projectDir); mkdirSync(runDir);
    const input = { stageId: dynamic.id, template: '', isGate: true, artifactContract: dynamic.artifact_contract, projectDir, runDir };
    expect(inspectStageArtifactContract(input).violations[0]?.reason).toContain('ARTIFACT_OUTPUT_ABSENT');
    writeFileSync(join(runDir, 'verdict_audit.json'), '{"pass":true}');
    const observed = inspectStageArtifactContract({ ...input, writes: ['run:verdict_audit.json'] });
    expect(observed.violations).toEqual([]);
    expect(observed.observations).toEqual([expect.objectContaining({ path: join(runDir, 'verdict_audit.json'), fresh: true, bytes: 13 })]);
  });

  it('keeps framework research provenance separate from planner path estimates', () => {
    const research = researchConfig();
    const report = admission([stage({ id: 'writer', scope: ['artifacts/**'] })], { research });
    expect(report.pass, report.errors.map(error => typeof error === 'string' ? error : error.message).join('; ')).toBe(true);
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
    const gate = stage({ artifact_contract: artifacts([{ id: 'verdict', root: 'run', path: "verdict_qa.json" }], [], []),
      id: 'qa', role: 'qa', is_gate: true, criterion_refs: [criterionId],
      depends_on: ['work'], dependency_reasons: { work: 'Judges the completed work.' },
    });
    const criteria = {
      version: 1 as const,
      briefDigest: 'fixture-digest',
      criteria: [{ id: criterionId, text: 'Judge the work.', line: 1, section: 'Report' }],
    };
    const repair = stage({ id: 'repair', depends_on: ['qa'], dependency_reasons: { qa: 'Correct rejected work.' }, retry_to: ['qa'] });
    const admitted = admission([work, gate, repair], { criteria });
    const noWorker = admission([{ ...gate, depends_on: [], dependency_reasons: {} }, repair], { criteria });
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

    expect(admitted.pass, admitted.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toBe(true);
    expect(noWorker.pass, noWorker.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toBe(true);
    expect(noGate.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('not assigned to a gate');
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
    expect(incomplete.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('do not cover ordinary quiescence (work.status=complete)');
    expect(covering.pass, covering.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toBe(true);
    expect(impossible.pass).toBe(false);
    expect(impossible.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('status literal "invented" cannot occur');
  });

  it('authorizes only declared output leaves and trees inside a preserved input, including aliases', () => {
    const projectDir = join(temporaryRoot(), 'project');
    mkdirSync(join(projectDir, 'fixtures', 'source'), { recursive: true });
    writeFileSync(join(projectDir, 'fixtures', 'source', 'evidence.txt'), 'preserved evidence\n');
    symlinkSync('fixtures/source', join(projectDir, 'alias'));
    const declaredInputs = resolveImmutableEvidenceBindings(projectDir, [
      '---', 'inputs: [{path: fixtures/source, frozen: true}]', 'outputs:',
      '  - path: fixtures/source/report.md',
      '  - path: fixtures/source/generated', '    type: directory',
      '---', '# Goal', 'Keep `fixtures/source` frozen. Produce the declared report and generated tree.',
    ].join('\n'));
    for (const scope of ['fixtures/source/report.md', 'fixtures/source/', 'fixtures/source/**', '**']) {
      expect(!firstImmutableEvidenceConflict(['fixtures/source/report.md'], declaredInputs, projectDir), scope).toBe(true);
    }
    for (const path of ['fixtures/source/generated/round/result.json', 'alias/generated/index.json']) {
      expect(!firstImmutableEvidenceConflict([path], declaredInputs, projectDir), path).toBe(true);
    }
    expect(!firstImmutableEvidenceConflict(['alias/report.md'], declaredInputs, projectDir)).toBe(true);
    for (const path of ['fixtures/source/evidence.txt', 'fixtures/source/undeclared.md',
      'alias/evidence.txt', 'alias/report.md/child.txt', 'fixtures/source/generated-peer/new.json']) {
      expect(!firstImmutableEvidenceConflict([path], declaredInputs, projectDir), path).toBe(false);
    }
    expect(scopeContainsPath([], 'fixtures/source/report.md', projectDir, declaredInputs)).toBe(false);
    expect(scopeContainsPath(['fixtures/other/**'], 'fixtures/source/report.md')).toBe(false);
  });

  it('keeps an output directory alias from authorizing preserved siblings outside its canonical tree', () => {
    const projectDir = join(temporaryRoot(), 'project');
    mkdirSync(join(projectDir, 'fixtures', 'source', 'generated'), { recursive: true });
    mkdirSync(join(projectDir, 'fixtures', 'source', 'evidence'), { recursive: true });
    writeFileSync(join(projectDir, 'fixtures', 'source', 'evidence', 'keep.txt'), 'preserved evidence\n');
    symlinkSync('../evidence', join(projectDir, 'fixtures', 'source', 'generated', 'alias'));
    const declaredInputs = resolveImmutableEvidenceBindings(projectDir, [
      '---', 'inputs: [{path: fixtures/source, frozen: true}]', 'outputs:',
      '  - path: fixtures/source/generated', '    type: directory',
      '---', '# Goal', 'Keep `fixtures/source` frozen. Produce the declared generated tree.',
    ].join('\n'));

    expect(!firstImmutableEvidenceConflict(['fixtures/source/generated/result.json'], declaredInputs, projectDir)).toBe(true);
    for (const path of ['fixtures/source/evidence/keep.txt', 'fixtures/source/generated/alias/keep.txt']) {
      expect(!firstImmutableEvidenceConflict([path], declaredInputs, projectDir), path).toBe(false);
    }
  });

  it('allows replacing a declared output alias while refusing a retargeted preserved input', () => {
    const projectDir = join(temporaryRoot(), 'project');
    const source = join(projectDir, 'fixtures', 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'prior.md'), 'previous output\n');
    writeFileSync(join(source, 'evidence.md'), 'preserved evidence\n');
    symlinkSync('prior.md', join(source, 'report.md'));
    const declaredInputs = resolveImmutableEvidenceBindings(projectDir, [
      '---', 'inputs: [{path: fixtures/source, frozen: true}]', 'outputs:',
      '  - path: fixtures/source/report.md', '    on_existing: replace',
      '---', '# Goal', 'Keep `fixtures/source` frozen. Replace the declared report.',
    ].join('\n'));
    expect(!firstImmutableEvidenceConflict(['fixtures/source/report.md'], declaredInputs, projectDir)).toBe(true);

    rmSync(join(source, 'report.md'));
    symlinkSync('evidence.md', join(source, 'report.md'));
    expect(!firstImmutableEvidenceConflict(['fixtures/source/report.md'], declaredInputs, projectDir)).toBe(false);
    expect(!firstImmutableEvidenceConflict(['fixtures/source/evidence.md'], declaredInputs, projectDir)).toBe(false);

    rmSync(join(source, 'report.md'));
    writeFileSync(join(source, 'report.md'), 'replacement output\n');
    expect(!firstImmutableEvidenceConflict(['fixtures/source/report.md'], declaredInputs, projectDir)).toBe(true);
    expect(!firstImmutableEvidenceConflict(['fixtures/source/evidence.md'], declaredInputs, projectDir)).toBe(false);
  });
});
