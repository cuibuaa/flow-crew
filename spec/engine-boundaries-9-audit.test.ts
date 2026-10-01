import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  captureDeferredStageArtifactContract,
  captureStageArtifactContractPreimages,
  inspectStageArtifactContract,
  type StageArtifactContractInput,
} from '../src/stage-artifact-contract.js';

const roots: string[] = [];
function fixture(template: string): StageArtifactContractInput {
  const root = mkdtempSync(join(tmpdir(), 'fc-artifact-independent-'));
  roots.push(root);
  const projectDir = join(root, 'project');
  const runDir = join(root, 'run');
  mkdirSync(projectDir);
  mkdirSync(runDir);
  return { stageId: 'independent-audit', template, projectDir, runDir };
}
function put(file: string, content = '{"fresh":true}\n'): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
function obligations(input: StageArtifactContractInput): string[] {
  return captureDeferredStageArtifactContract(input).obligations.map(o => o.path);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('independent artifact destination audit', () => {
  it('binds quoted outputs across CRLF continuations in all contract phases', () => {
    const input = fixture('Read inputs/reference.json. Produce "receipt.json" and "handoff.md" in\r\n "{run_dir}/stages/review.v2/".');
    const expected = ['receipt.json', 'handoff.md'].map(name => join(input.runDir, 'stages/review.v2', name));
    const preimages = captureStageArtifactContractPreimages(input);
    expect(preimages.map(p => p.path)).toEqual(expected);
    expect(obligations(input)).toEqual(expected);
    for (const file of expected) put(file);
    const deferred = captureDeferredStageArtifactContract({ ...input, preimages });
    expect(deferred.producedPromptArtifacts).toEqual([...expected].sort());
    const final = inspectStageArtifactContract({ ...input, priorProducedPromptArtifacts: deferred.producedPromptArtifacts });
    expect(final.obligations.map(o => o.path)).toEqual(expected);
    expect(final.violations).toEqual([]);
  });

  it('keeps equal basenames at distinct named destinations as two obligations', () => {
    const input = fixture('Write witness.json in the run directory. Then write witness.json in the project root.');
    const expected = [join(input.runDir, 'witness.json'), join(input.projectDir, 'witness.json')];
    const preimages = captureStageArtifactContractPreimages(input);
    expect(obligations(input)).toEqual(expected);
    put(expected[0]);
    expect(inspectStageArtifactContract({ ...input, preimages }).violations.map(o => o.path)).toEqual([expected[1]]);
  });

  it('refuses a nested run demand despite project and peer-run decoys plus another satisfied output', () => {
    const input = fixture('Write verdict.json under "{run_dir}/stages/qa/nested/". Write reports/completion.md.');
    const demanded = join(input.runDir, 'stages/qa/nested/verdict.json');
    const report = join(input.projectDir, 'reports/completion.md');
    const decoy = join(input.projectDir, 'verdict.json');
    const peerDecoy = join(dirname(input.runDir), 'peer-run/verdict.json');
    const preimages = captureStageArtifactContractPreimages(input);
    expect(preimages.map(p => p.path)).toEqual([demanded, report]);
    put(report, 'Independent satisfied report.\n');
    put(decoy);
    put(peerDecoy);
    const final = inspectStageArtifactContract({ ...input, preimages, writes: [report, decoy, peerDecoy] });
    expect(final.producedPromptArtifacts).toEqual([report]);
    expect(final.violations).toEqual([
      expect.objectContaining({ path: demanded, reason: expect.stringContaining('no readable file exists') }),
    ]);
  });

  it('requires attributable production of a stale run file through deferred completion', () => {
    const input = fixture('Write evidence.json in the run directory.');
    const demanded = join(input.runDir, 'evidence.json');
    const decoy = join(input.projectDir, 'evidence.json');
    put(demanded, '{"old":true}\n');
    const preimages = captureStageArtifactContractPreimages(input);
    put(decoy);
    expect(inspectStageArtifactContract({ ...input, preimages, writes: [decoy] }).violations).toEqual([
      expect.objectContaining({ path: demanded, reason: expect.stringContaining('predated the stage') }),
    ]);
    put(demanded, '{"new":true}\n');
    const deferred = captureDeferredStageArtifactContract({ ...input, preimages });
    expect(deferred.producedPromptArtifacts).toEqual([demanded]);
    expect(inspectStageArtifactContract({ ...input, priorProducedPromptArtifacts: deferred.producedPromptArtifacts }).violations).toEqual([]);
  });

  it('excludes comparison inputs and keeps later output destinations local', () => {
    const input = fixture('Write summary.json in the run directory based on inputs/baseline.json. Then create ledger.json.\n- Read notes.json in the run directory.');
    const expected = [join(input.runDir, 'summary.json'), join(input.projectDir, 'ledger.json')];
    expect(obligations(input)).toEqual(expected);
    expect(inspectStageArtifactContract(input).violations.map(o => o.path)).toEqual(expected);
  });

  it('retains explicit operand roots and refuses destinations outside the current context', () => {
    const input = fixture('Write reports/local.json and receipt.json in the run directory. Write outside.json under {run_dir}/../peer-run. Write this run\'s {project}/foreign.json.');
    expect(obligations(input)).toEqual([join(input.projectDir, 'reports/local.json'), join(input.runDir, 'receipt.json')]);
    expect(captureStageArtifactContractPreimages(input).map(p => p.path)).toEqual(obligations(input));
  });

  it('verifies a newly bound run markdown report through a real local node replay', () => {
    const input = fixture('Write proof.md in the run directory.');
    const report = join(input.runDir, 'proof.md');
    const target = join(input.projectDir, 'spec/witness.test.mjs');
    const preimages = captureStageArtifactContractPreimages(input);
    put(target, "import test from 'node:test'; import assert from 'node:assert/strict'; test('independent witness', () => assert.equal(2 + 2, 4));\n");
    put(report, 'Replay command: node --test spec/witness.test.mjs\n');
    const final = inspectStageArtifactContract({ ...input, preimages });
    expect(final.obligations.map(o => o.path)).toEqual([report, target]);
    expect(final.replayExecutions).toEqual([
      expect.objectContaining({ status: 'passed', exitCode: 0, collectedTests: 1, executedTests: 1 }),
    ]);
    expect(final.violations).toEqual([]);
  });

  it('keeps optional examples and read-only filename mentions non-obligating', () => {
    const input = fixture('Read input.json in the run directory. Compare baseline.json with archive.json. Write optional.md if needed.');
    expect(captureStageArtifactContractPreimages(input)).toEqual([]);
    expect(captureDeferredStageArtifactContract(input).obligations).toEqual([]);
    expect(inspectStageArtifactContract(input).obligations).toEqual([]);
  });
});
