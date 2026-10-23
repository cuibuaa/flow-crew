import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { mkdtempSync, rmSync } from './engine-fs.js';
import {
  archiveDeclaredOutputs,
  DECLARED_OUTPUT_MANIFEST,
  createArchivedPathVerifier,
  walkDeclaredOutput,
  type DeclaredOutputArchiveManifest,
} from './declared-output-archive.js';
import { hashRollbackFileSync } from './rollback-content-store.js';
import { within } from './source_services/cli-inputs.js';
import type { BriefOutputDeclaration } from './ship-inputs.js';
import { normalizedProjectPath } from './scheduler/sched_admission/scope-services.js';

const archiveMount = join('/mnt', 'h');
export const DEFAULT_LAND_ARCHIVE_ROOT = join(archiveMount, 'flowcrew-archive', 'fc-runs');

export interface LandArchiveReport {
  directory: string;
  worktreeProofDir: string;
  manifests: string[];
  files: number;
  bytes: number;
}

/** Never traverse an inventory path through a directory symlink. Leaf links
 * remain link objects, as in the existing declared-output archive. */
function declaration(sourceRoot: string, rawPath: string): BriefOutputDeclaration {
  if (rawPath.includes('\\')) throw new Error(`archive path has an ambiguous backslash: ${rawPath}`);
  const path = normalizedProjectPath(rawPath.replace(/\/$/, ''));
  if (!path) {
    throw new Error(`archive path is not source-relative: ${rawPath}`);
  }
  const parts = path.split('/');
  let parent = sourceRoot;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if (lstatSync(parent).isSymbolicLink()) throw new Error(`archive path traverses a symlink: ${rawPath}`);
  }
  const source = join(sourceRoot, path);
  const type = statSync(source);
  if (!type.isFile() && !type.isDirectory()) throw new Error(`unsupported archive entry: ${rawPath}`);
  return { path, expectedType: type.isDirectory() ? 'directory' : 'file', disposition: 'create', source: 'land', line: 0 };
}

function declarations(sourceRoot: string, paths: readonly string[]): BriefOutputDeclaration[] {
  const entries = [...new Map(paths.map(path => {
    const entry = declaration(sourceRoot, path);
    return [entry.path, entry] as const;
  })).values()].sort((a, b) => a.path.localeCompare(b.path));
  const directories = new Set(entries.filter(entry => entry.expectedType === 'directory').map(entry => entry.path));
  return entries.filter(entry => {
    for (let parent = posix.dirname(entry.path); parent !== '.'; parent = posix.dirname(parent)) {
      if (directories.has(parent)) return false;
    }
    return true;
  });
}

interface CensusMember { path: string; bytes: number; type: 'file' | 'symlink' }

function census(root: string, entries: readonly BriefOutputDeclaration[]): CensusMember[] {
  const members: CensusMember[] = [];
  for (const entry of entries) walkDeclaredOutput(join(root, entry.path), entry.path, (source, path, type) => {
    if (type !== 'directory') members.push({ path, bytes: type === 'symlink'
      ? readlinkSync(source, { encoding: 'buffer' }).byteLength : lstatSync(source).size, type });
  });
  return members.sort((a, b) => a.path.localeCompare(b.path));
}

function manifestEntries(proofDir: string): BriefOutputDeclaration[] {
  const manifest = JSON.parse(readFileSync(join(proofDir, DECLARED_OUTPUT_MANIFEST), 'utf8')) as DeclaredOutputArchiveManifest;
  if (manifest.version !== 1 || manifest.complete !== true || !Array.isArray(manifest.outputs)
    || manifest.outputs.some(output => output.external)) throw new Error(`incomplete land archive: ${proofDir}`);
  return manifest.outputs.map(output => ({ path: output.path, expectedType: output.expectedType, disposition: 'create', source: 'land', line: 0 }));
}

function verifySet(sourceRoot: string, proofDir: string, requireAllRoots: boolean): void {
  const expected = manifestEntries(proofDir);
  const current = declarations(sourceRoot, requireAllRoots ? readdirSync(sourceRoot) : expected.map(entry => entry.path));
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error(`land archive source inventory changed: ${sourceRoot}`);
  const manifest = JSON.parse(readFileSync(join(proofDir, DECLARED_OUTPUT_MANIFEST), 'utf8')) as DeclaredOutputArchiveManifest;
  const archived = manifest.outputs.flatMap(output => {
    if (output.external) return [];
    return output.members.map(member => ({
      path: output.expectedType === 'file' ? output.path : member.path ? `${output.path}/${member.path}` : output.path,
      bytes: member.bytes,
      type: member.type === 'symlink' ? 'symlink' as const : 'file' as const,
    }));
  }).sort((a, b) => a.path.localeCompare(b.path));
  const currentMembers = census(sourceRoot, current);
  if (JSON.stringify(currentMembers) !== JSON.stringify(archived)) throw new Error(`land archive source members changed: ${sourceRoot}`);
  for (const output of manifest.outputs) {
    if (output.external) continue;
    for (const member of output.members) {
      const target = output.expectedType === 'file' ? join(proofDir, output.archiveRoot) : join(proofDir, output.archiveRoot, member.path);
      if (!within(realpathSync(proofDir), realpathSync(dirname(target)))) {
        throw new Error(`land archive member resolves outside its archive: ${member.path}`);
      }
    }
  }
  const archivedPath = createArchivedPathVerifier(sourceRoot, proofDir, { hashFile: hashRollbackFileSync });
  for (const member of currentMembers) {
    if (!archivedPath(member.path)) {
      throw new Error(`land archive content verification failed: ${member.path}`);
    }
  }
}

/** Recheck both source inventories and every source/archive hash at the removal
 * gate; a copied report alone is never permission to remove current bytes. */
export function verifyLandArchive(projectDir: string, runDir: string, report: LandArchiveReport): void {
  verifySet(projectDir, report.worktreeProofDir, false);
  verifySet(runDir, join(report.directory, 'run-store'), true);
}

export function archiveLandOutputs(projectDir: string, runDir: string, root: string, worktreePaths: string[]): LandArchiveReport {
  const project = realpathSync(projectDir), run = realpathSync(runDir);
  const destinationRoot = realpathSync(resolve(root));
  if (!statSync(destinationRoot).isDirectory()) throw new Error(`archive root is not a directory: ${root}`);
  if (within(project, destinationRoot) || within(run, destinationRoot)) throw new Error('archive root must be outside the worktree and run store');
  if (resolve(root) === resolve(DEFAULT_LAND_ARCHIVE_ROOT)) {
    const mount = spawnSync('findmnt', ['--mountpoint', archiveMount], { encoding: 'utf8' });
    if (mount.status !== 0 || !within(realpathSync(archiveMount), destinationRoot)) {
      throw new Error(`archive volume is not mounted at ${archiveMount}`);
    }
  }
  const worktree = declarations(project, worktreePaths);
  const runStore = declarations(run, readdirSync(run));
  const members = [...census(project, worktree), ...census(run, runStore)];
  const bytes = members.reduce((sum, member) => sum + member.bytes, 0);
  const capacity = statfsSync(destinationRoot, { bigint: true });
  if (BigInt(bytes) > capacity.bavail * capacity.bsize) throw new Error(`archive volume has insufficient free space for ${bytes} bytes`);
  const directory = mkdtempSync(join(destinationRoot, `${basename(run)}-`));
  const worktreeProofDir = join(directory, 'worktree');
  const runStoreProofDir = join(directory, 'run-store');
  const manifests = [worktreeProofDir, runStoreProofDir].map(path => join(path, DECLARED_OUTPUT_MANIFEST));
  const report = { directory, worktreeProofDir, manifests, files: members.length, bytes };
  try {
    archiveDeclaredOutputs(project, worktreeProofDir, worktree);
    archiveDeclaredOutputs(run, runStoreProofDir, runStore);
    verifyLandArchive(project, run, report);
    return report;
  } catch (error) {
    // Retain any partial copy for diagnosis, but never expose a usable proof.
    for (const manifest of manifests) rmSync(manifest, { force: true });
    throw error;
  }
}
