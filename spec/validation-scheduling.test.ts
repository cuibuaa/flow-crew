import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { processLiveness, processStartToken } from '../src/process-liveness.js';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fcGlobalDir } from '../src/store.js';

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(done => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('exit', () => done()); child.kill('SIGTERM');
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() { const path = mkdtempSync(join(tmpdir(), 'validation-scheduling-')); roots.push(path); return path; }
function fixture() {
  const project = root();
  writeFileSync(join(project, 'check.cjs'), "require('node:fs').appendFileSync('executions','x');process.exit(0);");
  return { projectDir: project, treeHash: createHash('sha256').update(project).digest('hex'),
    commands: [{ role: 'test', command: process.execPath, args: ['check.cjs'], display: 'chosen zero' }] };
}
function controller(input: ReturnType<typeof fixture>) {
  const directory = root(), path = join(directory, 'controller.mjs');
  writeFileSync(path, `
import { engineValidation } from ${JSON.stringify(pathToFileURL(resolve('src/engine-validation.ts')).href)};
import { runProjectCommand } from ${JSON.stringify(pathToFileURL(resolve('src/project-validation.ts')).href)};
import { reserveRun, initializeReservedRun, updateRunState, runDir } from ${JSON.stringify(pathToFileURL(resolve('src/store.ts')).href)};
import { captureEngineCheckpoint } from ${JSON.stringify(pathToFileURL(resolve('src/restart-recovery.ts')).href)};
import { withRunProcessOwnership } from ${JSON.stringify(pathToFileURL(resolve('src/adapters/base.ts')).href)};
const input = JSON.parse(process.argv[2]);
const {runId} = reserveRun(input.projectDir);
initializeReservedRun(input.projectDir,runId,'probe','name: probe\\nstages: []\\n',[]);
updateRunState(input.projectDir,runId,state=>{state.status='running';state.engineCheckpoint=captureEngineCheckpoint(input.projectDir,runId)});
const request = withRunProcessOwnership(input.projectDir,runId,()=>engineValidation({...input, run:{projectDir:input.projectDir,runId}, treeAfter:()=>input.treeHash, runCommand: async command=>{
  process.send({type:'entered'});
  await new Promise(resolve=>process.once('message',resolve));
  return runProjectCommand(command);
}}));
process.send({type:'requested', directory: runDir(input.projectDir,runId)});
const result = await request;
process.send({type:'complete', result});
process.disconnect();
`);
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path, JSON.stringify(input)], {
    cwd: directory, env: { ...process.env, HOME: directory, FC_HOME: fcGlobalDir() }, timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  const messages: Array<{ type: string; directory?: string; result?: { resourceState: string; executions: unknown[] } }> = [];
  let diagnostic = '';
  child.stderr!.on('data', bytes => { diagnostic += bytes; });
  child.on('message', value => messages.push(value as typeof messages[number]));
  const wait = (type: string): Promise<typeof messages[number]> => {
    const prior = messages.find(value => value.type === type);
    if (prior) return Promise.resolve(prior);
    return new Promise((yes, no) => {
      const exited = () => { cleanup(); no(Error(`Controller exited ${child.exitCode ?? child.signalCode} before ${type}: ${diagnostic}`)); };
      const message = (value: unknown) => { if ((value as typeof messages[number]).type === type) { cleanup(); yes(value as typeof messages[number]); } };
      const cleanup = () => { child.off('exit', exited); child.off('message', message); };
      child.on('message', message); child.once('exit', exited);
    });
  };
  const exit = new Promise<void>(yes => child.once('exit', () => yes()));
  return { child, messages, wait, exit, release: () => child.send('release') };
}

describe('shared-daemon validation scheduling across scheduler processes', () => {
  it('unfinished-is-resource-state: a native cancellation returns its result after retiring the command owner', async () => {
    const directory = root(), ready = join(directory, 'ready'), path = join(directory, 'abort.mjs');
    const program = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
    writeFileSync(path, `
import {runProjectCommand} from ${JSON.stringify(pathToFileURL(resolve('src/project-validation.ts')).href)};
import {existsSync} from 'node:fs';
const control=new AbortController();
const poll=setInterval(()=>{if(existsSync(${JSON.stringify(ready)})){clearInterval(poll);control.abort();}},10);
const result=await runProjectCommand({role:'test',command:process.execPath,args:['-e',${JSON.stringify(program)}],
  display:'chosen interruption',cwd:${JSON.stringify(directory)},timeoutMs:30000,abortSignal:control.signal});
console.log(JSON.stringify({returned:true,exitCode:result.exitCode,unfinished:result.unfinished}));
`);
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path], {
      cwd: directory, env: { ...process.env, HOME: directory, FC_HOME: fcGlobalDir() }, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout!.on('data', bytes => { stdout += bytes; }); child.stderr!.on('data', bytes => { stderr += bytes; });
    const closed = new Promise<number | null>(yes => child.once('close', yes));
    try {
      expect(await closed, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ returned: true, exitCode: null, unfinished: true });
      expect(existsSync(ready)).toBe(true);
      expect(processLiveness(Number(readFileSync(ready, 'utf8')))).toBe('dead');
    } finally {
      if (existsSync(ready)) {
        const pid = Number(readFileSync(ready, 'utf8'));
        if (processLiveness(pid) === 'alive') process.kill(pid, 'SIGKILL');
      }
    }
  });

  it.skipIf(process.platform !== 'linux').each(['inherit', 'ignore'])('retains detached workers after command-leader and controller death (stdio=%s)', async stdio => {
    const a = fixture(), b = fixture(), socket = join(realpathSync(root()), 'detached.sock');
    let worker = 0, token: ReturnType<typeof processStartToken>, directory = '';
    let ready!: () => void;
    const workerReady = new Promise<void>(yes => { ready = yes; });
    const server = createServer(connection => connection.once('data', bytes => { worker = Number(bytes.toString()); ready(); }));
    await new Promise<void>(yes => server.listen(socket, yes));
    const program = `const c=require('node:net').createConnection(${JSON.stringify(socket)},()=>c.end(String(process.pid)));setInterval(()=>{},1000);`;
    writeFileSync(join(a.projectDir, 'check.cjs'), `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(program)}],{detached:true,stdio:${JSON.stringify(stdio)}}).unref();${stdio === 'ignore' ? 'setInterval(()=>{},1000);' : ''}`);
    try {
      const first = controller(a); await first.wait('entered');
      directory = (await first.wait('requested')).directory!; first.release(); await workerReady;
      token = processStartToken(worker); expect(processLiveness(worker, token)).toBe('alive');
      let leader: { pid: number; processStart: ReturnType<typeof processStartToken> };
      do {
        leader = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8')).engineCheckpoint.processes[0];
        if (stdio === 'ignore' || processLiveness(leader.pid, leader.processStart) === 'dead') break;
        await delay(25);
      } while (true);
      first.child.kill('SIGTERM'); await first.exit;
      expect(processLiveness(worker, token)).toBe('alive');
      const second = controller(b); await second.wait('entered');
      expect(processLiveness(worker, token)).toBe('dead');
      expect(processLiveness(leader.pid, leader.processStart)).toBe('dead');
      second.release(); await second.wait('complete'); await second.exit;
    } finally {
      server.close();
      if (worker && processLiveness(worker, token) === 'alive') process.kill(worker, 'SIGKILL');
      if (directory) for (const consumer of JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8')).engineCheckpoint.processes) {
        if (consumer.supervised && processLiveness(consumer.pid, consumer.processStart) === 'alive') process.kill(consumer.pid, 'SIGTERM');
      }
    }
  });
  it('enforces the shared FIFO and reuses completion after controller restart', async () => {
    const a = fixture(), b = fixture(), first = controller(a);
    await first.wait('entered');
    const second = controller(b); await second.wait('requested');
    expect(second.messages.some(value => value.type === 'entered')).toBe(false);
    first.release(); await first.wait('complete'); await first.exit;
    await second.wait('entered'); second.release(); await second.wait('complete'); await second.exit;
    const restarted = controller(a); const cached = await restarted.wait('complete'); await restarted.exit;
    expect(restarted.messages.some(value => value.type === 'entered')).toBe(false);
    expect(cached.result?.resourceState).toBe('complete'); expect(cached.result?.executions).toHaveLength(1);
    expect(readFileSync(join(a.projectDir, 'executions'), 'utf8')).toBe('x');
    expect(readFileSync(join(b.projectDir, 'executions'), 'utf8')).toBe('x');
  });

  it('keeps a dead controller slot until its actual checkpoint-owned validation process retires', async () => {
    const a = fixture(), b = fixture();
    const socket = join(realpathSync(root()), 'ready.sock');
    let commandPid = 0;
    let ready!: () => void;
    const commandReady = new Promise<void>(yes => { ready = yes; });
    const server = createServer(connection => connection.once('data', bytes => { commandPid = Number(bytes.toString()); ready(); }));
    await new Promise<void>(yes => server.listen(socket, yes));
    writeFileSync(join(a.projectDir, 'check.cjs'), `const net=require('node:net');const client=net.createConnection(${JSON.stringify(socket)},()=>client.end(String(process.pid)));setInterval(()=>{},1000);`);
    try {
      const first = controller(a); await first.wait('entered'); first.release(); await commandReady;
      const token = processStartToken(commandPid)!;
      expect(processLiveness(commandPid, token)).toBe('alive');
      const second = controller(b); await second.wait('requested');
      first.child.kill('SIGTERM'); await first.exit;
      await second.wait('entered');
      expect(processLiveness(commandPid, token)).toBe('dead');
      second.release(); await second.wait('complete'); await second.exit;
    } finally {
      server.close();
      if (commandPid && processLiveness(commandPid) === 'alive') process.kill(commandPid, 'SIGKILL');
    }
  });

  it('releases dead active and queued controllers and preserves the resource attempt on resume', async () => {
    const a = fixture(), b = fixture(), c = fixture();
    const first = controller(a); await first.wait('entered');
    const cancelled = controller(b); await cancelled.wait('requested');
    const survivor = controller(c); await survivor.wait('requested');
    cancelled.child.kill('SIGTERM'); await cancelled.exit;
    first.child.kill('SIGTERM'); await first.exit;
    await survivor.wait('entered'); survivor.release(); await survivor.wait('complete'); await survivor.exit;
    const resumed = controller(a); await resumed.wait('entered'); resumed.release();
    const completed = await resumed.wait('complete'); await resumed.exit;
    expect(completed.result?.executions).toHaveLength(2);
    expect(completed.result?.resourceState).toBe('complete');
    expect(readFileSync(join(a.projectDir, 'executions'), 'utf8')).toBe('x');
    expect(JSON.parse(readFileSync(join(fcGlobalDir(), 'validation/queue.json'), 'utf8')).tickets).toEqual([]);
  });
});
