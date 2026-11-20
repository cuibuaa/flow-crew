import { it, expect, vi } from 'vitest';
import { mkdir, writeFile, readFile, readlink, symlink, link, lstat, readdir, chmod, access, unlink, rename, utimes } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, known } from '../fixtures/rewrite-host.js';
import { stateFixture } from '../fixtures/rewrite-state.js';
import * as state from '../../dist-rewrite/records/state.js';
import { identifyEvidence, readEvidence } from '../../dist-rewrite/records/evidence.js';
import { setup } from '../../dist-rewrite/ops/setup.js';
import { main } from '../../dist-rewrite/ops/main.js';
import * as preparation from '../../dist-rewrite/ops/preparation.js';
import * as host from '../../dist-rewrite/host/process.js';
import { nativeTool, nativeExec } from '../../dist-rewrite/host/process.js';
import { contentIdentity, settleFrozenInputs, changedTreePaths } from '../../dist-rewrite/records/content.js';
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
it.each([false, true])('native no-replace publication race has one winner and never changes an occupied file, directory or symlink (copier noise=%s)', async (noise) => {
  const f = await fixture();
  try {
    const sources = [join(f.outside, 'one'), join(f.outside, 'two')], target = join(f.work, 'target');
    for (const [i, p] of sources.entries())
      await writeFile(p, String(i));
    const race = () => Promise.all(sources.map(source => state.recordOperation(f.journal, 'construct', { module,
     method: 'importTask', args: [source, target, false] })));
    const results = noise ? await withCopier(f, 'noise', race) : await race();
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
it('import content identity covers raw names, all entry kinds, modes and exact exclusions', async () => {
  const f = await fixture();
  try {
    const source = join(f.outside, 'identity'), target = join(f.work, 'identity');
    await mkdir(join(source, '.git'), { recursive: true });
    await writeFile(join(source, '.git', 'ignored'), 'authority');
    await mkdir(join(source, 'nested', '.git'), { recursive: true });
    await writeFile(join(source, 'nested', '.git', 'kept'), 'nested');
    await writeFile(join(source, 'frozen'), 'excluded');
    const nice = await nativeTool('nice');
    await nativeExec([nice, '-n', '19', await nativeTool('python3'), '-I', '-S', '-B', '-c',
      'import os,sys,socket; p=os.fsencode(sys.argv[1]); os.mkfifo(p+b"/fifo"); s=socket.socket(socket.AF_UNIX); os.chdir(p); s.bind("socket"); s.close()', source]);
    const excluded = ['.git', 'frozen'], before = await contentIdentity(source, excluded);
    known(await state.recordOperation(f.journal, 'construct', { module, method: 'importTask', args: [source, target, true] }));
    expect(await contentIdentity(target, excluded)).toBe(before);
    expect((await lstat(join(target, 'fifo'))).isFIFO()).toBe(true);
    expect((await lstat(join(target, 'socket'))).isSocket()).toBe(true);
    await writeFile(join(source, '.git', 'ignored'), 'new authority');
    await writeFile(join(source, 'frozen'), 'new excluded bytes');
    expect(await contentIdentity(source, excluded)).toBe(before);
    const stable = await contentIdentity(target, excluded);
    await utimes(join(target, 'nested', '.git', 'kept'), 1, 1);
    expect(await contentIdentity(target, excluded)).toBe(stable);
    const raw = Buffer.concat([Buffer.from(target + '/raw-'), Buffer.from([0xfe])]);
    const byteNames = await writeFile(raw, 'raw').then(() => true, () => false);
    const observedRaw = byteNames ? raw : Buffer.from(join(target, 'raw-中'));
    if (!byteNames) await writeFile(observedRaw, 'raw');
    const changes = [
      async () => { await writeFile(join(target, 'extra'), 'extra'); },
      async () => { await mkdir(join(target, 'empty')); },
      async () => { await chmod(join(target, 'nested'), 0o750); },
      async () => { await writeFile(join(target, 'nested', '.git', 'kept'), 'changed'); },
      async () => { await symlink('first', join(target, 'link')); },
      async () => { await unlink(join(target, 'link')); await symlink('second', join(target, 'link')); },
      async () => { await chmod(join(target, 'extra'), 0o751); },
      async () => { await chmod(target, 0o750); },
      async () => { await unlink(join(target, 'fifo')); await writeFile(join(target, 'fifo'), ''); },
      async () => { await rename(observedRaw, join(target, 'renamed')); },
    ];
    for (const change of changes) {
      const prior = await contentIdentity(target, excluded);
      await change();
      expect(await contentIdentity(target, excluded)).not.toBe(prior);
    }
  } finally { await f.close(); }
});

// The real copier still runs. Only its stream or its completed copy is perturbed,
// deterministically before import resumes its identity checks. Each recordOperation
// has a fresh process/nativeTool cache, so the first PATH hit is this wrapper.
async function withCopier<T>(f: Awaited<ReturnType<typeof fixture>>, action: 'noise' | 'source' | 'destination',
  run: () => Promise<T>): Promise<T> {
  const real = await nativeTool('rsync'), nice = await nativeTool('nice');
  const bin = join(f.outside, 'bin'), trace = join(f.outside, 'copier-argv');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'rsync'), `#!${process.execPath}
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
const child = spawn(${JSON.stringify(nice)}, ['-n', '19', ${JSON.stringify(real)}, ...args], {stdio:'inherit'});
child.on('error', error => { throw error; });
child.on('close', code => {
if (code !== 0) process.exit(code ?? 1);
process.stdout.write('>f.......\\n');
const action = ${JSON.stringify(action)};
if (action !== 'noise') fs.writeFileSync(args.at(action === 'source' ? -2 : -1), 'changed after copy');
});
`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = bin + ':' + path;
  try { return await run(); }
  finally { process.env.PATH = path; }
}

// openrsync (the macOS system rsync) creates a socket entry by binding "<destination operand>/<temporary name>"
// verbatim (OpenBSD usr.bin/rsync/mktemp.c, mkstempsock) and fails with EINVAL when that string does not fit
// sun_path: 104 bytes on macOS, 108 on Linux. GNU rsync on Linux has no such failure, so this wrapper applies
// openrsync's rule to the operand it is given and then runs the real copier.
it('import copies a socket entry however long the run directory is', async () => {
  const f = await fixture();
  try {
    const real = await nativeTool('rsync'), nice = await nativeTool('nice');
    const bin = join(f.outside, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'rsync'), `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2), destination = args.at(-1);
const bound = destination.replace(/\\/?$/, '/') + '.socket.XXXXXX';
if (Buffer.byteLength(bound) >= 104) { process.stderr.write('rsync: error: mkstempsock: Invalid argument\\n'); process.exit(1); }
process.exit(spawnSync(${JSON.stringify(nice)}, ['-n', '19', ${JSON.stringify(real)}, ...args], {stdio:'inherit'}).status ?? 1);
`, { mode: 0o755 });
    const source = join(f.outside, 'with-socket');
    // Deeper than any socket path limit: every component is legal, only the whole path is long.
    const parent = join(f.work, ...['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)]), target = join(parent, 'imported');
    expect(Buffer.byteLength(parent)).toBeGreaterThan(180);
    await mkdir(source);
    await nativeExec([nice, '-n', '19', await nativeTool('python3'), '-I', '-S', '-B', '-c',
      'import os,sys,socket; os.chdir(sys.argv[1]); s=socket.socket(socket.AF_UNIX); s.bind("socket"); s.close()', source]);
    const path = process.env.PATH;
    process.env.PATH = bin + ':' + path;
    try { known(await state.recordOperation(f.journal, 'construct', { module, method: 'importTask', args: [source, target, true] })); }
    finally { process.env.PATH = path; }
    expect((await lstat(join(target, 'socket'))).isSocket()).toBe(true);
    expect(await contentIdentity(target, [])).toBe(await contentIdentity(source, []));
  } finally { await f.close(); }
});

it('single-file import ignores openrsync-style stdout from the real copier', async () => {
  const f = await fixture();
  try {
    const source = join(f.outside, 'single'), target = join(f.work, 'single');
    await writeFile(source, 'one file');
    const result = await withCopier(f, 'noise', () => state.recordOperation(f.journal, 'construct', {
      module, method: 'importTask', args: [source, target, false] }));
    known(result);
    expect(await readFile(target, 'utf8')).toBe('one file');
    const calls = (await readFile(join(f.outside, 'copier-argv'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('--itemize-changes');
  } finally { await f.close(); }
});

it.each([
  ['source', 'Source changed during import'],
  ['destination', 'Imported copy differs from source'],
] as const)('import refuses a deterministic %s change between copy and check', async (action, detail) => {
  const f = await fixture();
  try {
    const source = join(f.outside, 'single'), target = join(f.work, 'single');
    await writeFile(source, 'original bytes');
    const result = await withCopier(f, action, () => state.recordOperation(f.journal, 'construct', {
      module, method: 'importTask', args: [source, target, false] }));
    expect(result).toMatchObject({ ok: false, detail });
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.close(); }
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

it.each([false, true])('setup preserves any declared TMPDIR without a grant (outside=%s)', async outside => {
  const s = await setupFixture(outside);
  try {
    const measured = known(await setup(s.request, s.context));
    expect(measured).not.toHaveProperty('nativeGrant');
    expect(measured.commands).toEqual([]);
    expect(measured.interpretation?.join('\n')).toContain('All authors/providers/commands run with host-account rights.');
    const journal = known(await state.openJournal(s.location, 'read')), events = known(await state.readEvents(journal, 0));
    const authority = events.find(e => e.payload.type === 'run_authority')!.payload.authority;
    expect(authority.commands[0].env.TMPDIR).toBe(s.request.brief.declaration.commands[0].env.TMPDIR);
    expect(events.some(e => e.payload.type === 'process' || e.payload.type === 'ownership')).toBe(false);
    // The project as setup left it is recorded once, in both setup facts, as the base every gate compares with.
    expect(measured.tree).toMatch(/^[0-9a-f]{64}$/);
    expect(events.flatMap(e => e.payload.type === 'setup_prepared' ? [e.payload.baselines.tree] : [])).toEqual([measured.tree, measured.tree]);
    expect(known(await changedTreePaths(journal, measured.tree!, measured.tree!))).toEqual([]);
    expect(await readFile(join(s.target, 'ordinary'), 'utf8')).toBe('source');
  } finally {
    const opened = await state.openJournal(s.location, 'read'); if (opened.ok) known(await state.reclaimRecordOperations(opened.value));
    await s.f.close();
  }
});
it('public setup/start preserve source project and state.sqlite as stable-read authority resources', async () => {
  const s = await setupFixture(false);
  const admission = vi.spyOn(preparation, 'admitPreparation'); // Observe the real public preflight result.
  const perform = host.performOperation;
  // Run the real pinned setup; stop at the subsequent runner dispatch, before any provider can enter.
  const dispatch = vi.spyOn(host, 'performOperation').mockImplementationOnce(perform)
    .mockResolvedValueOnce({ ok: true, value: 0 });
  let journal: Awaited<ReturnType<typeof state.openJournal>> | undefined;
  try {
    const brief = join(s.f.root, 'brief.md');
    await writeFile(brief, s.context.briefBytes);
    const errors: string[] = [];
    const context = { cwd: s.source, storeRoot: s.location.storeRoot, home: dirname(s.f.database),
      runtimeRoot: resolve(import.meta.dirname, '../..'), environment: s.context.privateEnvironment,
      stdin: new Uint8Array(), abort: s.context.abort, stdout: async () => {},
      stderr: async (bytes: Uint8Array) => { errors.push(Buffer.from(bytes).toString()); } };
    const args = [brief, '--project', s.source, '--config', join(s.f.configRoot, 'runtime.json')];
    const expected = [
      { path: s.source, access: 'stable-read' },
      { path: s.f.database, access: 'stable-read' },
    ];
    expect(await main(['setup', ...args], context), errors.join('')).toBe(0);
    expect(admission).toHaveBeenCalledTimes(1);
    expect(known(await admission.mock.results[0].value).resources).toEqual(expect.arrayContaining(expected));
    expect(await main(['start', ...args], context), errors.join('')).toBe(0);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const [setupArgs] = dispatch.mock.calls[0][0].args as [string[]];
    journal = await state.openJournal({ ...s.location, run: setupArgs[2] }, 'read');
    const events = known(await state.readEvents(known(journal), 0));
    const authority = events.find(event => event.payload.type === 'run_authority')!.payload.authority;
    expect(authority.resources).toEqual(expect.arrayContaining(expected));
    expect(events.some(event => event.payload.type === 'setup_prepared' && event.payload.measured !== null)).toBe(true);
  } finally {
    dispatch.mockRestore();
    admission.mockRestore();
    if (journal?.ok) known(await state.reclaimRecordOperations(journal.value));
    await s.f.close();
  }
});

it('setup retains separate project and state destinations when the store is beneath FC_HOME', async () => {
  const s = await setupFixture(false, true);
  try {
    expect(await setup(s.request, s.context)).toMatchObject({ ok: true, value: { commands: [] } });
    expect(s.location.storeRoot.startsWith(s.f.database.slice(0, s.f.database.lastIndexOf('/')) + '/')).toBe(true);
  } finally {
    const opened = await state.openJournal(s.location, 'read'); if (opened.ok) known(await state.reclaimRecordOperations(opened.value));
    await s.f.close();
  }
});

it.each([false, true])('frozen input copy has independent inodes and mutation is observed/restored without changing source (old hardlink case=%s)', async hardlinked => {
  const s = await setupFixture(false);
  try {
    const original = join(s.source, 'frozen.txt'); await writeFile(original, 'original');
    if (hardlinked) await link(original, join(s.source, 'alias.txt'));
    expect((await lstat(original)).nlink).toBe(hardlinked ? 2 : 1);
    const declaration = { ...s.request.brief.declaration, inputs: [{ id: 'frozen', path: 'frozen.txt', kind: 'file' as const, frozen: true }], commands: [] };
    const { body, ...metadata } = declaration;
    const bytes = Buffer.from('---\n' + JSON.stringify(metadata) + '\n---\n' + body), ref = identifyEvidence(bytes);
    const brief = { bytes: ref, digest: ref.sha256, declaration };
    const measured = known(await setup({ ...s.request, brief }, { ...s.context, briefBytes: bytes }));
    const copy = join(s.target, 'frozen.txt'), sourceStat = await lstat(original), copyStat = await lstat(copy);
    expect([copyStat.dev, copyStat.ino]).not.toEqual([sourceStat.dev, sourceStat.ino]);
    const journal = known(await state.openJournal(s.location, 'read')), events = known(await state.readEvents(journal, 0));
    const authority = events.find(e => e.payload.type === 'run_authority')!.payload.authority;
    const held = known(await state.claim(s.target, s.context.unit, { database: s.location.database, holder: journal.root }));
    try {
      const writer = known(await state.openWriter(journal, held, 'execution'));
      const { launchInvocation } = await import('../../dist-rewrite/host/process.js');
      const receipt = known(await launchInvocation({}, { argv: [process.execPath, '-e', "require('fs').writeFileSync('frozen.txt','changed')"], cwd: s.target, env: {} }, s.context.process(writer), s.context.abort));
      expect(receipt).toMatchObject({ state: 'closed', exit: 0 });
      expect(await readFile(copy, 'utf8')).toBe('changed');
      expect(await readFile(original, 'utf8')).toBe('original');
      const result = known(await settleFrozenInputs({ journal, layout: { location: s.location, project: s.target, protectedRoots: [journal.root] },
        brief, authority, inputBaseline: measured.inputs, outputBaseline: measured.outputs, projectClaim: held }));
      expect(result).toMatchObject({ state: 'restored' });
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(await readFile(copy, 'utf8')).toBe('original');
      expect(await readFile(original, 'utf8')).toBe('original');
      if (hardlinked) expect(await readFile(join(s.source, 'alias.txt'), 'utf8')).toBe('original');
    } finally { known(await state.release(held, 'handoff')); }
  } finally {
    const journal = await state.openJournal(s.location, 'read'); if (journal.ok) known(await state.reclaimRecordOperations(journal.value));
    await s.f.close();
  }
});

it('historical pin config and brief sandbox keys decode with advisories without changing approved bytes', async () => {
  const s = await setupFixture(false);
  try {
    const { parseBrief } = await import('../../dist-rewrite/contract/brief.js');
    const { parseRuntime } = await import('../../dist-rewrite/contract/runtime.js');
    const configPath = join(s.f.configRoot, 'runtime.json'), pinPath = join(s.location.storeRoot, s.f.runtime.path);
    const config = { ...s.f.configuration, sharedCaches: ['missing-cache'], devices: ['missing-device'], providerHomes: { ignored: true } };
    await chmod(configPath, 0o644); await writeFile(configPath, JSON.stringify(config));
    const entries = JSON.parse(await readFile(pinPath, 'utf8'));
    entries.find((entry: any) => entry.path === 'config/runtime.json').sha256 = createHash('sha256').update(await readFile(configPath)).digest('hex');
    const manifest = Buffer.from(JSON.stringify(entries)); await chmod(pinPath, 0o644); await writeFile(pinPath, manifest);
    await chmod(configPath, 0o444); await chmod(pinPath, 0o444);
    const runtime = { ...s.f.runtime, sha256: createHash('sha256').update(manifest).digest('hex') };
    const { body, ...metadata } = s.request.brief.declaration;
    const legacy = { ...metadata, commands: metadata.commands.map(command => ({ ...command, unconfined: true })) };
    const bytes = Buffer.from('---\n' + JSON.stringify(legacy) + '\n---\n' + body), ref = identifyEvidence(bytes), warnings: string[] = [];
    const declaration = known(parseBrief(bytes, line => warnings.push(line)));
    const configuration = known(parseRuntime(JSON.parse(await readFile(configPath, 'utf8')), line => warnings.push(line)));
    const request = { ...s.request, runtime, brief: { bytes: ref, digest: ref.sha256, declaration } };
    const measured = known(await setup(request, { ...s.context, configuration, briefBytes: bytes, unit: { ...s.context.unit, runtime } }));
    expect(measured.brief).toBe(ref.sha256); expect(measured).not.toHaveProperty('nativeGrant');
    expect(warnings.filter(line => line.startsWith('config.'))).toHaveLength(1);
    expect(warnings).toHaveLength(2); // One public brief boundary and one configuration boundary; the byte recheck is silent.
    expect(warnings.every(line => line.includes('these keys constrain nothing'))).toBe(true);
    const journal = known(await state.openJournal(s.location, 'read'));
    expect(Buffer.from(known(await readEvidence(journal, ref)))).toEqual(bytes);
    expect(known(await state.readEvents(journal, 0)).some(event => event.payload.type === 'setup_prepared')).toBe(true);
  } finally {
    const journal = await state.openJournal(s.location, 'read'); if (journal.ok) known(await state.reclaimRecordOperations(journal.value));
    await s.f.close();
  }
});
