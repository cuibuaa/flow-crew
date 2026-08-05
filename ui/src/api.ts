import type {
  Agent,
  BriefAdmissionSubmission,
  BriefPreflightResponse,
  DashboardStatus,
  InboxDecision,
  InboxOverview,
  InboxResolveResult,
  RunDetailData,
  SettingsData,
  WorkspaceRun,
} from "./types";

const BASE = "/api";

async function errorMessage(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`.trim();
  try {
    const body = await response.clone().json() as { error?: string };
    return body?.error || fallback;
  } catch {
    return fallback;
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<T>;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  return responseJson<T>(await fetch(url, init));
}

function post<T>(url: string, body: unknown): Promise<T> {
  return json<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface CreateTaskRequest extends BriefAdmissionSubmission {
  brief: string;
  projectDir?: string;
  workflow: string;
  supervise: boolean;
  maxIterations: number;
  noCampaign?: boolean;
  campaignId?: string;
  campaignName?: string;
}

export class BriefAdmissionRequestError extends Error {
  readonly status: number;
  readonly preflight: BriefPreflightResponse;

  constructor(message: string, status: number, preflight: BriefPreflightResponse) {
    super(message);
    this.name = "BriefAdmissionRequestError";
    this.status = status;
    this.preflight = preflight;
  }
}

async function postWithBriefAdmission<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 409) {
    try {
      const responseBody = await response.clone().json() as Partial<BriefPreflightResponse> & { error?: string };
      if (responseBody.report && typeof responseBody.receipt === "string") {
        throw new BriefAdmissionRequestError(
          responseBody.error || "Brief review is required before starting.",
          response.status,
          { report: responseBody.report, receipt: responseBody.receipt },
        );
      }
    } catch (error) {
      if (error instanceof BriefAdmissionRequestError) throw error;
      // A non-admission 409 (for example project busy) keeps the normal API
      // error contract below; inspecting a clone leaves its body readable.
    }
  }
  return responseJson<T>(response);
}

export const preflightBrief = (brief: string) =>
  post<BriefPreflightResponse>(`${BASE}/brief-preflight`, { brief });

export const createTask = (data: CreateTaskRequest) =>
  postWithBriefAdmission<{ id: string; unit?: string }>(`${BASE}/tasks`, data);

export const cancelTask = (id: string) =>
  post<{ ok: boolean }>(`${BASE}/tasks/${encodeURIComponent(id)}/cancel`, {});

export const fetchAgents = () => json<Agent[]>(`${BASE}/agents`);

export const fetchSettings = () => json<SettingsData>(`${BASE}/settings`);

export const fetchDashboardStatus = () => json<DashboardStatus>(`${BASE}/dashboard/status`);

export interface StageOutputResponse {
  text: string;
  totalBytes: number | null;
  tailBytes: number | null;
  truncated: boolean;
}

function stageOutputQuery(options?: { full?: boolean; tailBytes?: number }): string {
  const params = new URLSearchParams();
  if (options?.full) params.set("tailBytes", "full");
  else if (options?.tailBytes) params.set("tailBytes", String(options.tailBytes));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const fetchRunStageOutput = async (
  runId: string,
  stageId: string,
  options?: { full?: boolean; tailBytes?: number },
): Promise<StageOutputResponse> => {
  const response = await fetch(
    `${BASE}/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/output${stageOutputQuery(options)}`,
  );
  if (!response.ok) throw new Error(await errorMessage(response));
  return {
    text: await response.text(),
    totalBytes: Number(response.headers.get("X-Output-Total-Bytes")) || null,
    tailBytes: Number(response.headers.get("X-Output-Tail-Bytes")) || null,
    truncated: response.headers.get("X-Output-Truncated") === "true",
  };
};

export const renameRunCampaign = (campaignId: string, name: string) =>
  post<{ ok: boolean; updated: number; name: string }>(`${BASE}/run-campaigns/rename`, { campaignId, name });

export const deleteRunCampaign = async (campaignId: string) =>
  responseJson<{ ok: boolean; orphaned: number; removedHistory: boolean }>(
    await fetch(`${BASE}/run-campaigns/${encodeURIComponent(campaignId)}`, { method: "DELETE" }),
  );

export const fetchRunDetail = (id: string) =>
  json<RunDetailData>(`${BASE}/runs/${encodeURIComponent(id)}`);

export const fetchRunSummary = async (runId: string): Promise<string | null> => {
  const response = await fetch(`${BASE}/tasks/${encodeURIComponent(runId)}/summary`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await errorMessage(response));
  let data: { content?: unknown } | null;
  try {
    data = await response.json() as { content?: unknown } | null;
  } catch {
    throw new Error("Run summary response was not valid JSON");
  }
  if (!data || typeof data.content !== "string") {
    throw new Error("Run summary response did not contain text content");
  }
  return data.content;
};

export const fetchStandaloneRuns = async (): Promise<{ runs: WorkspaceRun[]; total: number }> => {
  const response = await fetch(`${BASE}/standalone-runs`);
  const runs = await responseJson<WorkspaceRun[]>(response);
  const headerTotal = Number.parseInt(response.headers.get("X-Total-Count") ?? "", 10);
  return {
    runs,
    total: Number.isFinite(headerTotal) && headerTotal >= 0 ? headerTotal : runs.length,
  };
};

export const fetchInboxOverview = () => json<InboxOverview>(`${BASE}/inbox/overview`);

export const resolveInboxItem = (
  runId: string,
  requestId: string,
  body: { decision: InboxDecision; by?: string; reason?: string; always?: boolean }
    & Partial<BriefAdmissionSubmission>,
) => postWithBriefAdmission<InboxResolveResult>(
  `${BASE}/inbox/${encodeURIComponent(runId)}/${encodeURIComponent(requestId)}/resolve`,
  body,
);

export const reviewCampaignPatch = (campaignId: string, index: number, decision: "accept" | "reject") =>
  post<{ remaining: number; version?: string }>(
    `${BASE}/campaigns/${encodeURIComponent(campaignId)}/review/${index}`,
    { decision },
  );

export const fetchCampaignBriefDiff = async (campaignId: string, from: string, to: string): Promise<string> => {
  const response = await fetch(
    `${BASE}/campaigns/${encodeURIComponent(campaignId)}/brief-diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.text();
};
