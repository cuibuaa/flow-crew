import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from './engine-fs.js';
import { join } from 'node:path';

type Operation = 'hook' | 'wake';
const causes = ['read', 'command', 'configuration', 'capability'] as const;
type Cause = typeof causes[number];
const incidentPath = (root: string, frontend: string, session: string, operation: Operation, cause: Cause) =>
  join(root, 'integration-errors', `${createHash('sha256').update(JSON.stringify([frontend, session, operation, cause])).digest('hex')}.json`);

export function hasSessionFailure(root: string, frontend: string, session: string, operation: Operation): boolean {
  return causes.some(cause => existsSync(incidentPath(root, frontend, session, operation, cause)));
}

/** Infrastructure diagnostics belong to the operator, never to a Stop reason.
 * An exclusive report receipt makes an ongoing outage visible only once. */
export function recordSessionFailure(root: string, frontend: string, session: string, operation: Operation, error: unknown, cause: Cause = 'read'): void {
  const path = incidentPath(root, frontend, session, operation, cause);
  mkdirSync(join(root, 'integration-errors'), { recursive: true });
  const message = `FlowCrew ${operation} unavailable for ${frontend} session ${session}: ${error instanceof Error ? error.message : String(error)}. Session state cannot be checked; inspect the push service.`;
  try { writeFileSync(path, JSON.stringify({ frontend, session, operation, cause, message, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600, flush: true }); }
  catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; }
}

export function sessionFailures(root: string, frontend: string, session: string, claim = false): string[] {
  return (['hook', 'wake'] as const).flatMap(operation => causes.flatMap(cause => {
    const path = incidentPath(root, frontend, session, operation, cause);
    try {
      const { message } = JSON.parse(readFileSync(path, 'utf8')) as { message: string };
      if (claim) writeFileSync(`${path}.shown`, '', { flag: 'wx', mode: 0o600 });
      return [message];
    } catch (error) {
      if (['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) return [];
      throw error;
    }
  }));
}

/** Only the component that verified this cause may retire its incident. A
 * healthy read says nothing about installed hooks or command availability. */
export function clearSessionFailure(root: string, frontend: string, session: string, operation: Operation, cause: Cause = 'read'): void {
  const path = incidentPath(root, frontend, session, operation, cause);
  if (existsSync(path)) {
    try {
      const incident: unknown = JSON.parse(readFileSync(path, 'utf8'));
      appendFileSync(join(root, '..', 'infrastructure-recoveries.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), component: 'session-read', frontend, session, operation, recovered: incident })}\n`, { mode: 0o600, flush: true });
    } catch { /* recovery must not depend on diagnostic storage */ }
  }
  for (const file of [path, `${path}.shown`]) {
    try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
