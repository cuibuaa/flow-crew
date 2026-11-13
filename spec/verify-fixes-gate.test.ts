import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createEngineTaskRunResolver,
  createTaskEntry,
  readTaskLedger,
  resolveFcTaskRuns,
  type FcTaskEntry,
} from '../src/fc-tasks.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fcTasksModuleUrl = new URL('../dist/fc-tasks.js', import.meta.url).href;
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function task(id: string, extra: Partial<FcTaskEntry> = {}): FcTaskEntry {
  return {
    id,
    subject: id,
    description: '',
    activeForm: '',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...extra,
  };
}

async function waitForFileMarker(path: string, marker: string): Promise<void> {
  await waitForFirstFileMarker(path, [marker]);
}

async function waitForFirstFileMarker(path: string, markers: string[]): Promise<string> {
  return waitForPathEvent(dirname(path), () => {
    if (!existsSync(path)) return undefined;
    const lines = readFileSync(path, 'utf-8').split('\n');
    return markers.find((marker) => lines.includes(marker));
  });
}

describe('independent session-ledger release gate', () => {
  it('flushes the parent when a peer wins the store-root mkdir race before an acknowledged write', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-verify-root-race.'));
    const storeRoot = join(root, 'store');
    const source = String.raw`
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { dirname, resolve } from 'node:path';
      const [moduleUrl, storeRoot] = process.argv.slice(1);
      const parent = dirname(storeRoot);
      const originalMkdir = fs.mkdirSync;
      const originalOpen = fs.openSync;
      const originalFsync = fs.fsyncSync;
      const opened = new Map();
      const fsyncPaths = [];
      let injected = false;
      fs.mkdirSync = (path, ...args) => {
        if (!injected && resolve(String(path)) === resolve(storeRoot)) {
          injected = true;
          originalMkdir(path, ...args);
          const error = new Error('peer won mkdir race');
          error.code = 'EEXIST';
          throw error;
        }
        return originalMkdir(path, ...args);
      };
      fs.openSync = (path, ...args) => {
        const descriptor = originalOpen(path, ...args);
        opened.set(descriptor, resolve(String(path)));
        return descriptor;
      };
      fs.fsyncSync = (descriptor) => {
        fsyncPaths.push(opened.get(descriptor) ?? '(regular file)');
        return originalFsync(descriptor);
      };
      syncBuiltinESMExports();
      const { createTaskEntry } = await import(moduleUrl + '?root-race=' + Date.now());
      let outcome;
      try {
        createTaskEntry({
          storeRoot,
          session: 'session',
          entry: { id: 'a', subject: 'a', description: '', activeForm: '', status: 'pending', blocks: [], blockedBy: [] },
        });
        outcome = 'acknowledged';
      } catch (error) {
        outcome = error.message;
      }
      process.stdout.write(JSON.stringify({
        outcome,
        parentFlushed: fsyncPaths.includes(resolve(parent)),
        fsyncPaths,
      }));
    `;

    try {
      const child = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', source, fcTasksModuleUrl, storeRoot],
        {
          cwd: projectRoot,
          encoding: 'utf-8',
          timeout: 10_000,
          env: { ...process.env, HOME: root, FC_HOME: join(root, 'fc-home') },
        },
      );
      expect(child.status, child.stderr).toBe(0);
      const observed = JSON.parse(child.stdout) as {
        outcome: string;
        parentFlushed: boolean;
        fsyncPaths: string[];
      };
      expect(
        observed.outcome !== 'acknowledged' || observed.parentFlushed,
        JSON.stringify(observed),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses one transaction lock for case-folded aliases of the same session directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-verify-casefold.'));
    const runner = join(root, 'casefold.mjs');
    const source = String.raw`
      import fs from 'node:fs';
      import { spawn } from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { fileURLToPath } from 'node:url';
      import { join, sep } from 'node:path';
      const [moduleUrl, root, mode] = process.argv.slice(2);
      const storeRoot = join(root, 'store');
      const canonical = join(storeRoot, 'Case');
      const alias = join(storeRoot, 'case');
      if (mode === 'outer') {
        fs.mkdirSync(canonical, { recursive: true });
        fs.writeFileSync(join(canonical, 'shared.json'), JSON.stringify({
          id: 'shared', subject: 'original', description: 'original', activeForm: '',
          status: 'pending', blocks: [], blockedBy: [],
        }) + '\n');
      }
      // Model only case-insensitive filesystem lookup. Keep the real platform
      // so the native process-identity probe can observe the lock's holder.
      const originals = {};
      const mapPath = (value) => typeof value === 'string'
        && (value === alias || value.startsWith(alias + sep))
        ? canonical + value.slice(alias.length)
        : value;
      for (const name of ['existsSync', 'lstatSync', 'mkdirSync', 'openSync', 'opendirSync', 'rmdirSync', 'unlinkSync']) {
        originals[name] = fs[name];
        fs[name] = function(path, ...args) {
          return originals[name].call(fs, mapPath(path), ...args);
        };
      }
      for (const name of ['linkSync', 'renameSync']) {
        originals[name] = fs[name];
        fs[name] = function(from, to, ...args) {
          return originals[name].call(fs, mapPath(from), mapPath(to), ...args);
        };
      }
      syncBuiltinESMExports();
      const module = await import(moduleUrl);
      const { readLockWaits } = await import(new URL('./lock-publication.js', moduleUrl));
      const queued = join(root, 'queued');
      const cell = new Int32Array(new SharedArrayBuffer(4));
      if (mode === 'inner') {
        const wait = Atomics.wait;
        Atomics.wait = (...args) => {
          if (!fs.existsSync(queued)) {
            fs.writeFileSync(queued + '.tmp', JSON.stringify(readLockWaits(module.ledgerLockPath(storeRoot, 'case'))));
            fs.renameSync(queued + '.tmp', queued);
          }
          return wait(...args);
        };
        module.updateTaskEntry({ storeRoot, session: 'case', id: 'shared', entry: { description: 'inner' } });
      } else {
        let child, closed, errors = '', waiting;
        try {
          module.updateTaskEntry({ storeRoot, session: 'Case', id: 'shared', entry: { subject: 'outer' },
            publication: { update: (temporary, target) => {
              child = spawn(process.execPath, [fileURLToPath(import.meta.url), moduleUrl, root, 'inner'], {
                cwd: root, env: { ...process.env, HOME: root, FC_HOME: join(root, 'fc-home') },
                stdio: ['ignore', 'ignore', 'pipe'],
              });
              closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
              child.stderr.on('data', data => { errors += data; });
              // Observe contention, then finish the held publication. Never
              // wait for the inner transaction to finish while holding it out.
              while (!fs.existsSync(queued)) Atomics.wait(cell, 0, 0, 10);
              waiting = JSON.parse(fs.readFileSync(queued, 'utf8'));
              fs.renameSync(temporary, target);
            } },
          });
          await closed;
          if (child.exitCode !== 0) throw new Error(errors);
          const final = JSON.parse(fs.readFileSync(join(canonical, 'shared.json'), 'utf8'));
          process.stdout.write(JSON.stringify({ holder: process.pid, waiter: child.pid, waiting, final }));
        } finally {
          if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await closed;
        }
      }
    `;

    try {
      writeFileSync(runner, source);
      const child = spawnSync(process.execPath, [runner, fcTasksModuleUrl, root, 'outer'], {
        cwd: projectRoot, encoding: 'utf-8', timeout: 120_000,
        env: { ...process.env, HOME: root, FC_HOME: join(root, 'fc-home') },
      });
      expect(child.status, child.stderr).toBe(0);
      const observed = JSON.parse(child.stdout);
      expect(observed.waiting).toEqual([expect.objectContaining({
        lock: expect.objectContaining({ kind: 'session-ledger' }),
        holder: expect.objectContaining({ pid: observed.holder }),
        waiter: expect.objectContaining({ pid: observed.waiter }),
      })]);
      expect(observed.final).toMatchObject({ subject: 'outer', description: 'inner' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 150_000);

  it('refuses a non-finite maxEntries value before it can poison the default reader', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-verify-nan-limit.'));
    const session = 'session';
    const directory = join(root, session);
    mkdirSync(directory);
    try {
      for (let index = 0; index < 1_000; index += 1) {
        const id = `entry-${String(index).padStart(4, '0')}`;
        writeFileSync(join(directory, `${id}.json`), `${JSON.stringify(task(id))}\n`);
      }
      let acknowledged = false;
      try {
        createTaskEntry({
          storeRoot: root,
          session,
          entry: task('overflow'),
          maxEntries: Number.NaN,
        });
        acknowledged = true;
      } catch { /* an invalid numeric bound must refuse */ }
      const reread = readTaskLedger(root, session);
      expect({ acknowledged, state: reread.state }).toEqual({
        acknowledged: false,
        state: 'ready',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scopes resolver preparation to the current entry set instead of retaining stale prior ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-verify-resolver-state.'));
    try {
      writeFileSync(
        join(root, 'tasks.jsonl'),
        `not-json\n${JSON.stringify({ id: 2, status: 'pending', projectDir: root })}\n`,
      );
      const first = task('first', { flowcrewTaskId: 1 });
      const second = task('second', { flowcrewTaskId: 2 });
      const resolver = createEngineTaskRunResolver({ engineRoot: root });
      const firstResolution = resolveFcTaskRuns([first], resolver)[0];
      const reusedResolution = resolveFcTaskRuns([second], resolver)[0];
      const freshResolution = resolveFcTaskRuns(
        [second],
        createEngineTaskRunResolver({ engineRoot: root }),
      )[0];

      expect(firstResolution.state).toBe('unavailable');
      expect(freshResolution.state).toBe('resolved');
      expect(reusedResolution).toMatchObject({ state: 'resolved', taskId: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('waits for EOF on non-TTY write-mode stdin before accepting the complete JSON stream', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-verify-pipe-prefix.'));
    const marker = join(root, 'read-started');
    const preload = join(root, 'signal-first-read.mjs');
    writeFileSync(preload, String.raw`
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const originalRead = fs.readSync;
      let started = false;
      let completedReads = 0;
      process.once('exit', () => {
        fs.appendFileSync(process.env.FC_VERIFY_READ_MARKER, 'EXIT\n');
      });
      fs.readSync = (descriptor, ...args) => {
        if (descriptor === 0 && !started) {
          started = true;
          fs.appendFileSync(process.env.FC_VERIFY_READ_MARKER, 'START\n');
        }
        if (descriptor === 0 && completedReads > 0) {
          fs.appendFileSync(process.env.FC_VERIFY_READ_MARKER, 'NEXT\n');
        }
        const count = originalRead(descriptor, ...args);
        if (descriptor === 0 && count > 0) {
          completedReads++;
          fs.appendFileSync(process.env.FC_VERIFY_READ_MARKER, 'DATA\n');
        }
        return count;
      };
      syncBuiltinESMExports();
    `);

    const child = spawn(
      process.execPath,
      [
        '--import', preload,
        cliPath,
        'fc_tasks', 'create',
        '--session', 'session',
        '--store-root', root,
        '--engine-root', join(root, 'engine'),
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: root,
          FC_HOME: join(root, 'fc-home'),
          FC_VERIFY_READ_MARKER: marker,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
    const closed = new Promise<number | null>((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise);
      child.once('close', resolvePromise);
    });

    try {
      await waitForFileMarker(marker, 'START');
      child.stdin.write(JSON.stringify(task('prefix')));
      await waitForFileMarker(marker, 'DATA');
      const nextOrExit = await waitForFirstFileMarker(marker, ['NEXT', 'EXIT']);
      expect(nextOrExit, `${stdout}\n${stderr}`).toBe('NEXT');
      child.stdin.end(' trailing-junk');
      const exitCode = await closed;
      const targetVisible = existsSync(join(root, 'session', 'prefix.json'));

      expect(
        { requestedAnotherReadBeforeEof: true, exitCode, targetVisible },
        `${stdout}\n${stderr}`,
      ).toEqual({ requestedAnotherReadBeforeEof: true, exitCode: 1, targetVisible: false });
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('does not promise unchanged JSON for every refusal while documenting post-publication ambiguity', () => {
    const guide = readFileSync(fileURLToPath(new URL('../guide/fc_tasks.md', import.meta.url)), 'utf-8');
    const promisesEveryRefusalIsUnchanged = guide.includes(
      'A refusal still leaves every JSON file unchanged',
    );
    const admitsPostPublicationAmbiguity = /directory-persistence failure[^\n]*outcome-ambiguous/iu.test(guide);
    expect({ promisesEveryRefusalIsUnchanged, admitsPostPublicationAmbiguity }).not.toEqual({
      promisesEveryRefusalIsUnchanged: true,
      admitsPostPublicationAmbiguity: true,
    });
  });
});
