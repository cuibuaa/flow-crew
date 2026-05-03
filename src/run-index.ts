import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
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

function runsRoot(projectDir: string): string {
  return join(projectDir, '.fc', 'runs');
}

function dbPath(projectDir: string): string {
  return join(projectDir, '.fc', 'run-index.sqlite');
}

function listRunDirectories(projectDir: string): string[] {
  try {
    return readdirSync(runsRoot(projectDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function loadSqlite(): { DatabaseSync: new (path: string) => DatabaseSync } | null {
  try {
    return require('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
  } catch {
    return null;
  }
}

function openDb(projectDir: string): DatabaseSync | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  mkdirSync(join(projectDir, '.fc'), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath(projectDir));
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
  try {
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
  } finally {
    db.close();
  }
}

export function deleteRunIndex(projectDir: string, runId: string): void {
  const db = openDb(projectDir);
  if (!db) return;
  try {
    db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
  } finally {
    db.close();
  }
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
        } catch {
          // Ignore incomplete or corrupt run directories.
        }
      }
    } catch {
      // No runs directory yet.
    }
    db.exec('COMMIT');
    return count;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    db.close();
  }
}

function ensureIndexSeeded(projectDir: string): void {
  if (rebuildAttempted.has(projectDir)) return;
  const db = openDb(projectDir);
  if (!db) return;
  try {
    const runDirs = listRunDirectories(projectDir);
    const row = db.prepare('SELECT COUNT(*) AS count FROM runs').get();
    const latest = db.prepare('SELECT run_id FROM runs ORDER BY run_id DESC LIMIT 1').get();
    const indexedCount = Number(row?.count ?? 0);
    const latestIndexedRunId = typeof latest?.run_id === 'string' ? latest.run_id : undefined;
    const latestRunDir = runDirs.at(-1);
    if (indexedCount !== runDirs.length || latestIndexedRunId !== latestRunDir) {
      rebuildAttempted.add(projectDir);
      db.close();
      rebuildRunIndex(projectDir);
      return;
    }
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
  rebuildAttempted.add(projectDir);
}

export function listRunIdsFromIndex(projectDir: string): string[] | null {
  ensureIndexSeeded(projectDir);
  const db = openDb(projectDir);
  if (!db) return null;
  try {
    return db.prepare('SELECT run_id FROM runs ORDER BY run_id ASC').all().map((row) => String(row.run_id));
  } finally {
    db.close();
  }
}

export function readRunIndexRecords(projectDir: string): RunIndexRecord[] | null {
  ensureIndexSeeded(projectDir);
  const db = openDb(projectDir);
  if (!db) return null;
  try {
    return db.prepare('SELECT * FROM runs ORDER BY run_id ASC').all().map(rowToRecord);
  } finally {
    db.close();
  }
}

export function readRunIndexRecordsByCampaign(projectDir: string, campaignStorageKey: string): RunIndexRecord[] | null {
  ensureIndexSeeded(projectDir);
  const db = openDb(projectDir);
  if (!db) return null;
  try {
    return db.prepare('SELECT * FROM runs WHERE campaign_storage_key = ? ORDER BY run_id ASC')
      .all(campaignStorageKey)
      .map(rowToRecord);
  } finally {
    db.close();
  }
}

export function removeRunIndexFiles(projectDir: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    const p = `${dbPath(projectDir)}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  rebuildAttempted.delete(projectDir);
}
