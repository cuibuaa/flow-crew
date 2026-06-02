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
  model?: string;
  tools: string[];
  adapter?: string;
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
  model?: string;
  reasoning_effort?: string;
  campaign_triggers?: {
    enabled?: boolean;
    regression_after?: number;
    plateau_after?: number;
    plateau_threshold?: number;
    repeated_failure_after?: number;
  };
  supervisor?: {
    enabled?: boolean;
    escalation_threshold?: number;
  };
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

export interface M3CampaignSummary {
  id: string;
  status: string;
  iterations_done: number;
  iterationCount: number;
  started_at: string;
  latest_outcome: string | null;
  latestOutcome: string | null;
  projectDir?: string | null;
  briefDir?: string | null;
  goal?: unknown;
  budget?: unknown;
  config?: Record<string, unknown> | null;
}

export type M3CampaignIteration = Record<string, unknown> & {
  iter?: number;
  run_id?: string;
  runId?: string;
  outcome?: string;
  commit?: string;
  commit_sha?: string;
  completing_commit?: string;
  brief_version?: string;
  briefVersion?: string;
  patch_applied?: unknown;
  diagnosis?: unknown;
  rejections?: Record<string, number>;
  rejection_counts?: Record<string, number>;
};

export type M3CampaignRevision = Record<string, unknown> & {
  version?: string;
  from_version?: string;
  to_version?: string;
  patch?: unknown;
  rule?: string;
};

export type M3KGNode = {
  id: string;
  type: "symptom" | "diagnosis" | "patch" | "outcome";
  campaignId: string;
  campaignStartedAt: string;
  metadata: Record<string, unknown>;
};

export type M3KGSuggestion = {
  symptomNode: M3KGNode;
  suggestedPatch?: M3KGNode;
  outcomeNode: M3KGNode;
  similarity: number;
  reason: string;
};

export type M3PendingReview = Record<string, unknown> & {
  index: number;
  ts: string;
  campaignId: string;
  reason: string;
  severity?: "low" | "medium" | "high";
  patch: unknown;
  patchSummary: string;
};

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

export type MetricFormat = "currency_usd" | "rating_0_to_10" | "pct" | "count" | "duration_min" | "raw";

export interface WorkspaceBadge {
  text: string;
  kind?: "default" | "success" | "warn" | "error" | "accent" | string;
}

export interface WorkspaceMetric {
  name: string;
  value: number | null;
  format: MetricFormat;
  target?: { min?: number | null; max?: number | null } | null;
  sublabel?: string | null;
}

export interface WorkspaceIteration {
  label: string;
  value: number | null;
  verdict?: "outlier" | "unstable" | "interim" | "shipped" | string;
}

export interface WorkspacePhase {
  name: string;
  status?: string | null;
  elapsed_min?: number | null;
  attempt?: number | null;
  commit?: string | null;
  commit_chain?: string[] | null;
  notes?: string | null;
}

export interface BriefRevision {
  version: string;
  reason: string;
  shipped?: boolean;
}

export interface WorkspaceRun {
  id: string;
  full_id?: string;
  started_at?: string;
  startedAt?: string;
  iter?: string;
  metric?: number | null;
  summary?: string;
  duration?: string;
  outcome?: string;
  projectDir?: string;
  hasSummary?: boolean;
}

export interface Campaign {
  id: string;
  name: string;
  status: string;
  badges?: WorkspaceBadge[];
  metric?: WorkspaceMetric | null;
  iterations?: WorkspaceIteration[] | null;
  phases?: WorkspacePhase[] | null;
  brief_revisions?: BriefRevision[] | null;
  runs?: WorkspaceRun[];
  started_at?: string | null;
  latest_run_started_at?: string | null;
  latestRunStartedAt?: string | null;
  kg_node_count?: number;
}

export interface CampaignKGNode {
  id: string;
  type: string;
  label?: string;
  meta?: string;
  campaign?: string;
  campaignId?: string;
  metadata?: Record<string, unknown>;
}

export interface CampaignKGEdge {
  id?: string;
  source?: string;
  target?: string;
  from?: string;
  to?: string;
  kind?: string;
  relation?: string;
  type?: string;
}

export interface DashboardData {
  generated_at?: string;
  campaigns: Campaign[];
  standalone_runs?: WorkspaceRun[];
  kg?: { nodes: CampaignKGNode[]; edges: CampaignKGEdge[] };
  sample_run?: RunDetailData | null;
}

export interface RunStage {
  id: string;
  role: string;
  depends_on: string[];
  is_gate?: boolean;
  retry_to?: string[];
  status: string;
  duration_ms?: number | null;
  retries?: number;
  artifact_count?: number;
}

export interface RunEvent {
  ts?: string;
  timestamp?: string;
  event?: string;
  type?: string;
  stage?: string;
  message?: string;
  detail?: string;
}

export interface RunDetailData {
  runId: string;
  projectDir?: string;
  workflowName?: string;
  status: string;
  iteration?: number | null;
  maxIterations?: number | null;
  startedAt?: string;
  completedAt?: string;
  duration_min?: number | null;
  failureReason?: string;
  taskDescriptionPreview?: string;
  campaignId?: string;
  stages: RunStage[];
  kg: { nodes: CampaignKGNode[]; edges: CampaignKGEdge[] };
  events: RunEvent[];
  stage_outputs: Record<string, string>;
}
