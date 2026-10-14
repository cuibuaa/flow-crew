import { fixtureResult } from './test-support/declared-dispatch.js';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ArtifactContractSchema, RecordedArtifactContractSchema, inspectArtifactDeclarations } from '../src/artifact-declarations.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { inspectDeclaredStageReads } from '../src/declared-artifact-audit.js';
import { inspectDispatchAdmission, inspectRealityCheckReachability, parseDispatchedStageConfig, normalizeStageContracts, runWorkflow, StageConfigSchema, WorkflowConfigSchema } from '../src/scheduler.js';
import { parseChecksFromMarkdown, runAllChecks } from '../src/reality-gate/index.js';
import { createRun, runDir } from '../src/store.js';
import { runStage } from '../src/worker.js';
import type { AgentConfig } from '../src/adapters/base.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-artifact-locations-')); roots.push(root);
  const project = join(root, 'project'), directory = join(root, 'run'); mkdirSync(project); mkdirSync(directory);
  return { root, project, directory };
}
describe('artifact locations and historical observations', () => {
  it('preserves concurrent ownership and unbound read protections', () => {
    const f = fixture();
    const c = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'data', root: 'project', path: 'data.json' }], reads: [], replays: [] });
    const writer = { id: 'writer', depends_on: [], artifact_contract: c };
    const runOutput = { ...c, produces: [{ ...c.produces[0], root: 'run' as const, path: 'shared.json' }] };
    expect(inspectArtifactDeclarations({ stages: [{ ...writer, artifact_contract: runOutput }, { ...writer, id: 'other', artifact_contract: runOutput }] }).join('\n')).toContain('ARTIFACT_OUTPUT_CONCURRENT_OWNERS');
    const read = { ...c, produces: [], reads: [{ id: 'unbound', root: 'project' as const, kind: 'file' as const, path: 'data.json', source: { kind: 'stage' as const, stage: 'missing', artifact: 'data' } }] };
    expect(inspectArtifactDeclarations({ stages: [{ id: 'reader', depends_on: [], artifact_contract: read }] }).join('\n')).toContain('ARTIFACT_READ');
  });
  it('normalizes omitted duties without waiving an unrelated dependency refusal', () => {
    const raw = { id: 'work', role: 'coder', depends_on: ['missing'], dependency_reasons: { missing: 'Consumes evidence' }, scope: [], prompt_template: 'Write prose.md' };
    const stage = parseDispatchedStageConfig(raw);
    expect(stage.artifact_contract).toMatchObject({produces:[],reads:[],replays:[]});
    const report = inspectDispatchAdmission({ dispatched: [stage], baseStages: [], dispatchStageId: 'plan' });
    expect(report.errors.some((error) => error.includes('ARTIFACT_DECLARATION_REQUIRED'))).toBe(false);
    expect(report.errors.some((error) => error.includes('unknown'))).toBe(true);
    expect(RecordedArtifactContractSchema.parse({ version: 1, produces: [], reads: [] }).replays).toBeUndefined();
    expect(ArtifactContractSchema.parse({ version: 1, produces: [], reads: [] }).replays).toBeUndefined();
  });
  it('launches omitted static contracts through the same ordinary and gate defaults as live stages', async () => {
    const f = fixture(); const invoked: string[] = [];
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
      { id: 'work', role: 'coder', max_retries: 0 },
      { id: 'review', role: 'qa', is_gate: true, scope: [], depends_on: ['work'] },
      { id: 'repair', role: 'coder', scope: [], depends_on: ['review'], retry_to: ['review'] },
    ] });
    const agent = (name: string): AgentConfig => ({ name, description: 'Fixture role', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Fixture.' });
    const agentsDir = join(f.project, 'config', 'agents'); mkdirSync(agentsDir, { recursive: true });
    for (const name of ['coder', 'qa']) writeFileSync(join(agentsDir, `${name}.yaml`), JSON.stringify(agent(name)));
    const state = await runWorkflow(workflow, '', f.project, { run: async (_prompt, _role, opts) => {
      invoked.push(opts.stageId);
      return fixtureResult({ output: opts.stageId === 'review' ? JSON.stringify({ pass: true, reason: 'Fixture passed', criteria: {}, audit_findings: { version: 1, findings: [] } }) : 'Fixture delivered', exitCode: 0, duration_ms: 1 }, opts);
    } }, new Map(['coder', 'qa'].map(name => [name, agent(name)])));
    expect(state.status, state.failureReason).toBe('complete');
    expect(invoked).toEqual(expect.arrayContaining(['work', 'review']));
    expect(workflow.stages[0].scope).toBeUndefined();
    expect(workflow.stages[0].max_retries).toBe(0);
    for (const stage of workflow.stages) {
      expect(stage.artifact_contract).toEqual(parseDispatchedStageConfig({ id: stage.id, role: stage.role, is_gate: stage.is_gate }).artifact_contract);
    }
  });
  it('infers retry gates before normalizing their omitted artifact authority', () => {
    const stages = [
      StageConfigSchema.parse({ id: 'review', role: 'qa' }),
      StageConfigSchema.parse({ id: 'repair', role: 'coder', retry_to: ['review'] }),
    ];
    normalizeStageContracts(stages);
    expect(stages[0].is_gate).toBe(true);
    expect(stages[0].artifact_contract?.produces).toContainEqual(expect.objectContaining({ root: 'run', path: 'verdict_review.json' }));
    expect(stages[1].artifact_contract?.produces).toEqual([]);
  });
  it.each([null, { version: 2, produces: [], reads: [] }])('refuses malformed explicit launch contracts before invoking the adapter (%j)', async artifact_contract => {
    const f = fixture(); let invoked = false;
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'work', role: 'coder' }] });
    Object.assign(workflow.stages[0], { artifact_contract });
    await expect(runWorkflow(workflow, '', f.project, { run: async (_record0, _record1, recordOpts: import("../src/adapters/base.js").RunOpts) => { invoked = true; return fixtureResult({ output: '', exitCode: 0, duration_ms: 1 }, recordOpts); } }, new Map())).rejects.toThrow();
    expect(invoked).toBe(false); expect(existsSync(join(f.project, '.fc'))).toBe(false);
  });
  it('retains engine-path and outward-link refusals for declared outputs', () => {
    const f = fixture(); const c = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'history', root: 'run', path: 'events.jsonl' }], reads: [], replays: [] });
    expect(inspectArtifactDeclarations({ stages: [{ id: 'work', depends_on: [], artifact_contract: c }], projectDir: f.project, runDir: f.directory }).join('\n')).toContain('ARTIFACT_FRAMEWORK_PATH');
    symlinkSync(f.root, join(f.project, 'outward'), 'dir'); c.produces[0] = { ...c.produces[0], root: 'project', path: 'outward/file.json' };
    expect(inspectArtifactDeclarations({ stages: [{ id: 'work', depends_on: [], artifact_contract: c }], projectDir: f.project, runDir: f.directory }).join('\n')).toContain('ARTIFACT_PATH_ESCAPE');
  });
  it('rejects undeclared reality reads and binds handlers to one declared root', async () => {
    const f = fixture(); const old = '## Reality checks\n```yaml\nchecks:\n - name: evidence\n   type: exec-script-exit-zero\n   params: {script: "cat absent.md"}\n```\n';
    expect(inspectRealityCheckReachability({ markdown: old, projectDir: f.project, runDir: f.directory, stages: [] }).join('\n')).toContain('REALITY_READ_DECLARATION_REQUIRED');
    const declared = old.replace('   params:', '   reads: []\n   params:');
    expect(inspectRealityCheckReachability({ markdown: declared, projectDir: f.project, runDir: f.directory, stages: [] })).toEqual([]);
    writeFileSync(join(f.project, 'same.json'), '{"value":"decoy"}'); writeFileSync(join(f.directory, 'same.json'), '{"value":"intended"}');
    const check = parseChecksFromMarkdown('## Reality checks\n```yaml\nchecks:\n - name: bound input\n   type: json-schema-match\n   reads: [{id: data, root: run, path: same.json, source: {kind: input}}]\n   params: {file: same.json, schema: {properties: {value: {enum: [intended]}}}}\n```\n');
    expect((await runAllChecks(check, { projectDir: f.project, taskDir: f.directory })).pass).toBe(true);
  });
});
