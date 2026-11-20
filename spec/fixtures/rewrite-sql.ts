import './rewrite-bytes.js';
import { vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Result, Brief } from '../../dist-rewrite/contract/brief.js';
import type { JournalPayload, Launch, Writer } from '../../dist-rewrite/contract/runtime.js';
import { initializeState, openJournal, openWriter, claim, release, protectedStatePaths, appendEvents, readEvents,
 readProjection } from '../../dist-rewrite/records/state.js';
import { interpretAuthority } from '../../dist-rewrite/exec/policy.js';

// SQL claims exercise the real state owner; host lifetime is an authored port here.
vi.mock('../../dist-rewrite/host/process.js', async original => ({
  ...await original<typeof import('../../dist-rewrite/host/process.js')>(),
  async beginOperation() { return { ok: true, value: { owner: { pid: 42, group: 42,
    start: randomUUID(), boot: 'authored-boot', authority: randomUUID() } } }; },
  async endOperation() { return { ok: true, value: 'dead' }; },
  async probeOwner() { return 'live'; },
}));
export const get = <T>(result: Result<T>): T => { if (!result.ok)
  throw new Error(JSON.stringify(result)); return result.value; };
export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function sqlFixture(patch: Partial<Brief> = {}, graph?: import('../../dist-rewrite/contract/plan.js').Plan | 'bootstrap',
 storeInsideHome = false) {
  const root = await mkdtemp(join(tmpdir(), 'fcrw-state-'));
  const privateRoot = join(root, 'state'), storeRoot = join(storeInsideHome ? privateRoot : root, 'store'), project = join(root, 'project');
  await mkdir(privateRoot);
  await Promise.all([mkdir(storeRoot), mkdir(project), mkdir(join(root, 'work'))]);
  const database = get(initializeState(join(privateRoot, 'state.sqlite'))), location = { storeRoot, run: 'Run', database };
  const journal = get(await openJournal(location, 'create')), ownership = { database, holder: journal.root };
  const projectClaim = get(await claim(project, null, ownership)), executionClaim = get(await claim(join(journal.root, 'execution'), null,
   ownership)), controlClaim = get(await claim(join(journal.root, 'control'), null, ownership));
  const execution = get(await openWriter(journal, executionClaim, 'execution')), control = get(await openWriter(journal, controlClaim, 'control'));
  const declaration: Brief = { criteria: [{ id: 'correct', text: 'Deliver reviewed work' }], inputs: [], outputs: [], commands: [],
   results: [], allowBlocked: false, body: 'Opaque goal', ...patch };
  const bytes = Buffer.from('---\n' + JSON.stringify((({ body, ...metadata }) => metadata)(declaration)) + '\n---\n' + declaration.body);
  const ref = { path: 'authored/brief', sha256: digest(bytes) }, brief = { bytes: ref, digest: ref.sha256, declaration };
  const role = { id: 'author', description: '', prompt: 'Full task', backend: 'codex' as const, model: 'fixture', effort: 'fixture' };
  const configuration = { roles: [role] };
  const runtime = { path: 'runtime/.pin', sha256: digest('authored immutable runtime') };
  const unit = { run: 'Run', authority: 'synthetic-run', runtime };
  const plan = graph && graph !== 'bootstrap' ? graph : { stages: [{ id: 'work', role: 'author', purpose: 'work' as const, after: [],
   instruction: 'Deliver', }, { id: 'gate', role: 'author', purpose: 'gate' as const, after: ['work'],
    commands: [], repair: { stage: 'repair', returnsTo: 'gate' } }, { id: 'repair',
   role: 'author', purpose: 'work' as const, after: [], instruction: 'Repair', }] };
  const launch: Launch = { run: 'Run', project, brief, runtime, roles: [role], unit, ...(graph === 'bootstrap' ? {} : { plan }), setup: {
   project: join(root, 'source'), target: project, brief: ref.sha256, inputs: [], outputs: [], commands: [] } };
  const authority = get(interpretAuthority(declaration, {
   project, protectedRoots: [journal.root, ...protectedStatePaths(database)], workRoot: join(root, 'work'), backend: 'codex' },
   declaration.outputs.map(() => 'absent')));
  const scope = { authority };
  const outputBaseline: import('../../dist-rewrite/contract/brief.js').Ref[] = [];
  const preparedLaunch = launch;
  const claims = [controlClaim, executionClaim, projectClaim];
  const releaseClaims = async () => { for (const held of claims.splice(0))
    get(await release(held, 'retire')); };
  const append = async (writer: Writer, payloads: readonly JournalPayload[]) => get(await appendEvents(writer,
   get(await readEvents(journal, 0)).length, payloads));
  const admit = async () => append(control, [{ type: 'run_authority', authority }, { type: 'setup_prepared', request: {
   project: launch.setup.project, target: project, brief, runtime }, unit, baselines: { inputs: [], outputs: outputBaseline },
   measured: null }, { type: 'setup_prepared', request: { project: launch.setup.project, target: project, brief, runtime }, unit, baselines: {
   inputs: [], outputs: outputBaseline }, measured: preparedLaunch.setup }, { type: 'admitted', launch: preparedLaunch }, {
   type: 'plan_committed', plan: { revision: 'Revision', plan: graph === 'bootstrap' ? { stages: [{ id: 'planner', role: 'author',
   purpose: 'plan', after: [], instruction: 'Plan finite work', }] } : plan, digest: digest(JSON.stringify(plan)), executed: [] } }]);
  return { root, database, location, journal, project, execution, control, configuration, runtime, unitContext: { database,
   storeRoot, environment: { PATH: '/usr/bin' }, pending: async () => ({ ok: true, value: [] }), observation: async () => ({ ok: true,
   value: null }) }, owner: execution.owner, ref, brief, launch: preparedLaunch, plan, scope, append, admit,
    projection: async () => get(await readProjection(journal)), releaseClaims,
    retireExecution: async () => { get(await release(executionClaim, 'retire')); claims.splice(claims.indexOf(executionClaim), 1); },
    close: async () => { await releaseClaims(); await rm(root, { recursive: true,
     force: true }); } };
}
export type SqlFixture = Awaited<ReturnType<typeof sqlFixture>>;
