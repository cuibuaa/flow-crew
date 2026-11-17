import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '../..');

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
    timeout: 10_000, killSignal: 'SIGKILL',
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
    { entry: 'dist-rewrite', mustContain: [] },
    { entry: 'dist-monitor', mustContain: [] },
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

/**
 * Section moves break `](#anchor)` links silently — GitHub renders a dead link exactly
 * like a live one. This caught nothing on the day it was written; it exists so the next
 * reorder cannot quietly strand a cross-reference.
 */
describe('README internal anchors', () => {
  it('resolves every in-page link to a heading that exists', () => {
    const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf-8');
    const slug = (heading: string) => heading
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .trim()
      .replace(/\s+/g, '-');
    const headings = new Set(
      [...readme.matchAll(/^#{1,6} (.+)$/gm)].map(([, text]) => slug(text)),
    );
    const targets = [...readme.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map(([, anchor]) => anchor);
    expect(targets.length, 'README should contain at least one in-page link').toBeGreaterThan(0);
    for (const anchor of targets) {
      expect(headings, `README links to #${anchor}, which no heading produces`).toContain(anchor);
    }
  });
});

describe('release metadata cannot drift', () => {
  // The README badge and package.json are two statements of the same fact, and
  // nothing previously reconciled them: v0.5.0 shipped with the badge already
  // one release stale. A version bump that forgets the badge now fails here
  // rather than being noticed by a reader months later.
  it('states the same version in package.json, the README badge, and its alt text', () => {
    const version = JSON.parse(
      readFileSync(join(repositoryRoot, 'package.json'), 'utf-8'),
    ).version as string;
    const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf-8');

    expect(readme).toContain(`badge/release-v${version}-`);
    expect(readme).toContain(`alt="FlowCrew v${version}"`);
  });

  it('has a dated changelog section for the version being shipped', () => {
    const version = JSON.parse(
      readFileSync(join(repositoryRoot, 'package.json'), 'utf-8'),
    ).version as string;
    const changelog = readFileSync(join(repositoryRoot, 'CHANGELOG.md'), 'utf-8');

    expect(changelog).toMatch(
      new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
    );
  });
});
