import { validAuthority } from './status.mjs';
export { parseRunStatusFile, RUN_STATUS_LAYOUT, withCurrentBoot } from './status.mjs';
import { z } from 'zod';
import {
  admittedBriefSchema, ignoreRetired, declaredPathSchema, hashSchema, idSchema, refSchema, parseValue,
  type Immutable, type AdmittedBrief, type Hash, type Id, type Ref, type Result,
} from './brief.js';
import { parsePlan, type Plan, type AdmittedPlan, type Stage, commandRelationSchema, type CommandRelation } from './plan.js';
import type { AnswerContext, AnswerSchema, GateOutcome, StageAnswer } from './answers.js';

// Runtime values describe observations. Only the decision owner interprets
// an observation against the operator's declaration and current run state.
/** Persist the one engine-outcome backstop. Completion history lives on admitted stage facts. */
export const backstopSchema = z.strictObject({
  gateSuffix: z.number().int().nonnegative(), failureSuffix: z.number().int().nonnegative(),
  bestPassCount: z.number().int().nonnegative().nullable(), segment: z.number().int().nonnegative(),
  settlement: z.string().nullable(), obligation: z.string().nullable(),
});
export type Backstop = Readonly<z.infer<typeof backstopSchema>>;
export const initialBackstop = (): Backstop => ({
  gateSuffix: 0, failureSuffix: 0, bestPassCount: null,
  segment: 0, settlement: null, obligation: null
});

export const providerPreferencesSchema = z.strictObject({
  model: z.string().optional(), effort: z.string().optional(),
  source: z.strictObject({ model: z.enum(['role', 'settings', 'builtin']), effort: z.enum(['role', 'settings', 'builtin']) })
});
export type ProviderPreferences = Immutable<z.infer<typeof providerPreferencesSchema>>;
/** The admitted interpretation, persisted once before provisioning. No filesystem I/O. */
type Grant = { readonly writableRoots: readonly string[]; readonly protectedRoots: readonly string[] };
export interface RunAuthority {
  readonly project: string;
  readonly backend?: 'codex' | 'claude';
  readonly aliases?: readonly { source: string; destination: string; dev: number; ino: number; sourceDev: number; sourceIno: number;
    nlink: number; sourceNlink: number; writable: boolean }[];
  readonly interpretation: readonly string[];
  readonly preferences: readonly { role: Id; backend: 'codex' | 'claude'; settings: ProviderPreferences }[];
  readonly parents: readonly { path: string; original: OutputFact; mode: number }[];
  readonly outputs: readonly { path: string; absolute: string; kind: 'file' | 'directory'; admission: 'absent' | 'present' | 'either';
    original: OutputFact; write: 'project' | 'exact'; provision: boolean; baseline: 'original-manifest'; mutation: 'tree' | 'in-place';
    delivery: { original: 'absent' | 'present' | 'either'; append: boolean; nonempty: boolean } }[];
  readonly resources: readonly { path: string; access: 'exclusive-write' | 'shared-write' | 'stable-read' }[];
  readonly purposes: Readonly<Record<'plan' | 'work' | 'gate' | 'command', Grant>>;
  readonly providers: Readonly<Record<'codex' | 'claude', readonly string[]>>;
  readonly commands: readonly { id: string; scratch: string; grant: Grant; env: Readonly<Record<string,string>> }[];
}
export const runAuthoritySchema = z.custom<RunAuthority>(validAuthority);
export type OutputFact = 'absent' | 'file' | 'directory' | 'other';


export type RunStatus = 'pending' | 'running' | 'parked' | 'complete' | 'accepted_blocked' | 'incomplete' | 'failed' | 'escalated' | 'cancelled';
export type StopReason = 'completed' | 'accepted_blocked' | 'gate_irreparable' | 'command_missing' | 'command_nonzero' | 'command_unfinished' | 'outputs_unpreserved' | 'backstop' | 'attempt_failed' | 'contract_refused' | 'isolation_refused' | 'cancelled' | 'recovery_unknown' | 'closure_unconfirmed' | 'accounting_unsettled' | 'claim_unreleased';

export interface Conclusion {
  readonly status: RunStatus;
  readonly reason: StopReason;
  readonly detail: string;
  readonly authoredGate?: Ref;
}

export type Ending = 'delivered' | 'invalid_answer' | 'invalid_plan' | 'work_failed'
  | 'technical_failure' | 'auth' | 'refused' | 'input_too_large' | 'quota' | 'duration'
  | 'cancelled' | 'isolation_failure' | 'closure_unknown' | 'provider_unknown';

export interface AttemptAddress {
  readonly run: Id;
  readonly stage: Id;
  readonly attempt: Id;
  readonly invocation: number;
}

export type InvocationSite =
  | ({ readonly kind: 'stage' } & AttemptAddress)
  | { readonly kind: 'setup'; readonly run: Id }
  | { readonly kind: 'final'; readonly run: Id };

export type Invocation = (
  | { readonly charge: 'work' | 'technical' | 'correction' | 'plan' | 'continuation'; readonly address: Extract<InvocationSite, { kind: 'stage' }> }
  | { readonly charge: 'command'; readonly address: InvocationSite }
);

export interface Usage {
  readonly state: 'known' | 'partial' | 'unknown';
  readonly input?: number;
  readonly output?: number;
  readonly cached?: number;
  readonly costUsd?: number;
  readonly raw: readonly Ref[];
}

export interface AttemptRequest {
  readonly address: AttemptAddress;
  readonly brief: AdmittedBrief;
  readonly plan: AdmittedPlan;
  readonly stage: Stage;
  readonly role: Role;
  readonly invocation: Invocation;
  readonly evidence: readonly Ref[];
  readonly guidance?: readonly { readonly intent: Id; readonly cursor: number; readonly intervention: Intervention }[];
  readonly context: AnswerContext;
}

export interface AttemptReceipt {
  readonly address: AttemptAddress;
  readonly ending: Ending;
  readonly answer?: StageAnswer;
  readonly answerRef?: Ref;
  readonly before: Hash;
  readonly after: Hash;
  readonly audit: Ref;
  readonly closure: OwnerState;
  readonly usage: Usage;
  readonly evidence: readonly Ref[];
  readonly resetAt?: string;
  readonly inputChars: number | null;
  readonly guidance?: readonly Id[];
}

export interface CommandKey {
  readonly observation?: CommandRelation;
  readonly generation?: Ref;
  readonly execution?: { readonly id: string; readonly scratch: string; readonly env: Readonly<Record<string, string>> };
  readonly tree: Hash;
  readonly declaration: Hash;
  readonly inputHashes: readonly Hash[];
  // Identity of the fixed per-run execution context, not host-global reuse.
  readonly context: Hash;
}

export type CommandExecution =
  | { readonly state: 'complete'; readonly exit: number }
  | { readonly state: 'unfinished'; readonly reason: 'duration' | 'cancelled' | 'closure_unknown' | 'reservation_unknown' }
  | { readonly state: 'not_started'; readonly reason: 'preparation_failed' };
export const observedPathSchema = z.strictObject({ path: declaredPathSchema, identity: refSchema });
export type ObservedPath = Immutable<z.infer<typeof observedPathSchema>>;
export const observedGenerationSchema = z.strictObject({ before: z.array(observedPathSchema), after: z.array(observedPathSchema) });

export interface CommandReceipt {
  readonly key: CommandKey;
  readonly command: Id;
  readonly execution: CommandExecution;
  readonly stdout: Ref;
  readonly stderr: Ref;
  readonly before: Hash;
  readonly after: Hash;
  readonly observed: { readonly before: readonly ObservedPath[]; readonly after: readonly ObservedPath[] };
  readonly delta: Ref;
  readonly spent: { readonly durationMs: number };
  readonly owner?: Owner;
}
/** The complete immutable evidence carried by one command receipt. */
export function commandRefs(receipt: CommandReceipt): readonly Ref[] {
  return [...new Map([receipt.stdout, receipt.stderr, receipt.delta, ...(receipt.key.generation ? [receipt.key.generation] : []),
  ...receipt.observed.before.map(item => item.identity),
    ...receipt.observed.after.map(item => item.identity)].map(ref => [JSON.stringify([ref.path, ref.sha256]), ref])).values()];
}

export type Reservation = {
  readonly key: CommandKey;
  readonly identity: Id;
  readonly invocation: Invocation;
} & (
    | { readonly state: 'reserved' | 'uncertain' | 'closed-unmeasured' }
    | { readonly state: 'committed'; readonly receipt: CommandReceipt }
  );

export type CheckpointId = Id;

export interface Checkpoint {
  readonly id: CheckpointId;
  readonly address: AttemptAddress;
  readonly parent: CheckpointId | null;
  readonly state: 'safe' | 'quarantined';
  readonly manifest: Ref;
  readonly tree: Hash;
  readonly brief: Hash;
  readonly inputHashes: readonly Ref[];
  readonly evidence: readonly Ref[];
  readonly observed?: readonly ObservedPath[];
}

export interface OutputReceipt {
  readonly preserved: boolean;
  readonly artifacts: readonly Ref[];
  readonly detail: string;
}

export interface Owner {
  readonly pid: number;
  readonly start: string;
  readonly boot: string;
  readonly group: number;
  readonly authority: string;
  readonly streams?: { readonly stdout: string; readonly stderr: string };
  readonly members?: readonly { readonly pid: number; readonly start: string; readonly boot: string }[];
}

export type OwnerState = 'live' | 'dead' | 'reused' | 'unknown';

export interface OwnedProgram {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: Ref;
  readonly writableRoots: readonly string[];
  readonly durationMs?: number;
}

export interface ProcessReceipt {
  readonly owner?: Owner;
  readonly state: 'closed' | 'not_started' | 'closure_unknown';
  readonly exit: number | null;
  readonly signal: string | null;
  readonly grant: GrantReceipt['state'];
  readonly stdout: Ref;
  readonly stderr: Ref;
  readonly durationMs: number;
  readonly scope: 'group' | 'contained_descendants';
}

/** Both a completed native exit and a retained start barrier require confirmed group closure. */
export const processClosed = (receipt: Pick<ProcessReceipt, 'state'>): boolean => receipt.state !== 'closure_unknown';

export interface GrantRequest {
  readonly aliases?: RunAuthority['aliases'];
  readonly writableRoots: readonly string[];
  readonly protectedRoots: readonly string[];
  /** Private Git authority for a worktree: privateDir must lie under a writable root; shared refs stay protected. */
  readonly git?: { readonly worktree: string; readonly commonDir: string; readonly privateDir: string; readonly baseCommit: string | null };
}

export interface GrantReceipt {
  readonly state: 'applied' | 'unavailable' | 'refused';
  readonly evidence: readonly Ref[];
  readonly detail: string;
}

const roleSchema = z.strictObject({
  id: idSchema,
  description: z.string(),
  prompt: z.string().min(1),
  backend: z.enum(['codex', 'claude']),
  model: z.string().min(1),
  effort: z.string().min(1),
});

export type Role = Readonly<z.infer<typeof roleSchema>>;
const runtimeSchema = z.strictObject({
  roles: z.array(roleSchema).min(1),
  // Physical locators belong to the host. Parsing does not claim these roots
  // exist, are disjoint, or are usable native grants.
  sharedCaches: z.array(declaredPathSchema),
  devices: z.array(declaredPathSchema),
  providerHomes: z.strictObject({ codex: z.array(declaredPathSchema), claude: z.array(declaredPathSchema) }),
}).superRefine((value, context) => {
  for (const [key, entries] of [['roles', value.roles.map(role => role.id)], ['sharedCaches', value.sharedCaches], ['devices',
    value.devices]] as const) {
    if (new Set(entries).size !== entries.length) {
      context.addIssue({ code: 'custom', path: [key], message: 'Duplicate declaration' });
    }
  }
});

export interface RuntimeConfig {
  readonly roles: readonly Role[];
  readonly sharedCaches: readonly string[];
  readonly devices: readonly string[];
  readonly providerHomes: Readonly<Record<Role['backend'], readonly string[]>>;
}
export function parseRuntime(value: unknown, advisory?: (line: string) => void): Result<RuntimeConfig> {
  return parseValue(runtimeSchema, ignoreRetired(value, 'config', line => advisory?.(`config.${line}`)));
}

export interface BackendRequest {
  readonly aliases?: GrantRequest['aliases'];
  readonly preferences: ProviderPreferences;
  readonly attempt: AttemptAddress;
  readonly role: Role;
  readonly input: Ref;
  readonly schema: AnswerSchema['json'];
  readonly project: string;
  readonly scratch: string;
  readonly writableRoots: readonly string[];
  readonly abort: AbortSignal;
  readonly protectedRoots: readonly string[];
  readonly git?: GrantRequest['git'];
  readonly durationMs?: number;
}

export interface BackendReply {
  readonly raw: Ref;
  readonly exit: number | null;
  readonly signal: string | null;
  readonly ending: Ending;
  readonly answerBytes?: Ref;
  readonly closure: OwnerState;
  readonly usage: Usage;
  readonly nativeCommands: readonly Ref[];
  readonly resetAt?: string;
}

export interface Adapter {
  invoke(request: BackendRequest): Promise<Result<BackendReply>>;
}
// One run, one pinned portable activation, pinned to immutable runtime bytes.
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ownerSchema = z.strictObject({ pid: positive, start: z.string().min(1), boot: z.string().min(1), group: positive,
  authority: z.string().min(1), streams: z.strictObject({ stdout: declaredPathSchema, stderr: declaredPathSchema }).optional(),
  members: z.array(z.strictObject({ pid: positive, start: z.string().min(1), boot: z.string().min(1) })).optional() });
const runRefSchema = z.strictObject({ run: idSchema, runtime: refSchema, authority: z.string().min(1) });

export type RunRef = Immutable<z.infer<typeof runRefSchema>>;
export function parseRunRef(value: unknown): Result<RunRef> { return parseValue(runRefSchema, value); }
const runObservationSchema = z.strictObject({
  unit: runRefSchema, state: z.enum(['active', 'inactive', 'failed', 'unknown']),
  owner: ownerSchema.nullable(), evidence: z.array(refSchema), detail: z.string(),
});

export type RunObservation = Immutable<z.infer<typeof runObservationSchema>>;
export function parseRunObservation(value: unknown): Result<RunObservation> { return parseValue(runObservationSchema, value); }

export const commandKeySchema = z.strictObject({
  observation: commandRelationSchema.optional(), generation: refSchema.optional(), tree: hashSchema, declaration: hashSchema,
    inputHashes: z.array(hashSchema), context: hashSchema,
  execution: z.strictObject({ id: idSchema, scratch: declaredPathSchema, env: z.record(z.string(), z.string()) }).optional()
});
const commandReceiptSchema = z.strictObject({
  key: commandKeySchema,
  command: idSchema,
  execution: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('complete'), exit: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }),
    z.strictObject({ state: z.literal('unfinished'), reason: z.enum(['duration', 'cancelled', 'closure_unknown', 'reservation_unknown']) }),
    z.strictObject({ state: z.literal('not_started'), reason: z.literal('preparation_failed') }),
  ]),
  stdout: refSchema, stderr: refSchema, before: hashSchema, after: hashSchema,
  observed: observedGenerationSchema, delta: refSchema, spent: z.strictObject({ durationMs: natural }), owner: ownerSchema.optional(),
});
const setupRequestSchema = z.strictObject({
  project: declaredPathSchema, target: declaredPathSchema, brief: admittedBriefSchema, runtime: refSchema,
});

export type SetupRequest = Immutable<z.infer<typeof setupRequestSchema>>;
export function parseSetupRequest(value: unknown): Result<SetupRequest> { return parseValue(setupRequestSchema, value); }
const setupEvidenceSchema = z.strictObject({
  project: declaredPathSchema, target: declaredPathSchema, brief: hashSchema,
  inputs: z.array(refSchema), outputs: z.array(refSchema),
  nativeGrant: z.enum(['applied', 'unavailable', 'refused']), commands: z.array(commandReceiptSchema),
  backend: z.enum(['codex', 'claude']).optional(),
  interpretation: z.array(z.string()).optional(),
});

export type SetupEvidence = Immutable<z.infer<typeof setupEvidenceSchema>>;
/** Validate preparation evidence shape and direct command states; returns invalid without interpreting baseline quality. */
export function parseSetupEvidence(value: unknown): Result<SetupEvidence> { return parseValue(setupEvidenceSchema, value); }
const sameRef = (left: Ref, right: Ref) => left.path === right.path && left.sha256 === right.sha256;
// Opaque frontend identity declared by whoever launches a run (for example `claude:<session id>`).
// The engine stores and republishes it; it never interprets, matches or routes on it.
const requesterSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const launchSchema = z.strictObject({
  backend: z.enum(['codex', 'claude']).optional(),
  requester: requesterSchema.optional(), run: idSchema, project: declaredPathSchema, brief: admittedBriefSchema,
  roles: z.array(roleSchema).min(1), runtime: refSchema, setup: setupEvidenceSchema,
  unit: runRefSchema, plan: z.unknown().optional(),
}).transform((launch, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  if (launch.setup.backend && launch.backend !== launch.setup.backend) fail('Backend differs from prepared setup');
  if (launch.run !== launch.unit.run || !sameRef(launch.runtime, launch.unit.runtime)) fail('Launch unit identity mismatch');
  if (launch.project !== launch.setup.target || launch.brief.digest !== launch.setup.brief) fail('Setup identity mismatch');
  if (new Set(launch.roles.map(role => role.id)).size !== launch.roles.length) { fail('Duplicate role'); return z.NEVER; }
  let plan: Plan | undefined;
  if (launch.plan !== undefined) {
    const parsed = parsePlan(launch.plan, {
      roleIds: launch.roles.map(role => role.id),
      commandIds: launch.brief.declaration.commands.map(command => command.id), checkpointIds: []
    });
    if (parsed.ok) plan = parsed.value; else fail(parsed.detail);
  }
  return { ...launch, roles: launch.roles.map(role => launch.backend ? { ...role, backend: launch.backend } : role), plan };
});

export type Launch = Immutable<z.infer<typeof launchSchema>>;
export function parseLaunch(value: unknown): Result<Launch> { return parseValue(launchSchema, value); }

const interventionSchema = z.strictObject({
  address: z.strictObject({ run: idSchema, stage: idSchema, attempt: idSchema, invocation: positive }).nullable(),
  kind: z.literal('guide'), content: refSchema,
  replacement: z.strictObject({ baseRevision: idSchema, plan: z.unknown() }).optional(),
});

export type Intervention = Immutable<z.infer<typeof interventionSchema>>;
export function parseIntervention(value: unknown): Result<Intervention> { return parseValue(interventionSchema, value); }
const intentAddress = { id: idSchema, run: idSchema, unit: runRefSchema, expectedCursor: natural };
const controlIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...intentAddress, kind: z.enum(['start', 'cancel', 'resume', 'status']) }),
  z.strictObject({ ...intentAddress, kind: z.literal('guide'), intervention: interventionSchema }),
]).superRefine((intent, context) => {
  if (intent.run !== intent.unit.run || (intent.kind === 'guide' && intent.intervention.address !== null && intent.run !== intent.intervention.address.run))
    context.addIssue({ code: 'custom', message: 'Intent address mismatch' });
});

export type ControlIntent = Immutable<z.infer<typeof controlIntentSchema>>;
/** Validate the closed operation grammar and matching run addresses; returns invalid without appending or controlling units. */
export function parseControlIntent(value: unknown): Result<ControlIntent> { return parseValue(controlIntentSchema, value); }
const operationSchema = z.strictObject({
  intent: controlIntentSchema,
  state: z.enum(['acknowledged', 'in_progress', 'unknown', 'refused', 'not_confirmed_closed']),
  cursor: natural.nullable(), observation: runObservationSchema.nullable(),
  evidence: z.array(refSchema), detail: z.string(),
}).superRefine((operation, context) => {
  const observed = operation.observation?.unit;
  if (observed && (observed.run !== operation.intent.run || observed.authority !== operation.intent.unit.authority || !sameRef(observed.runtime,
    operation.intent.unit.runtime)))
    context.addIssue({ code: 'custom', message: 'Operation unit mismatch' });
  if (operation.state === 'acknowledged' && operation.cursor === null)
    context.addIssue({ code: 'custom', message: 'Acknowledgement needs a committed journal cursor' });
  if (operation.cursor !== null && operation.cursor < operation.intent.expectedCursor)
    context.addIssue({ code: 'custom', message: 'Operation cursor cannot precede the observed intent boundary' });
});

export type Operation = Immutable<z.infer<typeof operationSchema>>;
/** Validate control cursor and observed-unit consistency; returns invalid without inferring semantic acceptance from acknowledgement. */
export function parseOperation(value: unknown): Result<Operation> { return parseValue(operationSchema, value); }

// The wire fields are validated by the one builtin-only decoder in status.mjs.
export interface RunStatusFile {
  readonly version: 2; readonly publishedAt: string; readonly run: Id; readonly identity: RunRef; readonly requester?: string;
  readonly status: RunStatus; readonly statusSince: number; readonly currentStage: Id | null; readonly journalCursor: number;
  readonly stopReason: StopReason | null; readonly authority?: RunAuthority;
  readonly backstop: Backstop & { readonly rule: 'C2'; readonly gateThreshold: 3; readonly failureThreshold: 4;
    readonly scope: 'engine-outcomes'; readonly condition: 'gate' | 'failure' | null };
  readonly step: { readonly startedAt: string | null; readonly elapsedMs: number | null };
  readonly usage: Usage & { readonly invocations: number; readonly activeDurationMs: number | null };
  readonly attention: { readonly reason: StopReason; readonly detail: string; readonly condition: 'gate' | 'failure' | null; readonly obligations?: readonly RunObligation[] } | null;
  readonly reclaimed?: { readonly at: string; readonly delivery: string };
  readonly interruption?: { readonly detail: 'interrupted by restart'; readonly resume: string };
  readonly host: { readonly boot?: string; readonly readiness: SetupEvidence['nativeGrant']; readonly interpretation: readonly string[] };
  readonly notification: { readonly session: 'bound' | 'unbound';
    readonly scope: 'persistent-status; optional bound-session wake'; readonly transport: 'unobserved' };
  readonly gates: readonly { readonly stage: Id; readonly attempt: Id; readonly scope: 'progress' | 'delivery'; readonly result?: string;
    readonly outcome: GateOutcome; readonly answer: Ref; readonly cursor: number }[];
}

export interface RunObligation {
  readonly kind: 'closure-unconfirmed' | 'accounting-unsettled' | 'claim-unreleased';
  readonly detail: string;
  readonly owner?: Owner;
  readonly members: readonly { readonly pid: number; readonly state: string; readonly parent: number | null }[];
}

export type JournalPayload =
  | { readonly type: 'obligation'; readonly obligation: RunObligation; readonly open: boolean }
  | { readonly type: 'accounting_interrupted' }
  | { readonly type: 'owner_closed'; readonly owner: Owner }
  | { readonly type: 'run_reclaimed'; readonly at: string; readonly delivery: string }
  | { readonly type: 'run_authority'; readonly authority: RunAuthority }
  // N4 records the original baselines with measured=null; N6 records the same baselines with the completed evidence,
  // so a caller that lost setup's response can recover it from the journal instead of re-snapshotting changed bytes.
  | {
    readonly type: 'setup_prepared'; readonly request: SetupRequest; readonly unit: RunRef;
    readonly baselines: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }; readonly measured: SetupEvidence | null
  }
  | { readonly type: 'admitted'; readonly launch: Launch }
  | { readonly type: 'control_intent'; readonly intent: ControlIntent }
  | { readonly type: 'control_settled'; readonly operation: Operation }
  | { readonly type: 'run_observed'; readonly observation: RunObservation }
  | { readonly type: 'plan_committed'; readonly plan: AdmittedPlan }
  | { readonly type: 'ownership'; readonly owner: Owner; readonly state: OwnerState }
  | { readonly type: 'process'; readonly receipt: ProcessReceipt }
  | { readonly type: 'invocation_reserved'; readonly invocation: Invocation }
  | { readonly type: 'attempt_received'; readonly receipt: AttemptReceipt }
  | { readonly type: 'backstop_reconstructed'; readonly basis: number; readonly backstop: Backstop }
  | { readonly type: 'outcome_settled'; readonly address: AttemptAddress; readonly obligation: string; readonly completed: boolean;
    readonly backstop: Backstop }
  | { readonly type: 'attempt_settled'; readonly receipt: AttemptReceipt }
  | { readonly type: 'command_reserved'; readonly reservation: Reservation }
  | { readonly type: 'command'; readonly receipt: CommandReceipt }
  | { readonly type: 'checkpoint'; readonly checkpoint: Checkpoint }
  | { readonly type: 'checkpoint_restore_started'; readonly checkpoint: CheckpointId }
  | { readonly type: 'checkpoint_materialized'; readonly checkpoint: CheckpointId }
  | { readonly type: 'outputs_preserved'; readonly receipt: OutputReceipt }
  | { readonly type: 'stage_settled'; readonly stage: Id; readonly state: 'pending' | 'running' | 'settled' | 'skipped';
    readonly evidence: readonly Ref[] }
  | GateTransition
  | { readonly type: 'active_time_opened'; readonly interval: ActiveInterval }
  | { readonly type: 'active_time_closed'; readonly interval: Id; readonly spentMs: number }
  | { readonly type: 'lifecycle'; readonly conclusion: Conclusion };

export interface JournalEvent {
  readonly seq: number;
  readonly run: Id;
  readonly at: string;
  readonly payload: JournalPayload;
}

export interface Journal {
  readonly database: string;
  readonly root: string;
}

export interface Writer {
  readonly journal: Journal;
  readonly owner: Owner;
  readonly epoch: Id;
  readonly kind: 'control' | 'execution';
  readonly cursor: number;
}

export interface RunProjection {
  readonly reclaimed?: { readonly at: string; readonly delivery: string };
  readonly authority?: RunAuthority;
  readonly run: Id;
  readonly cursor: number;
  readonly launch: Launch;
  readonly currentStage: Id | null;
  readonly stageStates: readonly StageState[];
  readonly transitions: readonly GateTransition[];
  readonly revisions: readonly AdmittedPlan[];
  readonly reservations: readonly Reservation[];
  readonly intervals: readonly ActiveInterval[];
  readonly obligations: readonly RunObligation[];
  readonly closedInvocations: readonly Invocation[];
  readonly intents: readonly ControlIntent[];
  readonly operations: readonly Operation[];
  readonly brief: AdmittedBrief;
  readonly plan: AdmittedPlan;
  readonly status: RunStatus;
  /** Cursor of the committed batch whose facts first produced the current status value; later batches that keep the status keep it. */
  readonly statusSince: number;
  readonly conclusion?: Conclusion;
  readonly attempts: readonly AttemptReceipt[];
  readonly received: readonly AttemptReceipt[];
  readonly backstop: Backstop;
  readonly commands: readonly CommandReceipt[];
  readonly lineage: readonly ({ readonly kind: 'command'; readonly receipt: CommandReceipt } | { readonly kind: 'checkpoint';
    readonly checkpoint: Checkpoint })[];
  readonly invocations: readonly Invocation[];
  readonly owners: readonly { readonly owner: Owner; readonly state: OwnerState }[];
  readonly restoring: CheckpointId | null;
  readonly checkpoints: readonly Checkpoint[];
  readonly outputs: readonly OutputReceipt[];
}


export interface RunLocation {
  readonly database: string;
  readonly storeRoot: string;
  readonly run: Id;
}

export interface StageState {
  readonly stage: Id;
  readonly state: 'dormant' | 'pending' | 'running' | 'settled' | 'skipped';
  readonly obligation: string;
  readonly completed: boolean;
}


export interface GateTransition {
  readonly type: 'gate_transition';
  readonly stage: Id;
  readonly attempt: Id;
  readonly outcome: GateOutcome;
  readonly next: Id | null;
  readonly evidence: readonly Ref[];
}


export interface ActiveInterval {
  readonly id: Id;
  readonly owner: Owner;
  readonly openedAt: string;
  readonly spentMs: number | null;
  /** null without this marker is open; an interrupted measurement remains unknown forever. */
  readonly closed?: 'unmeasured';
}

/** Share one skeleton-only Error instance; never represents a typed engine refusal or product outcome. */
export const NotImplemented = new Error('FlowCrew rewrite interface is not implemented');
