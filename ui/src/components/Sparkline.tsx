const BLOCKS = "▁▂▃▄▅▆▇█";
const DEFAULT_MAX_POINTS = 30;

export default function Sparkline({ values, maxPoints = DEFAULT_MAX_POINTS }: { values: number[]; maxPoints?: number }) {
  const visibleValues = maxPoints > 0 ? values.slice(-maxPoints) : values;
  if (visibleValues.length === 0) return <span />;
  const min = Math.min(...visibleValues);
  const max = Math.max(...visibleValues);
  const range = max - min || 1;
  const chars = visibleValues.map(v => BLOCKS[Math.round(((v - min) / range) * 7)]).join("");
  const title = values.length > visibleValues.length
    ? `Showing latest ${visibleValues.length} of ${values.length} scores`
    : `${visibleValues.length} score${visibleValues.length === 1 ? "" : "s"}`;
  return <span className="font-mono text-rc-accent" title={title}>{chars}</span>;
}
