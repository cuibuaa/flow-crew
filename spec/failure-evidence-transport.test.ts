import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRealityGateReport } from '../src/reality-gate/index.js';
import type { RealityGateExit, RealityGateReport } from '../src/reality-gate/types.js';
import {
  createRun,
  enforceRealityGateBeforeTerminal,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';

interface ExpectedExecution {
  command: string;
  stdout: string;
  stderr: string;
  exit: RealityGateExit;
}

let fixtureRoot: string;
let projectDir: string;
let previousFcGlobalDir: string;

beforeEach(() => {
  previousFcGlobalDir = fcGlobalDir();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-p2-m4-'));
  projectDir = join(fixtureRoot, 'project');
  mkdirSync(projectDir, { recursive: true });
  setFcGlobalDir(join(fixtureRoot, 'fc-home'));
});

afterEach(() => {
  setFcGlobalDir(previousFcGlobalDir);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeExecCheck(runId: string, name: string, command: string): void {
  const indentedCommand = command.split('\n').map((line) => `        ${line}`);
  writeFileSync(join(runDir(projectDir, runId), 'reality_checks.md'), [
    '## Reality checks',
    'checks:',
    `  - name: ${name}`,
    '    type: exec-script-exit-zero',
    '    params:',
    '      script: |-',
    ...indentedCommand,
  ].join('\n'), 'utf-8');
}

function replayExpectedExecution(
  artifactPath: string,
  expected: ExpectedExecution,
): { report: RealityGateReport; evidence: Record<string, unknown> } {
  const report = readRealityGateReport(artifactPath);
  if (report.pass !== false || report.checksRun !== 1 || report.results.length !== 1) {
    throw new Error('fixture verdict mismatch');
  }
  const evidence = report.results[0].evidence as Record<string, unknown> | undefined;
  if (!evidence) throw new Error('fixture evidence missing');
  if (evidence.command !== expected.command) throw new Error('command mismatch');
  if (evidence.stdout !== expected.stdout) throw new Error('stdout mismatch');
  if (evidence.stderr !== expected.stderr) throw new Error('stderr mismatch');
  if (JSON.stringify(evidence.exit) !== JSON.stringify(expected.exit)) throw new Error('exit mismatch');
  return { report, evidence };
}

function outputLineCount(value: string): number {
  if (value.length === 0) return 0;
  const breaks = value.match(/\r\n|\r|\n/g)?.length ?? 0;
  return breaks + (/\r\n$|\r$|\n$/.test(value) ? 0 : 1);
}

describe('failure evidence transport', () => {
  it('adjudicates only replayed durable evidence while display output stays bounded', async () => {
    const failureCommand = [
      'token=m4-fixture-sensitive-literal',
      'AWS_SECRET_ACCESS_KEY=m4-fixture-aws-sensitive-literal',
      'TOKEN_COUNT=5',
      'private_root="$(mktemp -d)"',
      'trap \'rm -rf "$private_root"\' EXIT',
      'printf private-log > "$private_root/check.log"',
      'rm -f "$private_root/check.log"',
      "printf 'm4-stdout-distinct\\nm4-terminal-verdict: FAIL\\n'",
      "printf 'm4-stderr-distinct\\n' >&2",
      'exit 23',
    ].join('\n');
    const failureStdout = 'm4-stdout-distinct\nm4-terminal-verdict: FAIL\n';
    const failureStderr = 'm4-stderr-distinct\n';
    const failureExit: RealityGateExit = { code: 23, signal: null, timedOut: false };
    const failureRun = createRun(projectDir, 'p2-m4-failure', 'name: p2-m4-failure', []);
    writeExecCheck(failureRun.runId, 'deleted-private-log-failure', failureCommand);

    const deceptiveState = readRunState(projectDir, failureRun.runId);
    deceptiveState.status = 'complete';
    deceptiveState.realityGate = {
      artifactPath: 'run.json#deceptive-display-only',
      pass: true,
      checkedAt: '2026-08-04T00:00:00.000Z',
      checksRun: 1,
      results: [{
        name: 'deceptive-display-summary',
        type: 'display-only',
        pass: true,
        advisory: false,
        details: 'PASS',
      }],
    };
    writeRunState(projectDir, failureRun.runId, deceptiveState);

    const failureGate = await enforceRealityGateBeforeTerminal(
      projectDir,
      failureRun.runId,
      deceptiveState,
      'complete',
    );
    const failureArtifact = join(runDir(projectDir, failureRun.runId), '.reality-gate.json');
    expect(statSync(failureArtifact).size).toBeGreaterThan(0);
    const failureArtifactRaw = readFileSync(failureArtifact, 'utf-8');
    if (!failureArtifactRaw.includes('TOKEN_COUNT=5')) {
      throw new Error('benign TOKEN_COUNT assignment was not preserved');
    }
    const replayedFailure = replayExpectedExecution(failureArtifact, {
      command: failureCommand
        .replace('token=m4-fixture-sensitive-literal', 'token=[redacted]')
        .replace(
          'AWS_SECRET_ACCESS_KEY=m4-fixture-aws-sensitive-literal',
          'AWS_SECRET_ACCESS_KEY=[redacted]',
        ),
      stdout: failureStdout,
      stderr: failureStderr,
      exit: failureExit,
    });

    expect(failureGate.allowed).toBe(false);
    expect(failureGate.report).toEqual(replayedFailure.report);
    expect(replayedFailure.report.results[0]).toMatchObject({
      name: 'deleted-private-log-failure',
      type: 'exec-script-exit-zero',
      pass: false,
      details: 'script exited 23',
    });
    expect(replayedFailure.evidence).toMatchObject({
      command: expect.stringContaining('rm -f "$private_root/check.log"'),
      stdout: failureStdout,
      stderr: failureStderr,
      code: 23,
      signal: null,
      timedOut: false,
      exit: failureExit,
    });
    expect(replayedFailure.evidence).not.toHaveProperty('env');
    expect(replayedFailure.evidence).not.toHaveProperty('environment');
    expect(failureArtifactRaw).not.toContain('m4-fixture-sensitive-literal');
    expect(failureArtifactRaw).not.toContain('m4-fixture-aws-sensitive-literal');
    expect(readRunState(projectDir, failureRun.runId)).toMatchObject({
      status: 'reality_gate_failed',
      realityGate: {
        artifactPath: '.reality-gate.json',
        pass: false,
        results: [{ exit: failureExit }],
      },
    });

    const longPrefixChars = 7_000;
    const startSentinel = 'M4-LONG-OUTPUT-START';
    const deceptivePass = 'DISPLAY SUMMARY SAYS PASS';
    const finalVerdict = 'M4-FINAL-VERDICT: FAIL exit=41';
    const longStdout = [
      startSentinel,
      'x'.repeat(longPrefixChars),
      deceptivePass,
      finalVerdict,
      '',
    ].join('\n');
    const longStderr = 'm4-long-stderr\n';
    const longExit: RealityGateExit = { code: 41, signal: null, timedOut: false };
    const longCommand = [
      `printf '${startSentinel}\\n'`,
      `printf 'x%.0s' {1..${longPrefixChars}}`,
      "printf '\\nDISPLAY SUMMARY SAYS PASS\\n'",
      `printf '${finalVerdict}\\n'`,
      "printf 'm4-long-stderr\\n' >&2",
      'exit 41',
    ].join('\n');
    const longRun = createRun(projectDir, 'p2-m4-long', 'name: p2-m4-long', []);
    writeExecCheck(longRun.runId, 'long-prefix-final-failure', longCommand);
    const longState = readRunState(projectDir, longRun.runId);
    longState.status = 'complete';

    const longGate = await enforceRealityGateBeforeTerminal(
      projectDir,
      longRun.runId,
      longState,
      'complete',
    );
    const longArtifact = join(runDir(projectDir, longRun.runId), '.reality-gate.json');
    const replayedLong = replayExpectedExecution(longArtifact, {
      command: longCommand,
      stdout: longStdout,
      stderr: longStderr,
      exit: longExit,
    });
    expect(longGate.allowed).toBe(false);
    expect(longGate.report).toEqual(replayedLong.report);
    expect(replayedLong.evidence.stdout).toContain(startSentinel);
    expect(replayedLong.evidence.stdout).toContain(deceptivePass);
    expect(replayedLong.evidence.stdout).toMatch(new RegExp(`${finalVerdict.replace('=', '\\=')}\\n$`));
    expect((replayedLong.evidence.stdout as string).length).toBe(longStdout.length);

    const longDisplay = readRunState(projectDir, longRun.runId).realityGate;
    const stdoutDisplay = longDisplay?.results[0].stdout;
    expect(longDisplay?.artifactPath).toBe('.reality-gate.json');
    expect(longDisplay?.results[0].exit).toEqual(longExit);
    expect(stdoutDisplay).toMatchObject({
      sourceChars: longStdout.length,
      sourceLines: outputLineCount(longStdout),
      capturedChars: 2_048,
      truncated: true,
    });
    expect(stdoutDisplay?.capturedLines).toBe(outputLineCount(stdoutDisplay?.tail ?? ''));
    expect(stdoutDisplay?.tail).not.toContain(startSentinel);
    expect(stdoutDisplay?.tail).toContain(deceptivePass);
    expect(stdoutDisplay?.tail).toMatch(new RegExp(`${finalVerdict.replace('=', '\\=')}\\n$`));

    const headOnlyReport = JSON.parse(JSON.stringify(replayedLong.report)) as RealityGateReport;
    (headOnlyReport.results[0].evidence as Record<string, unknown>).stdout = [
      startSentinel,
      'x'.repeat(longPrefixChars),
      deceptivePass,
      '',
    ].join('\n');
    const headOnlyArtifact = join(fixtureRoot, 'head-only.reality-gate.json');
    writeFileSync(headOnlyArtifact, JSON.stringify(headOnlyReport), 'utf-8');

    const tailOnlyReport = JSON.parse(JSON.stringify(replayedLong.report)) as RealityGateReport;
    (tailOnlyReport.results[0].evidence as Record<string, unknown>).stdout = [
      'x'.repeat(longPrefixChars),
      deceptivePass,
      finalVerdict,
      '',
    ].join('\n');
    const tailOnlyArtifact = join(fixtureRoot, 'tail-only.reality-gate.json');
    writeFileSync(tailOnlyArtifact, JSON.stringify(tailOnlyReport), 'utf-8');

    const expectedLong: ExpectedExecution = {
      command: longCommand,
      stdout: longStdout,
      stderr: longStderr,
      exit: longExit,
    };
    expect(() => replayExpectedExecution(headOnlyArtifact, expectedLong)).toThrow('stdout mismatch');
    expect(() => replayExpectedExecution(tailOnlyArtifact, expectedLong)).toThrow('stdout mismatch');

    process.stdout.write(`H-M4=green C-M4=0 evidence-transport=${JSON.stringify({
      artifactPath: longDisplay?.artifactPath,
      exit: longDisplay?.results[0].exit,
      rawChars: stdoutDisplay?.sourceChars,
      displayChars: stdoutDisplay?.capturedChars,
      rawLines: stdoutDisplay?.sourceLines,
      displayLines: stdoutDisplay?.capturedLines,
      negativeMutantsRejected: 2,
    })}\n`);
  });

  it('preserves a multibyte long stderr through the durable artifact', async () => {
    const startSentinel = 'M4-STDERR-START';
    const repeated = '界'.repeat(5_000);
    const finalVerdict = 'M4-STDERR-FINAL-VERDICT: FAIL';
    const command = [
      "printf 'm4-short-stdout\\n'",
      `printf '${startSentinel}\\n' >&2`,
      "printf '界%.0s' {1..5000} >&2",
      `printf '\\n${finalVerdict}\\n' >&2`,
      'exit 53',
    ].join('\n');
    const stderr = `${startSentinel}\n${repeated}\n${finalVerdict}\n`;
    const exit: RealityGateExit = { code: 53, signal: null, timedOut: false };
    const created = createRun(projectDir, 'p2-m4-long-stderr', 'name: p2-m4-long-stderr', []);
    writeExecCheck(created.runId, 'long-stderr-final-failure', command);
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');
    const artifactPath = join(runDir(projectDir, created.runId), '.reality-gate.json');
    const replayed = replayExpectedExecution(artifactPath, {
      command,
      stdout: 'm4-short-stdout\n',
      stderr,
      exit,
    });
    const display = readRunState(projectDir, created.runId).realityGate?.results[0].stderr;

    expect(gate.allowed).toBe(false);
    expect(replayed.evidence.stderr).toBe(stderr);
    expect(display).toMatchObject({
      sourceChars: stderr.length,
      sourceLines: outputLineCount(stderr),
      capturedChars: 2_048,
      truncated: true,
    });
    expect(display?.tail).not.toContain(startSentinel);
    expect(display?.tail).toMatch(new RegExp(`${finalVerdict}\\n$`));
  });

  it('does not authorize a durable pass claim backed by a nonzero exit', () => {
    const forgedArtifact = join(fixtureRoot, 'forged-pass.reality-gate.json');
    writeFileSync(forgedArtifact, JSON.stringify({
      pass: true,
      checkedAt: '2026-08-04T00:00:00.000Z',
      checksRun: 1,
      results: [{
        name: 'forged-pass',
        type: 'exec-script-exit-zero',
        pass: true,
        details: 'forged display says pass',
        evidence: {
          command: 'exit 9',
          stdout: 'M4-FINAL-VERDICT: FAIL\n',
          stderr: '',
          code: 9,
          signal: null,
          timedOut: false,
          exit: { code: 9, signal: null, timedOut: false },
        },
      }],
    }), 'utf-8');

    let authorized = false;
    try {
      authorized = readRealityGateReport(forgedArtifact).pass;
    } catch {
      authorized = false;
    }
    expect(authorized).toBe(false);
  });
});
