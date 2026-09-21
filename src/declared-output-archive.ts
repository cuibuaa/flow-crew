import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import type { BriefOutputDeclaration } from './ship-inputs.js';

export const DECLARED_OUTPUT_MANIFEST = 'declared_outputs_manifest.json';

interface ArchivedMember {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ArchivedDeclaredOutput {
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
  outputs: ArchivedDeclaredOutput[];
}

function normalized(path: string): string | undefined {
  const value = posix.normalize(path.replace(/\\/g, '/').replace(/^\.\//, ''));
  return !value || value === '.' || value === '..' || value.startsWith('../') || isAbsolute(value)
    ? undefined
    : value;
}

function memberRecord(path: string, bytes: Buffer): ArchivedMember {
  return { path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function digestMembers(members: readonly ArchivedMember[]): string {
  const hash = createHash('sha256');
  for (const member of members) hash.update(`${member.path}\0${member.bytes}\0${member.sha256}\n`);
  return hash.digest('hex');
}

function archiveOne(projectDir: string, archiveBase: string, declaration: BriefOutputDeclaration): ArchivedDeclaredOutput {
  const path = normalized(declaration.path);
  if (!path) throw new Error(`declared output is not a project-relative path: ${declaration.path}`);
  const segments = path.split('/');
  let source = resolve(projectDir);
  for (const segment of segments) {
    source = join(source, segment);
    const component = lstatSync(source);
    if (component.isSymbolicLink()) {
      throw new Error(`declared output ${path} has symlink ancestor ${segment}; archival refuses ambiguous targets`);
    }
  }
  const stat = lstatSync(source);
  const actualType = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  if (actualType !== declaration.expectedType) {
    throw new Error(`declared output ${path} expected ${declaration.expectedType}, found ${actualType}`);
  }
  const archiveRoot = `declared_outputs/${path}`;
  const destination = join(archiveBase, path);
  const members: ArchivedMember[] = [];
  const visit = (sourcePath: string, destinationPath: string, memberPath: string): void => {
    const current = lstatSync(sourcePath);
    if (current.isSymbolicLink()) throw new Error(`declared output ${path} contains symlink ${memberPath}`);
    if (current.isDirectory()) {
      mkdirSync(destinationPath, { recursive: true });
      for (const name of readdirSync(sourcePath).sort()) visit(
        join(sourcePath, name), join(destinationPath, name), memberPath ? `${memberPath}/${name}` : name,
      );
      return;
    }
    if (!current.isFile()) throw new Error(`declared output ${path} contains unsupported entry ${memberPath}`);
    const bytes = readFileSync(sourcePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
    members.push(memberRecord(memberPath, bytes));
  };
  visit(source, destination, declaration.expectedType === 'file' ? posix.basename(path) : '');
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
    const outputs = unique.map((declaration) => archiveOne(projectDir, join(temporary, 'declared_outputs'), declaration));
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
  exists(path: string): boolean;
  readBytes?(path: string): Uint8Array;
}

/** True only while both the worktree bytes and archived bytes still match the
 * committed manifest. This is the narrow permission `land --remove` needs. */
export function isPathSafelyArchived(
  projectDir: string,
  runDir: string,
  rawPath: string,
  fs: ArchiveReadFileSystem,
): boolean {
  if (!fs.readBytes) return false;
  let manifest: DeclaredOutputArchiveManifest;
  try { manifest = JSON.parse(readFileSync(join(runDir, DECLARED_OUTPUT_MANIFEST), 'utf-8')) as DeclaredOutputArchiveManifest; }
  catch { return false; }
  if (manifest.version !== 1 || manifest.complete !== true || !Array.isArray(manifest.outputs)) return false;
  const path = normalized(rawPath);
  if (!path) return false;
  for (const output of manifest.outputs) {
    const memberPath = output.expectedType === 'file'
      ? (path === output.path ? posix.basename(output.path) : undefined)
      : path.startsWith(`${output.path}/`) ? path.slice(output.path.length + 1) : undefined;
    if (memberPath === undefined) continue;
    const member = output.members.find((entry) => entry.path === memberPath);
    if (!member) return false;
    const projectPath = join(resolve(projectDir), path);
    const archivedPath = output.expectedType === 'file'
      ? join(runDir, output.archiveRoot)
      : join(runDir, output.archiveRoot, memberPath);
    if (!fs.exists(projectPath) || !fs.exists(archivedPath)) return false;
    try {
      const current = Buffer.from(fs.readBytes(projectPath));
      const archived = Buffer.from(fs.readBytes(archivedPath));
      const currentHash = createHash('sha256').update(current).digest('hex');
      const archivedHash = createHash('sha256').update(archived).digest('hex');
      return current.byteLength === member.bytes && archived.byteLength === member.bytes
        && currentHash === member.sha256 && archivedHash === member.sha256;
    } catch { return false; }
  }
  return false;
}
