import { putEvidence } from '../records/state.js';
import { authorityGrant } from '../exec/policy.js';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Result } from '../contract/brief.js';
import { answerSchema } from '../contract/answers.js';
import type { Adapter, AttemptReceipt, AttemptRequest, GrantReceipt, GrantRequest, BackendRequest } from '../contract/runtime.js';
import { checkReadiness, type ProcessPorts } from '../host/process.js';
import { captureTree, type ContentScope } from '../records/content.js';
import { readEvents } from '../records/state.js';
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
    || facts.some(value => value.type === 'control_intent' && value.intent.kind === 'cancel' || value.type === 'lifecycle'))
    return { ok: false, kind: 'conflict', detail: 'Unpaid, stale, settled or fenced attempt' };
  if (request.guidance?.length && (request.stage.purpose === 'gate' || request.guidance.some(guide =>
    !facts.slice(0, paidIndex).some(value => value.type === 'control_intent' && value.intent.kind === 'guide'
      && value.intent.id === guide.intent && value.intent.expectedCursor === guide.cursor
      && same(value.intent.intervention, guide.intervention))
    || facts.some(value => value.type === 'attempt_settled' && value.receipt.guidance?.includes(guide.intent)))))
    return { ok: false, kind: 'conflict', detail: 'Uncommitted or consumed guidance' };
  const input = await composeInput(request, schema, scope, context.configRoot);
  if (!input.ok) return input;
  const before = await captureTree(scope);
  if (!before.ok) return before;
  let scratch: string;
  try {
    const parent = resolve(scope.layout.location.storeRoot, 'work', request.address.run, 'stages', request.address.stage, request.address.attempt);
    await mkdir(parent, { recursive: true });
    scratch = resolve(parent, String(request.address.invocation));
    await mkdir(scratch); // Exclusive invocation workspace: a paid call cannot be entered twice.
  } catch (error) { return { ok: false, kind: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'conflict' : 'unavailable',
    detail: String(error) }; }
  const grant = authorityGrant(scope.authority, request.stage.purpose, scratch, request.role.backend, scope.git);
  const preferences = scope.authority.preferences.find(value => value.role === request.role.id && value.backend === request.role.backend);
  if (!preferences) return { ok: false, kind: 'conflict', detail: 'Role/backend lacks prepared model preferences' };
  const { writableRoots } = grant;
  const author = request.stage.purpose === 'work';
  const backend: BackendRequest = {
    preferences: preferences.settings, attempt: request.address, role: request.role, input: input.value.input,
    schema: schema.json, project: scope.layout.project, scratch, ...grant,
    abort: context.abort
  };
  const dispatch = await readEvents(scope.journal, 0);
  if (!dispatch.ok) return dispatch;
  if (context.abort.aborted || dispatch.value.some(event => event.payload.type === 'control_intent' && event.payload.intent.kind === 'cancel'
    || event.payload.type === 'lifecycle'))
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
    } catch { /* Malformed answers are retained for paid correction by the caller. */ }
  }
  if (ending === 'delivered' && answer === undefined) ending = request.stage.purpose === 'plan' ? 'invalid_plan' : 'invalid_answer';
  if (reply.closure !== 'dead' && reply.closure !== 'reused') ending = 'closure_unknown';
  const after = await captureTree(scope);
  if (!after.ok) return after;
  if (!author && before.value !== after.value) ending = 'isolation_failure';
  const audit = await putEvidence(scope.journal, new TextEncoder().encode(JSON.stringify({
    address: request.address,
    invocation, before: before.value, after: after.value, input: input.value.input, raw: raw.value,
    writableRoots, protectedRoots: backend.protectedRoots, closure: reply.closure
  })));
  if (!audit.ok) return audit;
  return {
    ok: true, value: {
      address: request.address, ending, answer, answerRef: reply.answerBytes,
      before: before.value, after: after.value, audit: audit.value, closure: reply.closure, usage: reply.usage,
      evidence: [input.value.input, raw.value, ...reply.nativeCommands], inputChars: input.value.chars,
      ...(reply.resetAt !== undefined ? { resetAt: reply.resetAt } : {}),
      ...(request.guidance ? { guidance: request.guidance.map(guide => guide.intent) } : {})
    }
  };
}

/** Probe the actual grant without invoking a provider executable. */
export async function probeExecution(grant: GrantRequest, context: Pick<ExecutionContext,
  'scope' | 'process' | 'privateEnvironment' | 'abort'>): Promise<Result<GrantReceipt>> {
  const scope = context.scope;
  return {
ok: true, value: await checkReadiness(grant, {
      argv: ['/usr/bin/true'], cwd: scope.layout.project,
      env: context.privateEnvironment, writableRoots: grant.writableRoots
    }, context.process, context.abort)
};
}
