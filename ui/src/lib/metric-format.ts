import type { MetricFormat } from "../types";

export const FMT: Record<MetricFormat, (v: number | null | undefined) => string> = {
  currency_usd: (v) => v == null ? "—" : "$" + v.toLocaleString("en-US", { maximumFractionDigits: 2 }),
  rating_0_to_10: (v) => v == null ? "—" : v.toFixed(1) + " / 10",
  pct: (v) => v == null ? "—" : v.toFixed(1) + "%",
  count: (v) => v == null ? "—" : String(v),
  duration_min: (v) => v == null ? "—" : v + "m",
  raw: (v) => v == null ? "—" : String(v),
};

export function formatMetric(format: MetricFormat | undefined, value: number | null | undefined): string {
  return FMT[format ?? "raw"](value);
}
