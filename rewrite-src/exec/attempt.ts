import { putEvidence } from '../records/state.js';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Result } from '../contract/brief.js';
import { answerSchema } from '../contract/answers.js';
import type { Adapter, AttemptReceipt, AttemptRequest, BackendRequest } from '../contract/runtime.js';
import { type ProcessPorts } from '../host/process.js';
import { captureTree, type ContentScope } from '../records/content.js';
import { executionFenced, readEvents } from '../records/state.js';
import { readEvidence } from '../records/evidence.js';
import { validateRecordRef } from '../records/evidence.js';
import { composeInput } from './input.js';

/** Concrete one-invocation resources, without routing or retry policy. */
export interface ExecutionContext {
  readonly scope: ContentScope;
  readonly adapter: Adapter;
  readonly process: ProcessPorts;
  readonly configRoot: string;
  readonly privateEnvironment: Readonly<Record<string, string>>;
  readonly abort: AbortSignal;
}
const same = isDeepStrictEqual;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Invoke one durably identified request and authenticate its answer/evidence. */
export async function runAttempt(request: AttemptRequest, context: ExecutionContext): Promise<Result<AttemptReceipt>> {
  const { scope } = context;
  // Bad engine-owned schema contexts are programming errors, before any invocation.
  const schema = answerSchema(request.context);
  const events = await readEvents(scope.journal, 0);
  if (!events.ok) return events;
  const facts = events.value.map(event => event.payload);
  const launches = facts.filter(value => value.type === 'admitted');
  const launch = launches.at(-1)?.launch;
  const plans = facts.filter(value => value.type === 'plan_committed');
  const currentPlan = plans.at(-1)?.plan;
  const invocation = request.invocation;
  const paidIndex = facts.map(value => value.type === 'invocation_reserved' && same(value.invocation, invocation)).lastIndexOf(true);
  const ids = (values: readonly string[]) => [...values].sort();
  if (!launch || !currentPlan || !same(currentPlan, request.plan)
    || launch.run !== request.address.run || request.address.run !== scope.layout.location.run
    || !same(launch.brief, request.brief) || !launch.roles.some(value => same(value, request.role))
    || !same(ids(request.context.roleIds), ids(launch.roles.map(value => value.id)))
    || !same(ids(request.context.commandIds), ids(request.brief.declaration.commands.map(value => value.id)))
    || !same(ids(request.context.criterionIds), ids(request.brief.declaration.criteria.map(value => value.id)))
    || !same(ids(request.context.resultIds), ids(request.brief.declaration.results.map(value => value.id)))
    || request.context.allowBlocked !== request.brief.declaration.allowBlocked
    || invocation.charge === 'command' || !same(invocation.address, { kind: 'stage', ...request.address })
    || facts.filter(value => value.type === 'invocation_reserved' && same(value.invocation, invocation)).length !== 1
    || !same(facts.filter(value => value.type === 'invocation_reserved').at(-1)?.invocation, invocation)
    || facts.slice(paidIndex + 1).some(value => value.type === 'ownership' || value.type === 'process')
    || facts.some(value => value.type === 'attempt_settled' && same(value.receipt.address, request.address))
    || executionFenced(events.value, paidIndex))
    return { ok: false, kind: 'conflict', detail: 'Unpaid, stale, settled or fenced attempt' };
  if (request.guidance?.length && (request.stage.purpose === 'gate' || request.guidance.some(guide =>
    !facts.slice(0, paidIndex).some(value => value.type === 'control_intent' && value.intent.kind === 'guide'
      && value.intent.id === guide.intent && value.intent.expectedCursor === guide.cursor
      && same(value.intent.intervention, guide.intervention))
    || facts.some(value => value.type === 'attempt_settled' && value.receipt.guidance?.includes(guide.intent)))))
    return { ok: false, kind: 'conflict', detail: 'Uncommitted or consumed guidance' };
  const before = request.before ? { ok: true as const, value: request.before } : await captureTree(scope);
  if (!before.ok) return before;
  const input = await composeInput(request, schema, scope, context.configRoot, before.value);
  if (!input.ok) return input;
  const scratch = input.value.workspace;
  const preferences = scope.authority.preferences.find(value => value.role === request.role.id && value.backend === request.role.backend);
  if (!preferences) return { ok: false, kind: 'conflict', detail: 'Role/backend lacks prepared model preferences' };
  const backend: BackendRequest = {
    preferences: preferences.settings, attempt: request.address, role: request.role, input: input.value.input, instruction: input.value.instruction,
    schema: schema.json, project: scope.layout.project, scratch,
    ...(scope.git ? { git: { ...scope.git, privateDir: resolve(scratch, 'git') } } : {}),
    abort: context.abort, live: request.live
  };
  const dispatch = await readEvents(scope.journal, 0);
  if (!dispatch.ok) return dispatch;
  if (context.abort.aborted || executionFenced(dispatch.value, paidIndex))
    return { ok: false, kind: 'conflict', detail: 'Attempt fenced before dispatch' };
  const invoked = await context.adapter.invoke(backend);
  if (!invoked.ok) return invoked;
  const reply = invoked.value;
  // Both real adapters publish this request-bound native carrier. A locator alone is insufficient.
  for (const ref of [...reply.nativeCommands, ...reply.usage.raw]) {
    const authenticated = await validateRecordRef(scope.journal, ref);
    if (!authenticated.ok) return authenticated;
  }
  const raw = await validateRecordRef(scope.journal, reply.raw);
  if (!raw.ok) return raw;
  const rawBytes = await readEvidence(scope.journal, raw.value);
  if (!rawBytes.ok) return rawBytes;
  let envelope: Record<string, unknown>;
  try { envelope = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes.value))); }
  catch { return { ok: false, kind: 'invalid', detail: 'Invalid native request carrier' }; }
  if (!same(envelope.attempt, request.address) || !same(envelope.role, request.role)
    || !same(envelope.input, input.value.input) || !same(envelope.answerBytes, reply.answerBytes))
    return { ok: false, kind: 'conflict', detail: 'Native answer carrier belongs to a different request' };
  const schemaRef = envelope.schema;
  if (!schemaRef || typeof schemaRef !== 'object' || Array.isArray(schemaRef)
    || typeof object(schemaRef).path !== 'string' || typeof object(schemaRef).sha256 !== 'string')
    return { ok: false, kind: 'invalid', detail: 'Missing native schema carrier' };
  const boundSchema = await readEvidence(scope.journal, schemaRef as { path: string; sha256: string });
  if (!boundSchema.ok) return boundSchema;
  if (new TextDecoder().decode(boundSchema.value) !== JSON.stringify(schema.json))
    return { ok: false, kind: 'conflict', detail: 'Native generation schema differs from receiving schema' };
  const refusals: import('../contract/brief.js').Ref[] = [];
  const refuse = async (refusal: Extract<Result<never>, { ok: false }>) => {
    const saved = await putEvidence(scope.journal, Buffer.from(JSON.stringify({ refusal })));
    if (saved.ok) refusals.push(saved.value);
    return saved;
  };
  let answer: AttemptReceipt['answer'];
  let ending = reply.ending;
  if (reply.answerBytes !== undefined) {
    const carrier = await validateRecordRef(scope.journal, reply.answerBytes);
    if (!carrier.ok) return carrier;
    const bytes = await readEvidence(scope.journal, carrier.value);
    if (!bytes.ok) return bytes;
    try {
      const parsed = schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.value)));
      if (parsed.ok) answer = parsed.value;
      else { const saved = await refuse(parsed); if (!saved.ok) return saved; }
    } catch (error) {
      const saved = await refuse({ ok: false, kind: 'invalid', detail: `Answer must be valid JSON: ${String(error)}` });
      if (!saved.ok) return saved;
    }
  }
  if (ending === 'delivered' && answer === undefined) {
    if (!reply.answerBytes) { const saved = await refuse({ ok: false, kind: 'invalid', detail: 'Delivered answer requires native answer bytes' }); if (!saved.ok) return saved; }
    ending = request.stage.purpose === 'plan' ? 'invalid_plan' : 'invalid_answer';
  }
  if (reply.closure !== 'dead' && reply.closure !== 'reused') ending = 'closure_unknown';
  const after = await captureTree(scope);
  if (!after.ok) return after;
  const audit = await putEvidence(scope.journal, new TextEncoder().encode(JSON.stringify({
    address: request.address,
    invocation, before: before.value, after: after.value, input: input.value.input, ...(input.value.review ? { review: input.value.review } : {}), raw: raw.value,
    closure: reply.closure
  })));
  if (!audit.ok) return audit;
  return {
    ok: true, value: {
      ...(input.value.reusedCommands.length ? {reusedCommands:input.value.reusedCommands} : {}),
      address: request.address, ending, answer, answerRef: reply.answerBytes,
      before: before.value, after: after.value, audit: audit.value, closure: reply.closure, usage: reply.usage,
      evidence: [input.value.input, raw.value, ...reply.nativeCommands, ...refusals], inputChars: input.value.chars,
      ...(reply.resetAt !== undefined ? { resetAt: reply.resetAt } : {}),
      ...(request.guidance ? { guidance: request.guidance.map(guide => guide.intent) } : {})
    }
  };
}
