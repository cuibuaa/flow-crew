import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, copyFileSync, symlinkSync, realpathSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDistFresh, createBuildManifest, publishBuildGeneration, computeBuildInputDigest, isBuildManifest, BUILD_MANIFEST_FILENAME } from '../src/build-manifest.js';
import { computeBuildFingerprint } from '../src/daemon-identity.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-build-identity-')); roots.push(root);
  const stagedDistDir = join(root, 'staged'), stagedUiDir = join(root, 'staged-ui');
  for (const dir of ['src', 'ui/src', 'ui/public', 'dist', 'ui/dist', 'staged', 'staged-ui/assets']) mkdirSync(join(root, dir), { recursive: true });
  for (const [file, bytes] of Object.entries({
    'tsconfig.json': '{}', 'ui/package.json': '{}', 'ui/src/view.tsx': 'new source',
    'src/entry.ts': 'export const value = 1;', 'staged/entry.js': 'export const value = 1;',
    'staged/entry.d.ts': 'export declare const value = 1;', 'staged-ui/index.html': '<html>new</html>',
    'staged-ui/assets/view.css': 'body { color: red; }', 'ui/dist/index.html': '<html>old</html>',
    'dist/entry.js': 'export const value = 0;', 'dist/entry.d.ts': 'export declare const value = 0;',
  })) writeFileSync(join(root, file), bytes);
  return { root, stagedDistDir, stagedUiDir };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('one backend and UI build identity', () => {
  it('attests retained backend and UI resources without deleting them', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'dist/retained.txt'), 'older runtime resource');
    writeFileSync(join(f.root, 'ui/dist/older.html'), 'older UI resource');
    const manifest = publishBuildGeneration({ projectRoot: f.root, ...f });
    expect(manifest.artifacts?.backend.some(r => r.path === 'retained.txt')).toBe(true);
    expect(manifest.artifacts?.ui.some(r => r.path === 'older.html')).toBe(true);
    expect(assertDistFresh(f.root).generation).toBe(manifest.generation);
    writeFileSync(join(f.root, 'ui/dist/extra.html'), 'undeclared');
    expect(() => assertDistFresh(f.root)).toThrow('undeclared outputs');
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('undeclared outputs');
    const next = publishBuildGeneration({ projectRoot: f.root, ...f });
    expect(next.generation).not.toBe(manifest.generation);
    expect(assertDistFresh(f.root).generation).toBe(next.generation);
    expect(readFileSync(join(f.root, 'dist/retained.txt'), 'utf8')).toBe('older runtime resource');
  });

  it('refuses incomplete inventories, digest tampering and false absence provenance', () => {
    const f = fixture();
    const manifest = publishBuildGeneration({ projectRoot: f.root, ...f });
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
    publishBuildGeneration({ projectRoot: f.root, ...f });
    rmSync(join(f.root, 'ui'), { recursive: true });
    expect(() => assertDistFresh(f.root)).toThrow();
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('incomplete UI');
    const absent = publishBuildGeneration({ projectRoot: f.root, stagedDistDir: f.stagedDistDir });
    expect(absent.uiPresence).toBe('absent');
    expect(assertDistFresh(f.root).ui).toBeUndefined();
  });

  it('refuses linked payloads and a late extra before committing the marker', () => {
    const f = fixture();
    const first = publishBuildGeneration({ projectRoot: f.root, ...f });
    const linked = join(f.root, 'ui/dist/linked.css');
    symlinkSync(join(f.root, 'ui/dist/assets/view.css'), linked);
    expect(() => assertDistFresh(f.root)).toThrow('Nonregular build artifact');
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow();
    rmSync(linked);
    writeFileSync(join(f.stagedDistDir, 'entry.js'), 'export const value = 2;');
    const late = join(f.root, 'ui/dist/late.html');
    expect(() => publishBuildGeneration({ projectRoot: f.root, ...f, onPhase: phase => {
      if (phase === 'runtime_files_published') writeFileSync(late, 'late unowned file');
    } })).toThrow('undeclared outputs');
    rmSync(late);
    expect(assertDistFresh(f.root).generation).toBe(first.generation);
  });

  it('covers UI source, public files, recipe and served HTML/CSS with unchanged roots', () => {
    const f = fixture();
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('without a combined build manifest');
    publishBuildGeneration({ projectRoot: f.root, ...f });
    writeFileSync(join(f.root, 'ui/dist/index.html'), 'changed');
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('modified UI');
    publishBuildGeneration({ projectRoot: f.root, ...f });
    expect(assertDistFresh(f.root).ui?.outputs.map(r => r.path)).toEqual(['assets/view.css', 'index.html']);
    const digest = computeBuildInputDigest(f.root).hash;
    writeFileSync(join(f.root, 'ui/public/logo.svg'), 'asset');
    expect(computeBuildInputDigest(f.root).hash).not.toBe(digest);
    expect(() => assertDistFresh(f.root)).toThrow('stale');
    publishBuildGeneration({ projectRoot: f.root, ...f });
    writeFileSync(join(f.root, 'ui/dist/assets/view.css'), 'partial');
    expect(() => assertDistFresh(f.root)).toThrow('UI generation is modified');
    expect(() => computeBuildFingerprint(join(f.root, 'dist'))).toThrow('modified UI');
  });

  it('rolls back both roots and commits one manifest only after both outputs', () => {
    const f = fixture();
    const first = publishBuildGeneration({ projectRoot: f.root, ...f });
    writeFileSync(join(f.stagedDistDir, 'entry.js'), 'export const value = 2;');
    writeFileSync(join(f.stagedUiDir, 'index.html'), 'second');
    expect(() => publishBuildGeneration({ projectRoot: f.root, ...f,
      beforeFileCommit: path => { if (path.startsWith('ui-dist/')) throw new Error('injected'); },
    })).toThrow('injected');
    expect(assertDistFresh(f.root).generation).toBe(first.generation);
    expect(readFileSync(join(f.root, 'ui/dist/index.html'), 'utf8')).toBe('<html>new</html>');
    const phases: string[] = [];
    const second = publishBuildGeneration({ projectRoot: f.root, ...f, onPhase: phase => {
      phases.push(phase);
      if (phase === 'runtime_files_published') expect(() => assertDistFresh(f.root)).toThrow();
    } });
    expect(phases.at(-1)).toBe('manifest_committed');
    expect(assertDistFresh(f.root).generation).toBe(second.generation);
    expect(readdirSync(join(f.root, '.cache')).some(p => p.startsWith('build-rollback'))).toBe(false);
    expect(statSync(join(f.root, 'dist/entry.js')).nlink).toBe(1);
    expect(statSync(join(f.root, '.cache/build-generations', first.generation, 'entry.js')).nlink).toBe(1);
  });

  it('rejects backend-only and altered UI manifests without publishing', () => {
    const f = fixture();
    expect(() => createBuildManifest(f.root, f.stagedDistDir)).toThrow('require a staged UI');
    const manifest = createBuildManifest(f.root, f.stagedDistDir, { stagedUiDir: f.stagedUiDir });
    expect(isBuildManifest({ ...manifest, ui: null })).toBe(false);
    expect(isBuildManifest({ ...manifest, ui: { outputs: [null] } })).toBe(false);
    const valid = fixture();
    const published = publishBuildGeneration({ projectRoot: valid.root, ...valid });
    const marker = join(valid.root, 'dist', BUILD_MANIFEST_FILENAME);
    const incomplete = { ...published }; delete incomplete.ui;
    writeFileSync(marker, JSON.stringify(incomplete));
    expect(() => assertDistFresh(valid.root)).toThrow('has no UI outputs');
    writeFileSync(marker, JSON.stringify(published));
    rmSync(join(valid.root, 'ui/dist'), { recursive: true });
    expect(() => computeBuildFingerprint(join(valid.root, 'dist'))).toThrow('incomplete UI');
    manifest.ui!.outputs[0].sha256 = '0'.repeat(64);
    expect(() => publishBuildGeneration({ projectRoot: f.root, ...f, manifest })).toThrow('UI whose output');
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
    for (const file of ['build-manifest.ts', 'daemon-identity.ts', 'process-liveness.ts']) copyFileSync(join(repository, 'src', file), join(root, 'src', file));
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
    for (const mode of ['test', 'development']) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build.ts'], {
        cwd: root, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, HOME: join(root, 'home'), FC_HOME: join(root, 'home/.fc'), NODE_ENV: mode },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(join(root, 'ui/dist/index.html'), 'utf8')).toBe('production');
      expect(assertDistFresh(root).ui?.outputs).toHaveLength(1);
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
