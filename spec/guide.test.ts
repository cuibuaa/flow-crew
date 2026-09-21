import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGuidanceLedger } from '../src/guidance.js';

let fixtureRoot: string;
let isolatedHome: string;
let isolatedFcHome: string;
let projectDir: string;
let runsDir: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-e10-guide-'));
  isolatedHome = join(fixtureRoot, 'home');
  isolatedFcHome = join(fixtureRoot, 'state');
  projectDir = join(fixtureRoot, 'project');
  runsDir = join(isolatedFcHome, 'runs');
  for (const directory of [isolatedHome, projectDir, runsDir]) {
    mkdirSync(directory, { recursive: true });
  }
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeRun(
  runId: string,
  status: string,
  title: string,
  mtimeOffsetSeconds: number,
  stageIds: string[] = [],
): void {
  const directory = join(runsDir, runId);
  mkdirSync(directory, { recursive: true });
  const runJson = join(directory, 'run.json');
  writeFileSync(runJson, JSON.stringify({
    runId,
    status,
    taskDescription: `# ${title}`,
    stages: Object.fromEntries(stageIds.map((stageId) => [stageId, { status: 'running', retries: 0 }])),
  }), 'utf-8');
  const timestamp = new Date(Date.UTC(2026, 7, 2, 12, 0, mtimeOffsetSeconds));
  utimesSync(runJson, timestamp, timestamp);
}

function runGuide(...guideArgs: string[]) {
  return spawnSync(
    process.execPath,
    [join(process.cwd(), 'dist', 'cli.js'), 'guide', ...guideArgs],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: isolatedHome,
        FC_HOME: isolatedFcHome,
        PROJECT_DIR: projectDir,
      },
      encoding: 'utf-8',
      timeout: 10_000,
    },
  );
}

function guidancePath(runId: string): string {
  return join(runsDir, runId, 'user_input.md');
}

describe('safe guide targeting', () => {
  it('refuses an ambiguous implicit target, lists both running candidates, and writes neither', () => {
    writeRun('run-alpha', 'running', 'Alpha task', 1);
    writeRun('run-beta', 'running', 'Beta task', 2);

    const result = runGuide('check the failing gate');
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('run-alpha');
    expect(output).toContain('run-beta');
    expect(existsSync(guidancePath('run-alpha'))).toBe(false);
    expect(existsSync(guidancePath('run-beta'))).toBe(false);
  });

  it('writes only the explicitly selected running run', () => {
    writeRun('run-alpha', 'running', 'Alpha task', 1);
    writeRun('run-beta', 'running', 'Beta task', 2);

    const result = runGuide('--run', 'run-alpha', 'use the isolated reproduction');

    expect(result.status).toBe(0);
    expect(readFileSync(guidancePath('run-alpha'), 'utf-8')).toBe('use the isolated reproduction');
    expect(existsSync(guidancePath('run-beta'))).toBe(false);
  });

  it('uses the only running run when the target is omitted, regardless of recency', () => {
    writeRun('run-live', 'running', 'Live task', 1);
    writeRun('run-finished', 'complete', 'Finished task', 2);

    const result = runGuide('continue with the live task');

    expect(result.status).toBe(0);
    expect(readFileSync(guidancePath('run-live'), 'utf-8')).toBe('continue with the live task');
    expect(existsSync(guidancePath('run-finished'))).toBe(false);
  });

  it('rejects traversal, unknown, and non-running explicit targets without writing', () => {
    writeRun('run-live', 'running', 'Live task', 1);
    writeRun('run-finished', 'failed', 'Finished task', 2);

    const traversal = runGuide('--run', '../run-live', 'unsafe');
    const unknown = runGuide('--run', 'run-missing', 'misdirected');
    const finished = runGuide('--run', 'run-finished', 'too late');

    expect([traversal.status, unknown.status, finished.status].every((status) => status !== 0)).toBe(true);
    expect(existsSync(guidancePath('run-live'))).toBe(false);
    expect(existsSync(guidancePath('run-finished'))).toBe(false);
  });

  it('[E2] sends --stage guidance directly to that running stage with a durable event', () => {
    writeRun('run-alpha', 'running', 'Alpha task', 1, ['plan', 'implement']);

    const result = runGuide(
      '--run', 'run-alpha',
      '--stage', 'implement',
      'use the already-isolated reproduction',
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(existsSync(guidancePath('run-alpha'))).toBe(false);
    const ledger = parseGuidanceLedger(readFileSync(join(runsDir, 'run-alpha', 'supervisor_guidance.md'), 'utf-8'));
    expect(ledger).toEqual([
      expect.objectContaining({
        target: 'implement',
        source: 'operator',
        body: 'use the already-isolated reproduction',
      }),
    ]);
    const events = readFileSync(join(runsDir, 'run-alpha', 'events.jsonl'), 'utf-8')
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'guidance_written',
      stageId: 'implement',
      source: 'operator',
    }));
  });
});
