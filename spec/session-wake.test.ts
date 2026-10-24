import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRegistry } from '../src/task-registry.js';
import { SessionPush, PUSH_FALLBACK_MS, PUSH_RETRY_MS, wrapUpPrompt } from '../src/session-push.js';
import { sessionGate } from '../src/cli-session-push.js';
import { hasClaudeWakeWaiter, supportsClaudeWakeVersion, waitForClaudeWake } from '../src/session-wake.js';
import { createTaskEntry } from '../src/fc-tasks.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fc-wake-'));
  roots.push(root);
  const registry = new TaskRegistry({ baseDir: join(root, 'fc') });
  const launcher = { frontend: 'claude' as const, sessionId: 'own-session', cwd: root, ledgerRoot: join(root, 'ledger'), socket: join(root, 'inbox.sock') };
  const task = registry.create({ projectDir: root, status: 'running', run_id: 'own-run', launcher });
  let time = Date.now();
  const claude = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const push = new SessionPush(registry, { claude, notify, now: () => time });
  const event = (kind: 'operator_wrap_up_required' | 'approval_parked' | 'attempt_failed' | 'run_status_changed' = 'operator_wrap_up_required') => push.enqueue(task, { type: kind, runId: 'own-run', timestamp: new Date(time).toISOString() })!;
  return { root, push, registry, launcher, task, claude, notify, event, now: () => time, advance: (ms: number) => { time += ms; } };
}

describe('Claude async Stop wake', () => {
  it.each(['2.1.308 (Claude Code)', '2.1.309', '2.2.0', '3.0.0'])('accepts the supported version floor (%s)', version => {
    expect(supportsClaudeWakeVersion(version)).toBe(true);
  });
  it.each(['2.1.287', '2.1.307', '1.9.999', '', 'unknown', '2.1.308-beta'])('keeps the foreground guarantee for unverified versions (%s)', version => {
    expect(supportsClaudeWakeVersion(version)).toBe(false);
  });

  it.each(['operator_wrap_up_required', 'approval_parked', 'attempt_failed', 'run_status_changed'] as const)('replaces foreground waiting with the fixed prompt for %s, and never infers ACK', async kind => {
    const f = fixture();
    expect(sessionGate(f.push, 'claude', f.launcher.sessionId).decision).toBe('block');
    let expected = '';
    const result = await waitForClaudeWake(f.push, f.launcher.sessionId, { sleep: async () => {
      expect(hasClaudeWakeWaiter(f.push.root, f.launcher.sessionId)).toBe(true);
      expect(f.push.deliveryReady(f.task)).toBe(true); // hook needs no inbox socket
      expect(sessionGate(f.push, 'claude', f.launcher.sessionId)).toEqual({});
      const event = f.event(kind);
      expected = wrapUpPrompt(event, f.registry.baseDir);
      await f.push.deliver(event);
      expect(f.claude).not.toHaveBeenCalled();
      expect(f.push.delivery(event.eventId)).toMatchObject({ attempts: 1, transport: 'wake' });
      expect(sessionGate(f.push, 'claude', f.launcher.sessionId).decision).toBe('block');
    } });
    expect(result).toEqual({ code: 2, prompt: expected });
    expect(f.push.pending()).toHaveLength(1);
    expect(hasClaudeWakeWaiter(f.push.root, f.launcher.sessionId)).toBe(false);
  });

  it('keeps unrelated sessions/frontends private and waits across terminal-before-event publication', async () => {
    const f = fixture();
    const other = f.registry.create({ projectDir: f.root, status: 'done', launcher: { ...f.launcher, sessionId: 'other-session' } });
    f.push.enqueue(other, { type: 'attempt_failed', runId: 'other-run', timestamp: new Date().toISOString() });
    const codex = f.registry.create({ projectDir: f.root, status: 'done', launcher: { ...f.launcher, frontend: 'codex' } });
    f.push.enqueue(codex, { type: 'attempt_failed', runId: 'codex-run', timestamp: new Date().toISOString() });
    let polls = 0;
    const result = await waitForClaudeWake(f.push, f.launcher.sessionId, { sleep: async () => {
      if (++polls === 1) f.registry.update(f.task.id, { status: 'done' });
      else if (polls === 2) await f.push.deliver(f.event());
      else throw new Error('did not wake');
    } });
    expect(polls).toBe(2);
    expect(result.prompt).toContain('run=own-run');
    expect(result.prompt).not.toContain('other-run');
  });

  it('elects one waiter across later Stops, and claims at most one wake per delivery attempt', async () => {
    const f = fixture();
    let eventId = '';
    const result = await waitForClaudeWake(f.push, f.launcher.sessionId, { sleep: async () => {
      expect(await waitForClaudeWake(f.push, f.launcher.sessionId)).toEqual({ code: 0 });
      const event = f.event(); eventId = event.eventId;
      await f.push.deliver(event);
    } });
    expect(result.code).toBe(2);
    const event = f.push.events().find(event => event.eventId === eventId)!;
    expect(f.push.claimWake(event)).toBe(false);
    const retry = await waitForClaudeWake(f.push, f.launcher.sessionId, { sleep: async () => {
      f.advance(30 * 60_000);
      await f.push.deliver(event);
    } });
    expect(retry.code).toBe(2);
    expect(f.claude).not.toHaveBeenCalled();
    expect(readdirSync(join(f.push.root, 'wake-claims'))).toHaveLength(2);
    f.push.acknowledge(eventId, f.launcher.sessionId);
    f.registry.update(f.task.id, { status: 'done' });
    createTaskEntry({ storeRoot: f.launcher.ledgerRoot, session: f.launcher.sessionId,
      taskRunResolver: { resolve: () => ({ state: 'resolved', taskId: f.task.id, taskStatus: 'done', projectDir: f.root }) },
      entry: { id: 'wrap', subject: 'wrap', description: '', activeForm: '', status: 'completed', blocks: [], blockedBy: [], flowcrewTaskId: f.task.id } });
    expect(await waitForClaudeWake(f.push, f.launcher.sessionId)).toEqual({ code: 0 });
    expect(f.push.claimWake(event)).toBe(false);
    expect(sessionGate(f.push, 'claude', f.launcher.sessionId)).toEqual({});
  });

  it('renews at its own deadline so a run longer than one waiter still wakes', async () => {
    const f = fixture();
    const expired = await waitForClaudeWake(f.push, f.launcher.sessionId, { now: f.now, lifetimeMs: 10, sleep: async ms => { f.advance(ms); } });
    expect(expired).toMatchObject({ code: 2, prompt: expect.stringContaining('renews wake coverage') });
    expect(hasClaudeWakeWaiter(f.push.root, f.launcher.sessionId)).toBe(false);
    expect(sessionGate(f.push, 'claude', f.launcher.sessionId).decision).toBe('block');
    const renewed = await waitForClaudeWake(f.push, f.launcher.sessionId, { now: f.now, sleep: async () => { await f.push.deliver(f.event()); } });
    expect(renewed).toMatchObject({ code: 2, prompt: expect.stringContaining('event=') });
  });

  it('never sends inbox frames during 30 minutes without a waiter after a claimed wake, then wakes again', async () => {
    const f = fixture();
    const event = f.event();
    expect((await waitForClaudeWake(f.push, f.launcher.sessionId, { now: f.now, sleep: async () => {
      await f.push.deliver(event);
    } })).code).toBe(2);
    expect(f.push.claimWake(event)).toBe(false); // already claimed, still pending
    expect(hasClaudeWakeWaiter(f.push.root, f.launcher.sessionId, f.now())).toBe(false);
    const later = f.event('attempt_failed'); // capability belongs to the session, not one event
    for (let elapsed = 0; elapsed < 30 * 60_000; elapsed += PUSH_RETRY_MS) {
      f.advance(PUSH_RETRY_MS);
      const restarted = new SessionPush(f.registry, { now: f.now, claude: f.claude, notify: f.notify });
      restarted.refreshSession('claude', f.launcher.sessionId, join(f.root, 'reopened.sock'));
      await restarted.deliver(event);
      await restarted.deliver(later);
      expect(f.claude).not.toHaveBeenCalled();
      expect(restarted.pending()).toHaveLength(2);
    }
    expect(f.push.delivery(event.eventId)).toMatchObject({ attempts: 1, transport: 'wake' });
    expect(f.push.delivery(later.eventId).attempts).toBe(0);
    expect(f.notify).toHaveBeenCalledTimes(2); // fallback still runs while waiting
    expect((await waitForClaudeWake(f.push, f.launcher.sessionId, { now: f.now, sleep: async () => {
      await f.push.deliver(event);
    } })).code).toBe(2);
    expect(f.push.delivery(event.eventId)).toMatchObject({ attempts: 2, transport: 'wake' });
    expect((await waitForClaudeWake(f.push, f.launcher.sessionId, { now: f.now, sleep: async () => {
      await f.push.deliver(later);
    } })).code).toBe(2);
    expect(f.push.delivery(later.eventId)).toMatchObject({ attempts: 1, transport: 'wake' });
    expect(f.claude).not.toHaveBeenCalled();
    expect(f.push.pending()).toHaveLength(2);
  });

  it('delivers a claimed pending event through the next waiter before the reminder deadline', async () => {
    const f = fixture();
    const event = f.event();
    for (let turn = 0; turn < 2; turn++) {
      expect((await waitForClaudeWake(f.push, f.launcher.sessionId, { now: f.now, sleep: async () => {
        await f.push.deliver(event);
      } })).code).toBe(2);
      f.advance(6 * 60_000);
    }
    expect(f.push.delivery(event.eventId)).toMatchObject({ attempts: 2, transport: 'wake' });
    expect(f.claude).not.toHaveBeenCalled();
    expect(f.push.pending()).toHaveLength(1);
  });

  it('recovers session capability from pre-upgrade claims even after an inbox fallback', async () => {
    const f = fixture();
    const event = f.event();
    await waitForClaudeWake(f.push, f.launcher.sessionId, { now: f.now, sleep: async () => {
      await f.push.deliver(event);
    } });
    rmSync(join(f.push.root, 'sessions'), { recursive: true });
    writeFileSync(join(f.push.root, 'delivery', `${event.eventId}.json`), JSON.stringify({
      ...f.push.delivery(event.eventId), transport: 'inbox', nextAttemptAt: 0,
    }));
    const restarted = new SessionPush(f.registry, { now: f.now, claude: f.claude, notify: f.notify });
    await restarted.deliver(f.event('approval_parked')); // a different event encounters the old claim first
    await restarted.deliver(event);
    expect(f.claude).not.toHaveBeenCalled();
    expect(restarted.pending()).toHaveLength(2);
    expect(readdirSync(join(f.push.root, 'sessions'))).toHaveLength(1);
  });

  it.each([true, false])('switches inbox-first delivery to wake immediately after acceptance=%s, keeping fallback and ACK', async accepted => {
    const f = fixture();
    if (!accepted) f.claude.mockRejectedValueOnce(new Error('socket closed'));
    const event = f.event();
    await f.push.deliver(event);
    expect(f.claude).toHaveBeenCalledTimes(1);
    const result = await waitForClaudeWake(f.push, f.launcher.sessionId, { now: f.now, sleep: async () => {
      expect(f.push.claimWake(event)).toBe(false); // the inbox attempt cannot wake
      await f.push.deliver(event); // no time advance: both reminder and failure backoff are bypassed
      expect(f.push.delivery(event.eventId)).toMatchObject({ attempts: 2, transport: 'wake' });
    } });
    expect(result.code).toBe(2);
    f.advance(PUSH_FALLBACK_MS);
    await f.push.deliver(event);
    expect(f.claude).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.push.pending()).toHaveLength(1);
    f.push.acknowledge(event.eventId, f.launcher.sessionId);
    f.advance(30 * 60_000);
    await f.push.deliver(event);
    expect(f.claude).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.push.pending()).toEqual([]);
  });

  it.each(['pid', 'start', 'host', 'hostStart', 'bootId', 'missing bootId', 'expired'])('rejects stale waiter %s and waits without sending inbox', async stale => {
    const f = fixture();
    const result = await waitForClaudeWake(f.push, f.launcher.sessionId, { now: f.now, sleep: async () => {
      const path = join(f.push.root, 'waiters', readdirSync(join(f.push.root, 'waiters'))[0]);
      const original = readFileSync(path, 'utf8');
      const waiter = JSON.parse(original);
      if (stale === 'pid' || stale === 'host') waiter[stale] = 2_147_483_647;
      else if (stale === 'start' || stale === 'hostStart') waiter[stale].value = 'reused';
      else if (stale === 'bootId') waiter.bootId = 'previous-boot';
      else if (stale === 'missing bootId') delete waiter.bootId;
      else waiter.expiresAt = 0;
      writeFileSync(path, JSON.stringify(waiter));
      // POSIX calendar start tokens do not use Linux boot identity.
      const invalid = process.platform === 'linux' || !['bootId', 'missing bootId'].includes(stale);
      expect(hasClaudeWakeWaiter(f.push.root, f.launcher.sessionId, f.now())).toBe(!invalid);
      const event = f.event();
      if (invalid) {
        await f.push.deliver(event);
        expect(f.push.delivery(event.eventId).attempts).toBe(0);
        expect(f.claude).not.toHaveBeenCalled();
      }
      writeFileSync(path, original);
      await f.push.deliver(event);
    } });
    expect(result.code).toBe(2);
    expect(f.claude).not.toHaveBeenCalled();
  });

  it('fails closed on unreadable ledger/outbox and never accepts stale or reused waiter identities', async () => {
    const f = fixture();
    await expect(waitForClaudeWake(f.push, f.launcher.sessionId, { sleep: async () => {
      mkdirSync(join(f.launcher.ledgerRoot, f.launcher.sessionId), { recursive: true });
      writeFileSync(join(f.launcher.ledgerRoot, f.launcher.sessionId, 'bad.json'), '{bad');
      expect(sessionGate(f.push, 'claude', f.launcher.sessionId).decision).toBe('block');
      const path = join(f.push.root, 'waiters', readdirSync(join(f.push.root, 'waiters'))[0]);
      const waiter = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ ...waiter, start: { ...waiter.start, value: 'reused' } }));
      expect(hasClaudeWakeWaiter(f.push.root, f.launcher.sessionId)).toBe(false);
      writeFileSync(path, JSON.stringify({ ...waiter, expiresAt: 0 }));
      expect(hasClaudeWakeWaiter(f.push.root, f.launcher.sessionId)).toBe(false);
      mkdirSync(join(f.push.root, 'events'), { recursive: true });
      writeFileSync(join(f.push.root, 'events', `${'a'.repeat(64)}.json`), '{bad');
    } })).rejects.toThrow();
    expect(() => sessionGate(f.push, 'claude', f.launcher.sessionId)).toThrow();
    expect(readdirSync(join(f.push.root, 'waiters'))).toEqual([]);
  });

  it('atomically arbitrates real concurrent processes for the same event/attempt', async () => {
    const f = fixture();
    let eventId = '';
    const result = await waitForClaudeWake(f.push, f.launcher.sessionId, { sleep: async () => {
      const event = f.event(); eventId = event.eventId;
      await f.push.deliver(event);
      const script = join(f.root, 'claim.mjs');
      writeFileSync(script, [
        `import { SessionPush } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'dist', 'session-push.js')).href)};`,
        `import { TaskRegistry } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'dist', 'task-registry.js')).href)};`,
        'const push = new SessionPush(new TaskRegistry({ baseDir: process.env.FC_HOME }));',
        'console.log(push.claimWake(push.events()[0]));',
      ].join('\n'));
      const outcomes = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
          cwd: f.root, env: { ...process.env, HOME: f.root, FC_HOME: f.registry.baseDir }, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = ''; let error = '';
        child.stdout.on('data', data => { output += data; });
        child.stderr.on('data', data => { error += data; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error || `exit ${code}`)));
      })));
      expect(outcomes.filter(value => value === 'true')).toHaveLength(1);
      expect(outcomes.filter(value => value === 'false')).toHaveLength(5);
      f.push.acknowledge(eventId, f.launcher.sessionId);
      f.registry.update(f.task.id, { status: 'done' });
      createTaskEntry({ storeRoot: f.launcher.ledgerRoot, session: f.launcher.sessionId,
        taskRunResolver: { resolve: () => ({ state: 'resolved', taskId: f.task.id, taskStatus: 'done', projectDir: f.root }) },
        entry: { id: 'wrap', subject: 'wrap', description: '', activeForm: '', status: 'completed', blocks: [], blockedBy: [], flowcrewTaskId: f.task.id } });
    } });
    expect(result).toEqual({ code: 0 });
    expect(f.push.claimWake(f.push.events()[0])).toBe(false);
  });
});
