import { authorityGrant, commandContext } from '../exec/policy.js';
import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { idSchema, type DeclaredCommand, type Result } from '../contract/brief.js';
import type { CommandKey, CommandReceipt, Reservation, Writer, ProcessReceipt } from '../contract/runtime.js';
import { launchInvocation, type ProcessPorts } from '../host/process.js';
import { captureGeneration, hashInputs, observePaths, contentDelta, type ContentScope } from '../records/content.js';
import { readCommand, commitCommand } from '../records/state.js';
import type { CommandRelation } from '../contract/plan.js';
import { readEvents, readProjection } from '../records/state.js';

/** One immutable declaration and run-local invocation reservation. */
export interface CommandRequest {
  readonly command: DeclaredCommand;
  readonly key: CommandKey;
  readonly reservation: Reservation;
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
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** Identify exact declaration, tree, input identities and fixed run context. */
export async function identifyCommand(command: DeclaredCommand, scope: ContentScope, stored?: CommandKey['execution'],
  observation?: CommandRelation): Promise<Result<CommandKey>> {
  if (!scope.brief.declaration.commands.some(value => same(value, command)))
    return { ok: false, kind: 'conflict', detail: 'Command differs from operator declaration' };
  const tree = await captureGeneration(scope);
  if (!tree.ok) return tree;
  const inputs = await hashInputs(scope);
  if (!inputs.ok) return inputs;
  if (inputs.value.length !== scope.brief.declaration.inputs.length)
    return { ok: false, kind: 'invalid', detail: 'Declared input identity count mismatch' };
  const indices = command.inputs.map(id => scope.brief.declaration.inputs.findIndex(input => input.id === id));
  if (indices.some(index => index < 0)) return { ok: false, kind: 'invalid', detail: 'Undeclared command input' };
  const execution = commandContext(scope.authority, command, stored?.id ?? `exec_${randomUUID()}`);
  if (stored && !same(stored, execution)) return { ok: false, kind: 'conflict', detail: 'Stored command context differs from policy' };
  return {
    ok: true, value: {
      ...(observation ? { observation } : {}), generation: tree.value, execution, tree: tree.value.sha256, declaration: hash(command),
      inputHashes: indices.map(index => inputs.value[index].sha256),
      context: hash({
        layout: scope.layout, journal: scope.journal.root, brief: scope.brief.digest,
        observation, inputBaseline: scope.inputBaseline, outputBaseline: scope.outputBaseline, authority: scope.authority, execution
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
  const identified = await identifyCommand(request.command, scope, request.key.execution, request.key.observation);
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
  if (facts.value.some(event => event.payload.type === 'control_intent' && event.payload.intent.kind === 'cancel'
    || event.payload.type === 'lifecycle'))
    return { ok: false, kind: 'conflict', detail: 'Command execution fenced' };
  const reservedIndex = facts.value.map(event => event.payload.type === 'command_reserved'
    && event.payload.reservation.identity === reservation.identity).lastIndexOf(true);
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
  const projection = await readProjection(scope.journal);
  const paths = [...(projection.ok ? projection.value.commands.flatMap(item => item.key.observation?.sources ?? []) : []),
    ...(request.key.observation?.sources ?? []), ...(request.key.observation?.products ?? [])];
  const observedBefore = await observePaths(scope, paths);
  if (!observedBefore.ok) return observedBefore;
  const before = request.key.tree;
  const grant = authorityGrant(scope.authority, 'command', scratch, undefined, undefined, request.command.id);
  const { writableRoots } = grant;
  let process: ProcessReceipt | undefined;
  const spawned = await launchInvocation(grant, {
    argv: request.command.argv, cwd: scope.layout.project,
    env: request.key.execution!.env, writableRoots, durationMs: request.command.durationMs
  }, context.process, context.abort);
  if (!spawned.ok && (spawned.kind === 'unknown' || spawned.kind === 'conflict')) return spawned;
  if (spawned.ok) process = spawned.value;
  let execution: CommandReceipt['execution'];
  if (!process || process.state === 'not_started') execution = { state: 'not_started', reason: 'preparation_failed' };
  else if (process.state === 'closure_unknown') execution = { state: 'unfinished', reason: 'closure_unknown' };
  else if (context.abort.aborted) execution = { state: 'unfinished', reason: 'cancelled' };
  else if (process.signal !== null && request.command.durationMs !== undefined && process.durationMs >= request.command.durationMs)
    execution = { state: 'unfinished', reason: 'duration' };
  else if (process.exit !== null && process.signal === null) execution = { state: 'complete', exit: process.exit };
  else execution = { state: 'unfinished', reason: 'closure_unknown' };
  const empty = process ? undefined : await context.process.putEvidence(new Uint8Array());
  if (empty && !empty.ok) return empty;
  const stdout = process?.stdout ?? (empty && empty.ok ? empty.value : undefined);
  const stderr = process?.stderr ?? stdout;
  if (!stdout || !stderr) return { ok: false, kind: 'unknown', detail: 'Missing command stream evidence' };
  const afterKey = await identifyCommand(request.command, scope, request.key.execution, request.key.observation);
  if (!afterKey.ok) return afterKey;
  const observedAfter = await observePaths(scope, paths);
  if (!observedAfter.ok) return observedAfter;
  const delta = await contentDelta(scope.journal, request.key.generation!, afterKey.value.generation!);
  if (!delta.ok) return delta;
  const receipt: CommandReceipt = {
    key: request.key, command: request.command.id, execution, stdout, stderr,
    before, after: afterKey.value.tree, observed: { before: observedBefore.value, after: observedAfter.value },
    delta: delta.value,
    spent: { durationMs: process?.durationMs ?? 0 }, ...(process?.owner ? { owner: process.owner } : {})
  };
  // Process recording may have advanced the journal; never use the opening writer cursor.
  const fresh = await readEvents(scope.journal, 0);
  if (!fresh.ok) return fresh;
  const committed = await commitCommand(writer, fresh.value.at(-1)?.seq ?? 0, reservation, receipt);
  return committed.ok ? { ok: true, value: receipt } : committed;
}
