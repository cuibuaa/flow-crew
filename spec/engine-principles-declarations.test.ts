import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactContractSchema, artifactActivation, inspectArtifactDeclarations } from '../src/artifact-declarations.js';
import { inspectDeclaredStageReads } from '../src/declared-artifact-audit.js';
import { inspectDispatchAdmission, inspectRealityCheckReachability, StageConfigSchema } from '../src/scheduler.js';
import { parseChecksFromMarkdown, runAllChecks } from '../src/reality-gate/index.js';
import { createRun, fcGlobalDir, runDir, setFcGlobalDir, updateRunState, type StageStatus } from '../src/store.js';

let root: string, project: string, directory: string, previousStore: string, runId: string;
const fact = { stage: 'choice', field: 'exitCode' as const, equals: 0 };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-declaration-mechanisms-')); project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['choice', 'producer', 'reader']).runId;
  directory = runDir(project, runId);
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });
function stage(id: string, depends_on: string[], artifact_contract?: unknown) {
  return StageConfigSchema.parse({ id, role: 'coder', scope: ['docs/**'], depends_on, dependency_reasons: Object.fromEntries(depends_on.map((id) => [id, 'Consumes the declared predecessor outcome.'])), prompt_template: 'Execute declared work.', artifact_contract });
}
function conditionalStages(readerWhen: unknown = fact) {
  const producer = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'report', root: 'project', path: 'docs/report.md', when: fact }], reads: [], replays: [] });
  const reader = ArtifactContractSchema.parse({ version: 1, produces: [], reads: [{ id: 'report', root: 'project', path: 'docs/report.md', when: readerWhen, source: { kind: 'stage', stage: 'producer', artifact: 'report' } }], replays: [] });
  return [stage('choice', [], { version: 1, produces: [], reads: [], replays: [] }), stage('producer', ['choice'], producer), stage('reader', ['producer'], reader)];
}

describe('declarations are explicit at new admission boundaries', () => {
  it.each(['plan_history', 'audit_findings', 'signals', 'stages', 'stages/writer/invocations'])('protects the %s controller directory as well as its children', (path) => {
    const contract = { version: 1, produces: [{ id: 'evidence', root: 'run', path, kind: 'directory' }], reads: [], replays: [] };
    const writer = stage('writer', [], contract);
    expect(inspectArtifactDeclarations({ stages: [writer] }).join(';')).toContain('ARTIFACT_FRAMEWORK_PATH');
    writer.artifact_contract!.produces[0].path = 'plan_history_notes';
    expect(inspectArtifactDeclarations({ stages: [writer] })).toEqual([]);
    writer.artifact_contract!.produces[0].root = 'project';
    writer.artifact_contract!.produces[0].path = 'docs/plan_history';
    expect(inspectArtifactDeclarations({ stages: [writer] })).toEqual([]);
  });

  it('keeps engine decision projections outside stage production authority',()=>{
    const product=stage('writer',[],{version:1,produces:[{id:'decision',root:'run',path:'stages/writer/plan_revision_decision_example.json'}],reads:[], replays: [] });
    expect(inspectDispatchAdmission({dispatched:[product],baseStages:[],dispatchStageId:'plan'}).errors.join(';')).toContain('ARTIFACT_FRAMEWORK_PATH');
    const request=stage('writer',[],{version:1,produces:[{id:'request',root:'run',path:'stages/writer/plan_revision_request.json'}],reads:[], replays: [] });
    expect(inspectDispatchAdmission({dispatched:[request],baseStages:[],dispatchStageId:'plan'}).pass).toBe(true);
  });
  it('refuses a missing stage contract by format with the same error for both prompt texts', () => {
    const untyped = stage('writer', []);
    const admit = (prompt_template: string) => inspectDispatchAdmission({ dispatched: [{ ...untyped, prompt_template }], baseStages: [], dispatchStageId: 'plan' });
    const first = admit('Write {run_dir}/success.json or {run_dir}/escalation.md.');
    expect(first.pass).toBe(false); expect(first.errors.join(';')).toContain('ARTIFACT_DECLARATION_REQUIRED: writer.artifact_contract');
    expect(admit('No path words.').errors).toEqual(first.errors);
    expect(inspectDispatchAdmission({ dispatched: [stage('writer', [], { version: 1, produces: [], reads: [], replays: [] })], baseStages: [], dispatchStageId: 'plan' }).pass).toBe(true);
  });

  it('names the missing reality reads without extracting escaped messages or references', () => {
    const markdown = (script: string) => '## Reality checks\n```yaml\nchecks:\n - name: script\n   type: exec-script-exit-zero\n   params:\n     script: ' + JSON.stringify(script) + '\n```\n';
    const inspect = (script: string) => inspectRealityCheckReachability({ markdown: markdown(script), projectDir: project, runDir: directory, stages: [] });
    expect(inspect('echo "message\\nmissing.md"')).toEqual(inspect('true'));
    expect(inspect('true')[0]).toContain('REALITY_READ_DECLARATION_REQUIRED');
    const typed = markdown('true').replace('   params:', '   reads: []\n   params:');
    expect(inspectRealityCheckReachability({ markdown: typed, projectDir: project, runDir: directory, stages: [] })).toEqual([]);
  });
});

describe('declared reads use producer bindings and settled runtime facts', () => {
  it.each(['project', 'run'] as const)('binds %s directory members for stage and terminal reads and confines physical locations', async (root) => {
    const producer = stage('producer', [], { version: 1, produces: [{ id: 'bundle', root, path: 'docs/bundle', kind: 'directory' }], reads: [] });
    const reader = stage('reader', ['producer'], { version: 1, produces: [], reads: [{ id: 'entry', root, path: 'docs/bundle/index.js', source: { kind: 'stage', stage: 'producer', artifact: 'bundle' } }] });
    const inspect = () => inspectArtifactDeclarations({ stages: [producer, reader], projectDir: project, runDir: directory });
    const terminalReads = () => inspectRealityCheckReachability({
      markdown: `## Reality checks\n\`\`\`yaml\nchecks:\n - name: member\n   type: exec-script-exit-zero\n   reads: ${JSON.stringify(reader.artifact_contract!.reads)}\n   params: {script: 'true'}\n\`\`\`\n`,
      projectDir: project, runDir: directory, stages: [producer, reader],
    });
    expect(inspect()).toEqual([]);
    expect(terminalReads()).toEqual([]);
    const read = reader.artifact_contract!.reads[0];
    read.path = 'docs/bundle_other/index.js';
    expect(inspect().join(';')).toContain('ARTIFACT_READ_UNBOUND');
    expect(terminalReads().join(';')).toContain('ARTIFACT_READ_UNBOUND');
    read.path = 'docs/bundle/index.js'; read.root = root === 'project' ? 'run' : 'project';
    expect(inspect().join(';')).toContain('ARTIFACT_READ_UNBOUND');
    expect(terminalReads().join(';')).toContain('ARTIFACT_READ_UNBOUND');
    read.root = root; read.path = 'docs/bundle';
    expect(inspect().join(';')).toContain('ARTIFACT_READ_UNBOUND');
    read.path = 'docs/bundle/index.js';
    const base = root === 'project' ? project : directory;
    mkdirSync(join(base, read.path), { recursive: true });
    expect(inspectDeclaredStageReads({ artifactContract: reader.artifact_contract!, projectDir: project, runDir: directory, statuses: { producer: { status: 'complete', retries: 0 } } }).join(';')).toContain('ARTIFACT_READ_ABSENT');
    rmSync(join(base, read.path), { recursive: true }); writeFileSync(join(base, read.path), 'export {};');
    expect(inspectDeclaredStageReads({ artifactContract: reader.artifact_contract!, projectDir: project, runDir: directory, statuses: { producer: { status: 'complete', retries: 0 } } })).toEqual([]);
    updateRunState(project, runId, (state) => {
      state.stages.producer = { status: 'complete', retries: 0 };
    });
    const check = { name: 'member', type: 'exec-script-exit-zero', reads: reader.artifact_contract!.reads, params: { script: 'true' } };
    expect((await runAllChecks([check], { projectDir: project, taskDir: directory })).pass).toBe(true);
    // This alias is confined to the authored root but belongs to another directory.
    const sibling = join(base, 'docs/other.js'); writeFileSync(sibling, 'export {};');
    rmSync(join(base, read.path)); symlinkSync(sibling, join(base, read.path));
    expect(inspect()).toEqual([]);
    expect((await runAllChecks([check], { projectDir: project, taskDir: directory })).pass).toBe(true);
    const outside = join(project, '..', 'outside.js'); writeFileSync(outside, 'export {};');
    rmSync(join(base, read.path)); symlinkSync(outside, join(base, read.path));
    expect(inspect().join(';')).toContain('ARTIFACT_PATH_ESCAPE');
    const report = await runAllChecks([check], { projectDir: project, taskDir: directory });
    expect(report.pass).toBe(false); expect(report.results[0].details).toContain('ARTIFACT_PATH_ESCAPE');
  });

  it('refuses a status predicate the runtime cannot emit as a settled stage', () => {
    const choice = stage('choice', [], { version: 1, produces: [], reads: [], replays: [] });
    const producer = stage('producer', ['choice'], { version: 1, produces: [{ id: 'report', root: 'project', path: 'docs/report.md', when: { stage: 'choice', field: 'status', equals: 'cancelled' } }], reads: [], replays: [] });
    expect(inspectArtifactDeclarations({ stages: [choice, producer] }).join(';')).toContain('ARTIFACT_FACT_INVALID');
    producer.artifact_contract!.produces[0].when!.equals = 'skipped';
    expect(inspectArtifactDeclarations({ stages: [choice, producer] })).toEqual([]);
  });

  it('waives only a known inactive read and requires the active branch file', () => {
    const artifactContract = conditionalStages()[2].artifact_contract!;
    const statuses: Record<string, StageStatus> = { choice: { status: 'complete', retries: 0, exitCode: 1 }, producer: { status: 'complete', retries: 0 } };
    expect(inspectDeclaredStageReads({ artifactContract, projectDir: project, runDir: directory, statuses })).toEqual([]);
    statuses.choice.exitCode = 0;
    expect(inspectDeclaredStageReads({ artifactContract, projectDir: project, runDir: directory, statuses })[0]).toContain('ARTIFACT_READ_ABSENT');
    mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Produced active branch.');
    expect(inspectDeclaredStageReads({ artifactContract, projectDir: project, runDir: directory, statuses })).toEqual([]);
  });

  it('never treats an unknown or malformed fact as an inactive branch', () => {
    expect(artifactActivation(fact, {})).toBe('unknown');
    expect(artifactActivation(fact, { choice: { status: 'running', retries: 0, exitCode: 1 } })).toBe('unknown');
    expect(artifactActivation(fact, { choice: { status: 'complete', retries: 0, exitCode: undefined } })).toBe('unknown');
    expect(artifactActivation(fact, { choice: { status: 'complete', retries: 0, exitCode: Number.NaN } })).toBe('unknown');
  });
});

describe('reality checks verify their declared reads at execution', () => {
  it('refuses an input removed after admission without invoking a successful script', async () => {
    const markdown = '## Reality checks\n```yaml\nchecks:\n - name: read\n   type: exec-script-exit-zero\n   reads:\n    - {id: input, root: project, path: input.md, source: {kind: input}}\n   params: {script: "touch executed.txt"}\n```\n';
    writeFileSync(join(project, 'input.md'), 'Existing admitted input');
    expect(inspectRealityCheckReachability({ markdown, projectDir: project, runDir: directory, stages: [] })).toEqual([]);
    rmSync(join(project, 'input.md'));
    const report = await runAllChecks(parseChecksFromMarkdown(markdown), { projectDir: project, taskDir: directory });
    expect(report.pass).toBe(false); expect(report.results[0].details).toContain('ARTIFACT_READ_ABSENT');
    expect(existsSync(join(project, 'executed.txt'))).toBe(false);
  });

  it('refuses an unsettled producer despite an existing file, then executes after settlement', async () => {
    mkdirSync(join(project, 'docs')); writeFileSync(join(project, 'docs/report.md'), 'Existing file alone is insufficient.');
    const reads = ArtifactContractSchema.parse({ version: 1, produces: [], reads: [{ id: 'report', root: 'project', path: 'docs/report.md', source: { kind: 'stage', stage: 'producer', artifact: 'report' } }], replays: [] }).reads;
    const decl = { name: 'report', type: 'exec-script-exit-zero', reads, params: { script: 'touch executed.txt' } };
    updateRunState(project, runId, (state) => { state.stages.producer = { status: 'running', retries: 0 }; });
    const first = await runAllChecks([decl], { projectDir: project, taskDir: directory });
    expect(first.pass).toBe(false); expect(first.results[0].details).toContain('ARTIFACT_READ_NOT_PRODUCED');
    expect(existsSync(join(project, 'executed.txt'))).toBe(false);
    updateRunState(project, runId, (state) => { state.stages.producer.status = 'complete'; });
    expect((await runAllChecks([decl], { projectDir: project, taskDir: directory })).pass).toBe(true);
    expect(existsSync(join(project, 'executed.txt'))).toBe(true);
  });
});
