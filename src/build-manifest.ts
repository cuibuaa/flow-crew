import { createHash, randomUUID } from 'node:crypto';
import { hashRollbackFileSync, updateFileHashSync } from './rollback-content-store.js';
import { chmodSync, closeSync, copyFileSync, mkdirSync, openSync, renameSync, rmSync, unlinkSync, writeFileSync } from './engine-fs.js';
import { existsSync, fsyncSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { findDeployedDistConsumers } from './daemon-identity.js';
import { prospectivePhysicalPath } from './engine-owned-carriers.js';

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
  /** Served at ui/dist beside the backend destination; absent for backend-only packages. */
  ui?: { outputs: BuildFileRecord[] };
  /** New builds explicitly attest UI intent; legacy backend-only roots remain readable. */
  uiPresence?: 'required' | 'absent';
  /** Complete published payload, including UI resources retained for older consumers. */
  artifacts?: { backend: BuildFileRecord[]; ui: BuildFileRecord[] };
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
  const { byteLength, sha256 } = hashRollbackFileSync(path);
  return { path: portableRelative(root, path), bytes: byteLength, sha256 };
}

function digestRecords(records: BuildFileRecord[]): string {
  const hash = createHash('sha256');
  for (const record of records) {
    hash.update(`${Buffer.byteLength(record.path)}:${record.path}:`);
    hash.update(`${record.bytes}:${record.sha256}\n`);
  }
  return hash.digest('hex');
}

/** One inventory for publication, freshness and identity. No links or special
 * nodes can supply served bytes outside the attested roots. The manifest is the
 * commit record, so its own bytes cannot be part of its content digest. */
export function collectBuildArtifacts(root: string, excludeCommitRecord = false): BuildFileRecord[] {
  const paths: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error(`Nonregular build artifact: ${path}`);
    }
  };
  let rootStat;
  try { rootStat = lstatSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
  if (!rootStat.isDirectory()) throw new Error(`Nonregular build artifact root: ${root}`);
  walk(root);
  return paths.filter((path) => !excludeCommitRecord || portableRelative(root, path) !== BUILD_MANIFEST_FILENAME)
    .map((path) => hashFile(path, root)).sort((a, b) => a.path.localeCompare(b.path));
}

function assertArtifactRecords(actual: BuildFileRecord[], expected: BuildFileRecord[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} artifact inventory is modified, partial or contains undeclared outputs`);
  }
}

export function assertBuildArtifactInventory(distDir: string, manifest: BuildManifest): NonNullable<BuildManifest['artifacts']> {
  const backend = collectBuildArtifacts(resolve(distDir), true);
  const ui = collectBuildArtifacts(join(resolve(distDir), '..', 'ui', 'dist'));
  const backendByPath = new Map(backend.map((record) => [record.path, record]));
  for (const record of manifest.outputs) {
    const actual = backendByPath.get(record.path);
    if (!actual || actual.bytes !== record.bytes || actual.sha256 !== record.sha256) {
      throw new Error(`Cannot fingerprint incomplete or modified backend generation: ${record.path}`);
    }
  }
  const uiByPath = new Map(ui.map((record) => [record.path, record]));
  for (const record of manifest.ui?.outputs ?? []) {
    const actual = uiByPath.get(record.path);
    if (!actual) throw new Error(`Cannot fingerprint incomplete UI generation: ${record.path}`);
    if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) {
      throw new Error(`Cannot fingerprint modified UI generation: ${record.path}`);
    }
  }
  // Even legacy manifests must cover all physical outputs. Old retained files
  // require a new publication to attest them, not deletion during validation.
  assertArtifactRecords(backend, manifest.artifacts?.backend ?? manifest.outputs, 'dist');
  assertArtifactRecords(ui, manifest.artifacts?.ui ?? manifest.ui?.outputs ?? [], 'UI');
  if (manifest.uiPresence === 'required' && !manifest.ui) throw new Error('UI presence requires UI outputs');
  if (manifest.uiPresence === 'absent' && (manifest.ui || ui.length)) throw new Error('UI absence attestation conflicts with served outputs');
  if (generationDigest(manifest.inputs.hash, manifest.outputs, manifest.ui, manifest.uiPresence, manifest.artifacts) !== manifest.generation) {
    throw new Error('dist manifest generation digest is invalid');
  }
  return { backend, ui };
}

function buildInputDirectories(root: string): string[] {
  const directories = [join(root, 'src')];
  if (existsSync(join(root, 'ui', 'package.json'))) directories.push(...['src', 'public'].map((directory) => join(root, 'ui', directory)));
  return directories;
}

export function collectBuildInputRecords(projectRoot: string): BuildFileRecord[] {
  const root = resolve(projectRoot);
  const directories = buildInputDirectories(root);
  const paths = collectRegularFiles(directories[0], (path) => /\.(?:ts|tsx)$/.test(path));
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
  }
  for (const directory of directories.slice(1)) paths.push(...collectRegularFiles(directory, () => true));
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
  // Incremental compiler metadata belongs to scratch, not the published payload.
  const staged = collectBuildArtifacts(root, true).filter((record) => record.path !== '.tsbuildinfo');
  assertArtifactRecords(staged, outputs, 'Staged backend');
  const inputs = computeBuildInputDigest(projectRoot);
  const ui = options.stagedUiDir ? { outputs: collectBuildArtifacts(options.stagedUiDir) } : undefined;
  if (existsSync(join(projectRoot, 'ui', 'package.json')) && !ui) {
    throw new Error('UI build inputs require a staged UI bundle');
  }
  if (ui && !ui.outputs.some((record) => record.path === 'index.html')) {
    throw new Error('UI generation is incomplete: index.html is missing');
  }
  const uiPresence = ui ? 'required' : 'absent';
  const artifacts = { backend: outputs, ui: ui?.outputs ?? [] };
  const generation = generationDigest(inputs.hash, outputs, ui, uiPresence, artifacts);
  return {
    version: BUILD_MANIFEST_VERSION,
    generation,
    builtAt: options.builtAt ?? new Date().toISOString(),
    inputs,
    outputs,
    ...(ui ? { ui } : {}),
    uiPresence,
    artifacts,
  };
}

function generationDigest(inputs: string, outputs: BuildFileRecord[], ui?: BuildManifest['ui'],
  uiPresence?: BuildManifest['uiPresence'], artifacts?: BuildManifest['artifacts']): string {
  return createHash('sha256').update(`${inputs}\n${digestRecords(outputs)}`
    + (ui ? `\nui:${digestRecords(ui.outputs)}` : '')
    + (uiPresence ? `\nui-presence:${uiPresence}` : '')
    + (artifacts ? `\nartifacts:${digestRecords(artifacts.backend)}:${digestRecords(artifacts.ui)}` : '')).digest('hex');
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
      && manifest.ui.outputs.some((record) => record.path === 'index.html')))
    && (manifest.uiPresence === undefined || ['required', 'absent'].includes(manifest.uiPresence))
    && (manifest.artifacts === undefined || (!!manifest.artifacts
      && Array.isArray(manifest.artifacts.backend) && manifest.artifacts.backend.every(isFileRecord)
      && Array.isArray(manifest.artifacts.ui) && manifest.artifacts.ui.every(isFileRecord)));
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
  assertBuildArtifactInventory(distDir, manifest);
  return manifest;
}

function validateManifestForPublication(
  projectRoot: string,
  stagedDistDir: string,
  manifest: BuildManifest,
  stagedUiDir?: string,
): BuildFileRecord[] {
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
  assertArtifactRecords(collectBuildArtifacts(stagedDistDir, true).filter((record) => record.path !== '.tsbuildinfo'), manifest.outputs, 'Staged backend');
  if (manifest.ui) {
    if (!stagedUiDir) throw new Error('Refusing to publish UI without a staged bundle');
    const actual = collectBuildArtifacts(stagedUiDir);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.ui.outputs)) {
      throw new Error('Refusing to publish UI whose output set or hashes differ from the staged generation');
    }
  } else if (existsSync(join(projectRoot, 'ui', 'package.json'))) {
    throw new Error('Refusing to publish backend-only identity for a UI checkout');
  }
  const generation = generationDigest(manifest.inputs.hash, manifest.outputs, manifest.ui, manifest.uiPresence, manifest.artifacts);
  if (generation !== manifest.generation) {
    throw new Error('Refusing to publish a manifest with an invalid generation digest');
  }
  return currentInputs.files;
}

function ensurePrivateBuildStaging(path: string, roots: string[]): void {
  const staging = prospectivePhysicalPath(path);
  for (const root of roots) {
    const physicalRoot = prospectivePhysicalPath(root);
    if ([relative(staging, physicalRoot), relative(physicalRoot, staging)]
      .some((relation) => relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)))) {
      throw new Error(`Build staging overlaps authored or published roots: ${staging}`);
    }
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
    const size = statSync(absolute).size;
    hash.update(`${path}:${size}:`);
    if (updateFileHashSync(absolute, hash).byteLength !== size) {
      throw new Error(`${absolute} changed while its build identity was hashed`);
    }
  }
  return `legacy-${hash.digest('hex')}`;
}

/**
 * Publish the exact staged backend output set without removing the dist root.
 * Refuse publication while a live consumer can still import the previous outputs.
 * Each replacement is complete before rename; the manifest is the commit record
 * and is renamed last. A synchronous failure rolls every touched path back from
 * the retained previous generation.
 */
export function publishBuildGeneration(options: PublishBuildOptions): BuildManifest {
  const projectRoot = resolve(options.projectRoot);
  const stagedDistDir = resolve(options.stagedDistDir);
  const stagedUiDir = options.stagedUiDir ? resolve(options.stagedUiDir) : undefined;
  const distDir = resolve(options.distDir ?? join(projectRoot, 'dist'));
  const cacheDir = resolve(options.cacheDir ?? join(distDir, '..', '.cache'));
  const uiRoot = join(distDir, '..', 'ui', 'dist');
  let manifest = options.manifest ?? createBuildManifest(projectRoot, stagedDistDir, { stagedUiDir });
  if (!isBuildManifest(manifest)) throw new Error('Refusing to publish an invalid build manifest');
  const inputs = validateManifestForPublication(projectRoot, stagedDistDir, manifest, stagedUiDir);
  const publicationRoots = [projectRoot, distDir, uiRoot, cacheDir, ...buildInputDirectories(projectRoot),
    ...inputs.map(({ path }) => join(projectRoot, path))];
  ensurePrivateBuildStaging(stagedDistDir, publicationRoots);
  if (stagedUiDir) ensurePrivateBuildStaging(stagedUiDir, publicationRoots);

  const merge = (prior: BuildFileRecord[], current: BuildFileRecord[]): BuildFileRecord[] => {
    const records = new Map(prior.map((record) => [record.path, record]));
    for (const record of current) records.set(record.path, record);
    return [...records.values()].sort((a, b) => a.path.localeCompare(b.path));
  };
  const priorBackend = collectBuildArtifacts(distDir, true);
  const currentPaths = new Set(manifest.outputs.map(({ path }) => path));
  const removedOutputs = priorBackend.filter(({ path }) => !currentPaths.has(path))
    .map(({ path }) => ({ key: path, target: join(distDir, path) }));
  const consumers = findDeployedDistConsumers(distDir, {
    fcHome: resolve(process.env.FC_HOME ?? join(homedir(), '.fc')),
  });
  if (consumers.length) {
    throw new Error('Refusing to publish build outputs while dist has live consumers: '
      + consumers.map(({ label }) => label).join(', ')
      + '. Publish to a private build root or after those consumers stop.');
  }
  const artifacts = {
    backend: manifest.outputs,
    ui: merge(collectBuildArtifacts(uiRoot), manifest.ui?.outputs ?? []),
  };
  if (!manifest.ui && artifacts.ui.length) {
    throw new Error('Refusing backend-only publication while retained UI is still served');
  }
  const uiPresence = manifest.ui ? 'required' : 'absent';
  manifest = { ...manifest, uiPresence, artifacts,
    generation: generationDigest(manifest.inputs.hash, manifest.outputs, manifest.ui, uiPresence, artifacts) };

  mkdirSync(distDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  const manifestPath = join(distDir, BUILD_MANIFEST_FILENAME);
  let priorManifest: BuildManifest | undefined;
  try { priorManifest = readBuildManifest(distDir); } catch { /* legacy/corrupt marker is archived byte-for-byte */ }
  const files = [
    ...manifest.outputs.map((record) => ({ key: record.path, source: join(stagedDistDir, record.path), target: join(distDir, record.path), record })),
    ...(manifest.ui?.outputs ?? []).map((record) => ({ key: `ui-dist/${record.path}`, source: join(stagedUiDir!, record.path), target: join(uiRoot, record.path), record })),
  ];
  const changedOutputs = files.filter(({ target, record }) => {
    if (!existsSync(target)) return true;
    const content = hashRollbackFileSync(target);
    return content.byteLength !== record.bytes || content.sha256 !== record.sha256;
  });
  const touched = [...changedOutputs.map(({ key, target }) => ({ key, target })), ...removedOutputs,
    { key: BUILD_MANIFEST_FILENAME, target: manifestPath }];
  const archiveFiles = [
    ...priorBackend.map(({ path }) => ({ key: path, target: join(distDir, path) })),
    ...collectBuildArtifacts(uiRoot).map(({ path }) => ({ key: `ui-dist/${path}`, target: join(uiRoot, path) })),
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

  // Prepare the manifest before UI writes. A validation launch that changes
  // the running distribution is voided by the parent integrity check.
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
    for (const [index, file] of removedOutputs.entries()) {
      options.beforeFileCommit?.(file.key, prepared.length + index);
      unlinkSync(file.target);
    }
    options.onPhase?.('runtime_files_published', manifest.generation);
    // Reobserve the exact backend set and retained UI payloads. Only our pending
    // commit record is excluded; a late file cannot be silently blessed as fresh.
    assertArtifactRecords(collectBuildArtifacts(distDir, true)
      .filter((record) => record.path !== basename(manifestTemporary)), artifacts.backend, 'dist');
    assertArtifactRecords(collectBuildArtifacts(uiRoot), artifacts.ui, 'UI');
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
