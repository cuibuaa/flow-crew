import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { runProjectValidationBaseline } from '../src/project-validation.js';
import { parseDispatchedStageConfig, type WorkflowConfig } from '../src/scheduler.js';
import { createScopeSafeStageRunner } from '../src/scheduler/sched_scope/stage-group.js';
import { executeSingleStage } from '../src/scheduler/sched_settlement/stage-execution.js';
import { bindReviewedGateValidation, gateValidationRefusal, recordGateValidationDelta } from '../src/scheduler/sched_settlement/gate-validation.js';
import { createRun } from './test-support/create-run.js';
import { beginStageAttempt, completeStageAttempt, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, writeRunState, writeStageStatus } from '../src/store.js';
import { fixtureArtifactContract, fixtureResult } from './test-support/declared-dispatch.js';

let root: string, project: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'receipt-owner-'));
  project = join(root, 'project');
  mkdirSync(join(project, 'agents'), { recursive: true });
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

const role: AgentConfig = { name: 'reviewer', description: 'fixture', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'Review the product.' };

async function fixture() {
  const stage = parseDispatchedStageConfig({ id: 'review', role: 'reviewer', is_gate: true, scope: [],
    artifact_contract: fixtureArtifactContract('review', true) });
  const workflow: WorkflowConfig = { name: 'direct', defaults: { max_iterations: 1, max_retries: 0 }, stages: [stage] };
  const created = createRun(project, workflow.name, 'name: direct\nstages: []\n', ['review']);
  const counter = join(root, 'executions');
  writeFileSync(counter, '');
  const baseline = await runProjectValidationBaseline(project, {
    commands: [{ role: 'test', command: process.execPath,
      args: ['-e', 'const fs = require("node:fs"); fs.appendFileSync(process.argv[1], "test\\n"); if (fs.existsSync("product.ts")) { console.log("FAILED tests/test_product.py::test_missing_result\\n1 failed"); process.exit(1); }', counter], display: 'fixture test' }],
    runCommand: () => ({ exitCode: 0 }),
  });
  writeFileSync(join(created.runDirPath, 'validation_baseline.json'), JSON.stringify({ version: 1, source: 'ship-setup-ready-record', baseline }));
  const state = readRunState(project, created.runId); state.status = 'running'; writeRunState(project, created.runId, state);
  return { ...created, stage, workflow, state, counter };
}

describe('configured validation has one wave settlement owner', () => {
  it('executes once per unchanged review, including repeated inner-loop reviews', async () => {
    const f = await fixture();
    const runner = createScopeSafeStageRunner({
      monitorApprovalRequests: async () => null,
      reconcileCompletedStageAttempts: () => ({ violation: false, }),
    });
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      return fixtureResult({ output: JSON.stringify({ pass: true, reason: 'Independent review passed.', criteria: {}, audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
    } };
    const counts: number[] = [];
    for (let round = 0; round < 3; round++) {
      await runner.runScopeSafeStageGroup([f.stage], project, f.runId, 1, stage => executeSingleStage(
        stage, project, f.runId, f.runDirPath, f.workflow, adapter, new Map([['reviewer', role]]),
        join(project, 'agents'), readRunState(project, f.runId), [stage],
      ));
      const status = readStageStatus(project, f.runId, 'review');
      expect(status.status, JSON.stringify(status)).toBe('complete');
      expect(gateValidationRefusal(project, f.runId, 'review')).toBeUndefined();
      const total = readFileSync(f.counter, 'utf8').trim().split('\n').length;
      counts.push(total - counts.reduce((sum, count) => sum + count, 0));
    }
    console.log('VALIDATION_EXECUTIONS_PER_REVIEW', JSON.stringify(counts));
    expect(counts).toEqual([1, 1, 1]);
    const receipts = readdirSync(f.runDirPath).filter(name => /^validation_delta_review_attempt_/.test(name))
      .map(name => JSON.parse(readFileSync(join(f.runDirPath, name), 'utf8')));
    // Immutable bind copies are evidence, not additional command executions.
    expect(new Set(receipts.map(receipt => receipt.checkedAt)).size).toBe(3);
  });

  it('waits for peer closure and catches a real regression written after review', async () => {
    const f = await fixture();
    const peer = parseDispatchedStageConfig({ id: 'peer', role: 'writer', scope: ['product.ts'],
      artifact_contract: fixtureArtifactContract('peer') });
    writeStageStatus(project, f.runId, peer.id, { status: 'pending', retries: 0 });
    const runner = createScopeSafeStageRunner({
      monitorApprovalRequests: async () => null,
      reconcileCompletedStageAttempts: () => ({ violation: false, }),
    });
    let releasePeer!: () => void;
    const reviewClosed = new Promise<void>(resolve => { releasePeer = resolve; });
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      return fixtureResult({ output: JSON.stringify({ pass: true, reason: 'Reviewed the original project.', criteria: {}, audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'snapshot' }, opts);
    } };
    await runner.runScopeSafeStageGroup([f.stage, peer], project, f.runId, 1, async stage => {
      if (stage.id === 'peer') {
        beginStageAttempt(project, f.runId, peer.id, 0);
        await reviewClosed;
        writeFileSync(join(project, 'product.ts'), 'regressed');
        completeStageAttempt(project, f.runId, peer.id, 0, { exitCode: 0, duration_ms: 1, writes: ['product.ts'], writeAttribution: 'snapshot' });
        return;
      }
      const result = await executeSingleStage(stage, project, f.runId, f.runDirPath, f.workflow, adapter,
        new Map([['reviewer', role]]), join(project, 'agents'), readRunState(project, f.runId), [f.stage, peer]);
      releasePeer();
      return result;
    });
    expect(readFileSync(f.counter, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(gateValidationRefusal(project, f.runId, 'review')).toMatchObject({ pass: false, reason: expect.stringContaining('test_missing_result') });
  });

  it.each(['gate-write', 'peer-write', 'peer-unknown', 'generated-write', 'baseline-change', 'prior-write'])(
    'invalidates only changes relevant to the current review (%s)', async kind => {
      const f = await fixture();
      const start = '2026-01-02T00:00:00.000Z', end = '2026-01-02T00:00:02.000Z';
      const prior = { index: 1, status: 'failed', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:02.000Z', writes: ['product.ts'], writeAttribution: 'snapshot' as const };
      const current = { index: 2, status: 'running', startedAt: start, writes: [], writeAttribution: 'snapshot' as const };
      writeStageStatus(project, f.runId, 'review', { status: 'running', retries: 0, attempts: [prior, current] });
      await recordGateValidationDelta(project, f.runId, 'review');
      writeStageStatus(project, f.runId, 'review', { status: 'complete', retries: 0, attempts: [prior, {
        ...current, status: 'complete', completedAt: end,
        writes: kind === 'gate-write' ? ['product.ts'] : [],
        ...(kind === 'generated-write' ? { validationGeneratedWrites: ['generated.js'] } : {}),
      }] });
      if (kind.startsWith('peer-')) writeStageStatus(project, f.runId, 'peer', { status: 'complete', retries: 0, attempts: [
        { ...prior, startedAt: start, completedAt: end, writeAttribution: kind === 'peer-unknown' ? 'unknown' : 'snapshot' },
        { ...current, status: 'complete', startedAt: end, completedAt: end },
      ] });
      if (kind === 'baseline-change') appendFileSync(join(f.runDirPath, 'validation_baseline.json'), '\n');
      const bound = bindReviewedGateValidation(project, f.runId, 'review', kind.startsWith('peer-') ? ['review', 'peer'] : ['review']);
      expect(bound).toBe(kind === 'prior-write');
      if (!bound) await recordGateValidationDelta(project, f.runId, 'review');
      expect(readFileSync(f.counter, 'utf8').trim().split('\n')).toHaveLength(kind === 'prior-write' ? 1 : 2);
    },
  );

  it('keeps a newly measured test regression as a gate rejection', async () => {
    const f = await fixture();
    const attempt = { index: 1, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', status: 'complete', writes: [], writeAttribution: 'snapshot' as const };
    writeStageStatus(project, f.runId, 'review', { status: 'complete', retries: 0, attempts: [attempt] });
    await recordGateValidationDelta(project, f.runId, 'review', { runCommand: () => ({ exitCode: 1, stdout: 'FAILED tests/test_product.py::test_missing_result\n1 failed' }) });
    expect(gateValidationRefusal(project, f.runId, 'review')).toMatchObject({ pass: false, reason: expect.stringContaining('test_missing_result') });
  });
});
