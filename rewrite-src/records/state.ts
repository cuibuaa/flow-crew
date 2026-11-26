import { stageNeedsCorrection } from '../contract/status.mjs';
import { ignoreRetired } from '../contract/brief.js';
import { commandEvidenceLabel, commandBasis, commandReceiptSchema, processClosed } from '../contract/runtime.js';
import { performOperation } from '../host/process.js';
import { DatabaseSync } from 'node:sqlite';
import { constants, realpathSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beginOperation, endOperation, probeOwner, runOperation, inOperation, type OperationRequest, type Claim }
  from '../host/process.js';
import type { RunLocation, Writer } from '../contract/runtime.js';

import { ownerSchema, commandRefs, backstopSchema, initialBackstop, commandKeySchema }
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
  JournalEvent as BaseJournalEvent, JournalPayload as BaseJournalPayload, Launch, Invocation, Operation, OutputReceipt, Owner, OwnerState, Reservation, RunProjection, RunStatus,
  StageState, StageSegment, Backstop, RunObligation } from '../contract/runtime.js';
import { type AdmittedPlan } from '../contract/plan.js';
import { validateRecordRef } from './evidence.js';
import type { ExecutionActivity, GuideDelivery, GuideStatus } from '../host/process.js';
export type JournalPayload = BaseJournalPayload;
type JournalEvent = Omit<BaseJournalEvent, 'payload'> & { readonly payload: JournalPayload };
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const keySchema = commandKeySchema;
const commandSchema = commandReceiptSchema;

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
const checkpointSchema = z.preprocess(value => ignoreRetired(value, 'checkpoint'), z.strictObject({
  id: idSchema, address: addressSchema, parent: idSchema.nullable(),
  state: z.enum(['safe', 'quarantined']), manifest: refSchema, tree: hash, brief: hash,
  inputHashes: z.array(refSchema), evidence: z.array(refSchema)
}));
const outputSchema = z.strictObject({ preserved: z.boolean(), artifacts: z.array(refSchema), detail: z.string(),
  released: z.array(declaredPathSchema).optional(), disposition: z.enum(['reviewed', 'unreviewed']).optional() });
const conclusionSchema = z.strictObject({
  status: z.enum(['pending', 'running', 'parked', 'complete', 'accepted_blocked', 'incomplete', 'failed', 'escalated', 'cancelled']),
  reason: z.enum(['completed', 'accepted_blocked', 'gate_irreparable', 'command_missing', 'command_nonzero', 'command_unfinished',
    'outputs_unpreserved', 'backstop', 'attempt_failed', 'contract_refused', 'isolation_refused', 'cancelled', 'recovery_unknown', 'closure_unconfirmed', 'accounting_unsettled', 'claim_unreleased']),
  detail: z.string(), authoredGate: refSchema.optional(), cause: z.literal('resume_refused').optional(),
}).refine(conclusion => ({
  pending: [], running: [], parked: ['backstop', 'attempt_failed', 'recovery_unknown', 'closure_unconfirmed', 'accounting_unsettled', 'claim_unreleased', 'command_unfinished'], complete: ['completed'],
  accepted_blocked: ['accepted_blocked'],
  incomplete: ['command_missing', 'command_nonzero', 'command_unfinished', 'outputs_unpreserved'],
  failed: ['gate_irreparable', 'attempt_failed', 'contract_refused', 'isolation_refused'],
  escalated: ['recovery_unknown'], cancelled: ['cancelled'],
}[conclusion.status] as string[]).includes(conclusion.reason));
const stageCommon = {
  id: idSchema, role: idSchema, after: z.array(idSchema),
  skills: z.array(idSchema).optional(), // Historical records only.
  commands: z.array(idSchema).optional(), baseCheckpoint: idSchema.optional()
};
const planSchema = z.preprocess(value => ignoreRetired(value, 'plan'), z.strictObject({
  stages: z.array(z.discriminatedUnion('purpose', [
    z.strictObject({ ...stageCommon, instruction: z.string().min(1), purpose: z.literal('work') }),
    z.strictObject({ ...stageCommon, instruction: z.string().min(1), purpose: z.literal('plan') }),
    z.strictObject({
      ...stageCommon, purpose: z.literal('gate'), commands: z.array(idSchema),
      repair: z.strictObject({ stage: idSchema, returnsTo: idSchema }).optional()
    }),
  ])).min(1)
}));
const admittedPlanSchema = z.strictObject({ revision: idSchema, plan: planSchema, digest: hash, executed: z.array(refSchema) });
// Historical replay is structural, not current admission: retain optional quote metadata even
// on passing criteria and advisory findings. Settlement alone validates newly delivered answers.
const attemptSchema = z.preprocess(value => ignoreRetired(value, 'attempt'), z.strictObject({
  address: addressSchema, ending: z.enum(['delivered', 'invalid_answer', 'invalid_plan', 'work_failed',
    'technical_failure', 'auth', 'refused', 'input_too_large', 'quota', 'duration', 'cancelled', 'isolation_failure', 'closure_unknown',
      'provider_unknown']),
  answer: z.union([
    z.strictObject({
      kind: z.literal('work'), answer: z.strictObject({
        status: z.enum(['delivered', 'blocked', 'environment_gap']), summary: z.string().min(1),
        caveats: z.array(z.string()), remainingWork: z.array(z.string()),
        blocks: z.strictObject({ criterionIds: z.array(idSchema), paths: z.array(declaredPathSchema) }).nullable(),
      })
    }),
    z.strictObject({
      kind: z.literal('gate'), answer: z.strictObject({
        outcome: z.enum(['accepted', 'accepted_blocked', 'rejected_repairable', 'rejected_irreparable']), reason: z.string().min(1),
        criteria: z.record(idSchema, z.union([
          z.strictObject({ status: z.enum(['pass', 'fail']), evidence: z.string().min(1), briefQuote: z.string().min(1).optional() }),
          z.strictObject({ status: z.literal('not_assessed'), evidence: z.string().min(1), reason: z.literal('pending_work') }),
        ])),
        findings: z.array(z.strictObject({
          id: idSchema, paths: z.array(declaredPathSchema), reason: z.string().min(1),
          criterionIds: z.array(idSchema), class: z.enum(['criterion_unmet', 'regression', 'advisory']), briefQuote: z.string().min(1).optional(), commandEvidence: refSchema.optional()
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
  reusedCommands: z.array(z.strictObject({receipt:commandSchema, sourceTree:hash, source:z.strictObject({stage:idSchema,attempt:idSchema,invocation:z.number().int().positive().optional()}), dependencyIntersection:z.tuple([]).optional()})).optional(),
  inputChars: natural.nullable(), guidance: z.preprocess(value => typeof value === 'string' ? [value] : value, z.array(idSchema)).optional()
}));
const baselinesSchema = z.strictObject({ inputs: z.array(refSchema), outputs: z.array(refSchema), tree: hash.optional() });
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
    type: z.literal('process'), receipt: z.preprocess(value => ignoreRetired(value, 'processReceipt'), z.strictObject({
      owner: ownerSchema.optional(), state: z.enum(['closed', 'not_started', 'closure_unknown']),
      exit: z.number().int().safe().nullable(), signal: z.string().nullable(), stdout: refSchema, stderr: refSchema, durationMs: natural, scope: z.enum(['group', 'contained_descendants']),
      guarantee: z.enum(['cgroup', 'marker']).optional(), unknownPids: z.array(natural.positive()).optional(), detail: z.string().optional(),
      closedAtTerminal: z.literal(true).optional(), terminationCause: z.enum(['cancelled', 'duration']).optional()
    }))
  }),
  invocation_reserved: z.strictObject({ type: z.literal('invocation_reserved'), invocation: invocationSchema }),
  attempt_received: z.strictObject({ type: z.literal('attempt_received'), receipt: attemptSchema }),
  backstop_reconstructed: z.strictObject({ type: z.literal('backstop_reconstructed'), basis: natural, backstop: backstopSchema }),
  outcome_settled: z.strictObject({ type: z.literal('outcome_settled'), address: addressSchema, obligation: z.string(), completed: z.boolean(),
    backstop: backstopSchema }),
  attempt_settled: z.strictObject({ type: z.literal('attempt_settled'), receipt: attemptSchema }),
  command_reserved: z.strictObject({ type: z.literal('command_reserved'), reservation: reservationSchema }),
  command_activity: z.strictObject({ type: z.literal('command_activity'), owner: ownerSchema, key: keySchema, state: z.enum(['observing','progress','quiet','unknown']),
    notice: z.literal('no observed progress for 10 min').optional() }),
  command_limit: z.strictObject({ type: z.literal('command_limit'), key: keySchema }),
  command: z.strictObject({ type: z.literal('command'), receipt: commandSchema }),
  checkpoint: z.strictObject({ type: z.literal('checkpoint'), checkpoint: checkpointSchema }),
  checkpoint_restore_started: z.strictObject({ type: z.literal('checkpoint_restore_started'), checkpoint: idSchema }),
  checkpoint_materialized: z.strictObject({ type: z.literal('checkpoint_materialized'), checkpoint: idSchema }),
  preparation_ended: z.strictObject({ type: z.literal('preparation_ended'), state: z.enum(['refused', 'cancelled']), detail: z.string() }),
  run_reclaimed: z.strictObject({ type: z.literal('run_reclaimed'), at: z.iso.datetime(), delivery: declaredPathSchema }),
  delivery_preserved: z.strictObject({ type: z.literal('delivery_preserved'), at: z.iso.datetime(), delivery: declaredPathSchema }),
  reclaim_completed: z.strictObject({ type: z.literal('reclaim_completed') }),
  held_measured: z.strictObject({ type: z.literal('held_measured'), ending: natural, bytes: natural }),
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
/** Canonical delivery index includes native steering and consumed immutable input. */
export function guidanceStatus(projection: Pick<RunProjection,'intents'|'guideDeliveries'>): GuideStatus[] {
  return projection.intents.filter(intent=>intent.kind === 'guide').map(intent=>{
    const invocation=projection.guideDeliveries?.find(delivery=>delivery.guide === intent.id)?.invocation;
    return {guide:intent.id,state:invocation ? 'delivered' : 'pending',...(invocation ? {invocation} : {})};
  });
}
export function pendingGuidance(projection: Pick<RunProjection,'intents'|'guideDeliveries'>) {
  const pending=new Set(guidanceStatus(projection).filter(guide=>guide.state === 'pending').map(guide=>guide.guide));
  return projection.intents.filter(intent=>pending.has(intent.id));
}
const activityKey = (invocation: Invocation, command?: string): string => JSON.stringify([invocation.charge === 'command' ? 'command' : 'invocation',
  invocation.address.kind === 'stage' ? invocation.address.stage : null,command]);
const equal = (left: unknown, right: unknown): boolean => isDeepStrictEqual(left, right);
// SQL reduction and readers share the pure reducer; no reader owns a second state list.
export { nextLifecycle, lifecycle, isFinal } from '../contract/lifecycle.mjs';
export type { Lifecycle, LifecycleFact } from '../contract/lifecycle.mjs';
import { nextLifecycle, lifecycle, isFinal } from '../contract/lifecycle.mjs';
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
/** Closure reconciliation settles ownership without rewriting the original unknown result. */
export const attemptOpen = (projection: Pick<RunProjection, 'closedInvocations'>, receipt: AttemptReceipt): boolean =>
  receipt.closure !== 'dead' && !projection.closedInvocations.some(invocation => invocation.charge !== 'command'
    && equal(invocation.address, { kind: 'stage', ...receipt.address }));
/** Received bytes still awaiting settlement in the executable graph. Closure is a
 * separate ownership fact (attemptOpen); retired and settled receipts stay history. */
export const pendingReceipts = (projection: Pick<RunProjection, 'received' | 'attempts' | 'stageStates'>): readonly AttemptReceipt[] =>
  projection.received.filter(raw => !projection.attempts.some(receipt => equal(receipt.address, raw.address))
    && !projection.stageStates.some(stage => stage.stage === raw.address.stage && stage.state === 'skipped'));
/** A reconciled request is spent only for the attempt that reserved it.
 * Corrections share that attempt; any new attempt requests its own commands. */
export function commandInterrupted(projection: Pick<RunProjection, 'reservations'>,
  address: AttemptReceipt['address'], command: string): boolean {
  return projection.reservations.some(reservation => reservation.state === 'closed-unmeasured'
    && reservation.identity === command && reservation.invocation.address.kind === 'stage'
    && reservation.invocation.address.run === address.run && reservation.invocation.address.stage === address.stage
    && reservation.invocation.address.attempt === address.attempt);
}
/** Cancellation fences the run; a lifecycle end fences only requests already reserved at that boundary. */
export const executionFenced = (events: readonly JournalEvent[], reservedIndex: number): boolean => events.some((event, index) =>
  event.payload.type === 'control_intent' && event.payload.intent.kind === 'cancel'
  || index > reservedIndex && event.payload.type === 'lifecycle');

const invalid = (detail: string): Result<never> => ({ ok: false, kind: 'invalid', detail });

/** One reducer for candidate and committed plan stage states. */
export function planStageStates(previous: readonly StageState[], plan: AdmittedPlan): StageState[] {
  const active = new Set(plan.plan.stages.map(stage => stage.id));
  const states = new Map(previous.map(state => [state.stage, !active.has(state.stage)
    && ['pending','dormant','running'].includes(state.state) ? {...state,state:'skipped' as const} : state]));
  for (const state of initialStates(plan)) if (!states.has(state.stage)) states.set(state.stage,state);
  return [...states.values()];
}

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
const activityTable = `CREATE TABLE IF NOT EXISTS advisory_activity (
 id INTEGER PRIMARY KEY, root TEXT NOT NULL REFERENCES runs(root), execution TEXT NOT NULL,
 value TEXT NOT NULL CHECK(json_valid(value))
); CREATE INDEX IF NOT EXISTS advisory_execution ON advisory_activity(root,execution,id);`;
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
  const { errcode, errstr } = error as { errcode?: number; errstr?: string };
  return bad(errcode === 5 || errcode === 6 ? 'conflict' : errcode === 11 || errcode === 26 ? 'invalid' : 'unknown',
    `${String(error)}; SQLite ${JSON.stringify({ errcode, errstr })}`);
}
type StateResult<T> = Result<T> & { readonly commitIssued?: true; readonly unsettled?: true };
export type Creation = { readonly state: 'not_attempted' } | { readonly state: 'rejected_or_aborted' }
  | { readonly state: 'confirmed'; readonly location: RunLocation } | { readonly state: 'indeterminate'; readonly location: RunLocation };
export type CreationResult = Result<Journal> & { readonly creation: Creation };
/** A connection never escapes its synchronous section. No await, callback reentry, shared connection, or custom busy scheduler. */
export function withState<T>(database: string, write: boolean, operation: (db: DatabaseSync) => Result<T>): StateResult<T> {
  if (active.has(database)) return bad('conflict', 'State operation is not reentrant');
  let db: DatabaseSync | undefined, begun = false, commitIssued = false;
  let outcome: StateResult<T>;
  try { outcome = ((): Result<T> => {
    if (!isAbsolute(database) || resolve(database) !== database || realpathSync(dirname(database)) !== dirname(database))
      return bad('invalid', 'State database requires a canonical protected parent');
    const stat = lstatSync(database);
    if (!stat.isFile() || stat.nlink !== 1 || realpathSync(database) !== database) return bad('invalid', 'Aliased state database');
    active.add(database);
    db = new DatabaseSync(database, { enableForeignKeyConstraints: true, readOnly: !write });
    db.exec('PRAGMA busy_timeout=5000');
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
      db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') return bad('invalid', 'Unsupported state database format or journal mode');
    db.exec('PRAGMA synchronous=FULL');
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); begun = true;
    const result = operation(db);
    if (result && typeof (result as unknown as { then?: unknown }).then === 'function') throw new Error('State operation must be synchronous');
    commitIssued = write && result.ok;
    db.exec(commitIssued ? 'COMMIT' : 'ROLLBACK'); begun = false;
    return result;
  })(); } catch (error) {
    outcome = { ...databaseFailure(error), ...(commitIssued ? { commitIssued: true as const } : {}) };
  }
  let cleanupError: unknown;
  if (begun) try { db?.exec('ROLLBACK'); begun = false; } catch (error) { cleanupError = error; }
  let closed = false;
  try { db?.close(); closed = true; } catch (error) { cleanupError = error; }
  active.delete(database);
  // COMMIT owns the outcome. Connection cleanup cannot retract a completed transaction.
  if (cleanupError) warnCleanup(cleanupError);
  return begun && !closed ? { ...outcome, unsettled: true } : outcome;
}
function warnCleanup(error: unknown): void {
  try { process.stderr.write(`State cleanup warning: ${String(error)}\n`); } catch {}
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
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;' + schema + activityTable + 'PRAGMA user_version=1; COMMIT;');
    }
    finally { try { db.close(); } catch (error) { warnCleanup(error); } }
    const fd = openSync(dirname(database), constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); }
    return valid(database);
  } catch (error) { return databaseFailure(error); }
}
interface Current {
  preparation?: import('../contract/runtime.js').Preparation;
  preparationReason?: string;
  heldSpace?: { ending: number; at?: string; writer: 'execution' | 'control'; bytes?: number };
  delivery?: { at: string; delivery: string };
  timeline?: import('../contract/runtime.js').RunTimeline;
  reclaimed?: { at: string; delivery: string };
  launch?: Launch; plan?: AdmittedPlan; setup?: Extract<JournalPayload, { type: 'setup_prepared' }>;
  authority?: Extract<JournalPayload, { type: 'run_authority' }>;
  status: RunStatus; statusSince: number; stepStartedAt?: string | null; hostClosure?: string; conclusion?: Conclusion; currentStage: Id | null;
  backstop: Backstop; restoring: Id | null; fenced: boolean;
}
const emptyCurrent = (): Current => ({ backstop: initialBackstop(), status: 'pending', statusSince: 0, currentStage: null, restoring: null,
  fenced: false });
function endCurrent(value: Current, writer: 'execution' | 'control', cursor: number, at = value.timeline?.endedAt): void {
  if (!at || value.reclaimed) return;
  if (!Number.isSafeInteger(value.statusSince) || value.statusSince <= 0 || value.statusSince > cursor || !isFinal(value.status))
    throw Error('Invalid retained ending boundary');
  value.timeline = { ...value.timeline!, endedAt: at };
  value.heldSpace ??= { ending: value.statusSince, at, writer };
}
function completedCurrent(reclaimed: NonNullable<Current['reclaimed']>) {
  return { reclaimed, delivery: reclaimed, heldSpace: undefined };
}
function current(db: DatabaseSync, journal: Journal): { cursor: number; value: Current } | null {
  const row = db.prepare('SELECT cursor,current FROM runs WHERE root=?').get(journal.root);
  if (!row) return null;
  const value = ignoreRetired(decode<Current>(row.current), 'projection');
  if (value.reclaimed) Object.assign(value, completedCurrent(value.reclaimed));
  endCurrent(value, 'control', Number(row.cursor));
  return { cursor: Number(row.cursor), value };
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
    || rows<Invocation>(db, journal.root, 'invocation').entries().some(([key, invocation]) => invocation.charge !== 'command'
      && rows<AttemptReceipt>(db, journal.root, 'attempt').get(key)?.closure !== 'dead'
      && !rows(db, journal.root, 'closed_invocation').has(key));
}
/** The reconciliation owner consumes the same accounting predicate as the reducer. */
export function readAccountingPending(journal: Journal): Result<boolean> {
  return withState(journal.database, false, db => valid(unsettledAccounting(db, journal)));
}
const afterFence = new Set<JournalPayload['type']>(['control_intent', 'control_settled', 'run_observed', 'ownership', 'process',
  'preparation_ended', 'obligation', 'accounting_interrupted', 'owner_closed', 'delivery_preserved', 'run_reclaimed', 'reclaim_completed', 'held_measured', 'attempt_received', 'attempt_settled', 'command', 'checkpoint', 'outputs_preserved', 'active_time_closed', 'backstop_reconstructed']);
function transition(db: DatabaseSync, journal: Journal, events: readonly JournalEvent[]): Result<number> {
  const saved = current(db, journal); if (!saved) return bad('unavailable', 'Run state unavailable');
  const run = basename(journal.root), start = saved.cursor;
  let { backstop, launch, plan, setup, authority, status, statusSince, conclusion, currentStage, restoring, fenced } = saved.value;
  if (!backstopSchema.safeParse(backstop).success && !(events.length === 1 &&
    events[0].payload.type === 'backstop_reconstructed')) return bad('unknown', 'Canonical C2 history must be reconstructed before continuation');
  const batchStatus = status;
  let stepStartedAt = saved.value.stepStartedAt ?? null;
  let hostClosure = saved.value.hostClosure;
  let reclaimed = saved.value.reclaimed;
  let heldSpace = saved.value.heldSpace, delivery = saved.value.delivery;
  let endingWriter: 'execution' | 'control' = 'execution';
  let timeline = saved.value.timeline;
  let endingAt = timeline?.endedAt;
  let preparationReason = saved.value.preparationReason;
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
      case 'preparation_ended':
        if (!saved.value.preparation || launch) return invalid('Only a non-admitted preparation can end');
        status = fact.state; preparationReason = fact.detail;
        if (fact.state === 'cancelled') conclusion = { status, reason: 'cancelled', detail: fact.detail };
        break;
      case 'run_authority':
        if (authority || setup || launch) return invalid('Run authority is immutable and precedes setup');
        { const admitted = admitResources(db, journal, fact.authority); if (!admitted.ok) return admitted; }
        authority = fact;
        break;
      case 'setup_prepared':
        if (launch || !equal(fact.request.runtime, fact.unit.runtime) || (setup &&
          (setup.measured !== null || fact.measured === null
          || !equal(setup.request, fact.request) || !equal(setup.unit, fact.unit) || !equal(setup.baselines, fact.baselines))))
          return invalid('Setup must complete the original baselines exactly once');
        if (fact.measured && (fact.measured.project !== fact.request.project || fact.measured.target !== fact.request.target
          || fact.measured.brief !== fact.request.brief.digest || !equal(fact.measured.inputs, fact.baselines.inputs)
          || !equal(fact.measured.outputs, fact.baselines.outputs) || fact.measured.tree !== fact.baselines.tree)) return invalid('Setup measurements do not match original baselines');
        setup = fact;
        break;
      case 'admitted': {
        const measured = fact.launch.setup;
        if (launch) return bad('conflict', 'Already admitted');
        if (!setup || setup.request.target !== fact.launch.project || setup.request.project !== measured.project
          || !equal(setup.request.brief, fact.launch.brief) || !equal(setup.request.runtime, fact.launch.runtime)
          || !equal(setup.unit, fact.launch.unit) || !equal(setup.measured, measured)) return invalid('Admission does not match setup');
        launch = fact.launch; status = 'pending';
        break;
      }
      case 'plan_committed': {
        if (!launch || revisions.has(fact.plan.revision))
          return invalid('Missing admission or duplicate plan revision');
        plan = decode<AdmittedPlan>(encode(fact.plan));
        revisions.set(plan.revision, plan);
        for (const state of planStageStates(stageStates.values(), plan)) stageStates.set(state.stage, state);
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
        if (invocation.address.kind === 'stage') {
          const address = invocation.address, previous = stageStates.get(address.stage);
          if (!previous || !plan?.plan.stages.some(stage => stage.id === address.stage)) return invalid('Invocation references an undefined stage');
          if (nextLifecycle(status, 'run') !== null) stageStates.set(previous.stage, { ...previous, state: 'running' });
        }
        if (invocation.address.kind === 'stage' && invocation.charge !== 'command') {
          if (invocations.has(addressOf(invocation.address))) return invalid('Invocation already reserved');
          invocations.set(addressOf(invocation.address), invocation);
        }
        if (invocation.address.kind === 'stage' && nextLifecycle(status, 'run') !== null) {
          status = 'running'; currentStage = invocation.address.stage; stepStartedAt = event.at; conclusion = undefined;
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
      case 'command_activity': {
        const key = keyOf(fact.key), reservation = reservations.get(key);
        if (!reservation || !reservationOpen(reservation)) return bad('conflict', 'Activity requires an open command reservation');
        const observedOwner = owners.get(ownerOf(fact.owner));
        if (observedOwner?.state !== 'live' || !equal(observedOwner.owner, fact.owner)) return bad('conflict', 'Activity owner is no longer current');
        const activities = rows<import('../contract/runtime.js').CommandActivity>(db, journal.root, 'command_activity', cursor);
        const previous = activities.get(key), address = reservation.invocation.address;
        if (fact.notice !== undefined && (previous?.notice || fact.state !== 'quiet')) return invalid('Notice requires the first quiet observation');
        activities.set(key, { command: reservation.identity, stage: address.kind === 'stage' ? address.stage : null,
          state: fact.state, ...(previous?.notice ? { notice: previous.notice } : fact.notice
            ? { notice: { cursor, message: fact.notice } } : {}) });
        break;
      }
      case 'command_limit': {
        const key = keyOf(fact.key), reservation = reservations.get(key);
        if (!reservation || !reservationOpen(reservation)) return bad('conflict', 'A time limit requires an open command reservation');
        const limits = rows<number>(db, journal.root, 'command_limit', cursor);
        limits.set(key, cursor);
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
        hostClosure = fact.receipt.detail;
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
      case 'held_measured':
        if (reclaimed || !heldSpace || heldSpace.ending !== fact.ending)
          return bad('conflict', 'Held measurement lacks its outstanding ending request');
        if (heldSpace.bytes !== undefined && heldSpace.bytes !== fact.bytes)
          return bad('conflict', 'Held measurement is immutable');
        heldSpace = { ...heldSpace, bytes: fact.bytes };
        break;
      case 'delivery_preserved':
        delivery = { at: fact.at, delivery: fact.delivery };
        break;
      case 'reclaim_completed':
      case 'run_reclaimed':
        if (fact.type === 'run_reclaimed') delivery = { at: fact.at, delivery: fact.delivery };
        if (!delivery) return bad('conflict', 'Cleanup completion requires a durable delivery');
        ({ reclaimed, heldSpace } = completedCurrent(delivery));
        // Reclaim retires only recorded admission/writer epochs; owned claims retire by exact epoch in release().
        for (const row of db.prepare(`SELECT id,owner,epoch FROM resources WHERE holder=? AND owner IS NULL
          AND ((? AND id LIKE 'operation:%') OR (id LIKE 'plan:%' AND epoch='admitted') OR epoch IN (SELECT epoch FROM epochs WHERE root=?))`)
          .all(journal.root, launch ? 0 : 1, journal.root)) {
          db.prepare('UPDATE epochs SET active=0 WHERE root=? AND epoch=?').run(journal.root, row.epoch);
          db.prepare('DELETE FROM resources WHERE id=? AND holder=? AND epoch=? AND owner IS ?')
            .run(row.id, journal.root, row.epoch, row.owner);
        }
        break;
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
          || intervals.values().some(i => intervalOpen(i) && owners.get(ownerOf(i.owner))?.state !== 'dead'
            && !rows(db, journal.root, 'closed_owner').has(ownerOf(i.owner)))
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
    if (fact.type === 'attempt_received' || fact.type === 'attempt_settled')
      for (const guide of fact.receipt.guidance ?? []) rows<GuideDelivery>(db,journal.root,'guide_delivery',cursor)
        .set(guide,{guide,invocation:fact.receipt.address});
    // One projection owner for control closure and cleanup attention. The fence only grows.
    if (ending) {
      if (terminal(ending.status)) fenced = true;
      status = ending.status; conclusion = ending;
      if (!['running', 'parked'].includes(status)) currentStage = null;
    }
    if (!endingAt && (ending && isFinal(status) || fact.type === 'preparation_ended')) {
      endingAt = event.at;
      endingWriter = fact.type === 'control_intent' || fact.type === 'preparation_ended' ? 'control' : 'execution';
    }
    timeline = projectTimeline(timeline, event, status, stageStates, checkpoints, plan);
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
  const value: Current = { preparation: saved.value.preparation, preparationReason, heldSpace, delivery, timeline, reclaimed, hostClosure, stepStartedAt: currentStage === null ? null : stepStartedAt, backstop, launch, plan, setup, authority, status, statusSince, conclusion, currentStage, restoring, fenced };
  endCurrent(value, endingWriter, cursor, endingAt);
  db.prepare('UPDATE runs SET cursor=?,current=? WHERE root=?').run(cursor, encode(value), journal.root);
  return valid(cursor);
}

/** Create only the addressed run directory; its SQL row and all facts use the installation database. */
export function openJournal(location: RunLocation, mode: 'create', preparation?: import('../contract/runtime.js').Preparation): Promise<CreationResult>;
export function openJournal(location: RunLocation, mode: 'read'): Promise<Result<Journal>>;
export async function openJournal(location: RunLocation, mode: 'create' | 'read', preparation?: import('../contract/runtime.js').Preparation): Promise<Result<Journal> | CreationResult> {
  let creation: Creation = { state: 'not_attempted' };
  const outcome = (result: Result<Journal>) => mode === 'read' ? result : { ...result, creation };
  const addressed = journalAddress(location); if (!addressed.ok) return outcome(addressed);
  if (!['create', 'read'].includes(mode)) return outcome(invalid('Invalid journal mode'));
  const journal = addressed.value;
  try {
    if (mode === 'create') {
      let madeDirectory = false, inserted = false;
      const result = withState(journal.database, true, db => {
        // Discoverability needs only the durable private directory; recorded construction follows COMMIT.
        mkdirSync(location.storeRoot, { recursive: true });
        if (realpathSync(location.storeRoot) !== location.storeRoot) return invalid('Aliased store');
        mkdirSync(dirname(journal.root), { recursive: true });
        if (realpathSync(dirname(journal.root)) !== dirname(journal.root)) return invalid('Aliased runs root');
        try { mkdirSync(journal.root); madeDirectory = true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          creation = { state: 'rejected_or_aborted' };
          return bad('conflict', 'Run already exists');
        }
        const directory = openSync(journal.root, constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
        const parent = openSync(dirname(journal.root), constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(parent); } finally { closeSync(parent); }
        creation = { state: 'indeterminate', location };
        try {
          db.prepare('INSERT INTO runs(root,store,name,current) VALUES(?,?,?,?)').run(journal.root, location.storeRoot, location.run,
            encode(preparation ? { ...emptyCurrent(), preparation, status: 'preparing' } : emptyCurrent()));
          inserted = true;
        } catch (error) {
          if ([2067, 1555].includes((error as { errcode?: number }).errcode!)) {
            creation = { state: 'rejected_or_aborted' };
            return bad('conflict', 'Run already exists');
          }
          throw error;
        }
        return valid(journal);
      });
      if (!result.ok && !result.commitIssued && !result.unsettled && 'location' in creation)
        creation = { state: 'rejected_or_aborted' };
      if (inserted && (result.ok || result.commitIssued || result.unsettled)) {
        creation = { state: 'indeterminate', location };
        const observed = withState(journal.database, false, db => valid(!!db.prepare(
          'SELECT 1 FROM runs WHERE root=? AND store=? AND name=?').get(journal.root, location.storeRoot, location.run)));
        if (observed.ok && observed.value) creation = { state: 'confirmed', location };
        if (result.ok && creation.state !== 'confirmed') return outcome(bad('unknown',
          observed.ok ? 'Created run could not be confirmed' : `Created run could not be confirmed: ${observed.detail}`));
      }
      // An unconfirmed creation is unknown whatever SQLite reported; the cause stays in the detail.
      if (!result.ok && creation.state === 'indeterminate') return outcome(bad('unknown', result.detail));
      if (!result.ok && madeDirectory && !('location' in creation))
        rmSync(journal.root, { recursive: true, force: true });
      return outcome(result);
    }
    // Reading a run that does not exist (no store, or no run directory) is invalid input: the operator named it.
    let store: string, root: string;
    try { store = realpathSync(location.storeRoot); root = realpathSync(journal.root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return invalid(`No run ${location.run} in this store`);
      throw error;
    }
    if (store !== location.storeRoot) return invalid('Aliased store');
    if (root !== journal.root) return invalid('Aliased run root');
    return withState(journal.database, false, db => current(db, journal) ? valid(journal) : bad('unavailable', 'Run state unavailable'));
  } catch (error) { return outcome(databaseFailure(error)); }
}
function journalAddress(location: RunLocation): Result<Journal> {
  if (!idSchema.safeParse(location.run).success || !isAbsolute(location.storeRoot) || resolve(location.storeRoot) !== location.storeRoot
    || !isAbsolute(location.database) || resolve(location.database) !== location.database) return invalid('Invalid run location');
  return valid({ root: join(location.storeRoot, 'runs', location.run), database: location.database });
}
/** Return this attempt's receipt even when creation cannot be confirmed. */
export async function createPreparation(location: RunLocation, preparation: import('../contract/runtime.js').Preparation): Promise<CreationResult> {
  const notAttempted = (result: Result<Journal>): CreationResult => ({ ...result, creation: { state: 'not_attempted' } });
  const addressed = journalAddress(location); if (!addressed.ok) return notAttempted(addressed);
  try {
    mkdirSync(dirname(location.database), { recursive: true });
    const ready = initializeState(location.database);
    return ready.ok ? await openJournal(location, 'create', preparation) : notAttempted(ready);
  } catch (error) { return notAttempted(databaseFailure(error)); }
}
/** Setup owns its ending; controls hold the existing control claim before calling this owner. */
export async function endPreparation(writer: Writer, state: 'refused' | 'cancelled', detail: string): Promise<Result<number>> {
  const ended = await appendEvents(writer, null, [{ type: 'preparation_ended', state, detail }]);
  if (ended.ok) await recordHeldBytes(writer);
  return ended;
}
/** The ending writer consumes the reducer's request after capture/closure, outside installation write ownership. */
export async function recordHeldBytes(writer: Writer): Promise<void> {
  const pending = withState(writer.journal.database, false, db => {
    const saved = current(db, writer.journal); if (!saved) return bad('unavailable', 'Run state unavailable');
    return valid(saved.value);
  });
  if (!pending.ok) { process.stderr.write(`Held measurement unavailable: ${pending.detail}\n`); return; }
  const { heldSpace, launch } = pending.value;
  if (!heldSpace || heldSpace.bytes !== undefined || writer.kind === 'execution' && heldSpace.writer === 'control') return;
  try {
    const run = basename(writer.journal.root), store = dirname(dirname(writer.journal.root));
    const measured = await recordOperation<number>(writer.journal, 'construct', { module: new URL('./held.js', import.meta.url).href,
      method: 'measureHeldBytes', args: [store, run, launch] });
    if (!measured.ok) throw Error(measured.detail);
    const recorded = await appendEvents(writer, null, [{ type: 'held_measured', ending: heldSpace.ending, bytes: measured.value }]);
    if (!recorded.ok) throw Error(recorded.detail);
  } catch (error) { process.stderr.write(`Held measurement unavailable for ${basename(writer.journal.root)}: ${String(error)}; repeat cancel or land\n`); }
}
/** Read the preparation owner without requiring an admitted launch or a runtime pin. */
export function readPreparation(journal: Journal): Result<import('../contract/runtime.js').PreparationState | null> {
  return withState(journal.database, false, db => {
    const saved = current(db, journal); if (!saved) return bad('unavailable', 'Run state unavailable');
    const { preparation, status, preparationReason: reason, reclaimed, delivery, launch } = saved.value;
    return valid(preparation ? { preparation, status, admitted: !!launch, ...(saved.value.setup ? { unit: saved.value.setup.unit } : {}), ...(reason === undefined ? {} : { reason }),
      ...(reclaimed ? { reclaimed } : {}), ...(delivery ? { delivery } : {}) } : null);
  });
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
export async function appendEvents(writer: Writer, expectedCursor: number | null, payloads: readonly JournalPayload[]): Promise<Result<number> & { readonly staleCursor?: true }> {
  if (expectedCursor !== null && (!Number.isSafeInteger(expectedCursor) || expectedCursor < 0) || !Array.isArray(payloads) ||
    !payloads.length) return invalid('Expected cursor and nonempty transaction');
  const frozen = structuredClone(payloads), run = basename(writer.journal.root);
  for (const payload of frozen) {
    if (!payloadValid(payload, run)) return invalid('Invalid journal payload');
    if (payload.type === 'command') for (const ref of commandRefs(payload.receipt)) { const result = await validateRecordRef(writer.journal,
      ref); if (!result.ok) return result; }
  }
  return withState(writer.journal.database, true, db => appendTransaction(db, writer, expectedCursor, frozen));
}
/** The sole event writer, also used by resource retirement inside its atomic SQL transaction. */
function appendTransaction(db: DatabaseSync, writer: Writer, expectedCursor: number | null, payloads: readonly JournalPayload[])
  : Result<number> & { readonly staleCursor?: true } {
  const run = basename(writer.journal.root);
  const saved = current(db, writer.journal); if (!saved) return bad('unavailable', 'Run state unavailable');
  const epoch = db.prepare('SELECT owner FROM epochs WHERE root=? AND kind=? AND epoch=? AND active=1').get(writer.journal.root, writer.kind,
    writer.epoch);
  if (!epoch || !equal(decode(epoch.owner), writer.owner)) return bad('conflict', 'Stale writer epoch');
  if (!db.prepare('SELECT 1 FROM resources WHERE holder=? AND epoch=? AND owner=?').get(writer.journal.root, writer.epoch,
    encode(writer.owner))) return bad('conflict', 'Writer claim is no longer held');
  if (expectedCursor !== null && saved.cursor !== expectedCursor) return { ok: false, kind: 'conflict', detail: 'Stale expected cursor', staleCursor: true };
  const executionOnly = new Set(['invocation_reserved', 'command_reserved', 'stage_settled', 'gate_transition', 'outcome_settled',
    'backstop_reconstructed', 'checkpoint_materialized']);
  for (const payload of payloads) if (writer.kind === 'execution' && ['control_intent', 'control_settled', 'admitted'].includes(payload.type) ||
    writer.kind === 'control' && executionOnly.has(payload.type)) return bad('conflict', 'Wrong writer kind');
  const at = new Date().toISOString();
  return transition(db, writer.journal, payloads.map((payload, index) => ({ seq: saved.cursor + index + 1, run, at, payload })));
}

export async function readEvents(journal: Journal, afterCursor: number): Promise<Result<readonly JournalEvent[]>> {
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) return invalid('Invalid exclusive cursor');
  return withState(journal.database, false, db => {
    const saved = current(db, journal); if (!saved) return bad('unavailable', 'Run state unavailable');
    if (afterCursor > saved.cursor) return invalid('Cursor beyond journal');
    return valid(db.prepare('SELECT seq,at,payload FROM events WHERE root=? AND seq>? ORDER BY seq').all(journal.root, afterCursor).map(row => ({
      seq: Number(row.seq), at: String(row.at), run: basename(journal.root), payload: ignoreRetired(decode<JournalPayload>(row.payload), 'journalPayload') as JournalPayload })));
  });
}
export async function readProjection(journal: Journal): Promise<Result<RunProjection>> {
  return withState(journal.database, false, db => {
    const saved = current(db, journal); if (!saved) return bad('unavailable', 'Run state unavailable');
    const { launch, plan, authority, ...state } = saved.value;
    if (!backstopSchema.safeParse(state.backstop).success) return bad('unknown', 'Canonical C2 history must be reconstructed before continuation');
    if (!launch || !plan) return bad('unavailable', 'Run is not atomically admitted with a plan');
    const list = <T>(kind: string) => rows<T>(db, journal.root, kind).values();
    // The acceptance record binds the last delivery receipt before its lifecycle transition.
    const accepted = ['complete', 'accepted_blocked'].includes(state.status) ? db.prepare(
      "SELECT value FROM current_rows WHERE root=? AND kind='output' AND ordinal<? ORDER BY ordinal DESC LIMIT 1")
      .get(journal.root, state.statusSince) : undefined;
    const reviewed = accepted ? decode<OutputReceipt>(accepted.value).artifacts : undefined;
    return valid({
      run: basename(journal.root), cursor: saved.cursor, launch, brief: launch.brief, plan,
      ...(state.timeline ? {timeline:state.timeline} : {}),
      backstop: state.backstop, status: state.status, statusSince: state.statusSince,
      currentStage: state.currentStage, restoring: state.restoring,
      ...(state.reclaimed ? { reclaimed: state.reclaimed } : {}),
      ...(state.delivery ? { delivery: state.delivery } : {}),
      ...(state.conclusion ? { conclusion: state.conclusion } : {}), ...(authority ? { authority: authority.authority } : {}),
      ...ignoreRetired({
        guideDeliveries:list<GuideDelivery>('guide_delivery'),
        received: list<AttemptReceipt>('received'),
        stageStates: list<StageState>('stage'), transitions: list<GateTransition>('transition'), revisions: list<AdmittedPlan>('revision'),
        obligations: list<RunObligation>('obligation'), closedInvocations: list<Invocation>('closed_invocation'),
        closedOwners: list<Owner>('closed_owner'),
        reservations: list<Reservation>('reservation'), intervals: list<ActiveInterval>('interval'), intents: list<ControlIntent>('intent'),
        lineage: db.prepare("SELECT kind,value FROM current_rows WHERE root=? AND kind IN ('command','checkpoint') ORDER BY ordinal,key")
          .all(journal.root).map(row => row.kind === 'command' ? { kind: 'command' as const, receipt: decode<CommandReceipt>(row.value) }
            : { kind: 'checkpoint' as const, checkpoint: decode<Checkpoint>(row.value) }),
        operations: list<Operation>('operation'), attempts: list<AttemptReceipt>('attempt'), commands: list<CommandReceipt>('command'),
        invocations: list<Invocation>('invocation'), owners: list<{ owner: Owner; state: OwnerState }>('owner'),
        checkpoints: list<Checkpoint>('checkpoint'), outputs: list<OutputReceipt>('output').map(receipt => {
          const disposition = reviewed && equal(reviewed, receipt.artifacts) ? 'reviewed' : 'unreviewed';
          return { ...receipt, disposition, detail: [disposition === 'reviewed' ? 'Reviewed accepted delivery'
            : 'Unreviewed retained observation', receipt.detail].filter(Boolean).join('\n') };
        })
      }, 'projection')
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
/** Run discovery belongs to durable journal rows; private evidence construction need not have completed. */
export function listRuns(storeRoot: string, database: string): Result<readonly string[]> {
  const selected = withState(database, false,
    db => valid(db.prepare('SELECT name FROM runs WHERE store=? ORDER BY name').all(storeRoot).map(row => String(row.name))));
  return !selected.ok && selected.kind === 'unavailable' ? valid([]) : selected;
}
export async function listProjections(storeRoot: string, database: string): Promise<Result<readonly { location: RunLocation;
  projection: Result<RunProjection> }[]>> {
  const selected = listRuns(storeRoot, database);
  if (!selected.ok) return selected;
  const out = [];
  for (const run of selected.value) { const location = { storeRoot, database, run }; const opened = await openJournal(location, 'read');
    out.push({ location, projection: opened.ok ? await readProjection(opened.value) : opened }); }
  return valid(out);
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
    const released = await release(held); if (!released.ok) return released;
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
  let parent = resource.path; const suffix: string[] = [];
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
        `Resource ${extent.path} is held by run ${basename(String(row.holder))} (${row.path}); confirmed execution closure and retained external bytes release it. Use flowcrew cancel ${basename(String(row.holder))} to reconcile closure; private workspace/record extents are freed by flowcrew land`);
  }
  return valid(true);
}
/** The same canonical extents used by record destinations are admitted in the state transaction before provisioning. */
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
    if (prior?.owner) db.prepare('UPDATE epochs SET active=0 WHERE root=? AND epoch=? AND owner=?')
      .run(scope.holder, prior.epoch, prior.owner);
    db.prepare('INSERT OR REPLACE INTO resources VALUES(?,?,?,?,?,?,?,?)').run(id, scope.holder, extent.path, extent.access, extent.inode,
      encode(owner), unit ? encode(unit) : null, epoch);
    return valid({ resource: extent.path, owner, epoch, unit, ...scope });
  });
  if (!acquired.ok) await endOperation(owner);
  return acquired;
}
function releaseMode(state: Current | undefined, claim: Claim): 'retire' | 'handoff' {
  return state?.reclaimed || claim.unit === null ? 'retire' : 'handoff';
}
/** Closure is observed before the short exact-epoch retirement transaction. */
export async function release(claim: Claim): Promise<Result<OwnerState>> {
  if (!claim || !ownerSchema.safeParse(claim.owner).success || !idSchema.safeParse(claim.epoch).success) return invalid('Invalid release');
  const closed = await endOperation(claim.owner); if (!closed.ok) return closed;
  return withState(claim.database, true, db => {
    const id = 'operation:' + claim.holder + ':' + claim.resource, prior = db.prepare('SELECT owner,epoch FROM resources WHERE id=?').get(id);
    if (!prior || prior.epoch !== claim.epoch || !equal(decode(prior.owner), claim.owner)) return bad('conflict', 'Stale claim epoch');
    db.prepare('UPDATE epochs SET active=0 WHERE root=? AND epoch=?').run(claim.holder, claim.epoch);
    if (releaseMode(current(db, { root: claim.holder, database: claim.database })?.value, claim) === 'handoff')
      db.prepare('UPDATE resources SET owner=NULL WHERE id=?').run(id);
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

/** Recorded retirement survives an unknown direct exit; interval accounting and probes cannot establish it. */
export function ownerRecordedClosed(projection: Pick<RunProjection, 'closedOwners'>, owner: Owner): boolean {
  return projection.closedOwners.some(closed => equal(closed, owner));
}

/** Output quiescence for snapshots and publication, even while the run's unit is active. */
export async function readClosure(journal: Journal, retained: readonly Owner[] = []): Promise<Result<true>> {
  const projection = await readProjection(journal); if (!projection.ok) return projection;
  for (const entry of projection.value.owners) {
    if (ownerRecordedClosed(projection.value, entry.owner) || retained.some(owner => equal(owner, entry.owner))) continue;
    const state = await probeOwner(entry.owner);
    if (state === 'unknown') return bad('unknown', 'Descendant owner is unknown');
    if (state === 'live') return bad('conflict', 'A descendant is live');
    return bad('conflict', 'Invocation owner has not retired under its recorded closure guarantee');
  }
  return valid(true);
}
/** Capture and reservation retirement share the event writer's claim checks and one atomic SQL transaction. */
export async function releaseRunResources(writer: Writer, reconciled: { cursor: number; retained: readonly Claim[] }): Promise<Result<true>> {
  const { journal } = writer;
  const before = withState(journal.database, false, db => {
    const saved = current(db, journal)!;
    if (saved.cursor !== reconciled.cursor) return bad('conflict', 'Run changed during execution resource retirement');
    const held = db.prepare("SELECT * FROM resources WHERE holder=? AND id LIKE 'plan:%'").all(journal.root);
    const operations = db.prepare("SELECT * FROM resources WHERE holder=? AND id LIKE 'operation:%' ORDER BY id").all(journal.root);
    const external = saved.value.authority?.authority.outputs.filter(output => output.write === 'exact'
      && held.some(row => row.path === output.absolute)) ?? [];
    return valid({saved, held, external, operations});
  });
  if (!before.ok) return before;
  const {saved, held, external, operations} = before.value;
  if (!isFinal(saved.value.status)) return valid(true);
  // Private workspace and record extents remain protected for maintenance until reclaim.
  const retiring = held.filter(row => external.some(output =>
    row.path === output.absolute));
  if (!retiring.length) return valid(true);
  const capture = await recordOperation<OutputReceipt>(journal, 'construct', {
    module: new URL('./content.js', import.meta.url).href, method: 'captureExecutionOutputs', args: [journal, external]
  });
  if (!capture.ok) return capture;
  return withState(journal.database, true, db => {
    const fresh = current(db, journal);
    if (!fresh || fresh.cursor !== reconciled.cursor
      || !equal(operations, db.prepare("SELECT * FROM resources WHERE holder=? AND id LIKE 'operation:%' ORDER BY id").all(journal.root))
      || reconciled.retained.some(claim => !operations.some(row => row.epoch === claim.epoch && row.owner === encode(claim.owner))))
      return bad('conflict', 'Run changed during execution resource retirement');
    const appended = appendTransaction(db, writer, reconciled.cursor, [{ type: 'outputs_preserved', receipt: capture.value }]);
    if (!appended.ok) return appended;
    for (const row of retiring) {
      const removed = db.prepare('DELETE FROM resources WHERE id=? AND holder=? AND epoch=? AND owner IS ?')
        .run(row.id, journal.root, row.epoch, row.owner);
      if (Number(removed.changes) !== 1) return bad('conflict', 'Execution resource epoch changed');
    }
    return valid(true);
  });
}

/** Retain existing event timestamps and definition ownership in the same projection transaction.
 * Disposition is copied from stageStates, never re-decided by timing. */
function projectTimeline(previous: import('../contract/runtime.js').RunTimeline | undefined, event: JournalEvent,
  status: RunStatus, stageStates: ReturnType<typeof rows<StageState>>, checkpoints: ReturnType<typeof rows<Checkpoint>>, plan?: AdmittedPlan): import('../contract/runtime.js').RunTimeline {
  // Match the journal's JSON representation before comparing persisted definitions.
  const fact = decode<JournalPayload>(encode(event.payload));
  let stages = [...(previous?.stages ?? [])];
  const admitted = fact.type === 'plan_committed' ? fact.plan : plan;
  if (fact.type === 'plan_committed') {
    const definitions = admitted!.plan.stages;
    stages = stages.map(row => !row.replacedBy && !definitions.some(stage => equal(stage,row.definition))
      ? {...row,replacedBy:fact.plan.revision} : row);
  }
  for (const definition of admitted?.plan.stages ?? []) if (!stages.some(row => !row.replacedBy && equal(row.definition,definition)))
    stages.push({definition,revision:admitted!.revision,state:'pending',startedAt:null,settledAt:null,segments:[]});
  stages = stages.map(row => {
    const address = fact.type === 'invocation_reserved' ? fact.invocation.address
      : fact.type === 'attempt_settled' ? fact.receipt.address : null;
    const addressed = address && 'stage' in address && address.stage === row.definition.id;
    let segments = [...row.segments], state = row.state, startedAt = row.startedAt, settledAt = row.settledAt;
    if (!row.replacedBy && addressed && fact.type === 'invocation_reserved' && fact.invocation.charge !== 'command'
      && fact.invocation.address.kind === 'stage') {
      const a = fact.invocation.address;
      segments.push({kind:'attempt',attempt:a.attempt,invocation:a.invocation,startedAt:event.at,endedAt:null});
      startedAt ??= event.at; state = stageStates.get(row.definition.id)!.state; settledAt = null;
    }
    if (addressed && fact.type === 'attempt_settled') {
      const a = fact.receipt.address;
      segments = segments.map(part => part.kind === 'attempt' && part.attempt === a.attempt && part.invocation === a.invocation
        ? {...part,endedAt:event.at,ending:fact.receipt.ending} : part);
    }
    if (!row.replacedBy && fact.type === 'stage_settled' && fact.stage === row.definition.id && nextLifecycle(status,'run') !== null) {
      state = stageStates.get(row.definition.id)!.state;
      if (state === 'running') startedAt ??= event.at;
      if (state === 'settled' || state === 'skipped') settledAt = event.at;
    }
    if (!row.replacedBy && state !== 'settled' && state !== 'skipped' && segments.length
      && status === 'parked' && previous?.stages.some(old => old === row)
      && !segments.some(part => part.kind === 'pause' && part.endedAt === null))
      segments.push({kind:'pause',startedAt:event.at,endedAt:null});
    if (status !== 'parked') segments = segments.map(part => part.kind === 'pause' && part.endedAt === null
      ? {...part,endedAt:event.at} : part);
    return {...row,state,startedAt,settledAt,segments};
  });
  return {...(fact.type === 'admitted' ? {checkpoints:{count:0,latestAt:null}}
      : fact.type === 'checkpoint' && fact.checkpoint.state === 'safe'
      ? {checkpoints:{count:checkpoints.values().filter(item => item.state === 'safe').length,latestAt:event.at}}
      : previous?.checkpoints ? {checkpoints:previous.checkpoints} : {}),
    ...(fact.type === 'lifecycle' && fact.conclusion.status === 'parked' && fact.conclusion.reason === 'backstop'
      ? {backstopAt:event.at} : previous?.backstopAt ? {backstopAt:previous.backstopAt} : {}),
    ...(previous?.startedAt ? {startedAt:previous.startedAt} : fact.type === 'admitted' ? {startedAt:event.at} : {}),lastActivityAt:event.at,
    ...(previous?.endedAt ? {endedAt:previous.endedAt} : {}),stages};
}

/** Definition-local journal disposition and distinct attempts; presentation belongs to status.mjs. */
function projectStages(db: DatabaseSync, journal: Journal, state: Current, revisions: readonly AdmittedPlan[], invocations: readonly Invocation[],
  attempts: readonly AttemptReceipt[]) {
  const states = new Map(rows<StageState>(db, journal.root, 'stage').values().map(item => [item.stage,item.state]));
  const history = state.timeline?.stages;
  const definitions: import('../contract/runtime.js').StageHistory[] = history ? [...history] : [];
  for (let index = 0; index < revisions.length; index++) {
    const revision = revisions[index];
    for (const definition of revision.plan.stages) if (!definitions.some(row => equal(row.definition,definition))) {
      const replacement = revisions.slice(index+1).find(next => !next.plan.stages.some(stage => equal(stage,definition)));
      definitions.push({definition,revision:revision.revision,...(replacement ? {replacedBy:replacement.revision} : {}),
        state:states.get(definition.id) ?? 'pending',startedAt:null,settledAt:null,segments:[]});
    }
  }
  const lastInvocation = invocations.filter(item => item.address.kind === 'stage' && item.charge !== 'command').at(-1);
  /** A stage's commands belong to its own latest attempt, whatever charge made the latest invocation (a gate in its command phase has only commands). */
  const latestAttempt = (stage: Id) => invocations.filter(item => item.address.kind === 'stage' && item.address.stage === stage)
    .map(item => (item.address as { attempt: Id }).attempt).at(-1);
  const reservations = rows<Reservation>(db,journal.root,'reservation').values();
  // Older projections retain outcomes and measured controller intervals, but no per-call timestamps.
  // Ordinals order calls and attribute gaps between measured intervals to their last stage; ambiguous definitions stay omitted.
  const projectedSegments = new Map<string, StageSegment[]>();
  const facts = db.prepare("SELECT kind,ordinal,value FROM current_rows WHERE root=? AND kind IN ('invocation','interval') ORDER BY ordinal,key")
    .all(journal.root);
  let previous: ActiveInterval | undefined, lastStage: string | undefined;
  for (const fact of facts) {
    if (fact.kind === 'interval') {
      const interval = decode<ActiveInterval>(fact.value);
      if (lastStage && previous?.spentMs !== null && previous?.spentMs !== undefined) {
        const startedAt = new Date(Date.parse(previous.openedAt)+previous.spentMs).toISOString();
        if (Date.parse(interval.openedAt) > Date.parse(startedAt))
          projectedSegments.get(lastStage)?.push({kind:'pause',startedAt,endedAt:interval.openedAt});
      }
      previous = interval;
    } else {
      const call = decode<Invocation>(fact.value), address = call.address;
      if (address.kind !== 'stage') continue;
      lastStage = address.stage;
      if (call.charge === 'command') continue;
      const receipt = attempts.find(item => equal(item.address,{run:address.run,stage:address.stage,attempt:address.attempt,invocation:address.invocation}));
      projectedSegments.set(address.stage,[...(projectedSegments.get(address.stage) ?? []),
        {kind:'attempt',attempt:address.attempt,invocation:address.invocation,startedAt:null,endedAt:null,
          ...(receipt ? {ending:receipt.ending} : {})}]);
    }
  }
  const ordered = [...(state.plan?.plan.stages ?? []).flatMap(stage => definitions.filter(row => !row.replacedBy && equal(row.definition,stage))),
    ...definitions.filter(row => row.replacedBy)];
  const stages = ordered.map<import('../contract/runtime.js').RunStageStatus>(row => {
    const stage = row.definition;
    // Legacy projections cannot attribute a reused id to a definition; omit ambiguous history.
    const unique = definitions.filter(other => other.definition.id === stage.id).length === 1;
    const recorded = history?.includes(row);
    const calls = unique ? invocations.flatMap(item =>
      item.charge !== 'command' && item.address.kind === 'stage' && item.address.stage === stage.id ? [item.address] : [])
      : row.segments.filter(part => part.kind === 'attempt');
    const receipts = attempts.filter(item => item.address.stage === stage.id && (recorded && !unique ? calls.some(call =>
      call.attempt === item.address.attempt && call.invocation === item.address.invocation) : unique));
    // Current-row order and outcomes are general; retained timing refines those same facts.
    // Prefer the recorded pause boundary over the enclosing controller gap when both exist.
    const matches = (part: StageSegment, retained: StageSegment) => retained.kind === part.kind && (part.kind === 'attempt'
      ? retained.attempt === part.attempt && retained.invocation === part.invocation
      : part.startedAt !== null && retained.startedAt !== null
        && (part.endedAt === null || Date.parse(retained.startedAt) < Date.parse(part.endedAt))
        && (retained.endedAt === null || Date.parse(retained.endedAt) > Date.parse(part.startedAt)));
    const segments = [...row.segments], projected = unique ? projectedSegments.get(stage.id) ?? [] : [];
    for (let index = 0; index < projected.length; index++) {
      const part = projected[index];
      if (segments.some(retained => matches(part,retained))) continue;
      const following = projected.slice(index+1).map(next => segments.findIndex(retained => matches(next,retained))).find(index => index >= 0);
      segments.splice(following ?? segments.length,0,part);
    }
    const last = receipts.at(-1), raw = row.replacedBy && recorded ? row.state : states.get(stage.id) ?? row.state;
    const answer = last?.answer;
    const summary = answer?.kind === 'work' ? answer.answer.summary : answer?.kind === 'gate' ? answer.answer.reason : undefined;
    const reused = new Map((calls.at(-1)?.attempt === last?.address.attempt ? last?.reusedCommands ?? [] : []).map(item => [item.receipt.command,item]));
    const progress = !row.replacedBy && stage.purpose === 'gate' ? [...new Set([...(stage.commands ?? []),...reused.keys()])].map(command => {
      const reservation = reservations.filter(item => item.identity === command && item.invocation.address.kind === 'stage'
        && item.invocation.address.stage === stage.id && item.invocation.address.attempt === latestAttempt(stage.id)
      ).at(-1);
      return {command,reservation};
    }) : undefined;
    return {id:stage.id,purpose:stage.purpose,role:stage.role,after:stage.after,
      ...('instruction' in stage ? {goal:stage.instruction.split(/\r?\n/,1)[0].slice(0,160),instruction:stage.instruction} : {}),
      commands:stage.commands ?? [],revision:row.revision,
      ...(row.replacedBy ? {replacedBy:row.replacedBy} : {}),
      state:raw,
      attempts:new Set(calls.map(call => call.attempt)).size,
      lastEnding:last?.ending ?? null,verdict:answer?.kind === 'gate' ? answer.answer.outcome : null,
      startedAt:row.startedAt,settledAt:row.settledAt,...(summary === undefined ? {} : {summary}),
      segments,
      ...(progress ? {commandProgress:progress.map(({command,reservation}) => {
        const evidence = reused.get(command);
        const receipt = evidence?.receipt ?? (reservation?.state === 'committed' ? reservation.receipt : undefined);
        const execution = receipt?.execution, basis = receipt && commandBasis(receipt);
        return {command,...(evidence ? commandEvidenceLabel(evidence,last!.address) : {}),...(basis ? {basis} : {}),
          state:execution ? execution.state !== 'complete' ? 'unfinished' : execution.exit === 0 ? 'passed' : 'failed'
            : !reservation ? 'not_started' : reservationOpen(reservation) ? 'running' : 'unfinished'};
      })} : {})
    };
  });
  return {stages,focus:stageFocus(state,stages,lastInvocation?.address.kind === 'stage' ? lastInvocation.address.stage : null)};
}

/** The only focus decision, from journal facts; availability never changes this published answer. */
function stageFocus(state: Current, stages: readonly import('../contract/runtime.js').RunStageStatus[], lastInvokedStage: Id | null): Id | null {
  const rows = stages.filter(stage => !stage.replacedBy);
  const pause = state.status === 'parked' ? rows.find(stage => stage.id === lastInvokedStage && !['settled','skipped'].includes(stage.state)) : undefined;
  return (['running','parked'].includes(state.status) ? state.currentStage ?? pause?.id : null)
    ?? rows.find(stageNeedsCorrection)?.id ?? null;
}

/** Current semantic read model on the export owner's private connection. No journal replay, native work or nested transaction. */
export function statusView(db: DatabaseSync, journal: Journal, publishedAt: string, activeElapsedMs: number | null)
  : Result<import('../contract/runtime.js').RunStatusFile> {
  const saved = current(db, journal);
  if (!saved) return bad('unavailable', 'Run state unavailable');
  const state = saved.value, setup = state.setup?.measured ?? state.launch?.setup
    ?? (state.preparation ? { project: state.preparation.project, interpretation: [] } : undefined);
  const brief = state.launch?.brief ?? state.setup?.request.brief ?? state.preparation?.brief;
  const identity = state.launch?.unit ?? state.setup?.unit ?? (state.preparation ? { run: basename(journal.root), authority: state.preparation.authority } : undefined);
  if (!setup || !brief || !identity) return bad('unavailable', 'Run preparation unavailable');
  const title = brief.declaration.title ?? brief.declaration.body.split(/\r?\n/).find(line => line.startsWith('# '))?.slice(2);
  // The status view reads the revision rows once and retires them once, the way `readProjection` does for `projection.revisions`.
  const revisions = ignoreRetired({ revisions: rows<AdmittedPlan>(db, journal.root, 'revision').values() }, 'projection').revisions as readonly AdmittedPlan[];
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
  const invocations = rows<Invocation>(db, journal.root, 'invocation').values();
  const {stages,focus} = projectStages(db,journal,state,revisions,invocations,attempts);
  const invocation = invocations.filter(item => item.address.kind === 'stage' && item.address.stage === state.currentStage).at(-1), address = invocation?.address;
  const stage = stages.find(row => !row.replacedBy && row.id === state.currentStage);
  const initial = revisions[0];
  const generated = !state.launch?.plan && initial?.plan.stages.length === 1 && initial.plan.stages[0].id === state.currentStage;
  const stageLabel = state.currentStage === null ? null : generated && stage ? `${stage.purpose} (${stage.role})` : state.currentStage;
  const attempt = address?.kind === 'stage' ? address.attempt : null;
  // All commands of an attempt share one invocation address, so the running command is the open reservation, not the first match.
  const command = invocation?.charge === 'command' ? rows<Reservation>(db, journal.root, 'reservation').values()
    .find(item => reservationOpen(item) && equal(item.invocation, invocation)) : undefined;
  // The running command's limit fact, raised once by the engine when `durationMs` passed; it is attention until the command's receipt closes the reservation.
  const limitedAt = state.status === 'running' && command ? rows<number>(db, journal.root, 'command_limit').get(keyOf(command.key)) : undefined;
  const limit = limitedAt !== undefined && command ? { reason: 'command_limit' as const, cursor: limitedAt, condition: null,
    detail: `command ${command.identity} passed its time limit (${brief.declaration.commands.find(item => item.id === command.identity)?.durationMs ?? 'declared'} ms) and is still running; `
      + `leave it to finish, or flowcrew cancel ${basename(journal.root)} to stop it with its receipt, streams and outputs kept` } : undefined;
  const label = command ? `Command ${command.identity}` : stage && address?.kind === 'stage'
    ? `${stage.purpose === 'work' ? 'author' : stage.purpose} · attempt ${stage.attempts}`
      + (address.invocation > 1 ? ` · ${invocation?.charge} ${address.invocation}` : '') : null;
  const gates = rows<{gate:import('../contract/runtime.js').RunStatusFile['gates'][number]}>(db,journal.root,'status_gate').values().map(row=>row.gate);
  const pending = state.plan ? {...state.plan.plan,stages:state.plan.plan.stages.filter(stage =>
    !stages.some(item => !item.replacedBy && item.id === stage.id && ['settled','skipped'].includes(item.state)))} : undefined;
  const held = state.heldSpace?.bytes;
  return parseRunStatusFile({...(state.reclaimed ? { reclaimed: state.reclaimed } : {}),
    ...(state.heldSpace && held === undefined ? { heldSpacePending: true } : {}),...(held === undefined ? {} : {heldBytes:held}),version:4,publishedAt,run:basename(journal.root),identity,
    ...(title === undefined ? {} : {title}), briefDigest: brief.digest, sourceProject: setup.project,
    ...(state.preparationReason === undefined ? {} : { preparationReason: state.preparationReason }),
    ...(state.timeline?.checkpoints ? {checkpoints:state.timeline.checkpoints} : {}),
    ...((state.launch?.requester ?? state.preparation?.requester) === undefined ? {} : {requester:state.launch?.requester ?? state.preparation?.requester}),
    status:state.status,journalStatus:state.status,statusSince:state.statusSince,currentStage:state.status === 'running' ? state.currentStage : null,focus,journalCursor:saved.cursor,
    guidance: guidanceStatus({intents:rows<ControlIntent>(db,journal.root,'intent').values(),
      guideDeliveries:rows<GuideDelivery>(db,journal.root,'guide_delivery').values()}),
    activity:currentExecutionActivities(db,journal).map(({sample:_sample,...activity})=>activity),
    commandActivity: currentCommandActivities(db, journal).map(({activity:{notice,...activity}}) =>
      activity.state === 'quiet' && notice ? {...activity,notice} : activity),
    ...(state.timeline ? {startedAt:state.timeline.startedAt,lastActivityAt:state.timeline.lastActivityAt,
      ...(state.timeline.endedAt ? {endedAt:state.timeline.endedAt} : {})} : {}),
    stages,...(state.plan ? {plan:{revision:state.plan.revision,pending}} : {}),
    stopReason:reason, ...(state.authority ? {authority:state.authority.authority} : {}),
    backstop:{...state.backstop,rule:'C2',gateThreshold:3,failureThreshold:4,scope:'engine-outcomes',condition,...(state.timeline?.backstopAt ? {pausedAt:state.timeline.backstopAt} : {})},
    step:{label,stageLabel,attempt,startedAt:state.stepStartedAt ?? null,elapsedMs:state.currentStage && state.stepStartedAt
      ? Math.max(0,Date.parse(publishedAt)-Date.parse(state.stepStartedAt)) : null},
    usage:{...usage,...totals,invocations:Number(db.prepare("SELECT count(*) AS n FROM current_rows WHERE root=? AND kind='invocation'")
      .get(journal.root)?.n ?? 0),activeDurationMs:duration},
    gates,
    attention:obligations.length ? {reason:obligationReason(obligations[0].kind),detail:[...new Set(obligations.map(o => o.detail))].join('; '),condition:null,obligations}
      : limit ?? (reason === null ? null : {reason,detail:state.conclusion?.detail ?? '',condition,...(state.conclusion?.cause ? {cause:state.conclusion.cause} : {})}),
    host:{activation:{owner:observed?.owner ?? null,state:observed?.state === 'active' ? 'active' : observed?.state === 'inactive' || observed?.state === 'failed' ? 'inactive' : 'unknown',checkedAt:null},...(observed?.owner ? {boot:observed.owner.boot} : {}),interpretation:[...(setup.interpretation ?? state.authority?.authority.interpretation ?? []), ...(state.hostClosure ? [state.hostClosure] : [])]},
    notification:{session:(state.launch?.requester ?? state.preparation?.requester) === undefined ? 'unbound' : 'bound',
      scope:'persistent-status; optional bound-session wake',transport:'unobserved'}});
}

const executionKey = (activity: Pick<ExecutionActivity,'invocation'|'command'>) => encode([activity.invocation,activity.command]);
const hasActivity = (db:DatabaseSync) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='advisory_activity' AND type='table'").get();
function advisoryRows(db: DatabaseSync, journal: Journal, latest = false): ExecutionActivity[] {
  if (!hasActivity(db)) return [];
  return db.prepare(`SELECT id,value FROM advisory_activity WHERE root=? ${latest
    ? 'AND id IN (SELECT max(id) FROM advisory_activity WHERE root=? GROUP BY execution)' : ''} ORDER BY id`)
    .all(...(latest ? [journal.root,journal.root] : [journal.root])).map(row=> {
      const activity=decode<ExecutionActivity>(row.value);
      return {...activity,...(activity.observation === 'quiet' ? {notice:{cursor:Number(row.id),message:'no observed progress for 10 min' as const}} : {})};
    });
}
export function readAdvisoryActivity(journal: Journal): Result<ExecutionActivity[]> {
  return withState(journal.database,false,db=>valid(advisoryRows(db,journal)));
}
export function readExecutionActivity(journal: Journal, activity: Pick<ExecutionActivity,'invocation'|'command'>): Result<ExecutionActivity | undefined> {
  return withState(journal.database,false,db=> {
    if (!hasActivity(db)) return valid(undefined);
    const row=db.prepare('SELECT value FROM advisory_activity WHERE root=? AND execution=? ORDER BY id DESC LIMIT 1')
      .get(journal.root,executionKey(activity));
    return valid(row ? decode<ExecutionActivity>(row.value) : undefined);
  });
}
export function insertAdvisoryActivity(journal: Journal, activity: ExecutionActivity): Result<number> {
  return withState(journal.database,true,db=> {
    db.exec(activityTable);
    return valid(Number(db.prepare('INSERT INTO advisory_activity(root,execution,value) VALUES(?,?,?)')
      .run(journal.root,executionKey(activity),encode(activity)).lastInsertRowid));
  });
}
/** Closure comes from paid execution facts, never from observation age. */
function currentExecutionActivities(db: DatabaseSync, journal: Journal): ExecutionActivity[] {
  const attempts=rows<AttemptReceipt>(db,journal.root,'attempt').values(), closed=rows<Invocation>(db,journal.root,'closed_invocation').values();
  const reservations=rows<Reservation>(db,journal.root,'reservation').values();
  const latest = new Map(rows<ExecutionActivity>(db,journal.root,'execution_activity').values().map(activity=>[activityKey(activity.invocation,activity.command),activity]));
  for (const activity of advisoryRows(db,journal,true)) latest.set(activityKey(activity.invocation,activity.command),activity);
  return [...latest.values()].map(activity=> {
    const ended = activity.invocation.charge === 'command'
      ? reservations.some(item=>item.identity === activity.command && equal(item.invocation,activity.invocation) && !reservationOpen(item))
      : attempts.some(item=>equal({kind:'stage',...item.address},activity.invocation.address)) || closed.some(item=>equal(item,activity.invocation));
    return ended ? {...activity,state:'ended',toolRunning:false,notice:undefined}
      : activity.source === 'command' && currentActivityOwners(db,journal).length !== 1
        ? {...activity,observation:'unknown',notice:undefined} : activity;
  });
}
/** Indexed current execution only; serial dispatch binds its single stream owner to its open reservation. */
function currentActivityOwners(db: DatabaseSync, journal: Journal): Owner[] {
  return rows<Owner>(db, journal.root, 'active_process').values().filter(owner =>
    rows<{ state: OwnerState }>(db, journal.root, 'owner').get(ownerOf(owner))?.state === 'live');
}
function currentCommandActivities(db: DatabaseSync, journal: Journal) {
  const activities = rows<import('../contract/runtime.js').CommandActivity>(db, journal.root, 'command_activity');
  const commands = rows<Reservation>(db, journal.root, 'reservation').entries().filter(([, value]) => reservationOpen(value));
  const observed = commands.length === 1 && currentActivityOwners(db, journal).length === 1;
  return commands.map(([identity, reservation]) => {
    const execution = currentExecutionActivities(db,journal).find(item=>item.command === reservation.identity && equal(item.invocation,reservation.invocation));
    const saved = execution ? {state:execution.observation} : activities.get(identity);
    return { identity, reservation, execution, activity: {
      command: reservation.identity, stage: reservation.invocation.address.kind === 'stage' ? reservation.invocation.address.stage : null,
      ...saved, state: observed ? saved?.state ?? 'unknown' : 'unknown' } as import('../contract/runtime.js').CommandActivity };
  });
}
export function readCommandActivity(journal: Journal): Result<{ cursor: number;
  commands: ReturnType<typeof currentCommandActivities>; owners: Owner[] }> {
  return withState<{ cursor: number; commands: ReturnType<typeof currentCommandActivities>; owners: Owner[] }>(journal.database, false, db => {
    const saved = current(db, journal); if (!saved) return bad('unavailable', 'Run state unavailable');
    return { ok: true as const, value: { cursor: saved.cursor, commands: currentCommandActivities(db, journal),
      owners: currentActivityOwners(db, journal) } };
  });
}
