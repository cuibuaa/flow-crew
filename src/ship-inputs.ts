import { parseBriefFrontmatterDocument, type BriefFrontmatterDocument } from './brief-frontmatter.js';
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
import { containsEngineOwnedGlobalPath, prospectivePhysicalPath } from './engine-owned-carriers.js';
import { gitCommonDirectory } from './project-identity.js';

export interface BriefInputReference {
  path: string;
  line: number;
  /** Only a structured input object with frozen: true grants task freezing. */
  frozen?: boolean;
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
   * explicit directory declaration (for example `report_dir`) admits a
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

const INPUT_KEY = /(?:^|_)(?:input|inputs|required_input|required_inputs|input_manifest|source|sources|dataset|datasets|fixture|fixtures|consume|consumes|read|reads)(?:_|$)/i;
const OUTPUT_KEY = /(?:^|_)(?:output|outputs|deliverable|deliverables|artifact|artifacts|result_file|report|reports|write|writes|writable_paths|terminal_states)(?:_|$)/i;
const ASSERTION_KEY = /^(?:rows?|row_count|files?|file_count|sha_?256|digest|span|time_span|start|end|description|note|type|format|role|name|label|encoding|delimiter|frozen)$/i;


/** Classify metadata without interpreting it as another input path. */
export function briefInputFieldKind(key: string): 'path' | 'annotation' | 'output' {
  if (OUTPUT_KEY.test(key) && !INPUT_KEY.test(key)) return 'output';
  return ASSERTION_KEY.test(key) ? 'annotation' : 'path';
}

interface NormalizedBriefInputPath {
  path?: string;
  reason?: string;
}

function normalizedBriefInputPath(authored: string): NormalizedBriefInputPath {
  if (authored !== authored.trim()) {
    return { reason: 'Explicit input must not contain leading or trailing whitespace' };
  }
  if (/[<>]/.test(authored)) {
    return { reason: 'Explicit input must be one literal project-relative path, not a template' };
  }
  if (/^[`'"([]/.test(authored)
    || /[`'">)\],;:]$/.test(authored)
    || /:\d+(?::\d+)?$/.test(authored)) {
    return { reason: 'Explicit input contains wrapper or trailing punctuation and cannot be rewritten as another path' };
  }
  if (authored.includes('\\')) {
    return { reason: 'Explicit input must use project-relative forward-slash separators' };
  }
  let candidate = authored.replace(/^\.\//, '');
  if (!candidate) return { reason: 'Explicit input is empty' };
  if (candidate.includes('::') || /\s/.test(candidate)) {
    return { reason: 'Explicit input must name one project-relative path without whitespace' };
  }
  if (candidate.startsWith('~') || isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
    return { reason: 'Explicit input must be a project-relative path' };
  }
  if (/^(?:https?|file):\/\//i.test(candidate) || candidate.includes('://')) {
    return { reason: 'Explicit input must be a project-relative path, not a URL' };
  }
  if (/[?*{}[\]]/.test(candidate) || /[$<>]/.test(candidate)) {
    return { reason: 'Explicit input must be one literal project-relative path, not a glob or template' };
  }
  const pathSegments = candidate.split('/');
  if (candidate === '.'
    || pathSegments.some((segment) => segment === '..')
    || pathSegments.slice(1).some((segment) => segment === '.')) {
    return { reason: 'Explicit input must be project-relative and stay within the project root' };
  }
  if (candidate.endsWith('.')) {
    return { reason: 'Explicit input contains trailing punctuation and cannot be rewritten as another path' };
  }
  candidate = candidate.replace(/\/$/, '');
  // Fractions and progress counters are not paths, even though they contain a slash.
  if (candidate.split('/').every((segment) => /^\d+$/.test(segment))) {
    return { reason: 'Explicit input is a numeric fraction or counter, not a path' };
  }
  return { path: candidate };
}


function lineForPath(brief: string, path: string): number {
  const index = brief.split(/\r?\n/).findIndex((line) => line.includes(path));
  return index < 0 ? 1 : index + 1;
}

function yamlInputKeyLine(line: string): { indent: number; value: string } | undefined {
  const match = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
  if (!match || !INPUT_KEY.test(match[2])) return undefined;
  return { indent: match[1].length, value: match[3].trim() };
}

function malformedYamlInputDeclarations(
  yamlText: string,
  error: unknown,
): UnresolvedBriefInputDeclaration[] {
  const lines = yamlText.split(/\r?\n/);
  const declarations: UnresolvedBriefInputDeclaration[] = [];
  const reason = `Explicit input declaration could not be parsed because frontmatter YAML is malformed: ${error instanceof Error ? error.message : String(error)}`;

  for (let index = 0; index < lines.length; index += 1) {
    const key = yamlInputKeyLine(lines[index]);
    if (!key) continue;
    let foundValue = false;
    if (key.value) {
      declarations.push({ value: key.value, line: index + 2, reason });
      foundValue = true;
    }
    for (let nested = index + 1; nested < lines.length; nested += 1) {
      const line = lines[nested];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      if (indent <= key.indent) break;
      const item = /^\s*-\s*(.*)$/.exec(line);
      if (!item) continue;
      declarations.push({ value: item[1].trim() || '<empty>', line: nested + 2, reason });
      foundValue = true;
    }
    if (!foundValue) declarations.push({ value: '<unparsed inputs>', line: index + 2, reason });
  }
  return declarations;
}

function explicitNullInputLocations(yamlText: string): Array<{ value: string; line: number }> {
  const lines = yamlText.split(/\r?\n/);
  const locations: Array<{ value: string; line: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const key = yamlInputKeyLine(lines[index]);
    if (!key) continue;
    if (/^(?:null|~)$/i.test(key.value)) locations.push({ value: key.value, line: index + 2 });
    for (let nested = index + 1; nested < lines.length; nested += 1) {
      const line = lines[nested];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      if (indent <= key.indent) break;
      const item = /^\s*-\s*(.*?)(?:\s+#.*)?$/.exec(line);
      if (item && (!item[1].trim() || /^(?:null|~)$/i.test(item[1].trim()))) {
        locations.push({ value: item[1].trim() || '<empty>', line: nested + 2 });
      }
    }
  }
  return locations;
}

function collectYamlInputs(
  brief: string,
  frontmatter: BriefFrontmatterDocument,
  addReference: (path: string, line: number, frozen?: boolean) => void,
  addUnresolvedInput: (input: UnresolvedBriefInputDeclaration) => void,
): void {
  const yamlText = frontmatter.yaml;
  if (frontmatter.error) {
    for (const declaration of malformedYamlInputDeclarations(yamlText, frontmatter.error)) addUnresolvedInput(declaration);
    return;
  }
  const root = frontmatter.value;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return;
  const nullLocations = explicitNullInputLocations(yamlText);
  let nullLocationIndex = 0;

  const processItem = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) processItem(entry);
      return;
    }
    if (typeof value === 'string') {
      const normalized = normalizedBriefInputPath(value);
      if (normalized.path) addReference(normalized.path, lineForPath(brief, value));
      else addUnresolvedInput({
        value,
        line: lineForPath(brief, value),
        reason: normalized.reason ?? 'Explicit input could not be normalized',
      });
      return;
    }
    if (value === null) {
      const location = nullLocations[nullLocationIndex++] ?? { value: 'null', line: 2 };
      addUnresolvedInput({
        ...location,
        reason: 'Explicit input must be a string path, not a null or empty entry',
      });
      return;
    }
    if (typeof value !== 'object') {
      const authoredValue = String(value);
      addUnresolvedInput({
        value: authoredValue,
        line: lineForPath(brief, authoredValue),
        reason: 'Explicit input must be a string path',
      });
      return;
    }
    const mapping = value as Record<string, unknown>;
    if ('frozen' in mapping && typeof mapping.frozen !== 'boolean') {
      addUnresolvedInput({ value: String(mapping.frozen), line: lineForPath(brief, 'frozen'),
        reason: 'Input frozen must be a YAML boolean (true or false)' });
    }
    const paths: string[] = [];
    for (const [key, entry] of Object.entries(mapping)) {
      const fieldKind = briefInputFieldKind(key);
      if (fieldKind === 'output') continue;
      if (typeof entry === 'string') {
        if (fieldKind === 'path') {
          const normalized = normalizedBriefInputPath(entry);
          if (normalized.path) paths.push(normalized.path);
          else addUnresolvedInput({
            value: entry,
            line: lineForPath(brief, entry),
            reason: normalized.reason ?? 'Explicit input could not be normalized',
          });
        }
      } else if (Array.isArray(entry) && entry.every((item) => typeof item === 'string')) {
        if (fieldKind === 'path') {
          for (const item of entry) {
            const normalized = normalizedBriefInputPath(item);
            if (normalized.path) paths.push(normalized.path);
            else addUnresolvedInput({
              value: item,
              line: lineForPath(brief, item),
              reason: normalized.reason ?? 'Explicit input could not be normalized',
            });
          }
        }
      }
    }
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length === 0) {
      for (const [key, entry] of Object.entries(mapping)) {
        if (!OUTPUT_KEY.test(key) && entry && typeof entry === 'object') processItem(entry);
      }
      return;
    }
    for (const path of uniquePaths) addReference(path, lineForPath(brief, path), mapping.frozen === true);
  };

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (INPUT_KEY.test(key)) processItem(entry);
      else if (!OUTPUT_KEY.test(key)) walk(entry);
    }
  };
  walk(root);
}

/**
 * Return only inputs declared by the leading, top-level `inputs:` block.
 * Body references are not declarations for launch-workspace reachability.
 */
export function extractDeclaredBriefInputPaths(brief: string): string[] {
  const frontmatter = parseBriefFrontmatterDocument(brief);
  if (!frontmatter) return [];
  const root = frontmatter.value;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return [];
  const inputs = (root as Record<string, unknown>).inputs;
  if (inputs === undefined) return [];

  const declared = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const path = normalizedBriefInputPath(value).path;
      if (path) declared.add(path);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!OUTPUT_KEY.test(key) && !ASSERTION_KEY.test(key)) visit(entry);
    }
  };
  visit(inputs);
  return [...declared].sort();
}

/** Parse input references from frontmatter declarations. */
export function parseBriefInputs(brief: string): ParsedBriefInputs {
  const references = new Map<string, BriefInputReference>();
  const unresolvedInputs: UnresolvedBriefInputDeclaration[] = [];
  const seenUnresolvedInputs = new Set<string>();
  const addReference = (
    path: string,
    line: number,
    frozen = false,
  ): void => {
    const existing = references.get(path);
    if (!existing) {
      references.set(path, { path, line, ...(frozen ? { frozen: true } : {}) });
      return;
    }
    if (frozen) existing.frozen = true;
  };
  const addUnresolvedInput = (input: UnresolvedBriefInputDeclaration): void => {
    const key = JSON.stringify([input.value, input.line, input.reason]);
    if (!seenUnresolvedInputs.has(key)) {
      seenUnresolvedInputs.add(key);
      unresolvedInputs.push(input);
    }
  };

  const frontmatter = parseBriefFrontmatterDocument(brief);
  if (frontmatter) collectYamlInputs(
    brief,
    frontmatter,
    addReference,
    addUnresolvedInput,
  );

  return {
    references: [...references.values()].sort((left, right) => left.path.localeCompare(right.path)),
    unresolvedInputs: unresolvedInputs.sort((left, right) => left.line - right.line || left.value.localeCompare(right.value)),
  };
}

/** Parse only the leading frontmatter `inputs:` declaration. */
export function parseDeclaredBriefInputs(brief: string): ParsedBriefInputs {
  const parsed = parseBriefInputs(brief);
  const declared = new Set(extractDeclaredBriefInputPaths(brief));
  return {
    ...parsed,
    references: parsed.references.filter((reference) => declared.has(reference.path)),
  };
}

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
    return { ...reference, resolvedPath, exists, readable };
  });
  return {
    inputs,
    unresolvedInputs: parsed.unresolvedInputs,
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

function outputDisposition(value: unknown): BriefOutputDisposition {
  if (typeof value !== 'string') return 'create';
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'update' || normalized === 'append' || normalized === 'replace') return normalized;
  return 'create';
}

/** Extract output paths and their disposition from frontmatter declarations. */
export function extractBriefOutputDeclarations(brief: string): BriefOutputDeclaration[] {
  const frontmatter = parseBriefFrontmatterDocument(brief);
  if (!frontmatter) return [];
  const parsed = frontmatter.value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const declarations: BriefOutputDeclaration[] = [];
  const add = (
    raw: unknown,
    source: string,
    disposition: BriefOutputDisposition,
    expectedType: BriefOutputDeclaration['expectedType'] = 'file',
  ): void => {
    if (typeof raw !== 'string') return;
    // Keep absolute declarations, including invalid ones, for explicit refusal.
    const normalized = isAbsolute(raw) ? { path: raw } : normalizedBriefInputPath(raw);
    if (!normalized.path) return;
    declarations.push({
      path: normalized.path,
      line: lineForPath(brief, raw),
      source,
      disposition,
      expectedType,
    });
  };
  const collectOutputValue = (
    value: unknown,
    source: string,
    inheritedDisposition: BriefOutputDisposition,
    inheritedType: BriefOutputDeclaration['expectedType'] = 'file',
  ): void => {
    if (typeof value === 'string') {
      add(value, source, inheritedDisposition, inheritedType);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectOutputValue(item, source, inheritedDisposition, inheritedType);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const disposition = outputDisposition(record.on_existing ?? record.onExisting ?? inheritedDisposition);
    const declaredType = typeof (record.type ?? record.kind) === 'string'
      && /^(?:dir|directory)$/i.test(String(record.type ?? record.kind).trim())
      ? 'directory'
      : inheritedType;
    for (const key of ['path', 'file', 'output', 'artifact', 'result_file', 'report_file', 'report_path']) {
      if (key in record) add(record[key], `${source}.${key}`, disposition, declaredType);
    }
    if ('paths' in record) collectOutputValue(record.paths, `${source}.paths`, disposition, declaredType);
  };

  const root = parsed as Record<string, unknown>;
  const walk = (record: Record<string, unknown>, prefix: string): void => {
    const inheritedDisposition = outputDisposition(record.on_existing ?? record.onExisting);
    for (const [key, value] of Object.entries(record)) {
      const source = prefix ? `${prefix}.${key}` : key;
      if (/^(?:result_file|output_file|report_file|report_path|report_dir)$/.test(key)) {
        add(value, source, inheritedDisposition, key === 'report_dir' ? 'directory' : 'file');
        continue;
      }
      if (/^(?:outputs?|deliverables?|artifacts?)$/.test(key)) {
        collectOutputValue(value, source, inheritedDisposition);
        continue;
      }
      if (key === 'terminal_states' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [status, terminal] of Object.entries(value as Record<string, unknown>)) {
          collectOutputValue(terminal, `${source}.${status}`, inheritedDisposition);
        }
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value as Record<string, unknown>, source);
    }
  };
  walk(root, '');

  const explicitInputs = new Set(extractDeclaredBriefInputPaths(brief));
  const deduped = new Map<string, BriefOutputDeclaration>();
  for (const declaration of declarations) {
    const disposition = explicitInputs.has(declaration.path) ? 'input' : declaration.disposition;
    const prior = deduped.get(declaration.path);
    if (!prior || (prior.disposition === 'create' && disposition !== 'create')) {
      deduped.set(declaration.path, { ...declaration, disposition });
    }
  }
  return [...deduped.values()];
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
    || !/^(?:outputs?|deliverables?|artifacts?)(?:\.|$)/.test(declaration.source)) {
    refuse('declare an absolute path with type: directory in outputs');
  }
  const controls = Array.from(path).some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
  if (path !== path.trim() || controls || /[\\$*?{}[\]<>]/.test(path)
    || path.split('/').some(part => part === '.' || part === '..') || path.includes('//')) {
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
