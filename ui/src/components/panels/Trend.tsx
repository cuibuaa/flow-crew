import { formatMetric } from "../../lib/metric-format";
import type { Campaign } from "../../types";

export default function Trend({ campaign }: { campaign?: Partial<Campaign> | null }) {
  const safeCampaign = campaign ?? {};
  const iterations = (safeCampaign.iterations ?? []).filter(Boolean);
  if (iterations.length === 0) return null;
  const fmt = safeCampaign.metric?.format ?? "raw";
  const target = safeCampaign.metric?.target;
  const values = iterations.map((i) => Math.abs(i.value ?? 0));
  const max = Math.max(...values, target?.max ?? 0, target?.min ?? 0, 1);
  return (
    <div className="section" data-testid="panel-trend">
      <h2>Result trend <span className="h2-hint">{iterations.length} recorded outcomes</span></h2>
      <div className="trend-chart">
        {iterations.map((item, index) => {
          const value = item.value ?? 0;
          const width = Math.max(1, Math.abs(value) / max * 100);
          const left = target?.min == null ? 0 : Math.max(0, target.min / max * 100);
          const right = target?.max == null ? 0 : Math.max(0, 100 - target.max / max * 100);
          const verdict = item.verdict ?? "interim";
          return (
            <div className="trend-row" key={`${item.label}-${index}`}>
              <span className="label" title={item.label}>Result</span>
              <div className="bar-container">
                {target ? <div className="valid-range-band" data-testid="valid-range-band" style={{ left: `${left.toFixed(1)}%`, right: `${right.toFixed(1)}%` }} /> : null}
                <div className={`bar ${verdict}`} data-testid={`trend-bar-${verdict}`} style={{ width: `${width.toFixed(1)}%` }}>
                  <span className="bar-value">{formatMetric(fmt, item.value)}</span>
                </div>
              </div>
              <span className={`verdict ${verdict}`}>{verdict}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
