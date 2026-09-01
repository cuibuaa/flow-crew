import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveCriterionDischarges,
  inspectDispatchAdmission,
  inspectRealityCheckReachability,
  parseDispatchedStageConfig,
  promoteAdmittedRealityChecks,
  recoverVerifiedResearchSettlement,
  restoreAdmittedRealityChecks,
  validatedCriterionDischarges,
} from '../src/scheduler.js';
import {
  STAGE_STATUS,
  fcGlobalDir,
  setFcGlobalDir,
  type CriterionDischargeRecord,
  type StageEvidenceRecord,
  type StoreState,
} from '../src/store.js';

const fixtureRoot = join(import.meta.dirname, 'fixtures', 'settlement-reachable');
const recorded = JSON.parse(readFileSync(join(fixtureRoot, 'recorded_final_state.json'), 'utf8')) as {
  source: { runId: string; files: Record<string, { bytes: number; sha256: string }> };
  recordedFailure: { status: string; iteration: number; admissionPass: boolean; reasonContains: string };
  briefDigest: string;
  criterionId: string;
  research: StoreState['research'];
  terminalStates: StoreState['terminalStates'];
  manifestStop: { consecutive_no_improvement: number; configured_halt_after_no_improvement: number };
  verdict: Record<string, unknown>;
  metric: Record<string, unknown>;
};
const recordedArchivedVerdictPath = [
  'stage_evidence',
  'iteration_8',
  Buffer.from('audit_terminal').toString('base64url'),
  'verdict.json',
].join('/');

const expectedRecordedSourceFiles = {
  'run.json': {
    bytes: 331400,
    sha256: '26b47912c63ec0ada3adf831fafdef2a6b9ee7760e1414f308eb244c38ead0c1',
  },
  'dispatch_admission.json': {
    bytes: 3107,
    sha256: 'ffeb5035a12ee5db735b6c346593971a68f35e37b1efca43211a101344c47b68',
  },
  'reality_checks.md': {
    bytes: 1238,
    sha256: 'e234bd2f6322308f2004156981aa5424b7abd115451a4419a492011c784f53cf',
  },
  'stages/audit_terminal/metric.json': {
    bytes: 851,
    sha256: '46bed43eaea2e45266305dba94d004c67b6cad0230e95bf5c82345c50dded3cd',
  },
  [recordedArchivedVerdictPath]: {
    bytes: 3541,
    sha256: 'a138cb858e76c66c95de067de5f6eddae2354faa82b1d4c743be4820fc0d8ad7',
  },
};

const originalFcHome = fcGlobalDir();
const temporaryRoots: string[] = [];

afterEach(() => {
  setFcGlobalDir(originalFcHome);
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-settlement-reachable-'));
  temporaryRoots.push(root);
  return root;
}

function stage(raw: Record<string, unknown>) {
  return parseDispatchedStageConfig({
    role: 'writer',
    prompt_template: 'settlement replay fixture',
    scope: [],
    depends_on: [],
    dependency_reasons: {},
    skills: [],
    is_gate: false,
    criterion_refs: [],
    ...raw,
  });
}

function replayState(): StoreState {
  return {
    runId: recorded.source.runId,
    workflowName: 'research',
    projectDir: '',
    status: 'running',
    research: recorded.research,
    terminalStates: recorded.terminalStates,
    stages: {
      audit_terminal: { status: STAGE_STATUS.COMPLETE, retries: 0 },
      write_ceiling: { status: STAGE_STATUS.SKIPPED, retries: 0 },
    },
    startedAt: new Date(0).toISOString(),
    currentIteration: recorded.recordedFailure.iteration,
  };
}

function settlementStages() {
  const terminalPath = recorded.terminalStates!.ceiling_hit.paths[0];
  return [
    stage({
      id: 'audit_terminal', role: 'qa', is_gate: true,
      criterion_refs: [recorded.criterionId],
    }),
    stage({
      id: 'write_ceiling', scope: [terminalPath], depends_on: ['audit_terminal'],
      dependency_reasons: { audit_terminal: 'Consumes the verified terminal audit.' },
      condition: `research.terminalPath == "${terminalPath}"`,
    }),
  ];
}

function materializeReplay(options: { verdict?: Record<string, unknown>; metric?: Record<string, unknown> } = {}) {
  const root = temporaryRoot();
  const projectDir = join(root, 'project');
  const fcHome = join(root, '.fc');
  setFcGlobalDir(fcHome);
  const runDirPath = join(fcHome, 'runs', recorded.source.runId);
  const metricDir = join(runDirPath, 'stages', 'audit_terminal');
  mkdirSync(metricDir, { recursive: true });
  const stages = settlementStages();
  writeFileSync(join(runDirPath, 'dispatch_admission.json'), `${JSON.stringify({
    version: 1,
    pass: true,
    checkedAt: new Date(0).toISOString(),
    errors: [],
    terminalOwners: { [recorded.terminalStates!.ceiling_hit.paths[0]]: 'write_ceiling' },
    criterionGateRefs: { audit_terminal: [recorded.criterionId] },
    criteriaDigest: recorded.briefDigest,
  }, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(runDirPath, 'verdict_audit_terminal.json'),
    `${JSON.stringify(options.verdict ?? recorded.verdict, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(metricDir, 'metric.json'),
    `${JSON.stringify(options.metric ?? recorded.metric, null, 2)}\n`,
    'utf8',
  );
  const state = replayState();
  state.projectDir = projectDir;
  return { root, projectDir, runDirPath, stages, state };
}

describe('recorded research settlement replay', () => {
  it('pins every source artifact identity and the encoded archived-gate path', () => {
    expect(recordedArchivedVerdictPath)
      .toBe('stage_evidence/iteration_8/YXVkaXRfdGVybWluYWw/verdict.json');
    expect(recorded.source.files).toEqual(expectedRecordedSourceFiles);
  });

  it('turns the recorded failed final state into a verified ceiling decision', () => {
    expect(recorded.recordedFailure).toMatchObject({ status: 'failed', iteration: 9, admissionPass: false });
    expect(recorded.manifestStop.consecutive_no_improvement)
      .toBe(recorded.manifestStop.configured_halt_after_no_improvement);

    const replay = materializeReplay();
    const projection = recoverVerifiedResearchSettlement(
      replay.stages,
      replay.state,
      replay.projectDir,
      replay.state.runId,
      replay.runDirPath,
    );

    expect(projection).toMatchObject({
      decision: 'stop_ceiling',
      terminalStatus: 'ceiling_hit',
      verificationPassed: true,
      campaignSucceeded: false,
      terminalOwner: 'write_ceiling',
    });
    const decision = JSON.parse(readFileSync(join(replay.runDirPath, 'research_decision.json'), 'utf8'));
    expect(decision).toMatchObject(projection!);
    expect(decision.terminalPath).toBe('docs/happymj_incumbent/ceiling_report.md');
    expect(readFileSync(join(replay.runDirPath, 'signals', 'research_terminal_ready.json'), 'utf8'))
      .toContain('write_ceiling');
  });

  it('keeps a failed effective gate blocking even when the metric says ceiling_hit', () => {
    const replay = materializeReplay({ verdict: { ...recorded.verdict, pass: false } });
    expect(recoverVerifiedResearchSettlement(
      replay.stages, replay.state, replay.projectDir, replay.state.runId, replay.runDirPath,
    )).toBeNull();
    expect(() => readFileSync(join(replay.runDirPath, 'research_decision.json'))).toThrow();
  });

  it('rejects a ceiling outcome whose campaign metric is a genuine win', () => {
    const replay = materializeReplay({
      verdict: { ...recorded.verdict, score: 0.06, threshold: 0.05 },
      metric: { ...recorded.metric, value: 0.06, pass: true },
    });
    expect(recoverVerifiedResearchSettlement(
      replay.stages, replay.state, replay.projectDir, replay.state.runId, replay.runDirPath,
    )).toBeNull();
    expect(() => readFileSync(join(replay.runDirPath, 'research_decision.json'))).toThrow();
  });

  it('publishes no terminal path for a verified continue outcome', () => {
    const replay = materializeReplay({
      verdict: { ...recorded.verdict, outcome: 'continue' },
      metric: { ...recorded.metric, outcome: 'continue' },
    });
    expect(recoverVerifiedResearchSettlement(
      replay.stages, replay.state, replay.projectDir, replay.state.runId, replay.runDirPath,
    )).toBeNull();
    expect(() => readFileSync(join(replay.runDirPath, 'research_decision.json'))).toThrow();
  });
});

describe('criterion discharge boundary', () => {
  const discharge: CriterionDischargeRecord = {
    criterionId: recorded.criterionId,
    briefDigest: recorded.briefDigest,
    iteration: 8,
    workStageId: 'round_work',
    gateStageId: 'audit_round',
    verdictPath: 'stage_evidence/iteration_8/audit_round/verdict.json',
    verdictSha256: 'a'.repeat(64),
  };

  it('admits settlement-only coverage only with a matching engine discharge', () => {
    const stages = settlementStages().map((entry) => ({ ...entry, criterion_refs: [] }));
    const input = {
      dispatched: stages,
      baseStages: [],
      dispatchStageId: 'plan',
      terminalStates: recorded.terminalStates,
      research: recorded.research,
      criteria: {
        version: 1 as const,
        briefDigest: recorded.briefDigest,
        criteria: [{ id: recorded.criterionId, text: 'Choose the terminal path by outcome.', line: 1, section: 'Report' }],
      },
    };
    const before = inspectDispatchAdmission(input);
    expect(before.pass).toBe(false);
    expect(before.errors.join('\n')).toContain('not assigned to a capable work/finalizer stage');

    const after = inspectDispatchAdmission({ ...input, criterionDischarges: [discharge] });
    expect(after.pass, after.errors.join('\n')).toBe(true);
    expect(after.dischargedCriteria).toEqual([discharge]);

    const changedBrief = inspectDispatchAdmission({
      ...input,
      criteria: { ...input.criteria, briefDigest: 'changed-brief' },
      criterionDischarges: [discharge],
    });
    expect(changedBrief.pass).toBe(false);
  });

  it('derives discharge from completed ordinary work plus immutable passing gate evidence only', () => {
    const replay = materializeReplay();
    const work = stage({ id: 'round_work', role: 'coder', criterion_refs: [recorded.criterionId] });
    const gate = stage({
      id: 'audit_terminal', role: 'qa', is_gate: true,
      depends_on: ['round_work'], dependency_reasons: { round_work: 'Audits completed round work.' },
      criterion_refs: [recorded.criterionId],
    });
    const archivePath = 'stage_evidence/iteration_8/audit_terminal/verdict.json';
    mkdirSync(dirname(join(replay.runDirPath, archivePath)), { recursive: true });
    writeFileSync(join(replay.runDirPath, archivePath), `${JSON.stringify(recorded.verdict, null, 2)}\n`, 'utf8');
    replay.state.stages.round_work = { status: STAGE_STATUS.COMPLETE, retries: 0 };
    const evidence: StageEvidenceRecord[] = [{
      stageId: 'audit_terminal', iteration: 8,
      status: replay.state.stages.audit_terminal,
      statusPath: 'stage_evidence/iteration_8/audit_terminal/status.json',
      attemptOutputPaths: [], verdictPath: archivePath,
    }];

    const derived = deriveCriterionDischarges({
      projectDir: replay.projectDir,
      runId: replay.state.runId,
      runDirPath: replay.runDirPath,
      iteration: 8,
      stages: [work, gate],
      state: replay.state,
      evidence,
    });
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      criterionId: recorded.criterionId,
      workStageId: 'round_work',
      gateStageId: 'audit_terminal',
      verdictPath: archivePath,
    });
    replay.state.criterionDischarges = derived;
    replay.state.stageEvidence = [
      ...evidence,
      {
        stageId: 'round_work', iteration: 8,
        status: replay.state.stages.round_work,
        statusPath: 'stage_evidence/iteration_8/round_work/status.json',
        attemptOutputPaths: [],
      },
    ];
    expect(validatedCriterionDischarges(replay.runDirPath, replay.state, recorded.briefDigest))
      .toHaveLength(1);
    writeFileSync(join(replay.runDirPath, archivePath), '{"pass":true,"criteria":{}}\n', 'utf8');
    expect(validatedCriterionDischarges(replay.runDirPath, replay.state, recorded.briefDigest))
      .toEqual([]);

    const terminalOnly = deriveCriterionDischarges({
      projectDir: replay.projectDir,
      runId: replay.state.runId,
      runDirPath: replay.runDirPath,
      iteration: 8,
      stages: [gate, stage({ id: 'write_ceiling', criterion_refs: [recorded.criterionId] })],
      state: replay.state,
      evidence,
    });
    expect(terminalOnly).toEqual([]);
  });
});

describe('admitted check reuse boundary', () => {
  it('restores the exact admitted bytes even though sed extraction independently accepts the expression', () => {
    const checks = readFileSync(join(fixtureRoot, 'reality_checks.md'), 'utf8');
    const source = recorded.source.files['reality_checks.md'];
    expect(Buffer.byteLength(checks)).toBe(source.bytes);
    expect(sha256(checks)).toBe(source.sha256);

    const root = temporaryRoot();
    const checksPath = join(root, 'reality_checks.md');
    writeFileSync(checksPath, checks, 'utf8');
    const state = replayState();
    promoteAdmittedRealityChecks(root, state);
    expect(state.admittedRealityChecks?.sha256).toBe(source.sha256);

    const mutated = checks.replaceAll('\\(', '/(').replaceAll('\\)', '/)').replaceAll('\\1', '/1');
    expect(sha256(mutated)).not.toBe(source.sha256);
    writeFileSync(checksPath, mutated, 'utf8');
    restoreAdmittedRealityChecks(root, state);
    expect(readFileSync(checksPath, 'utf8')).toBe(checks);

    const projectDir = join(root, 'project');
    const manifest = join(projectDir, 'docs', 'happymj_incumbent', 'run_manifest.json');
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, '{"rounds":[]}\n', 'utf8');
    for (const name of ['ship_report.md', 'ceiling_report.md', 'escalation_note.md']) {
      writeFileSync(join(dirname(manifest), name), 'terminal fixture\n', 'utf8');
    }
    expect(inspectRealityCheckReachability({
      markdown: checks,
      projectDir,
      stages: [],
      terminalStates: recorded.terminalStates,
      research: recorded.research,
    })).toEqual([]);
  });
});
