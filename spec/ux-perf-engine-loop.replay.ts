import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import * as codexModule from '../src/adapters/codex.js';
import {
  captureRepairRoundSnapshot,
  consumeSupervisorReject,
  inspectDispatchAdmission,
  inspectRealityCheckReachability,
  parseDispatchedStageConfig,
  runWorkflow,
  writeRepairRoundDiffArtifact,
  type WorkflowConfig,
} from '../src/scheduler.js';
import * as schedulerModule from '../src/scheduler.js';
import { Supervisor } from '../src/supervisor.js';
import * as supervisorModule from '../src/supervisor.js';
import { inspectTemporalResearchTests } from '../src/temporal-test-guard.js';
import * as workerModule from '../src/worker.js';
import {
  scopePathDigest,
  type ScopeRevisionRequestV1,
} from '../src/runtime-negotiation.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  setFcGlobalDir,
  writeStageStatus,
  writeRunState,
  type StageStatus,
} from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';
import { recordedEvidence } from './test-support/recorded-evidence.js';
import { parse as parseYaml } from 'yaml';

const roots: string[] = [];
let priorStateRoot: string | undefined;
let priorEnvironment: Record<string, string | undefined> | undefined;

// Namespace lookups keep the file loadable in the frozen base checkout. The
// dedicated unchanged-base seam cases below exercise only APIs that existed at
// the baseline revision; current-only unit cases may use the newly exported
// observability helpers.
const readCodexCapabilityMemory = codexModule.readCodexCapabilityMemory!;
const rememberCodexUnsupportedEffort = codexModule.rememberCodexUnsupportedEffort!;
const resolveCodexCapabilityIdentity = codexModule.resolveCodexCapabilityIdentity!;
const appendResearchTemporalPathContract = schedulerModule.appendResearchTemporalPathContract!;
const stageWithInheritedScope = schedulerModule.stageWithInheritedScope!;
const buildSupervisorRolePrompt = supervisorModule.buildSupervisorRolePrompt!;
const computeSupervisorEvidenceBinding = supervisorModule.computeSupervisorEvidenceBinding!;
const supervisorEvidenceDigest = supervisorModule.supervisorEvidenceDigest!;
const beginAttemptEvidenceGeneration = workerModule.beginAttemptEvidenceGeneration!;

function temporaryRoot(prefix = 'flowcrew-ux-loop-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const GIT_FIXTURE_SCRIPT = [
  "import { spawnSync } from 'node:child_process';",
  // gc.auto=0: a background `git gc --auto` spawned by a fixture commit can still be writing
  // under .git when afterEach removes the root, which surfaced on CI as ENOTEMPTY.
  'const result = spawnSync(\'git\', [\'-c\', \'gc.auto=0\', ...JSON.parse(process.argv[1])], { encoding: \'utf8\' });',
  'if (result.error) throw result.error;',
  'if (result.status !== 0) { process.stderr.write(result.stderr ?? \'\'); process.exit(result.status ?? 1); }',
].join('\n');

function runFixtureGit(cwd: string, args: string[], isolationRoot: string): void {
  execFileSync(process.execPath, [
    '--input-type=module', '-e', GIT_FIXTURE_SCRIPT, JSON.stringify(args),
  ], {
    cwd,
    env: { ...process.env, HOME: isolationRoot, FC_HOME: isolationRoot },
    stdio: 'pipe',
  });
}

afterEach(() => {
  vi.useRealTimers();
  if (priorStateRoot !== undefined) {
    setFcGlobalDir(priorStateRoot);
    priorStateRoot = undefined;
  }
  if (priorEnvironment) {
    for (const [key, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    priorEnvironment = undefined;
  }
  // Retry: a fixture's git child may still hold or write files under .git for a moment.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function stage(raw: Record<string, unknown>) {
  return parseDispatchedStageConfig({
    prompt_template: 'bounded replay', skills: [], is_gate: false, criterion_refs: [],
    ...raw,
  });
}

describe('UX/performance engine-loop evidence replays', () => {
  it('item 1: a stale log and engine placeholder cannot become current-attempt rejection evidence', () => {
    const runDirectory = temporaryRoot();
    const stagePath = join(runDirectory, 'stages', 'audit_round_02');
    mkdirSync(stagePath, { recursive: true });
    const stale = recordedEvidence('item1_attempt1_stale_output');
    const placeholderEvent = JSON.parse(
      recordedEvidence('item1_engine_placeholder_shape').toString('utf-8'),
    ) as { item: { aggregated_output: string } };
    const placeholderText = placeholderEvent.item.aggregated_output
      .slice(placeholderEvent.item.aggregated_output.indexOf('\n') + 1);
    const placeholderMetric = JSON.parse(placeholderText) as Record<string, unknown>;
    writeFileSync(join(stagePath, 'live.log'), stale);
    writeFileSync(join(runDirectory, 'verdict_audit_round_02.json'), '{"pass":false,"reason":"attempt 1"}\n');
    const startedAt = '2026-09-02T11:40:00.000Z';
    const generation = beginAttemptEvidenceGeneration(runDirectory, 'audit_round_02', 2, startedAt);
    writeFileSync(join(stagePath, 'live.log'), Buffer.concat([
      stale, recordedEvidence('item1_engine_placeholder_shape'),
    ]));
    writeFileSync(join(stagePath, 'metric.json'), JSON.stringify(placeholderMetric));
    const status: StageStatus = {
      status: 'complete', retries: 1,
      attempts: [{ index: 2, status: 'complete', startedAt, completedAt: '2026-09-02T11:41:00.000Z' }],
    };
    expect(computeSupervisorEvidenceBinding(runDirectory, 'audit_round_02', status))
      .toMatchObject({ attemptIndex: 2, emittedDeliverable: false });

    writeFileSync(join(stagePath, 'output_attempt_2.md'), 'attempt 2 correct output\n');
    const bound = computeSupervisorEvidenceBinding(runDirectory, 'audit_round_02', status)!;
    expect(bound.emittedDeliverable).toBe(true);

    // Changing bytes before the attempt boundary cannot change this generation.
    const log = readFileSync(join(stagePath, 'live.log'));
    const rewritten = Buffer.concat([Buffer.from('x'.repeat(stale.byteLength)), log.subarray(stale.byteLength)]);
    writeFileSync(join(stagePath, 'live.log'), rewritten);
    expect(computeSupervisorEvidenceBinding(runDirectory, 'audit_round_02', status)?.generation).toBe(bound.generation);
    expect(generation.segmentStart).toBeGreaterThan(stale.byteLength);

    // Current-attempt output remains novelty-bearing.
    writeFileSync(join(stagePath, 'live.log'), Buffer.concat([rewritten, Buffer.from('current attempt delta\n')]));
    expect(computeSupervisorEvidenceBinding(runDirectory, 'audit_round_02', status)?.generation).not.toBe(bound.generation);
  });

  it('item 1: a rejection bound to an older evidence generation cannot re-pend the later correct output', () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-reject-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const work = stage({ id: 'audit_round_02', role: 'qa', scope: [], depends_on: [], dependency_reasons: {} });
    const created = createRun(projectDir, 'reject-generation-replay', 'fixture', [work.id]);
    const startedAt = '2026-09-02T11:40:00.000Z';
    beginAttemptEvidenceGeneration(created.runDirPath, work.id, 2, startedAt);
    writeFileSync(join(created.runDirPath, 'stages', work.id, 'output_attempt_2.md'), 'correct later output\n');
    writeFileSync(
      join(created.runDirPath, 'stages', work.id, 'metric.json'),
      recordedEvidence('item1_later_correct_metric'),
    );
    const status: StageStatus = {
      status: 'complete', retries: 1, completedAt: '2026-09-02T11:41:00.000Z',
      attempts: [{ index: 2, status: 'complete', startedAt, completedAt: '2026-09-02T11:41:00.000Z' }],
    };
    writeStageStatus(projectDir, created.runId, work.id, status);
    const state = readRunState(projectDir, created.runId);
    state.stages[work.id] = status;
    writeRunState(projectDir, created.runId, state);
    const current = computeSupervisorEvidenceBinding(created.runDirPath, work.id, status)!;
    const signals = join(created.runDirPath, 'signals');
    mkdirSync(signals, { recursive: true });
    writeFileSync(join(signals, `reject_${work.id}.json`), JSON.stringify({
      version: 2, stage: work.id, reason: 'recorded stale contradiction',
      evidence: { ...current, generation: '0'.repeat(64) },
    }));
    expect(consumeSupervisorReject(state, [work], [work.id], {
      projectDir, runId: created.runId, runDirPath: created.runDirPath, iteration: 1,
    })).toBe(false);
    expect(state.stages[work.id].status).toBe('complete');
    expect(readdirSync(join(created.runDirPath, 'supervisor_rejections', 'discarded'))).toHaveLength(1);
    expect(readRunEvents(projectDir, created.runId).some((event) => event.type === 'supervisor_reject_discarded')).toBe(true);
  });

  it('unchanged-base seam item 1: an unprovable stale generation is never applied to the completed attempt', () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-reject-base-seam-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const work = stage({ id: 'audit_round_02', role: 'qa', scope: [], depends_on: [], dependency_reasons: {} });
    const created = createRun(projectDir, 'reject-base-seam', 'fixture', [work.id]);
    const startedAt = '2026-09-02T11:40:52.000Z';
    const status: StageStatus = {
      status: 'complete', retries: 1, completedAt: '2026-09-02T12:11:23.000Z',
      attempts: [{ index: 2, status: 'complete', startedAt, completedAt: '2026-09-02T12:11:23.000Z' }],
    };
    writeStageStatus(projectDir, created.runId, work.id, status);
    const state = readRunState(projectDir, created.runId);
    state.stages[work.id] = status;
    writeRunState(projectDir, created.runId, state);
    const stagePath = join(created.runDirPath, 'stages', work.id);
    mkdirSync(stagePath, { recursive: true });
    writeFileSync(join(stagePath, 'live.log'), 'attempt 1: I wrote the metric artifact\n');
    writeFileSync(join(stagePath, 'metric.json'), JSON.stringify({
      hasMetric: false, source: { kind: 'engine_attempt_default' },
    }));
    const signals = join(created.runDirPath, 'signals');
    mkdirSync(signals, { recursive: true });
    writeFileSync(join(signals, `reject_${work.id}.json`), JSON.stringify({
      version: 2,
      stage: work.id,
      reason: 'stale log contradicted the placeholder metric',
      evidence: {
        version: 1,
        stageId: work.id,
        attemptIndex: 1,
        attemptStartedAt: '2026-09-02T11:09:20.000Z',
        generation: '1'.repeat(64),
        emittedDeliverable: true,
      },
    }));

    expect(consumeSupervisorReject(state, [work], [work.id], {
      projectDir, runId: created.runId, runDirPath: created.runDirPath, iteration: 2,
    })).toBe(false);
    expect(state.stages[work.id].status).toBe('complete');
  });

  it('item 1: output emitted during a supervisor call cannot be blamed for the evidence captured before that call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T11:41:15.000Z'));
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-reject-observation-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const created = createRun(projectDir, 'reject-observation-race', 'fixture', ['audit_round_02']);
    const stagePath = join(created.runDirPath, 'stages', 'audit_round_02');
    mkdirSync(stagePath, { recursive: true });
    writeFileSync(join(stagePath, 'live.log'), 'attempt 1: I wrote the metric artifact\n');
    const attemptStartedAt = '2026-09-02T11:40:52.000Z';
    const status: StageStatus = {
      status: 'running', retries: 1, startedAt: '2026-09-02T11:09:20.000Z',
      attempts: [{ index: 2, status: 'running', startedAt: attemptStartedAt }],
    };
    writeStageStatus(projectDir, created.runId, 'audit_round_02', status);
    const state = readRunState(projectDir, created.runId);
    state.status = 'running';
    state.stages.audit_round_02 = status;
    writeRunState(projectDir, created.runId, state);
    beginAttemptEvidenceGeneration(created.runDirPath, 'audit_round_02', 2, attemptStartedAt);
    writeFileSync(join(stagePath, 'metric.json'), JSON.stringify({
      hasMetric: false, source: { kind: 'engine_attempt_default' },
    }));
    const adapter: Adapter = { async run() {
      // This is the later attempt's correct deliverable, emitted after the
      // assessment input was frozen but before the REJECT response arrived.
      writeFileSync(join(stagePath, 'output_attempt_2.md'), 'correct attempt 2 output\n');
      return {
        output: '{"verdict":"REJECT","target_stage":"audit_round_02","reason":"stale log contradicts placeholder","guidance":null}',
        exitCode: 0, duration_ms: 1,
      };
    } };
    const supervisor = new Supervisor(projectDir, created.runId, adapter, {
      enabled: true, adapter: 'mock', model: 'default', reasoningEffort: 'low',
      pollIntervalMs: 10, routineAssessmentIntervalMs: 10, cooldownAfterActionMs: 0,
      maxAssessmentsPerIteration: 20, tailBytes: 16_384, minDeltaBytes: 0,
      stuckThresholdMs: 600_000,
    }, 'reject only the exact observed deliverable');
    supervisor.start();
    await vi.advanceTimersByTimeAsync(15);
    supervisor.stop();

    expect(readdirSync(join(created.runDirPath, 'signals'))).not.toContain('reject_audit_round_02.json');
    expect(readFileSync(join(stagePath, 'output_attempt_2.md'), 'utf-8')).toContain('correct attempt 2');
  });

  it('unchanged-base seam item 2: a mismatched attempt receives one durable rejection and actionable non-hot wait guidance', async () => {
    const requestBytes = recordedEvidence('item2_mismatched_request');
    const recordedRequest = JSON.parse(requestBytes.toString('utf-8')) as ScopeRevisionRequestV1;
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-ux-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'coder.yaml'), [
      'name: coder', 'description: replay', 'model: default', 'reasoning_effort: default',
      'tools: []', 'prompt: replay',
    ].join('\n'));
    const config: WorkflowConfig = {
      name: 'mismatched-scope-replay', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: recordedRequest.stageId, role: 'coder', depends_on: [], scope: ['src/declared.ts'],
        prompt_template: 'replay mismatch', skills: [], dynamic_dispatch: false,
        is_gate: false, criterion_refs: [],
      }],
    };
    const allocated = createRun(projectDir, config.name, 'fixture', [recordedRequest.stageId]);
    const exactRunDir = join(dirname(allocated.runDirPath), recordedRequest.runId);
    renameSync(allocated.runDirPath, exactRunDir);
    const created = { runId: recordedRequest.runId, runDirPath: exactRunDir };
    writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
    const initial = readRunState(projectDir, created.runId);
    initial.runId = created.runId;
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);
    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      const stageDirectory = join(opts.runDir, 'stages', opts.stageId);
      writeFileSync(join(stageDirectory, 'scope_revision_request.json'), requestBytes);
      const decision = await waitForPathEvent(stageDirectory, () => {
        const name = readdirSync(stageDirectory).find((file) => file.startsWith('scope_revision_decision_'));
        return name ? JSON.parse(readFileSync(join(stageDirectory, name), 'utf-8')) as Record<string, unknown> : undefined;
      });
      expect(decision).toMatchObject({
        accepted: false,
        requestId: recordedRequest.requestId,
        attemptIndex: recordedRequest.attemptIndex,
        pathDigest: recordedRequest.pathDigest,
      });
      expect(String(decision.rejectionReason)).toContain('does not match running attempt 1');
      expect(prompt).not.toContain('<current attempt>');
      expect(prompt).toContain('at most once per second');
      return { output: 'stale request settled', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } };
    await runWorkflow(config, 'fixture', projectDir, adapter, new Map(), undefined, agentsDir, created.runId, 'replay', true);
    const decisions = readdirSync(join(created.runDirPath, 'stages', recordedRequest.stageId))
      .filter((file) => file.startsWith('scope_revision_decision_'));
    expect(decisions).toHaveLength(1);
    const events = readRunEvents(projectDir, created.runId);
    expect(events.filter((event) => event.type === 'scope_revision_decided')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'attempt_started' && event.stageId === recordedRequest.stageId))
      .toEqual([expect.objectContaining({ attemptIndex: 1, source: 'worker' })]);
    expect(events.filter((event) => event.type === 'attempt_finished' && event.stageId === recordedRequest.stageId))
      .toEqual([expect.objectContaining({ attemptIndex: 1, source: 'worker' })]);
    expect(events.some((event) => event.type === 'run_status_changed' && event.runStatus === 'complete')).toBe(true);
  }, 15_000);

  it('item 2: an accepted path is inherited with its immutable decision identity', () => {
    const requestBytes = recordedEvidence('item2_accepted_request');
    const decisionBytes = recordedEvidence('item2_accepted_decision');
    const request = JSON.parse(requestBytes.toString('utf-8')) as ScopeRevisionRequestV1;
    const decision = JSON.parse(decisionBytes.toString('utf-8')) as {
      identityDigest: string;
      priorScope: string[];
      effectiveScope: string[];
    };
    const runId = request.runId;
    const runDirectory = join(temporaryRoot(), runId);
    const stageDirectory = join(runDirectory, 'stages', request.stageId);
    mkdirSync(stageDirectory, { recursive: true });
    writeFileSync(join(stageDirectory, 'scope_revision_request.json'), requestBytes);
    writeFileSync(
      join(stageDirectory, `scope_revision_decision_attempt_1_${decision.identityDigest}.json`),
      decisionBytes,
    );
    expect(stageWithInheritedScope(runDirectory, stage({
      id: request.stageId,
      role: 'coder',
      scope: decision.priorScope,
      depends_on: [],
      dependency_reasons: {},
    })).scope).toEqual(decision.effectiveScope);
  });

  it('item 2: an accepted capability survives a technical retry without replaying its request or events', async () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-inherited-scope-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'coder.yaml'), [
      'name: coder', 'description: replay', 'model: default', 'reasoning_effort: default',
      'tools: []', 'prompt: replay',
    ].join('\n'));
    const config: WorkflowConfig = {
      name: 'inherited-scope-replay', defaults: { max_iterations: 1, max_retries: 1 },
      stages: [{
        id: 'work', role: 'coder', depends_on: [], scope: ['src/declared.ts'],
        prompt_template: 'replay accepted scope', skills: [], dynamic_dispatch: false,
        is_gate: false, criterion_refs: [],
      }],
    };
    const created = createRun(projectDir, config.name, 'fixture', ['work']);
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);
    let workCalls = 0;
    const added = 'src/inherited.ts';
    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      workCalls++;
      const stageDirectory = join(opts.runDir, 'stages', opts.stageId);
      if (workCalls === 1) {
        const requestedPaths = [added];
        writeFileSync(join(stageDirectory, 'scope_revision_request.json'), JSON.stringify({
          version: 1, kind: 'scope_revision', requestId: 'accepted-once',
          runId: created.runId, stageId: opts.stageId, attemptIndex: 1,
          requestedPaths, pathDigest: scopePathDigest(requestedPaths), reason: 'needed on the retry',
        }));
        const decision = await waitForPathEvent(stageDirectory, () => {
          const name = readdirSync(stageDirectory).find((file) => file.startsWith('scope_revision_decision_'));
          return name ? JSON.parse(readFileSync(join(stageDirectory, name), 'utf-8')) as Record<string, unknown> : undefined;
        });
        expect(decision).toMatchObject({ accepted: true, attemptIndex: 1 });
        return { output: 'force technical retry', exitCode: 1, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      expect(prompt).toContain(JSON.stringify(['src/declared.ts', added]));
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, added), 'inherited capability\n');
      return { output: 'retry used inherited scope', exitCode: 0, duration_ms: 1, writes: [added], writeAttribution: 'structured' };
    } };

    await runWorkflow(config, 'fixture', projectDir, adapter, new Map(), undefined, agentsDir, created.runId, 'replay', true);
    expect(workCalls).toBe(2);
    expect(readFileSync(join(projectDir, added), 'utf-8')).toBe('inherited capability\n');
    const decisions = readdirSync(join(created.runDirPath, 'stages', 'work'))
      .filter((file) => file.startsWith('scope_revision_decision_'));
    expect(decisions).toHaveLength(1);
    const events = readRunEvents(projectDir, created.runId);
    expect(events.filter((event) => event.type === 'scope_revision_requested')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'scope_revision_decided')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'guidance_written' && event.stageId === 'work')).toHaveLength(1);
  }, 15_000);

  it('unchanged-base seam item 3: the recorded direct sidecar load and shared-slot existence assertion are rejected for every role', () => {
    const recordedDiff = JSON.parse(
      recordedEvidence('item3_exact_before_after_test').toString('utf-8'),
    ) as { files: Array<{ path: string; before: { text?: string } }> };
    const recordedTest = recordedDiff.files.find((file) => file.path.endsWith('_verification.py'));
    expect(recordedTest?.before.text).toBeTruthy();
    const projectDir = temporaryRoot();
    const testPath = recordedTest!.path;
    mkdirSync(join(projectDir, 'tests'), { recursive: true });
    writeFileSync(join(projectDir, testPath), recordedTest!.before.text!);
    const findings = inspectTemporalResearchTests({
      projectDir,
      writes: [testPath],
      resultFile: 'docs/happymj_explore7/round_result.json',
      terminalPaths: [],
    });
    expect(findings.map((finding) => finding.kind)).toContain('depends_on_shared_presence');
  });

  it('unchanged-base seam item 3: a non-planner test-writing stage is failed before its temporal test can be accepted', async () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-temporal-stage-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'qa.yaml'), [
      'name: qa', 'description: replay', 'model: default', 'reasoning_effort: default',
      'tools: []', 'prompt: replay',
    ].join('\n'));
    const testPath = 'tests/test_round_verification.py';
    const config: WorkflowConfig = {
      name: 'temporal-stage-replay', defaults: { max_iterations: 1, max_retries: 0 },
      research: { baseline: 0, policy: 'best_of_n', resultFile: 'docs/happymj/round_result.json' },
      stages: [{
        id: 'audit_round', role: 'qa', depends_on: [], scope: [testPath],
        prompt_template: 'write the verifier', skills: [], dynamic_dispatch: false,
        is_gate: false, criterion_refs: [],
      }],
    };
    const created = createRun(projectDir, config.name, 'fixture', ['audit_round']);
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    initial.research = config.research;
    writeRunState(projectDir, created.runId, initial);
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      mkdirSync(join(projectDir, 'tests'), { recursive: true });
      writeFileSync(join(projectDir, testPath), [
        'from pathlib import Path',
        'RESULT = Path("docs/happymj/round_result.json")',
        'assert RESULT.exists()',
      ].join('\n'));
      return { output: 'verifier written', exitCode: 0, duration_ms: 1, writes: [testPath], writeAttribution: 'structured' };
    } };

    await runWorkflow(config, 'fixture', projectDir, adapter, new Map(), undefined, agentsDir, created.runId, 'replay', true);
    const status = JSON.parse(readFileSync(join(created.runDirPath, 'stages', 'audit_round', 'status.json'), 'utf-8')) as StageStatus;
    expect(status.status).toBe('failed');
    expect(status.error).toContain('Temporal test contract rejected');
  }, 15_000);

  it('item 4: the first proposal remains fail-closed after exact path guidance is supplied', () => {
    const markdown = recordedEvidence('item4_first_plan_proposal').toString('utf-8');
    const guided = appendResearchTemporalPathContract('plan now', {
      baseline: 0, policy: 'best_of_n', resultFile: 'docs/happymj_explore7/round_result.json',
    }, { complete: { paths: ['docs/happymj_explore7/ship_report.md'] } });
    expect(guided).toContain('docs/happymj_explore7/round_result.json.no_candidate.json');
    expect(guided).toContain('docs/happymj_explore7/run_manifest.json');
    expect(guided).toContain('hard check that references docs/happymj_explore7/round_result.json is still rejected');

    const errors = inspectRealityCheckReachability({
      markdown, projectDir: temporaryRoot(),
      stages: [stage({
        id: 'measure', role: 'coder', scope: ['docs/happymj_explore7/round_result.json'],
        depends_on: [], dependency_reasons: {},
      })],
      research: {
        baseline: 0,
        policy: 'best_of_n',
        resultFile: 'docs/happymj_explore7/round_result.json',
      },
    });
    expect(errors.join('\n')).toContain('writes only its sidecar docs/happymj_explore7/round_result.json.no_candidate.json');
    expect(errors.join('\n')).toContain('framework manifest docs/happymj_explore7/run_manifest.json');
  });

  it('unchanged-base seam item 4: the first research-stage call receives the resolved universal rule', async () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-first-research-prompt-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'planner.yaml'), [
      'name: planner', 'description: replay', 'model: default', 'reasoning_effort: default',
      'tools: []', 'prompt: replay',
    ].join('\n'));
    const config: WorkflowConfig = {
      name: 'first-research-prompt-replay', defaults: { max_iterations: 1, max_retries: 0 },
      research: { baseline: 0, policy: 'best_of_n', resultFile: 'docs/happymj/round_result.json' },
      stages: [{
        id: 'plan', role: 'planner', depends_on: [], scope: [],
        prompt_template: 'plan the first research round', skills: [], dynamic_dispatch: false,
        is_gate: false, criterion_refs: [],
      }],
    };
    const created = createRun(projectDir, config.name, 'fixture', ['plan']);
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    initial.research = config.research;
    writeRunState(projectDir, created.runId, initial);
    let firstPrompt = '';
    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      firstPrompt ||= prompt;
      return { output: 'planned', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } };

    await runWorkflow(config, 'fixture', projectDir, adapter, new Map(), undefined, agentsDir, created.runId, 'replay', true);
    expect(firstPrompt).toContain('docs/happymj/round_result.json.no_candidate.json');
    expect(firstPrompt).toContain('docs/happymj/run_manifest.json');
    expect(firstPrompt).toContain('Every hard check and every test, regardless of author role or round');
  }, 15_000);

  it('unchanged-base seam item 6: copied research conditions are rejected at non-research admission with a remedy', () => {
    const rawStages = parseYaml(
      recordedEvidence('item6_copied_dispatch').toString('utf-8'),
    ) as Array<Record<string, unknown>>;
    const report = inspectDispatchAdmission({
      dispatched: rawStages.map((raw) => stage(raw)),
      baseStages: [], dispatchStageId: 'plan',
    });
    expect(report.errors.join('\n')).toContain('references framework research facts in a non-research run');
    expect(report.errors.join('\n')).toContain('remove the condition or declare research mode');
  });

  it('item 6: the framework namespace stays reserved even if a non-research dispatch names a stage research', () => {
    const report = inspectDispatchAdmission({
      dispatched: [
        stage({ id: 'research', role: 'coder', scope: [], depends_on: [], dependency_reasons: {} }),
        stage({
          id: 'final_complete', role: 'writer', scope: ['docs/final.md'], depends_on: ['research'],
          dependency_reasons: { research: 'copied research-shaped topology' },
          condition: 'research.decision == "ship"',
        }),
      ],
      baseStages: [], dispatchStageId: 'plan',
    });
    expect(report.errors.join('\n')).toContain('references framework research facts in a non-research run');
  });

  it('canonical events: a scheduler-side stage exception still publishes one attributed attempt failure', async () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-thrown-attempt-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const config: WorkflowConfig = {
      name: 'thrown-attempt-event-replay', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'work', role: 'missing_role', depends_on: [], scope: [],
        prompt_template: 'this call must fail before the adapter starts', skills: [],
        dynamic_dispatch: false, is_gate: false, criterion_refs: [],
      }],
    };
    const created = createRun(projectDir, config.name, 'fixture', ['work']);
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);
    const adapter: Adapter = { async run() {
      throw new Error('adapter must not run for a missing role');
    } };

    const final = await runWorkflow(
      config, 'fixture', projectDir, adapter, new Map(), undefined,
      agentsDir, created.runId, 'replay', true,
    );
    expect(final.status).toBe('failed');
    const failureEvents = readRunEvents(projectDir, created.runId)
      .filter((event) => event.type === 'attempt_failed' && event.stageId === 'work');
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]).toMatchObject({
      attemptIndex: 1, source: 'scheduler', status: 'failed',
    });
    expect(failureEvents[0].detail).toContain('No agent config for role "missing_role"');
  }, 15_000);

  it('item 11: warm attempt capture does not visit/read/hash 1,100 clean files outside one declared path', () => {
    const projectDir = temporaryRoot();
    const runDirectory = temporaryRoot('flowcrew-rollback-run-');
    mkdirSync(join(projectDir, 'scoped'), { recursive: true });
    mkdirSync(join(projectDir, 'outside'), { recursive: true });
    writeFileSync(join(projectDir, 'scoped', 'only.txt'), 'scope\n');
    for (let index = 0; index < 1_100; index++) {
      writeFileSync(join(projectDir, 'outside', `${index}.txt`), `${index}\n`);
    }
    runFixtureGit(projectDir, ['init', '-q'], runDirectory);
    runFixtureGit(projectDir, ['add', '.'], runDirectory);
    runFixtureGit(projectDir, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], runDirectory);
    const scopedStage = stage({
      id: 'work', role: 'coder', scope: ['scoped/only.txt'], depends_on: [], dependency_reasons: {},
    });
    const first = captureRepairRoundSnapshot(projectDir, [scopedStage], { runDirPath: runDirectory });
    const warm = captureRepairRoundSnapshot(projectDir, [scopedStage], { runDirPath: runDirectory });
    expect(first.measurement).toMatchObject({
      baselineInitialized: true, baselineStrategy: 'git-index-plus-dirty-images',
      baselineFilesRead: 0, baselineFilesHashed: 0, baselineBytesRead: 0, baselineBytesHashed: 0,
    });
    expect(warm.measurement).toMatchObject({
      baselineInitialized: false, scopedFilesVisited: 1, scopedFilesRead: 1, scopedFilesHashed: 1,
      scopedBytesVisited: 6, scopedBytesRead: 6, scopedBytesHashed: 6,
      outsideScopeFilesVisited: 0, outsideScopeFilesRead: 0, outsideScopeFilesHashed: 0,
      outsideScopeBytesVisited: 0, outsideScopeBytesRead: 0, outsideScopeBytesHashed: 0,
      conservativeFallback: false,
    });
  }, 20_000);

  it('item 11: a watcher reliability loss takes the conservative full audit and detects an outside write', () => {
    const projectDir = temporaryRoot();
    const runDirectory = temporaryRoot('flowcrew-rollback-overflow-');
    mkdirSync(join(projectDir, 'scoped'), { recursive: true });
    mkdirSync(join(projectDir, 'outside'), { recursive: true });
    writeFileSync(join(projectDir, 'scoped', 'only.txt'), 'scope\n');
    writeFileSync(join(projectDir, 'outside', 'guarded.txt'), 'before\n');
    runFixtureGit(projectDir, ['init', '-q'], runDirectory);
    runFixtureGit(projectDir, ['add', '.'], runDirectory);
    runFixtureGit(projectDir, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], runDirectory);
    const scopedStage = stage({
      id: 'work', role: 'coder', scope: ['scoped/only.txt'], depends_on: [], dependency_reasons: {},
    });
    const snapshot = captureRepairRoundSnapshot(projectDir, [scopedStage], { runDirPath: runDirectory });
    (snapshot.rollbackBaseline as unknown as { reliable: boolean }).reliable = false;
    writeFileSync(join(projectDir, 'outside', 'guarded.txt'), 'after\n');
    runFixtureGit(projectDir, ['add', 'outside/guarded.txt'], runDirectory);
    runFixtureGit(projectDir, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'move head after baseline'], runDirectory);
    const artifact = writeRepairRoundDiffArtifact({
      snapshot, projectDir, runDirPath: runDirectory, iteration: 1, round: 1,
      repairStages: [scopedStage], statuses: {},
    });
    const parsed = JSON.parse(readFileSync(artifact, 'utf-8')) as { files: Array<{ path: string }> };
    expect(snapshot.measurement.conservativeFallback).toBe(true);
    expect(parsed.files.map((file) => file.path)).toContain('outside/guarded.txt');
  });

  it('item 11: run-start rollback preserves clean, dirty, untracked, deleted, and mode preimages', async () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-rollback-shapes-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const originals = {
      clean: 'clean committed\n',
      dirty: 'operator dirty bytes\n',
      untracked: 'operator untracked bytes\n',
      deleted: 'restore after delete\n',
      mode: 'restore mode\n',
    };
    for (const [name, contents] of Object.entries({
      clean: originals.clean, dirty: 'dirty committed\n', deleted: originals.deleted, mode: originals.mode,
    })) writeFileSync(join(projectDir, 'src', `${name}.txt`), contents);
    runFixtureGit(projectDir, ['init', '-q'], stateRoot);
    runFixtureGit(projectDir, ['add', '.'], stateRoot);
    runFixtureGit(projectDir, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], stateRoot);
    writeFileSync(join(projectDir, 'src', 'dirty.txt'), originals.dirty);
    writeFileSync(join(projectDir, 'src', 'untracked.txt'), originals.untracked);

    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'coder.yaml'), [
      'name: coder', 'description: replay', 'model: default', 'reasoning_effort: default',
      'tools: []', 'prompt: replay',
    ].join('\n'));
    const config: WorkflowConfig = {
      name: 'rollback-shapes-replay', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'work', role: 'coder', depends_on: [], scope: [], prompt_template: 'mutate outside scope',
        skills: [], dynamic_dispatch: false, is_gate: false, criterion_refs: [],
      }],
    };
    const created = createRun(projectDir, config.name, 'fixture', ['work']);
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);
    const paths = ['src/clean.txt', 'src/dirty.txt', 'src/untracked.txt', 'src/deleted.txt', 'src/mode.txt', 'src/new.txt'];
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      for (const path of paths.slice(0, 3)) writeFileSync(join(projectDir, path), 'unauthorized\n');
      rmSync(join(projectDir, 'src', 'deleted.txt'));
      chmodSync(join(projectDir, 'src', 'mode.txt'), 0o755);
      writeFileSync(join(projectDir, 'src', 'new.txt'), 'unauthorized new\n');
      return { output: 'mutated', exitCode: 0, duration_ms: 1, writes: paths, writeAttribution: 'structured' };
    } };

    await runWorkflow(config, 'fixture', projectDir, adapter, new Map(), undefined, agentsDir, created.runId, 'replay', true);
    expect(readFileSync(join(projectDir, 'src', 'clean.txt'), 'utf-8')).toBe(originals.clean);
    expect(readFileSync(join(projectDir, 'src', 'dirty.txt'), 'utf-8')).toBe(originals.dirty);
    expect(readFileSync(join(projectDir, 'src', 'untracked.txt'), 'utf-8')).toBe(originals.untracked);
    expect(readFileSync(join(projectDir, 'src', 'deleted.txt'), 'utf-8')).toBe(originals.deleted);
    expect(readFileSync(join(projectDir, 'src', 'mode.txt'), 'utf-8')).toBe(originals.mode);
    expect(statSync(join(projectDir, 'src', 'mode.txt')).mode & 0o777).toBe(0o644);
    expect(() => statSync(join(projectDir, 'src', 'new.txt'))).toThrow();
  }, 20_000);

  it('item 11: a non-Git run images once and still restores an out-of-scope overwrite', async () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-nongit-rollback-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'protected.txt'), 'operator preimage\n');
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'coder.yaml'), [
      'name: coder', 'description: replay', 'model: default', 'reasoning_effort: default',
      'tools: []', 'prompt: replay',
    ].join('\n'));
    const config: WorkflowConfig = {
      name: 'nongit-rollback-replay', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'work', role: 'coder', depends_on: [], scope: [], prompt_template: 'mutate outside scope',
        skills: [], dynamic_dispatch: false, is_gate: false, criterion_refs: [],
      }],
    };
    const created = createRun(projectDir, config.name, 'fixture', ['work']);
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      writeFileSync(join(projectDir, 'src', 'protected.txt'), 'unauthorized\n');
      return {
        output: 'mutated', exitCode: 0, duration_ms: 1,
        writes: ['src/protected.txt'], writeAttribution: 'structured',
      };
    } };
    await runWorkflow(config, 'fixture', projectDir, adapter, new Map(), undefined, agentsDir, created.runId, 'replay', true);
    expect(readFileSync(join(projectDir, 'src', 'protected.txt'), 'utf-8')).toBe('operator preimage\n');
  }, 15_000);

  it('items 13–14: capability identity is run-scoped and supervisor static/novel evidence stays stable', () => {
    const runDirectory = temporaryRoot();
    const role = { model: 'gpt-fixture', reasoning_effort: 'ultra' };
    const identity = resolveCodexCapabilityIdentity(role, {
      executable: 'codex', version: 'codex-cli 1.2.3', provider: 'fixture',
      model: role.model, reasoningEffort: role.reasoning_effort,
    });
    rememberCodexUnsupportedEffort(runDirectory, identity);
    expect(readCodexCapabilityMemory(runDirectory, identity)?.capability).toBe('reasoning_effort_unsupported');
    expect(readCodexCapabilityMemory(runDirectory, { ...identity, version: 'codex-cli 2.0.0' })).toBeUndefined();

    const task = 'Keep this exact static goal across calls.';
    expect(buildSupervisorRolePrompt(600_000, task)).toContain(`# Original Goal\n${task}`);
    const common = {
      tails: new Map([['work', 'new semantic output']]), artifacts: [], anomalySignals: [],
      attemptKeys: ['work:2:2026-09-02T12:00:00.000Z'],
    };
    expect(supervisorEvidenceDigest(common)).toBe(supervisorEvidenceDigest({ ...common }));
    expect(supervisorEvidenceDigest(common)).not.toBe(supervisorEvidenceDigest({
      ...common, attemptKeys: ['work:3:2026-09-02T12:01:00.000Z'],
    }));
  });

  it('unchanged-base seam item 13: one diagnosed effort rejection is reused by the next Codex stage in the same run', async () => {
    const root = temporaryRoot('flowcrew-codex-capability-seam-');
    const bin = join(root, 'bin');
    const runDirectory = join(root, 'run');
    const projectDir = join(root, 'project');
    const counter = join(root, 'codex-calls.txt');
    mkdirSync(bin, { recursive: true });
    mkdirSync(runDirectory, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const executable = join(bin, 'codex');
    writeFileSync(executable, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  printf "%s\\n" "codex-fixture 1.0.0"',
      '  exit 0',
      'fi',
      'printf "%s\\n" x >> "$FLOWCREW_CODEX_COUNTER"',
      'if grep -q "^model_reasoning_effort" "$CODEX_HOME/config.toml"; then',
      '  printf "%s\\n" "400 invalid_request: reasoning effort not supported" >&2',
      '  exit 1',
      'fi',
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"fixture ok\"}}'",
    ].join('\n'));
    chmodSync(executable, 0o755);
    priorEnvironment = Object.fromEntries(['PATH', 'CODEX_HOME', 'CODEX_PLUGINS_CACHE', 'CODEX_SKILLS_CACHE', 'FLOWCREW_CODEX_COUNTER']
      .map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
    process.env.CODEX_HOME = join(root, 'user-codex-home');
    process.env.CODEX_PLUGINS_CACHE = join(root, 'plugins');
    process.env.CODEX_SKILLS_CACHE = join(root, 'skills');
    process.env.FLOWCREW_CODEX_COUNTER = counter;
    const role = {
      name: 'coder', description: 'fixture', model: 'fixture-model', reasoning_effort: 'max',
      tools: [], prompt: 'fixture instructions',
    };
    const adapter = new CodexAdapter();
    for (const [index, stageId] of ['first', 'second'].entries()) {
      const result = await adapter.run('do fixture work', role, {
        timeout_ms: 5_000, workDir: projectDir, runDir: runDirectory, stageId,
        attemptIndex: 1, attemptStartedAt: `2026-09-02T12:00:0${index}.000Z`,
      });
      expect(result).toMatchObject({ exitCode: 0, output: 'fixture ok' });
    }
    expect(readFileSync(counter, 'utf-8').trim().split('\n')).toHaveLength(3);
  }, 15_000);

  it('unchanged-base seam item 14: static goal is cacheable, elapsed is attempt-relative, and unchanged WAIT evidence is not resent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:10.000Z'));
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-supervisor-novelty-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const created = createRun(projectDir, 'supervisor-novelty-replay', 'fixture', ['work']);
    const attemptStartedAt = '2026-09-02T12:00:05.000Z';
    const status: StageStatus = {
      status: 'running', retries: 1, startedAt: '2026-09-02T11:00:00.000Z',
      attempts: [{ index: 2, status: 'running', startedAt: attemptStartedAt }],
    };
    writeStageStatus(projectDir, created.runId, 'work', status);
    const state = readRunState(projectDir, created.runId);
    state.status = 'running';
    state.stages.work = status;
    writeRunState(projectDir, created.runId, state);
    const calls: Array<{ prompt: string; rolePrompt: string }> = [];
    const adapter: Adapter = { async run(prompt, role) {
      calls.push({ prompt, rolePrompt: role.prompt });
      return {
        output: '{"verdict":"WAIT","target_stage":null,"reason":"no new evidence","guidance":null}',
        exitCode: 0, duration_ms: 1,
      };
    } };
    const goal = 'Keep this exact static goal across supervisor calls.';
    const supervisor = new Supervisor(projectDir, created.runId, adapter, {
      enabled: true, adapter: 'mock', model: 'default', reasoningEffort: 'low',
      pollIntervalMs: 10, routineAssessmentIntervalMs: 10, cooldownAfterActionMs: 0,
      maxAssessmentsPerIteration: 20, tailBytes: 16_384, minDeltaBytes: 0,
      stuckThresholdMs: 600_000,
    }, goal);
    supervisor.start();
    await vi.advanceTimersByTimeAsync(45);
    supervisor.stop();

    expect(calls).toHaveLength(1);
    expect(calls[0].rolePrompt).toContain(`# Original Goal\n${goal}`);
    expect(calls[0].prompt).not.toContain(goal);
    const elapsed = calls[0].prompt.match(/## work — (\d+)s elapsed/);
    expect(elapsed).not.toBeNull();
    expect(Number(elapsed![1])).toBeLessThan(30);
  });

  it('unchanged-base seam item 16: request handling is watcher-driven with a slow fallback, never a 20 ms loop', () => {
    const worker = readFileSync(join(import.meta.dirname, '..', 'src', 'worker.ts'), 'utf-8');
    const scheduler = readFileSync(join(import.meta.dirname, '..', 'src', 'scheduler.ts'), 'utf-8');
    expect(worker).toContain("watch(directory, { persistent: false }");
    expect(worker).toContain('setInterval(pollTimeoutExtensionRequests, 1000)');
    expect(worker).not.toMatch(/setInterval\(pollTimeoutExtensionRequests,\s*20\)/);
    expect(scheduler).toContain('scope_revision_request.json');
    expect(scheduler).not.toMatch(/setTimeout\(resolvePromise,\s*20\)/);
    expect(recordedEvidence('item2_mismatched_request')).toHaveLength(608);
  });
});
