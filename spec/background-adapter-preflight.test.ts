import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `flowcrew quick --background` is the line the ship skill runs. It hands the
 * run to the daemon, which resolves the adapter in a child process much later,
 * so a missing agent CLI used to surface only after a Task id had already been
 * printed — the worst possible place to learn that setup never finished.
 *
 * These tests pin both directions: the submit is refused when no adapter CLI
 * is reachable, and it is NOT refused for `mock`, which needs no CLI at all.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Hardcoded candidates rather than reading process.env.PATH: the spec purity
// gate treats an unguarded PATH read as a machine dependency.
const TOOL_CANDIDATES = [
  '/bin/sh', '/bin/bash', '/usr/bin/bash', '/usr/bin/env',
  '/usr/bin/git', '/bin/git',
  '/usr/bin/uname', '/bin/uname',
];

let root: string;
let farm: string;

function farmPath(): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const candidate of TOOL_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    const link = join(bin, candidate.slice(candidate.lastIndexOf('/') + 1));
    if (!existsSync(link)) symlinkSync(candidate, link);
  }
  // The interpreter must be reachable by name; it is never a system path on CI.
  const node = join(bin, 'node');
  if (!existsSync(node)) symlinkSync(process.execPath, node);
  return bin;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-bg-adapter-'));
  farm = farmPath();
  mkdirSync(join(root, 'home'), { recursive: true });
  mkdirSync(join(root, 'fc'), { recursive: true });
  mkdirSync(join(root, 'project'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runBackgroundSubmit(extraArgs: readonly string[]): { code: number | null; out: string } {
  const result = spawnSync(
    process.execPath,
    [
      '--import', 'tsx', join(repositoryRoot, 'src', 'cli.ts'),
      'quick', '--background', '--acknowledge-brief-warnings',
      '--project', join(root, 'project'),
      ...extraArgs,
      '-',
    ],
    {
      cwd: repositoryRoot,
      env: {
        HOME: join(root, 'home'),
        FC_HOME: join(root, 'fc'),
        PATH: farm,
        NO_COLOR: '1',
      },
      encoding: 'utf-8',
      input: '# Goal\nProbe the background adapter preflight.\n',
      timeout: 60_000,
    },
  );
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('background submit checks adapter availability before registering', () => {
  it('refuses the submit and names the install command when no agent CLI is reachable', () => {
    const { code, out } = runBackgroundSubmit([]);

    expect(code).toBe(1);
    expect(out).toMatch(/npm i -g/);
    // The failure must happen before the daemon is contacted; a Task id here
    // would mean the run was accepted with nothing able to execute it.
    expect(out).not.toMatch(/registered/i);
  });

  it('does not block the mock adapter, which needs no external CLI', () => {
    const { code, out } = runBackgroundSubmit(['--adapter', 'mock']);

    // It may still fail for an unrelated reason (no daemon in this fixture),
    // but it must not be the adapter-availability refusal.
    expect(out).not.toMatch(/Install Codex: npm i -g/);
    if (code === 1) expect(out).toMatch(/daemon|socket|connect/i);
  });
});
