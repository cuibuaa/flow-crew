import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TaskRegistry, type TaskEntry } from '../task-registry.js';
import { parseChecksFromBrief, runAllChecks } from './index.js';
import type { CheckDecl } from './types.js';

interface AuditRow {
  task: string;
  project: string;
  claimedStatus: string;
  checksRun: string;
  realStatus: string;
  mismatch: string;
}

export async function cmdAuditReality(args: string[], opts: { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const output = valueAfter(args, '--output');
  const rows = await auditRows(args);
  const markdown = renderRows(rows);
  if (output) writeFileSync(output, markdown, 'utf-8');
  stdout.write(markdown);
  return 0;
}

async function auditRows(args: string[]): Promise<AuditRow[]> {
  const taskId = valueAfter(args, '--task');
  const registry = new TaskRegistry();
  const tasks = taskId ? [registry.get(Number.parseInt(taskId, 10))].filter((item): item is TaskEntry => Boolean(item)) : registry.list({ status: 'all' });
  if (taskId && tasks.length === 0) return auditRunMatches(Number.parseInt(taskId, 10));
  const filtered = args.includes('--range') && valueAfter(args, '--range') === 'last-21-days'
    ? tasks.filter((task) => Date.now() - new Date(task.created_at).getTime() <= 21 * 86400000)
    : tasks;
  return Promise.all(filtered.map(auditTask));
}

async function auditRunMatches(id: number): Promise<AuditRow[]> {
  const root = join(homedir(), '.fc', 'runs');
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const rows: AuditRow[] = [];
  for (const name of names) {
    const runPath = join(root, name);
    const statePath = join(runPath, 'run.json');
    if (!existsSync(statePath)) continue;
    let state: Record<string, unknown>;
    try { state = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>; } catch { continue; }
    const candidates = [state.taskId, state.task_id, state.campaignSeq, state.campaignIteration, state.id];
    if (!candidates.some((value) => value === id || value === String(id))) continue;
    rows.push(await auditRunState(name, runPath, state));
  }
  return rows;
}

async function auditRunState(name: string, runPath: string, state: Record<string, unknown>): Promise<AuditRow> {
  const projectDir = typeof state.projectDir === 'string' ? state.projectDir : process.cwd();
  const briefPath = existsSync(join(runPath, 'task_brief.md')) ? join(runPath, 'task_brief.md') : undefined;
  const label = `#${String(state.taskId ?? state.task_id ?? state.campaignSeq ?? state.campaignIteration ?? name)} ${name}`;
  const base = {
    task: escapeCell(label),
    project: escapeCell(projectDir.split(/[\\/]/).filter(Boolean).pop() ?? projectDir),
    claimedStatus: escapeCell(typeof state.status === 'string' ? state.status : 'unknown'),
  };
  if (!briefPath) return { ...base, checksRun: '(no checks declared)', realStatus: 'UNVERIFIABLE', mismatch: '—' };
  const decls = parseChecksFromBrief(briefPath);
  if (decls.length === 0) return { ...base, checksRun: '(no checks declared)', realStatus: 'UNVERIFIABLE', mismatch: '—' };
  const report = await runAllChecks(decls, { taskDir: runPath, projectDir, briefPath });
  return {
    ...base,
    checksRun: escapeCell(formatChecks(decls, report.results)),
    realStatus: report.pass ? 'PASS' : 'FAKE',
    mismatch: report.pass ? '—' : '⚠ FABRICATED',
  };
}

async function auditTask(task: TaskEntry): Promise<AuditRow> {
  const runPath = task.run_id ? join(homedir(), '.fc', 'runs', task.run_id) : undefined;
  const runJson = runPath && existsSync(join(runPath, 'run.json')) ? JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8')) as Record<string, unknown> : {};
  const projectDir = typeof runJson.projectDir === 'string' ? runJson.projectDir : task.projectDir;
  const briefPath = resolveBriefPath(task, runPath);
  if (!briefPath) {
    return baseRow(task, projectDir, '(no checks declared)', 'UNVERIFIABLE', '—');
  }
  const decls = parseChecksFromBrief(briefPath);
  if (decls.length === 0) return baseRow(task, projectDir, '(no checks declared)', 'UNVERIFIABLE', '—');
  const report = await runAllChecks(decls, { taskDir: runPath ?? projectDir, projectDir, briefPath });
  const checks = formatChecks(decls, report.results);
  const realStatus = report.pass ? 'PASS' : 'FAKE';
  const mismatch = report.pass ? '—' : '⚠ FABRICATED';
  return baseRow(task, projectDir, checks, realStatus, mismatch);
}

function baseRow(task: TaskEntry, projectDir: string, checksRun: string, realStatus: string, mismatch: string): AuditRow {
  return {
    task: `#${task.id} ${escapeCell(task.name)}`,
    project: escapeCell(projectDir.split(/[\\/]/).filter(Boolean).pop() ?? projectDir),
    claimedStatus: escapeCell(task.summary_verdict ?? task.status),
    checksRun: escapeCell(checksRun),
    realStatus,
    mismatch,
  };
}

function resolveBriefPath(task: TaskEntry, runPath?: string): string | undefined {
  const candidates = [
    runPath ? join(runPath, 'task_brief.md') : undefined,
    task.brief_path,
  ].filter((item): item is string => Boolean(item));
  return candidates.find((candidate) => existsSync(candidate));
}

function formatChecks(decls: CheckDecl[], results: Array<{ name: string; pass: boolean }>): string {
  const statusByName = new Map(results.map((item) => [item.name, item.pass ? 'PASS' : 'FAIL']));
  return decls.map((decl) => `${decl.name}:${statusByName.get(decl.name) ?? 'MISS'}`).join(', ');
}

function renderRows(rows: AuditRow[]): string {
  const header = [
    '| Task | Project | Claimed Status | Checks Run | Real Status | Mismatch |',
    '|---|---|---|---|---|---|',
  ];
  const body = rows.map((row) => `| ${row.task} | ${row.project} | ${row.claimedStatus} | ${row.checksRun} | ${row.realStatus} | ${row.mismatch} |`);
  return [...header, ...body, ''].join('\n');
}

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
