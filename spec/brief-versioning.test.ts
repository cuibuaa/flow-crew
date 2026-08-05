import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bumpVersion, diffVersions, ensureBriefDir, readHead, rollback, versionPath } from '../src/brief-versioning.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), `flowcrew-brief-${randomBytes(4).toString('hex')}-`));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function readRevisions(briefDir: string): any[] {
  return readFileSync(join(briefDir, 'revisions.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('brief versioning', () => {
  it('ensureBriefDir creates v1.md and HEAD from seed', () => {
    const info = ensureBriefDir(tempDir, '# Brief\n');

    expect(info.version).toBe('v1');
    expect(readFileSync(join(tempDir, 'v1.md'), 'utf-8')).toBe('# Brief\n');
    expect(readFileSync(join(tempDir, 'HEAD'), 'utf-8')).toBe('v1\n');
  });

  it('readHead returns highest version when HEAD pointer is missing', () => {
    ensureBriefDir(tempDir, 'one\n');
    bumpVersion(tempDir, 'two\n', 'second');
    unlinkSync(join(tempDir, 'HEAD'));

    const head = readHead(tempDir);

    expect(head.version).toBe('v2');
    expect(head.path).toBe(versionPath(tempDir, 'v2'));
  });

  it('bumpVersion writes the next immutable file, updates HEAD, and appends audit JSONL', () => {
    ensureBriefDir(tempDir, 'one\n');
    const next = bumpVersion(tempDir, 'two\n', 'test patch');

    expect(next.version).toBe('v2');
    expect(readFileSync(join(tempDir, 'v2.md'), 'utf-8')).toBe('two\n');
    expect(readFileSync(join(tempDir, 'HEAD'), 'utf-8')).toBe('v2\n');
    expect(readRevisions(tempDir)).toMatchObject([
      { from: 'v1', to: 'v2', reason: 'test patch' },
    ]);
    expect(readRevisions(tempDir)[0].diff).toContain('-one');
    expect(readRevisions(tempDir)[0].diff).toContain('+two');
  });

  it('rollback updates HEAD, appends a rollback entry, and leaves version files untouched', () => {
    ensureBriefDir(tempDir, 'one\n');
    bumpVersion(tempDir, 'two\n', 'second');
    bumpVersion(tempDir, 'three\n', 'third');

    const head = rollback(tempDir, 'v2', 'bad patch');

    expect(head.version).toBe('v2');
    expect(readFileSync(join(tempDir, 'HEAD'), 'utf-8')).toBe('v2\n');
    expect(existsSync(join(tempDir, 'v3.md'))).toBe(true);
    const revisions = readRevisions(tempDir);
    expect(revisions.at(-1)).toMatchObject({ from: 'v3', to: 'v2', reason: 'bad patch' });
  });

  it('diffVersions produces a unified diff', () => {
    ensureBriefDir(tempDir, 'alpha\nbeta\n');
    bumpVersion(tempDir, 'alpha\ngamma\n', 'change beta');

    const diff = diffVersions(tempDir, 'v1', 'v2');

    expect(diff).toContain('--- v1');
    expect(diff).toContain('+++ v2');
    expect(diff).toContain('-beta');
    expect(diff).toContain('+gamma');
  });

  it('serializes concurrent bumps without corrupting HEAD', async () => {
    ensureBriefDir(tempDir, 'v1\n');

    await Promise.all([
      new Promise((resolve) => setImmediate(() => resolve(bumpVersion(tempDir, 'first\n', 'first')))),
      new Promise((resolve) => setImmediate(() => resolve(bumpVersion(tempDir, 'second\n', 'second')))),
    ]);

    expect(readHead(tempDir).version).toBe('v3');
    expect(existsSync(join(tempDir, 'v2.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'v3.md'))).toBe(true);
    expect(readRevisions(tempDir)).toHaveLength(2);
  });
});
