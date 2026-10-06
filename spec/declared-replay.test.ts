import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactContractSchema, RecordedArtifactContractSchema, inspectArtifactDeclarations } from '../src/artifact-declarations.js';
import { captureStageArtifactContractPreimages, inspectStageArtifactContract, verifyStageArtifactContract } from '../src/stage-artifact-contract.js';
import { readRecordedArtifactContract } from '../src/recorded-artifact-contract.js';
import { inspectDeclaredStageReads } from '../src/declared-artifact-audit.js';
import { inspectDispatchAdmission, inspectRealityCheckReachability, parseDispatchedStageConfig, runWorkflow, StageConfigSchema, WorkflowConfigSchema } from '../src/scheduler.js';
import { parseChecksFromMarkdown, runAllChecks } from '../src/reality-gate/index.js';
import { createRun, runDir } from '../src/store.js';
import { runStage } from '../src/worker.js';
import type { AgentConfig } from '../src/adapters/base.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const role: AgentConfig = { name: 'fixture', description: '', model: 'default', reasoning_effort: 'default', tools: [], prompt: '' };
function fixture(vitest = false) {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-declared-replay-spec-')); roots.push(root);
  const project = join(root, 'project'), directory = join(root, 'run'); mkdirSync(project); mkdirSync(directory);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'vitest run' } }));
  if (vitest) cpSync(resolve('node_modules'), join(project, 'node_modules'), { recursive: true });
  writeFileSync(join(project, 'vitest.config.mjs'), `export default {cacheDir:${JSON.stringify(join(project, '.cache/vitest'))},test:{include:['*.test.ts'],pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:30000}};`);
  return { root, project, directory };
}
function contract(files: string[], runner: 'node_test' | 'vitest' | 'pytest' = 'node_test', failures: Array<{ artifact: string; test: string }> = [], argv: string[] = []) {
  return ArtifactContractSchema.parse({ version: 1, produces: [], reads: files.map((path, i) => ({ id: `file_${i}`, root: 'project', path, source: { kind: 'input' } })), groups: [], replays: [{ id: 'evidence', runner, targets: files.map((_, i) => `file_${i}`), argv, expected: { exit_code: failures.length ? 1 : 0, failures } }] });
}
function input(f: ReturnType<typeof fixture>, artifactContract: ReturnType<typeof contract>) {
  return { stageId: 'work', template: 'Write nonexistent.md. Replay command: npm test -- imaginary.test.ts: exit 0', projectDir: f.project, runDir: f.directory, artifactContract };
}
const budget = () => { const deadline = performance.now() + 40_000; return { remainingMs: () => deadline - performance.now() }; };
const nodeTest = (name: string, assertion: string) => `import {test} from 'node:test'; import assert from 'node:assert/strict'; test(${JSON.stringify(name)},()=>{${assertion}});\n`;

describe('declared replay execution', () => {
  it('verifies an expected failing reproduction by exact failure identity and direct exit', async () => {
    const f = fixture(); writeFileSync(join(f.project, 'case.test.mjs'), nodeTest('observed defect', 'assert.equal(1,2)'));
    const i = input(f, contract(['case.test.mjs'], 'node_test', [{ artifact: 'file_0', test: 'observed defect' }]));
    const audit = await verifyStageArtifactContract(i, budget());
    expect(audit.violations).toEqual([]);
    expect(audit.replayVerification).toBe('verified');
    expect(audit.replayExecutions[0]).toMatchObject({ status: 'passed', exitCode: 1, failedTests: 1, executedTests: 1 });
    expect((await verifyStageArtifactContract({ ...i, artifactContract: contract(['case.test.mjs'], 'node_test', [{ artifact: 'file_0', test: 'other defect' }]) }, budget())).violations[0].reason).toContain('REPLAY_FAILURE_MISMATCH');
  });
  it('executes every entry beyond four and every target after an expected failure', async () => {
    const f = fixture();
    writeFileSync(join(f.project, 'first.test.mjs'), nodeTest('first failure', `append(); assert.equal(1,2)`).replace("import {test}", `import {appendFileSync} from 'node:fs'; const append=()=>appendFileSync(${JSON.stringify(join(f.project, 'count'))},'x'); import {test}`));
    writeFileSync(join(f.project, 'second.test.mjs'), nodeTest('second success', 'assert.equal(1,1)'));
    const c = contract(['first.test.mjs', 'second.test.mjs'], 'node_test', [{ artifact: 'file_0', test: 'first failure' }]);
    c.replays = Array.from({ length: 5 }, (_, index) => ({ ...c.replays![0], id: `entry_${index}` }));
    const audit = await verifyStageArtifactContract(input(f, c), budget());
    expect(audit.violations).toEqual([]);
    expect(audit.replayExecutions).toHaveLength(5);
    expect(audit.replayExecutions.every((entry) => entry.targets?.length === 2 && entry.executedTests === 2)).toBe(true);
    expect(readFileSync(join(f.project, 'count'), 'utf8')).toBe('xxxxx');
  });
  it.each(['empty', 'skipped', 'import_error'])('refuses %s even when a direct outcome is claimed', async (kind) => {
    const f = fixture(); const path = join(f.project, 'case.test.mjs');
    writeFileSync(path, kind === 'empty' ? 'export {};\n' : kind === 'skipped' ? "import {test} from 'node:test';test.skip('observed defect',()=>{});\n" : "import './absent-module.mjs';\n");
    const c = contract(['case.test.mjs'], 'node_test', kind === 'import_error' ? [{ artifact: 'file_0', test: 'observed defect' }] : []);
    const audit = await verifyStageArtifactContract(input(f, c), budget());
    expect(audit.replayExecutions[0].status).toBe('failed');
    expect(audit.violations).toHaveLength(1);
  });
  it('does not let one exercised file mask another empty target', async () => {
    const f = fixture(); writeFileSync(join(f.project, 'real.test.mjs'), nodeTest('passes', 'assert.equal(1,1)'));
    writeFileSync(join(f.project, 'empty.test.mjs'), 'export {};\n');
    const audit = await verifyStageArtifactContract(input(f, contract(['real.test.mjs', 'empty.test.mjs'])), budget());
    expect(audit.replayExecutions[0].executedTests).toBe(1);
    expect(audit.violations[0].reason).toContain('REPLAY_COLLECTION_INVALID');
  });
  it('ignores command-result and sibling-name prose while verifying declared Vitest evidence', async () => {
    const f = fixture(true); writeFileSync(join(f.project, 'case.test.ts'), "import {test,expect} from 'vitest';test('actual evidence',()=>expect(1).toBe(1));\n");
    const i = input(f, contract(['case.test.ts'], 'vitest'));
    i.template = 'Write X/a.json and b.md. Replay command: npm test -- case.test.ts: exit 0';
    const audit = await verifyStageArtifactContract(i, budget());
    expect(audit.violations).toEqual([]); expect(audit.replayExecutions[0].executedTests).toBe(1);
    expect(audit.obligations).toEqual([]); expect(audit.advisories).toBeUndefined();
  });
  it('verifies an actual integration longer than the removed 15-second limit', async () => {
    const f = fixture(true); writeFileSync(join(f.project, 'long.test.ts'), "import {test,expect} from 'vitest';test('long integration',async()=>{await new Promise(r=>setTimeout(r,17000));expect(1).toBe(1)});\n");
    const audit = await verifyStageArtifactContract(input(f, contract(['long.test.ts'], 'vitest')), budget());
    expect(audit.violations).toEqual([]);
    expect(audit.replayExecutions[0]).toMatchObject({ status: 'passed', timedOut: false, executedTests: 1 });
    expect(audit.replayExecutions[0].elapsedMs).toBeGreaterThan(15_000);
  }, 40_000);
  it('reports timeout before missing JSON and refuses an exhausted immutable budget', async () => {
    const f = fixture(true); writeFileSync(join(f.project, 'slow.test.ts'), "import {test} from 'vitest';test('slow',async()=>await new Promise(r=>setTimeout(r,17000)));\n");
    const c = contract(['slow.test.ts'], 'vitest'); c.replays![0].timeout_ms = 100;
    const audit = await verifyStageArtifactContract(input(f, c), budget());
    expect(audit.replayExecutions[0]).toMatchObject({ timedOut: true, status: 'failed', signal: 'SIGKILL' });
    expect(audit.violations[0].reason).toContain('REPLAY_TIMEOUT');
    const exhausted = await verifyStageArtifactContract(input(f, c), { remainingMs: () => 0 });
    expect(exhausted.replayExecutions[0]).toMatchObject({ status: 'not_run', effectiveTimeoutMs: 0 });
    expect(exhausted.violations[0].reason).toContain('REPLAY_ATTEMPT_BOUNDARY');
  });
  it('honors control abort during replay', async () => {
    const f = fixture(); writeFileSync(join(f.project, 'slow.test.mjs'), "import {test} from 'node:test';test('slow',async()=>await new Promise(r=>setTimeout(r,17000)));\n");
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 100);
    try {
      const audit = await verifyStageArtifactContract(input(f, contract(['slow.test.mjs'])), { ...budget(), abortSignal: abort.signal });
      expect(audit.replayExecutions[0].reason).toContain('REPLAY_ABORTED');
      expect(audit.replayExecutions[0].timedOut).toBe(false);
    } finally { clearTimeout(timer); }
  });
});

describe('new input boundaries and retained data readers', () => {
  it.each(['missing', 'empty', 'decoy'])('retains the %s exact output refusal', (kind) => {
    const f = fixture();
    const c = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'owed', root: 'project', path: 'owed.md' }], reads: [], replays: [] });
    const i = input(f, c), preimages = captureStageArtifactContractPreimages(i);
    if (kind === 'empty') writeFileSync(join(f.project, 'owed.md'), '');
    if (kind === 'decoy') writeFileSync(join(f.directory, 'owed.md'), 'wrong root\n');
    expect(inspectStageArtifactContract({ ...i, preimages }).violations[0].reason).toContain('ARTIFACT_OUTPUT_ABSENT_OR_STALE');
  });
  it('retains unresolved predicates, exact groups and unsettled-producer read refusals', () => {
    const f = fixture();
    const conditional = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'conditional', root: 'project', path: 'conditional.md', when: { stage: 'previous', field: 'exitCode', equals: 0 } }], reads: [], replays: [] });
    expect(inspectStageArtifactContract(input(f, conditional)).violations[0].reason).toContain('ARTIFACT_FACT_UNKNOWN');
    const group = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'a', root: 'project', path: 'a.md' }, { id: 'b', root: 'project', path: 'b.md' }], reads: [], groups: [{ id: 'choice', mode: 'exactly_one', members: ['a', 'b'] }], replays: [] });
    writeFileSync(join(f.project, 'a.md'), 'a'); writeFileSync(join(f.project, 'b.md'), 'b');
    expect(inspectStageArtifactContract({ ...input(f, group), writes: ['a.md', 'b.md'] }).violations[0].reason).toContain('ARTIFACT_EXACTLY_ONE');
    const read = ArtifactContractSchema.parse({ version: 1, produces: [], reads: [{ id: 'data', root: 'project', path: 'a.md', source: { kind: 'stage', stage: 'previous', artifact: 'a' } }], replays: [] });
    expect(inspectDeclaredStageReads({ artifactContract: read, projectDir: f.project, runDir: f.directory }).join('\n')).toContain('ARTIFACT_READ_NOT_PRODUCED');
  });
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
  it('refuses old dispatch without waiving an unrelated dependency refusal', () => {
    const raw = { id: 'work', role: 'coder', depends_on: ['missing'], dependency_reasons: { missing: 'Consumes evidence' }, scope: [], prompt_template: 'Write prose.md' };
    expect(() => parseDispatchedStageConfig(raw)).toThrow(/ARTIFACT_DECLARATION_REQUIRED.*replays/s);
    const stage = StageConfigSchema.parse(raw); // Archived schema is readable.
    const report = inspectDispatchAdmission({ dispatched: [stage], baseStages: [], dispatchStageId: 'plan' });
    expect(report.errors.some((error) => error.includes('ARTIFACT_DECLARATION_REQUIRED'))).toBe(true);
    expect(report.errors.some((error) => error.includes('unknown'))).toBe(true);
    expect(RecordedArtifactContractSchema.parse({ version: 1, produces: [], reads: [] }).replays).toBeUndefined();
    expect(() => ArtifactContractSchema.parse({ version: 1, produces: [], reads: [] })).toThrow('REPLAY_DECLARATION_REQUIRED');
  });
  it('refuses legacy launch/resume before invoking the adapter or creating a run', async () => {
    const f = fixture(); let invoked = false;
    const workflow = WorkflowConfigSchema.parse({ name: 'old', stages: [{ id: 'old', role: 'coder' }] });
    await expect(runWorkflow(workflow, 'name: old\n', f.project, { run: async () => { invoked = true; return { output: '', exitCode: 0, duration_ms: 1 }; } }, new Map())).rejects.toThrow('DECLARED_INPUT_MIGRATION_REQUIRED');
    expect(invoked).toBe(false); expect(existsSync(join(f.project, '.fc'))).toBe(false);
  });
  it('preserves exact rooted output freshness and avoids sibling inference', () => {
    const f = fixture(); const c = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'a', root: 'run', path: 'stages/work/a.json' }, { id: 'b', root: 'run', path: 'stages/work/b.md' }], reads: [], replays: [] });
    const i = input(f, c); i.template = 'Write {run_dir}/stages/work/a.json and b.md';
    const preimages = captureStageArtifactContractPreimages(i); mkdirSync(join(f.directory, 'stages/work'), { recursive: true });
    writeFileSync(join(f.directory, 'stages/work/a.json'), '{}\n'); writeFileSync(join(f.directory, 'stages/work/b.md'), 'evidence\n');
    expect(inspectStageArtifactContract({ ...i, preimages }).violations).toEqual([]);
    const stale = inspectStageArtifactContract({ ...i, preimages: captureStageArtifactContractPreimages(i) });
    expect(stale.violations).toHaveLength(2); expect(stale.violations.every((v) => v.reason.includes('ABSENT_OR_STALE'))).toBe(true);
    expect(stale.obligations.every((o) => o.path.startsWith(f.directory))).toBe(true);
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
  it('refuses unsupported argv, conditional/unbound replay targets, duplicate IDs and excessive lists', () => {
    const f = fixture(); const c = contract(['case.test.mjs']);
    for (const mutation of [ { ...c, replays: [{ ...c.replays![0], argv: ['--reporter=json'] }] }, { ...c, replays: [{ ...c.replays![0], targets: ['absent'] }] }, { ...c, replays: [c.replays![0], c.replays![0]] }, { ...c, replays: Array.from({ length: 33 }, (_, i) => ({ ...c.replays![0], id: `entry_${i}` })) } ]) expect(ArtifactContractSchema.safeParse(mutation).success).toBe(false);
    c.reads[0].when = { stage: 'previous', field: 'exitCode', equals: 0 }; expect(ArtifactContractSchema.safeParse(c).success).toBe(false);
  });
  it('worker settlement verifies expected failure while preserving an authored failing audit verdict', async () => {
    const f = fixture(); writeFileSync(join(f.project, 'case.test.mjs'), nodeTest('observed defect', 'assert.equal(1,2)'));
    const run = createRun(f.project, 'fixture', 'name: fixture\nstages: []\n', ['work']); const directory = runDir(f.project, run.runId);
    const c = contract(['case.test.mjs'], 'node_test', [{ artifact: 'file_0', test: 'observed defect' }]);
    c.produces = [{ id: 'verdict', root: 'run', path: 'stages/work/audit.json', kind: 'file', nonempty: true }];
    const result = await runStage({ run: async () => {
      writeFileSync(join(directory, 'stages/work/audit.json'), '{"pass":false,"finding":"observed defect"}\n');
      return { exitCode: 0, output: 'The audit found a defect.', duration_ms: 1, writes: ['run:stages/work/audit.json'], writeAttribution: 'structured' };
    } }, { stageId: 'work', role, dependsOn: [], projectDir: f.project, runId: run.runId, runDir: directory, promptTemplate: '', artifactContract: c, timeout_ms: 5000, retries: 0, projectWriteScope: [] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, 'stages/work/audit.json'), 'utf8')).pass).toBe(false);
    expect(JSON.parse(readFileSync(join(directory, 'stages/work/artifact_contract.json'), 'utf8')).replayVerification).toBe('verified');
  });
});
