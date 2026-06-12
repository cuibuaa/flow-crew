import { useCallback } from "react";
import type { Campaign, CampaignKGEdge, CampaignKGNode, WorkspaceRun } from "../types";
import BriefRevisions from "./panels/BriefRevisions";
import CampaignKnowledge from "./panels/CampaignKnowledge";
import Header from "./panels/Header";
import KPIs from "./panels/KPIs";
import Phases from "./panels/Phases";
import RunsList from "./panels/RunsList";
import Trend from "./panels/Trend";

export default function Workspace({ campaign, kgNodes, onRunClick, onClickIterate }: { campaign: Campaign; kgNodes?: CampaignKGNode[]; kgEdges?: CampaignKGEdge[]; onRunClick?: (run: WorkspaceRun) => void; onClickIterate?: () => void }) {
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
      <CampaignKnowledge campaignId={campaign.id} nodes={kgNodes} phases={campaign.phases} />
      <RunsList runs={campaign.runs ?? []} metricFormat={campaign.metric?.format ?? "raw"} onRunClick={onRunClick} />
    </div>
  );
}
