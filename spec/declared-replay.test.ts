import { fixtureResult } from './test-support/declared-dispatch.js';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ArtifactContractSchema, RecordedArtifactContractSchema, inspectArtifactDeclarations } from '../src/artifact-declarations.js';
import { inspectStageArtifactContract } from '../src/stage-artifact-contract.js';
import { readRecordedArtifactContract } from '../src/recorded-artifact-contract.js';
import { inspectDeclaredStageReads } from '../src/declared-artifact-audit.js';
import { inspectDispatchAdmission, inspectRealityCheckReachability, parseDispatchedStageConfig, runWorkflow, StageConfigSchema, WorkflowConfigSchema } from '../src/scheduler.js';
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
  it('does not waive output scope, concurrent ownership or unbound read protections', () => {
    const f = fixture();
    const c = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'data', root: 'project', path: 'data.json' }], reads: [], replays: [] });
    const writer = { id: 'writer', depends_on: [], artifact_contract: c };
    expect(inspectArtifactDeclarations({ stages: [writer], scopeOwns: () => false }).join('\n')).toContain('ARTIFACT_OUTPUT_OUTSIDE_SCOPE');
    const runOutput = { ...c, produces: [{ ...c.produces[0], root: 'run' as const, path: 'shared.json' }] };
    expect(inspectArtifactDeclarations({ stages: [{ ...writer, artifact_contract: runOutput }, { ...writer, id: 'other', artifact_contract: runOutput }], scopeOwns: () => true }).join('\n')).toContain('ARTIFACT_OUTPUT_CONCURRENT_OWNERS');
    const read = { ...c, produces: [], reads: [{ id: 'unbound', root: 'project' as const, kind: 'file' as const, path: 'data.json', source: { kind: 'stage' as const, stage: 'missing', artifact: 'data' } }] };
    expect(inspectArtifactDeclarations({ stages: [{ id: 'reader', depends_on: [], artifact_contract: read }], scopeOwns: () => true }).join('\n')).toContain('ARTIFACT_READ');
  });
  it('preserves early recorded audits that predate the replay-results field', () => {
    const f = fixture();
    const path = join(f.directory, 'artifact_contract.json');
    const record = { version: 1, stageId: 'old', checkedAt: '2026-09-20T21:12:50Z', obligations: [], producedPromptArtifacts: [], violations: [], extension: { preserved: true } };
    writeFileSync(path, JSON.stringify(record));
    expect(readRecordedArtifactContract(path)).toEqual({ status: 'readable', legacy: true, record });
    expect('replayExecutions' in record).toBe(false);
    writeFileSync(path, JSON.stringify({ ...record, replayExecutions: 'malformed' }));
    expect(readRecordedArtifactContract(path).status).toBe('unreadable');
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
  it('refuses legacy launch/resume before invoking the adapter or creating a run', async () => {
    const f = fixture(); let invoked = false;
    const workflow = WorkflowConfigSchema.parse({ name: 'old', stages: [{ id: 'old', role: 'coder' }] });
    await expect(runWorkflow(workflow, 'name: old\n', f.project, { run: async (_record0, _record1, recordOpts: import("../src/adapters/base.js").RunOpts) => { invoked = true; return fixtureResult({ output: '', exitCode: 0, duration_ms: 1 }, recordOpts); } }, new Map())).rejects.toThrow('DECLARED_INPUT_MIGRATION_REQUIRED');
    expect(invoked).toBe(false); expect(existsSync(join(f.project, '.fc'))).toBe(false);
  });
  it('retains engine-path and outward-link refusals for declared outputs', () => {
    const f = fixture(); const c = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'history', root: 'run', path: 'events.jsonl' }], reads: [], replays: [] });
    expect(inspectArtifactDeclarations({ stages: [{ id: 'work', depends_on: [], artifact_contract: c }], scopeOwns: () => true, projectDir: f.project, runDir: f.directory }).join('\n')).toContain('ARTIFACT_FRAMEWORK_PATH');
    symlinkSync(f.root, join(f.project, 'outward'), 'dir'); c.produces[0] = { ...c.produces[0], root: 'project', path: 'outward/file.json' };
    expect(inspectArtifactDeclarations({ stages: [{ id: 'work', depends_on: [], artifact_contract: c }], scopeOwns: () => true, projectDir: f.project, runDir: f.directory }).join('\n')).toContain('ARTIFACT_PATH_ESCAPE');
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
