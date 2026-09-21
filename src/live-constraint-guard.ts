import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { scopePathDigest } from './runtime-negotiation.js';
import { stableGeneratedScope } from './generated-path-policy.js';

export const LIVE_CONSTRAINT_FALLBACK_SCAN_MS = 30_000;
export const LIVE_CONSTRAINT_MONITOR_DEADLINE_MS = 600_000;
export const LIVE_CONSTRAINT_MAX_REINVOCATIONS = 1;
export const SCOPE_REVISION_REQUEST_FILE = 'scope_revision_request.json';

export interface ScopeRevisionContractInput {
  runDir: string;
  runId: string;
  stageId: string;
  attemptIndex: number | '<current execution index>';
  scope: readonly string[];
  scopePresence: 'present' | 'missing';
  gate: boolean;
}

/**
 * Convert only observed, generator-owned content-addressed members to their
 * stable tree capability. Other paths remain exact, including hexadecimal
 * source directories and short hash-like names.
 */
export function scopeRevisionPathsForViolations(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => {
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
    return stableGeneratedScope(normalized) ?? normalized;
  }))].sort();
}

/** One byte-stable source for the ordinary prompt and live/post-audit guidance. */
export function scopeRevisionContract(input: ScopeRevisionContractInput): string {
  const gateIsolation = input.gate
    ? ' Gate project writes remain subject to isolation policy; if rejected, use a planner-predeclared path in a later iteration or an OS temporary probe lane.'
    : '';
  return `Declared project-write scope: ${JSON.stringify(input.scope)} (declaration ${input.scopePresence}). `
    + `A missing declaration is closed, never allow-all. Before any project write outside this initial capability, produce `
    + `exactly one JSON request to ${join(input.runDir, 'stages', input.stageId, SCOPE_REVISION_REQUEST_FILE)} `
    + `with {"version":1,"kind":"scope_revision","requestId":"<unique id>","runId":"${input.runId}","stageId":"${input.stageId}",`
    + `"attemptIndex":${input.attemptIndex === '<current execution index>' ? '<current execution index>' : input.attemptIndex},"requestedPaths":["path"],"pathDigest":"<sha256 of the canonical requestedPaths set>",`
    + `"reason":"<why the declared work requires it>"}. The scheduler canonicalizes and verifies the run/stage/execution/path binding. `
    + `Accepted paths from an earlier execution of this same stage remain in the effective scope after the scheduler revalidates them against the current batch. `
    + `Wait without hot-polling: continue independent work, or check for scope_revision_decision_<requestId>.json at most once per second, bounded by the remaining execution deadline; the scheduler also watches the directory and publishes one durable decision. `
    + `Write the new path only when accepted; `
    + `a rejection is an auditable request to stop or re-plan, not permission to bypass scope with casts or indirection.`
    + gateIsolation;
}

export function scopeRevisionInstruction(input: ScopeRevisionContractInput & {
  violatingPaths: readonly string[];
}): string {
  const paths = [...new Set(input.violatingPaths.map((path) => path.replace(/\\/g, '/')))].sort();
  const requestedPaths = scopeRevisionPathsForViolations(paths);
  const digest = scopePathDigest(requestedPaths);
  const stableScopeDetail = requestedPaths.some((path, index) => path !== paths[index])
    ? ` The refused member belongs to a recognized content-addressed generated tree, so the complete stable parent scope is ${JSON.stringify(requestedPaths)}.`
    : '';
  return `The live constraint guard detected project content change${paths.length === 1 ? '' : 's'} outside the effective scope: ${JSON.stringify(paths)}. `
    + `Each incident records whether exact preimage restoration succeeded; an unrestored path is never described as reverted. `
    + `Do not rewrite ${paths.length === 1 ? 'that path' : 'those paths'} unless a scope revision is accepted.`
    + stableScopeDetail + ' '
    + `If the declared work requires ${paths.length === 1 ? 'it' : 'them'}, write exactly one request to ${join(input.runDir, 'stages', input.stageId, SCOPE_REVISION_REQUEST_FILE)} `
    + `with {"version":1,"kind":"scope_revision","requestId":"<unique id>","runId":"${input.runId}","stageId":"${input.stageId}",`
    + `"attemptIndex":${input.attemptIndex},"requestedPaths":${JSON.stringify(requestedPaths)},"pathDigest":"${digest}",`
    + `"reason":"<why the declared work requires it>"}. Wait without hot-polling for scope_revision_decision_<requestId>.json and write only after acceptance. `
    + `This is the same instruction recorded by the post-attempt constraint audit, which remains the backstop.`;
}

export type LiveConstraintContentIdentity =
  | { state: 'absent' }
  | { state: 'unavailable'; reason: string }
  | {
      state: 'present';
      type: 'file' | 'symlink';
      byteLength: number;
      sha256: string;
    };

export type LiveConstraintContentComparison = 'equal' | 'different' | 'unavailable';

function errorReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = 'code' in error && typeof error.code === 'string' ? `${error.code}: ` : '';
  return `${code}${error.message}`;
}

function hashRegularFile(path: string): LiveConstraintContentIdentity {
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'r');
      const before = fstatSync(descriptor);
      if (!before.isFile()) return { state: 'unavailable', reason: 'path changed type while its content was read' };
      const hash = createHash('sha256');
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let byteLength = 0;
      while (true) {
        const count = readSync(descriptor, chunk, 0, chunk.length, null);
        if (count === 0) break;
        hash.update(chunk.subarray(0, count));
        byteLength += count;
      }
      const after = fstatSync(descriptor);
      if (before.size === after.size
        && before.mtimeMs === after.mtimeMs
        && before.ctimeMs === after.ctimeMs
        && byteLength === after.size) {
        return { state: 'present', type: 'file', byteLength, sha256: hash.digest('hex') };
      }
    } catch (error) {
      return { state: 'unavailable', reason: `could not read regular-file content: ${errorReason(error)}` };
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* the content result already captures the useful failure */ }
      }
    }
  }
  return { state: 'unavailable', reason: 'regular-file content changed during two consecutive reads' };
}

/** Metadata can nominate a path for inspection; only this identity proves a write. */
export function readLiveConstraintContentIdentity(path: string): LiveConstraintContentIdentity {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'unavailable', reason: `could not inspect path: ${errorReason(error)}` };
  }
  if (stat.isSymbolicLink()) {
    try {
      const bytes = readlinkSync(path, { encoding: 'buffer' });
      return {
        state: 'present',
        type: 'symlink',
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch (error) {
      return { state: 'unavailable', reason: `could not read symbolic-link target: ${errorReason(error)}` };
    }
  }
  if (!stat.isFile()) return { state: 'unavailable', reason: 'path is neither a regular file nor a symbolic link' };
  return hashRegularFile(path);
}

export function compareLiveConstraintContentIdentities(
  before: LiveConstraintContentIdentity,
  after: LiveConstraintContentIdentity,
): LiveConstraintContentComparison {
  if (before.state === 'unavailable' || after.state === 'unavailable') return 'unavailable';
  if (before.state === 'absent' || after.state === 'absent') {
    return before.state === after.state ? 'equal' : 'different';
  }
  return before.type === after.type
    && before.byteLength === after.byteLength
    && before.sha256 === after.sha256
    ? 'equal'
    : 'different';
}

export interface WriterLeaseBinding {
  /** One scheduler-selected batch whose members were checked pairwise. */
  batchId: string;
  /** One scope partition within that batch. Equal partitions remain serial. */
  partitionId: string;
  ownerStageId: string;
}

export interface WriterLeaseWaitObservation {
  phase: 'started' | 'finished';
  blockedByOwnerStageId?: string;
  partitionId: string;
  waitStartedAt: string;
  waitedMs?: number;
}

export interface WriterLeaseOptions extends Partial<WriterLeaseBinding> {
  onWait?: (observation: WriterLeaseWaitObservation) => void;
  now?: () => number;
}

interface WriterLeaseRequest {
  token: symbol;
  cohortId: string;
  partitionId: string;
  ownerStageId?: string;
  exclusive: boolean;
}

type WriterLeaseHolder = WriterLeaseRequest;

interface WriterLeaseWaiter {
  request: WriterLeaseRequest;
  ready: () => void;
}

interface WriterLeaseState {
  cohortId?: string;
  holders: Map<string, WriterLeaseHolder>;
  waiters: WriterLeaseWaiter[];
}

const writerLeases = new Map<string, WriterLeaseState>();

/**
 * One adapter invocation with project-write capability owns the portable
 * attribution boundary. Explicitly read-only invocations do not take the lease
 * and may continue concurrently.
 */
export async function acquireAttributableWriterLease(
  projectDir: string,
  writeCapable: boolean,
  options: WriterLeaseOptions = {},
): Promise<() => void> {
  if (!writeCapable) return () => undefined;
  const key = resolve(projectDir);
  const batchId = options.batchId?.trim();
  const requestedPartition = options.partitionId?.trim();
  const partitioned = Boolean(batchId && requestedPartition);
  const request: WriterLeaseRequest = {
    token: Symbol('writer-lease'),
    cohortId: partitioned ? `batch:${batchId}` : 'project-wide',
    partitionId: partitioned ? requestedPartition! : 'project-wide',
    ...(options.ownerStageId ? { ownerStageId: options.ownerStageId } : {}),
    exclusive: !partitioned,
  };
  const state: WriterLeaseState = writerLeases.get(key) ?? {
    holders: new Map<string, WriterLeaseHolder>(),
    waiters: [],
  };
  writerLeases.set(key, state);

  const canGrant = (candidate: WriterLeaseRequest): boolean => {
    if (state.holders.size === 0) return true;
    if (state.cohortId !== candidate.cohortId || candidate.exclusive) return false;
    const active = state.holders.values().next().value as WriterLeaseHolder | undefined;
    if (active?.exclusive) return false;
    return !state.holders.has(candidate.partitionId);
  };
  const grant = (candidate: WriterLeaseRequest): void => {
    if (state.holders.size === 0) state.cohortId = candidate.cohortId;
    state.holders.set(candidate.partitionId, candidate);
  };
  const safelyObserve = (observation: WriterLeaseWaitObservation): void => {
    try { options.onWait?.(observation); } catch { /* lease ownership must not be stranded by telemetry */ }
  };

  let waitStartedMs: number | undefined;
  let waitStartedAt: string | undefined;
  let blockedByOwnerStageId: string | undefined;
  if (state.waiters.length === 0 && canGrant(request)) {
    grant(request);
  } else {
    const blocker = state.holders.get(request.partitionId)
      ?? state.holders.values().next().value as WriterLeaseHolder | undefined;
    blockedByOwnerStageId = blocker?.ownerStageId;
    const now = options.now ?? Date.now;
    waitStartedMs = now();
    waitStartedAt = new Date(waitStartedMs).toISOString();
    safelyObserve({
      phase: 'started',
      ...(blockedByOwnerStageId ? { blockedByOwnerStageId } : {}),
      partitionId: request.partitionId,
      waitStartedAt,
    });
    await new Promise<void>((ready) => state.waiters.push({ request, ready }));
    const waitedMs = Math.max(0, now() - waitStartedMs);
    safelyObserve({
      phase: 'finished',
      ...(blockedByOwnerStageId ? { blockedByOwnerStageId } : {}),
      partitionId: request.partitionId,
      waitStartedAt,
      waitedMs,
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const holder = state.holders.get(request.partitionId);
    if (holder?.token !== request.token) return;
    state.holders.delete(request.partitionId);
    if (state.holders.size === 0) state.cohortId = undefined;

    // Preserve FIFO at the batch boundary. Once the oldest waiter establishes
    // a cohort, immediately admit only subsequent disjoint partitions from
    // that same scheduler-proven batch.
    while (state.waiters.length > 0) {
      const next = state.waiters[0];
      if (!canGrant(next.request)) break;
      state.waiters.shift();
      grant(next.request);
      next.ready();
    }
    if (state.holders.size === 0 && state.waiters.length === 0) writerLeases.delete(key);
  };
}

export type LiveConstraintScanTrigger = 'phase_start' | 'watch' | 'fallback' | 'phase_boundary';

export interface LiveConstraintViolationDetection {
  path: string;
  reason: string;
  restored: boolean;
  rollbackFailure?: string;
}

export interface LiveConstraintScanResult {
  scannedPaths: number;
  violations: LiveConstraintViolationDetection[];
  /** Unique untracked generated paths observed by this scan. */
  exemptedPaths?: string[];
}

export interface LiveConstraintIncident {
  version: 1;
  kind: 'live_constraint_incident';
  incidentId: string;
  stageId: string;
  attemptIndex: number;
  invocationIndex: number;
  trigger: LiveConstraintScanTrigger;
  path: string;
  reason: string;
  restored: boolean;
  rollbackFailure?: string;
  writeObservedAt: string;
  detectedAt: string;
  detectionLatencyMs: number;
  effectiveScope: string[];
  scopeRevisionInstruction: string;
}

export interface LiveConstraintMonitorFailure {
  kind: 'monitor_failure';
  stageId: string;
  attemptIndex: number;
  invocationIndex: number;
  detectedAt: string;
  reason: string;
  lastScanDurationMs: number;
  lastScanFileCount: number;
}

export interface LiveConstraintInvocationResult {
  incidents: LiveConstraintIncident[];
  exemptedCount: number;
  monitorFailure?: LiveConstraintMonitorFailure;
}

export interface LiveConstraintExemptionSummary {
  stageId: string;
  attemptIndex: number;
  invocationIndex: number;
  exemptedCount: number;
}

export interface LiveConstraintGuardOptions {
  projectDir: string;
  runDir: string;
  stageId: string;
  attemptIndex: number;
  effectiveScope: () => readonly string[];
  scanAndRestore: (
    candidatePaths: readonly string[],
    trigger: LiveConstraintScanTrigger,
  ) => LiveConstraintScanResult | Promise<LiveConstraintScanResult>;
  scopeRevisionInstruction: (paths: readonly string[]) => string;
  onExemptions?: (summary: LiveConstraintExemptionSummary) => void;
  onMonitorFailure?: (failure: LiveConstraintMonitorFailure) => void;
  fallbackScanMs?: number;
  monitorDeadlineMs?: number;
  now?: () => number;
  watchProject?: (
    listener: (path: string | undefined) => void,
    onError: (error: Error) => void,
  ) => FSWatcher | undefined;
}

export interface LiveConstraintGuardAttemptContext {
  attemptIndex: number;
  attemptStartedAt: string;
}

export interface LiveConstraintGuardFactory {
  (attempt: LiveConstraintGuardAttemptContext): LiveConstraintGuard;
  /** Scheduler proof consumed by runStage before the attempt begins. */
  writerLease?: WriterLeaseBinding;
}

export interface LiveConstraintInvocationMonitor {
  /** Structured adapter attribution closes watcher gaps without changing enforcement authority. */
  observePaths(paths: readonly string[]): void;
  finish(): Promise<LiveConstraintInvocationResult>;
}

interface ActiveInvocation {
  index: number;
  abort: (reason: string) => void;
  incidents: LiveConstraintIncident[];
  firstObservedAt: Map<string, number>;
  pendingPaths: Set<string>;
  pendingTrigger?: LiveConstraintScanTrigger;
  scanPromise?: Promise<void>;
  watcher?: FSWatcher;
  fallbackTimer?: ReturnType<typeof setInterval>;
  livenessTimer?: ReturnType<typeof setInterval>;
  lastSuccessfulScanAt: number;
  lastScanDurationMs: number;
  lastScanFileCount: number;
  exemptedPaths: Set<string>;
  monitorFailure?: LiveConstraintMonitorFailure;
  summaryReported: boolean;
  finished: boolean;
}

function positiveInterval(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function normalizeCandidatePath(path: string | undefined): string | undefined {
  const normalized = path?.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return normalized || undefined;
}

const liveConstraintPatternCache = new Map<string, RegExp>();
const trackedDirectoryCache = new WeakMap<ReadonlySet<string>, Set<string>>();

function globSegmentSource(segment: string): string {
  return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
}

/** Segment-aware matcher used only after the immutable Git tracked set wins. */
export function matchesLiveConstraintExemptPattern(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  let compiled = liveConstraintPatternCache.get(normalizedPattern);
  if (!compiled) {
    const segments = normalizedPattern.split('/').filter(Boolean);
    let source = '^';
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (segment === '**') {
        source += index === segments.length - 1 ? '.*' : '(?:[^/]+/)*';
      } else {
        source += globSegmentSource(segment);
        if (index < segments.length - 1) source += '/';
      }
    }
    compiled = new RegExp(`${source}$`);
    liveConstraintPatternCache.set(normalizedPattern, compiled);
  }
  return compiled.test(normalizedPath);
}

export function isLiveConstraintExemptPath(
  path: string,
  patterns: readonly string[],
  trackedPaths: ReadonlySet<string>,
): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (trackedPaths.has(normalized)) return false;
  return patterns.some((pattern) => matchesLiveConstraintExemptPattern(normalized, pattern));
}

/** Only a cache-tree pattern ending in `/**` can prune traversal. */
export function isLiveConstraintExemptDirectory(
  path: string,
  patterns: readonly string[],
  trackedPaths: ReadonlySet<string>,
): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  let trackedDirectories = trackedDirectoryCache.get(trackedPaths);
  if (!trackedDirectories) {
    trackedDirectories = new Set<string>();
    for (const tracked of trackedPaths) {
      const segments = tracked.split('/');
      for (let length = 1; length < segments.length; length++) {
        trackedDirectories.add(segments.slice(0, length).join('/'));
      }
    }
    trackedDirectoryCache.set(trackedPaths, trackedDirectories);
  }
  if (trackedPaths.has(normalized) || trackedDirectories.has(normalized)) return false;
  return patterns.some((pattern) => (
    pattern.replace(/\\/g, '/').endsWith('/**')
    && matchesLiveConstraintExemptPattern(`${normalized}/__flowcrew_cache_probe__`, pattern)
  ));
}

function incidentId(input: {
  stageId: string;
  attemptIndex: number;
  invocationIndex: number;
  path: string;
  detectedAt: string;
}): string {
  return createHash('sha256')
    .update(`${input.stageId}\0${input.attemptIndex}\0${input.invocationIndex}\0${input.path}\0${input.detectedAt}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Filesystem notification is an accelerator only. A bounded fallback and each
 * invocation boundary call the same scheduler-owned scan/restore policy.
 */
export class LiveConstraintGuard {
  private readonly now: () => number;
  private readonly fallbackScanMs: number;
  private readonly monitorDeadlineMs: number;
  private active?: ActiveInvocation;

  constructor(private readonly options: LiveConstraintGuardOptions) {
    this.now = options.now ?? Date.now;
    this.fallbackScanMs = positiveInterval(options.fallbackScanMs, LIVE_CONSTRAINT_FALLBACK_SCAN_MS);
    this.monitorDeadlineMs = positiveInterval(options.monitorDeadlineMs, LIVE_CONSTRAINT_MONITOR_DEADLINE_MS);
  }

  beginInvocation(invocationIndex: number, abort: (reason: string) => void): LiveConstraintInvocationMonitor {
    if (this.active && !this.active.finished) throw new Error('live constraint invocation monitor already active');
    const active: ActiveInvocation = {
      index: invocationIndex,
      abort,
      incidents: [],
      firstObservedAt: new Map(),
      pendingPaths: new Set(),
      lastSuccessfulScanAt: this.now(),
      lastScanDurationMs: 0,
      lastScanFileCount: 0,
      exemptedPaths: new Set(),
      summaryReported: false,
      finished: false,
    };
    this.active = active;

    const listener = (rawPath: string | undefined): void => {
      const path = normalizeCandidatePath(rawPath);
      if (path) {
        active.pendingPaths.add(path);
        if (!active.firstObservedAt.has(path)) active.firstObservedAt.set(path, this.now());
      }
      this.queueScan(active, 'watch');
    };
    const onWatchError = (): void => {
      // The fallback is the guarantee. A watcher error merely forces its next
      // scan to consider the full scheduler journal.
      this.queueScan(active, 'fallback');
    };
    try {
      active.watcher = this.options.watchProject
        ? this.options.watchProject(listener, onWatchError)
        : (() => {
            const watcher = watch(this.options.projectDir, { recursive: true, persistent: false }, (_event, fileName) => {
              listener(fileName?.toString());
            });
            watcher.on('error', onWatchError);
            return watcher;
          })();
    } catch {
      // Unsupported recursive watching is expected on some adapters/filesystems.
      // The bounded scan below remains authoritative.
    }
    active.fallbackTimer = setInterval(() => this.queueScan(active, 'fallback'), this.fallbackScanMs);
    const livenessPollMs = Math.max(25, Math.min(this.fallbackScanMs, Math.ceil(this.monitorDeadlineMs / 4)));
    active.livenessTimer = setInterval(() => {
      if (active.finished || active.monitorFailure) return;
      if (this.now() - active.lastSuccessfulScanAt < this.monitorDeadlineMs) return;
      active.monitorFailure = {
        kind: 'monitor_failure',
        stageId: this.options.stageId,
        attemptIndex: this.options.attemptIndex,
        invocationIndex: active.index,
        detectedAt: new Date(this.now()).toISOString(),
        reason: `live constraint monitor completed no clean scan within ${this.monitorDeadlineMs}ms`,
        lastScanDurationMs: active.lastScanDurationMs,
        lastScanFileCount: active.lastScanFileCount,
      };
      active.abort('live_constraint_monitor_failure');
    }, livenessPollMs);
    this.queueScan(active, 'phase_start');

    return {
      observePaths: (paths) => {
        for (const rawPath of paths) {
          const path = normalizeCandidatePath(rawPath);
          if (!path) continue;
          active.pendingPaths.add(path);
          if (!active.firstObservedAt.has(path)) active.firstObservedAt.set(path, this.now());
        }
        if (paths.length > 0) this.queueScan(active, 'watch');
      },
      finish: () => this.finishInvocation(active),
    };
  }

  private queueScan(active: ActiveInvocation, trigger: LiveConstraintScanTrigger): void {
    if (active.finished || active.monitorFailure) return;
    active.pendingTrigger = active.pendingTrigger === 'phase_boundary' ? 'phase_boundary' : trigger;
    if (active.scanPromise) return;
    active.scanPromise = Promise.resolve().then(async () => {
      while (!active.finished && !active.monitorFailure && active.pendingTrigger) {
        const nextTrigger = active.pendingTrigger;
        active.pendingTrigger = undefined;
        const paths = [...active.pendingPaths];
        active.pendingPaths.clear();
        const scanStartedAt = this.now();
        let result: LiveConstraintScanResult;
        try {
          result = await new Promise<LiveConstraintScanResult>((resolvePromise, rejectPromise) => {
            let settled = false;
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              rejectPromise(new Error(`scan exceeded ${this.monitorDeadlineMs}ms monitor deadline`));
            }, this.monitorDeadlineMs);
            Promise.resolve(this.options.scanAndRestore(paths, nextTrigger)).then(
              (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolvePromise(value);
              },
              (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                rejectPromise(error);
              },
            );
          });
        } catch (error) {
          active.monitorFailure = {
            kind: 'monitor_failure',
            stageId: this.options.stageId,
            attemptIndex: this.options.attemptIndex,
            invocationIndex: active.index,
            detectedAt: new Date(this.now()).toISOString(),
            reason: `live constraint scan failed closed: ${error instanceof Error ? error.message : String(error)}`,
            lastScanDurationMs: active.lastScanDurationMs,
            lastScanFileCount: active.lastScanFileCount,
          };
          active.abort('live_constraint_monitor_failure');
          break;
        }
        const scanCompletedAt = this.now();
        active.lastSuccessfulScanAt = scanCompletedAt;
        active.lastScanDurationMs = Math.max(0, scanCompletedAt - scanStartedAt);
        active.lastScanFileCount = Math.max(0, Math.floor(result.scannedPaths));
        for (const path of result.exemptedPaths ?? []) active.exemptedPaths.add(path);
        if (result.violations.length === 0) continue;
        const pathsForInstruction = [...new Set(result.violations.map((violation) => violation.path))].sort();
        const instruction = this.options.scopeRevisionInstruction(pathsForInstruction);
        const detectedMs = this.now();
        const detectedAt = new Date(detectedMs).toISOString();
        for (const violation of result.violations) {
          const observedMs = active.firstObservedAt.get(violation.path) ?? detectedMs;
          const incident: LiveConstraintIncident = {
            version: 1,
            kind: 'live_constraint_incident',
            incidentId: incidentId({
              stageId: this.options.stageId,
              attemptIndex: this.options.attemptIndex,
              invocationIndex: active.index,
              path: violation.path,
              detectedAt,
            }),
            stageId: this.options.stageId,
            attemptIndex: this.options.attemptIndex,
            invocationIndex: active.index,
            trigger: nextTrigger,
            path: violation.path,
            reason: violation.reason,
            restored: violation.restored,
            ...(violation.rollbackFailure ? { rollbackFailure: violation.rollbackFailure } : {}),
            writeObservedAt: new Date(observedMs).toISOString(),
            detectedAt,
            detectionLatencyMs: Math.max(0, detectedMs - observedMs),
            effectiveScope: [...this.options.effectiveScope()],
            scopeRevisionInstruction: instruction,
          };
          active.incidents.push(incident);
          if (!this.appendIncident(incident)) {
            active.monitorFailure = {
              kind: 'monitor_failure',
              stageId: this.options.stageId,
              attemptIndex: this.options.attemptIndex,
              invocationIndex: active.index,
              detectedAt,
              reason: 'live constraint incident could not be persisted after restoration',
              lastScanDurationMs: active.lastScanDurationMs,
              lastScanFileCount: active.lastScanFileCount,
            };
            active.abort('live_constraint_monitor_failure');
            break;
          }
        }
        if (active.monitorFailure) break;
        active.abort(result.violations.every((violation) => violation.restored)
          ? 'live_constraint_violation'
          : 'live_constraint_rollback_failure');
      }
    }).finally(() => {
      active.scanPromise = undefined;
      if (!active.finished && !active.monitorFailure && active.pendingTrigger) {
        this.queueScan(active, active.pendingTrigger);
      }
    });
  }

  private async finishInvocation(active: ActiveInvocation): Promise<LiveConstraintInvocationResult> {
    if (active.finished) return {
      incidents: [...active.incidents],
      exemptedCount: active.exemptedPaths.size,
      ...(active.monitorFailure ? { monitorFailure: active.monitorFailure } : {}),
    };
    active.watcher?.close();
    if (active.fallbackTimer) clearInterval(active.fallbackTimer);
    if (active.livenessTimer) clearInterval(active.livenessTimer);
    if (active.scanPromise) await active.scanPromise;
    if (!active.monitorFailure) {
      active.pendingTrigger = 'phase_boundary';
      active.finished = false;
      this.queueScan(active, 'phase_boundary');
      if (active.scanPromise) await active.scanPromise;
    }
    active.finished = true;
    if (!active.summaryReported) {
      active.summaryReported = true;
      if (active.exemptedPaths.size > 0) {
        try {
          this.options.onExemptions?.({
            stageId: this.options.stageId,
            attemptIndex: this.options.attemptIndex,
            invocationIndex: active.index,
            exemptedCount: active.exemptedPaths.size,
          });
        } catch { /* telemetry cannot weaken enforcement */ }
      }
      if (active.monitorFailure) {
        try { this.options.onMonitorFailure?.(active.monitorFailure); } catch { /* telemetry cannot weaken enforcement */ }
      }
    }
    return {
      incidents: [...active.incidents],
      exemptedCount: active.exemptedPaths.size,
      ...(active.monitorFailure ? { monitorFailure: active.monitorFailure } : {}),
    };
  }

  private appendIncident(incident: LiveConstraintIncident): boolean {
    const path = join(
      this.options.runDir,
      'stages',
      this.options.stageId,
      `live_constraint_incidents_attempt_${this.options.attemptIndex}.jsonl`,
    );
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(incident)}\n`, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }
}
