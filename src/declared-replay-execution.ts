import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { confineEngineChild, observeEngineChildBoundary, withEngineWriteBoundary, withEngineWriteBoundaryDirectory } from './write-boundary.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadavg, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactContractSchema, resolveArtifactLocation } from './artifact-declarations.js';
import { loadProjectDefaults } from './config.js';
import { configuredPytest, configuredVitest } from './declared-replay-config.js';
import { NODE_REPLAY_REPORTER, nodeReplayTests, pytestReplayTests, vitestReplayTests, type ReplayTests } from './declared-replay-results.js';
import type { DeclaredReplay } from './declared-replay.js';
import type { StageArtifactContractInput, StageArtifactReplayExecution, StageArtifactReplayProcess } from './stage-artifact-contract.js';
import type { CommandLifecycleEvent } from './adapters/base.js';
import { readLiveConstraintContentIdentity } from './live-constraint-guard.js';

export interface ReplayBudget {
  /** Worker-owned monotonic time remaining; the declaration cannot extend it. */
  remainingMs: () => number;
  abortSignal?: AbortSignal;
  /** Engine-owned invocation monitor; actual argv is data, never shell execution. */
  onCommandLifecycle?: (event: CommandLifecycleEvent) => void;
}
type ProcessOutcome = StageArtifactReplayProcess;
const OUTPUT_BYTES = 8 * 1024 * 1024;
const bounded = (text: string) => text.length <= 16_384 ? text : `${text.slice(0, 16_384)}\n[replay output truncated]`;

/** Preserve direct process facts and terminate the owned group on every exit. */
function run(command: string, args: string[], cwd: string, timeoutMs: number, budget: ReplayBudget, id: string, environment: NodeJS.ProcessEnv = {}): Promise<ProcessOutcome> {
  const startedAt = new Date().toISOString(), started = performance.now(), loadStart = loadavg();
  return new Promise((done) => {
    const abortSignal = budget.abortSignal;
    const description = [command, ...args].map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(' ');
    budget.onCommandLifecycle?.({ phase: 'started', id, command: description, timestamp: new Date().toISOString() });
    const launch = confineEngineChild(command, args);
    const child = spawn(launch.command, launch.args, {
      cwd, shell: false, detached: process.platform !== 'win32', stdio: launch.receiptPath ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...environment },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const stdoutHash = createHash('sha256'), stderrHash = createHash('sha256');
    let stdoutBytes = 0, stderrBytes = 0;
    let boundaryObserved = !launch.receiptPath;
    let bytes = 0, timedOut = false, aborted = false, processError: string | undefined;
    observeEngineChildBoundary(child, launch.receiptPath, (receipt) => {
      boundaryObserved = true;
      if (receipt.kind === 'refused' || receipt.kind === 'spawn_error') processError = receipt.message;
    });
    const stop = () => {
      if (!child.pid) return;
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); }
      catch { /* owned child/group already exited */ }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => { aborted = true; stop(); };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    const append = (stream: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_BYTES) { processError = `replay output exceeded ${OUTPUT_BYTES} bytes`; stop(); }
      else stream.push(chunk);
    };
    child.stdout!.on('data', (chunk: Buffer) => { stdoutBytes += chunk.length; stdoutHash.update(chunk); append(stdout, chunk); });
    child.stderr!.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; stderrHash.update(chunk); append(stderr, chunk); });
    child.on('error', (error) => { processError = `replay spawn failed: ${error.message}`; });
    child.on('close', (exitCode, signal) => {
      if (!boundaryObserved) processError = 'ENGINE_WRITE_BOUNDARY_UNVERIFIED: replay launcher closed without enforcement receipt; child fate is unknown';
      clearTimeout(timer); abortSignal?.removeEventListener('abort', onAbort); stop();
      budget.onCommandLifecycle?.({ phase: 'completed', id, command: description, timestamp: new Date().toISOString() });
      const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8');
      done({ command, argv: args, cwd, startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), loadStart, loadEnd: loadavg(),
        exitCode, signal, timedOut, aborted, stdout: out, stderr: err,
        stdoutBytes, stderrBytes, stdoutSha256: stdoutHash.digest('hex'), stderrSha256: stderrHash.digest('hex'),
        stdoutTruncated: out.length > 16_384 || Buffer.byteLength(out) < stdoutBytes,
        stderrTruncated: err.length > 16_384 || Buffer.byteLength(err) < stderrBytes,
        ...(processError ? { processError } : {}) });
    });
  });
}

function vitestCli(projectDir: string): string | undefined {
  try {
    const local = createRequire(join(projectDir, 'package.json'));
    const cli = join(dirname(local.resolve('vitest/package.json')), 'vitest.mjs');
    return existsSync(cli) && statSync(cli).isFile() ? cli : undefined;
  } catch { return undefined; }
}

/** All commands share the attempt deadline; a command budget covers all targets. */
export async function executeDeclaredReplays(input: StageArtifactContractInput, budget: ReplayBudget): Promise<StageArtifactReplayExecution[]> {
  if (!input.artifactContract?.replays?.length) return [];
  return withEngineWriteBoundary({ ...input, artifactContract: input.artifactContract },
    () => executeConfinedDeclaredReplays(input, budget));
}

async function executeConfinedDeclaredReplays(input: StageArtifactContractInput, budget: ReplayBudget): Promise<StageArtifactReplayExecution[]> {
  const contract = ArtifactContractSchema.parse(input.artifactContract);
  const validationBudget = loadProjectDefaults(input.projectDir).validation_timeout_ms;
  const executions: StageArtifactReplayExecution[] = [];
  for (const declaration of contract.replays) {
    const targets = declaration.targets.map((id) => {
      const artifact = [...contract.produces, ...contract.reads].find((entry) => entry.id === id)!;
      return { id, path: resolveArtifactLocation(artifact, input.projectDir, input.runDir) };
    });
    const effectiveTimeoutMs = Math.max(0, Math.floor(Math.min(declaration.timeout_ms ?? validationBudget, validationBudget, budget.remainingMs())));
    const started = performance.now();
    const command = JSON.stringify({ runner: declaration.runner, argv: declaration.argv, targets: declaration.targets });
    const inputs = () => targets.map((target) => ({ path: target.path, identity: readLiveConstraintContentIdentity(target.path) }));
    const modulePath = fileURLToPath(import.meta.url);
    const execution: StageArtifactReplayExecution = {
      declarationId: declaration.id, command, sourcePath: '', runner: declaration.runner,
      targetPaths: targets.map((target) => target.path), status: 'not_run', exitCode: null, signal: null, timedOut: false,
      collectedTests: 0, executedTests: 0, passedTests: 0, failedTests: 0, skippedTests: 0,
      stdout: '', stderr: '', reason: '', effectiveTimeoutMs, elapsedMs: 0, targets: [], processes: [],
      observation: { policy: 'single_execution_no_confirmation', startedAt: new Date().toISOString(), loadStart: loadavg(), inputsBefore: inputs(),
        runtime: { modulePath, moduleIdentity: readLiveConstraintContentIdentity(modulePath), manifestIdentity: readLiveConstraintContentIdentity(join(dirname(modulePath), '.flowcrew-build-manifest.json')) } },
    };
    const remaining = () => Math.max(0, Math.floor(Math.min(effectiveTimeoutMs - (performance.now() - started), budget.remainingMs())));
    const missing = targets.filter((target) => { try { return !statSync(target.path).isFile(); } catch { return true; } });
    if (declaration.timeout_ms !== undefined && declaration.timeout_ms > validationBudget) execution.reason = `REPLAY_BUDGET_INVALID: replays.${declaration.id}.timeout_ms exceeds configured validation_timeout_ms ${validationBudget}`;
    else if (missing.length) execution.reason = `REPLAY_INPUT_ABSENT: declare readable exact file targets; missing ${missing.map((target) => target.id).join(', ')}`;
    else if (effectiveTimeoutMs < 1 || budget.abortSignal?.aborted) execution.reason = 'REPLAY_ATTEMPT_BOUNDARY: immutable attempt deadline or control abort prevents replay execution';
    else {
      const outcomes: ProcessOutcome[] = [];
      const record = (id: string, path: string, result: ReplayTests) => {
        execution.targets!.push({ artifact: id, path, ...result, executed: result.passed + result.failed });
        execution.collectedTests += result.collected; execution.passedTests += result.passed;
        execution.failedTests += result.failed; execution.skippedTests += result.skipped;
        execution.executedTests += result.passed + result.failed;
      };
      const directory = mkdtempSync(join(tmpdir(), 'flowcrew-declared-replay-'));
      try {
        await withEngineWriteBoundaryDirectory(directory, async () => {
        if (declaration.runner === 'vitest') {
          const cli = configuredVitest(input.projectDir) ? vitestCli(input.projectDir) : undefined;
          if (!cli) execution.reason = 'REPLAY_RUNNER_UNCONFIGURED: declare the project test recipe as vitest run and provide its local CLI';
          else {
            const output = join(directory, 'vitest.json');
            const outcome = await run(process.execPath, [cli, 'run', '--reporter=json', `--outputFile=${output}`, '--root', input.projectDir, ...declaration.argv, ...targets.map((target) => target.path)], input.projectDir, remaining(), budget, `replay:${declaration.id}`);
            outcomes.push(outcome);
            let text = ''; try { text = readFileSync(output, 'utf8'); } catch { /* diagnostic follows process facts */ }
            const results = vitestReplayTests(text, targets.map((target) => target.path));
            for (const target of targets) record(target.id, target.path, results.get(target.path) ?? { collected: 0, passed: 0, failed: 0, skipped: 0, failures: [], error: 'Vitest did not return this target' });
          }
        } else {
          const pytest = declaration.runner === 'pytest' ? configuredPytest(input.projectDir) : undefined;
          if (declaration.runner === 'pytest' && !pytest) execution.reason = 'REPLAY_RUNNER_UNCONFIGURED: declare an inspectable configured python -m pytest recipe';
          else {
            const reporter = join(directory, 'node-reporter.mjs');
            if (declaration.runner === 'node_test') writeFileSync(reporter, NODE_REPLAY_REPORTER);
            for (const target of targets) {
              if (remaining() < 1 || budget.abortSignal?.aborted) { execution.reason = 'REPLAY_ATTEMPT_BOUNDARY: remaining command/attempt budget cannot execute every declared target'; break; }
              const junit = join(directory, `${target.id}.xml`);
              const outcome = declaration.runner === 'node_test'
                ? await run(process.execPath, ['--test', `--test-reporter=${reporter}`, ...declaration.argv, target.path], input.projectDir, remaining(), budget, `replay:${declaration.id}:${target.id}`)
                : await run(pytest!.pythonExecutable, ['-m', 'pytest', target.path, ...declaration.argv, '-p', 'no:cacheprovider', `--junitxml=${junit}`], input.projectDir, remaining(), budget, `replay:${declaration.id}:${target.id}`,
                  { PYTEST_ADDOPTS: '', ...pytest!.environment, PYTHONDONTWRITEBYTECODE: '1' });
              outcomes.push(outcome);
              let xml = ''; if (declaration.runner === 'pytest') try { xml = readFileSync(junit, 'utf8'); } catch { /* no trustworthy record */ }
              record(target.id, target.path, declaration.runner === 'node_test' ? nodeReplayTests(outcome.stdout, target.path) : pytestReplayTests(xml));
              // A normal expected failing reproduction must not skip later targets.
              if (outcome.timedOut || outcome.aborted || outcome.signal || outcome.processError) break;
            }
          }
        }
        execution.status = outcomes.length ? 'failed' : 'not_run';
        const unsuccessful = outcomes.find((outcome) => outcome.exitCode !== 0);
        execution.exitCode = unsuccessful ? unsuccessful.exitCode : outcomes.length ? 0 : null;
        execution.signal = outcomes.find((outcome) => outcome.signal)?.signal ?? null;
        execution.timedOut = outcomes.some((outcome) => outcome.timedOut);
        execution.stdout = bounded(outcomes.map((outcome) => outcome.stdout).join('\n'));
        execution.stderr = bounded(outcomes.map((outcome) => outcome.stderr).join('\n'));
        // The aggregate exit/log fields remain compatible. One durable ledger
        // keeps individual targets' direct facts instead of collapsing them.
        execution.processes = outcomes.map((outcome) => ({ ...outcome, stdout: bounded(outcome.stdout), stderr: bounded(outcome.stderr) }));
        const processError = outcomes.find((outcome) => outcome.processError)?.processError;
        if (execution.timedOut) execution.reason = `REPLAY_TIMEOUT: replay exceeded its effective ${effectiveTimeoutMs}ms budget`;
        else if (outcomes.some((outcome) => outcome.aborted)) execution.reason = 'REPLAY_ABORTED: authoritative attempt/control abort stopped the replay';
        else if (processError) execution.reason = processError;
        else if (execution.signal) execution.reason = `REPLAY_SIGNAL: replay ended on ${execution.signal}`;
        else if (!execution.reason) execution.reason = verifyOutcome(declaration, execution);
        if (!execution.reason) { execution.status = 'passed'; execution.reason = 'Every named target executed and matched the declared direct outcome and failing test identities'; }
        });
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
    execution.elapsedMs = Math.round(performance.now() - started);
    execution.observation!.completedAt = new Date().toISOString();
    execution.observation!.loadEnd = loadavg();
    execution.observation!.inputsAfter = inputs();
    executions.push(execution);
  }
  return executions;
}

function verifyOutcome(declaration: DeclaredReplay, execution: StageArtifactReplayExecution): string {
  if (execution.targets?.length !== declaration.targets.length) return 'REPLAY_TARGET_UNEXERCISED: not every declared target ran';
  for (const target of execution.targets) {
    if (target.error) return `REPLAY_COLLECTION_INVALID: ${target.artifact}: ${target.error}`;
    if (!target.collected || !target.executed) return `REPLAY_TARGET_UNEXERCISED: ${target.artifact} collected ${target.collected} and executed ${target.executed} tests`;
  }
  if (execution.exitCode !== declaration.expected.exit_code) return `REPLAY_EXIT_MISMATCH: expected direct exit ${declaration.expected.exit_code}, observed ${execution.exitCode ?? 'null'}`;
  const actual = execution.targets.flatMap((target) => target.failures.map((test) => JSON.stringify({ artifact: target.artifact, test }))).sort();
  const expected = declaration.expected.failures.map((failure) => JSON.stringify(failure)).sort();
  return JSON.stringify(actual) === JSON.stringify(expected) ? '' : `REPLAY_FAILURE_MISMATCH: expected ${JSON.stringify(declaration.expected.failures)}, observed ${JSON.stringify(execution.targets.flatMap((target) => target.failures.map((test) => ({ artifact: target.artifact, test }))))}`;
}
