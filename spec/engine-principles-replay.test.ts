import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyDeclarationAdmissionChange, classifyRealityDeclarationChange, recordedReplayValue, withRecordedReplayClock, type ReplayDecision } from '../src/recorded-replay-policy.js';
import { inspectDispatchAdmission, inspectRealityCheckReachability, StageConfigSchema } from '../src/scheduler.js';
import { artifactDeclarationErrors } from '../src/artifact-declarations.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
const returned = (value: unknown): ReplayDecision => ({status:'returned',value});
const required = artifactDeclarationErrors(undefined, 'work')[0];
function admissionFixture() {
  const work = StageConfigSchema.parse({id:'work',role:'coder',scope:['src/**'],depends_on:['missing'],dependency_reasons:{missing:'Consumes the missing artifact.'},prompt_template:'Work.',artifact_contract:{version:1,produces:[],reads:[],replays:[]}});
  const input = {dispatched:[work],baseStages:[],dispatchStageId:'plan'};
  const project = (report: ReturnType<typeof inspectDispatchAdmission>) => ({pass:report.pass,errors:report.errors,warnings:report.warnings,terminalOwners:report.terminalOwners});
  return {baseline:returned(project(inspectDispatchAdmission(input))),candidate:returned(project(inspectDispatchAdmission({...input,dispatched:[{...work,artifact_contract:undefined}]}))),requiredErrors:[required]};
}
describe('recorded replay is a refusal guard', () => {
  it('compares recorded timestamps while freezing only generated clocks and restoring the process clock', () => {
    const original = Date;
    const read = (checkedAt: string) => recordedReplayValue(withRecordedReplayClock(0, () => ({checkedAt,inspectedAt:'recorded',generated:new Date().toISOString(),root:'/private/run'})), '/private');
    const baseline = read('2026-01-01T00:00:00.000Z');
    const candidate = read('2026-01-02T00:00:00.000Z');
    expect(baseline).toMatchObject({checkedAt:'2026-01-01T00:00:00.000Z',generated:'1970-01-01T00:00:00.000Z',root:'<owned-root>/run'});
    expect(classifyDeclarationAdmissionChange({baseline:returned(baseline),candidate:returned(candidate),requiredErrors:[]})).toBe('ambiguous_unpredicted');
    expect(Date).toBe(original);
    expect(() => withRecordedReplayClock(0, () => { throw new Error('reader'); })).toThrow('reader');
    expect(Date).toBe(original);
  });
  it('explains only an added declaration error while retaining the actual topology refusal', () => {
    const fixture = admissionFixture();
    expect(fixture.baseline).toMatchObject({value:{pass:false,errors:expect.arrayContaining([expect.stringContaining('unknown')])}});
    expect(classifyDeclarationAdmissionChange(fixture)).toBe('intended');
  });
  it('blocks a lost topology refusal even when the declaration refusal remains', () => {
    const fixture = admissionFixture();
    const value = fixture.candidate.status === 'returned' ? fixture.candidate.value as Record<string,unknown> : {};
    expect(classifyDeclarationAdmissionChange({...fixture,candidate:returned({...value,errors:[required]})})).toBe('ambiguous_unpredicted');
  });
  it('blocks changed warnings, owners and unexpected refusal shapes', () => {
    const fixture = admissionFixture();
    const value = fixture.candidate.status === 'returned' ? fixture.candidate.value as Record<string,unknown> : {};
    for (const mutation of [{warnings:['changed']},{terminalOwners:{'docs/final.md':'foreign'}}]) {
      expect(classifyDeclarationAdmissionChange({...fixture,candidate:returned({...value,...mutation})})).toBe('ambiguous_unpredicted');
    }
    expect(classifyDeclarationAdmissionChange({...fixture,candidate:{status:'refused',error:'unpredicted'}})).toBe('ambiguous_unpredicted');
  });
  it('predicts the precise reality-read format refusal and blocks a changed verdict', () => {
    const root = mkdtempSync(join(tmpdir(),'flowcrew-replay-policy-')); roots.push(root);
    const project = join(root,'project'), directory = join(root,'run'); mkdirSync(project); mkdirSync(directory);
    const input = {markdown:'## Reality checks\n```yaml\nchecks:\n - name: files\n   type: exec-script-exit-zero\n   params: {script: "cat missing.md"}\n```\n',projectDir:project,runDir:directory,stages:[]};
    // Historical lexical decisions are inert data. Only the strict candidate
    // and the explicitly declared control are evaluated by the live engine.
    const baseline = returned(['reality check "files" references absent missing.md, but no stage scope owns it']);
    const candidate = returned(inspectRealityCheckReachability(input));
    const requiredErrors = ['REALITY_READ_DECLARATION_REQUIRED: reality check "files".reads: declare exact rooted inputs and sources, or reads: [] explicitly; script/prose paths cannot supply this declaration'];
    const declaredOnly = returned(inspectRealityCheckReachability({...input,markdown:input.markdown.replace('   params:', '   reads: []\n   params:')}));
    const policy = {baseline,candidate,declaredOnly,requiredErrors};
    expect(classifyRealityDeclarationChange(policy)).toBe('intended');
    expect(classifyRealityDeclarationChange({...policy,candidate:returned([])})).toBe('ambiguous_unpredicted');
  });
});
