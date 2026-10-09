import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderGuidanceEnvelope, type GuidanceEnvelope } from '../src/guidance.js';
import { recordedResourceRegistry, appendRecordedResourceLease } from './test-support/recorded-resource-registry.js';
import { inspectStageArtifactContract, writeStageArtifactContractAudit } from '../src/stage-artifact-contract.js';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { summarizeRunStateView } from '../src/run-state-access.js';
import { invocationInputPath, projectRunStageHistory, readRunStateView, recordInvocationInput, type InvocationInput, type QueryableStoreState } from '../src/run-state-view.js';
import { createRun, fcGlobalDir, readRunState, runDir, setFcGlobalDir, updateRunState, writeStageInput, writeStageStatus, type StageAttempt } from '../src/store.js';

let root: string, project: string, directory: string, runId: string, previousStore: string;
const startedAt = '2026-10-03T00:00:00.000Z';
const observedAt = '2026-10-03T00:01:00.000Z';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-state-view-'));
  project = join(root, 'project');
  mkdirSync(project);
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['writer', 'audit']).runId;
  directory = runDir(project, runId);
  updateRunState(project, runId, (state) => { state.startedAt = startedAt; });
});

afterEach(() => {
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

function attempt(index = 1, start = startedAt, extra: Partial<StageAttempt> = {}): StageAttempt {
  return { index, startedAt: start, status: 'complete', completedAt: observedAt, exitCode: 0, ...extra };
}
function input(extra: Partial<InvocationInput> = {}): InvocationInput {
  return { runId, stageId: 'writer', attemptIndex: 1, attemptStartedAt: startedAt, invocationIndex: 1, boundary: 'adapter', adapter: 'fixture', model: 'unchanged-model', systemPrompt: '# Brief\r\nRendered rôle instructions 🌿', userPrompt: 'Write output.\n\nLate guidance: retain the receipt.\n', capturedAt: observedAt, guidanceIds: ['late_guidance'], ...extra };
}
function view(includePromptText = false) { return readRunStateView(project, runId, { observedAt, includePromptText }); }

describe('versioned run state and immutable invocation inputs', () => {
  it('projects each retired iteration once without adding it to the active DAG or budget', () => {
    const old = { status: 'failed' as const, retries: 0, attempts: [attempt(1, startedAt, { status: 'failed', tokens_in: 700, tokens_out: 300 })] };
    const newer = { status: 'complete' as const, retries: 0, attempts: [attempt(1, observedAt, { tokens_in: 700, tokens_out: 300 })] };
    updateRunState(project, runId, (state) => {
      state.retiredStageUsage = [{ stageId: 'retired', iteration: 1, status: old }, { stageId: 'retired', iteration: 2, status: newer }];
      state.stageEvidence = [{ stageId: 'retired', iteration: 1, status: old, statusPath: 'unused.json', attemptOutputPaths: [] }];
    });
    const state = readRunState(project, runId);
    expect(projectRunStageHistory(state)).toEqual(state.retiredStageUsage);
    expect(Object.keys(state.stages)).toEqual(['writer', 'audit']);
    expect(view().budget.tokens).toMatchObject({ knownInputTokens: 1400, knownOutputTokens: 600 });
    expect(view().stages).not.toHaveProperty('retired');
    const diagnostics: Array<{ code: string; path?: string; detail: string }> = [];
    expect(projectRunStageHistory(JSON.parse('{"retiredStageUsage":[null]}'), diagnostic => diagnostics.push(diagnostic))).toEqual([]);
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'RUN_STAGE_HISTORY_INVALID', path: 'retiredStageUsage[0]' })]);
  });
  it('reproduces the latest-alias overwrite, then preserves final bytes of multiple invocations', () => {
    writeStageStatus(project, runId, 'writer', { status: 'complete', retries: 0, attempts: [attempt(1), attempt(2, observedAt)] });
    writeStageInput(project, runId, 'writer', 'initial prompt before late guidance');
    writeStageInput(project, runId, 'writer', 'second execution latest alias');
    const before = view(true);
    expect(before.prompts.legacyInputs[0]).toMatchObject({ exact: false, text: 'second execution latest alias' });
    expect(before.prompts.missingAttemptInputs).toHaveLength(2);
    expect(before.prompts.invocations).toEqual([]);

    const first = recordInvocationInput(directory, input());
    recordInvocationInput(directory, input({ invocationIndex: 2, systemPrompt: 'fallback system', userPrompt: 'same attempt, different guidance' }));
    recordInvocationInput(directory, input({ attemptIndex: 2, attemptStartedAt: observedAt, userPrompt: 'second attempt final input' }));
    const after = view(true);
    expect(after.prompts.coverage).toBe('recorded');
    expect(after.prompts.completeness).toBe('unknown');
    expect(after.prompts.missingAttemptInputs).toEqual([]);
    expect(after.prompts.invocations).toHaveLength(3);
    expect(after.prompts.invocations.every((entry) => entry.integrity === 'verified' && entry.attemptBinding === 'matched')).toBe(true);
    expect(after.prompts.invocations[0].record).toMatchObject({ userPrompt: input().userPrompt, systemPrompt: input().systemPrompt, userSha256: hash(input().userPrompt), systemSha256: hash(input().systemPrompt), guidanceIds: ['late_guidance'] });
    expect(readFileSync(first.path, 'utf8')).toContain('late_guidance');
    expect(after.prompts.legacyInputs[0].exact).toBe(false);
  });

  it('is idempotent for identical inputs and refuses mutation of an invocation identity', () => {
    const first = recordInvocationInput(directory, input());
    const bytes = readFileSync(first.path, 'utf8');
    expect(recordInvocationInput(directory, input({ capturedAt: '2026-10-03T00:02:00.000Z' })).record.capturedAt).toBe(observedAt);
    expect(() => recordInvocationInput(directory, input({ userPrompt: 'changed bytes' }))).toThrow('INVOCATION_INPUT_CONFLICT');
    expect(readFileSync(first.path, 'utf8')).toBe(bytes);
    expect(readFileSync(join(directory, 'run.json'), 'utf8')).not.toContain('changed bytes');
  });

  it('fences stage/run/path identity and existing symlink escapes', () => {
    expect(() => recordInvocationInput(directory, input({ runId: 'foreign-run' }))).toThrow('INVOCATION_RUN_BINDING');
    expect(() => recordInvocationInput(directory, input({ stageId: 'missing_stage' }))).toThrow('INVOCATION_RUN_BINDING');
    expect(() => invocationInputPath(directory, input({ stageId: '../outside' }))).toThrow();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(directory, 'stages', 'writer', 'invocations'), 'dir');
    expect(() => recordInvocationInput(directory, input())).toThrow('STATE_PATH_ESCAPE');
    expect(existsSync(join(outside, 'attempt_1'))).toBe(false);
    expect(() => readRunStateView(project, '../foreign')).toThrow('STATE_RUN_ID_INVALID');
    expect(() => readRunStateView(root, runId)).toThrow('STATE_RUN_BINDING');
  });

  it('separates reused attempt numbers by execution start and binds retained history', () => {
    const old = attempt(1, startedAt);
    const newer = attempt(1, observedAt);
    recordInvocationInput(directory, input());
    recordInvocationInput(directory, input({ attemptStartedAt: observedAt, userPrompt: 'later iteration, same numeric index' }));
    writeStageStatus(project, runId, 'writer', { status: 'complete', retries: 0, attempts: [newer] });
    updateRunState(project, runId, (state) => {
      state.stageEvidence = [{ stageId: 'writer', iteration: 1, status: { status: 'complete', retries: 0, attempts: [old] }, statusPath: 'unused.json', attemptOutputPaths: [] }];
      state.retiredStageUsage = [{ stageId: 'writer', iteration: 1, status: { status: 'complete', retries: 0, attempts: [old] } }];
    });
    const snapshot = view(true);
    expect(snapshot.prompts.invocations).toHaveLength(2);
    expect(snapshot.prompts.invocations.every((entry) => entry.attemptBinding === 'matched')).toBe(true);
    expect(snapshot.histories.stageEvidence?.[0].iteration).toBe(1);
    expect(snapshot.snapshot.sources.some((entry) => entry.prefix !== undefined && entry.path.endsWith('run-history.v1.jsonl'))).toBe(true);
  });

  it('captures configured supervisor inputs and distinguishes unbound capture from execution evidence', () => {
    expect(() => recordInvocationInput(directory, input({ stageId: '_supervisor' }))).toThrow('INVOCATION_RUN_BINDING');
    updateRunState(project, runId, (state) => {
      state.supervise = true;
      state.supervisor = { status: 'running', calls: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0, startedAt, attempts: [] };
    });
    recordInvocationInput(directory, input({ stageId: '_supervisor' }));
    expect(view().prompts.invocations[0]).toMatchObject({ integrity: 'verified', attemptBinding: 'unmatched' });
    expect(view().prompts.coverage).toBe('partial');
    updateRunState(project, runId, (state) => { state.supervisor!.attempts.push({ index: 1, startedAt, completedAt: observedAt, status: 'complete', duration_ms: 1, exitCode: 0 }); state.supervisor!.calls = 1; });
    expect(view(true).prompts.invocations[0]).toMatchObject({ integrity: 'verified', attemptBinding: 'matched', record: { stageId: '_supervisor', userPrompt: input().userPrompt } });
  });

  it('exposes one stable admitted revision, conditional declarations, findings, guidance and resource leases', () => {
    mkdirSync(join(project, 'docs'));
    writeFileSync(join(project, 'docs', 'present.md'), 'produced');
    writeFileSync(join(project, 'missing.md'), 'wrong-root decoy');
    const registryPath = join(root, 'leases.sqlite');
    recordedResourceRegistry(registryPath);
    appendRecordedResourceLease(registryPath, runId, 'writer', startedAt);
    updateRunState(project, runId, (state) => {
      state.dispatchedStages = [{ id: 'writer', scope: ['docs/**'], artifacts: 'declared elsewhere' }];
      (state as QueryableStoreState).queryState = {
        version: 1,
        planRevision: { revision: 2, digest: hash('plan 2'), admittedAt: observedAt, reason: 'new outcome requires another stage' },
        planHistory: [{ revision: 1, digest: hash('plan 1'), admittedAt: startedAt, reason: 'initial' }],
        artifacts: [
          { id: 'present', root: 'project', path: 'docs/present.md', stageId: 'writer' },
          { id: 'absent_run', root: 'run', path: 'missing.md', stageId: 'writer' },
          { id: 'inactive_branch', root: 'project', path: 'docs/escalation.md', activation: 'inactive', group: 'outcome' },
          { id: 'unknown_branch', root: 'project', path: 'docs/unknown.md', activation: 'unknown' },
          { id: 'traversal', root: 'run', path: '../foreign.md' },
        ],
        findings: [{ id: 'finding_1', status: 'open', paths: ['docs/present.md'], gateId: 'audit', reason: 'attribution line needs repair', invalidatesPlan: false }],
        resourceRegistryPath: registryPath,
      };
    });
    const envelope: GuidanceEnvelope = { version: 1, id: 'guide_1', target: 'writer', source: 'supervisor', createdAt: observedAt, body: 'Repair the declared line.' };
    writeFileSync(join(directory, 'supervisor_guidance.md'), renderGuidanceEnvelope(envelope));
    writeFileSync(join(directory, 'events.jsonl'), `${JSON.stringify({ runId, type: 'guidance_delivery_checked', stageId: 'writer', attemptIndex: 1, attemptStartedAt: startedAt, guidanceIds: ['guide_1'], delivered: true })}\n`);
    writeFileSync(join(directory, 'verdict_audit.json'), JSON.stringify({ verdict: 'reject', findings: ['report line'] }));

    const consumers = ['planner', 'stage', 'supervisor', 'operator'].map(() => view());
    expect(new Set(consumers.map((entry) => entry.snapshot.evidenceSha256)).size).toBe(1);
    const snapshot = consumers[0];
    expect(snapshot.plan.revision?.revision).toBe(2);
    expect(snapshot.plan.history).toHaveLength(1);
    expect(snapshot.artifacts.map((entry) => entry.existence.status)).toEqual(['present', 'absent', 'absent', 'absent', 'invalid_path']);
    expect(snapshot.artifacts[2].declaration.activation).toBe('inactive');
    expect(snapshot.artifacts[3].declaration.activation).toBe('unknown');
    expect(snapshot.audits.openFindings[0].paths).toEqual(['docs/present.md']);
    expect(snapshot.audits.verdicts[0].record).toMatchObject({ verdict: 'reject' });
    expect(snapshot.guidance[0].deliveryState).toBe('delivered');
    expect(snapshot.resources.status).toBe('available');
    if (snapshot.resources.status === 'available') expect(snapshot.resources.snapshot.leases[0].owner.runId).toBe(runId);
  });

  it('exposes settled file bytes and directory members without confusing them with later metadata', () => {
    mkdirSync(join(project, 'large'));
    writeFileSync(join(project, 'small.md'), 'abc');
    writeFileSync(join(project, 'large/payload'), Buffer.alloc(32768, 65));
    const audit = inspectStageArtifactContract({ stageId: 'writer', projectDir: project, runDir: directory,
      writes: ['small.md', 'large/payload'], artifactContract: ArtifactContractSchema.parse({ version: 1,
        produces: [{ id: 'small', root: 'project', path: 'small.md' }, { id: 'large', root: 'project', path: 'large', kind: 'directory' }], reads: [], replays: [] }) });
    expect(audit.violations).toEqual([]);
    writeStageArtifactContractAudit(directory, audit);
    writeFileSync(join(project, 'small.md'), 'edited');
    const summary = summarizeRunStateView(view()) as { artifacts: ReturnType<typeof view>['artifacts'] };
    expect(summary.artifacts.find((entry) => entry.existence.path === join(project, 'small.md'))).toMatchObject({ existence: { bytes: 6 }, settlement: { bytes: 3, fresh: true, checkedAt: audit.checkedAt } });
    expect(summary.artifacts.find((entry) => entry.existence.path === join(project, 'large'))?.settlement).toMatchObject({ bytes: 32768, members: 1, fresh: true });
  });

  it('does not treat unmeasured attempts as zero and avoids counting retired duplicate attempts twice', () => {
    const known = attempt(1, startedAt, { tokenUsage: 'known', tokens_in: 10, tokens_out: 4, duration_ms: 20 });
    const unknown = attempt(2, observedAt, { tokenUsage: 'unknown', tokens_in: 0, tokens_out: 0 });
    writeStageStatus(project, runId, 'writer', { status: 'complete', retries: 0, attempts: [known, unknown] });
    writeStageStatus(project, runId, 'audit', { status: 'complete', retries: 0 });
    updateRunState(project, runId, (state) => {
      state.budget = { totalTokens: 100, usedTokens: 0, totalTimeMs: 300000 };
      state.retiredStageUsage = [{ stageId: 'writer', iteration: 1, status: { status: 'complete', retries: 0, attempts: [known] } }];
      state.supervisor = { status: 'complete', calls: 1, tokens_in: 2, tokens_out: 1, duration_ms: 5, startedAt, completedAt: observedAt, attempts: [{ ...attempt(1), status: 'complete', exitCode: 0, completedAt: observedAt, tokens_in: 2, tokens_out: 1, duration_ms: 5 }] };
    });
    expect(view().budget.tokens).toMatchObject({ knownInputTokens: 12, knownOutputTokens: 5, unknownTokenAttempts: 1, unknownLegacyStages: 1, complete: false, remaining: null });
    expect(view().budget.time).toMatchObject({ knownAttemptDurationMs: 25, unknownDurationAttempts: 2, wallElapsedMs: 60000 });
    expect(view().budget.declared.usedTokens).toBe(0);
  });

  it('keeps malformed event rows visible while retaining later delivery evidence and unknown lifecycle text', () => {
    const queued: GuidanceEnvelope = { version: 1, id: 'queued', target: 'writer', source: 'operator', createdAt: startedAt, body: 'Queued body' };
    const delivered = { ...queued, id: 'delivered' };
    const quarantined = { ...queued, id: 'quarantined', quarantined: true, quarantineReason: 'wrong recipient' };
    writeFileSync(join(directory, 'supervisor_guidance.md'), [queued, delivered, quarantined].map(renderGuidanceEnvelope).join('\n\n'));
    writeFileSync(join(directory, 'events.jsonl'), `torn\u0000row\n${JSON.stringify({ runId, type: 'guidance_delivery_checked', guidanceIds: ['delivered'], delivered: true })}\n{"incomplete":`);
    const raw = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
    raw.status = 'archived-unrecognised-status';
    writeFileSync(join(directory, 'run.json'), JSON.stringify(raw));
    const snapshot = view();
    expect(snapshot.events.malformedRecords).toBe(2);
    expect(snapshot.guidance.map((entry) => entry.deliveryState)).toEqual(['queued', 'delivered', 'quarantined']);
    expect(snapshot.run.statusResolution.kind).toBe('unknown');
    expect(snapshot.diagnostics.some((entry) => entry.code === 'STATE_EVENT_ROWS_UNREADABLE')).toBe(true);
  });

  it('verifies captured bytes and exposes tampering without inventing exact prompts', () => {
    writeStageStatus(project, runId, 'writer', { status: 'complete', retries: 0, attempts: [attempt()] });
    const captured = recordInvocationInput(directory, input({ boundary: 'model', transport: { kind: 'request', payload: '{"messages":["exact payload"]}' } }));
    const metadata = view().prompts.invocations[0].record;
    expect(metadata?.systemPrompt).toBeUndefined();
    expect(metadata?.transport?.payload).toBeUndefined();
    expect(view(true).prompts.invocations[0].record?.transport?.payload).toContain('exact payload');
    const bytes = JSON.parse(readFileSync(captured.path, 'utf8'));
    bytes.userPrompt += '\ntampered';
    writeFileSync(captured.path, JSON.stringify(bytes));
    const corrupted = view();
    expect(corrupted.prompts.invocations[0]).toMatchObject({ integrity: 'invalid', reason: expect.stringContaining('HASH_MISMATCH') });
    expect(corrupted.prompts.missingAttemptInputs).toHaveLength(1);
  });

  it('rejects a malformed extension and truncated acknowledged history instead of dropping facts', () => {
    updateRunState(project, runId, (state) => {
      state.retiredStageUsage = [{ stageId: 'writer', iteration: 1, status: { status: 'failed', retries: 0, attempts: [attempt()] } }];
    });
    const state = readRunState(project, runId);
    const history = state.stateFormat?.history;
    expect(history?.committedBytes).toBeGreaterThan(0);
    const historyPath = join(directory, history!.path);
    const original = readFileSync(historyPath);
    writeFileSync(historyPath, original.subarray(0, Math.max(0, original.length - 10)));
    expect(() => view()).toThrow('Run history is truncated');
    writeFileSync(historyPath, original);
    const runPath = join(directory, 'run.json');
    const raw = JSON.parse(readFileSync(runPath, 'utf8'));
    raw.queryState = { version: 2 };
    writeFileSync(runPath, JSON.stringify(raw));
    expect(() => view()).toThrow();
    expect(relative(directory, invocationInputPath(directory, input()))).toContain('stages/writer/invocations/');
  });

  it('reports missing retained attempt inputs and observes their typed artifact contracts without parsing prose', () => {
    updateRunState(project, runId, (state) => { state.retiredStageUsage = [{ stageId: 'writer', iteration: 1, status: { status: 'complete', retries: 0, attempts: [attempt()] } }]; });
    writeFileSync(join(directory, 'stages', 'writer', 'input.md'), 'Write missing-prose-only.md; this text creates no new duty.');
    writeFileSync(join(directory, 'stages', 'writer', 'artifact_contract.json'), JSON.stringify({ version: 1, stageId: 'writer', obligations: [{ kind: 'prompt_artifact', path: join(directory, 'actual.md') }] }));
    const snapshot = view();
    expect(snapshot.prompts.missingAttemptInputs).toEqual([{ stageId: 'writer', attemptIndex: 1, attemptStartedAt: startedAt }]);
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.artifacts[0]).toMatchObject({ declaration: { root: 'run', path: 'actual.md' }, existence: { status: 'absent' } });
    expect(snapshot.artifacts.some((entry) => entry.declaration.path === 'missing-prose-only.md')).toBe(false);
  });

  it('refuses a changing projection after bounded retries using the compiled deployed-shape module', () => {
    writeFileSync(join(directory, 'events.jsonl'), '');
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { readRunStateView } from ${JSON.stringify(new URL('../dist/run-state-view.js', import.meta.url).href)};
      import { setFcGlobalDir } from ${JSON.stringify(new URL('../dist/store.js', import.meta.url).href)};
      setFcGlobalDir(${JSON.stringify(fcGlobalDir())});
      const original = fs.readFileSync;
      let mutations = 0;
      fs.readFileSync = function(path, ...args) {
        const result = original.call(fs, path, ...args);
        if (String(path) === ${JSON.stringify(join(directory, 'events.jsonl'))}) {
          const statePath = ${JSON.stringify(join(directory, 'run.json'))};
          const state = JSON.parse(original.call(fs, statePath, 'utf8'));
          state.currentIteration = ++mutations;
          fs.writeFileSync(statePath, JSON.stringify(state));
        }
        return result;
      };
      syncBuiltinESMExports();
      let error;
      try { readRunStateView(${JSON.stringify(project)}, ${JSON.stringify(runId)}, { maximumReadAttempts: 3 }); }
      catch (caught) { error = caught.code; }
      finally { fs.readFileSync = original; syncBuiltinESMExports(); }
      process.stdout.write(JSON.stringify({ error, mutations, stableAfterRestore: readRunStateView(${JSON.stringify(project)}, ${JSON.stringify(runId)}).run.currentIteration }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() }, encoding: 'utf8', timeout: 10000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ error: 'STATE_VIEW_UNSTABLE', mutations: 3, stableAfterRestore: 3 });
  });
});
import { spawnSync } from 'node:child_process';
