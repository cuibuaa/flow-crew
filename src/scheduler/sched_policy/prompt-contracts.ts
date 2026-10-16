/** Scheduler-owned execution and admission prompt contracts; builds strings only and changes no contract bytes. */
import { APPROVAL_REQUEST_FILE } from '../../approval-artifacts.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type StageConfig } from '../sched_admission/configuration.js';
import { scopeRevisionContract } from '../../live-constraint-guard.js';
import { type ResearchConfig, type TerminalStatesConfig, type StoreState } from '../../store.js';
import { resolveResearchPaths } from '../../research-paths.js';
import type { AgentConfig } from '../../adapters/base.js';

const SHARED_ROLE_CONTRACT = `## Review contract
An independent review decides whether the change achieves the brief's outcome and what it breaks.
Reviewers give every assigned criterion and every score required by the brief or role/gate contract its own result
and evidence. Pass only when all meet their acceptance lines. Disclose missing or ambiguous lines;
never invent a threshold or waive a supplied one. Examples do not exclude equivalent property evidence
unless the criterion explicitly requires that means. A wording/property conflict identifies its originating
sentence; a confirmed compatibility requirement remains binding unless the brief itself allows that incompatibility to be documented instead, in which case documenting it with its cause and evidence satisfies it. Reviewers say briefly in their reason what they did not examine and why.
Independent reviewers must not durably modify the reviewed target or authoritative inputs (the engine guards reviewer writes, so this needs no reviewer proof); isolated temporary probes and declared evidence generation are allowed within admitted capabilities. Target repairs belong to an author.

## Run-directory safety
Never write, move, delete, or otherwise modify any run directory other than this task's own run directory. This prohibition is absolute; read authorization never grants mutation authority.
By default, do not read, browse, or list other \`.fc/runs/\` directories. Explicit brief authorization allows a bounded set as read-only evidence and governs default read restrictions for that evidence only; it grants no permission to modify those runs.`;

/** Raw roles and base-loaded roles share the same policy, including when _base.md is absent. */
export function applySharedRoleContract(agent: AgentConfig): AgentConfig {
  return agent.prompt.includes(SHARED_ROLE_CONTRACT) ? agent : { ...agent, prompt: `${SHARED_ROLE_CONTRACT}\n\n${agent.prompt}` };
}

export function appendApprovalRequestContract(prompt: string, runDirPath: string, stageId: string): string {
  return `${prompt}\n\nHuman authorization is required only for effects outside this run's authority: other repositories, credentials, outward network effects, deleting user data, shared devices, or git history outside the run branch. `
    + `Admitted writes, private scratch, run-local tool environment setup and framework-owned isolated build/test/lint validation already have execution authority; proceed through their existing owners. Scope and contract errors are decided by the engine. `
    + `For an external effect, write exactly one JSON request ({id, action, target, risk: "external", title?, body?}) describing the external authority needed to `
    + `${join(runDirPath, 'stages', stageId, APPROVAL_REQUEST_FILE)} and stop before performing the action. `
    + `Each stage has its own slot. Non-external requests receive a deterministic decision without parking; an existing scratch acknowledgement grants no external effects. Read approvals/<id>.decision.json before continuing a requested action.`;
}

export function appendScopeRevisionContract(
  prompt: string,
  runDirPath: string,
  runId: string,
  stage: StageConfig,
): string {
  const declaredScope = stage.scope ?? [];
  const scopePresence = stage.scope === undefined ? 'missing' : 'present';
  return `${prompt}\n\n${scopeRevisionContract({
    runDir: runDirPath,
    runId,
    stageId: stage.id,
    attemptIndex: '<current execution index>',
    scope: declaredScope,
    scopePresence,
    gate: stage.is_gate === true,
  })}`;
}

export function appendResearchPathContract(
  prompt: string,
  research: ResearchConfig | undefined,
  terminalStates: TerminalStatesConfig | undefined,
): string {
  if (!research) return prompt;
  const paths = resolveResearchPaths(research);
  const terminalPaths = Object.values(terminalStates ?? {}).flatMap((entry) => entry.paths);
  return `${prompt}\n\n# Resolved research paths (scheduler-owned)\n`
    + `- mutable latest measured result: ${paths.resultFile}\n`
    + `- mutable no-candidate alternative: ${paths.resultFile}.no_candidate.json\n`
    + `- framework round manifest (written before confirmation): ${paths.manifestFile}\n`
    + `- terminal outputs: ${terminalPaths.length > 0 ? terminalPaths.join(', ') : 'none declared'}\n`
    + `The measured result and no-candidate sidecar are mutually exclusive mutable slots. `
    + `When no safe acting candidate exists, write exactly {"label":"<non-empty>","outcome":"no_candidate","reason":"<non-empty>"} to ${paths.resultFile}.no_candidate.json; the discriminator field is outcome, not status. `
    + `Hard checks must declare inputs that are available on every permitted round outcome. `
    + `${paths.manifestFile} is written after the scheduler accepts a round and before that round's confirmation gate. `
    + `Its evidence locator records accepted observations; configured validation and independent gates review authored tests. `
    + `A hard check that references ${paths.resultFile} is still rejected at admission even when a producer declares that path; a check that requires the absent ${paths.manifestFile} before the first accepted round is rejected as a temporal cycle.`;
}

export function appendPlannerAdmissionContract(
  prompt: string,
  terminalStates: TerminalStatesConfig | undefined,
): string {
  const terminalPaths = Object.entries(terminalStates ?? {}).flatMap(([status, entry]) => (
    entry.paths.map((path) => ({ status, path }))
  ));
  const rows = terminalPaths.length > 0
    ? terminalPaths.map(({ status, path }) => `- ${status}: ${path} — one final ordinary producer; ordered writers and repairs may share its scope`).join('\n')
    : '- none declared';
  return `${prompt}\n\n# Engine admission contract for this proposal (pre-submit)\n${rows}\n`
    + `Give each author that builds a private run directory output at stages/<stage-id>/build in artifact_contract.produces. Configure compiler output and caches there; project scope covers its source edits. Shared build destinations still conflict and serialize. `
    + `Paths under an external run store (for example .fc/runs/) are not project outputs and cannot be made reachable by declaring project scope.`;
}

export function appendAttemptDeadlineContract(
  prompt: string,
  attemptBudgetMs: number,
): string {
  return `${prompt}\n\nRuntime timeout contract: this execution has an immutable ${attemptBudgetMs}ms deadline. `
    + `Retries, backoff and fallback consume that same budget; the scheduler allocates any later execution's budget.`;
}

export function appendGateConstraintAuditContext(
  prompt: string,
  stage: StageConfig,
  allStages: StageConfig[],
  state: StoreState,
  runDirPath: string,
): string {
  if (!stage.is_gate) return prompt;
  const rows = [...dependencyClosure(stage, allStages)].flatMap((id) => {
    const status = state.stages[id];
    return (status?.attempts ?? []).flatMap((attempt) => {
      if (!attempt.constraintAudit) return [];
      const summary = attempt.constraintAudit;
      return [`- ${id} attempt ${attempt.index}: ${join(runDirPath, summary.path)} `
        + `(accepted=${summary.acceptedRevisionCount}, rejected=${summary.rejectedRevisionCount}, `
        + `mismatch=${summary.mismatchCount}, violations=${summary.violationCount}, unverified=${summary.unverifiedCount})`];
    });
  });
  if (rows.length === 0) return prompt;
  return `${prompt}\n\n# Runtime Constraint Audits\nRead these dependency-closure audits as gate evidence:\n${rows.join('\n')}`;
}

function dependencyClosure(stage: StageConfig, allStages: StageConfig[]): Set<string> {
  const byId = new Map(allStages.map((candidate) => [candidate.id, candidate]));
  const closure = new Set<string>();
  const queue = [...(stage.depends_on ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (closure.has(id)) continue;
    closure.add(id);
    queue.push(...(byId.get(id)?.depends_on ?? []));
  }
  return closure;
}
