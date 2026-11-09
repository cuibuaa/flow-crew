import { runRecordPath } from './run-layout.js';
import { readOptionalJsonlFile } from './jsonl.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { atomicWrite, closeSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, unlinkSync } from './engine-fs.js';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { RunEvent } from './run-events.js';
import type { StoreState } from './store.js';
import { isPausedRunStatus, isTerminalRunStatus, isSuccessfulRunStatus } from './lifecycle-status.js';
import { TaskRegistry, TASK_LIST_STATUS, isActiveTaskStatus, hasLiveForegroundOwner, sessionTaskIndexPath, type TaskEntry } from './task-registry.js';
import { codexRequest, queueCodex, sendClaude, notifyFallback } from './session-push-transport.js';
import { publicTaskEntries, readTaskLedger, refreshOpenTaskLedger, type LedgerReadResult } from './fc-tasks.js';
import { hasClaudeWakeWaiter } from './session-wake.js';

export interface LaunchTarget {
  frontend: 'claude' | 'codex';
  sessionId: string;
  cwd: string;
  socket?: string;
  codexHome?: string;
  ledgerRoot: string;
}

export function captureLauncher(env: NodeJS.ProcessEnv, cwd: string, session?: string): LaunchTarget | undefined {
  const frontend = env.CLAUDE_CODE_SESSION_ID ? 'claude' : env.CODEX_THREAD_ID ? 'codex' : undefined;
  const sessionId = session ?? (frontend === 'claude' ? env.CLAUDE_CODE_SESSION_ID : env.CODEX_THREAD_ID);
  if (!frontend || !sessionId || !/^[\w-]+$/u.test(sessionId)) return undefined;
  const home = resolve(cwd, env.HOME || homedir());
  const codexHome = resolve(cwd, env.CODEX_HOME || join(home, '.codex'));
  return {
    frontend, sessionId, cwd: resolve(cwd),
    ledgerRoot: resolve(cwd, env.FC_TASKS_ROOT || join(home, '.claude', 'tasks')),
    ...(frontend === 'claude'
      ? { socket: env.CLAUDE_CODE_MESSAGING_SOCKET ? resolve(cwd, env.CLAUDE_CODE_MESSAGING_SOCKET) : undefined }
      : { codexHome, socket: resolve(cwd, env.CODEX_APP_SERVER_SOCKET || join(codexHome, 'app-server-control', 'app-server-control.sock')) }),
  };
}

export { estimateProgress, progressLine } from './task-progress.js';
import { estimateProgress, progressLine, summarizeProgressHistory, type ProgressRun, type ProgressHistory } from './task-progress.js';

export interface PushEvent {
  version: 1;
  eventId: string;
  taskId: number;
  runId: string;
  launch?: number;
  attemptIndex?: number;
  stageId?: string;
  attemptStartedAt?: string;
  kind: string;
  detail?: string;
  createdAt: string;
  occurredAt: string;
  target: LaunchTarget;
  taskTitle?: string;
  requestId?: string;
  requestTitle?: string;
  requestTarget?: string;
  runStatus?: string;
  lastStage?: string;
  reportPath?: string;
  failureIdentity?: string;
}
function normalizePushEvent(event: PushEvent & { attempt?: number }): PushEvent {
  const { attempt, ...current } = event;
  return { ...current,
    launch: current.launch ?? (current.stageId ? undefined : attempt === 0 ? 1 : undefined),
    attemptIndex: current.attemptIndex ?? (current.stageId ? attempt : undefined),
  };
}
interface DeliveryState {
  superseded?: { runId: string; requestId: string; decision: 'approve' | 'deny'; at: string; observedAt: string; ackRequired: false };
  attempts: number;
  failures?: number;
  target?: string;
  transport?: 'inbox' | 'wake' | 'queue';
  nextAttemptAt?: number;
  sentAt?: string;
  receipt?: string;
  error?: string;
  fallbackAt?: string;
  fallbackError?: string;
  fallbackRetryAt?: number;
}
export interface DisplayState {
  threadId?: string;
  error?: string;
  retryAt?: number;
  title?: string;
  progress?: ProgressRun;
  history?: ProgressHistory;
  refreshedAt?: number;
}

function load<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function loadText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** fsync then atomic publish. Exclusive records (event/ACK) are immutable;
 * retries and acknowledgements never overwrite each other's state. */
function publish(path: string, value: unknown, exclusive = false): boolean {
  mkdirSync(resolve(path, '..'), { recursive: true });
  return atomicWrite(path, `${JSON.stringify(value)}\n`, { durability: 'durable', mode: 0o600, exclusive });
}
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeId = (id: string) => { if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid event id'); return id; };

export const PUSH_RETRY_MS = 120_000;
const PUSH_REMINDER_MS = 30 * 60_000;
export const PUSH_FALLBACK_MS = 10 * 60_000;
const needsLauncher = (status: unknown) => isTerminalRunStatus(status) || isPausedRunStatus(status);

export interface PushDependencies {
  now?: () => number;
  rpc?: typeof codexRequest;
  queue?: typeof queueCodex;
  claude?: typeof sendClaude;
  notify?: typeof notifyFallback;
}

export class SessionPush {
  private readonly now: () => number;
  private readonly rpc: typeof codexRequest;
  private readonly queue: typeof queueCodex;
  private readonly claude: typeof sendClaude;
  private readonly notify: typeof notifyFallback;
  private historyCache?: { at: number; runs: ProgressRun[] };
  private readonly loadedDisplays = new Set<string>();
  private readonly displaySockets = new Map<string, string>();
  constructor(readonly registry: TaskRegistry, dependencies: PushDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.rpc = dependencies.rpc ?? codexRequest;
    this.queue = dependencies.queue ?? queueCodex;
    this.claude = dependencies.claude ?? sendClaude;
    this.notify = dependencies.notify ?? notifyFallback;
  }
  get root(): string { return join(this.registry.baseDir, 'session-push'); }
  private eventPath(id: string): string { return join(this.root, 'events', `${safeId(id)}.json`); }
  private ackPath(id: string): string { return join(this.root, 'acks', `${safeId(id)}.json`); }
  private deliveryPath(id: string): string { return join(this.root, 'delivery', `${safeId(id)}.json`); }
  private displayPath(id: number): string { return join(this.registry.baseDir, 'tasks', String(id), 'session-push.json'); }
  display(id: number): DisplayState { return load<DisplayState>(this.displayPath(id)) ?? {}; }
  bindDisplay(id: number, threadId: string): void {
    publish(this.displayPath(id), { ...this.display(id), threadId, retryAt: undefined, error: undefined });
  }
  acknowledged(id: string): boolean { return existsSync(this.ackPath(id)); }
  delivery(id: string): DeliveryState { return load<DeliveryState>(this.deliveryPath(id)) ?? { attempts: 0 }; }
  /** Exactly one hook completion for an engine-selected wake attempt. The
   * immutable claim is separate from mutable delivery state and business ACK. */
  claimWake(event: PushEvent): boolean {
    if (this.acknowledged(event.eventId) || this.superseded(event)) return false;
    const state = this.delivery(event.eventId);
    if (state.transport !== 'wake' || state.attempts < 1) return false;
    const claimed = publish(join(this.root, 'wake-claims', `${safeId(event.eventId)}-${state.attempts}.json`),
      { eventId: event.eventId, attempt: state.attempts, claimedAt: this.now() }, true);
    // Recheck after claiming: an ACK that won the race must never cause a loop.
    return claimed && !this.acknowledged(event.eventId);
  }
  events(): PushEvent[] {
    const directory = join(this.root, 'events');
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))
      .map(name => load<PushEvent>(join(directory, name))!).filter(Boolean).map(normalizePushEvent);
  }
  private pendingDirectory(frontend: LaunchTarget['frontend'], session: string): string {
    return join(this.root, 'pending', key([frontend, session]));
  }
  private indexEventUnlocked(event: PushEvent): void {
    const path = join(this.pendingDirectory(event.target.frontend, event.target.sessionId), `${safeId(event.eventId)}.json`);
    if (this.acknowledged(event.eventId) || this.superseded(event)) {
      try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } else {
      mkdirSync(resolve(path, '..'), { recursive: true });
      try { linkSync(this.eventPath(event.eventId), path); syncDirectory(resolve(path, '..')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
  private indexEvent(event: PushEvent): void {
    const path = join(this.pendingDirectory(event.target.frontend, event.target.sessionId), `${safeId(event.eventId)}.json`);
    // Immutable links already in their desired disposition need no publication.
    const retired = this.acknowledged(event.eventId) || this.superseded(event);
    const exists = existsSync(path);
    if (retired ? !exists : exists) return;
    this.registry.withSessionWrite(() => this.indexEventUnlocked(event));
  }
  /** Writer-side migration. A reader must never discover ownership by scanning
   * the global outbox. Immutable event and ACK records remain authoritative. */
  private ensureEventIndex(): void {
    const ready = join(this.root, 'pending', 'ready');
    if (existsSync(ready)) return;
    this.registry.withSessionWrite(() => {
      if (existsSync(ready)) return;
      for (const event of this.events()) this.indexEventUnlocked(event);
      publish(ready, { version: 1 });
    });
  }
  pending(session?: string, frontend?: LaunchTarget['frontend']): PushEvent[] {
    if (!session) return this.events().filter(event => !this.acknowledged(event.eventId) && !this.superseded(event)).map(event => this.describe(event));
    if (!existsSync(join(this.root, 'pending', 'ready')) && existsSync(join(this.root, 'events'))) {
      throw new Error('Session event view unavailable; restart the FlowCrew push service to rebuild it');
    }
    return (frontend ? [frontend] : ['claude', 'codex'] as const).flatMap(kind => {
      const directory = this.pendingDirectory(kind, session);
      let names: string[];
      try { names = readdirSync(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      return names.map(name => load<PushEvent>(join(directory, name))).filter((event): event is PushEvent => !!event)
        .filter(event => {
          if (event.target.frontend !== kind || event.target.sessionId !== session) throw new Error('Invalid session event view');
          return !this.acknowledged(event.eventId) && !this.superseded(event);
        }).map(normalizePushEvent);
    });
  }
  /** A delivery disposition retires the obligation without forging a business ACK.
   * The push service observes run records; it never writes into another run. */
  private superseded(event: PushEvent): boolean {
    if (this.delivery(event.eventId).superseded) return true;
    return false;
  }
  private runDirectory(event: PushEvent): string | undefined {
    return /^[\w.-]+$/u.test(event.runId) && event.runId !== '.' && event.runId !== '..'
      ? join(this.registry.baseDir, 'runs', event.runId) : undefined;
  }
  /** Enrich from structured records, including legacy events. Never parse detail. */
  describe(event: PushEvent): PushEvent {
    const task = event.taskTitle ? undefined : this.registry.get(event.taskId);
    const directory = this.runDirectory(event);
    const state = directory && load<StoreState>(join(directory, 'run.json'));
    const failure = ['attempt_failed', 'stage_failed'].includes(event.kind);
    const needsOriginal = failure && !event.failureIdentity;
    const original = directory && needsOriginal && readOptionalJsonlFile<RunEvent>(join(directory, 'events.jsonl'))
      .find(source => source.type === event.kind && source.timestamp === event.occurredAt
        && source.stageId === event.stageId
        && (event.attemptIndex === undefined || source.attemptIndex === event.attemptIndex));
    const stages = state ? Object.entries(state.stages ?? {}).filter(([, stage]) => stage.startedAt || stage.completedAt)
      .sort((a, b) => (a[1].completedAt || a[1].startedAt || '').localeCompare(b[1].completedAt || b[1].startedAt || '')) : [];
    return { ...event, taskTitle: event.taskTitle || task?.name,
      failureIdentity: event.failureIdentity || (original && (providerFailureIdentity(original) || original.adapterFailureKind
        || (original.exitCode === undefined ? undefined : `exit ${original.exitCode}`))) || undefined,
      runStatus: event.runStatus || (state && state.status) || undefined,
      lastStage: event.lastStage || stages.at(-1)?.[0],
      reportPath: event.reportPath || (directory && existsSync(runRecordPath(directory, 'summary.md')) ? runRecordPath(directory, 'summary.md') : undefined),
    };
  }
  sessionTasks(frontend: LaunchTarget['frontend'], sessionId: string): TaskEntry[] {
    if (existsSync(join(this.root, 'task-index', 'dirty'))) throw new Error('Session task view publication interrupted; the next registry writer or push-service sweep will repair it');
    const ready = loadText(join(this.root, 'task-index', 'ready'));
    if (ready !== '2\n') {
      if (!existsSync(this.registry.registryPath)) return [];
      throw new Error('Session task view unavailable; restart the FlowCrew push service to rebuild it');
    }
    return (load<number[]>(sessionTaskIndexPath(this.registry.baseDir, { frontend, sessionId })) ?? [])
      .map(id => this.registry.get(id, { frontend, sessionId }))
      .filter((task): task is TaskEntry => !!task && task.launcher?.frontend === frontend && task.launcher.sessionId === sessionId);
  }
  /** Tasks wake coverage must be renewed for. A finished task's open ledger entry is a reminder;
   * only work that can still produce an event, or a pending event itself, justifies a model turn. */
  openTasks(frontend: LaunchTarget['frontend'], session: string): TaskEntry[] {
    return this.sessionTasks(frontend, session).filter(task => isActiveTaskStatus(task.status));
  }
  private closeHandledTask(task: TaskEntry, events: PushEvent[], ledger = readTaskLedger(task.launcher!.ledgerRoot, task.launcher!.sessionId, Number.MAX_SAFE_INTEGER)): boolean {
    const closed = !ledger.issues.length && publicTaskEntries(ledger).some(entry => entry.flowcrewTaskId === task.id && entry.status === 'completed');
    const currentRun = task.run_id || `task-${task.id}`;
    if (!closed || !events.some(event => event.runId === currentRun)
        || !events.every(event => this.acknowledged(event.eventId) || this.superseded(event))) return false;
    this.registry.closeSessionTask(task);
    return !isActiveTaskStatus(task.status);
  }
  deliveryReady(task: TaskEntry): boolean {
    if (!task.launcher) return false;
    const target = this.currentTarget(task.launcher);
    const pending = this.pending(target.sessionId, target.frontend).filter(event => event.taskId === task.id);
    if (target.frontend === 'claude' && (pending.length || isActiveTaskStatus(task.status)) && !hasClaudeWakeWaiter(this.root, target.sessionId, this.now())) {
      try { if (!target.socket || !lstatSync(target.socket).isSocket()) return false; } catch { return false; }
    }
    return pending.every(event => !load<DeliveryState>(this.deliveryPath(event.eventId))?.error);
  }
  enqueue(task: TaskEntry, source: Pick<RunEvent, 'type' | 'timestamp' | 'runId' | 'attemptIndex' | 'detail' | 'stageId' | 'attemptStartedAt' | 'requestId' | 'runStatus' | 'providerFailure' | 'adapterFailureKind' | 'exitCode'>, identity: unknown = source): PushEvent | undefined {
    if (!task.launcher) return undefined;
    this.ensureEventIndex();
    const eventId = key([task.id, source.runId, identity]);
    const existing = load<PushEvent>(this.eventPath(eventId))
      // Old fallback observations hashed the zero-based launch sequence.
      ?? (Array.isArray(identity) ? load<PushEvent>(this.eventPath(key([task.id, source.runId,
        identity.map(value => typeof value === 'number' ? value - 1 : value)]))) : undefined);
    if (existing) { this.indexEvent(normalizePushEvent(existing)); return normalizePushEvent(existing); }
    const event: PushEvent = this.describe({
      version: 1, eventId, taskId: task.id,
      runId: source.runId, launch: task.launch, attemptIndex: source.attemptIndex, kind: source.type,
      stageId: source.stageId, attemptStartedAt: source.attemptStartedAt,
      detail: source.detail, createdAt: new Date(this.now()).toISOString(), occurredAt: source.timestamp, target: task.launcher,
      taskTitle: task.name, requestId: source.requestId, runStatus: source.runStatus,
      failureIdentity: providerFailureIdentity(source) || source.adapterFailureKind
        || (source.exitCode === undefined ? undefined : `exit ${source.exitCode}`),
    });
    const canonical = publish(this.eventPath(event.eventId), event, true)
      ? event : normalizePushEvent(load<PushEvent>(this.eventPath(event.eventId))!);
    this.indexEvent(canonical);
    return canonical;
  }
  /** Capture before a manual retry can discard this task's old run binding. */
  capture(task: TaskEntry): void { if (task.launcher) this.collect(task, this.run(task)); }
  acknowledge(id: string, session: string): PushEvent {
    const stored = load<PushEvent>(this.eventPath(id));
    const event = stored && normalizePushEvent(stored);
    if (!event) throw new Error('Unknown event id');
    if (event.target.sessionId !== session) throw new Error('Event belongs to a different launching session');
    this.registry.withSessionWrite(() => {
      if (this.acknowledged(id)) { this.indexEventUnlocked(event); return; }
      const directory = this.pendingDirectory(event.target.frontend, session);
      mkdirSync(join(this.root, 'acks'), { recursive: true });
      // Moving the immutable event link publishes ACK and retires the pending
      // obligation in one operation. No killed ACK writer leaves closed history
      // in the directory polled by this session. Legacy ACK receipts stay intact.
      mkdirSync(directory, { recursive: true });
      try { linkSync(this.eventPath(id), join(directory, `${safeId(id)}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      renameSync(join(directory, `${safeId(id)}.json`), this.ackPath(id));
      for (const path of [directory, join(this.root, 'acks')]) syncDirectory(path);
    });
    const task = this.registry.get(event.taskId);
    if (task?.launcher) this.closeHandledTask(task, this.events().filter(candidate => candidate.taskId === task.id));
    return event;
  }
  refreshSession(frontend: LaunchTarget['frontend'], sessionId: string, socket?: string): void {
    if (!sessionId || !/^[\w-]+$/u.test(sessionId)) throw new Error('Invalid session id');
    const path = join(this.root, 'sessions', `${key([frontend, sessionId])}.json`);
    const previous = load<{ socket?: string }>(path);
    publish(path, {
      frontend, sessionId, socket: socket ?? previous?.socket, updatedAt: this.now(),
    });
  }
  private wakeCapabilityPath(session: string): string {
    return join(this.root, 'sessions', `wake-${key(session)}.json`);
  }
  /** One immutable registration fact per session, separate from socket refreshes
   * so concurrent hooks cannot erase capability while updating an address. */
  registerClaudeWake(session: string): void {
    if (!/^[\w-]+$/u.test(session)) throw new Error('Invalid wake session id');
    publish(this.wakeCapabilityPath(session), { sessionId: session, registeredAt: this.now() }, true);
  }
  private claudeWakeCapable(session: string): boolean {
    if (existsSync(this.wakeCapabilityPath(session))) return true;
    // Upgrade sessions that already woke before registration facts existed.
    // Mutable delivery state may since have fallen back to inbox; claims cannot.
    const claims = join(this.root, 'wake-claims');
    if (!existsSync(claims)) return false;
    for (const name of readdirSync(claims)) {
      const id = /^([a-f0-9]{64})-\d+\.json$/u.exec(name)?.[1];
      const event = id && load<PushEvent>(this.eventPath(id));
      if (event && event.target.frontend === 'claude' && event.target.sessionId === session) {
        this.registerClaudeWake(session);
        return true;
      }
    }
    return false;
  }
  private currentTarget(target: LaunchTarget): LaunchTarget {
    const registered = load<{ socket?: string }>(join(this.root, 'sessions', `${key([target.frontend, target.sessionId])}.json`));
    return registered?.socket ? { ...target, socket: registered.socket } : target;
  }
  private run(task: TaskEntry): ProgressRun | undefined {
    if (!task.run_id || isAbsolute(task.run_id) || !/^[\w.-]+$/u.test(task.run_id)) return undefined;
    const run = load<StoreState>(join(this.registry.baseDir, 'runs', task.run_id, 'run.json'));
    if (!run) return undefined;
    if (run.runId !== task.run_id || resolve(run.projectDir) !== resolve(task.projectDir)) throw new Error('Session push run binding mismatch');
    return { status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, workflowName: run.workflowName === 'default' ? 'planner' : run.workflowName,
      stages: Object.fromEntries(Object.entries(run.stages).map(([id, stage]) => [id, {
        status: stage.status, startedAt: stage.startedAt, completedAt: stage.completedAt, duration_ms: stage.duration_ms,
      }])) };
  }
  private collect(task: TaskEntry, run?: ProgressRun): void {
    if (task.run_id && /^[\w.-]+$/u.test(task.run_id)) {
      const path = join(this.registry.baseDir, 'runs', task.run_id, 'events.jsonl');
      let lifecycleRecorded = false;
      let lastLifecycle: RunEvent | undefined;
      for (const event of readOptionalJsonlFile<RunEvent>(path)) {
        if (event.runId !== task.run_id) continue;
        if (event.type === 'operator_wrap_up_required' || event.type === 'run_status_changed') {
          lastLifecycle = event;
          lifecycleRecorded = event.runStatus === run?.status
            && (event.type === 'operator_wrap_up_required' || !isTerminalRunStatus(event.runStatus));
        }
        if (['operator_wrap_up_required', 'attempt_failed', 'stage_failed'].includes(event.type)
            || (event.type === 'run_status_changed' && isPausedRunStatus(event.runStatus))) this.enqueue(task, event);
      }
      // A crash between the status commit and event append must still wake the
      // launcher. Stable lifecycle identity deduplicates every restart/sweep.
      if (run && needsLauncher(run.status) && !lifecycleRecorded) {
        this.enqueue(task, { type: 'operator_wrap_up_required', runId: task.run_id,
          timestamp: run.completedAt || task.completed_at || task.created_at,
          detail: `Run ${run.status}; inspect current state before acting.` },
        ['run-state', task.run_id, run.status, run.completedAt, task.launch, lastLifecycle]);
      }
    }
    if ((!run || !needsLauncher(run.status)) && !isActiveTaskStatus(task.status)) {
      this.enqueue(task, { type: 'operator_wrap_up_required', runId: task.run_id || `task-${task.id}`,
        timestamp: task.completed_at || task.created_at, detail: `Task ${task.status}: ${task.notes || ''}` },
      ['task-state', task.status, task.launch, task.completed_at]);
    }
  }
  async ensureDisplay(task: TaskEntry, run?: ProgressRun, history: ProgressRun[] = []): Promise<void> {
    if (!task.launcher) return;
    const display = this.display(task.id);
    display.progress = run;
    const summary = summarizeProgressHistory(run?.workflowName, history);
    display.history = { ...summary, stages: Object.fromEntries(Object.keys(run?.stages ?? {}).flatMap(stage =>
      summary.stages[stage] ? [[stage, summary.stages[stage]]] : [])) };
    display.refreshedAt = this.now();
    if (task.launcher.frontend === 'codex' && (!display.retryAt || display.retryAt <= this.now())) {
      try {
        const target = this.currentTarget(task.launcher);
        if (!target.socket) throw new Error('No Codex app-server socket recorded');
        try {
          const stat = lstatSync(target.socket);
          const signature = `${stat.dev}:${stat.ino}`;
          if (this.displaySockets.get(target.socket) !== signature) this.loadedDisplays.clear();
          this.displaySockets.set(target.socket, signature);
        } catch { /* the transport reports unavailable sockets; injected transports need no file */ }
        if (!display.threadId) {
          const result = await this.rpc(target.socket, target.codexHome, 'thread/start', {
            cwd: task.projectDir, ephemeral: false,
          });
          if (!result?.thread?.id || result.thread.parentThreadId) throw new Error('Codex did not create a standalone thread');
          display.threadId = result.thread.id;
          this.loadedDisplays.add(result.thread.id);
          // Persist ownership before metadata update. Never create another
          // thread merely because renaming the first one failed.
          publish(this.displayPath(task.id), display);
        }
        if (!this.loadedDisplays.has(display.threadId!)) {
          // Empty display threads can be hidden by saved-thread listings after
          // a server restart. Loading our own display restores command-center
          // visibility without a model turn or launcher resume.
          await this.rpc(target.socket, target.codexHome, 'thread/resume', { threadId: display.threadId, excludeTurns: true });
          this.loadedDisplays.add(display.threadId!);
        }
        const title = run ? progressLine(task.id, estimateProgress(run, history, this.now()))
          : `FlowCrew #${task.id} · ${task.status} · elapsed 0s · remaining unknown`;
        if (display.title !== title) {
          await this.rpc(target.socket, target.codexHome, 'thread/name/set', { threadId: display.threadId, name: title });
          display.title = title;
        }
        display.error = undefined;
        display.retryAt = undefined;
      } catch (error) {
        if (display.threadId) this.loadedDisplays.delete(display.threadId);
        display.error = error instanceof Error ? error.message : String(error);
        display.retryAt = this.now() + PUSH_RETRY_MS;
      }
    }
    publish(this.displayPath(task.id), display);
  }
  async deliver(event: PushEvent): Promise<void> {
    if (this.acknowledged(event.eventId) || this.superseded(event)) return;
    event = this.describe(event);
    const state = load<DeliveryState>(this.deliveryPath(event.eventId)) ?? { attempts: 0 };
    const target = this.currentTarget(event.target);
    const targetKey = (value: LaunchTarget) => key([value.frontend, value.sessionId, value.socket]);
    const changedTarget = (state.target ?? targetKey(event.target)) !== targetKey(target);
    const liveWake = target.frontend === 'claude' && hasClaudeWakeWaiter(this.root, target.sessionId, this.now());
    const awaitingWaiter = target.frontend === 'claude' && !liveWake && this.claudeWakeCapable(target.sessionId);
    // A fresh waiter must not inherit an inbox deadline or an already claimed wake.
    const switchToWake = liveWake && (state.transport !== 'wake'
      || existsSync(join(this.root, 'wake-claims', `${safeId(event.eventId)}-${state.attempts}.json`)));
    // Old delivery records scheduled accepted sends at the failure cadence.
    if (!state.target && state.sentAt && !state.error) state.nextAttemptAt = Date.parse(state.sentAt) + PUSH_REMINDER_MS;
    const { human } = renderPushEvent(event, this.registry.baseDir);
    let dirty = false;
    if (!awaitingWaiter && (switchToWake || changedTarget || !state.nextAttemptAt || state.nextAttemptAt <= this.now())) {
      if (changedTarget) state.failures = 0;
      state.target = targetKey(target);
      state.attempts++;
      state.nextAttemptAt = this.now() + PUSH_RETRY_MS;
      state.transport = target.frontend === 'codex' ? 'queue'
        : liveWake ? 'wake' : 'inbox';
      // Record the attempt first: an ambiguous crash retries the SAME event id.
      publish(this.deliveryPath(event.eventId), state);
      try {
        if (target.frontend === 'codex') state.receipt = await this.queue(target.sessionId, human, target.codexHome);
        else if (state.transport === 'wake') state.receipt = 'asyncRewake waiter selected; awaiting business ACK';
        else {
          if (!target.socket) throw new Error('No Claude inbox socket recorded');
          await this.claude(target.socket, event.eventId, human);
        }
        state.sentAt = new Date(this.now()).toISOString();
        state.error = undefined;
        state.failures = 0;
        state.nextAttemptAt = this.now() + PUSH_REMINDER_MS;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        state.failures = (state.failures ?? 0) + 1;
        state.nextAttemptAt = this.now() + Math.min(PUSH_REMINDER_MS, PUSH_RETRY_MS * 2 ** Math.min(state.failures - 1, 4));
      }
      dirty = true;
    }
    // Neither transport acceptance nor a model reply can publish an ACK.
    // Fallback retains its own deadline even while transport reminders back off.
    if (!state.fallbackAt && this.now() - Date.parse(event.createdAt) >= PUSH_FALLBACK_MS
        && (!state.fallbackRetryAt || state.fallbackRetryAt <= this.now())) {
      try {
        await this.notify(human, event.eventId);
        state.fallbackAt = new Date(this.now()).toISOString();
        state.fallbackError = undefined;
        state.fallbackRetryAt = undefined;
      } catch (error) {
        state.fallbackError = error instanceof Error ? error.message : String(error);
        state.fallbackRetryAt = this.now() + PUSH_RETRY_MS;
      }
      dirty = true;
    }
    if (dirty) publish(this.deliveryPath(event.eventId), state);
  }
  async sweep(foregroundTaskId?: number): Promise<void> {
    this.registry.ensureSessionTaskIndexes();
    this.ensureEventIndex();
    const tasks = this.registry.list({ status: TASK_LIST_STATUS.ALL });
    const owns = (task: TaskEntry) => foregroundTaskId === undefined
      ? !hasLiveForegroundOwner(task) : task.id === foregroundTaskId && task.foregroundOwner?.pid === process.pid;
    const launched = tasks.filter(task => task.launcher && owns(task));
    if (!launched.length) return;
    if (!this.historyCache || this.now() - this.historyCache.at >= 600_000) {
      this.historyCache = { at: this.now(), runs: tasks.flatMap(task => {
        try { const run = this.run(task); return run && isSuccessfulRunStatus(run.status) ? [run] : []; } catch { return []; }
      }) };
    }
    const history = this.historyCache.runs;
    const events = this.events();
    const ledgers = new Map<string, LedgerReadResult>();
    for (const task of launched) {
      try {
        const ledgerKey = JSON.stringify([task.launcher!.ledgerRoot, task.launcher!.sessionId]);
        let ledger = ledgers.get(ledgerKey);
        if (!ledger) {
          ledger = refreshOpenTaskLedger(task.launcher!.ledgerRoot, task.launcher!.sessionId);
          ledgers.set(ledgerKey, ledger);
        }
        const taskEvents = events.filter(event => event.taskId === task.id);
        for (const event of taskEvents) this.indexEvent(event); // repair a crash between event and index publication
        if (this.closeHandledTask(task, taskEvents, ledger)) continue;
        const run = this.run(task);
        this.collect(task, run);
        await this.ensureDisplay(task, run, history);
      } catch (error) {
        publish(this.displayPath(task.id), { ...this.display(task.id), error: String(error) });
      }
    }
    const ownedIds = new Set(launched.map(task => task.id));
    for (const event of this.pending()) if (ownedIds.has(event.taskId)) await this.deliver(event);
  }
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
function providerFailureIdentity(event: Pick<RunEvent, 'providerFailure'>): string | undefined {
  const failure = event.providerFailure;
  return failure ? `${failure.provider} ${failure.kind} (${failure.diagnosticSha256.slice(0, 12)})` : undefined;
}
export function wrapUpPrompt(event: PushEvent, engineRoot: string): string {
  return [
    [`FlowCrew wrap-up event=${event.eventId} run=${event.runId} task=${event.taskId}`,
      ...Object.entries({ stage: event.stageId, launch: event.launch, attemptIndex: event.attemptIndex, started: event.attemptStartedAt })
        .filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${value}`), `kind=${event.kind}.`].join(' '),
    'This event is not acceptance. Check the current run/attempt first; a late event must not authorize work on a superseded attempt.',
    'Read the report and run state; independently verify the result; archive unique output; reclaim the worktree and branch only when authorized and safe; then close the session ledger for a terminal run.',
    'For unfinished work or a failed attempt, inspect the recorded result and surface missing resources or author-owned facts. Keep its task ledger open while work remains.',
    'Deduplicate by event id: if already acknowledged, do not repeat wrap-up. Delivery or a reply is not completion.',
    `Only after handling this event, acknowledge it explicitly: FC_HOME=${quote(engineRoot)} flowcrew session-push ack --event ${event.eventId} --session ${quote(event.target.sessionId)}`,
  ].join('\n');
}

/** One event, two audiences. Unknown structured facts are omitted. */
export function renderPushEvent(event: PushEvent, engineRoot: string): { human: string; agent: string } {
  const task = `FlowCrew #${event.taskId}${event.taskTitle ? ` ${event.taskTitle}` : ''}`;
  const kind: Record<string, string> = {
    attempt_failed: 'attempt failed', stage_failed: 'stage failed',
    run_status_changed: 'run status changed', operator_wrap_up_required: 'wrap-up required',
  };
  const parts = [`${task}: ${kind[event.kind] || 'run event'}.`];
  if (event.kind === 'attempt_failed' || event.kind === 'stage_failed') {
    if (event.stageId) parts.push(`Stage: ${event.stageId}.`);
    if (event.attemptIndex !== undefined) parts.push(`Attempt: ${event.attemptIndex}.`);
    if (event.failureIdentity) parts.push(`Failure: ${event.failureIdentity}.`);
  } else {
    if (event.runStatus) parts.push(`Status: ${event.runStatus}.`);
    if (event.lastStage) parts.push(`Last stage: ${event.lastStage}.`);
    if (event.reportPath) parts.push(`Report: ${event.reportPath}`);
  }
  return { human: parts.join(' '), agent: wrapUpPrompt(event, engineRoot) };
}
