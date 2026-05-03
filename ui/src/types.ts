export interface Stage {
  id: string;
  role: string;
  status: "pending" | "running" | "complete" | "failed" | "skipped";
  duration_ms?: number;
  retries: number;
  artifacts?: string[];
  dependsOn: string[];
  dispatched?: boolean;
  startedAt?: string;
  completedAt?: string;
  isGate?: boolean;
  tokens_in?: number;
  tokens_out?: number;
  error?: string;
}

export interface Message {
  role: "user" | "system";
  content: string;
  timestamp: string;
}

export interface PlanStage {
  id: string;
  role: string;
  prompt_template: string;
  depends_on: string[];
  timeout_ms: number;
  max_retries: number;
  is_gate?: boolean;
  retry_to?: string[];
  task?: string;
}

export interface Task {
  id: string;
  name: string;
  type: string;
  workflow: string;
  status: "pending" | "running" | "completed" | "failed" | "awaiting_approval";
  stages: Stage[];
  startedAt: string;
  elapsed_ms: number;
  tokens: number;
  bestScore?: number;
  metricName?: string;
  discussion: Message[];
  plan: PlanStage[];
  dispatchedStages?: PlanStage[];
  currentIteration: number;
  maxIterations: number;
  timeoutMs?: number;
  maxRetries?: number;
  autoApproveRetries: boolean;
  campaignTriggers?: CampaignTriggers;
  iterationLog: string | null;
  failureReason?: string;
  completedAt?: string;
  campaignId?: string;
  campaignStorageKey?: string;
  campaignName?: string;
  campaignSeq?: number;
  campaignIteration?: number;
  campaignAlert?: {
    type: "regression" | "plateau" | "repeated_failure";
    action: "inject_researcher";
    message: string;
    source: "campaign_health";
    triggeredAt: string;
    iteration: number;
  };
  researchInjection?: {
    source: "campaign_health";
    triggeredAt: string;
    iteration: number;
    alertType: "regression" | "plateau" | "repeated_failure";
    message: string;
  };
  parentTaskId?: string;
  budget?: {
    totalTokens?: number;
    totalTimeMs?: number;
    usedTokens?: number;
    usedTimeMs?: number;
  };
}

export interface CampaignTriggers {
  enabled: boolean;
  regressionAfter: number;
  plateauAfter: number;
  plateauThreshold: number;
  repeatedFailureAfter: number;
}

export interface StageDetail extends Stage {
  input: string;
  output: string;
  tokens_in: number;
  tokens_out: number;
  error?: string;
}

export interface Agent {
  name: string;
  description: string;
  model: string;
  tools: string[];
}

export interface SettingsData {
  projectDir: string;
  adapter: string;
  workflows: string[];
  skills: string[];
  port: number;
  default_timeout_ms?: number;
  default_max_iterations?: number;
  default_gate_retry_loops?: number;
  default_stage_technical_retries?: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  runCount: number;
  bestScore: number | null;
  latestRun?: string;
}

export interface CampaignEntry {
  seq: number;
  runId: string;
  score: number;
  metric: string;
  gates: string;
  status: string;
  timestamp: string;
}

export type CampaignSelectionMode = "existing" | "new" | "standalone";

export function cleanCampaignDisplayName(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^new:/i.test(trimmed)) {
    const cleaned = trimmed.slice(4).trim();
    return cleaned || undefined;
  }
  return trimmed;
}

export function getCampaignDisplayName(target: { campaignName?: string | null; campaignId?: string | null }): string {
  return cleanCampaignDisplayName(target.campaignName) ?? cleanCampaignDisplayName(target.campaignId) ?? "Unnamed campaign";
}

export function getCampaignIteration(task: Pick<Task, "campaignIteration" | "currentIteration">): number {
  return task.campaignIteration ?? task.currentIteration;
}

// Knowledge Graph types
export type KGNodeType = 'goal' | 'approach' | 'finding' | 'result' | 'insight' | 'dead_end' | 'user_hint';
export type KGEdgeType = 'explored_by' | 'found_that' | 'measured_as' | 'sourced_from' | 'supports' | 'contradicts' | 'combines_with' | 'depends_on';

export interface KGNode {
  id: string;
  type: KGNodeType;
  label: string;
  details?: string;
  source?: string;
  score?: number;
  timestamp: string;
  stageId?: string;
}

export interface KGEdge {
  id?: string;
  from?: string;
  to?: string;
  source?: string;
  target?: string;
  type: KGEdgeType;
  label?: string;
  timestamp?: string;
}

export interface KnowledgeGraph {
  nodes: KGNode[];
  edges: KGEdge[];
  metadata: {
    bestScore?: number;
    metricName?: string;
    createdAt: string;
    updatedAt: string;
  };
}

// Execution Trace types
export type TraceEventType = 'llm_call' | 'tool_use' | 'web_search' | 'file_read' | 'file_write' | 'kg_update';

export interface TraceEvent {
  timestamp: string;
  stageId: string;
  type: TraceEventType;
  inputSummary: string;
  outputSummary: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs: number;
  kgNodesAdded?: string[];
}

export interface TraceSummary {
  totalEvents: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  totalDurationMs: number;
  byType: Record<string, number>;
}
