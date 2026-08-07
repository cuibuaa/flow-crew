import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRpcServer, type RpcRequest } from '../src/orchestrator-rpc.js';
import { extractTaskTitle } from '../src/store.js';

/**
 * Task registration is a user-facing projection of the brief, so both the
 * CLI and dashboard must call the same Markdown-aware title extractor.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsxLoader = import.meta.resolve('tsx');
let fixtureRoot: string;
let projectDir: string;
let fcHome: string;
let server: Server | undefined;

const titleCases = [
  {
    expected: 'Complete frontmatter title',
    brief: '---\nterminal_states:\n  shipped:\n    paths: [docs/report.md]\n---\nIntro before heading.\n# Complete frontmatter title\n',
  },
  {
    expected: 'No frontmatter title',
    brief: 'Intro before heading.\n## No frontmatter title\n',
  },
  {
    expected: 'Incomplete frontmatter title',
    brief: '---\nterminal_states:\n  shipped:\n    paths: [docs/report.md]\nIntro before heading.\n# Incomplete frontmatter title\n',
  },
] as const;

async function runBackgroundSubmit(brief: string): Promise<{ code: number | null; output: string }> {
  const child = spawn(
    process.execPath,
    [
      '--import', tsxLoader, join(repositoryRoot, 'src', 'cli.ts'),
      'quick', '--background', '--adapter', 'mock', '--acknowledge-brief-warnings',
      '--project', projectDir, '-',
    ],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: join(fixtureRoot, 'home'),
        FC_HOME: fcHome,
        TMPDIR: join(fixtureRoot, 'tmp'),
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(brief);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, output: stdout + stderr };
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-title-surfaces-'));
  projectDir = join(fixtureRoot, 'project');
  fcHome = join(fixtureRoot, 'state');
  for (const path of [projectDir, fcHome, join(fixtureRoot, 'home'), join(fixtureRoot, 'tmp'), join(projectDir, 'config')]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(projectDir, 'config', 'defaults.yaml'), [
    'default_timeout_ms: 3600000',
    'default_max_iterations: 5',
    'adapter: mock',
    '',
  ].join('\n'), 'utf-8');
});

afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('brief title extraction at registration surfaces', () => {
  it('finds the first Markdown heading for complete, absent, and incomplete frontmatter', () => {
    for (const fixture of titleCases) {
      expect(extractTaskTitle(fixture.brief)).toBe(fixture.expected);
    }
  });

  it('derives task titles through the shared extractor in the background CLI entry point', async () => {
    const requests: RpcRequest[] = [];
    server = await startRpcServer(join(fcHome, 'daemon.sock'), (request) => {
      requests.push(request);
      return {
        id: requests.length,
        unit: `flowcrew-task-${requests.length}.service`,
        pid: process.pid,
        build: 'title-test-build',
      };
    });

    for (const fixture of titleCases) {
      const result = await runBackgroundSubmit(fixture.brief);
      expect(result.code, result.output).toBe(0);
    }
    expect(requests.map((request) => request.cmd === 'register' ? request.task.name : '')).toEqual(
      titleCases.map((fixture) => fixture.expected),
    );
  });
});
