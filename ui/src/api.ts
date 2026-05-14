import type { Task, StageDetail, Agent, Message, PlanStage, SettingsData, CampaignSummary, CampaignEntry, CampaignTriggers, KnowledgeGraph, KGNode, KGEdge, TraceEvent, TraceSummary } from "./types";

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
  discussion: Message[];
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

// WebSocket helpers
function getWsBase(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

export const discussWsUrl = (taskId: string) =>
  `${getWsBase()}/api/discuss/ws?taskId=${encodeURIComponent(taskId)}`;

// Discussion & Plan
export const generatePlan = (taskId: string) =>
  post<PlanStage[]>(`${BASE}/plan`, { taskId });

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

// Campaigns
export const fetchCampaigns = () => json<CampaignSummary[]>(`${BASE}/campaigns`);
export const fetchCampaign = (id: string) => json<CampaignEntry[]>(`${BASE}/campaigns/${id}`);
export const renameCampaign = (campaignId: string, name: string) =>
  fetch(`${BASE}/campaigns/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId, name }) }).then(r => r.json());

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
