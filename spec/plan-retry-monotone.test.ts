import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { extractBriefCriteria, type BriefCriteriaArtifact } from '../src/brief-criteria.js';
import {
  inspectDispatchAdmission,
  inspectRealityCheckReachability,
  parseDispatchedStageConfig,
  resolveDispatchDependencies,
  runWorkflow,
  type StageConfig,
  type WorkflowConfig,
} from '../src/scheduler.js';
import {
  mergePlanRetryPair,
  planRetryRequirement,
  preparePlanRetryCandidate,
  readMonotonePlanRetryState,
  recordPlanRetryRefusal,
  type PlanRetryPair,
  type PlanRetryRequirement,
} from '../src/plan-retry-monotone.js';
import type {
  CriterionDischargeRecord,
  ResearchConfig,
  TerminalStatesConfig,
} from '../src/store.js';
import { runDir } from '../src/store.js';

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/retry-monotone/', import.meta.url));

interface FixtureContext {
  version: 1;
  sourceRunId: string;
  sourceRoot: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  taskBrief: {
    path: 'task_brief.md';
    bytes: number;
    sha256: string;
    sourcePath: 'task_brief.md';
  };
  recoveredRealityChecks: Array<{
    path: string;
    bytes: number;
    sha256: string;
    sourcePath: 'stages/plan/live.log';
  }>;
}

interface ArchivedAdmission {
  pass: boolean;
  errors: string[];
  terminalOwners: Record<string, string>;
  criterionGateRefs?: Record<string, string[]>;
  dischargedCriteria?: CriterionDischargeRecord[];
}

const fixtureConfig: Record<string, {
  terminalStates: TerminalStatesConfig;
  research: ResearchConfig;
}> = {
  'owner-criterion': {
    terminalStates: {
      shipped: { paths: ['docs/happymj_explore6/ship_report.md'] },
      ceiling_hit: { paths: ['docs/happymj_explore6/ceiling_report.md'] },
      escalated: { paths: ['docs/happymj_explore6/escalation_note.md'] },
    },
    research: {
      baseline: 0,
      policy: 'greedy_stack',
      higherIsBetter: true,
      resultFile: 'docs/happymj_explore6/round_result.json',
      reportDir: 'docs/happymj_explore6',
      stop: { beat: 0.05, maxRounds: 6, haltAfterNoImprovement: 4 },
    },
  },
  'check-escape': {
    terminalStates: {
      shipped: { paths: ['docs/happymj_incumbent/ship_report.md'] },
      ceiling_hit: { paths: ['docs/happymj_incumbent/ceiling_report.md'] },
      escalated: { paths: ['docs/happymj_incumbent/escalation_note.md'] },
    },
    research: {
      baseline: 0,
      policy: 'greedy_stack',
      higherIsBetter: true,
      resultFile: 'docs/happymj_incumbent/round_result.json',
      reportDir: 'docs/happymj_incumbent',
      stop: { beat: 0.05, maxRounds: 6, haltAfterNoImprovement: 4 },
    },
  },
};

function fixturePath(name: string, ...parts: string[]): string {
  return join(FIXTURE_ROOT, name, ...parts);
}

function dispatch(name: string, attempt: number): string {
  return readFileSync(fixturePath(name, `attempt_${attempt}`, 'dispatch.yaml'), 'utf8');
}

function realityChecks(name: string, attempt: number): string {
  return readFileSync(fixturePath(name, `attempt_${attempt}`, 'reality_checks.md'), 'utf8');
}

function admission(name: string, attempt: number): ArchivedAdmission {
  return JSON.parse(readFileSync(
    fixturePath(name, `attempt_${attempt}`, 'dispatch_admission.json'),
    'utf8',
  )) as ArchivedAdmission;
}

function criteria(name: string): BriefCriteriaArtifact {
  return JSON.parse(readFileSync(fixturePath(name, 'brief_criteria.json'), 'utf8')) as BriefCriteriaArtifact;
}

function fixtureBrief(name: string): string {
  return readFileSync(fixturePath(name, 'task_brief.md'), 'utf8');
}

function parsedStages(markdown: string): StageConfig[] {
  const parsed = parseYaml(markdown) as unknown;
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).stages)
      ? (parsed as { stages: unknown[] }).stages
      : [];
  const stages = items.map((item) => parseDispatchedStageConfig(item));
  resolveDispatchDependencies(stages, 'plan');
  return stages;
}

function parsedChecks(markdown: string): Array<Record<string, unknown>> {
  const body = /```(?:ya?ml)?\s*\n([\s\S]*?)\n```/i.exec(markdown)?.[1] ?? markdown;
  const parsed = parseYaml(body) as { checks?: unknown } | undefined;
  return Array.isArray(parsed?.checks)
    ? parsed.checks.filter((check): check is Record<string, unknown> => Boolean(check) && typeof check === 'object' && !Array.isArray(check))
    : [];
}

function replayAdmission(name: string, markdown: string, sourceAttempt: number) {
  const config = fixtureConfig[name];
  const archived = admission(name, sourceAttempt);
  return inspectDispatchAdmission({
    dispatched: parsedStages(markdown),
    baseStages: [],
    dispatchStageId: 'plan',
    terminalStates: config.terminalStates,
    research: config.research,
    criteria: criteria(name),
    criterionDischarges: archived.dischargedCriteria,
  });
}

function terminalOwnerFacts(report: ArchivedAdmission): PlanRetryRequirement[] {
  return Object.entries(report.terminalOwners).map(([path, owner]) => ({
    ...planRetryRequirement(`terminal_states path ${path}: admitted owner exists`),
    detail: `terminal path ${path} retains scoped owner ${owner}`,
  }));
}

describe('quarantined retry evidence identity and before-change replay', () => {
  for (const fixture of ['owner-criterion', 'check-escape']) {
    it(`${fixture} is pinned byte-for-byte by length and SHA-256`, () => {
      const context = JSON.parse(readFileSync(fixturePath(fixture, 'context.json'), 'utf8')) as FixtureContext;
      expect(context).toMatchObject({ version: 1, sourceRoot: 'dispatch_rejections' });
      expect(context.files).toHaveLength(9);
      for (const expected of context.files) {
        const bytes = readFileSync(fixturePath(fixture, expected.path));
        expect(bytes.byteLength, expected.path).toBe(expected.bytes);
        expect(createHash('sha256').update(bytes).digest('hex'), expected.path).toBe(expected.sha256);
      }
      const briefBytes = readFileSync(fixturePath(fixture, context.taskBrief.path));
      expect(briefBytes.byteLength).toBe(context.taskBrief.bytes);
      expect(createHash('sha256').update(briefBytes).digest('hex')).toBe(context.taskBrief.sha256);
      expect(context.taskBrief.sourcePath).toBe('task_brief.md');
      expect(context.recoveredRealityChecks).toHaveLength(3);
      for (const expected of context.recoveredRealityChecks) {
        const bytes = readFileSync(fixturePath(fixture, expected.path));
        expect(bytes.byteLength, expected.path).toBe(expected.bytes);
        expect(createHash('sha256').update(bytes).digest('hex'), expected.path).toBe(expected.sha256);
        expect(expected.sourcePath).toBe('stages/plan/live.log');
      }
    });
  }

  it('replays the recorded owner/gate oscillation without treating the brief mismatch as fact', () => {
    const reports = [1, 2, 3].map((attempt) => admission('owner-criterion', attempt));
    expect(reports.map((report) => Object.keys(report.terminalOwners).length)).toEqual([3, 3, 0]);
    expect(reports.map((report) => Object.keys(report.criterionGateRefs ?? {}).length)).toEqual([1, 0, 1]);
    expect(reports[0].errors).toEqual([
      expect.stringContaining('references mutable optional result path'),
    ]);
    expect(reports[1].errors).toHaveLength(3);
    expect(reports[1].errors.every((error) => error.includes('not assigned to a gate'))).toBe(true);
    expect(reports[2].errors).toHaveLength(3);
    expect(reports[2].errors.every((error) => error.includes('expected exactly one scoped owner, found 0'))).toBe(true);
  });

  it('replays the recorded check-recomposition refusals while topology itself stays admissible', () => {
    const reports = [1, 2, 3].map((attempt) => admission('check-escape', attempt));
    expect(reports.map((report) => Object.keys(report.terminalOwners).length)).toEqual([3, 3, 3]);
    expect(reports.map((report) => report.errors.length)).toEqual([1, 10, 1]);
    expect(reports[0].errors[0]).toContain('shipped_result_survives_confirmation');
    expect(reports[1].errors.every((error) => error.includes('shipped_manifest_records_positive_round'))).toBe(true);
    expect(reports[2].errors[0]).toContain('run_manifest_round_labels_unique');
    for (const attempt of [1, 2, 3]) expect(replayAdmission('check-escape', dispatch('check-escape', attempt), attempt).pass).toBe(true);
  });
});

describe('after-change historical replay', () => {
  it('retains attempt-2 owners while applying attempt-3 gate repair, producing an admitted union', () => {
    const second = admission('owner-criterion', 2);
    const merged = mergePlanRetryPair(
      { dispatch: dispatch('owner-criterion', 2) },
      { dispatch: dispatch('owner-criterion', 3) },
      second.errors.map((error) => planRetryRequirement(error)),
      terminalOwnerFacts(second),
    );
    const stageIds = parsedStages(merged.pair.dispatch).map((stage) => stage.id);
    expect(stageIds).toEqual(expect.arrayContaining([
      'write_ship',
      'write_ceiling',
      'write_escalate',
      'verify_plan',
    ]));
    expect(replayAdmission('owner-criterion', merged.pair.dispatch, 2)).toMatchObject({ pass: true, errors: [] });
  });

  it('starts from exact attempt 1 and admits once its sole check defect is repaired', () => {
    const firstDispatch = dispatch('owner-criterion', 1);
    const first = admission('owner-criterion', 1);
    const repaired = mergePlanRetryPair(
      { dispatch: firstDispatch, realityChecks: realityChecks('owner-criterion', 1) },
      { dispatch: dispatch('owner-criterion', 2), realityChecks: realityChecks('owner-criterion', 2) },
      first.errors.map((error) => planRetryRequirement(error)),
    );
    expect(repaired.pair.dispatch).toBe(firstDispatch);
    expect(repaired.pair.realityChecks).toBe(realityChecks('owner-criterion', 2));
    expect(replayAdmission('owner-criterion', repaired.pair.dispatch, 1)).toMatchObject({ pass: true, errors: [] });
    const reachabilityRoot = mkdtempSync(join(tmpdir(), 'fc-retry-reachability-'));
    try {
      expect(inspectRealityCheckReachability({
        markdown: repaired.pair.realityChecks!,
        projectDir: reachabilityRoot,
        stages: parsedStages(repaired.pair.dispatch),
        terminalStates: fixtureConfig['owner-criterion'].terminalStates,
        research: fixtureConfig['owner-criterion'].research,
      })).toEqual([]);
    } finally {
      rmSync(reachabilityRoot, { recursive: true, force: true });
    }
  });

  it('starts from the second exact attempt-1 proposal, repairs the check, and locks its bytes thereafter', () => {
    const firstDispatch = dispatch('check-escape', 1);
    const first = admission('check-escape', 1);
    const correctedChecks = realityChecks('check-escape', 2);
    const repaired = mergePlanRetryPair(
      { dispatch: firstDispatch, realityChecks: realityChecks('check-escape', 1) },
      { dispatch: dispatch('check-escape', 2), realityChecks: correctedChecks },
      first.errors.map((error) => planRetryRequirement(error)),
    );
    expect(repaired.pair.dispatch).toBe(firstDispatch);
    const stages = parsedStages(repaired.pair.dispatch);
    expect(replayAdmission('check-escape', repaired.pair.dispatch, 1).pass).toBe(true);
    const reachabilityRoot = mkdtempSync(join(tmpdir(), 'fc-retry-reachability-'));
    try {
      expect(inspectRealityCheckReachability({
        markdown: repaired.pair.realityChecks!,
        projectDir: reachabilityRoot,
        stages,
        terminalStates: fixtureConfig['check-escape'].terminalStates,
        research: fixtureConfig['check-escape'].research,
      })).toEqual([]);
    } finally {
      rmSync(reachabilityRoot, { recursive: true, force: true });
    }

    const unrelatedRepair = mergePlanRetryPair(
      repaired.pair,
      {
        dispatch: dispatch('check-escape', 3),
        realityChecks: realityChecks('check-escape', 3),
      },
      [planRetryRequirement('criterion synthetic_independent_requirement: not assigned to a gate')],
    );
    expect(unrelatedRepair.pair.realityChecks).toBe(correctedChecks);
    expect(unrelatedRepair.retainedRealityChecks).toBe(true);
  });

  it('retains a passing check definition while a neighbouring failed check is repaired', () => {
    const escapedScript = String.raw`sed -n 's/^\([a-z][a-z]*\)$/\1/p' docs/input.txt`;
    const incumbentChecks = stringifyYaml({
      checks: [
        {
          name: 'broken_optional_result_check',
          type: 'file-exists-nonempty',
          params: { paths: ['docs/happymj_incumbent/round_result.json'] },
        },
        {
          name: 'passing_escaped_check',
          type: 'exec-script-exit-zero',
          params: { script: escapedScript },
        },
      ],
    });
    const proposalChecks = stringifyYaml({
      checks: [
        {
          name: 'broken_optional_result_check',
          type: 'file-exists-nonempty',
          params: { paths: ['docs/happymj_incumbent/run_manifest.json'] },
        },
        {
          name: 'passing_escaped_check',
          type: 'exec-script-exit-zero',
          params: { script: 'regressed slash-parenthesis capture bytes' },
        },
      ],
    });
    const merged = mergePlanRetryPair(
      { dispatch: dispatch('check-escape', 1), realityChecks: incumbentChecks },
      { dispatch: dispatch('check-escape', 2), realityChecks: proposalChecks },
      [planRetryRequirement('reality check "broken_optional_result_check" references mutable optional result path')],
    );
    const checks = parsedChecks(merged.pair.realityChecks!);
    expect(checks.map((check) => check.name)).toEqual([
      'broken_optional_result_check',
      'passing_escaped_check',
    ]);
    expect((checks[0].params as Record<string, unknown>).paths).toEqual([
      'docs/happymj_incumbent/run_manifest.json',
    ]);
    expect((checks[1].params as Record<string, unknown>).script).toBe(escapedScript);
    expect(merged.retainedRealityChecks).toBe(true);
  });

  it('permits an explicitly named duplicate terminal owner to be removed', () => {
    const owner = (id: string) => ({
      id,
      role: 'coder',
      depends_on: [],
      dependency_reasons: {},
      scope: ['docs/final.md'],
      criterion_refs: [],
      prompt_template: `write from ${id}`,
    });
    const incumbent = stringifyYaml({ stages: [owner('first_owner'), owner('second_owner')] });
    const proposal = stringifyYaml({
      stages: [owner('first_owner')],
      retry_remove_stages: ['second_owner'],
    });
    const requirement = planRetryRequirement(
      'terminal_states path docs/final.md: expected exactly one scoped owner, found 2 (first_owner, second_owner)',
    );
    const merged = mergePlanRetryPair({ dispatch: incumbent }, { dispatch: proposal }, [requirement]);
    const stages = parsedStages(merged.pair.dispatch);
    expect(stages.map((stage) => stage.id)).toEqual(['first_owner']);
    expect(inspectDispatchAdmission({
      dispatched: stages,
      baseStages: [],
      dispatchStageId: 'plan',
      terminalStates: { complete: { paths: ['docs/final.md'] } },
    })).toMatchObject({ pass: true, errors: [] });
  });
});

describe('bounded refusal and cycle mechanics', () => {
  const temporaryRoots: string[] = [];
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function root(): string {
    const value = mkdtempSync(join(tmpdir(), 'fc-monotone-retry-'));
    temporaryRoots.push(value);
    return value;
  }

  function candidate(label: string): string {
    return stringifyYaml({
      stages: [{
        id: 'work',
        role: 'coder',
        depends_on: [],
        dependency_reasons: {},
        scope: [`docs/${label}.md`],
        criterion_refs: [],
        prompt_template: label,
      }],
    });
  }

  const impossible = planRetryRequirement('work.scope: impossible named requirement remains unsatisfied');

  function refuse(
    runRoot: string,
    attemptIndex: number,
    bytes: string,
    maxAttempts = 3,
    requirement: PlanRetryRequirement = impossible,
  ) {
    writeFileSync(join(runRoot, 'dispatch.yaml'), bytes, 'utf8');
    const prepared = preparePlanRetryCandidate({
      runDirPath: runRoot,
      stageId: 'plan',
      iteration: 1,
      attemptIndex,
    });
    return recordPlanRetryRefusal({
      runDirPath: runRoot,
      prepared,
      maxAttempts,
      unsatisfied: [requirement],
    });
  }

  it('stops an identical refusal and names the requirement', () => {
    const runRoot = root();
    expect(refuse(runRoot, 1, candidate('a')).stop).toBe(false);
    const second = refuse(runRoot, 2, candidate('a'));
    expect(second).toMatchObject({ stop: true, disposition: 'identical_refusal' });
    expect(second.reason).toContain(impossible.id);
    expect(second.reason).toContain('impossible named requirement');
  });

  it('stops A/B/A as a cycle inside the configured bound', () => {
    const runRoot = root();
    expect(refuse(runRoot, 1, candidate('a')).stop).toBe(false);
    expect(refuse(runRoot, 2, candidate('b')).stop).toBe(false);
    const third = refuse(runRoot, 3, candidate('a'));
    expect(third).toMatchObject({ stop: true, disposition: 'cycle_refusal' });
    expect(third.reason).toContain(impossible.id);
  });

  it('exhausts distinct refusals at the bound and names the requirement', () => {
    const runRoot = root();
    expect(refuse(runRoot, 1, candidate('a')).stop).toBe(false);
    expect(refuse(runRoot, 2, candidate('b')).stop).toBe(false);
    const third = refuse(runRoot, 3, candidate('c'));
    expect(third.stop).toBe(true);
    expect(third.state.terminal?.disposition).toBe('attempts_exhausted');
    expect(third.reason).toContain(impossible.id);
    expect(third.state.attempts).toHaveLength(3);
  });

  it('persists the first refusal bound even if a later caller supplies a larger value', () => {
    const runRoot = root();
    expect(refuse(runRoot, 1, candidate('a'), 2).stop).toBe(false);
    const second = refuse(runRoot, 2, candidate('b'), 99);
    expect(second.stop).toBe(true);
    expect(second.state.maxAttempts).toBe(2);
    expect(second.state.terminal?.disposition).toBe('attempts_exhausted');
    const afterTerminal = refuse(runRoot, 3, candidate('c'), 999);
    expect(afterTerminal.stop).toBe(true);
    expect(afterTerminal.state.maxAttempts).toBe(2);
    expect(afterTerminal.state.attempts).toHaveLength(2);
  });

  it('uses stable requirement IDs rather than refreshed diagnostic prose for repeats', () => {
    const runRoot = root();
    const first = planRetryRequirement(
      'work.scope: first rendering',
      'admission',
      'stage:work:scope',
    );
    const refreshed = planRetryRequirement(
      'work.scope: refreshed rendering of the same refusal',
      'admission',
      'stage:work:scope',
    );
    expect(refuse(runRoot, 1, candidate('a'), 3, first).stop).toBe(false);
    const second = refuse(runRoot, 2, candidate('a'), 3, refreshed);
    expect(second).toMatchObject({ stop: true, disposition: 'identical_refusal' });
    expect(second.reason).toContain('stage:work:scope');
  });

  it('advances a newly exposed requirement, then quarantines recurrence of the resolved one', () => {
    const runRoot = root();
    const scopeFailure = planRetryRequirement('work.scope.0: invalid scope syntax');
    const dependencyFailure = planRetryRequirement('work.depends_on: unknown stage "missing"');
    const firstCandidate = stringifyYaml({
      stages: [{
        id: 'work', role: 'coder', depends_on: [], dependency_reasons: {},
        scope: ['bad scope'], criterion_refs: [], prompt_template: 'first',
      }],
    });
    expect(refuse(runRoot, 1, firstCandidate, 4, scopeFailure).stop).toBe(false);

    const secondCandidate = stringifyYaml({
      stages: [{
        id: 'work', role: 'coder', depends_on: ['missing'],
        dependency_reasons: { missing: 'latent topology defect' },
        scope: ['docs/work.md'], criterion_refs: [], prompt_template: 'second',
      }],
    });
    const second = refuse(runRoot, 2, secondCandidate, 4, dependencyFailure);
    expect(second).toMatchObject({ stop: false, disposition: 'incumbent_advanced' });
    expect(second.state.unsatisfied).toEqual([dependencyFailure]);
    expect(second.state.satisfied.map((requirement) => requirement.id)).toContain(scopeFailure.id);

    const thirdCandidate = stringifyYaml({
      stages: [{
        id: 'work', role: 'coder', depends_on: [], dependency_reasons: {},
        scope: ['bad scope'], criterion_refs: [], prompt_template: 'third',
      }],
    });
    const third = refuse(runRoot, 3, thirdCandidate, 4, scopeFailure);
    expect(third).toMatchObject({ stop: false, disposition: 'regression_quarantined' });
    expect(third.state.unsatisfied).toEqual([dependencyFailure]);
  });

  it('advances past a newly exposed requirement that the invalid incumbent never satisfied', () => {
    const runRoot = root();
    expect(refuse(runRoot, 1, 'stages: []\n').stop).toBe(false);
    writeFileSync(join(runRoot, 'dispatch.yaml'), candidate('valid-shape'), 'utf8');
    const prepared = preparePlanRetryCandidate({
      runDirPath: runRoot,
      stageId: 'plan',
      iteration: 1,
      attemptIndex: 2,
    });
    const exposed = planRetryRequirement('criterion newly_visible: not assigned to a gate');
    const second = recordPlanRetryRefusal({
      runDirPath: runRoot,
      prepared,
      maxAttempts: 3,
      unsatisfied: [exposed],
    });
    expect(second).toMatchObject({ stop: false, disposition: 'incumbent_advanced' });
    expect(second.state.unsatisfied).toEqual([exposed]);
  });
});

describe('scheduler integration', () => {
  let projectDir: string;
  afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it('accumulates two independent repairs, exposes the incumbent, and runs no work before admission', async () => {
    projectDir = mkdtempSync(join(tmpdir(), `fc-retry-integration-${randomBytes(4).toString('hex')}-`));
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    for (const role of ['planner', 'coder', 'qa']) {
      writeFileSync(join(agentsDir, `${role}.yaml`), [
        `name: ${role}`,
        'description: retry integration role',
        'model: default',
        'reasoning_effort: default',
        'tools: []',
        'prompt: test role',
      ].join('\n'), 'utf8');
    }
    const brief = [
      '---',
      'terminal_states:',
      '  complete:',
      '    paths: [docs/final.md]',
      '---',
      '# Retry integration',
      '',
      '## What the report must show',
      '',
      '1. First independent requirement is covered.',
      '2. Second independent requirement is covered.',
    ].join('\n');
    const workflow: WorkflowConfig = {
      name: 'monotone-retry-integration',
      defaults: { max_iterations: 1 },
      stages: [{
        id: 'plan',
        role: 'planner',
        depends_on: [],
        prompt_template: 'plan the work',
        dynamic_dispatch: true,
        is_gate: false,
        skills: [],
        criterion_refs: [],
      }],
    };
    const planPrompts: string[] = [];
    const calls: string[] = [];
    let planCalls = 0;
    const ok = (output: string): RunResult => ({ output, exitCode: 0, duration_ms: 1 });
    const adapter = {
      async run(prompt: string, _agent: AgentConfig, opts: RunOpts): Promise<RunResult> {
        calls.push(opts.stageId);
        if (opts.stageId === 'plan') {
          planCalls += 1;
          planPrompts.push(prompt);
          const artifact = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')) as BriefCriteriaArtifact;
          const work = {
            id: 'work',
            role: 'coder',
            depends_on: [],
            dependency_reasons: {},
            scope: ['docs/work.md'],
            criterion_refs: artifact.criteria.map((criterion) => criterion.id),
            prompt_template: 'write the work evidence',
          };
          const finalize = {
            id: 'finalize',
            role: 'coder',
            depends_on: ['work'],
            dependency_reasons: { work: 'terminal report consumes completed work' },
            scope: ['docs/final.md'],
            criterion_refs: [],
            prompt_template: 'write the final report',
          };
          const audit = {
            id: 'audit',
            role: 'qa',
            depends_on: ['work'],
            dependency_reasons: { work: 'audit checks the completed work' },
            scope: [],
            criterion_refs: artifact.criteria.map((criterion) => criterion.id),
            is_gate: true,
            prompt_template: 'audit every criterion',
          };
          const stages = planCalls === 1
            ? [work]
            : planCalls === 2
              ? [work, finalize]
              : [work, audit];
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), stringifyYaml({ stages }), 'utf8');
          return ok(`plan attempt ${planCalls}`);
        }
        if (opts.stageId === 'work') {
          mkdirSync(join(projectDir, 'docs'), { recursive: true });
          writeFileSync(join(projectDir, 'docs', 'work.md'), '# work evidence\n', 'utf8');
          return ok('work complete');
        }
        if (opts.stageId === 'audit') {
          const artifact = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')) as BriefCriteriaArtifact;
          writeFileSync(join(opts.runDir, 'verdict_audit.json'), JSON.stringify({
            pass: true,
            reason: 'all criteria passed',
            criteria: Object.fromEntries(artifact.criteria.map((criterion) => [
              criterion.id,
              { status: 'pass', evidence: `verified ${criterion.id}` },
            ])),
          }), 'utf8');
          return ok('audit complete');
        }
        if (opts.stageId === 'finalize') {
          mkdirSync(join(projectDir, 'docs'), { recursive: true });
          writeFileSync(join(projectDir, 'docs', 'final.md'), '# final\n', 'utf8');
          return ok('finalized');
        }
        return ok(`completed ${opts.stageId}`);
      },
      async discuss(): Promise<RunResult> { return ok(''); },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;

    const final = await runWorkflow(
      workflow,
      stringifyYaml(workflow),
      projectDir,
      adapter,
      new Map(),
      undefined,
      agentsDir,
      undefined,
      brief,
      true,
    );

    expect(planCalls).toBe(3);
    expect(calls.slice(0, 3)).toEqual(['plan', 'plan', 'plan']);
    expect(calls).toEqual(['plan', 'plan', 'plan', 'work', 'audit', 'finalize', '_summary']);
    expect(final.status).toBe('complete');
    expect(planPrompts[1]).toContain('MONOTONE PLAN-RETRY INCUMBENT');
    expect(planPrompts[1]).toContain('terminal-owner:docs/final.md');
    expect(planPrompts[2]).toContain('criterion:');
    expect(planPrompts[2]).toContain('Already-satisfied requirements locked by the scheduler');
    const runRoot = runDir(projectDir, final.runId);
    const state = readMonotonePlanRetryState(runRoot, 'plan', 1);
    expect(state?.terminal?.disposition).toBe('admitted');
    expect(state?.attempts.map((attempt) => attempt.disposition)).toEqual([
      'incumbent_initialized',
      'incumbent_advanced',
      'admitted',
    ]);
  }, 60_000);

  for (const fixture of ['owner-criterion', 'check-escape']) {
    it(`replays ${fixture} exact proposal/check snapshots through the scheduler and admits within the bound`, async () => {
      projectDir = mkdtempSync(join(tmpdir(), `fc-retry-archive-${fixture}-${randomBytes(4).toString('hex')}-`));
      const agentsDir = join(projectDir, 'config', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      for (const role of ['planner', 'campaign_scout', 'campaign_planner', 'coder', 'qa', 'doc_writer']) {
        writeFileSync(join(agentsDir, `${role}.yaml`), [
          `name: ${role}`,
          'description: archived scheduler replay role',
          'model: default',
          'reasoning_effort: default',
          'tools: []',
          'prompt: replay role',
        ].join('\n'), 'utf8');
      }
      const brief = fixtureBrief(fixture);
      expect(extractBriefCriteria(brief).criteria.map((criterion) => criterion.id)).toEqual(
        criteria(fixture).criteria.map((criterion) => criterion.id),
      );
      const workflow: WorkflowConfig = {
        name: `archived-${fixture}-scheduler-replay`,
        defaults: { max_iterations: 1 },
        stages: [{
          id: 'plan',
          role: 'planner',
          depends_on: [],
          prompt_template: 'replay the archived plan candidates',
          dynamic_dispatch: true,
          is_gate: false,
          skills: [],
          criterion_refs: [],
        }],
      };
      const gateIds = new Set(parsedStages(dispatch(fixture, 1))
        .filter((stage) => stage.is_gate)
        .map((stage) => stage.id));
      const planPrompts: string[] = [];
      const calls: string[] = [];
      let planCalls = 0;
      const ok = (output: string): RunResult => ({ output, exitCode: 0, duration_ms: 1 });
      const adapter = {
        async run(prompt: string, _agent: AgentConfig, opts: RunOpts): Promise<RunResult> {
          calls.push(opts.stageId);
          if (opts.stageId === 'plan') {
            planCalls += 1;
            planPrompts.push(prompt);
            const archivedAttempt = Math.min(planCalls, 3);
            writeFileSync(join(opts.runDir, 'dispatch.yaml'), dispatch(fixture, archivedAttempt), 'utf8');
            writeFileSync(
              join(opts.runDir, 'reality_checks.md'),
              realityChecks(fixture, archivedAttempt),
              'utf8',
            );
            return ok(`replayed exact archived candidate ${archivedAttempt}`);
          }
          if (gateIds.has(opts.stageId)) {
            const artifact = JSON.parse(readFileSync(
              join(opts.runDir, 'brief_criteria.json'),
              'utf8',
            )) as BriefCriteriaArtifact;
            writeFileSync(join(opts.runDir, `verdict_${opts.stageId}.json`), JSON.stringify({
              pass: true,
              reason: 'scheduler replay gate passed',
              criteria: Object.fromEntries(artifact.criteria.map((criterion) => [
                criterion.id,
                { status: 'pass', evidence: `replay verified ${criterion.id}` },
              ])),
            }), 'utf8');
          }
          return ok(`completed ${opts.stageId}`);
        },
        async discuss(): Promise<RunResult> { return ok(''); },
        spawnDiscuss() { throw new Error('unused'); },
        async spawnInteractive() { throw new Error('unused'); },
      } as unknown as Adapter;

      const final = await runWorkflow(
        workflow,
        stringifyYaml(workflow),
        projectDir,
        adapter,
        new Map(),
        undefined,
        agentsDir,
        undefined,
        brief,
        true,
      );

      expect(planCalls).toBeGreaterThan(1);
      expect(planCalls).toBeLessThanOrEqual(3);
      expect(calls.slice(0, planCalls)).toEqual(Array(planCalls).fill('plan'));
      // The replay intentionally produces no research result; its terminal
      // condition is the admitted dispatch, after which the outer campaign is
      // expected to remain incomplete in this isolated harness.
      expect(final.status).toBe('incomplete');
      expect(planPrompts[1]).toContain('MONOTONE PLAN-RETRY INCUMBENT');
      const runRoot = runDir(projectDir, final.runId);
      const state = readMonotonePlanRetryState(runRoot, 'plan', 1);
      expect(state?.terminal?.disposition).toBe('admitted');
      const historicalError = admission(fixture, 1).errors[0];
      const currentErrors = state?.attempts[0].unsatisfied.map((requirement) => requirement.detail) ?? [];
      expect(currentErrors).toHaveLength(1);
      expect(currentErrors[0]).toContain(historicalError.split(';')[0]);
      expect(currentErrors[0]).toContain('.no_candidate.json');
      expect(currentErrors[0]).toContain('never writes');
      expect(currentErrors[0]).toContain('always-emitted framework manifest');
      expect(currentErrors[0]).toContain('unconditional producer');
      expect(JSON.parse(readFileSync(join(runRoot, 'dispatch_admission.json'), 'utf8'))).toMatchObject({
        pass: true,
        errors: [],
      });
      expect(state?.attempts).toHaveLength(planCalls);
      for (let index = 0; index < planCalls; index += 1) {
        const recorded = state!.attempts[index].proposed;
        expect(readFileSync(join(runRoot, recorded.dispatchPath), 'utf8')).toBe(dispatch(fixture, index + 1));
        expect(readFileSync(join(runRoot, recorded.realityChecksPath!), 'utf8')).toBe(
          realityChecks(fixture, index + 1),
        );
      }
    }, 60_000);
  }
});
