const BLOCKS = "▁▂▃▄▅▆▇█";

export default function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) return <span />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const chars = values.map(v => BLOCKS[Math.round(((v - min) / range) * 7)]).join("");
  return <span className="font-mono text-rc-accent">{chars}</span>;
}
