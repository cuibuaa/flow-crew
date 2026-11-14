import { createHash, randomUUID } from 'node:crypto';
import { hashRollbackFileSync } from './rollback-content-store.js';
import { cpSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from './engine-fs.js';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { prospectivePhysicalPath } from './engine-owned-carriers.js';

export const BUILD_MANIFEST_FILENAME = '.flowcrew-build-manifest.json';
export const BUILD_MANIFEST_VERSION = 1;
// Release declaration: change this value whenever coexistence is not bilateral.
export const CONTROL_COMPATIBILITY = 'shared-store-v1';
const runtimeResources = ['package.json', 'package-lock.json', 'config', 'node_modules', 'skills', 'guide', 'examples'];

export class ExclusiveMigrationRequired extends Error {
  readonly code = 'EXCLUSIVE_MIGRATION_REQUIRED';
  constructor(detail: string) {
    super(`EXCLUSIVE_MIGRATION_REQUIRED: ${detail}. Use daemon hold, daemon hold-status, daemon deploy, then daemon continue for exclusive migration (same FC_HOME and socket).`);
  }
}

export interface TaskRuntimeReference { generation: string; cliPath: string }

/** Missing/foreign declarations are readable, never implicit coexistence authority. */
export function assertControlCompatibility(...manifests: Array<BuildManifest | undefined>): void {
  if (manifests.some(manifest => manifest?.controlCompatibility !== CONTROL_COMPATIBILITY)) {
    throw new ExclusiveMigrationRequired('build compatibility is absent or unsupported');
  }
}

function retainedResource(root: string, path: string): boolean {
  const name = portableRelative(root, path);
  return !['node_modules/.cache', 'node_modules/.vite', 'node_modules/.vite-temp']
    .some(cache => name === cache || name.startsWith(`${cache}/`));
}

function resourceRecords(root: string): BuildFileRecord[] {
  const files: string[] = [];
  const walk = (path: string, ancestors: Set<string>): void => {
    if (!retainedResource(root, path)) return;
    const physical = realpathSync(path);
    const stat = statSync(path);
    if (stat.isFile()) files.push(path);
    else if (stat.isDirectory()) {
      if (ancestors.has(physical)) throw new Error(`Cyclic runtime resource: ${path}`);
      const next = new Set([...ancestors, physical]);
      for (const name of readdirSync(path)) walk(join(path, name), next);
    } else throw new Error(`Nonregular runtime resource: ${path}`);
  };
  for (const resource of runtimeResources) {
    const path = join(root, resource);
    if (existsSync(path)) walk(path, new Set());
  }
  return files.map(path => hashFile(path, root)).sort((a, b) => a.path.localeCompare(b.path));
}

function assertRuntimeResources(root: string, manifest: BuildManifest): void {
  const expected = manifest.inputs.files.filter(record => runtimeResources.some(resource =>
    record.path === resource || record.path.startsWith(`${resource}/`)));
  assertArtifactRecords(resourceRecords(root), expected, 'Runtime resources');
}

/** Runtime references can name only an attested physical generation, never public dist. */
export function validateTaskRuntime(reference: TaskRuntimeReference, runtimeRoot?: string): string {
  if (!reference || typeof reference.generation !== 'string' || !/^[a-f0-9]{64}$/.test(reference.generation)
      || typeof reference.cliPath !== 'string' || !isAbsolute(reference.cliPath)
      || resolve(reference.cliPath) !== reference.cliPath
      || !reference.cliPath.endsWith(`/.cache/build-generations/${reference.generation}/dist/cli.js`)) {
    throw new ExclusiveMigrationRequired('task runtime reference is invalid');
  }
  try {
    if (runtimeRoot && reference.cliPath !== join(prospectivePhysicalPath(runtimeRoot), '.cache', 'build-generations', reference.generation, 'dist', 'cli.js')) {
      throw new Error('runtime reference is outside this task store');
    }
    if (realpathSync(reference.cliPath) !== reference.cliPath) throw new Error('runtime path is not physical');
    const dist = dirname(reference.cliPath);
    const manifest = readBuildManifest(dist);
    if (!manifest || manifest.generation !== reference.generation) throw new Error('runtime generation is absent or different');
    assertBuildArtifactInventory(dist, manifest);
    assertRuntimeResources(dirname(dist), manifest);
    assertControlCompatibility(manifest);
    return reference.cliPath;
  } catch (error) {
    throw new ExclusiveMigrationRequired(`task runtime unavailable or modified: ${String(error)}`);
  }
}

export function selectTaskRuntime(cliPath: string, runtimeRoot: string): TaskRuntimeReference {
  const dist = realpathSync(dirname(cliPath));
  const manifest = readBuildManifest(dist);
  if (!manifest) throw new ExclusiveMigrationRequired('task build has no manifest');
  const runtime = dist.endsWith(`/.cache/build-generations/${manifest.generation}/dist`)
    ? dist : pinBuildRuntime(dist, runtimeRoot);
  const reference = { generation: manifest.generation, cliPath: join(runtime, 'cli.js') };
  validateTaskRuntime(reference);
  return reference;
}

export interface BuildFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BuildManifest {
  version: typeof BUILD_MANIFEST_VERSION;
  generation: string;
  /** Release-declared bilateral shared-store/control compatibility; absent on legacy builds. */
  controlCompatibility?: string;
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

export type BuildPublicationPhase = 'generation_prepared' | 'manifest_committed';

export interface PublishBuildOptions {
  projectRoot: string;
  stagedDistDir: string;
  stagedUiDir?: string;
  distDir?: string;
  cacheDir?: string;
  manifest?: BuildManifest;
  onPhase?: (phase: BuildPublicationPhase, detail: string) => void;
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
  if (existsSync(root)) root = realpathSync(root);
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
  const physicalDist = realpathSync(distDir);
  if (digestRecords(manifest.inputs.files) !== manifest.inputs.hash) throw new Error('Build input inventory digest is invalid');
  const backend = collectBuildArtifacts(physicalDist, true);
  const ui = collectBuildArtifacts(join(physicalDist, '..', 'ui', 'dist'));
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
  if (generationDigest(manifest.inputs.hash, manifest.outputs, manifest.ui, manifest.uiPresence, manifest.artifacts, manifest.controlCompatibility) !== manifest.generation) {
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
  for (const record of resourceRecords(root)) paths.push(join(root, record.path));
  for (const directory of directories.slice(1)) paths.push(...collectRegularFiles(directory, () => true));
  return [...new Set(paths)]
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
  const generation = generationDigest(inputs.hash, outputs, ui, uiPresence, artifacts, CONTROL_COMPATIBILITY);
  return {
    version: BUILD_MANIFEST_VERSION,
    generation,
    controlCompatibility: CONTROL_COMPATIBILITY,
    builtAt: options.builtAt ?? new Date().toISOString(),
    inputs,
    outputs,
    ...(ui ? { ui } : {}),
    uiPresence,
    artifacts,
  };
}

function generationDigest(inputs: string, outputs: BuildFileRecord[], ui?: BuildManifest['ui'],
  uiPresence?: BuildManifest['uiPresence'], artifacts?: BuildManifest['artifacts'], controlCompatibility?: string): string {
  return createHash('sha256').update(`${inputs}\n${digestRecords(outputs)}`
    + (ui ? `\nui:${digestRecords(ui.outputs)}` : '')
    + (uiPresence ? `\nui-presence:${uiPresence}` : '')
    + (artifacts ? `\nartifacts:${digestRecords(artifacts.backend)}:${digestRecords(artifacts.ui)}` : '')
    + (controlCompatibility !== undefined ? `\ncontrol-compatibility:${controlCompatibility}` : '')).digest('hex');
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
    && (manifest.controlCompatibility === undefined || typeof manifest.controlCompatibility === 'string')
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

// Replaces preflight's reason-text classification; details are opaque diagnostics.
export class BuildInspectionError extends Error {
  constructor(readonly code: 'missing_manifest' | 'unreadable_manifest' | 'invalid_manifest' | 'missing_ui' | 'hash_mismatch' | 'output_mismatch', message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export function readBuildManifest(distDir: string): BuildManifest | undefined {
  const path = join(resolve(distDir), BUILD_MANIFEST_FILENAME);
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (error) {
    throw new BuildInspectionError('unreadable_manifest',
      `Build manifest is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isBuildManifest(value)) throw new BuildInspectionError('invalid_manifest', `Build manifest is invalid at ${path}`);
  return value;
}

export function assertDistFresh(projectRoot: string, distDir = join(projectRoot, 'dist')): BuildManifest {
  const manifest = readBuildManifest(distDir);
  const remedy = 'Run `npm run build` and retry the tests.';
  if (!manifest) throw new BuildInspectionError('missing_manifest', `dist freshness cannot be proven: ${BUILD_MANIFEST_FILENAME} is missing. ${remedy}`);
  if (existsSync(join(projectRoot, 'ui', 'package.json')) && !manifest.ui) {
    throw new BuildInspectionError('missing_ui', `UI freshness cannot be proven: the build manifest has no UI outputs. ${remedy}`);
  }
  const currentInputs = computeBuildInputDigest(projectRoot);
  if (manifest.inputs.hash !== currentInputs.hash) {
    throw new BuildInspectionError('hash_mismatch',
      `dist is stale: source/config digest ${currentInputs.hash.slice(0, 12)} does not match `
      + `deployed generation ${manifest.inputs.hash.slice(0, 12)}. ${remedy}`,
    );
  }
  const expected = expectedBuildOutputs(projectRoot);
  const declared = manifest.outputs.map(({ path }) => path).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    throw new BuildInspectionError('output_mismatch', `dist manifest does not cover the current compiler output set. ${remedy}`);
  }
  try { assertBuildArtifactInventory(distDir, manifest); }
  catch (error) { throw new BuildInspectionError('output_mismatch', String(error), { cause: error }); }
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
  const generation = generationDigest(manifest.inputs.hash, manifest.outputs, manifest.ui, manifest.uiPresence, manifest.artifacts, manifest.controlCompatibility);
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

/** Source checkout for a runtime, including immutable published generations. */
export function buildProjectRoot(distDir: string): string {
  const root = dirname(resolve(distDir));
  const source = join(root, '.project-root');
  return existsSync(source) ? realpathSync(source) : root;
}

function validateBuildPublication(options: PublishBuildOptions) {
  const projectRoot = resolve(options.projectRoot);
  const stagedDistDir = resolve(options.stagedDistDir);
  const stagedUiDir = options.stagedUiDir ? resolve(options.stagedUiDir) : undefined;
  const distDir = resolve(options.distDir ?? join(projectRoot, 'dist'));
  const cacheDir = resolve(options.cacheDir ?? join(distDir, '..', '.cache'));
  const uiRoot = join(distDir, '..', 'ui', 'dist');
  const manifest = options.manifest ?? createBuildManifest(projectRoot, stagedDistDir, { stagedUiDir });
  if (!isBuildManifest(manifest)) throw new Error('Refusing to publish an invalid build manifest');
  const inputs = validateManifestForPublication(projectRoot, stagedDistDir, manifest, stagedUiDir);
  const publicationRoots = [projectRoot, distDir, uiRoot, cacheDir, ...buildInputDirectories(projectRoot),
    ...inputs.map(({ path }) => join(projectRoot, path))];
  ensurePrivateBuildStaging(stagedDistDir, publicationRoots);
  if (stagedUiDir) ensurePrivateBuildStaging(stagedUiDir, publicationRoots);

  return { projectRoot, stagedDistDir, stagedUiDir, distDir, cacheDir, uiRoot, manifest };
}

/** Ordinary build outputs are portable directories, independent of runtime caches. */
export function publishBuildOutputs(options: PublishBuildOptions): BuildManifest {
  const { stagedDistDir, stagedUiDir, distDir, cacheDir, uiRoot, manifest } = validateBuildPublication(options);
  const temporary = join(cacheDir, `.build-${randomUUID()}`);
  try {
    copyBuildPayload(stagedDistDir, stagedUiDir, temporary, manifest);
    options.onPhase?.('generation_prepared', manifest.generation);
    const commit = join(temporary, BUILD_MANIFEST_FILENAME);
    renameSync(join(temporary, 'dist', BUILD_MANIFEST_FILENAME), commit);
    // The manifest is the commit record. Remove it before replacing either tree
    // so an interrupted publication cannot attest a mixed backend/UI pair.
    if (existsSync(distDir) && !lstatSync(distDir).isSymbolicLink()) {
      rmSync(join(distDir, BUILD_MANIFEST_FILENAME), { force: true });
    }
    for (const [destination, payload] of [[uiRoot, 'ui/dist'], [distDir, 'dist']]) {
      const source = join(temporary, payload);
      if (existsSync(source)) publishBuildFiles(source, destination);
      else rmSync(destination, { recursive: true, force: true });
    }
    renameSync(commit, join(distDir, BUILD_MANIFEST_FILENAME));
    options.onPhase?.('manifest_committed', manifest.generation);
    return manifest;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Preserve live directory paths while atomically replacing individual files. */
function publishBuildFiles(source: string, destination: string): void {
  const previous = lstatSync(destination, { throwIfNoEntry: false });
  if (previous && !previous.isDirectory()) rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const entries = readdirSync(source, { withFileTypes: true });
  const names = new Set(entries.map(entry => entry.name));
  for (const name of readdirSync(destination)) {
    if (!names.has(name)) rmSync(join(destination, name), { recursive: true, force: true });
  }
  for (const entry of entries) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) publishBuildFiles(from, to);
    else {
      if (lstatSync(to, { throwIfNoEntry: false })?.isDirectory()) rmSync(to, { recursive: true, force: true });
      renameSync(from, to);
    }
  }
}

function copyBuildPayload(dist: string, ui: string | undefined, target: string, manifest: BuildManifest): void {
  mkdirSync(target, { recursive: true });
  cpSync(realpathSync(dist), join(target, 'dist'), { recursive: true });
  rmSync(join(target, 'dist', '.tsbuildinfo'), { force: true });
  if (ui) cpSync(realpathSync(ui), join(target, 'ui', 'dist'), { recursive: true });
  writeFileSync(join(target, 'dist', BUILD_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
  assertBuildArtifactInventory(join(target, 'dist'), manifest);
}

/** Pin engine bytes and resource/dependency roots for control and task consumers. */
export function pinBuildRuntime(distDir: string, runtimeRoot: string): string {
  distDir = realpathSync(distDir);
  ensurePrivateBuildStaging(runtimeRoot, [distDir, join(distDir, '..', 'ui', 'dist')]);
  const manifest = readBuildManifest(distDir);
  if (!manifest) throw new Error('Cannot pin runtime: build manifest is missing');
  assertBuildArtifactInventory(distDir, manifest);
  const projectRoot = buildProjectRoot(distDir);
  publishRuntimeGeneration({ projectRoot, stagedDistDir: distDir,
    stagedUiDir: manifest.ui ? join(distDir, '..', 'ui', 'dist') : undefined,
    distDir: join(runtimeRoot, 'dist'), cacheDir: join(runtimeRoot, '.cache'), manifest });
  return realpathSync(join(runtimeRoot, 'dist'));
}

function publishRuntimeGeneration(options: PublishBuildOptions & {
  distDir: string; cacheDir: string; manifest: BuildManifest;
}): BuildManifest {
  const { projectRoot, stagedDistDir, stagedUiDir, distDir, cacheDir, manifest } = options;
  const uiRoot = join(distDir, '..', 'ui', 'dist');
  const generations = join(cacheDir, 'build-generations');
  const generationRoot = join(generations, manifest.generation);
  const temporary = join(generations, `.${randomUUID()}`);
  const selected = join(cacheDir, 'build-current');
  const nextLink = join(cacheDir, `.build-current-${randomUUID()}`);
  const previous = existsSync(distDir) ? realpathSync(distDir) : undefined;
  mkdirSync(generations, { recursive: true });
  try {
    if (existsSync(generationRoot)) {
      assertBuildArtifactInventory(join(generationRoot, 'dist'), manifest);
      assertRuntimeResources(generationRoot, manifest);
      if (join(generationRoot, 'dist') === previous) return manifest;
    } else {
      copyBuildPayload(stagedDistDir, stagedUiDir, temporary, manifest);
      for (const resource of runtimeResources) {
        const source = join(projectRoot, resource);
        if (existsSync(source)) cpSync(source, join(temporary, resource), { recursive: true, dereference: true, filter: source => retainedResource(projectRoot, source) });
      }
      assertRuntimeResources(temporary, manifest);
      symlinkSync(projectRoot, join(temporary, '.project-root'));
      options.onPhase?.('generation_prepared', manifest.generation);
      renameSync(temporary, generationRoot);
    }
    symlinkSync(generationRoot, nextLink);
    // Initial conversion requires the old daemon to be stopped. Afterwards
    // both stable public links follow the same atomically selected generation.
    for (const [publicPath, payload] of [[distDir, 'dist'], [uiRoot, 'ui/dist']]) {
      mkdirSync(dirname(publicPath), { recursive: true });
      if (existsSync(publicPath) && !lstatSync(publicPath).isSymbolicLink()) {
        renameSync(publicPath, join(generations, `legacy-${randomUUID()}`));
      }
      if (!existsSync(publicPath)) {
        rmSync(publicPath, { force: true }); // a backend-only UI link can be dangling
        symlinkSync(join(selected, payload), publicPath);
      }
    }
    renameSync(nextLink, selected);
    options.onPhase?.('manifest_committed', manifest.generation);
    return manifest;
  } finally {
    rmSync(nextLink, { force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}
