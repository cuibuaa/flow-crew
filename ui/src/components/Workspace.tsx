import CampaignPage from "./campaign/CampaignPage";
import type { CampaignOperatorView, CampaignRunPage, SourceResult } from "./campaign/types";

// Keep the former panel entry points importable for downstream component consumers.
// The operator page below intentionally does not mount this legacy presentation model.
export { default as LegacyBriefRevisions } from "./panels/BriefRevisions";
export { default as LegacyCampaignHeader } from "./panels/Header";
export { default as LegacyCampaignKPIs } from "./panels/KPIs";
export { default as LegacyCampaignPhases } from "./panels/Phases";
export { default as LegacyCampaignTrend } from "./panels/Trend";

export default function Workspace({
  view,
  refreshError,
  loadOlder,
}: {
  view: CampaignOperatorView;
  refreshError?: string | null;
  loadOlder?: (id: string, cursor: string) => Promise<SourceResult<CampaignRunPage>>;
}) {
  return <CampaignPage view={view} refreshError={refreshError} loadOlder={loadOlder} />;
}
