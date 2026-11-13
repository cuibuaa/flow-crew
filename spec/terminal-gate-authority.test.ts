import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, utimesSync, symlinkSync } from 'node:fs';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowConfigSchema, runWorkflow } from '../src/scheduler.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { setFcGlobalDir, fcGlobalDir, runDir } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { createContentSettlementContext } from '../src/scheduler/sched_scope/frozen-inputs.js';
import { settleProjectWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { createRun } from './test-support/create-run.js';
const previous=fcGlobalDir(), roots:string[]=[];
afterEach(()=>{setFcGlobalDir(previous);for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true})});
it.each([
 {ignored:true,dispatched:false,initial:false},
 {ignored:true,dispatched:false,initial:true},
 {ignored:true,dispatched:true,initial:false},
 {ignored:true,dispatched:true,initial:true},
 {ignored:false,dispatched:false,initial:false},
 {ignored:false,dispatched:true,initial:false},
])('requires authorized terminal bytes: ignored=$ignored dispatched=$dispatched initial=$initial',async ({ignored,dispatched,initial})=>{
 setEngineDefaults({stage_technical_retries:1});
 const root=mkdtempSync(join(tmpdir(),'terminal-authority-')); roots.push(root);
 const project=join(root,'project');mkdirSync(project);setFcGlobalDir(join(root,'store'));
 isolatedProjectCommand('git',['init','-q'],project,root);if(ignored)writeFileSync(join(project,'.gitignore'),'result.md\n');
 const stages=[
  {id:'a',role:'coder',scope:['result.md'],depends_on:dispatched?['plan']:[]},
  {id:'g',role:'qa',is_gate:true,scope:[],depends_on:['a']},
  {id:'r',role:'coder',scope:['result.md'],depends_on:['g'],retry_to:['g']},
 ];
 const workflow=WorkflowConfigSchema.parse({name:'authority-probe',defaults:{max_iterations:1,max_retries:0},
  stages:dispatched?[{id:'plan',role:'planner',dynamic_dispatch:true,scope:[]}]:stages});
 let gates=0;
 const adapter=new ScriptedAdapter({
  plan:{runFiles:{'dispatch.yaml':JSON.stringify({stages})}},
  a:initial?{projectFiles:{'result.md':'authorized current result'}}:{},
  g:{runFiles:{'verdict_g.json':'{"pass":true,"reason":"Reviewed current content"}'}},
 });
 const original=adapter.run.bind(adapter);
 adapter.run=async(p,r,o)=>{const result=await original(p,r,o);if(o.stageId==='g'&&++gates===1){
  writeFileSync(join(project,'result.md'),'unauthorized gate result');
  return {...result,writes:['result.md'],writeAttribution:'structured'};
 }return result};
 const state=await runWorkflow(workflow,'',project,adapter,new Map(),undefined,join(import.meta.dirname,'../config/agents'),undefined,
  '---\nterminal_states:\n  complete: [result.md]\n---\nProduce a reviewed result.\n',true);
 const attempts=state.stages.g?.attempts??[];
 const directory=runDir(project,state.runId);
 const audit=attempts[0]?.constraintAudit;
 const details=audit?JSON.parse(readFileSync(runRecordPath(directory,audit.path),'utf8')):{};
 const bytes=existsSync(join(project,'result.md'))?readFileSync(join(project,'result.md'),'utf8'):'absent';
 console.log(JSON.stringify({ignored,dispatched,initial,status:state.status,bytes,
  attempts:attempts.map(a=>({status:a.status,writes:a.writes,violations:a.constraintAudit?.violationCount})),
  rollbackFailures:details.rollbackFailures,rollbackReasons:details.rollbackFailureReasons}));
 expect(attempts[0]?.constraintAudit?.violationCount).toBeGreaterThan(0);
 expect(bytes).toBe('unauthorized gate result');
 expect(state.status).not.toBe('complete');
});

// Ledger 824: five topology/rollback controls, metadata-only preservation, and
// FIFO/alias publication without adapter write metadata (eight cases).
describe('reproduction 824', () => {
  function topologyFixture(files: Record<string, string>, fifo?: string) {
    const root = mkdtempSync(join(tmpdir(), 'terminal-topology-')); roots.push(root);
    const project = join(root, 'project'); mkdirSync(project); setFcGlobalDir(join(root, 'store'));
    for (const [path, bytes] of Object.entries(files)) {
      const absolute = join(project, path);
      mkdirSync(dirname(absolute), { recursive: true }); writeFileSync(absolute, bytes);
    }
    if (fifo) isolatedProjectCommand('mkfifo', [fifo], project, root);
    isolatedProjectCommand('git', ['init', '-q'], project, root);
    const run = createRun(project, 'entry', 'name: entry\nstages: []\n', ['g']);
    writeFileSync(runRecordPath(run.runDirPath, 'task_brief.md'), 'Review project content.');
    const gate = StageConfigSchema.parse({ id: 'g', role: 'qa', is_gate: true, scope: [] });
    const context = createContentSettlementContext(project, [gate], run.runId);
    return { project, context, settle(paths: string[]) {
      try {
        return settleProjectWrites({ projectDir: project, context,
          readOnly: true, rawWrites: paths, appliedWrites: paths });
      } finally { }
    } };
  }

  it.each([false, true])('detects ignored=%s modifications, deletion and new nested leaves without restoration', ignored => {
    const { project, settle } = topologyFixture({ '.gitignore': ignored ? 'data/\n' : '',
      'data/old': 'old', 'data/deleted': 'delete-me' });
    writeFileSync(join(project, 'data/old'), 'bad'); rmSync(join(project, 'data/deleted'));
    mkdirSync(join(project, 'data/new')); writeFileSync(join(project, 'data/new/deep'), 'new');
    const result = settle(['data/old', 'data/deleted', 'data/new/deep']);
    expect(result.rollbackFailures).toEqual([]); expect(result.violations.length).toBeGreaterThanOrEqual(3);
    expect(result.rolledBackWrites).toEqual([]);
    expect(readFileSync(join(project, 'data/old'), 'utf8')).toBe('bad');
    expect(existsSync(join(project, 'data/deleted'))).toBe(false);
    expect(existsSync(join(project, 'data/new/deep'))).toBe(true);
  });

  it('detects a directory replaced by a symlink without changing its target', () => {
    const { project, settle } = topologyFixture({ 'directory/child': 'original', 'destination/child': 'operator' });
    rmSync(join(project, 'directory'), { recursive: true }); symlinkSync('destination', join(project, 'directory'));
    expect(settle(['directory', 'directory/child']).rollbackFailures).toEqual([]);
    expect(lstatSync(join(project, 'directory')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(project, 'directory/child'), 'utf8')).toBe('operator');
    expect(readFileSync(join(project, 'destination/child'), 'utf8')).toBe('operator');
  });

  it('detects a file replaced by a directory and leaves the replacement intact', () => {
    const { project, settle } = topologyFixture({ leaf: 'original' });
    rmSync(join(project, 'leaf')); mkdirSync(join(project, 'leaf')); writeFileSync(join(project, 'leaf/child'), 'replacement');
    const result = settle(['leaf', 'leaf/child']);
    expect(readFileSync(join(project, 'leaf/child'), 'utf8')).toBe('replacement');
    expect(result.violations.map(item => item.path)).toContain('leaf');
  });

  it('does not delete an unchanged preexisting ignored FIFO on reported write', () => {
    const { project, context, settle } = topologyFixture({ '.gitignore': 'pipe\n' }, 'pipe');
    expect(context.readOnlyBefore).toHaveProperty('pipe');
    settle(['pipe']);
    expect(existsSync(join(project, 'pipe'))).toBe(true);
    expect(lstatSync(join(project, 'pipe')).isFIFO()).toBe(true);
  });

  it('read-only retry preserves a preexisting ignored FIFO after a metadata-only touch', async () => {
    setEngineDefaults({ stage_technical_retries: 1 });
    const root = mkdtempSync(join(tmpdir(), 'terminal-fifo-')); roots.push(root);
    const project = join(root, 'project'); mkdirSync(project); setFcGlobalDir(join(root, 'store'));
    isolatedProjectCommand('git', ['init', '-q'], project, root);
    writeFileSync(join(project, '.gitignore'), 'operator.pipe\n');
    isolatedProjectCommand('mkfifo', ['operator.pipe'], project, root);
    const workflow = WorkflowConfigSchema.parse({ name: 'entry', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
      { id: 'author', role: 'coder', scope: ['result.md'] },
      { id: 'gate', role: 'qa', is_gate: true, scope: [], depends_on: ['author'] },
      { id: 'repair', role: 'coder', scope: ['result.md'], depends_on: ['gate'], retry_to: ['gate'] },
    ] });
    const adapter = new ScriptedAdapter({
      author: { projectFiles: { 'result.md': 'authorized report' } },
      gate: { runFiles: { 'verdict_gate.json': '{"pass":true,"reason":"Independently accepted report"}' } },
    });
    let reviews = 0;
    const original = adapter.run.bind(adapter);
    adapter.run = async (prompt, role, opts) => {
      const result = await original(prompt, role, opts);
      if (opts.stageId === 'gate' && ++reviews === 1) {
        utimesSync(join(project, 'operator.pipe'), new Date(), new Date());
        return { ...result, writes: ['operator.pipe'], writeAttribution: 'structured' };
      }
      return result;
    };
    const state = await runWorkflow(workflow, '', project, adapter, new Map(), undefined,
      join(import.meta.dirname, '../config/agents'), undefined,
      '---\nterminal_states:\n  complete: [result.md]\n---\nProduce and review the report without damaging project entries.\n', true);
    expect(lstatSync(join(project, 'operator.pipe')).isFIFO()).toBe(true);
    expect(state.stages.gate.attempts?.length).toBeGreaterThan(0);
    expect(state.stages.gate.attempts![0].constraintAudit?.violationCount).toBeGreaterThan(0);
    expect(state.status, state.failureReason).not.toBe('complete');
    expect(readFileSync(join(project, 'result.md'), 'utf8')).toBe('authorized report');
  });

  it.each(['fifo', 'alias'] as const)('a refused %s write cannot be published without adapter write metadata',
    shape => checkUnrestoredPublication(shape, 'unknown'));
});

// Scrubbed reproduction of the gate's unknown-preimage retry boundary. The
// unauthorized bytes must be kept for inspection without becoming publishable.
it.each(['fifo', 'alias'] as const)('refuses publication after an unrestored %s write before a clean retry',
  shape => checkUnrestoredPublication(shape, 'structured'));

async function checkUnrestoredPublication(shape: 'fifo' | 'alias', attribution: 'structured' | 'unknown') {
  const root = mkdtempSync(join(tmpdir(), 'terminal-unrestored-')); roots.push(root);
  const project = join(root, 'project'); mkdirSync(project); setFcGlobalDir(join(root, 'store'));
  isolatedProjectCommand('git', ['init', '-q'], project, root);
  writeFileSync(join(project, '.gitignore'), 'hidden/\nresult.md\n');
  if (shape === 'alias') {
    mkdirSync(join(project, 'hidden'));
    writeFileSync(join(project, 'hidden/result.md'), 'launch bytes');
    symlinkSync('hidden', join(project, 'alias'));
  }
  setEngineDefaults({ stage_technical_retries: 1 });
  const path = shape === 'fifo' ? 'result.md' : 'alias/result.md';
  const workflow = WorkflowConfigSchema.parse({ name: 'entry', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
    { id: 'author', role: 'coder', scope: [path] },
    { id: 'gate', role: 'qa', is_gate: true, scope: [], depends_on: ['author'] },
    { id: 'repair', role: 'coder', scope: [path], depends_on: ['gate'], retry_to: ['gate'] },
  ] });
  const adapter = new ScriptedAdapter({ author: {}, gate: {
    runFiles: { 'verdict_gate.json': '{"pass":true,"reason":"Accepted current content"}' },
  } });
  let reviews = 0;
  const original = adapter.run.bind(adapter);
  adapter.run = async (prompt, role, opts) => {
    const result = await original(prompt, role, opts);
    if (opts.stageId === 'author' && shape === 'fifo') {
      isolatedProjectCommand('mkfifo', [path], project, root);
      return { ...result, writes: [path], writeAttribution: 'structured' };
    }
    if (opts.stageId === 'gate' && ++reviews === 1) {
      if (shape === 'fifo') rmSync(join(project, path));
      writeFileSync(join(project, path), 'unauthorized gate publication');
      return { ...result, writes: attribution === 'structured' ? [path] : [], writeAttribution: attribution };
    }
    return result;
  };
  const state = await runWorkflow(workflow, '', project, adapter, new Map(), undefined,
    join(import.meta.dirname, '../config/agents'), undefined,
    `---\nterminal_states:\n  complete: [${path}]\n---\nPublish an authorized, independently reviewed report.\n`, true);
  const attempts = state.stages.gate.attempts!;
  expect(readFileSync(join(project, path), 'utf8')).toBe('unauthorized gate publication');
  expect(state.status, `unauthorized gate bytes published; shape=${shape}; reviewCount=${reviews}; gatePass=${state.stages.gate.gate?.pass}; violationCount=${attempts[0]?.constraintAudit?.violationCount}; attribution=${attempts[0]?.writeAttribution}; terminalArtifact=${state.terminalArtifact}`).not.toBe('complete');
  expect(attempts[0].constraintAudit?.violationCount).toBeGreaterThan(0);
  const audit = JSON.parse(readFileSync(runRecordPath(runDir(project, state.runId), attempts[0].constraintAudit!.path), 'utf8'));
  expect(audit.rollbackFailures).toEqual([]);
  expect(audit.rolledBackWrites).toEqual([]);
  expect(audit.violations).toContainEqual(expect.objectContaining({ kind: 'read_only_project_violation' }));
  expect(state.status, state.failureReason).toBe('failed');
  expect(state.terminalArtifact).toBeUndefined();
  expect(attempts).toHaveLength(1);
  expect(attempts[0].endingCause).toBe('engine_void');
  expect(readFileSync(join(project, path), 'utf8')).toBe('unauthorized gate publication');
}
