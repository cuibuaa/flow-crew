import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const script = join(import.meta.dirname, '..', 'scripts', 'release.sh');
const metadata = readFileSync(script, 'utf8').match(/<<'NODE'\n([\s\S]*?)\nNODE/)![1];
let cwd: string;
const section = '\n### Changed\n\nRelease notes.\n\n';
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'release-spec-'));
  writeFileSync(join(cwd, 'CHANGELOG.md'), `# Changelog\n\n## [1.2.3] - 2026-10-14\n${section}## [1.2.2] - 2026-10-13\n\nOlder.\n`);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '1.2.2', name: 'fixture' }));
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ version: '1.2.2', packages: { '': { version: '1.2.2' }, dependency: { version: '9.0.0' } } }));
  writeFileSync(join(cwd, 'README.md'), '<img src="https://img.shields.io/badge/release-v1.2.2-2563eb.svg" alt="FlowCrew v1.2.2" />\nOther text.\n');
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const read = (file: string) => readFileSync(join(cwd, file), 'utf8');
const run = (mode: string, version = '1.2.3') => {
  const changelog = openSync(join(cwd, 'CHANGELOG.md'), 'r');
  try {
    return spawnSync(process.execPath, ['-', mode, version], {
      cwd, encoding: 'utf8', input: metadata, stdio: ['pipe', 'pipe', 'pipe', changelog],
      env: { ...process.env, HOME: cwd, FC_HOME: join(cwd, 'fc-home') },
    });
  } finally { closeSync(changelog); }
};

it('extracts only the dated section body, preserving subheadings and whitespace', () => {
  const result = run('notes');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(section);
});

it('updates release versions while preserving dependency versions and changelog bytes', () => {
  const changelog = read('CHANGELOG.md');
  const result = run('prepare');
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(read('package.json'))).toEqual({ version: '1.2.3', name: 'fixture' });
  expect(JSON.parse(read('package-lock.json'))).toEqual({ version: '1.2.3', packages: { '': { version: '1.2.3' }, dependency: { version: '9.0.0' } } });
  expect(read('README.md')).toBe('<img src="https://img.shields.io/badge/release-v1.2.3-2563eb.svg" alt="FlowCrew v1.2.3" />\nOther text.\n');
  expect(read('CHANGELOG.md')).toBe(changelog);
});

it.each(['## [1.2.2] - 2026-10-14', '## [1.2.3]', '## [1.2.3] - TBD'])(
  'rejects a missing or undated section before writing: %s', (heading) => {
    writeFileSync(join(cwd, 'CHANGELOG.md'), `${heading}\n\nNotes.\n`);
    const files = ['CHANGELOG.md', 'package.json', 'package-lock.json', 'README.md'];
    const before = files.map(read);
    for (const mode of ['notes', 'prepare']) {
      const result = run(mode);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Require one dated CHANGELOG section');
      expect(files.map(read)).toEqual(before);
    }
  },
);
