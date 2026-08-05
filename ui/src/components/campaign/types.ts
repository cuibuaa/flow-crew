export type SourceStatus = "complete" | "partial" | "unavailable";

export interface SourceCoverage {
  succeeded: number;
  failed: number;
  total: number;
}

export interface CampaignRunReference {
  runId: string;
  shortName: string;
  href: string;
}

export interface SourceIssue {
  code: string;
  summary: string;
  affectedRuns: CampaignRunReference[];
  details?: string[];
}

export interface SourceResult<T> {
  status: SourceStatus;
  value: T;
  coverage: SourceCoverage;
  issues?: SourceIssue[];
}

export type RunStatus =
  | "pending"
  | "running"
  | "parked"
  | "complete"
  | "failed"
  | "awaiting_approval"
  | "shipped"
  | "ceiling_hit"
  | "escalated"
  | "reality_gate_failed"
  | "phase_complete"
  | "stopped"
  | "incomplete";

export interface CampaignClassification {
  kind: "research" | "engineering" | "mixed" | "unknown";
  status: "complete" | "partial";
  research: "present" | "absent" | "unknown";
  engineering: "present" | "absent" | "unknown";
  acceptedPointCount: number;
  engineeringRunCount: number;
  reasons: string[];
  issues: SourceIssue[];
}

export interface CampaignIdentity {
  id: string;
  name: string;
  storageKey: string;
  runCount: number;
  startedAt: string | null;
  startedAtSource: "runs" | "legacy" | "unknown";
  classification: CampaignClassification;
}

export interface CampaignAttentionItem {
  id: string;
  kind: "approval" | "brief_review" | "deferred" | "parked" | "worker_missing" | "campaign_alert" | "stale";
  title: string;
  reason: string;
  runId?: string;
  href: string;
  priority: "high" | "medium" | "low";
  source?: string;
  simulated?: boolean;
}

export interface CampaignAttention {
  items: CampaignAttentionItem[];
  total: number;
  shown: number;
}

export interface CampaignActivityItem {
  runId: string;
  shortName: string;
  fullTitle: string;
  status: RunStatus;
  statusExplanation: string;
  durationMs: number | null;
  durationPartial: boolean;
  worker: "live" | "missing" | "none" | "unknown";
  anomaly?: string;
  href: string;
}

export interface CampaignActivity {
  items: CampaignActivityItem[];
  total: number;
  shown: number;
}

export interface CampaignCost {
  wallMs: number;
  tokens: number;
  supervisorTokens: number;
  runCoverage: SourceCoverage;
  wallCoverage: SourceCoverage;
  tokenCoverage: SourceCoverage;
}

export interface AcceptedMeasurementPoint {
  runId: string;
  round: string;
  metric: string;
  metricKey: string;
  value: number;
  timestamp: string | null;
  direction: "higher" | "lower" | "unknown";
  evidence: "research_journal" | "campaign_ledger" | "outer_campaign";
}

export interface ResearchMetricGroup {
  metric: string;
  metricKey: string;
  points: AcceptedMeasurementPoint[];
  hasTrend: boolean;
  direction: "higher" | "lower" | "unknown" | "conflict";
  best: AcceptedMeasurementPoint | null;
}

export interface ResearchNarrative {
  selected: ResearchMetricGroup | null;
  otherMetrics: ResearchMetricGroup[];
  acceptedPointCount: number;
  confirmNotes: string[];
  latestCanonicalStatus: RunStatus | null;
}

export interface EngineeringDelivery {
  runId: string;
  shortName: string;
  fullTitle: string;
  status: RunStatus;
  statusExplanation: string;
  conclusion: string;
  commits: string[];
  filesChanged: string[];
  gates: string[];
  href: string;
}

export interface EngineeringNarrative {
  latest: EngineeringDelivery | null;
  deliveryCount: number;
}

export interface CampaignRunRow {
  runId: string;
  shortName: string;
  fullTitle: string;
  status: RunStatus;
  statusExplanation: string;
  conclusion: string;
  durationMs: number | null;
  durationPartial: boolean;
  commits: string[];
  gates: string[];
  zeroWork: boolean;
  zeroWorkReason?: string;
  startedAt: string | null;
  completedAt: string | null;
  href: string;
}

export interface CampaignRunPage {
  items: CampaignRunRow[];
  shown: number;
  total: number;
  nextCursor: string | null;
  truncated: boolean;
}

export interface CampaignOperatorView {
  generatedAt: string;
  identity: CampaignIdentity;
  cost: SourceResult<CampaignCost>;
  attention: SourceResult<CampaignAttention>;
  activity: SourceResult<CampaignActivity>;
  research: SourceResult<ResearchNarrative | null>;
  engineering: SourceResult<EngineeringNarrative | null>;
  runs: SourceResult<CampaignRunPage>;
}

export interface CampaignIndexRow {
  id: string;
  name: string;
  runCount: number;
  latestStartedAt: string | null;
  attention: { status: SourceStatus; count: number | null };
  activity: {
    status: SourceStatus;
    running: number;
    waiting: number;
    summary: string;
    needsIntervention: boolean;
  };
  recent: {
    status: SourceStatus;
    runStatus: RunStatus | null;
    statusExplanation: string | null;
    conclusion: string;
  };
  href: string;
}

export interface CampaignOperatorIndex {
  generatedAt: string;
  campaigns: SourceResult<{ items: CampaignIndexRow[]; total: number }>;
}
