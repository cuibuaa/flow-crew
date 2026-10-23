import { constants, existsSync, fstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { closeSync, openSync } from './engine-fs.js';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { FcTaskEntry } from './fc-tasks.js';
import type { ProgressRun } from './task-progress.js';

// Read only the launcher's small public metadata files, never executor output.
function metadata(path: string): Record<string, any> {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) return {};
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function startTime(record: string, route: Record<string, any>): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(basename(record));
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`
    : typeof route.started_at === 'string' && Number.isFinite(Date.parse(route.started_at)) ? route.started_at : undefined;
}

/** One lazy history scan per render, shared by every agent-task row. */
export function agentTaskProgressReader(root = process.env.AGENT_TASK_ROOT || join(homedir(), '.codex-tasks')) {
  let history: ProgressRun[] | undefined;
  const readHistory = () => {
    if (history) return history;
    history = [];
    try {
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const record = join(root, dir.name);
        if (!existsSync(join(record, 'DONE'))) continue;
        const route = metadata(join(record, 'route.json'));
        const startedAt = startTime(record, route);
        if (!startedAt || !['codex', 'claude'].includes(route.backend) || typeof route.effort !== 'string') continue;
        try {
          history.push({ status: 'complete', stages: {}, startedAt, completedAt: statSync(join(record, 'DONE')).mtime.toISOString(),
            agentTask: { backend: route.backend, effort: route.effort, phase: 'complete' } });
        } catch { /* Concurrent removal leaves this sample unavailable. */ }
      }
    } catch { /* No history is an unknown estimate. */ }
    return history;
  };
  return (entry: FcTaskEntry): { run: ProgressRun; history: ProgressRun[] } | undefined => {
    if (entry.status !== 'in_progress') return undefined;
    const link = /^Backend (codex|claude) task(?: \(route: [^)]*\))?; record (.+)\. Wrap-up remains:/.exec(entry.description);
    if (!link || dirname(resolve(link[2])) !== resolve(root)) return undefined;
    const record = resolve(link[2]);
    const route = metadata(join(record, 'route.json'));
    const progress = metadata(join(record, 'progress.json'));
    const startedAt = startTime(record, route);
    let completedAt: string | undefined;
    try { completedAt = statSync(join(record, 'DONE')).mtime.toISOString(); } catch { /* Still running or removed. */ }
    const finished = completedAt !== undefined;
    const phase = finished ? 'wrap-up' : ['running', 'VERIFY', 'review'].includes(progress.phase) ? progress.phase
      : !existsSync(join(record, 'exit')) ? 'running'
      : existsSync(join(record, 'verify.log')) && !existsSync(join(record, 'verify.exit')) ? 'VERIFY' : 'review';
    // Old launchers put the requested effort in the active form but did not persist it in route.json.
    const effort = typeof route.effort === 'string' ? route.effort
      : /, (default|none|minimal|low|medium|high|xhigh|max)\)(?:\s|$)/.exec(entry.activeForm)?.[1];
    return { run: { status: finished ? 'complete' : 'running', stages: {}, startedAt,
      ...(completedAt ? { completedAt } : {}), agentTask: {
      backend: link[1], effort: effort ?? 'unknown', phase,
      ...(progress.version === 1 && progress.measurement && typeof progress.measurement === 'object'
        ? { measurement: progress.measurement } : {}),
    } }, history: effort ? readHistory() : [] };
  };
}
