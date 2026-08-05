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

export type MetricFormat = "currency_usd" | "rating_0_to_10" | "pct" | "count" | "duration_min" | "raw";

interface WorkspaceBadge {
  text: string;
  kind?: "default" | "success" | "warn" | "error" | "accent" | string;
}

interface WorkspaceMetric {
  name: string;
  value: number | null;
  format: MetricFormat;
  target?: { min?: number | null; max?: number | null } | null;
  sublabel?: string | null;
}

interface WorkspaceIteration {
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
  direction?: string | null;
  result?: number | null;
  runId?: string | null;
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
  staleRunId?: string;
  badges?: WorkspaceBadge[];
  metric?: WorkspaceMetric | null;
  iterations?: WorkspaceIteration[] | null;
  phases?: WorkspacePhase[] | null;
  brief_revisions?: BriefRevision[] | null;
  runs?: WorkspaceRun[];
  runs_total?: number;
  started_at?: string | null;
  latest_run_started_at?: string | null;
  latestRunStartedAt?: string | null;
}

export function getCampaignRunTotal(campaign?: { runs?: WorkspaceRun[]; runs_total?: number } | null): number {
  const total = campaign?.runs_total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0
    ? total
    : campaign?.runs?.length ?? 0;
}

export type InboxDecision = "approve" | "deny";
type InboxRisk = "external" | "exec" | "write" | "unknown";

interface InboxResolution {
  decision: InboxDecision;
  by: string;
  at: string;
  reason?: string;
  always?: boolean;
}

export interface InboxItem {
  runId: string;
  projectDir: string;
  requestId: string;
  action: string;
  target?: string;
  risk: InboxRisk;
  title: string;
  body?: string;
  createdAt: string;
  atIteration?: number;
  stageId?: string;
  state: "pending" | "approved" | "denied";
  resolution?: InboxResolution;
  standingRuleEligible: { ok: boolean; reason?: string };
  campaignId?: string;
  campaignName?: string;
}

export interface InboxResolveResult {
  ok: boolean;
  won: boolean;
  item?: InboxItem;
  resumed?: boolean;
  error?: string;
  winner?: {
    decision: InboxDecision;
    by: string;
    at: string;
  };
}

export interface DeferredInboxItem {
  id: string | number;
  name?: string;
  projectDir: string;
  runId?: string | null;
  status: "deferred";
  deferReason: string;
  notBefore?: string | null;
}

export interface InboxSourceCoverage {
  succeeded: number;
  failed: number;
}

export type InboxSource<T> =
  | {
      status: "complete";
      items: T[];
      error?: never;
      coverage?: InboxSourceCoverage;
    }
  | {
      status: "partial";
      items: T[];
      error: string;
      coverage: InboxSourceCoverage;
    }
  | {
      status: "unavailable";
      items: [];
      error: string;
      coverage?: InboxSourceCoverage;
    };

export interface InboxStaleItem {
  id: string;
  name: string;
  status: "stale";
  staleRunId?: string;
}

interface BriefPatch {
  type: "brief_patch";
  section: string;
  op: "append" | "replace_value" | "edit";
  value: string;
}

export interface PendingBriefReview {
  index: number;
  ts: string;
  campaignId: string;
  reason: string;
  severity?: "low" | "medium" | "high";
  patch: BriefPatch;
  patchSummary: string;
  source?: string;
  briefVersion?: string;
  fromVersion?: string;
  toVersion?: string;
  from_version?: string;
  to_version?: string;
  runId?: string;
}

export interface InboxPatchItem extends PendingBriefReview {
  campaignName: string;
  latestVersion?: string;
}

export interface InboxOverview {
  approvals: InboxSource<InboxItem>;
  deferred: InboxSource<DeferredInboxItem>;
  stale: InboxSource<InboxStaleItem>;
  patches: InboxSource<InboxPatchItem>;
  campaignCount: number | null;
}

export interface CampaignKGNode {
  id: string;
  type: string;
  label?: string;
  text?: string;
  score?: number;
  timestamp?: string;
  meta?: string;
  source?: string;
  runId?: string;
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

export interface RunStage {
  id: string;
  role: string;
  depends_on: string[];
  is_gate?: boolean;
  retry_to?: string[];
  status: string;
  duration_ms?: number | null;
  retries?: number;
  reruns?: number;
  attempts?: RunStageAttempt[];
  tokens_in?: number;
  tokens_out?: number;
  artifact_count?: number;
}

export interface RunStageAttempt {
  index: number;
  startedAt: string;
  completedAt?: string;
  status: "running" | "complete" | "failed";
  duration_ms?: number;
  exitCode?: number;
  tokens_in?: number;
  tokens_out?: number;
  error?: string;
  writes?: string[];
  writeAttribution?: "structured" | "snapshot" | "unknown";
}

export interface SupervisorAttempt {
  index: number;
  startedAt: string;
  completedAt: string;
  status: "complete" | "failed";
  duration_ms: number;
  exitCode: number;
  tokens_in?: number;
  tokens_out?: number;
  verdict?: string;
  error?: string;
}

export interface SupervisorUsage {
  status: "running" | "complete";
  calls: number;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  startedAt: string;
  completedAt?: string;
  attempts: SupervisorAttempt[];
}

export interface RunEvent {
  ts?: string;
  timestamp?: string;
  event?: string;
  type?: string;
  stage?: string;
  stageId?: string;
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
  realityGate?: RealityGateDiagnostics;
  taskDescriptionPreview?: string;
  campaignId?: string;
  stages: RunStage[];
  supervisor?: SupervisorUsage;
  kg: { nodes: CampaignKGNode[]; edges: CampaignKGEdge[] };
  events: RunEvent[];
  stage_outputs: Record<string, string>;
}

export interface RealityGateOutputTail {
  tail: string;
  sourceChars: number;
  capturedChars: number;
  truncated: boolean;
}

export interface RealityGateCheckDiagnostic {
  name: string;
  type: string;
  pass: boolean;
  advisory: boolean;
  details: string;
  stdout?: RealityGateOutputTail;
  stderr?: RealityGateOutputTail;
}

export interface RealityGateDiagnostics {
  pass: boolean;
  checkedAt: string;
  checksRun: number;
  results: RealityGateCheckDiagnostic[];
}

export interface BuildFingerprint {
  algorithm: "sha256";
  hash: string;
  files: number;
  newestMtimeMs: number;
}

export interface DashboardStatus {
  freshness: "fresh" | "stale" | "unverified";
  pid: number;
  startedAt: string;
  loadedBuild: BuildFingerprint | null;
  diskBuild: BuildFingerprint | null;
  diskIsNewer: boolean | null;
  reason?: string;
}

export interface BriefPreflightFinding {
  code: string;
  fingerprint: string;
  level: "ok" | "warn" | "fail";
  message: string;
  acknowledgementRequired: boolean;
  line?: number;
  excerpt?: string;
  risk?: string;
  suggestion?: string;
}

export interface BriefPreflightReport {
  version: 1;
  digest: string;
  inputKind: "brief" | "plain_text";
  frontmatter: { status: "absent" | "valid" | "invalid"; error?: string };
  contractReady: boolean;
  findings: BriefPreflightFinding[];
  requiresAcknowledgement: boolean;
}

export interface BriefPreflightResponse {
  report: BriefPreflightReport;
  receipt: string;
}

export interface BriefAdmissionSubmission {
  briefPreflightDigest: string;
  briefPreflightReceipt: string;
  acknowledgeBriefWarnings?: boolean;
}
