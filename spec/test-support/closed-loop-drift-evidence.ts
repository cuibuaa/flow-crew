import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { supervisionPaths } from '../../src/supervision.js';
import type { RunDriftRowId } from '../../src/run-drift.js';

interface RecordedAnchor {
  label: string;
  sourcePath: string;
  byteStart?: number;
  byteEndExclusive?: number;
  bytes?: number;
  sha256: string;
}

interface OverheadRecord {
  stageId: string;
  attemptIndex: number;
  startedAt: string;
  completedAt: string;
  adapterMs: number;
  overheadMs: number;
}

export interface ClosedLoopDriftEvidence {
  version: 1;
  kind: 'closed_loop_drift_evidence';
  evidenceRunId: string;
  baseFailure: { exitCode: 1; logBytes: number; logSha256: string };
  historical: {
    doseMinutes: number[];
    doseFloorMinutes: number;
    firstPlan: { attemptIndex: 1; admitted: false; laterAdmittedAttemptIndex: number };
    supervisorRejections: { total: number; maxPerStage: number; laterOverturned: number; budgetPerStage: number };
    overhead: OverheadRecord[];
    registry: { bytes: number; records: number; tasks: number };
    serviceLogBytes: number;
  };
  runState: Record<string, unknown>;
  planRetryState: Record<string, unknown>;
  researchJournal: { rounds: Array<{ label: string; outcome: 'no_candidate' }> };
  events: Record<string, unknown>[];
  anchors: RecordedAnchor[];
}

export interface MaterializedClosedLoopDriftFixture {
  root: string;
  fcHome: string;
  runsRoot: string;
  runDir: string;
  projectDir: string;
  registryPath: string;
  serviceLogPath: string;
  runId: string;
  taskId: number;
  unit: string;
  evidence: ClosedLoopDriftEvidence;
  state: Record<string, unknown>;
}

export const EXPECTED_DRIFT_ROW_IDS = new Set<RunDriftRowId>([
  'research_dose',
  'first_plan_admission',
  'supervisor_rejections',
  'engine_overhead',
  'registry_growth',
  'log_growth',
]);

function fixturePath(): string {
  return join(import.meta.dirname, '..', 'fixtures', 'closed-loop-drift-evidence.json');
}

export function loadClosedLoopDriftEvidence(): ClosedLoopDriftEvidence {
  const fixture = JSON.parse(readFileSync(fixturePath(), 'utf-8')) as ClosedLoopDriftEvidence;
  if (fixture.version !== 1 || fixture.kind !== 'closed_loop_drift_evidence') {
    throw new Error('unsupported closed-loop drift evidence fixture');
  }
  if (fixture.baseFailure.exitCode !== 1 || !/^[0-9a-f]{64}$/.test(fixture.baseFailure.logSha256)) {
    throw new Error('closed-loop drift unchanged-base failure is not bound');
  }
  if (fixture.anchors.length < 7 || fixture.anchors.some((anchor) => (
    !/^[0-9a-f]{64}$/.test(anchor.sha256)
    || ((anchor.byteStart === undefined) !== (anchor.byteEndExclusive === undefined))
    || (anchor.byteStart !== undefined && anchor.byteEndExclusive! <= anchor.byteStart)
  ))) {
    throw new Error('closed-loop drift byte anchors are incomplete');
  }
  return fixture;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function buildRegistry(input: {
  path: string;
  bytes: number;
  records: number;
  tasks: number;
  runId: string;
  unit: string;
  taskId: number;
}): void {
  const rows: string[] = [];
  for (let index = 0; index < input.records - 1; index++) {
    rows.push(JSON.stringify({ id: (index % input.tasks) + 1, status: 'done' }));
  }
  rows.push(JSON.stringify({ id: input.taskId, run_id: input.runId, systemd_unit: input.unit, status: 'running' }));
  const unpaddedBytes = Buffer.byteLength(`${rows.join('\n')}\n`, 'utf-8');
  if (unpaddedBytes > input.bytes) throw new Error('recorded registry size is smaller than its fixture rows');
  rows[0] += ' '.repeat(input.bytes - unpaddedBytes);
  const output = `${rows.join('\n')}\n`;
  if (Buffer.byteLength(output, 'utf-8') !== input.bytes) throw new Error('registry fixture byte size drifted');
  writeFileSync(input.path, output, 'utf-8');
}

export function materializeClosedLoopDriftFixture(): MaterializedClosedLoopDriftFixture {
  const evidence = loadClosedLoopDriftEvidence();
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-closed-loop-drift-'));
  const fcHome = join(root, 'state');
  const runsRoot = join(fcHome, 'runs');
  const runDir = join(runsRoot, evidence.evidenceRunId);
  const projectDir = join(root, 'project');
  const registryPath = join(fcHome, 'tasks.jsonl');
  const taskId = 2130;
  const unit = `flowcrew-task-${taskId}.service`;
  mkdirSync(runDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const state = structuredClone(evidence.runState);
  state.projectDir = projectDir;
  const stages = state.stages as Record<string, Record<string, unknown>>;
  stages.plan.attempts = evidence.historical.overhead.map((sample) => ({
    index: sample.attemptIndex,
    status: 'complete',
    startedAt: sample.startedAt,
    completedAt: sample.completedAt,
    duration_ms: sample.adapterMs,
  }));
  writeJson(join(runDir, 'run.json'), state);
  writeJson(join(runDir, 'plan_retry_state.json'), evidence.planRetryState);
  writeJson(join(runDir, 'research_journal.json'), evidence.researchJournal);
  for (const [index, round] of evidence.researchJournal.rounds.entries()) {
    writeJson(join(runDir, `research_round_${index + 1}_no_candidate_consumed.json`), {
      label: round.label,
      outcome: round.outcome,
      dose_minutes: evidence.historical.doseMinutes[index],
    });
  }
  writeFileSync(join(runDir, 'events.jsonl'), `${evidence.events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf-8');
  writeJson(join(runDir, 'signals', 'reject_counts.json'), { run_round: 1, run_round2: 1 });
  writeFileSync(join(runDir, 'scheduler.pid'), `${process.pid}\n`, 'utf-8');

  mkdirSync(fcHome, { recursive: true });
  buildRegistry({
    path: registryPath,
    ...evidence.historical.registry,
    runId: evidence.evidenceRunId,
    unit,
    taskId,
  });
  const serviceLogPath = supervisionPaths(fcHome, unit).log;
  mkdirSync(dirname(serviceLogPath), { recursive: true });
  writeFileSync(serviceLogPath, '', 'utf-8');
  truncateSync(serviceLogPath, evidence.historical.serviceLogBytes);

  return {
    root,
    fcHome,
    runsRoot,
    runDir,
    projectDir,
    registryPath,
    serviceLogPath,
    runId: evidence.evidenceRunId,
    taskId,
    unit,
    evidence,
    state,
  };
}

function hashPath(path: string, root: string, hash: ReturnType<typeof createHash>): void {
  const entries = readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const target = join(path, entry.name);
    const relativePath = relative(root, target);
    const stats = statSync(target);
    hash.update(`${relativePath}\0${entry.isDirectory() ? 'd' : 'f'}\0${stats.size}\0${stats.mtimeMs}\0`);
    if (entry.isDirectory()) {
      hashPath(target, root, hash);
      continue;
    }
    if (stats.size <= 32 * 1024 * 1024) {
      hash.update(readFileSync(target));
      continue;
    }
    // The 168 MB historical log is sparse in the fixture. Hash both extents,
    // size, and mtime without turning a bounded read-only test into a 168 MB load.
    const fd = openSync(target, 'r');
    try {
      const first = Buffer.alloc(Math.min(4096, stats.size));
      const last = Buffer.alloc(Math.min(4096, stats.size));
      readSync(fd, first, 0, first.length, 0);
      readSync(fd, last, 0, last.length, Math.max(0, stats.size - last.length));
      hash.update(first);
      hash.update(last);
    } finally {
      closeSync(fd);
    }
  }
}

export function fixtureMutationHash(fixture: MaterializedClosedLoopDriftFixture): string {
  const hash = createHash('sha256');
  hashPath(fixture.fcHome, fixture.root, hash);
  hashPath(fixture.projectDir, fixture.root, hash);
  return hash.digest('hex');
}

export function resizeFixtureServiceLog(
  fixture: MaterializedClosedLoopDriftFixture,
  bytes: number,
): void {
  truncateSync(fixture.serviceLogPath, bytes);
}

export function fixtureLabel(fixture: MaterializedClosedLoopDriftFixture): string {
  return `${basename(fixture.projectDir)}:${fixture.runId}`;
}
