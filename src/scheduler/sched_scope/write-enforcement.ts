import { join } from 'node:path';
import { compareContentIdentities, readContentIdentity } from '../../content-identity.js';
import { normalizedProjectContentPath } from '../sched_admission/scope-services.js';
// Settlement checks the admitted frozen content and detects read-only changes.
import { type ContentSettlementContext, changedContentMembers, frozenChanges, projectContentMembers, readContentMemberIdentity, restoreFrozenInput } from './frozen-inputs.js';

export function settleProjectWrites(input: {
  projectDir: string;
  context: ContentSettlementContext;
  rawWrites: string[];
  appliedWrites: string[] | null;
  readOnly?: boolean;
}) {
  const rawWrites = input.rawWrites.filter(path => normalizedProjectContentPath(path) !== undefined), rolledBackWrites: string[] = [], rollbackFailures: string[] = [];
  const rollbackFailureReasons: Record<string, string> = {};
  const violations: Array<{ path: string; certainty: 'definite' | 'unverified'; kind: 'immutable_evidence_violation' | 'read_only_project_violation'; reason: string }> = [];
  const frozen = frozenChanges(input.projectDir, input.context.frozen);
  const readOnlyAfter = input.readOnly ? projectContentMembers(input.projectDir) : {};
  const readOnly = input.readOnly && input.context.readOnlyBefore
    ? changedContentMembers(input.context.readOnlyBefore, readOnlyAfter) : [];
  for (const path of new Set([...frozen, ...readOnly])) {
    if (!rawWrites.includes(path)) rawWrites.push(path);
    const taskFrozen = frozen.includes(path);
    const before = taskFrozen ? input.context.frozen.members[path] : input.context.readOnlyBefore?.[path];
    const after = taskFrozen ? readContentMemberIdentity(join(input.projectDir, path), input.projectDir) : readOnlyAfter[path];
    violations.push({ path, certainty: before?.state === 'unavailable' || after?.state === 'unavailable' ? 'unverified' : 'definite', kind: taskFrozen ? 'immutable_evidence_violation' : 'read_only_project_violation',
      reason: taskFrozen ? 'task-frozen evidence content changed or cannot be verified' : 'read-only project content changed or cannot be verified' });
    // Read-only settlement never restores, including when the changed path is frozen.
    if (taskFrozen && readOnly.includes(path)) violations.push({ path, certainty: violations.at(-1)!.certainty,
      kind: 'read_only_project_violation', reason: 'read-only project content changed or cannot be verified' });
    if (!taskFrozen) continue;
    if (input.readOnly) {
      rollbackFailures.push(path); rollbackFailureReasons[path] = 'read-only settlement does not restore project content';
      continue;
    }
    const admitted = input.context.frozen.members[path];
    if (admitted && compareContentIdentities(admitted, readContentIdentity(join(input.projectDir, path))) === 'equal') continue;
    const failure = restoreFrozenInput(input.projectDir, input.context.frozen, path);
    if (failure === undefined) rolledBackWrites.push(path);
    else { rollbackFailures.push(path); rollbackFailureReasons[path] = failure; }
  }
  return { rawWrites, appliedWrites: input.appliedWrites?.filter(path => normalizedProjectContentPath(path) !== undefined && !rolledBackWrites.includes(path)) ?? null,
    rolledBackWrites, rollbackFailures, rollbackFailureReasons, violations };
}
