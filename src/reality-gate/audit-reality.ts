import { readRunSnapshot } from '../run-lifecycle.js';
import { runRecordPath } from '../run-layout.js';
import { parseCommandArgs, commandUsage } from '../cli-args.js';
import { writeFileSync } from '../engine-fs.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TaskRegistry, type TaskEntry } from '../task-registry.js';
import { runsRoot } from '../store.js';
import { parseRealityChecks, runAllChecks } from './index.js';
import { admittedContract, ContractRefusal, type BriefAdmissionRecord } from '../brief-admission.js';
import type { CheckDecl, RealityGateReport } from './types.js';

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
  const stderr = opts.stderr ?? process.stderr;
  try {
    const parsed = parseCommandArgs('audit-reality', args);
    if (parsed.help) { stdout.write(`${commandUsage('audit-reality')}\n`); return 0; }
    const output = parsed.values.get('--output');
    const rows = await auditRows(parsed.values);
    const markdown = renderRows(rows);
    if (output) writeFileSync(output, markdown, 'utf-8');
    stdout.write(markdown);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function auditRows(values: Map<string, string>): Promise<AuditRow[]> {
  const taskId = values.get('--task');
  const registry = new TaskRegistry();
  const tasks = taskId ? [registry.get(Number(taskId))].filter((item): item is TaskEntry => Boolean(item)) : registry.list({ status: 'all' });
  if (taskId && tasks.length === 0) return auditRunMatches(Number(taskId));
  const filtered = values.get('--range') === 'last-21-days'
    ? tasks.filter((task) => Date.now() - new Date(task.created_at).getTime() <= 21 * 86400000)
    : tasks;
  return Promise.all(filtered.map(auditTask));
}

async function auditRunMatches(id: number): Promise<AuditRow[]> {
  const root = runsRoot();
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const rows: AuditRow[] = [];
  for (const name of names) {
    const runPath = join(root, name);
    const statePath = runRecordPath(runPath, 'run.json');
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
  const briefPath = runRecordPath(runPath, 'task_brief.md');
  const label = `#${String(state.taskId ?? state.task_id ?? state.campaignSeq ?? state.campaignIteration ?? name)} ${name}`;
  const base = {
    task: escapeCell(label),
    project: escapeCell(projectDir.split(/[\\/]/).filter(Boolean).pop() ?? projectDir),
    claimedStatus: escapeCell(typeof state.status === 'string' ? state.status : 'unknown'),
  };
  const declaration = auditDeclarations(state.briefAdmission as BriefAdmissionRecord | undefined);
  if (typeof declaration === 'string') return { ...base, checksRun: declaration, realStatus: 'UNVERIFIABLE', mismatch: '—' };
  const decls = declaration;
  if (decls.length === 0) return { ...base, checksRun: '(no checks declared)', realStatus: 'UNVERIFIABLE', mismatch: '—' };
  const report = await runAllChecks(decls, { taskDir: runPath, projectDir, briefPath });
  return {
    ...base,
    checksRun: escapeCell(formatChecks(decls, report.results)),
    ...auditOutcome(report),
  };
}

async function auditTask(task: TaskEntry): Promise<AuditRow> {
  const runPath = task.run_id ? join(runsRoot(), task.run_id) : undefined;
  const runJson = runPath ? readRunSnapshot(runPath) : {};
  const projectDir = typeof runJson.projectDir === 'string' ? runJson.projectDir : task.projectDir;
  const briefPath = runPath ? runRecordPath(runPath, 'task_brief.md') : task.brief_path;
  const declaration = auditDeclarations(runPath ? runJson.briefAdmission as BriefAdmissionRecord | undefined : task.brief_admission);
  if (typeof declaration === 'string') return baseRow(task, projectDir, declaration, 'UNVERIFIABLE', '—');
  const decls = declaration;
  if (decls.length === 0) return baseRow(task, projectDir, '(no checks declared)', 'UNVERIFIABLE', '—');
  const report = await runAllChecks(decls, { taskDir: runPath ?? projectDir, projectDir, briefPath });
  const checks = formatChecks(decls, report.results);
  const { realStatus, mismatch } = auditOutcome(report);
  return baseRow(task, projectDir, checks, realStatus, mismatch);
}

function baseRow(task: TaskEntry, projectDir: string, checksRun: string, realStatus: string, mismatch: string): AuditRow {
  return {
    task: `#${task.id} ${escapeCell(task.name)}`,
    project: escapeCell(projectDir.split(/[\\/]/).filter(Boolean).pop() ?? projectDir),
    claimedStatus: escapeCell(task.status),
    checksRun: escapeCell(checksRun),
    realStatus,
    mismatch,
  };
}

/** A historical audit remains visible without inventing an execution contract. */
function auditDeclarations(record: BriefAdmissionRecord | undefined): CheckDecl[] | string {
  try { return parseRealityChecks(admittedContract(record).declaration.reality_checks ?? []); }
  catch (error) {
    if (error instanceof ContractRefusal) return error.code;
    throw error;
  }
}

function auditOutcome(report: RealityGateReport) {
  if (report.results.some(item => item.unfinished && !item.advisory)) return { realStatus: 'UNFINISHED', mismatch: '—' };
  return { realStatus: report.pass ? 'PASS' : 'FAKE', mismatch: report.pass ? '—' : '⚠ FABRICATED' };
}

function formatChecks(decls: CheckDecl[], results: RealityGateReport['results']): string {
  const statusByName = new Map(results.map((item) => [item.name, item.unfinished ? 'UNFINISHED' : item.pass ? 'PASS' : 'FAIL']));
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

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
