import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { startRpcServer } from '../src/orchestrator-rpc.js';

const repositoryRoot = join(import.meta.dirname, '..');
const fixtures: string[] = [];
let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fc-cli-pipe-'));
  fixtures.push(root);
  const home = join(root, 'home');
  const fcHome = join(root, 'state');
  mkdirSync(home);
  mkdirSync(fcHome);
  return { root, home, fcHome };
}

async function runCli(
  args: string[],
  isolated: ReturnType<typeof fixture>,
  closedPipe?: 'stdout' | 'stderr',
  consumeFirstChunk = false,
) {
  const child = spawn(process.execPath, ['--import', 'tsx', join(repositoryRoot, 'src', 'cli.ts'), ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, HOME: isolated.home, FC_HOME: isolated.fcHome },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  if (closedPipe) {
    const reader = child[closedPipe];
    if (consumeFirstChunk) reader.once('data', () => reader.destroy());
    else reader.destroy();
  }
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { ...result, stdout, stderr };
}

function expectPipeExit(result: Awaited<ReturnType<typeof runCli>>) {
  expect(result.code === 0 || result.signal === 'SIGPIPE', JSON.stringify(result)).toBe(true);
  expect(result.stdout + result.stderr).not.toContain('EPIPE');
}

describe('CLI output pipes', () => {
  it.each([
    ['early command help', ['task', 'show', '--help'], 'stdout'],
    ['console help', ['--help'], 'stdout'],
    ['task command errors', ['task', 'invalid'], 'stderr'],
    ['quick command errors', ['quick'], 'stderr'],
  ] as const)('exits quietly when the reader closes %s', async (_label, args, stream) => {
    expectPipeExit(await runCli([...args], fixture(), stream));
  });

  it('exits quietly when a task detail reader closes after its first match', async () => {
    const isolated = fixture();
    const socket = join(isolated.root, 'daemon.sock');
    server = await startRpcServer(socket, (request) => ({
      task: {
        id: request.cmd === 'show' ? request.id : undefined,
        name: 'Pipe fixture',
        status: 'incomplete',
        attempt: 1,
        max_retries: 0,
        projectDir: isolated.root,
        systemd_unit: 'fixture.service',
        notes: 'Remaining output.\n'.repeat(65_536),
      },
      recent_ticks: [],
    }));

    const result = await runCli(['task', 'show', String(1), '--socket', socket], isolated, 'stdout', true);

    expect(result.stdout).toContain('Pipe fixture');
    expectPipeExit(result);
  });

  it.each([
    ['task', 'invalid'],
    ['quick'],
  ])('retains the command failure status with an open reader for %s', async (...args) => {
    const result = await runCli(args, fixture());

    expect(result).toMatchObject({ code: 1, signal: null });
    expect(result.stderr).toContain('Usage: flowcrew');
  });
});
