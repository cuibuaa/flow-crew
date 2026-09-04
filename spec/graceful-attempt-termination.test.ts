import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_TERMINATION_GRACE_MS,
  execWithStdin,
  execWithTimeout,
  resolveChildTerminationTiming,
  type Adapter,
  type AgentConfig,
  type RunResult,
} from '../src/adapters/base.js';
import {
  createRun,
  fcGlobalDir,
  readStageStatus,
  setFcGlobalDir,
} from '../src/store.js';
import { runStage } from '../src/worker.js';
import { ATTEMPT_CLOSE_OBSERVATION_TOLERANCE_MS } from '../src/attempt-deadline.js';

const CLEANUP_TRIALS = 3;
const FIXTURE_TIMEOUT_MS = 350;
const ABORT_FIXTURE_TIMEOUT_MS = 10_000;
const TEST_TERMINATION_GRACE_MS = 150;
const TEST_TERMINATION_TIMING = { graceMs: TEST_TERMINATION_GRACE_MS, pollMs: 5 } as const;

const FIXTURE_ROLE: AgentConfig = {
  name: 'fixture',
  description: 'graceful termination fixture',
  model: 'test',
  reasoning_effort: 'low',
  tools: [],
  prompt: 'fixture',
};

type ExecKind = 'without-stdin' | 'with-stdin';
type TerminationTrigger = 'timeout' | 'abort';

interface CleanupObservation {
  trial: number;
  execKind: ExecKind;
  trigger: TerminationTrigger;
  cleanupWritten: boolean;
  exitCode: number;
  timedOut: boolean;
  settlementElapsedMs: number;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`fixture did not become ready: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixturePid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const pid = Number.parseInt(readFileSync(path, 'utf-8'), 10);
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid ? pid : undefined;
}

function hardStopFixture(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch {
    // The test-owned fixture has already exited.
  }
}

async function awaitBounded(execution: Promise<RunResult>, timeoutMs: number): Promise<RunResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execution,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('adapter did not reap its fixture child')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runCleanupTrial(
  root: string,
  trial: number,
  execKind: ExecKind = 'without-stdin',
  trigger: TerminationTrigger = 'timeout',
): Promise<CleanupObservation> {
  const suffix = `${execKind}-${trigger}-${trial}`;
  const cleanupPath = join(root, `cleanup-${suffix}`);
  const readyPath = join(root, `ready-${suffix}`);
  const pidPath = join(root, `pid-${suffix}`);
  const fixture = [
    "const fs = require('node:fs');",
    'const [cleanupPath, readyPath, pidPath] = process.argv.slice(1);',
    "process.on('SIGTERM', () => {",
    "  fs.writeFileSync(cleanupPath, 'cleaned');",
    '  process.exit(0);',
    '});',
    "fs.writeFileSync(pidPath, String(process.pid));",
    "fs.writeFileSync(readyPath, 'ready');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const controller = trigger === 'abort' ? new AbortController() : undefined;
  const timeoutMs = trigger === 'abort' ? ABORT_FIXTURE_TIMEOUT_MS : FIXTURE_TIMEOUT_MS;
  const args = ['-e', fixture, cleanupPath, readyPath, pidPath];
  const opts = {
    cwd: root,
    timeout_ms: timeoutMs,
    env: {
      HOME: root,
      FC_HOME: join(root, 'fc-home'),
    },
    ...(controller ? { abortSignal: controller.signal } : {}),
    terminationTiming: TEST_TERMINATION_TIMING,
  };
  const settlementStarted = performance.now();
  const execution = execKind === 'with-stdin'
    ? execWithStdin(process.execPath, args, 'fixture input', opts)
    : execWithTimeout(process.execPath, args, opts);

  try {
    await waitForFile(readyPath, FIXTURE_TIMEOUT_MS - 100);
    controller?.abort('supervisor_abort');
    const result = await awaitBounded(
      execution,
      timeoutMs + TEST_TERMINATION_GRACE_MS + 2_000,
    );
    return {
      trial,
      execKind,
      trigger,
      cleanupWritten: existsSync(cleanupPath),
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      settlementElapsedMs: performance.now() - settlementStarted,
    };
  } finally {
    hardStopFixture(fixturePid(pidPath));
    await execution.catch(() => undefined);
  }
}

interface IgnoredSignalObservation {
  trial: number;
  trigger: 'timeout' | 'timeout_then_abort';
  exitCode: number;
  timedOut: boolean;
  termCount: number;
  settlementElapsedMs: number;
  survived: boolean;
}

interface DeadlineObservation {
  trial: number;
  exitCode: number;
  budgetMs: number;
  deadlineSpanMs: number;
  elapsedMs: number;
  deadlineOverrunMs: number;
  childClosed: boolean;
  cleanupWritten: boolean;
}

const IGNORE_TERM_TIMEOUT_MS = 350;

function processSurvived(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number | undefined, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (processSurvived(pid) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processSurvived(pid);
}

async function runIgnoredSignalTrial(
  root: string,
  trial: number,
  timeoutThenAbort: boolean,
): Promise<IgnoredSignalObservation> {
  const trigger = timeoutThenAbort ? 'timeout_then_abort' : 'timeout';
  const suffix = `${trigger}-${trial}`;
  const readyPath = join(root, `ignore-ready-${suffix}`);
  const pidPath = join(root, `ignore-pid-${suffix}`);
  const termCountPath = join(root, `ignore-terms-${suffix}`);
  const fixture = [
    "const fs = require('node:fs');",
    'const [readyPath, pidPath, termCountPath] = process.argv.slice(1);',
    'let termCount = 0;',
    "process.on('SIGTERM', () => {",
    '  termCount += 1;',
    '  fs.writeFileSync(termCountPath, String(termCount));',
    '});',
    "fs.writeFileSync(pidPath, String(process.pid));",
    "fs.writeFileSync(readyPath, 'ready');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const controller = timeoutThenAbort ? new AbortController() : undefined;
  const settlementStarted = performance.now();
  const execution = execWithTimeout(process.execPath, [
    '-e', fixture, readyPath, pidPath, termCountPath,
  ], {
    cwd: root,
    timeout_ms: IGNORE_TERM_TIMEOUT_MS,
    env: {
      HOME: root,
      FC_HOME: join(root, 'fc-home'),
    },
    ...(controller ? { abortSignal: controller.signal } : {}),
    terminationTiming: TEST_TERMINATION_TIMING,
  });
  let abortTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    await waitForFile(readyPath, IGNORE_TERM_TIMEOUT_MS - 50);
    if (controller) {
      // Schedule from the execution deadline, not from readiness observation.
      // Under full-suite load the latter can consume most of the short local
      // grace and let SIGKILL settle before the intended timeout/abort race.
      const abortAt = settlementStarted
        + IGNORE_TERM_TIMEOUT_MS
        + Math.floor(TEST_TERMINATION_GRACE_MS / 2);
      abortTimer = setTimeout(
        () => controller.abort('supervisor_abort'),
        Math.max(0, abortAt - performance.now()),
      );
    }
    const result = await awaitBounded(
      execution,
      IGNORE_TERM_TIMEOUT_MS + TEST_TERMINATION_GRACE_MS + 2_500,
    );
    const pid = fixturePid(pidPath);
    return {
      trial,
      trigger,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      termCount: existsSync(termCountPath)
        ? Number.parseInt(readFileSync(termCountPath, 'utf-8'), 10)
        : 0,
      settlementElapsedMs: performance.now() - settlementStarted,
      survived: processSurvived(pid),
    };
  } finally {
    clearTimeout(abortTimer);
    hardStopFixture(fixturePid(pidPath));
    await execution.catch(() => undefined);
  }
}

describe.skipIf(process.platform === 'win32')('graceful attempt termination', () => {
  it('lets a timed-out child run its SIGTERM cleanup handler', { timeout: 10_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-graceful-cleanup-'));
    try {
      const observations: CleanupObservation[] = [];
      expect(resolveChildTerminationTiming().graceMs).toBe(ATTEMPT_TERMINATION_GRACE_MS);
      for (let trial = 1; trial <= CLEANUP_TRIALS; trial++) {
        observations.push(await runCleanupTrial(root, trial));
      }
      process.stdout.write(`GRACEFUL_CLEANUP_SAMPLES=${JSON.stringify(observations)}\n`);

      expect(observations.map(({ cleanupWritten }) => cleanupWritten)).toEqual([true, true, true]);
      expect(observations.map(({ exitCode }) => exitCode)).toEqual([124, 124, 124]);
      expect(observations.every(({ timedOut }) => timedOut)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies graceful cleanup to stdin timeouts and both supervisor-abort paths', { timeout: 15_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-graceful-matrix-'));
    try {
      const observations: CleanupObservation[] = [];
      for (let trial = 1; trial <= CLEANUP_TRIALS; trial++) {
        observations.push(await runCleanupTrial(root, trial, 'with-stdin', 'timeout'));
      }
      for (const execKind of ['without-stdin', 'with-stdin'] as const) {
        for (let trial = 1; trial <= CLEANUP_TRIALS; trial++) {
          observations.push(await runCleanupTrial(root, trial, execKind, 'abort'));
        }
      }
      process.stdout.write(`GRACEFUL_TRIGGER_MATRIX=${JSON.stringify(observations)}\n`);

      expect(observations.every(({ cleanupWritten }) => cleanupWritten)).toBe(true);
      expect(observations.filter(({ trigger }) => trigger === 'timeout')
        .every(({ exitCode, timedOut }) => exitCode === 124 && timedOut)).toBe(true);
      expect(observations.filter(({ trigger }) => trigger === 'abort')
        .every(({ exitCode, timedOut }) => exitCode === 137 && !timedOut)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('SIGKILLs children that ignore SIGTERM after one bounded grace interval', { timeout: 12_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-graceful-ignore-'));
    try {
      const [timeoutSamples, raceSamples] = await Promise.all([
        Promise.all(Array.from({ length: CLEANUP_TRIALS }, (_, index) => (
          runIgnoredSignalTrial(root, index + 1, false)
        ))),
        Promise.all(Array.from({ length: CLEANUP_TRIALS }, (_, index) => (
          runIgnoredSignalTrial(root, index + 1, true)
        ))),
      ]);
      const observations = [...timeoutSamples, ...raceSamples];
      process.stdout.write(`SIGTERM_IGNORED_SAMPLES=${JSON.stringify(observations)}\n`);

      const minimumEscalationDuration = IGNORE_TERM_TIMEOUT_MS
        + TEST_TERMINATION_GRACE_MS - 100;
      const maximumEscalationDuration = IGNORE_TERM_TIMEOUT_MS
        + TEST_TERMINATION_GRACE_MS + 3_000;
      expect(observations.every(({ termCount }) => termCount === 1)).toBe(true);
      expect(observations.every(({ survived }) => !survived)).toBe(true);
      expect(observations.every(({ settlementElapsedMs }) => (
        settlementElapsedMs >= minimumEscalationDuration
        && settlementElapsedMs <= maximumEscalationDuration
      ))).toBe(true);
      expect(timeoutSamples.every(({ exitCode, timedOut }) => exitCode === 124 && timedOut)).toBe(true);
      expect(raceSamples.every(({ exitCode, timedOut }) => exitCode === 137 && timedOut)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('waits for escalation when a cleanly exiting leader leaves an ignoring descendant', { timeout: 12_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-graceful-descendant-'));
    const cleanupPath = join(root, 'leader-cleanup');
    const readyPath = join(root, 'leader-ready');
    const pidPath = join(root, 'leader-pid');
    const descendantReadyPath = join(root, 'descendant-ready');
    const descendantPidPath = join(root, 'descendant-pid');
    const descendantTermPath = join(root, 'descendant-term');
    const fixture = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      'const [cleanupPath, readyPath, pidPath, descendantReadyPath, descendantPidPath, descendantTermPath] = process.argv.slice(1);',
      'const descendantFixture = [',
      "  \"const fs = require('node:fs');\",",
      "  'const [readyPath, pidPath, termPath] = process.argv.slice(1);',",
      "  \"process.on('SIGTERM', () => fs.writeFileSync(termPath, 'term'));\",",
      "  \"fs.writeFileSync(pidPath, String(process.pid));\",",
      "  \"fs.writeFileSync(readyPath, 'ready');\",",
      "  'setInterval(() => {}, 1000);',",
      "].join('\\n');",
      "process.on('SIGTERM', () => {",
      "  fs.writeFileSync(cleanupPath, 'cleaned');",
      '  process.exit(0);',
      '});',
      "spawn(process.execPath, ['-e', descendantFixture, descendantReadyPath, descendantPidPath, descendantTermPath], { stdio: 'ignore' });",
      'const readyTimer = setInterval(() => {',
      '  if (!fs.existsSync(descendantReadyPath)) return;',
      '  clearInterval(readyTimer);',
      "  fs.writeFileSync(pidPath, String(process.pid));",
      "  fs.writeFileSync(readyPath, 'ready');",
      '}, 10);',
    ].join('\n');
    const settlementStarted = performance.now();
    const execution = execWithTimeout(process.execPath, [
      '-e', fixture, cleanupPath, readyPath, pidPath,
      descendantReadyPath, descendantPidPath, descendantTermPath,
    ], {
      cwd: root,
      timeout_ms: FIXTURE_TIMEOUT_MS,
      env: { HOME: root, FC_HOME: join(root, 'fc-home') },
      terminationTiming: TEST_TERMINATION_TIMING,
    });

    try {
      await waitForFile(readyPath, FIXTURE_TIMEOUT_MS - 100);
      const result = await awaitBounded(
        execution,
        FIXTURE_TIMEOUT_MS + TEST_TERMINATION_GRACE_MS + 2_000,
      );
      expect(result.exitCode).toBe(124);
      expect(performance.now() - settlementStarted).toBeGreaterThanOrEqual(
        FIXTURE_TIMEOUT_MS + TEST_TERMINATION_GRACE_MS - 100,
      );
      expect(existsSync(cleanupPath)).toBe(true);
      expect(existsSync(descendantTermPath)).toBe(true);
      expect(await waitForProcessExit(fixturePid(descendantPidPath), 2_000)).toBe(true);
    } finally {
      hardStopFixture(fixturePid(pidPath));
      hardStopFixture(fixturePid(descendantPidPath));
      await execution.catch(() => undefined);
      await waitForProcessExit(fixturePid(descendantPidPath), 2_000);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records post-deadline cleanup as real overrun without moving the immutable deadline', { timeout: 15_000 }, async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'flowcrew-graceful-deadline-project-'));
    const stateRoot = mkdtempSync(join(tmpdir(), 'flowcrew-graceful-deadline-state-'));
    const previousStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    try {
      const budgetMs = 600;
      const observations: DeadlineObservation[] = [];
      for (let trial = 1; trial <= CLEANUP_TRIALS; trial++) {
        const stageId = `deadline_${trial}`;
        const created = createRun(projectRoot, 'graceful-deadline', 'name: graceful-deadline', [stageId]);
        const cleanupPath = join(projectRoot, `deadline-cleanup-${trial}`);
        const readyPath = join(projectRoot, `deadline-ready-${trial}`);
        const pidPath = join(projectRoot, `deadline-pid-${trial}`);
        const fixture = [
          "const fs = require('node:fs');",
          'const [cleanupPath, readyPath, pidPath] = process.argv.slice(1);',
          "process.on('SIGTERM', () => {",
          "  fs.writeFileSync(cleanupPath, 'cleaned');",
          '  setTimeout(() => process.exit(0), 120);',
          '});',
          "fs.writeFileSync(pidPath, String(process.pid));",
          "fs.writeFileSync(readyPath, 'ready');",
          'setInterval(() => {}, 1000);',
        ].join('\n');
        let adapterExecution: Promise<RunResult> | undefined;
        const adapter: Adapter = {
          async run(_prompt, _role, opts) {
            adapterExecution = execWithTimeout(process.execPath, [
              '-e', fixture, cleanupPath, readyPath, pidPath,
            ], {
              cwd: projectRoot,
              timeout_ms: opts.timeout_ms,
              abortSignal: opts.abortSignal,
              env: {
                HOME: projectRoot,
                FC_HOME: stateRoot,
              },
            });
            return adapterExecution;
          },
        };

        try {
          const result = await runStage(adapter, {
            stageId,
            role: FIXTURE_ROLE,
            dependsOn: [],
            promptTemplate: 'deadline fixture',
            timeout_ms: budgetMs,
            projectDir: projectRoot,
            runId: created.runId,
            runDir: created.runDirPath,
            retries: 0,
          });
          const status = readStageStatus(projectRoot, created.runId, stageId);
          const timeout = status.timeout;
          if (!timeout) throw new Error('missing attempt deadline record');
          observations.push({
            trial,
            exitCode: result.exitCode,
            budgetMs: timeout.budgetMs,
            deadlineSpanMs: Date.parse(timeout.deadlineAt) - Date.parse(timeout.attemptStartedAt),
            elapsedMs: timeout.elapsedMs,
            deadlineOverrunMs: timeout.deadlineOverrunMs ?? 0,
            childClosed: Boolean(timeout.childClosedAt),
            cleanupWritten: existsSync(cleanupPath),
          });
          expect(status.error).toContain('timed out after');
          expect(timeout.terminationCause).toBe('attempt_timeout');
          expect(timeout.remainingMs).toBe(0);
        } finally {
          hardStopFixture(fixturePid(pidPath));
          await adapterExecution?.catch(() => undefined);
        }
      }
      process.stdout.write(`DEADLINE_SETTLEMENT_SAMPLES=${JSON.stringify(observations)}\n`);

      expect(observations.every(({ exitCode }) => exitCode === 124)).toBe(true);
      expect(observations.every(({ budgetMs, deadlineSpanMs }) => (
        budgetMs === 600 && deadlineSpanMs === budgetMs
      ))).toBe(true);
      expect(observations.every(({ elapsedMs, budgetMs }) => elapsedMs >= budgetMs)).toBe(true);
      expect(observations.every(({ deadlineOverrunMs }) => (
        deadlineOverrunMs > 0
        && deadlineOverrunMs <= ATTEMPT_CLOSE_OBSERVATION_TOLERANCE_MS
      ))).toBe(true);
      expect(observations.every(({ childClosed, cleanupWritten }) => childClosed && cleanupWritten)).toBe(true);
    } finally {
      setFcGlobalDir(previousStateRoot);
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('preserves supervisor-abort exit 137 and attribution while allowing cleanup', { timeout: 8_000 }, async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'flowcrew-graceful-abort-project-'));
    const stateRoot = mkdtempSync(join(tmpdir(), 'flowcrew-graceful-abort-state-'));
    const previousStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const stageId = 'supervisor_abort';
    const created = createRun(projectRoot, 'graceful-abort', 'name: graceful-abort', [stageId]);
    mkdirSync(join(created.runDirPath, 'signals'), { recursive: true });
    const cleanupPath = join(projectRoot, 'abort-cleanup');
    const readyPath = join(projectRoot, 'abort-ready');
    const pidPath = join(projectRoot, 'abort-pid');
    const fixture = [
      "const fs = require('node:fs');",
      'const [cleanupPath, readyPath, pidPath] = process.argv.slice(1);',
      "process.on('SIGTERM', () => {",
      "  fs.writeFileSync(cleanupPath, 'cleaned');",
      '  process.exit(0);',
      '});',
      "fs.writeFileSync(pidPath, String(process.pid));",
      "fs.writeFileSync(readyPath, 'ready');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    let adapterExecution: Promise<RunResult> | undefined;
    const adapter: Adapter = {
      async run(_prompt, _role, opts) {
        adapterExecution = execWithTimeout(process.execPath, [
          '-e', fixture, cleanupPath, readyPath, pidPath,
        ], {
          cwd: projectRoot,
          timeout_ms: opts.timeout_ms,
          abortSignal: opts.abortSignal,
          env: {
            HOME: projectRoot,
            FC_HOME: stateRoot,
          },
        });
        await waitForFile(readyPath, 1_000);
        writeFileSync(join(created.runDirPath, 'signals', `abort_${stageId}.json`), JSON.stringify({
          version: 1,
          stageId,
          attemptIndex: 1,
          reason: 'fixture supervisor decision',
          timestamp: new Date().toISOString(),
          source: 'supervisor',
        }));
        return adapterExecution;
      },
    };

    try {
      const result = await runStage(adapter, {
        stageId,
        role: FIXTURE_ROLE,
        dependsOn: [],
        promptTemplate: 'supervisor abort fixture',
        timeout_ms: 7_000,
        projectDir: projectRoot,
        runId: created.runId,
        runDir: created.runDirPath,
        retries: 0,
      });
      const status = readStageStatus(projectRoot, created.runId, stageId);
      expect(result.exitCode).toBe(137);
      expect(status.error).toBe('aborted by supervisor: fixture supervisor decision');
      expect(status.timeout?.terminationCause).toBe('supervisor_abort');
      expect(status.timeout?.deadlineReachedAt).toBeUndefined();
      expect(status.timeout?.deadlineOverrunMs).toBe(0);
      expect(existsSync(cleanupPath)).toBe(true);
    } finally {
      hardStopFixture(fixturePid(pidPath));
      await adapterExecution?.catch(() => undefined);
      setFcGlobalDir(previousStateRoot);
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('settles early exits and spawn errors, while keeping the post-result handle forceful', { timeout: 5_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-graceful-lifecycle-'));
    const readyPath = join(root, 'hard-ready');
    const pidPath = join(root, 'hard-pid');
    const termPath = join(root, 'hard-term');
    let hardKill: (() => void) | undefined;
    let hardExecution: Promise<RunResult> | undefined;
    try {
      const earlyAbort = new AbortController();
      const early = await execWithTimeout(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: root,
        timeout_ms: ABORT_FIXTURE_TIMEOUT_MS,
        abortSignal: earlyAbort.signal,
        env: { HOME: root, FC_HOME: join(root, 'fc-home') },
      });
      expect(early).toMatchObject({ exitCode: 0, timedOut: false });
      earlyAbort.abort('after_settlement');

      const spawnFailure = await execWithTimeout(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: join(root, 'missing-working-directory'),
        timeout_ms: ABORT_FIXTURE_TIMEOUT_MS,
        env: { HOME: root, FC_HOME: join(root, 'fc-home') },
      });
      expect(spawnFailure.exitCode).toBe(1);

      const fixture = [
        "const fs = require('node:fs');",
        'const [readyPath, pidPath, termPath] = process.argv.slice(1);',
        "process.on('SIGTERM', () => fs.writeFileSync(termPath, 'term'));",
        "fs.writeFileSync(pidPath, String(process.pid));",
        "fs.writeFileSync(readyPath, 'ready');",
        'setInterval(() => {}, 1000);',
      ].join('\n');
      hardExecution = execWithStdin(process.execPath, [
        '-e', fixture, readyPath, pidPath, termPath,
      ], 'fixture input', {
        cwd: root,
        timeout_ms: ABORT_FIXTURE_TIMEOUT_MS,
        env: { HOME: root, FC_HOME: join(root, 'fc-home') },
        onChild: (handles) => { hardKill = handles.kill; },
      });
      await waitForFile(readyPath, 1_000);
      if (!hardKill) throw new Error('post-result hard-kill handle was not supplied');
      hardKill();
      const hardResult = await awaitBounded(hardExecution, 2_000);
      expect(hardResult.exitCode).toBe(1);
      expect(hardResult.timedOut).toBe(false);
      expect(existsSync(termPath)).toBe(false);
      expect(processSurvived(fixturePid(pidPath))).toBe(false);
    } finally {
      hardStopFixture(fixturePid(pidPath));
      await hardExecution?.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
