import { validRequester } from './status.mjs';
import { validAuthority, currentAuthority } from './status.mjs';
export { parseRunStatusFile, parsePublicRunStatus, RUN_STATUS_LAYOUT, withCurrentBoot } from './status.mjs';
import { z } from 'zod';
import {
  admittedBriefSchema, ignoreRetired, declaredPathSchema, hashSchema, idSchema, refSchema, parseValue,
  type Immutable, type AdmittedBrief, type Hash, type Id, type Ref, type Result,
} from './brief.js';
import { parsePlan, type Plan, type AdmittedPlan, type Stage } from './plan.js';
import type { AnswerContext, AnswerSchema, GateOutcome, StageAnswer } from './answers.js';
import type { LiveHooks } from './live.js';

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
/** The admitted interpretation, persisted once before execution. No filesystem I/O. */
export interface RunAuthority {
  readonly project: string;
  readonly backend?: 'codex' | 'claude';
  readonly interpretation: readonly string[];
  readonly preferences: readonly { role: Id; backend: 'codex' | 'claude'; settings: ProviderPreferences }[];
  readonly parents: readonly { path: string; original: OutputFact; mode: number }[];
  readonly outputs: readonly { path: string; absolute: string; kind: 'file' | 'directory'; admission: 'absent' | 'present' | 'either';
    original: OutputFact; write: 'project' | 'exact'; baseline: 'original-manifest';
    delivery: { original: 'absent' | 'present' | 'either'; append: boolean; nonempty: boolean } }[];
  readonly resources: readonly { path: string; access: 'exclusive-write' | 'shared-write' | 'stable-read' }[];
  readonly commands: readonly { id: string; scratch: string; env: Readonly<Record<string,string>> }[];
}
export const runAuthoritySchema = z.custom<RunAuthority>(validAuthority).transform(currentAuthority);
export type OutputFact = 'absent' | 'file' | 'directory' | 'other';


export type RunStatus = 'preparing' | 'refused' | 'pending' | 'running' | 'parked' | 'complete' | 'accepted_blocked' | 'incomplete' | 'failed' | 'escalated' | 'cancelled';
export type StopReason = 'completed' | 'accepted_blocked' | 'gate_irreparable' | 'command_missing' | 'command_nonzero' | 'command_unfinished' | 'outputs_unpreserved' | 'backstop' | 'attempt_failed' | 'contract_refused' | 'isolation_refused' | 'cancelled' | 'recovery_unknown' | 'closure_unconfirmed' | 'accounting_unsettled' | 'claim_unreleased';

export interface Conclusion {
  readonly status: RunStatus;
  readonly reason: StopReason;
  readonly detail: string;
  readonly authoredGate?: Ref;
  readonly cause?: 'resume_refused';
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
  /** Tree capture the caller already holds for the moment the invocation starts; absent means the attempt reads the project itself. */
  readonly before?: Hash;
  readonly commandReview?: { readonly commands: readonly CommandReceipt[]; readonly reusedCommands: readonly CommandReuse[] };
  readonly address: AttemptAddress;
  readonly brief: AdmittedBrief;
  readonly plan: AdmittedPlan;
  readonly stage: Stage;
  readonly role: Role;
  readonly invocation: Invocation;
  readonly evidence: readonly Ref[];
  readonly guidance?: readonly { readonly intent: Id; readonly cursor: number; readonly intervention: Intervention }[];
  readonly context: AnswerContext;
  /** Live steering and activity hooks for this invocation (contract/live.ts). */
  readonly live?: LiveHooks;
}

/** Command provenance in the historical reusedCommands carrier; an empty intersection attests satisfaction. */
export interface CommandReuse {
  readonly receipt: CommandReceipt;
  readonly sourceTree: Hash;
  readonly source: { readonly stage: Id; readonly attempt: Id; readonly invocation?: number };
  readonly dependencyIntersection?: readonly [];
}

/** Display only: every satisfied receipt has provenance; earlier invocations are labelled reused. */
export function commandEvidenceLabel(item: CommandReuse, displaying: AttemptAddress): {source:string;reused?:string} {
  const source = `${item.source.stage}/${item.source.attempt}`;
  const reused = item.source.stage !== displaying.stage || item.source.attempt !== displaying.attempt
    || item.source.invocation !== undefined && item.source.invocation !== displaying.invocation;
  return {source:`${reused ? 'reused from' : 'from'} ${source}/${item.source.invocation ?? '?'} (tree ${item.sourceTree})`,
    ...(reused ? {reused:`reused from ${source}`} : {})};
}

/** What a gate was supplied as engine records, never as model input: the receipts it was shown and the command history at that moment.
 * One shape for its writer (`composeInput`), its checker (settlement) and the fixtures that stand in for either. */
export const gateReview = (projection: { readonly commands: readonly CommandReceipt[]; readonly lineage: RunProjection['lineage'] },
  commands: readonly CommandReceipt[], reusedCommands: readonly CommandReuse[]) =>
  ({ commands, reusedCommands, history: { commands: projection.commands, lineage: projection.lineage } });

export interface AttemptReceipt {
  readonly reusedCommands?: readonly CommandReuse[];
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

/** Exact inline receipt set shared by prompt composition and settlement attestation. */
export function currentCommandReceipts(commands: readonly CommandReceipt[], stage: Stage, brief: AdmittedBrief): CommandReceipt[] {
  const selected = new Set([...(stage.commands ?? []),...brief.declaration.commands.filter(command => command.required).map(command => command.id)]);
  return [...new Map(commands.filter(receipt => selected.has(receipt.command)).map(receipt => [receipt.command,receipt])).values()];
}

export interface CommandKey {
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
  | { readonly state: 'unfinished'; readonly reason: 'signalled'; readonly signal: string }
  | { readonly state: 'not_started'; readonly reason: 'preparation_failed' };
/** The same declaration and env run once on the run's base tree, after a required command exited non-zero. Exactly what happened is
 * stored, and never re-classified: the receipt `measure` produced (`ok: true`), or the failure it returned verbatim, or the
 * failure of the executor's own step around `measure` (`ok: false`): `kind: 'not_placed'` when the base copy could not be placed,
 * `kind: 'threw'` when any step of the attempt threw (the error text is the detail). */
export type BaseRun = { readonly tree: Hash } & (
  | { readonly ok: true; readonly execution: CommandExecution; readonly stdout: Ref; readonly stderr: Ref; readonly spent: { readonly durationMs: number };
    /** The launch refusal (kind and detail as given) when the program never ran to a receipt. */
    readonly refusal?: { readonly kind: string; readonly detail: string };
    /** Notes about the attempt itself, such as a copy that was left behind. */
    readonly detail?: string }
  | { readonly ok: false; readonly kind: string; readonly detail: string });
export interface CommandReceipt {
  readonly key: CommandKey;
  readonly command: Id;
  readonly execution: CommandExecution;
  readonly stdout: Ref;
  readonly stderr: Ref;
  readonly before: Hash;
  /** The tree the command left, and its delta from `before`. Both are absent exactly when `unpinned` is present. */
  readonly after?: Hash;
  readonly delta?: Ref;
  /** The command ended but a declared output changed while its after-tree was read: a writer outside its containment is still writing.
   * The capture's refusal as given (it names the path); behaviour keys on the absence of `after`, never on the text. */
  readonly unpinned?: { readonly detail: string };
  readonly spent: { readonly durationMs: number };
  readonly owner?: Owner;
  /** Measured when a required command exited non-zero; absent for any other receipt. */
  readonly base?: BaseRun;
}
/** What a non-zero exit means against the base: `pre-existing` only when a complete base run exits non-zero too; everything else
 * (it passes, or the run did not complete, for any reason) is `introduced`. Undefined when no base run was attempted. */
export type CommandBasis = 'pre-existing' | 'introduced';
export function commandBasis(receipt: CommandReceipt): CommandBasis | undefined {
  if (!receipt.base || receipt.execution.state !== 'complete' || receipt.execution.exit === 0) return undefined;
  return receipt.base.ok && receipt.base.execution.state === 'complete' && receipt.base.execution.exit !== 0 ? 'pre-existing' : 'introduced';
}
/** The complete immutable evidence carried by one command receipt. */
export function commandRefs(receipt: CommandReceipt): readonly Ref[] {
  return [...new Map([receipt.stdout, receipt.stderr, ...(receipt.delta ? [receipt.delta] : []), ...(receipt.key.generation ? [receipt.key.generation] : []),
    ...(receipt.base?.ok ? [receipt.base.stdout, receipt.base.stderr] : [])].map(ref => [JSON.stringify([ref.path, ref.sha256]), ref])).values()];
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
}

export interface OutputReceipt {
  readonly released?: readonly string[];
  readonly disposition?: 'reviewed' | 'unreviewed';
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
  readonly containment?: { readonly kind: 'cgroup'; readonly inode: string; readonly path: string }
    | { readonly kind: 'marker'; readonly marker: string };
  readonly streams?: { readonly stdout: string; readonly stderr: string };
  readonly members?: readonly { readonly pid: number; readonly start: string; readonly boot: string }[];
}

export type OwnerState = 'live' | 'dead' | 'reused' | 'unknown';

export interface OwnedProgram {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: Ref;
  readonly durationMs?: number;
}

export interface ProcessReceipt {
  readonly owner?: Owner;
  readonly state: 'closed' | 'not_started' | 'closure_unknown';
  readonly exit: number | null;
  readonly signal: string | null;
  /** The host records the interrupt at its source; readers never infer a deadline from elapsed time. */
  readonly terminationCause?: 'cancelled' | 'duration';
  /** Set by the host when it closed the owner after the provider's terminal event and its grace period, without a native exit;
   * `exit` and `signal` are then null because none was awaited. */
  readonly closedAtTerminal?: true;
  readonly stdout: Ref;
  readonly stderr: Ref;
  readonly durationMs: number;
  /** Retained for historical readers; guarantee states the actual closure facility. */
  readonly scope: 'group' | 'contained_descendants';
  readonly guarantee?: 'cgroup' | 'marker';
  readonly unknownPids?: readonly number[];
  readonly detail?: string;
}

/** Both a completed native exit and a retained start barrier require confirmed group closure. */
export const processClosed = (receipt: Pick<ProcessReceipt, 'state'>): boolean => receipt.state !== 'closure_unknown';

/** Invocation-local Git metadata; it separates normal refs/index from engine evidence, without denying host access. */
export interface GitContext {
  readonly worktree: string;
  readonly commonDir: string;
  readonly privateDir: string;
  readonly baseCommit: string | null;
}
export interface InvocationContext { readonly git?: GitContext; }

const roleSchema = z.strictObject({
  id: idSchema,
  description: z.string(),
  prompt: z.string().default(''),
  backend: z.enum(['codex', 'claude']),
  model: z.string().min(1),
  effort: z.string().min(1),
});

export type Role = Readonly<z.infer<typeof roleSchema>>;
const runtimeSchema = z.strictObject({
  roles: z.array(roleSchema).min(1),
}).superRefine((value, context) => {
  if (new Set(value.roles.map(role => role.id)).size !== value.roles.length)
    context.addIssue({ code: 'custom', path: ['roles'], message: 'Duplicate declaration' });
});

export interface RuntimeConfig { readonly roles: readonly Role[]; }

export function parseRuntime(value: unknown, advisory?: (line: string) => void): Result<RuntimeConfig> {
  return parseValue(runtimeSchema, ignoreRetired(value, 'config', line => advisory?.(`config.${line}`)));
}

export interface BackendRequest {
  readonly preferences: ProviderPreferences;
  readonly attempt: AttemptAddress;
  readonly role: Role;
  /** The user message (Markdown), as evidence. */
  readonly input: Ref;
  /** The role text, sent through the provider's system/developer instruction channel, never inside the user message. */
  readonly instruction: string;
  readonly schema: AnswerSchema['json'];
  readonly project: string;
  readonly scratch: string;
  readonly abort: AbortSignal;
  readonly git?: GitContext;
  readonly durationMs?: number;
  /** Live steering and activity hooks for this invocation (contract/live.ts). */
  readonly live?: LiveHooks;
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
export const ownerSchema = z.preprocess(value => ignoreRetired(value, 'owner'), z.strictObject({ pid: positive, start: z.string().min(1), boot: z.string().min(1), group: positive,
  authority: z.string().min(1),
  containment: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('cgroup'), inode: z.string().regex(/^\d+$/), path: z.string().min(1) }),
    z.strictObject({ kind: z.literal('marker'), marker: z.string().uuid() })
  ]).optional(), streams: z.strictObject({ stdout: declaredPathSchema, stderr: declaredPathSchema }).optional(),
  members: z.array(z.strictObject({ pid: positive, start: z.string().min(1), boot: z.string().min(1) })).optional() }));
const runRefSchema = z.strictObject({ run: idSchema, runtime: refSchema, authority: z.string().min(1) });

export type RunRef = Immutable<z.infer<typeof runRefSchema>>;
export function parseRunRef(value: unknown): Result<RunRef> { return parseValue(runRefSchema, value); }
const runObservationSchema = z.strictObject({
  unit: runRefSchema, state: z.enum(['active', 'inactive', 'failed', 'unknown']),
  owner: ownerSchema.nullable(), evidence: z.array(refSchema), detail: z.string(),
});

export type RunObservation = Immutable<z.infer<typeof runObservationSchema>>;
export function parseRunObservation(value: unknown): Result<RunObservation> { return parseValue(runObservationSchema, value); }

export const commandKeySchema = z.preprocess(value => ignoreRetired(value, 'commandKey'), z.strictObject({ generation: refSchema.optional(), tree: hashSchema, declaration: hashSchema,
    inputHashes: z.array(hashSchema), context: hashSchema,
  execution: z.strictObject({ id: idSchema, scratch: declaredPathSchema, env: z.record(z.string(), z.string()) }).optional()
}));
export const commandExecutionSchema = z.union([
  z.strictObject({ state: z.literal('complete'), exit: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ state: z.literal('unfinished'), reason: z.enum(['duration', 'cancelled', 'closure_unknown', 'reservation_unknown']) }),
  z.strictObject({ state: z.literal('unfinished'), reason: z.literal('signalled'), signal: z.string().min(1) }),
  z.strictObject({ state: z.literal('not_started'), reason: z.literal('preparation_failed') }),
]);
const baseRunSchema = z.union([
  z.strictObject({ tree: hashSchema, ok: z.literal(true), execution: commandExecutionSchema, stdout: refSchema, stderr: refSchema,
    spent: z.strictObject({ durationMs: natural }), refusal: z.strictObject({ kind: z.string().min(1), detail: z.string() }).optional(),
    detail: z.string().optional() }),
  z.strictObject({ tree: hashSchema, ok: z.literal(false), kind: z.string().min(1), detail: z.string() }),
]);
export const commandReceiptSchema = z.preprocess(value => ignoreRetired(value, 'commandReceipt'), z.strictObject({
  key: commandKeySchema,
  command: idSchema,
  execution: commandExecutionSchema,
  stdout: refSchema, stderr: refSchema, before: hashSchema, after: hashSchema.optional(),
  delta: refSchema.optional(), unpinned: z.strictObject({ detail: z.string() }).optional(),
  spent: z.strictObject({ durationMs: natural }), owner: ownerSchema.optional(), base: baseRunSchema.optional(),
}).refine(receipt => (receipt.after === undefined) === (receipt.delta === undefined) && (receipt.after === undefined) === (receipt.unpinned !== undefined),
  'A receipt pins its after-tree or records why not'));
const setupRequestSchema = z.strictObject({
  project: declaredPathSchema, target: declaredPathSchema, brief: admittedBriefSchema, runtime: refSchema,
});

export type SetupRequest = Immutable<z.infer<typeof setupRequestSchema>>;
export function parseSetupRequest(value: unknown): Result<SetupRequest> { return parseValue(setupRequestSchema, value); }
const setupEvidenceSchema = z.preprocess(value => ignoreRetired(value, 'setupEvidence'), z.strictObject({
  project: declaredPathSchema, target: declaredPathSchema, brief: hashSchema,
  inputs: z.array(refSchema), outputs: z.array(refSchema),
  /** The project and exact outputs as setup left them, before any stage ran: the base every gate's change view compares with.
   * Absent only in a run prepared before it was recorded. */
  tree: hashSchema.optional(),
  commands: z.array(commandReceiptSchema),
  backend: z.enum(['codex', 'claude']).optional(),
  interpretation: z.array(z.string()).optional(),
}));

export type SetupEvidence = Immutable<z.infer<typeof setupEvidenceSchema>>;
/** Validate preparation evidence shape and direct command states; returns invalid without interpreting baseline quality. */
export function parseSetupEvidence(value: unknown): Result<SetupEvidence> { return parseValue(setupEvidenceSchema, value); }
const sameRef = (left: Ref, right: Ref) => left.path === right.path && left.sha256 === right.sha256;
// Opaque frontend identity declared by whoever launches a run (for example `claude:<session id>`).
// The engine stores and republishes it; it never interprets, matches or routes on it.
const requesterSchema = z.custom<string>(validRequester);
const launchSchema = z.strictObject({
  backend: z.enum(['codex', 'claude']).optional(),
  requester: requesterSchema.optional(), run: idSchema, project: declaredPathSchema, brief: admittedBriefSchema,
  roles: z.array(roleSchema).min(1), runtime: refSchema, setup: setupEvidenceSchema,
  // `plan` is only read from journals admitted before setup decided the graph: no current writer sets it (`initialPlan` decides, `plan_committed`
  // records). The bootstrap rule (`decisions.ts`, `admission.ts`) and the status label read its absence; the strict schema keeps those journals readable.
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
  state: z.enum(['acknowledged', 'unknown', 'refused', 'not_confirmed_closed']),
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

export interface CommandActivity {
  readonly command: Id; readonly stage: Id | null;
  readonly state: 'observing' | 'progress' | 'quiet' | 'unknown';
  readonly notice?: { readonly cursor: number; readonly message: 'no observed progress for 10 min' };
}

/** Published from the admitted graph and existing execution facts; absent in older snapshots. */
export interface RunStageStatus {
  readonly id: Id; readonly purpose: Stage['purpose']; readonly role: Id; readonly after: readonly Id[];
  /** Present for work and plan stages; a gate has no instruction. */
  readonly goal?: string; readonly instruction?: string; readonly commands: readonly Id[];
  readonly revision: Id; readonly replacedBy?: Id;
  /** File: journal disposition. Observed read: displayed state after controller availability. */
  readonly state: 'pending' | 'dormant' | 'running' | 'settled' | 'skipped' | 'parked' | 'needs-correction' | 'interrupted' | 'unknown';
  readonly attempts: number; readonly lastEnding: Ending | null; readonly verdict: GateOutcome | null;
  readonly startedAt: string | null; readonly settledAt: string | null;
  readonly summary?: string;
  readonly segments?: readonly StageSegment[];
  readonly commandProgress?: readonly { readonly command: Id; readonly reused?: string; readonly source?: string; readonly basis?: CommandBasis; readonly state: 'passed' | 'running' | 'not_started' | 'failed' | 'unfinished' }[];
}

/** Projection facts; null start means this older projection did not retain invocation time. */
export interface StageSegment {
  readonly kind: 'attempt' | 'pause'; readonly startedAt: string | null; readonly endedAt: string | null;
  /** Measured duration retained by historical snapshots, independent of the reader clock. */
  readonly elapsedMs?: number;
  readonly attempt?: Id; readonly invocation?: number; readonly ending?: Ending;
}
export interface StageHistory {
  readonly definition: Stage; readonly revision: Id; readonly replacedBy?: Id;
  readonly state: StageState['state']; readonly startedAt: string | null; readonly settledAt: string | null;
  readonly segments: readonly StageSegment[];
}
export interface RunTimeline {
  readonly checkpoints?: { readonly count: number; readonly latestAt: string | null };
  readonly backstopAt?: string;
  readonly startedAt?: string; readonly lastActivityAt: string; readonly endedAt?: string;
  readonly stages: readonly StageHistory[];
}

// Shared status fields; status.mjs owns the separate file and public-output decoders.
export interface RunStatusFile {
  /** Declared brief title, otherwise its first level-one heading; absent on historical files. */
  readonly title?: string;
  /** The recorded brief's SHA-256 and the project directory setup read it for; absent on historical files. */
  readonly briefDigest?: string; readonly sourceProject?: string; readonly preparationReason?: string;
  readonly checkpoints?: { readonly count: number; readonly latestAt: string | null };
  readonly version: 2 | 3 | 4; readonly publishedAt: string; readonly run: Id; readonly identity: { readonly run: Id; readonly authority: string; readonly runtime?: Ref }; readonly requester?: string;
  readonly status: RunStatus | 'interrupted' | 'unknown'; readonly journalStatus?: RunStatus; readonly statusSince: number;
  /** Journal execution pointer; non-null only while running. */
  readonly currentStage: Id | null;
  /** Published focus for every lifecycle, independent of controller availability. */
  readonly focus: Id | null; readonly journalCursor: number;
  readonly stopReason: StopReason | null; readonly authority?: RunAuthority;
  readonly commandActivity?: readonly CommandActivity[];
  readonly stages?: readonly RunStageStatus[];
  readonly startedAt?: string; readonly lastActivityAt?: string; readonly endedAt?: string;
  readonly plan?: { readonly revision: Id; readonly pending: Plan };
  readonly unconfinedCommands?: readonly Id[];
  readonly backstop: Backstop & { readonly rule: 'C2'; readonly gateThreshold: 3; readonly failureThreshold: 4;
    readonly scope: 'engine-outcomes'; readonly condition: 'gate' | 'failure' | null; readonly pausedAt?: string };
  readonly step: { readonly label?: string | null; readonly stageLabel?: string | null; readonly attempt?: Id | null; readonly startedAt: string | null; readonly elapsedMs: number | null };
  readonly usage: Usage & { readonly invocations: number; readonly activeDurationMs: number | null };
  readonly attention: { readonly cause?: 'resume_refused'; readonly reason: StopReason | 'command_limit'; readonly cursor?: number; readonly detail: string; readonly condition: 'gate' | 'failure' | null; readonly obligations?: readonly RunObligation[] } | null;
  readonly reclaimed?: { readonly at: string; readonly delivery: string };
  /** Bytes an ended, unlanded run still holds, measured once when first published after it ended. */
  readonly heldBytes?: number;
  readonly heldSpacePending?: true;
  readonly interruption?: { readonly detail: 'interrupted by restart' | 'interrupted'; readonly resume: string };
  readonly host: { readonly activation?: { readonly owner: Owner | null; readonly state: 'active' | 'inactive' | 'unknown'; readonly checkedAt: string | null }; readonly boot?: string; readonly readiness?: 'applied' | 'unavailable' | 'refused'; readonly interpretation: readonly string[] };
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

export type JournalPayload = (
  | { readonly type: 'command_activity'; readonly owner: Owner; readonly key: CommandKey; readonly state: CommandActivity['state']; readonly notice?: 'no observed progress for 10 min' }
  /** A command passed its declared `durationMs` and keeps running: the run needs its operator to let it finish or cancel. One per reservation. */
  | { readonly type: 'command_limit'; readonly key: CommandKey }
  | { readonly type: 'obligation'; readonly obligation: RunObligation; readonly open: boolean }
  | { readonly type: 'accounting_interrupted' }
  | { readonly type: 'owner_closed'; readonly owner: Owner }
  | { readonly type: 'run_reclaimed'; readonly at: string; readonly delivery: string }
  | { readonly type: 'delivery_preserved'; readonly at: string; readonly delivery: string }
  | { readonly type: 'reclaim_completed' }
  | { readonly type: 'held_measured'; readonly ending: number; readonly bytes: number }
  | { readonly type: 'preparation_ended'; readonly state: 'refused' | 'cancelled'; readonly detail: string }
  | { readonly type: 'run_authority'; readonly authority: RunAuthority }
  // One complete preparation binds originals and measurement; null remains readable in historical records.
  | {
    readonly type: 'setup_prepared'; readonly request: SetupRequest; readonly unit: RunRef;
    readonly baselines: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[]; readonly tree?: Hash }; readonly measured: SetupEvidence | null
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
  | { readonly type: 'lifecycle'; readonly conclusion: Conclusion }
);

/** Ownership exists before a runtime digest or a copy can exist. Paths are derived from the run id. */
export interface Preparation {
  readonly project: string;
  readonly brief: AdmittedBrief;
  readonly authority: string;
  readonly owner: Owner;
  readonly requester?: string;
}
export interface PreparationState {
  readonly preparation: Preparation;
  readonly status: RunStatus;
  readonly admitted: boolean;
  readonly unit?: RunRef;
  readonly reason?: string;
  readonly reclaimed?: { readonly at: string; readonly delivery: string };
  readonly delivery?: { readonly at: string; readonly delivery: string };
}

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
  readonly timeline?: RunTimeline;
  readonly reclaimed?: { readonly at: string; readonly delivery: string };
  readonly delivery?: { readonly at: string; readonly delivery: string };
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
  readonly closedOwners: readonly Owner[];
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
