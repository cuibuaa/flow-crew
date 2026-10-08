import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execWithStdin } from '../src/adapters/base.js';
import { parseEngineChildBoundaryReceipt, withEngineWriteBoundary } from '../src/write-boundary.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prerequisite-')); roots.push(root);
  const projectDir = join(root, 'p'), runDir = join(root, 'r');
  mkdirSync(projectDir); mkdirSync(runDir);
  const artifactContract = { version: 1 as const, produces: [{ id: 'output', root: 'run' as const, path: 'out', kind: 'directory' as const }], reads: [], groups: [], replays: [] };
  const input = { projectDir, runDir, stageId: 'subject', attemptIndex: 1, artifactContract };
  const receiptPath = join(runDir, 'stages', 'subject', 'write_boundary_attempt_1.jsonl');
  const receipts = () => existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const command = (code: string, timeout_ms = 5000, abortSignal?: AbortSignal) => execWithStdin(process.execPath, ['-e', code], '', { cwd: projectDir, timeout_ms, abortSignal, captureStreams: true });
  return { root, projectDir, runDir, input, receipts, command };
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('authenticates the prerequisite phase independently of the exit number or diagnostic prose', () => {
  expect(parseEngineChildBoundaryReceipt(JSON.stringify({ kind: 'waiting', phase: 'pre_execution', pid: 100, message: 'prerequisite' }), 100).kind).toBe('waiting');
  for (const receipt of [
    { kind: 'waiting', phase: 'pre_execution', pid: 101, message: 'wrong process' },
    { kind: 'waiting', pid: 100, message: 'missing phase' },
    { kind: 'waiting', phase: 'post_execution', pid: 100, message: 'wrong phase' },
  ]) expect(() => parseEngineChildBoundaryReceipt(JSON.stringify(receipt), 100)).toThrow();
});

describe.skipIf(process.platform !== 'linux')('pre-execution prerequisite lifetime', () => {
  it('keeps the same launcher alive and rechecks closure before execution after release', async () => {
    const f = fixture(), member = join(f.projectDir, 'member'), outside = join(f.root, 'outside'), marker = join(f.projectDir, 'ran');
    writeFileSync(member, 'original'); linkSync(member, outside);
    let released = false, ranBeforeRelease = false;
    const control = setInterval(() => {
      if (!released && f.receipts().some(row => row.kind === 'waiting')) {
        ranBeforeRelease = existsSync(marker); released = true; unlinkSync(outside);
      }
    }, 20);
    try {
      const result = await withEngineWriteBoundary(f.input, () => f.command(`require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`));
      expect(result.exitCode, result.output).toBe(0);
      expect(released).toBe(true); expect(ranBeforeRelease).toBe(false); expect(existsSync(marker)).toBe(true);
      const rows = f.receipts(); expect(rows.map(row => row.kind)).toEqual(['waiting', 'installed']);
      expect(new Set(rows.map(row => row.childPid)).size).toBe(1);
      expect(rows[0].message).toContain(member); expect(readFileSync(member, 'utf8')).toBe('original');
      const events = readFileSync(join(f.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.map(event => event.type)).toEqual(['stage_environment_wait_started', 'stage_environment_wait_finished']);
    } finally { clearInterval(control); }
  });

  it.each(['deadline', 'abort'] as const)('keeps %s authoritative while the prerequisite remains unsatisfied', async mode => {
    const f = fixture(), member = join(f.projectDir, 'member'), marker = join(f.projectDir, 'ran');
    writeFileSync(member, 'original'); linkSync(member, join(f.root, 'outside'));
    const abort = new AbortController();
    const control = setInterval(() => { if (mode === 'abort' && f.receipts().some(row => row.kind === 'waiting')) abort.abort(); }, 20);
    try {
      const result = await withEngineWriteBoundary(f.input, () => f.command(`require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`, 800, abort.signal));
      expect(result.exitCode).toBe(mode === 'deadline' ? 124 : 137);
      expect(result.timedOut).toBe(mode === 'deadline'); expect(existsSync(marker)).toBe(false);
      expect(f.receipts().some(row => row.kind === 'installed')).toBe(false);
    } finally { clearInterval(control); }
  });

  it('does not convert a real child exit 125 or spawn failure into a prerequisite wait', async () => {
    const f = fixture();
    const real = await withEngineWriteBoundary(f.input, () => f.command("console.log('ENGINE_WRITE_BOUNDARY_WAITING: counterfeit prose');process.exit(125)"));
    expect(real.exitCode).toBe(125); expect(real.timedOut).toBe(false); expect(real.writeBoundary?.kind).toBe('installed');
    const missing = await withEngineWriteBoundary(f.input, () => execWithStdin(join(f.root, 'missing'), [], '', { cwd: f.projectDir, timeout_ms: 2000 }));
    expect(missing.exitCode).toBe(1); expect(missing.spawnError?.code).toBe('ENOENT');
    expect(f.receipts().some(row => row.kind === 'waiting')).toBe(false);
  });

  it('denies durable socket/FIFO creation while scratch IPC and ordinary publication work', async () => {
    const f = fixture();
    const result = await withEngineWriteBoundary(f.input, () => f.command(`
      const fs=require('fs'),path=require('path'),cp=require('child_process'),net=require('net');
      const paths=[process.cwd(),${JSON.stringify(join(f.runDir, 'out'))},${JSON.stringify(join(f.runDir, 'stages/subject/codex_home'))}];
      const rows=[];for(const root of paths){const p=path.join(root,'ipc.fifo');const r=cp.spawnSync('/usr/bin/python3',['-I','-S','-B','-c','import os,sys;os.mkfifo(sys.argv[1])',p]);rows.push({kind:'fifo',created:r.status===0});}
      const scratch=path.join(process.env.TMPDIR,'own.fifo');const r=cp.spawnSync('/usr/bin/python3',['-I','-S','-B','-c','import os,sys;os.mkfifo(sys.argv[1])',scratch]);
      let linked,renamed;try{fs.linkSync(scratch,path.join(process.cwd(),'linked.fifo'));linked='allowed'}catch(e){linked=e.code}try{fs.renameSync(scratch,path.join(process.cwd(),'moved.fifo'));renamed='allowed'}catch(e){renamed=e.code}fs.unlinkSync(scratch);
      let pending=paths.length+1;const complete=()=>{if(--pending===0){fs.writeFileSync(path.join(process.cwd(),'ordinary'),'ok');console.log(JSON.stringify({rows,scratchFifo:r.status===0,linked,renamed}));}};
      for(const root of paths){const server=net.createServer();server.on('error',e=>{rows.push({kind:'socket',created:false,error:e.code});complete()});server.listen(path.join(root,'ipc.sock'),()=>{rows.push({kind:'socket',created:true});server.close(complete)});}
      const scratchServer=net.createServer();scratchServer.listen(path.join(process.env.TMPDIR,'s.sock'),()=>scratchServer.close(complete));
    `));
    expect(result.exitCode, result.output).toBe(0);
    const observed = JSON.parse(result.stdout!);
    expect(observed.rows).toHaveLength(6); expect(observed.rows.every((row: { created: boolean }) => !row.created)).toBe(true);
    expect(observed).toMatchObject({ scratchFifo: true, linked: 'EACCES', renamed: 'EACCES' });
    expect(readFileSync(join(f.projectDir, 'ordinary'), 'utf8')).toBe('ok');
  });
});

it.skipIf(process.platform !== 'linux')('keeps parent-created disposable validation IPC separate from durable publications', async () => {
  const f = fixture(), disposable = join(f.root, 'disposable'); mkdirSync(disposable);
  const { withEngineWriteBoundaryDirectory } = await import('../src/write-boundary.js');
  await withEngineWriteBoundary(f.input, async () => {
    expect(() => withEngineWriteBoundaryDirectory(f.projectDir, () => undefined)).toThrow('separate from durable');
    const result = await withEngineWriteBoundaryDirectory(disposable, () => f.command(`
      const net=require('net');const server=net.createServer();
      server.on('error',e=>{console.error(e.code);process.exit(1)});
      server.listen(${JSON.stringify(join(disposable, 'owned.sock'))},()=>server.close(()=>console.log('closed')));
    `));
    expect(result.exitCode, result.output).toBe(0); expect(result.stdout).toBe('closed\n');
  });
  expect(existsSync(join(disposable, 'owned.sock'))).toBe(false);
});

it.skipIf(process.platform !== 'linux')('refuses disposable IPC allocations under durable trees, including physical aliases', async () => {
  const f = fixture();
  vi.stubEnv('TMPDIR', f.projectDir);
  await expect(withEngineWriteBoundary(f.input, async () => undefined)).rejects.toThrow('TMPDIR/temporary capability must be separate');
  const { readdirSync } = await import('node:fs');
  expect(readdirSync(f.projectDir)).toEqual([]);
  if (process.platform !== 'win32') {
    const alias = join(f.root, 'alias'); symlinkSync(f.projectDir, alias);
    vi.stubEnv('TMPDIR', alias);
    await expect(withEngineWriteBoundary(f.input, async () => undefined)).rejects.toThrow('TMPDIR/temporary capability must be separate');
    expect(readdirSync(f.projectDir)).toEqual([]);
  }
});
