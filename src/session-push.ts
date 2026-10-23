import { readOptionalJsonlFile } from './jsonl.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { atomicWrite, mkdirSync } from './engine-fs.js';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { RunEvent } from './run-events.js';
import type { StoreState } from './store.js';
import { isPausedRunStatus, isTerminalRunStatus, isSuccessfulRunStatus } from './lifecycle-status.js';
import { TaskRegistry, TASK_LIST_STATUS, isActiveTaskStatus, hasLiveForegroundOwner, sessionTaskIndexPath, type TaskEntry } from './task-registry.js';
import { codexRequest, queueCodex, sendClaude, notifyFallback } from './session-push-transport.js';
import { publicTaskEntries, readTaskLedger } from './fc-tasks.js';
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
}
function normalizePushEvent(event: PushEvent & { attempt?: number }): PushEvent {
  const { attempt, ...current } = event;
  return { ...current,
    launch: current.launch ?? (current.stageId ? undefined : attempt === 0 ? 1 : undefined),
    attemptIndex: current.attemptIndex ?? (current.stageId ? attempt : undefined),
  };
}
interface DeliveryState {
  attempts: number;
  transport?: 'inbox' | 'wake' | 'queue';
  nextAttemptAt?: number;
  sentAt?: string;
  receipt?: string;
  error?: string;
  fallbackAt?: string;
  fallbackError?: string;
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

/** fsync then atomic publish. Exclusive records (event/ACK) are immutable;
 * retries and acknowledgements never overwrite each other's state. */
function publish(path: string, value: unknown, exclusive = false): boolean {
  mkdirSync(resolve(path, '..'), { recursive: true });
  return atomicWrite(path, `${JSON.stringify(value)}\n`, { durability: 'durable', mode: 0o600, exclusive });
}
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeId = (id: string) => { if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid event id'); return id; };

export const PUSH_RETRY_MS = 120_000;
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
    if (this.acknowledged(event.eventId)) return false;
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
  pending(session?: string): PushEvent[] {
    return this.events().filter(event => (!session || event.target.sessionId === session) && !this.acknowledged(event.eventId));
  }
  sessionTasks(frontend: LaunchTarget['frontend'], sessionId: string): TaskEntry[] {
    if (!existsSync(join(this.root, 'task-index', 'ready'))) this.registry.ensureSessionTaskIndexes();
    return (load<number[]>(sessionTaskIndexPath(this.registry.baseDir, { frontend, sessionId })) ?? [])
      .map(id => this.registry.get(id))
      .filter((task): task is TaskEntry => task?.launcher?.frontend === frontend && task.launcher.sessionId === sessionId);
  }
  openTasks(frontend: LaunchTarget['frontend'], session: string, allowExecuting = false): TaskEntry[] {
    return this.sessionTasks(frontend, session)
      .filter(task => {
        const ledger = readTaskLedger(task.launcher!.ledgerRoot, session);
        const entry = publicTaskEntries(ledger).find(entry => entry.flowcrewTaskId === task.id);
        if (ledger.issues.length) return true;
        if (isActiveTaskStatus(task.status)) return !allowExecuting;
        return entry?.status !== 'completed' || !this.events().some(event => event.taskId === task.id
          && event.runId === (task.run_id || `task-${task.id}`) && this.acknowledged(event.eventId));
      });
  }
  deliveryReady(task: TaskEntry): boolean {
    if (!task.launcher) return false;
    const target = this.currentTarget(task.launcher);
    if (target.frontend === 'claude' && !hasClaudeWakeWaiter(this.root, target.sessionId, this.now())) {
      try { if (!target.socket || !lstatSync(target.socket).isSocket()) return false; } catch { return false; }
    }
    return this.pending(target.sessionId).filter(event => event.taskId === task.id)
      .every(event => !load<DeliveryState>(this.deliveryPath(event.eventId))?.error);
  }
  enqueue(task: TaskEntry, source: Pick<RunEvent, 'type' | 'timestamp' | 'runId' | 'attemptIndex' | 'detail' | 'stageId' | 'attemptStartedAt'>, identity: unknown = source): PushEvent | undefined {
    if (!task.launcher) return undefined;
    const eventId = key([task.id, source.runId, identity]);
    const existing = load<PushEvent>(this.eventPath(eventId))
      // Old fallback observations hashed the zero-based launch sequence.
      ?? (Array.isArray(identity) ? load<PushEvent>(this.eventPath(key([task.id, source.runId,
        identity.map(value => typeof value === 'number' ? value - 1 : value)]))) : undefined);
    if (existing) return normalizePushEvent(existing);
    const event: PushEvent = {
      version: 1, eventId, taskId: task.id,
      runId: source.runId, launch: task.launch, attemptIndex: source.attemptIndex, kind: source.type,
      stageId: source.stageId, attemptStartedAt: source.attemptStartedAt,
      detail: source.detail, createdAt: new Date(this.now()).toISOString(), occurredAt: source.timestamp, target: task.launcher,
    };
    publish(this.eventPath(event.eventId), event, true);
    return event;
  }
  /** Capture before a manual retry can discard this task's old run binding. */
  capture(task: TaskEntry): void { if (task.launcher) this.collect(task, this.run(task)); }
  acknowledge(id: string, session: string): PushEvent {
    const stored = load<PushEvent>(this.eventPath(id));
    const event = stored && normalizePushEvent(stored);
    if (!event) throw new Error('Unknown event id');
    if (event.target.sessionId !== session) throw new Error('Event belongs to a different launching session');
    publish(this.ackPath(id), { eventId: id, sessionId: session, acknowledgedAt: new Date(this.now()).toISOString() }, true);
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
        if (['operator_wrap_up_required', 'attempt_failed', 'stage_failed', 'approval_parked', 'approval_attempt_suspended'].includes(event.type)
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
    display.history = summarizeProgressHistory(run?.workflowName, history);
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
    if (this.acknowledged(event.eventId)) return;
    const state = load<DeliveryState>(this.deliveryPath(event.eventId)) ?? { attempts: 0 };
    if (state.nextAttemptAt && state.nextAttemptAt > this.now()) return;
    state.attempts++;
    state.nextAttemptAt = this.now() + PUSH_RETRY_MS;
    const target = this.currentTarget(event.target);
    state.transport = target.frontend === 'codex' ? 'queue'
      : hasClaudeWakeWaiter(this.root, target.sessionId, this.now()) ? 'wake' : 'inbox';
    // Record the attempt first: an ambiguous crash retries the SAME event id.
    publish(this.deliveryPath(event.eventId), state);
    const prompt = wrapUpPrompt(event, this.registry.baseDir);
    try {
      if (target.frontend === 'codex') state.receipt = await this.queue(target.sessionId, prompt, target.codexHome);
      else if (state.transport === 'wake') state.receipt = 'asyncRewake waiter selected; awaiting business ACK';
      else {
        if (!target.socket) throw new Error('No Claude inbox socket recorded');
        await this.claude(target.socket, event.eventId, prompt);
      }
      state.sentAt = new Date(this.now()).toISOString();
      state.error = undefined;
    } catch (error) { state.error = error instanceof Error ? error.message : String(error); }
    // Neither transport acceptance nor a model reply can publish an ACK.
    if (!state.fallbackAt && this.now() - Date.parse(event.createdAt) >= PUSH_FALLBACK_MS) {
      try { await this.notify(prompt, event.eventId); state.fallbackAt = new Date(this.now()).toISOString(); state.fallbackError = undefined; }
      catch (error) { state.fallbackError = error instanceof Error ? error.message : String(error); }
    }
    publish(this.deliveryPath(event.eventId), state);
  }
  async sweep(foregroundTaskId?: number): Promise<void> {
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
    for (const task of launched) {
      try {
        const ledger = readTaskLedger(task.launcher!.ledgerRoot, task.launcher!.sessionId);
        const closed = !ledger.issues.length && publicTaskEntries(ledger).some(entry => entry.flowcrewTaskId === task.id && entry.status === 'completed');
        const events = this.events().filter(event => event.taskId === task.id);
        const currentRun = task.run_id || `task-${task.id}`;
        if (closed && events.some(event => event.runId === currentRun)
            && events.every(event => this.acknowledged(event.eventId)) && !isActiveTaskStatus(task.status)) continue;
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
export function wrapUpPrompt(event: PushEvent, engineRoot: string): string {
  return [
    `FlowCrew wrap-up event=${event.eventId} run=${event.runId} task=${event.taskId} stage=${event.stageId ?? 'run'} launch=${event.launch ?? 'see-task-state'} attemptIndex=${event.attemptIndex ?? 'see-run-state'} started=${event.attemptStartedAt ?? 'see-run-state'} kind=${event.kind}.`,
    'This event is not acceptance. Check the current run/attempt first; a late event must not authorize work on a superseded attempt.',
    'Read the report and run state; independently verify the result; archive unique output; reclaim the worktree and branch only when authorized and safe; then close the session ledger for a terminal run.',
    'For a parked run, approval request, or failed attempt, inspect and resolve or surface the decision needed; do not bypass approval. Keep its task ledger open while work remains.',
    'Deduplicate by event id: if already acknowledged, do not repeat wrap-up. Delivery or a reply is not completion.',
    `Only after handling this event, acknowledge it explicitly: FC_HOME=${quote(engineRoot)} flowcrew session-push ack --event ${event.eventId} --session ${quote(event.target.sessionId)}`,
  ].join('\n');
}
