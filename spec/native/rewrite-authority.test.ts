import { identifyEvidence } from "../../dist-rewrite/records/evidence.js";
import { identifyCommand, runDeclaredCommand } from "../../dist-rewrite/exec/command.js";
import { gitAuthority } from "../../dist-rewrite/records/content.js";
import type { ContentScope } from "../../dist-rewrite/records/content.js";
import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setup } from "../../dist-rewrite/ops/setup.js";
import { authorityGrant } from "../../dist-rewrite/exec/policy.js";
import { parseBrief, type Result } from "../../dist-rewrite/contract/brief.js";
import type { RuntimeConfig } from "../../dist-rewrite/contract/runtime.js";
import { openJournal, readEvents, appendEvents, openWriter } from "../../dist-rewrite/records/state.js";
import { putEvidence, readEvidence } from "../../dist-rewrite/records/evidence.js";
import { reserveCommand } from "../../dist-rewrite/records/state.js";
import { claim, release, initializeState, recordOperation, storeEvidence, reclaimRecordOperations } from "../../dist-rewrite/records/state.js";
import { closeController, type ProcessPortsFactory } from "../../dist-rewrite/host/process.js";
import { launchInvocation } from "../../dist-rewrite/host/process.js";
const get = <T>(result: Result<T>): T => { if (!result.ok)
  throw new Error(JSON.stringify(result)); return result.value; };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let root: string;
afterEach(async () => { await closeController(); if (root)
  await rm(root, { recursive: true, force: true }); });
const fixturePath = new URL("../fixtures/rewrite-acceptance/authority.json", import.meta.url);
const authorityRows = JSON.parse(await readFile(fixturePath, 'utf8')).cells;
const space = [
  ...authorityRows.map((row: any) => ({ existing: row.disposition, kind: row.kind, outside: false,
    present: row.original === 'present', tmpDeclared: false, admitted: row.expected === 'succeed' })),
  // Both branches have unique native grants. The default-scratch row killed step-5's mutant.
  { existing: 'replace', kind: 'file', outside: true, present: true, tmpDeclared: false, admitted: true },
  { existing: 'replace', kind: 'file', outside: true, present: true, tmpDeclared: true, admitted: true },
];
it.each(space)('real setup declaration $existing/$kind/outside=$outside/present=$present/TMPDIR=$tmpDeclared', async ({ existing, kind,
 outside, present, tmpDeclared, admitted }) => {
  root = await mkdtemp(join(tmpdir(), 'rewrite-authority-'));
  const source = join(root, 'source'), project = join(root, 'project'), storeRoot = join(root, 'store');
  const runtimeRoot = join(storeRoot, 'pins', 'fixture'), configRoot = join(runtimeRoot, 'config');
  const cache = join(root, 'cache'), bin = join(root, 'bin'), home = join(root, 'home');
  for (const path of [source, configRoot, cache, bin, home, join(home, '.codex'), join(home, '.claude')])
    await mkdir(path, { recursive: true });
  await writeFile(join(home, '.claude.json'), '{}');
  // Version-only executable fixture; setup never invokes an adapter or a model.
  const declared = outside ? join(root, 'external') : 'out';
  const original = outside ? declared : join(source, declared);
  if (present) {
    if (kind === 'file')
      await writeFile(original, 'original');
    else
      await mkdir(original);
  }
  const config: RuntimeConfig = { roles: [{ id: 'role', backend: 'codex', model: 'fixture', effort: 'low', description: '', prompt: 'No model' }],
    sharedCaches: [cache], devices: ['/dev/null'],
    providerHomes: { codex: [join(home, '.codex')], claude: [join(home, '.claude'), join(home, '.claude.json')] } };
  const effective = outside ? declared : join(project, declared);
  const program = ("const fs=require('node:fs');const out=" +
    `${JSON.stringify(effective)}` +
    ";" +
    `${kind === 'file' ? "fs.appendFileSync(out,'authored')" : "fs.mkdirSync(out,{recursive:true});fs.writeFileSync(out+'/child','authored')"}` +
    ";fs.writeFileSync(process.env.TMPDIR+'/tmp','ok');const denied=[];for(const p of " +
    `${JSON.stringify([join(home, '.codex', 'denied'), join(home, '.claude', 'denied'), join(home, '.claude.json')])}` +
    "){try{fs.writeFileSync(p,'bad')}catch(e){denied.push(e.code)}}console.log(JSON.string" +
    "ify({env:process.env,denied}));");
  const metadata = { criteria: [{ id: 'correct', text: 'Synthetic' }], inputs: [], outputs: [{ path: declared, kind, existing }],
    commands: [{ id: 'baseline', argv: [process.execPath, '-e', program], env: { ONLY: 'declared', GIT_DIR: join(cache, 'operator-git'),
     ...(tmpDeclared ? { TMPDIR: cache } : {}) }, inputs: [], required: true }, { id: 'context', argv: ['/usr/bin/nice', '-n', '19',
     process.execPath, '-e', 'console.log(JSON.stringify(process.env));process.exit(7)'], env: {}, inputs: [], required: false }],
    results: [], allowBlocked: false };
  const bytes = Buffer.from('---\n' + JSON.stringify(metadata) + '\n---\nSynthetic');
  const digest = hash(bytes), brief = { bytes: identifyEvidence(bytes), digest, declaration: get(parseBrief(bytes)) };
  const configBytes = Buffer.from(JSON.stringify(config));
  await writeFile(join(configRoot, 'runtime.json'), configBytes);
  await chmod(join(configRoot, 'runtime.json'), 0o444);
  const manifest = Buffer.from(JSON.stringify([{ path: 'config/runtime.json', sha256: hash(configBytes), executable: false }]));
  await writeFile(join(runtimeRoot, '.pin'), manifest);
  await chmod(join(runtimeRoot, '.pin'), 0o444);
  const runtime = { path: 'pins/fixture/.pin', sha256: hash(manifest) };
  const database = get(initializeState(join(root, 'state.sqlite')));
  const location = { database, storeRoot, run: 'authority' };
  await mkdir(join(storeRoot, 'work', location.run, 'tmp'), { recursive: true });
  const processFactory: ProcessPortsFactory = writer => ({
    streamRoot: writer.journal.root, scratch: join(storeRoot, 'work', location.run, 'tmp'),
    storeEvidence: source => storeEvidence(writer.journal, source),
    operation: request => recordOperation(writer.journal, 'construct', request),
    putEvidence: bytes => putEvidence(writer.journal, bytes), readEvidence: ref => readEvidence(writer.journal, ref),
    async recordProcess(payload) { return appendEvents(writer, get(await readEvents(writer.journal, 0)).length, [payload]); },
  });
  const result = await setup({ project: source, target: project, brief, runtime }, {
    briefBytes: bytes, backend: 'codex', location, unit: { run: location.run, authority: 'synthetic-run', runtime }, configuration: config,
    configRoot, privateEnvironment: { PATH: bin + ':/usr/bin', HOME: home }, process: processFactory, abort: new AbortController().signal,
  });
  if (!admitted) {
    expect(result).toMatchObject({ ok: false, kind: 'invalid', detail: expect.stringContaining(declared) });
    const refused = get(await readEvents(get(await openJournal(location, 'read')), 0));
    expect(refused.some(event => ['process', 'ownership', 'invocation', 'command_reserved', 'command'].includes(event.payload.type))).toBe(false);
    return;
  }
  const measured = get(result);
  expect(measured.nativeGrant, JSON.stringify(measured)).toBe('applied');
  expect(measured.commands).toEqual([]);
  const journal = get(await openJournal(location, 'read'));
  const facts = get(await readEvents(journal, 0));
  const authority = facts.find(event => event.payload.type === 'run_authority')!.payload;
  if (authority.type !== 'run_authority')
    throw new Error('Missing authority');
  const heldWrite = get(await claim(join(journal.root, 'fixture-write'), null, { database, holder: journal.root }));
  try {
    const writer = get(await openWriter(journal, heldWrite, 'execution')), ports = processFactory(writer);
    const row = authority.authority.commands[0];
    await mkdir(row.scratch, { recursive: true });
    const grant = authorityGrant(authority.authority, 'command', row.scratch, undefined, undefined, row.id);
    const receipt = get(await launchInvocation(grant, {
      argv: ['/usr/bin/nice', '-n', '19', process.execPath, '-e', program], cwd: project, env: row.env,
      writableRoots: grant.writableRoots,
    }, ports, new AbortController().signal));
    expect(receipt).toMatchObject({ state: 'closed', exit: 0, grant: 'applied' });
    const observed = JSON.parse(Buffer.from(get(await readEvidence(journal, receipt.stdout))).toString());
    expect(observed.env).toMatchObject({ ONLY: 'declared', GIT_DIR: join(cache, 'operator-git'),
     TMPDIR: tmpDeclared ? cache : join(storeRoot, 'work/authority/commands/baseline') });
    expect(observed.denied).toHaveLength(3);
    for (const code of observed.denied)
      expect(['EACCES', 'EPERM', 'EROFS']).toContain(code);
    if (existing === 'replace' && kind === 'file' && outside && present && !tmpDeclared) {
      const projectClaim = get(await claim(project, { run: location.run, authority: 'synthetic-run', runtime }, { database,
       holder: journal.root }));
      try {
        const scope: ContentScope = { journal, layout: { location, project, protectedRoots: [journal.root, runtimeRoot],
         sharedCaches: [cache] },
          brief, inputBaseline: measured.inputs, outputBaseline: measured.outputs, projectClaim, git: gitAuthority(location,
           project), authority: authority.authority };
        const command = metadata.commands[1];
        const first = get(await identifyCommand(command, scope)), second = get(await identifyCommand(command, scope));
        expect(first.tree).toBe(second.tree);
        expect(first.context).not.toBe(second.context);
        expect(first.execution!.scratch).not.toBe(second.execution!.scratch);
        const reservation = get(await reserveCommand(writer, get(await readEvents(journal, 0)).length, command.id, first, {
         charge: 'command', address: { kind: 'setup', run: location.run } }));
        const request = { command, key: first, reservation };
        const receipt = get(await runDeclaredCommand(request, { scope, writer, process: ports, abort: new AbortController().signal }));
        expect(receipt.execution).toEqual({ state: 'complete', exit: 7 });
        expect(JSON.parse(Buffer.from(get(await readEvidence(journal, receipt.stdout))).toString())).toMatchObject({
         TMPDIR: first.execution!.scratch });
        const count = get(await readEvents(journal, 0)).length;
        expect(get(await runDeclaredCommand(request, { scope, writer, process: ports,
         abort: new AbortController().signal }))).toEqual(receipt);
        expect(get(await readEvents(journal, 0))).toHaveLength(count);
      }
      finally {
        get(await release(projectClaim, 'handoff'));
      }
    }
  }
  finally {
    get(await release(heldWrite, 'retire'));
  }
  const originalManifest = JSON.parse(Buffer.from(get(await readEvidence(journal, measured.outputs[0]))).toString());
  expect(originalManifest.path).toBe(declared);
  expect(originalManifest.snapshot.kind !== 'absent').toBe(present);
  expect(authority.authority.outputs[0]).toMatchObject({ write: outside ? 'exact' : 'project', provision: outside && !present });
  expect(authority.authority.purposes.work.writableRoots.includes(effective)).toBe(outside);
  // Exercise every model purpose's provider grant once, through the real native boundary.
  if (existing === 'replace' && kind === 'file' && outside && present && tmpDeclared) {
    const held = get(await claim(join(journal.root, 'native-grants'), null, { database, holder: journal.root }));
    try {
      const writer = get(await openWriter(journal, held, 'execution')), ports = processFactory(writer);
      for (const backend of ['codex', 'claude'] as const)
        for (const purpose of ['plan', 'work', 'gate'] as const) {
          const scratch = join(root, backend + purpose);
          await mkdir(scratch);
          const grant = authorityGrant(authority.authority, purpose, scratch, backend);
          const paths = [effective, join(home, '.codex', 'own'), join(home, '.claude', 'own'), join(home, '.claude.json'),
           join(storeRoot, 'runs', location.run, 'git-common', 'config')];
          const script = ("const fs=require('node:fs');console.log(JSON.stringify(" +
            `${JSON.stringify(paths)}` +
            ".map(p=>{try{fs.appendFileSync(p,'x');return true}catch{return false}})))");
          const receipt = get(await launchInvocation(grant, { argv: [process.execPath, '-e', script], cwd: project, env: {},
           writableRoots: grant.writableRoots, durationMs: 10000 }, ports, new AbortController().signal));
          expect(JSON.parse(Buffer.from(get(await readEvidence(journal,
           receipt.stdout))).toString())).toEqual([purpose === 'work', backend === 'codex', backend === 'claude', backend === 'claude', false]);
        }
    }
    finally {
      get(await release(held, 'retire'));
    }
  }
});
