import { commandContext } from '../exec/policy.js';
import { mkdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { idSchema, type DeclaredCommand, type Hash, type Ref, type Result } from '../contract/brief.js';
import type { BaseRun, CommandExecution, CommandKey, CommandReceipt, Owner, Reservation, Writer, ProcessReceipt } from '../contract/runtime.js';
import { launchInvocation, type ProcessPorts } from '../host/process.js';
import { captureGeneration, hashInputs, contentDelta, materializeProject, type ContentScope } from '../records/content.js';
import { publishedEvidence } from '../records/evidence.js';
import { readCommand, commitCommand, type JournalPayload } from '../records/state.js';
import { executionFenced, readEvents } from '../records/state.js';

/** One immutable declaration and run-local invocation reservation. */
export interface CommandRequest {
  readonly command: DeclaredCommand;
  readonly key: CommandKey;
  readonly reservation: Reservation;
  /** Classify a failing required command against the base tree. The final gate command phase sets it: publication is decided only there. */
  readonly againstBase?: boolean;
}
/** Execution resources without retry or publication policy. */
export interface CommandContext {
  readonly scope: ContentScope;
  readonly writer: Writer;
  readonly process: ProcessPorts;
  readonly abort: AbortSignal;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export const commandDeclarationIdentity = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** Identify exact declaration, tree, input identities and fixed run context. The tree is read from the project unless the caller
 * passes the capture it already holds (its recorded hash; the manifest was published with it). Only the inputs the command
 * declares are read: the key binds no others. */
export async function identifyCommand(command: DeclaredCommand, scope: ContentScope, stored?: CommandKey['execution'], held?: Hash): Promise<Result<CommandKey>> {
  if (!scope.brief.declaration.commands.some(value => same(value, command)))
    return { ok: false, kind: 'conflict', detail: 'Command differs from operator declaration' };
  const indices = command.inputs.map(id => scope.brief.declaration.inputs.findIndex(input => input.id === id));
  if (indices.some(index => index < 0)) return { ok: false, kind: 'invalid', detail: 'Undeclared command input' };
  const tree = held ? await publishedEvidence(scope.journal, held) : await captureGeneration(scope);
  if (!tree.ok) return tree;
  const inputs = await hashInputs(scope, indices);
  if (!inputs.ok) return inputs;
  const execution = commandContext(scope.authority, command, stored?.id ?? `exec_${randomUUID()}`);
  if (stored && !same(stored, execution)) return { ok: false, kind: 'conflict', detail: 'Stored command context differs from policy' };
  return {
    ok: true, value: {
      generation: tree.value, execution, tree: tree.value.sha256, declaration: commandDeclarationIdentity(command),
      inputHashes: inputs.value.map(ref => ref.sha256),
      context: commandDeclarationIdentity({
        layout: scope.layout, journal: scope.journal.root, brief: scope.brief.digest,
        inputBaseline: scope.inputBaseline, outputBaseline: scope.outputBaseline, authority: scope.authority, execution
      })
    }
  };
}

/** Reuse or execute one authenticated reservation and commit its direct receipt. */
export async function runDeclaredCommand(request: CommandRequest, context: CommandContext): Promise<Result<CommandReceipt>> {
  const { scope, writer } = context;
  if (!idSchema.safeParse(request.reservation.identity).success)
    return { ok: false, kind: 'invalid', detail: 'Invalid reservation identity' };
  if (writer.journal.root !== scope.journal.root || writer.kind !== 'execution')
    return { ok: false, kind: 'conflict', detail: 'Command writer scope mismatch' };
  // Fresh read: the key must still describe the bytes this command is about to run on.
  const identified = await identifyCommand(request.command, scope, request.key.execution);
  if (!identified.ok) return identified;
  if (!same(identified.value, request.key) || !same(request.key, request.reservation.key))
    return { ok: false, kind: 'conflict', detail: 'Command identity changed before execution' };
  const recorded = await readCommand(scope.journal, request.key);
  if (!recorded.ok) return recorded;
  const reservation = recorded.value;
  if (!reservation || reservation.identity !== request.reservation.identity || !same(reservation.key, request.reservation.key)
    || !same(reservation.invocation, request.reservation.invocation))
    return { ok: false, kind: 'conflict', detail: 'Reservation not authenticated' };
  if (reservation.state === 'committed') {
    if (reservation.receipt.command !== request.command.id)
      return { ok: false, kind: 'conflict', detail: 'Committed command identity mismatch' };
    return { ok: true, value: reservation.receipt };
  }
  // The journal conservatively folds unresolved reservations as uncertain; only the fresh reserve return authorizes this execution.
  if (request.reservation.state === 'uncertain') return { ok: false, kind: 'unknown', detail: 'Uncertain reservation cannot execute' };
  if (request.reservation.state !== 'reserved') return { ok: false, kind: 'conflict', detail: 'Reservation state mismatch' };
  const invocation = reservation.invocation;
  if (invocation.charge !== 'command' || invocation.address.run !== scope.layout.location.run)
    return { ok: false, kind: 'conflict', detail: 'Invalid command invocation' };
  const facts = await readEvents(scope.journal, 0);
  if (!facts.ok) return facts;
  const reservedIndex = facts.value.map(event => event.payload.type === 'command_reserved'
    && same(event.payload.reservation, request.reservation)).lastIndexOf(true);
  if (executionFenced(facts.value, reservedIndex))
    return { ok: false, kind: 'conflict', detail: 'Command execution fenced' };
  if (reservedIndex < 0 || facts.value.slice(reservedIndex + 1).some(event => event.payload.type === 'ownership' || event.payload.type === 'process'))
    return { ok: false, kind: 'unknown', detail: 'Reservation has unresolved process evidence' };
  let scratch: string;
  try {
    if (!request.key.execution) return { ok: false, kind: 'invalid', detail: 'Command reservation lacks effective execution context' };
    scratch = request.key.execution.scratch;
    await mkdir(resolve(scratch, '..'), { recursive: true });
    await mkdir(scratch); // One execution owns its reserved context.
  } catch (error) {
    return { ok: false, kind: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'conflict' : 'unavailable', detail: String(error) };
  }
  // Main and base runs belong to one reservation. One callback records its limit once, through the process writer's queue.
  let limit: Promise<Result<number>> | undefined;
  const io = { onLimit: () => limit ??= context.process.recordProcess({ type: 'command_limit', key: request.key }) };
  const before = request.key.tree;
  const measured = await measure(launchInvocation({}, {
    argv: request.command.argv, cwd: scope.layout.project,
    env: request.key.execution!.env, durationMs: request.command.durationMs
  }, context.process, context.abort, io), context);
  if (!measured.ok) return measured;
  const { execution, stdout, stderr, refusal } = measured.value;
  // The main command's tree and receipt facts are fixed here, before anything else runs. An output that changed while the tree was
  // read (a writer outside the containment) is a fact of this command and goes into its receipt; any other failure of the
  // observation is a failure of the run, as before.
  const observed = await observeAfter(scope, request.key.generation!);
  if ('ok' in observed) return observed;
  const main: CommandReceipt = {
    key: request.key, command: request.command.id, execution, stdout, stderr,
    before, ...observed,
    spent: { durationMs: measured.value.durationMs }, ...(measured.value.owner ? { owner: measured.value.owner } : {})
  };
  // A failing required command is classified against the base; a passing one costs nothing extra.
  // Operational failures on the base, as on the main run, prevent a command receipt.
  const base = request.againstBase && request.command.required && execution.state === 'complete' && execution.exit !== 0 && !context.abort.aborted
    ? await runOnBase(request, context, baseTree(facts.value, reservedIndex), io) : undefined;
  if (base && !base.ok) return base;
  const receipt: CommandReceipt = base ? { ...main, base: base.value } : main;
  // Process recording may have advanced the journal; never use the opening writer cursor.
  const fresh = await readEvents(scope.journal, 0);
  if (!fresh.ok) return fresh;
  const committed = await commitCommand(writer, fresh.value.at(-1)?.seq ?? 0, reservation, receipt);
  return !committed.ok ? committed : refusal ?? { ok: true, value: receipt };
}

/** What the command left: its tree and the delta from `from`. Only the capture's `output_changed` (a declared output changed while the tree
 * was read) is the command's `unpinned` result. Every other failure, a `conflict` of any other source included, is returned as it is. */
async function observeAfter(scope: ContentScope, from: Ref): Promise<Pick<CommandReceipt, 'after' | 'delta'> | Pick<CommandReceipt, 'unpinned'> | Extract<Result<never>, { ok: false }>> {
  const after = await captureGeneration(scope);
  if (!after.ok) return after.kind === 'output_changed' ? { unpinned: { detail: after.detail } } : after;
  const delta = await contentDelta(scope.journal, from, after.value);
  return delta.ok ? { after: after.value.sha256, delta: delta.value } : delta;
}

interface Measured {
  readonly execution: CommandExecution; readonly stdout: Ref; readonly stderr: Ref; readonly durationMs: number; readonly owner?: Owner;
  /** The launch refusal when the program never ran to a receipt; the receipt is still recorded, then the refusal returned. */
  readonly refusal?: Extract<Result<never>, { ok: false }>;
}
/** Evidence for a launch that left no process behind: nothing on stdout, the refusal on stderr. */
async function refusalStreams(context: CommandContext, refusal: unknown): Promise<Result<{ readonly stdout: Ref; readonly stderr: Ref }>> {
  const stderr = await context.process.putEvidence(Buffer.from(JSON.stringify({ refusal })));
  if (!stderr.ok) return stderr;
  const stdout = await context.process.putEvidence(new Uint8Array());
  return stdout.ok ? { ok: true, value: { stdout: stdout.value, stderr: stderr.value } } : stdout;
}
/** Describe one launched program as a command receipt does. Unknown/conflicting launches leave no measurement to describe. */
async function measure(launched: Promise<Result<ProcessReceipt>>, context: CommandContext): Promise<Result<Measured>> {
  const spawned = await launched;
  if (!spawned.ok && (spawned.kind === 'unknown' || spawned.kind === 'conflict')) return spawned;
  const process = spawned.ok ? spawned.value : undefined;
  let execution: CommandExecution;
  if (!process || process.state === 'not_started') execution = { state: 'not_started', reason: 'preparation_failed' };
  else if (process.state === 'closure_unknown') execution = { state: 'unfinished', reason: 'closure_unknown' };
  else if (process.terminationCause) execution = { state: 'unfinished', reason: process.terminationCause };
  else if (process.signal !== null) execution = { state: 'unfinished', reason: 'signalled', signal: process.signal };
  else if (process.exit !== null && process.signal === null) execution = { state: 'complete', exit: process.exit };
  else execution = { state: 'unfinished', reason: 'closure_unknown' };
  const streams = process ? { ok: true as const, value: { stdout: process.stdout, stderr: process.stderr } } : await refusalStreams(context, spawned);
  // The evidence of a refused launch could not be written: the refusal that led here stays beside that failure.
  if (!streams.ok) return spawned.ok ? streams : { ...streams, detail: `${streams.detail}; launch refused: ${spawned.kind}: ${spawned.detail}` };
  return { ok: true, value: { execution, ...streams.value, durationMs: process?.durationMs ?? 0, ...(process?.owner ? { owner: process.owner } : {}),
    ...(!spawned.ok ? { refusal: spawned } : {}) } };
}

/** The admitted original: the first tree this run recorded, before any author or command wrote. The search ends at the
 * reservation being executed, whose own `command_reserved` event always matches. */
function baseTree(facts: readonly { readonly payload: JournalPayload }[], reservedIndex: number): Hash {
  return facts.slice(0, reservedIndex + 1).map(({ payload }) => payload.type === 'command_reserved' ? payload.reservation.key.tree
    : payload.type === 'attempt_received' || payload.type === 'attempt_settled' ? payload.receipt.before : undefined).find(tree => tree !== undefined)!;
}

/** Run the command on a private base copy. Observation/launch failures stay run-level; placement failures describe the base only. */
async function runOnBase(request: CommandRequest, context: CommandContext, tree: Hash, io: { onLimit: () => Promise<Result<number>> }): Promise<Result<BaseRun>> {
  const { scope } = context, { command } = request;
  const execution = commandContext(scope.authority, command, `${request.key.execution!.id}_base`);
  const project = `${execution.scratch}.tree`;
  const base = await (async (): Promise<Result<BaseRun>> => {
    await mkdir(execution.scratch);
    const placed = await materializeProject(scope.journal, tree, project);
    if (!placed.ok) return { ok: true, value: { tree, ok: false, kind: 'not_placed', detail: `${placed.kind}: ${placed.detail}` } };
    const measured = await measure(launchInvocation({}, { argv: command.argv, cwd: project, env: execution.env,
      durationMs: command.durationMs }, context.process, context.abort, io), context);
    if (!measured.ok) return measured;
    const { execution: ended, stdout, stderr, durationMs, refusal } = measured.value;
    return { ok: true, value: { tree, ok: true, execution: ended, stdout, stderr, spent: { durationMs }, ...(refusal ? { refusal: { kind: refusal.kind, detail: refusal.detail } } : {}) } };
  })().catch((error: unknown): Result<BaseRun> => ({ ok: true, value: { tree, ok: false, kind: 'threw', detail: String(error) } }));
  const left = await rm(project, { recursive: true, force: true }).then(() => undefined, (error: unknown) => `copy not removed: ${String(error)}`);
  return left ? base.ok ? { ok: true, value: { ...base.value, detail: [base.value.detail, left].filter(Boolean).join('; ') } }
    : { ...base, detail: `${base.detail}; ${left}` } : base;
}
