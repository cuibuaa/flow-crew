import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { captureStageArtifactContractPreimages, inspectStageArtifactContract, stageArtifactProduction, verifyStageArtifactContract } from '../src/stage-artifact-contract.js';
import { reusableStageArtifactProduction } from '../src/recorded-artifact-contract.js';
import { createRun, fcGlobalDir, readStageStatus, setFcGlobalDir, type StageStatus } from '../src/store.js';
import { runStage } from '../src/worker.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(kind: 'file' | 'directory' = 'file', isGate = false) {
  const root = mkdtempSync(join(tmpdir(), 'fc-artifact-life-')); roots.push(root);
  const projectDir = join(root, 'project'), runDir = join(root, 'run'); mkdirSync(projectDir); mkdirSync(runDir);
  const name = isGate ? 'verdict_work.json' : 'product';
  const input = { stageId: 'work', template: 'stable admitted duties', projectDir, runDir, isGate,
    artifactContract: ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'product', root: 'run', path: name, kind }], reads: [], replays: [] }) };
  const preimages = captureStageArtifactContractPreimages(input);
  const target = join(runDir, name);
  if (kind === 'directory') { mkdirSync(target); writeFileSync(join(target, 'member'), 'content'); }
  else writeFileSync(target, 'content');
  const audit = inspectStageArtifactContract({ ...input, preimages });
  const start = '2026-01-01T00:00:00.000Z', close = '2026-01-01T00:00:01.000Z', end = '2026-01-01T00:00:03.000Z';
  audit.checkedAt = '2026-01-01T00:00:02.000Z';
  audit.production = stageArtifactProduction({ ...input, runId: 'owned-run', attemptIndex: 1, attemptStartedAt: start });
  const current = stageArtifactProduction({ ...input, runId: 'owned-run', attemptIndex: 2, attemptStartedAt: '2026-01-01T00:00:04.000Z' });
  const attempts: NonNullable<StageStatus['attempts']> = [{ index: 1, startedAt: start, completedAt: end, status: 'complete', exitCode: 0,
    timeout: { attemptId: 'owned', budgetMs: 60000, attemptStartedAt: start, deadlineAt: end, elapsedMs: 3000, remainingMs: 57000, rejectedExtensionCount: 0, decisionPaths: [], mismatchPaths: [], terminationCause: 'complete', childClosedAt: close, deadlineOverrunMs: 0 } }];
  const settled = () => captureStageArtifactContractPreimages(input);
  return { input, target, audit, current, attempts, settled };
}

describe('admitted-stage artifact production across executions', () => {
  it.each([0, 1])('retains worker-authenticated outputs after direct exit %s without replaying the old invocation', async (firstExit) => {
    const f = fixture(), previous = fcGlobalDir();
    setFcGlobalDir(join(f.input.runDir, 'store'));
    try {
      const created = createRun(f.input.projectDir, 'artifacts', 'name: artifacts', ['work']);
      const target = join(created.runDirPath, 'product');
      const role = { name: 'coder', description: 'fixture', model: 'test', reasoning_effort: 'low' as const, tools: [], prompt: 'fixture' };
      const options = { stageId: 'work', role, dependsOn: [], promptTemplate: 'current invocation',
        artifactObligationTemplate: f.input.template, artifactContract: f.input.artifactContract,
        projectDir: f.input.projectDir, runId: created.runId, runDir: created.runDirPath, timeout_ms: 60000, retries: 0 };
      let calls = 0;
      const adapter = { async run() { calls++; if (calls === 1) writeFileSync(target, 'owned output');
        return { output: `new invocation ${calls}`, exitCode: calls === 1 ? firstExit : 0, duration_ms: 1,
          writes: calls === 1 ? ['run:product'] : [], writeAttribution: 'structured' as const }; } };
      const first = await runStage(adapter, options);
      const second = await runStage(adapter, options);
      expect(first.exitCode).toBe(firstExit); expect(second.exitCode).toBe(0); expect(calls).toBe(2);
      expect(readStageStatus(f.input.projectDir, created.runId, 'work').attempts?.map(a => a.status))
        .toEqual([firstExit === 0 ? 'complete' : 'failed', 'complete']);
    } finally { setFcGlobalDir(previous); }
  });
  it.each(['complete', 'failed', 'suspended'] as const)('reuses unchanged authenticated production after a %s execution', (status) => {
    const f = fixture(); f.attempts[0].status = status;
    const preimages = f.settled();
    const priorProducedArtifacts = reusableStageArtifactProduction(f.current, 'work', f.audit, f.attempts, preimages);
    expect(priorProducedArtifacts).toHaveLength(1);
    expect(inspectStageArtifactContract({ ...f.input, preimages, priorProducedArtifacts }).violations).toEqual([]);
    expect(inspectStageArtifactContract({ ...f.input, preimages, priorProducedPromptArtifacts: [f.target] }).violations[0].reason).toContain('STALE');
  });
  it.each(['run', 'stage', 'root', 'declaration', 'attempt', 'start', 'missing_provenance', 'unknown_close', 'malformed_time', 'running'] as const)('refuses %s lineage', (shape) => {
    const f = fixture();
    switch (shape) {
      case 'run': f.audit.production!.runId = 'foreign'; break;
      case 'stage': f.audit.stageId = 'foreign'; break;
      case 'root': f.audit.production!.runDir = join(f.input.runDir, 'other'); break;
      case 'declaration': f.audit.production!.declarationDigest = 'different'; break;
      case 'attempt': f.audit.production!.attemptIndex = 2; break;
      case 'start': f.audit.production!.attemptStartedAt = 'different'; break;
      case 'missing_provenance': delete f.audit.production; break;
      case 'unknown_close': delete f.attempts[0].timeout!.childClosedAt; break;
      case 'malformed_time': f.attempts[0].completedAt = 'invalid'; break;
      case 'running': f.attempts[0].status = 'running'; break;
    }
    const preimages = f.settled();
    const priorProducedArtifacts = reusableStageArtifactProduction(f.current, 'work', f.audit, f.attempts, preimages);
    expect(priorProducedArtifacts).toEqual([]);
    expect(inspectStageArtifactContract({ ...f.input, preimages, priorProducedArtifacts }).violations[0].reason).toContain('STALE');
  });
  it.each(['file', 'directory'] as const)('refuses a %s changed between attempts or after the reuse boundary', (kind) => {
    const f = fixture(kind), preimages = f.settled();
    const priorProducedArtifacts = reusableStageArtifactProduction(f.current, 'work', f.audit, f.attempts, preimages);
    expect(priorProducedArtifacts).toHaveLength(1);
    writeFileSync(kind === 'file' ? f.target : join(f.target, 'member'), 'changed');
    const changed = f.settled();
    expect(reusableStageArtifactProduction(f.current, 'work', f.audit, f.attempts, changed)).toEqual([]);
    expect(inspectStageArtifactContract({ ...f.input, preimages: changed, priorProducedArtifacts }).violations[0].reason).toContain('STALE');
    rmSync(f.target, { recursive: true });
    expect(inspectStageArtifactContract({ ...f.input, preimages: f.settled(), priorProducedArtifacts }).violations[0].reason).toContain('ABSENT');
  });
  it('keeps gate adjudication current even when stage products are reusable', () => {
    const f = fixture('file', true), preimages = f.settled();
    const priorProducedArtifacts = reusableStageArtifactProduction(f.current, 'work', f.audit, f.attempts, preimages);
    expect(priorProducedArtifacts).toHaveLength(1);
    expect(inspectStageArtifactContract({ ...f.input, preimages, priorProducedArtifacts }).violations[0].reason).toContain('STALE');
    expect(inspectStageArtifactContract({ ...f.input, preimages, priorProducedArtifacts, writes: [f.target] }).violations).toEqual([]);
  });
  it('runs a new replay and refuses its changed result while retaining the product', async () => {
    const f = fixture(), preimages = f.settled();
    const priorProducedArtifacts = reusableStageArtifactProduction(f.current, 'work', f.audit, f.attempts, preimages);
    const target = join(f.input.projectDir, 'current.test.mjs');
    writeFileSync(target, 'import {test} from "node:test";test("current outcome",()=>{throw Error("replay now fails")});\n');
    const artifactContract = ArtifactContractSchema.parse({ ...f.input.artifactContract,
      reads: [{ id: 'test', root: 'project', path: 'current.test.mjs', source: { kind: 'input' } }],
      replays: [{ id: 'evidence', runner: 'node_test', targets: ['test'], argv: [], expected: { exit_code: 0, failures: [] } }] });
    // The replay is part of admission on both sides of the production binding.
    const admitted = { ...f.input, artifactContract };
    f.audit.production = stageArtifactProduction({ ...admitted, runId: 'owned-run', attemptIndex: 1, attemptStartedAt: f.attempts[0].startedAt });
    const current = stageArtifactProduction({ ...admitted, runId: 'owned-run', attemptIndex: 2, attemptStartedAt: '2026-01-01T00:00:04.000Z' });
    expect(reusableStageArtifactProduction(current, 'work', f.audit, f.attempts, preimages)).toEqual(priorProducedArtifacts);
    const audit = await verifyStageArtifactContract({ ...f.input, artifactContract, preimages, priorProducedArtifacts }, { remainingMs: () => 30000 });
    expect(audit.producedPromptArtifacts).toEqual([f.target]);
    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0].reason).toContain('DECLARED_REPLAY_REFUSED');
    expect(audit.replayExecutions[0]).toMatchObject({ status: 'failed', executedTests: 1, exitCode: 1 });
  });
});
