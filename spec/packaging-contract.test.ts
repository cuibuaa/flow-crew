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

/**
 * The README quotes a command total in two places. They silently drifted apart the
 * moment `flowcrew adapter` was added (one said 20, the other still said 19), because
 * nothing tied either number to the CLI. Derive the count instead of trusting prose.
 */
describe('documented command count', () => {
  function helpCommands(): string[] {
    const source = readFileSync(join(repositoryRoot, 'src', 'cli.ts'), 'utf-8');
    const dispatch = source.slice(source.indexOf('switch (command)'));
    const names = new Set<string>();
    for (const [, name] of dispatch.matchAll(/^\s*case '([a-z][a-z-]*)':/gm)) names.add(name);
    return [...names].sort();
  }

  it('keeps every README command total equal to the real dispatch table', () => {
    const total = helpCommands().length;
    expect(total).toBeGreaterThan(0);
    const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf-8');
    const quoted = [...readme.matchAll(/\b(?:all|All)\s+(\d+)\s+commands\b/g)].map((m) => Number(m[1]));
    expect(quoted.length, 'README should quote the command total at least once').toBeGreaterThan(0);
    for (const n of quoted) expect(n, `README says ${n} commands; the dispatch table has ${total}`).toBe(total);
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
