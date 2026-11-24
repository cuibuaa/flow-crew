import { existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { afterEach,vi } from 'vitest';
import { runHook } from '../../integrations/claude/flowcrew-session.mjs';
import { type RunStatus,type RunStatusFile } from '../../rewrite-src/contract/runtime.js';
import { wireStatus } from './rewrite-status.js';

const projectRoot = resolve(import.meta.dirname, '../..');
const source = join(projectRoot, 'dist-rewrite/flowcrew-session.mjs');
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const reasons = {
  pending: [null], running: [null], parked: ['backstop', 'attempt_failed', 'recovery_unknown'],
  complete: ['completed'], accepted_blocked: ['accepted_blocked'],
  incomplete: ['command_missing', 'command_nonzero', 'command_unfinished', 'outputs_unpreserved'],
  failed: ['gate_irreparable', 'attempt_failed', 'contract_refused', 'isolation_refused'],
  escalated: ['recovery_unknown'], cancelled: ['cancelled'],
} as const;
const terminal = ['complete', 'accepted_blocked', 'incomplete', 'failed', 'cancelled'];
function status(run = 'RunOne', state: RunStatus = 'running', requester = 'claude:session-one'): RunStatusFile {
  return wireStatus(run,state,requester);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rewrite-hooks-')); roots.push(root);
  const store = join(root, 'store'), secondStore = join(root, 'second-store'), tasksRoot = join(root, 'home/.claude/tasks');
  const config = { storeRoots: [store, secondStore], tasksRoot };
  function publish(value: RunStatusFile, atStore = store) {
    const directory = join(atStore, 'runs', value.run); mkdirSync(directory, { recursive: true });
    const path = join(directory, 'status.json');
    writeFileSync(`${path}.tmp`, JSON.stringify(value)); renameSync(`${path}.tmp`, path);
  }
  function entries(session = 'session-one'): Record<string, any>[] {
    const dir = join(tasksRoot, session);
    return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8'))) : [];
  }
  const invoke = (event = 'Stop', payload: unknown = { session_id: 'session-one' }) => runHook(payload, config, event);
  return { root, store, secondStore, tasksRoot, config, publish, entries, invoke };
}


export { fixture,projectRoot,reasons,source,status,terminal };
