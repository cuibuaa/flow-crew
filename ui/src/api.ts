import type { Task, StageDetail, Agent, PlanStage, SettingsData, CampaignSummary, CampaignEntry, CampaignTriggers, KnowledgeGraph, KGNode, KGEdge, TraceEvent, TraceSummary, M3CampaignSummary, M3CampaignIteration, M3CampaignRevision, M3PendingReview, M3KGSuggestion, Campaign, CampaignKGNode, CampaignKGEdge, RunDetailData, WorkspaceRun } from "./types";

const BASE = "/api";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json() as { error?: string };
      if (body?.error) msg = body.error;
    } catch { /* no JSON body */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return json<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch<T>(url: string, body: unknown): Promise<T> {
  return json<T>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface CreateTaskRequest {
  name: string;
  workflow: string;
  plan: PlanStage[];
  planFile?: string;
  campaignId?: string;
  campaignName?: string;
}

export interface UpdateTaskRequest {
  name?: string;
  timeoutMs?: number;
  maxIterations?: number;
  maxRetries?: number;
  autoApproveRetries?: boolean;
  campaignTriggers?: CampaignTriggers;
  campaignId?: string;
  campaignName?: string;
}

// Tasks
export const fetchTasks = () => json<Task[]>(`${BASE}/tasks`);
export const fetchTask = (id: string) => json<Task>(`${BASE}/tasks/${id}`);
export const createTask = (data: CreateTaskRequest) =>
  post<{ id: string }>(`${BASE}/tasks`, data);
export const updateTask = (id: string, data: UpdateTaskRequest) =>
  patch<Record<string, unknown>>(`${BASE}/tasks/${id}`, data);
export const executeTask = (id: string) => post<void>(`${BASE}/tasks/${id}/execute`, {});
export const deleteTask = (id: string) =>
  fetch(`${BASE}/tasks/${id}`, { method: 'DELETE' }).then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); });
export const cancelTask = (id: string) => post<void>(`${BASE}/tasks/${id}/cancel`, {});
export const rerunTask = (id: string) => post<{ ok: boolean; route: string }>(`${BASE}/tasks/${id}/rerun`, {});
export const renameTask = (id: string, name: string) => updateTask(id, { name });

// Stage rerun
export const rerunFromHere = (taskId: string, stageId: string) =>
  post<{ ok: boolean; reset: string[] }>(`${BASE}/tasks/${taskId}/stages/${stageId}/rerun`, {});
export const reevalGate = (taskId: string, stageId: string) =>
  post<{ ok: boolean }>(`${BASE}/tasks/${taskId}/stages/${stageId}/reeval`, {});

// Stages
export const fetchStageDetail = (taskId: string, stageId: string) =>
  json<StageDetail>(`${BASE}/tasks/${taskId}/stages/${stageId}`);

// Agents
export const fetchAgents = () => json<Agent[]>(`${BASE}/agents`);
export const fetchAgent = async (name: string): Promise<string> => {
  const res = await fetch(`${BASE}/agents/${name}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
};

// Settings
export const fetchSettings = () => json<SettingsData>(`${BASE}/settings`);

// Dispatch
export const fetchDispatch = (taskId: string) =>
  json<{ stages: PlanStage[]; status: string }>(`${BASE}/tasks/${taskId}/dispatch`);
export const approveDispatch = (taskId: string, body?: { autoApproveRetries?: boolean; maxIterations?: number; timeoutMs?: number }) =>
  post<{ ok: boolean }>(`${BASE}/tasks/${taskId}/approve`, body ?? {});
export const fetchIterationLog = (taskId: string) =>
  fetch(`${BASE}/tasks/${taskId}/iteration-log`).then(r => { if (!r.ok) return null; return r.text(); });
export interface StageOutputResponse {
  text: string;
  totalBytes: number | null;
  tailBytes: number | null;
  truncated: boolean;
}
function parseStageOutputResponse(r: Response): Promise<StageOutputResponse> {
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.text().then((text) => ({
    text,
    totalBytes: Number(r.headers.get("X-Output-Total-Bytes")) || null,
    tailBytes: Number(r.headers.get("X-Output-Tail-Bytes")) || null,
    truncated: r.headers.get("X-Output-Truncated") === "true",
  }));
}
function stageOutputQuery(opts?: { full?: boolean; tailBytes?: number }): string {
  const params = new URLSearchParams();
  if (opts?.full) params.set("tailBytes", "full");
  else if (opts?.tailBytes) params.set("tailBytes", String(opts.tailBytes));
  const query = params.toString();
  return query ? `?${query}` : "";
}
// Run-scoped stage output (workspace runs). Mirrors fetchStageOutput but hits the
// /runs/ endpoint; supports lazy tail + on-demand full load.
export const fetchRunStageOutput = (runId: string, stageId: string, opts?: { full?: boolean; tailBytes?: number }): Promise<StageOutputResponse> =>
  fetch(`${BASE}/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/output${stageOutputQuery(opts)}`).then(parseStageOutputResponse);
export const fetchStageOutput = (taskId: string, stageId: string, opts?: { full?: boolean; tailBytes?: number }): Promise<StageOutputResponse> => {
  const params = new URLSearchParams();
  if (opts?.full) params.set("tailBytes", "full");
  else if (opts?.tailBytes) params.set("tailBytes", String(opts.tailBytes));
  const query = params.toString();
  return fetch(`${BASE}/tasks/${taskId}/stages/${stageId}/output${query ? `?${query}` : ""}`).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return {
      text: await r.text(),
      totalBytes: Number(r.headers.get("X-Output-Total-Bytes")) || null,
      tailBytes: Number(r.headers.get("X-Output-Tail-Bytes")) || null,
      truncated: r.headers.get("X-Output-Truncated") === "true",
    };
  });
};

// Run campaign history used by task import and dashboard score summaries.
export const fetchRunCampaigns = () => json<CampaignSummary[]>(`${BASE}/run-campaigns`);
export const fetchRunCampaign = (id: string) => json<CampaignEntry[]>(`${BASE}/run-campaigns/${encodeURIComponent(id)}`);
export const renameRunCampaign = (campaignId: string, name: string) =>
  fetch(`${BASE}/run-campaigns/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId, name }) }).then(r => r.json());
export const deleteRunCampaign = (campaignId: string) =>
  fetch(`${BASE}/run-campaigns/${encodeURIComponent(campaignId)}`, { method: 'DELETE' }).then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<{ ok: boolean; orphaned: number; removedHistory: boolean }>; });

// M1/M2 filesystem campaigns shown by the M3 dashboard view.
export const fetchM3Campaigns = () => json<M3CampaignSummary[]>(`${BASE}/campaigns`);
export const fetchM3Campaign = (id: string) => json<M3CampaignSummary>(`${BASE}/campaigns/${encodeURIComponent(id)}`);
export const fetchM3CampaignIterations = (id: string) => json<M3CampaignIteration[]>(`${BASE}/campaigns/${encodeURIComponent(id)}/iterations`);
export const fetchM3CampaignRevisions = (id: string) => json<M3CampaignRevision[]>(`${BASE}/campaigns/${encodeURIComponent(id)}/revisions`);
export const fetchM3CampaignPendingReview = (id: string) => json<M3PendingReview[]>(`${BASE}/campaigns/${encodeURIComponent(id)}/pending-review`);
export const fetchM3CampaignKGHints = (id: string) => json<M3KGSuggestion[]>(`${BASE}/campaigns/${encodeURIComponent(id)}/kg-hints`);
export const reviewM3CampaignKGHint = (id: string, index: number) =>
  post<Record<string, unknown>>(`${BASE}/campaigns/${encodeURIComponent(id)}/kg-hints/${index}/review`, {});
export const reviewM3CampaignPatch = (id: string, index: number, decision: "accept" | "reject") =>
  post<Record<string, unknown>>(`${BASE}/campaigns/${encodeURIComponent(id)}/review/${index}`, { decision });
export const fetchM3CampaignBriefDiff = async (id: string, from: string, to: string): Promise<string> => {
  const res = await fetch(`${BASE}/campaigns/${encodeURIComponent(id)}/brief-diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
};

// Knowledge Graph
export const fetchKnowledgeGraph = (taskId: string) =>
  json<KnowledgeGraph>(`${BASE}/tasks/${taskId}/knowledge-graph`);
export const addKGNode = (taskId: string, node: { type: string; label: string; details?: string; source?: string; score?: number }) =>
  post<KGNode>(`${BASE}/tasks/${taskId}/knowledge-graph/nodes`, node);
export const updateKGNode = (taskId: string, nodeId: string, updates: { type?: string; label?: string; details?: string; score?: number }) =>
  patch<KGNode>(`${BASE}/tasks/${taskId}/knowledge-graph/nodes/${nodeId}`, updates);
export const deleteKGNode = (taskId: string, nodeId: string) =>
  fetch(`${BASE}/tasks/${taskId}/knowledge-graph/nodes/${nodeId}`, { method: 'DELETE' }).then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); });
export const addKGEdge = (taskId: string, edge: { from: string; to: string; type: string; label?: string }) =>
  post<KGEdge>(`${BASE}/tasks/${taskId}/knowledge-graph/edges`, edge);

// Execution Trace
export const fetchTrace = (taskId: string) =>
  json<{ events: TraceEvent[]; summary: TraceSummary }>(`${BASE}/tasks/${taskId}/trace`);
export const fetchStageTrace = (taskId: string, stageId: string) =>
  json<{ events: TraceEvent[]; summary: TraceSummary }>(`${BASE}/tasks/${taskId}/stages/${stageId}/trace`);

// Hierarchical Workspaces
export const fetchCampaigns = () => json<Campaign[]>(`${BASE}/campaigns`);
export const fetchCampaign = (id: string) => json<Campaign>(`${BASE}/campaigns/${encodeURIComponent(id)}`);
export const fetchCampaignKG = (id: string) => json<{ nodes: CampaignKGNode[]; edges: CampaignKGEdge[] }>(`${BASE}/campaigns/${encodeURIComponent(id)}/kg`);
export const fetchRunDetail = (id: string) => json<RunDetailData>(`${BASE}/runs/${encodeURIComponent(id)}`);
// Run summary markdown (summary.md, falls back to progress.md). Runs and tasks
// share runsRoot, so the /tasks/:id/summary endpoint resolves by run id too.
// Returns null when no summary exists yet (e.g. run still in progress → 404).
export const fetchRunSummary = (runId: string): Promise<string | null> =>
  fetch(`${BASE}/tasks/${encodeURIComponent(runId)}/summary`).then(async (r) => {
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return d && typeof d.content === "string" ? d.content : null;
  }).catch(() => null);
export const fetchCrossCampaignKGNodes = () => json<CampaignKGNode[]>(`${BASE}/cross-campaign-kg/nodes`);
export const fetchCrossCampaignKGEdges = () => json<CampaignKGEdge[]>(`${BASE}/cross-campaign-kg/edges`);
export const fetchStandaloneRuns = () => json<WorkspaceRun[]>(`${BASE}/standalone-runs`);
