import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestDeploymentHold } from '../src/deployment-hold.js';
import { NodeSystemd, Orchestrator } from '../src/orchestrator.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';
import { TaskRegistry, type TaskEntry, type TaskStatus } from '../src/task-registry.js';
import { atomicWriteJson, supervisionPaths } from '../src/supervision.js';

let root: string, previous: string, project: string, backend: NodeSystemd, orchestrator: Orchestrator;
let rows: TaskEntry[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-hold-history-'));
  previous = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  project = join(root, 'project');
  mkdirSync(project);
  const bin = join(root, 'bin'); mkdirSync(bin);
  // All manager observations stay inside this fixture, including subprocesses.
  vi.stubEnv('PATH', bin);
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'runtime'));
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', undefined);
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
case "$2" in
  list-units) IFS= read -r inventory < '${join(root, 'inventory.json')}'; printf '%s\\n' "$inventory" ;;
  *) echo 'unexpected individual manager probe' >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(root, 'inventory.json'), '[]\n');
  backend = new NodeSystemd(fcGlobalDir());
  orchestrator = new Orchestrator({ registry: new TaskRegistry({ baseDir: fcGlobalDir() }), systemd: backend, isProjectBusy: () => null });
  rows = [];
});
afterEach(async () => {
  await orchestrator.stop();
  setFcGlobalDir(previous);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function seed(status: TaskStatus, runStatus: string) {
  const id = rows.length + 1, runId = `fixture-${id}`;
  const path = join(fcGlobalDir(), 'runs', runId); mkdirSync(path, { recursive: true });
  const state = { runId, projectDir: project, status: runStatus, stages: {} };
  writeFileSync(join(path, 'run.json'), JSON.stringify(state));
  const task: TaskEntry = { id, name: 'Synthetic history', projectDir: project, systemd_unit: `fixture-${id}.service`, run_id: runId,
    status, attempt: 1, max_retries: 0, created_at: '2025-01-01T00:00:00.000Z', tick_log_path: join(root, `tick-${id}.jsonl`) };
  rows.push(task);
  return { task, path, state };
}
function publish() {
  writeFileSync(join(fcGlobalDir(), 'tasks.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
function history() {
  for (const [status, runStatus, count] of [
    ['cancelled', 'stopped', 661], ['stuck', 'failed', 132], ['done', 'complete', 45],
    ['reality_gate_failed', 'reality_gate_failed', 30], ['failed', 'failed', 20],
  ] as const) for (let i = 0; i < count; i++) seed(status, runStatus);
}

it('retires hundreds of absent terminal owners and becomes ready only after both running runs park', async () => {
  history();
  const running = [seed('running', 'running'), seed('running', 'running')];
  publish();
  const held = await orchestrator.holdDeployment();
  expect(held.ready).toBe(false);
  expect(held.errors).toEqual([]);
  expect(held.tasks.map(task => task.id)).toEqual(running.map(({ task }) => task.id));
  for (const [index, run] of running.entries()) {
    writeFileSync(join(run.path, 'run.json'), JSON.stringify({ ...run.state, status: 'parked', deploymentHold: held.hold }));
    const status = await orchestrator.deploymentStatus();
    expect(status.ready).toBe(index === 1);
    expect(status.tasks).toHaveLength(2);
  }
});

it('computes large-registry status below 500 ms without a detailed probe per historical task', async () => {
  history();
  const running = [seed('running', 'running'), seed('running', 'running')];
  publish();
  writeFileSync(join(root, 'inventory.json'), JSON.stringify(running.map(({ task }) => ({ unit: task.systemd_unit }))) + '\n');
  // Model the measured fixed cost per detailed probe without spawning hundreds
  // of children. Returning absent also lets the old path pass readiness checks.
  const detailed = vi.spyOn(backend, 'isActive').mockImplementation(async () => {
    const deadline = performance.now() + 2;
    while (performance.now() < deadline) { /* deterministic probe cost */ }
    return { kind: 'absent' };
  });
  await orchestrator.holdDeployment(); // Warm the append-only registry cache.
  detailed.mockClear();
  const start = performance.now();
  const status = await orchestrator.deploymentStatus();
  const elapsed = performance.now() - start;
  expect(status.ready).toBe(false);
  expect(elapsed).toBeLessThan(500);
  expect(detailed).toHaveBeenCalledTimes(2);
  expect(status.tasks).toHaveLength(2);
});

it.each(['running', 'parked', 'complete'])('refuses a live unit even with a historical registry row (run=%s)', async status => {
  const run = seed('cancelled', status); publish();
  writeFileSync(join(root, 'inventory.json'), JSON.stringify([{ unit: run.task.systemd_unit }]) + '\n');
  vi.spyOn(backend, 'isActive').mockResolvedValue({ kind: 'active' });
  expect((await orchestrator.holdDeployment()).ready).toBe(false);
});

it.each(['running', 'pending', 'unrecognized'])('refuses an absent unit for a non-settled run (run=%s)', async status => {
  seed('stuck', status); publish();
  expect((await orchestrator.holdDeployment()).ready).toBe(false);
});

it('refuses a corrupt scheduler identity on a terminal run', async () => {
  const run = seed('cancelled', 'stopped'); publish();
  writeFileSync(join(run.path, 'scheduler.pid'), 'unreadable identity');
  expect((await orchestrator.holdDeployment()).ready).toBe(false);
});

it.each([0, 60_000])('preserves local supervision ownership after manager retirement (launch age=%s)', async age => {
  const run = seed('cancelled', 'stopped'); publish();
  atomicWriteJson(supervisionPaths(fcGlobalDir(), run.task.systemd_unit).launch, {
    version: 1, unit: run.task.systemd_unit, workingDirectory: project, command: 'fixture',
    nodePath: process.execPath, shellPath: '/bin/sh', shutdownGraceMs: 100,
    createdAt: new Date(Date.now() - age).toISOString(),
  });
  const status = await orchestrator.holdDeployment();
  expect(status.ready).toBe(false);
  expect(status.tasks[0].detail).toContain(`unit=${age ? 'unobservable' : 'active'}`);
});

it('refuses unresolved command fate even after unit and scheduler retirement', async () => {
  const run = seed('cancelled', 'stopped'); publish();
  writeFileSync(join(run.path, 'run.json'), JSON.stringify({ ...run.state, planControl: { stages: [{ race: {} }] } }));
  expect((await orchestrator.holdDeployment()).ready).toBe(false);
});

it.each(['invalid', '{}', '[{}]'])('keeps an invalid manager inventory fail closed (%s)', async inventory => {
  seed('done', 'complete'); publish();
  writeFileSync(join(root, 'inventory.json'), inventory + '\n');
  expect((await orchestrator.holdDeployment()).ready).toBe(false);
});

it('keeps a manager failure fail closed instead of treating it as owner absence', async () => {
  seed('done', 'complete'); publish();
  writeFileSync(join(root, 'bin', 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  expect((await orchestrator.holdDeployment()).ready).toBe(false);
});

// Include directory names as well as file bytes so an observation cannot hide
// a repair by creating, replacing or deleting a different state artifact.
function stateBytes(path = fcGlobalDir()): Record<string, Buffer | null> {
  const snapshot: Record<string, Buffer | null> = {};
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      snapshot[entry.name + '/'] = null;
      for (const [name, bytes] of Object.entries(stateBytes(join(path, entry.name)))) {
        snapshot[entry.name + '/' + name] = bytes;
      }
    } else snapshot[entry.name] = readFileSync(join(path, entry.name));
  }
  return snapshot;
}

it.each(['absent', 'failed', 'unavailable', 'loaded-probe-failed'] as const)(
  'reads legacy fallback records without changing any state bytes (manager=%s)', async manager => {
    const records = [
      { bytes: '{ "pid": 2147483632, "state": "active", "command": "fixture" }\n', kind: 'terminal-unknown' },
      { bytes: '{malformed legacy record\n', kind: 'terminal-unknown' },
      { bytes: '{ "state": "inactive", "reason": "fixture ended" }\n', kind: 'terminal-unknown' },
      { bytes: JSON.stringify({ pid: process.pid, state: 'active' }), kind: 'active' },
      { bytes: JSON.stringify({ pid: process.pid, state: 'deactivating' }), kind: 'deactivating' },
    ];
    for (const record of records) {
      const { task } = seed('cancelled', 'stopped');
      writeFileSync(join(fcGlobalDir(), 'systemd-fallback', task.systemd_unit + '.json'), record.bytes);
    }
    publish();
    if (manager === 'failed') writeFileSync(join(root, 'inventory.json'), 'invalid\n');
    if (manager === 'unavailable') rmSync(join(root, 'bin', 'systemctl'));
    if (manager === 'loaded-probe-failed') {
      writeFileSync(join(root, 'inventory.json'), JSON.stringify(rows.map(task => ({ unit: task.systemd_unit }))) + '\n');
    }
    requestDeploymentHold(); // Only the request owns this write; status must not.
    const before = stateBytes();
    for (let attempt = 0; attempt < 2; attempt++) {
      const status = await orchestrator.deploymentStatus();
      expect(stateBytes()).toEqual(before);
      expect(status.errors).toEqual([]);
      expect(status.ready).toBe(false); // The live owners still veto readiness.
      expect(status.tasks.map(task => task.id)).toEqual(
        manager === 'absent' || manager === 'unavailable' ? [4, 5] : [1, 2, 3, 4, 5],
      );
      const observed = await backend.isActiveMany(rows.map(task => task.systemd_unit));
      expect([...observed.values()].map(unit => unit.kind)).toEqual(records.map(record =>
        (manager === 'failed' || manager === 'loaded-probe-failed') && record.kind === 'terminal-unknown'
          ? 'unobservable' : record.kind));
      expect(stateBytes()).toEqual(before);
    }
  },
);
