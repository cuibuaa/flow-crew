// Synthetic records only. The two histories have identical open session work.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value) + '\n');
};

export function sessionCostFixture(root, scale = 1) {
  const fc = join(root, 'fc');
  const ledger = join(root, 'ledger');
  const session = 'cost-session';
  const launcher = { frontend: 'claude', sessionId: session, cwd: root, ledgerRoot: ledger };
  const taskCount = 2452 * scale;
  const records = 8294 * scale;
  const ledgerCount = 885 * scale;
  const tasks = Array.from({ length: taskCount }, (_, n) => ({
    id: n + 1, name: `Synthetic task ${n + 1}`, kind: 'quick',
    brief_text: 'Synthetic task body. '.repeat(20), notes: 'Synthetic task metadata. '.repeat(40), projectDir: root, systemd_unit: `fixture-${n + 1}.service`,
    run_id: `fixture-run-${n + 1}`, launcher: n % 30 === 0 ? launcher : n % 30 === 1 ? { ...launcher, sessionId: 'another-session' } : undefined,
    status: n === 0 ? 'running' : 'done', attempt: 1, launch: 1, max_attempts: 2,
    launch_options: {}, created_at: '2026-01-01T00:00:00.000Z',
    tick_log_path: join(fc, 'tasks', String(n + 1), 'tick_log.md'),
  }));
  write(join(fc, 'tasks.jsonl'), Array.from({ length: records }, (_, n) => JSON.stringify(tasks[n % taskCount])).join('\n') + '\n');
  write(join(fc, 'tasks-seq'), String(taskCount));
  for (const task of tasks) {
    mkdirSync(join(fc, 'tasks', String(task.id)), { recursive: true });
    // Like a migrated store, only launch-owned tasks need session projections.
    if (task.launcher) write(join(fc, 'tasks', String(task.id), 'current.json'), task);
    write(join(fc, 'runs', task.run_id, 'run.json'), {
      runId: task.run_id, projectDir: root, status: task.id === 1 ? 'running' : 'complete', stages: {},
    });
    if (task.id !== 1 && task.launcher) write(join(fc, 'tasks', String(task.id), 'session-closed.json'),
      JSON.stringify([task.launcher.frontend, task.launcher.sessionId, task.run_id, task.launch]));
  }
  const entries = Array.from({ length: ledgerCount }, (_, n) => ({
    id: `entry-${n + 1}`, subject: `Synthetic ledger ${n + 1}`, description: '', activeForm: 'Synthetic open work',
    status: n < 2 ? 'in_progress' : 'completed', blocks: [], blockedBy: [],
    ...(n === 0 ? { flowcrewTaskId: 1 } : n > 1 ? { flowcrewTaskId: n + 1 } : {}),
  }));
  for (const entry of entries) write(join(ledger, session, entry.id + '.json'), entry);
  write(join(ledger, '.flowcrew-open', session + '.json'), {
    state: 'ready', entries: entries.filter(entry => entry.status !== 'completed'), issues: [], completedCount: ledgerCount - 2,
  });
  const event = n => ({ version: 1, eventId: hash(['fixture-event', n]), taskId: n + 1, runId: `fixture-run-${n + 1}`,
    launch: 1, kind: 'operator_wrap_up_required', target: tasks[n % taskCount].launcher ?? launcher,
    taskTitle: 'Synthetic event', runStatus: n === 0 ? 'running' : 'complete',
    createdAt: '2026-01-01T00:00:00.000Z', occurredAt: '2026-01-01T00:00:00.000Z' });
  for (let n = 0; n < ledgerCount; n++) {
    const row = event(n);
    write(join(fc, 'session-push', 'events', row.eventId + '.json'), row);
    if (n > 0) {
      write(join(fc, 'session-push', 'acks', row.eventId + '.json'), { eventId: row.eventId });
      write(join(fc, 'session-push', 'waiters', `archive-${n}.json`), { session, pid: 2147483647, host: 2147483647, expiresAt: 0 });
    }
  }
  const openEvent = event(0);
  write(join(fc, 'session-push', 'pending', hash(['claude', session]), openEvent.eventId + '.json'), openEvent);
  write(join(fc, 'session-push', 'pending', 'ready'), { version: 1 });
  const index = join(fc, 'session-push', 'task-index', hash(['claude', session]) + '.json');
  write(index, [1]);
  write(join(fc, 'session-push', 'task-index', 'ready'), '2\n');
  write(join(fc, 'tasks', '1', 'session-push.json'), { refreshedAt: Date.now(), progress: { status: 'running', stages: {} }, history: [] });
  return { root, fc, ledger, session, index, openEvent, tasks: taskCount, records, ledgerEntries: ledgerCount };
}
