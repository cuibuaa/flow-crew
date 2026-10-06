/** Scheduler-owned execution and admission prompt contracts; builds strings only and changes no contract bytes. */
import { APPROVAL_REQUEST_FILE } from '../../approval-artifacts.js';
import { join } from 'node:path';
import { type StageConfig } from '../sched_admission/configuration.js';
import { scopeRevisionContract } from '../../live-constraint-guard.js';
import { type ResearchConfig, type TerminalStatesConfig, type StoreState } from '../../store.js';
import { resolveResearchPaths } from '../../research-paths.js';

export function appendApprovalRequestContract(prompt: string, runDirPath: string, stageId: string): string {
  return `${prompt}\n\nApproval artifact contract: if this stage needs human authorization before a consequential action, `
    + `write exactly one JSON request ({id, action, target?, risk?, title?, body?}) to `
    + `${join(runDirPath, 'stages', stageId, APPROVAL_REQUEST_FILE)} and stop before performing the action. `
    + `Each stage has its own slot so parallel requests are not overwritten.`;
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

export function appendResearchTemporalPathContract(
  prompt: string,
  research: ResearchConfig | undefined,
  terminalStates: TerminalStatesConfig | undefined,
): string {
  if (!research) return prompt;
  const paths = resolveResearchPaths(research);
  const terminalPaths = Object.values(terminalStates ?? {}).flatMap((entry) => entry.paths);
  return `${prompt}\n\n# Resolved research temporal paths (scheduler-owned)\n`
    + `- mutable latest measured result: ${paths.resultFile}\n`
    + `- mutable no-candidate alternative: ${paths.resultFile}.no_candidate.json\n`
    + `- framework round manifest (written before confirmation): ${paths.manifestFile}\n`
    + `- terminal outputs: ${terminalPaths.length > 0 ? terminalPaths.join(', ') : 'none declared'}\n`
    + `The measured result and no-candidate sidecar are mutually exclusive mutable slots. `
    + `When no safe acting candidate exists, write exactly {"label":"<non-empty>","outcome":"no_candidate","reason":"<non-empty>"} to ${paths.resultFile}.no_candidate.json; the discriminator field is outcome, not status. `
    + `Every hard check and every test, regardless of author role or round, must avoid loading them, asserting either slot's existence/absence, or pinning its current label. `
    + `${paths.manifestFile} is written after the scheduler accepts a round and before that round's confirmation gate. `
    + `Its evidence locator may be used by confirmation, but tests must use scheduler-injected immutable round evidence rather than mutable latest-result slots. `
    + `This is mechanically checked after every research stage that writes a test. A hard check that references ${paths.resultFile} is still rejected at admission even when a producer declares that path; a check that requires the absent ${paths.manifestFile} before the first accepted round is rejected as a temporal cycle.`;
}

export function appendPlannerAdmissionContract(
  prompt: string,
  terminalStates: TerminalStatesConfig | undefined,
): string {
  const terminalPaths = Object.entries(terminalStates ?? {}).flatMap(([status, entry]) => (
    entry.paths.map((path) => ({ status, path }))
  ));
  const rows = terminalPaths.length > 0
    ? terminalPaths.map(({ status, path }) => `- ${status}: ${path} — exactly one scoped non-gate, non-repair DAG sink owner`).join('\n')
    : '- none declared';
  return `${prompt}\n\n# Engine admission contract for this proposal (pre-submit)\n${rows}\n`
    + `Before finishing dispatch.yaml, tally the owners for every row above; zero and multiple owners are both refused. `
    + `Also remove or demote every hard reality check whose absent path has neither an admitted producer nor a framework emitter. `
    + `Paths under an external run store (for example .fc/runs/) are not project outputs and cannot be made reachable by declaring project scope.`;
}

export function appendAttemptDeadlineContract(
  prompt: string,
  attemptBudgetMs: number,
): string {
  return `${prompt}\n\nRuntime timeout contract: this execution has an immutable ${attemptBudgetMs}ms deadline. `
    + `The base stage timeout comes only from config/defaults.yaml::default_timeout_ms. Adapter retries, backoff, `
    + `fallback loading, and fallback execution all consume this same execution deadline; runtime extension requests `
    + `are rejected and cannot move it. If this execution times out and a configured technical retry remains, the next `
    + `execution receives a strictly larger derived budget. A current-execution supervisor ABORT remains authoritative.`;
}

export function appendGateConstraintAuditContext(
  prompt: string,
  stage: StageConfig,
  allStages: StageConfig[],
  state: StoreState,
  runDirPath: string,
): string {
  if (!stage.is_gate) return prompt;
  const byId = new Map(allStages.map((candidate) => [candidate.id, candidate]));
  const closure = new Set<string>();
  const queue = [...(stage.depends_on ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (closure.has(id)) continue;
    closure.add(id);
    queue.push(...(byId.get(id)?.depends_on ?? []));
  }
  const rows = [...closure].flatMap((id) => {
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

