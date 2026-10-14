import { stageLiveLogPath } from '../src/stage-live-log.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandActivityTracker } from '../src/command-activity.js';
import { beginStageAttempt, createRun, readRunState, setFcGlobalDir, writeRunState } from '../src/store.js';
import { inspectStageExecutionFacts, StageWatchdog } from '../src/stage-watchdog.js';

// The setup loads the store before this module's mocks. Reload its graph and
// explicitly bind the new store instance to this file's disposable fixture.
const proc = vi.hoisted(() => {
  vi.resetModules();
  return {
    pid: 41001, child: 41002, foreign: 42001,
    start: '7100', cpu: 1, writes: 0, inode: 81001, received: 100, foreignReceived: 200,
    socketAvailable: true, omitReceiveCounter: false,
  };
});

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const missing = () => Object.assign(new Error('Missing fixture process observation'), { code: 'ENOENT' });
  return {
    ...actual,
    readFileSync(path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) {
      const name = String(path);
      const match = /^\/proc\/(\d+)\/(stat|io|wchan)$/.exec(name);
      if (match) {
        const id = Number(match[1]);
        if (![proc.pid, proc.child, proc.foreign].includes(id)) throw missing();
        if (match[2] === 'io') return `rchar: 100\nwchar: ${proc.writes}\nread_bytes: 0\nwrite_bytes: ${proc.writes}\n`;
        if (match[2] === 'wchan') return 'wait_woken';
        const fields = Array<string>(50).fill('0');
        fields[0] = 'S';
        fields[1] = '1';
        fields[2] = String(id === proc.foreign ? proc.foreign : proc.pid);
        fields[11] = String(proc.cpu);
        fields[19] = proc.start;
        return `${id} (fixture) ${fields.join(' ')}`;
      }
      if (name.startsWith('/proc/')) throw missing();
      return Reflect.apply(actual.readFileSync, actual, [path, ...args]);
    },
    readdirSync(path: Parameters<typeof actual.readdirSync>[0], ...args: unknown[]) {
      const name = String(path);
      if (name === '/proc') return [proc.pid, proc.child, proc.foreign].map(String);
      if (/^\/proc\/\d+\/fd$/.test(name)) return ['3'];
      if (name.startsWith('/proc/')) throw missing();
      return Reflect.apply(actual.readdirSync, actual, [path, ...args]);
    },
    readlinkSync(path: Parameters<typeof actual.readlinkSync>[0], ...args: unknown[]) {
      const name = String(path);
      if (name === `/proc/${proc.pid}/fd/3`) return `socket:[${proc.inode}]`;
      if (name === `/proc/${proc.child}/fd/3`) return `socket:[${proc.inode}]`;
      if (name === `/proc/${proc.foreign}/fd/3`) return 'socket:[82001]';
      if (name.startsWith('/proc/')) throw missing();
      return Reflect.apply(actual.readlinkSync, actual, [path, ...args]);
    },
  };
});

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync(file: string, ...args: unknown[]) {
      if (file === 'ss') {
        if (!proc.socketAvailable) throw Object.assign(new Error('Socket observation unavailable'), { code: 'ENOENT' });
        const received = proc.omitReceiveCounter ? '' : ` bytes_received:${proc.received}`;
        return `ESTAB 0 0 127.0.0.1:31001 127.0.0.1:31002 ino:${proc.inode}${received}\n`
          + `ESTAB 0 0 127.0.0.1:32001 127.0.0.1:32002 ino:82001 bytes_received:${proc.foreignReceived}\n`;
      }
      return Reflect.apply(actual.execFileSync, actual, [file, ...args]);
    },
  };
});

const stageId = 'review';
const config = { pollIntervalMs: 100, idleThresholdMs: 600_000 };
let project: string;
let run: ReturnType<typeof createRun>;
let status: ReturnType<typeof beginStageAttempt>;
let activity: CommandActivityTracker;

beforeEach(() => {
  Object.assign(proc, { start: '7100', cpu: 1, writes: 0, inode: 81001, received: 100, foreignReceived: 200,
    socketAvailable: true, omitReceiveCounter: false });
  const root = process.env.FLOWCREW_VITEST_ROOT!;
  setFcGlobalDir(join(root, 'provider-store'));
  project = join(root, 'provider-project');
  mkdirSync(project, { recursive: true });
  run = createRun(project, 'progress', 'name: progress\nstages: []', [stageId]);
  writeFileSync(join(run.runDirPath, 'task_brief.md'), '# Review the result\n');
  status = beginStageAttempt(project, run.runId, stageId, 0);
  const attempt = status.attempts!.at(-1)!;
  const state = readRunState(project, run.runId);
  state.status = 'running';
  state.stages[stageId] = status;
  writeRunState(project, run.runId, state);
  const stageRoot = join(run.runDirPath, 'stages', stageId);
  const logPath = stageLiveLogPath(run.runDirPath, stageId, attempt.index, attempt.startedAt);
  appendFileSync(logPath, `\n<!-- flowcrew-attempt ${JSON.stringify(attempt)} -->\n`);
  writeFileSync(join(stageRoot, 'attempt_generation.json'), JSON.stringify({
    version: 1, stageId, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt,
    segmentStart: Buffer.byteLength(readFileSync(logPath)),
  }));
  activity = new CommandActivityTracker({ runDir: run.runDirPath, stageId,
    attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt });
  activity.bindProcess(proc.pid, 'provider');
});

afterEach(() => { vi.restoreAllMocks(); });

function facts(previousProcessWork?: string) {
  return inspectStageExecutionFacts({ runDir: run.runDirPath, stageId, status,
    sinceMs: Date.now() + 1, previousProcessWork });
}

function monitor() { return new StageWatchdog(project, run.runId, config); }

function savedProgress() {
  return JSON.parse(readFileSync(join(run.runDirPath, 'stage_watchdog.json'), 'utf8'));
}

const signalPath = () => join(run.runDirPath, 'signals', `abort_${stageId}.json`);

describe.skipIf(process.platform !== 'linux')('provider inbound stream progress', () => {
  it('keeps a provider receiving bytes without emitted items or active commands alive', async () => {
      const supervisor = monitor();
      await supervisor.tick();
      const initialProgress = savedProgress().stageProgress[stageId].lastProgressAt;
      for (let count = 1; count <= 3; count++) {
        vi.spyOn(Date, 'now').mockReturnValue(initialProgress + count * (config.idleThresholdMs + 1));
        proc.received += 128;
        await supervisor.tick();
        const progress = savedProgress().stageProgress[stageId];
        expect(progress).toMatchObject({
          lastProgressAt: Date.now(), idleThresholdMs: config.idleThresholdMs,
          protectedFromIdleAbort: true, activeCommandCount: 0,
          liveProgressThisTick: false, artifactProgressThisTick: false,
        });
        expect(existsSync(signalPath())).toBe(false);
        expect(progress.processDescription).toContain('socket receive progress observed');
      }

    },
  );

  it('still aborts a provider with frozen counters at the configured idle threshold', async () => {
      const supervisor = monitor();
      await supervisor.tick();
      const lastProgressAt = savedProgress().stageProgress[stageId].lastProgressAt;
      vi.spyOn(Date, 'now').mockReturnValue(lastProgressAt + config.idleThresholdMs - 1);
      await supervisor.tick();
      expect(savedProgress().stageProgress[stageId]).toMatchObject({
        lastProgressAt, idleThresholdMs: config.idleThresholdMs, protectedFromIdleAbort: false,
      });
      expect(existsSync(signalPath())).toBe(false);
      vi.spyOn(Date, 'now').mockReturnValue(lastProgressAt + config.idleThresholdMs);
      await supervisor.tick();
      expect(JSON.parse(readFileSync(signalPath(), 'utf8'))).toMatchObject({ source: 'watchdog', attemptIndex: 1 });
    },
  );

  it('does not count provider or descendant CPU and writes as inbound stream progress without an active command', () => {
    const baseline = facts();
    proc.cpu += 200;
    proc.writes += 8192;
    const next = facts(baseline.processWork);
    expect(next.processWork).toBe(baseline.processWork);
    expect(next.protectedFromIdleAbort).toBe(false);
    expect(next.activeCommandCount).toBe(0);
  });

  it('keeps provider tool descendants alive when an active command advances CPU counters', () => {
    activity.started('fixture-command', 'fixture tool');
    const baseline = facts();
    proc.cpu += 200;
    const next = facts(baseline.processWork);
    expect(next.processWork).not.toBe(baseline.processWork);
    expect(next.protectedFromIdleAbort).toBe(true);
    expect(next.activeCommandCount).toBe(1);
  });

  it('does not reset the watchdog idle clock for repeated zero-byte socket reconnects', async () => {
    const supervisor = monitor();
    await supervisor.tick();
    const lastProgressAt = savedProgress().stageProgress[stageId].lastProgressAt;
    for (const idleMs of [config.idleThresholdMs - 1, config.idleThresholdMs]) {
      vi.spyOn(Date, 'now').mockReturnValue(lastProgressAt + idleMs);
      proc.inode++;
      proc.received = 0;
      await supervisor.tick();
      expect(savedProgress().stageProgress[stageId]).toMatchObject({
        lastProgressAt, idleThresholdMs: config.idleThresholdMs, protectedFromIdleAbort: false,
      });
      expect(existsSync(signalPath())).toBe(idleMs === config.idleThresholdMs);
    }
    expect(JSON.parse(readFileSync(signalPath(), 'utf8'))).toMatchObject({ source: 'watchdog', attemptIndex: 1 });
  });

  it('counts received bytes on a replacement socket even when its counter is below the previous socket', () => {
    const baseline = facts();
    proc.inode++;
    proc.received = 1;
    const next = facts(baseline.processWork);
    expect(next.processWork).not.toBe(baseline.processWork);
    expect(next.protectedFromIdleAbort).toBe(true);
  });

  it('ignores received-byte changes on sockets outside the owned process group', () => {
    const baseline = facts();
    proc.foreignReceived += 8192;
    const next = facts(baseline.processWork);
    expect(next.processWork).toBe(baseline.processWork);
    expect(next.protectedFromIdleAbort).toBe(false);
  });

  it('counts the first received bytes when the socket initially has no bytes_received field', () => {
    proc.omitReceiveCounter = true;
    const baseline = facts();
    proc.omitReceiveCounter = false;
    proc.received = 1;
    expect(facts(baseline.processWork).protectedFromIdleAbort).toBe(true);
  });

  it('does not grant idle protection when socket observations are unavailable', () => {
    const baseline = facts();
    proc.socketAvailable = false;
    proc.cpu += 200;
    const next = facts(baseline.processWork);
    expect(next.processWork).toBeUndefined();
    expect(next.protectedFromIdleAbort).toBe(false);
  });

  it('does not reset a frozen provider idle clock when socket sampling fails and recovers', async () => {
    const supervisor = monitor();
    await supervisor.tick();
    const lastProgressAt = savedProgress().stageProgress[stageId].lastProgressAt;
    for (let count = 1; count <= 4; count++) {
      vi.spyOn(Date, 'now').mockReturnValue(lastProgressAt + count * config.idleThresholdMs / 4);
      proc.socketAvailable = count % 2 === 0;
      await supervisor.tick();
      expect(savedProgress().stageProgress[stageId]).toMatchObject({ lastProgressAt, protectedFromIdleAbort: false });
    }
    expect(JSON.parse(readFileSync(signalPath(), 'utf8'))).toMatchObject({ source: 'watchdog', attemptIndex: 1 });
  });

  it('does not grant idle protection to a closed provider stream even if received bytes grow', () => {
    const baseline = facts();
    activity.close();
    proc.received += 8192;
    const next = facts(baseline.processWork);
    expect(next.protectedFromIdleAbort).toBe(false);
    expect(next.processDescription).toContain('stream closed');
  });

  it('rejects received bytes from a reused process identity', () => {
    const baseline = facts();
    proc.start = '7200';
    proc.received += 8192;
    const next = facts(baseline.processWork);
    expect(next.processWork).toBeUndefined();
    expect(next.protectedFromIdleAbort).toBe(false);
  });
});
