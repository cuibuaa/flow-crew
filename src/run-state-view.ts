import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { parseGuidanceLedger, type GuidanceEnvelope } from './guidance.js';
import { readResourceLeaseRegistry, resourceLeaseRegistryPath, type ResourceLeaseRegistryRead } from './resource-leases.js';
import { STAGE_STATUS, readArchivedRunState, runDir, type ArchivedStoreState, type StageAttempt, type StageStatus } from './store.js';

const safeId = z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/);
const nonempty = z.string().min(1);
const timestamp = nonempty.refine((value) => Number.isFinite(Date.parse(value)), 'expected an ISO timestamp');
const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);

const ArtifactSchema = z.object({
  id: nonempty,
  root: z.enum(['project', 'run']),
  path: nonempty,
  kind: z.enum(['file', 'directory']).default('file'),
  role: z.enum(['produce', 'read']).default('produce'),
  stageId: safeId.optional(),
  required: z.boolean().default(true),
  activation: z.enum(['active', 'inactive', 'unknown']).default('active'),
  group: nonempty.optional(),
  source: nonempty.default('admitted_declaration'),
}).strict();
const FindingSchema = z.object({
  id: nonempty,
  status: z.enum(['open', 'resolved']),
  paths: z.array(nonempty),
  stageId: safeId.optional(),
  gateId: safeId.optional(),
  reason: nonempty,
  criterionIds: z.array(nonempty).default([]),
  invalidatesPlan: z.boolean(),
  evidencePath: nonempty.optional(),
}).strict();
const PlanRevisionSchema = z.object({
  revision: quantity,
  digest,
  admittedAt: timestamp,
  reason: nonempty,
  path: nonempty.optional(),
}).strict();

/** Scheduler-owned read facts on the existing atomic run.json projection.
 * These describe admitted authority; the projector never grants it. */
export const RunQueryStateSchema = z.object({
  version: z.literal(1),
  planRevision: PlanRevisionSchema.optional(),
  planHistory: z.array(PlanRevisionSchema).default([]),
  artifacts: z.array(ArtifactSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  resourceRegistryPath: nonempty.refine(isAbsolute, 'expected an absolute registry path').optional(),
}).strict();
export type RunQueryState = z.input<typeof RunQueryStateSchema>;
export type QueryableStoreState = ArchivedStoreState & { queryState?: RunQueryState };

const InvocationSchema = z.object({
  version: z.literal(1),
  runId: nonempty,
  stageId: safeId,
  attemptIndex: quantity.positive(),
  attemptStartedAt: timestamp,
  invocationIndex: quantity.positive(),
  capturedAt: timestamp,
  boundary: z.enum(['adapter', 'model']),
  adapter: nonempty,
  model: nonempty,
  generation: nonempty.optional(),
  resumeSessionId: nonempty.optional(),
  guidanceIds: z.array(nonempty),
  systemPrompt: z.string(),
  userPrompt: z.string(),
  systemSha256: digest,
  userSha256: digest,
  /** Optional actual transport payload. Never record credentials or environment. */
  transport: z.object({ kind: z.enum(['stdin', 'argv', 'request']), payload: z.string(), sha256: digest }).strict().optional(),
}).strict();
export type InvocationInputRecord = z.infer<typeof InvocationSchema>;
export type InvocationInput = Omit<InvocationInputRecord, 'version' | 'capturedAt' | 'systemSha256' | 'userSha256' | 'guidanceIds' | 'transport'> & {
  capturedAt?: string;
  guidanceIds?: string[];
  transport?: { kind: 'stdin' | 'argv' | 'request'; payload: string };
};

export class RunStateViewError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'RunStateViewError';
  }
}

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function contained(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/** Reject lexical traversal and existing symlink escapes before reading/writing carriers. */
function carrierPath(root: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..') || !path || path.includes('\0')) throw new RunStateViewError('STATE_PATH_INVALID', `declare a confined relative path: ${path}`);
  const canonicalRoot = realpathSync(root);
  const candidate = resolve(canonicalRoot, path);
  if (!contained(canonicalRoot, candidate)) throw new RunStateViewError('STATE_PATH_INVALID', `path escapes its declared root: ${path}`);
  let ancestor = candidate;
  for (;;) {
    try {
      if (!contained(canonicalRoot, realpathSync(ancestor))) throw new RunStateViewError('STATE_PATH_ESCAPE', `path resolves outside its declared root: ${path}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (ancestor === canonicalRoot) throw error;
      ancestor = dirname(ancestor);
    }
  }
  return candidate;
}

function attemptKey(index: number, startedAt: string): string { return `attempt_${index}_${sha256(startedAt).slice(0, 24)}`; }
export function invocationInputPath(runDirectory: string, identity: Pick<InvocationInput, 'stageId' | 'attemptIndex' | 'attemptStartedAt' | 'invocationIndex'>): string {
  safeId.parse(identity.stageId);
  quantity.positive().parse(identity.attemptIndex);
  quantity.positive().parse(identity.invocationIndex);
  timestamp.parse(identity.attemptStartedAt);
  return carrierPath(runDirectory, join('stages', identity.stageId, 'invocations', attemptKey(identity.attemptIndex, identity.attemptStartedAt), `invocation_${identity.invocationIndex}.json`));
}

function checkedInvocation(value: unknown): InvocationInputRecord {
  const record = InvocationSchema.parse(value);
  if (sha256(record.systemPrompt) !== record.systemSha256 || sha256(record.userPrompt) !== record.userSha256
    || (record.transport && sha256(record.transport.payload) !== record.transport.sha256)) throw new RunStateViewError('INVOCATION_INPUT_HASH_MISMATCH', 'immutable invocation input bytes do not match their hashes');
  return record;
}

/** Publish after final rendering, before execution, for EVERY actual invocation.
 * A captured input proves supplied bytes at its boundary, not successful execution. */
export function recordInvocationInput(runDirectory: string, input: InvocationInput): { path: string; record: InvocationInputRecord } {
  const record = checkedInvocation({
    ...input,
    version: 1,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    guidanceIds: input.guidanceIds ?? [],
    systemSha256: sha256(input.systemPrompt),
    userSha256: sha256(input.userPrompt),
    ...(input.transport ? { transport: { ...input.transport, sha256: sha256(input.transport.payload) } } : {}),
  });
  const run = JSON.parse(readFileSync(carrierPath(runDirectory, 'run.json'), 'utf8')) as { runId?: unknown; stages?: Record<string, unknown>; supervise?: unknown; supervisor?: unknown; auxiliaryAttempts?: Record<string, unknown> };
  const knownActor = Object.hasOwn(run.stages ?? {}, record.stageId) || (record.stageId === '_supervisor' && (run.supervise === true || recordObject(run.supervisor) !== undefined)) || (record.stageId === '_summary' && Array.isArray(run.auxiliaryAttempts?._summary));
  if (run.runId !== record.runId || basename(resolve(runDirectory)) !== record.runId || !knownActor) throw new RunStateViewError('INVOCATION_RUN_BINDING', 'invocation must bind an initialized run and a known stage or configured supervisor');
  const path = invocationInputPath(runDirectory, record);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Recheck after directory creation; a preexisting outside-root symlink is never a capability.
  invocationInputPath(runDirectory, record);
  const temporary = `${path}.tmp.${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try { linkSync(temporary, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = checkedInvocation(JSON.parse(readFileSync(path, 'utf8')));
      const withoutCaptureTime = (entry: InvocationInputRecord): string => JSON.stringify({ ...entry, capturedAt: undefined });
      if (withoutCaptureTime(existing) !== withoutCaptureTime(record)) throw new RunStateViewError('INVOCATION_INPUT_CONFLICT', 'attempt/invocation identity already has different immutable input');
      return { path, record: existing };
    }
    const directoryFd = openSync(dirname(path), 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    return { path, record };
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* already absent */ }
  }
}

interface EvidenceSource { path: string; sha256: string | null; bytes: number | null; prefix?: number }
interface Diagnostic { code: string; path?: string; detail: string }

/** Optimistic read fence: no mutation, bounded retries, acknowledged prefixes stay prefixes. */
class ViewReadFence {
  readonly sources: EvidenceSource[] = [];
  readonly diagnostics: Diagnostic[] = [];
  private readonly checks: Array<() => boolean> = [];
  read(path: string, prefix?: number): string | undefined {
    const observe = (): Buffer | undefined => {
      try {
        const bytes = readFileSync(path);
        if (prefix !== undefined && bytes.length < prefix) throw new RunStateViewError('STATE_HISTORY_TRUNCATED', 'acknowledged history prefix is truncated');
        return prefix === undefined ? bytes : bytes.subarray(0, prefix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const bytes = observe();
    const expected = bytes === undefined ? undefined : sha256(bytes);
    this.sources.push({ path, sha256: expected ?? null, bytes: bytes?.length ?? null, ...(prefix === undefined ? {} : { prefix }) });
    this.checks.push(() => { const current = observe(); return (current === undefined ? undefined : sha256(current)) === expected; });
    return bytes?.toString('utf8');
  }
  json(path: string): unknown {
    const raw = this.read(path);
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch {
      this.diagnostics.push({ code: 'STATE_EVIDENCE_INVALID_JSON', path, detail: 'carrier is present but malformed; it was not treated as empty' });
      return undefined;
    }
  }
  list(path: string): string[] {
    const observe = (): string[] => {
      try { return readdirSync(path).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    };
    const names = observe();
    this.sources.push({ path, sha256: sha256(JSON.stringify(names)), bytes: null });
    this.checks.push(() => JSON.stringify(observe()) === JSON.stringify(names));
    return names;
  }
  watchValue<T>(observe: () => T): T {
    const value = observe();
    const expected = JSON.stringify(value);
    this.checks.push(() => JSON.stringify(observe()) === expected);
    return value;
  }
  stable(): boolean { return this.checks.every((check) => check()); }
}

export interface ArtifactObservation {
  declaration: z.infer<typeof ArtifactSchema>;
  /** Retained settlement receipt; checkedAt distinguishes it from current metadata. */
  settlement?: { checkedAt: string; bytes: number; members?: number; sha256: string; fresh: boolean };
  existence: { status: 'present' | 'absent' | 'type_mismatch' | 'invalid_path' | 'unreadable'; path?: string; kind?: 'file' | 'directory' | 'other'; bytes?: number; modifiedAt?: string; inode?: string; device?: string; links?: number; reason?: string };
}

function observeArtifact(projectDir: string, runDirectory: string, declaration: z.infer<typeof ArtifactSchema>): ArtifactObservation['existence'] {
  let path: string;
  const root = declaration.root === 'project' ? projectDir : runDirectory;
  try { path = carrierPath(root, declaration.path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', path: resolve(root, declaration.path) };
    return { status: 'invalid_path', reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const stats = statSync(path);
    const kind = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
    return { status: kind === declaration.kind ? 'present' : 'type_mismatch', path, kind, bytes: stats.size, modifiedAt: stats.mtime.toISOString(), inode: String(stats.ino), device: String(stats.dev), links: stats.nlink };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'absent', path } : { status: 'unreadable', path, reason: 'artifact metadata could not be observed' };
  }
}

function recordObject(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

export interface StateInvocationView {
  path: string;
  integrity: 'verified' | 'invalid';
  attemptBinding: 'matched' | 'unmatched';
  record?: Omit<InvocationInputRecord, 'systemPrompt' | 'userPrompt' | 'transport'> & { systemPrompt?: string; userPrompt?: string; transport?: { kind: 'stdin' | 'argv' | 'request'; payload?: string; sha256: string } };
  reason?: string;
}
export interface LegacyInputView { stageId: string; path: string; sha256: string; exact: false; reason: string; text?: string }
export interface GuidanceView { envelope: GuidanceEnvelope; sourcePath: string; deliveries: Array<Record<string, unknown>>; deliveryState: 'delivered' | 'queued' | 'quarantined' }

export interface RunStateView {
  version: 1;
  observedAt: string;
  snapshot: { runStateRevision: number | null; runStateSha256: string; evidenceSha256: string; sources: EvidenceSource[] };
  run: { runId: string; projectDir: string; workflowName: string; status: unknown; statusResolution: ReturnType<typeof readArchivedRunState>['status']; startedAt: string; completedAt?: string; currentIteration: number | null; failureReason?: string };
  plan: { stages: unknown[]; source: 'dispatchedStages' | 'plan' | 'unavailable'; revision: z.infer<typeof PlanRevisionSchema> | null; history: z.infer<typeof PlanRevisionSchema>[]; decisions: Record<string, import('./plan-revisions.js').PlanRevisionDecision>; admissionClaim: 'recorded' | 'unknown' };
  stages: Record<string, StageStatus>;
  histories: Pick<ArchivedStoreState, 'retiredStageUsage' | 'stageEvidence' | 'criterionDischarges' | 'unresolvedStageObligations' | 'supervisor' | 'auxiliaryAttempts'>;
  artifacts: ArtifactObservation[];
  artifactContracts: Array<{ stageId: string; path: string; record: unknown }>;
  budget: ReturnType<typeof budgetView>;
  resources: ResourceLeaseRegistryRead;
  resourceWaits: Array<{ stageId: string; attemptIndex: number; attemptStartedAt: string; requestId: string; waitStartedAt: string; reason: string }>;
  audits: { findings: z.infer<typeof FindingSchema>[]; openFindings: z.infer<typeof FindingSchema>[]; verdicts: Array<{ stageId: string; path: string; record: unknown }> };
  guidance: GuidanceView[];
  events: { rows: Array<Record<string, unknown>>; malformedRecords: number };
  prompts: { invocations: StateInvocationView[]; legacyInputs: LegacyInputView[]; coverage: 'recorded' | 'partial' | 'legacy_only' | 'none'; completeness: 'unknown'; missingAttemptInputs: Array<{ stageId: string; attemptIndex: number; attemptStartedAt: string }> };
  diagnostics: Diagnostic[];
}

function budgetView(state: ArchivedStoreState, observedAt: string) {
  const seen = new Set<string>();
  let knownInputTokens = 0, knownOutputTokens = 0, unknownTokenAttempts = 0, unknownLegacyStages = 0, knownAttemptDurationMs = 0, unknownDurationAttempts = 0;
  const add = (stageId: string, status: StageStatus) => {
    if (status.attempts?.length) {
      for (const attempt of status.attempts) {
        const key = JSON.stringify([stageId, attempt.index, attempt.startedAt]);
        if (seen.has(key)) continue;
        seen.add(key);
        if (quantity.safeParse(attempt.tokens_in).success) knownInputTokens += attempt.tokens_in!;
        if (quantity.safeParse(attempt.tokens_out).success) knownOutputTokens += attempt.tokens_out!;
        if (attempt.tokenUsage === 'unknown' || attempt.tokenUsage === 'partial'
          || !quantity.safeParse(attempt.tokens_in).success || !quantity.safeParse(attempt.tokens_out).success) unknownTokenAttempts += 1;
        if (quantity.safeParse(attempt.duration_ms).success) knownAttemptDurationMs += attempt.duration_ms!;
        else unknownDurationAttempts += 1;
      }
    } else if (status.status !== STAGE_STATUS.PENDING) {
      if (quantity.safeParse(status.tokens_in).success && quantity.safeParse(status.tokens_out).success) {
        knownInputTokens += status.tokens_in!;
        knownOutputTokens += status.tokens_out!;
      } else unknownLegacyStages += 1;
      if (quantity.safeParse(status.duration_ms).success) knownAttemptDurationMs += status.duration_ms!;
      else unknownDurationAttempts += 1;
    }
  };
  for (const [id, status] of Object.entries(state.stages)) add(id, status);
  for (const retired of state.retiredStageUsage ?? []) add(retired.stageId, retired.status);
  for (const evidence of state.stageEvidence ?? []) add(evidence.stageId, evidence.status);
  for (const [id, attempts] of Object.entries(state.auxiliaryAttempts ?? {})) add(id, { status: STAGE_STATUS.COMPLETE, retries: 0, attempts });
  if (state.supervisor) {
    if (state.supervisor.attempts?.length) {
      for (const attempt of state.supervisor.attempts) add('_supervisor', { status: attempt.status === STAGE_STATUS.COMPLETE ? 'complete' : 'failed', retries: 0, attempts: [attempt as StageAttempt] });
    } else if (state.supervisor.calls > 0) add('_supervisor', { status: state.supervisor.status, retries: 0, tokens_in: state.supervisor.tokens_in, tokens_out: state.supervisor.tokens_out, duration_ms: state.supervisor.duration_ms });
  }
  const tokensComplete = unknownTokenAttempts + unknownLegacyStages === 0;
  const start = Date.parse(state.startedAt);
  const end = Date.parse(state.completedAt ?? observedAt);
  const declared = state.budget ?? {};
  const limit = quantity.safeParse(declared.totalTokens).success ? declared.totalTokens! : null;
  return {
    declared,
    tokens: { knownInputTokens, knownOutputTokens, unknownTokenAttempts, unknownLegacyStages, complete: tokensComplete, limit, remaining: tokensComplete && limit !== null ? Math.max(0, limit - knownInputTokens - knownOutputTokens) : null },
    time: { knownAttemptDurationMs, unknownDurationAttempts, wallElapsedMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null, limitMs: quantity.safeParse(declared.totalTimeMs).success ? declared.totalTimeMs! : null, accounting: 'summed_attempt_duration_is_not_wall_time' as const },
  };
}

export interface RunStateViewOptions {
  includePromptText?: boolean;
  resourceRegistryPath?: string;
  observedAt?: string;
  maximumReadAttempts?: number;
}

/** Same read-only projector for planner, workers, supervisor, API and CLI.
 * No prompt extraction, live-log judgment, process signalling or reconciliation. */
export function readRunStateView(projectDir: string, runId: string, options: RunStateViewOptions = {}): RunStateView {
  if (!runId || basename(runId) !== runId || /[\\/]/.test(runId) || runId === '.' || runId === '..') throw new RunStateViewError('STATE_RUN_ID_INVALID', 'declare one safe run identifier');
  const maximum = quantity.positive().max(10).parse(options.maximumReadAttempts ?? 3);
  for (let attempt = 0; attempt < maximum; attempt += 1) {
    const fence = new ViewReadFence();
    const runDirectory = runDir(projectDir, runId);
    const path = (value: string) => carrierPath(runDirectory, value);
    const raw = fence.read(path('run.json'));
    if (raw === undefined) throw new RunStateViewError('STATE_RUN_ABSENT', `run ${runId} has no run.json`);
    const archived = readArchivedRunState(projectDir, runId);
    const state = archived.state as QueryableStoreState;
    if (state.runId !== runId || resolve(state.projectDir) !== resolve(projectDir)) throw new RunStateViewError('STATE_RUN_BINDING', 'run identity/project differs from the requested view');
    if (state.stateFormat?.history) fence.read(path(state.stateFormat.history.path), state.stateFormat.history.committedBytes);
    const queryState = RunQueryStateSchema.parse(state.queryState ?? { version: 1 });
    const observedAt = timestamp.parse(options.observedAt ?? new Date().toISOString());
    const artifacts: ArtifactObservation[] = [];
    const declarations = [
      ...queryState.artifacts,
      ...(state.declaredOutputs ?? []).map((output, index) => ArtifactSchema.parse({ id: `brief_output_${index}`, root: 'project', path: output.path, kind: output.expectedType, role: output.disposition === 'input' ? 'read' : 'produce', source: output.source })),
    ];
    for (const declaration of declarations) artifacts.push({ declaration, existence: fence.watchValue(() => observeArtifact(projectDir, runDirectory, declaration)) });
    const eventRaw = fence.read(path('events.jsonl'));
    const rows: Array<Record<string, unknown>> = [];
    let malformedRecords = 0;
    for (const line of (eventRaw ?? '').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = recordObject(JSON.parse(line));
        if (!row || row.runId !== runId) malformedRecords += 1;
        else rows.push(row);
      } catch { malformedRecords += 1; }
    }
    if (malformedRecords) fence.diagnostics.push({ code: 'STATE_EVENT_ROWS_UNREADABLE', path: path('events.jsonl'), detail: `${malformedRecords} malformed or unbound event rows retained as a gap` });
    const artifactContracts: RunStateView['artifactContracts'] = [];
    const verdicts: RunStateView['audits']['verdicts'] = [];
    const invocations: StateInvocationView[] = [];
    const legacyInputs: LegacyInputView[] = [];
    const guidance: GuidanceView[] = [];
    const addGuidance = (sourcePath: string) => {
      const text = fence.read(sourcePath);
      if (text === undefined) return;
      for (const envelope of parseGuidanceLedger(text)) {
        const deliveries = rows.filter((row) => row.type === 'guidance_delivery_checked' && Array.isArray(row.guidanceIds) && row.guidanceIds.includes(envelope.id) && row.delivered !== false);
        guidance.push({ envelope, sourcePath, deliveries, deliveryState: envelope.quarantined ? 'quarantined' : deliveries.length ? 'delivered' : 'queued' });
      }
    };
    addGuidance(path('supervisor_guidance.md'));
    for (const archive of fence.list(path('guidance_history')).filter((name) => /^iter_\d+\.md$/.test(name))) addGuidance(path(join('guidance_history', archive)));
    const stageIds = new Set([...Object.keys(state.stages), ...Object.keys(state.auxiliaryAttempts ?? {}), ...(state.stageEvidence ?? []).map((entry) => entry.stageId), ...(state.retiredStageUsage ?? []).map((entry) => entry.stageId)]);
    if (state.supervisor || state.supervise === true) stageIds.add('_supervisor');
    const allAttempts: Array<{ stageId: string; attempt: StageAttempt }> = [];
    const seenAttempts = new Set<string>();
    for (const stageId of stageIds) {
      if (!safeId.safeParse(stageId).success) { fence.diagnostics.push({ code: 'STATE_STAGE_ID_INVALID', detail: `stage identifier ${JSON.stringify(stageId)} is not safe to resolve` }); continue; }
      const stagePath = (value: string) => path(join('stages', stageId, value));
      const inputPath = stagePath('input.md');
      const latest = fence.read(inputPath);
      if (latest !== undefined) legacyInputs.push({ stageId, path: inputPath, sha256: sha256(latest), exact: false, reason: 'mutable latest alias; final system input and earlier invocation identity are not proven', ...(options.includePromptText ? { text: latest } : {}) });
      addGuidance(stagePath('guidance.md'));
      const contractPath = stagePath('artifact_contract.json');
      const contract = fence.json(contractPath);
      if (contract !== undefined) {
        artifactContracts.push({ stageId, path: contractPath, record: contract });
        // Retained typed decisions are evidence of old duties, not new prose extraction.
        const typed = recordObject(contract);
        if (typed?.version === 1 && typed.stageId === stageId && Array.isArray(typed.obligations)) {
          typed.obligations.forEach((value, index) => {
            const obligation = recordObject(value);
            if (typeof obligation?.path !== 'string' || !isAbsolute(obligation.path)) return;
            const root = contained(runDirectory, obligation.path) ? 'run' : contained(projectDir, obligation.path) ? 'project' : undefined;
            if (!root) { fence.diagnostics.push({ code: 'STATE_CONTRACT_LOCATION_UNBOUND', path: contractPath, detail: 'retained obligation names neither this project nor this run' }); return; }
            const observation = Array.isArray(typed.observations) ? typed.observations.map(recordObject).find((value) => value?.path === obligation.path) : undefined;
            const declaration = ArtifactSchema.parse({ id: `recorded_${stageId}_${index}`, root, path: relative(root === 'run' ? runDirectory : projectDir, obligation.path), ...(observation?.kind === 'directory' ? { kind: 'directory' } : {}), stageId, role: obligation.kind === 'replay_command_target' ? 'read' : 'produce', source: contractPath, activation: typed.completionDeferred === true ? 'unknown' : 'active' });
            artifacts.push({ declaration, existence: fence.watchValue(() => observeArtifact(projectDir, runDirectory, declaration)) });
          });
        }
      }
      const retained = recordObject(contract);
      if (typeof retained?.checkedAt === 'string' && Array.isArray(retained.observations)) {
        for (const value of retained.observations) {
          const observation = recordObject(value);
          if (typeof observation?.path !== 'string' || !quantity.safeParse(observation.bytes).success
            || !digest.safeParse(observation.sha256).success || typeof observation.fresh !== 'boolean') continue;
          for (const artifact of artifacts) if (artifact.declaration.stageId === stageId && artifact.existence.path === observation.path) {
            artifact.settlement = { checkedAt: retained.checkedAt, bytes: observation.bytes as number, sha256: observation.sha256 as string, fresh: observation.fresh,
              ...(quantity.safeParse(observation.members).success ? { members: observation.members as number } : {}) };
          }
        }
      }
      const verdictPath = path(`verdict_${stageId}.json`);
      const verdict = fence.json(verdictPath);
      if (verdict !== undefined) verdicts.push({ stageId, path: verdictPath, record: verdict });
      const attempts = [...(state.stages[stageId]?.attempts ?? []), ...(state.auxiliaryAttempts?.[stageId] ?? []), ...(state.stageEvidence ?? []).filter((entry) => entry.stageId === stageId).flatMap((entry) => entry.status.attempts ?? []), ...(state.retiredStageUsage ?? []).filter((entry) => entry.stageId === stageId).flatMap((entry) => entry.status.attempts ?? []), ...(stageId === '_supervisor' ? state.supervisor?.attempts ?? [] : [])];
      for (const execution of attempts) {
        const key = JSON.stringify([stageId, execution.index, execution.startedAt]);
        if (!seenAttempts.has(key)) { allAttempts.push({ stageId, attempt: execution }); seenAttempts.add(key); }
      }
      const invocationRoot = stagePath('invocations');
      for (const directory of fence.list(invocationRoot).filter((name) => /^attempt_\d+_[0-9a-f]{24}$/.test(name))) {
        const directoryPath = stagePath(join('invocations', directory));
        for (const filename of fence.list(directoryPath).filter((name) => /^invocation_\d+\.json$/.test(name))) {
          const invocationPath = stagePath(join('invocations', directory, filename));
          const value = fence.json(invocationPath);
          try {
            const record = checkedInvocation(value);
            if (record.runId !== runId || record.stageId !== stageId || invocationInputPath(runDirectory, record) !== invocationPath) throw new RunStateViewError('INVOCATION_RUN_BINDING', 'invocation carrier path and identity differ');
            const matched = attempts.some((entry) => entry.index === record.attemptIndex && entry.startedAt === record.attemptStartedAt);
            const { systemPrompt, userPrompt, transport, ...metadata } = record;
            invocations.push({ path: invocationPath, integrity: 'verified', attemptBinding: matched ? 'matched' : 'unmatched', record: { ...metadata, ...(options.includePromptText ? { systemPrompt, userPrompt } : {}), ...(transport ? { transport: { kind: transport.kind, sha256: transport.sha256, ...(options.includePromptText ? { payload: transport.payload } : {}) } } : {}) } });
          } catch (error) { invocations.push({ path: invocationPath, integrity: 'invalid', attemptBinding: 'unmatched', reason: error instanceof Error ? error.message : String(error) }); }
        }
      }
    }
    const missingAttemptInputs: RunStateView['prompts']['missingAttemptInputs'] = [];
    for (const { stageId, attempt: entry } of allAttempts) {
      if (!invocations.some((view) => view.integrity === 'verified' && view.attemptBinding === 'matched' && view.record?.stageId === stageId && view.record.attemptIndex === entry.index && view.record.attemptStartedAt === entry.startedAt)) missingAttemptInputs.push({ stageId, attemptIndex: entry.index, attemptStartedAt: entry.startedAt });
    }
    const registryPath = options.resourceRegistryPath ?? queryState.resourceRegistryPath ?? resourceLeaseRegistryPath();
    const resources = fence.watchValue(() => readResourceLeaseRegistry(registryPath));
    const stages = state.dispatchedStages ?? state.plan ?? [];
    const source = state.dispatchedStages ? 'dispatchedStages' : state.plan ? 'plan' : 'unavailable';
    const resourceWaits: RunStateView['resourceWaits'] = [];
    for (const row of rows) {
      if (row.type !== 'resource_lease_wait_started' && row.type !== 'resource_lease_wait_finished') continue;
      if (typeof row.requestId !== 'string') continue;
      const previous = resourceWaits.findIndex((entry) => entry.requestId === row.requestId);
      if (previous >= 0) resourceWaits.splice(previous, 1);
      const status = typeof row.stageId === 'string' ? state.stages[row.stageId] : undefined;
      const active = status?.attempts?.at(-1);
      if (row.type === 'resource_lease_wait_started' && typeof row.stageId === 'string'
        && typeof row.attemptIndex === 'number' && typeof row.attemptStartedAt === 'string'
        && active?.status === STAGE_STATUS.RUNNING && active.index === row.attemptIndex && active.startedAt === row.attemptStartedAt) {
        resourceWaits.push({ stageId: row.stageId, attemptIndex: row.attemptIndex, attemptStartedAt: row.attemptStartedAt, requestId: row.requestId, waitStartedAt: String(row.waitStartedAt ?? row.timestamp), reason: String(row.detail ?? 'resource contention') });
      }
    }
    const view: RunStateView = {
      version: 1, observedAt,
      snapshot: { runStateRevision: state.stateFormat?.revision ?? null, runStateSha256: sha256(raw), evidenceSha256: sha256(JSON.stringify({ sources: fence.sources, artifacts, resources })), sources: fence.sources },
      run: { runId, projectDir: state.projectDir, workflowName: state.workflowName, status: state.status, statusResolution: archived.status, startedAt: state.startedAt, completedAt: state.completedAt, currentIteration: state.currentIteration ?? null, failureReason: state.failureReason },
      plan: { stages, source, revision: queryState.planRevision ?? null, history: queryState.planHistory, decisions: state.planRevisionDecisions ?? {}, admissionClaim: queryState.planRevision ? 'recorded' : 'unknown' },
      stages: state.stages,
      histories: { retiredStageUsage: state.retiredStageUsage, stageEvidence: state.stageEvidence, criterionDischarges: state.criterionDischarges, unresolvedStageObligations: state.unresolvedStageObligations, supervisor: state.supervisor, auxiliaryAttempts: state.auxiliaryAttempts },
      artifacts, artifactContracts, budget: budgetView(state, observedAt), resources, resourceWaits,
      audits: { findings: queryState.findings, openFindings: queryState.findings.filter((finding) => finding.status === 'open'), verdicts },
      guidance, events: { rows, malformedRecords },
      prompts: { invocations, legacyInputs, missingAttemptInputs, coverage: invocations.some((entry) => entry.integrity === 'verified') ? (missingAttemptInputs.length || invocations.some((entry) => entry.integrity === 'invalid' || entry.attemptBinding !== 'matched') ? 'partial' : 'recorded') : legacyInputs.length ? 'legacy_only' : 'none', completeness: 'unknown' },
      diagnostics: fence.diagnostics,
    };
    if (fence.stable()) return view;
  }
  throw new RunStateViewError('STATE_VIEW_UNSTABLE', 'run projection or evidence changed during every bounded read; retry the same read-only query');
}
