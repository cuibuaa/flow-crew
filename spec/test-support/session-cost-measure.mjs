// Informational built-CLI measurements. No threshold and no provider calls.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionCostFixture } from './session-cost-fixture.mjs';

export function measureSessionCost(root, variant) {
  mkdirSync(root, { recursive: true });
  const cli = resolve('dist/cli.js');
  const rows = [];
  for (const scale of [1, 10]) {
    const f = sessionCostFixture(join(root, String(scale)), scale);
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(99); console.log('2.1.308 (fixture)');\n`, { mode: 0o700 });
    const env = { ...process.env, HOME: f.root, USERPROFILE: f.root, FC_HOME: f.fc, FC_TASKS_ROOT: f.ledger,
      CODEX_HOME: join(f.root, 'codex'), CLAUDE_CONFIG_DIR: join(f.root, 'claude'), AGENT_TASK_ROOT: join(f.root, 'agents'),
      FLOWCREW_DAEMON_SOCKET: join(f.root, 'daemon.sock'), PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: '' };
    const start = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19];
    const token = { kind: 'linux', value: start };
    const waiter = join(f.fc, 'session-push', 'waiters', createHash('sha256').update(f.session).digest('hex') + '.json');
    mkdirSync(join(f.fc, 'session-push', 'waiters'), { recursive: true });
    writeFileSync(waiter, JSON.stringify({ session: f.session, pid: process.pid, start: token, processStartTime: start,
      host: process.pid, hostStart: token, token: 'measurement-host', expiresAt: Date.now() + 600_000,
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }));
    const tickFile = join(f.root, 'wake-tick.json');
    const preload = join(f.root, 'one-tick.mjs');
    writeFileSync(preload, `import timers from 'node:timers/promises'; import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs'; import { loadavg } from 'node:os';
let tick = 0, cpu, wall, load; const pause = timers.setTimeout;
timers.setTimeout = function(ms, ...args) {
  if (++tick === 1) { cpu = process.cpuUsage(); wall = process.hrtime.bigint(); load = loadavg(); return Promise.resolve(); }
  if (tick === 2) {
    const used = process.cpuUsage(cpu); const elapsed = Number(process.hrtime.bigint() - wall) / 1e9;
    fs.writeFileSync(${JSON.stringify(tickFile)}, JSON.stringify({ wall_seconds: elapsed, user_seconds: used.user / 1e6, system_seconds: used.system / 1e6, load_average: load }));
    // End the fixture normally after this complete steady-state tick. These
    // fixture mutations happen after capturing CPU/wall and are not measured.
    fs.writeFileSync(${JSON.stringify(f.index)}, '[]');
    fs.writeFileSync(${JSON.stringify(join(f.fc, 'session-push', 'acks', f.openEvent.eventId + '.json'))}, '{}');
    return Promise.resolve();
  }
  return pause(ms, ...args);
}; syncBuiltinESMExports();`);
    for (const operation of ['statusline', 'Stop', 'wakeTick']) {
      const timeFile = join(f.root, `${operation}-time.json`);
      const args = operation === 'statusline' ? ['statusline', '--json'] : operation === 'Stop'
        ? ['hook', '--frontend', 'claude', '--event', 'Stop'] : ['wake'];
      if (operation === 'wakeTick') rmSync(waiter);
      const hostLoad = loadavg();
      const result = spawnSync('/usr/bin/time', ['-o', timeFile, '-f', '{"wall_seconds":%e,"user_seconds":%U,"system_seconds":%S,"exit_code":%x}',
        'nice', '-n', '19', process.execPath, ...(operation === 'wakeTick' ? ['--import', preload] : []), cli, 'session-push', ...args], {
        env, input: JSON.stringify({ session_id: f.session }), encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) throw new Error(`${variant}/${scale}/${operation} exit ${result.status}: ${result.error || result.stderr}`);
      const processTiming = JSON.parse(readFileSync(timeFile, 'utf8'));
      const timing = operation === 'wakeTick' ? JSON.parse(readFileSync(tickFile, 'utf8')) : { ...processTiming, load_average: hostLoad };
      const row = { variant, scale, operation, ...timing, cpu_seconds: timing.user_seconds + timing.system_seconds,
        cli_exit: result.status, process_timing: processTiming, registry_records: f.records, task_directories: f.tasks,
        registry_bytes: statSync(join(f.fc, 'tasks.jsonl')).size, ledger_entries: f.ledgerEntries, open_tasks: 1, open_ledger_entries: 2, pending_events: 1 };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  writeFileSync(join(root, 'measurements.json'), JSON.stringify(rows, null, 2) + '\n');
  return rows;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: session-cost-measure.mjs <private-scratch-root> <variant>');
  measureSessionCost(resolve(process.argv[2]), process.argv[3]);
}
