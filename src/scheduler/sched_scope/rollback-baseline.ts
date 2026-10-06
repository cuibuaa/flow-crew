// Boundary: Own one run-scoped lazy Git/disk preimage cache, watcher journal, current-image nomination, committed writes and lifecycle cleanup.
import { type LiveConstraintGitIndexEntry, parseLiveConstraintGitIndexEntries } from "../../live-constraint-guard.js";
import { RollbackContentStore, type RollbackStatIdentity, rollbackStatIdentity, rollbackStatIdentitiesEqual, hashRollbackFileCooperatively } from "../../rollback-content-store.js";
import { normalizedProjectPath } from "../sched_admission/scope-services.js";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { appendFileSync, lstatSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { type RepairFileFingerprint, type RepairFileImage, stageZeroIndexEntry, readRepairFileImage, repairFileFingerprint, repairFileImageBytes, describeRepairError, gitObjectIdForPath } from './file-images.js';
import { REPAIR_DIFF_SKIP_DIRS, listProjectFiles, listProjectFilesAt } from './path-capabilities.js';

export interface RunRollbackBaseline {
  key: string;
  projectDir: string;
  runDirPath?: string;
  contentStore: RollbackContentStore;
  images: Map<string, RepairFileImage>;
  fingerprints: Map<string, RepairFileFingerprint>;
  cleanTracked: Set<string>;
  lazyGitTracked: Map<string, RollbackStatIdentity>;
  /** Immutable Git-index membership. Unlike cleanTracked, authorized writes never remove this proof. */
  trackedPaths: Set<string>;
  gitIndexEntries: Map<string, LiveConstraintGitIndexEntry[]>;
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

export const rollbackBaselines = new Map<string, RunRollbackBaseline>();

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
  return nulPaths(output).filter((path) => !path.split('/').some((part) => REPAIR_DIFF_SKIP_DIRS.has(part)));
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
  return `${resolve(projectDir)}\u0000${runDirPath ? resolve(runDirPath) : '__standalone__'}`;
}

function noteRollbackPath(baseline: RunRollbackBaseline, rawPath: string): void {
  const observedPath = normalizedProjectPath(rawPath);
  if (!observedPath || observedPath.split('/').some((part) => REPAIR_DIFF_SKIP_DIRS.has(part))) return;
  const path = trackedGitlinkAncestor(baseline, observedPath) ?? observedPath;
  baseline.journalSequence++;
  baseline.journal.set(path, baseline.journalSequence);
  if (baseline.runDirPath) {
    try {
      appendFileSync(join(baseline.runDirPath, 'rollback_change_journal.jsonl'), `${JSON.stringify({
        version: 1, sequence: baseline.journalSequence, path, observedAt: new Date().toISOString(),
      })}\n`, 'utf-8');
    } catch { /* in-memory journal remains authoritative for this scheduler */ }
  }
}

function createRollbackBaseline(projectDir: string, runDirPath?: string): RunRollbackBaseline {
  const key = rollbackBaselineKey(projectDir, runDirPath);
  const contentStore = new RollbackContentStore(runDirPath);
  const images = new Map<string, RepairFileImage>();
  const fingerprints = new Map<string, RepairFileFingerprint>();
  const cleanTracked = new Set<string>();
  const lazyGitTracked = new Map<string, RollbackStatIdentity>();
  const trackedPaths = new Set<string>();
  const indexEntries = new Map<string, LiveConstraintGitIndexEntry[]>();
  let filesEnumerated = 0;
  let filesRead = 0;
  let filesHashed = 0;
  let bytesRead = 0;
  let bytesHashed = 0;
  let strategy: RunRollbackBaseline['initialization']['strategy'] = 'filesystem-images';
  let gitRoot: string | undefined;
  const captureBaselineImage = (path: string, entries?: readonly LiveConstraintGitIndexEntry[]): void => {
    const image = readRepairFileImage(projectDir, path, entries, { contentStore });
    images.set(path, image);
    const fingerprint = repairFileFingerprint(image);
    if (fingerprint) fingerprints.set(path, fingerprint);
    filesRead++;
    bytesRead += repairFileImageBytes(image);
    if (image.exists) {
      filesHashed++;
      bytesHashed += repairFileImageBytes(image);
    }
  };
  try {
    gitRoot = gitOutput(projectDir, ['rev-parse', '--show-toplevel']).trim();
    const trackedEntries = parseLiveConstraintGitIndexEntries(gitOutput(projectDir, ['ls-files', '-s', '-z', '--cached', '--', '.']));
    for (const path of trackedEntries.keys()) trackedPaths.add(path);
    const tracked = new Set(trackedEntries.keys());
    for (const [path, entries] of trackedEntries) indexEntries.set(path, entries);
    const dirty = new Set([
      // Every tracked path remains guardable even when it lives below a cache
      // directory. Preserve a dirty run-start preimage instead of restoring
      // such a path to the index blob.
      ...nulPaths(gitOutput(projectDir, ['diff', '--name-only', '-z', 'HEAD', '--', '.'])),
      // Git deliberately hides assume-unchanged and skip-worktree paths from
      // ordinary diff. Snapshot their live bytes even if the index object is
      // unchanged, since the worktree can still contain an operator preimage.
      ...gitOutput(projectDir, ['ls-files', '-v', '-z', '--cached', '--', '.'])
        .split('\0')
        .filter((entry) => entry.length > 2 && entry[1] === ' ' && entry[0] !== 'H')
        .map((entry) => entry.slice(2).replace(/\\/g, '/')),
      ...rollbackListedPaths(gitOutput(projectDir, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.'])),
      // Ignored files are still pre-existing operator data. Image them once so
      // an out-of-scope write restores their run-start bytes rather than
      // mistaking them for newly created disposable paths.
      ...rollbackListedPaths(gitOutput(projectDir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '.'])),
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
  } catch {
    gitRoot = undefined;
    for (const path of listProjectFiles(projectDir)) {
      filesEnumerated++;
      captureBaselineImage(path);
    }
  }
  const baseline: RunRollbackBaseline = {
    key, projectDir, runDirPath, contentStore, images, fingerprints, cleanTracked, lazyGitTracked, trackedPaths, gitIndexEntries: indexEntries, gitRoot,
    journal: new Map(), journalSequence: 0, reliable: true,
    initialization: { filesEnumerated, filesRead, filesHashed, bytesRead, bytesHashed, strategy },
  };
  try {
    baseline.watcher = watch(projectDir, { recursive: true, persistent: false }, (_event, name) => {
      if (!name) {
        baseline.reliable = false;
        return;
      }
      const path = name.toString().replace(/\\/g, '/');
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
    const fingerprint = repairFileFingerprint(image);
    if (fingerprint) baseline.fingerprints.set(path, fingerprint);
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
    const fingerprint = repairFileFingerprint(image);
    if (fingerprint) baseline.fingerprints.set(path, fingerprint);
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
  // The run-start inventory deliberately omits dependency/cache trees. A miss
  // there is lack of evidence, not evidence of absence. Everywhere else both
  // baseline strategies enumerate the complete project tree, so a missing
  // entry positively proves that the path did not exist when the run began.
  if (path.split('/').some((part) => REPAIR_DIFF_SKIP_DIRS.has(part))) {
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

export async function readRollbackCurrentImageCooperatively(
  baseline: RunRollbackBaseline,
  projectDir: string,
  path: string,
  before: RepairFileImage,
): Promise<RepairFileImage> {
  const absolute = join(projectDir, path);
  const identity = rollbackStatIdentity(absolute);
  const unchanged = unchangedRollbackFileImage(before, identity);
  if (unchanged) return unchanged;
  if (identity?.type !== 'file') return readRollbackCurrentImage(baseline, projectDir, path, before);
  try {
    const hashed = await hashRollbackFileCooperatively(absolute);
    if (hashed.sha256 === before.sha256 && hashed.byteLength === before.byteLength) {
      // Promote only nomination metadata. The immutable preimage identity,
      // mode and backing bytes must remain available for later rollback and
      // attributed metadata-write judgment.
      before.verifiedStatIdentity = hashed.statIdentity;
    }
    return {
      exists: true,
      type: 'file',
      sha256: hashed.sha256,
      ...(before.gitObjectId ? { gitObjectId: gitObjectIdForPath(projectDir, absolute) } : {}),
      byteLength: hashed.byteLength,
      binary: true,
      mode: Number(BigInt(hashed.statIdentity.mode) & 0o7777n),
      statIdentity: hashed.statIdentity,
      ...(before.indexEntryKind ? { indexEntryKind: before.indexEntryKind } : {}),
    };
  } catch (error) {
    return {
      exists: true,
      type: 'file',
      mode: before.mode,
      statIdentity: identity,
      inspectionFailure: `could not hash ${path} cooperatively: ${describeRepairError(error)}`,
      ...(before.indexEntryKind ? { indexEntryKind: before.indexEntryKind } : {}),
    };
  }
}

export function captureRollbackCurrentImage(
  baseline: RunRollbackBaseline,
  projectDir: string,
  path: string,
  before?: RepairFileImage,
): RepairFileImage {
  const identity = rollbackStatIdentity(join(projectDir, path));
  if (before && rollbackStatIdentitiesEqual(before.statIdentity, identity)) return before;
  return readRepairFileImage(
    projectDir,
    path,
    baseline.gitIndexEntries.get(path),
    { contentStore: baseline.contentStore },
  );
}

export function settleRollbackBaselinePath(baseline: RunRollbackBaseline, projectDir: string, path: string): void {
  const image = captureRollbackCurrentImage(baseline, projectDir, path, baseline.images.get(path));
  baseline.images.set(path, image);
  const fingerprint = repairFileFingerprint(image);
  if (fingerprint) baseline.fingerprints.set(path, fingerprint);
  else baseline.fingerprints.delete(path);
  baseline.cleanTracked.delete(path);
  baseline.gitIndexEntries.delete(path);
}

/** Commit a scheduler-owned project artifact into the run rollback baseline. */
export function settleFrameworkRollbackPath(projectDir: string, runDirPath: string, path: string): void {
  const baseline = rollbackBaselines.get(rollbackBaselineKey(projectDir, runDirPath));
  if (baseline) settleRollbackBaselinePath(baseline, projectDir, path);
}

export function closeRollbackBaseline(projectDir: string, runDirPath: string): void {
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
      && rollbackStatIdentitiesEqual(before.verifiedStatIdentity ?? before.statIdentity, identity)) {
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
