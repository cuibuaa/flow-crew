import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { KGNode, KGEdge, KnowledgeGraph as KnowledgeGraphData, TraceEvent } from "../types";
import { fetchKnowledgeGraph, addKGNode, updateKGNode, deleteKGNode, fetchTrace } from "../api";
import { useNavigate } from "react-router-dom";
import { type SimNode, NODE_COLORS, NODE_ICONS, edgeEndpoints, layoutNodesClustered, runSimulation, separateNodeOverlaps, truncate, filterByTime } from "./kg-utils";

const GRAPH_WIDTH = 800;
const GRAPH_HEIGHT = 600;
const NODE_TYPES = Object.keys(NODE_COLORS);

function graphSizeForNodeCount(count: number) {
  if (count <= 0) return { width: GRAPH_WIDTH, height: GRAPH_HEIGHT };
  const columns = Math.max(4, Math.ceil(Math.sqrt(count * 1.45)));
  const rows = Math.max(3, Math.ceil(count / columns));
  return {
    width: Math.max(GRAPH_WIDTH, columns * 170),
    height: Math.max(GRAPH_HEIGHT, rows * 130),
  };
}

export default function KnowledgeGraph({ taskId }: { taskId: string }) {
  const nav = useNavigate();
  const [kg, setKg] = useState<KnowledgeGraphData | null>(null);
  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<KGNode | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: KGNode } | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [hintLabel, setHintLabel] = useState("");
  const [hintDetails, setHintDetails] = useState("");
  const [timeSlider, setTimeSlider] = useState(100);
  const [dragId, setDragId] = useState<string | null>(null);
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(() => new Set(NODE_TYPES));
  const svgRef = useRef<SVGSVGElement>(null);
  const positionsRef = useRef(new Map<string, Pick<SimNode, "x" | "y" | "vx" | "vy">>());
  const graphSize = useMemo(() => graphSizeForNodeCount(kg?.nodes.length ?? 0), [kg?.nodes.length]);

  useEffect(() => {
    positionsRef.current.clear();
    setSimNodes([]);
    setSelectedNode(null);
  }, [taskId]);

  // Fetch KG data with polling
  useEffect(() => {
    let active = true;
    const load = () => {
      fetchKnowledgeGraph(taskId).then(d => { if (active) setKg(d); }).catch(() => {});
      fetchTrace(taskId).then(d => { if (active) setTraceEvents(d.events); }).catch(() => {});
    };
    load();
    const interval = setInterval(load, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [taskId]);

  useEffect(() => {
    positionsRef.current = new Map(simNodes.map(n => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }]));
  }, [simNodes]);

  useEffect(() => {
    if (!kg) return;
    setSelectedNode(prev => prev ? kg.nodes.find(n => n.id === prev.id) ?? null : null);
  }, [kg]);

  // Build graph layout when KG data changes. Existing coordinates are kept so
  // polling does not erase manual drag adjustments.
  useEffect(() => {
    if (!kg || kg.nodes.length === 0) { setSimNodes([]); return; }
    const existing = positionsRef.current;
    const hadExistingLayout = existing.size > 0;
    const nodes: SimNode[] = kg.nodes.map((n, i) => {
      const pos = existing.get(n.id);
      if (pos) return { ...n, x: pos.x, y: pos.y, vx: 0, vy: 0 };
      const angle = i * 2.4;
      const radius = 130 + (i % 5) * 28;
      return {
        ...n,
        x: graphSize.width / 2 + (Math.cos(angle) * radius),
        y: graphSize.height / 2 + (Math.sin(angle) * Math.min(radius, 190)),
        vx: 0,
        vy: 0,
      };
    });
    if (!hadExistingLayout && nodes.length > 80) {
      layoutNodesClustered(nodes, graphSize.width, graphSize.height);
      separateNodeOverlaps(nodes, graphSize.width, graphSize.height, 0.7, 12, { minX: 104, minY: 52 });
    }
    else if (!hadExistingLayout) runSimulation(nodes, kg.edges, graphSize.width, graphSize.height);
    else if (nodes.length !== existing.size) separateNodeOverlaps(nodes, graphSize.width, graphSize.height, 1.0, 20, { minX: 104, minY: 52 });
    setSimNodes(nodes);
  }, [kg, graphSize]);

  // Time/type-filtered nodes/edges
  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (!kg) return { visibleNodes: [] as SimNode[], visibleEdges: [] as KGEdge[] };
    const timeFiltered = filterByTime(simNodes, kg.edges, timeSlider);
    const nodes = timeFiltered.visibleNodes.filter(n => selectedTypes.has(n.type));
    const visibleIds = new Set(nodes.map(n => n.id));
    const edges = timeFiltered.visibleEdges.filter(e => {
      const endpoints = edgeEndpoints(e);
      return Boolean(endpoints.from && endpoints.to && visibleIds.has(endpoints.from) && visibleIds.has(endpoints.to));
    });
    return { visibleNodes: nodes, visibleEdges: edges };
  }, [simNodes, kg, timeSlider, selectedTypes]);

  const nodeTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of kg?.nodes ?? []) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    return counts;
  }, [kg]);

  const nodeMap = useMemo(() => new Map(visibleNodes.map(n => [n.id, n])), [visibleNodes]);

  const toggleType = useCallback((type: string) => {
    setSelectedTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const handleCtxAction = useCallback(async (action: "dead_end" | "delete") => {
    if (!ctxMenu) return;
    const node = ctxMenu.node;
    setCtxMenu(null);
    try {
      if (action === "dead_end") {
        await updateKGNode(taskId, node.id, { type: "dead_end" });
      } else {
        await deleteKGNode(taskId, node.id);
        if (selectedNode?.id === node.id) setSelectedNode(null);
      }
      const d = await fetchKnowledgeGraph(taskId);
      setKg(d);
    } catch { /* ignore */ }
  }, [ctxMenu, taskId, selectedNode]);

  const handleAddHint = useCallback(async () => {
    if (!hintLabel.trim()) return;
    try {
      await addKGNode(taskId, { type: "user_hint", label: hintLabel, details: hintDetails || undefined });
      const d = await fetchKnowledgeGraph(taskId);
      setKg(d);
    } catch { /* ignore */ }
    setHintLabel(""); setHintDetails(""); setShowAddDialog(false);
  }, [taskId, hintLabel, hintDetails]);

  const handleSvgMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragId || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * graphSize.width;
    const y = ((e.clientY - rect.top) / rect.height) * graphSize.height;
    setSimNodes(prev => prev.map(n => n.id === dragId ? { ...n, x, y } : n));
  }, [dragId, graphSize]);

  const handleSvgMouseUp = useCallback(() => setDragId(null), []);

  return (
    <div className="flex h-full min-h-[700px]" onClick={() => setCtxMenu(null)}>
      {/* Left sidebar */}
      <div className="w-[240px] shrink-0 border-r border-rc-border bg-rc-card overflow-y-auto p-3 space-y-4">
        <button onClick={() => nav(`/task/${taskId}/monitor`)} className="text-xs text-rc-muted hover:text-rc-text">Back to Monitor</button>
        <div>
          <h3 className="text-[10px] uppercase tracking-widest text-rc-muted mb-2">Score</h3>
          {kg?.metadata.bestScore != null && (
            <div className="text-sm text-rc-text">{kg.metadata.metricName ?? "Score"}: <span className="text-emerald-400 font-semibold">{kg.metadata.bestScore}</span></div>
          )}
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[10px] uppercase tracking-widest text-rc-muted">Types</h3>
            <div className="flex gap-2 text-[10px]">
              <button className="text-rc-accent hover:underline" onClick={() => setSelectedTypes(new Set(NODE_TYPES))}>All</button>
              <button className="text-rc-muted hover:text-rc-text" onClick={() => setSelectedTypes(new Set())}>None</button>
            </div>
          </div>
          <div className="space-y-1">
            {Object.entries(NODE_COLORS).map(([type, color]) => (
              <label key={type} className={`flex items-center gap-2 text-xs cursor-pointer rounded px-1.5 py-1 ${selectedTypes.has(type) ? "text-rc-text hover:bg-rc-bg/50" : "text-rc-muted opacity-70 hover:bg-rc-bg/30"}`}>
                <input
                  type="checkbox"
                  checked={selectedTypes.has(type)}
                  onChange={() => toggleType(type)}
                  className="h-3 w-3 accent-rc-accent"
                />
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
                <span className="truncate">{NODE_ICONS[type]} {type}</span>
                <span className="ml-auto text-[10px] text-rc-muted">{nodeTypeCounts.get(type) ?? 0}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <h3 className="text-[10px] uppercase tracking-widest text-rc-muted mb-2">Nodes ({visibleNodes.length})</h3>
          <div className="space-y-1">
            {visibleNodes.map(n => (
              <div key={n.id} onClick={() => setSelectedNode(n)}
                className={`text-xs px-2 py-1 rounded cursor-pointer truncate ${selectedNode?.id === n.id ? "bg-rc-bg text-rc-text" : "text-rc-muted hover:bg-rc-bg/50"}`}>
                {NODE_ICONS[n.type]} {n.label}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Center: SVG graph */}
      <div className="flex-1 flex flex-col min-w-0 bg-rc-bg">
        <div className="flex-1 relative overflow-auto"
          onDoubleClick={(e) => { if ((e.target as HTMLElement).tagName === "DIV") setShowAddDialog(true); }}>
          <svg
            ref={svgRef}
            className="block"
            style={{ width: graphSize.width, height: graphSize.height, minWidth: graphSize.width, minHeight: graphSize.height }}
            viewBox={`0 0 ${graphSize.width} ${graphSize.height}`}
            preserveAspectRatio="xMinYMin meet"
            onMouseMove={handleSvgMouseMove} onMouseUp={handleSvgMouseUp} onMouseLeave={handleSvgMouseUp}
            onDoubleClick={(e) => { if (e.target === svgRef.current) setShowAddDialog(true); }}>
            {/* Edges */}
            {visibleEdges.map((e, i) => {
              const endpoints = edgeEndpoints(e);
              const from = endpoints.from ? nodeMap.get(endpoints.from) : undefined;
              const to = endpoints.to ? nodeMap.get(endpoints.to) : undefined;
              if (!from || !to) return null;
              const strong = e.type === "supports" || e.type === "measured_as";
              return <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke={strong ? "#58a6ff" : "#30363d"} strokeWidth={strong ? 2.5 : 1.5} opacity={0.7} />;
            })}
            {/* Nodes */}
            {visibleNodes.map(n => {
              const color = NODE_COLORS[n.type] ?? "#8b949e";
              const selected = selectedNode?.id === n.id;
              return (
                <g key={n.id} transform={`translate(${n.x},${n.y})`} className="cursor-grab"
                  onMouseDown={(e) => { if (e.button === 0) setDragId(n.id); }}
                  onClick={(e) => { e.stopPropagation(); setSelectedNode(n); }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, node: n }); }}>
                  <rect x={-55} y={-28} width={110} height={56} rx={8}
                    fill={color + "22"} stroke={color} strokeWidth={selected ? 2.5 : 1.5}
                    filter={selected ? "url(#glow)" : undefined} />
                  <text y={-6} textAnchor="middle" fontSize={14} fill="#fff">{NODE_ICONS[n.type]}</text>
                  <text y={12} textAnchor="middle" fontSize={10} fill="#e1e4e8">{truncate(n.label)}</text>
                  {n.score != null && (
                    <text y={24} textAnchor="middle" fontSize={9} fill="#3fb950">{n.score}</text>
                  )}
                </g>
              );
            })}
            <defs>
              <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            </defs>
          </svg>
          {kg && visibleNodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="rounded-lg border border-rc-border bg-rc-card/90 px-4 py-3 text-xs text-rc-muted">
                No nodes match the current time/type filters.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-rc-border bg-rc-card px-4 py-2 flex items-center gap-4 text-xs text-rc-muted">
          <span>Time:</span>
          <input type="range" min={0} max={100} value={timeSlider} onChange={e => setTimeSlider(Number(e.target.value))} className="w-48" />
          <span>{timeSlider}%</span>
          <span>Nodes: <b className="text-rc-text">{visibleNodes.length}</b></span>
          <span>Edges: <b className="text-rc-text">{visibleEdges.length}</b></span>
          <button onClick={() => setShowAddDialog(true)} className="ml-auto text-rc-accent hover:underline">+ Add hint</button>
        </div>
      </div>

      {/* Right sidebar */}
      <div className="w-[300px] shrink-0 border-l border-rc-border bg-rc-card overflow-y-auto p-3 space-y-4">
        <h3 className="text-[10px] uppercase tracking-widest text-rc-muted">Node Details</h3>
        {selectedNode ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">{NODE_ICONS[selectedNode.type]}</span>
              <span className="text-sm font-semibold text-rc-text">{selectedNode.label}</span>
            </div>
            <span className="inline-block rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider text-white" style={{ background: NODE_COLORS[selectedNode.type] + "55", border: `1px solid ${NODE_COLORS[selectedNode.type]}` }}>
              {selectedNode.type}
            </span>
            {selectedNode.details && <p className="text-xs text-rc-muted leading-relaxed">{selectedNode.details}</p>}
            {selectedNode.score != null && <div className="text-xs text-rc-text">Score: <span className="text-emerald-400 font-semibold">{selectedNode.score}</span></div>}
            {selectedNode.source && <div className="text-xs"><a href={selectedNode.source} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all">{selectedNode.source}</a></div>}
            <div className="text-[10px] text-rc-muted">{new Date(selectedNode.timestamp).toLocaleString()}</div>
          </div>
        ) : (
          <p className="text-xs text-rc-muted">Click a node to see details</p>
        )}
        {kg && (
          <div>
            <h3 className="text-[10px] uppercase tracking-widest text-rc-muted mb-2">Graph Info</h3>
            <div className="text-xs text-rc-muted space-y-1">
              <div>Updated: {new Date(kg.metadata.updatedAt).toLocaleString()}</div>
              {kg.metadata.metricName && <div>Metric: {kg.metadata.metricName}</div>}
            </div>
          </div>
        )}
        {/* Execution Trace Timeline */}
        <div className="mt-4">
          <h3 className="text-xs uppercase text-rc-muted mb-2">Execution Trace</h3>
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {traceEvents.slice(-20).map((evt, i) => (
              <div key={i} className={`text-xs p-1.5 rounded border-l-2 ${
                evt.type === 'llm_call' ? 'border-l-blue-400 bg-blue-500/5' :
                evt.type === 'web_search' ? 'border-l-yellow-400 bg-yellow-500/5' :
                evt.type === 'kg_update' ? 'border-l-purple-400 bg-purple-500/5' :
                evt.type === 'tool_use' ? 'border-l-green-400 bg-green-500/5' :
                'border-l-gray-400 bg-gray-500/5'
              }`}>
                <span className="text-rc-muted">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                {' '}{evt.inputSummary || evt.type}
                {evt.tokensIn ? <span className="text-rc-muted ml-1">({evt.tokensIn}tok)</span> : null}
              </div>
            ))}
            {traceEvents.length === 0 && <p className="text-rc-muted text-xs">No trace events yet</p>}
          </div>
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div className="fixed z-50 rounded-lg border border-rc-border bg-rc-card shadow-lg py-1 min-w-[160px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={e => e.stopPropagation()}>
          <div className="px-3 py-1.5 text-xs text-rc-text hover:bg-rc-bg cursor-pointer" onClick={() => handleCtxAction("dead_end")}>Mark as dead end</div>
          <div className="px-3 py-1.5 text-xs text-rc-text hover:bg-rc-bg cursor-pointer" onClick={() => handleCtxAction("delete")}>Delete</div>
        </div>
      )}

      {/* Add hint dialog */}
      {showAddDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowAddDialog(false)}>
          <div className="bg-rc-card border border-rc-border rounded-xl p-5 w-[360px] space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-rc-text">Add Hint Node</h3>
            <input value={hintLabel} onChange={e => setHintLabel(e.target.value)} placeholder="Label"
              className="w-full px-3 py-2 bg-rc-bg border border-rc-border rounded-lg text-sm text-rc-text" />
            <textarea value={hintDetails} onChange={e => setHintDetails(e.target.value)} placeholder="Details (optional)"
              className="w-full px-3 py-2 bg-rc-bg border border-rc-border rounded-lg text-sm text-rc-text h-16 resize-y" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowAddDialog(false)} className="px-4 py-1.5 text-xs rounded-lg border border-rc-border text-rc-muted">Cancel</button>
              <button onClick={handleAddHint} className="px-4 py-1.5 text-xs rounded-lg bg-emerald-600 text-white">Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
