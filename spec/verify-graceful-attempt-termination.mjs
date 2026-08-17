import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  ATTEMPT_TERMINATION_GRACE_MS,
  execWithTimeout,
} from '../src/adapters/base.ts';

const TRIALS = 3;
const ORDINARY_TIMEOUT_MS = 1_200;

function fixturePid(path) {
  if (!existsSync(path)) return undefined;
  const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid ? pid : undefined;
}

function processIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hardStop(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
  }
}

async function waitForFile(path, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`fixture did not become ready: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (processIsAlive(pid) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processIsAlive(pid);
}

async function awaitBounded(execution, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      execution,
      new Promise((resolve, reject) => {
        void resolve;
        timer = setTimeout(
          () => reject(new Error('abort-first termination did not settle within its bound')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTrial(root, trial) {
  const readyPath = join(root, `ready-${trial}`);
  const pidPath = join(root, `pid-${trial}`);
  const termCountPath = join(root, `term-count-${trial}`);
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
  const controller = new AbortController();
  const execution = execWithTimeout(process.execPath, [
    '-e', fixture, readyPath, pidPath, termCountPath,
  ], {
    cwd: root,
    timeout_ms: ORDINARY_TIMEOUT_MS,
    abortSignal: controller.signal,
    env: { HOME: root, FC_HOME: join(root, 'fc-home') },
  });
  let pid;

  try {
    await waitForFile(readyPath, ORDINARY_TIMEOUT_MS - 200);
    pid = fixturePid(pidPath);
    const abortStarted = performance.now();
    controller.abort('supervisor_abort');
    const result = await awaitBounded(
      execution,
      ATTEMPT_TERMINATION_GRACE_MS + 2_500,
    );
    const reaped = await waitForExit(pid, 750);
    return {
      trial,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      termCount: existsSync(termCountPath)
        ? Number.parseInt(readFileSync(termCountPath, 'utf8'), 10)
        : 0,
      abortToSettlementMs: performance.now() - abortStarted,
      crossedOrdinaryTimeout: performance.now() - abortStarted > ORDINARY_TIMEOUT_MS,
      reaped,
    };
  } finally {
    hardStop(pid ?? fixturePid(pidPath));
    await execution.catch(() => undefined);
    await waitForExit(pid ?? fixturePid(pidPath), 750);
  }
}

if (process.platform === 'win32') {
  process.stdout.write('ABORT_FIRST_ESCALATION_SAMPLES={"skipped":"POSIX-only process-group probe"}\n');
} else {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-graceful-verify-'));
  try {
    const samples = await Promise.all(
      Array.from({ length: TRIALS }, (_, index) => runTrial(root, index + 1)),
    );
    const lowerBoundMs = ATTEMPT_TERMINATION_GRACE_MS - 150;
    const upperBoundMs = ATTEMPT_TERMINATION_GRACE_MS + 2_500;

    for (const sample of samples) {
      assert.equal(sample.exitCode, 137, 'abort-first result must preserve exit 137');
      assert.equal(sample.timedOut, false, 'cleanup latency must not relabel abort as timeout');
      assert.equal(sample.termCount, 1, 'competing timers must not send duplicate SIGTERM');
      assert.equal(sample.crossedOrdinaryTimeout, true, 'probe must cross the ordinary timeout boundary');
      assert.equal(sample.reaped, true, 'SIGTERM-ignoring fixture must be reaped after escalation');
      assert.ok(
        sample.abortToSettlementMs >= lowerBoundMs
          && sample.abortToSettlementMs <= upperBoundMs,
        'abort-first escalation must use one bounded grace interval',
      );
    }

    process.stdout.write(`ABORT_FIRST_ESCALATION_SAMPLES=${JSON.stringify(samples)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
