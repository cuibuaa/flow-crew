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

function fixture(template: string): StageArtifactContractInput {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-artifact-destination-'));
  roots.push(root);
  const projectDir = join(root, 'project');
  const runDir = join(root, 'run');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  return { stageId: 'destination', template, projectDir, runDir };
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

describe('prompt artifact destinations', () => {
  it.each(recorded)('honors the recorded $stage destination through every contract phase', (record) => {
    const input = fixture(record.template);
    const expected = record.names.map((name) => join(input.runDir, record.directory, name));
    const preimages = captureStageArtifactContractPreimages(input);
    expect(preimages.map((entry) => entry.path)).toEqual(expected);
    expect(paths(input)).toEqual(expected);
    // The implementation prompt cites a pre-existing test input; it is not an output.
    put(join(input.projectDir, 'spec/engine-boundaries-8.test.ts'), '// Inert replay input fixture.\n');
    for (const path of expected) put(path);
    const deferred = captureDeferredStageArtifactContract({ ...input, preimages });
    expect(deferred.producedPromptArtifacts).toEqual([...expected].sort());
    const final = inspectStageArtifactContract({ ...input, preimages });
    expect(final.obligations.filter((obligation) => obligation.kind === 'prompt_artifact')
      .map((obligation) => obligation.path)).toEqual(expected);
    expect(final.producedPromptArtifacts).toEqual([...expected].sort());
    expect(final.violations).toEqual([]);
  });

  it.each([
    ['Write alpha.json in the run directory. Write beta.json.', ['run/alpha.json', 'project/beta.json']],
    ['Write in this run directory alpha.json and beta.json.', ['run/alpha.json', 'run/beta.json']],
    ["Write same.json in the project root and this run's same.json.", ['project/same.json', 'run/same.json']],
    ['Write this run’s alpha.json and beta.json.', ['run/alpha.json', 'project/beta.json']],
    ['Write {project}/reports/alpha.json and beta.json under {run_dir}/stages/publish.',
      ['project/reports/alpha.json', 'run/stages/publish/beta.json']],
    ['Write alpha.json and\n beta.json in\n {run_dir}/stages/publish.',
      ['run/stages/publish/alpha.json', 'run/stages/publish/beta.json']],
    ['Write alpha.json\nin the run directory.\n\nWrite beta.json.', ['run/alpha.json', 'project/beta.json']],
    ['Write alpha.json\n- Read beta.json in the run directory.', ['project/alpha.json']],
    ['Write alpha.json\nRead beta.json in the run directory.', ['project/alpha.json']],
    ['Write alpha.json.\n\nIn the run directory, read beta.json.', ['project/alpha.json']],
    ['Write alpha.json in the project root.\nWrite beta.json in the run directory.',
      ['project/alpha.json', 'run/beta.json']],
    ['Write alpha.v1.json under "{run_dir}/stages/publish.v1".', ['run/stages/publish.v1/alpha.v1.json']],
    ['Write reports/using.md and ./alpha.json in the run directory.', ['project/reports/using.md', 'project/alpha.json']],
    ['Write alpha.json under evidence/publish/.', ['project/evidence/publish/alpha.json']],
    ['Write scripts under training/scripts/, invoke them, import corrected_gates.py.', ['project/corrected_gates.py']],
    ['Save new results under training/results/ before editing master_task_summary.md.', ['project/master_task_summary.md']],
    ['Write alpha.json in the run directory with direct citations and update its graph.json.',
      ['run/alpha.json', 'project/graph.json']],
    ['Write reports under training/reports/ with alpha.json, then update graph.json.',
      ['project/training/reports/alpha.json', 'project/graph.json']],
    // Recorded run_cascade template 2c01874b: an explicitly quoted prefix list.
    ['Write the required round JSON files under `docs/guardrail_indomain_safe_research/`, including `round_result.json` and a detailed harness artifact referenced when possible.',
      ['project/docs/guardrail_indomain_safe_research/round_result.json']],
  ])('binds a destination only within its own directive: %s', (template, expected) => {
    const input = fixture(template as string);
    const root = dirname(input.projectDir);
    const exact = (expected as string[]).map((path) => join(root, path));
    expect(captureStageArtifactContractPreimages(input).map((entry) => entry.path)).toEqual(exact);
    expect(paths(input)).toEqual(exact);
    expect(inspectStageArtifactContract(input).violations.map((obligation) => obligation.path)).toEqual(exact);
  });

  it('keeps comparison inputs separate while enforcing later output demands', () => {
    const input = fixture('Write alpha.json in the run directory after comparing inputs/base.json and write beta.json. Then create gamma.json under {run_dir}/stages/publish using inputs/reference.json.');
    expect(paths(input)).toEqual([
      join(input.runDir, 'alpha.json'), join(input.projectDir, 'beta.json'),
      join(input.runDir, 'stages/publish/gamma.json'),
    ]);
  });

  it('does not borrow a destination across a fence or from optional text', () => {
    const input = fixture('Write alpha.json\n```text\nin the run directory, read example.json.\n```\nWrite optional.json if needed.\nWrite beta.json.');
    expect(paths(input)).toEqual([join(input.projectDir, 'alpha.json'), join(input.projectDir, 'beta.json')]);
  });

  it('retains exact missing-file enforcement for explicit fenced instructions', () => {
    const input = fixture('The following are mandatory stage instructions:\n```text\nWrite {run_dir}/stages/delivery/required.json.\n```');
    const demanded = join(input.runDir, 'stages/delivery/required.json');
    expect(paths(input)).toEqual([demanded]);
    expect(inspectStageArtifactContract(input).violations).toEqual([
      expect.objectContaining({ path: demanded, reason: expect.stringContaining('no readable file exists') }),
    ]);
  });

  it.each([
    'Write result.json under {run_dir}/../another-run.',
    'Write result.json under {project}/../outside.',
    'Write ../escape.json in the run directory.',
    'Write {run_dir}/../another-run/result.json.',
    "Write this run's ../project/escape.json.",
    "Write this run's {project}/escape.json.",
  ])('retains project/current-run containment for %s', (template) => {
    const input = fixture(template);
    expect(paths(input)).toEqual([]);
    expect(captureStageArtifactContractPreimages(input)).toEqual([]);
  });

  it('accepts an authored output list in a named stage directory', () => {
    const input = fixture('Write result.json and brief.md under {run_dir}/stages/publish.');
    const preimages = captureStageArtifactContractPreimages(input);
    const expected = ['result.json', 'brief.md'].map((name) => join(input.runDir, 'stages/publish', name));
    expect(paths(input)).toEqual(expected);
    for (const path of expected) put(path);
    expect(inspectStageArtifactContract({ ...input, preimages }).violations).toEqual([]);
  });

  it('refuses a missing nested demand despite a root decoy and another satisfied demand', () => {
    const input = fixture('Write details.json under {run_dir}/stages/verify/nested.\nWrite reports/independent.md.');
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
      expect.objectContaining({ mention: 'details.json', path: demanded, reason: expect.stringContaining('no readable file exists') }),
    ]);
  });

  it('still refuses a stale run artifact and preserves deferred attributable production', () => {
    const input = fixture('Write result.json in the run directory.');
    const demanded = join(input.runDir, 'result.json');
    put(demanded, '{"preexisting":true}\n');
    const preimages = captureStageArtifactContractPreimages(input);
    expect(paths(input)).toEqual([demanded]);
    expect(captureDeferredStageArtifactContract({ ...input, preimages }).producedPromptArtifacts).toEqual([]);
    expect(inspectStageArtifactContract({ ...input, preimages }).violations).toEqual([
      expect.objectContaining({ path: demanded, reason: expect.stringContaining('predated the stage') }),
    ]);
    put(demanded, '{"updated":true}\n');
    const deferred = captureDeferredStageArtifactContract({ ...input, preimages });
    expect(deferred.producedPromptArtifacts).toEqual([demanded]);
    const final = inspectStageArtifactContract({ ...input, priorProducedPromptArtifacts: deferred.producedPromptArtifacts });
    expect(final.violations).toEqual([]);
  });
});
