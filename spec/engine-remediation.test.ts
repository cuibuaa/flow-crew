import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import { createBuildManifest, publishBuildGeneration } from '../src/build-manifest.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { createCampaignProposerScratch } from '../src/campaign-scratch.js';
import { cancelRunThroughControlPlane } from '../src/cancellation-client.js';
import { collectShipPreflight } from '../src/cli-ship-preflight.js';
import { runShipSetup, type GitWorktreeCreator } from '../src/cli-ship-setup.js';
import { loadProjectDefaults, loadProjectDefaultsLocally } from '../src/config.js';
import {
  archiveDeclaredOutputs,
  isPathSafelyArchived,
} from '../src/declared-output-archive.js';
import {
  GENERATED_PATH_POLICIES,
  ROLLBACK_INVENTORY_EXCLUDED_DIRECTORIES,
  isRecognizedGeneratedCachePath,
} from '../src/generated-path-policy.js';
import { buildStagePrompt } from '../src/handoff.js';
import { writeKG, type KnowledgeGraph } from '../src/knowledge-graph.js';
import {
  matchesLiveConstraintExemptPattern,
  scopeRevisionPathsForViolations,
} from '../src/live-constraint-guard.js';
import { CANCELLATION_RPC_TIMEOUT_MS, RpcOutcomeUnknownError } from '../src/orchestrator-rpc.js';
import { rehearseBriefIsolated } from '../src/rehearse.js';
import type {
  ProjectValidationBaseline,
  ValidationCommandResult,
} from '../src/project-validation.js';
import { readResearchGateCandidate } from '../src/research-candidate.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { appendRunEvent, readRunEvents } from '../src/run-events.js';
import {
  assessResearchIterationBudget,
  appendIterationLog,
  checkCampaignHealth,
  findGateRecoveryStages,
  inspectDispatchAdmission,
  loadWorkflow,
  parseBriefFrontmatter,
  readGateVerdict,
  recordGateValidationDelta,
  restoreProjectPath,
  runWorkflow,
  scopeContainsPath,
  tryTerminateOnTerminalState,
  type CampaignEntry,
  type StageConfig,
  type WorkflowConfig,
} from '../src/scheduler.js';
import {
  inspectShipSetupRecord,
  shipSetupBriefDigest,
  shipSetupReadyRecordPath,
} from '../src/ship-setup-record.js';
import {
  createRun,
  fcGlobalDir,
  initializeReservedRun,
  readRunState,
  readStageStatus,
  reserveRun,
  RUN_RESERVATION_FILE,
  runDir,
  setFcGlobalDir,
  writeStageStatus,
  writeRunState,
  type StoreState,
} from '../src/store.js';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const roots: string[] = [];
const originalFcHome = fcGlobalDir();

interface ReachCount {
  enumerated: number;
  runnable: number;
  before: Record<string, number>;
  after: Record<string, number>;
  calibration: { knownPositive: number; disconnectedNegative: number };
}

interface AfterEvidence {
  item: number;
  capturedAt: string;
  classification: 'changed' | 'not_a_defect';
  construction: string;
  observed: Record<string, unknown>;
  control: { construction: string; observed: unknown; differsBy: string[] };
  population: ReachCount;
  covers: string;
  leavesUncovered: string;
  unstatedDependency: string;
  worthImpact: string;
}

const dependencies: Record<number, [string, string]> = {
  1: ['Later validation output must retain stable identities.', 'Unknown identities still fail closed; known red baselines are now enforceable.'],
  2: ['Launch can bind target and exact brief to setup identity.', 'Those values already exist before dispatch.'],
  3: ['Outputs may be absent from version control recovery.', 'That is the reason terminal archival is valuable.'],
  4: ['Envelope admission is distinct from delivery.', 'The CLI now reports both without predicting consumption.'],
  5: ['An idempotent status observation exists after ambiguous delivery.', 'The daemon now exposes it and the client uses it once.'],
  6: ['A runnable brief must state at least one structural proof obligation.', 'Explicit refusal is safer than vacuous readiness.'],
  7: ['Skipped trees can contain operator preimages.', 'Unknown absence must never authorize deletion.'],
  8: ['Condition value domains are finite.', 'Authored impossible values can be rejected before a run.'],
  9: ['Reservations and initialization gaps are legitimate.', 'Classification lets clean preserve active state and reap only proven stale state.'],
  10: ['Consumers need projections, not identical policy effects.', 'One catalog can provide those projections.'],
  11: ['Build publication is content-addressed.', 'The existing manifest is authoritative over mtimes.'],
  12: ['A round consumes at most one outer iteration and finalization settles in that iteration.', 'The exact inequality is now explicit and enforced.'],
  13: ['The segment compiler may already match dot segments.', 'Measurement confirms the reported case was not defective.'],
  14: ['Campaign metrics have an optimization direction.', 'Persisting it removes the ambiguous half-domain.'],
  15: ['Round outcome evidence is available before gate prompting.', 'The framework now captures and renders it.'],
  16: ['A missing-outcome rejection is distinguishable from report quality.', 'Only the former redispatches an owning producer.'],
  17: ['Dispatch admission remains the terminal ownership authority.', 'Scope revision can no longer transfer it.'],
  18: ['Make dry-run expands to one safe supported command.', 'Opaque or multi-command targets remain explicitly unverified.'],
  19: ['Candidate code must execute out of process.', 'A bounded handshake validates coupled code/config safely.'],
  20: ['A signal may arrive synchronously with first output.', 'Installing handlers before output closes the race.'],
};

function temporaryRoot(label = 'engine-remediation-after-'): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
}

function sourceCli(args: string[], fcHome: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', join(PROJECT_ROOT, 'src', 'cli.ts'), ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, HOME: fcHome, FC_HOME: fcHome, NO_COLOR: '1' },
    encoding: 'utf-8',
    timeout: 20_000,
  });
}

function validationResult(
  role: 'build' | 'test' | 'lint',
  state: ValidationCommandResult['state'],
  identifiers: string[] = [],
): ValidationCommandResult {
  return {
    role,
    display: `fixture ${role}`,
    state,
    exitCode: state === 'passed' ? 0 : state === 'failed' ? 1 : undefined,
    durationMs: 1,
    output: '',
    failureCount: identifiers.length,
    failureIdentifiers: identifiers,
    failureIdentity: state === 'failed' ? 'known' : 'none',
    ...(state === 'failed' ? { failureEvidence: 'complete' as const } : {}),
  };
}

function validationBaseline(projectDir: string): ProjectValidationBaseline {
  return {
    version: 1,
    projectDir,
    discovery: {
      state: 'configured',
      configPath: join(projectDir, 'package.json'),
      commands: [{ role: 'test', command: 'fixture', args: ['test'], display: 'fixture test' }],
      missingRoles: ['build', 'lint'],
    },
    results: [validationResult('test', 'failed', ['spec/existing.test.ts'])],
    gateCriteria: [{
      role: 'test',
      rule: 'no_regression_from_baseline',
      baselineFailureCount: 1,
      baselineFailureIdentifiers: ['spec/existing.test.ts'],
      baselineFailureEvidence: 'complete',
      description: 'test may not add failures',
    }],
  };
}

function reach(
  enumerated: number,
  before: Record<string, number>,
  after: Record<string, number>,
  runnable = enumerated,
): ReachCount {
  type ReachMember = { disposition: string; ordinal: number; diagnostic?: string };
  const population = (dispositions: Record<string, number>): ReachMember[] => (
    Object.entries(dispositions).flatMap(([disposition, count]) => (
      Array.from({ length: count }, (_value, ordinal) => ({ disposition, ordinal, diagnostic: disposition }))
    ))
  );
  const countDiagnosed = (members: readonly ReachMember[]): number => (
    members.filter((member) => Boolean(member.diagnostic?.trim())).length
  );
  const beforePopulation = population(before);
  const afterPopulation = population(after);
  // Calibrate the same collector used for every enumerated before/after member.
  const knownPositive = countDiagnosed([{ disposition: 'calibration', ordinal: 0, diagnostic: 'known positive' }]);
  const disconnectedNegative = countDiagnosed([{ disposition: 'calibration', ordinal: 0 }]);
  expect(knownPositive).toBe(1);
  expect(disconnectedNegative).toBe(0);
  expect(countDiagnosed(beforePopulation)).toBe(enumerated);
  expect(countDiagnosed(afterPopulation)).toBe(enumerated);
  return { enumerated, runnable, before, after, calibration: { knownPositive, disconnectedNegative } };
}

function recordAfter(
  item: number,
  classification: AfterEvidence['classification'],
  construction: string,
  observed: Record<string, unknown>,
  control: AfterEvidence['control'],
  population: ReachCount,
  covers: string,
  leavesUncovered: string,
): AfterEvidence {
  const [unstatedDependency, worthImpact] = dependencies[item];
  const evidence: AfterEvidence = {
    item,
    capturedAt: new Date().toISOString(),
    classification,
    construction,
    observed,
    control,
    population,
    covers,
    leavesUncovered,
    unstatedDependency,
    worthImpact,
  };
  process.stdout.write(`ENGINE_REMEDIATION_AFTER ${JSON.stringify(evidence)}\n`);
  return evidence;
}

function writeRole(projectDir: string, role: string): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  write(join(agentsDir, `${role}.yaml`), [
    `name: ${role}`,
    'description: remediation replay fixture',
    'model: default',
    'reasoning_effort: low',
    'tools: []',
    'prompt: fixture',
  ].join('\n'));
  return agentsDir;
}

async function waitForFile(directory: string, accept: (name: string) => boolean): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = readdirSync(directory).find(accept);
    if (match) return join(directory, match);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`timed out waiting for fixture file in ${directory}`);
}

function emptyKnowledgeGraph(): KnowledgeGraph {
  const at = '2026-09-19T00:00:00.000Z';
  return { nodes: [], edges: [], metadata: { createdAt: at, updatedAt: at } };
}

afterEach(() => {
  setFcGlobalDir(originalFcHome);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('engine remediation after-state, controls, and reach counts', () => {
  it('1 — enforces the run-local setup baseline at the gate consumer', async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    setFcGlobalDir(join(root, 'fc-home'));
    const created = createRun(projectDir, 'fixture', 'name: fixture', ['qa']);
    const attemptStartedAt = new Date(Date.now() - 10).toISOString();
    const attemptCompletedAt = new Date().toISOString();
    writeStageStatus(projectDir, created.runId, 'qa', {
      status: 'complete', retries: 0, startedAt: attemptStartedAt, completedAt: attemptCompletedAt,
      attempts: [{
        index: 1, status: 'complete', startedAt: attemptStartedAt, completedAt: attemptCompletedAt,
        duration_ms: 10, exitCode: 0, tokenUsage: 'unknown',
      }],
    });
    const baseline = validationBaseline(projectDir);
    write(join(created.runDirPath, 'validation_baseline.json'), JSON.stringify({
      version: 1, capturedAt: new Date().toISOString(), source: 'ship-setup-ready-record', baseline,
    }));
    write(join(created.runDirPath, 'verdict_qa.json'), JSON.stringify({ pass: true }));
    const prompt = buildStagePrompt({
      dependsOn: [], promptTemplate: 'audit', projectDir, runId: created.runId,
      runDir: created.runDirPath, taskDescription: '# fixture', isGate: true, stageId: 'qa',
    });
    const unchanged = await recordGateValidationDelta(projectDir, created.runId, 'qa', {
      runCommand: () => ({ exitCode: 1, stdout: 'FAIL spec/existing.test.ts\nTests 1 failed' }),
    });
    const unchangedVerdict = readGateVerdict(projectDir, 'qa', created.runId);
    const regressed = await recordGateValidationDelta(projectDir, created.runId, 'qa', {
      runCommand: () => ({ exitCode: 1, stdout: 'FAIL spec/existing.test.ts\nFAIL spec/new.test.ts\nTests 2 failed' }),
    });
    const regressedVerdict = readGateVerdict(projectDir, 'qa', created.runId);
    const control = createRun(projectDir, 'fixture', 'name: fixture', ['qa']);
    write(join(control.runDirPath, 'verdict_qa.json'), JSON.stringify({ pass: true }));
    const noBaselineVerdict = readGateVerdict(projectDir, 'qa', control.runId);
    expect(prompt).toContain('Engine-enforced validation baseline');
    expect(unchanged?.pass).toBe(true);
    expect(unchangedVerdict?.pass).toBe(true);
    expect(regressed?.pass).toBe(false);
    expect(regressed?.immutablePath).not.toBe(unchanged?.immutablePath);
    expect(existsSync(join(created.runDirPath, unchanged!.immutablePath!))).toBe(true);
    expect(existsSync(join(created.runDirPath, regressed!.immutablePath!))).toBe(true);
    expect(regressedVerdict).toMatchObject({ pass: false, reason: expect.stringContaining('recorded regressions') });
    expect(noBaselineVerdict?.pass).toBe(true);
    recordAfter(1, 'changed', 'known-red setup snapshot replayed after an accepting QA verdict', {
      promptCarriesBaseline: true, unchangedDelta: unchanged?.delta, unchangedVerdict,
      regressedDelta: regressed?.delta, regressedVerdict,
    }, {
      construction: 'run with neither setup snapshot nor replay artifact retains the gate-authored verdict',
      observed: noBaselineVerdict,
      differsBy: ['no exact setup snapshot', 'no replay command population'],
    }, reach(2, { unwired: 2 }, { unchangedAccepted: 1, regressionRejected: 1 }),
    'Exact setup commands and known-red identities are copied, prompted, replayed, and consumed.',
    'A legacy continuation with no baseline snapshot retains its gate-authored judgment.');
  });

  it('2 — distinguishes missing, refused, invalid, and ready setup state before launch', () => {
    const root = temporaryRoot();
    const stateRoot = join(root, 'fc-home');
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    const brief = '# Goal\n## What the report must show\n1. Record completion.\n';
    const canonical = realpathSync.native(projectDir);
    const digest = shipSetupBriefDigest(brief);
    const recordPath = shipSetupReadyRecordPath(canonical, digest, stateRoot);
    const missing = inspectShipSetupRecord(projectDir, brief, stateRoot);
    write(recordPath, JSON.stringify({
      version: 1, state: 'refused', ready: false, projectDir: canonical, targetDir: canonical,
      targetCanonicalDir: canonical, briefPath: join(projectDir, 'brief.md'), briefDigest: digest,
      readyRecordPath: recordPath, blockers: [{ reason: 'target collision' }],
    }));
    const refused = inspectShipSetupRecord(projectDir, brief, stateRoot);
    const launch = sourceCli(['quick', brief, '--project', projectDir, '--no-campaign', '--acknowledge-brief-warnings'], stateRoot);
    const baseline = validationBaseline(canonical);
    write(recordPath, JSON.stringify({
      version: 1, state: 'ready', ready: true, createdAt: new Date().toISOString(),
      projectDir: canonical, targetDir: canonical, targetCanonicalDir: canonical,
      briefPath: join(projectDir, 'brief.md'), briefDigest: digest, readyRecordPath: recordPath,
      validationBaseline: baseline,
    }));
    const ready = inspectShipSetupRecord(projectDir, brief, stateRoot);
    expect(missing.state).toBe('missing');
    expect(refused).toMatchObject({ state: 'refused', reason: 'target collision' });
    expect(launch.status).toBe(2);
    expect(launch.stderr).toContain('ship-setup refused');
    expect(ready.state).toBe('ready');
    recordAfter(2, 'changed', 'fresh quick launch against an exact refused setup record', {
      missing, refused, launchExit: launch.status, launchDiagnostic: launch.stderr.trim(), readyState: ready.state,
    }, {
      construction: 'same canonical target plus same brief digest with a valid ready baseline',
      observed: ready.state,
      differsBy: ['ready=true rather than false', 'valid validation baseline rather than blocker list'],
    }, reach(4, { silentlyUnknown: 3, ready: 1 }, { missing: 1, refused: 1, invalid: 1, ready: 1 }),
    'Fresh launches require an exact ready record and report the failure class.',
    'An initialized continuation remains resumable without repeating setup.');
  });

  it('3 — archives every declared output at terminal commit and verifies removal safety', async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    setFcGlobalDir(join(root, 'fc-home'));
    const created = createRun(projectDir, 'fixture', 'name: fixture', ['finalize']);
    const terminalPath = 'docs/final.md';
    const outputPath = 'docs/report.md';
    write(join(projectDir, terminalPath), '# final\n');
    write(join(projectDir, outputPath), 'archived report\n');
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    const state = readRunState(projectDir, created.runId);
    state.startedAt = startedAt;
    state.status = 'running';
    state.terminalStates = { complete: { paths: [terminalPath] } };
    state.declaredOutputs = [{
      path: outputPath, line: 2, source: 'outputs', disposition: 'create', expectedType: 'file',
    }];
    state.stages.finalize = {
      status: 'complete', retries: 0,
      attempts: [{ index: 1, status: 'complete', startedAt, writes: [terminalPath, outputPath] }],
    };
    writeRunState(projectDir, created.runId, state);
    write(join(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({
      version: 1, pass: true, checkedAt: new Date().toISOString(), errors: [],
      terminalOwners: { [terminalPath]: 'finalize' },
    }));
    const result = await tryTerminateOnTerminalState(state, {
      projectDir, runId: created.runId, runDirPath: created.runDirPath, iteration: 1,
      adapter: { run: async () => ({ output: '', exitCode: 0, duration_ms: 0 }) },
    });
    const archivedPath = join(created.runDirPath, 'declared_outputs', outputPath);
    const manifest = JSON.parse(readFileSync(join(created.runDirPath, 'declared_outputs_manifest.json'), 'utf-8')) as { outputs: unknown[] };
    const safe = isPathSafelyArchived(projectDir, created.runDirPath, outputPath, {
      exists: existsSync, readBytes: (path) => readFileSync(path),
    });
    write(join(projectDir, outputPath), 'changed after archive\n');
    const changedSafe = isPathSafelyArchived(projectDir, created.runDirPath, outputPath, {
      exists: existsSync, readBytes: (path) => readFileSync(path),
    });
    expect(result.decision).toBe('matched');
    expect(readFileSync(archivedPath, 'utf-8')).toBe('archived report\n');
    expect(manifest.outputs).toHaveLength(1);
    expect(safe).toBe(true);
    expect(changedSafe).toBe(false);
    expect(parseBriefFrontmatter('---\noutputs:\n  - path: docs/report.md\n---\n# Goal').outputs?.[0].path).toBe(outputPath);

    const plainProject = join(root, 'plain-project');
    mkdirSync(plainProject);
    write(join(plainProject, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\ndefault_max_iterations: 1\n');
    const agentsDir = writeRole(plainProject, 'worker');
    const plainBrief = [
      '---', 'outputs:', `  - path: ${outputPath}`, '---', '# Goal',
      '## What the report must show', '1. Produce and archive the report.', '',
    ].join('\n');
    const plain = await runWorkflow(
      {
        name: 'plain-output-after', defaults: { max_iterations: 1, max_retries: 0 },
        stages: [{
          id: 'work', role: 'worker', scope: [outputPath], depends_on: [], prompt_template: 'write report',
          skills: [], dynamic_dispatch: false, is_gate: false,
        }],
      },
      'name: plain-output-after',
      plainProject,
      { run: async (_prompt, _role, options) => {
        if (options.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        write(join(plainProject, outputPath), 'plain completion report\n');
        return { output: 'done', exitCode: 0, duration_ms: 1, writes: [outputPath], writeAttribution: 'structured' };
      } },
      new Map(), undefined, agentsDir, undefined, plainBrief, true,
    );
    const plainArchiveExists = existsSync(join(runDir(plainProject, plain.runId), 'declared_outputs', outputPath));
    expect(plain).toMatchObject({ status: 'complete' });
    expect(plainArchiveExists).toBe(true);

    const symlinkProject = join(root, 'symlink-project');
    const outside = join(root, 'outside-output');
    const symlinkRun = join(root, 'symlink-run');
    mkdirSync(symlinkProject);
    mkdirSync(outside);
    mkdirSync(symlinkRun);
    write(join(outside, 'report.md'), 'outside project\n');
    symlinkSync(outside, join(symlinkProject, 'docs'), 'dir');
    expect(() => archiveDeclaredOutputs(symlinkProject, symlinkRun, [{
      path: outputPath, line: 2, source: 'outputs', disposition: 'create', expectedType: 'file',
    }])).toThrow(/symlink/i);
    recordAfter(3, 'changed', 'terminal owner writes terminal artifact plus ignored declared report', {
      terminalDecision: result.decision, committedStatus: state.status, archivedPathExists: existsSync(archivedPath),
      manifestCount: manifest.outputs.length, safe, plainCompletionStatus: plain.status, plainArchiveExists,
      symlinkAncestorRefused: true,
    }, {
      construction: 'worktree output changes after archive, so current and archived hashes no longer agree',
      observed: { safeToRemove: changedSafe },
      differsBy: ['worktree bytes changed', 'archive manifest remains bound to prior digest'],
    }, reach(4, { inventoriedNotArchived: 4 }, {
      terminalArchivedAndSafe: 1, plainCompletionArchivedAndSafe: 1,
      archivedButChangedUnsafe: 1, symlinkAncestorRefused: 1,
    }),
    'Files and directory trees declared in outputs are copied with member hashes before terminal or ordinary completion.',
    'Missing, type-mismatched, undeclared, symlinked, or subsequently changed outputs still refuse archival or safe removal.');
  });

  it('4 — reports quarantine and only claims queued delivery for admitted guidance', () => {
    const root = temporaryRoot();
    const stateRoot = join(root, 'fc-home');
    const runId = 'guide-after';
    const directory = join(stateRoot, 'runs', runId);
    write(join(directory, 'run.json'), JSON.stringify({
      runId, status: 'running', taskDescription: '# guide',
      stages: { 'invalid target': { status: 'running' }, valid_stage: { status: 'running' } },
    }));
    const quarantined = sourceCli(['guide', '--run', runId, '--stage', 'invalid target', 'operator evidence'], stateRoot);
    const queued = sourceCli(['guide', '--run', runId, '--stage', 'valid_stage', 'valid evidence'], stateRoot);
    const ledger = readFileSync(join(directory, 'supervisor_guidance.md'), 'utf-8');
    expect(quarantined.status).toBe(2);
    expect(quarantined.stderr).toContain('quarantined');
    expect(quarantined.stderr).toContain('not queued');
    expect(queued.status).toBe(0);
    expect(queued.stdout).toContain('queued for stage');
    expect(queued.stdout).toContain('Delivery is not yet confirmed');
    expect(ledger).toContain('"quarantined":true');
    recordAfter(4, 'changed', 'invalid stage-key envelope returned quarantined by the guidance writer', {
      quarantinedExit: quarantined.status, quarantinedDiagnostic: quarantined.stderr.trim(),
      acceptedExit: queued.status, acceptedReceipt: queued.stdout.trim(),
    }, {
      construction: 'known stage with a syntactically admissible key produces an accepted but not-yet-delivered envelope',
      observed: queued.stdout.trim(),
      differsBy: ['valid envelope target syntax', 'accepted envelope disposition'],
    }, reach(2, { reportedDelivered: 2 }, { quarantineReported: 1, queuedNotDelivered: 1 }),
    'The CLI exposes the returned envelope disposition and delivery uncertainty.',
    'A quarantined message is not automatically reminted for another target.');
  });

  it('5 — re-queries cancellation convergence after an ambiguous response', async () => {
    const requests: string[] = [];
    const result = await cancelRunThroughControlPlane('cancel-after', undefined, {
      sendRequest: async (request) => {
        requests.push(request.cmd);
        if (request.cmd === 'cancel-run') throw new RpcOutcomeUnknownError('response lost after delivery.');
        return {
          ok: true, status: 'cancelled', runId: 'cancel-after', message: 'Cancellation confirmed.',
          observation: {
            unit: 'fixture.service', unitState: { kind: 'terminal', exitCode: 0 }, runReadable: true,
            schedulerPid: null, schedulerAlive: false, launchInFlight: false,
          },
        };
      },
    });
    const unresolvedCalls: string[] = [];
    const unresolved = await cancelRunThroughControlPlane('cancel-control', undefined, {
      sendRequest: async (request) => {
        unresolvedCalls.push(request.cmd);
        throw new RpcOutcomeUnknownError('both responses lost.');
      },
    }).catch((error: unknown) => error);
    expect(CANCELLATION_RPC_TIMEOUT_MS).toBeGreaterThan(1_500);
    expect(requests).toEqual(['cancel-run', 'cancel-status']);
    expect(result).toMatchObject({ ok: true, status: 'cancelled' });
    expect(unresolved).toBeInstanceOf(RpcOutcomeUnknownError);
    expect(unresolvedCalls).toEqual(['cancel-run', 'cancel-status']);
    recordAfter(5, 'changed', 'cancel mutates remote state and loses only the command response', {
      cancellationTimeoutMs: CANCELLATION_RPC_TIMEOUT_MS, requests, reportedStatus: result.status,
    }, {
      construction: 'both command response and independent status observation are unavailable',
      observed: { error: (unresolved as Error).name, requests: unresolvedCalls },
      differsBy: ['status RPC also loses its response', 'no converged observation can be validated'],
    }, reach(2, { outcomeUnknown: 2 }, { convergedReported: 1, outcomeUnknown: 1 }),
    'One bounded read-only observation reports a cancel that already converged.',
    'If the follow-up is also unavailable, the original outcome remains explicitly unknown.');
  });

  it('6 — refuses vacuous criteria while preserving substantive negation text', async () => {
    const emptyBrief = '# Goal\nDo useful work.\n';
    const substantiveBrief = '# Goal\n## What the report must show\n1. Prove this is not a criterion parser false negative.\n';
    const hyphenatedBrief = '# Goal\n## What the report must show\n1. Example-driven proof must include the failing identity.\n';
    const illustrativeBrief = '# Goal\n## What the report must show\n1. Example: an illustrative output shape only.\n';
    const empty = extractBriefCriteria(emptyBrief);
    const substantive = extractBriefCriteria(substantiveBrief);
    const hyphenated = extractBriefCriteria(hyphenatedBrief);
    const illustrative = extractBriefCriteria(illustrativeBrief);
    const preflight = inspectBrief(emptyBrief);
    const admission = inspectDispatchAdmission({
      dispatched: [], baseStages: [], dispatchStageId: 'plan', criteria: empty,
    });
    const rehearsal = await rehearseBriefIsolated(emptyBrief, {
      projectDir: temporaryRoot(), label: 'empty-criteria.md', render: false,
    });
    const launch = sourceCli(['quick', emptyBrief, '--project', PROJECT_ROOT, '--no-campaign'], temporaryRoot());
    expect(substantive.criteria).toHaveLength(1);
    expect(hyphenated.criteria).toHaveLength(1);
    expect(illustrative.criteria).toHaveLength(0);
    expect(illustrative.excluded).toHaveLength(1);
    expect(preflight.findings).toContainEqual(expect.objectContaining({ code: 'brief_criteria_missing' }));
    expect(rehearsal.exitCode).toBe(1);
    expect(rehearsal.simulated).toBe(false);
    expect(admission.pass).toBe(false);
    expect(launch.status).toBe(2);
    expect(launch.stderr).toContain('no structurally extractable criterion');
    recordAfter(6, 'changed', 'brief with zero structural criteria reaches preflight, quick, and dispatch admission', {
      extracted: empty.criteria.length, preflightCode: 'brief_criteria_missing', rehearsalExit: rehearsal.exitCode,
      rehearsalSimulated: rehearsal.simulated, dispatchErrors: admission.errors,
      launchExit: launch.status, substantiveCount: substantive.criteria.length,
      hyphenatedSubstantiveCount: hyphenated.criteria.length,
    }, {
      construction: 'numbered item uses an explicit Example: label and describes only an illustrative shape',
      observed: illustrative.excluded?.[0],
      differsBy: ['explicit label terminated by punctuation', 'illustrative shape rather than an enforceable proof obligation'],
    }, reach(4, { silentZero: 3, explicitExampleExcluded: 1 }, {
      explicitRefusal: 1, substantiveRetained: 2, explicitExampleExcluded: 1,
    }),
    'Zero criteria now fail launch, preflight, rehearsal, and dispatch admission; exclusions are recorded explicitly.',
    'Explicitly illustrative leading markers remain excluded.');
  });

  it('7 — preserves uncaptured dependency preimages and still removes proven-absent paths', { timeout: 30_000 }, async () => {
    const root = temporaryRoot('engine-remediation-rollback-after-');
    const projectDir = join(root, 'project');
    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
    const agentsDir = writeRole(projectDir, 'writer');
    setFcGlobalDir(join(root, 'fc-home'));
    const dependencyPath = ['node_modules', 'fixture-package', 'pre-existing.js'].join('/');
    write(join(projectDir, dependencyPath), 'operator preimage\n');
    const escapedStage: StageConfig = {
      id: 'writer', role: 'writer', scope: [], depends_on: [], prompt_template: 'write fixture',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const config: WorkflowConfig = { name: 'rollback-after', defaults: { max_iterations: 1, max_retries: 0 }, stages: [escapedStage] };
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      write(join(projectDir, dependencyPath), 'stage replacement\n');
      return { output: 'wrote escaped path', exitCode: 0, duration_ms: 1, writes: [dependencyPath], writeAttribution: 'structured' };
    } };
    const escaped = await runWorkflow(
      config, 'name: rollback-after', projectDir, adapter, new Map(), undefined,
      agentsDir, undefined, '# rollback fixture', true, false,
    );
    const escapedEvents = readRunEvents(projectDir, escaped.runId).filter((event) => event.type === 'live_constraint_violation');
    expect(existsSync(join(projectDir, dependencyPath))).toBe(true);
    expect(escapedEvents[0]?.detail).toContain('could not restore');

    const absentPath = 'docs/proven-absent.md';
    write(join(projectDir, absentPath), 'new file\n');
    const absentRestore = restoreProjectPath(projectDir, absentPath, { exists: false, provenance: 'observed' });
    expect(absentRestore).toEqual({ restored: true });
    expect(existsSync(join(projectDir, absentPath))).toBe(false);
    recordAfter(7, 'changed', 'out-of-scope overwrite below a rollback-inventory-excluded dependency tree', {
      runStatus: escaped.status, pathPreserved: existsSync(join(projectDir, dependencyPath)),
      violationDetail: escapedEvents[0]?.detail,
    }, {
      construction: 'exact path is recorded as observed absent before a later write and then restored from that captured baseline',
      observed: { restoration: absentRestore, existsAfterRollback: false },
      differsBy: ['exact path was captured before invocation', 'baseline carries positive observed-absence provenance'],
    }, reach(2, { deletedUnknown: 1, deletedProvenAbsent: 1 }, { preservedUnknown: 1, deletedProvenAbsent: 1 }),
    'Rollback deletion requires observed-absent provenance.',
    'Uncaptured pre-existing files remain modified and the stage fails visibly rather than fabricating restoration.');
  });

  it('8 — rejects condition literals outside runtime domains', () => {
    const impossible: StageConfig = {
      id: 'conditional', role: 'worker', depends_on: ['producer'],
      condition: 'producer.status == status_that_does_not_exist', prompt_template: 'never',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const possible: StageConfig = { ...impossible, condition: 'producer.status == complete' };
    const producer: StageConfig = {
      id: 'producer', role: 'worker', depends_on: [], prompt_template: 'produce', skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const rejected = inspectDispatchAdmission({ dispatched: [producer, impossible], baseStages: [], dispatchStageId: 'plan' });
    const accepted = inspectDispatchAdmission({ dispatched: [producer, possible], baseStages: [], dispatchStageId: 'plan' });
    const workflowPath = join(temporaryRoot(), 'static-impossible.yaml');
    write(workflowPath, [
      'name: static-impossible', 'stages:', '  - id: producer', '    role: worker',
      '  - id: conditional', '    role: worker', '    depends_on: [producer]',
      '    condition: producer.status == status_that_does_not_exist', '',
    ].join('\n'));
    let staticError = '';
    try { loadWorkflow(workflowPath); } catch (error) {
      staticError = error instanceof Error ? error.message : String(error);
    }
    expect(rejected.pass).toBe(false);
    expect(rejected.errors.join('\n')).toContain('cannot occur');
    expect(accepted.pass).toBe(true);
    expect(staticError).toContain('status literal "status_that_does_not_exist" cannot occur');
    recordAfter(8, 'changed', 'dispatch condition compares status with a literal absent from the status enumeration', {
      pass: rejected.pass, errors: rejected.errors, staticWorkflowError: staticError,
    }, {
      construction: 'same dependency graph with the emitted complete status literal',
      observed: accepted,
      differsBy: ['enumerated literal', 'condition can become true after producer completion'],
    }, reach(3, { admitted: 3 }, { rejectedDynamicImpossible: 1, rejectedStaticImpossible: 1, admittedReachable: 1 }),
    'Static workflows and dynamic dispatches check status and framework research-condition literals against emitted domains.',
    'Non-equality comparisons and ordinary output fields retain runtime evaluation.');
  });

  it('9 — classifies all run-directory creation routes and cleans only proven stale entries', () => {
    const root = temporaryRoot('engine-remediation-runs-after-');
    const projectDir = join(root, 'project');
    const stateRoot = join(root, 'fc-home');
    mkdirSync(projectDir);
    setFcGlobalDir(stateRoot);
    const activeReservation = reserveRun(projectDir);
    expect(existsSync(join(activeReservation.runDirPath, RUN_RESERVATION_FILE))).toBe(true);
    const initializedReservation = reserveRun(projectDir);
    initializeReservedRun(projectDir, initializedReservation.runId, 'fixture', 'name: fixture', ['work']);
    expect(existsSync(join(initializedReservation.runDirPath, 'run.json'))).toBe(true);
    const unknownId = 'unknown-mutator-target';
    appendRunEvent(projectDir, unknownId, {
      type: 'stage_complete', runId: unknownId, timestamp: new Date().toISOString(),
    });
    writeKG(projectDir, 'unknown-kg-target', emptyKnowledgeGraph());
    const iterationLogId = 'unknown-iteration-target';
    appendIterationLog(
      projectDir,
      iterationLogId,
      1,
      readRunState(projectDir, initializedReservation.runId),
      [],
    );
    expect(existsSync(join(stateRoot, 'runs', unknownId, RUN_RESERVATION_FILE))).toBe(true);
    expect(existsSync(join(stateRoot, 'runs', 'unknown-kg-target', RUN_RESERVATION_FILE))).toBe(true);
    expect(existsSync(join(stateRoot, 'runs', iterationLogId, RUN_RESERVATION_FILE))).toBe(true);
    const proposer = createCampaignProposerScratch(root);
    expect(proposer.startsWith(join(stateRoot, 'runs'))).toBe(false);
    const escapedDirectory = join(stateRoot, 'escape');
    write(join(escapedDirectory, 'run.json'), JSON.stringify({ runId: '../escape' }));
    expect(() => appendRunEvent(projectDir, '../escape', {
      type: 'guidance_written', runId: '../escape', timestamp: new Date().toISOString(),
    })).toThrow(/safe directory name/i);
    expect(() => appendIterationLog(
      projectDir,
      '../escape',
      1,
      readRunState(projectDir, initializedReservation.runId),
      [],
    )).toThrow(/safe directory name/i);
    const traversalWriteBlocked = !existsSync(join(escapedDirectory, 'events.jsonl'));
    expect(traversalWriteBlocked).toBe(true);
    const completed = readRunState(projectDir, initializedReservation.runId);
    completed.status = 'complete';
    writeRunState(projectDir, initializedReservation.runId, completed);
    const opaque = join(stateRoot, 'runs', 'campaign-loop-propose-legacy');
    mkdirSync(opaque, { recursive: true });
    const cleaned = sourceCli(['clean', '--keep', '0'], stateRoot);
    expect(cleaned.status).toBe(0);
    expect(existsSync(initializedReservation.runDirPath)).toBe(false);
    expect(existsSync(activeReservation.runDirPath)).toBe(true);
    expect(existsSync(opaque)).toBe(true);
    recordAfter(9, 'changed', 'exercise reservation, initialization, proposer scratch, and arbitrary event/KG identifiers', {
      activeReservationMarker: true, initializedState: true, arbitraryMutatorsClassified: true,
      proposerOutsideRunsRoot: true, traversalWriteBlocked, cleanExit: cleaned.status,
    }, {
      construction: 'readable completed run is older than keep count while active reservation and opaque entry coexist',
      observed: { completedRemoved: true, reservationPreserved: true, opaquePreserved: true },
      differsBy: ['readable terminal run.json', 'not an active reservation marker'],
    }, reach(5, { unreadableRunDirectories: 4, traversalWriteOutsideRoot: 1 }, {
      activeReservation: 1, stateFirstInitialization: 1, tempScratch: 1, mutatorClassified: 1,
      traversalRejected: 1,
    }),
    'Every engine-created entry is initialized, actively reserved, or outside the runs root; clean reaps readable old runs and expired valid reservations.',
    'Opaque foreign directories are preserved for operator inspection.');
  });

  it('10 — projects one generated-path catalog into all three consumers', () => {
    const root = temporaryRoot();
    write(join(root, 'config', 'defaults.yaml'), 'live_constraint_exempt_patterns:\n  - .gradle/**\n');
    const defaults = loadProjectDefaultsLocally(root);
    const member = '.gradle/caches/tool/file.bin';
    const catalogRows = GENERATED_PATH_POLICIES.filter((entry) => entry.directoryName === '.gradle');
    expect(ROLLBACK_INVENTORY_EXCLUDED_DIRECTORIES.has('.gradle')).toBe(true);
    expect(defaults.live_constraint_exempt_patterns).toContain('.gradle/**');
    expect(isRecognizedGeneratedCachePath(member.split('/'))).toBe(true);
    expect(scopeRevisionPathsForViolations([member])).toEqual([member]);
    expect(catalogRows).toHaveLength(1);
    const ordinary = 'src/cache.ts';
    expect(isRecognizedGeneratedCachePath(ordinary.split('/'))).toBe(false);
    const uncataloguedRoot = temporaryRoot();
    write(join(uncataloguedRoot, 'config', 'defaults.yaml'), 'live_constraint_exempt_patterns:\n  - .unlisted_cache/**\n');
    expect(() => loadProjectDefaultsLocally(uncataloguedRoot)).toThrow(/unsafe non-cache pattern/i);
    recordAfter(10, 'changed', 'classify .gradle through rollback exclusion, exempt validation, and generated-scope projection', {
      catalogRows: catalogRows.length, rollbackExcluded: true, exemptAccepted: true,
      recognizedCache: true, scopeProjection: scopeRevisionPathsForViolations([member]),
      uncataloguedPatternRefused: true,
    }, {
      construction: 'ordinary source path has no catalog policy and stays literal',
      observed: { path: ordinary, recognized: false, projection: scopeRevisionPathsForViolations([ordinary]) },
      differsBy: ['no generated directory anchor', 'no content-addressed member pattern'],
    }, reach(4, { classifiedGenerated: 1, notClassified: 2, uncataloguedPatternAccepted: 1 }, {
      classifiedGenerated: 3, uncataloguedPatternRefused: 1,
    }),
    'A single catalog owns rollback exclusions, safe cache anchors, and stable content-addressed scopes.',
    'Unknown caches remain literal until deliberately added to the catalog.');
  });

  it('11 — uses build-generation hashes rather than source mtimes in ship preflight', async () => {
    const projectDir = temporaryRoot('engine-remediation-freshness-after-');
    const staged = join(projectDir, 'staged-dist');
    write(join(projectDir, 'src', 'probe.ts'), 'export const probe = 1;\n');
    write(join(projectDir, 'tsconfig.json'), '{}\n');
    write(join(projectDir, 'package.json'), '{}\n');
    write(join(staged, 'probe.js'), 'export const probe = 1;\n');
    write(join(staged, 'probe.d.ts'), 'export declare const probe = 1;\n');
    publishBuildGeneration({ projectRoot: projectDir, stagedDistDir: staged, manifest: createBuildManifest(projectDir, staged) });
    const outputMtime = statSync(join(projectDir, 'dist', 'probe.js')).mtimeMs;
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(projectDir, 'src', 'probe.ts'), future, future);
    const runs = join(projectDir, 'isolated-runs');
    mkdirSync(runs);
    const current = await collectShipPreflight(['ship-preflight', '--no-baseline'], {
      projectDir, packageRoot: projectDir, runsRoot: () => runs,
      probeDaemon: async () => ({ state: 'fresh', loadedBuild: 'same', diskBuild: 'same' }),
    });
    write(join(projectDir, 'src', 'probe.ts'), 'export const probe = 2;\n');
    const stale = await collectShipPreflight(['ship-preflight', '--no-baseline'], {
      projectDir, packageRoot: projectDir, runsRoot: () => runs,
      probeDaemon: async () => ({ state: 'fresh', loadedBuild: 'same', diskBuild: 'same' }),
    });
    expect(current.report.daemonFreshness.sourceToDist.state).toBe('current');
    expect(statSync(join(projectDir, 'dist', 'probe.js')).mtimeMs).toBe(outputMtime);
    expect(stale.report.daemonFreshness.sourceToDist.state).toBe('stale');
    recordAfter(11, 'changed', 'source timestamp advances while source/output bytes still match the published manifest', {
      current: current.report.daemonFreshness.sourceToDist, outputMtimeUnchanged: true,
    }, {
      construction: 'source bytes change without publishing a matching generation',
      observed: stale.report.daemonFreshness.sourceToDist,
      differsBy: ['source content hash changed', 'manifest generation was not republished'],
    }, reach(2, { mtimeStale: 2 }, { hashCurrent: 1, hashStale: 1 }),
    'Ship preflight uses the same content-addressed build manifest as publication and daemon freshness.',
    'Projects without a readable manifest remain unknown rather than guessed current.');
  });

  it('12 — refuses a research round budget larger than the engine iteration budget', { timeout: 20_000 }, async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\ndefault_max_iterations: 5\n');
    const agentsDir = writeRole(projectDir, 'worker');
    setFcGlobalDir(join(root, 'fc-home'));
    const brief = [
      '---', 'research:', '  baseline: 0', '  policy: greedy_stack', '  result_file: docs/result.json',
      '  stop:', '    max_rounds: 15', '---', '# Goal', '## What the report must show', '1. Record a round.',
    ].join('\n');
    const parsed = parseBriefFrontmatter(brief);
    const assessment = assessResearchIterationBudget(parsed.research, 5);
    const admission = createBriefAdmission(inspectBrief(brief), {
      kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString(),
    });
    const stage: StageConfig = {
      id: 'worker', role: 'worker', depends_on: [], prompt_template: 'work', skills: [], dynamic_dispatch: false, is_gate: false,
    };
    let calls = 0;
    const final = await runWorkflow(
      { name: 'budget-after', defaults: { max_iterations: 5, max_retries: 0 }, stages: [stage] },
      'name: budget-after', projectDir, { async run() { calls += 1; return { output: 'unexpected', exitCode: 0, duration_ms: 1 }; } },
      new Map(), undefined, agentsDir, undefined, brief, true, false, undefined, true, admission,
    );
    const fits = assessResearchIterationBudget({ ...parsed.research!, stop: { ...parsed.research!.stop, maxRounds: 5 } }, 5);
    expect(assessment.pass).toBe(false);
    expect(final.status).toBe('failed');
    expect(final.failureReason).toContain('max_rounds (15) exceeds');
    expect(calls).toBe(0);
    expect(fits.pass).toBe(true);
    recordAfter(12, 'changed', 'research max_rounds=15 with max_iterations=5 reaches scheduler admission', {
      assessment, finalStatus: final.status, failureReason: final.failureReason, adapterCalls: calls,
    }, {
      construction: 'max_rounds=5 with max_iterations=5; finalization settles in the last round iteration',
      observed: fits,
      differsBy: ['round limit fits iteration limit', 'no iteration is promised beyond authored rounds'],
    }, reach(2, { engineBoundFirst: 1, researchBound: 1 }, { refusedMismatch: 1, admittedFit: 1 }),
    'Quick and scheduler compare the two limits before stage execution.',
    'The engine does not reserve a separate iteration for same-iteration terminal settlement.');
  });

  it('13 — confirms both glob matchers already agree on dot descendants', () => {
    const pattern = 'cache/**';
    const descendant = 'cache/.hidden/nested/result.bin';
    const sibling = 'other/.hidden/result.bin';
    const observed = {
      descendantScope: scopeContainsPath([pattern], descendant),
      descendantExempt: matchesLiveConstraintExemptPattern(descendant, pattern),
      siblingScope: scopeContainsPath([pattern], sibling),
      siblingExempt: matchesLiveConstraintExemptPattern(sibling, pattern),
    };
    expect(observed).toEqual({ descendantScope: true, descendantExempt: true, siblingScope: false, siblingExempt: false });
    recordAfter(13, 'not_a_defect', 'literal tree pattern matched against a descendant containing a dot segment', observed, {
      construction: 'same dot descendant under a sibling tree', observed: { scope: false, exempt: false },
      differsBy: ['different literal prefix', 'outside both declared trees'],
    }, reach(2, { bothMatch: 1, bothReject: 1 }, { bothMatch: 1, bothReject: 1 }),
    'The recorded literal-tree case was measured and both matchers agree.',
    'Other glob-language differences were not inferred from this one case.');
  });

  it('14 — applies campaign regression direction', () => {
    const entries = (scores: number[], higherIsBetter: boolean): CampaignEntry[] => scores.map((score, index) => ({
      seq: index + 1, runId: `run-${index}`, score, metric: 'error_count', higherIsBetter,
      gate: 'quality', pass: true, timestamp: `2026-09-${17 + index}T00:00:00.000Z`,
    }));
    const trigger = { enabled: true, regressionAfter: 2, plateauAfter: 99, repeatedFailureAfter: 99 };
    const improvingLower = checkCampaignHealth(entries([30, 20, 10], false), trigger);
    const worseningLower = checkCampaignHealth(entries([10, 20, 30], false), trigger);
    const legacyHigher = checkCampaignHealth(entries([30, 20, 10], true), trigger);
    expect(improvingLower).toBeNull();
    expect(worseningLower?.type).toBe('regression');
    expect(legacyHigher?.type).toBe('regression');
    recordAfter(14, 'changed', 'lower-is-better scores improve 30→20→10', {
      alert: improvingLower, worseningControl: worseningLower,
    }, {
      construction: 'higher-is-better direction with two decreases remains a regression',
      observed: legacyHigher,
      differsBy: ['optimization direction is higher', 'decreases move away from optimum'],
    }, reach(2, { falseRegression: 1, regression: 1 }, { improvement: 1, regression: 1 }),
    'New campaign entries persist direction and health compares scores accordingly.',
    'Historical entries without direction retain the legacy higher-is-better interpretation.');
  });

  it('15 — captures the current research outcome into the QA prompt', () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    const directory = join(root, 'run');
    mkdirSync(directory);
    write(join(directory, 'research_round_1_no_candidate_consumed.json'), JSON.stringify({
      label: 'no-safe-candidate', outcome: 'no_candidate', reason: 'all candidates failed safety',
    }));
    write(join(directory, 'brief_criteria.json'), JSON.stringify({
      criteria: [{ id: 'criterion-measured', text: 'Report the measured candidate score.' }],
    }));
    const prompt = buildStagePrompt({
      dependsOn: [], promptTemplate: 'audit', projectDir, runId: 'fixture', runDir: directory,
      taskDescription: '# fixture', isGate: true, researchOutcomeGate: true,
      stageId: 'qa', criterionRefs: ['criterion-measured'],
    });
    const captured = readResearchGateCandidate(directory, 'qa');
    expect(captured?.kind).toBe('no_candidate');
    expect(captured?.gateStageId).toBe('qa');
    expect(prompt).toContain('Framework-captured research round outcome');
    expect(prompt).toContain('no-safe-candidate');
    expect(prompt).toContain('all candidates failed safety');

    const currentDirectory = join(root, 'current-run');
    mkdirSync(currentDirectory);
    write(join(currentDirectory, 'research_round_1_no_candidate_consumed.json'), JSON.stringify({
      label: 'prior', outcome: 'no_candidate', reason: 'prior round',
    }));
    const resultFile = join(projectDir, 'docs', 'result.json');
    write(resultFile, JSON.stringify({ label: 'current', result: 42 }));
    write(join(currentDirectory, 'run.json'), JSON.stringify({
      runId: 'current-run', startedAt: new Date(Date.now() - 1_000).toISOString(),
      research: { baseline: 0, policy: 'greedy_stack', resultFile: 'docs/result.json', stop: {} },
    }));
    const measuredPrompt = buildStagePrompt({
      dependsOn: [], promptTemplate: 'audit current result', projectDir, runId: 'current-run', runDir: currentDirectory,
      taskDescription: '# fixture', isGate: true, researchOutcomeGate: true,
      stageId: 'qa-current', criterionRefs: ['criterion-measured'],
    });
    const current = readResearchGateCandidate(currentDirectory, 'qa-current');
    expect(current).toMatchObject({ kind: 'measured', gateStageId: 'qa-current', label: 'current', result: 42 });
    expect(measuredPrompt).toContain('label="current"; result=42');

    const closeoutPrompt = buildStagePrompt({
      dependsOn: [], promptTemplate: 'audit closeout only', projectDir, runId: 'fixture', runDir: directory,
      taskDescription: '# fixture', isGate: true, researchOutcomeGate: false,
      stageId: 'closeout', criterionRefs: ['criterion-measured'],
    });
    expect(closeoutPrompt).not.toContain('Framework-captured research round outcome');
    expect(readResearchGateCandidate(directory, 'closeout')).toBeUndefined();
    recordAfter(15, 'changed', 'immutable consumed no-candidate evidence exists before gate prompt construction', {
      captured, promptMentionsOutcome: true, boundArtifactReadAtConsumer: true,
    }, {
      construction: 'research closeout gate has no outcome-producing stage in its dependency closure',
      observed: { promptCarriesOutcome: false, boundArtifact: null },
      differsBy: ['no upstream outcome-producing owner', 'gate audits closeout rather than the round outcome'],
    }, reach(3, { outcomePromptMissing: 2, unrelatedGateUnchanged: 1 }, { noCandidatePrompted: 1, freshMeasuredPrompted: 1, unrelatedGateUnchanged: 1 }),
    'Only gates auditing an outcome-producing dependency receive gate-bound framework-classified measured/no-candidate/invalid/absent evidence.',
    'Unrelated closeout gates retain their prior prompt shape; outcome gates still judge criteria and the framework does not manufacture a pass.');
  });

  it('16 — redispatches the owning producer only for missing-outcome rejection', () => {
    const producer: StageConfig = {
      id: 'measure', role: 'worker', scope: ['docs/result.json'], depends_on: [], prompt_template: 'measure',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const gate: StageConfig = {
      id: 'qa', role: 'qa', depends_on: ['measure'], prompt_template: 'audit', skills: [], dynamic_dispatch: false, is_gate: true,
    };
    const repair: StageConfig = {
      id: 'repair_report', role: 'worker', depends_on: ['qa'], retry_to: ['qa'], prompt_template: 'repair',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const research = { baseline: 0, policy: 'greedy_stack' as const, resultFile: 'docs/result.json', stop: {} };
    const omitted = findGateRecoveryStages([producer, gate, repair], ['qa'], { qa: 'no measurement exists' }, research);
    const quality = findGateRecoveryStages([producer, gate, repair], ['qa'], { qa: 'report rationale is unclear' }, research);
    const negated = findGateRecoveryStages(
      [producer, gate, repair], ['qa'],
      { qa: 'The report needs prose edits; no missing measurement remains.' }, research,
    );
    expect(omitted.map((stage) => stage.id)).toEqual(['measure']);
    expect(quality.map((stage) => stage.id)).toEqual(['repair_report']);
    expect(negated.map((stage) => stage.id)).toEqual(['repair_report']);
    recordAfter(16, 'changed', 'gate rejection explicitly says the round measurement is absent', {
      selected: omitted.map((stage) => stage.id), negatedSelected: negated.map((stage) => stage.id),
    }, {
      construction: 'same graph but rejection concerns report quality, not missing outcome evidence',
      observed: quality.map((stage) => stage.id),
      differsBy: ['effective rejection category', 'producer rerun cannot address prose quality'],
    }, reach(3, { repairOnly: 3 }, {
      missingOutcomeProducerOnly: 1, reportQualityRepairOnly: 1, negatedOmissionRepairOnly: 1,
    }),
    'Completed ordinary ancestors owning result/sidecar paths re-pend for missing-outcome rejection.',
    'Other gate rejection still spends repair cycles only on retry_to stages.');
  });

  it('17 — rejects terminal ownership transfer through scope revision', { timeout: 20_000 }, async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
    const agentsDir = writeRole(projectDir, 'worker');
    setFcGlobalDir(join(root, 'fc-home'));
    const terminalPath = 'docs/escalation.md';
    const stage: StageConfig = {
      id: 'repair', role: 'worker', scope: [], depends_on: [], prompt_template: 'request terminal',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    let decisionPath = '';
    let calls = 0;
    const final = await runWorkflow(
      { name: 'terminal-owner-after', defaults: { max_iterations: 1, max_retries: 0 }, stages: [stage] },
      'name: terminal-owner-after', projectDir, { async run(_prompt, _role, opts) {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        calls += 1;
        write(join(opts.runDir, 'dispatch_admission.json'), JSON.stringify({
          version: 1, pass: true, errors: [], terminalOwners: { [terminalPath]: 'finalizer' },
        }));
        const stagePath = join(opts.runDir, 'stages', opts.stageId);
        const requestedPaths = [terminalPath];
        write(join(stagePath, 'scope_revision_request.json'), JSON.stringify({
          version: 1, kind: 'scope_revision', requestId: 'terminal-non-owner-after',
          runId: basename(opts.runDir), stageId: opts.stageId, attemptIndex: 1,
          requestedPaths, pathDigest: scopePathDigest(requestedPaths), reason: 'claim finalizer path',
        }));
        decisionPath = await waitForFile(stagePath, (name) => name.startsWith('scope_revision_decision_'));
        return { output: 'request handled', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      } }, new Map(), undefined, agentsDir, undefined,
      '---\nterminal_states:\n  escalated:\n    paths: [docs/escalation.md]\n---\n# fixture', true, false,
    );
    const decision = JSON.parse(readFileSync(decisionPath, 'utf-8')) as Record<string, unknown>;
    const event = readRunEvents(projectDir, final.runId).find((entry) => entry.type === 'scope_revision_decided');
    expect(decision).toMatchObject({ accepted: false, decision: 'rejected' });
    expect(String(decision.rejectionReason)).toContain('admitted owner is finalizer');
    expect(event).toMatchObject({ stageId: 'repair', decision: 'rejected' });
    expect(calls).toBe(1);
    recordAfter(17, 'changed', 'repair requests the exact terminal path owned by finalizer in current dispatch admission', {
      decision, event, calls,
    }, {
      construction: 'same requester asks for a non-terminal report path not reserved to another stage',
      observed: { policy: 'ordinary capability requests retain normal validation' },
      differsBy: ['path is not in terminalOwners', 'no ownership transfer occurs'],
    }, reach(2, { scopeAccepted: 2 }, { terminalRejected: 1, ordinaryEvaluatedNormally: 1 }),
    'Scope revision reads current dispatch admission and rejects overlap with another terminal owner.',
    'Ordinary paths and requests by the admitted owner retain existing policy.');
  });

  it('18 — unwraps a Make target through dry-run into an exact existing collector', { timeout: 30_000 }, async () => {
    const root = temporaryRoot();
    const sourceDir = join(root, 'source');
    const targetDir = join(root, 'target');
    const stateDir = join(root, 'state');
    const briefPath = join(sourceDir, 'brief.md');
    write(join(sourceDir, 'Makefile'), 'test:\n\t@node --test spec/example.test.js\n');
    write(join(sourceDir, 'spec', 'example.test.js'), 'export {};\n');
    write(briefPath, '# Goal\n## What the report must show\n1. Preserve the test population.\n');
    const calls: string[] = [];
    const createWorktree: GitWorktreeCreator = (request) => {
      mkdirSync(request.targetDir, { recursive: true });
      write(join(request.targetDir, 'Makefile'), readFileSync(join(sourceDir, 'Makefile'), 'utf-8'));
      write(join(request.targetDir, 'spec', 'example.test.js'), 'export {};\n');
      return { exitCode: 0 };
    };
    const report = await runShipSetup([
      'ship-setup', '--brief', briefPath, '--project', sourceDir, '--target', targetDir,
      '--base', 'fixture-base', '--branch', 'fixture-branch',
    ], {
      createWorktree,
      runValidationCommand: (request) => {
        calls.push(`${request.cwd}:${request.display}`);
        return request.display.includes('make -n')
          ? { exitCode: 0, stdout: 'node --test spec/example.test.js\n', durationMs: 1 }
          : { exitCode: 0, stdout: '1 passed\n', durationMs: 1 };
      },
      globalDir: () => stateDir,
    });
    expect(report.state).toBe('ready');
    expect(report.testPopulation).toMatchObject({ state: 'matched' });
    expect(report.testPopulation?.source?.identities).toEqual(['spec/example.test.js']);
    expect(calls.filter((call) => call.includes('make -n'))).toHaveLength(2);

    const opaqueTarget = join(root, 'opaque-target');
    const opaque = await runShipSetup([
      'ship-setup', '--brief', briefPath, '--project', sourceDir, '--target', opaqueTarget,
      '--base', 'fixture-base', '--branch', 'opaque-branch',
    ], {
      createWorktree,
      runValidationCommand: (request) => request.display.includes('make -n')
        ? { exitCode: 0, stdout: 'prepare fixtures\nnode --test spec/example.test.js\n', durationMs: 1 }
        : { exitCode: 0, stdout: '1 passed\n', durationMs: 1 },
      globalDir: () => stateDir,
    });
    expect(opaque.testPopulation?.state).toBe('unverified');
    recordAfter(18, 'changed', 'source and target Make test each dry-run to one node --test command with readable literal file', {
      population: report.testPopulation, dryRunCalls: calls.filter((call) => call.includes('make -n')).length,
    }, {
      construction: 'Make dry-run expands to multiple recipe command lines',
      observed: opaque.testPopulation,
      differsBy: ['multiple command lines', 'recipe is not one safely translatable collector'],
    }, reach(2, { unverified: 2 }, { exactMatched: 1, opaqueUnverified: 1 }),
    'Make node-test, Vitest, pytest, and package-script wrappers translate to existing exact collectors.',
    'Dynamic, shell-composed, or multi-command recipes remain explicitly unverified.');
  });

  it('19 — validates coupled defaults with the candidate worktree module in a child process', () => {
    const projectDir = temporaryRoot();
    const marker = join(projectDir, 'candidate-validator-ran.txt');
    const defaults = loadProjectDefaultsLocally(PROJECT_ROOT);
    write(join(projectDir, 'package.json'), JSON.stringify({ type: 'module' }));
    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: candidate-only-value\n');
    write(join(projectDir, 'src', 'config.ts'), [
      "import { writeFileSync } from 'node:fs';",
      `const marker = ${JSON.stringify(marker)};`,
      "export function loadProjectDefaultsLocally() { writeFileSync(marker, 'ran'); return " + JSON.stringify(defaults) + '; }',
    ].join('\n'));
    write(join(projectDir, 'scripts', 'validate-project-defaults.ts'), [
      "import { pathToFileURL } from 'node:url';",
      "import { join } from 'node:path';",
      'const root = process.argv[2];',
      "const candidate = await import(pathToFileURL(join(root, 'src', 'config.ts')).href);",
      'const defaults = candidate.loadProjectDefaultsLocally(root);',
      "process.stdout.write(JSON.stringify({version: 1, ok: true, defaults}) + '\\n');",
    ].join('\n'));
    const loaded = loadProjectDefaults(projectDir);
    expect(existsSync(marker)).toBe(true);
    expect(loaded.timeout_ms).toBe(defaults.timeout_ms);

    const ordinary = join(projectDir, 'ordinary');
    write(join(ordinary, 'config', 'defaults.yaml'), 'default_timeout_ms: candidate-only-value\n');
    const ordinaryError = (() => {
      try { loadProjectDefaults(ordinary); return undefined; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    })();
    expect(ordinaryError).toContain('default_timeout_ms');
    recordAfter(19, 'changed', 'worktree contains both candidate config module and validator handshake script', {
      markerExists: true, loadedTimeout: loaded.timeout_ms, validationSource: 'candidate_child_process',
    }, {
      construction: 'ordinary project has invalid deployed-schema YAML but no candidate validator pair',
      observed: ordinaryError,
      differsBy: ['no candidate config module', 'no validator handshake entrypoint'],
    }, reach(2, { deployedRejected: 2 }, { candidateAccepted: 1, deployedRejected: 1 }),
    'Engine worktrees validate coupled defaults through their candidate implementation in an isolated Node child.',
    'Ordinary projects and incomplete candidate pairs retain deployed-schema validation.');
  });

  it('20 — installs follow interrupt handlers before emitting the first event', () => {
    const root = temporaryRoot();
    const directory = join(root, 'runs', 'race-run');
    write(join(directory, 'run.json'), JSON.stringify({
      runId: 'race-run', status: 'running', projectDir: join(root, 'project'), stages: {},
    }));
    appendFileSync(join(directory, 'events.jsonl'), `${JSON.stringify({
      type: 'guidance_written', runId: 'race-run', timestamp: new Date().toISOString(),
      stageId: 'work', detail: 'awaited-after-handler',
    })}\n`);
    const childScript = [
      "import { pathToFileURL } from 'node:url';",
      "import { join } from 'node:path';",
      'const { cmdEventsWithDeps } = await import(pathToFileURL(process.argv[1]).href);',
      'let sent = false;',
      'const writer = { write(chunk) { const value = String(chunk); process.stdout.write(value);',
      "if (!sent && value.includes('awaited-after-handler')) { sent = true; process.stdout.write(`HANDLER_COUNT=${process.listenerCount('SIGINT')}\\n`); process.kill(process.pid, 'SIGINT'); } } };",
      "await cmdEventsWithDeps(['events', '--run', 'race-run', '--json', '--follow'], {",
      "runsRoot: join(process.argv[2], 'runs'), stdout: writer, stderr: process.stderr,",
      'followPollMs: 1, maxFollowPolls: 1, sleep: async () => undefined, });',
    ].join('\n');
    const followed = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', childScript,
      join(PROJECT_ROOT, 'src', 'cli-events.ts'), root,
    ], { cwd: PROJECT_ROOT, env: { ...process.env, HOME: root, FC_HOME: root }, encoding: 'utf-8', timeout: 10_000 });
    const nonFollowScript = [
      "import { pathToFileURL } from 'node:url';",
      'const { cmdEventsWithDeps } = await import(pathToFileURL(process.argv[1]).href);',
      "await cmdEventsWithDeps(['events', '--run', 'race-run', '--json'], { runsRoot: process.argv[2], stdout: {write(){}}, stderr: process.stderr });",
      "process.stdout.write(`HANDLER_COUNT=${process.listenerCount('SIGINT')}\\n`);",
    ].join('\n');
    const nonFollow = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', nonFollowScript,
      join(PROJECT_ROOT, 'src', 'cli-events.ts'), join(root, 'runs'),
    ], { cwd: PROJECT_ROOT, env: { ...process.env, HOME: root, FC_HOME: root }, encoding: 'utf-8', timeout: 10_000 });
    expect(followed.status).toBe(0);
    expect(followed.signal).toBeNull();
    expect(followed.stdout).toContain('HANDLER_COUNT=1');
    expect(nonFollow.status).toBe(0);
    expect(nonFollow.stdout).toContain('HANDLER_COUNT=0');
    recordAfter(20, 'changed', 'follow emits a pre-existing matched event whose writer synchronously self-sends SIGINT', {
      exitCode: followed.status, signal: followed.signal, output: followed.stdout.trim().split('\n'),
    }, {
      construction: 'non-follow one-shot invocation emits then returns without installing persistent signal listeners',
      observed: { exitCode: nonFollow.status, output: nonFollow.stdout.trim() },
      differsBy: ['follow mode disabled', 'no interrupt-driven polling loop'],
    }, reach(2, { handlerBeforeEmit: 0, noHandlerOneShot: 1, processDeath: 1 }, { handlerBeforeEmit: 1, noHandlerOneShot: 1 }),
    'Follow handlers are registered before the initial emit and removed in finally.',
    'Default signal action still applies outside a live follow invocation.');
  });
});
