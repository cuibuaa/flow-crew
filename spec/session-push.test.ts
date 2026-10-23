import './test-support/policy-runtime.js';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskEntry, updateTaskEntry } from '../src/fc-tasks.js';
import { sessionGate, renderSessionProgress } from '../src/cli-session-push.js';
import { SessionPush, captureLauncher, estimateProgress, progressLine, PUSH_FALLBACK_MS, PUSH_RETRY_MS, wrapUpPrompt, type LaunchTarget } from '../src/session-push.js';
import { codexRequest, queueCodex, sendClaude } from '../src/session-push-transport.js';
import { TaskRegistry, hasLiveForegroundOwner } from '../src/task-registry.js';
import { processStartToken } from '../src/run-lock.js';
import { Orchestrator } from '../src/orchestrator.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function fixture(frontend: LaunchTarget['frontend'] = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'fc-push-'));
  roots.push(root);
  const registry = new TaskRegistry({ baseDir: root });
  const launcher: LaunchTarget = { frontend, sessionId: 'own-session', socket: join(root, 'frontend.sock'), ledgerRoot: join(root, 'ledger'), cwd: root };
  const task = registry.create({ projectDir: root, name: 'Tiny task', launcher, run_id: 'own-run', status: 'running' });
  return { root, registry, launcher, task };
}
function runFile(root: string, status = 'running', stages: Record<string, unknown> = { build: { status: 'running', startedAt: '2020-01-01T00:00:00Z' } }) {
  mkdirSync(join(root, 'runs', 'own-run'), { recursive: true });
  writeFileSync(join(root, 'runs', 'own-run', 'run.json'), JSON.stringify({ runId: 'own-run', projectDir: root, status, workflowName: 'tiny', startedAt: '2020-01-01T00:00:00Z', stages }));
}
const source = { type: 'attempt_failed' as const, runId: 'own-run', timestamp: '2020-01-01T00:00:00Z', attemptIndex: 1, detail: 'attempt failed' };

describe('session task selection', () => {
  it('gate and progress resolve only indexed tasks with get instead of listing the registry', () => {
    const { registry, launcher, task } = fixture('claude');
    registry.create({ projectDir: registry.baseDir, launcher: { ...launcher, sessionId: 'other-session' } });
    registry.create({ projectDir: registry.baseDir, launcher: { ...launcher, frontend: 'codex' } });
    const list = vi.spyOn(registry, 'list').mockImplementation(() => { throw new Error('global list'); });
    const get = vi.spyOn(registry, 'get');
    const push = new SessionPush(registry);
    expect(push.sessionTasks('claude', launcher.sessionId).map(row => row.id)).toEqual([task.id]);
    expect(sessionGate(push, 'claude', launcher.sessionId).decision).toBe('block');
    expect(renderSessionProgress(push, launcher.sessionId).text).toContain(`#${task.id}`);
    expect(get.mock.calls.every(([id]) => id === task.id)).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });

  it('an unindexed session does not parse the registry', () => {
    const { registry } = fixture('claude');
    vi.spyOn(registry, 'get').mockImplementation(() => { throw new Error('global registry parse'); });
    vi.spyOn(registry, 'list').mockImplementation(() => { throw new Error('global list'); });
    const push = new SessionPush(registry);
    expect(sessionGate(push, 'claude', 'unrelated-session')).toEqual({});
    expect(renderSessionProgress(push, 'unrelated-session')).toEqual({ text: '', covered: false });
  });
});

describe('separate launch and stage attempt counters', () => {
  it('starts both wake-up coordinates at one and keeps them independent', () => {
    const { registry, task } = fixture();
    const push = new SessionPush(registry);
    const event = push.enqueue(task, { ...source, stageId: 'work' })!;
    expect(event).toMatchObject({ launch: 1, attemptIndex: 1 });
    expect(wrapUpPrompt(event, registry.baseDir)).toContain('launch=1 attemptIndex=1');
    const later = push.enqueue({ ...task, launch: 3 }, { ...source, stageId: 'work', attemptIndex: 2 })!;
    expect(later).toMatchObject({ launch: 3, attemptIndex: 2 });
  });
  it('reads old immutable wake events without mixing their coordinate types', () => {
    const { root, registry, task } = fixture();
    const push = new SessionPush(registry);
    const event = push.enqueue(task, { ...source, stageId: 'work' })!;
    const { launch: _launch, attemptIndex: _attempt, ...legacy } = event;
    const path = join(root, 'session-push', 'events', `${event.eventId}.json`);
    writeFileSync(path, JSON.stringify({ ...legacy, attempt: 1 }));
    expect(push.events()[0]).toMatchObject({ attemptIndex: 1 });
    writeFileSync(path, JSON.stringify({ ...legacy, stageId: undefined, attempt: 0 }));
    expect(push.events()[0]).toMatchObject({ launch: 1 });
    writeFileSync(path, JSON.stringify({ ...legacy, stageId: undefined, attempt: 1 }));
    expect(push.events()[0].launch).toBeUndefined(); // Old run events mixed zero- and one-based counters.

  });
});

describe('launch identity', () => {
  it('one live foreground owner keeps daemon execution and push out; identity change hands durable work back to the daemon', async () => {
    const { root, registry, task } = fixture();
    runFile(root);
    const owned = registry.update(task.id, { foregroundOwner: { pid: process.pid, processStart: processStartToken(process.pid) } });
    expect(hasLiveForegroundOwner(owned)).toBe(true);
    const rpc = vi.fn().mockResolvedValue({ thread: { id: 'own-display', parentThreadId: null } });
    const queue = vi.fn().mockResolvedValue('queued');
    const push = new SessionPush(registry, { rpc, queue });
    const previousHome = fcGlobalDir();
    setFcGlobalDir(root);
    const systemd = { isActive: vi.fn().mockResolvedValue({ kind: 'absent' }), runUnit: vi.fn() } as any;
    const daemon = new Orchestrator({ registry, systemd, sessionPush: { rpc, queue } });
    try {
      // Even without any service-manager unit, a live local CLI is not relaunched.
      await daemon.tickOnce();
      expect(registry.get(task.id)?.status).toBe('running');
      expect(systemd.isActive).not.toHaveBeenCalled();
      expect(systemd.runUnit).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      await push.sweep(task.id);
      expect(rpc.mock.calls.filter(call => call[2] === 'thread/start')).toHaveLength(1);
      runFile(root, 'complete', {});
      await push.sweep(task.id);
      const ids = push.events().map(event => event.eventId);
      expect(ids).toHaveLength(1);
      expect(queue).toHaveBeenCalledTimes(1);
      const currentStart = processStartToken(process.pid);
      const reused = registry.update(task.id, { foregroundOwner: { pid: process.pid, processStart: currentStart && {
        kind: currentStart.kind, value: `${currentStart.value}9`,
      } } });
      if (currentStart) expect(hasLiveForegroundOwner(reused)).toBe(false);
      // Explicitly model an exited owner for platforms without start tokens.
      registry.update(task.id, { foregroundOwner: { pid: 0 } });
      await daemon.tickOnce();
      expect(registry.get(task.id)?.status).toBe('done');
      expect(push.events().map(event => event.eventId)).toEqual(ids);
      expect(rpc.mock.calls.filter(call => call[2] === 'thread/start')).toHaveLength(1);
      expect(push.pending()).toHaveLength(1);
    } finally { await daemon.stop(); setFcGlobalDir(previousHome); }
  });

  it('captures an explicit frontend address rather than a daemon guess', () => {
    expect(captureLauncher({}, '/workspace')).toBeUndefined();
    expect(captureLauncher({ CLAUDE_CODE_SESSION_ID: 'claude-session', CLAUDE_CODE_MESSAGING_SOCKET: '/private/inbox', CODEX_THREAD_ID: 'ambient' }, '/workspace', 'explicit'))
      .toMatchObject({ frontend: 'claude', sessionId: 'explicit', socket: '/private/inbox' });
    expect(captureLauncher({ CODEX_THREAD_ID: 'codex-session', CODEX_HOME: '/private/codex' }, '/workspace'))
      .toMatchObject({ frontend: 'codex', sessionId: 'codex-session', socket: '/private/codex/app-server-control/app-server-control.sock' });
    expect(captureLauncher({ CODEX_THREAD_ID: '../unsafe' }, '/workspace')).toBeUndefined();
    expect(captureLauncher({ CODEX_THREAD_ID: 'own-session', CODEX_HOME: './codex', FC_TASKS_ROOT: './ledger' }, '/workspace/main'))
      .toMatchObject({ cwd: '/workspace/main', codexHome: '/workspace/main/codex', ledgerRoot: '/workspace/main/ledger', socket: '/workspace/main/codex/app-server-control/app-server-control.sock' });
  });

  it('persists one standalone display thread, updates only its title and retries a failed rename without creating another', async () => {
    const { root, registry, task } = fixture();
    runFile(root);
    const rpc = vi.fn().mockResolvedValueOnce({ thread: { id: 'own-display', parentThreadId: null } }).mockRejectedValueOnce(new Error('socket lost')).mockResolvedValue({});
    let now = 0;
    let push = new SessionPush(registry, { now: () => now, rpc });
    await push.sweep();
    expect(push.display(task.id)).toMatchObject({ threadId: 'own-display', error: 'socket lost' });
    now += PUSH_RETRY_MS;
    push = new SessionPush(registry, { now: () => now, rpc }); // restart
    await push.sweep();
    expect(rpc.mock.calls.map(call => call[2])).toEqual(['thread/start', 'thread/name/set', 'thread/resume', 'thread/name/set']);
    expect(rpc.mock.calls[0][3]).toEqual({ cwd: root, ephemeral: false });
    expect(rpc.mock.calls[2][3]).toEqual({ threadId: 'own-display', excludeTurns: true });
    expect(rpc.mock.calls[3][3]).toMatchObject({ threadId: 'own-display', name: expect.stringContaining('remaining unknown') });
  });
});

describe('durable delivery and business ACK', () => {
  it.each(['claude', 'codex'] as const)('retries %s with the same event id, never infers ACK from transport acceptance, and stops only on explicit ACK', async frontend => {
    const { registry, task, launcher } = fixture(frontend);
    let now = Date.parse(source.timestamp);
    const queue = vi.fn().mockResolvedValue('queued receipt');
    const claude = vi.fn().mockResolvedValue(undefined);
    const dependencies = { now: () => now, queue, claude };
    let push = new SessionPush(registry, dependencies);
    const event = push.enqueue(task, source)!;
    expect(push.enqueue(task, source)?.eventId).toBe(event.eventId);
    expect(push.events()).toHaveLength(1);
    await push.deliver(event);
    expect(push.pending()).toHaveLength(1);
    expect(push.acknowledged(event.eventId)).toBe(false);
    now += PUSH_RETRY_MS;
    push = new SessionPush(registry, dependencies);
    await push.deliver(event);
    const deliveries = frontend === 'codex' ? queue.mock.calls : claude.mock.calls;
    expect(deliveries).toHaveLength(2);
    expect(JSON.stringify(deliveries[0])).toContain(event.eventId);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect(() => push.acknowledge(event.eventId, 'wrong-session')).toThrow('different');
    push.acknowledge(event.eventId, launcher.sessionId);
    registry.update(task.id, { status: 'done' });
    push.acknowledge(event.eventId, launcher.sessionId);
    await push.deliver(event);
    expect(deliveries).toHaveLength(2);
    expect(push.pending()).toEqual([]);
  });

  it('keeps a closed Claude event pending, refreshes only the reopened session address and retries with no headless model', async () => {
    const { registry, task } = fixture('claude');
    let now = Date.parse(source.timestamp);
    const claude = vi.fn().mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValue(undefined);
    let push = new SessionPush(registry, { now: () => now, claude });
    const event = push.enqueue(task, source)!;
    await push.deliver(event);
    push = new SessionPush(registry, { now: () => now, claude });
    push.refreshSession('claude', 'other', '/other/inbox');
    push.refreshSession('claude', task.launcher!.sessionId, '/reopened/inbox');
    push.refreshSession('claude', task.launcher!.sessionId); // Stop may have no new address.
    now += PUSH_RETRY_MS;
    await push.deliver(event);
    expect(claude.mock.calls[1][0]).toBe('/reopened/inbox');
    expect(claude.mock.calls[1][1]).toBe(event.eventId);
    expect(push.pending()).toHaveLength(1);
  });

  it('falls back within a bounded time, keeps the event unacknowledged and retries a failing notifier', async () => {
    const { registry, task } = fixture('claude');
    let now = Date.parse(source.timestamp);
    const notify = vi.fn().mockRejectedValueOnce(new Error('notifier unavailable')).mockResolvedValue(undefined);
    const push = new SessionPush(registry, { now: () => now, claude: vi.fn().mockRejectedValue(new Error('closed')), notify });
    const event = push.enqueue(task, source)!;
    await push.deliver(event);
    expect(notify).not.toHaveBeenCalled();
    now += PUSH_FALLBACK_MS;
    await push.deliver(event);
    expect(push.delivery(event.eventId)).toMatchObject({ error: 'closed', fallbackError: 'notifier unavailable' });
    now += PUSH_RETRY_MS;
    await push.deliver(event);
    now += PUSH_RETRY_MS;
    await push.deliver(event);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(push.pending()).toHaveLength(1);
  });

  it('collects failed attempts, parked and terminal state; restart never changes event identities', async () => {
    const { root, registry } = fixture('claude');
    const dependencies = { claude: vi.fn().mockRejectedValue(new Error('closed')), notify: vi.fn().mockResolvedValue(undefined) };
    let push = new SessionPush(registry, dependencies);
    runFile(root, 'parked');
    writeFileSync(join(root, 'runs', 'own-run', 'events.jsonl'), [source, { ...source, type: 'approval_parked', attemptIndex: 2 }].map(e => JSON.stringify(e)).join('\n') + '\n');
    await push.sweep();
    const ids = push.events().map(e => e.eventId).sort();
    expect(push.events().map(e => e.kind)).toEqual(expect.arrayContaining(['attempt_failed', 'approval_parked', 'operator_wrap_up_required']));
    push = new SessionPush(registry, dependencies);
    await push.sweep();
    expect(push.events().map(e => e.eventId).sort()).toEqual(ids);
    runFile(root, 'complete');
    await push.sweep();
    expect(push.events().length).toBeGreaterThan(ids.length);
  });

  it('the daemon sweeps terminal task outboxes even without hooks', async () => {
    const { registry, task } = fixture('claude');
    registry.update(task.id, { status: 'stuck', completed_at: source.timestamp });
    const claude = vi.fn().mockResolvedValue(undefined);
    const orchestrator = new Orchestrator({ registry, sessionPush: { claude, notify: vi.fn().mockResolvedValue(undefined) } });
    await orchestrator.tickOnce();
    await orchestrator.stop();
    expect(claude).toHaveBeenCalled();
    expect(new SessionPush(registry).pending()).not.toHaveLength(0);
  });

  it('recovers a repeated parked state whose event append was interrupted, without reusing an earlier ACK', async () => {
    const { root, registry, launcher } = fixture('claude');
    runFile(root, 'parked');
    const events = [{ ...source, type: 'run_status_changed', runStatus: 'parked' }];
    const path = join(root, 'runs', 'own-run', 'events.jsonl');
    const write = () => writeFileSync(path, events.map(event => JSON.stringify(event)).join('\n') + '\n');
    write();
    const push = new SessionPush(registry, { claude: vi.fn().mockResolvedValue(undefined) });
    await push.sweep();
    push.acknowledge(push.pending()[0].eventId, launcher.sessionId);
    for (const second of [1, 2]) {
      // Resume was journaled; the next parked state committed before its
      // lifecycle append. Earlier parked events must not hide this transition.
      events.push({ ...source, type: 'run_status_changed', runStatus: 'running', timestamp: `2020-01-01T00:00:0${second}Z` });
      write();
      await push.sweep();
      expect(push.pending()).toHaveLength(1);
      const event = push.pending()[0];
      expect(event.kind).toBe('operator_wrap_up_required');
      await push.sweep();
      expect(push.pending()[0].eventId).toBe(event.eventId);
      push.acknowledge(event.eventId, launcher.sessionId);
    }
    expect(push.events()).toHaveLength(3);
  });

  it.each([false, true])('preserves acknowledged fallback identities from old task rows (sequence=%s)', async sequence => {
    const { root, registry, task, launcher } = fixture('claude');
    runFile(root, 'complete');
    const push = new SessionPush(registry);
    const identity = ['run-state', task.run_id, 'complete', undefined, sequence ? 0 : 1, undefined];
    const eventId = createHash('sha256').update(JSON.stringify([task.id, task.run_id, identity])).digest('hex');
    mkdirSync(join(root, 'session-push', 'events'), { recursive: true });
    writeFileSync(join(root, 'session-push', 'events', `${eventId}.json`), JSON.stringify({
      version: 1, eventId, taskId: task.id, runId: task.run_id, kind: 'operator_wrap_up_required',
      createdAt: source.timestamp, occurredAt: task.created_at, target: launcher, attempt: sequence ? 0 : 1,
    }));
    push.acknowledge(eventId, launcher.sessionId);
    await push.sweep(task.id);
    expect(push.events()).toHaveLength(1);
    expect(push.pending()).toHaveLength(0);
  });

  it('captures a failed attempt before manual retry clears the old run binding', async () => {
    const { root, registry, task } = fixture('claude');
    const previous = fcGlobalDir();
    setFcGlobalDir(root);
    try {
      runFile(root, 'failed');
      writeFileSync(join(root, 'runs', 'own-run', 'events.jsonl'), JSON.stringify({ ...source, stageId: 'work', attemptStartedAt: source.timestamp }) + '\n');
      registry.update(task.id, { status: 'failed' });
      const orchestrator = new Orchestrator({ registry });
      await orchestrator.retry(task.id);
      await orchestrator.stop();
      expect(registry.get(task.id)?.run_id).toBeUndefined();
      expect(new SessionPush(registry).pending()).toEqual(expect.arrayContaining([expect.objectContaining({
        runId: 'own-run', kind: 'attempt_failed', stageId: 'work', launch: 1, attemptIndex: 1, attemptStartedAt: source.timestamp,
      })]));
    } finally { setFcGlobalDir(previous); }
  });

  it('keeps a later run gated and captures its terminal event after an earlier run was closed and ACKed', async () => {
    const { root, registry, task, launcher } = fixture('claude');
    registry.update(task.id, { status: 'done' });
    runFile(root, 'complete');
    const resolver = { resolve: () => ({ state: 'resolved' as const, taskId: task.id, taskStatus: 'done', projectDir: root }) };
    createTaskEntry({ storeRoot: launcher.ledgerRoot, session: launcher.sessionId, taskRunResolver: resolver,
      entry: { id: 'wrap-up', subject: 'wrap up', description: '', activeForm: '', blocks: [], blockedBy: [], status: 'completed', flowcrewTaskId: task.id } });
    const push = new SessionPush(registry, { claude: vi.fn().mockResolvedValue(undefined) });
    await push.sweep();
    push.acknowledge(push.pending()[0].eventId, launcher.sessionId);
    expect(sessionGate(push, 'claude', launcher.sessionId)).toEqual({});

    registry.update(task.id, { run_id: 'next-run' });
    mkdirSync(join(root, 'runs', 'next-run'), { recursive: true });
    writeFileSync(join(root, 'runs', 'next-run', 'run.json'), JSON.stringify({
      runId: 'next-run', projectDir: root, status: 'complete', stages: {},
    }));
    expect(sessionGate(push, 'claude', launcher.sessionId).decision).toBe('block');
    await push.sweep();
    expect(push.pending()).toEqual([expect.objectContaining({ runId: 'next-run' })]);
    expect(sessionGate(push, 'claude', launcher.sessionId).decision).toBe('block');
    push.acknowledge(push.pending()[0].eventId, launcher.sessionId);
    expect(sessionGate(push, 'claude', launcher.sessionId)).toEqual({});
  });
});

describe('shared progress and turn gate', () => {
  it('uses exact elapsed seconds, workflow medians and repair frequency; missing history is unknown', () => {
    const run = { workflowName: 'tiny', status: 'running', startedAt: '2020-01-01T00:00:00Z', stages: { build: { status: 'running', startedAt: '2020-01-01T00:00:00Z' }, repair: { status: 'pending' } } };
    const history = [
      { ...run, status: 'complete', stages: { build: { status: 'complete', duration_ms: 100_000 }, repair: { status: 'complete', duration_ms: 40_000 } } },
      { ...run, status: 'shipped', stages: { build: { status: 'complete', duration_ms: 200_000 }, repair: { status: 'skipped' } } },
    ];
    const estimate = estimateProgress(run, history, Date.parse(run.startedAt) + 30_999);
    expect(estimate).toEqual({ elapsedSeconds: 30, remainingSeconds: 140, stage: 'build', historyRuns: 2 });
    expect(estimateProgress(run, [], Date.parse(run.startedAt)).remainingSeconds).toBeNull();
    expect(progressLine(1, estimate)).toContain('elapsed 30s');
  });

  it.each(['claude', 'codex'] as const)('blocks %s until ledger wrap-up AND event ACK; it cannot escape through repeated Stop', frontend => {
    const { registry, launcher, task, root } = fixture(frontend);
    const entry = { id: `flowcrew-${task.id}`, subject: 'wrap up', description: '', activeForm: '', status: 'in_progress', blocks: [], blockedBy: [] };
    const resolver = { resolve: () => ({ state: 'resolved' as const, taskId: task.id, taskStatus: 'done', projectDir: root }) };
    createTaskEntry({ storeRoot: launcher.ledgerRoot, session: launcher.sessionId, entry: { ...entry, flowcrewTaskId: task.id }, taskRunResolver: resolver });
    const push = new SessionPush(registry);
    const event = push.enqueue(task, source)!;
    expect(sessionGate(push, frontend, launcher.sessionId).decision).toBe('block');
    expect(sessionGate(push, frontend, 'unrelated')).toEqual({});
    updateTaskEntry({ storeRoot: launcher.ledgerRoot, session: launcher.sessionId, id: entry.id, entry: { status: 'completed' }, taskRunResolver: resolver });
    expect(sessionGate(push, frontend, launcher.sessionId).decision).toBe('block');
    push.acknowledge(event.eventId, launcher.sessionId);
    registry.update(task.id, { status: 'done' });
    expect(sessionGate(push, frontend, launcher.sessionId)).toEqual({});
  });

  it('shares engine progress with Claude and expires monitor coverage when its engine heartbeat stops', async () => {
    const { root, registry, launcher, task } = fixture('claude');
    runFile(root);
    const server = createServer();
    servers.push(server);
    await new Promise<void>(resolve => server.listen(launcher.socket!, resolve));
    const now = Date.parse(source.timestamp) + 20_000;
    const push = new SessionPush(registry, { now: () => now });
    await push.sweep();
    const result = renderSessionProgress(push, launcher.sessionId, now);
    expect(result.covered).toBe(true);
    expect(result.text).toContain('elapsed 20s');
    expect(result.text).toContain(`FlowCrew #${task.id}`);
    expect(renderSessionProgress(push, launcher.sessionId, now + PUSH_RETRY_MS).covered).toBe(false);
  });
});

describe('frontend transports with fake CLIs and sockets', () => {
  it('sends the Claude JSON frame to the exact inbox socket without claiming a processing ACK', async () => {
    const { launcher } = fixture('claude');
    const frames: string[] = [];
    let received!: () => void;
    const ready = new Promise<void>(resolve => { received = resolve; });
    const server = createServer(socket => socket.on('data', bytes => { frames.push(bytes.toString()); received(); }));
    servers.push(server);
    await new Promise<void>(resolve => server.listen(launcher.socket!, resolve));
    await sendClaude(launcher.socket!, 'unique-event', 'Fixed wrap-up prompt');
    await ready;
    expect(JSON.parse(frames.join(''))).toEqual({ type: 'user', from: 'flowcrew', msg_id: 'unique-event', message: { role: 'user', content: 'Fixed wrap-up prompt' } });
  });

  it('uses the Codex app-server socket for metadata and codex queue for delivery, never turn/start or exec resume', async () => {
    const { root, launcher } = fixture();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'codex');
    writeFileSync(executable, `#!${process.execPath}\nimport { connect } from 'node:net';\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] === 'queue') { writeFileSync(process.env.CODEX_HOME + '/queued.json', JSON.stringify(process.argv.slice(2))); console.log('Queued receipt'); }\nelse { const s = connect(process.argv.at(-1)); process.stdin.pipe(s); s.pipe(process.stdout); }\n`);
    chmodSync(executable, 0o755);
    vi.stubEnv('PATH', bin);
    const calls: any[] = [];
    const server = createServer(socket => {
      let input = Buffer.alloc(0);
      let upgraded = false;
      socket.on('data', chunk => {
        input = Buffer.concat([input, chunk]);
        if (!upgraded) {
          const end = input.indexOf('\r\n\r\n');
          if (end < 0) return;
          const nonce = /Sec-WebSocket-Key: (.+)\r\n/u.exec(input.toString())![1];
          const accept = createHash('sha1').update(nonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          input = input.subarray(end + 4); upgraded = true;
        }
        while (input.length >= 2) {
          let size = input[1] & 127;
          let offset = 2;
          if (size === 126) { if (input.length < 4) return; size = input.readUInt16BE(2); offset = 4; }
          if (input.length < offset + 4 + size) return;
          const mask = input.subarray(offset, offset + 4);
          const request = JSON.parse(Buffer.from(input.subarray(offset + 4, offset + 4 + size).map((v, i) => v ^ mask[i % 4])).toString());
          input = input.subarray(offset + 4 + size);
          calls.push(request);
          if (request.id) {
            const body = Buffer.from(JSON.stringify({ id: request.id, result: request.id === 1 ? {} : { thread: { id: 'own-thread', parentThreadId: null } } }));
            socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(launcher.socket!, resolve));
    expect(await codexRequest(launcher.socket!, root, 'thread/start', { cwd: root, ephemeral: false })).toMatchObject({ thread: { id: 'own-thread' } });
    expect(calls.map(c => c.method)).toEqual(['initialize', 'initialized', 'thread/start']);
    expect(await queueCodex('own-session', 'event=id fixed prompt', root)).toBe('Queued receipt');
    expect(JSON.parse(readFileSync(join(root, 'queued.json'), 'utf8'))).toEqual(['queue', '--thread', 'own-session', '--message', 'event=id fixed prompt']);
  });
});
