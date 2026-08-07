/**
 * Regression invariant: durable supervision records are atomic and portable,
 * wrapper launch is optional, and a distinct shim preserves lifecycle truth
 * after the original launcher exits.
 *
 * Maintenance contract: this is a permanent backend regression suite, not a
 * run-specific gate artifact. Keep it Vitest-discovered and sequential because
 * its fixtures intentionally replace PATH while exercising real child trees.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
import { constants, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..');
const orchestratorUrl = pathToFileURL(join(repositoryRoot, 'dist', 'orchestrator.js')).href;
const supervisionUrl = pathToFileURL(join(repositoryRoot, 'dist', 'supervision.js')).href;
const runLockUrl = pathToFileURL(join(repositoryRoot, 'dist', 'run-lock.js')).href;
const { NodeSystemd } = await import(orchestratorUrl);
const {
  SUPERVISION_PROTOCOL_VERSION,
  atomicWriteJson,
  gcSupervisionDirectories,
  observePortableUnit,
  readSupervisionExit,
  readSupervisionRunning,
  supervisionPaths,
} = await import(supervisionUrl);
const { processIsAlive, processStartToken, processStartTokensMatch } = await import(runLockUrl);

const previousPath = process.env.PATH;

describe.sequential('durable supervision backend invariants', () => {
check('atomic same-directory records and exit precedence', async () => {
  await withFixture('atomic', async ({ root, bin }) => {
    process.env.PATH = bin;
    const unit = 'atomic-exit.service';
    const backend = new NodeSystemd(root, { shellPath: '/bin/sh' });
    await backend.runUnit({
      unit,
      workingDirectory: root,
      command: shellJoin([process.execPath, '-e', 'console.log("GATE3_LOG"); process.exit(3)']),
    });
    const terminal = await waitForStatus(backend, unit, 'terminal');
    const paths = supervisionPaths(root, unit);
    assert.deepEqual(terminal, { kind: 'terminal', exitCode: 3 });
    assert.deepEqual(readSupervisionExit(paths.exit)?.normalized, 3);
    assert.equal(readdirSync(paths.unitDir).some((entry) => entry.endsWith('.tmp')), false);
    assert.match(await backend.journalTail(unit, 20), /GATE3_LOG/);

    installExecutable(bin, 'systemctl', '#!/bin/sh\necho active\n');
    assert.deepEqual(await backend.isActive(unit), { kind: 'terminal', exitCode: 3 });

    const source = readFileSync(join(repositoryRoot, 'src', 'supervision.ts'), 'utf-8');
    assert.match(source, /join\(dirname\(path\), `\.\$\{randomUUID\(\)\}\.tmp`\)/);
    assert.match(source, /renameSync\(temporary, path\)/);
  });
});

check('launch timeout and stale running evidence stay terminal-unknown', async () => {
  await withFixture('stale', async ({ root, bin }) => {
    process.env.PATH = bin;
    const recent = supervisionPaths(root, 'recent.service');
    atomicWriteJson(recent.launch, launchRecord(root, 'recent.service', new Date(10_000).toISOString()));
    assert.deepEqual(
      observePortableUnit(root, 'recent.service', { nowMs: 10_500, startupGraceMs: 1_000 }).status,
      { kind: 'active' },
    );

    const old = supervisionPaths(root, 'old.service');
    atomicWriteJson(old.launch, launchRecord(root, 'old.service', new Date(10_000).toISOString()));
    assert.deepEqual(
      observePortableUnit(root, 'old.service', { nowMs: 20_000, startupGraceMs: 1_000 }).status,
      { kind: 'terminal-unknown', reason: 'never-started' },
    );

    seedStaleRunning(root, 'stale.service', new Date(10_000).toISOString());
    assert.deepEqual(
      observePortableUnit(root, 'stale.service', { nowMs: 20_000, startupGraceMs: 0 }).status,
      { kind: 'terminal-unknown', reason: 'shim-died-without-status' },
    );
  });
});

check('active systemd unit vetoes stale running evidence', async () => {
  await withFixture('veto', async ({ root, bin }) => {
    process.env.PATH = bin;
    seedStaleRunning(root, 'veto.service', '2020-01-01T00:00:00.000Z');
    installExecutable(bin, 'systemctl', '#!/bin/sh\necho active\n');
    const backend = new NodeSystemd(root, { startupGraceMs: 0 });
    assert.deepEqual(await backend.isActive('veto.service'), { kind: 'active' });
  });
});

check('independent reader recovers exit 42 after launcher parent exits', async () => {
  await withFixture('parent', async ({ root, bin }) => {
    process.env.PATH = bin;
    const unit = 'parent-exit.service';
    const source = [
      `import { NodeSystemd } from ${JSON.stringify(orchestratorUrl)};`,
      `const backend = new NodeSystemd(${JSON.stringify(root)}, { shellPath: '/bin/sh' });`,
      `await backend.runUnit({ unit: ${JSON.stringify(unit)}, workingDirectory: ${JSON.stringify(root)}, command: ${JSON.stringify(shellJoin([process.execPath, '-e', 'setTimeout(() => process.exit(42), 250)']))} });`,
    ].join('\n');
    const parent = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', source],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          HOME: root,
          FC_HOME: root,
          PATH: bin,
          NO_COLOR: '1',
        },
        encoding: 'utf-8',
        timeout: 10_000,
      },
    );
    assert.equal(parent.status, 0, `${parent.stdout}${parent.stderr}`);
    const independentReader = new NodeSystemd(root);
    assert.deepEqual(await waitForStatus(independentReader, unit, 'terminal'), {
      kind: 'terminal',
      exitCode: 42,
    });
  });
});

check('bare shim signal controls a distinct agent group and kills the agent', async () => {
  await withFixture('groups', async ({ root, bin, own }) => {
    process.env.PATH = bin;
    const unit = 'groups.service';
    const ready = join(root, 'ready');
    const backend = new NodeSystemd(root, { shellPath: '/bin/sh', shutdownGraceMs: 75 });
    await backend.runUnit({
      unit,
      workingDirectory: root,
      command: shellJoin([
        process.execPath,
        '-e',
        `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(ready)},'1'); setInterval(()=>{},1000)`,
      ]),
    });
    const paths = supervisionPaths(root, unit);
    assert.equal(await waitUntil(() => readSupervisionRunning(paths.running) !== undefined), true);
    const running = readSupervisionRunning(paths.running);
    assert.ok(running);
    own(running.shimPid, false, running.shimToken);
    own(running.agentPid, true, running.agentToken);
    assert.equal(await waitUntil(() => existsSync(ready)), true);
    assert.notEqual(running.shimPid, running.agentPid);
    if (process.platform !== 'win32') {
      assert.doesNotThrow(() => process.kill(-running.shimPid, 0));
      assert.doesNotThrow(() => process.kill(-running.agentPid, 0));
    }

    await backend.stopUnit(unit);
    assert.deepEqual(await waitForStatus(backend, unit, 'terminal'), {
      kind: 'terminal',
      exitCode: 128 + constants.signals.SIGKILL,
      signal: 'SIGKILL',
    });
    assert.equal(await waitUntil(() => !processIsAlive(running.agentPid)), true);

    const stopSource = readFileSync(join(repositoryRoot, 'src', 'orchestrator.ts'), 'utf-8');
    const stopBody = stopSource.slice(stopSource.indexOf('async stopUnit('), stopSource.indexOf('private async stopLegacyUnit'));
    assert.match(stopBody, /process\.kill\(running\.shimPid, 'SIGTERM'\)/);
    assert.doesNotMatch(stopBody, /process\.kill\(-running\.(?:shimPid|agentPid)/);
  });
});

check('asynchronous launcher ENOENT is persisted as terminal 127', async () => {
  await withFixture('enoent', async ({ root, bin }) => {
    process.env.PATH = bin;
    const unit = 'enoent.service';
    const backend = new NodeSystemd(root, {
      nodePath: join(root, 'missing-node'),
      shellPath: '/bin/sh',
    });
    await backend.runUnit({ unit, workingDirectory: root, command: shellJoin([process.execPath, '-e', '']) });
    assert.deepEqual(await waitForStatus(backend, unit, 'terminal'), { kind: 'terminal', exitCode: 127 });
    const exit = readSupervisionExit(supervisionPaths(root, unit).exit);
    assert.match(exit?.reason ?? '', /shim launcher spawn failed:.*ENOENT/);
  });
});

check('early shim exit cannot certify an orphaned agent as stopped', async () => {
  await withFixture('orphan', async ({ root, bin, own }) => {
    process.env.PATH = bin;
    const unit = 'orphan.service';
    const orphanPidPath = join(root, 'orphan.pid');
    const fakeShim = join(root, 'early-exit-shim.mjs');
    writeFileSync(fakeShim, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'flowcrew-durable-orphan-fixture'], { detached: true, stdio: 'ignore' });`,
      'await new Promise((resolveSpawn, rejectSpawn) => {',
      "  child.once('spawn', resolveSpawn);",
      "  child.once('error', rejectSpawn);",
      '});',
      "if (!child.pid) throw new Error('spawn event did not publish child pid');",
      `writeFileSync(${JSON.stringify(orphanPidPath)}, String(child.pid));`,
      'child.unref();',
    ].join('\n'), 'utf-8');
    const backend = new NodeSystemd(root, { shimPath: fakeShim, shellPath: '/bin/sh', startupGraceMs: 100 });
    await backend.runUnit({ unit, workingDirectory: root, command: shellJoin([process.execPath, '-e', '']) });
    assert.equal(await waitUntil(() => existsSync(orphanPidPath)), true);
    const orphanPid = Number.parseInt(readFileSync(orphanPidPath, 'utf-8'), 10);
    assert.ok(Number.isSafeInteger(orphanPid) && orphanPid > 1);
    own(orphanPid, true);
    assert.equal(processIsAlive(orphanPid), true);
    const status = await waitForSettledStatus(backend, unit);
    assert.equal(
      status.kind,
      'terminal-unknown',
      `an early shim exit left agent ${orphanPid} alive but was reported as ${JSON.stringify(status)}`,
    );
    assert.equal(existsSync(supervisionPaths(root, unit).exit), false);
  });
});

check('GC removes only old valid terminal directories', async () => {
  await withFixture('gc', async ({ root, bin }) => {
    process.env.PATH = bin;
    const old = supervisionPaths(root, 'old.service');
    const uncertain = supervisionPaths(root, 'uncertain.service');
    const malformed = supervisionPaths(root, 'malformed.service');
    atomicWriteJson(old.exit, {
      version: SUPERVISION_PROTOCOL_VERSION,
      exitCode: 0,
      normalized: 0,
      endedAt: '2020-01-01T00:00:00.000Z',
    });
    seedStaleRunning(root, 'uncertain.service', '2020-01-01T00:00:00.000Z');
    mkdirSync(malformed.unitDir, { recursive: true });
    writeFileSync(malformed.exit, '{', 'utf-8');
    assert.equal(gcSupervisionDirectories(root, {
      nowMs: Date.parse('2026-08-06T00:00:00.000Z'),
      retentionMs: 1_000,
    }), 1);
    assert.equal(existsSync(old.unitDir), false);
    assert.equal(existsSync(uncertain.unitDir), true);
    assert.equal(existsSync(malformed.unitDir), true);
  });
});

check('systemd-run is an optional wrapper around the same absolute shim command', async () => {
  await withFixture('wrapper', async ({ root, bin }) => {
    process.env.PATH = bin;
    const captured = join(root, 'systemd-run.args');
    installExecutable(
      bin,
      'systemd-run',
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(captured)}\n`,
    );
    const backend = new NodeSystemd(root, { shellPath: '/bin/sh' });
    await backend.runUnit({
      unit: 'wrapped.service',
      workingDirectory: root,
      command: shellJoin([process.execPath, '-e', 'process.exit(0)']),
    });
    const args = readFileSync(captured, 'utf-8').split(/\r?\n/).filter(Boolean);
    assert.ok(args.includes('--property=KillMode=mixed'));
    assert.ok(args.includes(process.execPath));
    assert.ok(args.some((arg) => /supervise-shim\.(?:js|ts)$/.test(arg)));
    assert.equal(existsSync(supervisionPaths(root, 'wrapped.service').launch), true);
  });
});

check('shim uses only Node built-ins/local modules and keeps lifecycle assertions active', async () => {
  const shimSource = readFileSync(join(repositoryRoot, 'src', 'supervise-shim.ts'), 'utf-8');
  const imports = [...shimSource.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.equal(imports.every((specifier) => specifier.startsWith('node:') || specifier.startsWith('./')), true);
  const lifecycle = readFileSync(join(repositoryRoot, 'spec', 'supervised-lifecycle.test.ts'), 'utf-8');
  assert.equal((lifecycle.match(/\bit\.fails\s*\(/g) ?? []).length, 0);
  assert.match(lifecycle, /it\('\[6\]/);
  assert.doesNotMatch(lifecycle, /\bit\.(?:fails|skip|todo)\s*\(/);
});
});

afterAll(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
});

function check(name: string, action: () => Promise<void>): void {
  it(name, action);
}

async function withFixture(label, action) {
  const root = mkdtempSync(join(tmpdir(), `fc-durable-supervision-${label}-`));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  linkFirstAvailable(bin, 'ps', ['/bin/ps', '/usr/bin/ps']);
  const owned = [];
  const own = (pid, group, token) => owned.push({ pid, group, token });
  try {
    await action({ root, bin, own });
  } finally {
    for (const item of owned) signalOwned(item, 'SIGTERM');
    await delay(100);
    for (const item of owned) signalOwned(item, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
}

function signalOwned(item, signal) {
  if (!Number.isSafeInteger(item.pid) || item.pid <= 1 || item.pid === process.pid) return;
  if (item.token && !processStartTokensMatch(item.token, processStartToken(item.pid))) return;
  try {
    process.kill(item.group && process.platform !== 'win32' ? -item.pid : item.pid, signal);
  } catch {
    // Test-owned process already exited.
  }
}

function launchRecord(root, unit, createdAt) {
  return {
    version: SUPERVISION_PROTOCOL_VERSION,
    unit,
    workingDirectory: root,
    command: shellJoin([process.execPath, '-e', '']),
    nodePath: process.execPath,
    shellPath: '/bin/sh',
    createdAt,
    shutdownGraceMs: 100,
  };
}

function seedStaleRunning(root, unit, createdAt) {
  const paths = supervisionPaths(root, unit);
  const launch = launchRecord(root, unit, createdAt);
  atomicWriteJson(paths.launch, launch);
  atomicWriteJson(paths.running, {
    version: SUPERVISION_PROTOCOL_VERSION,
    shimPid: 2_000_000_000,
    shimToken: { kind: 'linux', value: '1' },
    shimCommand: "'stale-shim'",
    agentPid: 1_999_999_999,
    agentToken: { kind: 'linux', value: '1' },
    command: launch.command,
    startedAt: createdAt,
  });
}

async function waitForStatus(backend, unit, kind, timeoutMs = 7_000) {
  let status = await backend.isActive(unit);
  const found = await waitUntil(async () => {
    status = await backend.isActive(unit);
    return status.kind === kind;
  }, timeoutMs);
  assert.equal(found, true, `last status for ${unit}: ${JSON.stringify(status)}`);
  return status;
}

async function waitForSettledStatus(backend, unit, timeoutMs = 3_000) {
  let status = await backend.isActive(unit);
  await waitUntil(async () => {
    status = await backend.isActive(unit);
    return status.kind !== 'active' && status.kind !== 'deactivating';
  }, timeoutMs);
  return status;
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(25);
  }
  return Boolean(await predicate());
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function shellJoin(parts) {
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function installExecutable(bin, name, source) {
  const path = join(bin, name);
  writeFileSync(path, source, 'utf-8');
  chmodSync(path, 0o755);
}

function linkFirstAvailable(bin, name, candidates) {
  const source = candidates.find((candidate) => existsSync(candidate));
  assert.ok(source, `missing fixed candidate for ${name}`);
  symlinkSync(source, join(bin, name));
}
