import { fixtureAuthority } from "../fixtures/rewrite-authority.js";
import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { commandBasis } from "../../dist-rewrite/contract/runtime.js";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Claim, type ProcessPorts } from "../../dist-rewrite/host/process.js";
import { initializeState, claim, release, openJournal, openWriter, appendEvents, readEvents } from "../../dist-rewrite/records/state.js";
import { putEvidence, readEvidence } from "../../dist-rewrite/records/evidence.js";
import { reserveCommand, readCommand, recordOperation, storeEvidence } from "../../dist-rewrite/records/state.js";
import { identifyCommand, runDeclaredCommand } from "../../dist-rewrite/exec/command.js";
import { baseConclusion, requiredCommandResult } from "../../dist-rewrite/core/decisions.js";
import type { ContentScope } from "../../dist-rewrite/records/content.js";
import type { Result } from "../../dist-rewrite/contract/brief.js";
let root: string | undefined;
const claims: Claim[] = [];
afterEach(async () => {
  {

    for (const owned of claims.splice(0))
      await release(owned, 'retire');
    if (root)
      await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});
function get<T>(result: Result<T>): T { if (!result.ok)
  throw new Error(JSON.stringify(result)); return result.value; }
it('real lower units execute a fresh reservation once and the same command again only for a new tree key', async () => {
  root = await mkdtemp(join(tmpdir(), 'rewrite-command-integration-'));
  const storeRoot = join(root, 'store'), project = join(root, 'project');
  await mkdir(storeRoot);
  await mkdir(project);
  await writeFile(join(project, 'source'), 'before author work');
  await mkdir(join(root, 'scratch'));
  const database = get(initializeState(join(root, 'state.sqlite')));
  const journal = get(await openJournal({ database, storeRoot, run: 'CommandRun' }, 'create'));
  const ownership = { database, holder: journal.root };
  const projectClaim = get(await claim(project, null, ownership));
  claims.push(projectClaim);
  const execution = get(await claim(join(root, 'execution'), null, ownership));
  claims.push(execution);
  const writer = get(await openWriter(journal, execution, 'execution'));
  const processPorts: ProcessPorts = {
    streamRoot: journal.root, scratch: join(root, 'scratch'),
    operation: request => recordOperation(journal, 'construct', request),
    storeEvidence: source => storeEvidence(journal, source),
    putEvidence: bytes => putEvidence(journal, bytes), readEvidence: ref => readEvidence(journal, ref),
    async recordProcess(payload) { return appendEvents(writer, get(await readEvents(journal, 0)).length, [payload]); },
  };
  const command = { id: 'Check', argv: [process.execPath, '-e', ("const fs=require('node:fs');fs.writeFileSync('/dev/null','device');" +
        "fs.writeFileSync(process.env.TMPDIR+'/file','temporary');" +
        "console.log(JSON.stringify(process.env));")], env: { ONLY: 'declared' }, inputs: [], required: true };
  const briefBytes = get(await putEvidence(journal, Buffer.from('synthetic exact brief')));
  const resources = { journal, layout: { location: { database, storeRoot, run: 'CommandRun' }, project, protectedRoots: [journal.root] },
    brief: { bytes: briefBytes, digest: briefBytes.sha256, declaration: { body: 'Synthetic command integration', criteria: [{ id: 'Correct', text: 'Correct' }], inputs: [], outputs: [],
       commands: [command], results: [], allowBlocked: false } },
    inputBaseline: [], outputBaseline: [], projectClaim };
  const scope: ContentScope = { ...resources, authority: fixtureAuthority(resources) };
  const context = { scope, writer, process: processPorts, abort: new AbortController().signal };
  const run = async () => {
    const key = get(await identifyCommand(command, scope));
    const reservation = get(await reserveCommand(writer, get(await readEvents(journal, 0)).length, command.id, key, { charge: 'command',
     address: { kind: 'setup', run: 'CommandRun' } }));
    expect(reservation.state).toBe('reserved');
    const durable = get(await readCommand(journal, key));
    expect(durable?.state).toBe('uncertain');
    if (!durable)
      throw new Error('Missing real reservation');
    expect(await runDeclaredCommand({ command, key, reservation: durable }, context)).toMatchObject({ ok: false, kind: 'unknown' });
    const receipt = get(await runDeclaredCommand({ command, key, reservation }, context));
    expect(receipt.execution).toEqual({ state: 'complete', exit: 0 });
    const env = JSON.parse(Buffer.from(get(await readEvidence(journal, receipt.stdout))).toString());
    expect(env).toMatchObject({ ONLY: 'declared', TMPDIR: key.execution!.scratch });
    expect(get(await runDeclaredCommand({ command, key, reservation }, context))).toEqual(receipt);
    return { receipt, scratch: env.TMPDIR };
  };
  const first = await run();
  await writeFile(join(project, 'source'), 'after author work');
  const second = await run();
  expect(second.scratch).not.toBe(first.scratch);
  expect(second.receipt.key).not.toEqual(first.receipt.key);
  const events = get(await readEvents(journal, 0));
  expect(events.filter(event => event.payload.type === 'invocation_reserved')).toHaveLength(2);
  expect(events.filter(event => event.payload.type === 'command')).toHaveLength(2);
});
import { stateFixture } from "../fixtures/rewrite-state.js";
it('P10 finite duration retains not-started or interrupted facts without replay', async () => {
  const command = { id: 'Duration', argv: [process.execPath, '-e',
   "process.stdout.write('native command started\\n');setTimeout(()=>{},10000)"], env: {}, inputs: [], required: true, durationMs: 100 };
  const f = await stateFixture({ commands: [command] });
  await mkdir(join(f.root, 'scratch'));
  await f.admit();
  try {
    const key = get(await identifyCommand(command, f.scope)), invocation = { charge: 'command' as const, address: {
     kind: 'final' as const, run: 'Run' } };
    const reservation = get(await reserveCommand(f.execution, (await f.projection()).cursor, command.id, key, invocation));
    const context = { scope: f.scope, writer: f.execution, abort: new AbortController().signal, process: { streamRoot: f.journal.root,
     scratch: join(f.root, 'scratch'), operation: (request: any) => recordOperation(f.journal, 'construct', request),
     storeEvidence: (source: any) => storeEvidence(f.journal, source), putEvidence: (bytes: Uint8Array) => putEvidence(f.journal, bytes),
     readEvidence: (ref: any) => readEvidence(f.journal, ref), recordProcess: async (payload: any) => appendEvents(f.execution,
     (await f.projection()).cursor, [payload]) } };
    const result = await runDeclaredCommand({ command, key, reservation }, context);
    // The declared duration includes launch preparation; either cut must remain an honest direct fact.
    if (result.ok) {
      expect(result.value.execution.state).not.toBe('complete');
      expect(result.value.execution.reason).toMatch(/^(duration|closure_unknown|preparation_failed)$/);
      expect(get(await runDeclaredCommand({ command, key, reservation }, context))).toEqual(result.value);
    }
    else {
      expect(result).toMatchObject({ kind: 'unknown' });
      expect((await f.projection()).commands).toEqual([]);
      const unresolved = get(await readCommand(f.journal, key));
      expect(unresolved?.state).toBe('uncertain');
      expect(await runDeclaredCommand({ command, key, reservation: unresolved! }, context)).toMatchObject({ ok: false, kind: 'unknown' });
    }
  }
  finally {

    await f.close();
  }
});

it('declared argv reaches host paths and sockets while declaration changes still reject', async () => {
  const code = String.raw`
    const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),out={};
    try{fs.writeFileSync(path.resolve('..','outside'),'written');out.write=true}catch{out.write=false}
    const server=net.createServer();
    // A Unix socket path is limited to 104-108 bytes, so it is bound in a short directory this command creates and removes,
    // never under a TMPDIR of any length.
    const dir=fs.mkdtempSync('/tmp/fc-');
    const finish=()=>{fs.rmSync(dir,{recursive:true,force:true});console.log(JSON.stringify(out))};
    server.on('error',()=>{out.socket=false;finish()});
    server.listen(path.join(dir,'p.sock'),()=>{out.socket=true;server.close(finish)});
  `;
  {
    const command = { id: 'Verify', argv: [process.execPath, '-e', code], env: {}, inputs: [], required: true };
    const f = await stateFixture({ commands: [command] });
    await mkdir(join(f.root, 'scratch'));
    try {
      await f.admit();
      for (const modified of [{ ...command, argv: [...command.argv, 'changed'] }, { ...command, env: { EXTRA: 'changed' } }])
        expect(await identifyCommand(modified, f.scope)).toMatchObject({ ok: false, kind: 'conflict' });
      const key = get(await identifyCommand(command, f.scope));
      const reservation = get(await reserveCommand(f.execution, (await f.projection()).cursor, command.id, key,
        { charge: 'command', address: { kind: 'final', run: 'Run' } }));
      const ports: ProcessPorts = { streamRoot: f.journal.root, scratch: join(f.root, 'scratch'),
        operation: request => recordOperation(f.journal, 'construct', request),
        storeEvidence: source => storeEvidence(f.journal, source), putEvidence: bytes => putEvidence(f.journal, bytes),
        readEvidence: ref => readEvidence(f.journal, ref),
        recordProcess: async payload => appendEvents(f.execution, (await f.projection()).cursor, [payload]) };
      const receipt = get(await runDeclaredCommand({ command, key, reservation }, {
        scope: f.scope, writer: f.execution, process: ports, abort: new AbortController().signal }));
      expect(receipt.execution).toEqual({ state: 'complete', exit: 0 });
      expect(JSON.parse(Buffer.from(get(await readEvidence(f.journal, receipt.stdout))).toString()))
        .toEqual({ write: true, socket: true });
      const facts = get(await readEvents(f.journal, 0));
      expect(facts.filter(event => event.payload.type === 'process').at(-1)?.payload).toMatchObject({
        receipt: { state: 'closed' } });
      expect(receipt.owner).not.toHaveProperty('unconfined');
      expect((await f.projection()).commands).toEqual([receipt]);
    } finally {  await f.close(); }
  }
});

// A required command that exits non-zero is run once more on the run's base tree; nothing else costs a second process.
it('a failing required command runs once on the base tree and is classified; a passing or optional one never does', async () => {
  const node = (code: string) => [process.execPath, '-e', code];
  const probe = "const fs=require('fs');process.stdout.write(JSON.stringify({cwd:process.cwd(),env:process.env,flag:fs.readFileSync('flag','utf8')}));process.exit(1)";
  const commands = [
    { id: 'Prior', argv: node('0'), env: {}, inputs: [], required: true },
    { id: 'Always', argv: node('process.exit(1)'), env: {}, inputs: [], required: true },
    { id: 'Introduced', argv: node("process.exit(require('fs').readFileSync('flag','utf8')==='bad'?1:0)"), env: {}, inputs: [], required: true },
    { id: 'Where', argv: node(probe), env: { ONLY: 'declared' }, inputs: [], required: true },
    { id: 'NewTool', argv: ['./tool.sh'], env: {}, inputs: [], required: true },
    { id: 'Fine', argv: node('0'), env: {}, inputs: [], required: true },
    { id: 'Optional', argv: node('process.exit(1)'), env: {}, inputs: [], required: false },
  ];
  const f = await stateFixture({ commands });
  await mkdir(join(f.root, 'scratch'));
  await f.admit();
  try {
    await writeFile(join(f.project, 'flag'), 'original');
    const ports: ProcessPorts = { streamRoot: f.journal.root, scratch: join(f.root, 'scratch'),
      operation: request => recordOperation(f.journal, 'construct', request),
      storeEvidence: source => storeEvidence(f.journal, source), putEvidence: bytes => putEvidence(f.journal, bytes),
      readEvidence: ref => readEvidence(f.journal, ref),
      recordProcess: async payload => appendEvents(f.execution, (await f.projection()).cursor, [payload]) };
    const processes = async () => get(await readEvents(f.journal, 0)).filter(event => event.payload.type === 'process').length;
    const run = async (id: string, againstBase = true) => {
      const command = commands.find(item => item.id === id)!;
      const key = get(await identifyCommand(command, f.scope));
      const reservation = get(await reserveCommand(f.execution, (await f.projection()).cursor, command.id, key,
        { charge: 'command', address: { kind: 'final', run: 'Run' } }));
      const before = await processes();
      const receipt = get(await runDeclaredCommand({ command, key, reservation, ...(againstBase ? { againstBase } : {}) }, { scope: f.scope, writer: f.execution, process: ports,
        abort: new AbortController().signal }));
      return { receipt, spawned: await processes() - before };
    };
    // The first tree the run recorded is the base: the original bytes, before the author wrote anything.
    expect((await run('Prior')).spawned).toBe(1);
    await writeFile(join(f.project, 'flag'), 'bad');
    await writeFile(join(f.project, 'tool.sh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const always = await run('Always');
    expect(always.spawned).toBe(2);
    expect(always.receipt.execution).toEqual({ state: 'complete', exit: 1 });
    expect(always.receipt.base).toMatchObject({ execution: { state: 'complete', exit: 1 } });
    expect(commandBasis(always.receipt)).toBe('pre-existing');

    const introduced = await run('Introduced');
    expect(introduced.spawned).toBe(2);
    expect(introduced.receipt.base).toMatchObject({ execution: { state: 'complete', exit: 0 } });
    expect(commandBasis(introduced.receipt)).toBe('introduced');
    expect(introduced.receipt.base!.tree).toBe(always.receipt.base!.tree);
    expect(introduced.receipt.base!.tree).not.toBe(introduced.receipt.before);

    // Same env and declaration, a private copy of the original, removed afterwards; the author's tree is untouched.
    const where = await run('Where');
    const seen = JSON.parse(Buffer.from(get(await readEvidence(f.journal, where.receipt.base!.stdout))).toString());
    const mine = JSON.parse(Buffer.from(get(await readEvidence(f.journal, where.receipt.stdout))).toString());
    expect(seen).toMatchObject({ env: { ONLY: 'declared' }, flag: 'original' });
    expect(mine).toMatchObject({ cwd: f.project, env: { ONLY: 'declared' }, flag: 'bad' });
    expect(seen.cwd).not.toBe(f.project);
    // The environment each launch was asked for is compared at the launch port, in the exec-flow spec; here only that it ran in its own copy.
    expect(mine.env.TMPDIR).toBe(where.receipt.key.execution!.scratch);
    expect(existsSync(seen.cwd)).toBe(false);
    expect(seen.cwd).toBe(`${where.receipt.key.execution!.scratch}_base.tree`);
    expect(await readFile(join(f.project, 'flag'), 'utf8')).toBe('bad');

    // The command does not exist on the base: the base run did not complete, so it counts as introduced, with what was stored.
    const missing = await run('NewTool');
    expect(missing.receipt.execution).toEqual({ state: 'complete', exit: 1 });
    expect(baseConclusion(missing.receipt.base!)).toMatch(/^base run did not complete: (not_started: preparation_failed|unfinished: closure_unknown)(: \S.*)?$/);
    expect(commandBasis(missing.receipt)).toBe('introduced');

    // Passing and optional commands, and a failing one outside the final gate command phase, cost one process and carry no base run.
    for (const [id, againstBase] of [['Fine', true], ['Optional', true], ['Always', false]] as const) {
      const result = await run(id, againstBase);
      expect(result.spawned).toBe(1);
      expect(result.receipt).not.toHaveProperty('base');
      expect(commandBasis(result.receipt)).toBeUndefined();
    }
    expect((await f.projection()).commands.filter(receipt => receipt.base).map(receipt => receipt.command))
      .toEqual(['Always', 'Introduced', 'Where', 'NewTool']);
  } finally { await f.close(); }
});

// What a base run writes into the working tree through an absolute path is not the main command's: its receipt is fixed first, and
// the tree-binding owner (requiredCommandResult) decides whether that receipt still applies to the tree the base run left behind.
// Without `dependsOn` any change to the tree breaks the binding. With `dependsOn` only a change inside a declared dependency does:
// a base-run write elsewhere leaves the receipt satisfied. That is the guarantee `dependsOn` gives, for a base run as for an author.
it.each([
  [true, undefined, 'out', 'run'],
  [false, undefined, 'out', 'satisfied'],
  [true, ['declared'], 'out', 'satisfied'],
  [true, ['declared'], 'declared/out', 'run'],
] as const)('a base run that writes into the working tree (%s; dependsOn %j; to %s) leaves the main receipt as it was; the tree binding decides %s', async (writes, dependsOn, target, outcome) => {
  // The command finds the working tree through a file recorded in the base tree; it writes there from whichever copy it runs in.
  const body = `const fs=require('fs');${writes ? "fs.writeFileSync(fs.readFileSync('where','utf8'),process.cwd());" : ''}process.exit(1)`;
  const command = { id: 'Wrote', argv: [process.execPath, '-e', body], env: {}, inputs: [], required: true, ...(dependsOn ? { dependsOn: [...dependsOn] } : {}) };
  const f = await stateFixture({ commands: [command] });
  await mkdir(join(f.root, 'scratch'));
  await f.admit();
  try {
    const abs = join(f.project, target);
    await mkdir(join(f.project, 'declared'));
    await writeFile(join(f.project, 'declared', 'kept'), 'kept');
    await writeFile(join(f.project, 'where'), abs);
    const ports: ProcessPorts = { streamRoot: f.journal.root, scratch: join(f.root, 'scratch'),
      operation: request => recordOperation(f.journal, 'construct', request),
      storeEvidence: source => storeEvidence(f.journal, source), putEvidence: bytes => putEvidence(f.journal, bytes),
      readEvidence: ref => readEvidence(f.journal, ref),
      recordProcess: async payload => appendEvents(f.execution, (await f.projection()).cursor, [payload]) };
    const key = get(await identifyCommand(command, f.scope));
    const reservation = get(await reserveCommand(f.execution, (await f.projection()).cursor, command.id, key,
      { charge: 'command', address: { kind: 'stage', run: 'Run', stage: 'work', attempt: 'Attempt', invocation: 1 } }));
    const receipt = get(await runDeclaredCommand({ command, key, reservation, againstBase: true },
      { scope: f.scope, writer: f.execution, process: ports, abort: new AbortController().signal }));
    expect(commandBasis(receipt)).toBe('pre-existing');
    // The working tree holds the base run's write (the copy's path), not the main command's (the project's own path).
    expect(existsSync(abs)).toBe(writes);
    if (writes) expect(await readFile(abs, 'utf8')).toBe(`${key.execution!.scratch}_base.tree`);
    const now = get(await identifyCommand(command, f.scope));
    expect(receipt.after === now.tree).toBe(!writes);
    const result = await requiredCommandResult(f.journal, await f.projection(), command, { tree: now.tree, inputHashes: [] });
    expect(result.kind).toBe(outcome);
  } finally { await f.close(); }
});
