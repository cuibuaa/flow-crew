import { readAdmittedContract } from './brief-criteria.js';
import { BriefDeclarationsSchema, parseBriefDeclarations, type BriefDeclarations } from './brief-declarations.js';
import { hashRollbackFileSync } from './rollback-content-store.js';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fcGlobalDir } from './store.js';
import { containsEngineOwnedGlobalPath, prospectivePhysicalPath, safeEvidencePath } from './engine-owned-carriers.js';
import { gitCommonDirectory } from './project-identity.js';

export interface BriefInputReference {
  path: string;
  line: number;
  /** Only a structured input object with frozen: true grants task freezing. */
  frozen?: boolean;
  type?: 'file' | 'directory';
  sha256?: string;
}

export interface UnresolvedBriefInputDeclaration {
  value: string;
  line: number;
  reason: string;
}

export interface ParsedBriefInputs {
  references: BriefInputReference[];
  unresolvedInputs: UnresolvedBriefInputDeclaration[];
}

export interface VerifiedBriefInput {
  frozen?: boolean;
  path: string;
  line: number;
  resolvedPath: string;
  exists: boolean;
  readable: boolean;
  /** Source/base provenance is populated by ship-setup. Ordinary verification
   * leaves these unset because it checks one concrete project root. */
  sourceExists?: boolean;
  baseRefExists?: boolean;
  checkedLocations?: string[];
}

export interface BriefInputVerification {
  inputs: VerifiedBriefInput[];
  unresolvedInputs: UnresolvedBriefInputDeclaration[];
}

export interface ShipInputStat {
  isDirectory(): boolean;
  isFile?(): boolean;
  isSymbolicLink?(): boolean;
  size?: number;
}

export interface ShipInputFileSystem {
  exists(path: string): boolean;
  readable(path: string): boolean;
  readText(path: string): string;
  readBytes(path: string): Uint8Array;
  hashFile(path: string): { sha256: string; byteLength: number };
  readDirectory(path: string): string[];
  stat(path: string): ShipInputStat;
  lstat?(path: string): ShipInputStat;
  readlink?(path: string): string;
  realpath?(path: string): string;
}

export const nodeShipInputFileSystem: ShipInputFileSystem = {
  exists: existsSync,
  readable: (path) => {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  readText: (path) => readFileSync(path, 'utf-8'),
  readBytes: (path) => readFileSync(path),
  hashFile: hashRollbackFileSync,
  readDirectory: (path) => readdirSync(path),
  stat: (path) => statSync(path),
  lstat: (path) => lstatSync(path),
  readlink: (path) => readlinkSync(path),
  realpath: (path) => realpathSync.native(path),
};

export type BriefOutputDisposition = 'create' | 'update' | 'append' | 'replace' | 'input';

export interface BriefOutputDeclaration {
  path: string;
  line: number;
  source: string;
  disposition: BriefOutputDisposition;
  /** The declared filesystem shape. File is the fail-closed default; only an
   * explicit `type: directory` declaration admits a
   * pre-existing directory. */
  expectedType: 'file' | 'directory';
}

export interface BriefOutputInventoryEntry extends BriefOutputDeclaration {
  resolvedPath: string;
  exists: boolean;
  entryType: 'absent' | 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
  sha256?: string;
  symlinkTarget?: string;
  blocking: boolean;
  reason?: string;
  warning?: string;
}

export interface BriefOutputInventory {
  declarations: BriefOutputDeclaration[];
  entries: BriefOutputInventoryEntry[];
  blocking: BriefOutputInventoryEntry[];
}

function lineForPath(brief: string, path: string): number {
  const index = brief.split(/\r?\n/).findIndex((line) => line.includes(path));
  return index < 0 ? 1 : index + 1;
}

/** All admission/setup readers consume the same strict declaration. */
export function extractDeclaredBriefInputPaths(brief: string): string[] {
  return (parseBriefDeclarations(brief).inputs ?? []).map(input => typeof input === 'string' ? input : input.path);
}

export function parseBriefInputs(brief: string): ParsedBriefInputs {
  try {
    return { references: (parseBriefDeclarations(brief).inputs ?? []).map(entry => {
      const value = typeof entry === 'string' ? { path: entry } : entry;
      return { ...value, line: lineForPath(brief, value.path) };
    }), unresolvedInputs: [] };
  } catch (error) {
    return { references: [], unresolvedInputs: [{ value: 'frontmatter', line: 1, reason: String(error) }] };
  }
}

export const parseDeclaredBriefInputs = parseBriefInputs;

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Verify declared input reachability under one project root. */
function verifyParsedBriefInputs(
  parsed: ParsedBriefInputs,
  projectRoot: string,
  fs: ShipInputFileSystem = nodeShipInputFileSystem,
): BriefInputVerification {
  const root = resolve(projectRoot);
  const unresolvedInputs = [...parsed.unresolvedInputs];
  const inputs = parsed.references.map((reference): VerifiedBriefInput => {
    const lexical = resolve(root, reference.path);
    if (!within(root, lexical)) {
      return {
        ...reference,
        resolvedPath: lexical,
        exists: false,
        readable: false,
      };
    }
    const exists = fs.exists(lexical);
    const readable = exists && fs.readable(lexical);
    let resolvedPath = lexical;
    if (exists && fs.realpath) {
      try {
        resolvedPath = fs.realpath(lexical);
      } catch {
        // Reachability remains explicit below.
      }
    }
    if (readable && (reference.type || reference.sha256)) {
      try {
        // Reuse the existing evidence boundary before reading declared hash bytes.
        if (reference.sha256 && (!within(root, resolvedPath) || !safeEvidencePath(reference.path)
          || !safeEvidencePath(relative(root, resolvedPath)))) throw new Error('inputs.path is outside the evidence boundary');
        const stat = fs.stat(lexical);
        if (reference.type && ((reference.type === 'directory') !== stat.isDirectory()
          || reference.type === 'file' && stat.isFile?.() === false)) {
          throw new Error('inputs.type does not match the declared input shape');
        }
        if (reference.sha256 && (stat.isDirectory() || stat.isFile?.() === false || fs.hashFile(lexical).sha256 !== reference.sha256)) {
          throw new Error('inputs.sha256 does not match the declared input bytes');
        }
      } catch (error) { unresolvedInputs.push({ value: reference.path, line: reference.line, reason: String(error) }); }
    }
    return { ...reference, resolvedPath, exists, readable };
  });
  return {
    inputs,
    unresolvedInputs,
  };
}

/** Verify only the launch-blocking frontmatter input declaration. */
export function verifyDeclaredBriefInputs(
  brief: string,
  projectRoot: string,
  fs: ShipInputFileSystem = nodeShipInputFileSystem,
): BriefInputVerification {
  return verifyParsedBriefInputs(parseDeclaredBriefInputs(brief), projectRoot, fs);
}

/** Only the top-level outputs declaration grants product authority. */
export function extractBriefOutputDeclarations(brief: string): BriefOutputDeclaration[] {
  return outputsFromDeclarations(parseBriefDeclarations(brief), brief);
}

export function outputsFromDeclarations(declarations: BriefDeclarations, brief: string): BriefOutputDeclaration[] {
  const inputs = new Set((declarations.inputs ?? []).map(input => typeof input === 'string' ? input : input.path));
  const outputs: BriefOutputDeclaration[] = (declarations.outputs ?? []).map(entry => {
    const value = typeof entry === 'string' ? { path: entry } : entry;
    return { path: value.path, line: lineForPath(brief, value.path), source: 'outputs',
      disposition: inputs.has(value.path) ? 'input' : value.on_existing ?? 'create',
      expectedType: value.type ?? 'file' };
  });
  return outputs;
}

/** Runtime never interprets a current brief or reconstructs an old contract. */
export function readAdmittedBriefContract(runDir: string, _brief = ''): {
  inputs: BriefInputReference[]; outputs: BriefOutputDeclaration[];
} {
  const { declaration } = readAdmittedContract(runDir);
  return {
    inputs: (declaration.inputs ?? []).map(input => ({ ...(typeof input === 'string' ? { path: input } : input), line: 1 })),
    outputs: outputsFromDeclarations(declaration, ''),
  };
}

/** Absolute output directories are durable capabilities, not project artifacts.
 * Inspect only their pathname components; never enumerate or hash their members. */
export function externalOutputDirectory(
  declaration: BriefOutputDeclaration,
  projectRoot: string,
  fs: ShipInputFileSystem = nodeShipInputFileSystem,
  context: { engineRoot?: string; stateRoot?: string; runDir?: string; inputPaths?: readonly string[] } = {},
): string {
  return validateExternalOutputDirectory(declaration, projectRoot, fs, context);
}

function validateExternalOutputDirectory(
  declaration: BriefOutputDeclaration,
  projectRoot: string,
  fs: ShipInputFileSystem,
  context: NonNullable<Parameters<typeof externalOutputDirectory>[3]>,
  checkProjectOverlap = true,
  gitCommon = gitCommonDirectory(projectRoot),
): string {
  const path = declaration.path;
  const refuse = (reason: string): never => { throw new Error(`EXTERNAL_OUTPUT_REFUSED: ${path}: ${reason}`); };
  if (!isAbsolute(path) || declaration.expectedType !== 'directory'
    || declaration.source !== 'outputs') {
    refuse('declare an absolute path with type: directory in outputs');
  }
  if (!BriefDeclarationsSchema.safeParse({ outputs: [{ path, type: 'directory' }] }).success) {
    refuse('use one literal absolute directory without traversal, templates, or control characters');
  }
  const target = resolve(path);
  if (dirname(target) === '/' || target === '/') refuse('root-level trees cannot be output capabilities');
  if (!fs.lstat) refuse('cannot check pathname components without lstat');
  let cursor = '/';
  for (const part of target.slice(1).split('/')) {
    cursor = join(cursor, part);
    let entry: ShipInputStat;
    try { entry = fs.lstat!(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      refuse(`cannot inspect ${cursor}: ${String(error)}`);
    }
    if (entry!.isSymbolicLink?.()) refuse(`symlinked pathname component ${cursor}`);
    if (!entry!.isDirectory()) refuse(`pathname component is not a directory: ${cursor}`);
  }
  const overlaps = (root: string): boolean => within(root, target) || within(target, root);
  const engineRoot = context.engineRoot ?? resolve(import.meta.dirname, '..');
  const protectedRoots = [
    ...(checkProjectOverlap ? [['project', projectRoot]] : []),
    ['engine root', engineRoot],
    ['engine dist', join(engineRoot, 'dist')],
    ['engine build generations', join(engineRoot, '.cache', 'build-generations')],
    ['FC_HOME/run storage', context.stateRoot ?? fcGlobalDir()],
    ...(context.runDir ? [['run storage', context.runDir]] : []),
    ...['.git', '.fc', '.github', '.codex', '.claude'].map(name => ['project protected path', join(projectRoot, name)]),
    ...(gitCommon ? [['project Git storage', gitCommon]] : []),
    ...(context.inputPaths ?? []).map(path => ['declared input', resolve(projectRoot, path)]),
  ];
  // $HOME holds projects, so only it, its ancestors, and its hidden configuration trees are refused.
  const home = resolve(homedir());
  if (within(target, home)) refuse(`overlaps $HOME: ${home}`);
  if (within(home, target) && relative(home, target).split(sep)[0].startsWith('.')) {
    refuse(`hidden configuration trees under $HOME cannot be output capabilities: ${home}`);
  }
  if (containsEngineOwnedGlobalPath(target, context.stateRoot ?? fcGlobalDir())) refuse('contains an engine database');
  for (const [label, root] of protectedRoots) {
    // Protected paths may themselves be references to external trees.
    const physical = prospectivePhysicalPath(resolve(root), { lstat: fs.lstat!, readlink: path => {
      if (!fs.readlink) refuse(`cannot inspect protected symlink ${path}`);
      return fs.readlink!(path);
    } });
    if (overlaps(resolve(root)) || overlaps(physical)) refuse(`overlaps ${label}: ${root}`);
  }
  return target;
}

/** Inventory declared outputs before setup copies a worktree. A non-empty file
 * or any symlink is closed by default: the brief must explicitly declare how
 * existing content is consumed or updated. */
export function inspectBriefOutputs(
  brief: string,
  projectRoot: string,
  fs: ShipInputFileSystem = nodeShipInputFileSystem,
  context: Parameters<typeof externalOutputDirectory>[3] & {
    /** External capabilities are checked against the launch project. null means
     * source discovery: defer only checkout overlap until the target is known. */
    launchProject?: string | null;
  } = {},
): BriefOutputInventory {
  const root = resolve(projectRoot);
  const declarations = extractBriefOutputDeclarations(brief);
  const entries = declarations.map((declaration): BriefOutputInventoryEntry => {
    const resolvedPath = resolve(root, declaration.path);
    if (isAbsolute(declaration.path)) {
      try {
        const launchProject = resolve(context.launchProject ?? root);
        validateExternalOutputDirectory(declaration, launchProject, fs,
          { ...context, inputPaths: extractDeclaredBriefInputPaths(brief) }, context.launchProject !== null,
          gitCommonDirectory(launchProject) ?? gitCommonDirectory(root));
        const sourceOverlap = context.launchProject === null && [root,
          prospectivePhysicalPath(root, { lstat: fs.lstat!, readlink: path => fs.readlink!(path) }),
        ].some(source => within(source, resolvedPath) || within(resolvedPath, source));
        const exists = fs.exists(resolvedPath);
        return { ...declaration, resolvedPath, exists, entryType: exists ? 'directory' : 'absent', blocking: false,
          ...(context.launchProject === null && sourceOverlap ? {
            warning: `Overlaps source checkout: ${root}; acceptable only for a worktree launch outside this directory; blocks if launched in place. Setup must check the launch project.`,
          } : {}),
          reason: 'External directory write capability; contents are not inventoried or archived' };
      } catch (error) {
        return { ...declaration, resolvedPath, exists: fs.exists(resolvedPath), entryType: 'other', blocking: true,
          reason: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!within(root, resolvedPath)) {
      return { ...declaration, resolvedPath, exists: false, entryType: 'other', blocking: true, reason: 'Declared output escapes the project root' };
    }
    let stat: ShipInputStat | undefined;
    try { stat = fs.lstat ? fs.lstat(resolvedPath) : fs.exists(resolvedPath) ? fs.stat(resolvedPath) : undefined; } catch { /* absent */ }
    if (!stat) return { ...declaration, resolvedPath, exists: false, entryType: 'absent', blocking: false };
    const symlink = stat.isSymbolicLink?.() === true;
    const entryType: BriefOutputInventoryEntry['entryType'] = symlink
      ? 'symlink'
      : stat.isDirectory() ? 'directory'
        : stat.isFile?.() === true ? 'file' : 'other';
    const size = typeof stat.size === 'number' ? stat.size : undefined;
    const permitted = declaration.disposition !== 'create';
    let aliasReason: string | undefined;
    let existingType = entryType;
    if (symlink) {
      try {
        if (declaration.disposition !== 'replace') {
          const target = fs.stat(resolvedPath);
          existingType = target.isDirectory() ? 'directory' : target.isFile?.() ? 'file' : 'other';
        }
      } catch (error) { aliasReason = error instanceof Error ? error.message : String(error); }
    }
    const shapeMismatch = (declaration.expectedType === 'file' && existingType === 'directory')
      || (declaration.expectedType === 'directory' && existingType === 'file');
    const blocking = (symlink && (!permitted || !!aliasReason))
      || existingType === 'other'
      || shapeMismatch
      || (entryType === 'file' && (size === undefined || size > 0) && !permitted);
    let sha256: string | undefined;
    if (entryType === 'file') {
      try { sha256 = fs.hashFile(resolvedPath).sha256; } catch { /* unreadable is visible through missing digest */ }
    }
    let symlinkTarget: string | undefined;
    if (symlink && fs.readlink) {
      try { symlinkTarget = fs.readlink(resolvedPath); } catch { /* retain type */ }
    }
    return {
      ...declaration,
      resolvedPath,
      exists: true,
      entryType,
      ...(size !== undefined ? { size } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(symlinkTarget ? { symlinkTarget } : {}),
      blocking,
      ...(blocking ? {
        reason: aliasReason ?? (symlink && !permitted
          ? 'Declared output is already occupied by a symlink; replacement is never implicit'
          : shapeMismatch
            ? `Declared ${declaration.expectedType} output is occupied by a ${entryType}`
          : entryType === 'file'
            ? 'Declared create-only output already contains data; add an explicit on_existing disposition or choose a fresh path'
            : 'Declared output is occupied by an unsupported entry type'),
      } : {}),
    };
  });
  return { declarations, entries, blocking: entries.filter((entry) => entry.blocking) };
}
