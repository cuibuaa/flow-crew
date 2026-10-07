import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

export const BUILD_MANIFEST_FILENAME = '.flowcrew-build-manifest.json';
export const BUILD_MANIFEST_VERSION = 1;

export interface BuildFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BuildManifest {
  version: typeof BUILD_MANIFEST_VERSION;
  generation: string;
  builtAt: string;
  inputs: {
    algorithm: 'sha256';
    hash: string;
    files: BuildFileRecord[];
  };
  outputs: BuildFileRecord[];
  /** Served at the existing ui/dist root; absent for backend-only packages. */
  ui?: { outputs: BuildFileRecord[] };
}

export type BuildPublicationPhase =
  | 'previous_generation_archived'
  | 'replacement_files_prepared'
  | 'runtime_files_published'
  | 'manifest_committed';

export interface PublishBuildOptions {
  projectRoot: string;
  stagedDistDir: string;
  stagedUiDir?: string;
  distDir?: string;
  cacheDir?: string;
  manifest?: BuildManifest;
  onPhase?: (phase: BuildPublicationPhase, detail: string) => void;
  /** Local fault/timing seam for transactional tests; production callers omit it. */
  beforeFileCommit?: (relativePath: string, index: number) => void;
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function collectRegularFiles(root: string, accept: (path: string) => boolean): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && accept(path)) files.push(path);
    }
  };
  if (existsSync(root)) walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function hashFile(path: string, root: string): BuildFileRecord {
  const bytes = readFileSync(path);
  return {
    path: portableRelative(root, path),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function digestRecords(records: BuildFileRecord[]): string {
  const hash = createHash('sha256');
  for (const record of records) {
    hash.update(`${Buffer.byteLength(record.path)}:${record.path}:`);
    hash.update(`${record.bytes}:${record.sha256}\n`);
  }
  return hash.digest('hex');
}

export function collectBuildInputRecords(projectRoot: string): BuildFileRecord[] {
  const root = resolve(projectRoot);
  const sourceRoot = join(root, 'src');
  const paths = collectRegularFiles(sourceRoot, (path) => /\.(?:ts|tsx)$/.test(path));
  const tsconfig = join(root, 'tsconfig.json');
  if (!existsSync(tsconfig)) throw new Error(`Build input is missing: ${tsconfig}`);
  paths.push(tsconfig);
  for (const input of ['package.json', 'package-lock.json', 'scripts/build.ts']) {
    const path = join(root, input);
    if (existsSync(path)) paths.push(path);
  }
  if (existsSync(join(root, 'ui', 'package.json'))) {
    for (const input of ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts',
      'tsconfig.json', 'tsconfig.node.json', 'tailwind.config.ts', 'postcss.config.js']) {
      const path = join(root, 'ui', input);
      if (existsSync(path)) paths.push(path);
    }
    for (const directory of ['src', 'public']) {
      paths.push(...collectRegularFiles(join(root, 'ui', directory), () => true));
    }
  }
  return paths
    .map((path) => hashFile(path, root))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function computeBuildInputDigest(projectRoot: string): BuildManifest['inputs'] {
  const files = collectBuildInputRecords(projectRoot);
  return { algorithm: 'sha256', hash: digestRecords(files), files };
}

export function expectedBuildOutputs(projectRoot: string): string[] {
  const root = resolve(projectRoot);
  const sourceRoot = join(root, 'src');
  const outputs: string[] = [];
  for (const path of collectRegularFiles(sourceRoot, (candidate) => /\.(?:ts|tsx)$/.test(candidate))) {
    const sourcePath = portableRelative(sourceRoot, path);
    if (sourcePath.endsWith('.d.ts')) continue;
    const stem = sourcePath.replace(/\.(?:ts|tsx)$/, '');
    outputs.push(`${stem}.js`, `${stem}.d.ts`);
  }
  return outputs.sort((left, right) => left.localeCompare(right));
}

export function pruneStaleBuildOutputs(projectRoot: string, stagedDistDir: string): string[] {
  const expected = new Set(expectedBuildOutputs(projectRoot));
  const root = resolve(stagedDistDir);
  const removed: string[] = [];
  for (const path of collectRegularFiles(root, (candidate) => /\.(?:js|d\.ts)$/.test(candidate))) {
    const output = portableRelative(root, path);
    if (expected.has(output)) continue;
    unlinkSync(path);
    removed.push(output);
  }
  return removed.sort((left, right) => left.localeCompare(right));
}

export function createBuildManifest(
  projectRoot: string,
  stagedDistDir: string,
  options: { builtAt?: string; stagedUiDir?: string } = {},
): BuildManifest {
  const root = resolve(stagedDistDir);
  const expected = expectedBuildOutputs(projectRoot);
  const actual = collectRegularFiles(root, (path) => /\.(?:js|d\.ts)$/.test(path))
    .map((path) => portableRelative(root, path));
  const missing = expected.filter((path) => !actual.includes(path));
  const unexpected = actual.filter((path) => !expected.includes(path));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Compiled generation is incomplete (missing=${missing.slice(0, 8).join(', ') || 'none'}; `
      + `unexpected=${unexpected.slice(0, 8).join(', ') || 'none'}).`,
    );
  }
  const outputs = expected.map((path) => hashFile(join(root, path), root));
  const inputs = computeBuildInputDigest(projectRoot);
  const ui = options.stagedUiDir ? { outputs: collectRegularFiles(options.stagedUiDir, () => true)
    .map((path) => hashFile(path, options.stagedUiDir!)) } : undefined;
  if (existsSync(join(projectRoot, 'ui', 'package.json')) && !ui) {
    throw new Error('UI build inputs require a staged UI bundle');
  }
  if (ui && !ui.outputs.some((record) => record.path === 'index.html')) {
    throw new Error('UI generation is incomplete: index.html is missing');
  }
  const generation = generationDigest(inputs.hash, outputs, ui);
  return {
    version: BUILD_MANIFEST_VERSION,
    generation,
    builtAt: options.builtAt ?? new Date().toISOString(),
    inputs,
    outputs,
    ...(ui ? { ui } : {}),
  };
}

function generationDigest(inputs: string, outputs: BuildFileRecord[], ui?: BuildManifest['ui']): string {
  return createHash('sha256').update(`${inputs}\n${digestRecords(outputs)}`
    + (ui ? `\nui:${digestRecords(ui.outputs)}` : '')).digest('hex');
}

function isFileRecord(value: unknown): value is BuildFileRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<BuildFileRecord>;
  return typeof record.path === 'string'
    && record.path.length > 0
    && !record.path.includes('\\')
    && !record.path.startsWith('/')
    && record.path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    && Number.isSafeInteger(record.bytes)
    && (record.bytes ?? -1) >= 0
    && typeof record.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(record.sha256);
}

export function isBuildManifest(value: unknown): value is BuildManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<BuildManifest>;
  return manifest.version === BUILD_MANIFEST_VERSION
    && typeof manifest.generation === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.generation)
    && typeof manifest.builtAt === 'string'
    && Number.isFinite(Date.parse(manifest.builtAt))
    && manifest.inputs?.algorithm === 'sha256'
    && typeof manifest.inputs.hash === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.inputs.hash)
    && Array.isArray(manifest.inputs.files)
    && manifest.inputs.files.every(isFileRecord)
    && Array.isArray(manifest.outputs)
    && manifest.outputs.length > 0
    && manifest.outputs.every(isFileRecord)
    && (manifest.ui === undefined || (!!manifest.ui && Array.isArray(manifest.ui.outputs)
      && manifest.ui.outputs.every(isFileRecord)
      && manifest.ui.outputs.some((record) => record.path === 'index.html')));
}

export function readBuildManifest(distDir: string): BuildManifest | undefined {
  const path = join(resolve(distDir), BUILD_MANIFEST_FILENAME);
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (error) {
    throw new Error(
      `Build manifest is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isBuildManifest(value)) throw new Error(`Build manifest is invalid at ${path}`);
  return value;
}

export function assertDistFresh(projectRoot: string, distDir = join(projectRoot, 'dist')): BuildManifest {
  const manifest = readBuildManifest(distDir);
  const remedy = 'Run `npm run build` and retry the tests.';
  if (!manifest) throw new Error(`dist freshness cannot be proven: ${BUILD_MANIFEST_FILENAME} is missing. ${remedy}`);
  if (existsSync(join(projectRoot, 'ui', 'package.json')) && !manifest.ui) {
    throw new Error(`UI freshness cannot be proven: the build manifest has no UI outputs. ${remedy}`);
  }
  const currentInputs = computeBuildInputDigest(projectRoot);
  if (manifest.inputs.hash !== currentInputs.hash) {
    throw new Error(
      `dist is stale: source/config digest ${currentInputs.hash.slice(0, 12)} does not match `
      + `deployed generation ${manifest.inputs.hash.slice(0, 12)}. ${remedy}`,
    );
  }
  const expected = expectedBuildOutputs(projectRoot);
  const declared = manifest.outputs.map(({ path }) => path).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    throw new Error(`dist manifest does not cover the current compiler output set. ${remedy}`);
  }
  for (const record of manifest.outputs) {
    const path = join(resolve(distDir), record.path);
    if (!existsSync(path)) throw new Error(`dist generation is incomplete: ${record.path} is missing. ${remedy}`);
    const actual = hashFile(path, resolve(distDir));
    if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) {
      throw new Error(`dist generation is modified or partial at ${record.path}. ${remedy}`);
    }
  }
  if (manifest.ui) {
    const uiRoot = join(resolve(distDir), '..', 'ui', 'dist');
    for (const record of manifest.ui.outputs) {
      const path = join(uiRoot, record.path);
      if (!existsSync(path)) throw new Error(`UI generation is incomplete: ${record.path}. ${remedy}`);
      const actual = hashFile(path, uiRoot);
      if (actual.sha256 !== record.sha256 || actual.bytes !== record.bytes) {
        throw new Error(`UI generation is modified or partial at ${record.path}. ${remedy}`);
      }
    }
  }
  return manifest;
}

function validateManifestForPublication(
  projectRoot: string,
  stagedDistDir: string,
  manifest: BuildManifest,
  stagedUiDir?: string,
): void {
  const currentInputs = computeBuildInputDigest(projectRoot);
  if (JSON.stringify(manifest.inputs.files) !== JSON.stringify(currentInputs.files)
    || manifest.inputs.hash !== currentInputs.hash) {
    throw new Error('Refusing to publish a manifest that does not describe the current build inputs');
  }
  const expected = expectedBuildOutputs(projectRoot);
  const declared = manifest.outputs.map(({ path }) => path);
  if (new Set(declared).size !== declared.length
    || JSON.stringify([...declared].sort((left, right) => left.localeCompare(right))) !== JSON.stringify(expected)) {
    throw new Error('Refusing to publish a manifest with a duplicate or incomplete output set');
  }
  const actualOutputs = manifest.outputs
    .map((record) => hashFile(join(stagedDistDir, record.path), stagedDistDir));
  if (JSON.stringify(actualOutputs) !== JSON.stringify(manifest.outputs)) {
    throw new Error('Refusing to publish a manifest whose output hashes do not match the staged generation');
  }
  if (manifest.ui) {
    if (!stagedUiDir) throw new Error('Refusing to publish UI without a staged bundle');
    const actual = collectRegularFiles(stagedUiDir, () => true).map((path) => hashFile(path, stagedUiDir));
    if (JSON.stringify(actual) !== JSON.stringify(manifest.ui.outputs)) {
      throw new Error('Refusing to publish UI whose output set or hashes differ from the staged generation');
    }
  } else if (existsSync(join(projectRoot, 'ui', 'package.json'))) {
    throw new Error('Refusing to publish backend-only identity for a UI checkout');
  }
  const generation = generationDigest(manifest.inputs.hash, manifest.outputs, manifest.ui);
  if (generation !== manifest.generation) {
    throw new Error('Refusing to publish a manifest with an invalid generation digest');
  }
}

function ensureOsTemporaryStaging(path: string): void {
  const staging = resolve(path);
  const temporaryRoot = resolve(tmpdir());
  const relation = relative(temporaryRoot, staging);
  if (relation === '' || relation.startsWith(`..${sep}`) || relation === '..' || resolve(temporaryRoot, relation) !== staging) {
    throw new Error(`Build staging must be below the OS temporary root: ${staging}`);
  }
}

function durableTemporaryCopy(source: string, target: string, generation: string): string {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${generation.slice(0, 12)}.${randomUUID()}.tmp`);
  copyFileSync(source, temporary);
  chmodSync(temporary, statSync(source).mode & 0o777);
  const fd = openSync(temporary, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return temporary;
}

function durableTemporaryText(contents: string, target: string, generation: string): string {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${generation.slice(0, 12)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o644);
  try {
    writeFileSync(fd, contents, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temporary;
}

function archiveCopy(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) return;
  copyFileSync(source, target);
}

function legacyGeneration(distDir: string, touchedPaths: string[]): string {
  const hash = createHash('sha256');
  for (const path of touchedPaths.sort((left, right) => left.localeCompare(right))) {
    const absolute = join(distDir, path);
    if (!existsSync(absolute)) continue;
    const bytes = readFileSync(absolute);
    hash.update(`${path}:${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return `legacy-${hash.digest('hex')}`;
}

/**
 * Publish a validated generation without ever removing dist or a runtime file.
 * Each replacement is complete before rename; the manifest is the commit record
 * and is renamed last. A synchronous failure rolls every touched path back from
 * the retained previous generation.
 */
export function publishBuildGeneration(options: PublishBuildOptions): BuildManifest {
  const projectRoot = resolve(options.projectRoot);
  const stagedDistDir = resolve(options.stagedDistDir);
  const distDir = resolve(options.distDir ?? join(projectRoot, 'dist'));
  const cacheDir = resolve(options.cacheDir ?? join(projectRoot, '.cache'));
  ensureOsTemporaryStaging(stagedDistDir);
  if (options.stagedUiDir) ensureOsTemporaryStaging(options.stagedUiDir);
  const manifest = options.manifest ?? createBuildManifest(projectRoot, stagedDistDir, { stagedUiDir: options.stagedUiDir });
  if (!isBuildManifest(manifest)) throw new Error('Refusing to publish an invalid build manifest');
  validateManifestForPublication(projectRoot, stagedDistDir, manifest, options.stagedUiDir);

  mkdirSync(distDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  const manifestPath = join(distDir, BUILD_MANIFEST_FILENAME);
  let priorManifest: BuildManifest | undefined;
  try { priorManifest = readBuildManifest(distDir); } catch { /* legacy/corrupt marker is archived byte-for-byte */ }
  const uiRoot = join(projectRoot, 'ui', 'dist');
  const files = [
    ...manifest.outputs.map((record) => ({ key: record.path, source: join(stagedDistDir, record.path), target: join(distDir, record.path), record })),
    ...(manifest.ui?.outputs ?? []).map((record) => ({ key: `ui-dist/${record.path}`, source: join(options.stagedUiDir!, record.path), target: join(uiRoot, record.path), record })),
  ];
  const changedOutputs = files.filter(({ target, record }) => {
    if (!existsSync(target)) return true;
    const bytes = readFileSync(target);
    return bytes.byteLength !== record.bytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256;
  });
  const touched = [...changedOutputs.map(({ key, target }) => ({ key, target })),
    { key: BUILD_MANIFEST_FILENAME, target: manifestPath }];
  const archiveFiles = [
    ...collectRegularFiles(distDir, (path) => /\.(?:js|d\.ts)$/.test(path)).map((target) => ({ key: portableRelative(distDir, target), target })),
    ...(manifest.ui ? collectRegularFiles(uiRoot, () => true).map((target) => ({ key: `ui-dist/${portableRelative(uiRoot, target)}`, target })) : []),
    { key: BUILD_MANIFEST_FILENAME, target: manifestPath },
  ];
  const previousGeneration = priorManifest?.generation ?? legacyGeneration(distDir, archiveFiles.filter(({ key }) => !key.startsWith('ui-dist/')).map(({ key }) => key));
  const backupRoot = join(cacheDir, 'build-generations', previousGeneration);
  const previous = new Map<string, string | undefined>();
  // Rollback uses a fresh physical snapshot, including any modified prior files.
  // The retained generation must never be hard-linked to a writable publication.
  const rollbackRoot = join(cacheDir, `build-rollback-${randomUUID()}`);
  for (const { key, target } of archiveFiles) {
    if (existsSync(target)) archiveCopy(target, join(backupRoot, key));
  }
  for (const { key, target } of touched) {
    const backup = join(rollbackRoot, key);
    if (existsSync(target)) archiveCopy(target, backup);
    previous.set(key, existsSync(backup) ? backup : undefined);
  }
  options.onPhase?.('previous_generation_archived', previousGeneration);

  // Authorization at the protected backend root precedes all UI writes. The
  // validation guard denies this preparation even when backend bytes are equal.
  let manifestTemporary: string;
  try {
    manifestTemporary = durableTemporaryText(
      `${JSON.stringify(manifest, null, 2)}\n`, manifestPath, manifest.generation,
    );
  } catch (error) {
    rmSync(rollbackRoot, { recursive: true, force: true });
    throw error;
  }
  const prepared: Array<{ relativePath: string; target: string; temporary: string }> = [];
  try {
    for (const file of changedOutputs) prepared.push({
      relativePath: file.key, target: file.target,
      temporary: durableTemporaryCopy(file.source, file.target, manifest.generation),
    });
  } catch (error) {
    for (const file of prepared) rmSync(file.temporary, { force: true });
    rmSync(manifestTemporary, { force: true });
    rmSync(rollbackRoot, { recursive: true, force: true });
    throw error;
  }
  options.onPhase?.('replacement_files_prepared', manifest.generation);

  let manifestCommitted = false;
  try {
    for (const [index, file] of prepared.entries()) {
      options.beforeFileCommit?.(file.relativePath, index);
      renameSync(file.temporary, file.target);
    }
    options.onPhase?.('runtime_files_published', manifest.generation);
    renameSync(manifestTemporary, manifestPath);
    manifestCommitted = true;
    options.onPhase?.('manifest_committed', manifest.generation);
    return manifest;
  } catch (error) {
    for (const { key, target } of touched) {
      const backup = previous.get(key);
      try {
        if (backup) {
          const temporary = durableTemporaryCopy(backup, target, previousGeneration.replace(/^legacy-/, ''));
          renameSync(temporary, target);
        } else if (existsSync(target)) {
          unlinkSync(target);
        }
      } catch { /* preserve the original publication error; the retained backup remains recoverable */ }
    }
    throw error;
  } finally {
    rmSync(rollbackRoot, { recursive: true, force: true });
    if (!manifestCommitted) {
      for (const file of prepared) rmSync(file.temporary, { force: true });
      rmSync(manifestTemporary, { force: true });
    }
  }
}
