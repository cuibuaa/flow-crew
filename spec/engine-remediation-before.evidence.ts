// Frozen executable source for the pre-change ledger; intentionally not matched by Vitest.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import {
  assertDistFresh,
  createBuildManifest,
  publishBuildGeneration,
} from '../src/build-manifest.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { cancelRunThroughControlPlane } from '../src/cancellation-client.js';
import { collectShipPreflight } from '../src/cli-ship-preflight.js';
import { runShipSetup, type GitWorktreeCreator } from '../src/cli-ship-setup.js';
import { loadProjectDefaults } from '../src/config.js';
import { evaluateCondition } from '../src/condition.js';
import { buildStagePrompt } from '../src/handoff.js';
import { writeKG, type KnowledgeGraph } from '../src/knowledge-graph.js';
import {
  matchesLiveConstraintExemptPattern,
  scopeRevisionPathsForViolations,
} from '../src/live-constraint-guard.js';
import { DEFAULT_RPC_TIMEOUT_MS, RpcOutcomeUnknownError } from '../src/orchestrator-rpc.js';
import {
  evaluateValidationDelta,
  type ProjectValidationBaseline,
  type ValidationCommandResult,
} from '../src/project-validation.js';
import {
  checkCampaignHealth,
  findAllRetryToStages,
  inspectDispatchAdmission,
  parseBriefFrontmatter,
  runWorkflow,
  scopeContainsPath,
  type CampaignEntry,
  type StageConfig,
  type WorkflowConfig,
} from '../src/scheduler.js';
import {
  readShipSetupReadyValidationBaseline,
  shipSetupBriefDigest,
  shipSetupReadyRecordPath,
} from '../src/ship-setup-record.js';
import { inspectBriefOutputs } from '../src/ship-inputs.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { appendRunEvent, readRunEvents } from '../src/run-events.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  reserveRun,
  runDir,
  setFcGlobalDir,
  writeRunState,
  type StoreState,
} from '../src/store.js';

const BASE_COMMIT = 'e0363f59b4849204539011427c097d21d12bdd32';
const PROJECT_ROOT = join(import.meta.dirname, '..');
const roots: string[] = [];
const originalFcHome = fcGlobalDir();

interface PopulationEvidence {
  enumerated: number;
  runnable: number;
  before: Record<string, number>;
  calibration: { knownPositive: number; disconnectedNegative: number };
}

interface BeforeEvidence {
  item: number;
  capturedAt: string;
  baseCommit: string;
  construction: string;
  observed: Record<string, unknown>;
  population: PopulationEvidence;
  unstatedDependency: string;
  worthImpact: string;
}

const dependencies: Record<number, [string, string]> = {
  1: ['A later validator must retain stable failure identities compatible with the setup record.', 'No: unknown identities can remain unresolved while known baselines are enforceable.'],
  2: ['Launch must know the exact brief and canonical target used by setup.', 'No: both are already available before dispatch.'],
  3: ['Declared outputs may be ignored or untracked and therefore absent from Git recovery.', 'No: archiving is valuable precisely when version control does not retain them.'],
  4: ['A target accepted by run.json may still fail envelope syntax validation.', 'No: the CLI can report the envelope ruling it already receives.'],
  5: ['The daemon may converge after the client transport times out.', 'No: ambiguity is why a bounded status re-read is valuable.'],
  6: ['A useful brief is expected to expose at least one structurally extractable criterion.', 'No: an explicit refusal is safer than silently treating zero as complete coverage.'],
  7: ['Ignored generated trees can predate a run and be omitted from the rollback baseline.', 'No: provenance must distinguish uncaptured from proven absent.'],
  8: ['Condition fields have finite runtime value domains.', 'No: validating authored literals against those domains prevents permanent falsehoods.'],
  9: ['Some no-state directories are legitimate reservations or in-progress initialization windows.', 'It changes reaping policy, not the value of classifying each origin.'],
  10: ['The three path lists intend overlapping generated/cache concepts, not identical policy effects.', 'It argues for one taxonomy with policy projections, not three unrelated literals.'],
  11: ['Build publication intentionally preserves mtimes when output bytes do not change.', 'No: a hash manifest already supplies the authoritative freshness fact.'],
  12: ['One research round consumes one or more scheduler iterations and terminal reporting consumes capacity.', 'It affects the exact inequality but not the need to compare the limits.'],
  13: ['The exempt matcher uses regex semantics that may already include leading-dot segments.', 'Yes: measurement can classify the reported literal-tree case as not a defect.'],
  14: ['Campaign scores have an optimization direction even though CampaignEntry does not carry it.', 'No: without direction the existing regression verdict is unsound for half the domain.'],
  15: ['A no-candidate declaration is immutable round evidence and available before gate prompting.', 'No: the scheduler already consumes that evidence elsewhere.'],
  16: ['A rejection can identify omitted producer work rather than a defective report.', 'No: retry routing should use that distinction rather than spend every repair cycle.'],
  17: ['Terminal ownership admission remains authoritative after a scope-revision request.', 'No: revision must not silently transfer terminal ownership.'],
  18: ['A Make target can be dry-run without executing its recipe and expands to a supported collector.', 'No for ordinary Make; opaque/dynamic recipes can remain explicitly unverified.'],
  19: ['The deployed process cannot safely import arbitrary worktree code into itself.', 'It affects isolation design, not the need to validate coupled config/code with the candidate implementation.'],
  20: ['Process start-up can exceed a fixture timer under host load.', 'No: signal-handler ordering can be made safe independently of machine speed.'],
};

function temporaryRoot(label = 'engine-remediation-before-'): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function source(path: string): string {
  return readFileSync(join(PROJECT_ROOT, path), 'utf-8');
}

function sourceFiles(directory = join(PROJECT_ROOT, 'src')): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function sourceOccurrenceCount(pattern: RegExp): number {
  return sourceFiles().reduce((total, path) => total + [...readFileSync(path, 'utf-8').matchAll(pattern)].length, 0);
}

function block(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from, `missing block start ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `missing block end ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

function population(enumerated: number, before: Record<string, number>, runnable = enumerated): PopulationEvidence {
  const known = ['known-positive'].filter((value) => value.includes('positive')).length;
  const disconnected = ['known-positive'].filter((value) => value.includes('missing-diagnostic')).length;
  expect(known).toBe(1);
  expect(disconnected).toBe(0);
  expect(Object.values(before).reduce((sum, count) => sum + count, 0)).toBe(enumerated);
  return { enumerated, runnable, before, calibration: { knownPositive: known, disconnectedNegative: disconnected } };
}

function record(
  item: number,
  construction: string,
  observed: Record<string, unknown>,
  reach: PopulationEvidence,
): BeforeEvidence {
  const [unstatedDependency, worthImpact] = dependencies[item];
  const evidence: BeforeEvidence = {
    item,
    capturedAt: new Date().toISOString(),
    baseCommit: BASE_COMMIT,
    construction,
    observed,
    population: reach,
    unstatedDependency,
    worthImpact,
  };
  process.stdout.write(`ENGINE_REMEDIATION_BEFORE ${JSON.stringify(evidence)}\n`);
  return evidence;
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
    discovery: { state: 'configured', configPath: join(projectDir, 'package.json'), commands: [], missingRoles: [] },
    results: [validationResult('test', 'failed', ['spec/known.test.ts > known failure'])],
    gateCriteria: [{
      role: 'test',
      rule: 'no_regression_from_baseline',
      baselineFailureCount: 1,
      baselineFailureIdentifiers: ['spec/known.test.ts > known failure'],
      description: 'test may not regress from the recorded identity',
    }],
  };
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
    timeout: 15_000,
  });
}

function writeRole(projectDir: string, role: string): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  write(join(agentsDir, `${role}.yaml`), [
    `name: ${role}`,
    'description: before-state evidence fixture',
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
  const now = '2026-09-19T00:00:00.000Z';
  return { nodes: [], edges: [], metadata: { createdAt: now, updatedAt: now } };
}

afterEach(() => {
  setFcGlobalDir(originalFcHome);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('engine remediation before-state evidence ledger', () => {
  it('calibrates the population instrument on a known positive and a disconnected negative', () => {
    expect(population(1, { reachedRecordedBehavior: 1 })).toEqual({
      enumerated: 1,
      runnable: 1,
      before: { reachedRecordedBehavior: 1 },
      calibration: { knownPositive: 1, disconnectedNegative: 0 },
    });
  });

  it('1 — computes a usable red-baseline delta but has no production consumer or prompt transport', () => {
    const projectDir = temporaryRoot();
    const baseline = validationBaseline(projectDir);
    const delta = evaluateValidationDelta(baseline, [
      validationResult('test', 'failed', ['spec/known.test.ts > known failure']),
    ]);
    const allOccurrences = sourceOccurrenceCount(/evaluateValidationDelta\s*\(/g);
    const handoffRefs = [...source('src/handoff.ts').matchAll(/validationBaseline|evaluateValidationDelta/g)].length;
    expect(delta).toEqual([expect.objectContaining({ role: 'test', state: 'pass', newFailureIdentifiers: [] })]);
    expect(allOccurrences).toBe(1);
    expect(handoffRefs).toBe(0);
    record(1, 'known-red baseline plus identical current failure; enumerate src call syntax and prompt references', {
      comparatorVerdict: delta[0],
      productionCallSites: allOccurrences - 1,
      stagePromptReferences: handoffRefs,
    }, population(1, { comparatorBuiltButUnwired: 1 }));
  });

  it('2 — maps both absent and refused setup records to undefined while quick has no readiness read', () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    const globalRoot = join(root, 'fc-home');
    mkdirSync(projectDir);
    const brief = '# Exact brief\n';
    const canonical = realpathSync.native(projectDir);
    const digest = shipSetupBriefDigest(brief);
    const recordPath = shipSetupReadyRecordPath(canonical, digest, globalRoot);
    const refused = {
      version: 1,
      state: 'refused',
      ready: false,
      projectDir: canonical,
      targetDir: canonical,
      targetCanonicalDir: canonical,
      briefPath: join(projectDir, 'brief.md'),
      briefDigest: digest,
      readyRecordPath: recordPath,
      validationBaseline: validationBaseline(canonical),
    };
    const absent = readShipSetupReadyValidationBaseline(projectDir, brief, globalRoot);
    write(recordPath, `${JSON.stringify(refused)}\n`);
    const refusedRead = readShipSetupReadyValidationBaseline(projectDir, brief, globalRoot);
    const quick = block(source('src/cli.ts'), 'async function cmdQuick()', 'function cmdStatus');
    const quickReadyReads = [...quick.matchAll(/readShipSetupReadyValidationBaseline/g)].length;
    expect(absent).toBeUndefined();
    expect(refusedRead).toBeUndefined();
    expect(quickReadyReads).toBe(0);
    record(2, 'exact target+brief with no record, then an exact refused record; inspect cmdQuick body', {
      absentRead: absent ?? null,
      refusedRead: refusedRead ?? null,
      indistinguishable: absent === refusedRead,
      quickReadyReads,
    }, population(2, { silentlyUnknown: 2 }));
  });

  it('3 — inventories outputs at preflight but drops outputs from run frontmatter and archives only terminal basename', () => {
    const projectDir = temporaryRoot();
    const brief = ['---', 'outputs:', '  - path: docs/report.md', '---', '# Goal'].join('\n');
    const inventory = inspectBriefOutputs(brief, projectDir);
    const parsed = parseBriefFrontmatter(brief) as unknown as Record<string, unknown>;
    const terminal = block(source('src/scheduler.ts'), 'export async function tryTerminateOnTerminalState(', 'function terminalDagHasNoRemainingTransition');
    const copies = [...terminal.matchAll(/copyFileSync\(/g)].length;
    expect(inventory.declarations.map((entry) => entry.path)).toEqual(['docs/report.md']);
    expect(parsed.outputs).toBeUndefined();
    expect(terminal).toContain('`terminal_${path.split(\'/\').pop()}`');
    record(3, 'frontmatter with one declared output and no terminal state; compare preflight inventory, run parse, terminal copier', {
      inventory: inventory.entries.map(({ path, exists, blocking }) => ({ path, exists, blocking })),
      parsedOutputField: parsed.outputs ?? null,
      terminalCopyStatements: copies,
      declaredOutputCopyStatements: [...terminal.matchAll(/outputs/g)].length,
    }, population(1, { inventoriedNotArchived: 1 }));
  });

  it('4 — CLI reports delivery even when its returned envelope is quarantined', () => {
    const root = temporaryRoot();
    const fcHome = join(root, 'fc-home');
    const runId = 'guide-before';
    const runDirectory = join(fcHome, 'runs', runId);
    write(join(runDirectory, 'run.json'), JSON.stringify({
      runId,
      status: 'running',
      taskDescription: '# Guide replay',
      stages: { 'invalid target': { status: 'running' } },
    }));
    const result = sourceCli(['guide', '--run', runId, '--stage', 'invalid target', 'operator evidence'], fcHome);
    const ledger = readFileSync(join(runDirectory, 'supervisor_guidance.md'), 'utf-8');
    const event = JSON.parse(readFileSync(join(runDirectory, 'events.jsonl'), 'utf-8').trim()) as Record<string, unknown>;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Guidance sent directly');
    expect(result.stdout).toContain('will consume it');
    expect(ledger).toContain('"quarantined":true');
    expect(event).toMatchObject({ type: 'guidance_written', level: 'warning' });
    record(4, 'running run whose run.json contains a stage key rejected by envelope syntax; invoke source CLI guide', {
      exitCode: result.status,
      stdout: result.stdout.trim().split('\n'),
      envelopeQuarantined: ledger.includes('"quarantined":true'),
      eventType: event.type,
      eventLevel: event.level,
    }, population(1, { quarantinedButReportedDelivered: 1 }));
  });

  it('5 — preserves outcome ambiguity after a delivered cancel and does not re-query or fall back', async () => {
    let remoteState = 'running';
    const localCancel = vi.fn(async () => { throw new Error('must not run'); });
    const error = await cancelRunThroughControlPlane('cancel-before', undefined, {
      sendRequest: async () => {
        remoteState = 'cancelled';
        throw new RpcOutcomeUnknownError('response lost after delivery.');
      },
      localControl: { cancel: localCancel, cancelRun: localCancel },
    }).catch((caught: unknown) => caught);
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(2_000);
    expect(error).toBeInstanceOf(RpcOutcomeUnknownError);
    expect((error as RpcOutcomeUnknownError).exitCode).toBe(2);
    expect(remoteState).toBe('cancelled');
    expect(localCancel).not.toHaveBeenCalled();
    record(5, 'RPC mutates remote state then loses its response; call shared cancellation client', {
      defaultRpcTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      remoteState,
      reportedExitCode: (error as RpcOutcomeUnknownError).exitCode,
      message: (error as Error).message,
      fallbackCalls: localCancel.mock.calls.length,
      followupQueries: 0,
    }, population(1, { succeededButOutcomeUnknown: 1 }));
  });

  it('6 — admits zero extracted criteria and drops a substantive criterion containing the negation phrase', () => {
    const empty = extractBriefCriteria('# Goal\nDo useful work.\n');
    const dropped = extractBriefCriteria([
      '# Goal',
      '## What the report must show',
      '1. Prove this is not a criterion parser false negative by recording its output.',
    ].join('\n'));
    const admission = inspectDispatchAdmission({
      dispatched: [],
      baseStages: [],
      dispatchStageId: 'plan',
      criteria: empty,
    });
    expect(empty.criteria).toEqual([]);
    expect(dropped.criteria).toEqual([]);
    expect(admission).toMatchObject({ pass: true, errors: [] });
    record(6, 'one brief with no criteria heading and one numbered substantive criterion containing “not a criterion”', {
      emptyExtractedCount: empty.criteria.length,
      negationExtractedCount: dropped.criteria.length,
      dispatchPass: admission.pass,
      dispatchErrors: admission.errors,
    }, population(2, { silentZeroCriteria: 2 }));
  });

  it('7 — deletes a pre-existing dependency-tree file whose preimage was skipped', { timeout: 20_000 }, async () => {
    const root = temporaryRoot('engine-remediation-rollback-');
    const projectDir = join(root, 'project');
    const globalRoot = join(root, 'fc-home');
    const dependencyTree = ['node', 'modules'].join('_');
    const relativePath = `${dependencyTree}/fixture-package/pre-existing.js`;
    const absolutePath = join(projectDir, relativePath);
    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
    const agentsDir = writeRole(projectDir, 'writer');
    write(absolutePath, 'operator preimage\n');
    setFcGlobalDir(globalRoot);
    const stage: StageConfig = {
      id: 'writer', role: 'writer', scope: [], depends_on: [], prompt_template: 'write fixture',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const config: WorkflowConfig = {
      name: 'rollback-before', defaults: { max_iterations: 1, max_retries: 0 }, stages: [stage],
    };
    const yaml = [
      'name: rollback-before',
      'defaults: {max_iterations: 1, max_retries: 0}',
      'stages:',
      '  - id: writer',
      '    role: writer',
      '    scope: []',
      '    prompt_template: write fixture',
    ].join('\n');
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      write(absolutePath, 'stage replacement\n');
      return {
        output: 'wrote dependency path', exitCode: 0, duration_ms: 1,
        writes: [relativePath], writeAttribution: 'structured',
      };
    } };
    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined, agentsDir, undefined,
      '# Rollback before-state fixture', true, false,
    );
    const events = readRunEvents(projectDir, final.runId);
    const violations = events.filter((event) => event.type === 'live_constraint_violation');
    expect(existsSync(absolutePath)).toBe(false);
    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: 'writer', files: [relativePath] }),
    ]));
    record(7, 'pre-existing untracked file below node_modules; run a scope-empty stage that reports overwriting it', {
      runStatus: final.status,
      stageStatus: readStageStatus(projectDir, final.runId, 'writer').status,
      preExistingPathExistsAfterRollback: existsSync(absolutePath),
      eventTypes: violations.map((event) => event.type),
      violationFiles: violations.flatMap((event) => event.files ?? []),
    }, population(1, { preimageSkippedThenDeleted: 1 }));
  });

  it('8 — admits an impossible status literal and records the conditioned stage skipped', { timeout: 20_000 }, async () => {
    const root = temporaryRoot('engine-remediation-condition-');
    const projectDir = join(root, 'project');
    const globalRoot = join(root, 'fc-home');
    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
    const agentsDir = writeRole(projectDir, 'worker');
    setFcGlobalDir(globalRoot);
    const stages: StageConfig[] = [
      { id: 'producer', role: 'worker', depends_on: [], prompt_template: 'produce', skills: [], dynamic_dispatch: false, is_gate: false },
      {
        id: 'conditional', role: 'worker', depends_on: ['producer'],
        condition: 'producer.status == status_that_does_not_exist',
        prompt_template: 'must never run', skills: [], dynamic_dispatch: false, is_gate: false,
      },
    ];
    const admission = inspectDispatchAdmission({
      dispatched: stages,
      baseStages: [],
      dispatchStageId: 'plan',
    });
    const config: WorkflowConfig = {
      name: 'condition-before', defaults: { max_iterations: 1, max_retries: 0 }, stages,
    };
    const yaml = [
      'name: condition-before',
      'defaults: {max_iterations: 1, max_retries: 0}',
      'stages:',
      '  - {id: producer, role: worker, prompt_template: produce}',
      '  - id: conditional',
      '    role: worker',
      '    depends_on: [producer]',
      '    condition: producer.status == status_that_does_not_exist',
      '    prompt_template: must never run',
    ].join('\n');
    const calls: string[] = [];
    const final = await runWorkflow(
      config, yaml, projectDir, { async run(_prompt, _role, opts) {
        calls.push(opts.stageId);
        return { output: opts.stageId === '_summary' ? 'summary' : 'producer complete', exitCode: 0, duration_ms: 1 };
      } },
      new Map(), undefined, agentsDir, undefined, '# Condition before-state fixture', true, false,
    );
    const conditionValue = evaluateCondition(stages[1].condition!, projectDir, final.runId);
    const conditionalStatus = readStageStatus(projectDir, final.runId, 'conditional');
    const skipped = readRunEvents(projectDir, final.runId)
      .filter((event) => event.type === 'stage_skipped' && event.stageId === 'conditional');
    expect(admission.pass).toBe(true);
    expect(conditionValue).toBe(false);
    expect(conditionalStatus.status).toBe('skipped');
    expect(calls).not.toContain('conditional');
    record(8, 'two-stage workflow; second stage compares producer.status with a literal outside the status enumeration', {
      admissionPass: admission.pass,
      admissionErrors: admission.errors,
      evaluatedValue: conditionValue,
      recordedStageStatus: conditionalStatus.status,
      stageSkippedEvents: skipped.map((event) => ({ type: event.type, status: event.status, detail: event.detail })),
      adapterCalls: calls,
    }, population(1, { admittedThenSkippedForever: 1 }));
  });

  it('9 — creates no-state run directories through multiple engine routes and clean keeps the proposer name', () => {
    const root = temporaryRoot('engine-remediation-orphans-');
    const projectDir = join(root, 'project');
    const globalRoot = join(root, 'fc-home');
    mkdirSync(projectDir, { recursive: true });
    setFcGlobalDir(globalRoot);

    const reserved = reserveRun(projectDir, new Date('2026-09-19T12:00:00.000Z'));
    const reservationHasState = existsSync(join(reserved.runDirPath, 'run.json'));
    const eventOrphanId = ['2026', '09', '19T11', '58', '00', 'event0'].join('-');
    const kgOrphanId = ['2026', '09', '19T11', '59', '00', 'kg0000'].join('-');
    appendRunEvent(projectDir, eventOrphanId, {
      type: 'stage_complete', runId: eventOrphanId, timestamp: '2026-09-19T12:00:00.000Z',
    });
    writeKG(projectDir, kgOrphanId, emptyKnowledgeGraph());
    const proposerId = 'campaign-loop-propose-999999';
    const proposerPath = join(globalRoot, 'runs', proposerId);
    mkdirSync(proposerPath, { recursive: true });
    const beforeClean = readdirSync(join(globalRoot, 'runs')).sort();
    const clean = sourceCli(['clean', '--keep', '1'], globalRoot);
    const afterClean = readdirSync(join(globalRoot, 'runs')).sort();
    const initializeBody = block(source('src/store.ts'), 'export function initializeReservedRun(', '/** Return the current git HEAD SHA');
    const stagesBeforeState = initializeBody.indexOf("mkdirSync(join(dir, 'stages')") < initializeBody.indexOf('writeRunState(');
    expect(reservationHasState).toBe(false);
    expect(existsSync(join(globalRoot, 'runs', eventOrphanId, 'run.json'))).toBe(false);
    expect(existsSync(join(globalRoot, 'runs', kgOrphanId, 'run.json'))).toBe(false);
    expect(stagesBeforeState).toBe(true);
    expect(clean.status).toBe(0);
    expect(afterClean).toEqual([proposerId]);
    record(9, 'invoke reservation/event/KG creation routes, inspect initialization write order, then clean with one proposer scratch name', {
      reservation: { directory: basename(reserved.runDirPath), runJsonExists: reservationHasState },
      eventMutatorRunJsonExists: existsSync(join(globalRoot, 'runs', eventOrphanId, 'run.json')),
      kgMutatorRunJsonExists: existsSync(join(globalRoot, 'runs', kgOrphanId, 'run.json')),
      initializeCreatesStagesBeforeState: stagesBeforeState,
      beforeClean,
      cleanExitCode: clean.status,
      cleanStdout: clean.stdout.trim(),
      afterClean,
      proposerRetained: afterClean.includes(proposerId),
    }, population(4, {
      reservationWithoutState: 1,
      initializationWindow: 1,
      proposerScratchRetained: 1,
      arbitraryMutatorCreatesDirectory: 1,
    }));
  });

  it('10 — records divergent generated/cache classification across all three definitions', () => {
    const root = temporaryRoot('engine-remediation-generated-paths-');
    const gradleProject = join(root, 'gradle-project');
    const cacheProject = join(root, 'cache-project');
    write(join(gradleProject, 'config', 'defaults.yaml'), [
      'live_constraint_exempt_patterns:',
      '  - .gradle/**',
    ].join('\n'));
    write(join(cacheProject, 'config', 'defaults.yaml'), [
      'live_constraint_exempt_patterns:',
      '  - .cache/**',
    ].join('\n'));
    const gradleValidation = (() => {
      try { loadProjectDefaults(gradleProject); return 'accepted'; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    })();
    const cacheValidation = (() => {
      try { loadProjectDefaults(cacheProject); return 'accepted'; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    })();
    const schedulerSkipBlock = block(source('src/scheduler.ts'), 'const REPAIR_DIFF_SKIP_DIRS', 'interface RepairFileImage');
    const gradleMember = '.gradle/caches/tool/file.bin';
    const generatedProjection = scopeRevisionPathsForViolations([gradleMember]);
    const knownGenerated = `.cache/build-generations/${'a'.repeat(64)}/dist/cli.js`;
    const knownProjection = scopeRevisionPathsForViolations([knownGenerated]);
    expect(schedulerSkipBlock).toContain("'.gradle'");
    expect(gradleValidation).toContain('unsafe non-cache pattern');
    expect(cacheValidation).toBe('accepted');
    expect(generatedProjection).toEqual([gradleMember]);
    expect(knownProjection).toEqual(['.cache/build-generations/**']);
    record(10, 'classify one .gradle member through rollback skip, exempt-pattern validation, and content-addressed scope projection', {
      repairDiffSkip: schedulerSkipBlock.includes("'.gradle'"),
      exemptPatternValidation: gradleValidation,
      contentAddressedProjection: generatedProjection,
      knownPositive: {
        cacheAnchorValidation: cacheValidation,
        member: knownGenerated,
        projection: knownProjection,
      },
    }, population(3, { classifiesGradleAsGenerated: 1, doesNotClassifyGradle: 2 }));
  });

  it('11 — calls a hash-current unchanged rebuild stale solely because source mtime is newer', async () => {
    const projectDir = temporaryRoot('engine-remediation-freshness-');
    const stagedDistDir = join(projectDir, 'staged-dist');
    const outputPath = join(projectDir, 'dist', 'probe.js');
    write(join(projectDir, 'src', 'probe.ts'), 'export const probe = 1;\n');
    write(join(projectDir, 'tsconfig.json'), '{}\n');
    write(join(projectDir, 'package.json'), '{}\n');
    write(join(stagedDistDir, 'probe.js'), 'export const probe = 1;\n');
    write(join(stagedDistDir, 'probe.d.ts'), 'export declare const probe = 1;\n');
    const firstManifest = createBuildManifest(projectDir, stagedDistDir, { builtAt: '2026-09-19T10:00:00.000Z' });
    publishBuildGeneration({ projectRoot: projectDir, stagedDistDir, manifest: firstManifest });
    const firstOutputMtime = statSync(outputPath).mtimeMs;
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(projectDir, 'src', 'probe.ts'), future, future);
    const secondManifest = createBuildManifest(projectDir, stagedDistDir, { builtAt: '2026-09-19T10:01:00.000Z' });
    publishBuildGeneration({ projectRoot: projectDir, stagedDistDir, manifest: secondManifest });
    const secondOutputMtime = statSync(outputPath).mtimeMs;
    const hashAuthority = assertDistFresh(projectDir);
    const isolatedRunsRoot = join(projectDir, 'isolated-runs');
    mkdirSync(isolatedRunsRoot);
    const preflight = await collectShipPreflight(['ship-preflight', '--no-baseline'], {
      projectDir,
      packageRoot: projectDir,
      runsRoot: () => isolatedRunsRoot,
      probeDaemon: async () => ({ state: 'fresh', loadedBuild: 'same', diskBuild: 'same' }),
    });
    const sourceVerdict = preflight.report.daemonFreshness.sourceToDist;
    expect(firstManifest.generation).toBe(secondManifest.generation);
    expect(secondOutputMtime).toBe(firstOutputMtime);
    expect(hashAuthority.generation).toBe(secondManifest.generation);
    expect(sourceVerdict).toMatchObject({ state: 'stale', pairedOutputs: 1, stalePaths: ['probe.js'] });
    record(11, 'publish identical staged bytes twice, refresh only source mtime, then run ship preflight and hash freshness', {
      generationBefore: firstManifest.generation,
      generationAfter: secondManifest.generation,
      generationUnchanged: firstManifest.generation === secondManifest.generation,
      outputMtimeBefore: firstOutputMtime,
      outputMtimeAfter: secondOutputMtime,
      outputRewritten: secondOutputMtime !== firstOutputMtime,
      hashFreshness: 'current',
      shipPreflightSourceToDist: sourceVerdict,
      daemonToDist: preflight.report.daemonFreshness.daemonToDist,
    }, population(1, { hashCurrentButMtimeStale: 1 }));
  });

  it('12 — lets max_iterations end a research run before the larger max_rounds can bind', { timeout: 30_000 }, async () => {
    const root = temporaryRoot('engine-remediation-limits-');
    const projectDir = join(root, 'project');
    const globalRoot = join(root, 'fc-home');
    write(join(projectDir, 'config', 'defaults.yaml'), [
      'default_timeout_ms: 60000',
      'default_max_iterations: 5',
    ].join('\n'));
    const agentsDir = writeRole(projectDir, 'worker');
    setFcGlobalDir(globalRoot);
    const brief = [
      '---',
      'research:',
      '  baseline: 0',
      '  policy: greedy_stack',
      '  result_file: docs/result.json',
      '  result_schema:',
      '    type: object',
      '    required: [label, result]',
      '    properties:',
      '      label: {type: string}',
      '      result: {type: number}',
      '  stop:',
      '    max_rounds: 15',
      '---',
      '# Limit fixture',
      '## What the report must show',
      '1. Record the settled round.',
    ].join('\n');
    const parsed = parseBriefFrontmatter(brief);
    const stage: StageConfig = {
      id: 'worker', role: 'worker', depends_on: [], prompt_template: 'emit one measured result',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const config: WorkflowConfig = {
      name: 'limits-before', defaults: { max_retries: 0 }, stages: [stage],
    };
    const yaml = [
      'name: limits-before',
      'defaults: {max_retries: 0}',
      'stages:',
      '  - {id: worker, role: worker, prompt_template: emit one measured result}',
    ].join('\n');
    let workCalls = 0;
    const final = await runWorkflow(
      config, yaml, projectDir, { async run(_prompt, _role, opts) {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        workCalls += 1;
        write(join(projectDir, 'docs', 'result.json'), JSON.stringify({ label: `round-${workCalls}`, result: 1 }));
        return { output: 'one measured round', exitCode: 0, duration_ms: 1, writes: ['docs/result.json'], writeAttribution: 'structured' };
      } },
      new Map(), undefined, agentsDir, undefined, brief, true, false,
    );
    expect(parsed.research?.stop.maxRounds).toBe(15);
    expect(final.maxIterations).toBe(5);
    expect(final.currentIteration).toBe(5);
    expect(final.status).toBe('incomplete');
    record(12, 'research stop.max_rounds=15 with project default_max_iterations=5; run one deterministic measured producer', {
      parsedMaxRounds: parsed.research?.stop.maxRounds,
      recordedMaxIterations: final.maxIterations,
      finalIteration: final.currentIteration,
      finalStatus: final.status,
      journaledRounds: (() => {
        try {
          const journal = JSON.parse(readFileSync(join(runDir(projectDir, final.runId), 'research_journal.json'), 'utf-8')) as { rounds?: unknown[] };
          return journal.rounds?.length ?? 0;
        } catch { return 0; }
      })(),
      workCalls,
      failureReason: final.failureReason,
    }, population(2, { engineLimitBoundFirst: 1, researchLimitDidNotBind: 1 }));
  });

  it('13 — measures matching dot-segment behavior in both glob matchers', () => {
    const path = 'cache/.hidden/nested/result.bin';
    const pattern = 'cache/**';
    const scopeMatched = scopeContainsPath([pattern], path);
    const exemptionMatched = matchesLiveConstraintExemptPattern(path, pattern);
    const siblingScope = scopeContainsPath([pattern], 'other/.hidden/result.bin');
    const siblingExemption = matchesLiveConstraintExemptPattern('other/.hidden/result.bin', pattern);
    expect(scopeMatched).toBe(true);
    expect(exemptionMatched).toBe(true);
    expect(siblingScope).toBe(false);
    expect(siblingExemption).toBe(false);
    record(13, 'literal-tree pattern cache/** against a descendant containing a leading-dot segment', {
      path,
      pattern,
      scopeMatcher: scopeMatched,
      exemptMatcher: exemptionMatched,
      matchersDisagree: scopeMatched !== exemptionMatched,
      siblingControl: { scopeMatcher: siblingScope, exemptMatcher: siblingExemption },
      measuredClassification: 'not_a_defect_for_the_recorded_literal_tree_case',
    }, population(2, { bothMatch: 1, bothRejectSibling: 1 }));
  });

  it('14 — treats lower-is-better improvement as consecutive score decline regression', () => {
    const entries: CampaignEntry[] = [30, 20, 10].map((score, index) => ({
      seq: index + 1,
      runId: `lower-is-better-${index + 1}`,
      score,
      metric: 'error_count',
      gate: 'quality',
      pass: true,
      timestamp: `2026-09-${String(17 + index).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const alert = checkCampaignHealth(entries, {
      enabled: true, regressionAfter: 2, plateauAfter: 99, repeatedFailureAfter: 99,
    });
    expect(alert).toMatchObject({ type: 'regression', message: '2 consecutive score declines' });
    expect(Object.prototype.hasOwnProperty.call(entries[0], 'higherIsBetter')).toBe(false);
    record(14, 'three distinct successful campaign entries for a lower-is-better error_count metric: 30 → 20 → 10', {
      scores: entries.map((entry) => entry.score),
      metric: entries[0].metric,
      directionFieldPresent: Object.prototype.hasOwnProperty.call(entries[0], 'higherIsBetter'),
      alert,
    }, population(2, { directionRepresentable: 0, directionAbsent: 2 }));
  });

  it('15 — builds a QA prompt without the immutable no-candidate outcome already in the run', () => {
    const root = temporaryRoot('engine-remediation-no-candidate-prompt-');
    const projectDir = join(root, 'project');
    const runDirectory = join(root, 'run');
    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
    write(join(runDirectory, 'research_round_1_no_candidate_consumed.json'), JSON.stringify({
      label: 'no-safe-candidate', outcome: 'no_candidate', reason: 'all candidates failed a hard safety constraint',
    }));
    write(join(runDirectory, 'brief_criteria.json'), JSON.stringify({
      criteria: [{ id: 'criterion-measured', text: 'Report the measured candidate score.' }],
    }));
    const prompt = buildStagePrompt({
      dependsOn: [],
      promptTemplate: 'Audit every assigned criterion.',
      projectDir,
      runId: 'prompt-before',
      runDir: runDirectory,
      taskDescription: '# Prompt fixture',
      isGate: true,
      stageId: 'qa_gate',
      criterionRefs: ['criterion-measured'],
    });
    const outcomeMentions = ['no-safe-candidate', 'no_candidate', 'all candidates failed']
      .filter((needle) => prompt.includes(needle));
    expect(existsSync(join(runDirectory, 'research_round_1_no_candidate_consumed.json'))).toBe(true);
    expect(prompt).toContain('Report the measured candidate score.');
    expect(outcomeMentions).toEqual([]);
    record(15, 'place immutable consumed no-candidate evidence beside brief_criteria.json, then build the assigned QA prompt', {
      immutableOutcomeExists: true,
      immutableOutcome: { label: 'no-safe-candidate', outcome: 'no_candidate' },
      assignedCriterionPresent: prompt.includes('Report the measured candidate score.'),
      outcomeMentionsInPrompt: outcomeMentions,
      promptContainsDeclaredOutcome: outcomeMentions.length > 0,
    }, population(1, { gatePromptMissingOutcome: 1 }));
  });

  it('16 — selects only retry_to repair stages when a rejection says completed producer work is absent', () => {
    const producer: StageConfig = {
      id: 'measure', role: 'worker', depends_on: [], prompt_template: 'measure', skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const gate: StageConfig = {
      id: 'qa', role: 'qa', depends_on: ['measure'], prompt_template: 'reject missing measurement', skills: [], dynamic_dispatch: false, is_gate: true,
    };
    const repair: StageConfig = {
      id: 'repair_report', role: 'worker', depends_on: ['qa'], retry_to: ['qa'],
      prompt_template: 'revise report', skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const state: Pick<StoreState, 'stages'> = {
      stages: {
        measure: { status: 'complete', retries: 0 },
        qa: { status: 'complete', retries: 0 },
        repair_report: { status: 'complete', retries: 0 },
      },
    };
    const selected = findAllRetryToStages([producer, gate, repair], ['qa']);
    expect(selected.map((stage) => stage.id)).toEqual(['repair_report']);
    expect(state.stages.measure.status).toBe('complete');
    record(16, 'completed measurement producer + rejecting gate + completed report repair wired retry_to the gate', {
      rejectionReason: 'no measurement exists',
      selectedForRepend: selected.map((stage) => stage.id),
      completedProducerStatus: state.stages.measure.status,
      completedProducerSelected: selected.some((stage) => stage.id === 'measure'),
      gateSelectedByRepairRouting: selected.flatMap((stage) => stage.retry_to ?? []),
    }, population(3, { redispatchedRepair: 1, reevaluatedGate: 1, completedProducerNotRedispatched: 1 }));
  });

  it('17 — accepts a non-owner scope request for a path admission reserves to a finalizer', { timeout: 20_000 }, async () => {
    const root = temporaryRoot('engine-remediation-terminal-scope-');
    const projectDir = join(root, 'project');
    const globalRoot = join(root, 'fc-home');
    const terminalPath = 'docs/escalation.md';
    const task = [
      '---',
      'terminal_states:',
      '  escalated:',
      `    paths: [${terminalPath}]`,
      '---',
      '# Terminal scope fixture',
    ].join('\n');
    const parsed = parseBriefFrontmatter(task);
    const base: StageConfig = {
      id: 'plan', role: 'planner', depends_on: [], prompt_template: 'plan', skills: [], dynamic_dispatch: true, is_gate: false,
    };
    const work: StageConfig = {
      id: 'repair', role: 'worker', scope: [], depends_on: ['plan'], prompt_template: 'repair', skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const finalizer: StageConfig = {
      id: 'finalizer', role: 'worker', scope: [terminalPath], depends_on: ['repair'], prompt_template: 'finalize', skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const admission = inspectDispatchAdmission({
      dispatched: [work, finalizer],
      baseStages: [base],
      dispatchStageId: 'plan',
      terminalStates: parsed.terminalStates,
    });
    expect(admission.pass).toBe(true);
    expect(admission.terminalOwners[terminalPath]).toBe('finalizer');

    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
    const agentsDir = writeRole(projectDir, 'worker');
    setFcGlobalDir(globalRoot);
    const runtimeStage: StageConfig = {
      id: 'repair', role: 'worker', scope: [], depends_on: [], prompt_template: 'request terminal path',
      skills: [], dynamic_dispatch: false, is_gate: false,
    };
    const config: WorkflowConfig = {
      name: 'terminal-scope-before', defaults: { max_iterations: 1, max_retries: 1 }, stages: [runtimeStage],
    };
    const yaml = [
      'name: terminal-scope-before',
      'defaults: {max_iterations: 1, max_retries: 1}',
      'stages:',
      '  - id: repair',
      '    role: worker',
      '    scope: []',
      '    prompt_template: request terminal path',
    ].join('\n');
    let invocations = 0;
    let decisionPath = '';
    const final = await runWorkflow(
      config, yaml, projectDir, { async run(_prompt, _role, opts) {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        invocations += 1;
        if (invocations === 1) {
          const stagePath = join(opts.runDir, 'stages', opts.stageId);
          const requestedPaths = [terminalPath];
          write(join(stagePath, 'scope_revision_request.json'), JSON.stringify({
            version: 1,
            kind: 'scope_revision',
            requestId: 'terminal-non-owner-before',
            runId: basename(opts.runDir),
            stageId: opts.stageId,
            attemptIndex: 1,
            requestedPaths,
            pathDigest: scopePathDigest(requestedPaths),
            reason: 'write the reserved terminal artifact from repair',
          }));
          decisionPath = await waitForFile(stagePath, (name) => name.startsWith('scope_revision_decision_') && name.endsWith('.json'));
        }
        return { output: `repair invocation ${invocations}`, exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      } },
      new Map(), undefined, agentsDir, undefined, task, true, false,
    );
    const decision = JSON.parse(readFileSync(decisionPath, 'utf-8')) as Record<string, unknown>;
    const scopeEvents = readRunEvents(projectDir, final.runId)
      .filter((event) => event.type === 'scope_revision_decided');
    expect(decision).toMatchObject({ accepted: true, decision: 'accepted', authorizedPaths: [terminalPath] });
    expect(scopeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: 'repair', decision: 'accepted' }),
    ]));
    record(17, 'admit finalizer as sole terminal owner, then have repair request that exact path during a real scheduler attempt', {
      admissionPass: admission.pass,
      admittedOwner: admission.terminalOwners[terminalPath],
      requestingStage: 'repair',
      decision: {
        accepted: decision.accepted,
        decision: decision.decision,
        authorizedPaths: decision.authorizedPaths,
        policyBasis: decision.policyBasis,
      },
      eventTypes: scopeEvents.map((event) => ({ type: event.type, decision: event.decision, stageId: event.stageId })),
      invocations,
    }, population(1, { nonOwnerTerminalScopeAccepted: 1 }));
  });

  it('18 — records a Makefile test runner as population-unverified without trying a dry-run collector', { timeout: 20_000 }, async () => {
    const root = temporaryRoot('engine-remediation-make-population-');
    const sourceDir = join(root, 'source');
    const targetDir = join(root, 'target');
    const stateDir = join(root, 'state');
    const briefPath = join(sourceDir, 'brief.md');
    write(join(sourceDir, 'Makefile'), [
      'test:',
      '\t@node --test spec/example.test.js',
    ].join('\n'));
    write(briefPath, '# Goal\nPreserve the configured test population.\n');
    const runnerCalls: Array<{ cwd: string; display: string }> = [];
    const createWorktree: GitWorktreeCreator = (request) => {
      mkdirSync(request.targetDir, { recursive: true });
      write(join(request.targetDir, 'Makefile'), readFileSync(join(sourceDir, 'Makefile'), 'utf-8'));
      return { exitCode: 0 };
    };
    const report = await runShipSetup([
      'ship-setup', '--brief', briefPath, '--project', sourceDir,
      '--target', targetDir, '--base', 'fixture-base', '--branch', 'fixture-branch',
    ], {
      createWorktree,
      runValidationCommand: (request) => {
        runnerCalls.push({ cwd: request.cwd, display: request.display });
        return { exitCode: 0, stdout: '1 passed\n', durationMs: 1 };
      },
      globalDir: () => stateDir,
    });
    const discoveryBody = block(source('src/cli-ship-setup.ts'), 'function discoverTestPopulationMethod(', 'function parseCollectedTestIdentities');
    expect(report.state).toBe('ready');
    expect(report.testPopulation).toMatchObject({ state: 'unverified' });
    expect(report.testPopulation?.reason).toContain('Configured test runner "make test"');
    expect(discoveryBody).not.toContain('make -n');
    record(18, 'source and target contain the same Makefile test target; run ship-setup with an injected successful opaque runner', {
      reportState: report.state,
      testPopulation: report.testPopulation,
      runnerCalls,
      dryRunCollectorCalls: runnerCalls.filter((call) => call.display.includes('make -n')).length,
      discoveryContainsMakeDryRun: discoveryBody.includes('make -n'),
    }, population(1, { makeRunnerPopulationUnverified: 1 }));
  });

  it('19 — validates candidate defaults with deployed code and never executes the worktree config module', () => {
    const projectDir = temporaryRoot('engine-remediation-config-version-');
    const marker = join(projectDir, 'candidate-validator-ran.txt');
    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: candidate-rule\n');
    write(join(projectDir, 'src', 'config.ts'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'candidate validator executed');`,
      "export const acceptsCandidateRule = true;",
    ].join('\n'));
    const outcome = (() => {
      try { return { state: 'accepted', value: loadProjectDefaults(projectDir).default_timeout_ms }; }
      catch (error) { return { state: 'rejected', error: error instanceof Error ? error.message : String(error) }; }
    })();
    expect(outcome).toMatchObject({ state: 'rejected' });
    expect(existsSync(marker)).toBe(false);
    record(19, 'worktree defaults use a value its colocated candidate config module declares acceptable; call deployed loadProjectDefaults', {
      loaderOutcome: outcome,
      candidateModuleExists: existsSync(join(projectDir, 'src', 'config.ts')),
      candidateModuleMarkerExists: existsSync(marker),
      validationSource: 'deployed_imported_module',
    }, population(1, { rejectedBeforeCandidateValidatorExecution: 1 }));
  });

  it('20 — receives SIGINT during the first followed event before any interrupt handler exists', () => {
    const root = temporaryRoot('engine-remediation-events-race-');
    const runs = join(root, 'runs');
    const runDirectory = join(runs, 'race-run');
    write(join(runDirectory, 'run.json'), JSON.stringify({
      runId: 'race-run', status: 'running', projectDir: join(root, 'project'), stages: {},
    }));
    appendFileSync(join(runDirectory, 'events.jsonl'), `${JSON.stringify({
      type: 'guidance_written', runId: 'race-run', timestamp: '2026-09-19T12:00:00.000Z',
      stageId: 'work', detail: 'awaited-before-handler',
    })}\n`);
    const childScript = [
      "import { pathToFileURL } from 'node:url';",
      "import { join } from 'node:path';",
      'const modulePath = process.argv[1];',
      'const root = process.argv[2];',
      'const { cmdEventsWithDeps } = await import(pathToFileURL(modulePath).href);',
      'const writer = { write(chunk) {',
      '  const value = String(chunk);',
      '  process.stdout.write(value);',
      "  if (value.includes('awaited-before-handler')) {",
      "    process.stdout.write(`HANDLER_COUNT=${process.listenerCount('SIGINT')}\\n`);",
      "    process.kill(process.pid, 'SIGINT');",
      '  }',
      '} };',
      'await cmdEventsWithDeps([\'events\', \'--run\', \'race-run\', \'--json\', \'--follow\'], {',
      "  runsRoot: join(root, 'runs'), stdout: writer, stderr: process.stderr,",
      '  followPollMs: 1, maxFollowPolls: 1, sleep: async () => undefined,',
      '});',
    ].join('\n');
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', childScript,
      join(PROJECT_ROOT, 'src', 'cli-events.ts'), root,
    ], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, HOME: root, FC_HOME: root },
      encoding: 'utf-8',
      timeout: 10_000,
    });
    expect(result.stdout).toContain('awaited-before-handler');
    expect(result.stdout).toContain('HANDLER_COUNT=0');
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGINT');
    record(20, 'follow one pre-existing matching event; injected writer self-sends real SIGINT synchronously on the first matched output', {
      directExitCode: result.status,
      directSignal: result.signal,
      matchedOutput: result.stdout.split('\n').filter(Boolean),
      stderr: result.stderr.trim(),
      handlerCountAtMatchedOutput: 0,
    }, population(1, { matchedThenDiedBySigint: 1 }));
  });
});
