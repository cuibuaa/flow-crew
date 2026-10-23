import { parseCommandArgs, commandUsage } from './cli-args.js';
import { EXIT_CODE } from './exit-code.js';
import { readFileSync } from 'node:fs';
import { fcGlobalDir } from './store.js';
import { TaskRegistry } from './task-registry.js';
import { defaultFcTasksRoot, publicTaskEntries, readTaskLedger } from './fc-tasks.js';
import { SessionPush, estimateProgress, progressLine, wrapUpPrompt, PUSH_RETRY_MS, type LaunchTarget } from './session-push.js';
import { claudeWakeCapability, hasClaudeWakeWaiter, waitForClaudeWake } from './session-wake.js';
import { setTimeout as sleep } from 'node:timers/promises';

export function sessionGate(push: SessionPush, frontend: LaunchTarget['frontend'], session: string): { decision?: 'block'; reason?: string } {
  const tasks = push.sessionTasks(frontend, session);
  const pending = push.pending(session).filter(event => event.target.frontend === frontend);
  const wakeCovered = frontend === 'claude' && hasClaudeWakeWaiter(push.root, session);
  const open = push.openTasks(frontend, session, wakeCovered && !pending.length);
  if (!pending.length && !open.length) return {};
  const event = pending[0];
  const missingDisplay = tasks.filter(task => task.launcher?.frontend === 'codex' && !push.display(task.id).threadId);
  return { decision: 'block', reason: [
    `FlowCrew wrap-up is open: tasks ${open.map(t => `#${t.id}`).join(', ') || '(ledger closed)'}, ${pending.length} unacknowledged event(s).`,
    event ? wrapUpPrompt(event, push.registry.baseDir)
      : 'Execution is still in flight or wrap-up has not been acknowledged. Wait for its event; inspect the task with flowcrew task show. Keep working until wrap-up and explicit event ACK are complete.',
    ...missingDisplay.map(task => `FlowCrew #${task.id} display thread is missing: ${push.display(task.id).error || 'creation pending'}. Create one standalone thread using the front end, then bind it with flowcrew session-push bind-display --task ${task.id} --thread <new-thread-id> --session ${session}.`),
  ].join('\n') };
}

export function renderSessionProgress(push: SessionPush, session: string, now = Date.now(), frontend: LaunchTarget['frontend'] = 'claude'): { text: string; covered: boolean } {
  const tasks = push.sessionTasks(frontend, session);
  const rows: string[] = [];
  let covered = tasks.length > 0;
  for (const task of tasks) {
    const display = push.display(task.id);
    const ledger = readTaskLedger(task.launcher!.ledgerRoot, session);
    const closed = publicTaskEntries(ledger).find(entry => entry.flowcrewTaskId === task.id)?.status === 'completed';
    if (closed && !push.pending(session).some(event => event.taskId === task.id)) continue;
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
  try {
    const push = new SessionPush(new TaskRegistry({ baseDir: fcGlobalDir() }));
    const value = (name: string) => parsed.values.get(name);
    switch (subcommand) {
      case 'wake': {
        const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
        if (!payload.session_id) throw new Error('Hook payload has no session identifier');
        if (!claudeWakeCapability().supported) return EXIT_CODE.completed;
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
        process.stdout.write(`${JSON.stringify(push.pending(value('--session')).map(event => ({ ...event, delivery: push.delivery(event.eventId) })), null, 2)}\n`);
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
        // A resumed Claude session can have a new inbox path. Never scan or
        // guess a session from a caller's daemon environment.
        push.refreshSession(frontend, session, frontend === 'claude' ? process.env.CLAUDE_CODE_MESSAGING_SOCKET : undefined);
        const eventName = payload.hook_event_name || payload.hookEventName || value('--event');
        if (eventName === 'Stop' || eventName === 'stop') {
          // Claude starts synchronous and async Stop commands concurrently.
          // Allow registration to win that race; without it the old gate holds.
          if (frontend === 'claude' && !push.pending(session).some(event => event.target.frontend === frontend) && push.openTasks(frontend, session).length) {
            for (let i = 0; i < 80 && !hasClaudeWakeWaiter(push.root, session); i++) await sleep(50);
          }
          const verdict = sessionGate(push, frontend, session);
          if (verdict.decision) process.stdout.write(`${JSON.stringify(verdict)}\n`);
        }
        return EXIT_CODE.completed;
      }
      case 'statusline': {
        const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
        const session = payload.session_id || value('--session');
        if (!session) throw new Error('statusline requires session_id');
        const result = renderSessionProgress(push, session);
        const { cmdFcTasks } = await import('./cli-fc-tasks.js');
        let ledgerText = '';
        cmdFcTasks(['fc_tasks', 'render', '--session', session, '--store-root', process.env.FC_TASKS_ROOT || defaultFcTasksRoot(), '--engine-root', push.registry.baseDir], {
          stdout: { write: chunk => { ledgerText += chunk; } },
        });
        const extra = result.text.split('\n').filter(line => line && !ledgerText.includes(line)).join('\n');
        result.text = `${ledgerText.trim()}${extra ? `\n${extra}` : ''}`;
        process.stdout.write(`${parsed.flags.has('--json') ? JSON.stringify(result) : result.text}\n`);
        return EXIT_CODE.completed;
      }
      default:
        process.stdout.write(`${commandUsage('session-push')}\n`);
        return EXIT_CODE.failed;
    }
  } catch (error) {
    process.stderr.write(`FlowCrew session push: ${error instanceof Error ? error.message : String(error)}\n`);
    // Hook errors must remain visible to both front ends, including malformed
    // registry/outbox state. Exit 2 is their common blocking-error contract.
    return subcommand === 'hook' || subcommand === 'wake' ? 2 : EXIT_CODE.failed;
  }
}
