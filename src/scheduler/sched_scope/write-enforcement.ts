// Settlement alone rejects project content changes, against task-frozen bytes.
import { normalizedProjectPath, normalizedProjectContentPath } from '../sched_admission/scope-services.js';
import { ignoredProjectPaths } from '../../project-identity.js';
import { restoreProjectPath } from './restore.js';
import { compareRepairFileContents } from './file-images.js';
import { type RepairRoundSnapshot } from './snapshots.js';
import { baselineImage, readRollbackCurrentImage, settleRollbackBaselinePath, frozenEvidencePaths } from './rollback-baseline.js';
import { join } from 'node:path';

export function settleProjectWrites(input: {
  projectDir: string;
  snapshot: RepairRoundSnapshot;
  rawWrites: string[];
  definiteWrites: ReadonlySet<string>;
}) {
  const rawWrites = [...new Set(input.rawWrites.map(normalizedProjectContentPath).filter((path): path is string => path !== undefined))];
  const appliedWrites: string[] = [], exemptedWrites: string[] = [], rolledBackWrites: string[] = [];
  const rollbackFailures: string[] = [], durableWrites: string[] = [], unavailableComparisons: string[] = [];
  const rollbackFailureReasons: Record<string, string> = {};
  const retainedReplacements: Record<string, string> = {};
  const violations: Array<{ path: string; certainty: 'definite' | 'unverified'; reason: string }> = [];
  const baseline = input.snapshot.rollbackBaseline;
  const frozenPaths = new Set(frozenEvidencePaths(baseline));
  const ignored = ignoredProjectPaths(input.projectDir, rawWrites);
  const orderedFrozen = [...frozenPaths].sort((left, right) => {
    const topology = (path: string) => ['directory', 'symlink'].includes(baseline.frozenImages.get(path)?.type ?? '');
    return Number(topology(right)) - Number(topology(left))
      || left.split('/').length - right.split('/').length || left.localeCompare(right);
  });
  for (const rawPath of new Set(orderedFrozen.concat(rawWrites))) {
    const path = normalizedProjectPath(rawPath)!;
    const frozen = frozenPaths.has(path);
    const before = frozen ? baseline.frozenImages.get(path) ?? { exists: false, provenance: 'observed' as const }
      : input.snapshot.files.get(path) ?? baselineImage(baseline, path);
    const current = readRollbackCurrentImage(baseline, input.projectDir, path, before);
    const comparison = compareRepairFileContents(before, current);
    if (comparison === 'equal') continue;
    // Directories carry frozen topology, but creating a parent is not a file output.
    if (!frozen && !before.exists && current.exists && current.type === 'directory') continue;
    if (!input.snapshot.files.has(path)) input.snapshot.files.set(path, before);
    if (comparison === 'unavailable') unavailableComparisons.push(path);
    if (frozen) {
      if (!rawWrites.includes(path)) rawWrites.push(path);
      violations.push({ path, certainty: input.definiteWrites.has(path) ? 'definite' : 'unverified',
        reason: comparison === 'unavailable' ? 'task-frozen evidence cannot be verified; preimage remains unknown'
          : 'task-frozen evidence content changed' });
      const restoration = restoreProjectPath(input.projectDir, path, before,
        baseline.runDirPath ? join(baseline.runDirPath, 'rollback-retained') : undefined);
      if (restoration.retainedPath) retainedReplacements[path] = restoration.retainedPath;
      if (restoration.restored) rolledBackWrites.push(path);
      else {
        rollbackFailures.push(path);
        rollbackFailureReasons[path] = restoration.failure ?? `could not restore ${path}`;
      }
      continue;
    }
    if (ignored.has(path)) { exemptedWrites.push(path); continue; }
    if (comparison === 'different') {
      appliedWrites.push(path);
      durableWrites.push(path);
      settleRollbackBaselinePath(baseline, input.projectDir, path);
    }
  }
  return { rawWrites, appliedWrites, exemptedWrites, rolledBackWrites, rollbackFailures,
    rollbackFailureReasons, retainedReplacements, durableWrites, unavailableComparisons, violations };
}
