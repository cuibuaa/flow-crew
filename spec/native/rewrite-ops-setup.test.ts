import {spawn} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import { it, expect, vi } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { mkdir, writeFile, readFile, readlink, symlink, link, lstat, readdir, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, known } from '../fixtures/rewrite-host.js';
import { stateFixture } from '../fixtures/rewrite-state.js';
import * as state from '../../dist-rewrite/records/state.js';
import { identifyEvidence, readEvidence } from '../../dist-rewrite/records/evidence.js';
import { setup, inspectSetup } from '../../dist-rewrite/ops/setup.js';
import { closeController } from '../../dist-rewrite/host/process.js';
const module = new URL('../../dist-rewrite/ops/setup.js', import.meta.url).href;
it(("native selective import preserves raw byte names, modes, links and nested Git; " +
  "excludes root authority; occupied publication refuses"), async () => {
  const f = await fixture();
  try {
    const source = join(f.outside, 'source'), target = join(f.work, 'imported');
    await mkdir(join(source, '.git'), { recursive: true });
    await writeFile(join(source, '.git', 'unreadable'), 'private');
    await chmod(join(source, '.git', 'unreadable'), 0);
    await mkdir(join(source, 'nested', '.git'), { recursive: true });
    await writeFile(join(source, 'nested', '.git', 'literal'), 'nested');
    // Probe the source filesystem, rather than assuming every host accepts non-UTF-8 names.
    let name = Buffer.concat([Buffer.from('raw-'), Buffer.from([255])]);
    const byteNames = await writeFile(Buffer.concat([Buffer.from(source + '/'), name]), 'raw bytes').then(() => true, () => false);
    if (!byteNames) {
      name = Buffer.from('raw-中');
      await writeFile(Buffer.concat([Buffer.from(source + '/'), name]), 'raw bytes');
    }
    const raw = Buffer.concat([Buffer.from(source + '/'), name]);
    await chmod(raw, 0o751);
    await link(raw, join(source, 'alias'));
    await symlink('alias', join(source, 'relative-link'));
    await symlink(join(source, 'alias'), join(source, 'absolute-link'));
    await writeFile(join(source, 'line\nbreak'), 'newline');
    await mkdir(join(source, 'empty'));
    const imported = await state.recordOperation(f.journal, 'construct', { module, method: 'importTask', args: [source, target, true] });
    known(imported);
    expect((await readdir(target, { encoding: 'buffer' })).map(n => n.toString('hex'))).toContain(name.toString('hex'));
    const copied = Buffer.concat([Buffer.from(target + '/'), name]);
    expect(await readFile(copied, 'utf8')).toBe('raw bytes');
    expect((await lstat(copied)).mode & 0o7777).toBe(0o751);
    expect((await lstat(copied)).ino).not.toBe((await lstat(raw)).ino);
    expect((await lstat(copied)).ino).not.toBe((await lstat(join(target, 'alias'))).ino);
    expect(await readFile(join(target, 'nested', '.git', 'literal'), 'utf8')).toBe('nested');
    await expect(access(join(target, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readlink(join(target, 'relative-link'))).toBe('alias');
    expect(await readlink(join(target, 'absolute-link'))).toBe(join(source, 'alias'));
    expect(await readFile(join(target, 'line\nbreak'), 'utf8')).toBe('newline');
    expect(await readdir(join(target, 'empty'))).toEqual([]);
    expect(await state.recordOperation(f.journal, 'construct', { module, method: 'importTask', args: [source, target,
     true] })).toMatchObject({ ok: false });
    expect(await readFile(copied, 'utf8')).toBe('raw bytes');
    known(await state.reclaimRecordOperations(f.journal));
    process.stderr.write('Native evidence native-import ' + JSON.stringify({ platform: process.platform, byteNames,
      nameHex: name.toString('hex') }) + '\n');
    await f.evidence('native-import', { imported, byteNames, nameHex: name.toString('hex') });
  }
  finally {
    await f.close();
  }
});
it('native no-replace publication race has one winner and never changes an occupied file, directory or symlink', async () => {
  const f = await fixture();
  try {
    const sources = [join(f.outside, 'one'), join(f.outside, 'two')], target = join(f.work, 'target');
    for (const [i, p] of sources.entries())
      await writeFile(p, String(i));
    const results = await Promise.all(sources.map(source => state.recordOperation(f.journal, 'construct', { module,
     method: 'importTask', args: [source, target, false] })));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(await readFile(target, 'utf8')).toBe(String(results.findIndex(r => r.ok)));
    known(await state.reclaimRecordOperations(f.journal));
    for (const kind of ['file', 'directory', 'symlink']) {
      const name = join(f.work, kind);
      if (kind === 'directory')
        await mkdir(name);
      else if (kind === 'symlink')
        await symlink('literal', name);
      else
        await writeFile(name, 'unchanged');
      expect(await state.recordOperation(f.journal, 'construct', { module, method: 'importTask', args: [sources[0], name,
       false] })).toMatchObject({ ok: false });
      if (kind === 'file')
        expect(await readFile(name, 'utf8')).toBe('unchanged');
      else if (kind === 'directory')
        expect(await readdir(name)).toEqual([]);
      else
        expect(await readlink(name)).toBe('literal');
      known(await state.reclaimRecordOperations(f.journal));
    }
    await f.evidence('native-publication', { results });
  }
  finally {
    await f.close();
  }
});
async function setupFixture(tmpOutside: boolean, insideHome = false) {
  const f = await stateFixture({}, undefined, insideHome), source = join(f.root, 'source'), target = join(f.root, 'setup-target'),
   cache = join(f.root, 'shared-cache');
  await mkdir(source);
  await mkdir(join(cache, 'tmp'), { recursive: true });
  await writeFile(join(source, 'ordinary'), 'source');
  const location = { ...f.location, run: 'Setup' }, scratch = join(f.location.storeRoot, 'work', 'Setup', 'tmp');
  await mkdir(scratch, { recursive: true });
  const declaration = { ...f.brief.declaration, commands: [{ id: 'verify', argv: ['synthetic-verify'], env: {
   TMPDIR: join(tmpOutside ? f.root : cache, 'tmp') }, inputs: [], required: true }] };
  const bytes = Buffer.from('---\n' + JSON.stringify((({ body, ...rest }) => rest)(declaration)) + '\n---\n' + declaration.body),
   ref = identifyEvidence(bytes), brief = { ...f.brief, declaration, bytes: ref, digest: ref.sha256 };
  const unit = { run: 'Setup', runtime: f.runtime, authority: 'synthetic-setup' }, request = { project: source, target, brief, runtime: f.runtime };
  const process = (writer: any) => ({ scratch, streamRoot: writer.journal.root,
   putEvidence: (bytes: Uint8Array) => state.putEvidence(writer.journal, bytes),
   storeEvidence: (source: any) => state.storeEvidence(writer.journal, source), readEvidence: (ref: any) => readEvidence(writer.journal, ref),
   operation: (request: any) => state.recordOperation(writer.journal, 'construct', request),
   recordProcess: async (payload: any) => state.appendEvents(writer, known(await state.readEvents(writer.journal, 0)).at(-1)?.seq ?? 0, [payload]) });
  const configuration = { ...f.configuration, sharedCaches: [cache] };
  return { f, location, source, target, request, context: { briefBytes: bytes, backend: 'codex' as const, location, unit, configuration,
   process, configRoot: f.configRoot, privateEnvironment: { PATH: globalThis.process.env.PATH!, HOME: f.root }, abort: new AbortController().signal } };
}
it.each([false, true])('A7 actual setup preserves granted TMPDIR or refuses outside declaration; outside=%s', async (outside) => {
  const s = await setupFixture(outside);
  try {
    const result = await setup(s.request, s.context);
    if (outside)
      expect(result).toMatchObject({ ok: false, kind: 'invalid', detail: expect.stringContaining('TMPDIR') });
    else {
      expect(result).toMatchObject({ ok: true, value: { nativeGrant: 'applied', commands: [] } });
      const journal = known(await state.openJournal(s.location, 'read'));
      const events = known(await state.readEvents(journal, 0));
      const authority = events.find(e => e.payload.type === 'run_authority')!.payload.authority;
      expect(authority.commands[0].env.TMPDIR).toBe(s.request.brief.declaration.commands[0].env.TMPDIR);
      expect(await readFile(join(s.target, 'ordinary'), 'utf8')).toBe('source');
    }
  }
  finally {
    await closeController();
    const opened = await state.openJournal(s.location, 'read');
    if (opened.ok)
      known(await state.reclaimRecordOperations(opened.value));
    await s.f.close();
  }
});
it('A3 setup confines work when the store is beneath FC_HOME beside state.sqlite', async () => {
  const s = await setupFixture(false, true);
  try {
    const result = await setup(s.request, s.context);
    expect(result).toMatchObject({ ok: true, value: { nativeGrant: 'applied' } });
    expect(s.location.storeRoot.startsWith(s.f.database.slice(0, s.f.database.lastIndexOf('/')) + '/')).toBe(true);
  }
  finally {
    await closeController();
    const journal = await state.openJournal(s.location, 'read');
    if (journal.ok)
      known(await state.reclaimRecordOperations(journal.value));
    await s.f.close();
  }
});

it('refuses setup before workload launch on real launcher failure with raw stderr and inspectable status', async () => {
  const s = await setupFixture(false);
  const original = SandboxManager.wrapWithSandboxArgv.bind(SandboxManager);
  let launches = 0;
  // Keep the real package preparation and host execution/recording path. The
  // actual native launcher rejects a deliberately invalid option before work.
  const launch = vi.spyOn(SandboxManager, 'wrapWithSandboxArgv').mockImplementation(async (...args) => {
    const wrapped = await original(...args);
    launches++;
    return { ...wrapped, argv: process.platform === 'linux'
      ? ['/usr/bin/bwrap', '--flowcrew-step6-invalid-option']
      : ['/usr/bin/sandbox-exec', '-f', '/dev/null', '/usr/bin/false'] };
  });
  try {
    const result = await setup(s.request, s.context);
    expect(result).toMatchObject({ ok: true, value: { nativeGrant: 'unavailable' } });
    expect(launches).toBe(1);
    const journal = known(await state.openJournal(s.location, 'read'));
    const events = known(await state.readEvents(journal, 0));
    const receipts = events.flatMap(event => event.payload.type === 'process' ? [event.payload.receipt] : []);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ state: 'closed', grant: 'applied' });
    expect(receipts[0].exit).not.toBe(0);
    const raw = Buffer.from(known(await readEvidence(journal, receipts[0].stderr))).toString().trim();
    expect(raw).not.toBe('');
    if (result.ok) expect(result.value.interpretation?.join('\n')).toContain('Cannot start confined work: ' + raw);
    expect(events.filter(event => event.payload.type === 'invocation_reserved' || event.payload.type === 'command')).toHaveLength(0);
    expect(events.some(event => event.payload.type === 'setup_prepared')).toBe(true);
    const cli = (argv:string[], input:unknown) => new Promise<{exit:number|null;stdout:string;stderr:string}>((done,reject)=>{
      const child = spawn(process.execPath,[new URL('../../dist-rewrite/cli.js',import.meta.url).pathname,...argv],{shell:false,cwd:resolve('.'),
        env:{...process.env,HOME:s.f.root,FC_HOME:dirname(s.f.database),FLOWCREW_STORE_ROOT:s.location.storeRoot,
          FLOWCREW_RUNTIME_ROOT:dirname(join(s.location.storeRoot,s.f.runtime.path))},stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
      child.once('error',reject);child.once('close',exit=>done({exit,stdout,stderr}));child.stdin.end(JSON.stringify(input));
    });
    const stdout: string[] = [], stderr: string[] = [];
    const { execute } = await import('../../dist-rewrite/ops/main.js');
    const exit = await execute(['start','--run',s.location.run,'--intent',JSON.stringify({id:'start_refused',kind:'start',
      run:s.location.run,unit:s.context.unit}),'--planner-role','author'], {
      cwd:resolve('.'),storeRoot:s.location.storeRoot,runtimeRoot:dirname(s.f.configRoot),home:dirname(s.f.database),
      environment:s.context.privateEnvironment,abort:s.context.abort,
      stdin:Buffer.from(JSON.stringify({...s.f.launch,run:s.location.run,project:s.target,brief:s.request.brief,
        unit:s.context.unit,backend:'codex',setup:known(result)})),
      stdout:async bytes=>{stdout.push(Buffer.from(bytes).toString());},stderr:async bytes=>{stderr.push(Buffer.from(bytes).toString());}
    });
    const start = {exit,stdout:stdout.join(''),stderr:stderr.join('')};

    expect(start.exit,start.stderr).not.toBe(0);
    expect(JSON.parse(start.stderr.trim().split('\n').at(-1)!).detail).toContain(raw);
    const status = await cli(['status',s.location.run],{});
    expect(status.exit,status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({version:2,run:s.location.run,host:{readiness:'unavailable'}});
    const after = known(await state.readEvents(journal,0));
    expect(after.filter(e=>e.payload.type==='invocation_reserved'||e.payload.type==='command')).toHaveLength(0);
    // Inspection of the original prepared authority remains possible after refusal.
    expect(await inspectSetup(s.request, s.location)).toMatchObject({ ok: true, value: { occupancy: 'same_run' } });
    const evidenceRoot = join(s.f.root, 'evidence');
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, 'setup-launch-refusal.json'),
      JSON.stringify({ result, launches, raw, receipts, start, status, workloadSpawns: after.filter(e =>
        e.payload.type === 'invocation_reserved' || e.payload.type === 'command').length }, null, 2));
  } finally {
    launch.mockRestore();
    await closeController();
    const journal = await state.openJournal(s.location, 'read');
    if (journal.ok) known(await state.reclaimRecordOperations(journal.value));
    await s.f.close();
  }
});

it('setup defers a required command whose declared frozen input makes its write impossible until real runtime enforcement', async () => {
  const s = await setupFixture(false);
  try {
    await writeFile(join(s.source, 'frozen.txt'), 'original');
    const declaration = { ...s.request.brief.declaration, inputs: [{ id: 'frozen', path: 'frozen.txt', kind: 'file' as const, frozen: true }],
      commands: [{ id: 'impossible', argv: [process.execPath, '-e', "require('node:fs').writeFileSync('frozen.txt','changed')"],
        env: {}, inputs: ['frozen'], required: true }] };
    const bytes = Buffer.from('---\n' + JSON.stringify((({ body, ...rest }) => rest)(declaration)) + '\n---\n' + declaration.body);
    const ref = identifyEvidence(bytes), request = { ...s.request, brief: { bytes: ref, digest: ref.sha256, declaration } };
    const measured = known(await setup(request, { ...s.context, briefBytes: bytes }));
    expect(measured).toMatchObject({ nativeGrant: 'applied', commands: [] });
    const journal = known(await state.openJournal(s.location, 'read')), facts = known(await state.readEvents(journal, 0));
    expect(facts.some(event => event.payload.type === 'command' || event.payload.type === 'invocation_reserved')).toBe(false);
    const authority = facts.find(event => event.payload.type === 'run_authority')!.payload.authority;
    const held = known(await state.claim(join(journal.root, 'runtime-check'), s.context.unit,
      { database: s.location.database, holder: journal.root }));
    try {
      const writer = known(await state.openWriter(journal, held, 'execution')), row = authority.commands[0];
      await mkdir(row.scratch, { recursive: true });
      const { authorityGrant } = await import('../../dist-rewrite/exec/policy.js');
      const { launchInvocation } = await import('../../dist-rewrite/host/process.js');
      const grant = authorityGrant(authority, 'command', row.scratch, undefined, undefined, row.id);
      const receipt = known(await launchInvocation(grant, { argv: declaration.commands[0].argv, cwd: s.target, env: row.env,
        writableRoots: grant.writableRoots }, s.context.process(writer), s.context.abort));
      expect(receipt.state).toBe('closed'); expect(receipt.exit).not.toBe(0);
      expect(await readFile(join(s.target, 'frozen.txt'), 'utf8')).toBe('original');
    } finally { known(await state.release(held, 'retire')); }
  } finally {
    await closeController();
    const journal = await state.openJournal(s.location, 'read'); if (journal.ok) known(await state.reclaimRecordOperations(journal.value));
    await s.f.close();
  }
});
