import { fixtureResult, fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { stringify } from 'yaml';
import type { Adapter } from '../src/adapters/base.js';
import {
  LiveConstraintGuard,
  acquireAttributableWriterLease,
} from '../src/live-constraint-guard.js';
import { loadProjectDefaults } from '../src/config.js';
import { runProjectValidationBaseline } from '../src/project-validation.js';
import { publishConstraintDecision, scopePathDigest, type ScopeRevisionRequestV1 } from '../src/runtime-negotiation.js';
import { decideScopeRevision } from '../src/scheduler/sched_scope/scope-revisions.js';
import { readmitScopeContinuation } from '../src/scheduler/sched_scope/stage-group.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { createScopeBatchContext } from '../src/scheduler/sched_scope/scope-batch.js';
import { createLiveGuardFactory } from '../src/scheduler/sched_scope/write-enforcement.js';

let projectDir: string;
let stateDir: string;
let priorStateDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-closed-loop-live-project-'));
  stateDir = mkdtempSync(join(tmpdir(), 'flowcrew-closed-loop-live-state-'));
  priorStateDir = fcGlobalDir();
  setFcGlobalDir(stateDir);
});

afterEach(() => {
  setFcGlobalDir(priorStateDir);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function seedProject(): string {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  mkdirSync(join(projectDir, 'spec'), { recursive: true });
  mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
  writeFileSync(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
  writeFileSync(join(projectDir, 'config', 'agents', 'coder.yaml'), [
    'name: coder',
    'description: live guard fixture',
    'model: default',
    'reasoning_effort: low',
    'tools: []',
    'prompt: fixture',
  ].join('\n'));
  const path = join(projectDir, 'spec', 'existing.test.ts');
  writeFileSync(path, 'export const invariant = "original";\n');
  writeFileSync(join(projectDir, 'operator-note.txt'), 'pre-existing dirt stays intact\n');
  return path;
}

function workflowFixture(scope: string[] = ['src/allowed.ts']): { config: WorkflowConfig; yaml: string } {
  const config: WorkflowConfig = {
    name: `closed-loop-live-guard-${scope.length > 0 ? 'nonempty' : 'empty'}`,
    defaults: { max_iterations: 1, max_retries: 0 },
    stages: [{ artifact_contract: fixtureArtifactContract('writer', false),
      id: 'writer', role: 'coder', scope, depends_on: [],
      prompt_template: 'Write only the declared source path.', skills: [],
      dynamic_dispatch: false, is_gate: false,
    }],
  };
  const yaml = [
    `name: closed-loop-live-guard-${scope.length > 0 ? 'nonempty' : 'empty'}`,
    'defaults:',
    '  max_iterations: 1',
    '  max_retries: 0',
    'stages:',
    '  - id: writer',
    '    role: coder',
    `    scope: [${scope.join(', ')}]`,
    '    depends_on: []',
    '    prompt_template: Write only the declared source path.',
  ].join('\n');
  return { config, yaml };
}

async function waitForDecision(directory: string, requestId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    for (const name of readdirSync(directory).filter((candidate) => (
      candidate.startsWith('scope_revision_decision_') && candidate.endsWith('.json')
    ))) {
      const decision = JSON.parse(readFileSync(join(directory, name), 'utf-8')) as Record<string, unknown>;
      if (decision.requestId === requestId) return decision;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`scope decision ${requestId} was not published`);
}

function seedInitializedGitlink(): string {
  seedProject();
  const nested = join(projectDir, 'submodule-dir');
  const child = join(nested, 'tracked.txt');
  const fixtureScript = String.raw`
    import { execFileSync } from 'node:child_process';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const projectDir = process.argv[1];
    const nested = join(projectDir, 'submodule-dir');
    const git = (cwd, args) => execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const initialize = (cwd) => {
      git(cwd, ['init', '-q']);
      git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
      git(cwd, ['config', 'user.name', 'FlowCrew Fixture']);
    };
    initialize(projectDir);
    git(projectDir, ['add', '.']);
    git(projectDir, ['commit', '-qm', 'parent baseline']);
    mkdirSync(nested);
    initialize(nested);
    writeFileSync(join(nested, 'tracked.txt'), 'pre-existing child content\n');
    git(nested, ['add', 'tracked.txt']);
    git(nested, ['commit', '-qm', 'nested baseline']);
    const nestedCommit = git(nested, ['rev-parse', 'HEAD']);
    git(projectDir, ['update-index', '--add', '--cacheinfo', '160000', nestedCommit, 'submodule-dir']);
    git(projectDir, ['commit', '-qm', 'record initialized gitlink']);
    if (git(projectDir, ['status', '--porcelain=v1']) !== '') throw new Error('fixture is not clean');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', fixtureScript, projectDir], {
    cwd: projectDir,
    env: { ...process.env, HOME: stateDir, FC_HOME: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

describe('portable live constraint guard', () => {

  it.each([
    { label: 'nested hidden dependency copy', scope: ['**', 'node_modules' + '/', '.venv/'], parent: ['docs', '.comparison', 'node_modules'].join('/') },
    { label: 'root dependency dotfiles', scope: ['**'], parent: 'node_modules' },
    { label: 'narrow capability', scope: ['src/allowed.ts'], parent: ['docs', '.comparison', 'node_modules'].join('/') },
  ])('recovers $label through scope readmission, cleanup and independent gated repair', { timeout: 30_000 }, async ({ scope, parent }) => {
    seedProject();
    mkdirSync(join(projectDir, parent), { recursive: true });
    writeFileSync(join(projectDir, parent, 'operator-owned.txt'), 'pre-existing dependency\n');
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'scope-recovery-fixture', private: true, packageManager: 'npm@10.0.0',
      scripts: { test: 'node -e "process.exit(0)"' } }));
    const { config } = workflowFixture(scope);
    config.defaults.max_retries = 1;
    config.stages.push({ ...config.stages[0], id: 'review', scope: [], is_gate: true,
      depends_on: ['writer'], artifact_contract: fixtureArtifactContract('review', true) },
    { ...config.stages[0], id: 'repair', depends_on: ['review'], retry_to: ['review'] });
    config.dispatch = config.stages;
    config.stages = [{ ...config.stages[0], id: 'plan', scope: [], dynamic_dispatch: true,
      artifact_contract: fixtureArtifactContract('plan') }];
    const yaml = stringify(config);
    const created = createRun(projectDir, config.name, yaml, config.stages.map(stage => stage.id));
    const baseline = await runProjectValidationBaseline(projectDir);
    expect(baseline.results.find(result => result.role === 'test')).toMatchObject({ state: 'passed', exitCode: 0 });
    writeFileSync(join(created.runDirPath, 'validation_baseline.json'), JSON.stringify({
      version: 1, capturedAt: new Date().toISOString(), source: 'ship-setup-ready-record', baseline,
    }));
    const state = readRunState(projectDir, created.runId);
    state.maxRetries = 1;
    state.autoApprove = true;
    writeRunState(projectDir, created.runId, state);
    const paths = [`${parent}/.package-lock.json`, `${parent}/.bin/tool`];
    const calls: string[] = [];
    let writerCalls = 0, reviews = 0;
    let denied = false;
    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      calls.push(opts.stageId);
      if (opts.stageId === 'review') {
        reviews++;
        const pass = !denied && reviews > 1;
        writeFileSync(join(opts.runDir, 'verdict_review.json'), JSON.stringify({ pass,
          reason: denied ? 'cleanup authority denied' : pass ? 'repair verified' : 'technical defect reproduced',
          ...(!pass ? { repairability: { version: 1, disposition: denied ? 'irreparable' : 'repairable',
            evidence: denied ? 'durable scope denial' : 'source still needs repair' } } : {}),
        }));
        return fixtureResult({ output: 'independent review', exitCode: 0, duration_ms: 1 }, opts);
      }
      if (opts.stageId === 'repair') {
        writeFileSync(join(projectDir, 'src/allowed.ts'), 'repaired\n');
        return fixtureResult({ output: 'repaired technical defect', exitCode: 0, duration_ms: 1,
          writes: ['src/allowed.ts'], writeAttribution: 'structured' }, opts);
      }
      writerCalls++;
      if (writerCalls === 1) {
        mkdirSync(join(projectDir, parent, '.bin'), { recursive: true });
        writeFileSync(join(projectDir, paths[0]), 'temporary dependency metadata\n');
        symlinkSync('../.package-lock.json', join(projectDir, paths[1]));
        return fixtureResult({ output: 'temporary comparison created', exitCode: 0, duration_ms: 1,
          writes: paths, writeAttribution: 'structured' }, opts);
      }
      if (writerCalls === 2) {
        expect(prompt).toContain('Do not rewrite those paths unless a scope revision is accepted');
        const directory = join(opts.runDir, 'stages', opts.stageId);
        const requestId = 'recover-comparison';
        writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({ version: 1,
          kind: 'scope_revision', requestId, runId: created.runId, stageId: opts.stageId,
          attemptIndex: opts.attemptIndex, requestedPaths: paths, pathDigest: scopePathDigest(paths),
          reason: 'remove the temporary comparison artifacts recorded by the failed rollback' }));
        const decision = await waitForDecision(directory, requestId);
        denied = decision.accepted !== true;
        return fixtureResult({ output: denied ? JSON.stringify({ status: 'blocked', summary: 'cleanup authority denied',
          files_modified: [], checks: [], caveats: ['Failed rollback requires accepted cleanup authority'] })
          : 'authority accepted; await readmission', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      expect(prompt).toContain('# Accepted scope revision');
      for (const path of paths) rmSync(join(projectDir, path));
      writeFileSync(join(projectDir, 'src/allowed.ts'), 'technical defect\n');
      return fixtureResult({ output: 'comparison removed', exitCode: 0, duration_ms: 1,
        writes: [...paths, 'src/allowed.ts'], writeAttribution: 'structured' }, opts);
    } };
    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined,
      join(projectDir, 'config/agents'), created.runId, 'Recover temporary comparison and deliver reviewed source.', true);
    const deltas = readdirSync(created.runDirPath).filter(name => /^validation_delta_review.*\.json$/.test(name));
    expect(deltas.length).toBeGreaterThan(0);
    for (const name of deltas) expect(JSON.parse(readFileSync(join(created.runDirPath, name), 'utf8')).pass).toBe(true);
    expect(final.status).toBe('complete');
    expect(denied).toBe(false);
    expect(writerCalls).toBe(3);
    expect(calls.slice(-3)).toEqual(['review', 'repair', 'review']);
    for (const path of paths) expect(existsSync(join(projectDir, path))).toBe(false);
    expect(readFileSync(join(projectDir, parent, 'operator-owned.txt'), 'utf8')).toBe('pre-existing dependency\n');
    expect(readFileSync(join(projectDir, 'operator-note.txt'), 'utf8')).toContain('pre-existing dirt');
    const directory = join(created.runDirPath, 'stages/writer');
    const audits = readdirSync(directory).filter(name => /^constraint_audit_attempt_\d+\.json$/.test(name))
      .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
    expect(audits[0].liveIncidents).toEqual(expect.arrayContaining(paths.map(path => expect.objectContaining({
      path, restored: false, rollbackFailure: expect.stringContaining('preimage absence was not observed'),
    }))));
    expect(audits.at(-1).liveIncidents).toEqual([]);
    expect(readFileSync(join(projectDir, 'src/allowed.ts'), 'utf8')).toBe('repaired\n');
  });

  it.each([
    { label: 'non-empty', scope: ['src/allowed.ts'] },
    { label: 'empty', scope: [] },
  ])('restores an unlisted existing test live with a $label declared scope, then re-dispatches its accepted revision', { timeout: 10_000 }, async ({ scope }) => {
    const testPath = seedProject();
    const preimage = readFileSync(testPath, 'utf-8');
    const { config, yaml } = workflowFixture(scope);
    const created = createRun(projectDir, config.name, yaml, ['writer']);
    const state = readRunState(projectDir, created.runId);
    state.autoApprove = true;
    state.maxRetries = 0;
    writeRunState(projectDir, created.runId, state);
    let invocationCount = 0;
    let restoreLatencyMs: number | undefined;
    let correctionBytes: Buffer | undefined;

    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      invocationCount++;
      if (invocationCount === 1) {
        if (scope.length > 0) writeFileSync(join(projectDir, 'src', 'allowed.ts'), 'authorized change survives\n');
        writeFileSync(testPath, 'export const invariant = "unauthorized";\n');
        const writtenAt = performance.now();
        const deadline = writtenAt + 1_000;
        while (performance.now() < deadline && readFileSync(testPath, 'utf-8') !== preimage) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        }
        if (readFileSync(testPath, 'utf-8') === preimage) restoreLatencyMs = performance.now() - writtenAt;
        return fixtureResult({
          output: 'first invocation wrote an unlisted existing test', exitCode: 0,
          duration_ms: performance.now() - writtenAt,
          writes: [...(scope.length > 0 ? ['src/allowed.ts'] : []), 'spec/existing.test.ts'], writeAttribution: 'structured',
        }, opts);
      }

      if (invocationCount === 2) {
        const marker = '# Live constraint correction\n';
        const markerAt = prompt.indexOf(marker);
        expect(markerAt).toBeGreaterThanOrEqual(0);
        const instruction = prompt.slice(markerAt + marker.length).split('\n\n# Execution clock\n')[0].trimEnd();
        correctionBytes = Buffer.from(instruction, 'utf-8');
        expect(prompt).toContain('absolute deadline');
        const directory = join(opts.runDir, 'stages', opts.stageId);
        const requestedPaths = ['spec/existing.test.ts'];
        const requestId = 'authorize-existing-test';
        writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
          version: 1,
          kind: 'scope_revision',
          requestId,
          runId: created.runId,
          stageId: opts.stageId,
          attemptIndex: opts.attemptIndex,
          requestedPaths,
          pathDigest: scopePathDigest(requestedPaths),
          reason: 'the corrected fixture explicitly needs this existing test',
        }));
        expect(await waitForDecision(directory, requestId)).toMatchObject({
          accepted: true, requestId, authorizedPaths: requestedPaths,
          pathDigest: scopePathDigest(requestedPaths),
        });
        return fixtureResult({
          output: 'scope accepted; stop at the control boundary', exitCode: 0,
          duration_ms: 2, writes: [], writeAttribution: 'structured',
        }, opts);
      }

      expect(prompt.match(/# Accepted scope revision\n/g)).toHaveLength(1);
      expect(prompt).toContain(`Continue the stage work in execution ${opts.attemptIndex}`);
      expect(prompt).toContain('Newly admitted paths: ["spec/existing.test.ts"]');
      const decisionName = readdirSync(join(opts.runDir, 'stages', opts.stageId))
        .find((name) => name.startsWith('scope_revision_decision_attempt_'));
      expect(prompt).toContain(`stages/${opts.stageId}/${decisionName}`);
      expect(prompt).not.toContain('This attempt stops at the control boundary');
      writeFileSync(testPath, 'export const invariant = "authorized-after-revision";\n');
      return fixtureResult({
        output: 'corrected after scope re-dispatch', exitCode: 0, duration_ms: 2,
        writes: ['spec/existing.test.ts'], writeAttribution: 'structured',
      }, opts);
    } };

    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      join(projectDir, 'config', 'agents'), created.runId, 'live guard replay', true, false,
    );
    expect(final.status).toBe('complete');
    expect(invocationCount).toBe(3);
    expect(restoreLatencyMs).toBeDefined();
    expect(restoreLatencyMs!).toBeLessThan(1_000);
    if (scope.length > 0) expect(readFileSync(join(projectDir, 'src', 'allowed.ts'), 'utf-8')).toContain('survives');
    else expect(existsSync(join(projectDir, 'src', 'allowed.ts'))).toBe(false);
    expect(readFileSync(join(projectDir, 'operator-note.txt'), 'utf-8')).toBe('pre-existing dirt stays intact\n');

    const status = readStageStatus(projectDir, created.runId, 'writer');
    expect(status.attempts?.map((attempt) => attempt.status)).toEqual(['suspended', 'complete']);
    const firstAudit = status.attempts?.[0].constraintAudit;
    expect(firstAudit).toBeDefined();
    const audit = JSON.parse(readFileSync(join(created.runDirPath, firstAudit!.path), 'utf-8')) as {
      liveIncidents: Array<{ path: string; restored: boolean; detectionLatencyMs: number; scopeRevisionInstruction: string }>;
      scopeRevisionInstructions: string[];
      violations: Array<{ path: string; resolution?: string }>;
    };
    expect(audit.liveIncidents).toHaveLength(1);
    expect(audit.liveIncidents[0]).toMatchObject({ path: 'spec/existing.test.ts', restored: true });
    expect(audit.violations).toContainEqual(expect.objectContaining({
      path: 'spec/existing.test.ts', resolution: 'live_reverted',
    }));
    expect(correctionBytes).toEqual(Buffer.from(audit.scopeRevisionInstructions[0], 'utf-8'));
    expect(existsSync(join(created.runDirPath, 'stages', 'writer', 'constraint_audit_attempt_1.json'))).toBe(true);
  });

  it('delivers restored writes to every batch member once and still restores a new write after readmission', async () => {
    const path = seedProject();
    const preimage = readFileSync(path, 'utf-8');
    const writer = StageConfigSchema.parse(workflowFixture([]).config.stages[0]);
    const peer = { ...writer, id: 'peer' };
    const created = createRun(projectDir, 'incident-delivery', '', ['writer', 'peer']);
    const context = createScopeBatchContext(projectDir, [writer, peer], undefined, created.runId);
    const { createSchedulerLiveConstraintGuardFactory } = createLiveGuardFactory({ transientVitestOutputScopes: () => [] });
    const scan = async (stage: typeof writer, attemptIndex: number) => {
      const factory = createSchedulerLiveConstraintGuardFactory({ stage, projectDir, runId: created.runId, context })!;
      const guard = factory({ attemptIndex, attemptStartedAt: new Date().toISOString() });
      const monitor = guard.beginInvocation(1, () => {});
      return monitor.finish();
    };

    writeFileSync(path, 'first unauthorized write\n');
    expect((await scan(writer, 1)).incidents).toHaveLength(1);
    expect(readFileSync(path, 'utf-8')).toBe(preimage);
    // The peer has not yet observed the batch fact, even though bytes are restored.
    expect((await scan(peer, 1)).incidents).toHaveLength(1);
    expect((await scan(writer, 2)).incidents).toHaveLength(0);
    expect((await scan(peer, 2)).incidents).toHaveLength(0);

    writeFileSync(path, 'another unauthorized write after readmission\n');
    expect((await scan(writer, 2)).incidents).toHaveLength(1);
    expect(readFileSync(path, 'utf-8')).toBe(preimage);
    expect((await scan(peer, 2)).incidents).toHaveLength(1);

    // A durable rollback failure cannot be consumed as though it were settled.
    context.liveViolations.push({
      sequence: ++context.liveViolationSequence, path: 'unrestored.txt', reason: 'rollback failed',
      restored: false, rollbackFailure: 'unavailable preimage', entryKind: 'untracked',
      comparisonOutcome: 'different', changeObserved: true, rollbackAttempted: true,
      targetStageIds: new Set(['writer', 'peer']), deliveredAttemptKeys: new Set(),
    });
    for (const attemptIndex of [3, 4]) {
      for (const stage of [writer, peer]) {
        expect((await scan(stage, attemptIndex)).incidents).toContainEqual(expect.objectContaining({
          path: 'unrestored.txt', restored: false,
        }));
      }
    }
  });

  it('retains a failed rollback as history instead of aborting its admitted recovery in the same batch', async () => {
    seedProject();
    const writer = StageConfigSchema.parse(workflowFixture([]).config.stages[0]);
    const created = createRun(projectDir, 'scope-recovery', '', ['writer']);
    const context = createScopeBatchContext(projectDir, [writer], undefined, created.runId);
    const parent = join(projectDir, 'docs', '.comparison', 'node_modules');
    const path = ['docs', '.comparison', 'node_modules', 'file.txt'].join('/');
    mkdirSync(parent, { recursive: true });
    writeFileSync(join(projectDir, path), 'temporary comparison');
    const { createSchedulerLiveConstraintGuardFactory } = createLiveGuardFactory({ transientVitestOutputScopes: () => [] });
    const scan = (stage: typeof writer, attemptIndex: number) => {
      const guard = createSchedulerLiveConstraintGuardFactory({ stage, projectDir, runId: created.runId, context })!({
        attemptIndex, attemptStartedAt: new Date().toISOString() });
      const monitor = guard.beginInvocation(1, () => {});
      monitor.observePaths([path]);
      return monitor;
    };
    expect((await scan(writer, 1).finish()).incidents).toContainEqual(expect.objectContaining({
      path, restored: false, unrestoredContent: expect.objectContaining({ state: 'present', type: 'file' }),
    }));
    const request: ScopeRevisionRequestV1 = { version: 1, kind: 'scope_revision', requestId: 'recover',
      requestedBy: 'stage', runId: created.runId, stageId: 'writer', attemptIndex: 1,
      requestedPaths: [path], pathDigest: scopePathDigest([path]), reason: 'clean up the recorded comparison' };
    const decision = decideScopeRevision({ request, stage: writer, priorScope: [], activePeers: [],
      projectDir, runId: created.runId, attemptIndex: 1, snapshot: context.snapshot });
    expect(decision.accepted).toBe(true);
    publishConstraintDecision({ stagePath: join(created.runDirPath, 'stages/writer'), request,
      decidedBy: 'scheduler-policy', decision: decision as Parameters<typeof publishConstraintDecision>[0]['decision'] });
    const revised = readmitScopeContinuation(writer, [writer], context.activeStageIds, created.runDirPath, context)!;
    const monitor = scan(revised, 2);
    rmSync(join(projectDir, path));
    expect((await monitor.finish()).incidents).toEqual([]);
    expect(context.liveViolations[0]).toMatchObject({ path, restored: false });
  });

  it('keeps a clean initialized gitlink intact during an explicit read-only stage', { timeout: 20_000 }, async () => {
    const child = seedInitializedGitlink();

    const { config, yaml } = workflowFixture([]);
    const created = createRun(projectDir, config.name, yaml, ['writer']);
    const state = readRunState(projectDir, created.runId);
    state.maxRetries = 0;
    writeRunState(projectDir, created.runId, state);
    let invocationCount = 0;
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      invocationCount++;
      return fixtureResult({ output: 'read-only', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
    } };

    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      join(projectDir, 'config', 'agents'), created.runId, 'initialized gitlink replay', true, false,
    );
    expect(final.status).toBe('complete');
    expect(invocationCount).toBe(1);
    expect(readFileSync(child, 'utf-8')).toBe('pre-existing child content\n');
    const stagePath = join(created.runDirPath, 'stages', 'writer');
    expect(readdirSync(stagePath).filter((name) => name.startsWith('live_constraint_incidents_'))).toEqual([]);
    expect(readStageStatus(projectDir, created.runId, 'writer').constraintAudit).toMatchObject({
      liveViolationCount: 0,
      liveComparisonUnavailableCount: 0,
      unresolvedViolationCount: 0,
    });
  });

  it('attributes a real initialized-gitlink change to the opaque root without deleting nested content', { timeout: 20_000 }, async () => {
    const child = seedInitializedGitlink();
    const { config, yaml } = workflowFixture([]);
    const created = createRun(projectDir, config.name, yaml, ['writer']);
    const state = readRunState(projectDir, created.runId);
    state.maxRetries = 0;
    writeRunState(projectDir, created.runId, state);
    let invocationCount = 0;
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      invocationCount++;
      writeFileSync(child, 'changed child content\n');
      return fixtureResult({
        output: 'changed nested content', exitCode: 0, duration_ms: 1,
        writes: ['submodule-dir/tracked.txt'], writeAttribution: 'structured',
      }, opts);
    } };

    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      join(projectDir, 'config', 'agents'), created.runId, 'changed initialized gitlink replay', true, false,
    );
    expect(final.status).toBe('failed');
    expect(invocationCount).toBe(1);
    expect(readFileSync(child, 'utf-8')).toBe('changed child content\n');
    const stagePath = join(created.runDirPath, 'stages', 'writer');
    const incidentFiles = readdirSync(stagePath).filter((name) => name.startsWith('live_constraint_incidents_'));
    expect(incidentFiles).toHaveLength(1);
    const incident = JSON.parse(readFileSync(join(stagePath, incidentFiles[0]), 'utf-8').trim()) as Record<string, unknown>;
    expect(incident).toMatchObject({
      path: 'submodule-dir',
      entryKind: 'gitlink',
      comparisonOutcome: 'different',
      changeObserved: true,
      rollbackAttempted: true,
      restored: false,
      rollbackFailure: 'refused to replace unexpected directory at submodule-dir',
    });
  });

  it('catches a dropped watch event through the bounded fallback', async () => {
    const aborts: string[] = [];
    let dirty = false;
    const guard = new LiveConstraintGuard({
      projectDir,
      runDir: stateDir,
      stageId: 'writer',
      attemptIndex: 1,
      effectiveScope: () => ['src/allowed.ts'],
      fallbackScanMs: 10,
      monitorDeadlineMs: 100,
      watchProject: () => undefined,
      scanAndRestore: (_paths, trigger) => dirty
        ? {
            scannedPaths: 1,
            violations: [{ path: 'config/defaults.yaml', reason: `caught by ${trigger}`, restored: true }],
          }
        : { scannedPaths: 0, violations: [] },
      scopeRevisionInstruction: (paths) => `revise:${paths.join(',')}`,
    });
    const monitor = guard.beginInvocation(1, (reason) => aborts.push(reason));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    dirty = true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    dirty = false;
    const result = await monitor.finish();
    expect(result.incidents[0]).toMatchObject({
      trigger: 'fallback', path: 'config/defaults.yaml', restored: true,
    });
    expect(aborts).toContain('live_constraint_violation');
  });

  it('records an unavailable comparison without claiming a write or aborting the invocation', async () => {
    const aborts: string[] = [];
    let emitted = false;
    const guard = new LiveConstraintGuard({
      projectDir,
      runDir: stateDir,
      stageId: 'reader',
      attemptIndex: 1,
      effectiveScope: () => [],
      fallbackScanMs: 1_000,
      monitorDeadlineMs: 100,
      watchProject: () => undefined,
      scanAndRestore: () => {
        if (emitted) return { scannedPaths: 1, violations: [] };
        emitted = true;
        return {
          scannedPaths: 1,
          violations: [{
            path: 'submodule-dir',
            reason: 'gitlink representation cannot be compared',
            restored: false,
            entryKind: 'gitlink',
            comparisonOutcome: 'unavailable',
            changeObserved: false,
            rollbackAttempted: false,
          }],
        };
      },
      scopeRevisionInstruction: () => 'must not be requested for an unavailable comparison',
    });

    const monitor = guard.beginInvocation(1, (reason) => aborts.push(reason));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    const result = await monitor.finish();

    expect(result.incidents).toEqual([]);
    expect(aborts).toEqual([]);
    const incidentPath = join(stateDir, 'stages', 'reader', 'live_constraint_incidents_attempt_1.jsonl');
    const incident = JSON.parse(readFileSync(incidentPath, 'utf-8').trim()) as Record<string, unknown>;
    expect(incident).toMatchObject({
      path: 'submodule-dir',
      entryKind: 'gitlink',
      comparisonOutcome: 'unavailable',
      changeObserved: false,
      rollbackAttempted: false,
      restored: false,
    });
    expect(incident).not.toHaveProperty('scopeRevisionInstruction');
  });

  it('fails closed on rollback failure and on a scan that exceeds the monitor deadline', async () => {
    const rollbackGuard = new LiveConstraintGuard({
      projectDir,
      runDir: stateDir,
      stageId: 'writer',
      attemptIndex: 1,
      effectiveScope: () => [],
      watchProject: () => undefined,
      scanAndRestore: () => ({
        scannedPaths: 1,
        violations: [{ path: 'protected.txt', reason: 'cannot restore', restored: false, rollbackFailure: 'denied' }],
      }),
      scopeRevisionInstruction: () => 'request scope',
    });
    const rollbackAborts: string[] = [];
    const rollback = await rollbackGuard.beginInvocation(1, (reason) => rollbackAborts.push(reason)).finish();
    expect(rollback.incidents[0]).toMatchObject({ restored: false, rollbackFailure: 'denied' });
    expect(rollbackAborts).toContain('live_constraint_rollback_failure');

    const deadlineGuard = new LiveConstraintGuard({
      projectDir,
      runDir: stateDir,
      stageId: 'writer',
      attemptIndex: 2,
      effectiveScope: () => [],
      fallbackScanMs: 100,
      monitorDeadlineMs: 20,
      watchProject: () => undefined,
      scanAndRestore: () => new Promise(() => undefined),
      scopeRevisionInstruction: () => 'request scope',
    });
    const deadlineAborts: string[] = [];
    const deadline = await deadlineGuard.beginInvocation(1, (reason) => deadlineAborts.push(reason)).finish();
    expect(deadline.monitorFailure?.reason).toContain('monitor deadline');
    expect(deadlineAborts).toContain('live_constraint_monitor_failure');
  });

  it('H2 uses configured monitor timing and reports the last completed scan', async () => {
    mkdirSync(join(projectDir, 'config'), { recursive: true });
    writeFileSync(join(projectDir, 'config', 'defaults.yaml'), [
      'default_timeout_ms: 60000',
      'live_constraint_fallback_scan_ms: 5',
      'live_constraint_monitor_deadline_ms: 35',
    ].join('\n') + '\n');
    const defaults = loadProjectDefaults(projectDir);
    expect(defaults.live_constraint_fallback_scan_ms).toBe(5);
    expect(defaults.live_constraint_monitor_deadline_ms).toBe(35);

    let scans = 0;
    const failures: Array<Record<string, unknown>> = [];
    const guard = new LiveConstraintGuard({
      projectDir,
      runDir: stateDir,
      stageId: 'writer',
      attemptIndex: 7,
      effectiveScope: () => [],
      fallbackScanMs: defaults.live_constraint_fallback_scan_ms,
      monitorDeadlineMs: defaults.live_constraint_monitor_deadline_ms,
      watchProject: () => undefined,
      scanAndRestore: () => {
        scans++;
        if (scans === 1) return { scannedPaths: 17, violations: [] };
        return new Promise(() => undefined);
      },
      scopeRevisionInstruction: () => 'request scope',
      onMonitorFailure: (failure) => failures.push(failure as unknown as Record<string, unknown>),
    });
    const aborts: string[] = [];
    const started = Date.now();
    const result = await guard.beginInvocation(3, (reason) => aborts.push(reason)).finish();

    expect(Date.now() - started).toBeLessThan(500);
    expect(aborts).toContain('live_constraint_monitor_failure');
    expect(result.monitorFailure).toMatchObject({
      lastScanFileCount: 17,
      lastScanDurationMs: expect.any(Number),
    });
    expect(failures).toEqual([
      expect.objectContaining({
        stageId: 'writer', attemptIndex: 7, invocationIndex: 3,
        lastScanFileCount: 17, lastScanDurationMs: expect.any(Number),
      }),
    ]);
  });

  it('H2 fallback scanning does not descend a symlinked input directory', { timeout: 10_000 }, async () => {
    seedProject();
    writeFileSync(join(projectDir, 'config', 'defaults.yaml'), [
      'default_timeout_ms: 60000',
      'live_constraint_fallback_scan_ms: 5',
      'live_constraint_monitor_deadline_ms: 500',
    ].join('\n') + '\n');
    const external = join(stateDir, 'large-input');
    mkdirSync(external, { recursive: true });
    const externalFile = join(external, 'checkpoint.bin');
    writeFileSync(externalFile, 'before\n');
    symlinkSync(external, join(projectDir, 'linked-input'), 'dir');
    const { config, yaml } = workflowFixture([]);
    const created = createRun(projectDir, config.name, yaml, ['writer']);
    const state = readRunState(projectDir, created.runId);
    state.autoApprove = true;
    writeRunState(projectDir, created.runId, state);
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      writeFileSync(externalFile, 'updated outside the project tree\n');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      return fixtureResult({ output: 'read-only project stage', exitCode: 0, duration_ms: 50, writes: [], writeAttribution: 'structured' }, opts);
    } };

    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      join(projectDir, 'config', 'agents'), created.runId, 'symlink fallback replay', true, false,
    );

    expect(final.status).toBe('complete');
    expect(readFileSync(externalFile, 'utf-8')).toBe('updated outside the project tree\n');
    expect(readStageStatus(projectDir, created.runId, 'writer').attempts?.at(-1)?.constraintAudit)
      .toMatchObject({ liveViolationCount: 0 });
  });

  it('serializes attributable writers while leaving an explicitly read-only lease free', async () => {
    const releaseFirst = await acquireAttributableWriterLease(projectDir, true);
    let secondAcquired = false;
    const second = acquireAttributableWriterLease(projectDir, true).then((release) => {
      secondAcquired = true;
      return release;
    });
    const releaseReadOnly = await acquireAttributableWriterLease(projectDir, false);
    releaseReadOnly();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(secondAcquired).toBe(false);
    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });
});
