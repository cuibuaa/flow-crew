import CampaignPage from "./campaign/CampaignPage";
import type { CampaignOperatorView, CampaignRunPage, SourceResult } from "./campaign/types";


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
