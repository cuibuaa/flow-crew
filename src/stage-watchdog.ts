import { mkdirSync } from './engine-fs.js';
import { isSessionHomeName } from './adapter-session.js';
import { stageLiveLogPath } from './stage-live-log.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { processGroupWork } from './process-liveness.js';
import { atomicWrite, isRunningStageStatus, isTerminalRunStatus, readRunState, readStageStatus,
  runDir as getRunDirPath, runningStageAttempt, type StageStatus, type StoreState } from './store.js';
import { ABORT_SIGNAL_VERSION, type StageAbortSignal } from './abort-signal.js';
import { readRunEvents } from './run-events.js';
import { createLogger } from './logging.js';
import { reportRunProcessProgress } from './adapters/base.js';

const log = createLogger({ name: 'stage-watchdog' });
export const DEFAULT_WATCHDOG_POLL_INTERVAL_MS = 30_000;

export interface StageWatchdogOptions {
  idleThresholdMs: number;
  pollIntervalMs?: number;
}

/** Current-attempt output, artifact and process work share one idle clock. */
export function detectStalledStages(input: {
  runningStages: string[];
  /** Stage ids that showed current-attempt output, artifact or process work THIS tick. */
  progressedStageIds: Set<string>;
  /** Per-stage last-progress timestamps carried across ticks (caller-owned). */
  lastProgressMs: Record<string, number>;
  now: number;
  thresholdMs: number;
}): { nextLastProgressMs: Record<string, number>; stalledStageIds: string[] } {
  const { runningStages, progressedStageIds, lastProgressMs, now, thresholdMs } = input;
  const next: Record<string, number> = {};
  const stalled: string[] = [];
  for (const stageId of runningStages) {
    if (progressedStageIds.has(stageId) || lastProgressMs[stageId] === undefined) {
      // First appearance OR fresh progress this tick → (re)set the clock; not stalled.
      next[stageId] = now;
      continue;
    }
    // No progress this tick — carry the prior timestamp forward and check the gap.
    next[stageId] = lastProgressMs[stageId];
    if (now - lastProgressMs[stageId] >= thresholdMs) stalled.push(stageId);
  }
  return { nextLastProgressMs: next, stalledStageIds: stalled };
}

export interface StageExecutionFacts {
  stageId: string;
  attemptIndex?: number;
  attemptStartedAt?: string;
  verdictObserved: boolean;
  outputObserved: boolean;
  handoffObserved: boolean;
  commitObserved: boolean;
  liveProgressThisTick: boolean;
  artifactProgressThisTick: boolean;
  activeCommandCount: number;
  commandActivityValid: boolean;
  finalizing: boolean;
  protectedFromIdleAbort: boolean;
  processWork?: string;
  processDescription?: string;
  processSample?: ReturnType<typeof processGroupWork>;
}

interface ProjectCommitFact {
  hash: string;
  committedAtMs: number;
}

interface AttemptGenerationRecord {
  version: 1;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  segmentStart: number;
}

function readAttemptGeneration(runDirectory: string, stageId: string): AttemptGenerationRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(runDirectory, 'stages', stageId, 'attempt_generation.json'), 'utf-8')) as AttemptGenerationRecord;
    if (parsed.version !== 1 || parsed.stageId !== stageId || !Number.isSafeInteger(parsed.attemptIndex)
      || typeof parsed.attemptStartedAt !== 'string' || !Number.isSafeInteger(parsed.segmentStart) || parsed.segmentStart < 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Compare bytes, not socket membership: zero-byte reconnects are not progress. */
function socketReadsAdvanced(current: string, previous?: string): boolean {
  if (previous === undefined) return false;
  try {
    const before = new Map<string, string>(JSON.parse(previous) as Array<[string, string]>);
    return (JSON.parse(current) as Array<[string, string]>).some(([inode, bytes]) => BigInt(bytes) > BigInt(before.get(inode) ?? '0'));
  } catch { return false; } // An unavailable/older observation establishes a baseline.
}

/**
 * Inspect only durable, current-attempt evidence. An output/verdict left by an
 * older attempt cannot make a new execution permanently immune to idle cancellation.
 */
export function inspectStageExecutionFacts(input: {
  runDir: string;
  stageId: string;
  status: StageStatus;
  sinceMs: number;
  commitObserved?: boolean;
  commitProgressThisTick?: boolean;
  previousProcessWork?: string;
}): StageExecutionFacts {
  const attempt = runningStageAttempt(input.status);
  const attemptStartedMs = attempt ? Date.parse(attempt.startedAt) : Number.NaN;
  const belongsToAttempt = (path: string): boolean => {
    if (!attempt || !Number.isFinite(attemptStartedMs)) return false;
    try {
      const stat = statSync(path);
      return stat.isFile() && stat.size > 0 && stat.mtimeMs >= attemptStartedMs;
    } catch {
      return false;
    }
  };
  const changedThisTick = (path: string): boolean => {
    if (!belongsToAttempt(path)) return false;
    // Heartbeat cutoffs use Date.now() milliseconds. Sub-millisecond filesystem
    // precision cannot make a previously observed clock tick new work again.
    try { return Math.floor(statSync(path).mtimeMs) > input.sinceMs; } catch { return false; }
  };

  const stageRoot = join(input.runDir, 'stages', input.stageId);
  const liveLogPath = stageLiveLogPath(input.runDir, input.stageId);
  const outputPath = join(stageRoot, 'output.md');
  const verdictPath = join(input.runDir, `verdict_${input.stageId}.json`);
  const handoffPath = join(input.runDir, `handoff_${input.stageId}.md`);
  const verdictObserved = belongsToAttempt(verdictPath);
  const outputObserved = belongsToAttempt(outputPath);
  const handoffObserved = belongsToAttempt(handoffPath);
  const commitObserved = input.commitObserved === true;
  let activeCommandCount = 0;
  let commandActivityValid = false;
  let processWork: string | undefined;
  let processDescription: string | undefined;
  let processSample: ReturnType<typeof processGroupWork>;
  let processProgress = false;
  if (attempt) {
    try {
      const activity = JSON.parse(readFileSync(join(stageRoot, 'command_activity.json'), 'utf-8')) as Record<string, unknown>;
      const active = Array.isArray(activity.active) ? activity.active : undefined;
      const updatedAtMs = typeof activity.updatedAt === 'string' ? Date.parse(activity.updatedAt) : Number.NaN;
      commandActivityValid = activity.version === 1
        && activity.stageId === input.stageId
        && activity.attemptIndex === attempt.index
        && activity.attemptStartedAt === attempt.startedAt
        && typeof activity.streamClosed === 'boolean'
        && active !== undefined
        && Number.isFinite(updatedAtMs)
        && updatedAtMs >= attemptStartedMs;
      if (commandActivityValid) {
        if (activity.streamClosed) processDescription = 'command stream closed; awaiting engine settlement';
        activeCommandCount = activity.streamClosed ? 0 : active!.filter((record) => {
          if (!record || typeof record !== 'object') return false;
          const value = record as Record<string, unknown>;
          const startedAtMs = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : Number.NaN;
          return typeof value.id === 'string' && value.id.length > 0
            && Number.isFinite(startedAtMs) && startedAtMs >= attemptStartedMs;
        }).length;
        const process = activity.process as { pid?: number; startTimeTicks?: string; kind?: string } | undefined;
        if (Number.isSafeInteger(process?.pid) && typeof process?.startTimeTicks === 'string') {
          const kind = process!.kind === 'command' ? 'command' : 'provider';
          const work = processGroupWork(process!.pid!, process!.startTimeTicks, kind);
          if (work) {
            processSample = work;
            const providerReading = kind === 'provider' && activeCommandCount === 0;
            processWork = providerReading ? work.readWork : work.fingerprint;
            processProgress = !activity.streamClosed && processWork !== undefined
              && (providerReading ? socketReadsAdvanced(processWork, input.previousProcessWork) : input.previousProcessWork !== processWork);
            // Changed counters prove local work; unchanged counters cannot rule
            // out work in containers, on a GPU, or through another process.
            const command = active!.map(record => (record as { command?: string }).command).filter(Boolean).join('; ');
            processDescription = activity.streamClosed ? 'command stream closed; awaiting engine settlement' : kind === 'command'
              ? `${processProgress ? 'working in' : 'waiting on'} local command ${command}; ${processProgress ? 'process work observed' : `no sampled CPU${work.ioObserved ? '/I/O' : ''} work`}${work.ioObserved ? '' : '; I/O counters unavailable'}`
              : `${activeCommandCount ? 'provider/tool' : 'provider'} stream; ${processProgress ? (activeCommandCount ? 'process work or socket receive progress observed' : 'socket receive progress observed') : 'awaiting provider output'}`;
          }
        }
      }
    } catch { /* missing/malformed activity never grants protection */ }
  }

  const internalName = /^(?:live(?:_attempt_\d+_[a-f0-9]{24})?\.log$|status\.json$|input\.md$|guidance(?:_consumed)?\.md$|command_activity\.json$|attempt_generation\.json$|attempt_deadline_|invocations$|session\.json$|constraint_audit_|write_boundary_|output_attempt_)/;
  let stageArtifactChanged = false;
  const walk = (dir: string, depth: number): void => {
    if (stageArtifactChanged || depth > 3) return;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[]; } catch { return; }
    for (const entry of entries) {
      if (internalName.test(entry.name) || isSessionHomeName(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && changedThisTick(path)) stageArtifactChanged = true;
      if (stageArtifactChanged) return;
    }
  };
  walk(stageRoot, 0);
  const generation = readAttemptGeneration(input.runDir, input.stageId);
  const generationMatches = generation?.attemptIndex === attempt?.index && generation?.attemptStartedAt === attempt?.startedAt;
  const liveProgressThisTick = changedThisTick(liveLogPath)
    && (!generationMatches || statSync(liveLogPath).size > generation!.segmentStart);
  const artifactProgressThisTick = stageArtifactChanged
    || changedThisTick(verdictPath)
    || changedThisTick(handoffPath)
    || (commitObserved && input.commitProgressThisTick !== false);
  const finalizing = outputObserved && !verdictObserved;
  const protectedFromIdleAbort = artifactProgressThisTick || liveProgressThisTick || processProgress;
  return {
    stageId: input.stageId,
    attemptIndex: attempt?.index,
    attemptStartedAt: attempt?.startedAt,
    verdictObserved,
    outputObserved,
    handoffObserved,
    commitObserved,
    liveProgressThisTick,
    artifactProgressThisTick,
    activeCommandCount,
    commandActivityValid,
    finalizing,
    protectedFromIdleAbort,
    processWork,
    processDescription,
    processSample,
  };
}

export function describeStageExecutionFacts(facts: StageExecutionFacts): string {
  const attempt = facts.attemptIndex === undefined ? 'no active attempt observed' : `active attempt ${facts.attemptIndex}`;
  return [
    attempt,
    facts.verdictObserved ? 'verdict observed' : 'no verdict observed',
    facts.outputObserved ? 'final output observed' : 'no final output observed',
    facts.handoffObserved ? 'handoff observed' : 'no handoff observed',
    facts.commitObserved ? 'commit observed' : 'no current-attempt commit observed',
    facts.activeCommandCount > 0
      ? `${facts.activeCommandCount} active command${facts.activeCommandCount === 1 ? '' : 's'} observed`
      : facts.commandActivityValid ? 'no active command observed' : 'no valid command activity record',
    facts.liveProgressThisTick ? 'live output changed during verification' : 'no live-output change during verification',
    facts.processDescription ?? 'no verified process observation',
    facts.finalizing ? 'finalization window active' : 'finalization window inactive',
  ].join('; ');
}

interface StageObservation {
  facts: StageExecutionFacts;
  lastProgressAt: number;
  aborted: boolean;
}

/** One owner binds progress and cancellation to the observed execution. A new
 * attempt resets both; inactive observations cannot carry into later work. */
class StageObservations {
  private readonly stages = new Map<string, StageObservation>();

  facts(stageId: string): StageExecutionFacts | undefined { return this.stages.get(stageId)?.facts; }
  lastProgressAt(stageId: string): number | undefined { return this.stages.get(stageId)?.lastProgressAt; }
  owns(facts: StageExecutionFacts): boolean {
    const previous = this.facts(facts.stageId);
    return previous !== undefined && previous.attemptIndex === facts.attemptIndex
      && previous.attemptStartedAt === facts.attemptStartedAt;
  }
  wasAborted(stageId: string): boolean { return this.stages.get(stageId)?.aborted === true; }
  recordAbort(stageId: string): void { this.stages.get(stageId)!.aborted = true; }
  recordProgress(facts: StageExecutionFacts, now: number): void {
    Object.assign(this.stages.get(facts.stageId)!, { facts, lastProgressAt: now });
  }
  restore(facts: StageExecutionFacts, lastProgressAt: number): void {
    this.stages.set(facts.stageId, { facts, lastProgressAt, aborted: false });
  }
  snapshot(thresholdMs: number): Record<string, StageExecutionFacts & { lastProgressAt: number; idleThresholdMs: number }> {
    return Object.fromEntries([...this.stages].map(([id, entry]) => [id, {
      ...entry.facts, lastProgressAt: entry.lastProgressAt, idleThresholdMs: thresholdMs,
    }]));
  }
  reconcile(facts: ReadonlyMap<string, StageExecutionFacts>, now: number, thresholdMs: number): string[] {
    const progressedStageIds = new Set<string>();
    const lastProgressMs: Record<string, number> = {};
    for (const [id, value] of facts) {
      const entry = this.stages.get(id);
      if (!this.owns(value)) { this.restore(value, now); progressedStageIds.add(id); }
      else entry!.facts = value;
      if (value.protectedFromIdleAbort) progressedStageIds.add(id);
      lastProgressMs[id] = this.lastProgressAt(id)!;
    }
    const result = detectStalledStages({ runningStages: [...facts.keys()], progressedStageIds, lastProgressMs, now, thresholdMs });
    for (const [id, entry] of this.stages) {
      if (!facts.has(id)) this.stages.delete(id);
      else entry.lastProgressAt = result.nextLastProgressMs[id];
    }
    return result.stalledStageIds;
  }
}

/**
 * The watchdog owns only deterministic cancellation. Keeping these observations
 * outside the removed model supervisor preserves silent work and idle bounds.
 */
export class StageWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly stageObservations = new StageObservations();
  private lastArtifactCheckMs = 0;

  constructor(
    private projectDir: string,
    private runId: string,
    private options: StageWatchdogOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.restoreProgress();
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick().catch(err => log.error(err, 'Stage watchdog tick failed'))
        .finally(() => this.scheduleNextTick());
    }, this.options.pollIntervalMs ?? DEFAULT_WATCHDOG_POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private runDir(): string { return getRunDirPath(this.projectDir, this.runId); }

  private authoritativeStageStatus(stageId: string, fallback: StageStatus): StageStatus {
    try { return readStageStatus(this.projectDir, this.runId, stageId); } catch { return fallback; }
  }

  private readProjectCommit(): ProjectCommitFact | undefined {
    try {
      const output = execFileSync('git', ['show', '-s', '--format=%H%x00%cI', 'HEAD'], {
        cwd: this.projectDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
      }).trim();
      const [hash, committedAt] = output.split('\0');
      const committedAtMs = Date.parse(committedAt);
      if (!/^[0-9a-f]{7,40}$/i.test(hash) || !Number.isFinite(committedAtMs)) return undefined;
      return { hash, committedAtMs };
    } catch { return undefined; }
  }

  private inspectFacts(stageId: string, status: StageStatus, sinceMs: number,
    baseCommit?: string, projectCommit = this.readProjectCommit()): StageExecutionFacts {
    const attempt = runningStageAttempt(status);
    const attemptStartedMs = attempt ? Date.parse(attempt.startedAt) : Number.NaN;
    const commitObserved = Boolean(attempt && projectCommit && projectCommit.hash !== baseCommit
      && Number.isFinite(attemptStartedMs) && projectCommit.committedAtMs + 999 >= attemptStartedMs);
    return inspectStageExecutionFacts({
      runDir: this.runDir(), stageId, status, sinceMs, commitObserved,
      commitProgressThisTick: Boolean(projectCommit && projectCommit.committedAtMs + 999 >= sinceMs),
      previousProcessWork: this.stageObservations.facts(stageId)?.processWork,
    });
  }

  private persistProgress(): void {
    try {
      atomicWrite(join(this.runDir(), 'stage_watchdog.json'), JSON.stringify({
        stageProgress: this.stageObservations.snapshot(this.options.idleThresholdMs),
        stageProgressObservedAt: this.lastArtifactCheckMs,
      }, null, 2));
    } catch { /* cancellation does not depend on dashboard publication */ }
  }

  /** Resume only observations bound to the current execution, including old runs. */
  restoreProgress(): void {
    try {
      const current = join(this.runDir(), 'stage_watchdog.json');
      const path = existsSync(current) ? current : join(this.runDir(), 'supervisor_state.json');
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
        stageProgress?: Record<string, StageExecutionFacts & { lastProgressAt: number }>;
        stageProgressObservedAt?: number;
      };
      const state = readRunState(this.projectDir, this.runId);
      for (const [stageId, facts] of Object.entries(parsed.stageProgress ?? {})) {
        const status = state.stages[stageId];
        const attempt = status && runningStageAttempt(this.authoritativeStageStatus(stageId, status));
        if (!attempt || facts.attemptIndex !== attempt.index || facts.attemptStartedAt !== attempt.startedAt
          || !Number.isFinite(facts.lastProgressAt) || facts.lastProgressAt > Date.now()) continue;
        this.stageObservations.restore({ ...facts, stageId }, facts.lastProgressAt);
      }
      if (Number.isFinite(parsed.stageProgressObservedAt) && parsed.stageProgressObservedAt! <= Date.now()) {
        this.lastArtifactCheckMs = parsed.stageProgressObservedAt!;
      }
    } catch { /* first start or missing historical progress */ }
  }

  /** Re-read execution ownership and progress immediately before cancellation. */
  private writeVerifiedAbort(stageId: string, sinceMs: number): { written: boolean; reason: string } {
    let state: StoreState;
    try { state = readRunState(this.projectDir, this.runId); }
    catch { return { written: false, reason: 'no readable run state observed' }; }
    const status = state.stages[stageId];
    if (!status || !isRunningStageStatus(status.status)) return { written: false, reason: 'no active running stage observed' };
    const authoritative = this.authoritativeStageStatus(stageId, status);
    if (!isRunningStageStatus(authoritative.status)) return { written: false, reason: 'no active running execution observed' };
    const facts = this.inspectFacts(stageId, authoritative, sinceMs, state.baseCommit);
    if (facts.attemptIndex === undefined || !this.stageObservations.owns(facts)) {
      return { written: false, reason: 'current execution changed during final verification' };
    }
    if (facts.protectedFromIdleAbort) {
      this.stageObservations.recordProgress(facts, Date.now());
      reportRunProcessProgress(this.projectDir, this.runId);
      return { written: false, reason: 'current live, artifact or process work was observed during final verification' };
    }
    const lastProgressAt = this.stageObservations.lastProgressAt(stageId);
    const idleMs = lastProgressAt === undefined ? -1 : Date.now() - lastProgressAt;
    if (idleMs < this.options.idleThresholdMs) return { written: false, reason: 'verified idle duration is below the configured threshold' };
    const environmentWaits = new Map<string, string>();
    for (const event of readRunEvents(this.projectDir, this.runId)) {
      const eventMs = Date.parse(event.timestamp);
      if (event.stageId !== stageId || event.attemptIndex !== facts.attemptIndex
        || !Number.isFinite(eventMs) || eventMs < Date.parse(facts.attemptStartedAt!)
        || (event.attemptStartedAt !== undefined && event.attemptStartedAt !== facts.attemptStartedAt)) continue;
      const key = event.observationId ?? 'legacy';
      if (event.type === 'stage_environment_wait_started' && event.detail) environmentWaits.set(key, event.detail);
      else if (event.type === 'stage_environment_wait_finished') environmentWaits.delete(key);
    }
    const waits = [...environmentWaits.values()];
    const basis = waits.length
      ? `pre_execution environment wait at watchdog threshold (${Math.round(idleMs / 1000)}s idle; threshold ${Math.round(this.options.idleThresholdMs / 1000)}s): ${waits.join('; ')}`
      : `no verified live/artifact/process progress for ${idleMs}ms (threshold ${this.options.idleThresholdMs}ms)`;
    const reason = `Watchdog ABORT verified for ${stageId} attempt ${facts.attemptIndex}: ${basis}; ${describeStageExecutionFacts(facts)}.`;
    const signal: StageAbortSignal = { version: ABORT_SIGNAL_VERSION, stageId, attemptIndex: facts.attemptIndex,
      reason, timestamp: new Date().toISOString(), source: 'watchdog' };
    try {
      mkdirSync(join(this.runDir(), 'signals'), { recursive: true });
      atomicWrite(join(this.runDir(), 'signals', `abort_${stageId}.json`), JSON.stringify(signal, null, 2));
      return { written: true, reason };
    } catch { return { written: false, reason: 'the owned cancellation signal could not be persisted' }; }
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    let state: StoreState;
    try { state = readRunState(this.projectDir, this.runId); } catch { return; }
    if (isTerminalRunStatus(state.status)) { this.stop(); return; }
    const runningStages = Object.entries(state.stages).filter(([, status]) => isRunningStageStatus(status.status)).map(([id]) => id);
    const now = Date.now();
    const cutoff = this.lastArtifactCheckMs || (now - this.options.idleThresholdMs);
    this.lastArtifactCheckMs = now;
    const projectCommit = this.readProjectCommit();
    const stageFacts = new Map<string, StageExecutionFacts>();
    for (const stageId of runningStages) {
      const status = this.authoritativeStageStatus(stageId, state.stages[stageId]);
      const facts = this.inspectFacts(stageId, status, cutoff, state.baseCommit, projectCommit);
      stageFacts.set(stageId, facts);
    }
    const stalledStageIds = this.stageObservations.reconcile(stageFacts, now, this.options.idleThresholdMs);
    if ([...stageFacts.values()].some(facts => facts.protectedFromIdleAbort)) reportRunProcessProgress(this.projectDir, this.runId);
    for (const stageId of stalledStageIds) {
      if (this.stageObservations.wasAborted(stageId)) continue;
      const abort = this.writeVerifiedAbort(stageId, cutoff);
      if (abort.written) {
        this.stageObservations.recordAbort(stageId);
        log.warn({ runId: this.runId, stageId, reason: abort.reason }, 'Stage watchdog idle cancellation');
      }
    }
    this.persistProgress();
  }
}
