import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFcTasks } from '../src/cli-fc-tasks.js';
import {
  FcTasksRefusal,
  createEngineTaskRunResolver,
  createTaskEntry,
  readTaskLedger,
  renderFcTasks,
  updateTaskEntry,
  type FcTaskEntry,
} from '../src/fc-tasks.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fcTasksModuleUrl = pathToFileURL(join(projectRoot, 'dist', 'fc-tasks.js')).href;
const TSX_LOADER_BASELINE_HEAP_MIB = 12;
const BOUNDED_DIRECTORY_MARGIN_HEAP_MIB = 20;
const BOUNDED_DIRECTORY_HEAP_MIB = TSX_LOADER_BASELINE_HEAP_MIB
  + BOUNDED_DIRECTORY_MARGIN_HEAP_MIB;

let root: string;
const verifiedLoaderHeaps = new Set<number>();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-tasks-wip-regression-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function task(id: string, overrides: Partial<FcTaskEntry> = {}): FcTaskEntry {
  return {
    id,
    subject: `subject ${id}`,
    description: `description ${id}`,
    activeForm: `working ${id}`,
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...overrides,
  };
}

function seed(session: string, filename: string, value: unknown): string {
  const directory = join(root, session);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf-8');
  return path;
}

function runInline(source: string, args: string[] = [], heapMiB?: number) {
  return spawnSync(process.execPath, [
    ...(heapMiB === undefined ? [] : [`--max-old-space-size=${heapMiB}`]),
    '--input-type=module',
    '-e',
    source,
    ...args,
  ], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: root,
      FC_HOME: join(root, 'fc-home'),
      NODE_NO_WARNINGS: '1',
    },
  });
}

function expectConstrainedLoader(heapMiB: number): void {
  if (verifiedLoaderHeaps.has(heapMiB)) return;
  const control = runInline(`
    const module = await import(process.argv[1]);
    process.stdout.write(typeof module.readTaskLedger);
  `, [fcTasksModuleUrl], heapMiB);
  expect(control.status, control.stderr).toBe(0);
  expect(control.stdout).toBe('function');
  verifiedLoaderHeaps.add(heapMiB);
}

interface ChildObservation {
  ready: Promise<void>;
  lockBoundary: Promise<'contended' | 'ready' | 'settled'>;
  publicationOrSettlement: Promise<'ready' | 'settled'>;
  settlement: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function observeChild(child: ChildProcess): ChildObservation {
  let stdout = '';
  let stderr = '';
  let contended = false;
  let ready = false;
  let boundaryObserved = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveLockBoundary!: (event: 'contended' | 'ready' | 'settled') => void;
  let rejectLockBoundary!: (error: Error) => void;
  let resolvePublicationOrSettlement!: (event: 'ready' | 'settled') => void;
  let rejectPublicationOrSettlement!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const lockBoundary = new Promise<'contended' | 'ready' | 'settled'>((resolvePromise, rejectPromise) => {
    resolveLockBoundary = resolvePromise;
    rejectLockBoundary = rejectPromise;
  });
  const publicationOrSettlement = new Promise<'ready' | 'settled'>((resolvePromise, rejectPromise) => {
    resolvePublicationOrSettlement = resolvePromise;
    rejectPublicationOrSettlement = rejectPromise;
  });
  void readyPromise.catch(() => undefined);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf-8');
    if (!contended && stdout.includes('CONTENDED\n')) {
      contended = true;
      boundaryObserved = true;
      resolveLockBoundary('contended');
    }
    if (!ready && stdout.includes('READY\n')) {
      ready = true;
      resolveReady();
      if (!boundaryObserved) {
        boundaryObserved = true;
        resolveLockBoundary('ready');
      }
      resolvePublicationOrSettlement('ready');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  const settlement = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    child.once('error', (error) => {
      if (!ready) rejectReady(error);
      rejectLockBoundary(error);
      rejectPublicationOrSettlement(error);
      rejectPromise(error);
    });
    child.once('close', () => {
      if (!ready) rejectReady(new Error(`child settled before entering publication: ${stderr}`));
      if (!boundaryObserved) {
        boundaryObserved = true;
        resolveLockBoundary('settled');
      }
      resolvePublicationOrSettlement('settled');
    });
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
  return { ready: readyPromise, lockBoundary, publicationOrSettlement, settlement };
}

function workerResult<T>(stdout: string): T {
  const line = stdout.split('\n').find((value) => value.startsWith('RESULT '));
  if (!line) throw new Error(`worker did not emit a result: ${stdout}`);
  return JSON.parse(line.slice('RESULT '.length)) as T;
}

describe('session ledger publication regressions', () => {
  it('F01 surfaces real directory fsync failures for both create and update', () => {
    seed('session', 'existing.json', task('existing'));
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { resolve } from 'node:path';
      const storeRoot = process.argv[2];
      const sessionPath = resolve(storeRoot, 'session');
      const opened = new Map();
      const originalOpen = fs.openSync;
      const originalFsync = fs.fsyncSync;
      fs.openSync = (...args) => {
        const descriptor = originalOpen(...args);
        opened.set(descriptor, resolve(String(args[0])));
        return descriptor;
      };
      fs.fsyncSync = (descriptor) => {
        if (fs.fstatSync(descriptor).isDirectory() && opened.get(descriptor) === sessionPath) {
          const error = new Error('injected directory persistence failure');
          error.code = 'EIO';
          throw error;
        }
        return originalFsync(descriptor);
      };
      syncBuiltinESMExports();
      const { createTaskEntry, updateTaskEntry } = await import(process.argv[1]);
      const entry = (id) => ({ id, subject: id, description: id, activeForm: id, status: 'pending', blocks: [], blockedBy: [] });
      const observed = {};
      try { createTaskEntry({ storeRoot, session: 'session', entry: entry('created') }); observed.create = 'acknowledged'; }
      catch (error) { observed.create = error.message; }
      try { updateTaskEntry({ storeRoot, session: 'session', id: 'existing', entry: { subject: 'changed' } }); observed.update = 'acknowledged'; }
      catch (error) { observed.update = error.message; }
      observed.createVisible = fs.existsSync(sessionPath + '/created.json');
      observed.updateSubject = JSON.parse(fs.readFileSync(sessionPath + '/existing.json', 'utf8')).subject;
      process.stdout.write(JSON.stringify(observed));
    `;

    const child = runInline(source, [fcTasksModuleUrl, root]);
    expect(child.status, child.stderr).toBe(0);
    const observed = JSON.parse(child.stdout) as {
      create: string;
      update: string;
      createVisible: boolean;
      updateSubject: string;
    };
    expect(observed.create).not.toBe('acknowledged');
    expect(observed.update).not.toBe('acknowledged');
    expect(observed.create).toMatch(/may be visible|reread/iu);
    expect(observed.update).toMatch(/may be visible|reread/iu);
    expect(observed).toMatchObject({ createVisible: true, updateSubject: 'changed' });
  });

  it('F01 flushes the parent directory that first acquires a session name', () => {
    mkdirSync(root, { recursive: true });
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const opened = new Map();
      const events = [];
      const originalOpen = fs.openSync;
      const originalFsync = fs.fsyncSync;
      const originalLink = fs.linkSync;
      fs.openSync = (...args) => { const fd = originalOpen(...args); opened.set(fd, String(args[0])); return fd; };
      fs.fsyncSync = (fd) => { events.push(['fsync', opened.get(fd) ?? 'unknown']); return originalFsync(fd); };
      fs.linkSync = (from, to) => { events.push(['link', String(from), String(to)]); return originalLink(from, to); };
      syncBuiltinESMExports();
      const { createTaskEntry } = await import(process.argv[1]);
      const storeRoot = process.argv[2];
      createTaskEntry({ storeRoot, session: 'new-session', entry: { id: 'a', subject: 'a', description: 'a', activeForm: 'a', status: 'pending', blocks: [], blockedBy: [] } });
      process.stdout.write(JSON.stringify(events));
    `;

    const child = runInline(source, [fcTasksModuleUrl, root]);
    expect(child.status, child.stderr).toBe(0);
    const events = JSON.parse(child.stdout) as string[][];
    const linkIndex = events.findIndex(([type]) => type === 'link');
    const normalizedRoot = resolve(root);
    const sessionPath = join(normalizedRoot, 'new-session');
    const eventSummary = JSON.stringify(events);
    expect(linkIndex, eventSummary).toBeGreaterThan(0);
    expect(events.slice(0, linkIndex).some(([type, path]) => type === 'fsync' && path.endsWith('.tmp')), eventSummary).toBe(true);
    expect(events.slice(linkIndex + 1).some(([type, path]) => type === 'fsync' && resolve(path) === sessionPath), eventSummary).toBe(true);
    expect(events.some(([type, path]) => type === 'fsync' && resolve(path) === normalizedRoot), eventSummary).toBe(true);
  });

  it('keeps an existing store usable through an execute-only unmodified ancestor', () => {
    const ancestor = join(root, 'execute-only');
    const storeRoot = join(ancestor, 'store');
    mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
    chmodSync(ancestor, 0o111);

    try {
      expect(() => createTaskEntry({
        storeRoot,
        session: 'session',
        entry: task('entry'),
      })).not.toThrow();
      expect(existsSync(join(storeRoot, 'session', 'entry.json'))).toBe(true);
    } finally {
      chmodSync(ancestor, 0o700);
    }
  });

  it('F02 serializes same-id patches so two acknowledgements cannot lose either field', { timeout: 15_000 }, async () => {
    seed('session', 'shared.json', task('shared'));
    const workerSource = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [moduleUrl, storeRoot, field, value, releasePath] = process.argv.slice(1);
      const originalMkdir = fs.mkdirSync;
      let reportedContention = false;
      fs.mkdirSync = (...args) => {
        try { return originalMkdir(...args); }
        catch (error) {
          if (!reportedContention && error.code === 'EEXIST' && String(args[0]).includes('.fc-tasks-lock-')) {
            reportedContention = true;
            process.stdout.write('CONTENDED\\n');
          }
          throw error;
        }
      };
      syncBuiltinESMExports();
      const { updateTaskEntry } = await import(moduleUrl);
      const wait = new Int32Array(new SharedArrayBuffer(4));
      try {
        updateTaskEntry({
          storeRoot,
          session: 'session',
          id: 'shared',
          entry: { [field]: value },
          publication: { update(temporary, target) {
            process.stdout.write('READY\\n');
            while (!fs.existsSync(releasePath)) Atomics.wait(wait, 0, 0, 10);
            fs.renameSync(temporary, target);
          } },
        });
        process.stdout.write('RESULT ' + JSON.stringify({ ok: true, field, value }) + '\\n');
      } catch (error) {
        process.stdout.write('RESULT ' + JSON.stringify({ ok: false, field, value, error: error.message }) + '\\n');
      }
    `;
    const releaseSubject = join(root, 'release-subject');
    const releaseDescription = join(root, 'release-description');
    const child = (field: string, value: string, release: string) => observeChild(spawn(process.execPath, [
      '--input-type=module', '-e', workerSource,
      fcTasksModuleUrl, root, field, value, release,
    ], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: root, FC_HOME: join(root, 'fc-home') },
    }));
    const subjectChild = child('subject', 'subject-from-one', releaseSubject);
    await subjectChild.ready;
    const descriptionChild = child('description', 'description-from-two', releaseDescription);
    const secondBoundary = await descriptionChild.lockBoundary;

    writeFileSync(releaseSubject, 'release');
    await subjectChild.settlement;
    const descriptionEvent = await descriptionChild.publicationOrSettlement;
    if (descriptionEvent === 'ready') {
      writeFileSync(releaseDescription, 'release');
    }

    const rawResults = await Promise.all([subjectChild.settlement, descriptionChild.settlement]);
    expect(secondBoundary, 'writer two must reach the held ledger lock before writer one is released').toBe('contended');
    expect(rawResults.every(({ code }) => code === 0), JSON.stringify(rawResults)).toBe(true);
    const results = rawResults.map(({ stdout }) => workerResult<{
      ok: boolean;
      field: 'subject' | 'description';
      value: string;
      error?: string;
    }>(stdout));
    const final = JSON.parse(readFileSync(join(root, 'session', 'shared.json'), 'utf-8')) as FcTaskEntry;
    const successes = results.filter(({ ok }) => ok);
    if (successes.length === 2) {
      expect(final).toMatchObject({
        subject: 'subject-from-one',
        description: 'description-from-two',
      });
    } else {
      expect(successes).toHaveLength(1);
      const refused = results.find(({ ok }) => !ok);
      expect(refused?.error).toMatch(/busy|concurr|conflict|lock/iu);
      expect(final[successes[0].field]).toBe(successes[0].value);
    }
  });

  it('F02 fails safe for a live lock owner and recovers only a definitely dead owner', { timeout: 15_000 }, () => {
    const lockPath = (session: string) => join(
      root,
      `.fc-tasks-lock-${createHash('sha256').update(session).digest('hex')}`,
    );
    const installLock = (session: string, pid: number) => {
      const directory = lockPath(session);
      mkdirSync(directory);
      writeFileSync(join(directory, 'owner'), `${JSON.stringify({
        version: 1,
        pid,
        token: 'a'.repeat(32),
      })}\n`);
    };

    installLock('live-owner', process.pid);
    expect(() => createTaskEntry({
      storeRoot: root,
      session: 'live-owner',
      entry: task('must-not-publish'),
      lockTiming: { waitMs: 25, pollMs: 5 },
    })).toThrow(/busy|lock|concurrent/iu);
    expect(existsSync(join(root, 'live-owner', 'must-not-publish.json'))).toBe(false);

    installLock('dead-owner', 2_147_483_647);
    expect(createTaskEntry({
      storeRoot: root,
      session: 'dead-owner',
      entry: task('recovered'),
    })).toBe(join(root, 'dead-owner', 'recovered.json'));
    expect(existsSync(lockPath('dead-owner'))).toBe(false);
  });

  it('F04 refuses entry 1,001 at the default maxEntries boundary and keeps the ledger usable', () => {
    for (let index = 0; index < 1_000; index += 1) {
      const id = `task-${String(index).padStart(4, '0')}`;
      seed('bounded', `${id}.json`, task(id));
    }

    let refusal: string | undefined;
    try {
      createTaskEntry({ storeRoot: root, session: 'bounded', entry: task('overflow') });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    const targetExists = existsSync(join(root, 'bounded', 'overflow.json'));
    const after = readTaskLedger(root, 'bounded');
    expect({ refused: refusal !== undefined, targetExists, state: after.state }).toEqual({
      refused: true,
      targetExists: false,
      state: 'ready',
    });
  });

  it('F01-F02-F04 keeps concurrent max admission inside the durable publication transaction', { timeout: 15_000 }, async () => {
    const workerSource = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [moduleUrl, storeRoot, id, releasePath] = process.argv.slice(1);
      const events = [];
      const opened = new Map();
      const originalOpen = fs.openSync;
      const originalFsync = fs.fsyncSync;
      const originalMkdir = fs.mkdirSync;
      let reportedContention = false;
      fs.mkdirSync = (...args) => {
        try { return originalMkdir(...args); }
        catch (error) {
          if (!reportedContention && error.code === 'EEXIST' && String(args[0]).includes('.fc-tasks-lock-')) {
            reportedContention = true;
            process.stdout.write('CONTENDED\\n');
          }
          throw error;
        }
      };
      fs.openSync = (...args) => { const fd = originalOpen(...args); opened.set(fd, String(args[0])); return fd; };
      fs.fsyncSync = (fd) => { events.push(['fsync', opened.get(fd) ?? 'unknown']); return originalFsync(fd); };
      syncBuiltinESMExports();
      const { createTaskEntry } = await import(moduleUrl);
      const wait = new Int32Array(new SharedArrayBuffer(4));
      try {
        createTaskEntry({
          storeRoot,
          session: 'bounded',
          maxEntries: 1,
          entry: { id, subject: id, description: id, activeForm: id, status: 'pending', blocks: [], blockedBy: [] },
          publication: { create(temporary, target) {
            events.push(['link', temporary, target]);
            process.stdout.write('READY\\n');
            while (!fs.existsSync(releasePath)) Atomics.wait(wait, 0, 0, 10);
            fs.linkSync(temporary, target);
          } },
        });
        process.stdout.write('RESULT ' + JSON.stringify({ ok: true, events }) + '\\n');
      } catch (error) {
        process.stdout.write('RESULT ' + JSON.stringify({ ok: false, error: error.message, events }) + '\\n');
      }
    `;
    const release = [join(root, 'release-a'), join(root, 'release-b')];
    const child = (id: string, index: number) => observeChild(spawn(process.execPath, [
      '--input-type=module', '-e', workerSource,
      fcTasksModuleUrl, root, id, release[index],
    ], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: root, FC_HOME: join(root, 'fc-home') },
    }));
    const children = [child('a', 0)];
    await children[0].ready;
    children.push(child('b', 1));
    const secondBoundary = await children[1].lockBoundary;

    writeFileSync(release[0], 'release');
    await children[0].settlement;
    const secondEvent = await children[1].publicationOrSettlement;
    if (secondEvent === 'ready') {
      writeFileSync(release[1], 'release');
    }

    const raw = await Promise.all(children.map(({ settlement }) => settlement));
    expect(secondBoundary, 'writer two must reach the held ledger lock before writer one is released').toBe('contended');
    expect(raw.every(({ code }) => code === 0), JSON.stringify(raw)).toBe(true);
    const outcomes = raw.map(({ stdout }) => workerResult<{
      ok: boolean;
      error?: string;
      events: string[][];
    }>(stdout));
    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(outcomes.filter(({ ok }) => !ok)[0]?.error).toMatch(/limit|maximum|entries/iu);
    const ledger = readTaskLedger(root, 'bounded', 1);
    expect(ledger).toMatchObject({ state: 'ready', entries: [{ id: expect.any(String) }] });

    const allEvents = outcomes.flatMap(({ events }) => events);
    const successfulEvents = outcomes.find(({ ok }) => ok)?.events ?? [];
    const linkIndex = successfulEvents.findIndex(([type]) => type === 'link');
    expect(successfulEvents.slice(0, linkIndex).some(([type, path]) => type === 'fsync' && path.endsWith('.tmp'))).toBe(true);
    expect(successfulEvents.slice(linkIndex + 1).some(([type, path]) => type === 'fsync' && resolve(path) === join(root, 'bounded'))).toBe(true);
    expect(allEvents.some(([type, path]) => type === 'fsync' && resolve(path) === resolve(root))).toBe(true);
  });
});

describe('session ledger input and CLI regressions', () => {
  it('F05 renders an oversized hand-written entry as nonblank degradation without exhausting the process', { timeout: 20_000 }, () => {
    expectConstrainedLoader(64);
    seed('oversized', 'huge.json', task('huge', {
      subject: 'x'.repeat(12 * 1024 * 1024),
    }));
    const source = `
      const { renderFcTasks } = await import(process.argv[1]);
      const result = renderFcTasks({ storeRoot: process.argv[2], explicitSession: 'oversized', columns: 80, lines: 20 });
      process.stdout.write(result.text);
    `;
    const child = runInline(source, [fcTasksModuleUrl, root], 64);
    expect(child.status, child.stderr.slice(-1_000)).toBe(0);
    expect(child.stdout.trim()).not.toBe('');
    expect(child.stdout).toMatch(/degraded|oversized|too large/iu);
  });

  it('F05 refuses oversized writer input before publishing any ledger file', () => {
    for (const [id, field] of [
      ['huge-subject', 'subject'],
      ['huge-description', 'description'],
      ['huge-active-form', 'activeForm'],
    ] as const) {
      expect(() => createTaskEntry({
        storeRoot: root,
        session: 'writer-limits',
        entry: task(id, { [field]: 'x'.repeat(12 * 1024 * 1024) }),
      })).toThrow(FcTasksRefusal);
    }
    const writerDirectory = join(root, 'writer-limits');
    expect(existsSync(writerDirectory) ? readdirSync(writerDirectory) : []).toEqual([]);
  });

  it('QA13 bounds a direct front-end payload before JSON parsing can exhaust the process', { timeout: 20_000 }, () => {
    expectConstrainedLoader(64);
    const source = `
      const { renderFcTasks } = await import(process.argv[1]);
      const payload = '{"session_id":"' + 'x'.repeat(100 * 1024 * 1024) + '"}';
      const result = renderFcTasks({
        storeRoot: process.argv[2],
        payload: { provided: true, text: payload },
        columns: 80,
        lines: 20,
      });
      process.stdout.write(result.text);
    `;
    const child = runInline(source, [fcTasksModuleUrl, root], 64);
    expect(child.status, child.stderr.slice(-1_000)).toBe(0);
    expect(child.stdout.trim()).not.toBe('');
    expect(child.stdout).toMatch(/degraded\[payload_too_large\]|payload.*limit/iu);
  });

  it('F07 rejects an unsafe session at the exported reader boundary', () => {
    const confined = join(root, 'confined');
    mkdirSync(confined);
    seed('outside-ledger', 'secret.json', task('outside-secret'));

    const result = readTaskLedger(confined, '../outside-ledger');
    expect(result).toMatchObject({
      state: 'unavailable',
      entries: [],
      issues: [{ code: 'store_unreadable', detail: expect.stringMatching(/session|unsafe/iu) }],
    });
  });

  it.each(['create', 'update'] as const)('F08 sanitizes stored filenames before printing %s refusals', (operation) => {
    const session = 'diagnostic';
    seed(session, 'evil\nINJECTED\u001b[31m.json', { ...task('bad'), activeForm: null });
    seed(session, 'healthy.json', task('healthy'));
    const args = operation === 'create'
      ? ['fc_tasks', 'create', '--session', session, '--store-root', root,
        '--entry', JSON.stringify(task('new'))]
      : ['fc_tasks', 'update', 'healthy', '--session', session, '--store-root', root,
        '--entry', JSON.stringify({ subject: 'changed' })];
    const stderr = { text: '', write(chunk: string) { this.text += chunk; } };
    const code = cmdFcTasks(args, {
      stdout: { write(_chunk: string) {} }, stderr, env: {}, cwd: root,
    });
    expect(code).toBe(1);
    expect(stderr.text.trimEnd().split('\n')).toHaveLength(1);
    expect(stderr.text).not.toContain('\u001b');
    expect(stderr.text).toContain('evil');
    expect(stderr.text).toContain('INJECTED');
  });

  it('F10 consumes documented JSON from write-mode TTY stdin', () => {
    const session = 'interactive';
    const stdout = { text: '', write(chunk: string) { this.text += chunk; } };
    const stderr = { text: '', write(chunk: string) { this.text += chunk; } };
    const originalTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    let code: number;
    try {
      code = cmdFcTasks([
        'fc_tasks', 'create', '--session', session, '--store-root', root,
        '--engine-root', join(root, 'engine'),
      ], {
        stdout,
        stderr,
        env: { CODEX_THREAD_ID: '' },
        cwd: projectRoot,
        stdinIsTTY: true,
        readStdin: () => `${JSON.stringify(task('tty-entry'))}\n`,
      });
    } finally {
      if (originalTty) Object.defineProperty(process.stdin, 'isTTY', originalTty);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    }

    expect(code, stderr.text).toBe(0);
    expect(existsSync(join(root, session, 'tty-entry.json'))).toBe(true);
  });

  it('F11 writes an accepted 240-byte id without exceeding NAME_MAX for its temporary file', () => {
    const id = '😀'.repeat(60);
    expect(Buffer.byteLength(id, 'utf-8')).toBe(240);
    expect(() => createTaskEntry({
      storeRoot: root,
      session: 'long-id',
      entry: task(id),
    })).not.toThrow();
    expect(existsSync(join(root, 'long-id', `${id}.json`))).toBe(true);
  });

  it('QA01 bounds non-JSON directory entries before readdir allocation can exhaust the process', { timeout: 20_000 }, () => {
    // The cap is a predeclared transpiler baseline plus a bounded-operation
    // margin. It stays far below materializing every candidate while avoiding
    // a fixture that spends the run one minor allocation from V8 abort.
    expectConstrainedLoader(BOUNDED_DIRECTORY_HEAP_MIB);
    const sessionPath = join(root, 'many-non-json');
    mkdirSync(sessionPath);
    // One entry beyond the production streaming cap reaches the same boundary
    // without spending seconds manufacturing irrelevant directory contents.
    for (let index = 0; index < 4_097; index += 1) {
      writeFileSync(join(sessionPath, `${index}.tmp`), '');
    }
    const source = `
      const { renderFcTasks } = await import(process.argv[1]);
      const result = renderFcTasks({ storeRoot: process.argv[2], explicitSession: 'many-non-json', maxEntries: 1 });
      process.stdout.write(result.text);
    `;
    const child = runInline(source, [fcTasksModuleUrl, root], BOUNDED_DIRECTORY_HEAP_MIB);
    expect(child.signal, child.stderr.slice(-1_000)).toBeNull();
    expect(child.status, child.stderr.slice(-1_000)).toBe(0);
    expect(child.stdout.trim()).not.toBe('');
  });

  it('QA02 sanitizes user-derived usage errors before writing terminal output', () => {
    const stdout = { text: '', write(chunk: string) { this.text += chunk; } };
    const code = cmdFcTasks([
      'fc_tasks', 'render', '--unknown\nINJECTED\u001b[31m',
    ], { stdout, stderr: { write(_chunk: string) {} }, env: {}, cwd: root });

    expect(code).toBe(2);
    expect(stdout.text.trimEnd().split('\n')).toHaveLength(1);
    expect(stdout.text).not.toContain('\u001b');
    expect(stdout.text).toContain('--unknown');
    expect(stdout.text).toContain('INJECTED');
  });

  it('QA03 bounds linked run records and statuses before rendering them', { timeout: 20_000 }, () => {
    expectConstrainedLoader(64);
    const storeRoot = join(root, 'store');
    const engineRoot = join(root, 'engine');
    const projectDir = join(root, 'project');
    mkdirSync(join(storeRoot, 'linked'), { recursive: true });
    writeFileSync(join(storeRoot, 'linked', 'a.json'), JSON.stringify({
      ...task('a', { status: 'in_progress' }),
      flowcrewTaskId: 1,
    }));
    mkdirSync(join(engineRoot, 'runs', 'run-1'), { recursive: true });
    appendFileSync(join(engineRoot, 'tasks.jsonl'), `${JSON.stringify({
      id: 1,
      status: 'running',
      projectDir,
      run_id: 'run-1',
    })}\n`);
    writeFileSync(join(engineRoot, 'runs', 'run-1', 'run.json'), JSON.stringify({
      runId: 'run-1',
      status: 'x'.repeat(12 * 1024 * 1024),
      projectDir,
    }));
    const source = `
      const { createEngineTaskRunResolver, renderFcTasks } = await import(process.argv[1]);
      const result = renderFcTasks({
        storeRoot: process.argv[2],
        explicitSession: 'linked',
        taskRunResolver: createEngineTaskRunResolver({ engineRoot: process.argv[3] }),
      });
      process.stdout.write(result.text);
    `;
    const child = runInline(source, [fcTasksModuleUrl, storeRoot, engineRoot], 64);
    expect(child.status, child.stderr.slice(-1_000)).toBe(0);
    expect(child.stdout.trim()).not.toBe('');
    expect(child.stdout).toMatch(/degraded|oversized|too large|stale/iu);
  });

  it('QA14 refuses a linked run directory symlink that escapes the configured archive', () => {
    const engineRoot = join(root, 'engine-symlink');
    const outside = join(root, 'outside-run');
    const projectDir = join(root, 'linked-project');
    mkdirSync(join(engineRoot, 'runs'), { recursive: true });
    mkdirSync(outside);
    appendFileSync(join(engineRoot, 'tasks.jsonl'), `${JSON.stringify({
      id: 9,
      status: 'running',
      projectDir,
      run_id: 'linked-run',
    })}\n`);
    writeFileSync(join(outside, 'run.json'), JSON.stringify({
      runId: 'linked-run',
      status: 'outside-controlled',
      projectDir,
    }));
    symlinkSync(outside, join(engineRoot, 'runs', 'linked-run'), 'dir');
    const entry = task('linked', { flowcrewTaskId: 9 });
    const resolver = createEngineTaskRunResolver({ engineRoot });
    resolver.prepare?.([entry]);

    const result = resolver.resolve(entry);
    expect(result).toMatchObject({ state: 'stale', taskId: 9 });
    expect(JSON.stringify(result)).not.toContain('outside-controlled');
  });

  it('QA14 refuses a symlinked default run archive that escapes the engine root', () => {
    const engineRoot = join(root, 'engine-run-root-symlink');
    const outsideArchive = join(root, 'outside-run-archive');
    const projectDir = join(root, 'run-root-project');
    mkdirSync(engineRoot);
    mkdirSync(join(outsideArchive, 'linked-run'), { recursive: true });
    appendFileSync(join(engineRoot, 'tasks.jsonl'), `${JSON.stringify({
      id: 11,
      status: 'running',
      projectDir,
      run_id: 'linked-run',
    })}\n`);
    writeFileSync(join(outsideArchive, 'linked-run', 'run.json'), JSON.stringify({
      runId: 'linked-run',
      status: 'outside-archive-controlled',
      projectDir,
    }));
    symlinkSync(outsideArchive, join(engineRoot, 'runs'), 'dir');
    const entry = task('linked-archive', { flowcrewTaskId: 11 });
    const resolver = createEngineTaskRunResolver({ engineRoot });
    resolver.prepare?.([entry]);

    const result = resolver.resolve(entry);
    expect(result).toMatchObject({ state: 'stale', taskId: 11 });
    expect(JSON.stringify(result)).not.toContain('outside-archive-controlled');
  });

  it('QA15 refuses a symlinked engine task registry outside the configured root', () => {
    const engineRoot = join(root, 'engine-registry-symlink');
    const outsideRegistry = join(root, 'outside-tasks.jsonl');
    const projectDir = join(root, 'registry-project');
    mkdirSync(engineRoot);
    writeFileSync(outsideRegistry, `${JSON.stringify({
      id: 10,
      status: 'outside-controlled',
      projectDir,
    })}\n`);
    symlinkSync(outsideRegistry, join(engineRoot, 'tasks.jsonl'), 'file');
    const entry = task('linked-registry', { flowcrewTaskId: 10 });
    const resolver = createEngineTaskRunResolver({ engineRoot });
    resolver.prepare?.([entry]);

    const result = resolver.resolve(entry);
    expect(result).toMatchObject({ state: 'unavailable', taskId: 10 });
    expect(JSON.stringify(result)).not.toContain('outside-controlled');
  });

  it('QA20 bounds reverse registry traversal when a linked task is older than the tail budget', () => {
    const engineRoot = join(root, 'engine-tail-budget');
    const projectDir = join(root, 'project');
    mkdirSync(engineRoot);
    mkdirSync(projectDir);
    const selected = JSON.stringify({ id: 1, status: 'pending', projectDir });
    const unrelated = `${JSON.stringify({
      id: 2,
      status: 'done',
      projectDir,
      padding: 'x'.repeat(900),
    })}\n`;
    const rows = unrelated.repeat(Math.ceil((17 * 1024 * 1024) / Buffer.byteLength(unrelated)));
    writeFileSync(join(engineRoot, 'tasks.jsonl'), `${selected}\n${rows}`, 'utf-8');

    const result = createEngineTaskRunResolver({ engineRoot }).resolve(
      task('linked', { flowcrewTaskId: 1 }),
    );

    expect(result).toMatchObject({ state: 'unavailable', taskId: 1 });
    expect(result.state === 'unavailable' ? result.detail : '').toMatch(/scan.*limit|tail.*limit/iu);
  });

  it('QA07 removes Unicode bidi controls from terminal-rendered ledger text', () => {
    seed('bidi', 'bidi.json', task('bidi', {
      subject: 'safe prefix\u202espoofed suffix\u2066tail\u2069',
    }));

    const rendered = renderFcTasks({
      storeRoot: root,
      explicitSession: 'bidi',
      columns: 100,
      lines: 4,
    });
    expect(rendered.text).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(rendered.text).toContain('safe prefix');
    expect(rendered.text).toContain('spoofed suffix');
  });

  it.each(['directory', 'file'] as const)('QA08 refuses a %s symlink swap between ledger checks and use', (kind) => {
    const storeRoot = join(root, 'swap-store');
    const sessionPath = join(storeRoot, 'session');
    const outside = join(root, 'swap-outside');
    mkdirSync(sessionPath, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(sessionPath, 'benign.json'), `${JSON.stringify(task('benign'))}\n`);
    writeFileSync(join(outside, 'secret.json'), `${JSON.stringify(task('outside-secret'))}\n`);
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [moduleUrl, storeRoot, sessionPath, outside, kind] = process.argv.slice(1);
      const originalReaddir = fs.readdirSync;
      const originalOpendir = fs.opendirSync;
      const originalReadFile = fs.readFileSync;
      const originalOpen = fs.openSync;
      let swapped = false;
      const swapDirectory = () => {
        if (swapped) return;
        swapped = true;
        fs.renameSync(sessionPath, sessionPath + '.original');
        fs.symlinkSync(outside, sessionPath, 'dir');
      };
      const swapFile = () => {
        if (swapped) return;
        swapped = true;
        fs.unlinkSync(sessionPath + '/benign.json');
        fs.symlinkSync(outside + '/secret.json', sessionPath + '/benign.json', 'file');
      };
      fs.readdirSync = (...args) => {
        if (kind === 'directory' && String(args[0]) === sessionPath) swapDirectory();
        return originalReaddir(...args);
      };
      fs.opendirSync = (...args) => {
        if (kind === 'directory' && String(args[0]) === sessionPath) swapDirectory();
        return originalOpendir(...args);
      };
      fs.readFileSync = (...args) => {
        if (kind === 'file' && String(args[0]) === sessionPath + '/benign.json') swapFile();
        return originalReadFile(...args);
      };
      fs.openSync = (...args) => {
        if (kind === 'file' && String(args[0]) === sessionPath + '/benign.json') swapFile();
        return originalOpen(...args);
      };
      syncBuiltinESMExports();
      const { readTaskLedger } = await import(moduleUrl);
      const result = readTaskLedger(storeRoot, 'session');
      process.stdout.write(JSON.stringify({ state: result.state, ids: result.entries.map((entry) => entry.id), issues: result.issues }));
    `;
    const child = runInline(source, [fcTasksModuleUrl, storeRoot, sessionPath, outside, kind]);
    expect(child.status, child.stderr).toBe(0);
    const observed = JSON.parse(child.stdout) as { state: string; ids: string[] };
    expect(observed.ids).not.toContain('outside-secret');
  });

  it('QA19 refuses a session-directory swap before temporary write can escape the store', () => {
    const storeRoot = join(root, 'write-swap-store');
    const sessionPath = join(storeRoot, 'session');
    const outside = join(root, 'write-swap-outside');
    mkdirSync(sessionPath, { recursive: true });
    mkdirSync(outside);
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [moduleUrl, storeRoot, sessionPath, outside] = process.argv.slice(1);
      const originalOpen = fs.openSync;
      let swapped = false;
      fs.openSync = (...args) => {
        const path = String(args[0]);
        if (!swapped && path.startsWith(sessionPath + '/.fc-task-') && path.endsWith('.tmp')) {
          swapped = true;
          fs.renameSync(sessionPath, sessionPath + '.original');
          fs.symlinkSync(outside, sessionPath, 'dir');
        }
        return originalOpen(...args);
      };
      syncBuiltinESMExports();
      const { createTaskEntry } = await import(moduleUrl);
      let outcome;
      try {
        createTaskEntry({
          storeRoot,
          session: 'session',
          entry: { id: 'escaped', subject: 'escaped', description: '', activeForm: '', status: 'pending', blocks: [], blockedBy: [] },
        });
        outcome = 'acknowledged';
      } catch (error) {
        outcome = error.message;
      }
      process.stdout.write(JSON.stringify({ outcome, outsideTarget: fs.existsSync(outside + '/escaped.json') }));
    `;

    const child = runInline(source, [fcTasksModuleUrl, storeRoot, sessionPath, outside]);
    expect(child.status, child.stderr).toBe(0);
    const observed = JSON.parse(child.stdout) as { outcome: string; outsideTarget: boolean };
    expect(observed.outcome).not.toBe('acknowledged');
    expect(observed.outsideTarget).toBe(false);
  });

  it('keeps ordinary small entries and resolver records compatible', () => {
    const engineRoot = join(root, 'engine-small');
    const projectDir = join(root, 'project-small');
    seed('small', 'small.json', { ...task('small', { status: 'in_progress' }), flowcrewTaskId: 7 });
    mkdirSync(join(engineRoot, 'runs', 'run-small'), { recursive: true });
    appendFileSync(join(engineRoot, 'tasks.jsonl'), `${JSON.stringify({ id: 7, status: 'running', projectDir, run_id: 'run-small' })}\n`);
    writeFileSync(join(engineRoot, 'runs', 'run-small', 'run.json'), JSON.stringify({ runId: 'run-small', status: 'running', projectDir }));

    const result = renderFcTasks({
      storeRoot: root,
      explicitSession: 'small',
      taskRunResolver: createEngineTaskRunResolver({ engineRoot }),
    });
    expect(result).toMatchObject({ state: 'active', issueCodes: [] });
    expect(result.text).toContain('run:running [small]');
  });
});
