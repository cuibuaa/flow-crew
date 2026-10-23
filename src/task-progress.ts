import { isSuccessfulRunStatus, isTerminalRunStatus, STAGE_STATUS } from './lifecycle-status.js';

export interface ProgressRun {
  status: string;
  startedAt?: string;
  completedAt?: string;
  workflowName?: string;
  stages: Record<string, { status: string; startedAt?: string; completedAt?: string; duration_ms?: number }>;
  agentTask?: {
    backend: string;
    effort: string;
    phase: string;
    measurement?: { done: number; total: number; unit: string; startedAt: string; startedDone: number; updatedAt: string };
  };
}
export interface ProgressEstimate {
  elapsedSeconds: number;
  remainingSeconds: number | null;
  stage: string;
  historyRuns: number;
  source?: 'measured' | 'history' | 'unknown';
  fraction?: number;
}
export interface ProgressHistory {
  runs: number;
  stages: Record<string, { medianSeconds: number; frequency: number }>;
}
const seconds = (end: string | number, start?: string) => start
  ? Math.max(0, (Number(typeof end === 'string' ? Date.parse(end) : end) - Date.parse(start)) / 1000) || 0 : 0;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Shared by the Claude renderer and engine-owned Codex titles. Historical
 * stage presence weights conditional repair work; no history means unknown. */
export function summarizeProgressHistory(workflow: string | undefined, history: readonly ProgressRun[]): ProgressHistory {
  const comparable = history.filter(h => isSuccessfulRunStatus(h.status) && h.workflowName === workflow);
  const samples: Record<string, number[]> = {};
  for (const run of comparable) {
    for (const [name, stage] of Object.entries(run.stages)) {
      if (stage.status !== STAGE_STATUS.COMPLETE) continue;
      const duration = stage.duration_ms !== undefined ? stage.duration_ms / 1000
        : stage.startedAt && stage.completedAt ? seconds(stage.completedAt, stage.startedAt) : undefined;
      if (duration !== undefined && Number.isFinite(duration)) (samples[name] ??= []).push(duration);
    }
  }
  return { runs: comparable.length, stages: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, {
    medianSeconds: median(values), frequency: values.length / comparable.length,
  }])) };
}

export function estimateProgress(run: ProgressRun, history: ProgressRun[] | ProgressHistory, now = Date.now()): ProgressEstimate {
  if (run.agentTask) {
    const terminal = isTerminalRunStatus(run.status);
    const elapsed = seconds(terminal && run.completedAt ? run.completedAt : now, run.startedAt);
    const measurement = run.agentTask.measurement;
    const durations = (Array.isArray(history) ? history.filter(h => h.completedAt && Date.parse(h.completedAt) <= now
      && h.agentTask?.backend === run.agentTask!.backend && h.agentTask.effort === run.agentTask!.effort)
      .map(h => seconds(h.completedAt!, h.startedAt)) : [])
      .filter(n => Number.isFinite(n) && n > elapsed);
    let remaining: number | null = null;
    let source: ProgressEstimate['source'] = 'unknown';
    let fraction: number | undefined;
    if (measurement && Number.isFinite(measurement.done) && Number.isFinite(measurement.total)
      && Number.isFinite(measurement.startedDone) && measurement.total > 0
      && measurement.startedDone >= 0 && measurement.done >= measurement.startedDone && measurement.done <= measurement.total
      && Date.parse(measurement.updatedAt) <= now && Date.parse(measurement.startedAt) <= Date.parse(measurement.updatedAt)) {
      const interval = seconds(measurement.updatedAt, measurement.startedAt);
      const completed = measurement.done - measurement.startedDone;
      if (completed > 0 && interval > 0) {
        remaining = Math.ceil((measurement.total - measurement.done) * interval / completed);
        fraction = measurement.done / measurement.total;
        source = 'measured';
      }
    }
    if (remaining === null && durations.length >= 5) {
      // Backtested lower quartile of durations conditional on still running.
      const sorted = durations.sort((a, b) => a - b);
      const position = (sorted.length - 1) * 0.25;
      const lower = Math.floor(position);
      remaining = Math.ceil(sorted[lower] + (position - lower) * (sorted[Math.ceil(position)] - sorted[lower]) - elapsed);
      fraction = elapsed / (elapsed + remaining);
      source = 'history';
    }
    return { elapsedSeconds: Math.floor(elapsed), remainingSeconds: terminal ? 0 : remaining, stage: run.agentTask.phase,
      historyRuns: durations.length, source, ...(terminal ? { fraction: 1 } : fraction === undefined ? {} : { fraction }) };
  }
  const stats = Array.isArray(history) ? summarizeProgressHistory(run.workflowName, history) : history;
  const terminal = isTerminalRunStatus(run.status);
  let known = stats.runs > 0;
  let remaining = 0;
  const active: string[] = [];
  for (const [name, stage] of Object.entries(run.stages)) {
    if (stage.status !== STAGE_STATUS.PENDING && stage.status !== STAGE_STATUS.RUNNING) continue;
    if (stage.status === STAGE_STATUS.RUNNING) active.push(name);
    const sample = stats.stages[name];
    if (!sample) {
      if (stage.status === STAGE_STATUS.RUNNING || name !== 'repair') known = false;
      continue;
    }
    remaining += stage.status === STAGE_STATUS.RUNNING
      ? Math.max(0, sample.medianSeconds - seconds(now, stage.startedAt))
      : sample.medianSeconds * sample.frequency;
  }
  return {
    elapsedSeconds: Math.floor(seconds(terminal && run.completedAt ? run.completedAt : now, run.startedAt)),
    remainingSeconds: terminal ? 0 : known ? Math.ceil(remaining) : null,
    stage: active.join('+') || run.status,
    historyRuns: stats.runs,
  };
}
export function progressLine(taskId: number | string, progress: ProgressEstimate): string {
  const time = (n: number) => n < 60 ? `${n}s` : `${Math.floor(n / 60)}m${n % 60}s`;
  const label = typeof taskId === 'number' ? `FlowCrew #${taskId}` : taskId;
  const filled = Math.round(Math.max(0, Math.min(1, progress.fraction ?? 0)) * 10);
  const bar = progress.source ? ` · ${progress.source === 'history' ? 'history ' : ''}[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}]` : '';
  return `${label} · elapsed ${time(progress.elapsedSeconds)} · ${progress.stage} · remaining ${progress.remainingSeconds === null ? 'unknown' : `~${time(progress.remainingSeconds)}`}${bar}`;
}
