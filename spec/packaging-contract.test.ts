import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..');

function packageFilesField(): string[] {
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, 'package.json'), 'utf-8'),
  ) as { files?: unknown };
  expect(Array.isArray(manifest.files), 'package.json must declare a files allowlist').toBe(true);
  return manifest.files as string[];
}

function trackedUnder(prefix: string): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', prefix], {
    cwd: repositoryRoot,
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  }).split('\0').filter(Boolean);
}

/**
 * `files` is an allowlist: anything absent is silently dropped from the published
 * tarball. skills/ is not documentation — install.sh and ship.md are the runtime
 * inputs behind `/ship`, the documented primary entry point — and
 * examples/hello-research.brief.md is the argument of the first command the README
 * quickstart tells a newcomer to run. Omitting either ships a CLI whose own
 * quickstart cannot be followed, and npm gives no warning when it happens.
 */
describe('published package contents', () => {
  const runtimeRequired = [
    { entry: 'skills', mustContain: ['skills/install.sh', 'skills/ship.md'] },
    { entry: 'examples', mustContain: ['examples/hello-research.brief.md'] },
    { entry: 'guide', mustContain: ['guide/cli.md'] },
    { entry: 'config', mustContain: ['config/defaults.yaml'] },
    { entry: 'dist', mustContain: [] },
    { entry: 'ui/dist', mustContain: [] },
    { entry: 'README.md', mustContain: ['README.md'] },
    { entry: 'LICENSE', mustContain: ['LICENSE'] },
  ];

  it('allowlists every directory the CLI needs at runtime', () => {
    const files = packageFilesField();
    for (const { entry } of runtimeRequired) {
      expect(files, `package.json "files" must include ${entry}`).toContain(entry);
    }
  });

  it('keeps each allowlisted runtime path tracked and non-empty', () => {
    for (const { entry, mustContain } of runtimeRequired) {
      if (mustContain.length === 0) continue; // build outputs are gitignored by design
      const tracked = trackedUnder(entry);
      expect(tracked.length, `${entry} must be tracked to reach the tarball`).toBeGreaterThan(0);
      for (const path of mustContain) {
        expect(tracked, `${path} must be tracked`).toContain(path);
      }
    }
  });
});
