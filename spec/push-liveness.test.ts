import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionPush, renderPushEvent, type PushEvent } from '../src/session-push.js';
import { TaskRegistry } from '../src/task-registry.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-push-')); roots.push(root);
  const registry = new TaskRegistry({ baseDir: root });
  const task = registry.create({ name: 'Historical task', projectDir: root, status: 'parked', run_id: 'run',
    launcher: { frontend: 'claude', sessionId: 'session', ledgerRoot: join(root, 'ledger'), cwd: root } });
  const event: PushEvent = { version: 1, eventId: 'a'.repeat(64), taskId: task.id, taskTitle: task.name,
    runId: 'run', kind: 'approval_parked', createdAt: '2020-01-01T00:00:00Z', occurredAt: '2020-01-01T00:00:00Z', target: task.launcher!, requestId: 'historic' };
  const events = join(root, 'session-push/events'); mkdirSync(events, { recursive: true });
  writeFileSync(join(events, `${event.eventId}.json`), JSON.stringify(event));
  return { root, registry, event, push: new SessionPush(registry) };
}
describe('historical session-push records are read without live approval transport', () => {
  it('renders an old kind through the generic wrap-up and retains explicit acknowledgement', () => {
    const f = fixture();
    expect(f.push.pending()).toHaveLength(1);
    const rendered = renderPushEvent(f.push.pending()[0], f.root);
    expect(rendered.human).toContain('Historical task: run event.');
    expect(rendered.human).not.toContain('inbox approve');
    expect(rendered.agent).toContain('Read the report and run state');
    expect(f.push.acknowledged(f.event.eventId)).toBe(false);
    f.push.acknowledge(f.event.eventId, 'session');
    expect(f.push.pending()).toEqual([]);
  });
  it('honors a pre-existing delivery retirement without inventing a business acknowledgement', () => {
    const f = fixture(); const directory = join(f.root, 'session-push/delivery'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${f.event.eventId}.json`), JSON.stringify({ superseded: { at: '2020-01-01T00:01:00Z', ackRequired: false } }));
    expect(new SessionPush(f.registry).pending()).toEqual([]);
    expect(f.push.acknowledged(f.event.eventId)).toBe(false);
  });
});
