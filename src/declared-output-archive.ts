import { hashRollbackFileSync } from './rollback-content-store.js';
import { createHash } from 'node:crypto';
import { atomicWrite, copyFileSync, mkdirSync, renameSync, rmSync, symlinkSync } from './engine-fs.js';
import { lstatSync, readFileSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { externalOutputDirectory, type BriefOutputDeclaration } from './ship-inputs.js';
import { normalizedProjectPath } from './scheduler/sched_admission/scope-services.js';

export const DECLARED_OUTPUT_MANIFEST = 'declared_outputs_manifest.json';

interface ArchivedMember {
  path: string;
  bytes: number;
  sha256: string;
  type?: 'symlink';
}

export interface ArchivedDeclaredOutput {
  external?: false;
  path: string;
  expectedType: 'file' | 'directory';
  archiveRoot: string;
  members: ArchivedMember[];
  digest: string;
}

export interface DeclaredOutputArchiveManifest {
  version: 1;
  archivedAt: string;
  complete: true;
  outputs: Array<ArchivedDeclaredOutput | { path: string; expectedType: 'directory'; external: true }>;
}

function memberRecord(path: string, bytes: Buffer, symlink: boolean): ArchivedMember {
  return { path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), ...(symlink ? { type: 'symlink' as const } : {}) };
}

function digestMembers(members: readonly ArchivedMember[]): string {
  const hash = createHash('sha256');
  for (const member of members) hash.update(`${member.path}\0${member.bytes}\0${member.sha256}${member.type ? `\0${member.type}` : ''}\n`);
  return hash.digest('hex');
}

export function walkDeclaredOutput(source: string, path: string, visit: (source: string, path: string, type: 'file' | 'directory' | 'symlink') => void): void {
  const current = lstatSync(source);
  const type = current.isSymbolicLink() ? 'symlink' : current.isDirectory() ? 'directory' : current.isFile() ? 'file' : undefined;
  if (!type) throw new Error(`declared output contains unsupported entry ${path}`);
  visit(source, path, type);
  if (type === 'directory') {
    for (const name of readdirSync(source).sort()) walkDeclaredOutput(join(source, name), path ? `${path}/${name}` : name, visit);
  }
}

/** The same physical path/type precondition governs gate acceptance and archival. */
export function declaredOutputSource(projectDir: string, declaration: BriefOutputDeclaration): string {
  if (isAbsolute(declaration.path)) {
    const source = externalOutputDirectory(declaration, projectDir);
    if (!lstatSync(source).isDirectory()) throw new Error(`external output is not a directory: ${source}`);
    return source;
  }
  const path = normalizedProjectPath(declaration.path);
  if (!path) throw new Error(`declared output is not a project-relative path: ${declaration.path}`);
  const source = resolve(projectDir, path);
  const stat = statSync(source);
  const actualType = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  if (actualType !== declaration.expectedType) {
    throw new Error(`declared output ${path} expected ${declaration.expectedType}, found ${actualType}`);
  }
  walkDeclaredOutput(source, path, () => {});
  return source;
}

function archiveOne(projectDir: string, archiveBase: string, declaration: BriefOutputDeclaration): ArchivedDeclaredOutput {
  const source = declaredOutputSource(projectDir, declaration);
  const path = normalizedProjectPath(declaration.path)!;
  const archiveRoot = `declared_outputs/${path}`;
  const destination = join(archiveBase, path);
  const members: ArchivedMember[] = [];
  walkDeclaredOutput(source, declaration.expectedType === 'file' ? posix.basename(path) : '', (sourcePath, memberPath, type) => {
    const destinationPath = declaration.expectedType === 'file' ? destination : join(destination, memberPath);
    if (type === 'directory') {
      mkdirSync(destinationPath, { recursive: true });
      return;
    }
    const symlink = type === 'symlink';
    mkdirSync(dirname(destinationPath), { recursive: true });
    if (symlink) {
      const bytes = readlinkSync(sourcePath, { encoding: 'buffer' });
      symlinkSync(bytes, destinationPath);
      members.push(memberRecord(memberPath, bytes, true));
    } else {
      copyFileSync(sourcePath, destinationPath);
      const identity = hashRollbackFileSync(destinationPath);
      members.push({ path: memberPath, bytes: identity.byteLength, sha256: identity.sha256 });
    }
  });
  members.sort((left, right) => left.path.localeCompare(right.path));
  return { path, expectedType: declaration.expectedType, archiveRoot, members, digest: digestMembers(members) };
}

export function archiveDeclaredOutputs(
  projectDir: string,
  runDir: string,
  declarations: readonly BriefOutputDeclaration[],
): DeclaredOutputArchiveManifest {
  const unique = [...new Map(declarations.map((entry) => [entry.path, entry])).values()];
  const temporary = join(runDir, `.declared-outputs-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(temporary, { recursive: true });
    mkdirSync(join(temporary, 'declared_outputs'), { recursive: true });
    const outputs = unique.map((declaration) => {
      if (isAbsolute(declaration.path)) {
        const path = declaredOutputSource(projectDir, declaration);
        return { path, expectedType: 'directory' as const, external: true as const };
      }
      return archiveOne(projectDir, join(temporary, 'declared_outputs'), declaration);
    });
    const finalRoot = join(runDir, 'declared_outputs');
    rmSync(finalRoot, { recursive: true, force: true });
    renameSync(join(temporary, 'declared_outputs'), finalRoot);
    const manifest: DeclaredOutputArchiveManifest = {
      version: 1, archivedAt: new Date().toISOString(), complete: true, outputs,
    };
    // The manifest is the durable evidence index; publish only after the tree is in place.
    atomicWrite(join(runDir, DECLARED_OUTPUT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { durability: 'durable' });
    return manifest;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

interface ArchiveReadFileSystem {
  hashFile?(path: string): { sha256: string; byteLength: number };
}

/** Load one manifest per inspection and index its members. Each predicate call
 * still hashes both current copies; no file identities are cached. */
export function createArchivedPathVerifier(
  projectDir: string,
  runDir: string,
  fs: ArchiveReadFileSystem,
): (rawPath: string) => boolean {
  if (!fs.hashFile) return () => false;
  const indexed = new Map<string, { member: ArchivedMember; archivedPath: string }>();
  try {
    const manifest = JSON.parse(readFileSync(join(runDir, DECLARED_OUTPUT_MANIFEST), 'utf-8')) as DeclaredOutputArchiveManifest;
    if (manifest.version !== 1 || manifest.complete !== true || !Array.isArray(manifest.outputs)) return () => false;
    const files = new Map<string, number>(), directories = new Map<string, number>();
    manifest.outputs.forEach((output, index) => {
      if (output.external) return;
      if (normalizedProjectPath(output.path) !== output.path || normalizedProjectPath(output.archiveRoot) !== output.archiveRoot
        || !['file', 'directory'].includes(output.expectedType) || !Array.isArray(output.members)) throw new Error('invalid archived output');
      const scopes = output.expectedType === 'file' ? files : directories;
      if (!scopes.has(output.path)) scopes.set(output.path, index);
    });
    // Earlier declarations own their whole scope, including missing members.
    // Looking up ancestors preserves that rule without scanning every output.
    const firstOutput = (path: string): number => {
      let first = files.get(path) ?? Infinity;
      for (let parent = path; parent !== '.'; parent = posix.dirname(parent)) {
        first = Math.min(first, directories.get(parent) ?? Infinity);
      }
      return first;
    };
    manifest.outputs.forEach((output, index) => {
      if (output.external) return;
      for (const member of output.members) {
        if (typeof member.path !== 'string' || !Number.isSafeInteger(member.bytes) || member.bytes < 0
          || typeof member.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(member.sha256)
          || (member.type !== undefined && member.type !== 'symlink')) throw new Error('invalid archived member');
        const path = output.expectedType === 'file' ? output.path : member.path ? `${output.path}/${member.path}` : output.path;
        if (output.expectedType === 'file' && member.path !== posix.basename(output.path)) continue;
        if (normalizedProjectPath(path) !== path || firstOutput(path) !== index || indexed.has(path)) continue;
        indexed.set(path, { member, archivedPath: output.expectedType === 'file'
          ? join(runDir, output.archiveRoot) : join(runDir, output.archiveRoot, member.path) });
      }
    });
  } catch { return () => false; }
  return (rawPath: string): boolean => {
    const path = normalizedProjectPath(rawPath);
    const archived = path ? indexed.get(path) : undefined;
    if (!path || !archived) return false;
    const { member, archivedPath } = archived;
    const projectPath = join(resolve(projectDir), path);
    try {
      const symlink = member.type === 'symlink';
      if (lstatSync(projectPath).isSymbolicLink() !== symlink || lstatSync(archivedPath).isSymbolicLink() !== symlink) return false;
      const identity = (path: string) => symlink
        ? (() => {
            const bytes = readlinkSync(path, { encoding: 'buffer' });
            return { byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
          })()
        : fs.hashFile!(path);
      const current = identity(projectPath), archived = identity(archivedPath);
      return current.byteLength === member.bytes && archived.byteLength === member.bytes
        && current.sha256 === member.sha256 && archived.sha256 === member.sha256;
    } catch { return false; }
  };
}
