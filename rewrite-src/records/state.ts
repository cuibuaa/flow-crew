import { processClosed } from '../contract/runtime.js';
import { performOperation } from '../host/process.js';
import { DatabaseSync } from 'node:sqlite';
import { constants, realpathSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beginOperation, endOperation, probeOwner, runOperation, inOperation, type OperationRequest, type Claim }
  from '../host/process.js';
import { initializeEvidence } from './evidence.js';
import type { RunLocation, Writer } from '../contract/runtime.js';

import { ownerSchema, commandRefs, backstopSchema, initialBackstop, observedPathSchema, observedGenerationSchema, commandKeySchema }
  from '../contract/runtime.js';
import { runAuthoritySchema } from '../contract/runtime.js';
// Private fact grammar and application owner for journal append and projection.
import { z } from 'zod';
import { hashSchema as hash, idSchema, refSchema, declaredPathSchema, type Id, type Result } from '../contract/brief.js';
import { basename, dirname, join, resolve, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseRunStatusFile, parseSetupRequest, parseRunRef, parseSetupEvidence, parseLaunch, parseControlIntent, parseOperation, parseRunObservation }
  from '../contract/runtime.js';
import type { ActiveInterval, AttemptReceipt, Checkpoint, CommandKey, CommandReceipt, Conclusion, ControlIntent, GateTransition, Journal,
  JournalEvent, JournalPayload, Launch, Invocation, Operation, OutputReceipt, Owner, OwnerState, Reservation, RunProjection, RunStatus,
  StageState, Backstop, RunObligation } from '../contract/runtime.js';
import { commandRelationSchema, type AdmittedPlan } from '../contract/plan.js';
import { validateRecordRef } from './evidence.js';
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const keySchema = commandKeySchema;
const commandSchema = z.strictObject({
  key: keySchema, command: idSchema,
  execution: z.union([z.strictObject({ state: z.literal('complete'), exit: z.number().int().safe() }),
  z.strictObject({ state: z.literal('unfinished'), reason: z.enum(['duration', 'cancelled', 'closure_unknown', 'reservation_unknown']) }),
  z.strictObject({ state: z.literal('not_started'), reason: z.enum(['preparation_failed']) })]),
  stdout: refSchema, stderr: refSchema, before: hash, after: hash, observed: observedGenerationSchema, delta: refSchema,
  spent: z.strictObject({ durationMs: natural }), owner: ownerSchema.optional()
});

// Invocation identity binds ownership; measured duration is observation only.
function validateCommandReceipt(reservation: Reservation, receipt: CommandReceipt): Result<CommandReceipt> {
  if (!commandSchema.safeParse(receipt).success || reservation.state === 'committed'
    || JSON.stringify([reservation.key.tree, reservation.key.declaration, reservation.key.inputHashes, reservation.key.context])
    !== JSON.stringify([receipt.key.tree, receipt.key.declaration, receipt.key.inputHashes, receipt.key.context])
    || reservation.identity !== receipt.command || reservation.invocation.charge !== 'command'
    || receipt.before !== reservation.key.tree)
    return { ok: false, kind: 'invalid', detail: 'Unbound or overwritten command receipt' };
  return { ok: true, value: receipt };
}

const addressSchema = z.strictObject({ run: idSchema, stage: idSchema, attempt: idSchema, invocation: natural.positive() });
const invocationSiteSchema = z.union([addressSchema.extend({ kind: z.literal('stage') }),
z.strictObject({ kind: z.enum(['setup', 'final']), run: idSchema })]);
const invocationSchema = z.strictObject({
  charge: z.enum(['work', 'technical', 'correction', 'plan', 'continuation', 'command']), address: invocationSiteSchema,
}).refine(invocation => invocation.charge === 'command' || invocation.address.kind === 'stage');
const reservationSchema = z.strictObject({
  key: keySchema, identity: idSchema, invocation: invocationSchema,
  state: z.enum(['reserved', 'uncertain', 'committed', 'closed-unmeasured']), receipt: commandSchema.optional(),
}).refine(reservation => (reservation.state === 'committed') === (reservation.receipt !== undefined));
const checkpointSchema = z.strictObject({
  id: idSchema, address: addressSchema, parent: idSchema.nullable(),
  state: z.enum(['safe', 'quarantined']), manifest: refSchema, tree: hash, brief: hash,
  inputHashes: z.array(refSchema), evidence: z.array(refSchema), observed: z.array(observedPathSchema).optional()
});
const outputSchema = z.strictObject({ preserved: z.boolean(), artifacts: z.array(refSchema), detail: z.string() });
const conclusionSchema = z.strictObject({
  status: z.enum(['pending', 'running', 'parked', 'complete', 'accepted_blocked', 'incomplete', 'failed', 'escalated', 'cancelled']),
  reason: z.enum(['completed', 'accepted_blocked', 'gate_irreparable', 'command_missing', 'command_nonzero', 'command_unfinished',
    'outputs_unpreserved', 'backstop', 'attempt_failed', 'contract_refused', 'isolation_refused', 'cancelled', 'recovery_unknown', 'closure_unconfirmed', 'accounting_unsettled', 'claim_unreleased']),
  detail: z.string(), authoredGate: refSchema.optional(),
}).refine(conclusion => ({
  pending: [], running: [], parked: ['backstop', 'attempt_failed', 'recovery_unknown', 'closure_unconfirmed', 'accounting_unsettled', 'claim_unreleased'], complete: ['completed'],
  accepted_blocked: ['accepted_blocked'],
  incomplete: ['command_missing', 'command_nonzero', 'command_unfinished', 'outputs_unpreserved'],
  failed: ['gate_irreparable', 'attempt_failed', 'contract_refused', 'isolation_refused'],
  escalated: ['recovery_unknown'], cancelled: ['cancelled'],
}[conclusion.status] as string[]).includes(conclusion.reason));
const stageCommon = {
  id: idSchema, role: idSchema, after: z.array(idSchema), instruction: z.string().min(1),
  skills: z.array(idSchema), commands: z.array(idSchema).optional(), baseCheckpoint: idSchema.optional()
};
const planSchema = z.strictObject({
  stages: z.array(z.discriminatedUnion('purpose', [
    z.strictObject({ ...stageCommon, purpose: z.literal('work') }),
    z.strictObject({ ...stageCommon, purpose: z.literal('plan') }),
    z.strictObject({
      ...stageCommon, purpose: z.literal('gate'), commands: z.array(idSchema),
      repair: z.strictObject({ stage: idSchema, returnsTo: idSchema }).optional()
    }),
  ])).min(1), observations: z.array(commandRelationSchema).optional()
});
const admittedPlanSchema = z.strictObject({ revision: idSchema, plan: planSchema, digest: hash, executed: z.array(refSchema) });
const attemptSchema = z.strictObject({
  address: addressSchema, ending: z.enum(['delivered', 'invalid_answer', 'invalid_plan', 'work_failed',
    'technical_failure', 'auth', 'refused', 'input_too_large', 'quota', 'duration', 'cancelled', 'isolation_failure', 'closure_unknown',
      'provider_unknown']),
  answer: z.union([
    z.strictObject({
      kind: z.literal('work'), answer: z.strictObject({
        status: z.enum(['delivered', 'blocked', 'environment_gap']), summary: z.string().min(1),
        observations: z.array(commandRelationSchema).optional(), caveats: z.array(z.string()), remainingWork: z.array(z.string()),
        blocks: z.strictObject({ criterionIds: z.array(idSchema), paths: z.array(declaredPathSchema) }).nullable(),
      })
    }),
    z.strictObject({
      kind: z.literal('gate'), answer: z.strictObject({
        outcome: z.enum(['accepted', 'accepted_blocked', 'rejected_repairable', 'rejected_irreparable']), reason: z.string().min(1),
        criteria: z.record(idSchema, z.union([
          z.strictObject({ status: z.enum(['pass', 'fail']), evidence: z.string().min(1) }),
          z.strictObject({ status: z.literal('not_assessed'), evidence: z.string().min(1), reason: z.literal('pending_work') }),
        ])),
        findings: z.array(z.strictObject({
          id: idSchema, paths: z.array(declaredPathSchema), reason: z.string().min(1),
          criterionIds: z.array(idSchema), class: z.enum(['criterion_unmet', 'regression', 'advisory']), commandEvidence: refSchema.optional()
        })),
        commandEvidence: z.array(z.strictObject({ command: idSchema, context: z.string(), executions: z.array(z.string()) })).optional(),
        remainingWork: z.array(z.string()), result: idSchema.optional(),
      })
    }),
    z.strictObject({ kind: z.literal('plan'), answer: z.strictObject({ baseRevision: idSchema, plan: planSchema }) }),
  ]).optional(), answerRef: refSchema.optional(),
  before: hash, after: hash, audit: refSchema, closure: z.enum(['live', 'dead', 'reused', 'unknown']),
  usage: z.strictObject({
    state: z.enum(['known', 'partial', 'unknown']), input: natural.optional(), output: natural.optional(), cached: natural.optional(),
    costUsd: z.number().nonnegative().finite().optional(), raw: z.array(refSchema)
  }), evidence: z.array(refSchema), resetAt: z.string().optional(),
  inputChars: natural.nullable(), guidance: z.preprocess(value => typeof value === 'string' ? [value] : value, z.array(idSchema)).optional()
});
const baselinesSchema = z.strictObject({ inputs: z.array(refSchema), outputs: z.array(refSchema) });
const obligationSchema = z.strictObject({
  kind: z.enum(['closure-unconfirmed', 'accounting-unsettled', 'claim-unreleased']), detail: z.string(), owner: ownerSchema.optional(),
  members: z.array(z.strictObject({ pid: natural.positive(), state: z.string(), parent: natural.nullable() }))
});
const obligationKey = (o: RunObligation) => JSON.stringify([o.kind, o.owner?.authority ?? null]);
const schemas: Partial<Record<JournalPayload['type'], z.ZodType>> = {
  obligation: z.strictObject({ type: z.literal('obligation'), obligation: obligationSchema, open: z.boolean() }),
  accounting_interrupted: z.strictObject({ type: z.literal('accounting_interrupted') }),
  owner_closed: z.strictObject({ type: z.literal('owner_closed'), owner: ownerSchema }),
  run_authority: z.strictObject({ type: z.literal('run_authority'), authority: runAuthoritySchema }),
  ownership: z.strictObject({ type: z.literal('ownership'), owner: ownerSchema, state: z.enum(['live', 'dead', 'reused', 'unknown']) }),
  process: z.strictObject({
    type: z.literal('process'), receipt: z.strictObject({
      owner: ownerSchema.optional(), state: z.enum(['closed', 'not_started', 'closure_unknown']),
      exit: z.number().int().safe().nullable(), signal: z.string().nullable(), grant: z.enum(['applied', 'unavailable', 'refused']),
        stdout: refSchema, stderr: refSchema, durationMs: natural, scope: z.enum(['group', 'contained_descendants'])
    })
  }),
  invocation_reserved: z.strictObject({ type: z.literal('invocation_reserved'), invocation: invocationSchema }),
  attempt_received: z.strictObject({ type: z.literal('attempt_received'), receipt: attemptSchema }),
  backstop_reconstructed: z.strictObject({ type: z.literal('backstop_reconstructed'), basis: natural, backstop: backstopSchema }),
  outcome_settled: z.strictObject({ type: z.literal('outcome_settled'), address: addressSchema, obligation: z.string(), completed: z.boolean(),
    backstop: backstopSchema }),
  attempt_settled: z.strictObject({ type: z.literal('attempt_settled'), receipt: attemptSchema }),
  command_reserved: z.strictObject({ type: z.literal('command_reserved'), reservation: reservationSchema }),
  command: z.strictObject({ type: z.literal('command'), receipt: commandSchema }),
  checkpoint: z.strictObject({ type: z.literal('checkpoint'), checkpoint: checkpointSchema }),
  checkpoint_restore_started: z.strictObject({ type: z.literal('checkpoint_restore_started'), checkpoint: idSchema }),
  checkpoint_materialized: z.strictObject({ type: z.literal('checkpoint_materialized'), checkpoint: idSchema }),
  run_reclaimed: z.strictObject({ type: z.literal('run_reclaimed'), at: z.iso.datetime(), delivery: declaredPathSchema }),
  outputs_preserved: z.strictObject({ type: z.literal('outputs_preserved'), receipt: outputSchema }),
  stage_settled: z.strictObject({ type: z.literal('stage_settled'), stage: idSchema, state: z.enum(['pending', 'running', 'settled', 'skipped']),
    evidence: z.array(refSchema) }),
  gate_transition: z.strictObject({
    type: z.literal('gate_transition'), stage: idSchema, attempt: idSchema,
    outcome: z.enum(['accepted', 'accepted_blocked', 'rejected_repairable', 'rejected_irreparable']), next: idSchema.nullable(),
      evidence: z.array(refSchema)
  }),
  active_time_opened: z.strictObject({
    type: z.literal('active_time_opened'), interval: z.strictObject({
      id: idSchema, owner: ownerSchema,
      openedAt: z.iso.datetime(), spentMs: natural.nullable()
    })
  }),
  active_time_closed: z.strictObject({ type: z.literal('active_time_closed'), interval: idSchema, spentMs: natural }),
  lifecycle: z.strictObject({ type: z.literal('lifecycle'), conclusion: conclusionSchema }),
};
function payloadValid(payload: JournalPayload, run: string): boolean {
  if (!payload || typeof payload !== 'object') return false;
  switch (payload.type) {
    case 'setup_prepared': return Object.keys(payload).length === 5 && parseSetupRequest(payload.request).ok
      && parseRunRef(payload.unit).ok && payload.unit.run === run
      && baselinesSchema.safeParse(payload.baselines).success
      && (payload.measured === null || parseSetupEvidence(payload.measured).ok);
    case 'admitted': return Object.keys(payload).length === 2 && parseLaunch(payload.launch).ok && payload.launch.run === run;
    case 'control_intent': return Object.keys(payload).length === 2 && parseControlIntent(payload.intent).ok && payload.intent.run === run;
    case 'control_settled': return Object.keys(payload).length === 2 && parseOperation(payload.operation).ok && payload.operation.intent.run === run;
    case 'run_observed': return Object.keys(payload).length === 2 && parseRunObservation(payload.observation).ok &&
      payload.observation.unit.run === run;
    case 'plan_committed': return Object.keys(payload).length === 2 && admittedPlanSchema.safeParse(payload.plan).success;
    default: {
      const schema = schemas[payload.type];
      if (!schema?.safeParse(payload).success) return false;
      if (payload.type === 'invocation_reserved') return payload.invocation.address.run === run;
      if ((payload.type === 'attempt_settled' || payload.type === 'attempt_received')) return payload.receipt.address.run === run;
      if (payload.type === 'checkpoint') return payload.checkpoint.address.run === run;
      if (payload.type === 'command_reserved') return payload.reservation.invocation.address.run === run;
      return true;
    }
  }
}

const keyOf = (key: CommandKey): string => JSON.stringify([key.tree, key.declaration, key.inputHashes, key.context]);
const addressOf = (address: AttemptReceipt['address']): string => JSON.stringify([address.run, address.stage, address.attempt, address.invocation]);
const ownerOf = (owner: Owner): string => owner.authority;
const equal = (left: unknown, right: unknown): boolean => isDeepStrictEqual(left, right);
// SQL reduction and readers share the pure reducer; no reader owns a second state list.
export { nextLifecycle, lifecycle, isFinal } from './lifecycle.mjs';
export type { Lifecycle, LifecycleFact } from './lifecycle.mjs';
import { nextLifecycle, lifecycle, isFinal } from './lifecycle.mjs';
/** Accounting attention is bookkeeping; only unresolved closure or claims block effects. */
export function hasBlockingObligations(obligations: readonly RunObligation[]): boolean {
  return obligations.some(o => o.kind === 'closure-unconfirmed' || o.kind === 'claim-unreleased');
}
/** One entry decision: return retained conclusions, refuse blocking obligations, or admit new work (null).
 * The reservation transaction also consumes this decision; a retained conclusion authorizes no effects. */
export function workAdmission(projection: Pick<RunProjection, 'status' | 'obligations' | 'intents' | 'conclusion'>): Result<Conclusion | null> {
  if (projection.conclusion && isFinal(projection.status)) return { ok: true, value: projection.conclusion };
  if (hasBlockingObligations(projection.obligations)
    || projection.intents.some(intent => intent.kind === 'cancel'))
    return bad('conflict', 'Run cannot start work before lifecycle and obligations permit it');
  if (nextLifecycle(projection.status, 'run') !== null) return { ok: true, value: null };
  return projection.conclusion ? { ok: true, value: projection.conclusion }
    : bad('conflict', 'Run cannot start work before lifecycle and obligations permit it');
}
const obligationReason = (kind: RunObligation['kind']): 'closure_unconfirmed' | 'accounting_unsettled' | 'claim_unreleased' =>
  ({ 'closure-unconfirmed': 'closure_unconfirmed', 'accounting-unsettled': 'accounting_unsettled',
    'claim-unreleased': 'claim_unreleased' } as const)[kind];
export const acceptsGuidance = (status: RunStatus, fenced: boolean): boolean => !fenced && !isFinal(status);
const terminal = isFinal;
export const intervalOpen = (interval: ActiveInterval): boolean => interval.spentMs === null && interval.closed !== 'unmeasured';
export const reservationOpen = (reservation: Reservation): boolean => reservation.state === 'reserved' || reservation.state === 'uncertain';
const invalid = (detail: string): Result<never> => ({ ok: false, kind: 'invalid', detail });

// Dormancy is a property of the admitted dependency graph, not a chosen route.
function initialStates(plan: AdmittedPlan): StageState[] {
  const stages = new Map(plan.plan.stages.map(stage => [stage.id, stage]));
  const ordinary = new Set<Id>();
  const visit = (id: Id): void => {
    if (ordinary.has(id)) return;
    ordinary.add(id);
    for (const parent of stages.get(id)?.after ?? []) visit(parent);
  };
  const gates = plan.plan.stages.filter(stage => stage.purpose === 'gate');
  for (const stage of gates.length ? gates : plan.plan.stages) visit(stage.id);
  return plan.plan.stages.map(stage => ({
    stage: stage.id,
    state: ordinary.has(stage.id) ? 'pending' : 'dormant', obligation: plan.revision + ':' + plan.plan.stages.indexOf(stage), completed: false
  }));
}


const valid = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown', detail: string): Result<never> => ({ ok: false, kind, detail });
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const encode = (value: unknown) => JSON.stringify(value);
const active = new Set<string>();
const schema = ("\nCREATE TABLE IF NOT EXISTS runs (\n root TEXT PRIMARY KEY, store TEXT NOT NULL, name TEXT " +
    "NOT NULL,\n cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0), current TEXT NOT NULL CHE" +
    "CK(json_valid(current)),\n UNIQUE(store,name)\n);\nCREATE TABLE IF NOT EXISTS events (\n root " +
    "TEXT NOT NULL REFERENCES runs(root), seq INTEGER NOT NULL CHECK(seq > 0),\n batch INTEGER N" +
    "OT NULL, at TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),\n PRIMARY KEY(" +
    "root,seq)\n);\nCREATE TABLE IF NOT EXISTS current_rows (\n root TEXT NOT NULL REFERENCES runs" +
    "(root), kind TEXT NOT NULL, key TEXT NOT NULL,\n value TEXT NOT NULL CHECK(json_valid(value" +
    ")), ordinal INTEGER NOT NULL,\n PRIMARY KEY(root,kind,key)\n);\nCREATE INDEX IF NOT EXISTS cu" +
    "rrent_order ON current_rows(root,kind,ordinal);\nCREATE TABLE IF NOT EXISTS epochs (\n root " +
    "TEXT NOT NULL REFERENCES runs(root), kind TEXT NOT NULL CHECK(kind IN ('control','executio" +
    "n')),\n epoch TEXT NOT NULL, owner TEXT NOT NULL CHECK(json_valid(owner)), active INTEGER N" +
    "OT NULL CHECK(active IN (0,1)),\n PRIMARY KEY(root,kind,epoch)\n);\nCREATE UNIQUE INDEX IF NO" +
    "T EXISTS active_epoch ON epochs(root,kind) WHERE active=1;\nCREATE TABLE IF NOT EXISTS reso" +
    "urces (\n id TEXT PRIMARY KEY, holder TEXT NOT NULL, path TEXT NOT NULL, access TEXT NOT NU" +
    "LL\n CHECK(access IN ('exclusive-write','shared-write','stable-read')),\n inode TEXT, owner " +
    "TEXT CHECK(owner IS NULL OR json_valid(owner)), unit TEXT CHECK(unit IS NULL OR json_valid" +
    "(unit)), epoch TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS resource_holder ON resources(ho" +
    "lder);\n");
function databaseFailure(error: unknown): Result<never> {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return bad('unavailable', String(error));
  const code = (error as { errcode?: number }).errcode;
  return bad(code === 5 || code === 6 ? 'conflict' : code === 11 || code === 26 ? 'invalid' : 'unknown', String(error));
}
/** A connection never escapes its synchronous section. No await, callback reentry, shared connection, or custom busy scheduler. */
export function withState<T>(database: string, write: boolean, operation: (db: DatabaseSync) => Result<T>): Result<T> {
  if (active.has(database)) return bad('conflict', 'State operation is not reentrant');
  let db: DatabaseSync | undefined, begun = false;
  let outcome: Result<T>;
  try { outcome = ((): Result<T> => {
    if (!isAbsolute(database) || resolve(database) !== database || realpathSync(dirname(database)) !== dirname(database))
      return bad('invalid', 'State database requires a canonical protected parent');
    const stat = lstatSync(database);
    if (!stat.isFile() || stat.nlink !== 1 || realpathSync(database) !== database) return bad('invalid', 'Aliased state database');
    active.add(database);
    db = new DatabaseSync(database, { enableForeignKeyConstraints: true });
    db.exec('PRAGMA busy_timeout=5000');
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
      db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') return bad('invalid', 'Unsupported state database format or journal mode');
    db.exec('PRAGMA synchronous=FULL');
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); begun = true;
    const result = operation(db);
    if (result && typeof (result as unknown as { then?: unknown }).then === 'function') throw new Error('State operation must be synchronous');
    db.exec(result.ok ? 'COMMIT' : 'ROLLBACK'); begun = false;
    return result;
  })(); } catch (error) { outcome = databaseFailure(error); }
  let cleanupError: unknown;
  if (begun) try { db?.exec('ROLLBACK'); } catch (error) { cleanupError = error; }
  try { db?.close(); } catch (error) { cleanupError = error; }
  active.delete(database);
  return cleanupError ? bad('unknown', String(cleanupError)) : outcome;
}
/** SQLite owns these protected file names; protecting their parent would also deny the installation work roots. */
export const protectedStatePaths = (database: string): readonly string[] => [database, database + '-wal', database + '-shm'];
/** Explicit installation address shared by all stores; creation belongs to CLI composition, never read paths. */
export function initializeState(database: string): Result<string> {
  if (!isAbsolute(database) || resolve(database) !== database) return bad('invalid', 'Absolute state database required');
  try {
    if (realpathSync(dirname(database)) !== dirname(database)) return bad('invalid', 'Aliased state parent');
    if (!existsSync(database)) { const fd = openSync(database, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600); fsyncSync(fd); closeSync(fd); }
    if (lstatSync(database).nlink !== 1 || realpathSync(database) !== database) return bad('invalid', 'Aliased state database');
    const db = new DatabaseSync(database);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version); if (![0, 1].includes(version) || version === 0 &&
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get()) return bad('invalid', 'Unsupported state database format');
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;' + schema + 'PRAGMA user_version=1; COMMIT;');
    }
    finally { db.close(); }
    const fd = openSync(dirname(database), constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); }
    return valid(database);
  } catch (error) { return databaseFailure(error); }
}
interface Current {
  reclaimed?: { at: string; delivery: string };
  launch?: Launch; plan?: AdmittedPlan; setup?: Extract<JournalPayload, { type: 'setup_prepared' }>;
  authority?: Extract<JournalPayload, { type: 'run_authority' }>;
  status: RunStatus; statusSince: number; stepStartedAt?: string | null; hostScope?: import('../contract/runtime.js').ProcessReceipt['scope']; conclusion?: Conclusion; currentStage: Id | null;
  backstop: Backstop; restoring: Id | null; fenced: boolean;
}
const emptyCurrent = (): Current => ({ backstop: initialBackstop(), status: 'pending', statusSince: 0, currentStage: null, restoring: null,
  fenced: false });
function current(db: DatabaseSync, journal: Journal): { cursor: number; value: Current } | null {
  const row = db.prepare('SELECT cursor,current FROM runs WHERE root=?').get(journal.root);
  return row ? { cursor: Number(row.cursor), value: decode(row.current) } : null;
}
// These indexed rows are the current facts themselves, not a replay cache or a second reducer.
function rows<V>(db: DatabaseSync, root: string, kind: string, ordinal = 0) {
  return {
    get(key: string): V | undefined { const row = db.prepare('SELECT value FROM current_rows WHERE root=? AND kind=? AND key=?').get(root, kind,
      key); return row ? decode<V>(row.value) : undefined; },
    delete(key: string) { db.prepare('DELETE FROM current_rows WHERE root=? AND kind=? AND key=?').run(root, kind, key); },
    has(key: string) { return !!db.prepare('SELECT 1 FROM current_rows WHERE root=? AND kind=? AND key=?').get(root, kind, key); },
    set(key: string, value: V) {
      db.prepare('INSERT INTO current_rows VALUES(?,?,?,?,?) ON CONFLICT(root,kind,key) DO UPDATE SET value=excluded.value').run(root, kind, key,
      encode(value), ordinal); },
    values(): V[] { return db.prepare('SELECT value FROM current_rows WHERE root=? AND kind=? ORDER BY ordinal,key').all(root,
      kind).map(row => decode<V>(row.value)); },
    entries(): [string, V][] { return db.prepare('SELECT key,value FROM current_rows WHERE root=? AND kind=? ORDER BY ordinal,key').all(root,
      kind).map(row => [String(row.key), decode<V>(row.value)]); },
  };
}
/** Accounting reads current facts independently of admission or lifecycle. */
function unsettledAccounting(db: DatabaseSync, journal: Journal): boolean {
  return rows<ActiveInterval>(db, journal.root, 'interval').values().some(intervalOpen)
    || rows<Reservation>(db, journal.root, 'reservation').values().some(reservationOpen)
    || rows<Invocation>(db, journal.root, 'invocation').entries().some(([key, invocation]) => !rows(db, journal.root, 'attempt').has(key)
      && !rows(db, journal.root, 'closed_invocation').has(key) && invocation.charge !== 'command');
}
const afterFence = new Set<JournalPayload['type']>(['control_intent', 'control_settled', 'run_observed', 'ownership', 'process',
  'obligation', 'accounting_interrupted', 'owner_closed', 'run_reclaimed', 'attempt_received', 'attempt_settled', 'command', 'checkpoint', 'outputs_preserved', 'active_time_closed', 'backstop_reconstructed']);
function transition(db: DatabaseSync, journal: Journal, events: readonly JournalEvent[]): Result<number> {
  const saved = current(db, journal); if (!saved) return bad('unavailable', 'Run state unavailable');
  const run = basename(journal.root), start = saved.cursor;
  let { backstop, launch, plan, setup, authority, status, statusSince, conclusion, currentStage, restoring, fenced } = saved.value;
  if (!backstopSchema.safeParse(backstop).success && !(events.length === 1 &&
    events[0].payload.type === 'backstop_reconstructed')) return bad('unknown', 'Canonical C2 history must be reconstructed before continuation');
  const batchStatus = status;
  let stepStartedAt = saved.value.stepStartedAt ?? null;
  let hostScope = saved.value.hostScope;
  let reclaimed = saved.value.reclaimed;
  const outcomes = new Set<string>();
  for (const [index, event] of events.entries()) {
    const cursor = start + index + 1, fact = event.payload;
    if (event.seq !== cursor || event.run !== run || !payloadValid(fact, run)) return invalid('Invalid state payload or address');
    if (fenced && !afterFence.has(fact.type)) return bad('conflict', 'Run execution is fenced');
    let ending: Conclusion | undefined;
    const stageStates = rows<StageState>(db, journal.root, 'stage', cursor), revisions = rows<AdmittedPlan>(db, journal.root, 'revision', cursor),
      intents = rows<ControlIntent>(db, journal.root, 'intent', cursor),
      invocations = rows<Invocation>(db, journal.root, 'invocation', cursor), attempts = rows<AttemptReceipt>(db, journal.root, 'attempt', cursor),
      reviews = rows<boolean>(db, journal.root, 'review', cursor), reservations = rows<Reservation>(db, journal.root, 'reservation', cursor),
      owners = rows<{ owner: Owner; state: OwnerState }>(db, journal.root, 'owner', cursor), checkpoints = rows<Checkpoint>(db, journal.root,
        'checkpoint', cursor),
      transitions = rows<GateTransition>(db, journal.root, 'transition', cursor), intervals = rows<ActiveInterval>(db, journal.root, 'interval',
        cursor);
    const obligations = rows<RunObligation>(db, journal.root, 'obligation', cursor);
    const append = (kind: string, value: unknown) => rows(db, journal.root, kind, cursor).set(String(cursor), value);
    switch (fact.type) {
      case 'run_authority':
        if (authority || setup || launch) return invalid('Run authority is immutable and precedes setup');
        { const admitted = admitResources(db, journal, fact.authority); if (!admitted.ok) return admitted; }
        authority = fact;
        break;
      case 'setup_prepared':
        if (launch || (!setup && fact.measured !== null) || !equal(fact.request.runtime, fact.unit.runtime) || (setup &&
          (setup.measured !== null || fact.measured === null
          || !equal(setup.request, fact.request) || !equal(setup.unit, fact.unit) || !equal(setup.baselines, fact.baselines))))
          return invalid('Setup must complete the original baselines exactly once');
        if (fact.measured && (fact.measured.project !== fact.request.project || fact.measured.target !== fact.request.target
          || fact.measured.brief !== fact.request.brief.digest || !equal(fact.measured.inputs, fact.baselines.inputs)
          || !equal(fact.measured.outputs, fact.baselines.outputs))) return invalid('Setup measurements do not match original baselines');
        setup = fact;
        break;
      case 'admitted': {
        const measured = fact.launch.setup;
        if (launch || fact.launch.run !== run) return invalid('Duplicate or misaddressed admission');
        if (setup && (setup.request.target !== fact.launch.project
          || setup.request.brief.digest !== fact.launch.brief.digest
          || !equal(setup.unit, fact.launch.unit) || !setup.measured || !equal(setup.measured,
            measured))) return invalid('Admission does not match setup');
        launch = fact.launch;
        break;
      }
      case 'plan_committed': {
        if (!launch || revisions.has(fact.plan.revision))
          return invalid('Missing admission or duplicate plan revision');
        plan = fact.plan;
        revisions.set(plan.revision, plan);
        const active = new Set(plan.plan.stages.map(stage => stage.id));
        for (const [id, state] of stageStates.entries()) if (!active.has(id) && (state.state === 'pending' || state.state === 'dormant' ||
          state.state === 'running'))
          stageStates.set(id, { ...state, state: 'skipped' });
        for (const state of initialStates(plan)) if (!stageStates.has(state.stage)) stageStates.set(state.stage, state);
        break;
      }
      case 'control_intent': {
        if (fact.intent.kind === 'guide' && !acceptsGuidance(status, fenced)) return bad('conflict', 'Terminal or cancelled runs cannot receive guidance');
        if (intents.has(fact.intent.id)) return { ok: false, kind: 'conflict', detail: 'Control intent already committed' };
        intents.set(fact.intent.id, fact.intent);
        if (fact.intent.kind === 'resume') {
          const next = nextLifecycle(status, 'resume');
          if (next === null || fenced || hasBlockingObligations(obligations.values())) return bad('conflict', 'Terminal, fenced or obligated runs cannot resume');
          if (status === 'parked' && conclusion?.reason === 'backstop') backstop = { ...initialBackstop(), segment: backstop.segment + 1 };
          if (next !== lifecycle(status)) { status = 'pending'; conclusion = undefined; currentStage = null; }
        }
        if (fact.intent.kind === 'cancel') {
          const next = nextLifecycle(status, 'cancel'); fenced = true;
          if (next !== lifecycle(status)) ending = { status: 'cancelled', reason: 'cancelled', detail: 'Cancellation intent committed' };
        }
        break;
      }
      case 'control_settled':
        if (!equal(intents.get(fact.operation.intent.id), fact.operation.intent))
          return invalid('Operation lacks its addressed intent');
        append('operation', fact.operation);
        break;
      case 'invocation_reserved': {
        const invocation = fact.invocation;
        const admission = workAdmission({ status, conclusion, obligations: obligations.values(), intents: intents.values() });
        if (!admission.ok || admission.value !== null)
          return bad('conflict', 'Inactive, fenced or obligated run cannot admit an invocation');
        if (invocation.charge === 'command') {
          const following = events[index + 1]?.payload;
          if (following?.type !== 'command_reserved' || !equal(following.reservation?.invocation, invocation))
            return { ok: false, kind: 'conflict', detail: 'Command invocation requires atomic reservation' };
        }
        if (invocation.charge === 'command') {
          const following = events[index + 1].payload;
          if (following.type === 'command_reserved') invocations.set('command:' + keyOf(following.reservation.key), invocation);
        }
        if (invocation.address.kind === 'stage' && invocation.charge !== 'command') {
          const previous = stageStates.get(invocation.address.stage);
          if (!previous) return invalid('Invocation references an undefined stage');
          if (invocations.has(addressOf(invocation.address))) return invalid('Invocation already reserved');
          invocations.set(addressOf(invocation.address), invocation);
          if (nextLifecycle(status, 'run') !== null) {
            stageStates.set(previous.stage, { ...previous, state: 'running' });
            status = 'running'; currentStage = previous.stage; stepStartedAt = event.at; conclusion = undefined;
          }
        }
        break;
      }
      case 'attempt_received': {
        const receipt = fact.receipt, key = addressOf(receipt.address), raw = rows<AttemptReceipt>(db, journal.root, 'received', cursor);
        if (!invocations.has(key) || raw.has(key) || attempts.has(key)) return invalid('Raw attempt requires one open invocation');
        raw.set(key, receipt);
        break;
      }
      case 'backstop_reconstructed':
        if (backstopSchema.safeParse(backstop).success || fact.basis !== start) return bad('conflict',
          'Backstop reconstruction requires the original unsupported cursor');
        backstop = fact.backstop;
        break;
      case 'outcome_settled': {
        const stage = stageStates.get(fact.address.stage), key = addressOf(fact.address);
        if (!stage || stage.obligation !== fact.obligation || outcomes.has(key) || !events.slice(0,
          index).some(event => event.payload.type === 'attempt_settled' &&
          addressOf(event.payload.receipt.address) === key)) return invalid('Outcome lacks unique admitted settlement');
        if (fact.completed && stage.completed) return invalid('Obligation already completed');
        outcomes.add(key);
        if (fact.completed) stageStates.set(stage.stage, { ...stage, completed: true });
        backstop = fact.backstop;
        break;
      }
      case 'attempt_settled': {
        const receipt = fact.receipt;
        if (!stageStates.has(receipt.address.stage)
          || attempts.has(addressOf(receipt.address))
          || !invocations.has(addressOf(receipt.address)))
          return invalid('Attempt lacks a unique declared reserved invocation');
        attempts.set(addressOf(receipt.address), receipt);
        if (receipt.answer?.kind === 'gate' && receipt.answerRef && plan) {
          const descendants = new Set([receipt.address.stage]);
          for (let changed = true; changed;) {
            changed = false;
            for (const stage of plan.plan.stages) if (!descendants.has(stage.id) && stage.after.some(id => descendants.has(id))) {
              descendants.add(stage.id); changed = true;
            }
          }
          const scope = plan.plan.stages.some(stage => stage.id !== receipt.address.stage && stage.purpose === 'gate' && descendants.has(stage.id))
            ? 'progress' : 'delivery';
          const gates = rows<{invocation:number;gate:import('../contract/runtime.js').RunStatusFile['gates'][number]}>(db, journal.root, 'status_gate', cursor);
          const key = JSON.stringify([receipt.address.stage,receipt.address.attempt]);
          if ((gates.get(key)?.invocation ?? 0) < receipt.address.invocation) gates.set(key, {invocation:receipt.address.invocation,
            gate:{stage:receipt.address.stage,attempt:receipt.address.attempt,scope,outcome:receipt.answer.answer.outcome,answer:receipt.answerRef,
              ...(receipt.answer.answer.result === undefined ? {} : {result:receipt.answer.answer.result}),cursor}});
        }
        if (receipt.ending === 'delivered' && receipt.closure === 'dead' &&
          receipt.answer?.kind === 'gate') reviews.set(JSON.stringify([receipt.address.stage, receipt.address.attempt, receipt.answer.answer.outcome]), true);
        break;
      }
      case 'command_reserved': {
        const reservation = fact.reservation;
        const key = keyOf(reservation.key);
        const preceding = events[index - 1]?.payload;
        if (reservations.has(key) || reservation.state !== 'reserved' || preceding?.type !== 'invocation_reserved'
          || preceding.invocation.charge !== 'command' || !equal(preceding.invocation, reservation.invocation))
          return { ok: false, kind: 'conflict', detail: 'Reservation requires one matching atomic command invocation' };
        reservations.set(key, { ...reservation, state: 'uncertain' });
        break;
      }
      case 'command': {
        const key = keyOf(fact.receipt.key);
        const reservation = reservations.get(key);
        if (!reservation) return { ok: false, kind: 'conflict', detail: 'Command receipt requires a reservation' };
        const checked = validateCommandReceipt(reservation, fact.receipt);
        if (!checked.ok) return checked;
        reservations.set(key, { ...reservation, state: 'committed', receipt: fact.receipt });
        append('command', fact.receipt);
        break;
      }
      case 'ownership':
        owners.set(ownerOf(fact.owner), { owner: fact.owner, state: fact.state });
        if (fact.owner.streams) rows<Owner>(db, journal.root, 'active_process', cursor).set(ownerOf(fact.owner), fact.owner);
        break;
      case 'process':
        hostScope = fact.receipt.scope;
        if (fact.receipt.owner) rows(db, journal.root, 'active_process').delete(ownerOf(fact.receipt.owner));
        if (fact.receipt.owner) owners.set(ownerOf(fact.receipt.owner), {
          owner: fact.receipt.owner,
          state: processClosed(fact.receipt) ? 'dead' : 'unknown'
        });
        if (fact.receipt.owner && processClosed(fact.receipt)) rows(db, journal.root, 'closed_owner', cursor).set(ownerOf(fact.receipt.owner), fact.receipt.owner);
        break;
      case 'checkpoint':
        if (checkpoints.has(fact.checkpoint.id)
          || (fact.checkpoint.parent !== null && !checkpoints.has(fact.checkpoint.parent)))
          return invalid('Checkpoint identity or parent is missing');
        checkpoints.set(fact.checkpoint.id, fact.checkpoint);
        break;
      case 'checkpoint_restore_started':
        if (checkpoints.get(fact.checkpoint)?.state !== 'safe' || (restoring &&
          restoring !== fact.checkpoint)) return invalid('Restore requires the same admitted safe checkpoint');
        restoring = fact.checkpoint;
        break;
      case 'checkpoint_materialized':
        if (checkpoints.get(fact.checkpoint)?.state !== 'safe' ||
          restoring !== fact.checkpoint) return invalid('Materialized checkpoint is absent, quarantined or not started');
        restoring = null;
        break;
      case 'run_reclaimed': reclaimed = { at: fact.at, delivery: fact.delivery }; break;
      case 'outputs_preserved': append('output', fact.receipt); break;
      case 'stage_settled': {
        const previous = stageStates.get(fact.stage);
        if (!previous) return invalid('State references an undefined stage');
        if (nextLifecycle(status, 'run') !== null) {
          stageStates.set(fact.stage, { ...previous, state: fact.state });
          if (fact.state === 'running') { if (currentStage !== fact.stage) stepStartedAt = event.at; currentStage = fact.stage; status = 'running'; conclusion = undefined; }
          else if (currentStage === fact.stage) currentStage = null;
        }
        break;
      }
      case 'gate_transition': {
        if (transitions.has(JSON.stringify([fact.stage, fact.attempt])))
          return invalid('Duplicate gate transition');
        if (!reviews.has(JSON.stringify([fact.stage, fact.attempt, fact.outcome])))
          return invalid('Gate transition lacks its reviewed attempt');
        transitions.set(JSON.stringify([fact.stage, fact.attempt]), fact);
        break;
      }
      case 'active_time_opened':
        if (intervals.has(fact.interval.id) || fact.interval.spentMs !== null) return invalid('Duplicate or already closed active interval');
        intervals.set(fact.interval.id, fact.interval);
        break;
      case 'active_time_closed': {
        const interval = intervals.get(fact.interval);
        if (!interval || !intervalOpen(interval)) return invalid('Active interval lacks one opening');
        intervals.set(interval.id, { ...interval, spentMs: fact.spentMs });
        break;
      }
      case 'obligation': {
        const key = obligationKey(fact.obligation);
        if (fact.open) obligations.set(key, fact.obligation); else obligations.delete(key);
        if (fact.open && hasBlockingObligations([fact.obligation]) && nextLifecycle(status, 'obligation') !== lifecycle(status)) ending = {
          status: 'parked', reason: obligationReason(fact.obligation.kind), detail: fact.obligation.kind + ': ' + fact.obligation.detail
        };
        break;
      }
      case 'owner_closed':
        owners.set(ownerOf(fact.owner), { owner: fact.owner, state: 'dead' });
        rows(db, journal.root, 'active_process').delete(ownerOf(fact.owner));
        rows(db, journal.root, 'closed_owner', cursor).set(ownerOf(fact.owner), fact.owner);
        break;
      // Group closure belongs to the accounting owners; a successor unit may already be active.
      case 'accounting_interrupted':
        if (hasBlockingObligations(obligations.values())
          || intervals.values().some(i => intervalOpen(i) && !rows(db, journal.root, 'closed_owner').has(ownerOf(i.owner)))
          || owners.values().some(o => o.state !== 'dead' && o.state !== 'reused')) return bad('unknown', 'Accounting requires authenticated closure');
        for (const interval of intervals.values()) if (intervalOpen(interval)) intervals.set(interval.id, { ...interval, closed: 'unmeasured' });
        for (const [key, reservation] of reservations.entries()) if (reservationOpen(reservation)) reservations.set(key, { ...reservation, state: 'closed-unmeasured' });
        for (const [key, invocation] of invocations.entries()) if (invocation.charge === 'command' || attempts.get(key)?.closure !== 'dead')
          rows(db, journal.root, 'closed_invocation', cursor).set(key, invocation);
        break;
      case 'lifecycle': {
        const target = lifecycle(fact.conclusion.status);
        const action = target === 'completed' ? 'complete' : target === 'failed' ? 'fail' : target === 'parked' ? 'park'
          : target === 'cancelled' ? 'cancel' : target === 'running' ? 'run' : 'resume';
        if (nextLifecycle(status, action) === null) return bad('conflict', 'Lifecycle transition refused');
        if (!terminal(status)) ending = fact.conclusion;
        break;
      }
      case 'run_observed': rows(db, journal.root, 'run_observation', cursor).set('activation', fact.observation); break;
      default: return invalid('Unknown journal fact');
    }
    // One projection owner for control closure and cleanup attention. The fence only grows.
    if (ending) {
      if (terminal(ending.status)) fenced = true;
      status = ending.status; conclusion = ending;
      if (!['running', 'parked'].includes(status)) currentStage = null;
    }
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(journal.root, cursor, start + events.length, event.at, encode(fact));
  }
  const accounting = rows<RunObligation>(db, journal.root, 'obligation', start + events.length);
  const intervals = rows<ActiveInterval>(db, journal.root, 'interval').values();
  const owners = rows<{ owner: Owner; state: OwnerState }>(db, journal.root, 'owner');
  const dead = (owner: Owner) => rows(db, journal.root, 'closed_owner').has(ownerOf(owner))
    || owners.get(ownerOf(owner))?.state === 'dead';
  const interrupted = intervals.some(i => intervalOpen(i) && dead(i.owner))
    || unsettledAccounting(db, journal) && intervals.every(i => !intervalOpen(i) || dead(i.owner))
      && rows<import('../contract/runtime.js').RunObservation>(db, journal.root, 'run_observation').get('activation')?.state === 'inactive'
      && owners.values().length > 0 && owners.values().every(o => o.state === 'dead');
  const obligation: RunObligation = { kind: 'accounting-unsettled', detail: 'Dead activation left accounting open', members: [] };
  if (interrupted) accounting.set(obligationKey(obligation), obligation);
  else if (!unsettledAccounting(db, journal)) accounting.delete(obligationKey(obligation));
  const cursor = start + events.length;
  if (status !== batchStatus || (statusSince === 0 && launch && plan)) statusSince = cursor;
  const value: Current = { reclaimed, hostScope, stepStartedAt: currentStage === null ? null : stepStartedAt, backstop, launch, plan, setup, authority, status, statusSince, conclusion, currentStage, restoring, fenced };
  db.prepare('UPDATE runs SET cursor=?,current=? WHERE root=?').run(cursor, encode(value), journal.root);
  return valid(cursor);
}

/** Create only the addressed run directory; its SQL row and all facts use the installation database. */
export async function openJournal(location: RunLocation, mode: 'create' | 'read'): Promise<Result<Journal>> {
  if (!idSchema.safeParse(location.run).success || !isAbsolute(location.storeRoot) || resolve(location.storeRoot) !== location.storeRoot ||
    !['create', 'read'].includes(mode)) return invalid('Invalid run location');
  const journal: Journal = { root: join(location.storeRoot, 'runs', location.run), database: location.database };
  try {
    if (realpathSync(location.storeRoot) !== location.storeRoot) return invalid('Aliased store');
    if (mode === 'create') {
      mkdirSync(dirname(journal.root), { recursive: true });
      if (realpathSync(dirname(journal.root)) !== dirname(journal.root)) return invalid('Aliased runs root');
      try { mkdirSync(journal.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return bad('conflict',
        'Run already exists'); throw error; }
      await initializeEvidence(journal);
      const result = withState(journal.database, true, db => {
        db.prepare('INSERT INTO runs(root,store,name,current) VALUES(?,?,?,?)').run(journal.root, location.storeRoot, location.run,
          encode(emptyCurrent())); return valid(journal);
      });
      return result;
    }
    if (realpathSync(journal.root) !== journal.root) return invalid('Aliased run root');
    return withState(journal.database, false, db => current(db, journal) ? valid(journal) : bad('unavailable', 'Run state unavailable'));
  } catch (error) { return bad((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'invalid', String(error)); }
}
export async function openWriter(journal: Journal, claim: Claim, kind: Writer['kind']): Promise<Result<Writer>> {
  if (!claim || !ownerSchema.safeParse(claim.owner).success || !idSchema.safeParse(claim.epoch).success || !['control',
    'execution'].includes(kind)) return invalid('Invalid claim or writer kind');
  return withState(journal.database, true, db => {
    const state = current(db, journal); if (!state) return bad('unavailable', 'Run state unavailable');
    const held = db.prepare('SELECT owner,epoch FROM resources WHERE id=?').get('operation:' + claim.holder + ':' + claim.resource);
    if (claim.database !== journal.database || claim.holder !== journal.root || !held || held.epoch !== claim.epoch || !equal(decode(held.owner),
      claim.owner)) return bad('conflict', 'Claim epoch is not held');
    if (kind === 'execution' && state.value.fenced) return bad('conflict', 'Run execution is fenced');
    const prior = db.prepare('SELECT epoch,owner FROM epochs WHERE root=? AND kind=? AND active=1').get(journal.root, kind);
    if (prior?.epoch !== claim.epoch) {
      if (db.prepare('SELECT 1 FROM epochs WHERE root=? AND kind=? AND epoch=?').get(journal.root, kind, claim.epoch)) return bad('conflict',
        'Retired writer epoch');
      if (prior && !equal(decode(prior.owner), claim.owner) &&
        db.prepare('SELECT 1 FROM resources WHERE holder=? AND epoch=? AND owner=?').get(journal.root, prior.epoch, prior.owner)) return bad('conflict',
        'Previous writer claim remains held');
      db.prepare('UPDATE epochs SET active=0 WHERE root=? AND kind=?').run(journal.root, kind);
      db.prepare('INSERT INTO epochs VALUES(?,?,?,?,1)').run(journal.root, kind, claim.epoch, encode(claim.owner));
    } else if (!equal(decode(prior.owner), claim.owner)) return bad('conflict', 'Writer epoch owner mismatch');
    return valid({ journal, owner: claim.owner, epoch: claim.epoch, kind, cursor: state.cursor });
  });
}
/** Authenticate selected immutable bytes outside the writer section. The commit rechecks all bindings and CAS. */
export async function appendEvents(writer: Writer, expectedCursor: number | null, payloads: readonly JournalPayload[]): Promise<Result<number>> {
  if (expectedCursor !== null && (!Number.isSafeInteger(expectedCursor) || expectedCursor < 0) || !Array.isArray(payloads) ||
    !payloads.length) return invalid('Expected cursor and nonempty transaction');
  const frozen = structuredClone(payloads), run = basename(writer.journal.root);
  for (const payload of frozen) {
    if (!payloadValid(payload, run)) return invalid('Invalid journal payload');
    if (payload.type === 'command') for (const ref of commandRefs(payload.receipt)) { const result = await validateRecordRef(writer.journal,
      ref); if (!result.ok) return result; }
  }
  return withState(writer.journal.database, true, db => {
    const saved = current(db, writer.journal); if (!saved) return bad('unavailable', 'Run state unavailable');
    const epoch = db.prepare('SELECT owner FROM epochs WHERE root=? AND kind=? AND epoch=? AND active=1').get(writer.journal.root, writer.kind,
      writer.epoch);
    if (!epoch || !equal(decode(epoch.owner), writer.owner)) return bad('conflict', 'Stale writer epoch');
    if (!db.prepare('SELECT 1 FROM resources WHERE holder=? AND epoch=? AND owner=?').get(writer.journal.root, writer.epoch,
      encode(writer.owner))) return bad('conflict', 'Writer claim is no longer held');
    if (expectedCursor !== null && saved.cursor !== expectedCursor) return bad('conflict', 'Stale expected cursor');
    const executionOnly = new Set(['invocation_reserved', 'command_reserved', 'stage_settled', 'gate_transition', 'outcome_settled',
      'backstop_reconstructed', 'checkpoint_materialized']);
    for (const payload of frozen) if (writer.kind === 'execution' && ['control_intent', 'control_settled', 'admitted'].includes(payload.type) ||
      writer.kind === 'control' && executionOnly.has(payload.type)) return bad('conflict', 'Wrong writer kind');
    const at = new Date().toISOString();
    return transition(db, writer.journal, frozen.map((payload, index) => ({ seq: saved.cursor + index + 1, run, at, payload })));
  });
}
export async function readEvents(journal: Journal, afterCursor: number): Promise<Result<readonly JournalEvent[]>> {
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) return invalid('Invalid exclusive cursor');
  return withState(journal.database, false, db => {
    const saved = current(db, journal); if (!saved) return bad('unavailable', 'Run state unavailable');
    if (afterCursor > saved.cursor) return invalid('Cursor beyond journal');
    return valid(db.prepare('SELECT seq,at,payload FROM events WHERE root=? AND seq>? ORDER BY seq').all(journal.root, afterCursor).map(row => ({
      seq: Number(row.seq), at: String(row.at), run: basename(journal.root), payload: decode<JournalPayload>(row.payload) })));
  });
}
export async function readProjection(journal: Journal): Promise<Result<RunProjection>> {
  return withState(journal.database, false, db => {
    const saved = current(db, journal); if (!saved) return bad('unavailable', 'Run state unavailable');
    const { launch, plan, authority, ...state } = saved.value;
    if (!backstopSchema.safeParse(state.backstop).success) return bad('unknown', 'Canonical C2 history must be reconstructed before continuation');
    if (!launch || !plan) return bad('unavailable', 'Run is not atomically admitted with a plan');
    const list = <T>(kind: string) => rows<T>(db, journal.root, kind).values();
    return valid({
run: basename(journal.root), cursor: saved.cursor, launch, brief: launch.brief, plan,
      backstop: state.backstop, received: list<AttemptReceipt>('received'), status: state.status, statusSince: state.statusSince,
        currentStage: state.currentStage, restoring: state.restoring,
      ...(state.reclaimed ? { reclaimed: state.reclaimed } : {}),
      ...(state.conclusion ? { conclusion: state.conclusion } : {}), ...(authority ? { authority: authority.authority } : {}),
      stageStates: list<StageState>('stage'), transitions: list<GateTransition>('transition'), revisions: list<AdmittedPlan>('revision'),
      obligations: list<RunObligation>('obligation'), closedInvocations: list<Invocation>('closed_invocation'),
      reservations: list<Reservation>('reservation'), intervals: list<ActiveInterval>('interval'), intents: list<ControlIntent>('intent'),
      lineage: db.prepare("SELECT kind,value FROM current_rows WHERE root=? AND kind IN ('command','checkpoint') ORDER BY ordinal,key")
        .all(journal.root).map(row => row.kind === 'command' ? { kind: 'command' as const, receipt: decode<CommandReceipt>(row.value) }
          : { kind: 'checkpoint' as const, checkpoint: decode<Checkpoint>(row.value) }),
      operations: list<Operation>('operation'), attempts: list<AttemptReceipt>('attempt'), commands: list<CommandReceipt>('command'),
      invocations: list<Invocation>('invocation'), owners: list<{ owner: Owner; state: OwnerState }>('owner'),
        checkpoints: list<Checkpoint>('checkpoint'), outputs: list<OutputReceipt>('output')
});
  });
}
/** Host observation reads the same indexed current facts, never repeatedly scans retained process history. */
export function readHostState(journal: Journal): Result<{ observation: import('../contract/runtime.js').RunObservation | null;
  pending: readonly Owner[] }> {
  return withState(journal.database, false, db => current(db, journal) ? valid({
    observation: rows<import('../contract/runtime.js').RunObservation>(db, journal.root, 'run_observation').get('activation') ?? null,
    pending: rows<Owner>(db, journal.root, 'active_process').values() }) : bad('unavailable', 'Run state unavailable'));
}
export async function listProjections(storeRoot: string, database: string): Promise<Result<readonly { location: RunLocation;
  projection: Result<RunProjection> }[]>> {
  const selected = withState(database, false,
    db => valid(db.prepare('SELECT name FROM runs WHERE store=? ORDER BY name').all(storeRoot).map(row => String(row.name))));
  if (!selected.ok) return selected;
  const out = [];
  for (const run of selected.value) { const location = { storeRoot, database, run }; const opened = await openJournal(location, 'read');
    out.push({ location, projection: opened.ok ? await readProjection(opened.value) : opened }); }
  return valid(out);
}
export function ownerClosed(journal: Journal, owner: Owner): Result<boolean> {
  return withState(journal.database, false, db => valid(rows<Owner>(db, journal.root, 'closed_owner').has(ownerOf(owner))));
}
/** Retire interrupted operation claims through their existing exact-epoch closure owner. */
export async function reconcileClaims(journal: Journal, retained: readonly Claim[]): Promise<Result<true>> {
  const found = withState(journal.database, false, db => valid(db.prepare(
    "SELECT path,owner,epoch,unit FROM resources WHERE holder=? AND owner IS NOT NULL AND id LIKE 'operation:%'").all(journal.root)));
  if (!found.ok) return found;
  for (const row of found.value) {
    if (retained.some(c => c.epoch === row.epoch)) continue;
    const held: Claim = { resource: String(row.path), owner: decode<Owner>(row.owner), epoch: String(row.epoch),
      unit: row.unit ? decode(row.unit) : null, holder: journal.root, database: journal.database };
    // Live operations retain their authority; stopping the unit must precede this reconciliation.
    const state = await probeOwner(held.owner);
    if (state === 'live') return bad('conflict', 'Prior claim owner still live');
    const released = await release(held, 'handoff'); if (!released.ok) return released;
  }
  return valid(true);
}
export async function readCommand(journal: Journal, key: CommandKey): Promise<Result<Reservation | null>> {
  if (!keySchema.safeParse(key).success) return invalid('Invalid command key');
  const result = withState(journal.database, false, db => valid(rows<Reservation>(db, journal.root, 'reservation').get(keyOf(key)) ?? null));
  if (result.ok && result.value?.state === 'committed') for (const ref of commandRefs(result.value.receipt)) {
    const checked = await validateRecordRef(journal, ref); if (!checked.ok) return checked; }
  return result;
}
export async function reserveCommand(writer: Writer, expectedCursor: number, command: Id, key: CommandKey,
  invocation: Invocation): Promise<Result<Reservation>> {
  if (!idSchema.safeParse(command).success || !keySchema.safeParse(key).success || !invocationSchema.safeParse(invocation).success ||
    invocation.charge !== 'command' ||
    invocation.address.run !== basename(writer.journal.root)) return invalid('Invalid command reservation identity or invocation');
  const existing = await readCommand(writer.journal, key); if (!existing.ok) return existing;
  if (existing.value) return existing.value.identity === command ? valid(existing.value) : bad('conflict',
    'Command identity differs for an existing key');
  const reservation: Reservation = { key, identity: command, invocation, state: 'reserved' };
  const result = await appendEvents(writer, expectedCursor, [{ type: 'invocation_reserved', invocation }, { type: 'command_reserved', reservation }]);
  if (result.ok) return valid(reservation);
  if (result.kind === 'conflict') { const read = await readCommand(writer.journal, key); if (!read.ok) return read;
    if (read.value) return read.value.identity === command ? valid(read.value) : bad('conflict', 'Concurrent command identity differs'); }
  return result;
}
export async function commitCommand(writer: Writer, expectedCursor: number, reservation: Reservation,
  receipt: CommandReceipt): Promise<Result<number>> {
  const checked = validateCommandReceipt(reservation, receipt); if (!checked.ok) return checked;
  const saved = await readCommand(writer.journal, reservation.key); if (!saved.ok) return saved;
  if (!saved.value || saved.value.state === 'committed' || saved.value.identity !== reservation.identity || !equal(saved.value.invocation,
    reservation.invocation)) return bad('conflict', 'Reservation is absent, replaced or already committed');
  return appendEvents(writer, expectedCursor, [{ type: 'command', receipt }]);
}

interface Extent { path: string; access: 'exclusive-write' | 'shared-write' | 'stable-read' }
function physicalExtent(resource: Extent): Extent & { inode: string | null } {
  let parent = resource.path, suffix: string[] = [];
  while (!existsSync(parent)) { suffix.unshift(basename(parent)); const next = dirname(parent);
    if (next === parent) throw new Error('Missing physical root'); parent = next; }
  const path = join(realpathSync(parent), ...suffix);
  const info = existsSync(path) ? lstatSync(path) : null;
  return { ...resource, path, inode: info ? `${info.dev}:${info.ino}` : null };
}
const overlaps = (a: string, b: string) => a === b || a.startsWith(b.endsWith('/') ? b : b + '/') || b.startsWith(a.endsWith('/') ? a : a + '/');
function resourceConflict(db: DatabaseSync, holder: string, extent: ReturnType<typeof physicalExtent>): Result<true> {
  for (const row of db.prepare('SELECT holder,path,access,inode FROM resources WHERE holder<>?').all(holder)) {
    if ((overlaps(extent.path, String(row.path)) || extent.inode !== null && extent.inode === row.inode)
      && !(extent.access === 'stable-read' && row.access === 'stable-read')
      && !(extent.access === 'shared-write' && row.access === 'shared-write')) return bad('conflict',
        `Resource conflict: ${extent.path} with ${row.path}`);
  }
  return valid(true);
}
/** The same canonical extents used by launch grants are admitted in the state transaction before provisioning. */
function admitResources(db: DatabaseSync, journal: Journal, authority: NonNullable<RunProjection['authority']>): Result<true> {
  for (const resource of authority.resources) {
const extent = physicalExtent(resource), checked = resourceConflict(db, journal.root, extent); if (!checked.ok) return checked;
    db.prepare('INSERT INTO resources VALUES(?,?,?,?,?,?,?,?)').run('plan:' + journal.root + ':' + resource.access + ':' + extent.path,
      journal.root, extent.path, extent.access, extent.inode, null, null, 'admitted');
  }
  return valid(true);
}
/** Operation identity and resource ownership use the same installation transaction. Handoff retains the run reservation. */
export async function claim(resource: string, unit: import('../contract/runtime.js').RunRef | null, scope: { database: string; holder: string }
  ): Promise<Result<Claim>> {
  if (!isAbsolute(resource) || resource.includes('\0') || unit !== null && !parseRunRef(unit).ok) return invalid('Invalid operation claim');
  const extent = physicalExtent({ path: resource, access: 'exclusive-write' }), id = 'operation:' + scope.holder + ':' + extent.path;
  const snapshot = withState(scope.database, false, db => valid(db.prepare('SELECT * FROM resources WHERE id=?').get(id)));
  if (!snapshot.ok) return snapshot;
  if (snapshot.value?.owner) {
    const owner = decode<Owner>(snapshot.value.owner), state = await probeOwner(owner);
    if (state !== 'dead') return bad(state === 'unknown' ? 'unknown' : 'conflict', 'Operation group remains owned');
    const closed = await endOperation(owner); if (!closed.ok) return closed;
  }
  const opened = await beginOperation(); if (!opened.ok) return opened;
  const owner = opened.value.owner, epoch = 'e' + randomUUID();
  const acquired = withState(scope.database, true, db => {
    const conflict = resourceConflict(db, scope.holder, extent); if (!conflict.ok) return conflict;
    const prior = db.prepare('SELECT * FROM resources WHERE id=?').get(id);
    if (!equal(prior, snapshot.value)) return bad('conflict', 'Claim changed during admission');
    if (prior?.unit && !equal(decode(prior.unit), unit)) return bad('conflict', 'Another pinned run reserves resource');
    db.prepare('INSERT OR REPLACE INTO resources VALUES(?,?,?,?,?,?,?,?)').run(id, scope.holder, extent.path, extent.access, extent.inode,
      encode(owner), unit ? encode(unit) : null, epoch);
    return valid({ resource: extent.path, owner, epoch, unit, ...scope });
  });
  if (!acquired.ok) await endOperation(owner);
  return acquired;
}
/** Closure is observed before the short exact-epoch retirement transaction. */
export async function release(claim: Claim, mode: 'handoff' | 'retire'): Promise<Result<OwnerState>> {
  if (!claim || !ownerSchema.safeParse(claim.owner).success || !idSchema.safeParse(claim.epoch).success) return invalid('Invalid release');
  const closed = await endOperation(claim.owner); if (!closed.ok) return closed;
  return withState(claim.database, true, db => {
    const id = 'operation:' + claim.holder + ':' + claim.resource, prior = db.prepare('SELECT owner,epoch FROM resources WHERE id=?').get(id);
    if (!prior || prior.epoch !== claim.epoch || !equal(decode(prior.owner), claim.owner)) return bad('conflict', 'Stale claim epoch');
    db.prepare('UPDATE epochs SET active=0 WHERE root=? AND epoch=?').run(claim.holder, claim.epoch);
    if (mode === 'handoff' && claim.unit) db.prepare('UPDATE resources SET owner=NULL WHERE id=?').run(id);
    else db.prepare('DELETE FROM resources WHERE id=?').run(id);
    return valid('dead' as const);
  });
}
/** Native work executes in the recorded operation group; no callback can outlive its own recorded owner. */
export async function recordOperation<T>(journal: Journal, kind: 'construct' | 'restore' | 'gc' | 'publish', request: OperationRequest,
  source?: () => AsyncIterable<Uint8Array>, output?: (bytes: AsyncIterable<Uint8Array>) => Promise<void>): Promise<Result<T>> {
  if (inOperation) return performOperation<T>(request);
  const id = 'record:' + randomUUID(), epoch = 'e' + randomUUID();
  return runOperation<T>(request, {
    ready: async owner => withState(journal.database, true, db => {
      for (const row of db.prepare("SELECT access FROM resources WHERE holder=? AND id LIKE 'record:%'").all(journal.root))
        if (kind !== 'construct' || row.access !== 'shared-write') return bad('conflict', 'Record construction or maintenance remains unresolved');
      if (kind !== 'construct') {
        if (rows<AttemptReceipt>(db, journal.root, 'attempt').values().some(value => value.closure !== 'dead' && !rows(db, journal.root, 'closed_invocation').has(addressOf(value.address)))) return bad('unknown',
          'Unproved attempt closure prevents maintenance');
        if (rows<Reservation>(db, journal.root, 'reservation').values().some(reservationOpen)) return bad('unknown',
          'Unresolved reservation prevents maintenance');
        for (const value of rows<{ owner: Owner; state: OwnerState }>(db, journal.root, 'owner').values()) if (value.state !== 'dead' &&
          value.state !== 'reused') return bad('unknown', 'Unproved writer closure prevents maintenance');
      }
      db.prepare('INSERT INTO resources VALUES(?,?,?,?,?,?,?,?)').run(id, journal.root, journal.root,
        kind === 'construct' ? 'shared-write' : 'exclusive-write', null, encode(owner), null, epoch); return valid(true);
    }),
    updated: async (previous, owner) => withState(journal.database, true,
      db => Number(db.prepare('UPDATE resources SET owner=? WHERE id=? AND epoch=? AND owner=?').run(encode(owner), id, epoch,
      encode(previous)).changes) === 1 ? valid(true) : bad('conflict', 'Native member authority changed')),
    closed: async owner => withState(journal.database, true, db => {
      const removed = db.prepare('DELETE FROM resources WHERE id=? AND epoch=? AND owner=?').run(id, epoch, encode(owner));
        return Number(removed.changes) === 1 ? valid(true) : bad('conflict', 'Record operation epoch changed');
    }),
  }, source, output);
}
export async function reclaimRecordOperations(journal: Journal): Promise<Result<true>> {
  const read = withState(journal.database, true, db => {
const rows = db.prepare("SELECT id,owner,epoch FROM resources WHERE holder=? AND id LIKE 'record:%'").all(journal.root);
    db.prepare("UPDATE resources SET access='exclusive-write' WHERE holder=? AND id LIKE 'record:%'").run(journal.root); return valid(rows);
});
  if (!read.ok) return read;
  for (const row of read.value) {
const owner = decode<Owner>(row.owner), closed = await endOperation(owner); if (!closed.ok) return closed;
    const retired = withState(journal.database, true,
      db => Number(db.prepare('DELETE FROM resources WHERE id=? AND owner=? AND epoch=?').run(row.id, row.owner,
      row.epoch).changes) === 1 ? valid(true) : bad('conflict', 'Reclaim epoch changed')); if (!retired.ok) return retired;
  }
  return valid(true);
}
export function putEvidence(journal: Journal, bytes: Uint8Array) { return recordOperation<import('../contract/brief.js').Ref>(journal,
  'construct', { module: new URL('./evidence.js', import.meta.url).href, method: 'putEvidence', args: [journal, bytes] }); }
export function storeEvidence(journal: Journal, source: () => AsyncIterable<Uint8Array>) {
  return recordOperation<import('../contract/brief.js').Ref>(journal, 'construct', { module: new URL('./evidence.js', import.meta.url).href,
  method: 'storeEvidenceInput', args: [journal] }, source); }

/** Reclaim releases admitted extents only after durable preservation and deletion of a terminal worktree. */
export function releaseRunResources(journal: Journal): Result<true> {
  return withState(journal.database, true, db => {
    const saved = current(db, journal); if (!saved || !terminal(saved.value.status)) return bad('conflict', 'Executable run retains its resources');
    const preserved = db.prepare("SELECT value FROM current_rows WHERE root=? AND kind='output' ORDER BY ordinal DESC LIMIT 1").get(journal.root);
    if (!preserved || !decode<OutputReceipt>(preserved.value).preserved) return bad('unknown', 'Unpreserved outputs retain resources');
    db.prepare("DELETE FROM resources WHERE holder=? AND id LIKE 'plan:%'").run(journal.root);
    return valid(true);
  });
}

/** Current semantic read model on the export owner's private connection. No journal replay, native work or nested transaction. */
export function statusView(db: DatabaseSync, journal: Journal, publishedAt: string, activeElapsedMs: number | null)
  : Result<import('../contract/runtime.js').RunStatusFile> {
  const saved = current(db, journal);
  if (!saved) return bad('unavailable', 'Run state unavailable');
  const state = saved.value, setup = state.setup?.measured ?? state.launch?.setup;
  const brief = state.launch?.brief ?? state.setup?.request.brief;
  const identity = state.launch?.unit ?? state.setup?.unit;
  if (!setup || !brief || !identity) return bad('unavailable', 'Run preparation unavailable');
  const attempts = rows<AttemptReceipt>(db, journal.root, 'attempt').values();
  const intervals = rows<ActiveInterval>(db, journal.root, 'interval').values();
  const open = intervals.filter(intervalOpen);
  const duration = intervals.some(i => i.closed === 'unmeasured') || open.length && (open.length !== 1 || activeElapsedMs === null) ? null
    : intervals.reduce((sum,i) => sum + (i.spentMs ?? activeElapsedMs ?? 0), 0);
  const usage: import('../contract/runtime.js').Usage = {state: attempts.length && attempts.every(a => a.usage.state === 'known') ? 'known'
    : attempts.some(a => a.usage.state !== 'unknown') ? 'partial' : 'unknown', raw: attempts.flatMap(a => a.usage.raw)};
  const totals: Record<string,number> = {};
  for (const key of ['input','output','cached','costUsd'] as const) {
    const values = attempts.flatMap(a => a.usage[key] === undefined ? [] : [a.usage[key]!]);
    if (values.length) totals[key] = values.reduce((a,b) => a+b,0);
  }
  const obligations = rows<RunObligation>(db, journal.root, 'obligation').values();
  const reason = state.conclusion?.reason ?? null;
  const condition = reason === 'backstop' ? state.backstop.gateSuffix >= 3 ? 'gate' : state.backstop.failureSuffix >= 4 ? 'failure' : null : null;
  const observed = rows<import('../contract/runtime.js').RunObservation>(db, journal.root, 'run_observation').get('activation');
  return parseRunStatusFile({...(state.reclaimed ? { reclaimed: state.reclaimed } : {}),version:2,publishedAt,run:basename(journal.root),identity,
    ...(state.launch?.requester === undefined ? {} : {requester:state.launch.requester}),
    status:state.status,statusSince:state.statusSince,currentStage:state.currentStage,journalCursor:saved.cursor,
    stopReason:reason, ...(state.authority ? {authority:state.authority.authority} : {}),
    backstop:{...state.backstop,rule:'C2',gateThreshold:3,failureThreshold:4,scope:'engine-outcomes',condition},
    step:{startedAt:state.stepStartedAt ?? null,elapsedMs:state.currentStage && state.stepStartedAt
      ? Math.max(0,Date.parse(publishedAt)-Date.parse(state.stepStartedAt)) : null},
    usage:{...usage,...totals,invocations:Number(db.prepare("SELECT count(*) AS n FROM current_rows WHERE root=? AND kind='invocation'")
      .get(journal.root)?.n ?? 0),activeDurationMs:duration},
    gates:rows<{gate:import('../contract/runtime.js').RunStatusFile['gates'][number]}>(db,journal.root,'status_gate').values().map(row=>row.gate),
    attention:obligations.length ? {reason:obligationReason(obligations[0].kind),detail:[...new Set(obligations.map(o => o.detail))].join('; '),condition:null,obligations}
      : reason === null ? null : {reason,detail:state.conclusion?.detail ?? '',condition},
    host:{...(observed?.owner ? {boot:observed.owner.boot} : {}),readiness:setup.nativeGrant,interpretation:[...(setup.interpretation ?? state.authority?.authority.interpretation ?? []),
      ...(state.hostScope ? [state.hostScope === 'group' ? 'Closure covers the recorded process group; a child creating a new session may escape.'
        : 'Closure covers sandbox-contained descendants.'] : [])]},
    notification:{session:state.launch?.requester === undefined ? 'unbound' : 'bound',
      scope:'persistent-status; optional bound-session wake',transport:'unobserved'}});
}
