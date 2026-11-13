import './test-support/policy-runtime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execWithStdin, type Adapter } from '../src/adapters/base.js';
import { createRun } from './test-support/create-run.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { runScopeSafeStageGroup } from '../src/scheduler/sched_loop/services.js';
import { runStage } from '../src/worker.js';
import { fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir } from '../src/store.js';
import { runRecordPath, stageWorkPath } from '../src/run-layout.js';
import { queryWriteGrantCapability } from '../src/write-grant.js';
import * as grantOwner from '../src/write-grant.js';
import { stageRecordSchema } from '../src/handoff.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import { readRunEvents } from '../src/run-events.js';

const cases = [
  { name: '#2490 guide repair', files: { 'guide/brief-contract.md': 'repaired guide' } },
  { name: '922b38 gitignore and declared output', files: { '.gitignore': 'incidental/\ngenerated/\n', 'docs/runner_minimal/step2_report.md': 'declared report', 'evidence/check.txt': 'checked' } },
  { name: 'd30223 test-state files', files: { 'offline-test-X/state/decision1/job.log': 'job', 'offline-test-X/state/decision1/summary.json': '{}', 'state/events.log': 'event', 'state/locks/registry': 'fixture lock' } },
  { name: '92e8e4 make-test evidence', files: { 'offline-test-X/check.txt': 'test evidence', 'tests/fixture.txt': 'new fixture', 'stages/implement/build/make-test.log': 'historical project log' } },
  { name: '8bbc7e incidental native cache', files: { 'dec_table.npz': 'dummy binary 1\0', 'suit_table.npz': 'dummy binary 2\0' } },
];
let root: string, project: string, previous: string;
let observedGrants: string[][];
const capable = queryWriteGrantCapability().kind === 'landlock';
const role = { name: 'local', description: 'Reduced replay', prompt: '', tools: [], model: 'fixture', reasoning_effort: 'low' };
beforeEach(() => {
  observedGrants = [];
  const prepare = grantOwner.prepareWriteGrant;
  vi.spyOn(grantOwner, 'prepareWriteGrant').mockImplementation((...args) => {
    const grant = prepare(...args); if (grant) observedGrants.push(grant.writable.map(root => root.path)); return grant;
  });
  root = mkdtempSync(join(tmpdir(), 'contract-authority-')); project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  for (const path of ['src/a.ts', 'guide/brief-contract.md', 'tests/fixture.txt']) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), 'tracked baseline'); }
  writeFileSync(join(project, 'frozen.txt'), 'pinned evidence'); writeFileSync(join(project, '.gitignore'), 'incidental/\n');
  isolatedProjectCommand('git', ['init', '-q', '--separate-git-dir', join(root, 'git')], project, root);
  isolatedProjectCommand('git', ['add', '.'], project, root);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=' + ['fixture', 'example.invalid'].join('@'), 'commit', '-qm', 'Pinned fixture'], project, root);
  writeFileSync(join(project, 'untracked.txt'), 'untracked evidence');
});
afterEach(() => { vi.restoreAllMocks(); setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });
async function execute(script: string, options: { readOnly?: boolean; frozen?: string; output?: boolean; locator?: string } = {}) {
  const grantStart = observedGrants.length;
  const stage = StageConfigSchema.parse({ id: options.readOnly ? 'review' : 'implement', role: 'local', scope: ['src/'], is_gate: options.readOnly ?? false,
    artifact_contract: { version: 1, produces: options.output ? [{ id: 'report', root: 'project', path: 'docs/runner_minimal', kind: 'directory' }] : [], reads: [] } });
  if (options.output) mkdirSync(join(project, 'docs/runner_minimal'), { recursive: true });
  const brief = `---\ninputs: [{path: ${options.frozen ?? 'frozen.txt'}, frozen: true}${options.locator ? ', ' + options.locator : ''}${options.output ? ', .gitignore, docs/runner_minimal' : ''}]\n${options.output ? 'outputs: [{path: docs/runner_minimal/step2_report.md}]\n' : ''}---\nReduced replay.`;
  const { runId, runDirPath } = createRun(project, 'replay', 'name: replay\nstages: []\n', [stage.id], brief);
  const adapter: Adapter = { sessionKind: 'local', async run(_prompt, _role, opts) {
    const result = await execWithStdin(process.execPath, ['-e', script], '', { cwd: project, timeout_ms: opts.timeout_ms, execution: opts, captureStreams: true });
    return fixtureResult(result, opts);
  } };
  await runScopeSafeStageGroup([stage], project, runId, 1, (s, settlementBoundary) => runStage(adapter, {
    stageId: s.id, role, dependsOn: [], scope: s.scope, promptTemplate: 'Complete the fixture.', projectDir: project, runId, runDir: runDirPath,
    retries: 0, timeout_ms: 60_000, isGate: options.readOnly, outputSchema: stageRecordSchema({ isGate: options.readOnly }), artifactContract: stage.artifact_contract, settlementBoundary,
  }));
  const status = readStageStatus(project, runId, stage.id), attempt = status.attempts!.at(-1)!;
  const audit = JSON.parse(readFileSync(runRecordPath(runDirPath, attempt.constraintAudit!.path), 'utf8'));
  console.log(JSON.stringify({ kind: 'contract-write-replay', test: expect.getState().currentTestName,
    capability: readRunState(project, runId).writeGrant?.capability, stage: stage.id, status: status.status,
    writes: attempt.writes, appliedWrites: audit.appliedWrites, rolledBackWrites: audit.rolledBackWrites,
    rollbackFailures: audit.rollbackFailures, violations: audit.violations, grantRoots: observedGrants.slice(grantStart) }));
  return { status, attempt, audit, runId, runDirPath };
}
const writeScript = (files: Record<string, string>) => `const fs=require('node:fs'),p=require('node:path');for(const [name,bytes] of Object.entries(${JSON.stringify(files)})){fs.mkdirSync(p.dirname(name),{recursive:true});fs.writeFileSync(name,bytes)};console.log('delivered');`;
describe.each(cases)('$name reduced contract replay', fixture => {
  it('accepts the omitted paths, preserves output bytes and records an independent read-only check', async () => {
    const files = fixture.files as Record<string, string>;
    const checks = `const assert=require('node:assert/strict');for(const [name,bytes] of Object.entries(${JSON.stringify(files)}))assert.equal(require('node:fs').readFileSync(name,'utf8'),bytes);console.log('fixture tests passed');`;
    const suite = writeScript(files) + checks;
    writeFileSync(join(project, 'suite.cjs'), suite);
    writeFileSync(join(project, 'Makefile'), `test:\n\t${JSON.stringify(process.execPath)} suite.cjs\n`);
    const invoke = fixture.name.startsWith('8bbc7e')
      ? `require('./suite.cjs');`
      : `const child=require('node:child_process').spawnSync('make',['test'],{encoding:'utf8'});if(child.status!==0)throw Error(child.stderr);process.stdout.write(child.stdout);`;
    const result = await execute(invoke + `const fs2=require('node:fs'),p2=require('node:path');const log=p2.join(process.env.HOME,'..','..','build','make-test.log');fs2.mkdirSync(p2.dirname(log),{recursive:true});fs2.writeFileSync(log,'complete make-test evidence');`, { output: fixture.name.startsWith('922b38'), locator: fixture.name.startsWith('#2490') ? 'guide/brief-contract.md' : undefined });
    expect(result.status.status, result.status.error).toBe('complete');
    expect(result.audit.violations).toEqual([]); expect(result.audit.rolledBackWrites).toEqual([]);
    for (const [path, bytes] of Object.entries(files)) { expect(readFileSync(join(project, path), 'utf8')).toBe(bytes); expect(result.audit.appliedWrites).toContain(path); }
    expect(readFileSync(stageWorkPath(result.runDirPath, 'stages/implement/build/make-test.log'), 'utf8')).toBe('complete make-test evidence');
    expect(result.audit).not.toHaveProperty('declaredScope'); expect(result.audit).not.toHaveProperty('effectiveScope');
    expect(readRunEvents(project, result.runId).some(event => /scope_(request|refus|restor)/.test(event.type))).toBe(false);
    const review = await execute(`const fs=require('node:fs'),assert=require('node:assert/strict');for(const [path,bytes] of Object.entries(${JSON.stringify(files)}))assert.equal(fs.readFileSync(path,'utf8'),bytes);console.log(JSON.stringify({pass:true,reason:'Independently checked actual output bytes.',criteria:{},audit_findings:{version:1,findings:[]}}));`, { readOnly: true });
    expect(review.status.status, review.status.error).toBe('complete'); expect(review.audit.violations).toEqual([]);
    expect(review.audit.appliedWrites).toEqual([]);
    if (capable) expect(review.attempt.writeGrantApplied).toBeDefined();
  });
  it('fails tracked frozen mutation and restores the pinned bytes even after a private HEAD moves', async () => {
    const result = await execute("require('node:fs').writeFileSync('frozen.txt','bad');const cp=require('node:child_process');cp.execFileSync('git',['add','frozen.txt']);cp.execFileSync('git',['-c','user.name=Fixture','-c','user.email='+['fixture','example.invalid'].join('@'),'commit','-qm','Moving private stage HEAD']);console.log('mutated')");
    expect(result.status.status).toBe('failed'); expect(result.status.error).toContain('immutable_evidence_violation');
    expect(result.audit.rolledBackWrites).toEqual(['frozen.txt']); expect(readFileSync(join(project, 'frozen.txt'), 'utf8')).toBe('pinned evidence');
  });
  it('fails untracked frozen mutation and explicitly leaves it unrestored', async () => {
    const result = await execute("require('node:fs').writeFileSync('untracked.txt','bad');console.log('mutated')", { frozen: 'untracked.txt' });
    expect(result.status.status).toBe('failed'); expect(result.audit.rollbackFailures).toEqual(['untracked.txt']);
    expect(result.audit.rolledBackWrites).toEqual([]); expect(readFileSync(join(project, 'untracked.txt'), 'utf8')).toBe('bad');
  });
  it.skipIf(!capable)('denies read-only project writes through the production kernel grant', async () => {
    const result = await execute("try{require('node:fs').writeFileSync('review-write.txt','bad');throw Error('write allowed')}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e};console.log(JSON.stringify({pass:true,reason:'Kernel denied project write.',criteria:{},audit_findings:{version:1,findings:[]}}))", { readOnly: true });
    expect(result.status.status, result.status.error).toBe('complete'); expect(result.attempt.writeGrantApplied).toBeDefined();
    expect(existsSync(join(project, 'review-write.txt'))).toBe(false);
  });
  it.skipIf(!capable)('denies an undeclared outside write through the production kernel grant', async () => {
    const outside = join(root, 'outside.txt');
    const result = await execute(`try{require('node:fs').writeFileSync(${JSON.stringify(outside)},'bad');throw Error('write allowed')}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e};console.log('denied')`);
    expect(result.status.status, result.status.error).toBe('complete'); expect(result.attempt.writeGrantApplied).toBeDefined(); expect(existsSync(outside)).toBe(false);
  });
});
