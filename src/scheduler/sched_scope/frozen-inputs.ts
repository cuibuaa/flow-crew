import { artifactRootContains } from '../../artifact-location.js';
// Hash-only frozen bindings replace the run rollback cache, journal and byte store.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { closeSync, mkdirSync, openSync, renameSync, rmSync, symlinkSync } from '../../engine-fs.js';
import { publishJsonCreateOnly } from '../../canonical-json.js';
import { readContentIdentity, compareContentIdentities, type ContentIdentity } from '../../content-identity.js';
import { gitResultSync, rethrowGitNotAnswered } from '../../git-facts.js';
import { readAdmittedContract } from '../../brief-criteria.js';
import { readAdmittedBriefContract } from '../../ship-inputs.js';
import { runDir } from '../../store.js';
import { readRunSnapshot } from '../../run-lifecycle.js';
import { runRecordPath } from '../../run-layout.js';
import type { StageConfig } from '../sched_admission/configuration.js';
import { normalizedProjectContentPath } from '../sched_admission/scope-services.js';
import { bindImmutableEvidence, canonicalPotentialProjectPath, firstImmutableEvidenceConflict, listProjectFiles, listProjectFilesAt, type ImmutableEvidenceBinding } from './path-capabilities.js';

const absent: ContentIdentity = { state: 'absent' };
export type ContentMembers = Record<string, ContentIdentity>;
interface FrozenInputs {
  version: 1;
  baseCommit?: string;
  bindings: ImmutableEvidenceBinding[];
  members: ContentMembers;
  parents: Record<string, string>;
}
export function isReadOnlyStage(stage: Pick<StageConfig, 'is_gate' | 'decision'>): boolean {
  return stage.is_gate;
}
export function readContentMemberIdentity(path: string, projectDir?: string): ContentIdentity {
  if (projectDir && !artifactRootContains(realpathSync(projectDir), canonicalPotentialProjectPath(projectDir, dirname(relative(projectDir, path))))) {
    return { state: 'unavailable', reason: 'member parent is outside the project' };
  }
  try {
    if (lstatSync(path).isDirectory()) return { state: 'present', type: 'directory', byteLength: 0, sha256: '' };
  } catch { /* readContentIdentity preserves absent versus unavailable */ }
  return readContentIdentity(path);
}
export function projectContentMembers(projectDir: string): ContentMembers {
  return Object.fromEntries(listProjectFiles(projectDir, { complete: true }).map(path => [path, readContentMemberIdentity(join(projectDir, path), projectDir)]));
}
function frozenMembers(projectDir: string, bindings: ImmutableEvidenceBinding[], observedPaths?: string[]): ContentMembers {
  const paths = new Set<string>(observedPaths);
  const topology = new Set<string>();
  for (const binding of bindings) {
    const canonical = normalizedProjectContentPath(relative(realpathSync(projectDir), binding.resolvedPath));
    if (!canonical) throw new Error(`IMMUTABLE_EVIDENCE_UNBOUND: ${binding.path}`);
    for (const root of new Set([binding.path, canonical])) {
      paths.add(root);
      if (binding.kind === 'tree' && artifactRootContains(realpathSync(projectDir), canonicalPotentialProjectPath(projectDir, root))) for (const path of listProjectFilesAt(projectDir, root, false, { complete: true })) paths.add(path);
      // Ancestors are topology, not payload. A replaced ancestor must not redirect a restore.
      for (let parent = dirname(root); parent !== '.'; parent = dirname(parent)) paths.add(parent);
    }
  }
  if (!observedPaths) {
    const pending = [...paths];
    for (let index = 0; index < pending.length; index++) {
      const path = pending[index];
      try {
        if (!lstatSync(join(projectDir, path)).isSymbolicLink()) continue;
        const target = normalizedProjectContentPath(relative(realpathSync(projectDir), resolve(projectDir, dirname(path), readlinkSync(join(projectDir, path)))));
        if (!target) throw new Error(`IMMUTABLE_EVIDENCE_UNBOUND: ${path}`);
        if (!paths.has(target)) { paths.add(target); topology.add(target); pending.push(target); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      }
    }
  }
  return Object.fromEntries([...paths].sort().filter(path => observedPaths?.includes(path) || topology.has(path) ||
    firstImmutableEvidenceConflict([path], bindings, projectDir)
      || bindings.some(binding => binding.path.startsWith(`${path}/`)))
    .map(path => [path, readContentMemberIdentity(join(projectDir, path), projectDir)]));
}
/** Published before the first child, reused unchanged on retries and restart. */
export function bindFrozenInputs(projectDir: string, directory: string): FrozenInputs {
  const path = runRecordPath(directory, 'frozen_inputs.json');
  const declaration = readAdmittedContract(directory).declaration;
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as FrozenInputs;
  const state = readRunSnapshot(directory) as { baseCommit?: string; stages?: Record<string, { attempts?: unknown[]; startedAt?: string }> };
  const contract = readAdmittedBriefContract(directory);
  const bindings = bindImmutableEvidence(projectDir, contract.inputs, contract.outputs,
    declaration.research?.frozen ?? []);
  if (bindings.length && Object.values(state.stages ?? {}).some(stage => stage.attempts?.length || stage.startedAt)) {
    throw new Error('IMMUTABLE_EVIDENCE_UNAVAILABLE: frozen admission manifest is missing after execution');
  }
  const members = frozenMembers(projectDir, bindings);
  for (const [path, identity] of Object.entries(members)) {
    if (identity.state === 'unavailable') throw new Error(`IMMUTABLE_EVIDENCE_UNAVAILABLE: ${path}`);
  }
  for (const input of contract.inputs.filter(input => input.frozen && input.sha256)) {
    const binding = bindings.find(binding => binding.path === input.path);
    const lexicalIdentity = members[input.path];
    const identity = lexicalIdentity?.state === 'present' && lexicalIdentity.type === 'symlink' && binding
      ? members[relative(realpathSync(projectDir), binding.resolvedPath)] : members[input.path];
    if (identity?.state !== 'present' || identity.sha256 !== input.sha256) throw new Error(`IMMUTABLE_EVIDENCE_DIGEST: ${input.path}`);
  }
  const frozen: FrozenInputs = { version: 1, baseCommit: state.baseCommit, bindings, members,
    parents: Object.fromEntries(Object.keys(members).map(path => [path, canonicalPotentialProjectPath(projectDir, dirname(path))])) };
  publishJsonCreateOnly(path, frozen);
  return frozen;
}
export interface ContentSettlementContext { frozen: FrozenInputs; readOnlyBefore?: ContentMembers }
export function createContentSettlementContext(projectDir: string, stages: StageConfig[], runId: string): ContentSettlementContext {
  return { frozen: bindFrozenInputs(projectDir, runDir(projectDir, runId)),
    ...(stages.some(isReadOnlyStage) ? { readOnlyBefore: projectContentMembers(projectDir) } : {}) };
}
export function changedContentMembers(before: ContentMembers, after: ContentMembers): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(path =>
    compareContentIdentities(before[path] ?? absent, after[path] ?? absent) !== 'equal');
}
export function frozenChanges(projectDir: string, frozen: FrozenInputs): string[] {
  return changedContentMembers(frozen.members, frozenMembers(projectDir, frozen.bindings, Object.keys(frozen.members))).filter(path =>
    frozen.members[path]?.state === 'present' || firstImmutableEvidenceConflict([path], frozen.bindings, projectDir));
}
/** Only a pinned base blob with the admitted digest can replace a frozen leaf.
 * No stage HEAD, index, absence deletion, displaced tree or generic preimage. */
export function restoreFrozenInput(projectDir: string, frozen: FrozenInputs, path: string): string | undefined {
  const identity = frozen.members[path];
  if (!frozen.baseCommit || identity?.state !== 'present' || identity.type === 'directory') return 'no matching pinned Git file';
  let temporary: string | undefined;
  try {
    const parent = canonicalPotentialProjectPath(projectDir, dirname(path));
    if (parent !== frozen.parents[path]) return 'admitted parent identity changed';
    // Canonical binding was confined at admission; parents must still stay in the project.
    if (!normalizedProjectContentPath(relative(realpathSync(projectDir), join(parent, basename(path))))) return 'parent is outside the project';
    const entry = gitResultSync(['ls-tree', '-z', frozen.baseCommit, '--', path], { cwd: projectDir, encoding: 'utf8' });
    const exact = entry.stdout.split('\0').find(line => line.slice(line.indexOf('\t') + 1) === path);
    const match = entry.status === 0 && exact ? /^(100644|100755|120000) blob ([a-f0-9]+)\t/.exec(exact) : null;
    if (!match || (match[1] === '120000') !== (identity.type === 'symlink')) return 'no matching pinned Git file';
    mkdirSync(parent, { recursive: true });
    temporary = join(parent, `.${basename(path)}.frozen-${randomUUID()}`);
    if (identity.type === 'symlink') {
      const blob = gitResultSync(['cat-file', 'blob', match[2]], { cwd: projectDir });
      if (blob.status !== 0 || createHash('sha256').update(blob.stdout).digest('hex') !== identity.sha256) return 'pinned Git content differs from admitted digest';
      symlinkSync(blob.stdout, temporary);
    } else {
      const fd = openSync(temporary, 'wx', match[1] === '100755' ? 0o755 : 0o644);
      let result;
      try { result = gitResultSync(['cat-file', 'blob', match[2]], { cwd: projectDir, stdio: ['ignore', fd, 'pipe'] }); }
      finally { closeSync(fd); }
      if (result.status !== 0 || result.error) return 'pinned Git blob unavailable';
    }
    if (compareContentIdentities(identity, readContentIdentity(temporary)) !== 'equal') return 'pinned Git content differs from admitted digest';
    renameSync(temporary, join(parent, basename(path)));
    return compareContentIdentities(identity, readContentIdentity(join(parent, basename(path)))) === 'equal' ? undefined : 'restored content could not be verified';
  } catch (error) { rethrowGitNotAnswered(error); return String(error); }
  finally { if (temporary) rmSync(temporary, { force: true }); }
}
