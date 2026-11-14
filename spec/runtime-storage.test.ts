import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import * as engineFs from '../src/engine-fs.js';
import { BUILD_MANIFEST_FILENAME, computeBuildInputDigest, createBuildManifest, pinBuildRuntime, readBuildManifest, validateTaskRuntime } from '../src/build-manifest.js';

// Fixture dependency trees live in a temporary project; the directory name is the package manager's.
const deps = 'node_modules';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'fc-storage-')); roots.push(root);
  const project = join(root, 'project'), runtime = join(root, 'runtime');
  for (const directory of ['src', 'dist', 'config', `${deps}/.cache`, `${deps}/.bin`, `${deps}/fixture-dev`, 'ui/src', 'ui/dist', 'dependency']) {
    fs.mkdirSync(join(project, directory), { recursive: true });
  }
  for (const [path, bytes] of Object.entries({
    'package.json': '{"type":"module"}', 'tsconfig.json': '{}', 'ui/package.json': '{}',
    'package-lock.json': JSON.stringify({ packages: {
      [`${deps}/fixture-dep`]: {}, [`${deps}/fixture-dev`]: { dev: true },
    } }),
    'ui/dist/index.html': '<html>retained</html>', 'config/value.txt': 'resource one',
    'dependency/package.json': '{"name":"fixture-dep","type":"module","main":"index.js"}',
    'dependency/index.js': 'export const value = "dependency one";',
    [`${deps}/.cache/ignored`]: 'cache',
    [`${deps}/fixture-dev/package.json`]: '{"name":"fixture-dev"}',
    [`${deps}/fixture-dev/index.js`]: 'development only',
  })) fs.writeFileSync(join(project, path), bytes);
  fs.chmodSync(join(project, 'dependency/index.js'), 0o751);
  fs.symlinkSync(join(project, 'dependency'), join(project, `${deps}/fixture-dep`));
  fs.symlinkSync('../fixture-dev/index.js', join(project, `${deps}/.bin/fixture-dev`));
  fs.symlinkSync(join(project, 'config/value.txt'), join(project, 'config/alias.txt'));
  const publish = (build: number) => {
    const bytes = `import { value } from 'fixture-dep';
import { readFileSync } from 'node:fs';
export const build = ${build};
export const load = () => [build, value, readFileSync(new URL('../config/value.txt', import.meta.url), 'utf8')];`;
    fs.writeFileSync(join(project, 'src/cli.ts'), bytes);
    fs.writeFileSync(join(project, 'dist/cli.js'), bytes);
    fs.chmodSync(join(project, 'dist/cli.js'), 0o755);
    fs.writeFileSync(join(project, 'dist/cli.d.ts'), 'export declare const build: number;');
    const manifest = createBuildManifest(project, join(project, 'dist'), {
      stagedUiDir: join(project, 'ui/dist'), builtAt: '2025-01-01T00:00:00.000Z',
    });
    fs.writeFileSync(join(project, 'dist', BUILD_MANIFEST_FILENAME), JSON.stringify(manifest));
    const dist = pinBuildRuntime(join(project, 'dist'), runtime);
    return { generation: manifest.generation, cliPath: join(dist, 'cli.js') };
  };
  return { project, runtime, publish };
}

type Reference = ReturnType<ReturnType<typeof fixture>['publish']>;
function load(reference: Reference, runtime: string): unknown {
  validateTaskRuntime(reference, runtime);
  // A new process loads after each mutation, with no module cache from publication.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(reference.cliPath).href)}); console.log(JSON.stringify(m.load()));`],
  { encoding: 'utf8', timeout: 10_000, cwd: runtime, env: { HOME: runtime, FC_HOME: runtime } });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

it('retains only non-dev lockfile packages and attests exactly the copied files', () => {
  const f = fixture(), reference = f.publish(1), base = dirname(dirname(reference.cliPath));
  expect(fs.existsSync(join(base, `${deps}/fixture-dev`))).toBe(false);
  expect(fs.existsSync(join(base, `${deps}/.bin/fixture-dev`))).toBe(false);
  const paths = readBuildManifest(dirname(reference.cliPath))!.inputs.files.map(record => record.path);
  expect(paths).toContain(`${deps}/fixture-dep/index.js`);
  expect(paths.some(path => path.startsWith(`${deps}/fixture-dev/`))).toBe(false);
  expect(paths).not.toContain(`${deps}/.bin/fixture-dev`);
  const before = computeBuildInputDigest(f.project);
  fs.writeFileSync(join(f.project, `${deps}/fixture-dev/index.js`), 'changed development bytes');
  expect(computeBuildInputDigest(f.project)).toEqual(before);
  expect(load(reference, f.runtime)).toEqual([1, 'dependency one', 'resource one']);
});

it.each([{}, { dev: false }, { optional: true }, { devOptional: true }])('retains packages with lockfile fields %j', fields => {
  const f = fixture();
  const lockfile = join(f.project, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
  lock.packages[`${deps}/fixture-dev`] = fields;
  fs.writeFileSync(lockfile, JSON.stringify(lock));
  const reference = f.publish(1), base = dirname(dirname(reference.cliPath));
  expect(fs.readFileSync(join(base, `${deps}/fixture-dev/index.js`), 'utf8')).toBe('development only');
  expect(readBuildManifest(dirname(reference.cliPath))!.inputs.files.map(record => record.path))
    .toContain(`${deps}/fixture-dev/index.js`);
  validateTaskRuntime(reference, f.runtime);
});

it.each(['missing lockfile', 'missing packages map'])('retains the complete dependency tree with %s', missing => {
  const f = fixture(), lockfile = join(f.project, 'package-lock.json');
  if (missing === 'missing lockfile') fs.rmSync(lockfile);
  else fs.writeFileSync(lockfile, JSON.stringify({ lockfileVersion: 1, dependencies: { 'fixture-dev': { dev: true } } }));
  const reference = f.publish(1), base = dirname(dirname(reference.cliPath));
  expect(fs.existsSync(join(base, `${deps}/fixture-dev/index.js`))).toBe(true);
  expect(fs.existsSync(join(base, `${deps}/.bin/fixture-dev`))).toBe(true);
  expect(load(reference, f.runtime)).toEqual([1, 'dependency one', 'resource one']);
});

it('detects a development-only package added to an already published generation', () => {
  const f = fixture(), reference = f.publish(1), base = dirname(dirname(reference.cliPath));
  validateTaskRuntime(reference, f.runtime);
  fs.cpSync(join(f.project, `${deps}/fixture-dev`), join(base, `${deps}/fixture-dev`), { recursive: true });
  expect(() => validateTaskRuntime(reference, f.runtime)).toThrow('Runtime resources artifact inventory');
  expect(() => pinBuildRuntime(join(f.project, 'dist'), f.runtime)).toThrow('Runtime resources artifact inventory');
});

it.each(['in-place write', 'replacement', 'removal'])('loads retained dependency and resource bytes after source %s', operation => {
  const f = fixture(), first = f.publish(1), second = f.publish(2);
  expect(first.generation).not.toBe(second.generation);
  for (const path of ['dependency/index.js', 'config/value.txt']) {
    const source = join(f.project, path);
    if (operation !== 'in-place write') fs.rmSync(source);
    if (operation !== 'removal') fs.writeFileSync(source, 'replaced source bytes');
  }
  if (operation === 'removal') {
    for (const path of ['dependency', 'config']) fs.rmSync(join(f.project, path), { recursive: true });
  }
  expect(load(first, f.runtime)).toEqual([1, 'dependency one', 'resource one']);
  expect(load(second, f.runtime)).toEqual([2, 'dependency one', 'resource one']);
});

it.each([`${deps}/fixture-dep/index.js`, 'config/value.txt', 'dist/cli.js', 'ui/dist/index.html'])('isolates and detects changed, added and missing %s across verified generations', path => {
  const f = fixture(), first = f.publish(1), second = f.publish(2);
  validateTaskRuntime(first, f.runtime); validateTaskRuntime(second, f.runtime);
  const original = join(dirname(dirname(first.cliPath)), path);
  const bytes = fs.readFileSync(original);
  const other = join(dirname(dirname(second.cliPath)), path);
  const otherBytes = fs.readFileSync(other);
  expect(fs.statSync(original).ino).not.toBe(fs.statSync(other).ino);
  fs.writeFileSync(original, 'tampered through the first generation');
  expect(() => validateTaskRuntime(first, f.runtime)).toThrow();
  expect(fs.readFileSync(other)).toEqual(otherBytes);
  expect(load(second, f.runtime)).toEqual([2, 'dependency one', 'resource one']);
  fs.writeFileSync(original, bytes);
  const added = join(dirname(original), 'undeclared.txt'); fs.writeFileSync(added, 'added');
  expect(() => validateTaskRuntime(first, f.runtime)).toThrow();
  fs.rmSync(added); validateTaskRuntime(first, f.runtime);
  fs.rmSync(original);
  expect(() => validateTaskRuntime(first, f.runtime)).toThrow();
  expect(load(second, f.runtime)).toEqual([2, 'dependency one', 'resource one']);
});

it.each([0, 1])('keeps the other generation loadable after explicit removal of generation %s', removed => {
  const f = fixture(), generations = [f.publish(1), f.publish(2)];
  fs.rmSync(dirname(dirname(generations[removed].cliPath)), { recursive: true });
  expect(load(generations[1 - removed], f.runtime)).toEqual([2 - removed, 'dependency one', 'resource one']);
});

it('leaves the selected runtime intact and removes partial copies after a copy error', () => {
  const f = fixture(), first = f.publish(1);
  const copy = engineFs.cpSync;
  vi.spyOn(engineFs, 'cpSync').mockImplementation((source, destination, options) => {
    if (String(source) === join(f.project, 'config')) throw Object.assign(new Error('fixture copy error'), { code: 'EIO' });
    return copy(source, destination, options);
  });
  expect(() => f.publish(2)).toThrow('fixture copy error');
  expect(fs.realpathSync(join(f.runtime, 'dist/cli.js'))).toBe(first.cliPath);
  expect(fs.readdirSync(join(f.runtime, '.cache/build-generations'))).toEqual([first.generation]);
  expect(load(first, f.runtime)).toEqual([1, 'dependency one', 'resource one']);
});

it.each([false, true])('requests best-effort cloning and preserves copy semantics (simulated unsupported=%s)', unsupported => {
  // The existing mutation seam records the requested primitive. Mode zero models
  // the full-copy result on hosts without cloning; this is not a real clone probe.
  const copy = engineFs.cpSync;
  const calls = vi.spyOn(engineFs, 'cpSync').mockImplementation((source, destination, options) => {
    expect(options?.mode).toBe(fs.constants.COPYFILE_FICLONE);
    return copy(source, destination, unsupported ? { ...options, mode: 0 } : options);
  });
  const f = fixture(), first = f.publish(1), second = f.publish(2);
  expect(calls).toHaveBeenCalled();
  const base = dirname(dirname(first.cliPath));
  for (const [path, mode] of [['dist/cli.js', 0o755], [`${deps}/fixture-dep/index.js`, 0o751]] as const) {
    expect(fs.statSync(join(base, path)).mode & 0o777).toBe(mode);
    expect(fs.statSync(join(base, path)).nlink).toBe(1);
  }
  expect(fs.lstatSync(join(base, `${deps}/fixture-dep`)).isDirectory()).toBe(true);
  expect(fs.lstatSync(join(base, 'config/alias.txt')).isFile()).toBe(true);
  expect(fs.existsSync(join(base, `${deps}/.cache`))).toBe(false);
  fs.writeFileSync(join(f.project, 'config/value.txt'), 'source write');
  fs.writeFileSync(join(base, `${deps}/fixture-dep/index.js`), 'generation write');
  expect(() => validateTaskRuntime(first, f.runtime)).toThrow();
  expect(load(second, f.runtime)).toEqual([2, 'dependency one', 'resource one']);
});
