import { fixtureAuthority } from "../fixtures/rewrite-authority.js";
import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeController, type Claim, type ProcessPorts } from "../../dist-rewrite/host/process.js";
import { initializeState, claim, release, openJournal, openWriter, appendEvents, readEvents } from "../../dist-rewrite/records/state.js";
import { putEvidence, readEvidence } from "../../dist-rewrite/records/evidence.js";
import { reserveCommand, readCommand, recordOperation, storeEvidence } from "../../dist-rewrite/records/state.js";
import { identifyCommand, runDeclaredCommand } from "../../dist-rewrite/exec/command.js";
import type { ContentScope } from "../../dist-rewrite/records/content.js";
import type { Result } from "../../dist-rewrite/contract/brief.js";
let root: string | undefined;
const claims: Claim[] = [];
afterEach(async () => {
  {
    await closeController();
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
  const resources = { journal, layout: { location: { database, storeRoot, run: 'CommandRun' }, project, protectedRoots: [journal.root],
   sharedCaches: [] },
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
it('P10 finite duration retains not-started or interrupted facts and never reexecutes an unknown reservation', async () => {
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
    await closeController();
    await f.close();
  }
});
