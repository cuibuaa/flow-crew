import { initializeState } from '../dist-rewrite/records/state.js';
import { identifyEvidence } from '../dist-rewrite/records/evidence.js';
import { interpretAuthority } from '../dist-rewrite/exec/policy.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Brief, Ref, Result } from '../dist-rewrite/contract/brief.js';
import type { RunProjection, JournalEvent, JournalPayload, Launch, Writer, RunObservation,
 CommandReceipt } from '../dist-rewrite/contract/runtime.js';
import type { Claim, ProcessPortsFactory } from '../dist-rewrite/host/process.js';
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const no = (kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown' = 'unknown'): Result<never> => ({ ok: false, kind,
 detail: 'typed refusal' });
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const ref = (path = 'evidence/a'): Ref => ({ path, sha256: hash(path) });
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fc-rewrite-ops-'));
  const initialized = initializeState(join(root, 'state.sqlite'));
  if (!initialized.ok)
    throw Error(initialized.detail);
  const location = { database: initialized.value, storeRoot: root, run: 'run_a' };
  const unitContext = { database: join(root, 'state.sqlite'), storeRoot: root, environment: { HOST_ONLY: 'explicit' } };
  const journal = { database: location.database, root: join(root, 'runs', location.run) };
  const source = join(root, 'source');
  const target = join(root, 'project');
  await mkdir(journal.root, { recursive: true });
  // Authored record layout for the frozen observational consumer; no Git process is needed.
  await mkdir(join(journal.root, 'git-common'));
  await mkdir(source);
  await writeFile(join(source, 'ignored.txt'), 'original');
  const runtime = ref('pins/run_a/.pin');
  const configuration = { roles: [{ id: 'role_a', description: 'Declared role', prompt: 'Explicit prompt', backend: 'codex' as const, model: 'declared-model',
     effort: 'declared-effort' }], sharedCaches: [], devices: ['/dev/null'],
     providerHomes: { codex: [], claude: [] } };
  const declaration: Brief = { criteria: [{ id: 'criterion', text: 'Exact goal' }], inputs: [], outputs: [], commands: [], results: [],
    allowBlocked: false, body: 'Opaque body\n' };
  const briefBytes = new TextEncoder().encode(("---\n" +
    `${JSON.stringify(Object.fromEntries(Object.entries(declaration).filter(([key]) => key !== 'body')))}` +
    "\n---\n" +
    `${declaration.body}` +
    ""));
  const brief = { bytes: identifyEvidence(briefBytes), digest: hash(briefBytes), declaration };
  const unit = { run: location.run, authority: 'synthetic-run', runtime };
  const setup = { project: source, target, brief: brief.digest, inputs: [], outputs: [], nativeGrant: 'applied' as const, commands: [] };
  const launch: Launch = { run: location.run, project: target, brief, roles: configuration.roles, runtime, unit, setup,
   requester: 'claude:opaque_session' };
  const plan = { revision: 'revision_a', digest: hash('plan'), executed: [], plan: { stages: [{ id: 'work', purpose: 'work' as const,
   role: 'role_a', after: [], instruction: 'Work', skills: [] }] } };
  const interpreted = interpretAuthority(declaration, configuration, { project: target, protectedRoots: [journal.root, join(root,
   'pins', 'run_a')], workRoot: join(root, 'work', location.run) }, []);
  if (!interpreted.ok)
    throw new Error(interpreted.detail);
  const projection: RunProjection = { invocations: [], lineage: [],
    backstop: { gateSuffix: 0, failureSuffix: 0, bestPassCount: null, segment: 0, settlement: null, obligation: null },
     authority: interpreted.value, run: location.run, cursor: 0, statusSince: 0, launch, currentStage: null, stageStates: [], transitions: [],
     revisions: [plan], reservations: [], intervals: [], intents: [], operations: [], brief, plan,
    status: 'pending', attempts: [], commands: [], leases: [], owners: [], restoring: null, checkpoints: [], outputs: [] };
  const owner = { pid: 101, start: 'birth-a', boot: 'boot-a' };
  const claim: Claim = { resource: target, owner, epoch: 'epoch_a', unit };
  const writer: Writer = { journal, owner, epoch: claim.epoch, kind: 'control', cursor: 0 };
  const observation: RunObservation = { unit, state: 'active', owner, evidence: [], detail: 'measured' };
  const events: JournalEvent[] = [];
  const append = (payloads: readonly JournalPayload[]) => {
    for (const payload of payloads)
      events.push({ seq: events.length + 1, run: location.run, at: '2026-01-01T00:00:00.000Z', payload });
    return events.length;
  };
  const process: ProcessPortsFactory = () => ({ putEvidence: async (bytes) => ok({ path: `blobs/${hash(bytes)}`, sha256: hash(bytes) }),
   readEvidence: async () => no('unavailable'), recordProcess: async (payload) => ok(append([payload])) });
  const command: CommandReceipt = { command: 'verify', key: { tree: hash('tree'), declaration: hash('declaration'), inputHashes: [],
   context: hash('context') },
    execution: { state: 'complete', exit: 0 }, stdout: ref('out'), stderr: ref('err'), before: hash('tree'), after: hash('tree'),
     sourceBound: true, spent: { actions: 1, durationMs: 1 } };
  return { root, unitContext, location, journal, source, target, runtime, configuration, briefBytes, brief, unit, setup, launch, plan,
   projection, owner, claim, writer, observation, events, append, process, command,
    request: { project: source, target, brief, runtime }, configRoot: join(root, 'pins', 'run_a', 'config'),
     clean: () => rm(root, { recursive: true, force: true }) };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
