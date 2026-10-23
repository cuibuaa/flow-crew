import { cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, lstatSync, copyFileSync, symlinkSync, realpathSync, chmodSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertBuildArtifactInventory, assertDistFresh, collectBuildArtifacts, createBuildManifest, publishBuildOutputs, pinBuildRuntime, readBuildManifest, buildProjectRoot, computeBuildInputDigest, isBuildManifest, BUILD_MANIFEST_FILENAME, type BuildFileRecord, type BuildManifest } from '../src/build-manifest.js';
import { computeBuildFingerprint } from '../src/daemon-identity.js';
import { validationEnvironment } from '../src/validation-environment.js';

const roots: string[] = [];
function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'fc-bi-')); roots.push(scratch);
  const root = join(scratch, 'project');
  const stagedDistDir = join(scratch, 'staged'), stagedUiDir = join(scratch, 'staged-ui');
  for (const dir of ['src', 'ui/src', 'ui/public', 'dist', 'ui/dist']) mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(stagedDistDir); mkdirSync(join(stagedUiDir, 'assets'), { recursive: true });
  for (const [file, bytes] of Object.entries({
    'tsconfig.json': '{}', 'ui/package.json': '{}', 'ui/src/view.tsx': 'new source',
    'src/entry.ts': 'export const value = 1;', '../staged/entry.js': 'export const value = 1;',
    '../staged/entry.d.ts': 'export declare const value = 1;', '../staged-ui/index.html': '<html>new</html>',
    '../staged-ui/assets/view.css': 'body { color: red; }', 'ui/dist/index.html': '<html>old</html>',
    'dist/entry.js': 'export const value = 0;', 'dist/entry.d.ts': 'export declare const value = 0;',
  })) writeFileSync(join(root, file), bytes);
  return { root, stagedDistDir, stagedUiDir };
}
function fixtureGeneration(manifest: BuildManifest): string {
  const recordsDigest = (records: BuildFileRecord[]): string => createHash('sha256')
    .update(records.map(record => `${Buffer.byteLength(record.path)}:${record.path}:${record.bytes}:${record.sha256}\n`).join('')).digest('hex');
  return createHash('sha256').update(`${manifest.inputs.hash}\n${recordsDigest(manifest.outputs)}`
    + (manifest.ui ? `\nui:${recordsDigest(manifest.ui.outputs)}` : '')
    + `\nui-presence:${manifest.uiPresence}`
    + `\nartifacts:${recordsDigest(manifest.artifacts!.backend)}:${recordsDigest(manifest.artifacts!.ui)}`).digest('hex');
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('one backend and UI build identity', () => {
  it('accepts isolated sibling staging even when TMPDIR names authored space', () => {
    const f = fixture();
    const temporary = join(f.root, 'temporary'); mkdirSync(temporary);
    vi.stubEnv('TMPDIR', temporary);
    const manifest = publishBuildOutputs({ projectRoot: f.root, ...f });
    expect(assertDistFresh(f.root).generation).toBe(manifest.generation);
    for (const path of ['entry.js', 'entry.d.ts']) copyFileSync(join(f.stagedDistDir, path), join(temporary, path));
    expect(() => publishBuildOutputs({ projectRoot: f.root, ...f,
      stagedDistDir: temporary,
    })).toThrow('staging overlaps authored or published roots');
  });

  it('refuses staging through authored, published and prospective destination aliases', () => {
    const f = fixture();
    const alias = join(dirname(f.root), 'alias');
    writeFileSync(join(f.root, 'src/index.html'), '<html>authored</html>');
    expect(() => publishBuildOutputs({ projectRoot: f.root, ...f, stagedUiDir: join(f.root, 'src') }))
      .toThrow('staging overlaps authored or published roots');
    writeFileSync(join(dirname(f.root), 'index.html'), '<html>ancestor</html>');
    expect(() => publishBuildOutputs({ projectRoot: f.root, ...f, stagedUiDir: dirname(f.root) }))
      .toThrow('staging overlaps authored or published roots');
    expect(() => publishBuildOutputs({ projectRoot: f.root, ...f, stagedDistDir: join(f.root, 'dist') }))
      .toThrow('staging overlaps authored or published roots');
    symlinkSync(f.stagedDistDir, alias);
    expect(() => publishBuildOutputs({ projectRoot: f.root, ...f, distDir: join(alias, 'future', 'dist') }))
      .toThrow('staging overlaps authored or published roots');
    expect(() => publishBuildOutputs({ projectRoot: f.root, ...f, cacheDir: alias }))
      .toThrow('staging overlaps authored or published roots');
    expect(readFileSync(join(f.root, 'dist/entry.js'), 'utf8')).toContain('value = 0');
  });

  it('uses one normalized UI staging path through symlinks and parent components', () => {
    const f = fixture();
    const alias = join(dirname(f.root), 'alias');
    symlinkSync(join(f.root, 'src'), alias);
    mkdirSync(join(f.root, 'staged-ui'));
    writeFileSync(join(f.root, 'staged-ui/index.html'), '<html>authored decoy</html>');
    const manifest = publishBuildOutputs({ projectRoot: f.root, ...f, stagedUiDir: `${alias}/../staged-ui` });
    expect(assertDistFresh(f.root).generation).toBe(manifest.generation);
    expect(readFileSync(join(f.root, 'ui/dist/index.html'), 'utf8')).toBe('<html>new</html>');
    expect(readFileSync(join(f.root, 'staged-ui/index.html'), 'utf8')).toBe('<html>authored decoy</html>');
  });

  it('refuses normalized UI staging inside authored space despite an external symlink spelling', () => {
    const f = fixture();
    const normalized = join(f.root, 'staged-ui'); mkdirSync(normalized);
    copyFileSync(join(f.stagedUiDir, 'index.html'), join(normalized, 'index.html'));
    const external = join(dirname(f.root), 'external'); mkdirSync(join(external, 'child'), { recursive: true });
    mkdirSync(join(external, 'staged-ui'));
    copyFileSync(join(f.stagedUiDir, 'index.html'), join(external, 'staged-ui/index.html'));
    const alias = join(f.root, 'alias'); symlinkSync(join(external, 'child'), alias);
    const manifest = createBuildManifest(f.root, f.stagedDistDir, { stagedUiDir: normalized });
    expect(() => publishBuildOutputs({ projectRoot: f.root, ...f, manifest, stagedUiDir: `${alias}/../staged-ui` }))
      .toThrow('staging overlaps authored or published roots');
    expect(readFileSync(join(f.root, 'ui/dist/index.html'), 'utf8')).toBe('<html>old</html>');
  });

  it.each(['src', 'ui/src', 'ui/public', 'empty ui/public', 'tsconfig.json'])('refuses external authored %s aliases into staging', input => {
    const f = fixture();
    const logical = join(f.root, input === 'empty ui/public' ? 'ui/public' : input);
    rmSync(logical, { recursive: true });
    let stagedDistDir = f.stagedDistDir;
    let physical = f.stagedUiDir;
    if (input === 'src') {
      physical = join(dirname(f.root), 'external-source'); mkdirSync(physical);
      writeFileSync(join(physical, 'entry.ts'), 'export const value = 1;');
      stagedDistDir = join(physical, 'compiled'); mkdirSync(stagedDistDir);
      for (const path of ['entry.js', 'entry.d.ts']) copyFileSync(join(f.stagedDistDir, path), join(stagedDistDir, path));
    } else if (input === 'empty ui/public') {
      physical = join(f.stagedDistDir, 'empty-public'); mkdirSync(physical);
    } else if (input === 'tsconfig.json') {
      physical = join(f.stagedUiDir, 'schema.json'); writeFileSync(physical, '{}');
    }
    symlinkSync(physical, logical);
    // Both bundle and input validation succeed; only physical overlap refuses.
    const manifest = createBuildManifest(f.root, stagedDistDir, { stagedUiDir: f.stagedUiDir });
    expect(() => publishBuildOutputs({ projectRoot: f.root, ...f, stagedDistDir, manifest }))
      .toThrow('staging overlaps authored or published roots');
    expect(readFileSync(join(f.root, 'dist/entry.js'), 'utf8')).toContain('value = 0');
    expect(readFileSync(join(f.root, 'ui/dist/index.html'), 'utf8')).toBe('<html>old</html>');
  });

  it('checks declared compiler records within a complete inventory that includes static assets', () => {
    const f = fixture();
    const manifest = publishBuildOutputs({ projectRoot: f.root, ...f });
    const marker = join(f.root, 'dist', BUILD_MANIFEST_FILENAME);
    writeFileSync(join(f.root, 'dist/license.txt'), 'static license');
    manifest.artifacts!.backend = collectBuildArtifacts(join(f.root, 'dist'), true);
    manifest.generation = fixtureGeneration(manifest);
    writeFileSync(marker, JSON.stringify(manifest));
    expect(assertDistFresh(f.root).generation).toBe(manifest.generation);
    expect(assertBuildArtifactInventory(join(f.root, 'dist'), manifest).backend).toHaveLength(3);
    manifest.outputs[0] = { ...manifest.outputs[0], sha256: '0'.repeat(64) };
    manifest.generation = fixtureGeneration(manifest);
    writeFileSync(marker, JSON.stringify(manifest));
    expect(() => assertDistFresh(f.root)).toThrow('incomplete or modified backend generation');
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('incomplete or modified backend generation');
  });

  it('pins complete generations and retains exactly the current and previous runtime', () => {
    const f = fixture();
    const runtimeRoot = join(dirname(f.root), 'daemon/runtime');
    const publishAndPin = (value: number) => {
      writeFileSync(join(f.root, 'src/entry.ts'), `export const value = ${value};`);
      writeFileSync(join(f.stagedDistDir, 'entry.js'), `export const value = ${value};`);
      const manifest = publishBuildOutputs({ projectRoot: f.root, ...f });
      const runtime = pinBuildRuntime(join(f.root, 'dist'), runtimeRoot);
      expect(assertBuildArtifactInventory(runtime, manifest)).toEqual(manifest.artifacts);
      return { manifest, runtime };
    };
    const first = publishAndPin(1);
    expect(buildProjectRoot(first.runtime)).toBe(f.root);
    expect(readFileSync(join(first.runtime, '../ui/dist/index.html'), 'utf8')).toBe('<html>new</html>');
    const second = publishAndPin(2);
    expect(readFileSync(join(first.runtime, 'entry.js'), 'utf8')).toContain('value = 1');
    const generations = join(runtimeRoot, '.cache/build-generations');
    expect(readdirSync(generations).sort()).toEqual([first.manifest.generation, second.manifest.generation].sort());
    const third = publishAndPin(3);
    expect(readdirSync(generations).sort()).toEqual([second.manifest.generation, third.manifest.generation].sort());
    expect(existsSync(first.runtime)).toBe(false);
    expect(readFileSync(join(second.runtime, 'entry.js'), 'utf8')).toContain('value = 2');
  });

  it('keeps a running pinned daemon and its late imports on old code after a changed-source rebuild and re-pin', { timeout: 120_000 }, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'fc-pinned-rebuild-')); roots.push(scratch);
    const root = join(scratch, 'project');
    const repository = resolve(import.meta.dirname, '..');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    for (const path of ['src', 'tsconfig.json', 'package.json', 'scripts/build.ts']) {
      cpSync(join(repository, path), join(root, path), { recursive: true });
    }
    symlinkSync(realpathSync(join(repository, 'node_modules')), join(root, 'node_modules'), 'dir');
    roots.push(join(tmpdir(), `flowcrew-build-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`));
    writeFileSync(join(root, 'src/late.ts'), 'export const value = 1;');
    writeFileSync(join(root, 'src/daemon-probe.ts'), [
      "import { existsSync } from 'node:fs';",
      "process.stdout.write('ready\\n');",
      "while (!existsSync(process.argv[2])) await new Promise(r => setTimeout(r, 5));",
      "process.stdout.write(String((await import('./late.js')).value));",
    ].join('\n'));
    const { env } = validationEnvironment(scratch, process.env);
    const build = () => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build.ts'], {
        cwd: root, encoding: 'utf8', timeout: 60_000,
        env: { ...env, HOME: env.HOME, FC_HOME: env.FC_HOME },
      });
      expect(result.status, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
      return assertDistFresh(root);
    };
    const first = build();
    const runtimeRoot = join(scratch, 'daemon/runtime');
    const runtime = pinBuildRuntime(join(root, 'dist'), runtimeRoot);
    expect(runtime).toBe(join(runtimeRoot, '.cache/build-generations', first.generation, 'dist'));
    const release = join(scratch, 'release');
    const child = spawn(process.execPath, [join(runtime, 'daemon-probe.js'), release], {
      cwd: root, env: { ...env, HOME: env.HOME, FC_HOME: env.FC_HOME }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const finished = new Promise<number | null>((resolveChild, reject) => {
      child.stdout.on('data', chunk => output += String(chunk));
      child.stderr.on('data', chunk => output += String(chunk));
      child.once('error', reject); child.once('close', resolveChild);
    });
    try {
      await vi.waitFor(() => expect(output).toBe('ready\n'), { timeout: 10_000 });
      let second = first;
      for (const value of [2, 3, 4]) {
        writeFileSync(join(root, 'src/late.ts'), `export const value = ${value};`);
        second = build();
        expect(second.inputs.hash).not.toBe(first.inputs.hash);
        expect(second.generation).not.toBe(first.generation);
        expect(assertBuildArtifactInventory(runtime, first)).toEqual(first.artifacts);
      }
      const nextRuntime = pinBuildRuntime(join(root, 'dist'), runtimeRoot);
      expect(nextRuntime).not.toBe(runtime);
      expect(existsSync(runtime)).toBe(true);
      expect(assertBuildArtifactInventory(runtime, first)).toEqual(first.artifacts);
      expect(assertBuildArtifactInventory(nextRuntime, second)).toEqual(second.artifacts);
      expect(buildProjectRoot(runtime)).toBe(root);
      expect(existsSync(join(root, '.cache/build-generations'))).toBe(false);
      writeFileSync(release, 'release');
      expect(await finished).toBe(0);
      expect(output).toBe('ready\n1');
      expect((await import(pathToFileURL(join(nextRuntime, 'late.js')).href)).value).toBe(4);
      expect((await import(pathToFileURL(join(root, 'dist/late.js')).href)).value).toBe(4);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await finished;
    }
  });

  it('publishes real payload roots even when staging uses directory aliases', () => {
    const f = fixture();
    const backend = join(dirname(f.root), 'backend-alias'), ui = join(dirname(f.root), 'ui-alias');
    symlinkSync(f.stagedDistDir, backend); symlinkSync(f.stagedUiDir, ui);
    const manifest = publishBuildOutputs({ projectRoot: f.root, stagedDistDir: backend, stagedUiDir: ui });
    for (const path of ['dist', 'ui/dist']) expect(lstatSync(join(f.root, path)).isDirectory()).toBe(true);
    expect(assertDistFresh(f.root)).toEqual(manifest);
    expect(existsSync(join(f.stagedDistDir, BUILD_MANIFEST_FILENAME))).toBe(false);
  });

  it('pins a portable package without compiler sources and refuses modified served bytes', () => {
    const f = fixture();
    publishBuildOutputs({ projectRoot: f.root, ...f });
    rmSync(join(f.root, 'src'), { recursive: true });
    rmSync(join(f.root, 'tsconfig.json'));
    expect(() => pinBuildRuntime(join(f.root, 'dist'), join(f.root, 'dist/runtime'))).toThrow('overlaps');
    const runtime = pinBuildRuntime(join(f.root, 'dist'), join(dirname(f.root), 'daemon/runtime'));
    expect(readFileSync(join(runtime, 'entry.js'), 'utf8')).toContain('value = 1');
    writeFileSync(join(f.root, 'ui/dist/index.html'), 'modified');
    expect(() => pinBuildRuntime(join(f.root, 'dist'), join(dirname(f.root), 'daemon/runtime'))).toThrow('modified UI');
    expect(realpathSync(join(dirname(f.root), 'daemon/runtime/dist'))).toBe(runtime);
    expect(assertBuildArtifactInventory(runtime, readBuildManifest(runtime)!)).toEqual(readBuildManifest(runtime)!.artifacts);
  });

  it('leaves the selected generation untouched when preparation fails', () => {
    const f = fixture();
    const first = publishBuildOutputs({ projectRoot: f.root, ...f });
    const runtimeRoot = join(dirname(f.root), 'daemon/runtime');
    const runtime = pinBuildRuntime(join(f.root, 'dist'), runtimeRoot);
    writeFileSync(join(f.stagedDistDir, 'entry.js'), 'export const value = 2;');
    expect(() => publishBuildOutputs({ projectRoot: f.root, ...f, onPhase: phase => {
      if (phase === 'generation_prepared') throw new Error('injected');
    } })).toThrow('injected');
    expect(assertDistFresh(f.root).generation).toBe(first.generation);
    expect(realpathSync(join(runtimeRoot, 'dist'))).toBe(runtime);
    expect(assertBuildArtifactInventory(runtime, first)).toEqual(first.artifacts);
    expect(readdirSync(join(runtimeRoot, '.cache/build-generations'))).toEqual([first.generation]);
  });

  it('publishes complete private backend, UI and cache trees without touching shared outputs', () => {
    const f = fixture();
    const sharedBackend = readFileSync(join(f.root, 'dist/entry.js'), 'utf8');
    const sharedUi = readFileSync(join(f.root, 'ui/dist/index.html'), 'utf8');
    for (const author of ['left', 'right']) {
      const outputRoot = join(f.root, 'authors', author);
      const distDir = join(outputRoot, 'dist');
      const manifest = publishBuildOutputs({ projectRoot: f.root, stagedDistDir: f.stagedDistDir,
        stagedUiDir: f.stagedUiDir, distDir });
      expect(assertDistFresh(f.root, distDir).generation).toBe(manifest.generation);
      expect(readFileSync(join(outputRoot, 'ui/dist/index.html'), 'utf8')).toBe('<html>new</html>');
      expect(statSync(join(outputRoot, '.cache')).isDirectory()).toBe(true);
    }
    expect(readFileSync(join(f.root, 'dist/entry.js'), 'utf8')).toBe(sharedBackend);
    expect(readFileSync(join(f.root, 'ui/dist/index.html'), 'utf8')).toBe(sharedUi);
  });

  it('refuses incomplete inventories, digest tampering and false absence provenance', () => {
    const f = fixture();
    const manifest = publishBuildOutputs({ projectRoot: f.root, ...f });
    const marker = join(f.root, 'dist', BUILD_MANIFEST_FILENAME);
    writeFileSync(marker, JSON.stringify({ ...manifest, generation: '0'.repeat(64) }));
    expect(() => assertDistFresh(f.root)).toThrow('generation digest is invalid');
    writeFileSync(marker, JSON.stringify({ ...manifest, uiPresence: 'absent' }));
    expect(() => assertDistFresh(f.root)).toThrow('absence attestation conflicts');
    writeFileSync(marker, JSON.stringify(manifest));
    writeFileSync(join(f.root, 'dist/extra.dat'), 'extra backend payload');
    expect(() => assertDistFresh(f.root)).toThrow('undeclared outputs');
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('undeclared outputs');
  });

  it('rejects UI removal from a required build and keeps genuine absence explicit', () => {
    const f = fixture();
    publishBuildOutputs({ projectRoot: f.root, ...f });
    rmSync(join(realpathSync(join(f.root, 'dist')), '..', 'ui'), { recursive: true });
    rmSync(join(f.root, 'ui'), { recursive: true, force: true });
    expect(() => assertDistFresh(f.root)).toThrow();
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('incomplete UI');
    const absent = publishBuildOutputs({ projectRoot: f.root, stagedDistDir: f.stagedDistDir });
    expect(absent.uiPresence).toBe('absent');
    expect(assertDistFresh(f.root).ui).toBeUndefined();
  });

  it('refuses linked payloads in portable build outputs', () => {
    const f = fixture();
    publishBuildOutputs({ projectRoot: f.root, ...f });
    const linked = join(f.root, 'ui/dist/linked.css');
    symlinkSync(join(f.root, 'ui/dist/assets/view.css'), linked);
    expect(() => assertDistFresh(f.root)).toThrow('Nonregular build artifact');
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow();
    rmSync(linked);
  });

  it('rejects changed build inputs and modified backend or UI outputs', () => {
    const f = fixture();
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('without a combined build manifest');
    publishBuildOutputs({ projectRoot: f.root, ...f });
    writeFileSync(join(f.root, 'src/entry.ts'), 'export const value = 2;');
    expect(() => assertDistFresh(f.root)).toThrow(/dist is stale.*npm run build/s);
    writeFileSync(join(f.root, 'src/entry.ts'), 'export const value = 1;');
    writeFileSync(join(f.root, 'dist/entry.js'), 'export const value = 9;');
    expect(() => assertDistFresh(f.root)).toThrow('modified backend generation');
    writeFileSync(join(f.root, 'dist/entry.js'), readFileSync(join(f.stagedDistDir, 'entry.js')));
    publishBuildOutputs({ projectRoot: f.root, ...f });
    writeFileSync(join(f.root, 'ui/dist/index.html'), 'changed');
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('modified UI');
    writeFileSync(join(f.root, 'ui/dist/index.html'), readFileSync(join(f.stagedUiDir, 'index.html')));
    publishBuildOutputs({ projectRoot: f.root, ...f });
    expect(assertDistFresh(f.root).ui?.outputs.map(r => r.path)).toEqual(['assets/view.css', 'index.html']);
    const digest = computeBuildInputDigest(f.root).hash;
    writeFileSync(join(f.root, 'ui/public/logo.svg'), 'asset');
    expect(computeBuildInputDigest(f.root).hash).not.toBe(digest);
    expect(() => assertDistFresh(f.root)).toThrow('stale');
    publishBuildOutputs({ projectRoot: f.root, ...f });
    writeFileSync(join(f.root, 'ui/dist/assets/view.css'), 'partial');
    expect(() => assertDistFresh(f.root)).toThrow('modified UI generation');
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('modified UI');
  });

  it('rejects backend-only and altered UI manifests without publishing', () => {
    const f = fixture();
    expect(() => createBuildManifest(f.root, f.stagedDistDir)).toThrow('require a staged UI');
    const manifest = createBuildManifest(f.root, f.stagedDistDir, { stagedUiDir: f.stagedUiDir });
    expect(isBuildManifest({ ...manifest, ui: null })).toBe(false);
    expect(isBuildManifest({ ...manifest, ui: { outputs: [null] } })).toBe(false);
    const valid = fixture();
    const published = publishBuildOutputs({ projectRoot: valid.root, ...valid });
    const marker = join(valid.root, 'dist', BUILD_MANIFEST_FILENAME);
    const incomplete = { ...published }; delete incomplete.ui;
    writeFileSync(marker, JSON.stringify(incomplete));
    expect(() => assertDistFresh(valid.root)).toThrow('has no UI outputs');
    writeFileSync(marker, JSON.stringify(published));
    rmSync(realpathSync(join(valid.root, 'ui/dist')), { recursive: true });
    expect(() => computeBuildFingerprint(join(valid.root, 'dist'))).toThrow('incomplete UI');
    manifest.ui!.outputs[0].sha256 = '0'.repeat(64);
    expect(() => publishBuildOutputs({ projectRoot: f.root, ...f, manifest })).toThrow('UI whose output');
    expect(readFileSync(join(f.root, 'dist/entry.js'), 'utf8')).toContain('value = 0');
  });

  it.each(['legacy', 'missing'])('refuses a required absent UI with a %s manifest', kind => {
    const f = fixture();
    rmSync(join(f.root, 'ui'), { recursive: true });
    const legacy = createBuildManifest(f.root, f.stagedDistDir);
    copyFileSync(join(f.stagedDistDir, 'entry.js'), join(f.root, 'dist/entry.js'));
    copyFileSync(join(f.stagedDistDir, 'entry.d.ts'), join(f.root, 'dist/entry.d.ts'));
    const marker = join(f.root, 'dist', BUILD_MANIFEST_FILENAME);
    if (kind === 'legacy') writeFileSync(marker, JSON.stringify(legacy));
    // A genuinely backend-only package retains its original identity.
    expect(computeBuildFingerprint(join(f.root, 'dist')).files).toBe(1);
    if (kind === 'legacy') expect(assertDistFresh(f.root).generation).toBe(legacy.generation);
    mkdirSync(join(f.root, 'ui'));
    writeFileSync(join(f.root, 'ui/package.json'), '{}');
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('without a combined build manifest');
  });

  it('publishes the production UI when invoked from a test or development parent', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'flowcrew-build-production-'))); roots.push(root);
    roots.push(join(tmpdir(), `flowcrew-build-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`));
    const repository = resolve(import.meta.dirname, '..');
    // Keep fixture writes local even when review dependencies are symlinked.
    const fakeVitePackage = join(root, 'ui', 'node_modules', 'vite');
    for (const dir of ['src', 'scripts', 'ui/src']) mkdirSync(join(root, dir), { recursive: true });
    mkdirSync(join(fakeVitePackage, 'bin'), { recursive: true });
    for (const file of ['build-manifest.ts', 'engine-fs.ts', 'engine-owned-carriers.ts', 'rollback-content-store.ts', 'daemon-identity.ts', 'process-liveness.ts']) copyFileSync(join(repository, 'src', file), join(root, 'src', file));
    copyFileSync(join(repository, 'scripts/build.ts'), join(root, 'scripts/build.ts'));
    copyFileSync(join(repository, 'tsconfig.json'), join(root, 'tsconfig.json'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'src/cli.ts'), 'export const cli = true;');
    writeFileSync(join(root, 'ui/package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'ui/src/view.ts'), 'export const view = true;');
    for (const config of ['tsconfig.json', 'tsconfig.node.json']) writeFileSync(join(root, 'ui', config), '{"compilerOptions":{"skipLibCheck":true,"noEmit":true},"include":["src"]}');
    writeFileSync(join(fakeVitePackage, 'package.json'), '{"name":"vite","type":"module"}');
    // A deterministic compiler outlet observes the child contract; actual Vite
    // rendering is exercised by the project build, not duplicated in this spec.
    writeFileSync(join(fakeVitePackage, 'bin/vite.js'), [
      "import fs from 'node:fs'; import path from 'node:path';",
      "const out = process.argv[process.argv.indexOf('--outDir') + 1];",
      "fs.mkdirSync(out, {recursive:true}); fs.writeFileSync(path.join(out,'index.html'), process.env.NODE_ENV);",
    ].join('\n'));
    symlinkSync(realpathSync(join(repository, 'node_modules')), join(root, 'node_modules'), 'dir');
    const outputRoot = join(root, 'author-build');
    roots.push(join(tmpdir(), `flowcrew-build-${createHash('sha256').update(outputRoot).digest('hex').slice(0, 16)}`));
    for (const mode of ['test', 'development', 'private']) {
      const destination = mode === 'private' ? outputRoot : root;
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build.ts', ...(mode === 'private' ? [destination] : [])], {
        cwd: root, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: join(root, 'home'), FC_HOME: join(root, 'home/.fc'), NODE_ENV: mode },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(join(destination, 'ui/dist/index.html'), 'utf8')).toBe('production');
      expect(assertDistFresh(root, join(destination, 'dist')).ui?.outputs).toHaveLength(1);
    }
  }, 120_000);

  it('builds source during installation and leaves packaged installations ready to run', () => {
    const repository = resolve(import.meta.dirname, '..');
    const scripts = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts.prepare).toBeUndefined();
    const hook = /^node -e "(.+)"$/.exec(scripts.postinstall)?.[1];
    expect(hook).toBeDefined();
    for (const shape of ['package', 'source', 'source-ui']) {
      const root = mkdtempSync(join(tmpdir(), 'flowcrew-build-install-')); roots.push(root);
      writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
      const bin = join(root, 'bin'), log = join(root, 'calls.jsonl'); mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, 'node'));
      const npm = join(bin, 'npm');
      writeFileSync(npm, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');\n`);
      chmodSync(npm, 0o755);
      if (shape !== 'package') { mkdirSync(join(root, 'scripts')); writeFileSync(join(root, 'scripts/build.ts'), 'source'); }
      if (shape === 'source-ui') { mkdirSync(join(root, 'ui')); writeFileSync(join(root, 'ui/package.json'), '{}'); }
      const result = spawnSync(process.execPath, ['-e', hook!], { cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: bin, HOME: join(root, 'home'), FC_HOME: join(root, 'home/.fc') } });
      expect(result.status, result.stderr).toBe(0);
      const calls = readdirSync(root).includes('calls.jsonl') ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      expect(calls).toEqual(shape === 'package' ? [] : shape === 'source' ? [['run', 'build']] : [['install', '--prefix', 'ui'], ['run', 'build']]);
    }
  });

});
