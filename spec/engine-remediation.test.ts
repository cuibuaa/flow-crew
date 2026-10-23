import './test-support/policy-runtime.js';
import { hashRollbackFileSync } from '../src/rollback-content-store.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import { artifacts } from './spec_contracts/declared-fixtures.js';
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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import { createBuildManifest, publishBuildOutputs } from '../src/build-manifest.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { cancelRunThroughControlPlane } from '../src/cancellation-client.js';
import { collectShipPreflight } from '../src/cli-ship-preflight.js';
import { loadEngineDefaults } from '../src/config.js';
import { createArchivedPathVerifier } from '../src/declared-output-archive.js';
import { buildStagePrompt } from '../src/handoff.js';
import { routePendingOperatorGuidanceToStage } from '../src/guidance.js';
import { CANCELLATION_RPC_TIMEOUT_MS, RpcOutcomeUnknownError } from '../src/orchestrator-rpc.js';
import { rehearseBriefIsolated } from './test-support/rehearse.js';

import type {
  ProjectValidationBaseline,
  ValidationCommandResult,
} from '../src/project-validation.js';
import { beginResearchInputGeneration, readResearchGateCandidate } from '../src/research-candidate.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { appendRunEvent, readRunEvents } from '../src/run-events.js';
import { assessResearchIterationBudget, appendIterationLog, findGateRecoveryStages, inspectDispatchAdmission, loadWorkflow, parseBriefFrontmatter, parseDispatchedStageConfig, readGateEvaluation, recordGateValidationDelta, restoreProjectPath, runWorkflow, tryTerminateOnTerminalState, type StageConfig, type WorkflowConfig } from '../src/scheduler.js';
import {
  inspectShipSetupRecord,
  shipSetupBriefDigest,
  shipSetupReadyRecordPath,
} from '../src/ship-setup-record.js';
import { createRun } from './test-support/create-run.js';
import {
  fcGlobalDir,
  initializeReservedRun,
  readRunState,
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

afterEach(() => {
  setFcGlobalDir(originalFcHome);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('engine behaviour contracts', () => {
  it('enforces the run-local setup baseline at the gate consumer', async () => {
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
    const unchangedVerdict = readGateEvaluation(projectDir, 'qa', created.runId);
    const regressed = await recordGateValidationDelta(projectDir, created.runId, 'qa', {
      runCommand: () => ({ exitCode: 1, stdout: 'FAIL spec/existing.test.ts\nFAIL spec/new.test.ts\nTests 2 failed' }),
    });
    const regressedVerdict = readGateEvaluation(projectDir, 'qa', created.runId);
    const control = createRun(projectDir, 'fixture', 'name: fixture', ['qa']);
    write(join(control.runDirPath, 'verdict_qa.json'), JSON.stringify({ pass: true }));
    const noBaselineVerdict = readGateEvaluation(projectDir, 'qa', control.runId);
    expect(prompt).not.toContain('Engine-enforced validation baseline');
    expect(unchanged?.pass).toBe(true);
    expect(unchangedVerdict?.pass).toBe(true);
    expect(regressed?.pass).toBe(false);
    expect(regressed?.immutablePath).not.toBe(unchanged?.immutablePath);
    expect(existsSync(join(created.runDirPath, unchanged!.immutablePath!))).toBe(true);
    expect(existsSync(join(created.runDirPath, regressed!.immutablePath!))).toBe(true);
    expect(regressedVerdict).toMatchObject({ pass: false, reason: expect.stringContaining('recorded regressions') });
    expect(noBaselineVerdict?.pass).toBe(true);
  });

  it('distinguishes missing, refused, invalid, and ready setup state before launch', () => {
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
    expect(launch.status).toBe(1);
    expect(launch.stderr).toContain('ship-setup refused');
    expect(ready.state).toBe('ready');
  });

  it('archives every declared output at terminal commit and verifies removal safety', async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    setFcGlobalDir(join(root, 'fc-home'));
    const created = createRun(projectDir, 'fixture', 'name: fixture', ['finalize', 'review']);
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
    const producedAt = new Date(Date.now() - 500).toISOString();
    const reviewedAt = new Date(Date.now() - 250).toISOString();
    state.stages.finalize = {
      status: 'complete', retries: 0,
      attempts: [{ index: 1, status: 'complete', startedAt, completedAt: producedAt, writes: [terminalPath, outputPath] }],
    };
    state.stages.review = { status: 'complete', retries: 0,
      attempts: [{ index: 1, status: 'complete', startedAt: reviewedAt, completedAt: reviewedAt }] };
    state.dispatchedStages = [
      parseDispatchedStageConfig({ id: 'finalize', role: 'writer', scope: [terminalPath, outputPath] }),
      parseDispatchedStageConfig({ id: 'review', role: 'qa', is_gate: true, depends_on: ['finalize'], scope: [] }),
    ];
    write(join(created.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: true, reason: 'Accepted the produced report.' }));
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
    const safe = createArchivedPathVerifier(projectDir, created.runDirPath, {
      hashFile: hashRollbackFileSync,
    })(outputPath);
    write(join(projectDir, outputPath), 'changed after archive\n');
    const changedSafe = createArchivedPathVerifier(projectDir, created.runDirPath, {
      hashFile: hashRollbackFileSync,
    })(outputPath);
    expect(result.decision).toBe('matched');
    expect(readFileSync(archivedPath, 'utf-8')).toBe('archived report\n');
    expect(manifest.outputs).toHaveLength(1);
    expect(safe).toBe(true);
    expect(changedSafe).toBe(false);
    expect(parseBriefFrontmatter('---\noutputs:\n  - path: docs/report.md\n---\n# Goal').outputs?.[0].path).toBe(outputPath);});

  it('reports quarantine and only claims queued delivery for admitted guidance', () => {
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
    const requests = readFileSync(join(directory, 'user_input.md'), 'utf-8');
    expect(existsSync(join(directory, 'supervisor_guidance.md'))).toBe(false);
    expect(requests).toContain('"quarantined":true');
    routePendingOperatorGuidanceToStage(directory, 'valid_stage');
    const ledger = readFileSync(join(directory, 'supervisor_guidance.md'), 'utf-8');
    expect(quarantined.status).toBe(1);
    expect(quarantined.stderr).toContain('quarantined');
    expect(quarantined.stderr).toContain('not queued');
    expect(queued.status).toBe(0);
    expect(queued.stdout).toContain('queued for stage');
    expect(queued.stdout).toContain('Delivery is not yet confirmed');
    expect(ledger).toContain('"quarantined":true');
  });

  it('keeps cancellation outcome unknown after delivery without another control request', async () => {
    const requests: string[] = [];
    const result = await cancelRunThroughControlPlane('cancel-after', undefined, {
      sendRequest: async request => {
        requests.push(request.cmd);
        throw new RpcOutcomeUnknownError('response lost after delivery.');
      },
    }).catch((error: unknown) => error);
    expect(CANCELLATION_RPC_TIMEOUT_MS).toBeGreaterThan(1_500);
    expect(requests).toEqual(['cancel']);
    expect(result).toBeInstanceOf(RpcOutcomeUnknownError);
  });

  it('refuses vacuous criteria while preserving substantive negation text', async () => {
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
    expect(admission.errors).toContainEqual({ code: 'criteria_missing', field: 'criteria', message: 'brief_criteria.json contains zero criteria; dispatch cannot prove coverage' });
    expect(launch.status).toBe(1);
    expect(launch.stderr).toContain('structurally extractable criterion');
  });

  it('preserves uncaptured dependency preimages and still removes proven-absent paths', { timeout: 30_000 }, async () => {
    const root = temporaryRoot('engine-remediation-rollback-after-');
    const projectDir = join(root, 'project');
    const agentsDir = writeRole(projectDir, 'writer');
    setFcGlobalDir(join(root, 'fc-home'));
    const dependencyPath = ['.venv', 'fixture-package', 'pre-existing.js'].join('/');
    write(join(projectDir, dependencyPath), 'operator preimage\n');
    const escapedStage: StageConfig = { criterion_refs: [], artifact_contract: artifacts([], [], []),
      id: 'writer', role: 'writer', scope: [], depends_on: [], prompt_template: 'write fixture',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const config: WorkflowConfig = { name: 'rollback-after', defaults: { max_iterations: 1, max_retries: 0 }, stages: [escapedStage] };
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      write(join(projectDir, dependencyPath), 'stage replacement\n');
      return fixtureResult({ output: 'wrote escaped path', exitCode: 0, duration_ms: 1, writes: [dependencyPath], writeAttribution: 'structured' }, opts);
    } };
    const escaped = await runWorkflow(
      config, 'name: rollback-after', projectDir, adapter, new Map(), undefined,
      agentsDir, undefined, '# rollback fixture', true,
    );
    const escapedEvents = readRunEvents(projectDir, escaped.runId).filter((event) => event.type === 'live_constraint_violation');
    expect(existsSync(join(projectDir, dependencyPath))).toBe(true);
    expect(escapedEvents).toEqual([]);
    expect(escaped.status).toBe('complete');

    const absentPath = 'docs/proven-absent.md';
    write(join(projectDir, absentPath), 'new file\n');
    const absentRestore = restoreProjectPath(projectDir, absentPath, { exists: false, provenance: 'observed' });
    expect(absentRestore).toEqual({ restored: true });
    expect(existsSync(join(projectDir, absentPath))).toBe(false);
  });

  it('rejects condition literals outside runtime domains', () => {
    const impossible: StageConfig = { criterion_refs: [], artifact_contract: artifacts([], [], []),
      id: 'conditional', role: 'worker', depends_on: ['producer'],
      condition: 'producer.status == status_that_does_not_exist', prompt_template: 'never',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const possible: StageConfig = { ...impossible, condition: 'producer.status == complete' };
    const producer: StageConfig = { criterion_refs: [], artifact_contract: artifacts([], [], []),
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
    expect(rejected.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('cannot occur');
    expect(accepted.pass).toBe(true);
    expect(staticError).toContain('status literal "status_that_does_not_exist" cannot occur');
  });

  it('classifies all run-directory creation routes and cleans only proven stale entries', () => {
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
    const iterationLogId = 'unknown-iteration-target';
    appendIterationLog(
      projectDir,
      iterationLogId,
      1,
      readRunState(projectDir, initializedReservation.runId),
      [],
    );
    expect(existsSync(join(stateRoot, 'runs', unknownId, RUN_RESERVATION_FILE))).toBe(true);
    expect(existsSync(join(stateRoot, 'runs', iterationLogId, RUN_RESERVATION_FILE))).toBe(true);
    const escapedDirectory = join(stateRoot, 'escape');
    write(join(escapedDirectory, 'run.json'), JSON.stringify({ runId: '../escape' }));
    expect(() => appendRunEvent(projectDir, '../escape', {
      type: 'guidance_written', runId: '../escape', timestamp: new Date().toISOString(),
    })).toThrow('RUN_IDENTITY_INVALID');
    expect(() => appendIterationLog(
      projectDir,
      '../escape',
      1,
      readRunState(projectDir, initializedReservation.runId),
      [],
    )).toThrow('RUN_IDENTITY_INVALID');
    const traversalWriteBlocked = !existsSync(join(escapedDirectory, 'events.jsonl'));
    expect(traversalWriteBlocked).toBe(true);
    const unprovenReservation = reserveRun(projectDir);
    initializeReservedRun(projectDir, unprovenReservation.runId, 'fixture', 'name: fixture', ['work']);
    const unproven = readRunState(projectDir, unprovenReservation.runId);
    unproven.status = 'complete';
    writeRunState(projectDir, unprovenReservation.runId, unproven);
    const completed = readRunState(projectDir, initializedReservation.runId);
    completed.status = 'complete';
    // A terminal label alone does not establish that scheduler-owned commands
    // retired. Model a settled controller and an empty owned-command set.
    completed.engineCheckpoint = { version: 2, runId: completed.runId, projectDir,
      pid: 2147483647, processes: [], at: new Date().toISOString() };
    writeRunState(projectDir, initializedReservation.runId, completed);
    const opaque = join(stateRoot, 'runs', 'campaign-loop-propose-legacy');
    mkdirSync(opaque, { recursive: true });
    const cleaned = sourceCli(['clean', '--keep', '0'], stateRoot);
    expect(cleaned.status).toBe(0);
    expect(existsSync(initializedReservation.runDirPath)).toBe(false);
    expect(existsSync(activeReservation.runDirPath)).toBe(true);
    expect(existsSync(unprovenReservation.runDirPath)).toBe(true);
    expect(existsSync(opaque)).toBe(true);
  });

  it('uses build-generation hashes rather than source mtimes in ship preflight', async () => {
    const projectDir = temporaryRoot('engine-remediation-freshness-after-');
    const staged = temporaryRoot('engine-remediation-staging-');
    write(join(projectDir, 'src', 'probe.ts'), 'export const probe = 1;\n');
    write(join(projectDir, 'tsconfig.json'), '{}\n');
    write(join(projectDir, 'package.json'), '{}\n');
    write(join(staged, 'probe.js'), 'export const probe = 1;\n');
    write(join(staged, 'probe.d.ts'), 'export declare const probe = 1;\n');
    publishBuildOutputs({ projectRoot: projectDir, stagedDistDir: staged, manifest: createBuildManifest(projectDir, staged) });
    const outputMtime = statSync(join(projectDir, 'dist', 'probe.js')).mtimeMs;
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(projectDir, 'src', 'probe.ts'), future, future);
    const runs = join(projectDir, 'isolated-runs');
    mkdirSync(runs);
    const current = await collectShipPreflight(['ship-preflight'], {
      projectDir, packageRoot: projectDir, runsRoot: () => runs,
      probeDaemon: async () => ({ state: 'fresh', loadedBuild: 'same', diskBuild: 'same' }),
    });
    write(join(projectDir, 'src', 'probe.ts'), 'export const probe = 2;\n');
    const stale = await collectShipPreflight(['ship-preflight'], {
      projectDir, packageRoot: projectDir, runsRoot: () => runs,
      probeDaemon: async () => ({ state: 'fresh', loadedBuild: 'same', diskBuild: 'same' }),
    });
    expect(current.report.daemonFreshness.sourceToDist.state).toBe('current');
    expect(statSync(join(projectDir, 'dist', 'probe.js')).mtimeMs).toBe(outputMtime);
    expect(stale.report.daemonFreshness.sourceToDist.state).toBe('stale');
  });

  it('refuses a research round budget larger than the engine iteration budget', { timeout: 20_000 }, async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
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
    const stage: StageConfig = { criterion_refs: [], artifact_contract: artifacts([], [], []),
      id: 'worker', role: 'worker', depends_on: [], prompt_template: 'work', skills: [], dynamic_dispatch: false, is_gate: false,
    };
    let calls = 0;
    const final = await runWorkflow(
      { name: 'budget-after', defaults: { max_iterations: 5, max_retries: 0 }, stages: [stage] },
      'name: budget-after', projectDir, { async run(_record0, _record1, recordOpts: import("../src/adapters/base.js").RunOpts) { calls += 1; return fixtureResult({ output: 'unexpected', exitCode: 0, duration_ms: 1 }, recordOpts); } },
      new Map(), undefined, agentsDir, undefined, brief, true, undefined, true, admission,
    );
    const fits = assessResearchIterationBudget({ ...parsed.research!, stop: { ...parsed.research!.stop, maxRounds: 5 } }, 5);
    expect(assessment.pass).toBe(false);
    expect(final.status).toBe('failed');
    expect(final.failureReason).toContain('max_rounds (15) exceeds');
    expect(calls).toBe(0);
    expect(fits.pass).toBe(true);
  });

  it('captures the current research outcome into the QA prompt', () => {
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
    const currentState = {
      runId: 'current-run', startedAt: new Date(Date.now() - 1_000).toISOString(),
      stages: {},
      research: { baseline: 0, policy: 'greedy_stack', resultFile: 'docs/result.json', stop: {} },
    } as StoreState;
    beginResearchInputGeneration(projectDir, currentState);
    write(join(currentDirectory, 'run.json'), JSON.stringify(currentState));
    write(resultFile, JSON.stringify({ label: 'current', result: 42 }));
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
  });

  it('redispatches the owning producer only for missing-outcome rejection', () => {
    const producer: StageConfig = { criterion_refs: [], artifact_contract: artifacts([], [], []),
      id: 'measure', role: 'worker', scope: ['docs/result.json'], depends_on: [], prompt_template: 'measure',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const gate: StageConfig = { criterion_refs: [], artifact_contract: artifacts([{ id: 'verdict', root: 'run', path: "verdict_qa.json" }], [], []),
      id: 'qa', role: 'qa', depends_on: ['measure'], prompt_template: 'audit', skills: [], dynamic_dispatch: false, is_gate: true,
    };
    const repair: StageConfig = { criterion_refs: [], artifact_contract: artifacts([], [], []),
      id: 'repair_report', role: 'worker', depends_on: ['qa'], retry_to: ['qa'], prompt_template: 'repair',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const research = { baseline: 0, policy: 'greedy_stack' as const, resultFile: 'docs/result.json', stop: {} };
    const omitted = findGateRecoveryStages([producer, gate, repair], ['qa'], research, { qa: { gateId: 'qa', authoredVerdict: { pass: true }, effectiveVerdict: { pass: false, refusal: { kind: 'research_outcome_absent' } }, rejectionKind: 'omitted_research_outcome' } });
    const quality = findGateRecoveryStages([producer, gate, repair], ['qa'], research);
    expect(omitted.map((stage) => stage.id)).toEqual(['measure']);
    expect(quality.map((stage) => stage.id)).toEqual(['repair_report']);
  });

  it('installs follow interrupt handlers before emitting the first event', () => {
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
  });
});
