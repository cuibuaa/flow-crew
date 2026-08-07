import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isLiveFlowcrewSchedulerForRun,
  processCommandMatches,
  processStartToken,
  processStartTokensMatch,
  writeSchedulerProcessIdentity,
} from '../src/run-lock.js';

/**
 * Drives the macOS code paths on whatever platform CI happens to be running,
 * by flipping `process.platform` to 'darwin'. On Linux this reaches
 * `posixProcessStartToken` (`ps -o lstart=`) with REAL processes, because the
 * production branch falls through to the POSIX path whenever the `/proc`
 * token is unavailable — and forcing 'darwin' skips the `/proc` read entirely.
 *
 * WHAT THIS PROVES: the branch selection, the shape of the POSIX identity, and
 * that command-binding behaves as specified against live processes.
 *
 * WHAT IT CANNOT PROVE, and why the blocking `macos` CI job still exists:
 * Darwin renders `ps -o lstart=` through its own libc, ships bash 3.2, caps
 * `sun_path` at 104 bytes, and has no `timeout` binary. None of that is
 * observable from Linux. Treat a green run here as a necessary condition, not
 * a sufficient one.
 */

const realPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

let root: string;
let ownedChild: ChildProcess | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-darwin-'));
});

afterEach(() => {
  setPlatform(realPlatform);
  if (ownedChild?.pid && ownedChild.exitCode === null) ownedChild.kill('SIGTERM');
  ownedChild = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function spawnOwnedChild(marker: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', marker],
    {
      cwd: root,
      env: { ...process.env, HOME: root, FC_HOME: root },
      stdio: 'ignore',
    },
  );
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  return child;
}

describe('darwin branch, driven from any platform', () => {
  it('selects the POSIX lstart token instead of the /proc token', () => {
    setPlatform('darwin');
    const token = processStartToken(process.pid);
    expect(token?.kind).toBe('posix-lstart');
    expect(token?.value).toBeTruthy();
  });

  it('keeps POSIX token and argv probes independent of the caller PATH', async () => {
    setPlatform('darwin');
    ownedChild = await spawnOwnedChild('flowcrew-darwin-path-probe');
    const previousPath = process.env.PATH;
    process.env.PATH = root;
    try {
      expect(processStartToken(ownedChild.pid!)?.kind).toBe('posix-lstart');
      expect(processCommandMatches(ownedChild.pid!, 'flowcrew-darwin-path-probe')).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('produces a stable token across repeated probes of the same process', () => {
    setPlatform('darwin');
    const first = processStartToken(process.pid);
    const second = processStartToken(process.pid);
    expect(processStartTokensMatch(first, second)).toBe(true);
  });

  it('never matches a linux token against a posix token of equal value', () => {
    setPlatform('darwin');
    const posix = processStartToken(process.pid);
    expect(posix?.kind).toBe('posix-lstart');
    const spoofed = { kind: 'linux' as const, value: posix!.value };
    expect(processStartTokensMatch(spoofed, posix)).toBe(false);
  });

  it('binds a live scheduler identity written while darwin is in effect', async () => {
    setPlatform('darwin');
    const marker = 'flowcrew-darwin-bind-probe';
    ownedChild = await spawnOwnedChild(marker);
    const runPath = join(root, 'darwin-run');
    mkdirSync(runPath);

    writeSchedulerProcessIdentity(runPath, 'run-darwin', ownedChild.pid!);
    expect(isLiveFlowcrewSchedulerForRun(ownedChild.pid!, 'run-darwin', runPath)).toBe(true);
  });

  it('refuses to bind when the recorded run id does not match', async () => {
    setPlatform('darwin');
    ownedChild = await spawnOwnedChild('flowcrew-darwin-runid-probe');
    const runPath = join(root, 'darwin-runid');
    mkdirSync(runPath);

    writeSchedulerProcessIdentity(runPath, 'run-darwin', ownedChild.pid!);
    expect(isLiveFlowcrewSchedulerForRun(ownedChild.pid!, 'a-different-run', runPath)).toBe(false);
  });

  it('matches a live process against its recorded command, apostrophes included', async () => {
    setPlatform('darwin');
    const marker = "flowcrew-darwin-it's-quoted-probe";
    ownedChild = await spawnOwnedChild(marker);
    expect(processCommandMatches(ownedChild.pid!, marker)).toBe(true);
  });

  it('does not match a live process against an unrelated command', async () => {
    setPlatform('darwin');
    ownedChild = await spawnOwnedChild('flowcrew-darwin-negative-probe');
    expect(processCommandMatches(ownedChild.pid!, 'some-entirely-different-command')).toBe(false);
  });

  it('reports a dead pid as unbound rather than throwing', async () => {
    setPlatform('darwin');
    ownedChild = await spawnOwnedChild('flowcrew-darwin-dead-probe');
    const pid = ownedChild.pid!;
    const runPath = join(root, 'darwin-dead');
    mkdirSync(runPath);
    writeSchedulerProcessIdentity(runPath, 'run-darwin', pid);

    ownedChild.kill('SIGKILL');
    await new Promise<void>((resolveExit) => { ownedChild!.once('exit', () => resolveExit()); });
    ownedChild = undefined;

    expect(isLiveFlowcrewSchedulerForRun(pid, 'run-darwin', runPath)).toBe(false);
  });
});
