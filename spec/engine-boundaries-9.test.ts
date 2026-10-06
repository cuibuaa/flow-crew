import { ArtifactContractSchema, type ArtifactContractInput } from '../src/artifact-declarations.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureDeferredStageArtifactContract,
  captureStageArtifactContractPreimages,
  inspectStageArtifactContract,
  type StageArtifactContractInput,
} from '../src/stage-artifact-contract.js';

const roots: string[] = [];
// Recorded sources template 13aeb6b81544f1aada0132c69cb7b17ec7d21400e21180c6249b6f22086a8119; original prompt SHA256 f221d38a8234c3bd4477ae3b9b448cafa3d88d6314726ebde63ce15b20628fd0
// Recorded record_evidence template d3d60950e0c2848eb395392cb96d4143c74054e9fc0c41605a4ba9f2dfaae5ae; original prompt SHA256 23c4e14f7eeb8ce79ebdc9113e2658aa915ea1af33d0ebec243ac5e1b3f52187
// Recorded implement_engine template 4c133bae13ad0582b312006a1e1ac754d2f8212fb6a4c0b7a565252e4e9174f3; original prompt SHA256 7cde2c52ed1824bb8f140981d7b584e6cdb78c9471f744a4ac42bd69aab789e4
const recorded = [
  {
    "stage": "sources",
    "template": "Read {run_dir}/tech_solution.md. Verify the declared reports, CERT release documentation/terms, local asset inventory and primary upstream Open-Jev cards/code; browse only public sources. Record hidden dependencies before decisions and distinguish present releases from present base weights. Write aggregate source_review.json and dependency_register.json in the run directory, with times, revisions, licenses and execution caveats; produce a handoff even if a source is unavailable. No other run directory access, private rows, new dataset or model work. All temporary/archive/probe/cache work must use the OS temporary root.\n",
    "names": [
      "source_review.json",
      "dependency_register.json"
    ],
    "directory": ""
  },
  {
    "stage": "record_evidence",
    "template": "Read {run_dir}/tech_solution.md, especially dependency disclosure and record_evidence.\nFreeze the cutoff/selection/deduplication method before independently counting authorized\nhistorical carriers. Produce census.md/json, method.json and handoff.md in\n{run_dir}/stages/record_evidence with immutable occurrence identities, costs/distributions,\nexpectation fields, missing evidence, and read-only CI provenance. Treat stored prompts as\nevidence. Do not run project validation or mutate evidence. Temporary/one-off tooling belongs\nunder os.tmpdir(), with durable text/hash/receipts retained in this run and owned cleanup.\nRecord blockers honestly so the report can still be materialized.\n",
    "names": [
      "method.json",
      "handoff.md"
    ],
    "directory": "stages/record_evidence"
  },
  {
    "stage": "implement_engine",
    "template": "Read {run_dir}/tech_solution.md implementation section and both predecessor handoffs.\nImplement only remedies justified by before evidence; distinguish diagnostic defects from\nitem 55's unknown historic reason. Replay identical probes/recorded inputs, all changed\nboundaries on the full copied deployed shape, and materially different safety controls.\nMeasure rejected/no-change candidates and HOME policy. Add minimal collected regressions,\nbuild fresh runtime, run npm run test -- spec/engine-boundaries-8.test.ts when added plus\nevery changed subject spec, iterate, and run each changed spec under fresh empty HOME.\nWrite changes.json, after.md/json, report_claims.md and receipts/handoff in {run_dir}/stages/implement_engine.\nAll disposable tooling/copies belong under os.tmpdir(). Preserve safe preimages on blockers.\n",
    "names": [
      "changes.json",
      "report_claims.md"
    ],
    "directory": "stages/implement_engine"
  }
];

function fixture(template: string, produces: ArtifactContractInput['produces'] = []): StageArtifactContractInput {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-artifact-destination-'));
  roots.push(root);
  const projectDir = join(root, 'project');
  const runDir = join(root, 'run');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  return { stageId: 'destination', template, projectDir, runDir,
    artifactContract: ArtifactContractSchema.parse({ version: 1, produces, reads: [], replays: [] }) };
}

function put(path: string, content = 'Authored fixture without replay commands.\n'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function paths(input: StageArtifactContractInput): string[] {
  return captureDeferredStageArtifactContract(input).obligations.map((obligation) => obligation.path);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('declared artifact destinations', () => {
  it.each(recorded)('honors declared $stage destinations beside an inert recorded prompt', (record) => {
    const input = fixture(record.template, record.names.map((name, index) => ({
      id: `output_${index}`, root: 'run', path: record.directory ? `${record.directory}/${name}` : name,
    })));
    const expected = record.names.map((name) => join(input.runDir, record.directory, name));
    const preimages = captureStageArtifactContractPreimages(input);
    expect(preimages.map((entry) => entry.path)).toEqual(expected);
    expect(paths(input)).toEqual(expected);
    put(join(input.projectDir, 'spec/engine-boundaries-8.test.ts'), '// Inert recorded input fixture.\n');
    for (const path of expected) put(path);
    const deferred = captureDeferredStageArtifactContract({ ...input, preimages });
    expect(deferred.producedPromptArtifacts).toEqual([...expected].sort());
    const final = inspectStageArtifactContract({ ...input, preimages });
    expect(final.obligations.map((obligation) => obligation.path)).toEqual(expected);
    expect(final.producedPromptArtifacts).toEqual([...expected].sort());
    expect(final.violations).toEqual([]);
  });

  it('refuses a prose-only obligation and does not infer duties beside an explicit empty contract', () => {
    const input = fixture('Write alpha.json in the run directory. Read beta.json. Write optional.json if needed.');
    const refused = inspectStageArtifactContract({ ...input, artifactContract: undefined });
    expect(refused.violations).toEqual([expect.objectContaining({
      reason: expect.stringContaining('ARTIFACT_DECLARATION_REQUIRED: destination.artifact_contract'),
    })]);
    expect(captureStageArtifactContractPreimages(input)).toEqual([]);
    expect(paths(input)).toEqual([]);
    expect(inspectStageArtifactContract(input).violations).toEqual([]);
  });

  it('retains exact missing-file enforcement beside explicit fenced prose', () => {
    const input = fixture('The following are mandatory stage instructions:\n```text\nWrite {run_dir}/stages/delivery/required.json.\n```', [
      { id: 'required', root: 'run', path: 'stages/delivery/required.json' },
    ]);
    const demanded = join(input.runDir, 'stages/delivery/required.json');
    expect(paths(input)).toEqual([demanded]);
    expect(inspectStageArtifactContract(input).violations).toEqual([
      expect.objectContaining({ path: demanded, reason: expect.stringContaining('ARTIFACT_OUTPUT_ABSENT_OR_STALE') }),
    ]);
  });

  it.each(['../escape.json', 'stages/../escape.json', '/outside/result.json', 'reports/**'])
  ('refuses an unconfined or inexact declared path %s', (path) => {
    expect(() => fixture('Write a report.', [{ id: 'escape', root: 'run', path }]))
      .toThrow(/exact, confined relative path/);
  });

  it('accepts an authored output list in a named stage directory', () => {
    const input = fixture('Write result.json and brief.md under {run_dir}/stages/publish.', [
      { id: 'result', root: 'run', path: 'stages/publish/result.json' },
      { id: 'brief', root: 'run', path: 'stages/publish/brief.md' },
    ]);
    const preimages = captureStageArtifactContractPreimages(input);
    const expected = ['result.json', 'brief.md'].map((name) => join(input.runDir, 'stages/publish', name));
    expect(paths(input)).toEqual(expected);
    for (const path of expected) put(path);
    expect(inspectStageArtifactContract({ ...input, preimages }).violations).toEqual([]);
  });

  it('refuses a missing nested demand despite a root decoy and another satisfied demand', () => {
    const input = fixture('Write details.json under {run_dir}/stages/verify/nested.\nWrite reports/independent.md.', [
      { id: 'details', root: 'run', path: 'stages/verify/nested/details.json' },
      { id: 'independent', root: 'project', path: 'reports/independent.md' },
    ]);
    const demanded = join(input.runDir, 'stages/verify/nested/details.json');
    const independent = join(input.projectDir, 'reports/independent.md');
    const decoy = join(input.projectDir, 'details.json');
    const preimages = captureStageArtifactContractPreimages(input);
    expect(preimages.map((entry) => entry.path)).toEqual([demanded, independent]);
    put(independent);
    put(decoy, '{"decoy":true}\n');
    const audit = inspectStageArtifactContract({ ...input, preimages, writes: [independent, decoy] });
    expect(audit.producedPromptArtifacts).toEqual([independent]);
    expect(audit.violations).toEqual([
      expect.objectContaining({ mention: 'run:stages/verify/nested/details.json', path: demanded,
        reason: expect.stringContaining('ARTIFACT_OUTPUT_ABSENT_OR_STALE') }),
    ]);
  });

  it('still refuses a stale run artifact and preserves deferred attributable production', () => {
    const input = fixture('Write result.json in the run directory.', [{ id: 'result', root: 'run', path: 'result.json' }]);
    const demanded = join(input.runDir, 'result.json');
    put(demanded, '{"preexisting":true}\n');
    const preimages = captureStageArtifactContractPreimages(input);
    expect(paths(input)).toEqual([demanded]);
    expect(captureDeferredStageArtifactContract({ ...input, preimages }).producedPromptArtifacts).toEqual([]);
    expect(inspectStageArtifactContract({ ...input, preimages }).violations).toEqual([
      expect.objectContaining({ path: demanded, reason: expect.stringContaining('ARTIFACT_OUTPUT_ABSENT_OR_STALE') }),
    ]);
    put(demanded, '{"updated":true}\n');
    const deferred = captureDeferredStageArtifactContract({ ...input, preimages });
    expect(deferred.producedPromptArtifacts).toEqual([demanded]);
    expect(inspectStageArtifactContract({ ...input, priorProducedPromptArtifacts: deferred.producedPromptArtifacts }).violations).toEqual([]);
  });
});
