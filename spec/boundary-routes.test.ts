import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execWithStdin } from '../src/adapters/base.js';
import { parseEngineChildBoundaryReceipt, withEngineWriteBoundary } from '../src/write-boundary.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fc-boundary-routes-')); roots.push(root);
  const projectDir = join(root, 'project'), runDir = join(root, 'run');
  mkdirSync(projectDir); mkdirSync(runDir);
  return { root, projectDir, runDir, stageId: 'writer', projectWriteScope: ['**'],
    artifactContract: { version: 1 as const, produces: [], reads: [], replays: [], groups: [] } };
}
const native = process.platform === 'linux' ? it : it.skip;
const listen = (server: Server, endpoint: string | { host: string; port: number }) =>
  new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });

describe('stage transport and native communication scopes', () => {
  native('keeps read-only review scratch and run products writable while denying failed-temp project fallback', async () => {
    const f = fixture();
    const artifactContract = { ...f.artifactContract, produces: [{ root: 'run' as const, path: 'review.txt', id: 'review', kind: 'file' as const, nonempty: true }] };
    const input = { ...f, isGate: true, projectWriteScope: [], artifactContract };
    const run = (command: string) => withEngineWriteBoundary(input, () => execWithStdin('/bin/sh', ['-c', command], '', { cwd: f.projectDir, timeout_ms: 5000 }));
    expect((await run(`set -eu; d=$(mktemp -d); printf probe > "$d/check"; printf review > ${JSON.stringify(join(f.runDir, 'review.txt'))}`)).exitCode).toBe(0);
    expect(readFileSync(join(f.runDir, 'review.txt'), 'utf8')).toBe('review');
    expect((await run('d=$(mktemp -d /tmp/release-config-review-XXXXXX 2>&1); mkdir -p "$d/legacy"')).exitCode).not.toBe(0);
    expect(readdirSync(f.projectDir)).toEqual([]);
  });

  it('removes inherited and adapter-supplied daemon routing after merging the environment', async () => {
    const f = fixture(), saved = process.env.FLOWCREW_DAEMON_SOCKET;
    process.env.FLOWCREW_DAEMON_SOCKET = join(f.root, 'owned-not-listening.sock');
    try {
      for (const env of [undefined, { FLOWCREW_DAEMON_SOCKET: join(f.root, 'override.sock') }]) {
        const r = await execWithStdin(process.execPath, ['-e', "console.log(JSON.stringify({socket:process.env.FLOWCREW_DAEMON_SOCKET??null,marker:process.env.FLOWCREW_ROUTE_TEST}))"], '', {
          cwd: f.projectDir, timeout_ms: 5_000, env: { FLOWCREW_ROUTE_TEST: 'preserved', ...env },
        });
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.output)).toEqual({ socket: null, marker: 'preserved' });
      }
    } finally {
      if (saved === undefined) delete process.env.FLOWCREW_DAEMON_SOCKET; else process.env.FLOWCREW_DAEMON_SOCKET = saved;
    }
  });

  native('confines signals and abstract peers while retaining pathname and loopback controls', async () => {
    const f = fixture(), abstract = '\0fc-spec-owned-' + process.pid, pathname = join(f.root, 'endpoint.sock');
    const abstractServer = createServer(c => c.end('abstract control'));
    const pathServer = createServer(c => c.end('pathname control'));
    const tcpServer = createServer(c => c.end('loopback control'));
    let delivered = 0;
    const signal = () => { delivered++; };
    process.on('SIGUSR1', signal);
    try {
      await listen(abstractServer, abstract); await listen(pathServer, pathname); await listen(tcpServer, { host: '127.0.0.1', port: 0 });
      const address = tcpServer.address(); if (!address || typeof address === 'string') throw new Error('missing owned TCP address');
      const code = "const net=require('net');let signal;try{process.kill(" + process.pid + ",'SIGUSR1');signal='allowed'}catch(e){signal=e.code;}const connect=options=>new Promise(resolve=>{const c=net.createConnection(options);c.on('error',e=>resolve({error:e.code}));let text='';c.on('data',b=>text+=b);c.on('end',()=>resolve({text}));c.setTimeout(1000,()=>{c.destroy();resolve({error:'timeout'});});});Promise.all([connect({path:" + JSON.stringify(abstract) + "}),connect({path:" + JSON.stringify(pathname) + "}),connect({host:'127.0.0.1',port:" + address.port + "})]).then(([abstract,pathname,tcp])=>console.log(JSON.stringify({signal,abstract,pathname,tcp})));";
      const response = await withEngineWriteBoundary(f, () => execWithStdin(process.execPath, ['-e', code], '', { cwd: f.projectDir, timeout_ms: 5_000, captureStreams: true }));
      expect(response.exitCode).toBe(0);
      if (response.writeBoundary?.kind !== 'installed') throw new Error('missing enforcement receipt');
      const actual = JSON.parse(response.stdout!);
      expect(actual.pathname).toEqual({ text: 'pathname control' });
      expect(actual.tcp).toEqual({ text: 'loopback control' });
      if (response.writeBoundary.abi >= 6) {
        expect(response.writeBoundary.scopes).toEqual({ signal: 'enforced', abstractUnixSocket: 'enforced' });
        expect(actual.signal).toBe('EPERM'); expect(actual.abstract).toEqual({ error: 'EPERM' }); expect(delivered).toBe(0);
      } else {
        expect(response.writeBoundary.scopes).toEqual({ signal: 'unavailable', abstractUnixSocket: 'unavailable' });
        expect(response.stderr).toContain('ENGINE_WRITE_BOUNDARY_SCOPE_UNAVAILABLE');
      }
    } finally {
      process.removeListener('SIGUSR1', signal);
      await Promise.all([abstractServer, pathServer, tcpServer].filter(s => s.listening).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
    }
  });

  native('allows signals and abstract connections within the confined process ancestry', async () => {
    const f = fixture();
    const code = "const net=require('net'),{spawn}=require('child_process');const address='\\0fc-descendants-'+process.pid;const server=net.createServer(c=>c.end('owned'));server.listen(address,()=>{const socket=net.createConnection(address);let text='';socket.on('data',b=>text+=b);socket.on('end',()=>{server.close();console.log('socket:'+text);});const child=spawn(process.execPath,['-e',\"process.on('SIGUSR1',()=>{console.log('received');process.exit(0);});console.log('ready');setInterval(()=>{},1000)\"],{stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>{if(b.toString().includes('ready'))process.kill(child.pid,'SIGUSR1');process.stdout.write(b);});child.on('close',code=>{if(code!==0)process.exitCode=1;});});";
    const response = await withEngineWriteBoundary(f, () => execWithStdin(process.execPath, ['-e', code], '', { cwd: f.projectDir, timeout_ms: 5_000 }));
    expect(response.exitCode, response.output).toBe(0); expect(response.output).toContain('socket:owned'); expect(response.output).toContain('received');
  });

  native('retires leftover owned group members before returning a normal leader success', async () => {
    const f = fixture(), pidfile = join(f.projectDir, 'descendant.pid');
    const code = "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)\"],{stdio:'ignore'});require('fs').writeFileSync(" + JSON.stringify(pidfile) + ",String(c.pid));c.unref();console.log('done');";
    const response = await withEngineWriteBoundary(f, () => execWithStdin(process.execPath, ['-e', code], '', { cwd: f.projectDir, timeout_ms: 5_000, terminationTiming: { graceMs: 250, pollMs: 10 } }));
    expect(response.exitCode).toBe(0); expect(response.processExitCode).toBe(0);
    const pid = Number(readFileSync(pidfile, 'utf8'));
    if (existsSync('/proc/' + pid + '/stat')) expect(readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[0]).toBe('Z');
  });


  native('keeps the deadline active while retiring an unresponsive original-group child', async () => {
    const f = fixture();
    const descendant = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)";
    const code = "const {spawn}=require('child_process');const child=spawn(process.execPath,['-e'," + JSON.stringify(descendant) + "],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{child.disconnect();child.unref();console.log('leader done');});";
    const response = await withEngineWriteBoundary(f, () => execWithStdin(process.execPath, ['-e', code], '', {
      cwd: f.projectDir, timeout_ms: 1000, terminationTiming: { graceMs: 1500, pollMs: 10 },
    }));
    expect(response.exitCode, response.output).toBe(124); expect(response.timedOut).toBe(true); expect(response.processExitCode).toBe(0);
  });

  it('accepts historical receipts without inventing scope enforcement', () => {
    const receipt = { kind: 'installed', abi: 7, pid: 123, fileCapabilities: 0, directoryCapabilities: 1 };
    expect(parseEngineChildBoundaryReceipt(JSON.stringify(receipt), 123)).toEqual(receipt);
  });

  it.each([3, 5, 6, 7])('requires honest additive scope receipts at ABI %i', abi => {
    const expected = abi >= 6 ? 'enforced' : 'unavailable';
    const receipt = { kind: 'installed', abi, pid: 123, fileCapabilities: 0, directoryCapabilities: 1,
      scopes: { signal: expected, abstractUnixSocket: expected } };
    expect(parseEngineChildBoundaryReceipt(JSON.stringify(receipt), 123)).toEqual(receipt);
    for (const scopes of [{ signal: expected }, 'enforced', { signal: expected === 'enforced' ? 'unavailable' : 'enforced', abstractUnixSocket: expected }]) {
      expect(() => parseEngineChildBoundaryReceipt(JSON.stringify({ ...receipt, scopes }), 123)).toThrow('invalid launcher scope receipt');
    }
  });
});
