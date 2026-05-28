import { useCallback } from "react";
import type { Campaign, CampaignKGEdge, CampaignKGNode, WorkspaceRun } from "../types";
import BriefRevisions from "./panels/BriefRevisions";
import CampaignKG from "./panels/CampaignKG";
import Header from "./panels/Header";
import KPIs from "./panels/KPIs";
import Phases from "./panels/Phases";
import RunsList from "./panels/RunsList";
import Trend from "./panels/Trend";

export default function Workspace({ campaign, kgNodes, kgEdges, onRunClick, onClickIterate }: { campaign: Campaign; kgNodes?: CampaignKGNode[]; kgEdges?: CampaignKGEdge[]; onRunClick?: (run: WorkspaceRun) => void; onClickIterate?: () => void }) {
  const viewBrief = useCallback(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="panel-brief-revisions"]');
    panel?.scrollIntoView({ behavior: "smooth", block: "start" });
    panel?.focus({ preventScroll: true });
  }, []);

  return (
    <div data-testid="workspace">
      <Header campaign={campaign} onViewBrief={viewBrief} onClickIterate={onClickIterate} />
      <KPIs campaign={campaign} />
      <Trend campaign={campaign} />
      <Phases phases={campaign.phases} />
      <BriefRevisions revisions={campaign.brief_revisions} />
      <CampaignKG campaignId={campaign.id} nodes={kgNodes} edges={kgEdges} emptyState="show" />
      <RunsList runs={campaign.runs ?? []} metricFormat={campaign.metric?.format ?? "raw"} onRunClick={onRunClick} />
    </div>
  );
}
