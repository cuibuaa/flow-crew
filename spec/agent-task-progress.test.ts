import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTaskProgressReader } from '../src/agent-task-progress.js';
import { cmdFcTasks } from '../src/cli-fc-tasks.js';
import { createTaskEntry, renderFcTasks } from '../src/fc-tasks.js';
import { estimateProgress, progressLine, type ProgressRun } from '../src/task-progress.js';

let root: string;
const start = '2020-01-01T00:00:00Z';
const at = (seconds: number) => new Date(Date.parse(start) + seconds * 1000).toISOString();
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agent-progress-')); });
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
function record(name: string, effort: string | null = 'high', backend = 'codex', duration?: number) {
  const path = join(root, 'records', name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'route.json'), JSON.stringify({ backend, effort, started_at: start }));
  if (duration !== undefined) {
    writeFileSync(join(path, 'DONE'), '');
    utimesSync(join(path, 'DONE'), new Date(at(duration)), new Date(at(duration)));
  }
  return path;
}
function ledger(path: string) {
  const entry = { id: '1', subject: 'codex: fixture', activeForm: 'fixture (codex, high) now: loop',
    description: `Backend codex task (route: explicit); record ${path}. Wrap-up remains: inspect result`,
    status: 'in_progress', blocks: [], blockedBy: [] };
  createTaskEntry({ storeRoot: join(root, 'ledger'), session: 'fixture', entry });
  return entry;
}
function render(seconds = 130) {
  return renderFcTasks({ storeRoot: join(root, 'ledger'), explicitSession: 'fixture',
    agentTaskRoot: join(root, 'records'), now: Date.parse(at(seconds)), columns: 200 });
}

describe('agent-task progress in the shared ledger renderer', () => {
  it('reads the launcher measurement schema and formats a rate, phase and bar through the shared functions', () => {
    const path = record('active');
    const entry = ledger(path);
    writeFileSync(join(path, 'progress.json'), JSON.stringify({ version: 1, startedAt: start, phase: 'running', phaseStartedAt: start,
      measurement: { done: 40, total: 100, unit: 'cases', startedAt: at(10), startedDone: 10, updatedAt: at(130) } }));
    const input = agentTaskProgressReader(join(root, 'records'))(entry)!;
    const progress = estimateProgress(input.run, input.history, Date.parse(at(130)));
    expect(progress).toMatchObject({ elapsedSeconds: 130, remainingSeconds: 240, source: 'measured', fraction: 0.4 });
    expect(render().text).toContain('Codex #1 · elapsed 2m10s · running · remaining ~4m0s · [████░░░░░░]');
  });

  it('uses only completed same-backend, same-effort survivors and labels the backtested lower quartile', () => {
    ledger(record('active'));
    for (const [index, duration] of [200, 300, 400, 500, 600].entries()) record(`past-${index}`, 'high', 'codex', duration);
    record('short', 'high', 'codex', 100);
    record('other-effort', 'low', 'codex', 800);
    record('other-backend', 'high', 'claude', 800);
    record('legacy', null, 'codex', 800);
    record('future', 'high', 'codex', 1200);
    // By this checkpoint all five relevant samples are complete and 130s have elapsed for the active run.
    const path = join(root, 'records', 'active', 'route.json');
    writeFileSync(path, JSON.stringify({ backend: 'codex', effort: 'high', started_at: at(1000) }));
    expect(render(1130).text).toContain('remaining ~2m50s · history [████░░░░░░]');
  });

  it('keeps unknown honest with sparse history and reflects legacy VERIFY and review instead of an overdue zero', () => {
    const path = record('active');
    ledger(path);
    record('past', 'high', 'codex', 100);
    expect(render().text).toContain('elapsed 2m10s · running · remaining unknown · [░░░░░░░░░░]');
    writeFileSync(join(path, 'exit'), '0');
    writeFileSync(join(path, 'verify.log'), '');
    expect(render().text).toContain('· VERIFY · remaining unknown');
    writeFileSync(join(path, 'verify.exit'), '0');
    expect(render(1330).text).toContain('elapsed 22m10s · review · remaining unknown');
  });

  it('does not invent a measured rate from one point or invalid counters; completed phase progress does not spill into review', () => {
    const path = record('active');
    ledger(path);
    for (const measurement of [
      { done: 20, total: 100, startedDone: 20, startedAt: at(10), updatedAt: at(10) },
      { done: 101, total: 100, startedDone: 0, startedAt: at(10), updatedAt: at(100) },
    ]) {
      writeFileSync(join(path, 'progress.json'), JSON.stringify({ version: 1, phase: 'running', measurement }));
      expect(render().text).toContain('remaining unknown');
    }
    writeFileSync(join(path, 'progress.json'), JSON.stringify({ version: 1, phase: 'review', phaseStartedAt: at(100) }));
    expect(render().text).toContain('· review · remaining unknown');
  });

  it('exposes the same row through fc_tasks render using an explicit fixture root', () => {
    const path = record('active');
    ledger(path);
    vi.useFakeTimers(); vi.setSystemTime(new Date(at(130)));
    let text = '';
    expect(cmdFcTasks(['fc_tasks', 'render', '--session', 'fixture', '--store-root', join(root, 'ledger'), '--columns', '200'], {
      env: { AGENT_TASK_ROOT: join(root, 'records') }, stdinIsTTY: true,
      stdout: { write: chunk => { text += chunk; } },
    })).toBe(0);
    expect(text).toBe(render().text);
  });

  it('leaves FlowCrew estimator values, formatting and ledger rows unchanged', () => {
    const run: ProgressRun = { status: 'running', workflowName: 'fixture', startedAt: start,
      stages: { build: { status: 'running', startedAt: start } } };
    const past = { ...run, status: 'complete', stages: { build: { status: 'complete', duration_ms: 200_000 } } };
    const progress = estimateProgress(run, [past], Date.parse(at(130)));
    expect(progress).toEqual({ elapsedSeconds: 130, remainingSeconds: 70, stage: 'build', historyRuns: 1 });
    expect(progressLine(7, progress)).toBe('FlowCrew #7 · elapsed 2m10s · build · remaining ~1m10s');
    const tinyHistory = [2, 19_998].map(duration_ms => ({ ...past, stages: { build: { status: 'complete', duration_ms } } }));
    expect(estimateProgress(run, tinyHistory, Date.parse(start)).remainingSeconds).toBe(10);
    createTaskEntry({ storeRoot: join(root, 'ledger'), session: 'fixture', entry: {
      id: 'fc', subject: 'engine fixture', activeForm: 'building', description: '', status: 'in_progress', blocks: [], blockedBy: [],
    } });
    expect(render().text).toBe('fc_tasks: engine 0 running · ledger 1 in progress, 0 pending, 0 done\n▶ [fc] building\n');
    const resolver = { resolve: () => ({ state: 'resolved' as const, taskId: 7, taskStatus: 'running', projectDir: root }) };
    createTaskEntry({ storeRoot: join(root, 'ledger'), session: 'engine', flowcrewTaskId: 7, taskRunResolver: resolver, entry: {
      id: 'fc', subject: 'engine fixture', activeForm: 'building', description: '', status: 'in_progress', blocks: [], blockedBy: [],
    } });
    expect(renderFcTasks({ storeRoot: join(root, 'ledger'), explicitSession: 'engine', agentTaskRoot: join(root, 'records'),
      taskRunResolver: resolver, taskProgress: id => progressLine(id, progress), columns: 200 }).text)
      .toBe('fc_tasks: engine 1 running · ledger 1 in progress, 0 pending, 0 done\n▶ task:running [fc] building\nFlowCrew #7 · elapsed 2m10s · build · remaining ~1m10s\n');
  });
});
