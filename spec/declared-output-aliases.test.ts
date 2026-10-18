import { hashRollbackFileSync } from '../src/rollback-content-store.js';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { archiveDeclaredOutputs, isPathSafelyArchived } from '../src/declared-output-archive.js';
import { inspectBriefOutputs, type BriefOutputDeclaration } from '../src/ship-inputs.js';

let root: string, project: string, run: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'declared-output-aliases-'));
  project = join(root, 'project'); run = join(root, 'archive');
  mkdirSync(project); mkdirSync(run);
  writeFileSync(join(project, 'source.md'), 'source bytes');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const declaration = (path: string, expectedType: 'file' | 'directory' = 'file'): BriefOutputDeclaration => ({
  path, expectedType, disposition: 'create', source: 'outputs', line: 2,
});
const inventory = (disposition?: string) => inspectBriefOutputs(`---\noutputs:\n  - path: report.md\n${disposition ? `    on_existing: ${disposition}\n` : ''}---\n`, project);
const archiveFs = { hashFile: hashRollbackFileSync };

it.each(['update', 'append', 'replace'])('admits an output alias with explicit %s authority', disposition => {
  symlinkSync('source.md', join(project, 'report.md'));
  expect(inventory().blocking).toHaveLength(1);
  expect(inventory(disposition).entries[0]).toMatchObject({ entryType: 'symlink', blocking: false, disposition });
});

it('admits intentional input reuse of an output alias', () => {
  symlinkSync('source.md', join(project, 'report.md'));
  expect(inspectBriefOutputs('---\ninputs: [report.md]\noutputs: [report.md]\n---\n', project).entries[0])
    .toMatchObject({ entryType: 'symlink', disposition: 'input', blocking: false });
});

it('requires matching target type when following an alias and permits explicit replacement', () => {
  mkdirSync(join(project, 'directory')); symlinkSync('directory', join(project, 'report.md'));
  expect(inventory('update').blocking).toHaveLength(1);
  expect(inventory('replace').blocking).toHaveLength(0);
});

it.each(['existing', 'absent'])('admits an explicitly updated %s output through its aliased parent', state => {
  const target = join(project, 'data'); mkdirSync(target);
  if (state === 'existing') writeFileSync(join(target, 'report.md'), 'existing report');
  symlinkSync(target, join(project, 'linked'));
  expect(inspectBriefOutputs('---\noutputs:\n  - path: linked/report.md\n    on_existing: update\n---\n', project).blocking).toHaveLength(0);
});

it('archives file and directory link objects without copying their target members', () => {
  mkdirSync(join(project, 'reports')); mkdirSync(join(project, 'data')); mkdirSync(join(project, '.fc'));
  writeFileSync(join(project, 'data', 'row.csv'), 'target data');
  const protectedTargets = [join(root, 'outside.md'), join(project, '.fc', 'state.md')];
  for (const target of protectedTargets) writeFileSync(target, 'protected bytes');
  const links = [['report.md', '../source.md'], ['data', '../data'], ['future.md', '../future.md'],
    ['self', '.'], ['project', '..'], ['external', protectedTargets[0]], ['engine', protectedTargets[1]]];
  for (const [name, target] of links) {
    symlinkSync(target, join(project, 'reports', name));
  }
  const manifest = archiveDeclaredOutputs(project, run, [declaration('reports', 'directory')]);
  expect(manifest.outputs[0]).toMatchObject({ members: [
    { path: 'data', type: 'symlink' }, { path: 'engine', type: 'symlink' }, { path: 'external', type: 'symlink' },
    { path: 'future.md', type: 'symlink' }, { path: 'project', type: 'symlink' },
    { path: 'report.md', type: 'symlink' }, { path: 'self', type: 'symlink' },
  ] });
  for (const [name] of links) {
    const archived = join(run, 'declared_outputs', 'reports', name);
    expect(lstatSync(archived).isSymbolicLink()).toBe(true);
    expect(readlinkSync(archived, { encoding: 'buffer' })).toEqual(readlinkSync(join(project, 'reports', name), { encoding: 'buffer' }));
    expect(isPathSafelyArchived(project, run, `reports/${name}`, archiveFs)).toBe(true);
  }
  writeFileSync(join(project, 'source.md'), 'changed target bytes');
  expect(isPathSafelyArchived(project, run, 'reports/report.md', archiveFs)).toBe(true);
  rmSync(join(project, 'reports/report.md')); symlinkSync('../future.md', join(project, 'reports/report.md'));
  expect(isPathSafelyArchived(project, run, 'reports/report.md', archiveFs)).toBe(false);
  rmSync(join(project, 'reports/report.md')); writeFileSync(join(project, 'reports/report.md'), '../source.md');
  expect(isPathSafelyArchived(project, run, 'reports/report.md', archiveFs)).toBe(false);
  for (const target of protectedTargets) expect(readFileSync(target, 'utf8')).toBe('protected bytes');
});

it('archives an output through a confined directory ancestor and preserves a declared root link', () => {
  mkdirSync(join(project, 'reports')); writeFileSync(join(project, 'reports/report.md'), 'report bytes');
  symlinkSync('reports', join(project, 'alias'));
  expect(archiveDeclaredOutputs(project, run, [declaration('alias/report.md')]).complete).toBe(true);
  expect(readFileSync(join(run, 'declared_outputs/alias/report.md'), 'utf8')).toBe('report bytes');
  expect(archiveDeclaredOutputs(project, run, [declaration('alias', 'directory')]).complete).toBe(true);
  expect(lstatSync(join(run, 'declared_outputs/alias')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(run, 'declared_outputs/alias'))).toBe('reports');
  expect(isPathSafelyArchived(project, run, 'alias', archiveFs)).toBe(true);
});
