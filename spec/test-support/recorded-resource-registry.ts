import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { registerEngineOwnedSqlitePath } from '../../src/engine-owned-carriers.js';
import { readResourceLeaseRegistry } from '../../src/resource-leases.js';

/** Existing state and carrier consumers need recorded SQLite data, not a
 * production acquisition mechanism. All callers supply a private fixture path.
 */
export function recordedResourceRegistry(path: string, initialize = true) {
  registerEngineOwnedSqlitePath(path);
  if (initialize) initializeRecordedResourceRegistry(path);
  return { path, read: () => readResourceLeaseRegistry(path) };
}
export function initializeRecordedResourceRegistry(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('CREATE TABLE IF NOT EXISTS resource_registry (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
    db.prepare('INSERT OR IGNORE INTO resource_registry (id, data) VALUES (1, ?)').run(JSON.stringify({ version: 1, revision: 0, nextFence: 1, leases: [], history: [] }));
  } finally { db.close(); }
}
export function appendRecordedResourceLease(path: string, runId: string, stageId = 'writer', at = '2026-10-03T00:00:00.000Z') {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 2000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
    const snapshot = JSON.parse(String(db.prepare('SELECT data FROM resource_registry WHERE id = 1').get()?.data));
    const fence = snapshot.nextFence++, leaseId = `lease_${fence}`, requestId = `recorded_${fence}`;
    snapshot.leases.push({ leaseId, fence, requestId, requestDigest: createHash('sha256').update(requestId).digest('hex'), owner: { runId, stageId, attemptIndex: 1, attemptStartedAt: at, generation: 'recorded', pid: process.pid }, acquiredAt: at, status: 'active', gpuCards: [], disk: [] });
    snapshot.history.push({ revision: ++snapshot.revision, at, kind: 'acquired', leaseId, requestId, reason: 'recorded fixture' });
    db.prepare('UPDATE resource_registry SET data = ? WHERE id = 1').run(JSON.stringify(snapshot));
    db.exec('COMMIT');
  } finally { db.close(); }
}
