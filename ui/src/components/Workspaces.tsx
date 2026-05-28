import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { deleteRunCampaign, fetchCampaigns, fetchCrossCampaignKGEdges, fetchCrossCampaignKGNodes, fetchStandaloneRuns, renameRunCampaign } from "../api";
import { formatMetric } from "../lib/metric-format";
import type { Campaign, CampaignKGEdge, CampaignKGNode, WorkspaceRun } from "../types";
import CampaignFilter, { type CampaignFilterValue } from "./CampaignFilter";
import NewRunModal from "./NewRunModal";
import RunsList from "./panels/RunsList";
import Workspace from "./Workspace";

const CAMPAIGN_FILTER_STORAGE_KEY = "fc.campaignFilter";
const DAY_MS = 24 * 60 * 60 * 1000;
const FILTER_WINDOWS: Record<Exclude<CampaignFilterValue, "all">, number> = {
  active: 14 * DAY_MS,
  recent: 30 * DAY_MS,
};

function statusDot(status: string): string {
  return status === "shipped" ? "shipped" : status === "running" ? "running" : status === "failed" ? "failed" : "idle";
}

function isCampaignFilterValue(value: string | null): value is CampaignFilterValue {
  return value === "active" || value === "recent" || value === "all";
}

function readInitialCampaignFilter(): CampaignFilterValue {
  if (typeof window === "undefined") return "active";
  const stored = window.localStorage.getItem(CAMPAIGN_FILTER_STORAGE_KEY);
  return isCampaignFilterValue(stored) ? stored : "active";
}

function latestRunStartedAt(campaign: Campaign): number | null {
  const direct = campaign.latest_run_started_at ?? campaign.latestRunStartedAt;
  const candidates = [
    direct,
    campaign.started_at,
    ...(campaign.runs ?? []).map((run) => run.started_at ?? run.startedAt),
  ];
  let latest: number | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const time = Date.parse(candidate);
    if (Number.isNaN(time)) continue;
    latest = latest === null ? time : Math.max(latest, time);
  }
  return latest;
}

function hasLiveRun(campaign: Campaign): boolean {
  if (campaign.status === "running" || campaign.status === "pending") return true;
  return (campaign.runs ?? []).some((run) => {
    const outcome = (run.outcome ?? "").toLowerCase();
    return outcome === "running" || outcome === "pending";
  });
}

function campaignMatchesFilter(campaign: Campaign, filter: CampaignFilterValue, now = Date.now()): boolean {
  if (filter === "all") return true;
  if (hasLiveRun(campaign)) return true;
  const latest = latestRunStartedAt(campaign);
  return latest !== null && latest >= now - FILTER_WINDOWS[filter];
}

export default function Workspaces({ initialCampaigns, initialKg }: { initialCampaigns?: Campaign[]; initialKg?: { nodes: CampaignKGNode[]; edges: CampaignKGEdge[] } }) {
  const navigate = useNavigate();
  const params = useParams();
  const [campaigns, setCampaigns] = useState<Campaign[]>(initialCampaigns ?? []);
  const [campaignFilter, setCampaignFilter] = useState<CampaignFilterValue>(readInitialCampaignFilter);
  const [kgNodes, setKgNodes] = useState<CampaignKGNode[]>(initialKg?.nodes ?? []);
  const [kgEdges, setKgEdges] = useState<CampaignKGEdge[]>(initialKg?.edges ?? []);
  const [standaloneRuns, setStandaloneRuns] = useState<WorkspaceRun[]>([]);
  const [standaloneStatus, setStandaloneStatus] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [defaultCampaignId, setDefaultCampaignId] = useState<string | undefined>();
  const [contextCampaign, setContextCampaign] = useState<{ campaign: Campaign; x: number; y: number } | null>(null);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteCampaign, setDeleteCampaign] = useState<Campaign | null>(null);

  const filteredCampaigns = useMemo(() => campaigns.filter((campaign) => campaignMatchesFilter(campaign, campaignFilter)), [campaignFilter, campaigns]);
  const hiddenCampaignCount = campaigns.length - filteredCampaigns.length;
  const activeId = params.id ?? filteredCampaigns[0]?.id ?? "__standalone";
  const visibleCampaigns = useMemo(() => campaigns.filter((campaign) => campaignMatchesFilter(campaign, campaignFilter) || campaign.id === activeId), [activeId, campaignFilter, campaigns]);

  useEffect(() => {
    if (initialCampaigns) return;
    let cancelled = false;
    const load = () => {
      fetchCampaigns().then((value) => { if (!cancelled) setCampaigns(value); }).catch(() => { if (!cancelled) setCampaigns([]); });
      fetchCrossCampaignKGNodes().then((value) => { if (!cancelled) setKgNodes(value); }).catch(() => { if (!cancelled) setKgNodes([]); });
      fetchCrossCampaignKGEdges().then((value) => { if (!cancelled) setKgEdges(value); }).catch(() => { if (!cancelled) setKgEdges([]); });
      fetchStandaloneRuns().then((value) => { if (!cancelled) setStandaloneRuns(value); }).catch(() => { if (!cancelled) setStandaloneRuns([]); });
    };
    load();
    const interval = window.setInterval(() => { if (!document.hidden) load(); }, 15000);
    const onVisibility = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [initialCampaigns]);

  useEffect(() => {
    window.localStorage.setItem(CAMPAIGN_FILTER_STORAGE_KEY, campaignFilter);
  }, [campaignFilter]);

  useEffect(() => {
    const syncCampaignFilter = (event: StorageEvent) => {
      if (event.key !== CAMPAIGN_FILTER_STORAGE_KEY) return;
      setCampaignFilter(isCampaignFilterValue(event.newValue) ? event.newValue : "active");
    };
    window.addEventListener("storage", syncCampaignFilter);
    return () => window.removeEventListener("storage", syncCampaignFilter);
  }, []);

  useEffect(() => {
    if (!params.id && filteredCampaigns[0]?.id) navigate(`/campaign/${encodeURIComponent(filteredCampaigns[0].id)}`, { replace: true });
  }, [filteredCampaigns, navigate, params.id]);

  const activeCampaign = useMemo(() => campaigns.find((campaign) => campaign.id === activeId), [activeId, campaigns]);
  const standaloneCounts = useMemo(() => {
    const counts: Record<string, number> = { all: standaloneRuns.length, failed: 0, pending: 0, running: 0, complete: 0 };
    for (const run of standaloneRuns) counts[run.outcome ?? "pending"] = (counts[run.outcome ?? "pending"] ?? 0) + 1;
    return counts;
  }, [standaloneRuns]);
  const filteredStandaloneRuns = useMemo(() => standaloneStatus === "all" ? standaloneRuns : standaloneRuns.filter((run) => (run.outcome ?? "pending") === standaloneStatus), [standaloneRuns, standaloneStatus]);
  const openRun = (run: WorkspaceRun) => navigate(`/run/${encodeURIComponent(run.full_id ?? run.id)}`);
  const beginRename = (campaign: Campaign) => {
    setEditingCampaignId(campaign.id);
    setEditingName(campaign.name ?? campaign.id);
    setContextCampaign(null);
  };
  const commitRename = async () => {
    const campaignId = editingCampaignId;
    const name = editingName.trim();
    setEditingCampaignId(null);
    if (!campaignId || !name) return;
    await renameRunCampaign(campaignId, name);
    setCampaigns((items) => items.map((item) => item.id === campaignId ? { ...item, name } : item));
    if (!initialCampaigns) fetchCampaigns().then(setCampaigns).catch(() => undefined);
  };
  const confirmDelete = async () => {
    const campaign = deleteCampaign;
    if (!campaign) return;
    await deleteRunCampaign(campaign.id);
    setDeleteCampaign(null);
    setCampaigns((items) => items.filter((item) => item.id !== campaign.id));
    fetchStandaloneRuns().then(setStandaloneRuns).catch(() => undefined);
    if (activeId === campaign.id) {
      const next = campaigns.find((item) => item.id !== campaign.id)?.id;
      navigate(next ? `/campaign/${encodeURIComponent(next)}` : "/campaign/__standalone", { replace: true });
    }
    if (!initialCampaigns) fetchCampaigns().then(setCampaigns).catch(() => undefined);
  };
  return (
    <>
      <div className="topbar">
        <div className="brand">FlowCrew</div>
        <div className="tabs">
          <NavLink className={({ isActive }) => `tab ${isActive ? "active" : ""}`} to="/campaign">Workspaces</NavLink>
          <NavLink className={({ isActive }) => `tab ${isActive ? "active" : ""}`} to="/agents">Agents</NavLink>
          <NavLink className={({ isActive }) => `tab ${isActive ? "active" : ""}`} to="/settings">Settings</NavLink>
        </div>
        <div className="right"><button className="btn ghost" type="button" onClick={() => window.location.reload()}>⟳ rebuild</button><button className="btn" type="button" onClick={() => { setDefaultCampaignId(undefined); setModalOpen(true); }}>+ New Run</button></div>
      </div>
      <div className="shell">
        <aside className="sidebar" data-testid="sidebar">
          <div className="section-label">Campaigns ({campaigns.length})</div>
          <CampaignFilter value={campaignFilter} onChange={setCampaignFilter} hiddenCount={hiddenCampaignCount} />
          {visibleCampaigns.map((campaign) => (
            editingCampaignId === campaign.id ? (
              <div className={`sidebar-item ${campaign.id === activeId ? "active" : ""}`} data-testid="sidebar-item" key={campaign.id} role="treeitem" aria-selected={campaign.id === activeId}>
                <input
                  aria-label={`Rename ${campaign.name ?? campaign.id}`}
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
              <Link
                className={`sidebar-item ${campaign.id === activeId ? "active" : ""}`}
                data-testid="sidebar-item"
                key={campaign.id}
                role="treeitem"
                aria-selected={campaign.id === activeId}
                to={`/campaign/${encodeURIComponent(campaign.id)}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextCampaign({ campaign, x: event.clientX, y: event.clientY });
                }}
              >
                <div className="title"><span className="sidebar-name"><span className={`status-dot ${statusDot(campaign.status)}`} /> <span className="name" title={campaign.id}>{campaign.name}</span></span>{campaign.metric ? <span className="sidebar-metric"><span>{campaign.metric.name || "metric"}</span><span className="mono">{formatMetric(campaign.metric.format, campaign.metric.value)}</span></span> : <span className="sidebar-count"><span>runs</span><span className="mono">{campaign.runs?.length ?? 0}</span></span>}</div>
                <div className="meta"><span className="mono">{campaign.runs?.length ?? 0} runs</span><span>{campaign.status}</span></div>
              </Link>
            )
          ))}
          <div className="section-label standalone-label">Standalone</div>
          <Link className={`sidebar-item ${activeId === "__standalone" ? "active" : ""}`} to="/campaign/__standalone"><div className="title"><span className="sidebar-name"><span className="status-dot idle" /><span className="name">unattached runs</span></span><span className="sidebar-count">{standaloneRuns.length}</span></div></Link>
        </aside>
        <main className="main" data-testid="main">
          {activeId === "__standalone" ? (
            <div data-testid="standalone-view">
              <div className="campaign-header"><div><h1>Standalone runs</h1><div className="subtitle">{standaloneRuns.length} runs not attached to any campaign</div></div></div>
              <div className="status-summary" data-testid="standalone-summary">
                <span>{standaloneCounts.failed} failed</span>
                <span>{standaloneCounts.pending} pending</span>
                <span>{standaloneCounts.running} running</span>
              </div>
              <div className="filter-chips" aria-label="Filter standalone runs by status">
                {["all", "failed", "pending", "running", "complete"].map((status) => (
                  <button className={`chip ${standaloneStatus === status ? "active" : ""}`} type="button" key={status} onClick={() => setStandaloneStatus(status)}>{status} {standaloneCounts[status] ?? 0}</button>
                ))}
              </div>
              <RunsList runs={filteredStandaloneRuns} onRunClick={openRun} />
            </div>
          ) : activeCampaign ? (
            <Workspace
              campaign={activeCampaign}
              kgNodes={kgNodes}
              kgEdges={kgEdges}
              onRunClick={openRun}
              onClickIterate={() => {
                setDefaultCampaignId(activeCampaign.id);
                setModalOpen(true);
              }}
            />
          ) : <div className="empty-state">no campaign selected</div>}
        </main>
      </div>
      {contextCampaign ? (
        <div className="context-menu" role="menu" data-testid="campaign-context-menu" style={{ left: contextCampaign.x, top: contextCampaign.y }}>
          <button type="button" role="menuitem" onClick={() => beginRename(contextCampaign.campaign)}>Rename campaign</button>
          <button type="button" role="menuitem" className="danger" onClick={() => { setDeleteCampaign(contextCampaign.campaign); setContextCampaign(null); }}>Delete campaign</button>
        </div>
      ) : null}
      {deleteCampaign ? (
        <div className="modal-backdrop show" data-testid="delete-campaign-dialog">
          <div className="modal confirm-danger" role="dialog" aria-modal="true" aria-labelledby="delete-campaign-title">
            <h2 id="delete-campaign-title">Delete campaign</h2>
            <p>Move {deleteCampaign.runs?.length ?? 0} runs to standalone?</p>
            <div className="footer">
              <button className="btn ghost" type="button" onClick={() => setDeleteCampaign(null)}>cancel</button>
              <button className="btn danger" type="button" onClick={() => void confirmDelete()}>Delete campaign</button>
            </div>
          </div>
        </div>
      ) : null}
      <NewRunModal open={modalOpen} campaigns={campaigns} defaultCampaignId={defaultCampaignId} onClose={() => setModalOpen(false)} />
    </>
  );
}
