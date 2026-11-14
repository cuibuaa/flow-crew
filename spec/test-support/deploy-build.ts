import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createBuildManifest, publishBuildOutputs } from '../../src/build-manifest.js';

// Test-only synchronous event barrier. It blocks even a synchronous admission
// call without a clock deciding when work may advance. The helper announces
// its own identity so failure cleanup can retire every process it created.
const waitScript = `
 const fs = require('node:fs'), path = require('node:path');
 const [root, seam, owner] = process.argv.slice(1);
 const release = path.join(root, 'release');
 const watcher = fs.watch(root, check);
 fs.writeFileSync(path.join(root, 'entered'), JSON.stringify({seam, pid: Number(owner), helper: process.pid}));
 function check() { if (fs.existsSync(release)) { watcher.close(); process.exit(0); } }
 check();
`;
const barrier = `
import { spawnSync as fixtureSpawnSync } from 'node:child_process';
import { existsSync as fixtureExists } from 'node:fs';
function fixtureBarrier(seam) {
 const root = process.env.DEPLOY_FIXTURE_BARRIER;
 if (!root || process.env.DEPLOY_FIXTURE_SEAM !== seam || fixtureExists(root + '/entered')) return;
 const result = fixtureSpawnSync(process.execPath, ['-e', ${JSON.stringify(waitScript)}, root, seam, String(process.pid)], {stdio: 'inherit'});
 if (result.status !== 0) throw new Error('fixture barrier failed');
}
`;

const controlBarrier = `
import { watch as fixtureWatch, existsSync as fixtureControlExists, writeFileSync as fixtureWrite, readFileSync as fixtureRead } from 'node:fs';
async function fixtureControlBarrier(seam) {
 const root = process.env.DEPLOY_FIXTURE_CONTROL;
 if (!root || process.env.DEPLOY_FIXTURE_CONTROL_SEAM !== seam || fixtureControlExists(root + '/entered')) return;
 await new Promise(resolve => {
   const watcher = fixtureWatch(root, check);
   fixtureWrite(root + '/entered', JSON.stringify({seam,pid:process.pid}));
   function check() { if (fixtureControlExists(root + '/release')) {watcher.close();resolve();} }
   check();
 });
}
`;

// The daemon uses its real register/reservation/command/supervision entrance.
// Only quick's user I/O and the provider are fixture adapters; the scheduler,
// worker, validation, settlement and plan admission are production code.
const cli = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'daemon') {
 process.exitCode = await (await import('./cli-daemon.js')).cmdDaemon(args);
} else {
 const value = key => args[args.indexOf(key) + 1];
 const project = value('--project'), run = value('--existing-run-id');
 const receipt = JSON.parse(Buffer.from(value('--brief-admission-record'), 'base64url').toString());
 const { runWorkflow, WorkflowConfigSchema } = await import('./scheduler.js');
 const { ScriptedAdapter } = await import('./adapters/scripted.js');
 const { stringify } = await import('yaml');
 const stage = (id, extra = {}) => ({id, role: 'coder', scope: [], artifact_contract: {version:1,produces:[],reads:[]}, ...extra});
 const dispatch = [stage('work', {criterion_refs:['keep']}), stage('review', {is_gate:true, depends_on:['work'], criterion_refs:['keep'],
   artifact_contract:{version:1,produces:[{id:'verdict',root:'run',path:'work/verdict_review.json'}],reads:[]}}),
   stage('repair', {depends_on:['review'],retry_to:['review']})];
 const workflow = WorkflowConfigSchema.parse({name:'deployment', defaults:{max_iterations:1,max_retries:0}, stages:[stage('plan',{dynamic_dispatch:true})]});
 const adapter = new ScriptedAdapter({
   plan:{output:'Proposed graph.',runFiles:{'dispatch.yaml':stringify(dispatch)}},
   work:{output:'Work complete.'},
   review:{output:'Independent review.',runFiles:{'verdict_review.json':JSON.stringify({pass:true,reason:'Inspected surviving work.',criteria:{keep:{status:'pass',evidence:'Same task and result inspected.'}},audit_findings:{version:1,findings:[]}})}}
 });
 writeFileSync(join(process.env.DEPLOY_FIXTURE_BARRIER,'task'),String(process.pid));
 const state = await runWorkflow(workflow,stringify(workflow),project,adapter,new Map(),undefined,join(import.meta.dirname,'../config/agents'),run,receipt.contract.brief,true,undefined,receipt);
 // Exercise a fresh import and resource read after both deployments.
 const late = await import('./late.js');
 const resource = readFileSync(join(import.meta.dirname,'../guide/runtime.txt'),'utf8');
 const dependency = (await import('fixture-dependency')).value;
 writeFileSync(join(process.env.DEPLOY_FIXTURE_BARRIER,'finished'),JSON.stringify({pid:process.pid,run:state.runId,status:state.status,late:late.value,resource,dependency}));
 process.exitCode = ['complete','shipped'].includes(state.status) ? 0 : 1;
}
`;

export function deployBuild(root: string, sourceRoot = resolve('.'), publication = {createBuildManifest, publishBuildOutputs}) {
  const engine = join(root, 'e'), staged = join(root, 's');
  mkdirSync(engine, { recursive: true });
  for (const name of ['src', 'config']) cpSync(join(sourceRoot, name), join(engine, name), { recursive: true });
  cpSync(join(sourceRoot, 'dist'), staged, { recursive: true });
  // The fixture is backend-only, and retains exactly the dependencies it uses.
  writeFileSync(join(engine, 'package.json'), '{"type":"module"}');
  writeFileSync(join(engine, 'tsconfig.json'), '{}');
  mkdirSync(join(engine, 'node_modules'), { recursive: true });
  const installedModules = dirname(dirname(createRequire(join(sourceRoot, 'package.json')).resolve('yaml/package.json')));
  const dependencies = new Set<string>();
  const visit = (name: string) => {
    if (dependencies.has(name)) return;
    dependencies.add(name);
    const path = join(installedModules, name);
    mkdirSync(join(engine, 'node_modules', name, '..'), { recursive: true });
    symlinkSync(path, join(engine, 'node_modules', name));
    const metadata = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    for (const child of Object.keys(metadata.dependencies ?? {})) visit(child);
  };
  for (const name of Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies)) visit(name);
  const fixtureDependency = join(engine, 'node_modules', 'fixture-dependency');
  mkdirSync(fixtureDependency);
  writeFileSync(join(fixtureDependency, 'package.json'), '{"type":"module","main":"index.js"}');
  mkdirSync(join(engine, 'guide'));
  writeFileSync(join(engine, 'src/late.ts'), 'export const value = 1;');
  writeFileSync(join(staged, 'late.d.ts'), 'export declare const value: number;');
  writeFileSync(join(staged, 'cli.js'), cli);
  const inject = (file: string, before: string, seam: string, condition = '') => {
    const path = join(staged, file), text = readFileSync(path, 'utf8');
    if (!text.includes(before)) throw new Error(`Fixture hook moved: ${file}: ${before}`);
    writeFileSync(path, barrier + text.replace(before, `${before}\n${condition} fixtureBarrier('${seam}');`));
  };
  inject('adapters/scripted.js', 'async run(prompt, _role, opts) {', 'model', "if (opts.stageId === 'work')");
  inject('worker.js', "await opts.settlementBoundary?.('attempt_closed');", 'settlement', "if (opts.stageId === 'work')");
  inject('scheduler/sched_admission/dispatch.js', 'const errors = [];', 'admission');
  // Make observation event-driven in the fixture; production's timer is merely
  // a producer. No test infers passage from an interval having elapsed.
  const orchestrator = join(staged, 'orchestrator.js');
  let control = readFileSync(orchestrator, 'utf8').replace('opts.intervalMs ?? 30000', 'opts.intervalMs ?? 20');
  for (const [marker,seam] of [
    ['task = prepared;', 'reservation'],
    ['atomicWriteJson(paths.launch, launch, { mode: 0o600 });','launch-record'],
    ['child.unref();','launch-ack'],
    ['async findCommitByPrefix(projectDir, prefix) {','git'],
  ]) {
    if (!control.includes(marker)) throw new Error(`Control fixture hook moved: ${marker}`);
    control = control.replace(marker,`${marker}\nawait fixtureControlBarrier('${seam}');`);
  }
  writeFileSync(orchestrator, controlBarrier + control);
  // All transports remain private stubs. A successful send records a receipt,
  // never a business ACK, so duplicate delivery would be visible in this log.
  writeFileSync(join(staged, 'session-push-transport.js'), controlBarrier + `
import { appendFileSync } from 'node:fs';
export async function queueCodex(session, text, home, event) { appendFileSync(process.env.DEPLOY_FIXTURE_SENDS, JSON.stringify({session,text,pid:process.pid,eventId:event?.eventId,kind:event?.kind})+'\\n'); if(event?.kind === 'operator_wrap_up_required') await fixtureControlBarrier('send'); return 'fixture-receipt'; }
export async function codexRequest() { return {}; }
export async function sendClaude() { throw new Error('unused transport'); }
export async function notifyFallback() { throw new Error('unused notification'); }
`);
  const push = join(staged,'session-push.js');
  const pushSource=readFileSync(push,'utf8');
  const queueMarker='this.queue(target.sessionId, human, target.codexHome)';
  if (!pushSource.includes(queueMarker)) throw new Error('Structured send fixture hook moved');
  writeFileSync(push, controlBarrier + pushSource.replace('dependencies.now ?? Date.now',
    "dependencies.now ?? (() => {const path=process.env.DEPLOY_FIXTURE_CONTROL + '/clock'; return fixtureControlExists(path) ? Number(fixtureRead(path,'utf8')) : Date.now();})")
    .replace(queueMarker,'this.queue(target.sessionId, human, target.codexHome, {eventId:event.eventId,kind:event.kind})'));
  return {
    engine, staged,
    publish(value: number) {
      writeFileSync(join(engine, 'src/late.ts'), `export const value = ${value};`);
      writeFileSync(join(staged, 'late.js'), `export const value = ${value};`);
      writeFileSync(join(engine, 'guide/runtime.txt'), String(value));
      writeFileSync(join(fixtureDependency, 'index.js'), `export const value = ${value};`);
      return publication.publishBuildOutputs({projectRoot: engine, stagedDistDir: staged,
        manifest: publication.createBuildManifest(engine, staged)});
    },
  };
}

/** A real engine-owned validation command, held on a filesystem event. */
export function validationBarrierCommand(barrier: string) {
  const file = join(barrier,'validation.mjs');
  writeFileSync(file, `import {watch,existsSync,readFileSync,writeFileSync} from 'node:fs';
const root=${JSON.stringify(barrier)};
if (!existsSync(root+'/entered')) {
 await new Promise(resolve=>{
  const watcher=watch(root,check);
  writeFileSync(root+'/entered',JSON.stringify({seam:'validation',pid:Number(readFileSync(root+'/task','utf8')),helper:process.pid}));
  function check(){if(existsSync(root+'/release')){watcher.close();resolve();}} check();
 });
}`);
  return {role:'build' as const,command:process.execPath,args:[file],display:'fixture validation barrier'};
}

export function installValidationBarrier(setupPath: string, barrier: string) {
  const setup=JSON.parse(readFileSync(setupPath,'utf8'));
  const command=validationBarrierCommand(barrier);
  setup.validationBaseline.discovery.commands=[command];
  setup.validationBaseline.results=[{...command,state:'passed',exitCode:0,durationMs:0,output:'',failureIdentifiers:[],failureIdentity:'none'}];
  writeFileSync(setupPath,JSON.stringify(setup));
}
