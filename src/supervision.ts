import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  processCommandBinding,
  processIsAlive,
  processStartToken,
  processStartTokensMatch,
  type ProcessStartToken,
} from './run-lock.js';

export type UnitStatus =
  | { kind: 'active' }
  | { kind: 'deactivating' }
  | { kind: 'terminal'; exitCode: number; signal?: string }
  | { kind: 'terminal-unknown'; reason: string }
  | { kind: 'absent' }
  | { kind: 'unobservable'; reason: string };

export interface FileSupervisorLogSource {
  kind: 'file';
  path: string;
  /** Byte position immediately after the snapshot already returned to the client. */
  offset?: number;
}

export interface JournalSupervisorLogSource {
  kind: 'journal';
  unit: string;
}

export interface UnavailableSupervisorLogSource {
  kind: 'unavailable';
  reason: string;
}

export type SupervisorLogSource =
  FileSupervisorLogSource
  | JournalSupervisorLogSource
  | UnavailableSupervisorLogSource;

export interface SupervisorTailSnapshot {
  output: string;
  source: SupervisorLogSource;
}

export interface SupervisorBackend {
  isActive(unit: string): Promise<UnitStatus>;
  runUnit(opts: { unit: string; workingDirectory: string; command: string }): Promise<void>;
  stopUnit(unit: string): Promise<void>;
  journalTail(unit: string, lines: number, follow?: boolean): Promise<string>;
  /** Optional for older/injected backends; file snapshots include their byte-end cursor. */
  tailSnapshot?(unit: string, lines: number): Promise<SupervisorTailSnapshot>;
  /** Optional for older/injected backends; production exposes a truthful follow route. */
  logSource?(unit: string): Promise<SupervisorLogSource> | SupervisorLogSource;
}

export const SUPERVISION_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_SUPERVISION_STARTUP_GRACE_MS = 5_000;
export const DEFAULT_SUPERVISION_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface SupervisionLaunchRecord {
  version: typeof SUPERVISION_PROTOCOL_VERSION;
  unit: string;
  workingDirectory: string;
  command: string;
  nodePath: string;
  shellPath: string;
  createdAt: string;
  shutdownGraceMs: number;
  legacyRecordPath?: string;
}

export interface SupervisionRunningRecord {
  version: typeof SUPERVISION_PROTOCOL_VERSION;
  shimPid: number;
  /**
   * Absent means "identity not established yet", never "invalid". A process
   * table can lag a fork: on Linux `/proc/<pid>/stat` is readable the instant
   * the pid exists, but macOS has to ask `ps`, which may not list a
   * just-forked process yet. Refusing to launch on a missed probe turned a
   * timing artefact into "the agent was not launched". The shim backfills this
   * as soon as the probe succeeds; readers fall back to command binding until
   * then.
   */
  shimToken?: ProcessStartToken;
  /** Complete argv for PID-reuse-resistant binding of the shim itself. */
  shimCommand: string;
  agentPid: number;
  /** Same lazily-established contract as `shimToken`. */
  agentToken?: ProcessStartToken;
  command: string;
  startedAt: string;
  stoppingAt?: string;
}

export interface SupervisionExitRecord {
  version: typeof SUPERVISION_PROTOCOL_VERSION;
  exitCode: number | null;
  signal?: string;
  normalized: number;
  endedAt: string;
  reason?: string;
}

export interface SupervisionPaths {
  root: string;
  unitDir: string;
  launch: string;
  running: string;
  exit: string;
  log: string;
}

export interface PortableUnitObservation {
  status: UnitStatus;
  launch?: SupervisionLaunchRecord;
  running?: SupervisionRunningRecord;
  exit?: SupervisionExitRecord;
}

function safeUnitName(unit: string): string {
  const sanitized = unit.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return sanitized === '.' || sanitized === '..' ? `_${sanitized.replace(/\./g, '_')}` : sanitized;
}

export function supervisionPaths(baseDir: string, unit: string): SupervisionPaths {
  const root = join(baseDir, 'supervise');
  const unitDir = join(root, safeUnitName(unit));
  return {
    root,
    unitDir,
    launch: join(unitDir, 'launch.json'),
    running: join(unitDir, 'running.json'),
    exit: join(unitDir, 'exit.json'),
    log: join(unitDir, 'out.log'),
  };
}

/** Same-directory tmp + rename keeps readers from observing partial JSON. */
export function atomicWriteJson(
  path: string,
  value: unknown,
  options: { createParent?: boolean } = {},
): void {
  if (options.createParent !== false) mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* rename succeeded or cleanup is best-effort */ }
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStartToken(value: unknown): value is ProcessStartToken {
  return isRecord(value)
    && (value.kind === 'linux' || value.kind === 'posix-lstart')
    && typeof value.value === 'string'
    && value.value.length > 0;
}

export function readSupervisionLaunch(path: string): SupervisionLaunchRecord | undefined {
  const value = readJson(path);
  if (!isRecord(value)
    || value.version !== SUPERVISION_PROTOCOL_VERSION
    || typeof value.unit !== 'string'
    || typeof value.workingDirectory !== 'string'
    || typeof value.command !== 'string'
    || typeof value.nodePath !== 'string'
    || typeof value.shellPath !== 'string'
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(value.shutdownGraceMs)
    || (value.legacyRecordPath !== undefined && typeof value.legacyRecordPath !== 'string')) return undefined;
  return value as unknown as SupervisionLaunchRecord;
}

export function readSupervisionRunning(path: string): SupervisionRunningRecord | undefined {
  const value = readJson(path);
  if (!isRecord(value)
    || value.version !== SUPERVISION_PROTOCOL_VERSION
    || !Number.isSafeInteger(value.shimPid)
    || Number(value.shimPid) <= 0
    || (value.shimToken !== undefined && !isStartToken(value.shimToken))
    || typeof value.shimCommand !== 'string'
    || !Number.isSafeInteger(value.agentPid)
    || Number(value.agentPid) <= 0
    || (value.agentToken !== undefined && !isStartToken(value.agentToken))
    || typeof value.command !== 'string'
    || typeof value.startedAt !== 'string'
    || (value.stoppingAt !== undefined && typeof value.stoppingAt !== 'string')) return undefined;
  return value as unknown as SupervisionRunningRecord;
}

export function readSupervisionExit(path: string): SupervisionExitRecord | undefined {
  const value = readJson(path);
  if (!isRecord(value)
    || value.version !== SUPERVISION_PROTOCOL_VERSION
    || !(value.exitCode === null || Number.isSafeInteger(value.exitCode))
    || !Number.isSafeInteger(value.normalized)
    || Number(value.normalized) < 0
    || typeof value.endedAt !== 'string'
    || (value.signal !== undefined && typeof value.signal !== 'string')
    || (value.reason !== undefined && typeof value.reason !== 'string')) return undefined;
  return value as unknown as SupervisionExitRecord;
}

export function runningRecordBindsShim(record: SupervisionRunningRecord): boolean {
  return runningRecordBindingStatus(record) === 'bound';
}

export type RunningRecordBindingStatus = 'bound' | 'unbound' | 'unreadable';

export function runningRecordBindingStatus(record: SupervisionRunningRecord): RunningRecordBindingStatus {
  if (!processIsAlive(record.shimPid)) return 'unbound';
  // The recorded argv is a required factor in every case. The start token is an
  // additional one, applied only once it has been established: an unrecorded
  // token means the probe has not succeeded yet, which is not evidence that
  // this pid belongs to someone else. A token that IS recorded and does not
  // match is a genuine mismatch and always disqualifies.
  if (record.shimToken !== undefined) {
    const currentToken = processStartToken(record.shimPid);
    if (currentToken === undefined) return 'unreadable';
    if (!processStartTokensMatch(record.shimToken, currentToken)) return 'unbound';
  }
  return processCommandBinding(record.shimPid, record.shimCommand);
}

/**
 * Read order is a safety property, not an implementation detail. A durable exit
 * result wins even while a stale PID or a systemd cgroup still appears alive.
 */
export function observePortableUnit(
  baseDir: string,
  unit: string,
  options: { nowMs?: number; startupGraceMs?: number } = {},
): PortableUnitObservation {
  const paths = supervisionPaths(baseDir, unit);
  const exit = readSupervisionExit(paths.exit);
  if (exit) {
    return {
      status: {
        kind: 'terminal',
        exitCode: exit.normalized,
        ...(exit.signal ? { signal: exit.signal } : {}),
      },
      exit,
    };
  }

  const runningExists = existsSync(paths.running);
  const running = readSupervisionRunning(paths.running);
  if (running) {
    const binding = runningRecordBindingStatus(running);
    if (binding === 'bound') {
      return {
        status: running.stoppingAt ? { kind: 'deactivating' } : { kind: 'active' },
        running,
      };
    }
    if (binding === 'unreadable') {
      return {
        status: { kind: 'unobservable', reason: 'shim identity is temporarily unreadable' },
        running,
      };
    }
    return {
      status: { kind: 'terminal-unknown', reason: 'shim-died-without-status' },
      running,
    };
  }
  if (runningExists) {
    return { status: { kind: 'terminal-unknown', reason: 'shim-died-without-status' } };
  }

  const launchExists = existsSync(paths.launch);
  const launch = readSupervisionLaunch(paths.launch);
  if (launch) {
    const createdAt = Date.parse(launch.createdAt);
    const nowMs = options.nowMs ?? Date.now();
    const startupGraceMs = Math.max(0, options.startupGraceMs ?? DEFAULT_SUPERVISION_STARTUP_GRACE_MS);
    if (Number.isFinite(createdAt) && createdAt <= nowMs + 5_000 && nowMs - createdAt <= startupGraceMs) {
      return { status: { kind: 'active' }, launch };
    }
    return { status: { kind: 'terminal-unknown', reason: 'never-started' }, launch };
  }
  if (launchExists) {
    return { status: { kind: 'terminal-unknown', reason: 'never-started' } };
  }
  return { status: { kind: 'absent' } };
}

export function hasSupervisionEvidence(baseDir: string, unit: string): boolean {
  const paths = supervisionPaths(baseDir, unit);
  return existsSync(paths.launch) || existsSync(paths.running) || existsSync(paths.exit);
}

/** Delete only old directories with a valid exit record; every uncertain state is retained. */
export function gcSupervisionDirectories(
  baseDir: string,
  options: { nowMs?: number; retentionMs?: number } = {},
): number {
  const root = supervisionPaths(baseDir, '_').root;
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = Math.max(0, options.retentionMs ?? DEFAULT_SUPERVISION_RETENTION_MS);
  let removed = 0;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return 0; }
  for (const entry of entries) {
    const unitDir = join(root, entry);
    let isDirectory = false;
    try { isDirectory = statSync(unitDir).isDirectory(); } catch { /* raced with another GC */ }
    if (!isDirectory) continue;
    const exit = readSupervisionExit(join(unitDir, 'exit.json'));
    const endedAt = exit ? Date.parse(exit.endedAt) : NaN;
    if (!exit || !Number.isFinite(endedAt) || nowMs - endedAt < retentionMs) continue;
    try {
      rmSync(unitDir, { recursive: true, force: true });
      removed += 1;
    } catch { /* conservative best-effort maintenance */ }
  }
  return removed;
}

/** Runtime boundary for supervisor observations received over RPC or read as unknown data. */
export function isUnitStatus(value: unknown): value is UnitStatus {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'active':
    case 'deactivating':
    case 'absent':
      return true;
    case 'terminal':
      return Number.isSafeInteger(value.exitCode)
        && Number(value.exitCode) >= 0
        && (value.signal === undefined || typeof value.signal === 'string');
    case 'terminal-unknown':
    case 'unobservable':
      return typeof value.reason === 'string';
    default:
      return false;
  }
}
