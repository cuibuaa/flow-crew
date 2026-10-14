import { mkdirSync, renameSync, rmSync, writeFileSync } from './engine-fs.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from './adapters/base.js';

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADAPTER_NAMESPACE = /^[a-z][a-z0-9_-]*$/i;

export interface SessionMetadata {
  version: 1;
  sessionId: string;
  ownerStageId: string;
  capturedAt: string;
  resumedFromStageId?: string;
  /** Records written before adapter-neutral sessions belong to Codex. */
  adapter?: string;
}

export function isSessionUuid(value: unknown): value is string {
  return typeof value === 'string' && SESSION_UUID.test(value);
}

function sessionPath(runDir: string, stageId: string): string {
  return join(runDir, 'stages', stageId, 'session.json');
}

export function readSession(runDir: string, stageId: string, adapter?: string): SessionMetadata | undefined {
  try {
    const parsed = JSON.parse(readFileSync(sessionPath(runDir, stageId), 'utf-8')) as Partial<SessionMetadata>;
    if (parsed.version !== 1 || !isSessionUuid(parsed.sessionId) || typeof parsed.ownerStageId !== 'string' || !parsed.ownerStageId) return undefined;
    if (parsed.adapter !== undefined && (typeof parsed.adapter !== 'string' || !ADAPTER_NAMESPACE.test(parsed.adapter))) return undefined;
    if (adapter !== undefined && !ADAPTER_NAMESPACE.test(adapter)) return undefined;
    if (adapter !== undefined && (parsed.adapter ?? 'codex') !== adapter) return undefined;
    return parsed as SessionMetadata;
  } catch {
    return undefined;
  }
}

export function writeSession(runDir: string, stageId: string, metadata: SessionMetadata): void {
  const dir = join(runDir, 'stages', stageId);
  mkdirSync(dir, { recursive: true });
  const target = sessionPath(runDir, stageId);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
    renameSync(tmp, target);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

/** A native identity is evidence even on failure, but a different identity
 * cannot establish continuation of the requested conversation. */
export function settleSession(
  runDir: string, stageId: string, result: Pick<RunResult, 'exitCode' | 'sessionId' | 'friendlyError'>,
  nativeId: unknown, resumeId?: string, resumedFromStageId?: string,
  options: { adapter?: string; mismatchMessage?: string } = {},
): void {
  const nativeSessionId = isSessionUuid(nativeId) ? nativeId : undefined;
  if (resumeId && nativeSessionId && nativeSessionId !== resumeId) {
    if (![124, 125, 137].includes(result.exitCode)) result.exitCode = 1;
    result.friendlyError = options.mismatchMessage ?? 'Resume returned a different session UUID; continuation was not verified';
    delete result.sessionId;
    return;
  }
  const sessionId = nativeSessionId ?? (isSessionUuid(resumeId) ? resumeId : undefined);
  if (!sessionId) return;
  result.sessionId = sessionId;
  writeSession(runDir, stageId, {
    version: 1, sessionId, ownerStageId: stageId, capturedAt: new Date().toISOString(),
    resumedFromStageId: resumeId ? resumedFromStageId : undefined,
    adapter: options.adapter,
  });
}

export function stageSessionHome(runDir: string, stageId: string, adapter = 'codex'): string {
  if (!ADAPTER_NAMESPACE.test(adapter)) throw new Error('Session home requires an adapter namespace');
  return join(runDir, 'stages', stageId, `${adapter}_home`);
}

export function isSessionHomeName(name: string): boolean {
  return /_home$/i.test(name) && ADAPTER_NAMESPACE.test(name.slice(0, -5));
}

/** A stage can change adapters between attempts. Retire every native home at
 * the lifecycle boundary, independently of its latest session metadata. */
export function finalizeStageSessions(runDir: string, stageId: string): void {
  const stageDir = join(runDir, 'stages', stageId);
  try {
    for (const name of readdirSync(stageDir)) {
      if (isSessionHomeName(name)) finalizeSessionHome(join(stageDir, name), 0);
    }
  } catch { /* best-effort */ }
}

/** Native homes are transient on success unless retained for an admitted
 * continuation. Failure homes remain credential-free for diagnosis; completed
 * SQLite write-ahead logs can be discarded after the owned process exits. */
export function finalizeSessionHome(home: string, exitCode: number, preserve = false): void {
  if (exitCode === 0) {
    if (!preserve) {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    return;
  }
  try {
    for (const name of readdirSync(home)) {
      if (name.endsWith('.sqlite-wal') || name.endsWith('.sqlite-shm')) {
        try { rmSync(join(home, name), { force: true }); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }
}
