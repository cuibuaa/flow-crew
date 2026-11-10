import { runRecordPath } from '../../run-layout.js';
/** Scheduler-owned execution and admission prompt contracts; builds strings only and changes no contract bytes. */
import { type StageConfig } from '../sched_admission/configuration.js';
import { type ResearchConfig, type TerminalStatesConfig, type StoreState } from '../../store.js';
import { resolveResearchPaths } from '../../research-paths.js';
import type { AgentConfig } from '../../adapters/base.js';

export const SINGLE_AUTHOR_NOTICE = 'Execution model: every authoring stage runs one author. Requests in brief text or frontmatter for competing candidates run as single-author work under this notice. Independent gates have their own stage budgets.';

const SHARED_ROLE_CONTRACT = `## Review contract
An independent review decides whether the change achieves the brief's outcome and what it breaks.
Reviewers give every assigned criterion and every score required by the brief or role/gate contract its own result
and evidence. Pass only when all meet their acceptance lines. Disclose missing or ambiguous lines;
never invent a threshold or waive a supplied one. Examples do not exclude equivalent property evidence
unless the criterion explicitly requires that means. A wording/property conflict identifies its originating
sentence; a confirmed compatibility requirement remains binding unless the brief itself allows that incompatibility to be documented instead, in which case documenting it with its cause and evidence satisfies it. Reviewers say briefly in their reason what they did not examine and why.
Independent reviewers must not durably modify the reviewed target or authoritative inputs; disposable probes use only the invocation's private $TMPDIR. Target repairs belong to an author.

## Run-directory safety
The run envelope contains separate engine/ and work/ trees. engine/, root run.json and root events.jsonl are read-only to stages; writing those records voids the stage result. Stage outputs, evidence, probes and model homes belong under work/. Put run-rooted artifact declarations under work/; requests/ and control/ are engine API locations, not stage output locations.
Never write, move, delete, or otherwise modify engine-owned records in any FlowCrew run directory. This prohibition is absolute; read authorization never grants mutation authority. Only exact output paths already assigned to this stage by its admitted artifact_contract.produces or brief retain write authority; output ownership never authorizes additional evidence files or engine-record writes.
By default, do not read, browse, or list other \`.fc/runs/\` directories. Explicit brief authorization allows a bounded set as read-only evidence and governs default read restrictions for that evidence only; it grants no permission to modify those runs.`;

/** Raw roles and base-loaded roles share the same policy, including when _base.md is absent. */
export function applySharedRoleContract(agent: AgentConfig): AgentConfig {
  return agent.prompt.includes(SHARED_ROLE_CONTRACT) ? agent : { ...agent, prompt: `${SHARED_ROLE_CONTRACT}\n\n${agent.prompt}` };
}

export function appendProjectWriteContext(prompt: string, stage: StageConfig): string {
  return `${prompt}\n\nPlanner project-path estimate: ${JSON.stringify(stage.scope ?? [])}. This estimate informs scheduling and reporting; required project work may use other paths. `
    + 'Preserve evidence that the task explicitly declares frozen. Input locators alone do not freeze source trees. '
    + 'Each invocation has private scratch at $TMPDIR (also $TMP and $TEMP). Use mktemp -d "$TMPDIR/probe-XXXXXX" for disposable probes; check creation succeeded before copying.';
}

export function appendResearchPathContract(
  prompt: string,
  research: ResearchConfig | undefined,
  terminalStates: TerminalStatesConfig | undefined,
): string {
  if (!research) return prompt;
  if (research.measurement) return `${prompt}\n\n# Engine-owned research instrument\n`
    + `Edit only the admitted candidate inputs: ${research.measurement.candidate.join(', ')}. The engine snapshots and measures them after independent review. `
    + `The frozen command, dependencies and environment are retained outside your write capabilities. Producer result files and spread estimates do not enter selection. `
    + `Read the research journal to choose the next candidate. Code applies calibrated paired noise, every structured guard and the held-out allowance; it restores the measured best after rejection. `
    + `Terminal producers must follow research_decision.json. The framework owns the manifest and all instrument/observation records.`;
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
    + `Put compiler output and caches in $TMPDIR; project scope covers source edits. Scratch is retired at run termination. Declare required deliverables in artifact_contract.produces at paths their stage owns under its admitted write contract. Put evidence in the structured result. `
    + `Paths under an external run store (for example .fc/runs/) are not project outputs and cannot be made reachable by declaring project scope.`;
}

export function appendAttemptDeadlineContract(
  prompt: string,
  attemptBudgetMs: number,
): string {
  return `${prompt}\n\nStage budget: ${attemptBudgetMs}ms. The engine delivers a live wrap-up instruction before it expires, then allows a bounded finishing interval. Keep admitted files and report done/remaining work. `
    + `Retries, backoff and fallback share this execution's hard stop; budget handoffs spend the next finite workflow iteration. Independent gates have separate stage budgets.`;
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
      return [`- ${id} attempt ${attempt.index}: ${runRecordPath(runDirPath, summary.path)} `
        + `(violations=${summary.violationCount}, unverified=${summary.unverifiedCount})`];
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
