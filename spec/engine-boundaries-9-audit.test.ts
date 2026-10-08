import { ArtifactContractSchema, type ArtifactContractInput } from '../src/artifact-declarations.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  captureDeferredStageArtifactContract,
  captureStageArtifactContractPreimages,
  inspectStageArtifactContract,
  verifyStageArtifactContract,
  type StageArtifactContractInput,
} from '../src/stage-artifact-contract.js';

const roots: string[] = [];
function fixture(template: string, produces: ArtifactContractInput['produces'] = []): StageArtifactContractInput {
  const root = mkdtempSync(join(tmpdir(), 'fc-artifact-independent-'));
  roots.push(root);
  const projectDir = join(root, 'project');
  const runDir = join(root, 'run');
  mkdirSync(projectDir);
  mkdirSync(runDir);
  return { stageId: 'independent_audit', template, projectDir, runDir,
    artifactContract: ArtifactContractSchema.parse({ version: 1, produces, reads: [], replays: [] }) };
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
  it('binds declared outputs beside inert CRLF continuations in all contract phases', () => {
    const input = fixture('Read inputs/reference.json. Produce "receipt.json" and "handoff.md" in\r\n "{run_dir}/stages/review.v2/".', [
      { id: 'receipt', root: 'run', path: 'stages/review.v2/receipt.json' },
      { id: 'handoff', root: 'run', path: 'stages/review.v2/handoff.md' },
    ]);
    const expected = ['receipt.json', 'handoff.md'].map(name => join(input.runDir, 'stages/review.v2', name));
    const preimages = captureStageArtifactContractPreimages(input);
    expect(preimages.map(p => p.path)).toEqual(expected);
    expect(obligations(input)).toEqual(expected);
    for (const file of expected) put(file);
    const deferred = captureDeferredStageArtifactContract({ ...input, preimages });
    expect(deferred.producedPromptArtifacts).toEqual([...expected].sort());
    const final = inspectStageArtifactContract({ ...input, priorProducedPromptArtifacts: deferred.producedPromptArtifacts });
    expect(final.obligations.map(o => o.path)).toEqual(expected);
    expect(final.violations.map(v => v.path)).toEqual(expected);
  });

  it('keeps equal basenames at distinct named destinations as two obligations', () => {
    const input = fixture('Write witness.json in the run directory. Then write witness.json in the project root.', [
      { id: 'run_witness', root: 'run', path: 'witness.json' },
      { id: 'project_witness', root: 'project', path: 'witness.json' },
    ]);
    const expected = [join(input.runDir, 'witness.json'), join(input.projectDir, 'witness.json')];
    const preimages = captureStageArtifactContractPreimages(input);
    expect(obligations(input)).toEqual(expected);
    put(expected[0]);
    expect(inspectStageArtifactContract({ ...input, preimages }).violations.map(o => o.path)).toEqual([expected[1]]);
  });

  it('refuses a nested run demand despite project and peer-run decoys plus another satisfied output', () => {
    const input = fixture('Write verdict.json under "{run_dir}/stages/qa/nested/". Write reports/completion.md.', [
      { id: 'verdict', root: 'run', path: 'stages/qa/nested/verdict.json' },
      { id: 'report', root: 'project', path: 'reports/completion.md' },
    ]);
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
      expect.objectContaining({ path: demanded, reason: expect.stringContaining('ARTIFACT_OUTPUT_ABSENT_OR_STALE') }),
    ]);
  });

  it('requires attributable production of a stale run file through deferred completion', () => {
    const input = fixture('Write evidence.json in the run directory.', [{ id: 'evidence', root: 'run', path: 'evidence.json' }]);
    const demanded = join(input.runDir, 'evidence.json');
    const decoy = join(input.projectDir, 'evidence.json');
    put(demanded, '{"old":true}\n');
    const preimages = captureStageArtifactContractPreimages(input);
    put(decoy);
    expect(inspectStageArtifactContract({ ...input, preimages, writes: [decoy] }).violations).toEqual([
      expect.objectContaining({ path: demanded, reason: expect.stringContaining('ARTIFACT_OUTPUT_ABSENT_OR_STALE') }),
    ]);
    put(demanded, '{"new":true}\n');
    const deferred = captureDeferredStageArtifactContract({ ...input, preimages });
    expect(deferred.producedPromptArtifacts).toEqual([demanded]);
    expect(inspectStageArtifactContract({ ...input, priorProducedPromptArtifacts: deferred.producedPromptArtifacts }).violations[0].reason).toContain('ARTIFACT_OUTPUT_ABSENT_OR_STALE');
  });



  it('refuses an explicitly declared destination outside the current root', () => {
    expect(() => fixture('Write outside.json under {run_dir}/../peer-run.', [
      { id: 'outside', root: 'run', path: '../peer-run/outside.json' },
    ])).toThrow(/exact, confined relative path/);
  });

  it('verifies a declared run markdown report through a real local node replay', async () => {
    const input = fixture('Write proof.md in the run directory.', [{ id: 'proof', root: 'run', path: 'proof.md' }]);
    const report = join(input.runDir, 'proof.md');
    const target = join(input.projectDir, 'spec/witness.test.mjs');
    const preimages = captureStageArtifactContractPreimages(input);
    put(target, "import test from 'node:test'; import assert from 'node:assert/strict'; test('independent witness', () => assert.equal(2 + 2, 4));\n");
    put(report, 'Replay command: node --test spec/witness.test.mjs\n');
    input.artifactContract = ArtifactContractSchema.parse({ ...input.artifactContract,
      reads: [{ id: 'witness', root: 'project', path: 'spec/witness.test.mjs', source: { kind: 'input' } }],
      replays: [{ id: 'proof_replay', runner: 'node_test', targets: ['witness'], argv: [], expected: { exit_code: 0, failures: [] } }],
    });
    const final = await verifyStageArtifactContract({ ...input, preimages }, { remainingMs: () => 10_000 });
    expect(final.obligations.map(o => o.path)).toEqual([report]);
    expect(final.replayExecutions).toEqual([
      expect.objectContaining({ status: 'passed', exitCode: 0, collectedTests: 1, executedTests: 1 }),
    ]);
    expect(final.violations).toEqual([]);
  });


});
