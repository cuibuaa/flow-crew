import './test-support/policy-runtime.js';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseAgent } from '../src/scheduler/sched_admission/configuration.js';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';

import { applyBasePrompt, inspectDispatchAdmission, loadBasePrompt, loadWorkflow, parseBriefFrontmatter, parseDispatchedStageConfig } from '../src/scheduler.js';
import { buildStagePrompt } from '../src/handoff.js';
import { parseChecksFromMarkdown, runAllChecks } from '../src/reality-gate/index.js';

const projectRoot = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(projectRoot, path), 'utf8');
const yamlBlocks = (text: string): string[] => [...text.matchAll(/```yaml\s*\n([\s\S]*?)```/g)].map((match) => match[1]);


function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-published-spec-'));
  const project = join(root, 'project'), run = join(root, 'run');
  mkdirSync(project); mkdirSync(join(run, 'stages', 'audit'), { recursive: true });
  return { root, project, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('published declaration inputs', () => {
  it.each(['planner', 'research'])('loads the built-in %s workflow with a complete contract', (name) => {
    const { config } = loadWorkflow(join(projectRoot, 'config', 'workflows', `${name}.yaml`));
    for (const stage of config.stages) expect(ArtifactContractSchema.parse(stage.artifact_contract)).toEqual({
      version: 1, produces: [{ id: 'dispatch', root: 'run', path: 'dispatch.yaml', kind: 'file', nonempty: true }], reads: [], groups: [],
    });
  });

  it('loads every role through the shared base prompt after consolidating its safety boundary', () => {
    const directory = join(projectRoot, 'config', 'agents');
    const base = loadBasePrompt(directory);
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.yaml'))) {
      const role = parseAgent(parse(readFileSync(join(directory, file), 'utf8')));
      expect(typeof role.prompt, file).toBe('string');
      const loaded = applyBasePrompt(role, base).prompt;
      expect(loaded, file).toBe(`${base}\n\n${role.prompt}`);
      expect(loaded.split('read authorization never grants mutation authority'), file).toHaveLength(2);
      expect(loaded.split('never invent a threshold or waive a supplied one'), file).toHaveLength(2);
    }
  });

  it('retains safety and acceptance authority for raw and base-absent role loading', () => {
    const owned = fixture();
    try {
      const base = loadBasePrompt(owned.project);
      expect(base).toBe('');
      for (const file of readdirSync(join(projectRoot, 'config/agents')).filter((name) => name.endsWith('.yaml'))) {
        const raw = parse(read(`config/agents/${file}`));
        const role = parseAgent(raw);
        for (const loaded of [role, applyBasePrompt(raw, base), applyBasePrompt(role, base)]) {
          expect(loaded.prompt, file).toContain('Never write, move, delete, or otherwise modify any run directory other than');
          expect(loaded.prompt, file).toContain('Explicit brief authorization allows a bounded set as read-only evidence');
          expect(loaded.prompt, file).toContain('Pass only when all meet their acceptance lines');
          expect(loaded.prompt, file).toContain('never invent a threshold or waive a supplied one');
          expect(loaded.prompt, file).toContain('Examples do not exclude equivalent property evidence');
        }
      }
    } finally { owned.cleanup(); }
  });

  it('leaves configured validation comparison to the engine', () => {
    const owned = fixture();
    try {
      writeFileSync(join(owned.run, 'validation_baseline.json'), JSON.stringify({ baseline: { gateCriteria: [] } }));
      const base = loadBasePrompt(join(projectRoot, 'config/agents'));
      for (const isGate of [false, true]) {
        const prompt = base + buildStagePrompt({ stageId: 'audit', isGate, dependsOn: [],
          promptTemplate: 'Perform the assigned stage.', projectDir: owned.project, runDir: owned.run });
        expect(prompt).not.toContain('Read validation_delta_');
        expect(prompt).not.toContain('regressed or unresolved delta');
      }
    } finally { owned.cleanup(); }
  });

  it('admits the published mock dispatch and normalizes omitted optional duties', () => {
    const fixture = JSON.parse(read('examples/mock-fixtures/plan.json'));
    const raw = parse(fixture.write_files['dispatch.yaml']);
    const stages = raw.map(parseDispatchedStageConfig);
    expect(inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: 'plan' }).pass).toBe(true);
    const { artifact_contract: removed, ...legacy } = raw[0];
    expect(removed).toBeDefined();
    expect(parseDispatchedStageConfig(legacy).artifact_contract).toMatchObject({produces:[],reads:[]});
  });

  it('parses the full brief through the brief loader and every published stage/check fragment through its native parser', () => {
    for (const path of ['guide/brief-contract.md', 'guide/agent-protocol.md', 'guide/configuration.md']) {
      const blocks = yamlBlocks(read(path));
      expect(blocks.length, path).toBeGreaterThan(0);
      for (const block of blocks) {
        if (/^---\s*\n/.test(block)) {
          const parsed = parseBriefFrontmatter(block);
          expect(parsed.workflow).toBe('direct');
          expect(parsed.research).toBeUndefined();
          expect(parsed.frontmatterError).toBeUndefined();
          expect(parsed.workflowError).toBeUndefined();
          expect(parsed.researchPolicyError).toBeUndefined();
          continue;
        }
        const value = parse(block);
        if (value?.artifact_contract) ArtifactContractSchema.parse(value.artifact_contract);
        else if (Array.isArray(value) && value.some((item) => item?.id && item?.role)) value.forEach(parseDispatchedStageConfig);
        else if (value?.name && value?.prompt) parseAgent(value);
        else if (value?.checks) {
          const checks = parseChecksFromMarkdown(`## Reality checks\n\x60\x60\x60yaml\n${block}\x60\x60\x60\n`);
          expect(checks.length).toBeGreaterThan(0);
          expect(checks.filter((check) => check.kind === 'invalid')).toEqual([]);
        }
      }
    }
  });

  it('runs the published reality checks on their declared inputs and refuses a mismatched result', async () => {
    const owned = fixture();
    try {
      const block = yamlBlocks(read('guide/brief-contract.md')).filter((text) => !/^---\s*\n/.test(text)).find((text) => parse(text)?.checks);
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
      // JSON's exponent grammar can parse to Infinity: the example's finite-number
      // script must reject it even though its JSON-schema number type accepts it.
      writeFileSync(result, '{"metric":"quality","value":1e999,"evidence":"overflow fixture"}');
      const overflow = await runAllChecks(checks, { projectDir: owned.project, taskDir: owned.run });
      expect(overflow.pass).toBe(false);
      expect(overflow.results.find((check) => check.name === 'result-shape')).toMatchObject({ pass: true });
      expect(overflow.results.find((check) => check.name === 'result-value')).toMatchObject({ pass: false });
    } finally { owned.cleanup(); }
  });
});
