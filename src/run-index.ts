import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { StoreState } from './store.js';

const require = createRequire(import.meta.url);

type DatabaseSync = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Record<string, unknown>[];
    run(...values: unknown[]): unknown;
  };
  close(): void;
};

export interface RunIndexRecord {
  runId: string;
  status?: string;
  workflowName?: string;
  taskDescription?: string;
  startedAt?: string;
  completedAt?: string;
  campaignId?: string;
  campaignStorageKey?: string;
  campaignName?: string;
  campaignSeq?: number;
  campaignIteration?: number;
  jsonMtime?: number;
}

const rebuildAttempted = new Set<string>();
// Persistent per-DB connection cache. Opening a fresh node:sqlite handle (plus
// re-running the CREATE TABLE/INDEX DDL) on every query was a major source of
// per-request overhead; the index is read/written hundreds of times per
// dashboard refresh. We keep one handle per db path for the process lifetime.
const dbHandles = new Map<string, DatabaseSync>();
// Memoize the seed-freshness check so readers don't re-run it on every call.
const seedCheckedAt = new Map<string, number>();
const SEED_CHECK_TTL_MS = 5_000;

function runsRoot(_projectDir: string): string {
  return join(homedir(), '.fc', 'runs');
}

function dbPath(_projectDir: string): string {
  const { homedir } = require('node:os') as typeof import('node:os');
  return join(homedir(), '.fc', 'run-index.sqlite');
}

function loadSqlite(): { DatabaseSync: new (path: string) => DatabaseSync } | null {
  try {
    return require('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
  } catch { /* non-critical */
    return null;
  }
}

function openDb(projectDir: string): DatabaseSync | null {
  const path = dbPath(projectDir);
  const cached = dbHandles.get(path);
  if (cached) return cached;
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  const { homedir } = require('node:os') as typeof import('node:os');
  mkdirSync(join(homedir(), '.fc'), { recursive: true });
  const db = new sqlite.DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      status TEXT,
      workflow_name TEXT,
      task_description TEXT,
      started_at TEXT,
      completed_at TEXT,
      campaign_id TEXT,
      campaign_storage_key TEXT,
      campaign_name TEXT,
      campaign_seq INTEGER,
      campaign_iteration INTEGER,
      json_mtime REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_runs_campaign ON runs(campaign_storage_key, campaign_seq);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  `);
  dbHandles.set(path, db);
  return db;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function canonicalStorageKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/^new:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || undefined;
}

function campaignStorageKeyForState(state: StoreState): string | undefined {
  return state.campaignStorageKey
    ?? canonicalStorageKey(state.campaignId)
    ?? canonicalStorageKey(state.campaignName);
}

function rowToRecord(row: Record<string, unknown>): RunIndexRecord {
  return {
    runId: String(row.run_id),
    status: asString(row.status),
    workflowName: asString(row.workflow_name),
    taskDescription: asString(row.task_description),
    startedAt: asString(row.started_at),
    completedAt: asString(row.completed_at),
    campaignId: asString(row.campaign_id),
    campaignStorageKey: asString(row.campaign_storage_key),
    campaignName: asString(row.campaign_name),
    campaignSeq: asNumber(row.campaign_seq),
    campaignIteration: asNumber(row.campaign_iteration),
    jsonMtime: asNumber(row.json_mtime),
  };
}

export function recordToPartialState(record: RunIndexRecord): StoreState {
  return {
    runId: record.runId,
    workflowName: record.workflowName ?? '',
    projectDir: '',
    status: (record.status as StoreState['status']) ?? 'pending',
    stages: {},
    startedAt: record.startedAt ?? '',
    completedAt: record.completedAt,
    taskDescription: record.taskDescription,
    campaignId: record.campaignId,
    campaignStorageKey: record.campaignStorageKey,
    campaignName: record.campaignName,
    campaignSeq: record.campaignSeq,
    campaignIteration: record.campaignIteration,
  };
}

export function upsertRunIndex(projectDir: string, state: StoreState): void {
  const db = openDb(projectDir);
  if (!db) return;
  {
    const runJson = join(runsRoot(projectDir), state.runId, 'run.json');
    const jsonMtime = existsSync(runJson) ? statSync(runJson).mtimeMs : Date.now();
    const campaignStorageKey = campaignStorageKeyForState(state);
    db.prepare(`
      INSERT INTO runs (
        run_id, status, workflow_name, task_description, started_at, completed_at,
        campaign_id, campaign_storage_key, campaign_name, campaign_seq, campaign_iteration,
        json_mtime, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status=excluded.status,
        workflow_name=excluded.workflow_name,
        task_description=excluded.task_description,
        started_at=excluded.started_at,
        completed_at=excluded.completed_at,
        campaign_id=excluded.campaign_id,
        campaign_storage_key=excluded.campaign_storage_key,
        campaign_name=excluded.campaign_name,
        campaign_seq=excluded.campaign_seq,
        campaign_iteration=excluded.campaign_iteration,
        json_mtime=excluded.json_mtime,
        updated_at=excluded.updated_at
    `).run(
      state.runId,
      state.status,
      state.workflowName,
      state.taskDescription ?? null,
      state.startedAt,
      state.completedAt ?? null,
      state.campaignId ?? null,
      campaignStorageKey ?? null,
      state.campaignName ?? null,
      state.campaignSeq ?? null,
      state.campaignIteration ?? null,
      jsonMtime,
      Date.now(),
    );
  }
}

export function deleteRunIndex(projectDir: string, runId: string): void {
  const db = openDb(projectDir);
  if (!db) return;
  db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
}

export function rebuildRunIndex(projectDir: string): number {
  const db = openDb(projectDir);
  if (!db) return 0;
  let count = 0;
  try {
    db.exec('BEGIN');
    db.exec('DELETE FROM runs');
    try {
      for (const runId of readdirSync(runsRoot(projectDir))) {
        try {
          const raw = readFileSync(join(runsRoot(projectDir), runId, 'run.json'), 'utf-8');
          const state = JSON.parse(raw) as StoreState;
          const jsonMtime = statSync(join(runsRoot(projectDir), runId, 'run.json')).mtimeMs;
          const campaignStorageKey = campaignStorageKeyForState(state);
          db.prepare(`
            INSERT OR REPLACE INTO runs (
              run_id, status, workflow_name, task_description, started_at, completed_at,
              campaign_id, campaign_storage_key, campaign_name, campaign_seq, campaign_iteration,
              json_mtime, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            state.runId || runId,
            state.status,
            state.workflowName,
            state.taskDescription ?? null,
            state.startedAt,
            state.completedAt ?? null,
            state.campaignId ?? null,
            campaignStorageKey ?? null,
            state.campaignName ?? null,
            state.campaignSeq ?? null,
            state.campaignIteration ?? null,
            jsonMtime,
            Date.now(),
          );
          count++;
        } catch { /* non-critical */
          // Ignore incomplete or corrupt run directories.
        }
      }
    } catch { /* non-critical */
      // No runs directory yet.
    }
    db.exec('COMMIT');
    return count;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

function ensureIndexSeeded(projectDir: string): void {
  const last = seedCheckedAt.get(projectDir);
  if (last !== undefined && Date.now() - last < SEED_CHECK_TTL_MS) return;
  const db = openDb(projectDir);
  if (!db) return;
  // Every createRun/writeRunState upserts into the index, so the index can only
  // be *missing* rows when it has never been seeded (fresh sqlite, or legacy runs
  // predating the index). A one-time full rebuild on an empty index covers that;
  // we no longer readdir all ~9900 run dirs on every check.
  const row = db.prepare('SELECT COUNT(*) AS count FROM runs').get();
  const indexedCount = Number(row?.count ?? 0);
  if (indexedCount === 0 && !rebuildAttempted.has(projectDir)) {
    rebuildAttempted.add(projectDir);
    rebuildRunIndex(projectDir);
  }
  seedCheckedAt.set(projectDir, Date.now());
}

export function listRunIdsFromIndex(projectDir: string): string[] | null {
  ensureIndexSeeded(projectDir);
  const db = openDb(projectDir);
  if (!db) return null;
  return db.prepare('SELECT run_id FROM runs ORDER BY run_id ASC').all().map((row) => String(row.run_id));
}

/** Run ids with no campaign attached (standalone runs), newest first. */
export function listStandaloneRunIdsFromIndex(projectDir: string, limit: number): string[] | null {
  ensureIndexSeeded(projectDir);
  const db = openDb(projectDir);
  if (!db) return null;
  return db
    .prepare('SELECT run_id FROM runs WHERE campaign_storage_key IS NULL ORDER BY run_id DESC LIMIT ?')
    .all(limit)
    .map((row) => String(row.run_id));
}

export function readRunIndexRecords(projectDir: string): RunIndexRecord[] | null {
  ensureIndexSeeded(projectDir);
  const db = openDb(projectDir);
  if (!db) return null;
  return db.prepare('SELECT * FROM runs ORDER BY run_id ASC').all().map(rowToRecord);
}

export function readRunIndexRecordsByCampaign(projectDir: string, campaignStorageKey: string): RunIndexRecord[] | null {
  ensureIndexSeeded(projectDir);
  const db = openDb(projectDir);
  if (!db) return null;
  return db.prepare('SELECT * FROM runs WHERE campaign_storage_key = ? ORDER BY run_id ASC')
    .all(campaignStorageKey)
    .map(rowToRecord);
}

export function removeRunIndexFiles(projectDir: string): void {
  // Drop the cached handle first so deleting the files doesn't race an open connection.
  const path = dbPath(projectDir);
  const handle = dbHandles.get(path);
  if (handle) {
    try { handle.close(); } catch { /* already closed */ }
    dbHandles.delete(path);
  }
  for (const suffix of ['', '-shm', '-wal']) {
    const p = `${path}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  rebuildAttempted.delete(projectDir);
  seedCheckedAt.delete(projectDir);
}
