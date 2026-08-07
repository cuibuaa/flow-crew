import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isLiveFlowcrewSchedulerForRun,
  processArgumentsFromPs,
  processCommandBinding,
  processIsAlive,
  processStartToken,
  writeSchedulerProcessIdentity,
} from '../src/run-lock.js';

let root: string;
let ownedChild: ChildProcess | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-token-'));
});

afterEach(() => {
  if (ownedChild?.pid && ownedChild.exitCode === null) ownedChild.kill('SIGTERM');
  ownedChild = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('portable process identity', () => {
  it('writes v2 scheduler identity and binds it to the same live process', () => {
    const runPath = join(root, 'v2-run');
    mkdirSync(runPath);

    writeSchedulerProcessIdentity(runPath, 'v2-run', process.pid);

    const identity = JSON.parse(readFileSync(join(runPath, 'scheduler.identity.json'), 'utf-8')) as {
      version?: number;
      pid?: number;
      runId?: string;
      startToken?: { kind?: string; value?: string };
      command?: string;
    };
    expect(identity).toMatchObject({ version: 2, pid: process.pid, runId: 'v2-run' });
    expect(identity.startToken?.value).toBeTruthy();
    expect(identity.command).toBeTruthy();
    expect(isLiveFlowcrewSchedulerForRun(process.pid, 'v2-run', runPath)).toBe(true);
  });

  it('continues to bind a pre-change v1 Linux identity on a Linux token', () => {
    const runPath = join(root, 'v1-run');
    mkdirSync(runPath);
    const token = processStartToken(process.pid);
    writeFileSync(join(runPath, 'scheduler.identity.json'), JSON.stringify({
      version: 1,
      pid: process.pid,
      runId: 'v1-run',
      linuxStartTimeTicks: token?.value ?? 'unavailable',
    }), 'utf-8');

    const bound = isLiveFlowcrewSchedulerForRun(process.pid, 'v1-run', runPath);
    expect(bound).toBe(token?.kind === 'linux');
  });

  it('rejects equal token values when the token kinds differ', () => {
    const runPath = join(root, 'kind-mismatch');
    mkdirSync(runPath);
    const token = processStartToken(process.pid);
    expect(token).toBeDefined();
    writeFileSync(join(runPath, 'scheduler.identity.json'), JSON.stringify({
      version: 2,
      pid: process.pid,
      runId: 'kind-mismatch',
      startToken: {
        kind: token?.kind === 'linux' ? 'posix-lstart' : 'linux',
        value: token?.value,
      },
      command: 'kind mismatch must reject before command binding',
    }), 'utf-8');

    expect(isLiveFlowcrewSchedulerForRun(process.pid, 'kind-mismatch', runPath)).toBe(false);
  });

  it('treats EPERM and unknown probe errors as live and only ESRCH as dead', () => {
    const eperm = Object.assign(new Error('not permitted'), { code: 'EPERM' });
    vi.spyOn(process, 'kill').mockImplementation(() => { throw eperm; });
    expect(processIsAlive(12345)).toBe(true);

    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('unexpected probe failure'), { code: 'EIO' });
    });
    expect(processIsAlive(12345)).toBe(true);

    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });
    expect(processIsAlive(12345)).toBe(false);
  });

  it('uses -ww and preserves a long argv through the POSIX ps fallback', async () => {
    const marker = `flowcrew-long-argv-${'x'.repeat(1_024)}`;
    ownedChild = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', marker],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          FC_HOME: root,
        },
        stdio: 'ignore',
      },
    );
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      ownedChild!.once('spawn', resolveSpawn);
      ownedChild!.once('error', rejectSpawn);
    });

    const previousPath = process.env.PATH;
    process.env.PATH = root;
    try {
      const args = processArgumentsFromPs(ownedChild.pid!);
      expect(args?.join(' ')).toContain(marker);
      const recorded = shellJoin([process.execPath, '-e', 'setInterval(() => {}, 1000)', marker]);
      expect(processCommandBinding(ownedChild.pid!, recorded)).toBe('bound');
      expect(processCommandBinding(ownedChild.pid!, "'not-the-owned-command'")).toBe('unbound');
      const recordedSuperset = shellJoin(['prefix', ...args!, 'suffix']);
      expect(processCommandBinding(ownedChild.pid!, recordedSuperset)).toBe('unbound');
      expect(processCommandBinding(2_000_000_000, recorded)).toBe('unreadable');
      const source = readFileSync(new URL('../src/run-lock.ts', import.meta.url), 'utf-8');
      expect(source).toContain("['-ww', '-o', 'lstart=', '-p', String(pid)]");
      expect(source).toContain("['-ww', '-o', 'args=', '-p', String(pid)]");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

function shellJoin(parts: string[]): string {
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}
