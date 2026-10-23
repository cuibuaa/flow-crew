import { spawn } from 'node:child_process';
import { CommandActivityTracker } from '../src/command-activity.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSession, settleSession, writeSession } from '../src/adapter-session.js';
import { SessionPush } from '../src/session-push.js';
import { atomicWrite } from '../src/engine-fs.js';
import { TaskRegistry } from '../src/task-registry.js';

const roots: string[] = [];
function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'atomic-publication-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('atomic publication', () => {
  it('publishes exact binary bytes with the requested private mode', () => {
    const path = join(temporaryDirectory(), 'record');
    const bytes = Buffer.from([0, 255, 195, 169, 10]);
    atomicWrite(path, bytes, { mode: 0o600 });
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    atomicWrite(path, 'replacement', { mode: 0o600 });
    expect(readFileSync(path, 'utf8')).toBe('replacement');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const defaultPath = join(temporaryDirectory(), 'default-mode');
    atomicWrite(defaultPath, 'default');
    expect(statSync(defaultPath).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it('syncs file contents before publication and the parent directory afterwards', () => {
    const path = join(temporaryDirectory(), 'record');
    writeFileSync(path, 'previous');
    const sync = fs.fsyncSync;
    const observations: string[] = [];
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      observations.push(`${fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'}:${readFileSync(path, 'utf8')}`);
      sync(fd);
    });
    syncBuiltinESMExports();
    try {
      atomicWrite(path, 'published');
      expect(observations).toEqual(['file:previous', 'directory:published']);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });

  it('reports publication failure and removes its unpublished temporary file', () => {
    const root = temporaryDirectory();
    const path = join(root, 'record');
    // A nonempty directory cannot be atomically replaced by a file.
    const registry = new TaskRegistry({ baseDir: path });
    registry.create({ projectDir: root });
    expect(() => atomicWrite(path, 'new record')).toThrow();
    expect(readdirSync(root)).toEqual(['record']);
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it('publishes live command progress without syncing either file or directory', () => {
    const root = temporaryDirectory();
    const path = join(root, 'stages', 'work', 'command_activity.json');
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('unexpected progress sync'); });
    syncBuiltinESMExports();
    try {
      const tracker = new CommandActivityTracker({ runDir: root, stageId: 'work', attemptIndex: 1, attemptStartedAt: new Date(0).toISOString() });
      tracker.started('tool', 'fixture');
      expect(JSON.parse(readFileSync(path, 'utf8')).active).toHaveLength(1);
      tracker.completed('tool');
      tracker.close();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ completedCount: 1, active: [], streamClosed: true });
      expect(spy).not.toHaveBeenCalled();
      expect(readdirSync(join(root, 'stages', 'work'))).toEqual(['command_activity.json']);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });

  it('reports a durable directory-sync failure even after the new file is visible', () => {
    const root = temporaryDirectory();
    const path = join(root, 'record');
    writeFileSync(path, 'previous');
    const sync = fs.fsyncSync;
    const failure = new Error('directory sync refused');
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw failure;
      sync(fd);
    });
    syncBuiltinESMExports();
    try {
      expect(() => atomicWrite(path, 'published', { durability: 'durable' })).toThrow(failure);
      expect(readFileSync(path, 'utf8')).toBe('published');
      expect(readdirSync(root)).toEqual(['record']);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });

  // Guard test: the base already used unique temporary names; no concurrency fix is claimed.
  it('guards complete session-push publications while writers share a path', async () => {
    const root = temporaryDirectory();
    const push = new SessionPush(new TaskRegistry({ baseDir: root }));
    const sessionId = 'shared-session';
    const key = createHash('sha256').update(JSON.stringify(['codex', sessionId])).digest('hex');
    const path = join(push.root, 'sessions', `${key}.json`);
    push.refreshSession('codex', sessionId, 'initial');
    const script = `
      const { SessionPush } = await import(${JSON.stringify(new URL('../dist/session-push.js', import.meta.url).href)});
      const { TaskRegistry } = await import(${JSON.stringify(new URL('../dist/task-registry.js', import.meta.url).href)});
      const push = new SessionPush(new TaskRegistry({ baseDir: process.argv[1] }));
      process.stdout.write('ready\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      for (let i = 0; i < 20; i++) push.refreshSession('codex', 'shared-session', process.argv[2] + '-' + i);
    `;
    const children = Array.from({ length: 4 }, (_, index) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, String(index)], {
        cwd: root, env: { ...process.env, HOME: root, FC_HOME: join(root, 'fc-home') },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const done = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}: ${stderr}`)));
      });
      const ready = new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
      return { child, done, ready };
    });
    try {
      await Promise.race([Promise.all(children.map(child => child.ready)), Promise.all(children.map(child => child.done))]);
      for (const { child } of children) child.stdin.end('start');
      let complete = false;
      let failure: unknown;
      const done = Promise.all(children.map(child => child.done)).catch(error => { failure = error; }).finally(() => { complete = true; });
      while (!complete) {
        expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ frontend: 'codex', sessionId, socket: expect.any(String) });
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      await done;
      if (failure) throw failure;
      expect(JSON.parse(readFileSync(path, 'utf8')).socket).toMatch(/^[0-3]-19$/);
      expect(readdirSync(join(push.root, 'sessions'))).toEqual([`${key}.json`]);
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(children.map(child => child.done));
    }
  });

  it('never overwrites an existing session-push event or acknowledgement', () => {
    const root = temporaryDirectory();
    const registry = new TaskRegistry({ baseDir: root });
    const launcher = { frontend: 'codex' as const, sessionId: 'own-session', cwd: root, ledgerRoot: join(root, 'ledger') };
    const task = registry.create({ projectDir: root, launcher });
    let now = 0;
    const push = new SessionPush(registry, { now: () => now });
    const source = { type: 'attempt_failed' as const, runId: 'own-run', timestamp: new Date(now).toISOString() };
    const event = push.enqueue(task, source, 'same-event')!;
    push.acknowledge(event.eventId, launcher.sessionId);
    const ackPath = join(push.root, 'acks', `${event.eventId}.json`);
    const ack = readFileSync(ackPath, 'utf8');
    now = 100;
    expect(push.enqueue(task, { ...source, detail: 'later content' }, 'same-event')).toEqual(event);
    push.acknowledge(event.eventId, launcher.sessionId);
    expect(readFileSync(ackPath, 'utf8')).toBe(ack);
    expect(statSync(ackPath).mode & 0o777).toBe(0o600);
  });
});

describe('adapter session persistence failure', () => {
  const sessionId = '12345678-1234-4234-8234-123456789abc';
  it.each([0, 1, 124, 125, 137])('is explicit to the caller without masking control exit %i', exitCode => {
    const root = temporaryDirectory();
    const path = join(root, 'stages', 'build', 'session.json');
    mkdirSync(path, { recursive: true }); // Force failure during publication, after parent creation.
    const metadata = { version: 1 as const, sessionId, ownerStageId: 'build', capturedAt: new Date(0).toISOString() };
    expect(() => writeSession(root, 'build', metadata)).toThrow();
    const result = { exitCode, sessionId, friendlyError: undefined as string | undefined };
    settleSession(root, 'build', result, sessionId);
    expect(result.exitCode).toBe([124, 125, 137].includes(exitCode) ? exitCode : 1);
    expect(result.friendlyError).toMatch(/^Could not persist adapter session: /);
    expect(result.sessionId).toBeUndefined();
    expect(readSession(root, 'build')).toBeUndefined();
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(join(root, 'stages', 'build'))).toEqual(['session.json']);
  });
});
