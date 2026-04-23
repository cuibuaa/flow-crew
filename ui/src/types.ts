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
  isGate?: boolean;
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
  autoApproveRetries: boolean;
  iterationLog: string | null;
  campaignId?: string;
  campaignSeq?: number;
}

export interface StageDetail extends Stage {
  input: string;
  output: string;
  tokens_in: number;
  tokens_out: number;
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
