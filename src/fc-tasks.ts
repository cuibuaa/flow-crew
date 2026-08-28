import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import stringWidth from 'string-width';

export const FC_TASK_FIELDS = [
  'id',
  'subject',
  'description',
  'activeForm',
  'status',
  'blocks',
  'blockedBy',
] as const;

/** Optional FlowCrew-owned link; it is deliberately not part of the legacy seven-field census. */
export const FC_TASK_LINK_FIELD = 'flowcrewTaskId' as const;

const FC_TASK_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
} as const;

export const FC_TASK_STATUSES = [
  FC_TASK_STATUS.PENDING,
  FC_TASK_STATUS.IN_PROGRESS,
  FC_TASK_STATUS.COMPLETED,
] as const;

export type FcTaskStatus = (typeof FC_TASK_STATUSES)[number];

export interface FcTaskEntry {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: FcTaskStatus;
  blocks: string[];
  blockedBy: string[];
  flowcrewTaskId?: number;
}

export const RENDER_DEGRADATION_CODES = [
  'invalid_dimensions',
  'payload_not_json',
  'payload_too_large',
  'payload_not_object',
  'session_absent',
  'session_key_absent',
  'session_invalid',
  'store_unreadable',
  'scan_limit_exceeded',
  'entry_not_json',
  'entry_invalid',
  'duplicate_id',
  'graph_invalid',
  'resolver_unavailable',
  'internal_error',
] as const;

export type RenderDegradationCode = (typeof RENDER_DEGRADATION_CODES)[number];

export interface LedgerIssue {
  code: Extract<
    RenderDegradationCode,
    | 'store_unreadable'
    | 'scan_limit_exceeded'
    | 'entry_not_json'
    | 'entry_invalid'
    | 'duplicate_id'
    | 'graph_invalid'
  >;
  detail: string;
}

interface StoredTask extends FcTaskEntry {
  sourceName: string;
  sourcePath: string;
  sourceRecord: Record<string, unknown>;
}

interface ParsedTaskSource {
  sourceName: string;
  sourcePath: string;
  sourceBytes: number;
  sourceRecord: unknown;
}

interface UnreadableTaskSource {
  sourceName: string;
  sourcePath: string;
  sourceBytes: number;
  issue: LedgerIssue;
}

type ScannedTaskSource = ParsedTaskSource | UnreadableTaskSource;

type LedgerScanResult =
  | { state: 'no_ledger'; sources: []; entries: []; issues: [] }
  | {
      state: 'ready';
      sources: ScannedTaskSource[];
      entries: StoredTask[];
      issues: LedgerIssue[];
      totalBytes: number;
    }
  | {
      state: 'unavailable';
      sources: [];
      entries: [];
      issues: [LedgerIssue];
    };

export type LedgerReadResult =
  | { state: 'no_ledger'; entries: []; issues: [] }
  | { state: 'ready'; entries: StoredTask[]; issues: LedgerIssue[] }
  | { state: 'unavailable'; entries: []; issues: [LedgerIssue] };

export interface SessionPayload {
  provided: boolean;
  text: string;
}

export interface RenderFcTasksOptions {
  storeRoot: string;
  explicitSession?: string;
  payload?: SessionPayload;
  sessionKey?: string;
  environmentSession?: string;
  columns?: string | number;
  lines?: string | number;
  maxEntries?: number;
  readLedger?: (storeRoot: string, session: string, maxEntries?: number) => LedgerReadResult;
  taskRunResolver?: FcTaskRunResolver;
}

export interface RenderFcTasksResult {
  text: string;
  state: 'active' | 'idle' | 'no_ledger' | 'degraded';
  session?: string;
  issueCodes: RenderDegradationCode[];
}

export interface LedgerPublication {
  create?: (temporaryPath: string, targetPath: string) => void;
  update?: (temporaryPath: string, targetPath: string) => void;
}

export interface LedgerWriteOptions {
  storeRoot: string;
  session: string;
  entry: unknown;
  maxEntries?: number;
  publication?: LedgerPublication;
  flowcrewTaskId?: number;
  taskRunResolver?: FcTaskRunResolver;
  clearFlowcrewTaskLink?: boolean;
}

export interface LedgerUpdateOptions extends LedgerWriteOptions {
  id: string;
}

export class FcTasksRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FcTasksRefusal';
  }
}

export type FcTaskRunResolution =
  | { state: 'never_linked' }
  | {
      state: 'resolved';
      taskId: number;
      taskStatus: string;
      projectDir: string;
      briefDigest?: string;
      runId?: string;
      runStatus?: string;
    }
  | { state: 'stale'; taskId: number; detail: string }
  | { state: 'unavailable'; taskId: number; detail: string };

export interface FcTaskRunResolver {
  prepare?(entries: readonly FcTaskEntry[]): void;
  resolve(entry: FcTaskEntry): FcTaskRunResolution;
}

export interface EngineTaskRunResolverOptions {
  /** FlowCrew state root containing tasks.jsonl and runs/. Required for test-store isolation. */
  engineRoot: string;
  /** Optional explicit archive root; defaults to <engineRoot>/runs. */
  runRoot?: string;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_LINES = 24;
const DEFAULT_MAX_ENTRIES = 1_000;
const MAX_COLUMNS = 10_000;
const MAX_LINES = 1_000;
const MAX_LEDGER_DIRECTORY_ENTRIES = 4_096;
const MAX_FRONTEND_PAYLOAD_BYTES = 1024 * 1024;
const MAX_LEDGER_ENTRY_BYTES = 1024 * 1024;
const MAX_LEDGER_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_TASK_TEXT_BYTES = 256 * 1024;
const MAX_TASK_RELATIONSHIPS = DEFAULT_MAX_ENTRIES;
const MAX_LEDGER_GRAPH_ERRORS = DEFAULT_MAX_ENTRIES;
const MAX_ENGINE_RUN_RECORD_BYTES = 1024 * 1024;
const MAX_ENGINE_STATUS_BYTES = 4 * 1024;
const MAX_ENGINE_PROJECT_PATH_BYTES = 64 * 1024;
const MAX_ENGINE_TASK_SNAPSHOT_BYTES = MAX_LEDGER_TOTAL_BYTES;
const MAX_ENGINE_REGISTRY_SCAN_BYTES = MAX_LEDGER_TOTAL_BYTES;
const LEDGER_LOCK_WAIT_MS = 5_000;
const LEDGER_LOCK_POLL_MS = 10;
const INVALID_SEGMENT_CHARACTERS = /[<>:"/\\|?*]/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const lockWaitCell = new Int32Array(new SharedArrayBuffer(4));

export function defaultFcTasksRoot(): string {
  return join(homedir(), '.claude', 'tasks');
}

export function defaultFcEngineRoot(): string {
  return join(homedir(), '.fc');
}

export function isSafePathSegment(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && value === value.trim()
    && value !== '.'
    && value !== '..'
    && Buffer.byteLength(value, 'utf-8') <= 240
    && !containsControlCharacter(value)
    && !INVALID_SEGMENT_CHARACTERS.test(value);
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return isTerminalControl(codePoint);
  });
}

function isTerminalControl(codePoint: number): boolean {
  return codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || codePoint === 0x061c
    || codePoint === 0x200e
    || codePoint === 0x200f
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new FcTasksRefusal(`${field} must be an array of strings`);
  }
  if (value.length > MAX_TASK_RELATIONSHIPS) {
    throw new FcTasksRefusal(`${field} exceeds the ${MAX_TASK_RELATIONSHIPS}-id limit`);
  }
  if (value.some((item) => typeof item !== 'string')) {
    throw new FcTasksRefusal(`${field} must be an array of strings`);
  }
  const values = value as string[];
  if (new Set(values).size !== values.length) {
    throw new FcTasksRefusal(`${field} must not contain duplicate ids`);
  }
  for (const id of values) {
    if (!isSafePathSegment(id)) {
      throw new FcTasksRefusal(`${field} contains an unsafe id`);
    }
  }
  return [...values];
}

export function validateFcTaskEntry(value: unknown, strictFields = false): FcTaskEntry {
  if (!isObject(value)) throw new FcTasksRefusal('entry must be a JSON object');

  if (strictFields) {
    const expected = new Set<string>([...FC_TASK_FIELDS, FC_TASK_LINK_FIELD]);
    const unexpected = Object.keys(value).filter((field) => !expected.has(field));
    const missing = FC_TASK_FIELDS.filter((field) => !(field in value));
    if (missing.length > 0) throw new FcTasksRefusal(`entry is missing field ${missing[0]}`);
    if (unexpected.length > 0) throw new FcTasksRefusal(`entry has unexpected field ${unexpected[0]}`);
  }

  if (typeof value.id !== 'string' || !isSafePathSegment(value.id)) {
    throw new FcTasksRefusal('id must be a non-empty safe path segment');
  }
  const { subject, description, activeForm } = value;
  if (typeof subject !== 'string') throw new FcTasksRefusal('subject must be a string');
  if (typeof description !== 'string') throw new FcTasksRefusal('description must be a string');
  if (typeof activeForm !== 'string') throw new FcTasksRefusal('activeForm must be a string');
  for (const [field, text] of Object.entries({ subject, description, activeForm })) {
    if (Buffer.byteLength(text, 'utf-8') > MAX_TASK_TEXT_BYTES) {
      throw new FcTasksRefusal(`${field} exceeds the ${MAX_TASK_TEXT_BYTES}-byte limit`);
    }
  }
  if (typeof value.status !== 'string' || !FC_TASK_STATUSES.includes(value.status as FcTaskStatus)) {
    throw new FcTasksRefusal(`status must be one of ${FC_TASK_STATUSES.join(', ')}`);
  }

  let flowcrewTaskId: number | undefined;
  if (Object.hasOwn(value, FC_TASK_LINK_FIELD)) {
    if (!Number.isSafeInteger(value.flowcrewTaskId) || (value.flowcrewTaskId as number) < 1) {
      throw new FcTasksRefusal(`${FC_TASK_LINK_FIELD} must be a positive safe integer`);
    }
    flowcrewTaskId = value.flowcrewTaskId as number;
  }

  return {
    id: value.id,
    subject,
    description,
    activeForm,
    status: value.status as FcTaskStatus,
    blocks: uniqueStringArray(value.blocks, 'blocks'),
    blockedBy: uniqueStringArray(value.blockedBy, 'blockedBy'),
    ...(flowcrewTaskId === undefined ? {} : { flowcrewTaskId }),
  };
}

function isCompleteFcTaskEntry(value: unknown): boolean {
  return isObject(value) && FC_TASK_FIELDS.every((field) => field in value);
}

function validateFcTaskPatch(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new FcTasksRefusal('entry must be a JSON object');
  const expected = new Set<string>([...FC_TASK_FIELDS, FC_TASK_LINK_FIELD]);
  const unexpected = Object.keys(value).filter((field) => !expected.has(field));
  if (unexpected.length > 0) {
    throw new FcTasksRefusal(`entry has unexpected field ${unexpected[0]}`);
  }
  return value;
}

function supportedTaskRecord(value: Record<string, unknown>): Record<string, unknown> {
  const supported: Record<string, unknown> = {};
  for (const field of [...FC_TASK_FIELDS, FC_TASK_LINK_FIELD]) {
    if (Object.hasOwn(value, field)) supported[field] = value[field];
  }
  return supported;
}

interface EngineTaskRecord {
  id: number;
  status: string;
  projectDir: string;
  runId?: string;
  briefDigest?: string;
}

type EngineTaskSnapshot =
  | { ok: true; tasks: Map<number, unknown> }
  | { ok: false; detail: string };

const ENGINE_REGISTRY_READ_CHUNK = 64 * 1024;
const MAX_ENGINE_REGISTRY_ROW_BYTES = 4 * 1024 * 1024;

function engineBriefDigest(value: unknown, field: 'brief_admission' | 'briefAdmission'): string | undefined {
  if (!isObject(value)) return undefined;
  const admission = value[field];
  if (!isObject(admission) || typeof admission.digest !== 'string') return undefined;
  return /^[a-f0-9]{64}$/u.test(admission.digest) ? admission.digest : undefined;
}

function parseEngineTask(value: unknown, expectedId: number): EngineTaskRecord | undefined {
  if (!isObject(value)
      || value.id !== expectedId
      || typeof value.status !== 'string'
      || value.status.trim() === ''
      || Buffer.byteLength(value.status, 'utf-8') > MAX_ENGINE_STATUS_BYTES
      || typeof value.projectDir !== 'string'
      || value.projectDir.trim() === ''
      || Buffer.byteLength(value.projectDir, 'utf-8') > MAX_ENGINE_PROJECT_PATH_BYTES) return undefined;
  if (value.run_id !== undefined && (typeof value.run_id !== 'string' || value.run_id.trim() === '')) {
    return undefined;
  }
  return {
    id: expectedId,
    status: value.status,
    projectDir: resolve(value.projectDir),
    ...(typeof value.run_id === 'string' ? { runId: value.run_id } : {}),
    ...(engineBriefDigest(value, 'brief_admission') === undefined
      ? {}
      : { briefDigest: engineBriefDigest(value, 'brief_admission') }),
  };
}

function pathWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

type DirectoryIdentity = { dev: number | bigint; ino: number | bigint };

function containedDirectoryIdentity(root: string, candidate: string): DirectoryIdentity | undefined {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!pathWithin(resolvedRoot, resolvedCandidate)) return undefined;
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  const components = relativePath === '' ? [] : relativePath.split(sep);
  let current = resolvedRoot;
  try {
    const rootStat = lstatSync(current);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
    if (components.length === 0) {
      return { dev: rootStat.dev, ino: rootStat.ino };
    }
    let finalIdentity: DirectoryIdentity | undefined;
    for (const component of components) {
      current = join(current, component);
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
      finalIdentity = { dev: stat.dev, ino: stat.ino };
    }
    return finalIdentity;
  } catch {
    return undefined;
  }
}

function sameContainedDirectory(
  root: string,
  candidate: string,
  expected: DirectoryIdentity,
): boolean {
  const current = containedDirectoryIdentity(root, candidate);
  return current !== undefined && current.dev === expected.dev && current.ino === expected.ino;
}

type BoundedFileRead =
  | { ok: true; text: string; byteLength: number }
  | { ok: false; reason: 'missing' | 'oversized' | 'unsafe' | 'unreadable'; detail: string };

function readBoundedRegularFile(path: string, maximumBytes: number): BoundedFileRead {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'missing', detail: 'file is missing' };
    }
    return { ok: false, reason: 'unreadable', detail: 'file cannot be inspected' };
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    return { ok: false, reason: 'unsafe', detail: 'path is not a regular non-symbolic file' };
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      return { ok: false, reason: 'unsafe', detail: 'file changed between inspection and open' };
    }
    if (opened.size > maximumBytes) {
      return { ok: false, reason: 'oversized', detail: `file exceeds the ${maximumBytes}-byte limit` };
    }
    const bytes = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maximumBytes) {
      return { ok: false, reason: 'oversized', detail: `file grew beyond the ${maximumBytes}-byte limit` };
    }
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink()
        || after.dev !== opened.dev || after.ino !== opened.ino) {
      return { ok: false, reason: 'unsafe', detail: 'file changed while it was being read' };
    }
    return { ok: true, text: bytes.subarray(0, offset).toString('utf-8'), byteLength: offset };
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* the read has already failed closed */ }
    }
  }
}

function resolveEngineRun(
  task: EngineTaskRecord,
  runRoot: string,
): FcTaskRunResolution {
  if (!task.runId) {
    return {
      state: 'resolved',
      taskId: task.id,
      taskStatus: task.status,
      projectDir: task.projectDir,
      ...(task.briefDigest === undefined ? {} : { briefDigest: task.briefDigest }),
    };
  }

  const runPath = isAbsolute(task.runId)
    ? resolve(task.runId)
    : resolve(runRoot, task.runId);
  const expectedRunId = basename(runPath);
  if ((!isAbsolute(task.runId) && !isSafePathSegment(task.runId)) || !pathWithin(runRoot, runPath)) {
    return { state: 'stale', taskId: task.id, detail: 'bound run path is outside the configured archive' };
  }
  const runDirectoryIdentity = containedDirectoryIdentity(runRoot, runPath);
  if (!runDirectoryIdentity) {
    return { state: 'stale', taskId: task.id, detail: 'bound run directory is not a real contained directory' };
  }

  let rawRun: unknown;
  const runRecord = readBoundedRegularFile(
    join(runPath, 'run.json'),
    MAX_ENGINE_RUN_RECORD_BYTES,
  );
  if (!sameContainedDirectory(runRoot, runPath, runDirectoryIdentity)) {
    return { state: 'stale', taskId: task.id, detail: 'bound run directory changed while it was inspected' };
  }
  if (!runRecord.ok) {
    if (runRecord.reason !== 'missing') {
      const detail = runRecord.reason === 'oversized'
        ? 'bound run record is oversized'
        : 'bound run record is unreadable';
      return { state: 'stale', taskId: task.id, detail };
    }
    const reservationRecord = readBoundedRegularFile(
      join(runPath, '.run-reservation.json'),
      MAX_ENGINE_RUN_RECORD_BYTES,
    );
    if (!sameContainedDirectory(runRoot, runPath, runDirectoryIdentity)) {
      return { state: 'stale', taskId: task.id, detail: 'bound run directory changed while it was inspected' };
    }
    if (!reservationRecord.ok) {
      return { state: 'stale', taskId: task.id, detail: 'bound run record is missing' };
    }
    let reservation: unknown;
    try {
      reservation = JSON.parse(reservationRecord.text) as unknown;
    } catch {
      return { state: 'stale', taskId: task.id, detail: 'bound run reservation does not match the task' };
    }
    if (!isObject(reservation)
        || reservation.version !== 1
        || reservation.runId !== expectedRunId
        || typeof reservation.projectDir !== 'string'
        || resolve(reservation.projectDir) !== task.projectDir
        || typeof reservation.reservedAt !== 'string'
        || !Number.isFinite(Date.parse(reservation.reservedAt))) {
      return { state: 'stale', taskId: task.id, detail: 'bound run reservation does not match the task' };
    }
    return {
      state: 'resolved',
      taskId: task.id,
      taskStatus: task.status,
      projectDir: task.projectDir,
      ...(task.briefDigest === undefined ? {} : { briefDigest: task.briefDigest }),
      runId: expectedRunId,
    };
  }
  try {
    rawRun = JSON.parse(runRecord.text) as unknown;
  } catch {
    return { state: 'stale', taskId: task.id, detail: 'bound run record is unreadable' };
  }

  if (!isObject(rawRun)
      || (rawRun.runId !== undefined && rawRun.runId !== expectedRunId)
      || typeof rawRun.status !== 'string'
      || rawRun.status.trim() === ''
      || Buffer.byteLength(rawRun.status, 'utf-8') > MAX_ENGINE_STATUS_BYTES
      || typeof rawRun.projectDir !== 'string'
      || Buffer.byteLength(rawRun.projectDir, 'utf-8') > MAX_ENGINE_PROJECT_PATH_BYTES
      || resolve(rawRun.projectDir) !== task.projectDir) {
    return { state: 'stale', taskId: task.id, detail: 'bound run record does not match the task' };
  }
  const runDigest = engineBriefDigest(rawRun, 'briefAdmission');
  if (task.briefDigest !== undefined && runDigest !== undefined && runDigest !== task.briefDigest) {
    return { state: 'stale', taskId: task.id, detail: 'bound run brief digest does not match the task' };
  }
  return {
    state: 'resolved',
    taskId: task.id,
    taskStatus: task.status,
    projectDir: task.projectDir,
    ...(task.briefDigest === undefined ? {} : { briefDigest: task.briefDigest }),
    runId: expectedRunId,
    runStatus: rawRun.status,
  };
}

function readLatestEngineTasks(
  registryPath: string,
  requestedIds: ReadonlySet<number>,
  engineRoot: string,
  engineRootIdentity: DirectoryIdentity,
): EngineTaskSnapshot {
  const tasks = new Map<number, unknown>();
  if (requestedIds.size === 0) return { ok: true, tasks };

  let descriptor: number | undefined;
  try {
    if (!sameDirectory(engineRoot, engineRootIdentity)) {
      return { ok: false, detail: 'configured engine root changed before its registry was read' };
    }
    const before = lstatSync(registryPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      return { ok: false, detail: 'engine task registry is not a regular non-symbolic file' };
    }
    descriptor = openSync(registryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      return { ok: false, detail: 'engine task registry changed between inspection and open' };
    }
    let offset = opened.size;
    let carry = Buffer.alloc(0);
    let unreadable = 0;
    let selectedBytes = 0;
    let scannedBytes = 0;
    let snapshotOversized = false;

    const inspect = (bytes: Buffer): void => {
      const line = bytes.toString('utf-8').trim();
      if (!line) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        unreadable += 1;
        return;
      }
      if (isObject(parsed)
          && Number.isSafeInteger(parsed.id)
          && requestedIds.has(parsed.id as number)
          && !tasks.has(parsed.id as number)) {
        selectedBytes += bytes.length;
        if (selectedBytes > MAX_ENGINE_TASK_SNAPSHOT_BYTES) {
          snapshotOversized = true;
          return;
        }
        tasks.set(parsed.id as number, parsed);
      }
    };

    while (offset > 0
        && tasks.size < requestedIds.size
        && unreadable === 0
        && !snapshotOversized
        && scannedBytes < MAX_ENGINE_REGISTRY_SCAN_BYTES) {
      const length = Math.min(
        ENGINE_REGISTRY_READ_CHUNK,
        offset,
        MAX_ENGINE_REGISTRY_SCAN_BYTES - scannedBytes,
      );
      offset -= length;
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(descriptor, chunk, 0, length, offset);
      if (bytesRead !== length) {
        return { ok: false, detail: 'engine task registry changed while it was being read' };
      }
      scannedBytes += bytesRead;
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
      let lineEnd = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) continue;
        inspect(combined.subarray(index + 1, lineEnd));
        lineEnd = index;
        if (tasks.size === requestedIds.size || unreadable > 0 || snapshotOversized) break;
      }
      carry = Buffer.from(combined.subarray(0, lineEnd));
      if (carry.length > MAX_ENGINE_REGISTRY_ROW_BYTES) {
        return { ok: false, detail: 'engine task registry contains an oversized record' };
      }
    }
    if (offset > 0
        && tasks.size < requestedIds.size
        && unreadable === 0
        && !snapshotOversized) {
      return {
        ok: false,
        detail: `engine task registry tail scan exceeds the ${MAX_ENGINE_REGISTRY_SCAN_BYTES}-byte limit`,
      };
    }
    if (offset === 0
        && tasks.size < requestedIds.size
        && unreadable === 0
        && !snapshotOversized) inspect(carry);
    if (snapshotOversized) {
      return { ok: false, detail: 'engine task snapshot exceeds the bounded read limit' };
    }
    if (unreadable > 0) {
      return {
        ok: false,
        detail: `engine task registry has ${unreadable} unreadable record${unreadable === 1 ? '' : 's'} in the required tail`,
      };
    }
    const after = lstatSync(registryPath);
    if (!after.isFile() || after.isSymbolicLink()
        || after.dev !== opened.dev || after.ino !== opened.ino
        || !sameDirectory(engineRoot, engineRootIdentity)) {
      return { ok: false, detail: 'engine task registry changed while it was being read' };
    }
    return { ok: true, tasks };
  } catch {
    return { ok: false, detail: 'engine task registry cannot be read' };
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

/**
 * Build a read-only resolver over the authoritative task registry. Its append-only tail is scanned
 * backward only until the latest requested task rows are found, then each run is opened directly by
 * recorded id; no archive walk or pid signal occurs.
 */
export function createEngineTaskRunResolver(
  options: EngineTaskRunResolverOptions,
): FcTaskRunResolver {
  const engineRoot = resolve(options.engineRoot);
  const runRoot = resolve(options.runRoot ?? join(engineRoot, 'runs'));
  let snapshot: EngineTaskSnapshot | undefined;
  const requestedIds = new Set<number>();

  const loadSnapshot = (): EngineTaskSnapshot => {
    if (snapshot) return snapshot;
    let engineRootIdentity: DirectoryIdentity;
    try {
      const rootStat = lstatSync(engineRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        snapshot = { ok: false, detail: 'configured engine root is not a directory' };
        return snapshot;
      }
      engineRootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
    } catch {
      snapshot = { ok: false, detail: 'configured engine root is unavailable' };
      return snapshot;
    }

    const registryPath = join(engineRoot, 'tasks.jsonl');
    if (!existsSync(registryPath)) {
      snapshot = { ok: true, tasks: new Map() };
      return snapshot;
    }
    snapshot = readLatestEngineTasks(
      registryPath,
      requestedIds,
      engineRoot,
      engineRootIdentity,
    );
    return snapshot;
  };

  return {
    prepare(entries): void {
      requestedIds.clear();
      for (const entry of entries) {
        if (entry.flowcrewTaskId !== undefined) requestedIds.add(entry.flowcrewTaskId);
      }
      snapshot = undefined;
      if (requestedIds.size > 0) loadSnapshot();
    },
    resolve(entry): FcTaskRunResolution {
      if (entry.flowcrewTaskId === undefined) return { state: 'never_linked' };
      if (!requestedIds.has(entry.flowcrewTaskId)) {
        requestedIds.add(entry.flowcrewTaskId);
        snapshot = undefined;
      }
      const current = loadSnapshot();
      if (!current.ok) {
        return { state: 'unavailable', taskId: entry.flowcrewTaskId, detail: current.detail };
      }
      const rawTask = current.tasks.get(entry.flowcrewTaskId);
      if (rawTask === undefined) {
        return { state: 'stale', taskId: entry.flowcrewTaskId, detail: 'linked engine task no longer exists' };
      }
      const task = parseEngineTask(rawTask, entry.flowcrewTaskId);
      if (!task) {
        return { state: 'stale', taskId: entry.flowcrewTaskId, detail: 'linked engine task record is invalid' };
      }
      return resolveEngineRun(task, runRoot);
    },
  };
}

export function resolveFcTaskRun(
  entry: FcTaskEntry,
  resolver?: FcTaskRunResolver,
): FcTaskRunResolution {
  if (entry.flowcrewTaskId === undefined) return { state: 'never_linked' };
  if (!resolver) {
    return {
      state: 'unavailable',
      taskId: entry.flowcrewTaskId,
      detail: 'no engine task resolver was supplied',
    };
  }
  try {
    const resolution = resolver.resolve(entry);
    if (resolution.state === 'never_linked'
        || resolution.taskId !== entry.flowcrewTaskId) {
      return {
        state: 'unavailable',
        taskId: entry.flowcrewTaskId,
        detail: 'engine task resolver returned a mismatched link identity',
      };
    }
    return resolution;
  } catch (error) {
    return {
      state: 'unavailable',
      taskId: entry.flowcrewTaskId,
      detail: `engine task resolver failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function resolveFcTaskRuns(
  entries: readonly FcTaskEntry[],
  resolver?: FcTaskRunResolver,
): FcTaskRunResolution[] {
  let preparationFailure: string | undefined;
  try {
    resolver?.prepare?.(entries);
  } catch (error) {
    preparationFailure = `engine task resolver failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return entries.map((entry) => {
    if (entry.flowcrewTaskId === undefined) return { state: 'never_linked' };
    if (preparationFailure !== undefined) {
      return {
        state: 'unavailable',
        taskId: entry.flowcrewTaskId,
        detail: preparationFailure,
      };
    }
    return resolveFcTaskRun(entry, resolver);
  });
}

function graphErrors(entries: readonly FcTaskEntry[]): string[] {
  const ids = new Set(entries.map(({ id }) => id));
  const errors: string[] = [];
  for (const entry of entries) {
    for (const field of ['blocks', 'blockedBy'] as const) {
      for (const target of entry[field]) {
        if (target === entry.id) {
          errors.push(`${entry.id}.${field} must not reference itself`);
        } else if (!ids.has(target)) {
          errors.push(`${entry.id}.${field} names missing entry ${target}`);
        }
        if (errors.length >= MAX_LEDGER_GRAPH_ERRORS) return errors;
      }
    }
  }
  return errors;
}

function lexicalIdOrder(left: FcTaskEntry, right: FcTaskEntry): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validateLedgerSources(
  sources: readonly ScannedTaskSource[],
): { entries: StoredTask[]; issues: LedgerIssue[] } {
  const parsed: StoredTask[] = [];
  const issues: LedgerIssue[] = [];
  for (const source of sources) {
    if ('issue' in source) {
      issues.push(source.issue);
      continue;
    }
    const { sourceName, sourcePath, sourceRecord } = source;
    try {
      const entry = validateFcTaskEntry(sourceRecord);
      parsed.push({
        ...entry,
        sourceName,
        sourcePath,
        sourceRecord: sourceRecord as Record<string, unknown>,
      });
    } catch (error) {
      issues.push({
        code: 'entry_invalid',
        detail: `${sourceName}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const unique: StoredTask[] = [];
  const firstSourceById = new Map<string, string>();
  for (const entry of parsed) {
    const firstSource = firstSourceById.get(entry.id);
    if (firstSource !== undefined) {
      issues.push({
        code: 'duplicate_id',
        detail: `id ${entry.id} appears in ${firstSource} and ${entry.sourceName}`,
      });
      continue;
    }
    firstSourceById.set(entry.id, entry.sourceName);
    unique.push(entry);
  }

  for (const detail of graphErrors(unique)) issues.push({ code: 'graph_invalid', detail });
  unique.sort(lexicalIdOrder);
  return { entries: unique, issues };
}

function scanTaskLedger(
  storeRoot: string,
  session: string,
  maxEntries = DEFAULT_MAX_ENTRIES,
): LedgerScanResult {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    return unavailableLedger(
      'scan_limit_exceeded',
      'maxEntries must be a positive safe integer',
    );
  }
  if (!isSafePathSegment(session)) {
    return unavailableLedger('store_unreadable', 'session is not a safe path segment');
  }
  const sessionPath = join(storeRoot, session);
  let directoryIdentity: { dev: number | bigint; ino: number | bigint };
  try {
    const stat = lstatSync(sessionPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return unavailableLedger('store_unreadable', 'session ledger is not a real directory');
    }
    directoryIdentity = { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'no_ledger', sources: [], entries: [], issues: [] };
    }
    return unavailableLedger('store_unreadable', 'session ledger cannot be inspected');
  }
  let names: string[];
  try {
    names = [];
    let directoryEntries = 0;
    const directory = opendirSync(sessionPath);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        directoryEntries += 1;
        if (directoryEntries > MAX_LEDGER_DIRECTORY_ENTRIES) {
          return unavailableLedger(
            'scan_limit_exceeded',
            `ledger directory exceeds the ${MAX_LEDGER_DIRECTORY_ENTRIES}-entry scan limit`,
          );
        }
        if (!entry.name.endsWith('.json')) continue;
        if (names.length >= maxEntries) {
          return unavailableLedger(
            'scan_limit_exceeded',
            `ledger has more than ${maxEntries} JSON entries; scan limit is ${maxEntries}`,
          );
        }
        if (!entry.isFile() || entry.isSymbolicLink()) {
          return unavailableLedger(
            'store_unreadable',
            `${entry.name} is not a regular ledger file`,
          );
        }
        names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
    names.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'no_ledger', sources: [], entries: [], issues: [] };
    }
    return unavailableLedger(
      'store_unreadable',
      `cannot scan session ledger: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!sameDirectory(sessionPath, directoryIdentity)) {
    return unavailableLedger('store_unreadable', 'session ledger changed while it was being scanned');
  }

  const sources: ScannedTaskSource[] = [];
  let totalBytes = 0;
  for (const sourceName of names) {
    const sourcePath = join(sessionPath, sourceName);
    if (!sameDirectory(sessionPath, directoryIdentity)) {
      return unavailableLedger('store_unreadable', 'session ledger changed while it was being read');
    }
    const opened = readBoundedRegularFile(sourcePath, MAX_LEDGER_ENTRY_BYTES);
    if (!opened.ok) {
      const code = opened.reason === 'oversized' ? 'entry_invalid' : 'store_unreadable';
      sources.push({
        sourceName,
        sourcePath,
        sourceBytes: 0,
        issue: { code, detail: `${sourceName}: ${opened.detail}` },
      });
      continue;
    }
    totalBytes += opened.byteLength;
    if (totalBytes > MAX_LEDGER_TOTAL_BYTES) {
      return unavailableLedger(
        'scan_limit_exceeded',
        `ledger exceeds the ${MAX_LEDGER_TOTAL_BYTES}-byte total scan limit`,
      );
    }
    try {
      sources.push({
        sourceName,
        sourcePath,
        sourceBytes: opened.byteLength,
        sourceRecord: JSON.parse(opened.text),
      });
    } catch {
      sources.push({
        sourceName,
        sourcePath,
        sourceBytes: opened.byteLength,
        issue: {
          code: 'entry_not_json',
          detail: `${sourceName}: invalid JSON`,
        },
      });
    }
    if (!sameDirectory(sessionPath, directoryIdentity)) {
      return unavailableLedger('store_unreadable', 'session ledger changed while it was being read');
    }
  }

  const validated = validateLedgerSources(sources);
  return { state: 'ready', sources, totalBytes, ...validated };
}

function unavailableLedger(code: LedgerIssue['code'], detail: string): LedgerScanResult {
  return {
    state: 'unavailable',
    sources: [],
    entries: [],
    issues: [{ code, detail }],
  };
}

function sameDirectory(
  path: string,
  expected: { dev: number | bigint; ino: number | bigint },
): boolean {
  try {
    const current = lstatSync(path);
    return current.isDirectory()
      && !current.isSymbolicLink()
      && current.dev === expected.dev
      && current.ino === expected.ino;
  } catch {
    return false;
  }
}

export function readTaskLedger(
  storeRoot: string,
  session: string,
  maxEntries = DEFAULT_MAX_ENTRIES,
): LedgerReadResult {
  const scanned = scanTaskLedger(storeRoot, session, maxEntries);
  if (scanned.state === 'no_ledger') return { state: 'no_ledger', entries: [], issues: [] };
  if (scanned.state === 'unavailable') {
    return { state: 'unavailable', entries: [], issues: scanned.issues };
  }
  return { state: 'ready', entries: scanned.entries, issues: scanned.issues };
}

function sanitizeRow(value: string): string {
  const withoutControls = [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return isTerminalControl(codePoint) ? ' ' : character;
  }).join('');
  return withoutControls.replace(/\s+/gu, ' ').trim();
}

export function clipToDisplayWidth(value: string, columns: number): string {
  const clean = sanitizeRow(value);
  if (stringWidth(clean) <= columns) return clean;
  if (columns <= 1) return '…';

  let clipped = '';
  let used = 0;
  for (const { segment } of segmenter.segment(clean)) {
    const segmentWidth = stringWidth(segment);
    if (used + segmentWidth + 1 > columns) break;
    clipped += segment;
    used += segmentWidth;
  }
  return `${clipped}…`;
}

function parseDimension(
  value: string | number | undefined,
  fallback: number,
  maximum: number,
): { ok: true; value: number } | { ok: false; value: number } {
  if (value === undefined) return { ok: true, value: fallback };
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    return { ok: false, value: fallback };
  }
  return { ok: true, value: parsed };
}

type SessionResolution =
  | { ok: true; session: string }
  | { ok: false; code: Extract<RenderDegradationCode, 'payload_not_json' | 'payload_too_large' | 'payload_not_object' | 'session_absent' | 'session_key_absent' | 'session_invalid'>; detail: string };

export function resolveFcTasksSession(options: {
  explicitSession?: string;
  payload?: SessionPayload;
  sessionKey?: string;
  environmentSession?: string;
}): SessionResolution {
  if (options.explicitSession !== undefined) {
    if (!isSafePathSegment(options.explicitSession)) {
      return { ok: false, code: 'session_invalid', detail: 'explicit session is not a safe path segment' };
    }
    return { ok: true, session: options.explicitSession };
  }

  if (options.payload?.provided) {
    if (typeof options.payload.text !== 'string') {
      return { ok: false, code: 'payload_not_json', detail: 'front-end payload is not JSON text' };
    }
    if (Buffer.byteLength(options.payload.text, 'utf-8') > MAX_FRONTEND_PAYLOAD_BYTES) {
      return {
        ok: false,
        code: 'payload_too_large',
        detail: `front-end payload exceeds the ${MAX_FRONTEND_PAYLOAD_BYTES}-byte limit`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.payload.text);
    } catch {
      return { ok: false, code: 'payload_not_json', detail: 'front-end payload is not JSON' };
    }
    if (!isObject(parsed)) {
      return { ok: false, code: 'payload_not_object', detail: 'front-end payload must be a JSON object' };
    }
    const key = options.sessionKey ?? 'session_id';
    if (!Object.hasOwn(parsed, key)) {
      return { ok: false, code: 'session_key_absent', detail: `front-end payload has no ${key} key` };
    }
    const value = parsed[key];
    if (typeof value !== 'string' || !isSafePathSegment(value)) {
      return { ok: false, code: 'session_invalid', detail: `${key} must be a non-empty safe path segment` };
    }
    return { ok: true, session: value };
  }

  if (options.environmentSession !== undefined && options.environmentSession !== '') {
    if (!isSafePathSegment(options.environmentSession)) {
      return { ok: false, code: 'session_invalid', detail: 'environment session is not a safe path segment' };
    }
    return { ok: true, session: options.environmentSession };
  }
  return { ok: false, code: 'session_absent', detail: 'no session selector was supplied' };
}

function degradedResult(
  code: RenderDegradationCode,
  detail: string,
  columns: number,
): RenderFcTasksResult {
  return {
    text: `${clipToDisplayWidth(`fc_tasks: degraded[${code}] · ${detail}`, columns)}\n`,
    state: 'degraded',
    issueCodes: [code],
  };
}

function rowWithOverflowSuffix(header: string, hiddenCount: number, columns: number): string {
  const suffix = `+${hiddenCount} row${hiddenCount === 1 ? '' : 's'} hidden`;
  const separator = ' · ';
  const suffixWidth = stringWidth(suffix);
  const separatorWidth = stringWidth(separator);
  const cleanHeader = sanitizeRow(header);
  const degradedPrefix = cleanHeader.match(/^fc_tasks: degraded\[[^\]]+\]/u)?.[0];

  if (degradedPrefix
      && stringWidth(degradedPrefix) > columns - suffixWidth - separatorWidth) {
    const compactSuffix = `+${hiddenCount}row${hiddenCount === 1 ? '' : 's'}`;
    if (stringWidth(degradedPrefix) + stringWidth(compactSuffix) <= columns) {
      return `${degradedPrefix}${compactSuffix}`;
    }
  }

  if (suffixWidth + separatorWidth >= columns) {
    return clipToDisplayWidth(suffix, columns);
  }

  const clippedHeader = clipToDisplayWidth(header, columns - suffixWidth - separatorWidth);
  return `${clippedHeader}${separator}${suffix}`;
}

function boundRows(header: string, detailRows: string[], lines: number, columns: number): string[] {
  if (detailRows.length === 0) return [header];
  if (lines === 1) return [rowWithOverflowSuffix(header, detailRows.length, columns)];
  if (detailRows.length <= lines - 1) return [header, ...detailRows];

  const visibleCount = Math.max(0, lines - 2);
  const hiddenCount = detailRows.length - visibleCount;
  return [
    header,
    ...detailRows.slice(0, visibleCount),
    `… +${hiddenCount} row${hiddenCount === 1 ? '' : 's'} not shown`,
  ];
}

function taskRunMarker(resolution: FcTaskRunResolution): string {
  switch (resolution.state) {
    case 'never_linked':
      return '';
    case 'resolved':
      return resolution.runStatus === undefined
        ? `task:${resolution.taskStatus}`
        : `run:${resolution.runStatus}`;
    case 'stale':
      return `stale:#${resolution.taskId}`;
    case 'unavailable':
      return `link-unavailable:#${resolution.taskId}`;
    default: {
      const _exhaustive: never = resolution;
      return _exhaustive;
    }
  }
}

export function renderFcTasks(options: RenderFcTasksOptions): RenderFcTasksResult {
  const parsedColumns = parseDimension(options.columns, DEFAULT_COLUMNS, MAX_COLUMNS);
  const parsedLines = parseDimension(options.lines, DEFAULT_LINES, MAX_LINES);
  if (!parsedColumns.ok || !parsedLines.ok) {
    const invalid = [!parsedColumns.ok ? 'COLUMNS' : '', !parsedLines.ok ? 'LINES' : '']
      .filter(Boolean)
      .join(' and ');
    return degradedResult('invalid_dimensions', `${invalid} must be a positive bounded integer`, parsedColumns.value);
  }

  const session = resolveFcTasksSession(options);
  if (!session.ok) return degradedResult(session.code, session.detail, parsedColumns.value);

  try {
    const ledger = (options.readLedger ?? readTaskLedger)(
      options.storeRoot,
      session.session,
      options.maxEntries,
    );
    if (ledger.state === 'no_ledger') {
      return {
        text: `${clipToDisplayWidth(`fc_tasks: no ledger · session ${session.session}`, parsedColumns.value)}\n`,
        state: 'no_ledger',
        session: session.session,
        issueCodes: [],
      };
    }
    if (ledger.state === 'unavailable') {
      const issue = ledger.issues[0];
      return {
        ...degradedResult(issue.code, issue.detail, parsedColumns.value),
        session: session.session,
      };
    }

    const running = ledger.entries.filter(({ status }) => status === FC_TASK_STATUS.IN_PROGRESS);
    const pending = ledger.entries.filter(({ status }) => status === FC_TASK_STATUS.PENDING);
    const done = ledger.entries.length - running.length - pending.length;
    const open = [...running, ...pending].sort(lexicalIdOrder);
    const allRunResolutions = resolveFcTaskRuns(ledger.entries, options.taskRunResolver);
    const runResolutionById = new Map(
      ledger.entries.map((entry, index) => [entry.id, allRunResolutions[index]]),
    );
    const openWithRunState = open.map((entry, index) => ({
      entry,
      resolution: runResolutionById.get(entry.id) ?? allRunResolutions[index],
    }));
    const staleCount = allRunResolutions.filter((resolution) => resolution.state === 'stale').length;
    const unavailable = allRunResolutions
      .find((resolution): resolution is Extract<FcTaskRunResolution, { state: 'unavailable' }> => (
        resolution.state === 'unavailable'
      ));
    const issueCodes = [...new Set<RenderDegradationCode>([
      ...ledger.issues.map(({ code }) => code),
      ...(unavailable ? ['resolver_unavailable' as const] : []),
    ])];

    let summary: string;
    if (ledger.entries.length === 0 && ledger.issues.length > 0) {
      summary = 'no readable entries';
    } else if (open.length === 0) {
      summary = `idle · ${done} done`;
    } else {
      summary = `${running.length} running · ${pending.length} pending · ${done} done`;
    }
    if (staleCount > 0) summary = `${staleCount} stale · ${summary}`;
    const header = issueCodes.length > 0
      ? `fc_tasks: degraded[${issueCodes.join(',')}] · ${summary}`
      : `fc_tasks: ${summary}`;

    const detailRows = openWithRunState.map(({ entry, resolution }) => {
      const marker = taskRunMarker(resolution);
      const prefix = marker ? `${marker} ` : '';
      if (entry.status === FC_TASK_STATUS.IN_PROGRESS) {
        return `▶ ${prefix}[${entry.id}] ${entry.activeForm || entry.subject}`;
      }
      return `○ ${prefix}[${entry.id}] ${entry.subject}`;
    });
    const warnings = [
      ...ledger.issues.map(({ code, detail }) => ({ code, detail })),
      ...(unavailable ? [{ code: 'resolver_unavailable' as const, detail: unavailable.detail }] : []),
    ];
    if (warnings.length > 0) {
      const first = warnings[0];
      detailRows.unshift(
        `⚠ ${first.code}: ${first.detail}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''}`,
      );
    }

    const rows = boundRows(header, detailRows, parsedLines.value, parsedColumns.value)
      .map((row) => clipToDisplayWidth(row, parsedColumns.value));
    return {
      text: `${rows.join('\n')}\n`,
      state: issueCodes.length > 0 ? 'degraded' : open.length > 0 ? 'active' : 'idle',
      session: session.session,
      issueCodes,
    };
  } catch (error) {
    return {
      ...degradedResult(
        'internal_error',
        `renderer failed: ${error instanceof Error ? error.message : String(error)}`,
        parsedColumns.value,
      ),
      session: session.session,
    };
  }
}

function assertWritableSession(
  storeRoot: string,
  session: string,
  create: boolean,
): { path: string; identity: DirectoryIdentity } {
  if (!isSafePathSegment(session)) throw new FcTasksRefusal('session must be a non-empty safe path segment');
  if (create) ensureDirectoryChain(storeRoot);
  const sessionPath = join(storeRoot, session);
  if (create) {
    try {
      mkdirSync(sessionPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new FcTasksRefusal(`session ledger cannot be created: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  let stat;
  try {
    stat = lstatSync(sessionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FcTasksRefusal(`session ledger ${session} does not exist`);
    }
    throw new FcTasksRefusal('session ledger cannot be inspected');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new FcTasksRefusal('session ledger must be a real directory');
  }
  try {
    fsyncDirectory(storeRoot);
  } catch (error) {
    throw new FcTasksRefusal(`session directory persistence failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    path: sessionPath,
    identity: { dev: stat.dev, ino: stat.ino },
  };
}

function ensureDirectoryChain(path: string): void {
  const missing: string[] = [];
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const directory of missing.reverse()) {
    const parent = resolve(directory, '..');
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new FcTasksRefusal(`ledger store cannot be created durably: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('created path is not a real directory');
      }
      // EEXIST can mean a peer won the mkdir race. Its parent entry still needs
      // the same persistence barrier before this process may acknowledge a write.
      fsyncDirectory(parent);
    } catch (error) {
      throw new FcTasksRefusal(`ledger store cannot be created durably: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function writableMaxEntries(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new FcTasksRefusal('maxEntries must be a positive safe integer');
  }
  return limit;
}

function readWritableLedger(
  storeRoot: string,
  session: string,
  maxEntries?: number,
): { entries: StoredTask[]; totalBytes: number } {
  const ledger = scanTaskLedger(storeRoot, session, maxEntries);
  if (ledger.state === 'no_ledger') {
    throw new FcTasksRefusal('session ledger changed before the write transaction');
  }
  if (ledger.state === 'unavailable' || ledger.issues.length > 0) {
    const issues = ledger.issues;
    throw new FcTasksRefusal(`existing ledger is invalid: ${issues[0].code}: ${issues[0].detail}`);
  }
  return { entries: ledger.entries, totalBytes: ledger.totalBytes };
}

function validateProposedLedger(entries: readonly FcTaskEntry[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new FcTasksRefusal(`duplicate id ${entry.id}`);
    ids.add(entry.id);
  }
  const errors = graphErrors(entries);
  if (errors.length > 0) throw new FcTasksRefusal(`ledger graph is invalid: ${errors[0]}`);
}

function applyExplicitTaskLink(
  entry: FcTaskEntry,
  flowcrewTaskId: number | undefined,
  clear: boolean,
): FcTaskEntry {
  if (clear && flowcrewTaskId !== undefined) {
    throw new FcTasksRefusal('cannot set and clear a FlowCrew task link in the same write');
  }
  if (flowcrewTaskId !== undefined) {
    if (!Number.isSafeInteger(flowcrewTaskId) || flowcrewTaskId < 1) {
      throw new FcTasksRefusal(`${FC_TASK_LINK_FIELD} must be a positive safe integer`);
    }
    if (entry.flowcrewTaskId !== undefined && entry.flowcrewTaskId !== flowcrewTaskId) {
      throw new FcTasksRefusal(
        `${FC_TASK_LINK_FIELD} ${entry.flowcrewTaskId} does not match requested FlowCrew task ${flowcrewTaskId}`,
      );
    }
    return { ...entry, flowcrewTaskId };
  }
  if (!clear) return entry;
  const { flowcrewTaskId: _flowcrewTaskId, ...withoutLink } = entry;
  return withoutLink;
}

function verifyTaskLink(entry: FcTaskEntry, resolver?: FcTaskRunResolver): void {
  if (entry.flowcrewTaskId === undefined) return;
  const resolution = resolveFcTaskRun(entry, resolver);
  if (resolution.state === 'resolved' && resolution.taskId === entry.flowcrewTaskId) return;
  if (resolution.state === 'stale') {
    throw new FcTasksRefusal(
      `stale FlowCrew task link #${entry.flowcrewTaskId}: ${resolution.detail}`,
    );
  }
  if (resolution.state === 'unavailable') {
    throw new FcTasksRefusal(
      `cannot verify FlowCrew task link #${entry.flowcrewTaskId}: ${resolution.detail}`,
    );
  }
  throw new FcTasksRefusal(`cannot verify FlowCrew task link #${entry.flowcrewTaskId}`);
}

function writeTemporaryEntry(
  sessionPath: string,
  sessionIdentity: DirectoryIdentity,
  serializedEntry: string,
): string {
  const temporaryPath = join(sessionPath, `.fc-task-${randomBytes(16).toString('hex')}.tmp`);
  let descriptor: number | undefined;
  try {
    if (!sameDirectory(sessionPath, sessionIdentity)) {
      throw new FcTasksRefusal('session ledger changed before the temporary write');
    }
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    if (!sameDirectory(sessionPath, sessionIdentity)) {
      throw new FcTasksRefusal('session ledger changed during the temporary write');
    }
    writeFileSync(descriptor, serializedEntry, 'utf-8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporaryPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(temporaryPath); } catch { /* absent or already removed */ }
    throw new FcTasksRefusal(`could not prepare atomic ledger write: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupported = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')
      || (process.platform === 'win32' && ['EBADF', 'EISDIR', 'EPERM'].includes(code ?? ''));
    if (!unsupported) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function serializeLedgerEntry(value: unknown): { text: string; byteLength: number } {
  let text: string;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    throw new FcTasksRefusal(`entry cannot be serialized: ${error instanceof Error ? error.message : String(error)}`);
  }
  const byteLength = Buffer.byteLength(text, 'utf-8');
  if (byteLength > MAX_LEDGER_ENTRY_BYTES) {
    throw new FcTasksRefusal(`entry exceeds the ${MAX_LEDGER_ENTRY_BYTES}-byte file limit`);
  }
  return { text, byteLength };
}

interface LedgerLock {
  path: string;
  ownerPath: string;
  token: string;
  identity: { dev: number | bigint; ino: number | bigint };
}

function ledgerLockPath(storeRoot: string, session: string): string {
  // A case-insensitive store can expose one session directory through multiple
  // spellings. Serialize those aliases even on a case-sensitive host so the
  // transaction identity never depends on the host's case-folding policy.
  const canonicalSession = session.normalize('NFC').toLowerCase();
  const digest = createHash('sha256').update(canonicalSession).digest('hex');
  return join(storeRoot, `.fc-tasks-lock-${digest}`);
}

function acquireLedgerLock(storeRoot: string, session: string): LedgerLock {
  const path = ledgerLockPath(storeRoot, session);
  const ownerPath = join(path, 'owner');
  const token = randomBytes(16).toString('hex');
  const started = process.hrtime.bigint();
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      try {
        writeFileSync(ownerPath, `${JSON.stringify({ version: 1, pid: process.pid, token })}\n`, {
          encoding: 'utf-8',
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        try { rmdirSync(path); } catch { /* fail-safe residue blocks another writer */ }
        throw new FcTasksRefusal(`ledger lock owner cannot be recorded: ${error instanceof Error ? error.message : String(error)}`);
      }
      const stat = lstatSync(path);
      return { path, ownerPath, token, identity: { dev: stat.dev, ino: stat.ino } };
    } catch (error) {
      if (error instanceof FcTasksRefusal) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new FcTasksRefusal(`ledger lock cannot be acquired: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (recoverDefinitelyStaleLedgerLock(path, ownerPath)) continue;
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      if (elapsedMs >= LEDGER_LOCK_WAIT_MS) {
        throw new FcTasksRefusal('ledger lock is busy; retry after the concurrent writer finishes');
      }
      Atomics.wait(lockWaitCell, 0, 0, LEDGER_LOCK_POLL_MS);
    }
  }
}

function recoverDefinitelyStaleLedgerLock(path: string, ownerPath: string): boolean {
  let identity: { dev: number | bigint; ino: number | bigint };
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    identity = { dev: stat.dev, ino: stat.ino };
  } catch {
    return false;
  }
  const owner = readBoundedRegularFile(ownerPath, 4_096);
  if (!owner.ok) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(owner.text) as unknown;
  } catch {
    return false;
  }
  if (!isObject(parsed)
      || parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid as number) < 1
      || typeof parsed.token !== 'string'
      || !/^[a-f0-9]{32}$/u.test(parsed.token)) return false;
  try {
    process.kill(parsed.pid as number, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }
  if (!sameDirectory(path, identity)) return false;
  try {
    unlinkSync(ownerPath);
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function releaseLedgerLock(lock: LedgerLock): void {
  if (!sameDirectory(lock.path, lock.identity)) {
    throw new FcTasksRefusal('ledger lock ownership was lost; reread the ledger before retrying');
  }
  const owner = readBoundedRegularFile(lock.ownerPath, 4_096);
  if (!owner.ok) throw new FcTasksRefusal('ledger lock ownership was lost; reread the ledger before retrying');
  let parsed: unknown;
  try {
    parsed = JSON.parse(owner.text) as unknown;
  } catch {
    throw new FcTasksRefusal('ledger lock ownership was damaged; reread the ledger before retrying');
  }
  if (!isObject(parsed) || parsed.pid !== process.pid || parsed.token !== lock.token) {
    throw new FcTasksRefusal('ledger lock ownership changed; reread the ledger before retrying');
  }
  if (!sameDirectory(lock.path, lock.identity)) {
    throw new FcTasksRefusal('ledger lock ownership changed; reread the ledger before retrying');
  }
  try {
    unlinkSync(lock.ownerPath);
    rmdirSync(lock.path);
  } catch (error) {
    throw new FcTasksRefusal(
      `ledger lock could not be released; publication outcome may be visible, reread the ledger before retrying: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function withLedgerLock<T>(storeRoot: string, session: string, action: () => T): T {
  const lock = acquireLedgerLock(storeRoot, session);
  try {
    return action();
  } finally {
    releaseLedgerLock(lock);
  }
}

export function createTaskEntry(options: LedgerWriteOptions): string {
  const limit = writableMaxEntries(options.maxEntries);
  if (options.clearFlowcrewTaskLink) {
    throw new FcTasksRefusal('create cannot clear a FlowCrew task link');
  }
  const entry = applyExplicitTaskLink(
    validateFcTaskEntry(options.entry, true),
    options.flowcrewTaskId,
    false,
  );
  verifyTaskLink(entry, options.taskRunResolver);
  const session = assertWritableSession(options.storeRoot, options.session, true);
  const sessionPath = session.path;
  return withLedgerLock(options.storeRoot, options.session, () => {
    const writable = readWritableLedger(options.storeRoot, options.session, limit);
    if (writable.entries.length >= limit) {
      throw new FcTasksRefusal(`ledger entry limit ${limit} has been reached`);
    }
    if (writable.entries.some(({ id }) => id === entry.id)) {
      throw new FcTasksRefusal(`duplicate id ${entry.id}`);
    }
    validateProposedLedger([...writable.entries, entry]);
    const serialized = serializeLedgerEntry(entry);
    if (writable.totalBytes + serialized.byteLength > MAX_LEDGER_TOTAL_BYTES) {
      throw new FcTasksRefusal(`ledger would exceed the ${MAX_LEDGER_TOTAL_BYTES}-byte total limit`);
    }

    const targetPath = join(sessionPath, `${entry.id}.json`);
    const temporaryPath = writeTemporaryEntry(sessionPath, session.identity, serialized.text);
    let published = false;
    try {
      if (!sameDirectory(sessionPath, session.identity)) {
        throw new FcTasksRefusal('session ledger changed before create publication');
      }
      const publish = options.publication?.create ?? ((temporary, target) => linkSync(temporary, target));
      publish(temporaryPath, targetPath);
      published = true;
      if (!sameDirectory(sessionPath, session.identity)) {
        throw new FcTasksRefusal('session ledger changed during create publication');
      }
      fsyncDirectory(sessionPath);
      if (!sameDirectory(sessionPath, session.identity)) {
        throw new FcTasksRefusal('session ledger changed during create persistence');
      }
      return targetPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new FcTasksRefusal(`duplicate target file for id ${entry.id}`);
      const ambiguity = published ? '; publication may be visible, reread the ledger before retrying' : '';
      throw new FcTasksRefusal(`atomic create refused${ambiguity}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try { unlinkSync(temporaryPath); } catch { /* published link or already absent */ }
    }
  });
}

export function updateTaskEntry(options: LedgerUpdateOptions): string {
  const limit = writableMaxEntries(options.maxEntries);
  if (!isSafePathSegment(options.id)) throw new FcTasksRefusal('update id must be a non-empty safe path segment');
  const completeEntry = isCompleteFcTaskEntry(options.entry)
    ? validateFcTaskEntry(options.entry, true)
    : undefined;
  const patch = completeEntry === undefined ? validateFcTaskPatch(options.entry) : undefined;
  if (completeEntry !== undefined && completeEntry.id !== options.id) {
    throw new FcTasksRefusal(`entry id ${completeEntry.id} does not match update id ${options.id}`);
  }

  const session = assertWritableSession(options.storeRoot, options.session, false);
  const sessionPath = session.path;
  return withLedgerLock(options.storeRoot, options.session, () => {
    const scanned = scanTaskLedger(options.storeRoot, options.session, limit);
    if (scanned.state === 'unavailable') {
      const issue = scanned.issues[0];
      throw new FcTasksRefusal(`existing ledger is invalid: ${issue.code}: ${issue.detail}`);
    }
    if (scanned.state === 'no_ledger') {
      throw new FcTasksRefusal(`update requires exactly one existing id ${options.id}`);
    }
    const matches = scanned.sources.filter(
      (source): source is ParsedTaskSource & { sourceRecord: Record<string, unknown> } => (
        'sourceRecord' in source
        && isObject(source.sourceRecord)
        && source.sourceRecord.id === options.id
      ),
    );
    if (matches.length > 1) {
      throw new FcTasksRefusal(
        `existing ledger is invalid: duplicate_id: id ${options.id} appears in ${matches.map(({ sourceName }) => sourceName).join(' and ')}`,
      );
    }
    if (matches.length === 0) {
      if (scanned.issues.length > 0) {
        const issue = scanned.issues[0];
        throw new FcTasksRefusal(`existing ledger is invalid: ${issue.code}: ${issue.detail}`);
      }
      throw new FcTasksRefusal(`update requires exactly one existing id ${options.id}`);
    }

    const target = matches[0];
    const sourceRecord = target.sourceRecord;
    let entry = completeEntry ?? validateFcTaskEntry({
      ...supportedTaskRecord(sourceRecord),
      ...patch,
    }, true);
    if (completeEntry === undefined && entry.id !== options.id) {
      throw new FcTasksRefusal(`entry id ${entry.id} does not match update id ${options.id}`);
    }
    entry = applyExplicitTaskLink(entry, options.flowcrewTaskId, Boolean(options.clearFlowcrewTaskLink));
    if (entry.flowcrewTaskId === undefined
        && !options.clearFlowcrewTaskLink
        && Number.isSafeInteger(sourceRecord.flowcrewTaskId)
        && (sourceRecord.flowcrewTaskId as number) > 0) {
      entry = { ...entry, flowcrewTaskId: sourceRecord.flowcrewTaskId as number };
    }
    verifyTaskLink(entry, options.taskRunResolver);

    let serializedEntry: unknown = entry;
    if (completeEntry === undefined) {
      const partialEntry: Record<string, unknown> = { ...sourceRecord, ...entry };
      if (entry.flowcrewTaskId === undefined) delete partialEntry[FC_TASK_LINK_FIELD];
      serializedEntry = partialEntry;
    }
    const proposed = validateLedgerSources(
      scanned.sources.map((source) => source === target ? { ...source, sourceRecord: serializedEntry } : source),
    );
    if (proposed.issues.length > 0) {
      const issue = proposed.issues[0];
      throw new FcTasksRefusal(`proposed update leaves ledger invalid: ${issue.code}: ${issue.detail}`);
    }
    const serialized = serializeLedgerEntry(serializedEntry);
    const proposedBytes = scanned.totalBytes - target.sourceBytes + serialized.byteLength;
    if (proposedBytes > MAX_LEDGER_TOTAL_BYTES) {
      throw new FcTasksRefusal(`ledger would exceed the ${MAX_LEDGER_TOTAL_BYTES}-byte total limit`);
    }

    const targetPath = target.sourcePath;
    const temporaryPath = writeTemporaryEntry(sessionPath, session.identity, serialized.text);
    let published = false;
    try {
      if (!sameDirectory(sessionPath, session.identity)) {
        throw new FcTasksRefusal('session ledger changed before update publication');
      }
      const publish = options.publication?.update ?? ((temporary, targetPathValue) => renameSync(temporary, targetPathValue));
      publish(temporaryPath, targetPath);
      published = true;
      if (!sameDirectory(sessionPath, session.identity)) {
        throw new FcTasksRefusal('session ledger changed during update publication');
      }
      fsyncDirectory(sessionPath);
      if (!sameDirectory(sessionPath, session.identity)) {
        throw new FcTasksRefusal('session ledger changed during update persistence');
      }
      return targetPath;
    } catch (error) {
      const ambiguity = published ? '; publication may be visible, reread the ledger before retrying' : '';
      throw new FcTasksRefusal(`atomic update refused${ambiguity}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (existsSync(temporaryPath)) {
        try { unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
      }
    }
  });
}

export function publicTaskEntries(result: LedgerReadResult): FcTaskEntry[] {
  if (result.state !== 'ready') return [];
  return result.entries.map(({
    sourceName: _sourceName,
    sourcePath: _sourcePath,
    sourceRecord: _sourceRecord,
    ...entry
  }) => entry);
}
