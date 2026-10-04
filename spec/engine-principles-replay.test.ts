import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyDeclarationAdmissionChange, classifyRealityDeclarationChange, type ReplayDecision } from '../src/recorded-replay-policy.js';
import { inspectDispatchAdmission, inspectRealityCheckReachability, StageConfigSchema } from '../src/scheduler.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
const returned = (value: unknown): ReplayDecision => ({status:'returned',value});
const required = 'ARTIFACT_DECLARATION_REQUIRED: work.artifact_contract: declare {version:1, produces:[], reads:[], groups:[]} explicitly; prose cannot supply this contract';
function admissionFixture() {
  const work = StageConfigSchema.parse({id:'work',role:'coder',scope:['src/**'],depends_on:['missing'],dependency_reasons:{missing:'Consumes the missing artifact.'},prompt_template:'Work.'});
  const input = {dispatched:[work],baseStages:[],dispatchStageId:'plan'};
  const project = (report: ReturnType<typeof inspectDispatchAdmission>) => ({pass:report.pass,errors:report.errors,warnings:report.warnings,terminalOwners:report.terminalOwners});
  return {baseline:returned(project(inspectDispatchAdmission(input))),candidate:returned(project(inspectDispatchAdmission({...input,requireArtifactContracts:true}))),requiredErrors:[required]};
}
describe('recorded replay is a refusal guard', () => {
  it('explains only an added declaration error while retaining the actual topology refusal', () => {
    const fixture = admissionFixture();
    expect(fixture.baseline).toMatchObject({value:{pass:false,errors:expect.arrayContaining([expect.stringContaining('unknown')])}});
    expect(classifyDeclarationAdmissionChange({...fixture,compatibility:fixture.baseline})).toBe('intended');
  });
  it('blocks a lost topology refusal even when the declaration refusal remains', () => {
    const fixture = admissionFixture();
    const value = fixture.candidate.status === 'returned' ? fixture.candidate.value as Record<string,unknown> : {};
    expect(classifyDeclarationAdmissionChange({...fixture,compatibility:fixture.baseline,candidate:returned({...value,errors:[required]})})).toBe('ambiguous_unpredicted');
  });
  it('blocks changed warnings, owners and compatibility behavior rather than calling them intended', () => {
    const fixture = admissionFixture();
    const value = fixture.candidate.status === 'returned' ? fixture.candidate.value as Record<string,unknown> : {};
    for (const mutation of [{warnings:['changed']},{terminalOwners:{'docs/final.md':'foreign'}}]) {
      expect(classifyDeclarationAdmissionChange({...fixture,compatibility:fixture.baseline,candidate:returned({...value,...mutation})})).toBe('ambiguous_unpredicted');
    }
    expect(classifyDeclarationAdmissionChange({...fixture,compatibility:returned({pass:true,errors:[]})})).toBe('ambiguous_unpredicted');
  });
  it('predicts the precise reality-read format refusal and blocks a changed verdict', () => {
    const root = mkdtempSync(join(tmpdir(),'flowcrew-replay-policy-')); roots.push(root);
    const project = join(root,'project'), directory = join(root,'run'); mkdirSync(project); mkdirSync(directory);
    const input = {markdown:'## Reality checks\n```yaml\nchecks:\n - name: files\n   type: exec-script-exit-zero\n   params: {script: "cat missing.md"}\n```\n',projectDir:project,runDir:directory,stages:[]};
    const baseline = returned(inspectRealityCheckReachability(input));
    const candidate = returned(inspectRealityCheckReachability({...input,requireDeclaredReads:true}));
    const requiredErrors = ['REALITY_READ_DECLARATION_REQUIRED: reality check "files".reads: declare exact rooted inputs and sources, or reads: [] explicitly; script/prose paths cannot supply this declaration'];
    const policy = {baseline,candidate,compatibility:baseline,declaredOnly:returned([]),requiredErrors};
    expect(classifyRealityDeclarationChange(policy)).toBe('intended');
    expect(classifyRealityDeclarationChange({...policy,candidate:returned([])})).toBe('ambiguous_unpredicted');
  });
});
