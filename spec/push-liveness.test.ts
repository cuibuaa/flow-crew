import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionPush } from '../src/session-push.js';
import { TaskRegistry } from '../src/task-registry.js';
import { sessionGate } from '../src/cli-session-push.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'push-liveness-')); roots.push(root);
  const registry = new TaskRegistry({ baseDir: root });
  const task = registry.create({ name: 'Decision graph', projectDir: root, status: 'parked', run_id: 'run',
    launcher: { frontend: 'claude', sessionId: 'session', ledgerRoot: join(root, 'ledger'), cwd: root, socket: join(root, 'socket') } });
  const run = join(root, 'runs/run'); mkdirSync(join(run, 'approvals'), { recursive: true });
  writeFileSync(join(run, 'run.json'), JSON.stringify({ runId: 'run', projectDir: root, status: 'parked', stages: {},
    parked: { requestId: 'replays' } }));
  writeFileSync(join(run, 'approvals/replays.request.json'), JSON.stringify({ title: 'Eight chooser replays', target: 'Configured provider' }));
  const claude = vi.fn().mockResolvedValue(undefined);
  const push = new SessionPush(registry, { claude });
  const event = push.enqueue(task, { type: 'approval_parked', timestamp: '2026-11-06T01:23:04.190Z', runId: 'run', requestId: 'replays' })!;
  return { root, run, push, event, claude };
}
function retain(name: string, f: ReturnType<typeof fixture>) {
  const result = { event: f.event,
    delivery: f.push.delivery(f.event.eventId), pending: f.push.pending(),
    businessAck: f.push.acknowledged(f.event.eventId), gate: sessionGate(f.push, 'claude', 'session'),
  };
  console.log(`PUSH_AUTH_RECORD ${JSON.stringify({ directory: 'liveness', files: { [`${name}.json`]: JSON.stringify(result, null, 2) } })}`);
}

describe('approval liveness is checked when delivered, not when emitted', () => {
  it.each(['approve', 'deny'] as const)('supersedes an event decided %s after creation, retires its ACK, and never claims or sends it', async decision => {
    const f = fixture();
    expect(f.push.pending()).toHaveLength(1);
    const at = '2026-11-06T03:14:53.337Z';
    writeFileSync(join(f.run, 'approvals/replays.decision.json'), JSON.stringify({ decision, at }));
    await f.push.deliver(f.event);
    expect(f.claude).not.toHaveBeenCalled();
    expect(f.push.pending()).toEqual([]);
    expect(f.push.claimWake(f.event)).toBe(false);
    expect(f.push.delivery(f.event.eventId).superseded).toMatchObject({ runId: 'run', requestId: 'replays', decision, at, ackRequired: false });
    expect(f.push.acknowledged(f.event.eventId)).toBe(false);
    expect(existsSync(join(f.root, 'session-push/acks', `${f.event.eventId}.json`))).toBe(false);
    expect(sessionGate(f.push, 'claude', 'session').reason).not.toContain('needs approval');
    const restarted = new SessionPush(f.push.registry, { claude: f.claude });
    expect(restarted.pending()).toEqual([]);
    expect(JSON.parse(readFileSync(join(f.root, 'session-push/delivery', `${f.event.eventId}.json`), 'utf8')).superseded.at).toBe(at);
    retain(`stale-${decision}`, f);
  });

  it('delivers the same sequence with no decision and keeps explicit ACK required', async () => {
    const f = fixture();
    await f.push.deliver(f.event);
    expect(f.claude).toHaveBeenCalledOnce();
    expect(f.claude.mock.calls[0][2]).toContain('Decision graph: needs approval. Request: Eight chooser replays. Target: Configured provider.');
    const gate = sessionGate(f.push, 'claude', 'session');
    expect(gate.systemMessage).toContain('flowcrew inbox approve');
    expect(gate.reason).toContain(`--event ${f.event.eventId}`);
    expect(f.push.pending()).toHaveLength(1);
    expect(f.push.delivery(f.event.eventId).superseded).toBeUndefined();
    expect(f.push.acknowledged(f.event.eventId)).toBe(false);
    retain('live', f);
  });

  it('checks again at wake claim after a pending list was read', async () => {
    const f = fixture(); await f.push.deliver(f.event);
    const pending = f.push.pending()[0];
    writeFileSync(join(f.run, 'approvals/replays.decision.json'), JSON.stringify({ decision: 'approve', at: '2026-11-06T03:14:53.337Z' }));
    expect(f.push.claimWake(pending)).toBe(false);
    expect(f.push.pending()).toEqual([]);
  });

  it('hydrates a pre-upgrade event by structured run-event identity, not its detail prose', () => {
    const f = fixture();
    writeFileSync(join(f.run, 'events.jsonl'), JSON.stringify({ type: 'approval_parked', runId: 'run', timestamp: f.event.occurredAt, requestId: 'replays' }) + '\n');
    const old = { ...f.event, requestId: undefined, requestTitle: undefined, requestTarget: undefined, detail: 'deliberately unrelated prose' };
    writeFileSync(join(f.root, 'session-push/events', `${old.eventId}.json`), JSON.stringify(old));
    expect(f.push.pending()[0]).toMatchObject({ requestId: 'replays', requestTitle: 'Eight chooser replays', requestTarget: 'Configured provider' });
  });
  it('never assigns an unidentifiable old approval to a newer parked request', () => {
    const f = fixture();
    const old = { ...f.event, requestId: undefined, requestTitle: undefined, requestTarget: undefined };
    writeFileSync(join(f.root, 'session-push/events', `${old.eventId}.json`), JSON.stringify(old));
    writeFileSync(join(f.run, 'run.json'), JSON.stringify({ runId: 'run', projectDir: f.root, status: 'parked', stages: {},
      parked: { requestId: 'newer', pausedAt: '2026-11-06T04:00:00Z', reason: 'Newer request' } }));
    expect(f.push.pending()[0].requestId).toBeUndefined();
    expect(f.push.pending()[0].requestTitle).toBeUndefined();
  });
});
