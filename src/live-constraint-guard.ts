import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { scopePathDigest } from './runtime-negotiation.js';

export const LIVE_CONSTRAINT_FALLBACK_SCAN_MS = 30_000;
export const LIVE_CONSTRAINT_MONITOR_DEADLINE_MS = 120_000;
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
  const digest = scopePathDigest(paths);
  return `The live constraint guard detected and reverted project write${paths.length === 1 ? '' : 's'} outside the effective scope: ${JSON.stringify(paths)}. `
    + `Do not rewrite ${paths.length === 1 ? 'that path' : 'those paths'} unless a scope revision is accepted. `
    + `If the declared work requires ${paths.length === 1 ? 'it' : 'them'}, write exactly one request to ${join(input.runDir, 'stages', input.stageId, SCOPE_REVISION_REQUEST_FILE)} `
    + `with {"version":1,"kind":"scope_revision","requestId":"<unique id>","runId":"${input.runId}","stageId":"${input.stageId}",`
    + `"attemptIndex":${input.attemptIndex},"requestedPaths":${JSON.stringify(paths)},"pathDigest":"${digest}",`
    + `"reason":"<why the declared work requires it>"}. Wait without hot-polling for scope_revision_decision_<requestId>.json and write only after acceptance. `
    + `This is the same instruction recorded by the post-attempt constraint audit, which remains the backstop.`;
}

interface WriterLeaseState {
  held: boolean;
  waiters: Array<() => void>;
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
): Promise<() => void> {
  if (!writeCapable) return () => undefined;
  const key = resolve(projectDir);
  const state = writerLeases.get(key) ?? { held: false, waiters: [] };
  writerLeases.set(key, state);
  if (state.held) await new Promise<void>((ready) => state.waiters.push(ready));
  state.held = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.waiters.shift();
    if (next) {
      // Ownership transfers directly; do not expose an unlocked microtask gap.
      state.held = true;
      next();
      return;
    }
    state.held = false;
    writerLeases.delete(key);
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
}

export interface LiveConstraintInvocationResult {
  incidents: LiveConstraintIncident[];
  monitorFailure?: LiveConstraintMonitorFailure;
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

export type LiveConstraintGuardFactory = (
  attempt: LiveConstraintGuardAttemptContext,
) => LiveConstraintGuard;

export interface LiveConstraintInvocationMonitor {
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
  monitorFailure?: LiveConstraintMonitorFailure;
  finished: boolean;
}

function positiveInterval(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function normalizeCandidatePath(path: string | undefined): string | undefined {
  const normalized = path?.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return normalized || undefined;
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
      };
      active.abort('live_constraint_monitor_failure');
    }, livenessPollMs);
    this.queueScan(active, 'phase_start');

    return { finish: () => this.finishInvocation(active) };
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
          };
          active.abort('live_constraint_monitor_failure');
          break;
        }
        active.lastSuccessfulScanAt = this.now();
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
    if (active.finished) return { incidents: [...active.incidents], ...(active.monitorFailure ? { monitorFailure: active.monitorFailure } : {}) };
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
    return {
      incidents: [...active.incidents],
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
