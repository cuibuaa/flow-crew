// Boundary: Represent exact content and Git-index/file-kind evidence, materialize small images and compare content; use rollback-content-store hashing rather than a second store.
import { type RollbackStatIdentity, RollbackContentStore, hashRollbackFileSync } from "../../rollback-content-store.js";
import { type Stats, readdirSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { normalizedProjectPath } from "../sched_admission/scope-services.js";

export interface RepairFileImage {
  exists: boolean;
  /** Whether absence was observed or merely inferred from an uncaptured path. */
  provenance?: 'observed' | 'unknown';
  sha256?: string;
  byteLength?: number;
  binary?: boolean;
  text?: string;
  /** In-memory rollback bytes; omitted from serialized audit artifacts. */
  bytes?: Buffer;
  /** Scheduler-owned preimage outside the watched project; never serialized. */
  backingPath?: string;
  /** Trusted nomination metadata. Content equality still uses the hash. */
  statIdentity?: RollbackStatIdentity;
  symlink?: boolean;
  type?: 'file' | 'directory' | 'symlink' | 'gitlink' | 'sparse_tree' | 'unmerged';
  /** The index kind stays explicit even when filesystem bytes are readable. */
  indexEntryKind?: GitIndexEntryKind;
  /** Git blob identity proves bytes even when the blob cannot be materialized. */
  gitObjectId?: string;
  /** Exact preimage bytes could not be obtained; never interpret this as absence. */
  materializationFailure?: string;
  /** Existence/content could not be inspected at all. */
  inspectionFailure?: string;
  /** Retained only as restoration metadata; never part of content equality. */
  mode?: number;
  /** Admitted physical parent for frozen restoration; never follow a replacement alias. */
  restorationParent?: string;
}

export function describeRepairError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = 'code' in error && typeof error.code === 'string' ? `${error.code}: ` : '';
  return `${code}${error.message}`;
}

export function stageZeroIndexEntry(entries: readonly GitIndexEntry[] | undefined): GitIndexEntry | undefined {
  return entries?.find((entry) => entry.stage === 0);
}

function indexEntryKind(entries: readonly GitIndexEntry[] | undefined): GitIndexEntryKind | undefined {
  const stageZero = stageZeroIndexEntry(entries);
  if (stageZero) return stageZero.kind;
  return entries?.length ? 'unmerged' : undefined;
}

function readGitlinkFileImage(
  projectDir: string,
  normalized: string,
  entry: GitIndexEntry,
  stat: Stats,
): RepairFileImage {
  const absolute = join(projectDir, normalized);
  if (!stat.isDirectory()) {
    return {
      exists: true,
      type: 'gitlink',
      indexEntryKind: 'gitlink',
      gitObjectId: entry.objectId,
      mode: stat.mode & 0o7777,
      inspectionFailure: `gitlink worktree path ${normalized} is not a directory`,
    };
  }
  let names: string[];
  try { names = readdirSync(absolute).sort(); } catch (error) {
    return {
      exists: true,
      type: 'gitlink',
      indexEntryKind: 'gitlink',
      gitObjectId: entry.objectId,
      mode: stat.mode & 0o7777,
      inspectionFailure: `could not inspect gitlink directory ${normalized}: ${describeRepairError(error)}`,
    };
  }
  if (names.length === 0) {
    const identity = Buffer.from(`gitlink\0${entry.objectId}\0uninitialized-empty-directory`, 'utf-8');
    return {
      exists: true,
      type: 'gitlink',
      indexEntryKind: 'gitlink',
      gitObjectId: entry.objectId,
      sha256: createHash('sha256').update(identity).digest('hex'),
      byteLength: 0,
      binary: false,
      mode: stat.mode & 0o7777,
    };
  }
  try {
    const head = execFileSync('git', ['-C', absolute, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
    }).trim();
    const status = execFileSync('git', ['-C', absolute, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const identity = Buffer.concat([
      Buffer.from(`gitlink\0${entry.objectId}\0${head}\0`, 'utf-8'),
      status,
    ]);
    return {
      exists: true,
      type: 'gitlink',
      indexEntryKind: 'gitlink',
      gitObjectId: entry.objectId,
      sha256: createHash('sha256').update(identity).digest('hex'),
      byteLength: identity.byteLength,
      binary: true,
      mode: stat.mode & 0o7777,
    };
  } catch (error) {
    return {
      exists: true,
      type: 'gitlink',
      indexEntryKind: 'gitlink',
      gitObjectId: entry.objectId,
      mode: stat.mode & 0o7777,
      inspectionFailure: `gitlink worktree representation is unavailable for ${normalized}: ${describeRepairError(error)}`,
    };
  }
}

export function readRepairFileImage(
  projectDir: string,
  relativePath: string,
  indexEntries?: readonly GitIndexEntry[],
  options: { contentStore?: RollbackContentStore } = {},
): RepairFileImage {
  const normalized = normalizedProjectPath(relativePath);
  if (!normalized) return { exists: false, provenance: 'unknown' };
  const absolute = join(projectDir, normalized);
  const kind = indexEntryKind(indexEntries);
  const stageZero = stageZeroIndexEntry(indexEntries);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { exists: false, provenance: 'observed', ...(kind ? { indexEntryKind: kind } : {}) }
      : { exists: false, provenance: 'unknown', inspectionFailure: `could not inspect ${normalized}: ${describeRepairError(error)}` };
  }
  if (stageZero?.kind === 'gitlink') return readGitlinkFileImage(projectDir, normalized, stageZero, stat);
  if (stageZero?.kind === 'sparse_tree') {
    return {
      exists: true,
      type: 'sparse_tree',
      indexEntryKind: 'sparse_tree',
      gitObjectId: stageZero.objectId,
      mode: stat.mode & 0o7777,
      inspectionFailure: `sparse index tree ${normalized} has no file-level worktree representation`,
    };
  }
  if (stat.isSymbolicLink()) {
    try {
      const bytes = readlinkSync(absolute, { encoding: 'buffer' });
      let text: string | undefined;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* raw non-UTF8 target */ }
      return {
        exists: true,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
        binary: text === undefined,
        bytes,
        ...(text === undefined ? {} : { text }),
        symlink: true,
        type: 'symlink',
        ...(kind ? { indexEntryKind: kind } : {}),
        mode: stat.mode & 0o7777,
      };
    } catch (error) {
      return {
        exists: true,
        type: 'symlink',
        ...(kind ? { indexEntryKind: kind } : {}),
        mode: stat.mode & 0o7777,
        materializationFailure: `could not read symbolic-link preimage ${normalized}: ${describeRepairError(error)}`,
      };
    }
  }
  if (stat.isDirectory()) return { exists: true, type: 'directory', byteLength: 0,
    sha256: createHash('sha256').update('directory').digest('hex'), mode: stat.mode & 0o7777 };
  if (!stat.isFile()) return { exists: false, provenance: 'unknown', ...(kind ? { indexEntryKind: kind } : {}) };
  try {
    let backingPath: string | undefined;
    const captured = options.contentStore
      ? (() => {
          const result = options.contentStore!.capture(absolute, normalized);
          backingPath = result.backingPath;
          return result;
        })()
      : hashRollbackFileSync(absolute);
    const { sha256, byteLength, statIdentity } = captured;
    // Keep the existing human-readable audit detail for small files. Large
    // rollback content remains only in scheduler-owned disk backing.
    const bytes = byteLength <= 1024 * 1024 ? readFileSync(backingPath ?? absolute) : undefined;
    let text: string | undefined;
    if (bytes && !bytes.includes(0)) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* binary/non-UTF8 */ }
    }
    return {
      exists: true, sha256, byteLength, binary: text === undefined,
      ...(text === undefined ? (bytes ? { bytes } : {}) : { text }),
      ...(backingPath ? { backingPath } : {}), statIdentity,
      type: 'file', mode: stat.mode & 0o7777, ...(kind ? { indexEntryKind: kind } : {}),
    };
  } catch (error) {
    return {
      exists: true,
      type: 'file',
      ...(kind ? { indexEntryKind: kind } : {}),
      mode: stat.mode & 0o7777,
      materializationFailure: `could not read regular-file preimage ${normalized}: ${describeRepairError(error)}`,
    };
  }
}

/** Detection retains no payload for content that has not been admitted writable. */
export function repairFileIdentity(image: RepairFileImage): RepairFileImage {
  const { bytes: _bytes, text: _text, backingPath: _backingPath, ...identity } = image;
  return identity;
}

export function repairFileImageBytes(image: RepairFileImage): number {
  if (!image.exists) return 0;
  if (image.byteLength !== undefined) return image.byteLength;
  if (image.bytes) return image.bytes.byteLength;
  return Buffer.byteLength(image.text ?? '', 'utf-8');
}

type RepairFileContentComparison = 'equal' | 'different' | 'unavailable';

export function repairFileMaterializedBytes(image: RepairFileImage): Buffer | undefined {
  if (!image.exists) return undefined;
  if (image.bytes !== undefined) return image.bytes;
  if (image.text !== undefined) return Buffer.from(image.text, 'utf8');
  return undefined;
}

function gitBlobObjectId(bytes: Buffer, expectedObjectId: string): string | undefined {
  const algorithm = expectedObjectId.length === 40 ? 'sha1'
    : expectedObjectId.length === 64 ? 'sha256'
    : undefined;
  if (!algorithm) return undefined;
  return createHash(algorithm)
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex');
}

export function gitObjectIdForPath(projectDir: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['hash-object', '--no-filters', path], {
      cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
    }).trim();
  } catch { return undefined; }
}

export function compareRepairFileContents(
  before: RepairFileImage,
  after: RepairFileImage,
): RepairFileContentComparison {
  if (before.inspectionFailure || after.inspectionFailure) return 'unavailable';
  // An omitted path has no prior existence fact. Use the same evidence rule
  // as restoration instead of manufacturing an observed absence from a miss.
  if ((!before.exists && before.provenance !== 'observed')
      || (!after.exists && after.provenance !== 'observed')) return 'unavailable';
  if (before.exists !== after.exists) return 'different';
  if (!before.exists) return 'equal';
  if (!before.type || !after.type) return 'unavailable';
  if (before.type !== after.type) return 'different';
  if (before.sha256 !== undefined && after.sha256 !== undefined) {
    return before.sha256 === after.sha256 && before.byteLength === after.byteLength
      ? 'equal'
      : 'different';
  }
  if (before.gitObjectId && after.gitObjectId) {
    return before.gitObjectId === after.gitObjectId ? 'equal' : 'different';
  }
  const beforeBytes = repairFileMaterializedBytes(before);
  const afterBytes = repairFileMaterializedBytes(after);
  if (before.gitObjectId && afterBytes) {
    const actual = gitBlobObjectId(afterBytes, before.gitObjectId);
    return actual === undefined ? 'unavailable' : actual === before.gitObjectId ? 'equal' : 'different';
  }
  if (after.gitObjectId && beforeBytes) {
    const actual = gitBlobObjectId(beforeBytes, after.gitObjectId);
    return actual === undefined ? 'unavailable' : actual === after.gitObjectId ? 'equal' : 'different';
  }
  return 'unavailable';
}

export type GitIndexEntryKind =
  | 'regular'
  | 'executable'
  | 'symlink'
  | 'gitlink'
  | 'sparse_tree'
  | 'unmerged'
  | 'unknown';

export interface GitIndexEntry {
  path: string;
  objectId: string;
  mode: string;
  stage: number;
  kind: GitIndexEntryKind;
}

export function classifyGitIndexEntry(mode: string, stage: number): GitIndexEntryKind {
  if (stage !== 0) return 'unmerged';
  switch (mode) {
    case '100644': return 'regular';
    case '100755': return 'executable';
    case '120000': return 'symlink';
    case '160000': return 'gitlink';
    case '040000': return 'sparse_tree';
    default: return 'unknown';
  }
}

/** Retain every index stage; stage 1/2/3 entries are evidence, not noise. */
export function parseGitIndexEntries(output: string): Map<string, GitIndexEntry[]> {
  const entries = new Map<string, GitIndexEntry[]>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, objectId, rawStage] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1).replace(/\\/g, '/');
    const stage = Number(rawStage);
    if (!mode || !/^[0-7]{6}$/.test(mode) || !/^[0-9a-f]{40,64}$/i.test(objectId ?? '')
        || !Number.isInteger(stage) || stage < 0 || stage > 3 || !path) continue;
    const row: GitIndexEntry = {
      path,
      objectId,
      mode,
      stage,
      kind: classifyGitIndexEntry(mode, stage),
    };
    const prior = entries.get(path) ?? [];
    prior.push(row);
    entries.set(path, prior);
  }
  return entries;
}
