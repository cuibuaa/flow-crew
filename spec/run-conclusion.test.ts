import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { readRunEvents } from '../src/run-events.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { completePlainWorkflow, concludeWorkflowIteration } from '../src/scheduler/sched_loop/iteration-outcome.js';
import { createResearchBudgetFinalizer } from '../src/scheduler/sched_loop/research-terminal.js';
import { createBlockageConcluder } from '../src/scheduler/sched_policy/guidance.js';
import { concludeRun, cancelRunStateAtPath } from '../src/scheduler/sched_policy/run-completion.js';
import { recoverTerminalStudyCompletion } from '../src/scheduler/sched_settlement/completion.js';
import { writeCampaignEntry } from '../src/scheduler/sched_loop/services.js';
import { validationExecutionId } from '../src/scheduler/sched_settlement/gate-validation.js';
import { campaignsRoot, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, updateRunState, writeRunState, writeStageStatus, type RunStatus } from '../src/store.js';
import { createRun } from './test-support/create-run.js';

let root: string, project: string, directory: string, runId: string, previousStore: string;
const adapter = new ScriptedAdapter({});
const review = StageConfigSchema.parse({ id: 'review', role: 'reviewer', is_gate: true });
const startedAt = '2026-10-21T01:49:44.000Z';
const completedAt = '2026-10-21T01:50:44.000Z';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-conclusion-'));
  project = join(root, 'project');
  mkdirSync(project);
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  const created = createRun(project, 'conclusion', 'name: conclusion\nstages: []\n', ['review', 'optional']);
  ({ runId } = created);
  directory = created.runDirPath;
  const state = readRunState(project, runId);
  state.status = 'running';
  state.dispatchedStages = [review];
  writeRunState(project, runId, state);
});
afterEach(() => {
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

function expectOwnerConclusion(status: string) {
  const events = readRunEvents(project, runId);
  expect(events.filter(event => event.type === 'run_status_changed' && event.runStatus === status)).toHaveLength(1);
  expect(readRunState(project, runId).status).toBe(status);
  // The store emits status changes for every write; completion is the owner's effect.
  expect(events.filter(event => event.type === 'run_completed')).toHaveLength(1);
}

async function finishIteration(innerRetriesUsed = 0) {
  const state = readRunState(project, runId);
  const finalizer = createResearchBudgetFinalizer(project, runId, directory,
    { name: 'conclusion', description: '', defaults: {}, stages: [review] }, adapter, new Map(), '', new Map());
  return (await concludeWorkflowIteration(state, [review], 1, ['review'], innerRetriesUsed, 3, 3,
    finalizer, project, runId, directory, adapter, new Set(), new Map())).state;
}

function settledReview(status: 'complete' | 'failed', extra: object = {}) {
  writeStageStatus(project, runId, 'review', {
    status, retries: 0, exitCode: status === 'failed' ? 1 : 0, startedAt, completedAt,
    attempts: [{ index: 1, status, startedAt, completedAt, exitCode: status === 'failed' ? 1 : 0, writes: [], ...extra }],
    ...extra,
  });
}

describe('terminal conclusions from settled evidence', () => {
  it('reports validation_unresolved for the eaf119 review exit 1 instead of bounded attempts', async () => {
    settledReview('failed');
    writeFileSync(join(directory, 'verdict_review.json'), JSON.stringify({ pass: true }));
    const baseline = '{}\n';
    writeFileSync(join(directory, 'validation_baseline.json'), baseline);
    writeFileSync(join(directory, 'validation_delta_review.json'), JSON.stringify({
      version: 2, stageId: 'review', checkedAt: completedAt, pass: false,
      baselineSha256: createHash('sha256').update(baseline).digest('hex'),
      attemptIndex: 1, attemptStartedAt: startedAt, attemptCompletedAt: completedAt,
      executionId: validationExecutionId(runId, 'review', 1, startedAt, completedAt),
      current: [], delta: [{ role: 'test', state: 'unresolved', reason: 'vitest ENOENT; failure identity/count is unavailable', newFailureIdentifiers: [] }],
    }));
    const state = await finishIteration();
    expect(state).toMatchObject({ status: 'incomplete', reasonCode: 'validation_unresolved' });
    expectOwnerConclusion('incomplete');
  });

  it('reports provider_refusal for the 737f62 provider rejection instead of bounded attempts', async () => {
    settledReview('failed', { providerFailure: {
      kind: 'refusal', provider: 'codex', source: 'native_stdout', eventType: 'turn.failed', reason: 'Provider declined this request',
    } });
    const state = await finishIteration(1);
    expect(state).toMatchObject({ status: 'incomplete', reasonCode: 'provider_refusal' });
    expectOwnerConclusion('incomplete');
  });

  it('keeps the b7295c rejected gate incomplete after bounded repair attempts', async () => {
    settledReview('complete');
    writeFileSync(join(directory, 'verdict_review.json'), JSON.stringify({ pass: false, reason: 'New pytest failure remains' }));
    const state = await finishIteration(3);
    expect(state).toMatchObject({ status: 'incomplete', reasonCode: 'bounded_attempts' });
    expectOwnerConclusion('incomplete');
  });

  it('publishes plain completion through the owner and retains pending stages', async () => {
    const state = await completePlainWorkflow(readRunState(project, runId), [], project, runId, directory, 1, adapter, 'base_all_done');
    expect(state.status).toBe('complete');
    expectOwnerConclusion('complete');
    expect(readRunEvents(project, runId).filter(event => event.type === 'run_completed')).toHaveLength(1);
    expect(readRunState(project, runId).stages.optional.status).toBe('pending');
    expect(existsSync(join(directory, 'stages', 'optional', 'status.json'))).toBe(false);
  });

  it('settles superseded work through the blockage owner without rewriting its stage ledger', () => {
    const pending = { status: 'pending' as const, retries: 1, attempts: [
      { index: 1, status: 'failed' as const, startedAt, completedAt, exitCode: 1, error: 'prior failure' },
    ] };
    writeStageStatus(project, runId, 'optional', pending);
    const statusPath = join(directory, 'stages', 'optional', 'status.json');
    const before = readFileSync(statusPath, 'utf8');
    mkdirSync(join(directory, 'signals'), { recursive: true });
    writeFileSync(join(directory, 'signals', 'repeated_blockage.json'), JSON.stringify({ action: 'escalate', detail: 'unchanged evidence' }));
    const { concludeRepeatedBlockage } = createBlockageConcluder(() => {});
    const result = concludeRepeatedBlockage(readRunState(project, runId), { projectDir: project, runId, runDirPath: directory, iteration: 1 });
    expect(result?.stages.optional).toMatchObject({ status: 'skipped', attempts: pending.attempts });
    expect(readFileSync(statusPath, 'utf8')).toBe(before);
    expectOwnerConclusion('escalated');
  });

  it.each([
    ['incomplete', 'bounded_attempts'], ['failed', 'dispatch_refused'], ['failed', 'recovery_blocked'],
  ] as const)('retains runnable obligations after %s / %s', async (status, reasonCode) => {
    const state = await concludeRun(readRunState(project, runId), { status, reasonCode });
    expect(state.stages.optional.status).toBe('pending');
    expect(existsSync(join(directory, 'stages', 'optional', 'status.json'))).toBe(false);
    expectOwnerConclusion(status);
  });

  it('projects the legacy run ledger before terminal publication', async () => {
    const legacy = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
    delete legacy.stateFormat;
    legacy.stages.review = { status: 'complete', retries: 0, exitCode: 0 };
    writeFileSync(join(directory, 'run.json'), JSON.stringify(legacy));
    mkdirSync(join(directory, 'stages', 'review'), { recursive: true });
    writeFileSync(join(directory, 'stages', 'review', 'status.json'), JSON.stringify({ status: 'pending', retries: 0 }));
    updateRunState(project, runId, current => { current.currentIteration = 2; });
    expect(readStageStatus(project, runId, 'review').status).toBe('complete');
    await completePlainWorkflow(readRunState(project, runId), [], project, runId, directory, 1, adapter, 'base_all_done');
    expect(readRunState(project, runId).stages.review.status).toBe('complete');
    expect(readStageStatus(project, runId, 'review').status).toBe('complete');
    expect(readStageStatus(project, runId, 'optional').status).toBe('pending');
    expectOwnerConclusion('complete');
  });

  it('keeps the fc9ce3 missing JSON field behind the reality gate and publishes the failed status', async () => {
    writeFileSync(join(project, 'delivery.json'), JSON.stringify({ title: 'scrubbed delivery' }));
    writeFileSync(join(directory, 'reality_checks.md'), [
      '## Reality checks', 'checks:', '  - name: delivery-required-fields', '    type: json-schema-match',
      '    reads:', '      - id: delivery', '        root: project', '        kind: file', '        path: delivery.json', '        source: {kind: input}',
      '    params:', '      file: delivery.json', '      schema:', '        type: object', '        required: [title, findings]',
    ].join('\n'));
    const state = await completePlainWorkflow(readRunState(project, runId), [], project, runId, directory, 1, adapter, 'base_all_done');
    expect(state.status).toBe('reality_gate_failed');
    expect(state.stages.optional.status).toBe('pending');
    expect(existsSync(join(directory, 'stages', 'optional', 'status.json'))).toBe(false);
    expectOwnerConclusion('reality_gate_failed');
    const report = JSON.parse(readFileSync(join(directory, '.reality-gate.json'), 'utf8'));
    expect(report.pass).toBe(false);
    expect(report.results[0].details).toContain('findings');
  });

  it('keeps a recovered study behind the reality gate in its campaign entry', async () => {
    settledReview('complete');
    writeFileSync(join(directory, 'verdict_review.json'), JSON.stringify({ pass: false, study_complete: true, model_success: false, reason: 'study_complete_without_model_success' }));
    writeFileSync(join(project, 'delivery.json'), '{}');
    writeFileSync(join(directory, 'reality_checks.md'), [
      '## Reality checks', 'checks:', '  - name: recovered-delivery', '    type: json-schema-match',
      '    reads: []', '    params:', '      file: delivery.json', '      schema:',
      '        type: object', '        required: [findings]',
    ].join('\n'));
    const state = readRunState(project, runId);
    state.campaignId = state.campaignStorageKey = 'conclusion-proof';
    const result = await recoverTerminalStudyCompletion(project, runId, state, writeCampaignEntry);
    expect(result?.status).toBe('reality_gate_failed');
    const entries = readFileSync(join(campaignsRoot(), 'conclusion-proof.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(entries.at(-1).status).toBe('reality_gate_failed');
    expectOwnerConclusion('reality_gate_failed');
  });

  it('publishes cancellation and fences an unlocked scheduler completion', async () => {
    const stale = readRunState(project, runId);
    const cancelled = cancelRunStateAtPath(directory, completedAt).state;
    expect(cancelled).toMatchObject({ status: 'cancelled', reasonCode: 'cancelled' });
    expectOwnerConclusion('cancelled');
    await expect(completePlainWorkflow(stale, [], project, runId, directory, 1, adapter, 'base_all_done')).rejects.toThrow(/cancel/i);
    expectOwnerConclusion('cancelled');
    expect(readRunEvents(project, runId).some(event => event.type === 'run_completed' && event.detail === 'complete')).toBe(false);
  });

  it.each(['complete', 'failed', 'shipped', 'ceiling_hit', 'escalated', 'reality_gate_failed', 'cancelled', 'incomplete'] satisfies RunStatus[])(
    'publishes owner completion and status events for terminal %s', async status => {
      writeFileSync(join(directory, 'reality_checks.md'), [
        '## Reality checks', 'checks:', '  - name: count-terminal-checks',
        '    type: exec-script-exit-zero', '    reads: []',
        '    params:', '      script: printf invocation >> reality-executions.txt',
      ].join('\n'));
      await concludeRun(readRunState(project, runId), { status, reasonCode: 'workflow_complete' });
      expectOwnerConclusion(status);
      expect(readRunEvents(project, runId).filter(event => event.type === 'run_completed')).toHaveLength(1);
      const executions = join(project, 'reality-executions.txt');
      if (['complete', 'shipped', 'ceiling_hit'].includes(status)) expect(readFileSync(executions, 'utf8')).toBe('invocation');
      else expect(existsSync(executions)).toBe(false);
    },
  );
});
