import { createBuildManifest, BUILD_MANIFEST_FILENAME } from '../src/build-manifest.js';
import { readCampaignEntries } from '../src/campaigns.js';
import {
  cmdShipPreflightWithDeps,
  type DaemonLoadedBuildProbe,
  type ShipPreflightDependencies,
} from '../src/cli-ship-preflight.js';
import { findDeployedDistConsumers } from '../src/daemon-identity.js';
import {
  renderFcTasks,
  type FcTaskEntry,
  type FcTaskRunResolver,
  type LedgerReadResult,
} from '../src/fc-tasks.js';
import { GENERATED_PATH_POLICIES, stableGeneratedScope } from '../src/generated-path-policy.js';
import { LiveConstraintGuard } from '../src/live-constraint-guard.js';
import type {
  ProjectValidationBaseline,
  ValidationCommandResult,
  ValidationCommandRunner,
} from '../src/project-validation.js';
import { scopePathDigest, type ScopeRevisionRequestV1 } from '../src/runtime-negotiation.js';
import {
  captureRepairRoundSnapshot,
  decideScopeRevision,
  inspectDispatchAdmission,
  parseBriefFrontmatter,
  parseDispatchedStageConfig,
  readGateVerdict,
  recordGateValidationDelta,
  restoreProjectPath,
  writeCampaignEntry,
  type StageConfig,
} from '../src/scheduler.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import {
  campaignsRoot,
  createRun,
  fcGlobalDir,
  readRunState,
  RUN_STATUS,
  setFcGlobalDir,
  writeRunState,
  writeStageStatus,
  type StoreState,
} from '../src/store.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const appendFault = vi.hoisted(() => ({
  eventPath: '',
  needle: '',
  remaining: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync(path: Parameters<typeof actual.appendFileSync>[0], data: string | Uint8Array, options?: unknown) {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8');
      if (String(path) === appendFault.eventPath
          && appendFault.remaining > 0
          && text.includes(appendFault.needle)) {
        appendFault.remaining -= 1;
        throw new Error('injected obligation append failure');
      }
      return (actual.appendFileSync as (...args: unknown[]) => void)(path, data, options);
    },
  };
});

const roots: string[] = [];
const originalFcRoot = fcGlobalDir();
const dependencyDirectory = ['node', 'modules'].join('_');

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `flowcrew-selfcollision-after-${label}-`));
  roots.push(root);
  return root;
}

function write(path: string, body: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function stage(raw: Record<string, unknown>): StageConfig {
  return parseDispatchedStageConfig({
    id: 'fixture',
    role: 'worker',
    prompt_template: 'bounded engine-self-collision fixture',
    scope: [],
    depends_on: [],
    dependency_reasons: {},
    skills: [],
    is_gate: false,
    criterion_refs: [],
    ...raw,
  });
}

function recordAfter(item: number, construction: string, observed: Record<string, unknown>): void {
  process.stdout.write(`ENGINE_SELF_COLLISION_AFTER=${JSON.stringify({
    item,
    capturedAt: new Date().toISOString(),
    construction,
    observed,
  })}\n`);
}

function validationResult(
  role: ValidationCommandResult['role'],
  state: ValidationCommandResult['state'],
): ValidationCommandResult {
  return {
    role,
    display: `fixture ${role}`,
    state,
    exitCode: state === 'passed' ? 0 : 1,
    durationMs: 1,
    output: '',
    failureCount: 0,
    failureIdentifiers: [],
    failureIdentity: state === 'passed' ? 'none' : 'known',
    ...(state === 'passed' ? {} : { failureEvidence: 'complete' as const }),
  };
}

function validationBaseline(projectDir: string): ProjectValidationBaseline {
  return {
    version: 1,
    execution: 'executed',
    projectDir,
    discovery: {
      state: 'configured',
      configPath: join(projectDir, 'package.json'),
      commands: [{ role: 'test', command: 'fixture', args: ['test'], display: 'fixture test' }],
      missingRoles: ['build', 'lint'],
    },
    results: [validationResult('test', 'passed')],
    gateCriteria: [{
      role: 'test',
      rule: 'must_remain_green',
      baselineFailureIdentifiers: [],
      description: 'test passed at baseline and must remain green',
    }],
  };
}

function settleGateAttempt(
  projectDir: string,
  runId: string,
  attempts: Array<{ index: number; startedAt: string; completedAt: string }>,
): void {
  const latest = attempts.at(-1)!;
  writeStageStatus(projectDir, runId, 'qa', {
    status: 'complete',
    retries: 0,
    startedAt: attempts[0].startedAt,
    completedAt: latest.completedAt,
    attempts: attempts.map((attempt) => ({
      ...attempt,
      status: 'complete',
      duration_ms: 1,
      exitCode: 0,
      tokenUsage: 'unknown',
    })),
  });
}

function seedCampaignMetric(
  projectDir: string,
  stateRoot: string,
  campaignStorageKey: string,
): { state: StoreState; runDirectory: string } {
  setFcGlobalDir(stateRoot);
  const created = createRun(projectDir, 'campaign-fixture', 'name: campaign-fixture', ['qa']);
  const state = readRunState(projectDir, created.runId);
  state.campaignId = campaignStorageKey;
  state.campaignStorageKey = campaignStorageKey;
  state.campaignName = campaignStorageKey;
  state.research = { baseline: 0, policy: 'best_of_n' };
  state.dispatchedStages = [stage({ id: 'qa', role: 'qa', is_gate: true })];
  state.stages.qa = { status: 'complete', retries: 0 };
  write(join(created.runDirPath, 'stages', 'qa', 'metric.json'), `${JSON.stringify({
    hasMetric: true,
    metric: 'quality',
    value: 1,
    higherIsBetter: true,
    threshold: 1,
    pass: true,
  })}\n`);
  return { state, runDirectory: created.runDirPath };
}

function linkedWorktree(root: string, name: string, common: string): string {
  const projectDir = join(root, name);
  const gitDir = join(common, 'worktrees', name);
  mkdirSync(gitDir, { recursive: true });
  write(join(gitDir, 'commondir'), '../..\n');
  mkdirSync(projectDir, { recursive: true });
  write(join(projectDir, '.git'), `gitdir: ${gitDir}\n`);
  return projectDir;
}

afterEach(async () => {
  try {
    const events = await import('../src/run-events.js');
    events.clearAttemptSummaryRefreshDebounce();
  } catch { /* module may not have loaded */ }
  setFcGlobalDir(originalFcRoot);
  appendFault.eventPath = '';
  appendFault.needle = '';
  appendFault.remaining = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('engine self-collision after-state replays and controls', () => {
  it('1 — keeps scheduler campaign bookkeeping outside the guarded project while guarding a stage-authored local ledger', async () => {
    const root = temporaryRoot('item-1');
    const projectDir = join(root, 'project');
    const stateRoot = join(root, 'state');
    mkdirSync(projectDir, { recursive: true });
    const { state, runDirectory } = seedCampaignMetric(projectDir, stateRoot, 'collision');
    const localRelative = '.fc/campaigns/collision.jsonl';
    const localPath = join(projectDir, localRelative);
    const globalPath = join(campaignsRoot(), 'collision.jsonl');
    const research = parseBriefFrontmatter([
      '---',
      'research:',
      '  baseline: 0',
      '  policy: best_of_n',
      '  result_file: artifacts/round.json',
      '  report_dir: artifacts',
      '---',
    ].join('\n')).research!;
    const reservation = inspectDispatchAdmission({
      dispatched: [stage({ id: 'terminal_report', scope: ['artifacts/run_manifest.json'] })],
      baseStages: [],
      dispatchStageId: 'plan',
      research,
    });

    const aborts: string[] = [];
    const guard = new LiveConstraintGuard({
      projectDir,
      runDir: runDirectory,
      stageId: 'terminal_report',
      attemptIndex: 1,
      effectiveScope: () => [],
      watchProject: () => undefined,
      fallbackScanMs: 60_000,
      monitorDeadlineMs: 60_000,
      scopeRevisionInstruction: () => 'unused',
      scanAndRestore: () => ({ scannedPaths: 1, violations: [] }),
    });
    const monitor = guard.beginInvocation(1, (reason) => aborts.push(reason));
    writeCampaignEntry(projectDir, state);
    const schedulerResult = await monitor.finish();
    expect(existsSync(globalPath)).toBe(true);
    expect(existsSync(localPath)).toBe(false);
    expect(schedulerResult.incidents).toEqual([]);
    expect(aborts).toEqual([]);

    write(localPath, 'stage-authored\n');
    const restored = restoreProjectPath(projectDir, localRelative, {
      exists: false,
      provenance: 'observed',
    });
    expect(restored).toEqual({ restored: true });
    expect(existsSync(localPath)).toBe(false);

    recordAfter(1, 'write a scored campaign row while an empty-scope stage guard is active', {
      engineWrite: { path: globalPath.slice(root.length + 1), projectRelative: false },
      projectLedgerExists: existsSync(localPath),
      guardIncidents: schedulerResult.incidents,
      aborts,
      frameworkReservedScopes: reservation.frameworkReservedScopes,
      control: { actor: 'stage', path: localRelative, restored },
    });
  });

  it('2 — carries new campaign history across linked worktrees without merging an unrelated repository', () => {
    const root = temporaryRoot('item-2');
    const common = join(root, 'repo.git');
    const first = linkedWorktree(root, 'worktree-a', common);
    const fresh = linkedWorktree(root, 'worktree-b', common);
    const unrelated = linkedWorktree(root, 'unrelated', join(root, 'other.git'));
    const stateRoot = join(root, 'state');
    const { state } = seedCampaignMetric(first, stateRoot, 'portable-history');
    writeCampaignEntry(first, state);

    const firstEntries = readCampaignEntries(first, 'portable-history');
    const freshEntries = readCampaignEntries(fresh, 'portable-history');
    const unrelatedEntries = readCampaignEntries(unrelated, 'portable-history');
    expect(firstEntries).toHaveLength(1);
    expect(freshEntries).toHaveLength(1);
    expect(unrelatedEntries).toEqual([]);
    rmSync(first, { recursive: true, force: true });
    expect(readCampaignEntries(fresh, 'portable-history')).toHaveLength(1);

    const legacyPath = join(fresh, '.fc', 'campaigns', 'legacy.jsonl');
    write(legacyPath, `${JSON.stringify({
      seq: 1,
      runId: 'legacy-run',
      score: 2,
      metric: 'quality',
      pass: true,
      timestamp: new Date().toISOString(),
      campaignId: 'legacy',
    })}\n`);
    expect(readCampaignEntries(fresh, 'legacy')).toHaveLength(1);

    recordAfter(2, 'write in linked worktree A, read in B before and after reclaim, then read from an unrelated repository', {
      globalWriterPath: join(campaignsRoot(), 'portable-history.jsonl').slice(root.length + 1),
      firstWorktreeEntries: firstEntries.length,
      freshWorktreeEntriesBeforeReclaim: freshEntries.length,
      freshWorktreeEntriesAfterReclaim: readCampaignEntries(fresh, 'portable-history').length,
      unrelatedRepositoryEntries: unrelatedEntries.length,
      legacyLocalEntries: readCampaignEntries(fresh, 'legacy').length,
    });
  });

  it('3 — accepts churn beneath exact stable generated parents and still rejects ordinary or literal late requests', () => {
    const fixtures = new Map<string, string>([
      [`${dependencyDirectory}/.vite/vitest/**`, `${dependencyDirectory}/.vite/vitest/${'a'.repeat(40)}/results.json`],
      ['.cache/build-generations/**', `.cache/build-generations/${'b'.repeat(64)}/.flowcrew-build-manifest.json`],
    ]);
    const decide = (requestedPath: string, member: string, label: string) => {
      const root = temporaryRoot(`item-3-${label}`);
      const projectDir = join(root, 'project');
      const stateRoot = join(root, 'state');
      mkdirSync(projectDir, { recursive: true });
      setFcGlobalDir(stateRoot);
      const created = createRun(projectDir, 'scope-fixture', 'name: scope-fixture', ['writer']);
      write(join(projectDir, member), 'before\n');
      const snapshot = captureRepairRoundSnapshot(
        projectDir,
        [stage({ id: 'snapshot', scope: [requestedPath] })],
        { runDirPath: created.runDirPath },
      );
      writeFileSync(join(projectDir, member), 'after with the same pathname\n');
      const request: ScopeRevisionRequestV1 = {
        version: 1,
        kind: 'scope_revision',
        requestId: `generated-${label}`,
        runId: created.runId,
        stageId: 'writer',
        attemptIndex: 1,
        requestedBy: 'stage',
        requestedPaths: [requestedPath],
        pathDigest: scopePathDigest([requestedPath]),
        reason: 'configured command owns this generated tree',
      };
      return decideScopeRevision({
        request,
        stage: stage({ id: 'writer', scope: [] }),
        priorScope: [],
        activePeers: [],
        projectDir,
        runId: created.runId,
        attemptIndex: 1,
        snapshot,
      });
    };
    const generated = GENERATED_PATH_POLICIES
      .filter((policy) => policy.contentAddressedMember && policy.stableScope)
      .map((policy) => {
        const member = fixtures.get(policy.stableScope!)!;
        return { stableScope: policy.stableScope, member, decision: decide(policy.stableScope!, member, member.length.toString()) };
      });
    expect(generated.every(({ decision }) => decision.accepted)).toBe(true);
    const ordinary = decide('src/generated/**', 'src/generated/ordinary.ts', 'ordinary');
    expect(ordinary).toMatchObject({ accepted: false, decision: 'rejected' });
    expect(ordinary.rejectionReason).toContain('requested content changed before scope approval');
    const generatedMember = fixtures.get('.cache/build-generations/**')!;
    const literal = decide(generatedMember, generatedMember, 'literal');
    expect(literal).toMatchObject({ accepted: false, decision: 'rejected' });
    expect(literal.rejectionReason).toContain('Request the stable generated parent');

    recordAfter(3, 'rewrite each recognized content-addressed member, request its stable parent, then exercise ordinary and literal controls', {
      generated,
      ordinaryControl: ordinary,
      literalGeneratedControl: literal,
      projectionPositive: stableGeneratedScope(generatedMember),
      projectionNegative: stableGeneratedScope('src/generated/ordinary.ts') ?? null,
    });
  });

  it('4 — refuses a bare nested citation with the accepted form and keeps valid full citations bounded', () => {
    const root = temporaryRoot('item-4');
    const projectDir = join(root, 'project');
    const runDirectory = join(projectDir, 'run-fixture');
    const reportRelative = 'reports/published.md';
    write(join(runDirectory, 'stages', 'gate', 'evidence.json'), '{"evidence":true}\n');
    write(join(projectDir, reportRelative), '# Replay\n\n`node --test evidence.json`\n');
    const bare = inspectStageArtifactContract({
      stageId: 'report', template: `Publish ${reportRelative}.`, projectDir, runDir: runDirectory, writes: [reportRelative],
    });
    const message = bare.violations.find(({ mention }) => mention === 'evidence.json')?.reason;
    expect(message).toBe(
      'published replay command cites bare filename evidence.json; bare replay targets resolve at the project root, and no readable input file exists there. Cite a full project-relative path to a project-contained artifact, or remove the replay citation if no executable input is intended',
    );

    const validTarget = 'run-fixture/stages/gate/replay.test.cjs';
    write(join(projectDir, validTarget), [
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      "test('full citation', () => assert.equal(2 + 2, 4));",
      '',
    ].join('\n'));
    write(join(projectDir, reportRelative), `# Replay\n\n\`node --test ${validTarget}\`\n`);
    const full = inspectStageArtifactContract({
      stageId: 'report', template: `Publish ${reportRelative}.`, projectDir, runDir: runDirectory, writes: [reportRelative],
    });
    expect(full.violations).toEqual([]);
    expect(full.replayExecutions[0]).toMatchObject({ status: 'passed', exitCode: 0 });

    const missingTarget = 'run-fixture/stages/gate/missing.test.cjs';
    write(join(projectDir, reportRelative), `# Missing replay\n\n\`node --test ${missingTarget}\`\n`);
    const missingFull = inspectStageArtifactContract({
      stageId: 'report', template: `Publish ${reportRelative}.`, projectDir, runDir: runDirectory, writes: [reportRelative],
    });
    expect(missingFull.violations.find(({ mention }) => mention === missingTarget)?.reason)
      .toBe(`published replay command names ${missingTarget}, but no readable input file exists at that exact project-relative path`);

    write(join(projectDir, reportRelative), '# No executable citation\n');
    const omitted = inspectStageArtifactContract({
      stageId: 'report', template: `Publish ${reportRelative}.`, projectDir, runDir: runDirectory, writes: [reportRelative],
    });
    expect(omitted.violations).toEqual([]);

    recordAfter(4, 'cite the nested artifact by bare filename, then use a full bounded citation and an omitted-citation control', {
      bareMessage: message,
      bareExecution: bare.replayExecutions[0],
      fullExecution: full.replayExecutions[0],
      fullViolations: full.violations,
      missingFullPathViolation: missingFull.violations,
      omittedViolations: omitted.violations,
    });
  });

  it('5 — rejects a prior-attempt delta by execution identity and preserves immutable attempt evidence', async () => {
    const root = temporaryRoot('item-5');
    const projectDir = join(root, 'project');
    const stateRoot = join(root, 'state');
    mkdirSync(projectDir, { recursive: true });
    setFcGlobalDir(stateRoot);
    const created = createRun(projectDir, 'validation-fixture', 'name: validation-fixture', ['qa']);
    write(join(created.runDirPath, 'validation_baseline.json'), `${JSON.stringify({
      version: 1,
      capturedAt: new Date().toISOString(),
      source: 'ship-setup-ready-record',
      baseline: validationBaseline(projectDir),
    }, null, 2)}\n`);
    write(join(created.runDirPath, 'verdict_qa.json'), `${JSON.stringify({
      pass: true,
      reason: 'gate-authored verdict before engine validation',
      recordedAt: new Date().toISOString(),
    })}\n`);
    const first = {
      index: 1,
      startedAt: new Date(Date.now() - 40).toISOString(),
      completedAt: new Date(Date.now() - 30).toISOString(),
    };
    settleGateAttempt(projectDir, created.runId, [first]);
    const failed = await recordGateValidationDelta(projectDir, created.runId, 'qa', {
      runCommand: () => ({
        exitCode: 1,
        durationMs: 1,
        stdout: 'TAP version 13\nnot ok 1 - spec/regression-a.test.ts\nnot ok 2 - spec/regression-b.test.ts\nnot ok 3 - spec/regression-c.test.ts\n1..3\n# tests 3\n# pass 0\n# fail 3\n',
      }),
    });
    const currentRegression = readGateVerdict(projectDir, 'qa', created.runId);
    expect(currentRegression).toMatchObject({ pass: false, reason: expect.stringContaining('recorded regressions') });
    const immutableFailure = readFileSync(join(created.runDirPath, failed!.immutablePath!), 'utf-8');
    const second = {
      index: 2,
      startedAt: new Date(Date.now() - 20).toISOString(),
      completedAt: new Date(Date.now() - 10).toISOString(),
    };
    settleGateAttempt(projectDir, created.runId, [first, second]);
    write(join(created.runDirPath, 'verdict_qa.json'), `${JSON.stringify({
      pass: true,
      reason: 'repair complete; no new failing identifiers',
      recordedAt: new Date().toISOString(),
    })}\n`);
    const stale = readGateVerdict(projectDir, 'qa', created.runId);
    expect(stale).toMatchObject({ pass: false, reason: expect.stringContaining('not current execution') });
    expect(stale?.reason).toContain('run configured validation for the current gate attempt');

    const passing = await recordGateValidationDelta(projectDir, created.runId, 'qa', {
      runCommand: () => ({
        exitCode: 0,
        durationMs: 1,
        stdout: 'TAP version 13\nok 1 - spec/repaired.test.ts\n1..1\n# tests 1\n# pass 1\n# fail 0\n',
      }),
    });
    expect(readGateVerdict(projectDir, 'qa', created.runId)).toMatchObject({ pass: true });
    expect(JSON.parse(immutableFailure)).toMatchObject({
      attemptIndex: 1,
      pass: false,
      executionId: failed?.executionId,
    });
    expect(passing).toMatchObject({ attemptIndex: 2, pass: true });

    recordAfter(5, 'record a failing attempt-1 delta, settle a passing attempt-2 verdict, then validate attempt 2', {
      staleDecision: stale,
      currentRegressionDecision: currentRegression,
      failedDelta: failed,
      passingDelta: passing,
      immutableAttemptOneStillFailing: JSON.parse(immutableFailure),
      currentDecision: readGateVerdict(projectDir, 'qa', created.runId),
    });
  });

  it('6 — records configured-command intent without turning validation by-products into stage scope', () => {
    const root = temporaryRoot('item-6');
    const projectDir = join(root, 'project');
    mkdirSync(projectDir, { recursive: true });
    write(join(projectDir, 'package.json'), JSON.stringify({
      scripts: {
        build: 'compile',
        test: 'vitest run',
        lint: 'style',
        'build:ui': 'cd ui && npm run build',
      },
      devDependencies: { vitest: 'fixture' },
    }));
    write(join(projectDir, 'package-lock.json'), '{}\n');
    write(join(projectDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { outDir: 'dist', tsBuildInfoFile: '.cache/tsc.tsbuildinfo' },
    }));
    write(join(projectDir, 'ui', 'package.json'), JSON.stringify({
      scripts: { build: 'vite build' },
      devDependencies: { vite: 'fixture' },
    }));
    const generatedScopes = [
      '.cache/**',
      'dist/**',
      `${dependencyDirectory}/.vite/**`,
      `${dependencyDirectory}/.vite-temp/**`,
      'ui/dist/**',
      `ui/${dependencyDirectory}/.vite/**`,
      `ui/${dependencyDirectory}/.vite-temp/**`,
    ];
    const implementation = Array.from({ length: 6 }, (_value, index) => stage({
      id: `implement_${index + 1}`,
      prompt_template: 'Implement the assigned change and run npm run build plus npm test before finishing.',
      scope: [],
    }));
    const wrong = [
      ...implementation,
      stage({ id: 'write_report', prompt_template: 'Write the final report.', scope: generatedScopes }),
      stage({ id: 'gate', role: 'qa', is_gate: true, prompt_template: 'Run npm run build, npm run test, and npm run lint.', scope: generatedScopes }),
      stage({ id: 'repair', prompt_template: 'Repair the gate and rerun npm test.', scope: generatedScopes }),
    ];
    const zeroScope = inspectDispatchAdmission({
      dispatched: wrong, baseStages: [], dispatchStageId: 'plan', projectDir,
    });
    expect(zeroScope.pass, zeroScope.errors.join('\n')).toBe(true);
    expect(zeroScope.errors.filter((error) => error.includes('lacks generated output capabilities'))).toEqual([]);

    const corrected = wrong.map((candidate) => candidate.id === 'write_report'
      ? { ...candidate, scope: [] }
      : { ...candidate, scope: [...generatedScopes] });
    const accepted = inspectDispatchAdmission({
      dispatched: corrected, baseStages: [], dispatchStageId: 'plan', projectDir,
    });
    expect(accepted.pass, accepted.errors.join('\n')).toBe(true);
    expect(accepted.configuredCommandScopes).toEqual([...generatedScopes].sort());
    expect(accepted.configuredCommandStageRoles).not.toHaveProperty('write_report');

    const inert = inspectDispatchAdmission({
      dispatched: [
        stage({ id: 'owner', prompt_template: 'Run npm run test.', scope: generatedScopes }),
        stage({ id: 'sentence', prompt_template: 'Audit the result. Run npm run build.', scope: generatedScopes }),
        stage({ id: 'capture', prompt_template: 'Capture npm run lint directly.', scope: generatedScopes }),
        stage({ id: 'rerun', prompt_template: 'Re-run npm test after repair.', scope: generatedScopes }),
        stage({ id: 'described', prompt_template: 'Run the configured test command before finishing.', scope: generatedScopes }),
        stage({ id: 'verify', prompt_template: 'After implementation, verify with npm run test before finishing.', scope: generatedScopes }),
        stage({ id: 'negated', prompt_template: 'Do not run npm run test; summarize its existing result.', scope: [] }),
        stage({ id: 'negated_verify', prompt_template: 'Do not verify with npm run test; summarize its existing result.', scope: [] }),
        stage({ id: 'quoted', prompt_template: 'Example only:\n```\nnpm run test\n```', scope: [] }),
      ],
      baseStages: [],
      dispatchStageId: 'plan',
      projectDir,
    });
    expect(inert.pass, inert.errors.join('\n')).toBe(true);
    expect(inert.configuredCommandStageRoles).toEqual({
      capture: ['lint'], described: ['test'], owner: ['test'], rerun: ['test'], sentence: ['build'], verify: ['test'],
    });

    const absent = inspectDispatchAdmission({
      dispatched: [stage({ id: 'runner', prompt_template: 'Run npm run test.', scope: [] })],
      baseStages: [],
      dispatchStageId: 'plan',
      projectDir,
    });
    const partial = inspectDispatchAdmission({
      dispatched: [stage({ id: 'runner', prompt_template: 'Run npm run test.', scope: ['.cache/**'] })],
      baseStages: [],
      dispatchStageId: 'plan',
      projectDir,
    });
    const ordinaryImperative = inspectDispatchAdmission({
      dispatched: [stage({
        id: 'runner',
        prompt_template: 'After implementation, verify with npm run test before finishing.',
        scope: [],
      })],
      baseStages: [],
      dispatchStageId: 'plan',
      projectDir,
    });
    expect(absent.pass, absent.errors.join('\n')).toBe(true);
    expect(absent.configuredCommandScopes).toEqual([...generatedScopes].sort());
    expect(partial.pass, partial.errors.join('\n')).toBe(true);
    expect(partial.errors.join('\n')).not.toContain('dist/**');
    expect(ordinaryImperative.pass, ordinaryImperative.errors.join('\n')).toBe(true);
    expect(ordinaryImperative.configuredCommandStageRoles).toEqual({ runner: ['test'] });

    recordAfter(6, 'admit zero-scope and partial-scope validation runners while retaining generated-path and command-intent telemetry', {
      zeroScopeAllocation: {
        pass: zeroScope.pass,
        errors: zeroScope.errors,
        configuredCommandScopes: zeroScope.configuredCommandScopes,
        configuredCommandStageRoles: zeroScope.configuredCommandStageRoles,
      },
      correctedAllocation: {
        pass: accepted.pass,
        errors: accepted.errors,
        reportScope: corrected.find(({ id }) => id === 'write_report')?.scope,
      },
      inertControls: {
        pass: inert.pass,
        stageRoles: inert.configuredCommandStageRoles,
      },
      absentAllocation: { pass: absent.pass, errors: absent.errors },
      partialAllocation: { pass: partial.pass, errors: partial.errors },
      ordinaryImperative: {
        prompt: 'After implementation, verify with npm run test before finishing.',
        pass: ordinaryImperative.pass,
        errors: ordinaryImperative.errors,
        stageRoles: ordinaryImperative.configuredCommandStageRoles,
      },
    });
  });

  it('7 — refuses before command one when a cross-project run consumes this checkout dist', async () => {
    const root = temporaryRoot('item-7');
    const projectDir = join(root, 'target-project');
    const otherProject = join(root, 'other-project');
    const packageRoot = join(root, 'engine-package');
    const stateRoot = join(root, 'state');
    const runRoot = join(stateRoot, 'runs');
    mkdirSync(join(projectDir, dependencyDirectory), { recursive: true });
    mkdirSync(otherProject, { recursive: true });
    write(join(projectDir, 'package.json'), JSON.stringify({
      scripts: { build: 'compile', test: 'check', lint: 'style' },
      flowcrew: { testPopulation: { files: [] } },
    }));
    write(join(projectDir, 'package-lock.json'), '{}\n');
    write(join(packageRoot, 'src', 'probe.ts'), 'export const probe = true;\n');
    write(join(packageRoot, 'dist', 'probe.js'), 'export const probe = true;\n');
    write(join(packageRoot, 'dist', 'probe.d.ts'), 'export declare const probe = true;\n');
    write(join(packageRoot, 'tsconfig.json'), '{}\n');
    write(join(packageRoot, 'dist', BUILD_MANIFEST_FILENAME), `${JSON.stringify(
      createBuildManifest(packageRoot, join(packageRoot, 'dist')),
      null,
      2,
    )}\n`);
    write(join(runRoot, 'cross-project-run', 'run.json'), `${JSON.stringify({
      runId: 'cross-project-run', projectDir: otherProject, status: 'running',
    })}\n`);
    const procRoot = join(root, 'proc');
    write(join(procRoot, '4242', 'cmdline'), Buffer.from([
      'node', join(packageRoot, 'dist', 'cli.js'), '--existing-run-id', 'cross-project-run', '',
    ].join('\0')));
    const consumers = findDeployedDistConsumers(join(packageRoot, 'dist'), {
      procRoot, diskBuildHash: 'fixture', processAlive: () => true,
    });
    const unrelated = findDeployedDistConsumers(join(root, 'unrelated-engine', 'dist'), {
      procRoot, diskBuildHash: 'fixture', processAlive: () => true,
    });
    expect(consumers).toHaveLength(1);
    expect(unrelated).toEqual([]);
    write(join(procRoot, '4343', 'cmdline'), Buffer.from([
      'node', join(root, 'unrelated', 'reporter.js'),
      `--output=${join(packageRoot, 'dist', 'diagnostic.txt')}`, '',
    ].join('\0')));
    const opaqueArgument = findDeployedDistConsumers(join(packageRoot, 'dist'), {
      procRoot, diskBuildHash: 'fixture', processAlive: () => true,
    });
    expect(opaqueArgument).toEqual(consumers);
    const evalProcRoot = join(root, 'eval-proc');
    write(join(evalProcRoot, '4444', 'cmdline'), Buffer.from([
      'node', '--input-type=module', '-e',
      `await import(${JSON.stringify(`file://${join(packageRoot, 'dist', 'probe.js')}`)})`,
      '--', '--existing-run-id', 'eval-run', '',
    ].join('\0')));
    const evaluatedImport = findDeployedDistConsumers(join(packageRoot, 'dist'), {
      procRoot: evalProcRoot, diskBuildHash: 'fixture', processAlive: () => true,
    });
    expect(evaluatedImport).toHaveLength(1);
    const relativeProcRoot = join(root, 'relative-proc');
    write(join(relativeProcRoot, '4545', 'cmdline'), Buffer.from([
      'node', 'dist/cli.js', '--existing-run-id', 'relative-run', '',
    ].join('\0')));
    const relativeEntrypoint = findDeployedDistConsumers(join(packageRoot, 'dist'), {
      procRoot: relativeProcRoot,
      diskBuildHash: 'fixture',
      processAlive: () => true,
      readProcessCwd: () => packageRoot,
    });
    expect(relativeEntrypoint).toEqual([{
      pid: 4545,
      kind: 'run',
      runId: 'relative-run',
      label: 'run relative-run (pid 4545)',
    }]);
    const relativeOtherDistribution = findDeployedDistConsumers(join(packageRoot, 'dist'), {
      procRoot: relativeProcRoot,
      diskBuildHash: 'fixture',
      processAlive: () => true,
      readProcessCwd: () => join(root, 'other-engine'),
    });
    expect(relativeOtherDistribution).toEqual([]);

    class Capture {
      value = '';
      writer = { write: (chunk: string): void => { this.value += chunk; } };
    }
    const stderr = new Capture();
    const runner = vi.fn<ValidationCommandRunner>((request) => ({
      exitCode: 0, durationMs: 1, stdout: `${request.role} passed\n`,
    }));
    const dependencies: ShipPreflightDependencies = {
      projectDir,
      packageRoot,
      runsRoot: () => runRoot,
      readGitCommonDir: () => '.git',
      readCampaignEntries: () => [],
      probeDaemon: async (): Promise<DaemonLoadedBuildProbe> => ({
        state: 'fresh', loadedBuild: 'same', diskBuild: 'same',
      }),
      inspectLiveRun: () => true,
      findDistConsumers: () => consumers,
      runValidationCommand: runner,
      stdout: new Capture().writer,
      stderr: stderr.writer,
    };
    const refused = await cmdShipPreflightWithDeps(['ship-preflight'], dependencies);
    expect(refused).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(stderr.value).toContain('No project command was launched');

    const noBaseline = await cmdShipPreflightWithDeps(['ship-preflight', '--no-baseline'], dependencies);
    expect(noBaseline).toBe(0);
    expect(runner).not.toHaveBeenCalled();

    const quietRunner = vi.fn<ValidationCommandRunner>((request) => ({
      exitCode: 0, durationMs: 1, stdout: `${request.role} passed\n`,
    }));
    const quiet = await cmdShipPreflightWithDeps(['ship-preflight'], {
      ...dependencies,
      findDistConsumers: () => [],
      runValidationCommand: quietRunner,
      stderr: new Capture().writer,
    });
    expect(quiet).toBe(0);
    expect(quietRunner.mock.calls.map(([request]) => request.role)).toEqual(['build', 'test', 'lint']);

    const terminalRunner = vi.fn<ValidationCommandRunner>((request) => ({
      exitCode: 0, durationMs: 1, stdout: `${request.role} passed\n`,
    }));
    const terminal = await cmdShipPreflightWithDeps(['ship-preflight'], {
      ...dependencies,
      inspectLiveRun: () => false,
      runValidationCommand: terminalRunner,
      stderr: new Capture().writer,
    });
    expect(terminal).toBe(0);
    expect(terminalRunner.mock.calls.map(([request]) => request.role)).toEqual(['build', 'test', 'lint']);

    recordAfter(7, 'run preflight with a verified cross-project consumer of this package dist, then no-baseline, unrelated-dist, terminal-run, and opaque-data-argument controls', {
      consumerDetectorPositive: consumers,
      consumerDetectorNegative: unrelated,
      opaqueDataArgumentIgnored: !opaqueArgument.some(({ pid }) => pid === 4343),
      evaluatedImportDetected: evaluatedImport,
      cwdRelativeEntrypointDetected: relativeEntrypoint,
      cwdRelativeOtherDistributionIgnored: relativeOtherDistribution,
      refusedExitCode: refused,
      rolesLaunchedBeforeRefusal: runner.mock.calls.map(([request]) => request.role),
      refusalOutput: stderr.value,
      noBaselineExitCode: noBaseline,
      unrelatedConsumerExitCode: quiet,
      unrelatedConsumerRoles: quietRunner.mock.calls.map(([request]) => request.role),
      terminalRunExitCode: terminal,
      terminalRunRoles: terminalRunner.mock.calls.map(([request]) => request.role),
    });
  });

  it('8 — counts distinct running execution identities while retaining both ledger rows', () => {
    const root = temporaryRoot('item-8');
    const entries: FcTaskEntry[] = ['1', '2'].map((id) => ({
      id,
      subject: `task-${id}`,
      description: `task-${id}`,
      activeForm: `running-${id}`,
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
      flowcrewTaskId: Number(id),
    }));
    const readLedger = (): LedgerReadResult => ({
      state: 'ready',
      entries: entries.map((entry) => ({
        ...entry,
        sourceName: `${entry.id}.json`,
        sourcePath: join(root, `${entry.id}.json`),
        sourceRecord: { ...entry },
      })),
      issues: [],
    });
    const render = (resolver: FcTaskRunResolver) => renderFcTasks({
      storeRoot: root,
      explicitSession: 'fixture',
      columns: 180,
      readLedger,
      taskRunResolver: resolver,
    }).text.split('\n')[0];
    const resolver = (runId: (entry: FcTaskEntry) => string | undefined, status = 'running'): FcTaskRunResolver => ({
      resolve: (entry) => ({
        state: 'resolved',
        taskId: entry.flowcrewTaskId!,
        taskStatus: status === 'running' ? 'running' : 'done',
        projectDir: root,
        ...(runId(entry) ? { runId: runId(entry) } : {}),
        ...(runId(entry) ? { runStatus: status } : {}),
      }),
    });
    const shared = render(resolver(() => 'one-running-run'));
    const distinct = render(resolver((entry) => `running-${entry.id}`));
    const taskOnly = render(resolver(() => undefined));
    const terminal = render(resolver(() => 'one-terminal-run', 'complete'));
    expect(shared).toContain('engine 1 running');
    expect(distinct).toContain('engine 2 running');
    expect(taskOnly).toContain('engine 2 running');
    expect(terminal).toContain('engine 0 running');

    recordAfter(8, 'render two ledger rows resolving to one, two, task-only, and terminal execution identities', {
      sharedRunHeader: shared,
      distinctRunHeader: distinct,
      taskOnlyHeader: taskOnly,
      terminalHeader: terminal,
      renderedLedgerRowsRetained: entries.length,
    });
  });

  it('9 — commits the cursor only after retryably appending every obligation exactly once', async () => {
    const root = temporaryRoot('item-9');
    const projectDir = join(root, 'project');
    const stateRoot = join(root, 'state');
    mkdirSync(projectDir, { recursive: true });
    setFcGlobalDir(stateRoot);
    const created = createRun(projectDir, 'cursor-fixture', 'name: cursor-fixture', []);
    const state = readRunState(projectDir, created.runId);
    state.status = RUN_STATUS.COMPLETE;
    state.completedAt = new Date().toISOString();
    writeRunState(projectDir, created.runId, state);
    const cursorPath = join(created.runDirPath, 'run_event_status.json');
    write(cursorPath, `${JSON.stringify({
      version: 1, status: RUN_STATUS.RUNNING, observedAt: new Date(0).toISOString(),
    })}\n`);

    vi.resetModules();
    const isolatedStore = await import('../src/store.js');
    isolatedStore.setFcGlobalDir(stateRoot);
    const isolatedEvents = await import('../src/run-events.js');
    appendFault.eventPath = join(created.runDirPath, 'events.jsonl');
    appendFault.needle = '"type":"operator_wrap_up_required"';
    appendFault.remaining = 1;
    expect(() => isolatedEvents.recordRunEvent(projectDir, created.runId, {
      type: 'campaign_alert',
      runId: created.runId,
      timestamp: new Date().toISOString(),
      detail: 'trigger terminal observation',
    }, { debounceMs: 60_000 })).toThrow('injected obligation append failure');
    const cursorAfterFailure = JSON.parse(readFileSync(cursorPath, 'utf-8')) as { status: string };
    const failureEvents = isolatedEvents.readRunEvents(projectDir, created.runId);
    expect(cursorAfterFailure.status).toBe(RUN_STATUS.RUNNING);
    expect(failureEvents.map(({ type }) => type)).toEqual(['campaign_alert', 'run_status_changed']);

    appendFault.remaining = 0;
    isolatedEvents.recordRunEvent(projectDir, created.runId, {
      type: 'campaign_alert',
      runId: created.runId,
      timestamp: new Date().toISOString(),
      detail: 'retry after recovery',
    }, { debounceMs: 60_000 });
    isolatedEvents.recordRunEvent(projectDir, created.runId, {
      type: 'campaign_alert',
      runId: created.runId,
      timestamp: new Date().toISOString(),
      detail: 'unchanged repeat',
    }, { debounceMs: 60_000 });
    const retryEvents = isolatedEvents.readRunEvents(projectDir, created.runId);
    expect(retryEvents.filter(({ type }) => type === 'run_status_changed')).toHaveLength(1);
    expect(retryEvents.filter(({ type }) => type === 'operator_wrap_up_required')).toHaveLength(1);
    expect(JSON.parse(readFileSync(cursorPath, 'utf-8'))).toMatchObject({ status: RUN_STATUS.COMPLETE });
    isolatedEvents.clearAttemptSummaryRefreshDebounce();

    recordAfter(9, 'append the status event, inject the wrap-up obligation failure, retry, then observe the unchanged status again', {
      cursorAfterFailure,
      eventTypesAfterFailure: failureEvents.map(({ type }) => type),
      cursorAfterRetry: JSON.parse(readFileSync(cursorPath, 'utf-8')),
      eventTypesAfterRetryAndRepeat: retryEvents.map(({ type }) => type),
      statusEventCount: retryEvents.filter(({ type }) => type === 'run_status_changed').length,
      obligationCount: retryEvents.filter(({ type }) => type === 'operator_wrap_up_required').length,
    });
  });
});
