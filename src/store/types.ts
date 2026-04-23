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
  autoApproveRetries?: boolean;
  timeoutMs?: number;
  failureReason?: string;
  campaignId?: string;
  campaignSeq?: number;
}
