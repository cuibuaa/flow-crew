import { ignoredProjectPaths } from '../../project-identity.js';
// Boundary: Own one run-scoped lazy Git/disk preimage cache, watcher journal, current-image nomination, committed writes and lifecycle cleanup.
import { type GitIndexEntry, parseGitIndexEntries } from "./file-images.js";
import { RollbackContentStore, type RollbackStatIdentity, rollbackStatIdentity, rollbackStatIdentitiesEqual } from "../../rollback-content-store.js";
import { normalizedProjectPath, normalizedProjectContentPath } from "../sched_admission/scope-services.js";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, join, relative, dirname } from "node:path";
import { existsSync, readFileSync, readlinkSync, lstatSync, realpathSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { type RepairFileImage, stageZeroIndexEntry, readRepairFileImage, repairFileIdentity, repairFileImageBytes, describeRepairError, gitObjectIdForPath } from './file-images.js';
import { resolveImmutableEvidenceBindings, canonicalPotentialProjectPath, listProjectFiles, listProjectFilesAt, firstImmutableEvidenceConflict, type ImmutableEvidenceBinding } from './path-capabilities.js';

export interface RunRollbackBaseline {
  frozenInputs: ImmutableEvidenceBinding[];
  frozenImages: Map<string, RepairFileImage>;
  frozenTopology: Set<string>;
  key: string;
  projectDir: string;
  runDirPath?: string;
  contentStore: RollbackContentStore;
  images: Map<string, RepairFileImage>;
  cleanTracked: Set<string>;
  lazyGitTracked: Map<string, RollbackStatIdentity>;
  gitIndexEntries: Map<string, GitIndexEntry[]>;
  gitRoot?: string;
  journal: Map<string, number>;
  journalSequence: number;
  reliable: boolean;
  watcher?: import('node:fs').FSWatcher;
  initialization: {
    filesEnumerated: number;
    filesRead: number;
    filesHashed: number;
    bytesRead: number;
    bytesHashed: number;
    strategy: 'git-index-plus-dirty-images' | 'filesystem-images';
  };
}

const rollbackBaselines = new Map<string, RunRollbackBaseline>();

/** Gitlinks are one superproject entry even when their initialized worktree is
 * a populated directory. Collapse descendant notifications and scans to that
 * entry instead of treating submodule-owned files as untracked superproject
 * writes. */
export function trackedGitlinkAncestor(
  baseline: Pick<RunRollbackBaseline, 'gitIndexEntries'>,
  rawPath: string,
): string | undefined {
  let path = normalizedProjectPath(rawPath);
  while (path) {
    if (stageZeroIndexEntry(baseline.gitIndexEntries.get(path))?.kind === 'gitlink') return path;
    const separator = path.lastIndexOf('/');
    if (separator < 0) break;
    path = path.slice(0, separator);
  }
  return undefined;
}

function nulPaths(output: string): string[] {
  return output.split('\0').map((value) => value.replace(/\\/g, '/')).filter(Boolean);
}

function rollbackListedPaths(output: string): string[] {
  return nulPaths(output).filter((path) => normalizedProjectContentPath(path) !== undefined);
}

function gitOutput(projectDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: projectDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function rollbackBaselineKey(projectDir: string, runDirPath?: string): string {
  let root = resolve(projectDir);
  try { root = realpathSync(projectDir); } catch { /* cleanup may follow removal of the project */ }
  return `${root}\u0000${runDirPath ? resolve(runDirPath) : '__standalone__'}`;
}

function noteRollbackPath(baseline: RunRollbackBaseline, rawPath: string): void {
  const observedPath = normalizedProjectPath(rawPath);
  if (!observedPath || !normalizedProjectContentPath(observedPath)) return;
  const path = trackedGitlinkAncestor(baseline, observedPath) ?? observedPath;
  baseline.journalSequence++;
  baseline.journal.set(path, baseline.journalSequence);

}

function createRollbackBaseline(projectDir: string, runDirPath?: string): RunRollbackBaseline {
  const key = rollbackBaselineKey(projectDir, runDirPath);
  projectDir = realpathSync(projectDir);
  const contentStore = new RollbackContentStore(runDirPath);
  const images = new Map<string, RepairFileImage>();
  const cleanTracked = new Set<string>();
  const lazyGitTracked = new Map<string, RollbackStatIdentity>();
  const indexEntries = new Map<string, GitIndexEntry[]>();
  let filesEnumerated = 0;
  let filesRead = 0;
  let filesHashed = 0;
  let bytesRead = 0;
  let bytesHashed = 0;
  let strategy: RunRollbackBaseline['initialization']['strategy'] = 'filesystem-images';
  let gitRoot: string | undefined;
  const captureBaselineImage = (path: string, entries?: readonly GitIndexEntry[]): void => {
    const image = repairFileIdentity(readRepairFileImage(projectDir, path, entries));
    images.set(path, image);
    filesRead++;
    bytesRead += repairFileImageBytes(image);
    if (image.exists) {
      filesHashed++;
      bytesHashed += repairFileImageBytes(image);
    }
  };
  try {
    gitRoot = gitOutput(projectDir, ['rev-parse', '--show-toplevel']).trim();
    const trackedEntries = parseGitIndexEntries(gitOutput(projectDir, ['ls-files', '-s', '-z', '--cached', '--', '.']));
    const tracked = new Set(trackedEntries.keys());
    for (const [path, entries] of trackedEntries) indexEntries.set(path, entries);
    const ignored = rollbackListedPaths(gitOutput(projectDir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '.']));
    for (const path of ignored) {
      images.set(path, { exists: false, provenance: 'unknown' });
    }
    const dirty = new Set([
      // Every tracked path remains guardable even when it lives below a cache
      // directory. Preserve its live identity; an admitted writer captures
      // operator bytes before writing instead of restoring the index blob.
      ...nulPaths(gitOutput(projectDir, ['diff', '--name-only', '-z', '--', '.'])),
      // Git deliberately hides assume-unchanged and skip-worktree paths from
      // ordinary diff. Snapshot their live bytes even if the index object is
      // unchanged, since the worktree can still contain an operator preimage.
      ...gitOutput(projectDir, ['ls-files', '-v', '-z', '--cached', '--', '.'])
        .split('\0')
        .filter((entry) => entry.length > 2 && entry[1] === ' ' && entry[0] !== 'H')
        .map((entry) => entry.slice(2).replace(/\\/g, '/')),
      ...rollbackListedPaths(gitOutput(projectDir, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.'])),
    ]);
    filesEnumerated = tracked.size + [...dirty].filter((path) => !tracked.has(path)).length;
    for (const path of tracked) if (!dirty.has(path)) cleanTracked.add(path);
    // A Git object is an exact worktree preimage only when checkout attributes
    // cannot transform its bytes. Query attributes in one process rather than
    // launching a subprocess per tracked file.
    const autocrlf = (() => { try { return gitOutput(projectDir, ['config', '--get', 'core.autocrlf']).trim(); } catch { return ''; } })();
    const eol = (() => { try { return gitOutput(projectDir, ['config', '--get', 'core.eol']).trim(); } catch { return ''; } })();
    if (autocrlf !== 'true' && eol !== 'crlf' && cleanTracked.size > 0) {
      const paths = [...cleanTracked].filter((path) => {
        const kind = stageZeroIndexEntry(indexEntries.get(path))?.kind;
        return kind === 'regular' || kind === 'executable';
      });
      const checked = spawnSync('git', ['check-attr', '-z', '--stdin', 'filter', 'ident', 'text', 'eol', 'working-tree-encoding'], {
        cwd: projectDir, input: Buffer.from(`${paths.join('\0')}\0`), encoding: 'buffer',
        stdio: ['pipe', 'pipe', 'ignore'], timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
      });
      if (checked.status === 0 && checked.stdout) {
        const values = checked.stdout.toString('utf8').split('\0');
        const transformed = new Set<string>();
        for (let index = 0; index + 2 < values.length; index += 3) {
          if (values[index + 2] !== 'unspecified') transformed.add(values[index]);
        }
        for (const path of paths) {
          if (transformed.has(path)) continue;
          const identity = rollbackStatIdentity(join(projectDir, path));
          if (identity?.type === 'file') lazyGitTracked.set(path, identity);
        }
      }
    }
    for (const path of dirty) {
      captureBaselineImage(path, indexEntries.get(path));
    }
    // A clean blob can be recreated from its immutable index object lazily. A
    // gitlink's initialized/uninitialized worktree state cannot, so freeze it
    // now, before any stage can change a nested repository.
    for (const [path, entries] of trackedEntries) {
      if (stageZeroIndexEntry(entries)?.kind !== 'gitlink' || images.has(path)) continue;
      captureBaselineImage(path, entries);
    }
    strategy = 'git-index-plus-dirty-images';
  } catch (error) {
    // A non-Git project needs a filesystem identity inventory. Once Git was
    // found, an inventory/capture failure must not silently expand the scan.
    if (gitRoot) throw error;
    for (const path of listProjectFiles(projectDir)) {
      filesEnumerated++;
      captureBaselineImage(path);
    }
  }
  const baseline: RunRollbackBaseline = {
    frozenInputs: [], frozenImages: new Map(), frozenTopology: new Set(),
    key, projectDir, runDirPath, contentStore, images, cleanTracked, lazyGitTracked, gitIndexEntries: indexEntries, gitRoot,
    journal: new Map(), journalSequence: 0, reliable: true,
    initialization: { filesEnumerated, filesRead, filesHashed, bytesRead, bytesHashed, strategy },
  };
  const briefPath = runDirPath && join(runDirPath, 'task_brief.md');
  baseline.frozenInputs = briefPath && existsSync(briefPath)
    ? resolveImmutableEvidenceBindings(projectDir, readFileSync(briefPath, 'utf8')) : [];
  // Derive supporting topology only for identities still frozen after exact
  // output precedence. A released input alias is not a separate prohibition.
  const pending = evidenceMemberPaths(baseline).filter(path =>
    firstImmutableEvidenceConflict([path], baseline.frozenInputs, projectDir));
  const inspected = new Set<string>();
  const structuralRoots = new Set(baseline.frozenInputs.map(input => input.path));
  for (const member of pending) {
    let path = member;
    while (path && path !== '.') {
      if (!inspected.has(path) && (path !== member || structuralRoots.has(path))) {
        inspected.add(path);
        try {
          const stat = lstatSync(join(projectDir, path));
          if (stat.isDirectory() || stat.isSymbolicLink()) baseline.frozenTopology.add(path);
          if (stat.isSymbolicLink()) {
            const target = normalizedProjectContentPath(relative(projectDir,
              resolve(projectDir, dirname(path), readlinkSync(join(projectDir, path)))));
            if (target && !inspected.has(target)) { structuralRoots.add(target); pending.push(target); }
          }
        } catch { /* capture below retains observed absence or inspection failure */ }
      }
      path = dirname(path);
    }
  }
  for (const path of evidenceMemberPaths(baseline)) {
    const image = readRepairFileImage(projectDir, path, indexEntries.get(path), { contentStore });
    if (image.inspectionFailure || image.materializationFailure || image.provenance === 'unknown') {
      throw new Error(`IMMUTABLE_EVIDENCE_UNAVAILABLE: ${path}`);
    }
    image.restorationParent = canonicalPotentialProjectPath(projectDir, dirname(path));
    baseline.frozenImages.set(path, image);
    images.set(path, image);
  }
  try {
    baseline.watcher = watch(projectDir, { recursive: true, persistent: false }, (_event, name) => {
      if (!name) {
        baseline.reliable = false;
        return;
      }
      const path = normalizedProjectContentPath(name.toString());
      if (!path) return;
      const gitlink = trackedGitlinkAncestor(baseline, path);
      noteRollbackPath(baseline, path);
      if (gitlink) return;
      try {
        if (lstatSync(join(projectDir, path)).isDirectory()) {
          for (const nested of listProjectFilesAt(projectDir, path)) noteRollbackPath(baseline, nested);
        }
      } catch {
        // A recursive directory deletion may coalesce to a parent event. Expand
        // that event through the run-start inventory so every lost child gets
        // its own restorable candidate.
        const prefix = `${path.replace(/\/$/, '')}/`;
        for (const known of new Set([...baseline.cleanTracked, ...baseline.images.keys()])) {
          if (known.startsWith(prefix)) noteRollbackPath(baseline, known);
        }
      }
    });
    baseline.watcher.on('error', () => { baseline.reliable = false; });
  } catch {
    baseline.reliable = false;
  }
  rollbackBaselines.set(key, baseline);
  return baseline;
}

export function ensureRollbackBaseline(projectDir: string, runDirPath?: string): { baseline: RunRollbackBaseline; initialized: boolean } {
  const key = rollbackBaselineKey(projectDir, runDirPath);
  const existing = rollbackBaselines.get(key);
  if (existing) return { baseline: existing, initialized: false };
  return { baseline: createRollbackBaseline(projectDir, runDirPath), initialized: true };
}

function imageFromGitBaseline(baseline: RunRollbackBaseline, path: string): RepairFileImage {
  if (!baseline.gitRoot || !baseline.cleanTracked.has(path)) return { exists: false, provenance: 'unknown' };
  const entries = baseline.gitIndexEntries.get(path);
  const entry = stageZeroIndexEntry(entries);
  if (!entries?.length) {
    const image: RepairFileImage = {
      exists: true,
      type: 'file',
      materializationFailure: `Git index preimage metadata is unavailable for ${path}`,
    };
    baseline.images.set(path, image);
    return image;
  }
  if (!entry) {
    const image = readRepairFileImage(baseline.projectDir, path, entries);
    if (!image.indexEntryKind) image.indexEntryKind = 'unmerged';
    baseline.images.set(path, image);
    return image;
  }
  if (entry.kind === 'gitlink') {
    const image = readRepairFileImage(baseline.projectDir, path, entries);
    baseline.images.set(path, image);
    return image;
  }
  if (entry.kind === 'sparse_tree' || entry.kind === 'unknown') {
    const image: RepairFileImage = {
      exists: true,
      type: entry.kind === 'sparse_tree' ? 'sparse_tree' : 'file',
      indexEntryKind: entry.kind,
      gitObjectId: entry.objectId,
      materializationFailure: `Git index kind ${entry.kind} cannot be materialized as a file preimage for ${path}`,
    };
    baseline.images.set(path, image);
    return image;
  }
  const rawMode = Number.parseInt(entry.mode, 8);
  const symlink = entry.kind === 'symlink';
  if (!symlink) {
    const statIdentity = baseline.lazyGitTracked.get(path);
    if (statIdentity) {
      const image: RepairFileImage = {
        exists: true, type: 'file', indexEntryKind: entry.kind,
        gitObjectId: entry.objectId, byteLength: Number(statIdentity.size),
        statIdentity,
        mode: Number.isFinite(rawMode) && (rawMode & 0o111) ? 0o755 : 0o644,
      };
      baseline.images.set(path, image);
      return image;
    }
  }
  try {
    const bytes = execFileSync('git', ['cat-file', 'blob', entry.objectId], {
      cwd: baseline.projectDir, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000, maxBuffer: 64 * 1024 * 1024,
    });
    let text: string | undefined;
    if (!bytes.includes(0)) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* binary */ }
    }
    const image: RepairFileImage = {
      exists: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
      binary: text === undefined,
      ...(symlink || text === undefined ? { bytes } : {}),
      ...(text === undefined ? {} : { text }),
      ...(symlink ? { symlink: true, type: 'symlink' as const } : { type: 'file' as const }),
      indexEntryKind: entry.kind,
      mode: symlink ? 0o777 : (Number.isFinite(rawMode) && (rawMode & 0o111) ? 0o755 : 0o644),
    };
    baseline.images.set(path, image);
    return image;
  } catch (error) {
    const image: RepairFileImage = {
      exists: true,
      type: symlink ? 'symlink' : 'file',
      indexEntryKind: entry.kind,
      mode: symlink ? 0o777 : (Number.isFinite(rawMode) && (rawMode & 0o111) ? 0o755 : 0o644),
      gitObjectId: entry.objectId,
      materializationFailure: `could not materialize Git preimage for ${path}: ${describeRepairError(error)}`,
    };
    baseline.images.set(path, image);
    return image;
  }
}

export function baselineImage(baseline: RunRollbackBaseline, path: string): RepairFileImage {
  const captured = baseline.images.get(path);
  if (captured) return captured;
  if (baseline.cleanTracked.has(path)) return imageFromGitBaseline(baseline, path);
  // A leaf inventory never proves absence below an existing alias.
  let parent = path;
  while (parent.includes('/')) {
    parent = parent.slice(0, parent.lastIndexOf('/'));
    const ancestor = baseline.images.get(parent);
    if (ancestor?.type === 'symlink' || ancestor?.provenance === 'unknown'
      || stageZeroIndexEntry(baseline.gitIndexEntries.get(parent))?.kind === 'symlink') return { exists: false, provenance: 'unknown' };
  }
  // Cache/engine trees are omitted. A miss there is unknown existence. Both
  // baseline strategies enumerate the complete project tree, so a missing
  // entry positively proves that the path did not exist when the run began.
  if (!normalizedProjectContentPath(path) || ignoredProjectPaths(baseline.projectDir, [path]).has(path)) {
    return { exists: false, provenance: 'unknown' };
  }
  return { exists: false, provenance: 'observed' };
}

export function readRollbackCurrentImage(
  baseline: RunRollbackBaseline,
  projectDir: string,
  path: string,
  before?: RepairFileImage,
): RepairFileImage {
  const identity = rollbackStatIdentity(join(projectDir, path));
  const unchanged = unchangedRollbackFileImage(before, identity);
  if (unchanged) return unchanged;
  const image = readRepairFileImage(projectDir, path, baseline.gitIndexEntries.get(path));
  if (before?.gitObjectId && image.type === 'file') image.gitObjectId = gitObjectIdForPath(projectDir, join(projectDir, path));
  return image;
}

export function captureRollbackCurrentImage(
  baseline: RunRollbackBaseline,
  projectDir: string,
  path: string,
  before?: RepairFileImage,
): RepairFileImage {
  const identity = rollbackStatIdentity(join(projectDir, path));
  if (before && rollbackStatIdentitiesEqual(before.statIdentity, identity)) return before;
  const image = repairFileIdentity(readRepairFileImage(projectDir, path, baseline.gitIndexEntries.get(path)));
  // Earlier rounds retain their own identity when a writer sees different bytes.
  if (before && before.sha256 === image.sha256 && before.exists === image.exists) {
    baseline.images.set(path, image);
  }
  return image;
}

export function settleRollbackBaselinePath(baseline: RunRollbackBaseline, projectDir: string, path: string): void {
  const before = baseline.images.get(path);
  // Settlement admits this identity; only task-frozen bytes need restoration.
  const image = captureRollbackCurrentImage(baseline, projectDir, path, before);
  baseline.images.set(path, image);
  baseline.cleanTracked.delete(path);
  baseline.gitIndexEntries.delete(path);
}

/** Commit a scheduler-owned project artifact into the run rollback baseline. */
export function settleFrameworkRollbackPath(projectDir: string, runDirPath: string, path: string): void {
  const baseline = rollbackBaselines.get(rollbackBaselineKey(projectDir, runDirPath));
  if (baseline) settleRollbackBaselinePath(baseline, projectDir, path);
}

export function closeRollbackBaseline(projectDir: string, runDirPath?: string): void {
  const key = rollbackBaselineKey(projectDir, runDirPath);
  const baseline = rollbackBaselines.get(key);
  baseline?.watcher?.close();
  baseline?.contentStore.cleanup();
  rollbackBaselines.delete(key);
}

function unchangedRollbackFileImage(
  before: RepairFileImage | undefined,
  identity: RollbackStatIdentity | undefined,
): RepairFileImage | undefined {
  if (before?.type === 'file' && (before.sha256 !== undefined || before.gitObjectId !== undefined)
      && rollbackStatIdentitiesEqual(before.statIdentity, identity)) {
    return {
      exists: true,
      type: 'file',
      sha256: before.sha256,
      gitObjectId: before.gitObjectId,
      byteLength: before.byteLength,
      binary: before.binary,
      mode: Number(BigInt(identity!.mode) & 0o7777n),
      statIdentity: identity,
      ...(before.indexEntryKind ? { indexEntryKind: before.indexEntryKind } : {}),
    };
  }
  return undefined;
}

/** Canonical frozen members are always nominated, independent of Git ignore or
 * the project watcher. Newly appearing members retain an explicit absent image. */
function evidenceMemberPaths(baseline: RunRollbackBaseline): string[] {
  const paths = new Set([...baseline.frozenImages.keys(), ...baseline.frozenTopology]);
  for (const input of baseline.frozenInputs) {
    const canonical = normalizedProjectContentPath(relative(baseline.projectDir, input.resolvedPath));
    if (!canonical) throw new Error(`IMMUTABLE_EVIDENCE_UNBOUND: frozen target is outside the project: ${input.path}`);
    if (input.kind === 'tree') {
      paths.add(input.path); paths.add(canonical);
      for (const path of listProjectFilesAt(baseline.projectDir, canonical, false, { complete: true })) paths.add(path);
    } else { paths.add(input.path); paths.add(canonical); }
  }
  return [...paths].sort();
}

export function frozenEvidencePaths(baseline: RunRollbackBaseline): string[] {
  return evidenceMemberPaths(baseline).filter(path => baseline.frozenTopology.has(path)
    || firstImmutableEvidenceConflict([path], baseline.frozenInputs, baseline.projectDir));
}
