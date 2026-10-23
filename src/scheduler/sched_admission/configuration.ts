/** Agent/workflow/live-dispatch schemas and admitted query facts. Typed runtime fields share one validator; inert metadata is stripped. */
import { loadEngineDefaults as loadDefaults } from '../../config.js';
import { z } from 'zod';
import { type AgentConfig } from '../../adapters/base.js';
import { ArtifactContractSchema, RecordedArtifactContractSchema, artifactActivation } from '../../artifact-declarations.js';
import { type StoreState, RUN_STATUS } from '../../store.js';
import { parseCondition } from '../../condition.js';
import { applySharedRoleContract } from '../sched_policy/prompt-contracts.js';

export { loadDefaults };

/** Operator-owned bound for technical timeout retries; plans cannot override it. */
export function configuredTechnicalRetryLimit(): number {
  return Math.max(0, Math.floor(Number(loadDefaults().stage_technical_retries)));
}

/** How often a stage that failed for an ordinary reason runs again; the same in the batch and in the gate loop. */
export function failureRetryLimit(stage: StageConfig, workflow: WorkflowConfig): number {
  return Math.max(0, Math.floor(Number(stage.max_retries ?? workflow.defaults.max_retries ?? configuredTechnicalRetryLimit())));
}

const AgentConfigSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  model: z.string().default('default'),
  reasoning_effort: z.string().default('default'),
  tools: z.array(z.string()).default([]),
  prompt: z.string(),
  adapter: z.string().optional(),
  handoff_visibility: z.enum(['full', 'minimal', 'none']).optional(),
});

export function parseAgent(raw: unknown): AgentConfig {
  const agent = AgentConfigSchema.parse(raw);
  if (agent.model === 'default') agent.model = loadDefaults().model;
  if (agent.reasoning_effort === 'default') agent.reasoning_effort = loadDefaults().reasoning_effort;
  return applySharedRoleContract(agent);
}

const StageFields = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  role: z.string().min(1),
  depends_on: z.array(z.string()).optional().default([]),
  /** Project-relative write capability. Missing is closed for writes and conflicts with writer scopes. */
  scope: z.array(z.string()).optional(),
  /** Optional historical dependency prose; graph edges carry execution order. */
  dependency_reasons: z.record(z.string(), z.string()).optional(),
  condition: z.string().optional(),
  prompt_template: z.string().optional().default(''),
  max_retries: z.number().optional(),
  skills: z.array(z.string()).optional().default([]),
  dynamic_dispatch: z.boolean().optional().default(false),
  is_gate: z.boolean().optional().default(false),
  retry_to: z.array(z.string()).optional(),
  /** Canonical IDs from the run-local brief_criteria.json artifact. */
  criterion_refs: z.array(z.string()).optional().default([]),
  /** Versioned exact outputs and reads; an explicit empty contract is meaningful. */
  artifact_contract: ArtifactContractSchema.optional(),
});

export const StageConfigSchema = StageFields;

/** Read-only history retains the ownership marker; it never enables execution. */
export const RecordedStageConfigSchema = StageFields.extend({ race: z.boolean().optional(), artifact_contract: RecordedArtifactContractSchema.optional() });
export type StageConfig = z.infer<typeof StageFields>;
export type RecordedStageConfig = z.infer<typeof RecordedStageConfigSchema>;

const WorkflowFields = z.object({
  name: z.string(),
  description: z.string().optional().default(''),
  defaults: z.object({
    max_retries: z.number().optional(),
    max_iterations: z.number().int().positive().optional(),
  }).optional().default({}),
  stages: z.array(StageFields).min(1),
  /** A fixed answer to a dynamic_dispatch stage, admitted like a planner answer. */
  dispatch: z.array(z.unknown()).min(1).optional(),
}).refine((workflow) => !workflow.dispatch || workflow.stages.some((stage) => stage.dynamic_dispatch), {
  path: ['dispatch'], message: 'a fixed dispatch is the answer of a dynamic_dispatch stage; declare that stage',
});
export const WorkflowConfigSchema = WorkflowFields;
export const RecordedWorkflowConfigSchema = WorkflowFields.safeExtend({ stages: z.array(RecordedStageConfigSchema).min(1) });
export type WorkflowConfig = z.infer<typeof WorkflowFields>;

/** The scheduler resolves conditions; every consumer reads the same admitted facts. */
export function refreshRunQueryState(state: StoreState, stages: StageConfig[]): void {
  const previous = state.queryState ?? { version: 1 as const };
  state.queryState = {
    ...previous, version: 1,
    artifacts: stages.flatMap((stage) => [
      ...(stage.artifact_contract?.produces ?? []).map((artifact) => ({
        id: `${stage.id}:${artifact.id}`, root: artifact.root, path: artifact.path, kind: artifact.kind,
        stageId: stage.id, role: 'produce' as const, activation: artifactActivation(artifact.when, state.stages),
        group: stage.artifact_contract?.groups.find((group) => group.members.includes(artifact.id))?.id,
        source: 'admitted_declaration',
      })),
      ...(stage.artifact_contract?.reads ?? []).map((artifact) => ({
        id: `${stage.id}:${artifact.id}`, root: artifact.root, path: artifact.path, kind: artifact.kind,
        stageId: stage.id, role: 'read' as const, activation: artifactActivation(artifact.when, state.stages), source: 'admitted_declaration',
      })),
    ]),
  };
}

export const RESEARCH_DECISION_STATUS_ALIASES = new Map<string, string>([
  [RUN_STATUS.SHIPPED, 'ship'],
  [RUN_STATUS.CEILING_HIT, 'stop_ceiling'],
]);

export const EMITTED_RESEARCH_DECISIONS = new Set(RESEARCH_DECISION_STATUS_ALIASES.values());

function normalizeResearchTerminalCondition(condition: string | undefined): string | undefined {
  if (!condition?.trim()) return condition;
  try {
    const parsed = parseCondition(condition);
    if (parsed.stageId === 'research'
        && parsed.field === 'decision'
        && parsed.op === '=='
        && typeof parsed.value === 'string') {
      const emittedDecision = RESEARCH_DECISION_STATUS_ALIASES.get(parsed.value);
      if (emittedDecision) return `research.decision == ${JSON.stringify(emittedDecision)}`;
      if (parsed.value === RUN_STATUS.ESCALATED) {
        return `research.terminalStatus == ${JSON.stringify(RUN_STATUS.ESCALATED)}`;
      }
    }
  } catch { /* admission reports malformed conditions; parsing stays fail-closed */ }
  return condition;
}

/**
 * Dynamic plans describe the DAG, not scheduler recovery policy. Keep accepting
 * the historical field so an otherwise usable plan is not discarded, but strip
 * it before the stage reaches state, workflow persistence, or execution.
 */
export function parseDispatchedStageConfig(raw: unknown): StageConfig {
  // Keep the historical task alias at the one live parser boundary.
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'task' in raw) {
    const { task, ...fields } = raw as Record<string, unknown>;
    raw = { ...fields, prompt_template: fields.prompt_template ?? task };
  }
  const stage = StageConfigSchema.parse(raw);
  // Live omission is a closed capability, never the legacy ungoverned scope state.
  stage.scope ??= [];
  if (stage.is_gate && stage.retry_to?.length) throw new Error('gate stages cannot declare retry_to; repairs own retry_to edges');
  normalizeStageContracts([stage]);
  delete stage.max_retries;
  stage.condition = normalizeResearchTerminalCondition(stage.condition);
  return stage;
}

/** Normalize quality topology and artifact authority for static workflows and dynamic dispatch. */
export function normalizeStageContracts(stages: StageConfig[]): StageConfig[] {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  for (const repair of stages) {
    if (repair.is_gate || !repair.retry_to?.length) continue;
    repair.dependency_reasons ??= {};
    for (const gateId of repair.retry_to) {
      const gate = byId.get(gateId);
      if (!gate) continue;
      gate.is_gate = true;
      if (!repair.depends_on.includes(gateId)) repair.depends_on = [...repair.depends_on, gateId];
      repair.dependency_reasons[gateId] ??= 'Framework retry dependency: fixes run only after this gate reports a failure.';
    }
  }
  for (const stage of stages) {
    const contract = stage.artifact_contract = RecordedArtifactContractSchema.parse(stage.artifact_contract === undefined ? {
      version: 1, produces: [],
      reads: [], groups: [],
    } : stage.artifact_contract);
    const path = stage.dynamic_dispatch ? 'dispatch.yaml' : stage.is_gate ? `verdict_${stage.id}.json` : undefined;
    if (!path) continue;
    const output = contract.produces.find((artifact) => artifact.root === 'run' && artifact.path === path);
    if (output) Object.assign(output, { kind: 'file', when: undefined });
    else {
      const base = stage.dynamic_dispatch ? 'dispatch' : 'verdict';
      let id = base;
      const ids = new Set([...contract.produces, ...contract.reads].map((artifact) => artifact.id));
      for (let index = 1; ids.has(id); index++) id = `${base}_${index}`;
      contract.produces.push({ root: 'run', path, id, kind: 'file', nonempty: stage.dynamic_dispatch });
    }
  }
  return stages;
}

export type CampaignPhaseMetadata = {
  gate: string;
  pass: boolean;
  phase?: string;
  phaseComplete?: boolean;
  nextPhase?: string;
  outcome?: string;
  artifactSummary?: string;
  reason?: string;
};

export function isTerminalStudyCompletionArtifact(record: Record<string, unknown>): boolean {
  // Domain-agnostic contract: a gate verdict may declare that the STUDY is complete
  // even though the model did NOT succeed — a rigorous negative result is itself a
  // valid terminal outcome. Recognized by the verdict's OWN fields, NOT by any
  // hardcoded gate name, so any brief/gate can opt in by emitting this contract.
  if (record.phase_complete === true || record.phaseComplete === true || record.continue_next_phase === true) return false;
  return record.study_complete === true
    && record.model_success === false
    && record.reason === 'study_complete_without_model_success';
}
