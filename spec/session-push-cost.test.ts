import './test-support/policy-runtime.js';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { processStartToken } from '../src/run-lock.js';
import { sessionCostFixture } from './test-support/session-cost-fixture.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }, 180_000);
const cli = join(import.meta.dirname, '../dist/cli.js');
const preload = join(import.meta.dirname, 'test-support/session-cost-io-preload.mjs');

it('statusline, Stop and a wake tick read the same records and open the same files at 1x and 10x history', () => {
  const results = [];
  for (const scale of [1, 10]) {
    const root = mkdtempSync(join(tmpdir(), 'fc-session-cost-')); roots.push(root);
    const f = sessionCostFixture(root, scale);
    const fixturePath = join(root, 'fixture.json'); writeFileSync(fixturePath, JSON.stringify(f));
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(99); console.log('2.1.308 (fixture)');\n`);
    chmodSync(join(bin, 'claude'), 0o700);
    const token = processStartToken(process.pid);
    const fakeLease = join(f.fc, 'session-push', 'waiters', createHash('sha256').update(f.session).digest('hex') + '.json');
    writeFileSync(fakeLease, JSON.stringify({ session: f.session, pid: process.pid, start: token,
      processStartTime: token?.kind === 'linux' ? token.value : undefined, host: process.pid, hostStart: token,
      expiresAt: Date.now() + 600_000, token: 'fixture-coverage',
      ...(process.platform === 'linux' ? { bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } : {}) }));
    const scopedEvent = join(f.fc, 'session-push', 'pending', createHash('sha256').update(JSON.stringify(['claude', f.session])).digest('hex'), f.openEvent.eventId + '.json');
    const ack = join(f.fc, 'session-push', 'acks', f.openEvent.eventId + '.json');
    const result: Record<string, Record<string, number>> = {};
    for (const operation of ['statusline', 'Stop', 'StopIdle', 'wakeTick']) {
      if (operation === 'StopIdle') { writeFileSync(ack, '{}'); rmSync(scopedEvent); }
      if (operation === 'wakeTick') { rmSync(ack); writeFileSync(scopedEvent, JSON.stringify(f.openEvent)); rmSync(fakeLease); }
      const receipt = join(root, operation + '-io.json');
      const args = operation === 'statusline' ? ['statusline', '--json'] : (operation === 'Stop' || operation === 'StopIdle')
        ? ['hook', '--frontend', 'claude', '--event', 'Stop'] : ['wake'];
      const child = spawnSync(process.execPath, ['--import', preload, cli, 'session-push', ...args], {
        env: { ...process.env, HOME: root, USERPROFILE: root, FC_HOME: f.fc, FC_TASKS_ROOT: f.ledger,
          CODEX_HOME: join(root, 'codex'), AGENT_TASK_ROOT: join(root, 'agents'), FLOWCREW_DAEMON_SOCKET: join(root, 'daemon.sock'),
          PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: '', SESSION_COST_FIXTURE: fixturePath, SESSION_COST_OPERATION: operation, SESSION_COST_IO: receipt },
        input: JSON.stringify({ session_id: f.session }), encoding: 'utf8', timeout: 120_000,
      });
      expect(child.status, `${operation}: ${child.error || child.stderr || child.stdout}`).toBe(0);
      result[operation] = JSON.parse(readFileSync(receipt, 'utf8'));
    }
    results.push(result);
  }
  console.log('session-cost deterministic I/O', JSON.stringify(results));
  expect(results[1]).toEqual(results[0]);
  for (const result of results) for (const call of Object.values(result)) {
    expect(call.historicalLedgerRecords).toBe(0);
    expect(call.globalEventRecords).toBe(0);
  }
  expect(results[0].statusline.registryRecords).toBeGreaterThan(0);
  expect(results[0].wakeTick.registryRecords).toBeGreaterThan(0);
  expect(results[0].StopIdle.registryRecords).toBeGreaterThan(0);
}, 600_000);
