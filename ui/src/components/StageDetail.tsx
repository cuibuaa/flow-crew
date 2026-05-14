import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { StageDetail as StageDetailType } from "../types";
import { fetchStageDetail, fetchStageOutput } from "../api";
import { useTasks } from "./Layout";
import AnsiOutput from "./AnsiOutput";

const OUTPUT_TAIL_BYTES = 200 * 1024;

function formatBytes(bytes: number | null) {
  if (bytes == null) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ArtifactsPanel({ artifacts }: { artifacts: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="glass-panel rounded-card shrink-0">
      <button onClick={() => setOpen(!open)} className="w-full text-left px-4 py-3 flex items-center gap-2">
        <span className="text-xs font-bold text-rc-muted uppercase tracking-wider">{open ? "▾" : "▸"} Artifacts</span>
        <span className="text-[10px] font-mono bg-rc-accent/20 text-rc-accent px-1.5 py-0.5 rounded">{artifacts.length}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 max-h-48 overflow-auto flex flex-wrap gap-2">
          {artifacts.map((a) => (
            <span key={a} className="text-xs font-mono text-rc-accent bg-rc-code px-2 py-1 rounded-input cursor-pointer hover:bg-rc-hover transition">{a}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StageDetail() {
  const { id, stageId } = useParams<{ id: string; stageId: string }>();
  const nav = useNavigate();
  const tasks = useTasks();
  const task = tasks.find((t) => t.id === id);
  const stage = task?.stages.find((s) => s.id === stageId);

  const [detail, setDetail] = useState<StageDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState('');
  const [outputMeta, setOutputMeta] = useState<{ totalBytes: number | null; tailBytes: number | null; truncated: boolean } | null>(null);
  const [outputLoading, setOutputLoading] = useState(false);
  const [fullOutputLoading, setFullOutputLoading] = useState(false);

  useEffect(() => {
    if (!id || !stageId) return;
    setOutput('');
    setOutputMeta(null);
    setOutputLoading(true);
    fetchStageOutput(id, stageId, { tailBytes: OUTPUT_TAIL_BYTES })
      .then((res) => {
        setOutput(res.text);
        setOutputMeta({ totalBytes: res.totalBytes, tailBytes: res.tailBytes, truncated: res.truncated });
      })
      .catch(() => {})
      .finally(() => setOutputLoading(false));
  }, [id, stageId]);

  const loadFullOutput = async () => {
    if (!id || !stageId || fullOutputLoading) return;
    setFullOutputLoading(true);
    try {
      const res = await fetchStageOutput(id, stageId, { full: true });
      setOutput(res.text);
      setOutputMeta({ totalBytes: res.totalBytes, tailBytes: res.tailBytes, truncated: res.truncated });
    } finally {
      setFullOutputLoading(false);
    }
  };

  useEffect(() => {
    if (!id || !stageId) return;
    fetchStageDetail(id, stageId)
      .then(setDetail)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [id, stageId]);

  if (!stage) return <div className="text-rc-muted">Stage not found</div>;
  if (loading) return <div className="text-rc-muted">Loading…</div>;
  if (error) return <div className="text-rc-error">Error: {error}</div>;

  return (
    <div className="flex flex-col h-full space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <span className="text-sm font-semibold text-rc-text">{stage.id}</span>
          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-input bg-rc-card text-rc-text-secondary font-mono">{stage.role}</span>
          <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-input ${
            { complete: "bg-rc-success/20 text-rc-success", running: "bg-rc-accent/20 text-rc-accent",
              failed: "bg-rc-error/20 text-rc-error", pending: "bg-rc-muted/20 text-rc-muted", skipped: "bg-rc-muted/20 text-rc-muted" }[stage.status]
          }`}>{stage.status}</span>
          <span className="text-xs text-rc-muted font-mono bg-rc-accent/10 text-rc-accent px-1.5 py-0.5 rounded-input">{((stage.duration_ms ?? 0) / 1000).toFixed(1)}s</span>
          {detail?.error && (
            <span className="text-xs text-rose-300 font-mono bg-rose-400/10 px-1.5 py-0.5 rounded-input">{detail.error}</span>
          )}
        </div>
        <button onClick={() => nav(`/task/${id}/monitor`)} className="btn-ghost px-3 py-1.5 text-sm border border-rc-border">← Back to Monitor</button>
      </div>

      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        <div className="glass-panel rounded-card p-4 overflow-auto">
          <h3 className="text-xs font-bold text-rc-muted uppercase tracking-wider mb-3">Input</h3>
          <pre className="text-xs font-mono text-rc-success whitespace-pre-wrap leading-relaxed">{detail?.input ?? ""}</pre>
        </div>
        <div className="glass-panel rounded-card p-4 overflow-hidden">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-bold text-rc-muted uppercase tracking-wider">Output</h3>
              <p className="mt-1 text-[10px] text-rc-muted font-mono">
                {outputLoading
                  ? "Loading output tail..."
                  : outputMeta?.truncated
                    ? `Showing last ${formatBytes(outputMeta.tailBytes)} of ${formatBytes(outputMeta.totalBytes)}`
                    : `Showing full output (${formatBytes(outputMeta?.totalBytes ?? null)})`}
              </p>
            </div>
            {outputMeta?.truncated && (
              <button
                onClick={loadFullOutput}
                disabled={fullOutputLoading}
                className="btn-ghost shrink-0 px-3 py-1.5 text-xs border border-rc-border disabled:opacity-50"
              >
                {fullOutputLoading ? "Loading..." : "Load full output"}
              </button>
            )}
          </div>
          <AnsiOutput content={output} className="h-[calc(100%-2rem)]" />
        </div>
      </div>

      {(stage.artifacts ?? []).length > 0 && (
        <ArtifactsPanel artifacts={stage.artifacts ?? []} />
      )}
    </div>
  );
}
