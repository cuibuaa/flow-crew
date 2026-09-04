import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `flowcrew status` is an operator surface, not a machine-wide lottery. Its
 * implicit scope is the invoking project; cross-project views are explicit.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsxLoader = import.meta.resolve('tsx');
let fixtureRoot: string;
let fcHome: string;
let projectA: string;
let projectB: string;
let projectC: string;

function writeRun(
  id: string,
  projectDir: string,
  title: string,
  status: string,
  mtimeMs: number,
): string {
  const directory = join(fcHome, 'runs', id);
  mkdirSync(directory, { recursive: true });
  const runJson = join(directory, 'run.json');
  writeFileSync(runJson, JSON.stringify({
    runId: id,
    projectDir: resolve(projectDir),
    workflowName: 'default',
    taskDescription: `# ${title}`,
    status,
    currentIteration: 1,
    maxIterations: 5,
    startedAt: '2000-01-01T00:00:00.000Z',
    ...(status === 'complete' ? { completedAt: '2000-01-01T00:01:00.000Z' } : {}),
    stages: { work: { status: status === 'complete' ? 'complete' : 'running', retries: 0 } },
  }, null, 2), 'utf-8');
  const timestamp = new Date(mtimeMs);
  utimesSync(runJson, timestamp, timestamp);
  return directory;
}

function status(args: string[] = [], cwd = projectB) {
  return spawnSync(
    process.execPath,
    ['--import', tsxLoader, join(repositoryRoot, 'src', 'cli.ts'), 'status', ...args],
    {
      cwd,
      env: {
        ...process.env,
        HOME: join(fixtureRoot, 'home'),
        FC_HOME: fcHome,
        TMPDIR: join(fixtureRoot, 'tmp'),
        PROJECT_DIR: '',
        NO_COLOR: '1',
      },
      encoding: 'utf-8',
      timeout: 60_000,
    },
  );
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-project-status-'));
  fcHome = join(fixtureRoot, 'state');
  projectA = join(fixtureRoot, 'project-a');
  projectB = join(fixtureRoot, 'project-b');
  projectC = join(fixtureRoot, 'project-c');
  for (const path of [fcHome, projectA, projectB, projectC, join(fixtureRoot, 'home'), join(fixtureRoot, 'tmp')]) {
    mkdirSync(path, { recursive: true });
  }
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('project-scoped status', () => {
  it('scopes the default to cwd and preserves explicit all/project escape hatches', () => {
    writeRun('run-b', projectB, 'Project B result', 'complete', 1_000);
    writeRun('run-a', projectA, 'Project A newer run', 'running', 2_000);

    const local = status();
    expect(local.status, local.stderr).toBe(0);
    expect(local.stdout).toContain('Project B result');
    expect(local.stdout).not.toContain('Project A newer run');

    const all = status(['--all']);
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout).toContain('Project A newer run');

    const explicit = status(['--project', projectA]);
    expect(explicit.status, explicit.stderr).toBe(0);
    expect(explicit.stdout).toContain('Project A newer run');

    const unrelated = status([], projectC);
    expect(unrelated.status, unrelated.stderr).toBe(0);
    expect(unrelated.stdout).toContain('No runs found for project:');
    expect(unrelated.stdout).not.toContain('Project A newer run');
    expect(unrelated.stdout).not.toContain('Project B result');

    const help = status(['--help']);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('flowcrew status [--all | --project <path>]');
  });

  it('renders terminal run.json truth instead of a stale In progress projection', () => {
    const directory = writeRun('terminal-b', projectB, 'Terminal Project B', 'complete', 1_000);
    writeFileSync(join(directory, 'progress.md'), '# In progress\n\nStale supervisor projection.\n', 'utf-8');

    const result = status();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Terminal Project B');
    expect(result.stdout).toContain('Status: complete');
    expect(result.stdout).not.toContain('In progress');
    expect(result.stdout).not.toContain('Stale supervisor projection');
    const drift = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith('Drift '));
    expect(drift).toHaveLength(6);
    expect(drift.every((line) => (
      line.includes('; unit=') && line.includes('; threshold=')
      && line.includes('; source=') && line.includes('; crossing=')
    ))).toBe(true);
    expect(drift.find((line) => line.startsWith('Drift research_dose:'))).toContain('value=unavailable');
  });
});
