import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import {
  createTask,
  deleteRunCampaign,
  fetchStandaloneRuns,
  renameRunCampaign,
} from "../api";
import type { BriefAdmissionSubmission, Campaign, WorkspaceRun } from "../types";
import "../campaign-page.css";
import CampaignFilter, { type CampaignFilterValue } from "./CampaignFilter";
import CampaignIndex from "./campaign/CampaignIndex";
import {
  CampaignPageRequestError,
  fetchCampaignOperatorIndex,
  fetchCampaignOperatorView,
} from "./campaign/client";
import type {
  CampaignIndexRow,
  CampaignOperatorIndex,
  CampaignOperatorView,
  RunStatus,
} from "./campaign/types";
import NewRunModal, { type NewRunDraft } from "./NewRunModal";
import RunsList from "./panels/RunsList";
import Workspace from "./Workspace";
import { showToast } from "./Toast";

const CAMPAIGN_FILTER_STORAGE_KEY = "fc.campaignFilter";
const SIDEBAR_CAMPAIGNS_PER_PAGE = 24;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILTER_WINDOWS: Record<Exclude<CampaignFilterValue, "all">, number> = {
  active: 14 * DAY_MS,
  recent: 30 * DAY_MS,
};
const RUN_STATUSES = new Set<RunStatus>([
  "pending", "running", "parked", "complete", "failed", "awaiting_approval", "shipped",
  "ceiling_hit", "escalated", "reality_gate_failed", "phase_complete", "stopped", "incomplete",
]);

function normalizeStandaloneResult(value: { runs: WorkspaceRun[]; total: number } | WorkspaceRun[]): { runs: WorkspaceRun[]; total: number } {
  if (Array.isArray(value)) return { runs: value, total: value.length };
  if (!value || !Array.isArray(value.runs)) throw new Error("invalid standalone-runs response");
  return {
    runs: value.runs,
    total: typeof value.total === "number" && Number.isFinite(value.total) ? value.total : value.runs.length,
  };
}

function isCampaignFilterValue(value: string | null): value is CampaignFilterValue {
  return value === "active" || value === "recent" || value === "all";
}

function readInitialCampaignFilter(): CampaignFilterValue {
  if (typeof window === "undefined") return "active";
  const stored = window.localStorage.getItem(CAMPAIGN_FILTER_STORAGE_KEY);
  return isCampaignFilterValue(stored) ? stored : "active";
}

function indexRowMatchesFilter(campaign: CampaignIndexRow, filter: CampaignFilterValue, now = Date.now()): boolean {
  if (filter === "all") return true;
  if (campaign.activity.running > 0 || campaign.activity.waiting > 0) return true;
  const latest = campaign.latestStartedAt ? Date.parse(campaign.latestStartedAt) : Number.NaN;
  return Number.isFinite(latest) && latest >= now - FILTER_WINDOWS[filter];
}

function campaignStatus(value: string | undefined): RunStatus | null {
  return value && RUN_STATUSES.has(value as RunStatus) ? value as RunStatus : null;
}

function legacyIndex(campaigns: Campaign[]): CampaignOperatorIndex {
  const rows: CampaignIndexRow[] = campaigns.map((campaign) => {
    const runStatus = campaignStatus(campaign.status);
    const runs = campaign.runs ?? [];
    const running = runStatus === "running" || runs.some((run) => run.outcome === "running") ? 1 : 0;
    const waiting = runStatus === "pending" || runStatus === "parked" || runStatus === "awaiting_approval" ? 1 : 0;
    const latestStartedAt = campaign.latest_run_started_at
      ?? campaign.latestRunStartedAt
      ?? campaign.started_at
      ?? runs.map((run) => run.startedAt ?? run.started_at ?? null).filter(Boolean).sort().at(-1)
      ?? null;
    return {
      id: campaign.id,
      name: campaign.name,
      runCount: campaign.runs_total ?? runs.length,
      latestStartedAt,
      attention: { status: "complete", count: runStatus === "parked" ? 1 : 0 },
      activity: {
        status: "complete",
        running,
        waiting,
        summary: running ? "1 run is executing" : waiting ? "1 run is waiting or parked" : "No run is executing or waiting",
        needsIntervention: runStatus === "parked",
      },
      recent: {
        status: "complete",
        runStatus,
        statusExplanation: null,
        conclusion: runs[0]?.summary ?? "Outcome summary unavailable",
      },
      href: `/campaign/${encodeURIComponent(campaign.id)}`,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    campaigns: {
      status: "complete",
      value: { items: rows, total: rows.length },
      coverage: { succeeded: rows.length, failed: 0, total: rows.length },
    },
  };
}

export default function Workspaces({
  initialCampaigns,
  initialIndex,
  initialView,
}: {
  initialCampaigns?: Campaign[];
  initialIndex?: CampaignOperatorIndex;
  initialView?: CampaignOperatorView;
}) {
  const navigate = useNavigate();
  const params = useParams();
  const activeId = params.id;
  const seededIndex = initialIndex ?? (initialCampaigns ? legacyIndex(initialCampaigns) : null);
  const [index, setIndex] = useState<CampaignOperatorIndex | null>(seededIndex);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [view, setView] = useState<CampaignOperatorView | null>(initialView ?? null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [campaignFilter, setCampaignFilter] = useState<CampaignFilterValue>(readInitialCampaignFilter);
  const [sidebarPage, setSidebarPage] = useState(0);
  const [standaloneRuns, setStandaloneRuns] = useState<WorkspaceRun[]>([]);
  const [standaloneTotal, setStandaloneTotal] = useState(0);
  const [standaloneStatus, setStandaloneStatus] = useState("all");
  const [standaloneError, setStandaloneError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [defaultCampaignId, setDefaultCampaignId] = useState<string | undefined>();
  const [menuCampaign, setMenuCampaign] = useState<{ campaign: CampaignIndexRow; x: number; y: number } | null>(null);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteCampaign, setDeleteCampaign] = useState<CampaignIndexRow | null>(null);

  const loadIndex = useCallback(async () => {
    try {
      const next = await fetchCampaignOperatorIndex();
      setIndex(next);
      setIndexError(null);
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setIndexError(message);
      throw error;
    }
  }, []);

  useEffect(() => {
    if (seededIndex) return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchCampaignOperatorIndex();
        if (!cancelled) { setIndex(next); setIndexError(null); }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setIndexError(message);
          showToast(`Campaign index failed to load: ${message}`);
        }
      }
    };
    void load();
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    const onVisibility = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [seededIndex]);

  useEffect(() => {
    if (!activeId || activeId === "__standalone") {
      setView(null);
      setViewError(null);
      setNotFound(false);
      return;
    }
    if (initialView?.identity.id === activeId) return;
    if (initialCampaigns) return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchCampaignOperatorView(activeId);
        if (!cancelled) {
          setView(next);
          setViewError(null);
          setNotFound(false);
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof CampaignPageRequestError && error.status === 404) {
          setView(null);
          setNotFound(true);
          setViewError(null);
        } else {
          setViewError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    setNotFound(false);
    setView((current) => current?.identity.id === activeId ? current : null);
    void load();
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [activeId, initialCampaigns, initialView]);

  useEffect(() => {
    if (activeId !== "__standalone") return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = normalizeStandaloneResult(await fetchStandaloneRuns());
        if (!cancelled) {
          setStandaloneRuns(result.runs);
          setStandaloneTotal(result.total);
          setStandaloneError(null);
        }
      } catch (error) {
        if (!cancelled) setStandaloneError(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [activeId]);

  useEffect(() => {
    window.localStorage.setItem(CAMPAIGN_FILTER_STORAGE_KEY, campaignFilter);
    setSidebarPage(0);
  }, [campaignFilter]);

  useEffect(() => {
    const syncCampaignFilter = (event: StorageEvent) => {
      if (event.key !== CAMPAIGN_FILTER_STORAGE_KEY) return;
      setCampaignFilter(isCampaignFilterValue(event.newValue) ? event.newValue : "active");
    };
    window.addEventListener("storage", syncCampaignFilter);
    return () => window.removeEventListener("storage", syncCampaignFilter);
  }, []);

  const campaigns = index?.campaigns.value.items ?? [];
  const filteredCampaigns = useMemo(
    () => campaignFilter === "all" ? campaigns : campaigns.filter((campaign) => indexRowMatchesFilter(campaign, campaignFilter)),
    [campaignFilter, campaigns],
  );
  const hiddenCampaignCount = campaigns.length - filteredCampaigns.length;
  const visibleCampaigns = useMemo(() => {
    if (campaignFilter === "all" || !activeId || filteredCampaigns.some((campaign) => campaign.id === activeId)) return filteredCampaigns;
    const active = campaigns.find((campaign) => campaign.id === activeId);
    return active ? [...filteredCampaigns, active] : filteredCampaigns;
  }, [activeId, campaignFilter, campaigns, filteredCampaigns]);
  const sidebarPageCount = Math.max(1, Math.ceil(visibleCampaigns.length / SIDEBAR_CAMPAIGNS_PER_PAGE));
  const sidebarCampaigns = visibleCampaigns.slice(sidebarPage * SIDEBAR_CAMPAIGNS_PER_PAGE, (sidebarPage + 1) * SIDEBAR_CAMPAIGNS_PER_PAGE);
  useEffect(() => {
    const activeIndex = activeId ? visibleCampaigns.findIndex((campaign) => campaign.id === activeId) : -1;
    setSidebarPage((current) => activeIndex >= 0
      ? Math.floor(activeIndex / SIDEBAR_CAMPAIGNS_PER_PAGE)
      : Math.min(current, sidebarPageCount - 1));
  }, [activeId, sidebarPageCount, visibleCampaigns]);
  const standaloneCounts = useMemo(() => {
    const counts: Record<string, number> = { all: standaloneRuns.length, failed: 0, pending: 0, running: 0, parked: 0, complete: 0 };
    for (const run of standaloneRuns) counts[run.outcome ?? "pending"] = (counts[run.outcome ?? "pending"] ?? 0) + 1;
    return counts;
  }, [standaloneRuns]);
  const filteredStandaloneRuns = useMemo(() => standaloneStatus === "all" ? standaloneRuns : standaloneRuns.filter((run) => (run.outcome ?? "pending") === standaloneStatus), [standaloneRuns, standaloneStatus]);
  const campaignOptions: Campaign[] = useMemo(
    () => modalOpen
      ? campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name, status: "unknown", runs_total: campaign.runCount, runs: [] }))
      : [],
    [campaigns, modalOpen],
  );

  const beginRename = (campaign: CampaignIndexRow) => {
    setEditingCampaignId(campaign.id);
    setEditingName(campaign.name);
    setMenuCampaign(null);
  };

  const commitRename = async () => {
    const campaignId = editingCampaignId;
    const name = editingName.trim();
    if (!campaignId || !name) return;
    try {
      await renameRunCampaign(campaignId, name);
      setIndex((current) => current ? {
        ...current,
        campaigns: { ...current.campaigns, value: { ...current.campaigns.value, items: current.campaigns.value.items.map((campaign) => campaign.id === campaignId ? { ...campaign, name } : campaign) } },
      } : current);
      setView((current) => current?.identity.id === campaignId ? { ...current, identity: { ...current.identity, name } } : current);
      setEditingCampaignId(null);
      if (!seededIndex) void loadIndex().catch(() => {});
    } catch (error) {
      showToast(`Campaign rename failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const confirmDelete = async () => {
    if (!deleteCampaign) return;
    try {
      await deleteRunCampaign(deleteCampaign.id);
      const deletedId = deleteCampaign.id;
      setDeleteCampaign(null);
      setIndex((current) => current ? {
        ...current,
        campaigns: {
          ...current.campaigns,
          value: {
            items: current.campaigns.value.items.filter((campaign) => campaign.id !== deletedId),
            total: Math.max(0, current.campaigns.value.total - 1),
          },
        },
      } : current);
      if (activeId === deletedId) navigate("/campaign", { replace: true });
      if (!seededIndex) void loadIndex().catch(() => {});
    } catch (error) {
      showToast(`Campaign deletion failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const createRun = async (draft: NewRunDraft, admission: BriefAdmissionSubmission) => {
    const existingCampaign = draft.campaign !== "standalone" && draft.campaign !== "new" ? draft.campaign : undefined;
    const created = await createTask({
      brief: draft.brief,
      projectDir: draft.projectDir.trim() || undefined,
      workflow: draft.workflow,
      supervise: draft.supervise,
      maxIterations: draft.maxIter,
      noCampaign: draft.campaign === "standalone",
      campaignId: draft.campaign === "new" ? draft.campaignId : existingCampaign,
      campaignName: draft.campaign === "new" ? draft.campaignName : undefined,
      ...admission,
    });
    setModalOpen(false);
    setDefaultCampaignId(undefined);
    showToast(`Task ${created.id} is queued; the daemon will start it when the project is available.`, "success");
    if (!seededIndex) void loadIndex().catch(() => {});
  };

  const openMenu = (campaign: CampaignIndexRow, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setMenuCampaign({ campaign, x: Math.max(8, rect.right - 180), y: rect.bottom + 4 });
  };

  return (
    <>
      <div className="topbar">
        <div className="brand">FlowCrew</div>
        <div className="tabs">
          <NavLink className={({ isActive }) => `tab ${isActive ? "active" : ""}`} to="/inbox">Inbox</NavLink>
          <NavLink className={({ isActive }) => `tab ${isActive ? "active" : ""}`} to="/campaign">Workspaces</NavLink>
          <NavLink className={({ isActive }) => `tab ${isActive ? "active" : ""}`} to="/agents">Agents</NavLink>
          <NavLink className={({ isActive }) => `tab ${isActive ? "active" : ""}`} to="/settings">Settings</NavLink>
        </div>
        <div className="right"><button className="btn ghost" type="button" onClick={() => { void loadIndex().catch(() => {}); if (activeId && activeId !== "__standalone") void fetchCampaignOperatorView(activeId).then(setView).catch((error) => setViewError(error instanceof Error ? error.message : String(error))); }}>⟳ Refresh</button><button className="btn" type="button" onClick={() => { setDefaultCampaignId(undefined); setModalOpen(true); }}>+ New Run</button></div>
      </div>
      <div className="shell campaign-shell">
        <aside className="sidebar campaign-sidebar" data-testid="sidebar" aria-label="Campaign navigation">
          <div className="section-label">Campaigns ({campaigns.length})</div>
          <CampaignFilter value={campaignFilter} onChange={setCampaignFilter} hiddenCount={hiddenCampaignCount} />
          {indexError ? <p className="campaign-sidebar-error" role="alert">Index refresh failed</p> : null}
          <div role="tree" aria-label="Campaigns">
            {sidebarCampaigns.map((campaign) => editingCampaignId === campaign.id ? (
              <div className="campaign-sidebar-row" key={campaign.id}>
                <input
                  aria-label={`Rename ${campaign.name}`}
                  className="sidebar-rename-input"
                  value={editingName}
                  autoFocus
                  onChange={(event) => setEditingName(event.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") setEditingCampaignId(null);
                  }}
                />
              </div>
            ) : (
              <div className={`campaign-sidebar-row ${campaign.id === activeId ? "active" : ""}`} key={campaign.id} onContextMenu={(event) => { event.preventDefault(); setMenuCampaign({ campaign, x: event.clientX, y: event.clientY }); }}>
                <Link className="campaign-sidebar-link" data-testid="sidebar-item" role="treeitem" aria-selected={campaign.id === activeId} to={campaign.href}>{campaign.name}</Link>
                <button className="campaign-sidebar-actions" type="button" aria-label={`Manage campaign ${campaign.name}`} aria-haspopup="menu" onClick={(event) => openMenu(campaign, event.currentTarget)}>•••</button>
              </div>
            ))}
          </div>
          {sidebarPageCount > 1 ? (
            <nav className="campaign-sidebar-pagination" aria-label="Campaign navigation pages">
              <button type="button" aria-label="Previous campaign page" disabled={sidebarPage === 0} onClick={() => setSidebarPage((current) => current - 1)}>←</button>
              <span>{sidebarPage + 1}/{sidebarPageCount}</span>
              <button type="button" aria-label="Next campaign page" disabled={sidebarPage + 1 >= sidebarPageCount} onClick={() => setSidebarPage((current) => current + 1)}>→</button>
            </nav>
          ) : null}
          <div className="section-label standalone-label">Standalone</div>
          <Link className={`sidebar-item ${activeId === "__standalone" ? "active" : ""}`} to="/campaign/__standalone"><div className="title"><span className="sidebar-name"><span className="name">unattached runs</span></span>{standaloneTotal ? <span className="sidebar-count">{standaloneTotal}</span> : null}</div></Link>
        </aside>
        <main className="main campaign-main" data-testid="main">
          {!activeId ? (
            index ? <CampaignIndex index={index} onNewRun={() => { setDefaultCampaignId(undefined); setModalOpen(true); }} />
              : indexError ? <div className="campaign-index-error" role="alert" data-testid="workspace-load-error">Campaign index unavailable: {indexError}</div>
                : <div className="campaign-loading" role="status">Loading campaign index…</div>
          ) : activeId === "__standalone" ? (
            <div data-testid="standalone-view">
              <div className="campaign-header"><div><h1>Standalone runs</h1><div className="subtitle">{standaloneTotal} runs not attached to any campaign</div></div></div>
              {standaloneError ? <div className="error-state" role="alert">Standalone runs failed to load: {standaloneError}</div> : null}
              <div className="status-summary" data-testid="standalone-summary"><span>{standaloneCounts.failed} failed</span><span>{standaloneCounts.pending} pending</span><span>{standaloneCounts.running} running</span><span>{standaloneCounts.parked} parked</span></div>
              <div className="recent-count-hint">Status counts and filters cover the {standaloneRuns.length} most recent runs shown.</div>
              <div className="filter-chips" aria-label="Filter standalone runs by status">{["all", "failed", "pending", "running", "parked", "complete"].map((status) => <button className={`chip ${standaloneStatus === status ? "active" : ""}`} type="button" key={status} onClick={() => setStandaloneStatus(status)}>{status} {standaloneCounts[status] ?? 0}</button>)}</div>
              <RunsList runs={filteredStandaloneRuns} onRunClick={(run) => navigate(`/run/${encodeURIComponent(run.full_id ?? run.id)}`)} />
            </div>
          ) : notFound ? (
            <div className="campaign-not-found" data-testid="campaign-not-found">
              <div className="eyebrow">404 · CAMPAIGN NOT FOUND</div>
              <h1>Campaign not found</h1>
              <p>No readable campaign or run record exists for <code>{activeId}</code>.</p>
              <Link className="btn" to="/campaign">Return to campaign index</Link>
            </div>
          ) : view?.identity.id === activeId ? (
            <Workspace view={view} refreshError={viewError} />
          ) : viewError ? (
            <div className="campaign-detail-error" role="alert">Campaign details unavailable: {viewError} <Link to="/campaign">Return to index</Link></div>
          ) : <div className="campaign-loading" role="status">Loading campaign details…</div>}
        </main>
      </div>
      {menuCampaign ? (
        <div className="context-menu" role="menu" data-testid="campaign-context-menu" style={{ left: menuCampaign.x, top: menuCampaign.y }}>
          <button type="button" role="menuitem" onClick={() => { setDefaultCampaignId(menuCampaign.campaign.id); setModalOpen(true); setMenuCampaign(null); }}>New run in this campaign</button>
          <button type="button" role="menuitem" onClick={() => beginRename(menuCampaign.campaign)}>Rename campaign</button>
          <button type="button" role="menuitem" className="danger" onClick={() => { setDeleteCampaign(menuCampaign.campaign); setMenuCampaign(null); }}>Delete campaign</button>
        </div>
      ) : null}
      {deleteCampaign ? (
        <div className="modal-backdrop show" data-testid="delete-campaign-dialog">
          <div className="modal confirm-danger" role="dialog" aria-modal="true" aria-labelledby="delete-campaign-title">
            <h2 id="delete-campaign-title">Delete campaign</h2>
            <p>Move {deleteCampaign.runCount} runs to standalone?</p>
            <div className="footer"><button className="btn ghost" type="button" onClick={() => setDeleteCampaign(null)}>cancel</button><button className="btn danger" type="button" onClick={() => void confirmDelete()}>Delete campaign</button></div>
          </div>
        </div>
      ) : null}
      <NewRunModal open={modalOpen} campaigns={campaignOptions} defaultCampaignId={defaultCampaignId} onClose={() => setModalOpen(false)} onSubmit={createRun} />
    </>
  );
}
