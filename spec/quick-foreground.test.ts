import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { createEngineTaskRunResolver, publicTaskEntries, readTaskLedger, updateTaskEntry } from '../src/fc-tasks.js';
import { renderSessionProgress, sessionGate } from '../src/cli-session-push.js';
import { SessionPush } from '../src/session-push.js';
import { TaskRegistry } from '../src/task-registry.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';

const packageRoot = join(import.meta.dirname, '..');
const previousPath = process.env.PATH;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
});

// Only metadata RPC is implemented: a turn/start, launcher resume or other
// unexpected request fails the test instead of contacting any real frontend.
function metadataServer(calls: any[]) {
  return createServer(socket => {
    let input = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      if (!upgraded) {
        const end = input.indexOf('\r\n\r\n');
        if (end < 0) return;
        const nonce = /Sec-WebSocket-Key: (.+)\r\n/u.exec(input.toString())![1];
        const accept = createHash('sha1').update(nonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        input = input.subarray(end + 4); upgraded = true;
      }
      while (input.length >= 2) {
        let size = input[1] & 127;
        let offset = 2;
        if (size === 126) { if (input.length < 4) return; size = input.readUInt16BE(2); offset = 4; }
        if (input.length < offset + 4 + size) return;
        const mask = input.subarray(offset, offset + 4);
        const request = JSON.parse(Buffer.from(input.subarray(offset + 4, offset + 4 + size).map((v, i) => v ^ mask[i % 4])).toString());
        input = input.subarray(offset + 4 + size);
        calls.push(request);
        expect(['initialize', 'initialized', 'thread/start', 'thread/name/set']).toContain(request.method);
        if (request.id) {
          const body = Buffer.from(JSON.stringify({ id: request.id, result: request.method === 'thread/start' ? { thread: { id: 'own-display', parentThreadId: null } } : {} }));
          socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
        }
      }
    });
  });
}

it.each(['claude', 'codex'] as const)('foreground %s quick completes locally with registration, progress, delivery and explicit-only ACK gating', async frontend => {
  const root = mkdtempSync(join(tmpdir(), 'fc-qf-'));
  roots.push(root);
  const project = join(root, 'project');
  const engine = join(root, 'fc');
  const ledger = join(root, 'ledger');
  const bin = join(root, 'bin');
  const fixtures = join(root, 'fixtures');
  for (const path of [project, engine, bin, fixtures, join(root, 'home'), join(root, 'tmp')]) mkdirSync(path, { recursive: true });
  const brief = '# Foreground task\n\n## Acceptance criteria\n1. The tiny task completes with a wrap-up obligation.\n';
  const gate = { pass: true, reason: 'Tiny task checked.', criteria: Object.fromEntries(extractBriefCriteria(brief).criteria.map(c => [c.id, { status: 'pass', evidence: 'The deterministic stage completed.' }])), audit_findings: { version: 1, findings: [] } };
  writeFileSync(join(fixtures, 'implement.json'), JSON.stringify({ output_text: 'Tiny task completed.' }));
  writeFileSync(join(fixtures, 'review.json'), JSON.stringify({ output_text: JSON.stringify(gate) }));
  const queueFile = join(root, 'queue.jsonl');
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nif (process.argv[2] !== 'queue') process.exit(125);\nappendFileSync(${JSON.stringify(queueFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('Queued receipt');\n`);
  chmodSync(join(bin, 'codex'), 0o755);
  const inheritedPath = previousPath ?? [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter);
  process.env.PATH = `${bin}${delimiter}${inheritedPath}`;
  const env = { ...process.env, HOME: join(root, 'home'), FC_HOME: engine, FC_TASKS_ROOT: ledger,
    TMPDIR: join(root, 'tmp'), MOCK_FIXTURE_DIR: fixtures,
    FLOWCREW_DAEMON_SOCKET: join(engine, 'no-daemon.sock'),
    CLAUDE_CODE_SESSION_ID: frontend === 'claude' ? 'own-session' : undefined,
    CODEX_THREAD_ID: frontend === 'codex' ? 'own-session' : undefined,
    CODEX_HOME: join(root, 'home'), CLAUDE_CODE_MESSAGING_SOCKET: join(root, 'inbox.sock'),
    CODEX_APP_SERVER_SOCKET: join(root, 'metadata.sock'),
  };
  // Git is exercised only by this Node fixture in its disposable repository,
  // with private user/engine homes, matching the other CLI integration probes.
  const runner = join(root, 'runner.mjs');
  writeFileSync(runner, [
    "import { spawnSync } from 'node:child_process';",
    'const [file, ...args] = process.argv.slice(2);',
    "const result = spawnSync(file, args, { env: process.env, encoding: 'utf8', timeout: 5000 });",
    "process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || result.error?.message || '');",
    'process.exit(result.status ?? 1);',
  ].join('\n'));
  for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Fixture']]) {
    const result = spawnSync(process.execPath, [runner, 'git', ...args], {
      cwd: project, env: { ...env, HOME: join(root, 'home'), FC_HOME: engine }, encoding: 'utf8', timeout: 7500,
    });
    expect(result.status, result.stderr).toBe(0);
  }
  writeReadySetupRecord(project, brief, engine);
  const calls: any[] = [];
  const frames: string[] = [];
  const server = frontend === 'codex' ? metadataServer(calls) : createServer(socket => {
    let frame = '';
    socket.on('data', bytes => { frame += bytes.toString(); });
    socket.on('end', () => { frames.push(frame); });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(frontend === 'codex' ? env.CODEX_APP_SERVER_SOCKET : env.CLAUDE_CODE_MESSAGING_SOCKET, resolve));
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(packageRoot, 'src', 'cli.ts'),
    'quick', '-', '--project', project, '--adapter', 'mock', '--workflow', 'direct', '--no-campaign', '--acknowledge-brief-warnings'], {
    cwd: project, env: { ...env, HOME: join(root, 'home'), FC_HOME: engine }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 25_000,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.end(brief);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  expect(code, output).toBe(0);
  const registry = new TaskRegistry({ baseDir: engine });
  const tasks = registry.list({ status: 'all' });
  expect(tasks).toHaveLength(1);
  const task = tasks[0];
  expect(task).toMatchObject({ status: 'done', foregroundOwner: { pid: child.pid }, launcher: { frontend, sessionId: 'own-session' } });
  const run = JSON.parse(readFileSync(join(engine, 'runs', task.run_id!, 'run.json'), 'utf8'));
  expect(run).toMatchObject({ status: 'complete', engineCheckpoint: { pid: child.pid } });
  const entries = publicTaskEntries(readTaskLedger(ledger, 'own-session'));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ status: 'in_progress', flowcrewTaskId: task.id });
  const push = new SessionPush(registry);
  const events = push.events();
  expect(events.length).toBeGreaterThan(0);
  expect(push.pending()).toHaveLength(events.length);
  for (const event of events) {
    expect(push.delivery(event.eventId)).toMatchObject({ attempts: 1, sentAt: expect.any(String) });
    expect(frontend === 'codex' ? readFileSync(queueFile, 'utf8') : frames.join('')).toContain(event.eventId);
  }
  expect(push.display(task.id).progress?.status).toBe('complete');
  expect(renderSessionProgress(push, 'own-session', Date.now(), frontend).text).toContain('elapsed');
  if (frontend === 'codex') {
    expect(calls.filter(c => c.method === 'thread/start')).toHaveLength(1);
    expect(calls.filter(c => c.method === 'thread/name/set').at(-1).params.name).toMatch(/elapsed .*remaining/);
  }
  expect(sessionGate(push, frontend, 'own-session').decision).toBe('block');
  updateTaskEntry({ storeRoot: ledger, session: 'own-session', id: entries[0].id, entry: { status: 'completed' },
    taskRunResolver: createEngineTaskRunResolver({ engineRoot: engine }) });
  expect(sessionGate(push, frontend, 'own-session').decision).toBe('block');
  for (const event of events) push.acknowledge(event.eventId, 'own-session');
  expect(sessionGate(push, frontend, 'own-session')).toEqual({});
});
