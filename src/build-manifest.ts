import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
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
}

export type BuildPublicationPhase =
  | 'previous_generation_archived'
  | 'replacement_files_prepared'
  | 'runtime_files_published'
  | 'manifest_committed';

export interface PublishBuildOptions {
  projectRoot: string;
  stagedDistDir: string;
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
  options: { builtAt?: string } = {},
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
  const generation = createHash('sha256')
    .update(`${inputs.hash}\n${digestRecords(outputs)}`)
    .digest('hex');
  return {
    version: BUILD_MANIFEST_VERSION,
    generation,
    builtAt: options.builtAt ?? new Date().toISOString(),
    inputs,
    outputs,
  };
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
    && manifest.outputs.every(isFileRecord);
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
  return manifest;
}

function validateManifestForPublication(
  projectRoot: string,
  stagedDistDir: string,
  manifest: BuildManifest,
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
  const generation = createHash('sha256')
    .update(`${manifest.inputs.hash}\n${digestRecords(manifest.outputs)}`)
    .digest('hex');
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

function linkOrCopy(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) return;
  try { linkSync(source, target); } catch { copyFileSync(source, target); }
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
  const manifest = options.manifest ?? createBuildManifest(projectRoot, stagedDistDir);
  if (!isBuildManifest(manifest)) throw new Error('Refusing to publish an invalid build manifest');
  validateManifestForPublication(projectRoot, stagedDistDir, manifest);

  mkdirSync(distDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  const manifestPath = join(distDir, BUILD_MANIFEST_FILENAME);
  let priorManifest: BuildManifest | undefined;
  try { priorManifest = readBuildManifest(distDir); } catch { /* legacy/corrupt marker is archived byte-for-byte */ }
  const priorRecords = new Map(priorManifest?.outputs.map((record) => [record.path, record]) ?? []);
  const changedOutputs = manifest.outputs.filter((record) => {
    const prior = priorRecords.get(record.path);
    const currentPath = join(distDir, record.path);
    if (!prior || prior.bytes !== record.bytes || prior.sha256 !== record.sha256 || !existsSync(currentPath)) {
      return true;
    }
    const current = hashFile(currentPath, distDir);
    return current.bytes !== prior.bytes || current.sha256 !== prior.sha256;
  });
  const touchedPaths = [...changedOutputs.map(({ path }) => path), BUILD_MANIFEST_FILENAME];
  const legacyRuntimePaths = collectRegularFiles(distDir, (path) => /\.(?:js|d\.ts)$/.test(path))
    .map((path) => portableRelative(distDir, path));
  const archivePaths = [
    ...new Set([
      ...(priorManifest?.outputs.map(({ path }) => path) ?? legacyRuntimePaths),
      BUILD_MANIFEST_FILENAME,
    ]),
  ];
  const previousGeneration = priorManifest?.generation ?? legacyGeneration(distDir, archivePaths);
  const backupRoot = join(cacheDir, 'build-generations', previousGeneration);
  const previous = new Map<string, string | undefined>();
  for (const relativePath of archivePaths) {
    const current = join(distDir, relativePath);
    if (!existsSync(current)) continue;
    const backup = join(backupRoot, relativePath);
    linkOrCopy(current, backup);
  }
  for (const relativePath of touchedPaths) {
    const backup = join(backupRoot, relativePath);
    previous.set(relativePath, existsSync(backup) ? backup : undefined);
  }
  options.onPhase?.('previous_generation_archived', previousGeneration);

  const prepared = changedOutputs.map((record) => ({
    relativePath: record.path,
    target: join(distDir, record.path),
    temporary: durableTemporaryCopy(join(stagedDistDir, record.path), join(distDir, record.path), manifest.generation),
  }));
  const manifestTemporary = durableTemporaryText(
    `${JSON.stringify(manifest, null, 2)}\n`,
    manifestPath,
    manifest.generation,
  );
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
    for (const relativePath of touchedPaths) {
      const target = join(distDir, relativePath);
      const backup = previous.get(relativePath);
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
    if (!manifestCommitted) {
      for (const file of prepared) rmSync(file.temporary, { force: true });
      rmSync(manifestTemporary, { force: true });
    }
  }
}
