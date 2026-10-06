/** Private deployed-daemon trials. No provider, GPU or operator RPC is used. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 as hash, parseReplayArguments } from './engine-principles-inputs.js';
import { createPrivateTrialSupport } from './engine-principles-trial-support.js';

const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Usage: node --import tsx scripts/engine-principles-trial.ts --dist <copied candidate dist> --out <evidence directory>'); process.exit(0); }
const options = parseReplayArguments(args, ['--dist', '--out']);
const dist = resolve(options['--dist']), out = resolve(options['--out']);
const root = mkdtempSync(join(tmpdir(), 'flowcrew-principles-daemon-'));
const storeRoot = join(root, 'store'), socket = join(storeRoot, 'trial.sock'), bin = join(root, 'bin'), home = join(root, 'empty-home');
for (const path of [out, storeRoot, bin, home]) mkdirSync(path, { recursive: true });
const env = { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), FC_HOME: storeRoot, FLOWCREW_DAEMON_SOCKET: socket, PATH: `${bin}:${process.env.PATH}`, EP1_TRIAL_ROOT: root, CODEX_PLUGINS_CACHE: join(root, 'plugins'), CODEX_SKILLS_CACHE: join(root, 'skills') };
Object.assign(process.env, { FC_HOME: storeRoot, FLOWCREW_DAEMON_SOCKET: socket });
const module = (file: string) => import(pathToFileURL(join(dist, file)).href);
const { sendRpc } = await module('orchestrator-rpc.js');
const { inspectBrief, createBriefAdmission } = await module('brief-preflight.js');
const { readRunStateView } = await module('run-state-view.js');
const { reconcileHostInterruptedRun, engineGeneration } = await module('restart-recovery.js');
const { processStartToken } = await module('run-lock.js');
const { extractBriefCriteria } = await module('brief-criteria.js');
const children: ChildProcess[] = [];
const cases: any[] = [];
function write(path: string, content: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
const empty = { version: 1, produces: [], reads: [], groups: [], replays: [] };
function stage(id: string, extra: object = {}): object { return { id, role: 'coder', depends_on: [], dependency_reasons: {}, scope: ['docs/**'], prompt_template: 'Do the declared private fixture work.', artifact_contract: empty, ...extra }; }
const fixtureSource = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('codex private-fixture');process.exit(0)}
const root=process.env.EP1_TRIAL_ROOT;
if(!root||!process.env.CODEX_HOME?.startsWith(root+'/store/runs/')) { console.error('private fixture binding required');process.exit(7); }
const stage=path.basename(path.dirname(process.env.CODEX_HOME)),run=path.resolve(process.env.CODEX_HOME,'../../..'),project=process.cwd();
const write=(p,t)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,t)};
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 const stat=fs.readFileSync('/proc/self/stat','utf8'),token={kind:'linux',value:stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[19]};
 console.log(JSON.stringify({type:'flowcrew_private_fixture',at:new Date().toISOString(),pid:process.pid,token,stage,run,project,inputSha256:require('node:crypto').createHash('sha256').update(input).digest('hex')}));
 const kind=JSON.parse(fs.readFileSync(path.join(project,'fixture.json'))).kind,refs=JSON.parse(fs.readFileSync(path.join(run,'brief_criteria.json'))).criteria.map(c=>c.id);let message='fixture completed',writes=[];
 if(stage==='_supervisor'){message=JSON.stringify({action:'WAIT',reason:'Private deterministic fixture; no semantic intervention required.'});}
 else if(kind==='rolling'&&stage==='first'){
  const state=JSON.parse(fs.readFileSync(path.join(run,'run.json'))),status=JSON.parse(fs.readFileSync(path.join(run,'stages/first/status.json'))),a=status.attempts.at(-1),r=state.queryState.planRevision;
  const extra={id:'extra',role:'coder',scope:['docs/**'],depends_on:['first'],dependency_reasons:{first:'Outcome establishes more work'},criterion_refs:refs,prompt_template:'Produce declared extra output.',artifact_contract:{version:1,produces:[{id:'extra',root:'project',path:'docs/extra.md'}],reads:[],groups:[],replays:[]}};
  const pending=state.planControl.stages.map(s=>s.id==='audit'?{...s,depends_on:['first','extra'],dependency_reasons:{first:'Audit first outcome',extra:'Audit the admitted extra outcome'}}:s);
  write(path.join(run,'stages/first/plan_revision_request.json'),JSON.stringify({version:1,requestId:'append_extra',runId:state.runId,stageId:'first',attemptIndex:a.index,attemptStartedAt:a.startedAt,baseRevision:r.revision,baseDigest:r.digest,reason:'First outcome requires additional work',stages:[...pending,extra]}));
 }else if(kind==='rolling'&&stage==='extra'){write(path.join(project,'docs/extra.md'),'extended plan completed');writes.push('docs/extra.md');}
 else if(kind==='repair'&&stage==='plan'){
  const report={id:'report',role:'coder',scope:['docs/**'],depends_on:[],dependency_reasons:{},criterion_refs:refs,prompt_template:'Produce the declared report.',artifact_contract:{version:1,produces:[{id:'report',root:'project',path:'docs/report.md'}],reads:[],groups:[],replays:[]}};
  const audit={id:'audit',role:'qa',scope:[],depends_on:['report'],dependency_reasons:{report:'Audit report'},criterion_refs:refs,prompt_template:'Audit the declared report.',is_gate:true,artifact_contract:{version:1,produces:[{id:'verdict',root:'run',path:'verdict_audit.json'}],reads:[{id:'report',root:'project',path:'docs/report.md',source:{kind:'stage',stage:'report',artifact:'report'}}],groups:[],replays:[]}};
  write(path.join(run,'dispatch.yaml'),JSON.stringify([report,audit]));
 }else if(kind==='repair'&&stage==='report'){write(path.join(project,'docs/report.md'),'report attribution missing');writes.push('docs/report.md');}
 else if(kind==='repair'&&stage==='audit'){
  const pass=fs.readFileSync(path.join(project,'docs/report.md'),'utf8').includes('attribution repaired');
  write(path.join(run,'verdict_audit.json'),JSON.stringify({pass,reason:pass?'accepted':'missing attribution',criteria:Object.fromEntries(refs.map(id=>[id,{status:pass?'pass':'fail',evidence:'Private file content checked'}])),audit_findings:{version:1,findings:pass?[]:[{id:'attribution',paths:['docs/report.md'],reason:'Add missing attribution.',criterion_ids:refs,invalidates_plan:false,repair_role:'coder'}]}}));
 }else if(kind==='repair'&&stage.startsWith('repair_')){write(path.join(project,'docs/report.md'),'attribution repaired');writes.push('docs/report.md');}
 else if(kind==='restart'&&stage==='completed'){write(path.join(project,'docs/completed.md'),'completed before restart');writes.push('docs/completed.md');}
 else if(kind==='restart'&&stage==='interrupted'){
  if(!fs.existsSync(path.join(root,'allow-restart-completion'))){setInterval(()=>{},1000);return;}
  write(path.join(project,'docs/resumed.md'),'completed after restart');writes.push('docs/resumed.md');
 }else if(stage==='audit'){
  write(path.join(run,'verdict_audit.json'),JSON.stringify({pass:true,reason:'Private deterministic outcomes verified.',criteria:Object.fromEntries(refs.map(id=>[id,{status:'pass',evidence:'Declared outcomes present in private run state'}]))}));
 }
 if(writes.length)console.log(JSON.stringify({type:'item.completed',item:{type:'file_change',changes:writes.map(path=>({path}))}}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:message}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
});
`;
write(join(bin, 'codex'), fixtureSource); writeFileSync(join(bin, 'claude'), fixtureSource); spawnSync('chmod', ['755', join(bin, 'codex'), join(bin, 'claude')]);
for (const name of ['systemd-run', 'systemctl']) { write(join(bin, name), '#!/bin/sh\nexit 1\n'); spawnSync('chmod', ['755', join(bin, name)]); }
function project(kind: string, stages: object[]): string {
  const dir = join(root, `source-${kind}`); mkdirSync(dir);
  write(join(dir, 'fixture.json'), JSON.stringify({ kind }));
  write(join(dir, 'config/defaults.yaml'), JSON.stringify({ adapter: 'codex', default_timeout_ms: 120000, default_stage_technical_retries: 0, default_plan_stage_retries: 0, default_max_iterations: 1, default_gate_retry_loops: 2, supervisor: { poll_interval_ms: 60000 } }));
  for (const name of ['coder', 'planner', 'qa']) write(join(dir, `config/agents/${name}.yaml`), JSON.stringify({ name, description: name, model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Execute only the private deterministic fixture.' }));
  const refs = extractBriefCriteria(brief).criteria.map((entry: any) => entry.id);
  const initial = stages.map((entry: any) => ({ ...entry, criterion_refs: entry.dynamic_dispatch ? [] : refs }));
  if (kind !== 'repair') initial.push(stage('audit', { role: 'qa', scope: [], depends_on: [kind === 'rolling' ? 'first' : 'interrupted'], dependency_reasons: { [kind === 'rolling' ? 'first' : 'interrupted']: 'Audit declared outcomes' }, criterion_refs: refs, is_gate: true, artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_audit.json' }], reads: [{ id: 'state', root: 'run', path: 'run.json', source: { kind: 'framework', artifact: 'run_state' } }], groups: [], replays: [] } }));
  write(join(dir, 'config/workflows/trial.yaml'), JSON.stringify({ name: kind, defaults: { max_iterations: 1 }, stages: initial }));
  write(join(dir, 'Makefile'), 'build:\n\tnode --check fixture-driver.mjs\ntest:\n\tnode --test spec/fixture.test.mjs\nlint:\n\tnode --check fixture-driver.mjs\n');
  write(join(dir, 'fixture-driver.mjs'), "export const fixtureKinds = ['rolling', 'repair', 'restart'];\n");
  write(join(dir, 'spec/fixture.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { fixtureKinds } from '../fixture-driver.mjs'; test('configured fixture is recognized', () => { const fixture = JSON.parse(fs.readFileSync('fixture.json')); assert.ok(fixtureKinds.includes(fixture.kind)); });\n");
  const git = (argv: string[]) => { const r = spawnSync('git', argv, { cwd: dir, encoding: 'utf8', timeout: 5000 }); if (r.status !== 0) throw new Error(`private git ${r.status}: ${r.stderr}`); };
  git(['init', '-q']); git(['add', 'fixture.json', 'config', 'Makefile', 'fixture-driver.mjs', 'spec/fixture.test.mjs']); git(['-c', 'user.name=Private Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'Private fixture baseline']);
  const target = join(root, kind), briefPath = join(root, `${kind}-brief.md`); write(briefPath, brief);
  const setup = spawnSync(process.execPath, [join(dist, 'cli.js'), 'ship-setup', '--brief', briefPath, '--project', dir, '--target', target, '--base', 'HEAD', '--branch', `trial-${kind}`, '--json'], { env, cwd: dir, encoding: 'utf8', timeout: 45000, maxBuffer: 4000000 });
  write(join(out, `setup-${kind}.json`), JSON.stringify({ exitCode: setup.status, signal: setup.signal, stdout: setup.stdout, stderr: setup.stderr, error: setup.error?.message }, null, 2));
  if (setup.status !== 0) throw new Error(`PRIVATE_SETUP_REFUSED: ${kind}; direct exit ${setup.status}; see setup-${kind}.json`);
  return target;
}
const brief = '# Private fixture\n\n## Requirements\n1. The declared workflow stages finish and their evidence is retained.\n';
const admission = createBriefAdmission(inspectBrief(brief), { kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString() });
const { tracked, own, stopOwned, discoverOwned, poll, register, preserve } = createPrivateTrialSupport({
  root, storeRoot, dist, out, socket, brief, admission, processStartToken, sendRpc, readRunStateView, engineGeneration,
});
async function bound(response: any): Promise<string> { return poll('run binding', async () => { const show = await sendRpc(socket, { cmd: 'show', id: response.id, raw: false }); return show.task?.run_id; }); }
async function settled(dir: string, runId: string): Promise<any> { return poll('run completion and scheduler closure', () => { const f = join(storeRoot, 'runs', runId, 'run.json'); if (!existsSync(f)) return; const s = JSON.parse(readFileSync(f, 'utf8')); return ['complete', 'failed', 'aborted', 'stopped', 'incomplete', 'parked'].includes(s.status) && (!s.engineCheckpoint || processStartToken(s.engineCheckpoint.pid) === undefined) ? s : undefined; }); }
let daemon: ChildProcess | undefined;
let error: string | undefined;
try {
  daemon = spawn(process.execPath, [join(dist, 'cli.js'), 'daemon', 'serve', '--socket', socket], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(daemon); own(daemon.pid!, 'private daemon');
  daemon.stdout?.on('data', (data) => appendFileSync(join(out, 'private-daemon.log'), data)); daemon.stderr?.on('data', (data) => appendFileSync(join(out, 'private-daemon.log'), data));
  const identity = await poll('daemon ready', async () => { try { return await sendRpc(socket, { cmd: 'status' }, 500); } catch { return; } });
  write(join(out, 'private-daemon-identity.json'), JSON.stringify(identity, null, 2));
  const rolling = project('rolling', [stage('first')]); const rollingId = await bound(await register(rolling)); const rollingState = await settled(rolling, rollingId);
  cases.push(await preserve('rolling', rolling, rollingId, rollingState));
  if (rollingState.status !== 'complete' || rollingState.queryState?.planHistory?.length !== 2 || rollingState.stages.first.attempts.length !== 1 || rollingState.stages.extra.status !== 'complete') throw new Error('ROLLING_TRIAL_ASSERTION: extension or completed-work preservation failed');
  const repair = project('repair', [stage('plan', { role: 'planner', scope: [], dynamic_dispatch: true })]); const repairId = await bound(await register(repair)); const repairState = await settled(repair, repairId);
  cases.push(await preserve('repair', repair, repairId, repairState));
  const repairStage = repairState.planControl?.stages.find((entry: any) => entry.id.startsWith('repair_'));
  if (repairState.status !== 'complete' || repairState.currentIteration !== 1 || repairState.stages.report.attempts.length !== 1 || JSON.stringify(repairStage?.scope) !== JSON.stringify(['docs/report.md']) || repairState.queryState?.findings?.[0]?.status !== 'resolved') throw new Error('REPAIR_TRIAL_ASSERTION: scoped repair failed');
  const restart = project('restart', [stage('completed', { artifact_contract: { version: 1, produces: [{ id: 'completed', root: 'project', path: 'docs/completed.md' }], reads: [], groups: [], replays: [] } }), stage('interrupted', { depends_on: ['completed'], dependency_reasons: { completed: 'Continue completed work' }, artifact_contract: { version: 1, produces: [{ id: 'resumed', root: 'project', path: 'docs/resumed.md' }], reads: [], groups: [], replays: [] } })]);
  const restartId = await bound(await register(restart));
  const interrupted = await poll('interrupted stage running', () => { const f = join(storeRoot, 'runs', restartId, 'run.json'); if (!existsSync(f)) return; const s = JSON.parse(readFileSync(f, 'utf8')); return s.stages.interrupted?.status === 'running' && s.stages.completed?.status === 'complete' ? s : undefined; });
  const before = await preserve('restart-before', restart, restartId, interrupted); const completedHash = hash(readFileSync(join(restart, 'docs/completed.md'), 'utf8'));
  discoverOwned(); for (const entry of tracked.filter((entry) => entry.label !== 'private daemon')) stopOwned(entry, 'SIGKILL');
  await poll('owned scheduler dead', () => processStartToken(interrupted.engineCheckpoint.pid) === undefined ? true : undefined, 10000);
  const recovered = reconcileHostInterruptedRun(restart, restartId, { currentBootId: 'simulated-new-host-boot', currentGeneration: engineGeneration() });
  write(join(out, 'restart-reconciliation.json'), JSON.stringify({ before, recovered, simulation: 'All owned consumers stopped, then trusted boot-evidence seam supplied a new boot. No operator state was edited.' }, null, 2));
  if (recovered.recovery?.kind !== 'resumable') throw new Error(`RESTART_NOT_RESUMABLE: ${recovered.failureReason}`);
  write(join(root, 'allow-restart-completion'), 'trusted fixture release');
  await register(restart, restartId); const restarted = await settled(restart, restartId);
  // A parked projection remains briefly until the newly launched scheduler claims it.
  if (restarted.status === 'parked') await poll('resumed completion', () => { const s = JSON.parse(readFileSync(join(storeRoot, 'runs', restartId, 'run.json'), 'utf8')); return s.status === 'complete' || s.status === 'failed' ? s : undefined; });
  const finalRestart = restarted.status === 'parked' ? await settled(restart, restartId) : restarted;
  cases.push(await preserve('restart-after', restart, restartId, finalRestart));
  if (finalRestart.status !== 'complete' || finalRestart.currentIteration !== interrupted.currentIteration || finalRestart.maxIterations !== interrupted.maxIterations || finalRestart.stages.completed.attempts.length !== 1 || hash(readFileSync(join(restart, 'docs/completed.md'), 'utf8')) !== completedHash || finalRestart.stages.interrupted.attempts[0].exitCode !== 143) throw new Error('RESTART_TRIAL_ASSERTION: result, completed work, interrupted ledger or budget changed');
} catch (cause) { error = cause instanceof Error ? cause.stack : String(cause); }
finally {
  discoverOwned();
  try { await sendRpc(socket, { cmd: 'stop' }, 1000); } catch { /* owned listener may be gone */ }
  for (const entry of tracked) stopOwned(entry);
  await new Promise((done) => setTimeout(done, 500));
  for (const entry of tracked) stopOwned(entry, 'SIGKILL');
  for (const child of children) if (child.exitCode === null) await Promise.race([new Promise((done) => child.once('exit', done)), new Promise((done) => setTimeout(done, 500))]);
  if (existsSync(storeRoot)) cpSync(storeRoot, join(out, 'trial-private-store'), { recursive: true, dereference: false, filter: (path) => !path.endsWith('.sock') && !path.endsWith('trial.sock') });
  write(join(out, 'trials.json'), JSON.stringify({ version: 1, at: new Date().toISOString(), dist, root, privateSocket: socket, fakeProvider: true, realModelCalls: 0, gpuOperations: 0, operatorMutations: 0, cases, trackedChildren: tracked, error, pass: !error, limits: ['Deterministic local provider executable exercises actual adapter transport; no claim about live provider behavior.', 'Restart is a stopped-child/new-boot-evidence simulation, not a physical host reboot.'] }, null, 2));
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ pass: !error, cases: cases.map(({ label, status, runId }) => ({ label, status, runId })), error }));
process.exitCode = error ? 1 : 0;
