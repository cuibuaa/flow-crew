import * as rollbackFiles from '../src/rollback-content-store.js';
import * as engineFs from '../src/engine-fs.js';
import { atomicWrite, renameSync as publishRename } from '../src/engine-fs.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, { closeSync, cpSync, ftruncateSync, openSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hash, type BinaryLike, type Encoding } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { execWithStdin, type Adapter } from '../src/adapters/base.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { registerEngineOwnedSqlitePath } from '../src/engine-owned-carriers.js';
import { inspectArtifactDeclarations, producesEngineOwnedArtifact } from '../src/artifact-declarations.js';
import { queueOperatorGuidance, routePendingOperatorGuidanceToStage } from '../src/guidance.js';
import { appendTextRecord } from '../src/append-boundary.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { startSchedulerHeartbeat } from '../src/scheduler-heartbeat.js';
import { writeSchedulerProcessIdentity, removeSchedulerProcessIdentity } from '../src/run-lock.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { runValidationCommand } from '../src/project-validation.js';
import { runAllChecks } from '../src/reality-gate/index.js';
import { generateRunSummary } from './test-support/run-summary.js';

import { HANDOFF_SCHEMA } from '../src/handoff.js';


// External products belong beside the fixture project, while the installation
// remains a distinct sibling namespace even when TMPDIR is inside this repo.
const installation = vi.hoisted(() => { vi.resetModules(); return { install: () => {} }; });
vi.mock('../src/ship-inputs.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ship-inputs.js')>();
  const { dirname, join } = await import('node:path');
  const external = actual.externalOutputDirectory;
  installation.install = () => {
    vi.spyOn(actual, 'externalOutputDirectory').mockImplementation((declaration, project, fs, context) =>
      external(declaration, project, fs, { engineRoot: join(dirname(project), 'engine'), ...context }));
  };
  return actual;
});

let root: string, project: string, run: string, store: string, previous: string;
const contract = { version: 1 as const, produces: [], reads: [], groups: [] };
beforeEach(() => {
  installation.install();
  root = mkdtempSync(join(tmpdir(), 'engine-integrity-'));
  project = join(root, 'project'); mkdirSync(project);
  store = join(root, 'store'); previous = fcGlobalDir(); setFcGlobalDir(store);
  run = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
});
afterEach(() => { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });
const input = () => ({ projectDir: project, runDir: run, stageId: 'work', artifactContract: contract, structuredResult: true });
const write = (path: string, bytes = 'engine record') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
const command = (code: string) => execWithStdin(process.execPath, ['-e', code], '', { cwd: project, timeout_ms: 5000 });
const voided = (action: () => Promise<unknown>) => expect(withEngineIntegrity(input(), action)).rejects.toThrow('ENGINE_STATE_TAMPERED');

describe('structural engine state protection', () => {
  it('protects a nested run beneath an invocation temporary ancestor', async () => {
    const parent = join(root, '.tmp-owner');
    project = join(parent, 'project'); mkdirSync(project, { recursive: true });
    store = join(parent, 'store'); setFcGlobalDir(store);
    run = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runDirPath;
    const path = join(run, 'run.json');
    const before = readFileSync(path, 'utf8');
    await voided(async () => {
      const result = await command(`require('node:fs').writeFileSync(${JSON.stringify(path)}, 'counterfeit')`);
      expect(result.exitCode).toBe(0);
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it.each(['run', 'store', 'project-link', 'future-database', 'live-distribution', 'project-inside-run', 'project-inside-distribution'])('refuses engine storage inside authored work: %s', async mode => {
    let args = input();
    if (mode === 'project-inside-distribution') args = { ...args, projectDir: join(import.meta.dirname, '../dist/future-project') };
    if (mode === 'live-distribution') args = { ...args, projectDir: join(import.meta.dirname, '..') };
    if (mode === 'project-inside-run') args = { ...args, projectDir: join(run, 'future-project') };
    if (mode === 'run') { args = { ...args, runDir: project }; }
    if (mode === 'store') setFcGlobalDir(join(project, 'engine'));
    if (mode === 'project-link') { const link = join(root, 'project-alias'); symlinkSync(store, link, 'dir'); args = { ...args, projectDir: link }; }
    if (mode === 'future-database') registerEngineOwnedSqlitePath(join(project, 'data', 'future.sqlite'));
    let called = false;
    await expect(withEngineIntegrity(args, async () => { called = true; })).rejects.toThrow('ENGINE_STATE_REFUSED');
    expect(called).toBe(false);
  });

  it('restores a parent-published carrier moved from the project', async () => {
    const source = join(project, 'result.json'), carrier = join(run, 'goal_met.json');
    write(source, 'trusted result');
    await voided(async () => {
      publishRename(source, carrier);
      writeFileSync(carrier, 'child edit');
    });
    expect(readFileSync(carrier, 'utf8')).toBe('trusted result');
  });

  it('restores engine decisions without creating rollback evidence payloads', async () => {
    const carrier = join(run, 'stage_watchdog.json');
    write(carrier, 'trusted state');
    const capture = vi.spyOn(rollbackFiles.RollbackContentStore.prototype, 'capture');
    await voided(async () => { writeFileSync(carrier, 'child edit'); });
    expect(readFileSync(carrier, 'utf8')).toBe('trusted state');
    expect(capture).not.toHaveBeenCalled();
    expect(existsSync(join(run, '.rollback-preimages'))).toBe(false);
  });

  it('refuses a decision record carried by an unscanned rollback payload', async () => {
    const payload = join(run, '.rollback-preimages', 'blob');
    write(payload, 'counterfeit decision');
    symlinkSync(payload, join(run, 'verdict_previous.json'));
    let called = false;
    await expect(withEngineIntegrity(input(), async () => { called = true; })).rejects.toThrow('engine record aliases rollback payload');
    expect(called).toBe(false);
  });

  it.each(['run.json', 'events.jsonl', 'run-history.jsonl', 'run-history.v1.jsonl', 'workflow.yaml', 'validation_baseline.json',
    'validation_delta_review.json', 'verdict_review.json', 'summary.md', 'goal_met.json',
    'approvals/decision.json', 'stages/work/status.json', 'stages/work/invocations/attempt/input.json.gz',
    'stage_evidence/review/verdict.json', 'dispatch.yaml', 'handoff_previous.md', 'scheduler.identity.json', 'scheduler.pid'])('voids a successful child overwriting %s', async local => {
    const path = join(run, local); write(path);
    await voided(() => command(`require('node:fs').writeFileSync(${JSON.stringify(path)},'counterfeit pass')`));
    expect(readFileSync(path, 'utf8')).toBe(local === 'events.jsonl' ? 'counterfeit pass' : 'engine record');
  });

  it.each(['write', 'unlink', 'rename', 'symlink', 'hardlink', 'directory-view'])('voids the historical local carrier route: %s', async route => {
    const path = join(run, 'verdict_previous.json'); write(path);
    const alias = join(project, 'alias');
    if (route === 'hardlink') linkSync(path, alias);
    if (route === 'directory-view') symlinkSync(run, alias, 'dir');
    const target = route === 'hardlink' ? alias : route === 'directory-view' ? join(alias, 'verdict_previous.json') : path;
    const code = route === 'unlink' ? `fs.unlinkSync(path)` : route === 'rename' ? `fs.renameSync(path,path+'.moved')`
      : route === 'symlink' ? `fs.unlinkSync(path);fs.symlinkSync(${JSON.stringify(join(project, 'counterfeit'))},path)` : `fs.writeFileSync(path,'counterfeit')`;
    await voided(() => command(`const fs=require('node:fs'),path=${JSON.stringify(target)};${code}`));
  });

  it.each(['replace-directory', 'create-record', 'change-mode'])('voids namespace and future carrier changes: %s', async route => {
    const directory = join(run, 'stages/previous/invocations'); write(join(directory, 'record'));
    await voided(async () => {
      if (route === 'replace-directory') { renameSync(directory, directory + '.moved'); mkdirSync(directory); }
      if (route === 'create-record') write(join(run, 'verdict_future.json'), '{"pass":true}');
      if (route === 'change-mode') await command(`require('node:fs').chmodSync(${JSON.stringify(join(directory, 'record'))},0o777)`);
    });
  });

  it('accepts an alias alone but voids any subsequent counterfeit bytes through it', async () => {
    const carrier = join(run, 'verdict_previous.json'), alias = join(project, 'alias'); write(carrier);
    await withEngineIntegrity(input(), async () => { linkSync(carrier, alias); });
    await voided(() => command(`require('node:fs').writeFileSync(${JSON.stringify(alias)},'counterfeit')`));
  });

  it.each(['same-content', 'direct', 'import', 'preload', 'descendant', 'shell', 'make', 'retained-generation'])('checks content in a real isolated engine distribution via %s', async route => {
    const engine = join(root, 'engine'); mkdirSync(engine);
    const backend = join(engine, route === 'retained-generation' ? 'generation' : 'dist');
    cpSync(realpathSync(join(import.meta.dirname, '../dist')), backend, { recursive: true });
    const dependencies = dirname(dirname(createRequire(import.meta.url).resolve('yaml/package.json')));
    symlinkSync(dependencies, join(engine, 'node_modules'), 'dir');
    write(join(engine, 'package.json'), '{"type":"module"}');
    const carrier = join(backend, 'integrity-probe.txt'); write(carrier);
    const code = route === 'same-content'
      ? `const fs=require('node:fs'),p=${JSON.stringify(carrier)};fs.copyFileSync(p,p+'.republished');fs.renameSync(p+'.republished',p)`
      : `require('node:fs').writeFileSync(${JSON.stringify(carrier)},'counterfeit')`;
    const module = join(project, 'overwrite.cjs'); write(module, code);
    const program = route === 'shell' ? '/bin/sh' : route === 'make' ? 'make' : process.execPath;
    const args = route === 'shell' ? ['-c', `printf counterfeit > '${carrier}'`]
      : route === 'make' ? ['-f', join(project, 'Makefile')]
      : route === 'import' ? ['--input-type=module', '-e', `await import(${JSON.stringify(module)})`]
      : route === 'preload' ? ['-e', '']
      : route === 'descendant' ? ['-e', `require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(code)}],{stdio:'inherit'})`]
      : ['-e', code];
    if (route === 'make') write(join(project, 'Makefile'), `all:\n\t@printf counterfeit > '${carrier}'\n`);
    const harness = `
      import {withEngineIntegrity} from ${JSON.stringify(join(backend, 'engine-integrity.js'))};
      import {setFcGlobalDir} from ${JSON.stringify(join(backend, 'store.js'))};
      import {execWithStdin} from ${JSON.stringify(join(backend, 'adapters/base.js'))};
      setFcGlobalDir(${JSON.stringify(store)});
      try {await withEngineIntegrity(${JSON.stringify(input())},()=>execWithStdin(${JSON.stringify(program)},${JSON.stringify(args)},'',{
        cwd:${JSON.stringify(project)},timeout_ms:5000,
        env:{...process.env,${route === 'preload' ? `NODE_OPTIONS:${JSON.stringify('--require ' + module)}` : ''}}
      }));process.exitCode=0;}catch(e){console.log(e.message);process.exitCode=125;}
    `;
    const result = await execWithStdin(process.execPath, ['--input-type=module', '-e', harness], '', { cwd: project, timeout_ms:10000 });
    expect(result.exitCode, result.output).toBe(route === 'same-content' ? 0 : 125);
    if (route !== 'same-content') expect(result.output).toContain('ENGINE_STATE_TAMPERED');
  });

  it('reads only the published tail when a parent appends to a log', async () => {
    const log = join(run, 'events.jsonl'); write(log, 'x'.repeat(4096));
    const read = fs.readSync; let bytes = 0;
    fs.readSync = ((...args: Parameters<typeof read>) => {
      const count = read(...args); bytes += count; return count;
    }) as typeof read;
    syncBuiltinESMExports();
    try {
      await withEngineIntegrity(input(), async () => {
        bytes = 0;
        engineFs.appendFileSync(log, 'parent event\n');
        expect(bytes).toBe(Buffer.byteLength('parent event\n'));
      });
    } finally { fs.readSync = read; syncBuiltinESMExports(); }
  });

  it.each(['append', 'rename'])('keeps %s publication work independent of prior records and carrier size', async operation => {
    const log = join(run, 'events.jsonl'), carrier = join(run, 'stages/work/command_activity.json');
    const staged = `${carrier}.tmp-parent`, record = 'parent event\n';
    const keys = Map.prototype.keys, update = Hash.prototype.update, stat = fs.lstatSync, readdir = fs.readdirSync;
    let work = { ledgerEntries: 0, bytesHashed: 0, stats: 0, descents: 0 };
    // Count entries consumed, rather than calls to keys(): spreading a whole
    // ledger still makes just one call while doing work for every old record.
    Map.prototype.keys = function () {
      const iterator = keys.call(this), next = iterator.next;
      iterator.next = () => {
        const result = next.call(iterator);
        if (!result.done) work.ledgerEntries++;
        return result;
      };
      return iterator;
    };
    Hash.prototype.update = function (this: Hash, data: BinaryLike, encoding?: Encoding) {
      work.bytesHashed += typeof data === 'string' ? Buffer.byteLength(data, encoding) : data.byteLength;
      return Reflect.apply(update, this, [data, encoding]);
    };
    fs.lstatSync = ((...args: Parameters<typeof stat>) => {
      work.stats++; return stat(...args);
    }) as typeof stat;
    fs.readdirSync = ((...args: Parameters<typeof readdir>) => {
      work.descents++; return readdir(...args);
    }) as typeof readdir;
    syncBuiltinESMExports();
    try {
      const samples: typeof work[] = [];
      for (const [priorRecords, carrierBytes] of [[0, 0], [128, 0], [128, 64 * 1024]]) {
        for (let index = 0; index < priorRecords; index++) write(join(run, 'stage_evidence/work', `record-${index}.json`));
        write(log, `${'x'.repeat(carrierBytes)}\n`); write(carrier);
        await withEngineIntegrity(input(), async () => {
          for (let index = 0; index < 3; index++) {
            writeFileSync(staged, record);
            work = { ledgerEntries: 0, bytesHashed: 0, stats: 0, descents: 0 };
            if (operation === 'append') appendTextRecord(log, record);
            else engineFs.renameSync(staged, carrier);
            samples.push({ ...work });
          }
        });
      }
      expect(samples[0].stats).toBeGreaterThan(0);
      expect(samples[0].bytesHashed).toBe(Buffer.byteLength(record));
      expect(samples[0].descents).toBe(0);
      expect(samples).toEqual(Array.from({ length: 9 }, () => samples[0]));
    } finally {
      Map.prototype.keys = keys; Hash.prototype.update = update; fs.lstatSync = stat; fs.readdirSync = readdir;
      syncBuiltinESMExports();
    }
  });

  it('does not scan the protected tree for an ordinary parent file rename', async () => {
    const carrier = join(run, 'stage_watchdog.json'), staged = `${carrier}.tmp-parent`;
    const readdir = fs.readdirSync; let descents = 0;
    fs.readdirSync = ((...args: Parameters<typeof readdir>) => {
      descents++; return readdir(...args);
    }) as typeof readdir;
    syncBuiltinESMExports();
    try {
      await withEngineIntegrity(input(), async () => {
        writeFileSync(staged, 'parent replacement'); descents = 0;
        engineFs.renameSync(staged, carrier);
        expect(descents).toBe(0);
      });
    } finally { fs.readdirSync = readdir; syncBuiltinESMExports(); }
  });

  it('does not descend unprotected stage build directories', async () => {
    const build = join(run, 'stages/work/build');
    write(join(build, 'nested', 'artifact'), 'authored build');
    const readdir = fs.readdirSync;
    let descents = 0;
    fs.readdirSync = ((...args: Parameters<typeof readdir>) => {
      if (String(args[0]).startsWith(build)) descents++;
      return readdir(...args);
    }) as typeof readdir;
    syncBuiltinESMExports();
    try { await withEngineIntegrity(input(), async () => {}); }
    finally { fs.readdirSync = readdir; syncBuiltinESMExports(); }
    expect(descents).toBe(0);
  });

  it.each(['overwrite', 'append'])('recognizes parent descriptor %s of a protected log', async operation => {
    const log = join(run, 'stages/work/live.log'); write(log, 'old');
    await withEngineIntegrity(input(), async () => {
      const descriptor = engineFs.openSync(log, operation === 'append' ? 'a' : 'w');
      try { engineFs.writeSync(descriptor, 'new parent bytes'); }
      finally { engineFs.closeSync(descriptor); }
    });
    expect(readFileSync(log, 'utf8')).toBe((operation === 'append' ? 'old' : '') + 'new parent bytes');
  });

  it.each(['path', 'descriptor', 'numeric'])('respects non-append flags passed to appendFileSync (%s)', async target => {
    const log = join(run, 'stages/work/live.log'); write(log, 'old');
    await withEngineIntegrity(input(), async () => {
      if (target !== 'descriptor') engineFs.appendFileSync(log, 'replacement', { flag: target === 'path' ? 'w'
        : fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_TRUNC });
      else {
        const descriptor = engineFs.openSync(log, 'r+');
        try { engineFs.appendFileSync(descriptor, 'replacement'); }
        finally { engineFs.closeSync(descriptor); }
      }
    });
    expect(readFileSync(log, 'utf8')).toBe('replacement');
  });

  it('accepts a parent overwrite of a protected log and rejects a later prefix forgery', async () => {
    const log = join(run, 'stages/work/live.log'); write(log, 'old');
    await expect(withEngineIntegrity(input(), async () => {
      engineFs.writeFileSync(log, 'replacement');
      writeFileSync(log, 'counterfeit');
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
  });

  it('detects a rewritten log prefix at exit even after parent appends', async () => {
    const log = join(run, 'stages/work/live.log'); write(log, 'trusted');
    fs.utimesSync(log, 1, 1);
    await expect(withEngineIntegrity(input(), async () => {
      const before = fs.statSync(log);
      writeFileSync(log, 'forgery'); fs.utimesSync(log, before.atime, before.mtime);
      engineFs.appendFileSync(log, 'parent append');
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
  });

  it('trims an untrusted log tail by reading the trusted prefix on demand', async () => {
    const log = join(run, 'stages/work/live.log'); write(log, 'trusted');
    await expect(withEngineIntegrity(input(), async () => {
      fs.appendFileSync(log, 'untrusted');
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(readFileSync(log, 'utf8')).toBe('trusted');
  });

  it('accepts protected records larger than the whole-file Buffer limit', async () => {
    const record = join(run, 'stages/work/live.log');
    const descriptor = openSync(record, 'w');
    try { ftruncateSync(descriptor, 2 ** 31 + 1); } finally { closeSync(descriptor); }
    await withEngineIntegrity(input(), async () => { engineFs.appendFileSync(record, 'parent append'); });
    expect(fs.statSync(record).size).toBe(2 ** 31 + 1 + 'parent append'.length);
  });

  it('permits ordinary external files and unknown hardlink closure without filesystem grants', async () => {
    const path = join(project, 'ordinary'), outside = join(root, 'outside'); write(path);
    linkSync(path, outside);
    const result = await withEngineIntegrity(input(), () => command(`require('node:fs').writeFileSync(${JSON.stringify(outside)},'ordinary update')`));
    expect(result.exitCode).toBe(0); expect(readFileSync(path,'utf8')).toBe('ordinary update');
  });

  it('permits atomic replacement of a declared shared-parent run output', async () => {
    const target = join(run, 'report.md');
    const artifactContract = { ...contract, produces: [{ id: 'report', root: 'run' as const, path: 'report.md', kind: 'file' as const }] };
    const result = await withEngineIntegrity({ ...input(), artifactContract }, () => command(`
      const fs=require('node:fs'),target=${JSON.stringify(target)};
      fs.writeFileSync(target,'first');fs.writeFileSync(target+'.tmp','replacement');fs.renameSync(target+'.tmp',target);
    `));
    expect(result.exitCode).toBe(0);expect(readFileSync(target,'utf8')).toBe('replacement');
  });

  it('permits validation request transport without publishing an approval or decision', async () => {
    const slot = join(run, 'stages/_validation/approval_request.json');mkdirSync(dirname(slot), { recursive: true });
    const result = await runValidationCommand({ role: 'test', command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(slot)},JSON.stringify({id:'request',action:'fixture',risk:'unknown'}))`],
      display: 'fixture', cwd: project, runDir: run });
    expect(result.exitCode).toBe(0);expect(existsSync(slot)).toBe(true);
    expect(existsSync(join(run,'approvals.jsonl'))).toBe(false);
    expect(existsSync(join(run,'approvals/request.decision.json'))).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('permits ordinary abstract peers and signals to a fixture process we started', async () => {
    const peer = spawn(process.execPath, ['-e', "process.on('SIGUSR1',()=>process.exit(0));console.log('ready');setInterval(()=>{},1000)"], {
      cwd: project, env: { ...process.env, HOME: root, FC_HOME: store }, stdio: ['ignore','pipe','pipe'],
    });
    const closed = new Promise<number|null>(resolve => peer.once('close', resolve));
    await new Promise<void>(resolve => peer.stdout.once('data',()=>resolve()));
    const address = '\0br-peer-' + process.pid;
    const server = createServer(socket=>socket.end('peer'));
    await new Promise<void>(resolve=>server.listen(address,resolve));
    try {
      const result = await withEngineIntegrity(input(), () => command(`process.kill(${peer.pid},'SIGUSR1');const socket=require('node:net').createConnection(${JSON.stringify(address)});socket.on('data',b=>console.log(b.toString()));`));
      expect(result.exitCode).toBe(0); expect(result.output).toContain('peer'); expect(await closed).toBe(0);
    } finally { if (peer.exitCode === null) peer.kill('SIGKILL'); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });

  it.skipIf(process.platform !== 'linux')('retires owned descendants before checking stage integrity and keeps retirement within the deadline', async () => {
    const pidfile = join(project, 'descendant.pid');
    const result = await withEngineIntegrity(input(), () => execWithStdin(process.execPath, ['-e', `
      const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(c.pid));c.unref();
    `], '', {cwd:project,timeout_ms:5000,terminationTiming:{graceMs:250,pollMs:10}}));
    expect(result.exitCode).toBe(0);
    const pid = readFileSync(pidfile,'utf8');
    if (existsSync('/proc/'+pid+'/stat')) expect(readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[0]).toBe('Z');
    const descendant = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)";
    const timeout = await withEngineIntegrity(input(), () => execWithStdin(process.execPath,['-e', `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>{c.disconnect();c.unref()});`],'',{
      cwd:project,timeout_ms:500,terminationTiming:{graceMs:1000,pollMs:10}}));
    expect(timeout.exitCode).toBe(124);expect(timeout.processExitCode).toBe(0);
  });

  it('does not confuse independent observer diagnostics with altered canonical records', async () => {
    atomicWrite(join(run,'scheduler.pid'),String(process.pid));
    writeSchedulerProcessIdentity(run,run.split('/').at(-1)!);
    const handle = startSchedulerHeartbeat({runPath:run,runId:run.split('/').at(-1)!,intervalMs:60000,stallThresholdMs:50,observerPollMs:5});
    try {
      await handle.ready;
      await withEngineIntegrity(input(), async () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
        await new Promise(resolve=>setTimeout(resolve,30));
      });
      expect(readFileSync(join(run,'events.jsonl'),'utf8')).toContain('scheduler_loop_stalled');
    } finally { await handle.stop(); removeSchedulerProcessIdentity(run,process.pid); }
  });

  it('voids a late external hardlink write after dispatch without scanning the output directory', async () => {
    const output = join(root, 'external'), carrier = join(run, 'verdict_previous.json'), alias = join(output, 'late-alias');
    write(carrier); write(join(run, 'task_brief.md'), `---\noutputs:\n  - path: ${JSON.stringify(output)}\n    type: directory\n---\n# Goal\nWrite results.\n`);
    await voided(() => execWithStdin(process.execPath, ['-e', `const fs=require('node:fs');console.log('ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(alias)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(alias)},'counterfeit');}},5);`], '', {
      cwd: project, timeout_ms: 5000, onStdout(text) { if (text.includes('ready')) linkSync(carrier, alias); },
    }));
  });

  it.each(['dangling', 'loop', 'project-hop', 'file-output'])('refuses protected unresolved or writable links: %s', async mode => {
    const carrier = join(run, 'verdict_previous.json'), target = join(project, 'target');
    if (mode === 'loop') symlinkSync(carrier, carrier);
    else if (mode === 'dangling') symlinkSync(join(root, 'missing'), carrier);
    else {
      if (mode === 'file-output') {
        const declared = join(run, 'report.md'); write(declared); symlinkSync(declared, carrier);
        const args = { ...input(), artifactContract: { ...contract, produces: [{ id: 'report', root: 'run' as const, path: 'report.md', kind: 'file' as const }] } };
        await expect(withEngineIntegrity(args, async () => {})).rejects.toThrow('ENGINE_STATE_REFUSED');
        return;
      }
      write(target); symlinkSync(target, carrier);
    }
    await expect(withEngineIntegrity(input(), async () => {})).rejects.toThrow(/ENGINE_STATE_REFUSED|SYMLINK_LOOP/);
  });

  it.each(['direct', 'dot'])('refuses a protected carrier that consults a project intermediate hop: %s', async route => {
    const outside = join(root,'outside');mkdirSync(outside);write(join(root,'record'),'engine');write(join(outside,'record'),'engine');
    const hop = join(project,'hop');symlinkSync(outside,hop,'dir');
    const carrier = join(run,'verdict_previous.json');
    symlinkSync(hop + (route === 'dot' ? '/../record' : '/record'), carrier);
    await expect(withEngineIntegrity(input(),async()=>{})).rejects.toThrow('ENGINE_STATE_REFUSED');
  });

  it.each(['declared-build', 'private-build', 'stage-output'])('keeps a completed author\'s %s separate from engine carriers in a self-hosted project', async kind => {
    // A disposable source checkout has its own distribution and bin links;
    // the running engine remains in its separate distribution.
    write(join(project, 'package.json'), '{"name":"engine-fixture","type":"module"}');
    write(join(project, 'src/cli.ts'), 'export {};');
    write(join(project, 'dist/cli.js'), 'export {};');
    const bin = join(project, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(relative(bin, join(project, 'dist/cli.js')), join(bin, 'engine'));
    const path = kind === 'stage-output' ? 'stages/work/report.md' : 'stages/work/build';
    const output = { id: 'result', root: 'run' as const, path, kind: kind === 'stage-output' ? 'file' as const : 'directory' as const };
    const author = { ...input(), artifactContract: { ...contract, produces: kind === 'private-build' ? [] : [output] } };
    const link = kind === 'stage-output' ? join(run, path) : join(run, path, 'validation', 'node_modules', '.bin');
    await withEngineIntegrity(author, async () => {
      if (kind === 'stage-output') write(join(project, 'report.md'), 'authored report');
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(kind === 'stage-output' ? join(project, 'report.md') : bin, link);
    });
    let reviewed = false;
    await withEngineIntegrity({ ...input(), stageId: 'review' }, async () => { reviewed = true; });
    expect(reviewed).toBe(true);
    expect(readFileSync(join(project, 'dist/cli.js'), 'utf8')).toBe('export {};');
  });

  it.each(['', 'status.json', 'invocations/model/input.json'])('still refuses an earlier stage carrier %s that links into the self-hosted project', async local => {
    const target = join(project, 'node_modules', '.bin');
    mkdirSync(target, { recursive: true });
    const carrier = join(run, 'stages/previous', local);
    mkdirSync(dirname(carrier), { recursive: true });
    symlinkSync(target, carrier);
    let called = false;
    await expect(withEngineIntegrity({ ...input(), stageId: 'review' }, async () => { called = true; }))
      .rejects.toThrow('engine carrier consults authored work');
    expect(called).toBe(false);
  });

  it('accepts a replaced stage directory with unchanged protected members', async () => {
    const stage = join(run, 'stages/previous'), moved = join(root, 'previous');
    const status = join(stage, 'status.json'); write(status, '{"status":"complete"}');
    await withEngineIntegrity(input(), async () => {
      renameSync(stage, moved); mkdirSync(stage);
      renameSync(join(moved, 'status.json'), status);
    });
    expect(readFileSync(status, 'utf8')).toBe('{"status":"complete"}');
  });

  it('accepts a replaced storage ancestor with unchanged protected members', async () => {
    await withEngineIntegrity(input(), async()=>{
      const parent = dirname(run);renameSync(parent,parent+'.moved');mkdirSync(parent);
      renameSync(join(parent+'.moved',run.split('/').at(-1)!),run);
    });
  });

  // Preserve the named constructions from the earlier refusal census as
  // disposable shapes. None of its launch scripts or private records execute.
  it.each(['A0','A1','A2','A3','A4','A5','A6','A7','A8','A8-trailing-slash','A9','A10','A11',
    'second-directory','second-loop','proc-pid','proc-self-cwd','concurrent-sibling','live'])('refuses historical protected-link construction %s', async name => {
    const out = join(run,'stages/previous/invocations');mkdirSync(out,{recursive:true});
    const carrier = join(out,'result.json'), outside = join(root,'outside');mkdirSync(outside);
    const hop = join(project,'hop');let target = '';
    if (['A0','A7','A8','A8-trailing-slash'].includes(name)) {
      target = join(project,'target');
      if (name==='A7') target=relative(out,target);
      if (name==='A8') target=project+'//./target';
      if (name==='A8-trailing-slash') target=project+'/target/';
    }
    if (['A1','live','A10'].includes(name)) {
      if (name==='A10') target=join(run,'stages/work/codex_home/hop'); // string only: never inspect private state
      else {const endpoint=join(outside,'absent');if(name==='live')write(endpoint);symlinkSync(endpoint,hop);target=hop;}
    }
    if (['A2','A3','second-directory'].includes(name)) {
      const endpoint=join(outside,'absent');if(name==='A3')write(endpoint);
      const dir=join(project,'directory');symlinkSync(endpoint,dir);target=dir+'/file';
    }
    if (['A4','A5'].includes(name)) {
      mkdirSync(join(project,'a/b'),{recursive:true});target=project+'/missing/../../record';
      if(name==='A5')target=relative(out,project)+'/missing/../../record';
    }
    if(name==='A6'){symlinkSync(carrier,hop);target=hop;}
    if(name==='second-loop'){const b=join(root,'loop'),a=join(project,'loop');symlinkSync(a,b);symlinkSync(b,a);target=b+'/result.json';}
    if(name==='A9'){const handoff=join(run,'handoff_work.md');write(handoff);target=handoff+'/file';}
    if(name==='A11'){target=join(outside,'hop');symlinkSync(join(outside,'absent'),target);}
    if(name==='proc-self-cwd'){const regular=join(outside,'regular');write(regular);symlinkSync(regular,hop);target='/proc/self/cwd/hop';}
    if(name==='proc-pid')target='/proc/2147483647/cwd/result.json';
    if(name==='concurrent-sibling'){target=join(run,'stages/sibling/invocations/hop');mkdirSync(dirname(target),{recursive:true});symlinkSync(join(outside,'absent'),target);}
    symlinkSync(target,carrier);let called=false;
    await expect(withEngineIntegrity(input(),async()=>{called=true})).rejects.toThrow('ENGINE_STATE_REFUSED');
    expect(called).toBe(false);
  });

  it('refuses both concurrent siblings when their shared protected link is unresolved', async () => {
    const carrier=join(run,'verdict_previous.json');symlinkSync(join(root,'missing'),carrier);
    const results=await Promise.allSettled(['work','sibling'].map(stageId=>withEngineIntegrity({...input(),stageId},async()=>{throw new Error('must not launch')})));
    for(const result of results){expect(result.status).toBe('rejected');if(result.status==='rejected')expect(result.reason.message).toContain('ENGINE_STATE_REFUSED');}
  });

  it('voids replacement of an intermediate link and changes to an earlier recorded directory target', async () => {
    const target = join(root, 'earlier'), record = join(target, 'record.json'); write(record);
    const hop = join(root, 'hop'); symlinkSync(target, hop, 'dir');
    const carrier = join(run, 'stages/previous/invocations'); mkdirSync(dirname(carrier), { recursive: true }); symlinkSync(hop, carrier, 'dir');
    await voided(() => command(`require('node:fs').writeFileSync(${JSON.stringify(record)},'counterfeit')`));
    write(record);
    await voided(async () => { unlinkSync(hop); symlinkSync(join(root, 'missing'), hop, 'dir'); });
  });

  it.each(['run-index.sqlite'])('accepts concurrent shared database transactions: %s', async name => {
    const path = join(store, name); registerEngineOwnedSqlitePath(path);
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS fixture(value)');
    try {
      await withEngineIntegrity(input(), async () => {
        const result = await command(`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(path)});db.exec('INSERT INTO fixture VALUES (1)');db.close()`);
        expect(result.exitCode).toBe(0);
      });
      expect(db.prepare('SELECT * FROM fixture').all()).toHaveLength(1);
    } finally { db.close(); }
  });

  it('allows a new native SQLite reader to change shared-memory coordination during a stage', async () => {
    const path = join(store, 'run-index.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture(value); INSERT INTO fixture VALUES (1)');
    const before = readFileSync(path + '-shm');
    try {
      await withEngineIntegrity(input(), async () => {
        const result = await command(`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(path)},{readOnly:true});db.prepare('SELECT * FROM fixture').all();db.close()`);
        expect(result.exitCode).toBe(0);
      });
      expect(readFileSync(path + '-shm')).not.toEqual(before);
    } finally { db.close(); }
  });

  it.each(['not-directory', 'dot-after-file', 'proc', 'cycle', 'missing-parent'])('refuses unresolved protected namespace shape: %s', async route => {
    const carrier = join(run, 'verdict_previous.json'), target = join(root, 'target');
    if (route === 'cycle') { const dir = join(run, 'stages/previous/invocations'); mkdirSync(dir, {recursive:true}); symlinkSync(dir, join(dir, 'self'), 'dir'); }
    else {
      write(target);
      symlinkSync(route === 'proc' ? '/proc/self/fd/999999' : route === 'missing-parent' ? join(root, 'missing', 'record')
        : target + (route === 'dot-after-file' ? '/./record' : '/record'), carrier);
    }
    await expect(withEngineIntegrity(input(), async () => {})).rejects.toThrow(/ENGINE_STATE_REFUSED|NOT_DIRECTORY|SYMLINK_LOOP/);
  });

  it('accepts concurrent declared output publications without trusting them as engine facts', async () => {
    const output = { id:'report',root:'run' as const,path:'reports/review.txt',kind:'file' as const };
    await withEngineIntegrity(input(), async () => {
      await withEngineIntegrity({...input(),stageId:'review',artifactContract:{...contract,produces:[output]}}, async () => { write(join(run,output.path),'review'); });
      appendTextRecord(join(run,'events.jsonl'),'parent after authored publication');
    });
  });

  it('accepts concurrent parent publications without accepting child changes', async () => {
    const path = join(run, 'events.jsonl'); write(path, 'original\n');
    await withEngineIntegrity(input(), async () => {
      await withEngineIntegrity({ ...input(), stageId: '_observer' }, async () => {
        appendTextRecord(path, 'parent');
        updateRunState(project, run.split('/').at(-1)!, state => { state.taskDescription = 'parent update'; });
      });
    });
    expect(readFileSync(path, 'utf8')).toContain('parent');
  });

  it('does not let a later parent overwrite or append hide tampering', async () => {
    const path = join(run, 'events.jsonl'); write(path, 'original\n');
    await voided(async () => { writeFileSync(path, 'counterfeit'); try { appendTextRecord(path, 'parent'); } catch { /* observer may ignore display failure */ } });
    expect(readFileSync(path, 'utf8')).toBe('counterfeit');
    await voided(async () => { writeFileSync(path, 'counterfeit'); try { atomicWrite(path, 'parent replacement'); } catch { /* still latched */ } });
  });

  it.each(['record', 'record-parent', 'database', 'database-parent'])('refuses engine carrier outputs at admission: %s', mode => {
    const database = mode.startsWith('database');
    if (database) symlinkSync(mode === 'database' ? join(store, 'run-index.sqlite') : store, join(project, 'storage'));
    const artifact = { id: 'out', root: database ? 'project' as const : 'run' as const,
      path: database ? 'storage' : mode === 'record' ? 'run.json' : 'stages/work',
      kind: mode.endsWith('parent') ? 'directory' as const : 'file' as const };
    expect(inspectArtifactDeclarations({ stages: [{ id: 'work', depends_on: [], artifact_contract: { ...contract, produces: [artifact] } }],
      runDir: run, projectDir: project })).toContain(`ARTIFACT_FRAMEWORK_PATH: work.out cannot produce engine-owned evidence ${artifact.path}`);
  });

  it.each(['handoff_work.md', 'handoff_previous.md'])('refuses a non-structured handoff output through the guard: %s', async path => {
    let called = false;
    await expect(withEngineIntegrity({ ...input(), structuredResult: false,
      artifactContract: { ...contract, produces: [{ id: 'out', root: 'run', path, kind: 'file' }] },
    }, async () => { called = true; })).rejects.toThrow('ENGINE_STATE_REFUSED');
    expect(called).toBe(false);
  });

  it.each(['namespace', 'symlink', 'hardlink'])('refuses an output directory containing engine records through the guard: %s', async mode => {
    const carrier = join(run, 'run.json'), output = 'reports';
    if (mode === 'symlink') { mkdirSync(join(run, output)); symlinkSync(carrier, join(run, output, 'alias')); }
    if (mode === 'hardlink') { mkdirSync(join(run, output)); linkSync(carrier, join(run, output, 'alias')); }
    let called = false;
    await expect(withEngineIntegrity({ ...input(), artifactContract: { ...contract,
      produces: [{ id: 'out', root: 'run', path: mode === 'namespace' ? 'stages/work' : output, kind: 'directory' }],
    } }, async () => { called = true; })).rejects.toThrow('ENGINE_STATE_REFUSED');
    expect(called).toBe(false);
  });

  it.each([false, true])('allows independent interrupt requests with an initially present signals directory: %s', async present => {
    const directory = join(run, 'signals');
    rmSync(directory, { recursive: true, force: true });
    if (present) mkdirSync(directory);
    const path = join(directory, 'interrupt_operator.json');
    await withEngineIntegrity(input(), async () => {
      const result = await command(`const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(directory)},{recursive:true});fs.writeFileSync(${JSON.stringify(path)},'operator request')`);
      expect(result.exitCode).toBe(0);
    });
    expect(readFileSync(path, 'utf8')).toBe('operator request');
  });

  it.each([false, true])('protects abort records with an initially present signals directory: %s', async present => {
    const directory = join(run, 'signals'), path = join(directory, 'abort_work.json');
    rmSync(directory, { recursive: true, force: true });
    if (present) write(path, 'trusted abort');
    await voided(async () => { write(path, 'counterfeit abort'); });
    if (present) expect(readFileSync(path, 'utf8')).toBe('trusted abort');
  });

  it('refuses an external output containing a future registered engine database', async () => {
    const output=join(root,'external');registerEngineOwnedSqlitePath(join(output,'future.sqlite'));
    write(join(run,'task_brief.md'),`---\noutputs:\n  - path: ${output}\n    type: directory\n---\n# Goal\nProduce results.\n`);
    await expect(withEngineIntegrity(input(),async()=>{})).rejects.toThrow('EXTERNAL_OUTPUT_REFUSED');
  });

  it('rejects a malformed successful typed answer before publishing a handoff', async () => {
    const runId = run.split('/').at(-1)!;
    const adapter: Adapter = { async run() { return {exitCode:0,duration_ms:1,output:'{"status":"delivered"}'}; } };
    const result = await runStage(adapter, { stageId:'work', projectDir:project,runDir:run,runId,
      role:{name:'fixture',description:'',model:'default',reasoning_effort:'low',tools:[],prompt:''},
      dependsOn:[],promptTemplate:'Do the work.',timeout_ms:5000,retries:0,artifactContract:contract,outputSchema:HANDOFF_SCHEMA });
    expect(result.exitCode).not.toBe(0);
    expect(result.friendlyError).toContain('STAGE_RECORD_INVALID');
    expect(existsSync(join(run,'handoff_work.md'))).toBe(false);
  });

  it.each(['validation','reality'])('voids an actual %s command that overwrites acknowledged history', async route => {
    const carrier = join(run,'run-history.jsonl');write(carrier,'acknowledged history');
    const code = `const fs=require('node:fs');fs.writeFileSync('generated','legitimate');fs.writeFileSync(${JSON.stringify(carrier)},'counterfeit');`;
    if (route === 'validation') {
      await expect(runValidationCommand({role:'test',command:process.execPath,args:['-e',code],display:'fixture',cwd:project,runDir:run})).rejects.toThrow('ENGINE_STATE_TAMPERED');
    } else {
      const script = join(project,'probe.cjs');write(script,code);
      const result = await runAllChecks([{name:'fixture',type:'exec-script-exit-zero',reads:[],params:{script:`'${process.execPath}' '${script}'`,timeout_seconds:5}}],{projectDir:project,taskDir:run});
      expect(result.pass).toBe(false);expect(result.results[0].details).toContain('ENGINE_STATE_TAMPERED');
    }
    expect(readFileSync(join(project,'generated'),'utf8')).toBe('legitimate');
    expect(readFileSync(carrier,'utf8')).toBe('acknowledged history');
  });

  it('builds the terminal summary from engine records without invoking a narrative writer', async () => {
    const runId = run.split('/').at(-1)!;updateRunState(project,runId,state=>{state.status='complete'});
    let called = false;
    const summary = await generateRunSummary(project,runId,{async run(){called=true;writeFileSync(join(run,'run.json'),'counterfeit');throw new Error('must not run')}});
    expect(summary).toContain('Status: **complete**');expect(called).toBe(false);
  });

  it('keeps a tampered stage failed when a trusted approval suspension also arrives', async () => {
    const runId = run.split('/').at(-1)!;
    const adapter: Adapter = {async run(_prompt,_role,opts) {
      atomicWrite(join(run,'signals/abort_work.json'), JSON.stringify({version:1,stageId:'work',attemptIndex:opts.attemptIndex,
        source:'scheduler',timestamp:new Date().toISOString(),reason:'pending approval',requestId:'fixture',requestingStageId:'work'}));
      await new Promise<void>(resolve=>opts.abortSignal!.addEventListener('abort',()=>resolve(),{once:true}));
      writeFileSync(join(run,'verdict_previous.json'),'{"pass":true}');
      return {exitCode:0,duration_ms:1,output:'done'};
    }};
    const result = await runStage(adapter,{stageId:'work',projectDir:project,runDir:run,runId,
      role:{name:'fixture',description:'',model:'default',reasoning_effort:'low',tools:[],prompt:''},dependsOn:[],promptTemplate:'Work',
      timeout_ms:5000,retries:0,artifactContract:contract});
    expect(result.exitCode).toBe(125);expect(result.suspended).not.toBe(true);
    expect(readStageStatus(project,runId,'work').status).toBe('failed');
  });

  it.each(['scheduler.identity.json','run-index.sqlite-wal'])('refuses a declared hardlink output alias of %s', async name => {
    const carrier = name.startsWith('scheduler') ? join(run,name) : join(store,name); write(carrier);
    const alias = join(project,'declared-alias');linkSync(carrier,alias);
    expect(producesEngineOwnedArtifact({id:'out',root:'project',path:'declared-alias',kind:'file'},{id:'work',depends_on:[]},run,project)).toBe(true);
  });

  it('accepts queued operator requests while only the parent publishes canonical guidance', async () => {
    await withEngineIntegrity(input(), async () => {
      queueOperatorGuidance({runDir:run,target:'work',body:'Use the bounded check',knownStageIds:['work']});
      expect(existsSync(join(run,'supervisor_guidance.md'))).toBe(false);
      routePendingOperatorGuidanceToStage(run,'work');
    });
    expect(readFileSync(join(run,'supervisor_guidance.md'),'utf8')).toContain('Use the bounded check');
  });

  it('preserves direct launch failure and stdin without accepting counterfeit diagnostic prose', async () => {
    const missing = await withEngineIntegrity(input(),()=>execWithStdin(join(project,'missing'),[],'input',{cwd:project,timeout_ms:5000}));
    expect(missing.spawnError?.code).toBe('ENOENT');
    const result = await withEngineIntegrity(input(),()=>execWithStdin(process.execPath,['-e',"process.stdin.on('data',b=>console.log(b.toString()+' ENGINE_STATE_TAMPERED: counterfeit prose'))"],'exact stdin',{cwd:project,timeout_ms:5000}));
    expect(result.exitCode).toBe(0);expect(result.output).toContain('exact stdin');
  });

  it('settles a forged verdict attempt as failed despite a successful typed answer', async () => {
    const runId = run.split('/').at(-1)!;
    const adapter: Adapter = { async run() {
      writeFileSync(join(run, 'verdict_review.json'), '{"pass":true}');
      return { exitCode: 0, duration_ms: 1, output: JSON.stringify({ status: 'delivered', summary: 'done', files_modified: [], checks: [], caveats: [] }) };
    } };
    const result = await runStage(adapter, { stageId: 'work', projectDir: project, runDir: run, runId,
      role: { name: 'fixture', description: '', model: 'default', reasoning_effort: 'low', tools: [], prompt: '' },
      dependsOn: [], promptTemplate: 'Do the work.', timeout_ms: 5000, retries: 0, artifactContract: contract, outputSchema: HANDOFF_SCHEMA });
    expect(result.exitCode).toBe(125);
    expect(result.output).toContain('ENGINE_STATE_TAMPERED');
    expect(readStageStatus(project, runId, 'work').status).toBe('failed');
  });
});
