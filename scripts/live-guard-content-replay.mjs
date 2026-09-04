#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { runWorkflow } from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';

const EXPECTED_EVIDENCE = {
  bytes: 513_384_558,
  sha256: 'c741a41b83956785fa32488fe412719e2db2416e315ec5ba51e032e89a545c2f',
  firstLineBytes: 163_347,
  firstLineSha256: 'dd4e3473e735053b437beddf4161c91bd1bebf1809109089b3c6eb61e450642b',
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    args[token.slice(2)] = value;
    index++;
  }
  return args;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', (chunk) => hash.update(chunk));
  await once(stream, 'end');
  return hash.digest('hex');
}

async function readFirstLine(path) {
  const stream = createReadStream(path);
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const newline = chunk.indexOf(0x0a);
    if (newline < 0) {
      chunks.push(chunk);
      length += chunk.length;
      continue;
    }
    chunks.push(chunk.subarray(0, newline + 1));
    length += newline + 1;
    stream.destroy();
    break;
  }
  const bytes = Buffer.concat(chunks, length);
  return { bytes, record: JSON.parse(bytes.subarray(0, -1).toString('utf8')) };
}

async function anchorEvidence(path) {
  if (!path) throw new Error('--evidence is required');
  const stat = statSync(path);
  const [sha256, first] = await Promise.all([hashFile(path), readFirstLine(path)]);
  const firstLineSha256 = createHash('sha256').update(first.bytes).digest('hex');
  const actual = {
    bytes: stat.size,
    sha256,
    firstLineBytes: first.bytes.length,
    firstLineSha256,
  };
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_EVIDENCE)) {
    throw new Error(`evidence identity mismatch: ${JSON.stringify(actual)}`);
  }
  const record = first.record;
  if (record.trigger !== 'fallback'
    || !Array.isArray(record.effectiveScope)
    || record.effectiveScope.length !== 0
    || record.writeObservedAt !== record.detectedAt
    || record.detectionLatencyMs !== 0
    || record.restored !== false
    || typeof record.path !== 'string') {
    throw new Error('first recorded incident does not satisfy its byte-anchored contract');
  }
  const normalized = record.path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`recorded path is not fixture-safe: ${record.path}`);
  }
  return { ...actual, path: normalized, trigger: record.trigger, effectiveScope: record.effectiveScope };
}

function git(projectDir, args) {
  return execFileSync('git', args, {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
}

function fixtureConfig(scope, suffix) {
  const config = {
    name: `live-guard-content-${suffix}`,
    defaults: { max_iterations: 1, max_retries: 0 },
    stages: [{
      id: 'scout', role: 'scout', scope, depends_on: [],
      prompt_template: 'Inspect the fixture and obey the declared project-write scope.',
      skills: [], dynamic_dispatch: false, is_gate: false,
    }],
  };
  const renderedScope = scope.map((path) => JSON.stringify(path)).join(', ');
  const yaml = [
    `name: live-guard-content-${suffix}`,
    'defaults:',
    '  max_iterations: 1',
    '  max_retries: 0',
    'stages:',
    '  - id: scout',
    '    role: scout',
    `    scope: [${renderedScope}]`,
    '    depends_on: []',
    '    prompt_template: Inspect the fixture and obey the declared project-write scope.',
  ].join('\n');
  return { config, yaml };
}

function createFixture(recordedPath, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-live-content-replay-'));
  const projectDir = join(root, 'project');
  const stateDir = join(root, 'state');
  mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
  writeFileSync(join(projectDir, 'config', 'agents', 'scout.yaml'), [
    'name: scout',
    'description: deterministic content-guard replay',
    'model: default',
    'reasoning_effort: low',
    'tools: []',
    'prompt: fixture',
  ].join('\n'));
  const target = join(projectDir, recordedPath);
  mkdirSync(dirname(target), { recursive: true });
  const preimage = Buffer.from('# byte-stable recorded-incident fixture\n', 'utf8');
  writeFileSync(target, preimage);
  chmodSync(join(projectDir, 'config', 'defaults.yaml'), 0o644);
  chmodSync(join(projectDir, 'config', 'agents', 'scout.yaml'), 0o644);
  chmodSync(target, 0o644);
  if (options.largePreimage) {
    writeFileSync(join(projectDir, 'tracked-large.bin'), Buffer.alloc(65 * 1024 * 1024, 0x61));
    chmodSync(join(projectDir, 'tracked-large.bin'), 0o644);
  }
  git(projectDir, ['init', '--quiet']);
  git(projectDir, ['config', 'user.name', 'FlowCrew Replay']);
  git(projectDir, ['config', 'user.email', 'replay@example.invalid']);
  git(projectDir, ['add', '--all']);
  git(projectDir, ['commit', '--quiet', '-m', 'fixture preimage']);
  git(projectDir, ['config', 'core.fileMode', 'false']);
  return { root, projectDir, stateDir, target, preimage };
}

function incidentsFor(runDirPath) {
  const stageDir = join(runDirPath, 'stages', 'scout');
  let names = [];
  try { names = readdirSync(stageDir); } catch { return []; }
  return names
    .filter((name) => /^live_constraint_incidents_attempt_\d+\.jsonl$/.test(name))
    .sort()
    .flatMap((name) => readFileSync(join(stageDir, name), 'utf8').trim().split('\n').filter(Boolean))
    .map((line) => JSON.parse(line));
}

function summarizeSamples(values) {
  const samples = [...values].sort((left, right) => left - right);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const median = samples.length % 2 === 1
    ? samples[Math.floor(samples.length / 2)]
    : (samples[(samples.length / 2) - 1] + samples[samples.length / 2]) / 2;
  const below = samples.filter((value) => value < median).length;
  const equal = samples.filter((value) => value === median).length;
  return {
    n: samples.length,
    unit: 'ms',
    mean,
    median,
    reported: median,
    location: {
      below,
      equal,
      rankZeroBased: below,
      midrankPercentile: ((below + (equal / 2)) / samples.length) * 100,
    },
  };
}

async function runFixtureStage(fixture, scope, suffix, adapter) {
  const previousStateDir = fcGlobalDir();
  setFcGlobalDir(fixture.stateDir);
  try {
    const { config, yaml } = fixtureConfig(scope, suffix);
    const created = createRun(fixture.projectDir, config.name, yaml, ['scout']);
    const state = readRunState(fixture.projectDir, created.runId);
    state.autoApprove = true;
    state.maxRetries = 0;
    writeRunState(fixture.projectDir, created.runId, state);
    const final = await runWorkflow(
      config,
      yaml,
      fixture.projectDir,
      adapter,
      new Map(),
      undefined,
      join(fixture.projectDir, 'config', 'agents'),
      created.runId,
      'byte-anchored live guard replay',
      true,
      false,
    );
    return {
      final,
      runDirPath: created.runDirPath,
      status: readStageStatus(fixture.projectDir, created.runId, 'scout'),
      incidents: incidentsFor(created.runDirPath),
    };
  } finally {
    setFcGlobalDir(previousStateDir);
  }
}

async function recordedScenario(evidence) {
  const fixture = createFixture(evidence.path);
  let invocationCount = 0;
  try {
    chmodSync(fixture.target, 0o777);
    const shifted = new Date(Date.now() + 86_400_000);
    utimesSync(fixture.target, shifted, shifted);
    if (git(fixture.projectDir, ['status', '--porcelain']) !== '') {
      throw new Error('metadata-only fixture unexpectedly changed Git content state');
    }
    chmodSync(fixture.projectDir, 0o555);
    const result = await runFixtureStage(fixture, [], 'recorded', {
      async run(_prompt, _role, opts) {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        invocationCount++;
        readFileSync(fixture.target);
        return { output: 'read-only scouting dispatch', exitCode: 0, duration_ms: 1 };
      },
    });
    const bytesIntact = readFileSync(fixture.target).equals(fixture.preimage);
    const falsePositive = result.status.status === 'failed'
      && result.incidents.some((incident) => incident.path === evidence.path && incident.restored === false)
      && result.status.attempts?.some((attempt) => String(attempt.error ?? '').includes('live constraint rollback failed'));
    const clean = result.status.status === 'complete'
      && result.incidents.length === 0
      && invocationCount === 1;
    if (!bytesIntact || (!falsePositive && !clean)) {
      throw new Error(`recorded scenario reached an unexpected state: ${JSON.stringify({
        status: result.status.status,
        incidents: result.incidents.length,
        invocationCount,
        bytesIntact,
      })}`);
    }
    return {
      classification: falsePositive ? 'recorded_rollback_failure' : 'read_only_dispatched',
      directExitCode: falsePositive ? 1 : 0,
      stageStatus: result.status.status,
      invocationCount,
      incidentCount: result.incidents.length,
      bytesIntact,
      incident: result.incidents[0] && {
        path: result.incidents[0].path,
        trigger: result.incidents[0].trigger,
        restored: result.incidents[0].restored,
        rollbackFailure: result.incidents[0].rollbackFailure,
      },
    };
  } finally {
    chmodSync(fixture.projectDir, 0o755);
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function touchOnlyArtifactScenario(evidence) {
  const fixture = createFixture(evidence.path);
  try {
    const result = await runFixtureStage(fixture, [evidence.path], 'touch-only', {
      async run(_prompt, _role, opts) {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        const shifted = new Date(Date.now() + 86_400_000);
        utimesSync(fixture.target, shifted, shifted);
        return { output: 'read content and changed only timestamp metadata', exitCode: 0, duration_ms: 1 };
      },
    });
    const attributed = result.status.artifacts?.includes(evidence.path) === true
      || result.status.writes?.includes(evidence.path) === true;
    const bytesIntact = readFileSync(fixture.target).equals(fixture.preimage);
    if (result.status.status !== 'complete' || result.incidents.length !== 0 || !bytesIntact) {
      throw new Error(`touch-only artifact scenario did not otherwise complete cleanly: ${JSON.stringify({
        stageStatus: result.status.status,
        incidentCount: result.incidents.length,
        incidents: result.incidents.map(({ path, trigger, reason, restored, rollbackFailure }) => ({ path, trigger, reason, restored, rollbackFailure })),
        bytesIntact,
      })}`);
    }
    return {
      directExitCode: attributed ? 1 : 0,
      stageStatus: result.status.status,
      attributed,
      artifacts: result.status.artifacts ?? [],
      writes: result.status.writes ?? [],
    };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function structuredTimestampOnlyScenario(evidence) {
  const fixture = createFixture(evidence.path);
  try {
    const result = await runFixtureStage(fixture, [], 'structured-touch', {
      async run(_prompt, _role, opts) {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        const shifted = new Date(Date.now() + 86_400_000);
        utimesSync(fixture.target, shifted, shifted);
        return {
          output: 'structured timestamp-only attribution', exitCode: 0, duration_ms: 1,
          writes: [evidence.path], writeAttribution: 'structured',
        };
      },
    });
    const audit = result.status.constraintAudit;
    const bytesIntact = readFileSync(fixture.target).equals(fixture.preimage);
    const clean = result.status.status === 'complete'
      && result.incidents.length === 0
      && bytesIntact
      && audit?.violationCount === 0
      && audit.unresolvedViolationCount === 0
      && audit.rawWriteCount === 1
      && audit.rolledBackWriteCount === 0;
    return {
      directExitCode: clean ? 0 : 1,
      stageStatus: result.status.status,
      incidentCount: result.incidents.length,
      bytesIntact,
      audit: audit && {
        violationCount: audit.violationCount,
        unresolvedViolationCount: audit.unresolvedViolationCount,
        rawWriteCount: audit.rawWriteCount,
        rolledBackWriteCount: audit.rolledBackWriteCount,
      },
    };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function replaceSymlink(path, target) {
  rmSync(path, { force: true });
  symlinkSync(target, path);
}

function readSymlinkBytes(path) {
  try { return readlinkSync(path, { encoding: 'buffer' }); } catch { return undefined; }
}

async function rawSymlinkScenario(evidence) {
  const trials = [];
  for (const preimageState of ['clean', 'dirty']) {
    const fixture = createFixture(evidence.path);
    const link = join(fixture.projectDir, 'tracked-link');
    const preimage = Buffer.from([0xff]);
    let invocationCount = 0;
    try {
      if (preimageState === 'clean') {
        symlinkSync(preimage, link);
        git(fixture.projectDir, ['add', '--all']);
        git(fixture.projectDir, ['commit', '--quiet', '-m', 'raw symlink preimage']);
      } else {
        symlinkSync('committed-target', link);
        git(fixture.projectDir, ['add', '--all']);
        git(fixture.projectDir, ['commit', '--quiet', '-m', 'symlink baseline']);
        replaceSymlink(link, preimage);
      }
      const result = await runFixtureStage(fixture, [], `raw-symlink-${preimageState}`, {
        async run(_prompt, _role, opts) {
          if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
          invocationCount++;
          if (invocationCount === 1) {
            replaceSymlink(link, Buffer.from([0xfe]));
            const deadline = performance.now() + 2_000;
            while (performance.now() < deadline
              && !readSymlinkBytes(link)?.equals(preimage)) {
              await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
            }
            return {
              output: 'genuine raw symbolic-link content write', exitCode: 0, duration_ms: 1,
              writes: ['tracked-link'], writeAttribution: 'structured',
            };
          }
          return {
            output: 'same-attempt corrected symbolic-link dispatch', exitCode: 0, duration_ms: 1,
            writes: [], writeAttribution: 'structured',
          };
        },
      });
      const incident = result.incidents[0];
      const audit = result.status.constraintAudit;
      const restoredBytes = readSymlinkBytes(link);
      const passed = result.status.status === 'complete'
        && invocationCount === 2
        && result.incidents.length === 1
        && incident.path === 'tracked-link'
        && incident.restored === true
        && restoredBytes?.equals(preimage) === true
        && audit?.violationCount === 1
        && audit.unresolvedViolationCount === 0
        && audit.liveRestoredCount === 1;
      trials.push({
        preimageState,
        passed,
        stageStatus: result.status.status,
        invocationCount,
        incidentCount: result.incidents.length,
        restored: incident?.restored === true,
        restoredTargetHex: restoredBytes?.toString('hex') ?? null,
        audit: audit && {
          violationCount: audit.violationCount,
          unresolvedViolationCount: audit.unresolvedViolationCount,
          liveRestoredCount: audit.liveRestoredCount,
        },
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
  return { directExitCode: trials.every((trial) => trial.passed) ? 0 : 1, trials };
}

async function genuineWriteTrials(evidence, trialCount = 5) {
  const fixture = createFixture(evidence.path);
  const trials = [];
  try {
    for (let trial = 0; trial < trialCount; trial++) {
      let invocationCount = 0;
      let writeToRestoreMs;
      const result = await runFixtureStage(fixture, [], `genuine-${trial + 1}`, {
        async run(_prompt, _role, opts) {
          if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
          invocationCount++;
          if (invocationCount === 1) {
            const writtenAt = performance.now();
            writeFileSync(fixture.target, `unauthorized content trial ${trial + 1}\n`);
            const deadline = writtenAt + 2_000;
            while (performance.now() < deadline && !readFileSync(fixture.target).equals(fixture.preimage)) {
              await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
            }
            if (readFileSync(fixture.target).equals(fixture.preimage)) {
              writeToRestoreMs = performance.now() - writtenAt;
            }
            return {
              output: 'genuine out-of-scope content write', exitCode: 0,
              duration_ms: performance.now() - writtenAt,
              writes: [evidence.path], writeAttribution: 'structured',
            };
          }
          return { output: 'same-attempt corrected scouting dispatch', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
        },
      });
      const incident = result.incidents[0];
      const auditExists = typeof result.status.constraintAudit?.path === 'string'
        && existsSync(join(result.runDirPath, result.status.constraintAudit.path));
      if (result.status.status !== 'complete'
        || invocationCount !== 2
        || result.incidents.length !== 1
        || incident.path !== evidence.path
        || incident.restored !== true
        || !readFileSync(fixture.target).equals(fixture.preimage)
        || !auditExists
        || writeToRestoreMs === undefined) {
        throw new Error(`genuine-write trial ${trial + 1} failed its contract`);
      }
      trials.push({
        trial: trial + 1,
        detectionLatencyMs: incident.detectionLatencyMs,
        writeToRestoreMs,
        invocationCount,
        restored: incident.restored,
        postAttemptAudit: auditExists,
      });
    }
    return {
      directExitCode: 0,
      fixturePath: fixture.projectDir,
      samples: trials,
      distribution: summarizeSamples(trials.map((trial) => trial.detectionLatencyMs)),
      writeToRestoreDistribution: summarizeSamples(trials.map((trial) => trial.writeToRestoreMs)),
    };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function restoreFailureSafetyScenario(evidence) {
  const fixture = createFixture(evidence.path, { largePreimage: true });
  const largePath = join(fixture.projectDir, 'tracked-large.bin');
  let invocationCount = 0;
  try {
    const result = await runFixtureStage(fixture, [], 'restore-failure', {
      async run(_prompt, _role, opts) {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        invocationCount++;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
        writeFileSync(largePath, 'genuine changed bytes retained on failed restore\n');
        return {
          output: 'forced unavailable large preimage after a genuine content write',
          exitCode: 0,
          duration_ms: 1_000,
          writes: ['tracked-large.bin'],
          writeAttribution: 'structured',
        };
      },
    });
    const incident = result.incidents.find((candidate) => candidate.path === 'tracked-large.bin');
    const retained = existsSync(largePath)
      && readFileSync(largePath, 'utf8') === 'genuine changed bytes retained on failed restore\n';
    const safe = result.status.status === 'failed'
      && invocationCount === 1
      && incident?.restored === false
      && typeof incident.rollbackFailure === 'string'
      && incident.rollbackFailure.length > 0
      && retained;
    if (!safe) {
      throw new Error(`restore-failure safety contract failed: ${JSON.stringify({
        stageStatus: result.status.status,
        invocationCount,
        incident,
        retained,
      })}`);
    }
    return {
      directExitCode: 0,
      stageStatus: result.status.status,
      invocationCount,
      retained,
      incident: {
        path: incident.path,
        restored: incident.restored,
        rollbackFailure: incident.rollbackFailure,
      },
    };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? 'current-contract';
  const evidence = await anchorEvidence(args.evidence);
  const output = { version: 1, mode, evidence };
  if (mode === 'recorded') {
    output.recorded = await recordedScenario(evidence);
    console.log(`LIVE_GUARD_REPLAY=${JSON.stringify(output)}`);
    process.exitCode = output.recorded.directExitCode;
    return;
  }
  if (mode === 'touch-only') {
    output.touchOnly = await touchOnlyArtifactScenario(evidence);
    console.log(`LIVE_GUARD_REPLAY=${JSON.stringify(output)}`);
    process.exitCode = output.touchOnly.directExitCode;
    return;
  }
  if (mode === 'structured-touch') {
    output.structuredTouch = await structuredTimestampOnlyScenario(evidence);
    console.log(`LIVE_GUARD_REPLAY=${JSON.stringify(output)}`);
    process.exitCode = output.structuredTouch.directExitCode;
    return;
  }
  if (mode === 'raw-symlink') {
    output.rawSymlink = await rawSymlinkScenario(evidence);
    console.log(`LIVE_GUARD_REPLAY=${JSON.stringify(output)}`);
    process.exitCode = output.rawSymlink.directExitCode;
    return;
  }
  if (mode === 'genuine-write') {
    output.genuineWrite = await genuineWriteTrials(evidence);
    console.log(`LIVE_GUARD_REPLAY=${JSON.stringify(output)}`);
    return;
  }
  if (mode === 'restore-failure') {
    output.restoreFailure = await restoreFailureSafetyScenario(evidence);
    console.log(`LIVE_GUARD_REPLAY=${JSON.stringify(output)}`);
    return;
  }
  if (mode !== 'current-contract') throw new Error(`unsupported mode: ${mode}`);
  output.recorded = await recordedScenario(evidence);
  output.touchOnly = await touchOnlyArtifactScenario(evidence);
  output.structuredTouch = await structuredTimestampOnlyScenario(evidence);
  output.rawSymlink = await rawSymlinkScenario(evidence);
  output.genuineWrite = await genuineWriteTrials(evidence);
  output.restoreFailure = await restoreFailureSafetyScenario(evidence);
  const exits = [
    output.recorded.directExitCode,
    output.touchOnly.directExitCode,
    output.structuredTouch.directExitCode,
    output.rawSymlink.directExitCode,
    output.genuineWrite.directExitCode,
    output.restoreFailure.directExitCode,
  ];
  if (exits.some((code) => code !== 0)) throw new Error(`current contract failed: ${JSON.stringify(exits)}`);
  console.log(`LIVE_GUARD_REPLAY=${JSON.stringify(output)}`);
}

main().catch((error) => {
  console.error(`LIVE_GUARD_REPLAY_ERROR=${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 2;
});
