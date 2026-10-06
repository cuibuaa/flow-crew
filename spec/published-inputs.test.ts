import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ArtifactContractSchema, type ArtifactContract } from '../src/artifact-declarations.js';
import { captureStageArtifactContractPreimages, verifyStageArtifactContract } from '../src/stage-artifact-contract.js';
import { applyBasePrompt, inspectDispatchAdmission, loadBasePrompt, loadWorkflow, parseBriefFrontmatter, parseDispatchedStageConfig } from '../src/scheduler.js';
import { parseChecksFromMarkdown, runAllChecks } from '../src/reality-gate/index.js';

const projectRoot = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(projectRoot, path), 'utf8');
const yamlBlocks = (text: string): string[] => [...text.matchAll(/```yaml\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
const guideContracts = (): ArtifactContract[] => yamlBlocks(read('guide/engine-state-and-revisions.md'))
  .map((text) => parse(text) as { artifact_contract?: unknown })
  .filter((value) => value.artifact_contract)
  .map((value) => ArtifactContractSchema.parse(value.artifact_contract));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-published-spec-'));
  const project = join(root, 'project'), run = join(root, 'run');
  mkdirSync(project); mkdirSync(join(run, 'stages', 'audit'), { recursive: true });
  return { root, project, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('published declaration inputs', () => {
  it.each(['default', 'research'])('loads the built-in %s workflow with a complete contract', (name) => {
    const { config } = loadWorkflow(join(projectRoot, 'config', 'workflows', `${name}.yaml`));
    for (const stage of config.stages) expect(ArtifactContractSchema.parse(stage.artifact_contract).replays).toEqual([]);
  });

  it('loads every role through the shared base prompt after consolidating its safety boundary', () => {
    const directory = join(projectRoot, 'config', 'agents');
    const base = loadBasePrompt(directory);
    expect(base).toContain('read authorization never grants mutation authority');
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.yaml'))) {
      const role = parse(readFileSync(join(directory, file), 'utf8'));
      expect(typeof role.prompt, file).toBe('string');
      expect(applyBasePrompt(role, base).prompt, file).toBe(`${base}\n\n${role.prompt}`);
    }
  });

  it('retains the affected roles\' run-record boundary when an optional base prompt is absent', () => {
    const owned = fixture();
    try {
      const base = loadBasePrompt(owned.project);
      expect(base).toBe('');
      for (const name of ['coder', 'researcher', 'doc_reviewer']) {
        const role = parse(read(`config/agents/${name}.yaml`));
        const loaded = applyBasePrompt(role, base);
        expect(loaded.prompt).toBe(role.prompt);
        expect(loaded.prompt, name).toContain('Never modify other run directories');
        expect(loaded.prompt, name).toContain('only when this task explicitly authorizes');
      }
    } finally { owned.cleanup(); }
  });

  it('admits the published mock dispatch and rejects the same fixture without its declaration', () => {
    const fixture = JSON.parse(read('examples/mock-fixtures/plan.json'));
    const raw = parse(fixture.write_files['dispatch.yaml']);
    const stages = raw.map(parseDispatchedStageConfig);
    expect(inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: 'plan' }).pass).toBe(true);
    const { artifact_contract: removed, ...legacy } = raw[0];
    expect(removed).toBeDefined();
    expect(() => parseDispatchedStageConfig(legacy)).toThrow('ARTIFACT_DECLARATION_REQUIRED');
  });

  it('admits all planner reference sketches with bound outputs, reads and replays', () => {
    const prompt = parse(read('config/agents/planner.yaml')).prompt as string;
    const section = prompt.split('# Reference Examples')[1].split('# Runtime Context Handlers')[0];
    const examples = [...section.matchAll(/Example ([A-Z])[^\n]*:\n([\s\S]*?)(?=\nExample [A-Z]|$)/g)];
    expect(examples.length).toBeGreaterThan(0);
    for (const [, name, body] of examples) {
      const raw = parse(body.slice(body.search(/^- id:/m)));
      const stages = raw.map(parseDispatchedStageConfig);
      const admission = inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: 'plan' });
      expect(admission.errors, `example ${name}`).toEqual([]);
    }
  });

  it('parses the full brief through the brief loader and every published stage/check fragment through its native parser', () => {
    for (const path of ['guide/brief-contract.md', 'guide/engine-state-and-revisions.md', 'guide/reality-gate.md']) {
      for (const block of yamlBlocks(read(path))) {
        if (/^---\s*\n/.test(block)) {
          expect(parseBriefFrontmatter(block).research).toBeDefined();
          continue;
        }
        const value = parse(block);
        if (value?.artifact_contract) ArtifactContractSchema.parse(value.artifact_contract);
        else if (Array.isArray(value) && value.some((item) => item?.id && item?.role)) value.forEach(parseDispatchedStageConfig);
        else if (value?.checks) {
          const checks = parseChecksFromMarkdown(`## Reality checks\n\x60\x60\x60yaml\n${block}\x60\x60\x60\n`);
          expect(checks.length).toBeGreaterThan(0);
          expect(checks.filter((check) => check.kind === 'invalid')).toEqual([]);
        }
      }
    }
  });

  it.each([0, 1])('executes the published Node replay example with expected direct exit %i', async (exitCode) => {
    const contract = guideContracts().find((entry) => entry.replays?.some((replay) => replay.runner === 'node_test' && replay.expected.exit_code === exitCode));
    expect(contract, 'guide must retain a runnable declaration for this outcome').toBeDefined();
    const owned = fixture();
    try {
      const input = { stageId: 'audit', template: 'Report commands have no executable authority.', projectDir: owned.project, runDir: owned.run, artifactContract: contract! };
      const preimages = captureStageArtifactContractPreimages(input);
      for (const output of contract!.produces) {
        const path = join(output.root === 'project' ? owned.project : owned.run, output.path);
        mkdirSync(dirname(path), { recursive: true });
        const title = exitCode ? contract!.replays![0].expected.failures[0].test : 'declared regression';
        writeFileSync(path, `import test from 'node:test'; import assert from 'node:assert/strict';\ntest(${JSON.stringify(title)}, () => assert.equal(1, ${exitCode ? 2 : 1}));\n`);
      }
      const started = performance.now();
      const audit = await verifyStageArtifactContract({ ...input, preimages }, { remainingMs: () => Math.max(0, 15_000 - (performance.now() - started)) });
      expect(audit.violations).toEqual([]);
      expect(audit.replayExecutions).toHaveLength(1);
      expect(audit.replayExecutions[0]).toMatchObject({ status: 'passed', exitCode, timedOut: false, collectedTests: 1, executedTests: 1, failedTests: exitCode, passedTests: 1 - exitCode });
      const { replays: omitted, ...oldContract } = contract!;
      expect(omitted).toHaveLength(1);
      expect(() => ArtifactContractSchema.parse(oldContract)).toThrow('REPLAY_DECLARATION_REQUIRED');
    } finally { owned.cleanup(); }
  });

  it('runs the published reality checks on their declared inputs and refuses a mismatched result', async () => {
    const owned = fixture();
    try {
      const block = yamlBlocks(read('guide/reality-gate.md')).find((text) => parse(text)?.checks);
      expect(block).toBeDefined();
      const checks = parseChecksFromMarkdown(`## Reality checks\n\x60\x60\x60yaml\n${block}\x60\x60\x60\n`);
      mkdirSync(join(owned.project, 'docs')); writeFileSync(join(owned.project, 'docs/output.md'), 'Measured output\n');
      const result = join(owned.project, 'result.json');
      writeFileSync(result, JSON.stringify({ metric: 'quality', value: 42, evidence: 'measured fixture' }));
      expect((await runAllChecks(checks, { projectDir: owned.project, taskDir: owned.run })).pass).toBe(true);
      writeFileSync(result, JSON.stringify({ metric: 'quality', value: null, evidence: 'invalid value' }));
      const refused = await runAllChecks(checks, { projectDir: owned.project, taskDir: owned.run });
      expect(refused.pass).toBe(false);
      expect(refused.results.find((check) => check.name === 'result-value')).toMatchObject({ pass: false });
    } finally { owned.cleanup(); }
  });
});
