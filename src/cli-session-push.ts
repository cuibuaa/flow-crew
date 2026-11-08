import { parseCommandArgs, commandUsage } from './cli-args.js';
import { EXIT_CODE } from './exit-code.js';
import { readFileSync } from 'node:fs';
import { fcGlobalDir } from './store.js';
import { isActiveTaskStatus, TaskRegistry } from './task-registry.js';
import { defaultFcTasksRoot, readOpenTaskLedger, renderFcTasks } from './fc-tasks.js';
import { SessionPush, estimateProgress, progressLine, renderPushEvent, PUSH_RETRY_MS, type LaunchTarget } from './session-push.js';
import { claudeWakeCapability, hasClaudeWakeWaiter, waitForClaudeWake } from './session-wake.js';
import { clearSessionFailure, hasSessionFailure, recordSessionFailure, sessionFailures } from './session-integration-errors.js';
import { setTimeout as sleep } from 'node:timers/promises';

export function sessionGate(push: SessionPush, frontend: LaunchTarget['frontend'], session: string): { decision?: 'block'; reason?: string; systemMessage?: string } {
  const pending = push.pending(session, frontend);
  const first = pending[0];
  if (first) {
    let displayAdvice = '';
    if (frontend === 'codex') {
      try {
        const display = push.display(first.taskId);
        if (!display.threadId) displayAdvice = `\nFlowCrew #${first.taskId} display thread is missing: ${display.error || 'creation pending'}. Create one standalone thread, then bind it with flowcrew session-push bind-display --task ${first.taskId} --thread <new-thread-id> --session ${session}.`;
      } catch { /* optional display state cannot hide a known pending event */ }
    }
    return { decision: 'block', systemMessage: renderPushEvent(first, push.registry.baseDir).human,
      reason: `FlowCrew wrap-up is open: ${pending.length} unacknowledged event(s).\n${renderPushEvent(first, push.registry.baseDir).agent}${displayAdvice}` };
  }
  // Codex's durable queue does not have an expiring wake lease. Missing
  // display creation is retried by the service; it cannot manufacture a turn.
  if (frontend === 'codex') return {};
  const open = push.openTasks(frontend, session);
  if (!open.length || hasClaudeWakeWaiter(push.root, session) || hasSessionFailure(push.root, frontend, session, 'wake')) return {};
  return { decision: 'block', reason: `FlowCrew wake coverage must be renewed for this session's open tasks ${open.map(task => `#${task.id}`).join(', ')}. End this turn normally to register the installed wake waiter; inspect the push service if coverage remains unavailable.` };
}

export function renderSessionProgress(push: SessionPush, session: string, now = Date.now(), frontend: LaunchTarget['frontend'] = 'claude'): { text: string; covered: boolean } {
  const tasks = push.sessionTasks(frontend, session);
  const rows = push.pending(session, frontend).map(event => renderPushEvent(event, push.registry.baseDir).human);
  let covered = tasks.length > 0 && !hasSessionFailure(push.root, frontend, session, 'wake');
  for (const task of tasks) {
    const display = push.display(task.id);
    const fresh = display.refreshedAt !== undefined && now - display.refreshedAt < PUSH_RETRY_MS;
    const ready = push.deliveryReady(task);
    covered &&= fresh && ready;
    if (display.progress) rows.push(progressLine(task.id, estimateProgress(display.progress, display.history || [], now)));
    else rows.push(`FlowCrew #${task.id} · ${task.status} · remaining unknown`);
    if (!fresh) rows.push(`⚠ FlowCrew #${task.id}: push engine has no recent heartbeat; run flowcrew daemon status`);
    else if (!ready) rows.push(`⚠ FlowCrew #${task.id}: push target unavailable; inspect flowcrew session-push list`);
  }
  return { text: rows.join('\n'), covered };
}

export async function cmdSessionPush(args: string[]): Promise<number> {
  const subcommand = args[0]?.startsWith('-') ? undefined : args[0];
  let parsed;
  try { parsed = parseCommandArgs(`session-push${subcommand ? ` ${subcommand}` : ''}`, subcommand ? args.slice(1) : args); }
  catch (error) {
    process.stderr.write(`FlowCrew session push: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODE.failed;
  }
  if (parsed.help) {
    process.stdout.write(`${commandUsage(`session-push${subcommand ? ` ${subcommand}` : ''}`)}\n`);
    return EXIT_CODE.completed;
  }
  // Doctor's capability check must not create an engine store as a side effect.
  if (subcommand === 'wake-check') {
    const capability = claudeWakeCapability();
    process.stdout.write(`${capability.detail}\n`);
    return capability.supported ? EXIT_CODE.completed : EXIT_CODE.failed;
  }
  let callingSession = 'unknown';
  let callingFrontend: LaunchTarget['frontend'] = 'claude';
  const push = new SessionPush(new TaskRegistry({ baseDir: fcGlobalDir(), createDirectories: false }));
  try {
    const value = (name: string) => parsed.values.get(name);
    switch (subcommand) {
      case 'wake': {
        const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
        if (!payload.session_id) throw new Error('Hook payload has no session identifier');
        callingSession = payload.session_id;
        const capability = claudeWakeCapability();
        if (!capability.supported) {
          recordSessionFailure(push.root, 'claude', callingSession, 'wake', new Error(capability.detail), 'capability');
          return EXIT_CODE.completed;
        }
        clearSessionFailure(push.root, 'claude', callingSession, 'wake', 'capability');
        const result = await waitForClaudeWake(push, payload.session_id);
        if (result.prompt) process.stderr.write(`${result.prompt}\n`);
        return result.code;
      }
      case 'ack': {
        const eventId = value('--event');
        const session = value('--session') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID;
        if (!eventId || !session) throw new Error('ack requires --event and --session');
        const event = push.acknowledge(eventId, session);
        process.stdout.write(`FlowCrew event ${event.eventId} acknowledged (business wrap-up).\n`);
        return EXIT_CODE.completed;
      }
      case 'list':
        for (const event of push.pending(value('--session'))) process.stdout.write(`${renderPushEvent(event, push.registry.baseDir).human}\n`);
        return EXIT_CODE.completed;
      case 'bind-display': {
        const task = push.registry.get(Number(value('--task')));
        const threadId = value('--thread');
        const session = value('--session');
        if (!task?.launcher || task.launcher.frontend !== 'codex' || task.launcher.sessionId !== session || !threadId) throw new Error('bind-display requires an exact Codex task, new thread id and launching session');
        if (push.display(task.id).threadId) throw new Error('Task already has a display thread');
        // Validate standalone identity without asking for prompt/history data.
        const { codexRequest } = await import('./session-push-transport.js');
        const result = await codexRequest(task.launcher.socket!, task.launcher.codexHome, 'thread/read', { threadId, includeTurns: false });
        if (result.thread.parentThreadId || result.thread.cwd !== task.projectDir) throw new Error('Display must be a standalone thread in this task project');
        push.bindDisplay(task.id, threadId);
        await push.ensureDisplay(task);
        return EXIT_CODE.completed;
      }
      case 'hook': {
        const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
        const frontend = value('--frontend');
        if (frontend !== 'claude' && frontend !== 'codex') throw new Error('hook requires --frontend claude|codex');
        const session = payload.session_id || payload.thread_id || payload['thread-id'];
        if (!session) throw new Error('Hook payload has no session identifier; cannot apply the turn gate');
        callingSession = session;
        callingFrontend = frontend;
        // A resumed Claude session can have a new inbox path. Never scan or
        // guess a session from a caller's daemon environment.
        const requestedEvent = payload.hook_event_name || payload.hookEventName || value('--event');
        if (requestedEvent === 'SessionStart') push.refreshSession(frontend, session, frontend === 'claude' ? process.env.CLAUDE_CODE_MESSAGING_SOCKET : undefined);
        const eventName = payload.hook_event_name || payload.hookEventName || value('--event');
        if (eventName === 'Stop' || eventName === 'stop') {
          // Claude starts synchronous and async Stop commands concurrently.
          // Allow registration to win that race; without it the old gate holds.
          if (frontend === 'claude' && !hasSessionFailure(push.root, frontend, session, 'wake') && !push.pending(session, frontend).length && push.openTasks(frontend, session).length) {
            for (let i = 0; i < 80 && !hasClaudeWakeWaiter(push.root, session); i++) await sleep(50);
          }
          const verdict = sessionGate(push, frontend, session);
          clearSessionFailure(push.root, frontend, session, 'hook');
          const warnings = sessionFailures(push.root, frontend, session, true);
          if (verdict.systemMessage) warnings.unshift(verdict.systemMessage);
          if (verdict.decision || warnings.length) process.stdout.write(`${JSON.stringify({ ...verdict, ...(warnings.length ? { systemMessage: warnings.join('\n') } : {}) })}\n`);
        }
        return EXIT_CODE.completed;
      }
      case 'statusline': {
        const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
        const session = payload.session_id || value('--session');
        if (!session) throw new Error('statusline requires session_id');
        callingSession = session;
        const result = renderSessionProgress(push, session);
        const tasks = push.sessionTasks('claude', session);
        const ledgerText = renderFcTasks({
          storeRoot: process.env.FC_TASKS_ROOT || defaultFcTasksRoot(), explicitSession: session,
          columns: process.env.COLUMNS, lines: process.env.LINES, readLedger: readOpenTaskLedger,
          agentProgress: () => undefined,
          engineRunningCount: tasks.filter(task => isActiveTaskStatus(task.status)).length,
          taskRunResolver: { resolve: entry => {
            const task = tasks.find(task => task.id === entry.flowcrewTaskId)
              ?? (entry.flowcrewTaskId === undefined ? undefined : push.registry.get(entry.flowcrewTaskId, { frontend: 'claude', sessionId: session }));
            return task ? { state: 'resolved', taskId: task.id, taskStatus: task.status, projectDir: task.projectDir,
              runId: task.run_id, runStatus: push.display(task.id).progress?.status }
              : entry.flowcrewTaskId === undefined ? { state: 'never_linked' }
              : { state: 'stale', taskId: entry.flowcrewTaskId, detail: 'Task absent from this session’s open work' };
          } },
        }).text;
        result.text = [ledgerText.trim(), result.text, ...sessionFailures(push.root, 'claude', session)].filter(Boolean).join('\n');
        process.stdout.write(`${parsed.flags.has('--json') ? JSON.stringify(result) : result.text}\n`);
        return EXIT_CODE.completed;
      }
      default:
        process.stdout.write(`${commandUsage('session-push')}\n`);
        return EXIT_CODE.failed;
    }
  } catch (error) {
    if (subcommand === 'hook' || subcommand === 'wake') {
      try {
        recordSessionFailure(push.root, callingFrontend, callingSession, subcommand, error);
        if (subcommand === 'hook') {
          const warnings = sessionFailures(push.root, callingFrontend, callingSession, true);
          if (warnings.length) process.stdout.write(`${JSON.stringify({ systemMessage: warnings.join('\n') })}\n`);
        }
      } catch (failure) {
        // Even a failed diagnostic store must remain visible to the operator.
        process.stdout.write(`${JSON.stringify({ systemMessage: `FlowCrew session state and diagnostic storage unavailable: ${String(failure)}` })}\n`);
      }
      return EXIT_CODE.completed;
    }
    if (subcommand === 'statusline') {
      const text = `FlowCrew display unavailable for session ${callingSession}: ${error instanceof Error ? error.message : String(error)}`;
      process.stdout.write(`${parsed.flags.has('--json') ? JSON.stringify({ text, covered: false }) : text}\n`);
      return EXIT_CODE.failed;
    }
    process.stderr.write(`FlowCrew session push: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODE.failed;
  }
}
