/** Bounded private-daemon recovery publication trials. No provider, GPU or operator RPC is used. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 as hash, parseReplayArguments } from './engine-principles-inputs.js';
import { cancelledContinuationRefused, createPrivateTrialSupport } from './engine-principles-trial-support.js';

const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Usage: node --import tsx scripts/engine-principles-recovery-trial.ts --dist <copied candidate dist> --out <evidence directory>'); process.exit(0); }
const options = parseReplayArguments(args, ['--dist', '--out']);
const dist = resolve(options['--dist']), out = resolve(options['--out']);
const root = mkdtempSync(join(tmpdir(), 'flowcrew-recovery-daemon-'));
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
const cancellationCases: any[] = [];
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
 else if(stage==='completed'){write(path.join(project,'docs/completed.md'),'completed before restart');writes.push('docs/completed.md');}
 else if(stage==='interrupted'){
  if(!fs.existsSync(path.join(root,'allow-'+path.basename(run)))){setInterval(()=>{},1000);return;}
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
function project(label: string, stages: object[]): string {
  const kind = 'restart';
  const dir = join(root, `source-${label}`); mkdirSync(dir);
  write(join(dir, 'fixture.json'), JSON.stringify({ kind }));
  write(join(dir, 'config/defaults.yaml'), JSON.stringify({ adapter: 'codex', default_timeout_ms: 120000, default_stage_technical_retries: 0, default_plan_stage_retries: 0, default_max_iterations: 1, default_gate_retry_loops: 2, supervisor: { poll_interval_ms: 60000 } }));
  for (const name of ['coder', 'planner', 'qa']) write(join(dir, `config/agents/${name}.yaml`), JSON.stringify({ name, description: name, model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Execute only the private deterministic fixture.' }));
  const refs = extractBriefCriteria(brief).criteria.map((entry: any) => entry.id);
  const initial = stages.map((entry: any) => ({ ...entry, criterion_refs: entry.dynamic_dispatch ? [] : refs }));
  initial.push(stage('audit', { role: 'qa', scope: [], depends_on: ['interrupted'], dependency_reasons: { interrupted: 'Audit declared outcomes' }, criterion_refs: refs, is_gate: true, artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_audit.json' }], reads: [{ id: 'state', root: 'run', path: 'run.json', source: { kind: 'framework', artifact: 'run_state' } }], groups: [], replays: [] } }));
  write(join(dir, 'config/workflows/trial.yaml'), JSON.stringify({ name: kind, defaults: { max_iterations: 1 }, stages: initial }));
  write(join(dir, 'Makefile'), 'build:\n\tnode --check fixture-driver.mjs\ntest:\n\tnode --test spec/fixture.test.mjs\nlint:\n\tnode --check fixture-driver.mjs\n');
  write(join(dir, 'fixture-driver.mjs'), "export const fixtureKinds = ['restart'];\n");
  write(join(dir, 'spec/fixture.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { fixtureKinds } from '../fixture-driver.mjs'; test('configured fixture is recognized', () => { const fixture = JSON.parse(fs.readFileSync('fixture.json')); assert.ok(fixtureKinds.includes(fixture.kind)); });\n");
  const git = (argv: string[]) => { const r = spawnSync('git', argv, { cwd: dir, encoding: 'utf8', timeout: 5000 }); if (r.status !== 0) throw new Error(`private git ${r.status}: ${r.stderr}`); };
  git(['init', '-q']); git(['add', 'fixture.json', 'config', 'Makefile', 'fixture-driver.mjs', 'spec/fixture.test.mjs']); git(['-c', 'user.name=Private Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'Private fixture baseline']);
  const target = join(root, label), briefPath = join(root, `${label}-brief.md`); write(briefPath, brief);
  const setup = spawnSync(process.execPath, [join(dist, 'cli.js'), 'ship-setup', '--brief', briefPath, '--project', dir, '--target', target, '--base', 'HEAD', '--branch', `trial-${label}`, '--json'], { env, cwd: dir, encoding: 'utf8', timeout: 45000, maxBuffer: 4000000 });
  write(join(out, `setup-${label}.json`), JSON.stringify({ exitCode: setup.status, signal: setup.signal, stdout: setup.stdout, stderr: setup.stderr, error: setup.error?.message }, null, 2));
  if (setup.status !== 0) throw new Error(`PRIVATE_SETUP_REFUSED: ${label}; direct exit ${setup.status}; see setup-${label}.json`);
  return target;
}
const brief = '# Private fixture\n\n## Requirements\n1. The declared workflow stages finish and their evidence is retained.\n';
const admission = createBriefAdmission(inspectBrief(brief), { kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString() });
const { tracked, own, stopOwned, discoverOwned, poll, register, preserve, fixtureCalls } = createPrivateTrialSupport({
  root, storeRoot, dist, out, socket, brief, admission, processStartToken, sendRpc, readRunStateView, engineGeneration,
});
async function bound(response: any): Promise<string> { return poll('run binding', async () => { const show = await sendRpc(socket, { cmd: 'show', id: response.id, raw: false }); return show.task?.run_id; }); }
async function settled(dir: string, runId: string): Promise<any> { return poll('run completion and scheduler closure', () => { const f = join(storeRoot, 'runs', runId, 'run.json'); if (!existsSync(f)) return; const s = JSON.parse(readFileSync(f, 'utf8')); return ['complete', 'failed', 'stopped', 'incomplete', 'parked'].includes(s.status) && (!s.engineCheckpoint || processStartToken(s.engineCheckpoint.pid) === undefined) ? s : undefined; }); }
const points = ['no_crash', 'stage_ledger', 'run_projection', 'intent', 'pending_ledger', 'pending_projection', 'commit'];
const recoveryChild = `
 import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
 import { join } from 'node:path'; import { pathToFileURL } from 'node:url';
 const [dist, project, fc, runId, point, generation] = process.argv.slice(1);
 const rename = fs.renameSync;
 fs.renameSync = function(from, to) {
  const result = rename(from, to);
  if (point !== 'no_crash' && String(to).endsWith(point.endsWith('ledger') ? '/stages/interrupted/status.json' : '/run.json')) {
   const record = JSON.parse(fs.readFileSync(to, 'utf8'));
   const stage = point.endsWith('ledger') ? record : record.stages.interrupted;
   const interrupted = stage.attempts.at(-1).error?.startsWith('HOST_RESTART_INTERRUPTED:');
   const hit = point === 'intent' ? record.recoveryIntent?.phase === 'prepared' && !interrupted
    : point === 'commit' ? record.recoveryIntent?.phase === 'committed'
    : point.startsWith('pending_') ? stage.status === 'pending' && interrupted
    : stage.status === 'failed' && interrupted;
   if (hit) process.kill(process.pid, 'SIGKILL');
  }
  return result;
 };
 syncBuiltinESMExports();
 const store = await import(pathToFileURL(join(dist, 'store.js'))); store.setFcGlobalDir(fc);
 const recovery = await import(pathToFileURL(join(dist, 'restart-recovery.js')));
 recovery.reconcileHostInterruptedRun(project, runId, { currentBootId: 'simulated-new-host-boot', currentGeneration: generation });
`;
// A second native cancellation process commits at an actual unlocked recovery
// boundary. These are the original audit's constructions, now on real runs.
const cancellationChild = `
 import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
 import { syncBuiltinESMExports } from 'node:module'; import { join } from 'node:path';
 import { pathToFileURL } from 'node:url';
 const [dist, project, fc, runId, point, generation, output] = process.argv.slice(1);
 const directory = join(fc, 'runs', runId), unlink = fs.unlinkSync;
 let acknowledgement;
 function cancel() {
  const source = ${JSON.stringify(`
   import { join } from 'node:path'; import { pathToFileURL } from 'node:url';
   const [dist, project, fc, runId] = process.argv.slice(1);
   const store = await import(pathToFileURL(join(dist, 'store.js'))); store.setFcGlobalDir(fc);
   const { RunCancellationCoordinator } = await import(pathToFileURL(join(dist, 'run-control.js')));
   const coordinator = new RunCancellationCoordinator({ registry: { list: () => [] }, units: { getStatus: async () => ({ kind: 'absent' }), stopUnit: async () => {}, listUnits: async () => [] }, runsDir: join(fc, 'runs') });
   const result = await coordinator.cancelRun(runId);
   console.log(JSON.stringify({ result, state: store.readRunState(project, runId), at: new Date().toISOString() }));
  `)};
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, dist, project, fc, runId], { encoding: 'utf8', timeout: 10000 });
  if (child.status !== 0) throw new Error('NATIVE_CANCELLATION_FAILED: ' + child.stderr);
  acknowledgement = { directExitCode: child.status, ...JSON.parse(child.stdout) };
 }
 fs.unlinkSync = function(file) {
  const result = unlink(file);
  if (!acknowledgement && String(file) === join(directory, '.run-state.lock')) {
   const state = JSON.parse(fs.readFileSync(join(directory, 'run.json'))), stage = state.stages.interrupted;
   const hit = point === 'intent_release' ? state.recoveryIntent?.phase === 'prepared' && stage.status === 'running'
    : point === 'closed_release' ? stage.status === 'failed'
    : point === 'pending_release' ? stage.status === 'pending'
    : point === 'commit_release' ? state.recoveryIntent?.phase === 'committed'
    : point === 'blocked_release' ? state.recovery?.kind === 'blocked' : false;
   if (hit) cancel();
  }
  return result;
 }; syncBuiltinESMExports();
 const store = await import(pathToFileURL(join(dist, 'store.js'))); store.setFcGlobalDir(fc);
 const recovery = await import(pathToFileURL(join(dist, 'restart-recovery.js')));
 if (point === 'before_entry') cancel();
 let error;
 try { recovery.reconcileHostInterruptedRun(project, runId, { currentBootId: 'simulated-new-host-boot', currentGeneration: point === 'blocked_release' ? 'different-generation' : generation }); } catch (cause) { error = cause.message; }
 fs.writeFileSync(output, JSON.stringify({ point, acknowledgement, error, final: store.readRunState(project, runId) }, null, 2));
`;
let daemon: ChildProcess | undefined;
let error: string | undefined;
async function startDaemon(): Promise<void> {
 daemon = spawn(process.execPath, [join(dist, 'cli.js'), 'daemon', 'serve', '--socket', socket], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
 children.push(daemon); own(daemon.pid!, 'private daemon');
 daemon.stdout?.on('data', data => appendFileSync(join(out, 'private-daemon.log'), data));
 daemon.stderr?.on('data', data => appendFileSync(join(out, 'private-daemon.log'), data));
 const identity = await poll('daemon ready', async () => { try { return await sendRpc(socket, { cmd: 'status' }, 500); } catch { return; } });
 write(join(out, `daemon-identity-${children.length}.json`), JSON.stringify(identity, null, 2));
}
async function stopDaemon(): Promise<void> {
 if (!daemon) return;
 const child = daemon;
 await sendRpc(socket, { cmd: 'stop' }, 1000);
 await poll('owned daemon stopped', () => child.exitCode !== null ? true : undefined, 10000);
}
try {
 await startDaemon();
 for (const point of points) {
  const target = project(point, [stage('completed', { artifact_contract: { version: 1, produces: [{ id: 'completed', root: 'project', path: 'docs/completed.md' }], reads: [], groups: [], replays: [] } }), stage('interrupted', { depends_on: ['completed'], dependency_reasons: { completed: 'Continue completed work' }, artifact_contract: { version: 1, produces: [{ id: 'resumed', root: 'project', path: 'docs/resumed.md' }], reads: [], groups: [], replays: [] } })]);
  const runId = await bound(await register(target));
  const before = await poll('interrupted work and deterministic provider running', () => {
   const file = join(storeRoot, 'runs', runId, 'run.json'); if (!existsSync(file)) return;
   const state = JSON.parse(readFileSync(file, 'utf8'));
   const provider = fixtureCalls().some(call => call.run === join(storeRoot, 'runs', runId) && call.stage === 'interrupted');
   return state.stages.interrupted?.status === 'running' && state.stages.completed?.status === 'complete' && provider ? state : undefined;
  });
  await preserve(`${point}-before`, target, runId, before);
  const completedHash = hash(readFileSync(join(target, 'docs/completed.md'), 'utf8'));
  await stopDaemon(); // Stops only scheduling; consumers are killed by their recorded identities below.
  discoverOwned();
  for (const entry of tracked.filter(entry => entry.label !== 'private daemon')) stopOwned(entry, 'SIGKILL');
  await poll('all owned consumers stopped', () => tracked.filter(entry => entry.label !== 'private daemon').every(entry => !entry.token || JSON.stringify(processStartToken(entry.pid)) !== JSON.stringify(entry.token)) ? true : undefined, 10000);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', recoveryChild, dist, target, storeRoot, runId, point, engineGeneration()], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  const childReceipt = { exitCode: child.status, signal: child.signal, error: child.error?.message, stderr: child.stderr };
  write(join(out, `recovery-child-${point}.json`), JSON.stringify(childReceipt, null, 2));
  if (child.error || (point === 'no_crash' ? child.status !== 0 : child.signal !== 'SIGKILL')) throw new Error(`RECOVERY_CRASH_NOT_REACHED: ${point}; ${JSON.stringify(childReceipt)}`);
  const intermediate = await preserve(`${point}-publication`, target, runId, JSON.parse(readFileSync(join(storeRoot, 'runs', runId, 'run.json'), 'utf8')));
  const recovered = reconcileHostInterruptedRun(target, runId, { currentBootId: 'simulated-new-host-boot-again', currentGeneration: engineGeneration() });
  write(join(out, `reconciliation-${point}.json`), JSON.stringify(recovered, null, 2));
  if (recovered.recovery?.kind !== 'resumable' || recovered.stages.interrupted.status !== 'pending' || recovered.stages.interrupted.attempts.length !== 1 || recovered.stages.interrupted.attempts[0].exitCode !== 143) throw new Error(`RECOVERY_NOT_RUNNABLE: ${point}`);
  const runnable = await preserve(`${point}-runnable`, target, runId, recovered);
  write(join(root, 'allow-' + runId), 'Trusted deterministic fixture release');
  await startDaemon();
  await register(target, runId);
  const result = await poll('same-run resumed completion and scheduler closure', () => {
   const state = JSON.parse(readFileSync(join(storeRoot, 'runs', runId, 'run.json'), 'utf8'));
   return ['complete', 'failed', 'stopped'].includes(state.status) && processStartToken(state.engineCheckpoint.pid) === undefined ? state : undefined;
  });
  const final = await preserve(`${point}-after`, target, runId, result);
  if (result.status !== 'complete' || result.currentIteration !== before.currentIteration || result.maxIterations !== before.maxIterations || result.maxRetries !== before.maxRetries || result.stages.completed.attempts.length !== 1 || result.stages.interrupted.attempts.length !== 2 || result.stages.interrupted.attempts[0].exitCode !== 143 || hash(readFileSync(join(target, 'docs/completed.md'), 'utf8')) !== completedHash || final.fixtureCalls.filter((call: any) => call.stage === 'completed').length !== 1 || final.fixtureCalls.filter((call: any) => call.stage === 'interrupted').length !== 2 || JSON.stringify(result.queryState.planHistory) !== JSON.stringify(before.queryState.planHistory)) throw new Error(`RECOVERY_CONTINUATION_CHANGED: ${point}`);
  const view = readRunStateView(target, runId, { includePromptText: true });
  const modelInputs = view.prompts.invocations.filter((input: any) => input.record?.boundary === 'model').map((input: any) => {
   const transport = input.record.transport;
   const request = JSON.parse(transport.payload);
   if (input.integrity !== 'verified' || input.attemptBinding !== 'matched' || hash(transport.payload) !== transport.sha256 || typeof request.stdin !== 'string') throw new Error(`RECOVERY_TRANSPORT_UNBOUND: ${point}`);
   return { stageId: input.record.stageId, attemptIndex: input.record.attemptIndex, stdinSha256: hash(request.stdin), requestSha256: transport.sha256 };
  });
  const inputBindings = final.fixtureCalls.map((call: any) => {
   const matches = modelInputs.filter((input: any) => input.stageId === call.stage && input.stdinSha256 === call.inputSha256);
   return { stageId: call.stage, suppliedInputSha256: call.inputSha256, matches: matches.length, modelInputs: matches };
  });
  if (inputBindings.some((binding: any) => binding.matches !== 1)) throw new Error(`RECOVERY_EXACT_INPUT_UNBOUND: ${point}`);
  cases.push({ point, child: childReceipt, intermediate, runnable, final, inputBindings, pass: true });
 }
 for (const point of ['before_entry', 'intent_release', 'closed_release', 'pending_release', 'commit_release', 'blocked_release']) {
  const label = `cancel-${point}`;
  const target = project(label, [stage('completed', { artifact_contract: { version: 1, produces: [{ id: 'completed', root: 'project', path: 'docs/completed.md' }], reads: [], groups: [], replays: [] } }), stage('interrupted', { depends_on: ['completed'], dependency_reasons: { completed: 'Continue completed work' }, artifact_contract: { version: 1, produces: [{ id: 'resumed', root: 'project', path: 'docs/resumed.md' }], reads: [], groups: [], replays: [] } })]);
  const runId = await bound(await register(target));
  const before = await poll('private cancellation trial executing interrupted work', () => {
   const file = join(storeRoot, 'runs', runId, 'run.json'); if (!existsSync(file)) return;
   const state = JSON.parse(readFileSync(file, 'utf8'));
   const provider = fixtureCalls().some(call => call.run === join(storeRoot, 'runs', runId) && call.stage === 'interrupted');
   return state.stages.interrupted?.status === 'running' && state.stages.completed?.status === 'complete' && provider ? state : undefined;
  });
  const prior = await preserve(`${label}-before`, target, runId, before);
  await stopDaemon(); discoverOwned();
  for (const entry of tracked.filter(entry => entry.label !== 'private daemon')) stopOwned(entry, 'SIGKILL');
  await poll('private cancellation consumers stopped', () => tracked.filter(entry => entry.label !== 'private daemon').every(entry => !entry.token || JSON.stringify(processStartToken(entry.pid)) !== JSON.stringify(entry.token)) ? true : undefined, 10000);
  const receiptPath = join(out, `cancellation-child-${point}.json`);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', cancellationChild, dist, target, storeRoot, runId, point, engineGeneration(), receiptPath], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  if (child.status !== 0 || child.error) throw new Error(`PRIVATE_CANCELLATION_CHILD_FAILED: ${point}; ${child.stderr}`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.acknowledgement?.directExitCode !== 0 || receipt.acknowledgement.result.status !== 'cancelled' || receipt.final.status !== 'stopped' || JSON.stringify(receipt.final) !== JSON.stringify(receipt.acknowledgement.state)) throw new Error(`PRIVATE_CANCELLATION_OVERWRITTEN: ${point}`);
  const cancelled = await preserve(`${label}-cancelled`, target, runId, receipt.final);
  const stoppedBytes = readFileSync(join(storeRoot, 'runs', runId, 'run.json'), 'utf8');
  const repeated = reconcileHostInterruptedRun(target, runId, { currentBootId: 'simulated-new-host-boot-again', currentGeneration: engineGeneration() });
  if (repeated.status !== 'stopped' || stoppedBytes !== readFileSync(join(storeRoot, 'runs', runId, 'run.json'), 'utf8')) throw new Error(`PRIVATE_REPEATED_RECOVERY_REVIVED: ${point}`);
  write(join(root, 'allow-' + runId), 'A cancelled run must ignore this release');
  await startDaemon();
  const request = await register(target, runId);
  const continuation = await poll('daemon refuses cancelled same-run continuation', async () => {
   const response = await sendRpc(socket, { cmd: 'show', id: request.id, raw: false });
   return cancelledContinuationRefused(response, runId) ? response : undefined;
  });
  const finalState = JSON.parse(readFileSync(join(storeRoot, 'runs', runId, 'run.json'), 'utf8'));
  const final = await preserve(`${label}-after`, target, runId, finalState);
  if (finalState.status !== 'stopped' || finalState.completedAt !== receipt.final.completedAt || finalState.failureReason !== 'Cancelled by user' || stoppedBytes !== readFileSync(join(storeRoot, 'runs', runId, 'run.json'), 'utf8') || final.fixtureCalls.length !== prior.fixtureCalls.length || existsSync(join(target, 'docs/resumed.md')) || JSON.stringify(finalState.queryState.planHistory) !== JSON.stringify(before.queryState.planHistory) || finalState.currentIteration !== before.currentIteration || finalState.maxIterations !== before.maxIterations || finalState.maxRetries !== before.maxRetries) throw new Error(`PRIVATE_CANCELLED_CONTINUATION_EXECUTED: ${point}`);
  cancellationCases.push({ point, child: { directExitCode: child.status, signal: child.signal }, acknowledgement: receipt.acknowledgement, prior, cancelled, final, continuation, noNewWork: true, repeatUnchanged: true, pass: true });
 }
} catch (cause) { error = cause instanceof Error ? cause.stack : String(cause); }
finally {
 discoverOwned();
 try { await sendRpc(socket, { cmd: 'stop' }, 1000); } catch { /* owned listener may be gone */ }
 for (const entry of tracked) stopOwned(entry);
 await new Promise(done => setTimeout(done, 500));
 for (const entry of tracked) stopOwned(entry, 'SIGKILL');
 for (const child of children) if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 1000))]);
 const alive = tracked.filter(entry => entry.token && JSON.stringify(processStartToken(entry.pid)) === JSON.stringify(entry.token));
 if (alive.length) error = `${error ?? ''} OWNED_CHILD_CLEANUP_FAILED: ${JSON.stringify(alive)}`;
 if (existsSync(storeRoot)) cpSync(storeRoot, join(out, 'trial-private-store'), { recursive: true, dereference: false, filter: path => !path.endsWith('.sock') });
 write(join(out, 'trials.json'), JSON.stringify({ version: 1, at: new Date().toISOString(), dist, generation: engineGeneration(), root, privateSocket: socket, fakeProvider: true, realModelCalls: 0, gpuOperations: 0, operatorMutations: 0, cases, cancellationCases, trackedChildren: tracked, aliveAfterCleanup: alive, error, pass: !error, limits: ['Actual private daemon/scheduler/adapter transport with deterministic fixture executables; no live provider claim.', 'Owned consumers are stopped, then trusted new-boot evidence is supplied; not a physical reboot/all service-manager paths.'] }, null, 2));
 rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ pass: !error, cases: cases.map(({ point, pass }) => ({ point, pass })), cancellationCases: cancellationCases.map(({ point, pass }) => ({ point, pass })), error }));
process.exitCode = error ? 1 : 0;
