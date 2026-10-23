import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertBuildArtifactInventory, readBuildManifest, type BuildManifest } from '../src/build-manifest.js';

const repository = resolve(import.meta.dirname, '..');
const cleanup: string[] = [];
afterAll(() => {
  for (const path of cleanup.splice(0).reverse()) rmSync(path, { recursive: true, force: true });
});

let manifest: BuildManifest;
let deliveries: Record<string, { root: string; command: string; args: string[] }>;
let run: (command: string, args: string[], cwd?: string) => string;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'fc-distribution-')); cleanup.push(root);
  const project = join(root, 'producer');
  for (const path of ['src', 'scripts', 'ui/src']) mkdirSync(join(project, path), { recursive: true });
  for (const file of ['build-manifest.ts', 'engine-fs.ts', 'engine-owned-carriers.ts', 'rollback-content-store.ts', 'daemon-identity.ts', 'process-liveness.ts']) {
    copyFileSync(join(repository, 'src', file), join(project, 'src', file));
  }
  copyFileSync(join(repository, 'scripts/build.ts'), join(project, 'scripts/build.ts'));
  copyFileSync(join(repository, 'tsconfig.json'), join(project, 'tsconfig.json'));
  symlinkSync(join(repository, 'node_modules'), join(project, 'node_modules'), 'dir');
  symlinkSync(join(repository, 'ui', 'node_modules'), join(project, 'ui', 'node_modules'), 'dir');
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'flowcrew', version: '0.0.0', type: 'module',
    bin: { flowcrew: 'dist/cli.js' }, files: ['dist', 'ui/dist'] }));
  writeFileSync(join(project, 'src/cli.ts'), '#!/usr/bin/env node\nconsole.log("0.0.0");\n');
  writeFileSync(join(project, 'ui/package.json'), '{"type":"module"}');
  writeFileSync(join(project, 'ui/src/view.ts'), 'export const view = true;');
  for (const name of ['tsconfig.json', 'tsconfig.node.json']) {
    writeFileSync(join(project, 'ui', name), '{"compilerOptions":{"skipLibCheck":true},"files":["src/view.ts"]}');
  }
  writeFileSync(join(project, 'ui/index.html'), '<html><body>portable UI</body></html>');
  const key = createHash('sha256').update(project).digest('hex').slice(0, 16);
  cleanup.push(join(tmpdir(), `flowcrew-build-${key}`));
  const prefix = join(root, 'prefix');
  const env = { ...process.env, HOME: root, FC_HOME: join(root, 'state'), npm_config_prefix: prefix,
    npm_config_cache: join(root, 'npm-cache'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
  // The probe runs host tools only inside this test-owned project and environment.
  const probe = join(root, 'probe.mjs');
  writeFileSync(probe, [
    "import { spawnSync } from 'node:child_process';",
    "const child = spawnSync(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });",
    "if (child.error) { console.error(child.error); process.exit(127); }",
    "process.exit(child.status ?? 1);",
  ].join('\n'));
  run = (command: string, args: string[], cwd = project) => {
    const result = spawnSync(process.execPath, [probe, command, ...args], { cwd,
      env: { ...env, HOME: root, FC_HOME: join(root, 'state') }, encoding: 'utf8', timeout: 30_000 });
    expect(result.status, `${command} ${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };
  run(process.execPath, ['--import', 'tsx', 'scripts/build.ts']);
  manifest = readBuildManifest(join(project, 'dist'))!;
  const archive = join(root, 'runtime.tgz');
  run('tar', ['-czf', archive, 'dist', 'ui/dist']);
  const packed = run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', root]);
  const consumer = join(root, 'consumer'); mkdirSync(consumer);
  copyFileSync(join(project, 'package.json'), join(consumer, 'package.json'));
  run('tar', ['-xzf', archive], consumer);
  // Producer paths must be inaccessible, as on a different CI machine.
  renameSync(project, join(root, 'producer-offline'));
  run('npm', ['i', '-g', join(root, packed)], consumer);
  const installed = join(run('npm', ['root', '-g'], consumer), 'flowcrew');
  deliveries = {
    tar: { root: consumer, command: process.execPath, args: ['dist/cli.js', '--version'] },
    npm: { root: installed, command: join(prefix, 'bin/flowcrew'), args: ['--version'] },
  };
});

it.each(['tar', 'npm'])('ships real backend and UI files through %s without the producer checkout', carrier => {
  const delivery = deliveries[carrier];
  expect(run(delivery.command, delivery.args, delivery.root)).toBe('0.0.0');
  for (const payload of ['dist', 'ui/dist']) expect(lstatSync(join(delivery.root, payload)).isDirectory()).toBe(true);
  expect(readFileSync(join(delivery.root, 'ui/dist/index.html'), 'utf8')).toContain('portable UI');
  expect(existsSync(join(delivery.root, 'dist/.flowcrew-build-manifest.json'))).toBe(true);
  expect(assertBuildArtifactInventory(join(delivery.root, 'dist'), manifest)).toEqual(manifest.artifacts);
});
