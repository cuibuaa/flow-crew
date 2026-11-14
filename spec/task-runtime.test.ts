import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { reattestCompatibility } from './test-support/manifest-compatibility.js';
import { assertBuildArtifactInventory, assertControlCompatibility, createBuildManifest, readBuildManifest,
  selectTaskRuntime, validateTaskRuntime, BUILD_MANIFEST_FILENAME, ExclusiveMigrationRequired } from '../src/build-manifest.js';
import { TaskRegistry, normalizeTaskEntry } from '../src/task-registry.js';
import { handleDaemonListRequest } from '../src/cli-daemon.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { createRun } from './test-support/create-run.js';
import { captureEngineCheckpoint } from '../src/restart-recovery.js';
import { fcGlobalDir, setFcGlobalDir, readRunState, updateRunState } from '../src/store.js';
import * as deployment from '../src/deployment-hold.js';

const roots: string[] = [];
let previousStore: string | undefined;
afterEach(()=>{
  vi.restoreAllMocks();
  if (previousStore !== undefined) { setFcGlobalDir(previousStore); previousStore = undefined; }
  for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'fc-rt-')); roots.push(root);
  const project=join(root,'p'), dist=join(project,'dist'), runtime=join(root,'runtime');
  for (const path of [dist,join(project,'src'),join(project,'guide')]) mkdirSync(path,{recursive:true});
  writeFileSync(join(project,'tsconfig.json'),'{}'); writeFileSync(join(project,'package.json'),'{"type":"module"}');
  writeFileSync(join(project,'src/cli.ts'),'export const value = 1;');
  writeFileSync(join(dist,'cli.js'),'export const value = 1;');
  writeFileSync(join(dist,'cli.d.ts'),'export declare const value: number;');
  writeFileSync(join(project,'guide/resource.txt'),'retained resource');
  const manifest=createBuildManifest(project,dist);
  writeFileSync(join(dist,BUILD_MANIFEST_FILENAME),JSON.stringify(manifest));
  const reference=selectTaskRuntime(join(dist,'cli.js'),runtime);
  return {root,project,dist,runtime,reference,manifest};
}

it.each([undefined,'foreign-v2','unknown'])('reads compatibility %s without granting coexistence', value=>{
  const f=fixture(), foreign=reattestCompatibility(f.manifest,value);
  writeFileSync(join(f.dist,BUILD_MANIFEST_FILENAME),JSON.stringify(foreign));
  expect(readBuildManifest(f.dist)).toEqual(foreign);
  expect(()=>assertBuildArtifactInventory(f.dist,foreign)).not.toThrow();
  expect(()=>assertControlCompatibility(f.manifest,foreign)).toThrow(ExclusiveMigrationRequired);
  expect(()=>assertControlCompatibility(foreign)).toThrow('hold-status');
});

it('covers the compatibility declaration with the generation integrity contract',()=>{
  const f=fixture(); f.manifest.controlCompatibility='foreign';
  expect(()=>assertBuildArtifactInventory(f.dist,f.manifest)).toThrow('generation digest');
});

it('cannot rewrite the retained resource inventory under a frozen generation',()=>{
  const f=fixture(),dist=dirname(f.reference.cliPath),path=join(dist,'../guide/resource.txt');
  const manifest=readBuildManifest(dist)!;
  const bytes='rewritten resource'; writeFileSync(path,bytes);
  const record=manifest.inputs.files.find(record=>record.path==='guide/resource.txt')!;
  record.bytes=Buffer.byteLength(bytes);record.sha256=createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(dist,BUILD_MANIFEST_FILENAME),JSON.stringify(manifest));
  expect(()=>validateTaskRuntime(f.reference,f.runtime)).toThrow(ExclusiveMigrationRequired);
});

it.each(['traversal','alias','generation','missing','tampered','resource','foreign-store'])('refuses a %s frozen runtime without selecting current dist', broken=>{
  const f=fixture(), reference={...f.reference};
  if (broken==='traversal') reference.cliPath=join(f.runtime,'.cache','build-generations',reference.generation,'dist')+'/../dist/cli.js';
  if (broken==='alias') { symlinkSync(reference.cliPath,join(f.root,'alias')); reference.cliPath=join(f.root,'alias'); }
  if (broken==='generation') reference.generation='0'.repeat(64);
  if (broken==='missing') rmSync(reference.cliPath);
  if (broken==='tampered') writeFileSync(reference.cliPath,'export const value = 2;');
  if (broken==='resource') writeFileSync(join(dirname(dirname(reference.cliPath)),'guide/resource.txt'),'altered');
  const runtime=broken==='foreign-store' ? join(f.root,'foreign-runtime') : f.runtime;
  expect(()=>validateTaskRuntime(reference,runtime)).toThrow(ExclusiveMigrationRequired);
});

it('freezes the task reference while preserving history and unknown legacy fields',()=>{
  const f=fixture(), registry=new TaskRegistry({baseDir:join(f.root,'store')});
  const task=registry.create({projectDir:f.project,runtime:f.reference});
  expect(()=>registry.update(task.id,{runtime:{...f.reference,generation:'0'.repeat(64)}})).toThrow('frozen');
  expect(()=>registry.update(task.id,{runtime:undefined})).toThrow('frozen');
  registry.update(task.id,{attempt:2,processDeaths:1});
  expect(registry.get(task.id)?.runtime).toEqual(f.reference);
  const legacy={...task,runtime:undefined,launch_seq:0,launch:undefined,max_attempts:undefined,max_retries:3,retained:'opaque'};
  writeFileSync(registry.registryPath,JSON.stringify(legacy)+'\n');
  expect(normalizeTaskEntry(legacy as never)).toMatchObject({launch:1,max_attempts:3,retained:'opaque'});
  expect(handleDaemonListRequest(registry,{cmd:'list'}).tasks).toHaveLength(1);
  expect(readFileSync(registry.registryPath,'utf8')).toContain('opaque');
});

it('a previously executed legacy task cannot silently select the current runtime on recovery',async()=>{
  const f=fixture(),registry=new TaskRegistry({baseDir:join(f.root,'store')});
  const brief='---\ncriteria: [{id: keep, text: Preserve completed work.}]\n---\nPreserve work.';
  const task=registry.create({projectDir:f.project,brief_text:brief,
    brief_admission:createBriefAdmission(inspectBrief(brief),{kind:'explicit',source:'cli_current_input_flag',at:new Date().toISOString()}),
    status:'deferred',launch:2});
  let launches=0;
  const orchestrator=new Orchestrator({registry,cliPath:join(f.dist,'cli.js'),isProjectBusy:()=>null,
    systemd:{isActive:async()=>({kind:'absent'}),runUnit:async()=>{launches++;},stopUnit:async()=>{},journalTail:async()=>''}});
  await orchestrator.tickOnce();
  expect(launches).toBe(0);
  expect(registry.get(task.id)?.notes).toContain('EXCLUSIVE_MIGRATION_REQUIRED');
  expect(registry.get(task.id)?.runtime).toBeUndefined();
  await orchestrator.stop();
});

function legacyRun() {
  const f = fixture();
  previousStore = fcGlobalDir(); setFcGlobalDir(f.root);
  const brief = '---\ncriteria: [{id: keep, text: Preserve completed work.}]\n---\nPreserve work.';
  const admission = createBriefAdmission(inspectBrief(brief), {kind:'explicit',source:'cli_current_input_flag',at:new Date().toISOString()});
  const run = createRun(f.project, 'legacy', 'name: legacy\ndefaults: {max_iterations: 2, max_retries: 0}\nstages:\n  - id: work\n    role: coder\n    scope: []\n    artifact_contract: {version: 1, produces: [], reads: []}\n', ['work'], brief, admission);
  const checkpoint = {...captureEngineCheckpoint(f.project,run.runId), generation:f.reference.generation};
  updateRunState(f.project, run.runId, state => { state.status='parked'; state.engineCheckpoint=checkpoint; });
  const registry = new TaskRegistry({baseDir:f.root});
  const task = registry.create({projectDir:f.project,run_id:run.runId,status:'pending',launch:2,brief_text:brief,brief_admission:admission});
  const commands: string[] = [];
  const controller = new Orchestrator({registry,cliPath:join(f.dist,'cli.js'),isProjectBusy:()=>null,
    systemd:{isActive:async()=>({kind:'absent'}),runUnit:async input=>{commands.push(input.command);},stopUnit:async()=>{},journalTail:async()=>''}});
  const publish = (value: number) => {
    for (const [directory,extension] of [[join(f.project,'src'),'ts'],[f.dist,'js']]) {
      writeFileSync(join(directory,`cli.${extension}`),`export const value = ${value};`);
    }
    const manifest = createBuildManifest(f.project,f.dist);
    writeFileSync(join(f.dist,BUILD_MANIFEST_FILENAME),JSON.stringify(manifest));
    return manifest;
  };
  return {...f,run,registry,task,commands,controller,publish,checkpoint};
}

it('a historical released hold cannot authorize a different runtime through the public recovery tick', async()=>{
  const f = legacyRun();
  const at = new Date().toISOString();
  updateRunState(f.project,f.run.runId,state=>{
    state.deploymentHold={version:1,id:'historical-release',requestedAt:at,heldAt:at,releasedAt:at};
  });
  const current = f.publish(3);
  expect(current.generation).not.toBe(f.reference.generation);
  expect(deployment.readDeploymentHold()).toBeUndefined();
  try {
    await f.controller.tickOnce();
    expect(f.commands).toEqual([]);
    expect(f.registry.get(f.task.id)).toMatchObject({status:'stuck',notes:expect.stringContaining('EXCLUSIVE_MIGRATION_REQUIRED')});
    expect(f.registry.get(f.task.id)?.runtime).toBeUndefined();
    expect(readRunState(f.project,f.run.runId).engineCheckpoint).toEqual(f.checkpoint);
    expect(validateTaskRuntime(f.reference,f.runtime)).toBe(f.reference.cliPath);
  } finally { await f.controller.stop(); }
});

it.each([false,true])('explicit held continuation freezes a legacy runtime before release and preserves it on recovery (interrupted=%s)', async interrupted=>{
  const f = legacyRun(), hold = deployment.requestDeploymentHold();
  updateRunState(f.project,f.run.runId,state=>{state.deploymentHold={...hold,heldAt:new Date().toISOString()};});
  const selected = f.publish(2);
  const update = f.registry.update.bind(f.registry);
  const writes = vi.spyOn(f.registry,'update').mockImplementation((id,patch)=>{
    if (patch.runtime) {
      expect(deployment.deploymentHeld()).toBe(true);
      expect(readRunState(f.project,f.run.runId).deploymentHold?.releasedAt).toBeUndefined();
    }
    return update(id,patch);
  });
  try {
    expect(await f.controller.deploymentStatus()).toMatchObject({ready:true});
    if (interrupted) {
      const release = vi.spyOn(deployment,'releaseDeploymentHold').mockImplementationOnce(()=>{throw new Error('fixture interruption before global release');});
      try { await expect(f.controller.continueDeployment()).rejects.toThrow('fixture interruption'); }
      finally { release.mockRestore(); }
      expect(deployment.deploymentHeld()).toBe(true);
      expect(f.registry.get(f.task.id)?.runtime?.generation).toBe(selected.generation);
      await f.controller.tickOnce(); expect(f.commands).toEqual([]);
      f.publish(3);
    }
    expect(await f.controller.continueDeployment()).toMatchObject({released:true,errors:[]});
    const runtime = f.registry.get(f.task.id)?.runtime;
    expect(runtime?.generation).toBe(selected.generation);
    expect(validateTaskRuntime(runtime!,f.runtime)).toBe(runtime?.cliPath);
    writes.mockRestore();
    f.publish(4);
    await f.controller.tickOnce();
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toContain(runtime!.cliPath);
    expect(f.registry.get(f.task.id)?.runtime).toEqual(runtime);
    expect(readRunState(f.project,f.run.runId).engineCheckpoint).toEqual(f.checkpoint);
  } finally { await f.controller.stop(); }
});

it('refused legacy continuation keeps its hold and cannot acquire a runtime', async()=>{
  const f = legacyRun(), hold = deployment.requestDeploymentHold();
  updateRunState(f.project,f.run.runId,state=>{
    state.deploymentHold={...hold,heldAt:new Date().toISOString()};
    delete state.stages.work;
  });
  try {
    const result = await f.controller.continueDeployment();
    expect(result).toMatchObject({released:false,ready:false});
    expect(result.errors.join('\n')).toContain('missing stage projection');
    expect(f.registry.get(f.task.id)?.runtime).toBeUndefined();
    expect(deployment.deploymentHeld()).toBe(true);
    expect(readRunState(f.project,f.run.runId).deploymentHold?.releasedAt).toBeUndefined();
    expect(f.commands).toEqual([]);
  } finally { await f.controller.stop(); }
});
