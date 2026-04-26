export interface StageStatus {
  status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  exitCode?: number;
  duration_ms?: number;
  artifacts?: string[];
  retries: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  tokens_in?: number;
  tokens_out?: number;
}

export interface CampaignTriggers {
  enabled?: boolean;
  regressionAfter?: number;
  plateauAfter?: number;
  plateauThreshold?: number;
  repeatedFailureAfter?: number;
}

export interface StoreState {
  runId: string;
  workflowName: string;
  projectDir: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'awaiting_approval';
  stages: Record<string, StageStatus>;
  startedAt: string;
  completedAt?: string;
  discussion?: unknown[];
  plan?: unknown[];
  dispatchedStages?: unknown[];
  taskDescription?: string;
  currentIteration?: number;
  maxIterations?: number;
  maxRetries?: number;
  autoApproveRetries?: boolean;
  timeoutMs?: number;
  campaignTriggers?: CampaignTriggers;
  failureReason?: string;
  campaignId?: string;
  campaignStorageKey?: string;
  campaignName?: string;
  campaignSeq?: number;
  campaignIteration?: number;
  campaignAlert?: {
    type: 'regression' | 'plateau' | 'repeated_failure';
    action: 'inject_researcher';
    message: string;
    source: 'campaign_health';
    triggeredAt: string;
    iteration: number;
  };
  researchInjection?: {
    source: 'campaign_health';
    triggeredAt: string;
    iteration: number;
    alertType: 'regression' | 'plateau' | 'repeated_failure';
    message: string;
  };
}
