import { formatMetric } from "../../lib/metric-format";
import { getCampaignRunTotal, type Campaign } from "../../types";

export default function KPIs({ campaign }: { campaign?: Partial<Campaign> | null }) {
  const safeCampaign = campaign ?? {};
  const metric = safeCampaign.metric;
  if (!metric) return null;
  const target = metric.target;
  const targetText = target ? `range ${target.min ?? "—"}-${target.max ?? "∞"}` : "no range set";
  const deltaText = target?.max != null && typeof metric.value === "number" ? `${targetText} · target delta ${(target.max - metric.value).toFixed(2)}` : targetText;
  return (
    <div className="kpis" data-testid="panel-kpis">
      <div className="kpi primary">
        <div className="label">Latest score · {metric.name || "metric"}</div>
        <div className="value">{formatMetric(metric.format, metric.value)}</div>
        <div className="sublabel">{metric.sublabel ?? deltaText}</div>
      </div>
      {safeCampaign.phases ? <div className="kpi"><div className="label">Phases</div><div className="value">{safeCampaign.phases.filter((p) => p?.status === "complete").length}/{safeCampaign.phases.length}</div><div className="sublabel">complete</div></div> : null}
      <div className="kpi"><div className="label">Runs</div><div className="value">{getCampaignRunTotal(safeCampaign)}</div><div className="sublabel">recorded</div></div>
    </div>
  );
}
