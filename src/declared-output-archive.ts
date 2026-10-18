import { hashRollbackFileSync } from './rollback-content-store.js';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from './engine-fs.js';
import { lstatSync, readFileSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { externalOutputDirectory, type BriefOutputDeclaration } from './ship-inputs.js';

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

function normalized(path: string): string | undefined {
  const value = posix.normalize(path.replace(/\\/g, '/').replace(/^\.\//, ''));
  return !value || value === '.' || value === '..' || value.startsWith('../') || isAbsolute(value)
    ? undefined
    : value;
}

function memberRecord(path: string, bytes: Buffer, symlink: boolean): ArchivedMember {
  return { path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), ...(symlink ? { type: 'symlink' as const } : {}) };
}

function digestMembers(members: readonly ArchivedMember[]): string {
  const hash = createHash('sha256');
  for (const member of members) hash.update(`${member.path}\0${member.bytes}\0${member.sha256}${member.type ? `\0${member.type}` : ''}\n`);
  return hash.digest('hex');
}

function walkDeclaredOutput(source: string, path: string, visit: (source: string, path: string, type: 'file' | 'directory' | 'symlink') => void): void {
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
  const path = normalized(declaration.path);
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
  const path = normalized(declaration.path)!;
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
    const temporaryManifest = join(runDir, `${DECLARED_OUTPUT_MANIFEST}.tmp`);
    mkdirSync(dirname(temporaryManifest), { recursive: true });
    writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    renameSync(temporaryManifest, join(runDir, DECLARED_OUTPUT_MANIFEST));
    return manifest;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

interface ArchiveReadFileSystem {
  hashFile?(path: string): { sha256: string; byteLength: number };
}

/** True only while both the worktree bytes and archived bytes still match the
 * committed manifest. This is the narrow permission `land --remove` needs. */
export function isPathSafelyArchived(
  projectDir: string,
  runDir: string,
  rawPath: string,
  fs: ArchiveReadFileSystem,
): boolean {
  if (!fs.hashFile) return false;
  let manifest: DeclaredOutputArchiveManifest;
  try { manifest = JSON.parse(readFileSync(join(runDir, DECLARED_OUTPUT_MANIFEST), 'utf-8')) as DeclaredOutputArchiveManifest; }
  catch { return false; }
  if (manifest.version !== 1 || manifest.complete !== true || !Array.isArray(manifest.outputs)) return false;
  const path = normalized(rawPath);
  if (!path) return false;
  for (const output of manifest.outputs) {
    if (output.external) continue;
    const memberPath = output.expectedType === 'file'
      ? (path === output.path ? posix.basename(output.path) : undefined)
      : path === output.path ? '' : path.startsWith(`${output.path}/`) ? path.slice(output.path.length + 1) : undefined;
    if (memberPath === undefined) continue;
    const member = output.members.find((entry) => entry.path === memberPath);
    if (!member) return false;
    const projectPath = join(resolve(projectDir), path);
    const archivedPath = output.expectedType === 'file'
      ? join(runDir, output.archiveRoot)
      : join(runDir, output.archiveRoot, memberPath);
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
  }
  return false;
}
