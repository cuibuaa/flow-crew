import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Result, Brief } from '../../dist-rewrite/contract/brief.js';
import type { JournalPayload, Launch, Writer } from '../../dist-rewrite/contract/runtime.js';
import { reclaimRecordOperations, initializeState, openJournal, openWriter, claim, release, protectedStatePaths, appendEvents, readEvents,
 readProjection, putEvidence } from '../../dist-rewrite/records/state.js';
import { interpretAuthority } from '../../dist-rewrite/exec/policy.js';
import { hashInputs, captureTree, gitAuthority, type ContentScope } from '../../dist-rewrite/records/content.js';
export const get = <T>(result: Result<T>): T => { if (!result.ok)
  throw new Error(JSON.stringify(result)); return result.value; };
export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function stateFixture(patch: Partial<Brief> = {}, graph?: import('../../dist-rewrite/contract/plan.js').Plan | 'bootstrap',
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
  const ref = get(await putEvidence(journal, bytes)), brief = { bytes: ref, digest: ref.sha256, declaration };
  const role = { id: 'author', description: '', prompt: 'Full task', backend: 'codex' as const, model: 'fixture', effort: 'fixture' };
  const runtimeRoot = join(storeRoot, 'runtime'), configRoot = join(runtimeRoot, 'config');
  await mkdir(configRoot, { recursive: true });
  const configuration = { roles: [role] };
  const cli = Buffer.from('// inert fixture runtime'), config = Buffer.from(JSON.stringify(configuration));
  await writeFile(join(runtimeRoot, 'cli.js'), cli);
  await writeFile(join(configRoot, 'runtime.json'), config);
  const manifest = Buffer.from(JSON.stringify([{ path: 'cli.js', sha256: digest(cli), executable: false }, {
   path: 'config/runtime.json', sha256: digest(config), executable: false }]));
  await writeFile(join(runtimeRoot, '.pin'), manifest);
  for (const path of ['cli.js', 'config/runtime.json', '.pin'])
    await chmod(join(runtimeRoot, path), 0o444);
  const runtime = { path: 'runtime/.pin', sha256: digest(manifest) };
  const unit = { run: 'Run', authority: 'synthetic-run', runtime };
  const plan = graph && graph !== 'bootstrap' ? graph : { stages: [{ id: 'work', role: 'author', purpose: 'work' as const, after: [],
   instruction: 'Deliver', }, { id: 'gate', role: 'author', purpose: 'gate' as const, after: ['work'],
    commands: [], repair: { stage: 'repair', returnsTo: 'gate' } }, { id: 'repair',
   role: 'author', purpose: 'work' as const, after: [], instruction: 'Repair', }] };
  const launch: Launch = { run: 'Run', project, brief, runtime, roles: [role], unit, plan: graph === 'bootstrap' ? undefined : plan, setup: {
   project: join(root, 'source'), target: project, brief: ref.sha256, inputs: [], outputs: [], commands: [] } };
  const authority = get(interpretAuthority(declaration, {
   project, protectedRoots: [journal.root, ...protectedStatePaths(database)], workRoot: join(root, 'work'), backend: 'codex' },
   declaration.outputs.map(() => 'absent')));
  const scope: ContentScope = { journal, brief, layout: { location, project, protectedRoots: [journal.root,
   ...protectedStatePaths(database)] }, authority, inputBaseline: [], outputBaseline: [], projectClaim,
   git: gitAuthority(location, project) };
  const outputBaseline = get(await hashInputs({ ...scope, brief: { ...brief, declaration: { ...declaration,
   inputs: declaration.outputs.map((output, index) => ({ id: 'original_' + index, path: output.path, kind: output.kind, frozen: false })) } } }));
  const inputBaseline = get(await hashInputs(scope));
  const preparedScope = { ...scope, inputBaseline, outputBaseline }, baseTree = get(await captureTree(preparedScope));
  const preparedLaunch = { ...launch, setup: { ...launch.setup, inputs: inputBaseline, outputs: outputBaseline, tree: baseTree } };
  const claims = [controlClaim, executionClaim, projectClaim];
  const releaseClaims = async () => { for (const held of claims.splice(0))
    get(await release(held, 'retire')); };
  const append = async (writer: Writer, payloads: readonly JournalPayload[]) => get(await appendEvents(writer,
   get(await readEvents(journal, 0)).length, payloads));
  // `recordTree: false` writes what a run prepared before setup recorded its base tree holds: the same facts without the tree.
  const admit = async ({ recordTree = true } = {}) => {
    const { tree, ...untreed } = preparedLaunch.setup, setup = recordTree ? preparedLaunch.setup : untreed,
      baselines = { inputs: inputBaseline, outputs: outputBaseline, ...(recordTree ? { tree } : {}) }, admitted = { ...preparedLaunch, setup };
    return append(control, [{ type: 'run_authority', authority }, { type: 'setup_prepared', request: {
   project: launch.setup.project, target: project, brief, runtime }, unit, baselines, measured: null }, { type: 'setup_prepared', request: {
   project: launch.setup.project, target: project, brief, runtime }, unit, baselines, measured: setup }, { type: 'admitted', launch: admitted }, {
   type: 'plan_committed', plan: { revision: 'Revision', plan: graph === 'bootstrap' ? { stages: [{ id: 'planner', role: 'author',
   purpose: 'plan', after: [], instruction: 'Plan finite work', }] } : plan, digest: digest(JSON.stringify(plan)), executed: [] } }]);
  };
  return { root, database, location, journal, project, execution, control, configuration, configRoot, runtime, unitContext: { database,
   storeRoot, environment: { PATH: '/usr/bin' }, pending: async () => ({ ok: true, value: [] }), observation: async () => ({ ok: true,
   value: null }) }, owner: execution.owner, ref, brief, launch: preparedLaunch, plan, scope: preparedScope, append, admit,
    projection: async () => get(await readProjection(journal)), releaseClaims,
    retireExecution: async () => { get(await release(executionClaim, 'retire')); claims.splice(claims.indexOf(executionClaim), 1); },
     tree: async () => get(await captureTree(preparedScope)),
    close: async () => { get(await reclaimRecordOperations(journal)); await releaseClaims(); await rm(root, { recursive: true,
     force: true }); } };
}
export type StateFixture = Awaited<ReturnType<typeof stateFixture>>;
