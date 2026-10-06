/** Finite condition validation and ordinary-quiescence coverage; no runtime terminal decision. */
import { parseCondition } from '../../condition.js';
import { STAGE_STATUS } from '../../store.js';
import { EMITTED_RESEARCH_DECISIONS, type StageConfig } from './configuration.js';
import { normalizedProjectPath } from './scope-services.js';

export function researchTerminalConditionExcludesContinue(
  condition: string | undefined,
  declaration: { status: string; path: string },
): boolean {
  if (!condition?.trim()) return false;
  try {
    const parsed = parseCondition(condition);
    if (parsed.stageId !== 'research') return false;
    if (parsed.field === 'decision') {
      if (parsed.op === '!=' && parsed.value === 'continue') return true;
      return parsed.op === '=='
        && typeof parsed.value === 'string'
        && EMITTED_RESEARCH_DECISIONS.has(parsed.value);
    }
    if (parsed.op !== '==' || typeof parsed.value !== 'string') return false;
    if (parsed.field === 'terminalPath') {
      return normalizedProjectPath(parsed.value) === normalizedProjectPath(declaration.path);
    }
    if (parsed.field === 'terminalStatus') return parsed.value === declaration.status;
    return false;
  } catch {
    return false;
  }
}

export function finiteStatusConditionDomainError(
  stageId: string,
  parsed: ReturnType<typeof parseCondition>,
): string | undefined {
  if (parsed.field !== 'status') return undefined;
  const allowed = new Set<string>(Object.values(STAGE_STATUS));
  if (typeof parsed.value === 'string' && allowed.has(parsed.value)) return undefined;
  return `${stageId}.condition: status literal ${JSON.stringify(parsed.value)} cannot occur; expected one of ${[...allowed].join(', ')}`;
}

export interface TerminalConditionCoverageAssessment {
  checked: boolean;
  coversOrdinaryQuiescence?: boolean;
  assignmentsEvaluated: number;
  statusDomains: Record<string, string[]>;
  uncoveredAssignment?: Record<string, string>;
  reason?: string;
}

function statusConditionMatches(
  actual: string,
  condition: ReturnType<typeof parseCondition>,
): boolean {
  if (typeof condition.value !== 'string') return false;
  if (condition.op === '==') return actual === condition.value;
  if (condition.op === '!=') return actual !== condition.value;
  // Runtime numeric comparison converts status strings to NaN, which is false.
  return false;
}

/** Prove that at least one terminal owner is eligible after an otherwise
 * successful DAG settles. Mandatory stages are complete; conditional/repair
 * stages have the two settled possibilities complete and skipped. Conditions
 * over non-status evidence are left to their owning subsystem rather than
 * guessed into a refusal. */
export function assessTerminalConditionCoverage(
  stages: readonly StageConfig[],
  terminalOwnerIds: readonly string[],
): TerminalConditionCoverageAssessment {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const owners = terminalOwnerIds.map((id) => byId.get(id)).filter((stage): stage is StageConfig => Boolean(stage));
  if (owners.length !== terminalOwnerIds.length) {
    return { checked: false, assignmentsEvaluated: 0, statusDomains: {}, reason: 'not every terminal owner is present in the admitted stage set' };
  }
  if (owners.some((owner) => !owner.condition?.trim())) {
    return { checked: true, coversOrdinaryQuiescence: true, assignmentsEvaluated: 1, statusDomains: {} };
  }

  const parsedConditions: Array<{ ownerId: string; condition: ReturnType<typeof parseCondition> }> = [];
  for (const owner of owners) {
    let condition: ReturnType<typeof parseCondition>;
    try { condition = parseCondition(owner.condition!); } catch {
      return { checked: false, assignmentsEvaluated: 0, statusDomains: {}, reason: `${owner.id} has an unparsable condition` };
    }
    if (condition.field !== 'status') {
      return { checked: false, assignmentsEvaluated: 0, statusDomains: {}, reason: `${owner.id} depends on non-status evidence` };
    }
    if (terminalOwnerIds.includes(condition.stageId)) {
      return { checked: false, assignmentsEvaluated: 0, statusDomains: {}, reason: `${owner.id} depends on another terminal owner` };
    }
    if (!byId.has(condition.stageId)) {
      return { checked: false, assignmentsEvaluated: 0, statusDomains: {}, reason: `${owner.id} references an unknown stage` };
    }
    parsedConditions.push({ ownerId: owner.id, condition });
  }

  const statusDomains = Object.fromEntries([...new Set(parsedConditions.map(({ condition }) => condition.stageId))]
    .sort()
    .map((stageId) => {
      const stage = byId.get(stageId)!;
      const optional = Boolean(stage.condition?.trim() || (!stage.is_gate && stage.retry_to?.length));
      return [stageId, optional ? [STAGE_STATUS.COMPLETE, STAGE_STATUS.SKIPPED] : [STAGE_STATUS.COMPLETE]];
    }));
  const entries = Object.entries(statusDomains);
  const assignmentCount = entries.reduce((count, [, domain]) => count * domain.length, 1);
  if (assignmentCount > 4096) {
    return { checked: false, assignmentsEvaluated: 0, statusDomains, reason: `ordinary-quiescence domain has ${assignmentCount} assignments, above the 4096 admission bound` };
  }

  let assignmentsEvaluated = 0;
  let uncoveredAssignment: Record<string, string> | undefined;
  const assignment: Record<string, string> = {};
  const visit = (index: number): void => {
    if (uncoveredAssignment) return;
    if (index < entries.length) {
      const [stageId, domain] = entries[index];
      for (const status of domain) {
        assignment[stageId] = status;
        visit(index + 1);
      }
      delete assignment[stageId];
      return;
    }
    assignmentsEvaluated++;
    const covered = parsedConditions.some(({ condition }) => (
      statusConditionMatches(assignment[condition.stageId], condition)
    ));
    if (!covered) uncoveredAssignment = { ...assignment };
  };
  visit(0);
  return {
    checked: true,
    coversOrdinaryQuiescence: !uncoveredAssignment,
    assignmentsEvaluated,
    statusDomains,
    ...(uncoveredAssignment ? { uncoveredAssignment } : {}),
  };
}
