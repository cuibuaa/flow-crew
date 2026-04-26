import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useTasks } from "./Layout";
import { reevalGate, rerunFromHere } from "../api";
import type { Stage, Task } from "../types";

const NODE_MIN_WIDTH = 220;
const NODE_MAX_WIDTH = 260;
const NODE_HEIGHT = 116;
const COLUMN_GAP = 124;
const ROW_GAP = 42;
const GRAPH_PADDING_X = 40;
const GRAPH_PADDING_Y = 28;
const GRAPH_MIN_HEIGHT = 560;
const DAG_PANEL_MIN_HEIGHT = 640;
const ACTIVITY_PANEL_MIN_HEIGHT = 340;
const LIVE_OUTPUT_HEIGHT = 420;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function measureElementWidth(element: HTMLElement): number {
  const rectWidth = element.getBoundingClientRect().width;
  return Math.round(rectWidth || element.clientWidth || 0);
}

function computeGraphSizing(stageCount: number, depthCount: number, viewportWidth: number): {
  nodeWidth: number;
  contentWidth: number;
  surfaceWidth: number;
  xOffset: number;
} {
  const safeDepthCount = Math.max(1, depthCount);
  const safeStageCount = Math.max(1, stageCount);
  const denseGraph = safeStageCount / safeDepthCount >= 3;
  const maxReadableWidth = denseGraph ? Math.max(NODE_MIN_WIDTH, NODE_MAX_WIDTH - 20) : NODE_MAX_WIDTH;
  const availableForNodes = viewportWidth - GRAPH_PADDING_X * 2 - Math.max(0, safeDepthCount - 1) * COLUMN_GAP;
  const viewportNodeWidth = viewportWidth > 0
    ? Math.floor(availableForNodes / safeDepthCount)
    : maxReadableWidth;
  const nodeWidth = clamp(viewportNodeWidth, NODE_MIN_WIDTH, maxReadableWidth);
  const contentWidth = GRAPH_PADDING_X * 2 + safeDepthCount * nodeWidth + Math.max(0, safeDepthCount - 1) * COLUMN_GAP;
  const surfaceWidth = Math.max(contentWidth, Math.ceil(viewportWidth || 0));
  const xOffset = GRAPH_PADDING_X + Math.max(0, (surfaceWidth - contentWidth) / 2);

  return { nodeWidth, contentWidth, surfaceWidth, xOffset };
}

function computeDepths(stages: Stage[]): Map<string, number> {
  const memo = new Map<string, number>();
  const byId = new Map(stages.map((stage) => [stage.id, stage]));

  const getDepth = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    const stage = byId.get(id);
    if (!stage || stage.dependsOn.length === 0) {
      memo.set(id, 0);
      return 0;
    }
    const depth = 1 + Math.max(...stage.dependsOn.map((dep) => getDepth(dep)));
    memo.set(id, depth);
    return depth;
  };

  for (const stage of stages) getDepth(stage.id);
  return memo;
}

function topoSortStages(stages: Stage[]): Stage[] {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const indexById = new Map(stages.map((stage, index) => [stage.id, index]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const stage of stages) {
    indegree.set(stage.id, stage.dependsOn.length);
    for (const dep of stage.dependsOn) {
      const next = dependents.get(dep) ?? [];
      next.push(stage.id);
      dependents.set(dep, next);
    }
  }

  const queue = stages
    .filter((stage) => (indegree.get(stage.id) ?? 0) === 0)
    .sort((a, b) => (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0))
    .map((stage) => stage.id);

  const ordered: Stage[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const stage = byId.get(id);
    if (!stage) continue;
    ordered.push(stage);

    for (const dependentId of dependents.get(id) ?? []) {
      const nextDegree = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependentId);
        queue.sort((left, right) => (indexById.get(left) ?? 0) - (indexById.get(right) ?? 0));
      }
    }
  }

  return ordered.length === stages.length ? ordered : stages;
}

function avgDuration(stages: Stage[]): number {
  const completed = stages.filter((stage) => stage.status === "complete" && stage.duration_ms);
  if (completed.length === 0) return 0;
  return completed.reduce((sum, stage) => sum + (stage.duration_ms ?? 0), 0) / completed.length;
}

interface HealthInfo {
  slow?: boolean;
  stalled?: boolean;
  elapsedMs: number;
}

function getStageHealth(stage: Stage, avg: number): HealthInfo {
  if (stage.status !== "running" || !stage.startedAt) return { elapsedMs: 0 };
  const elapsedMs = Math.max(0, Date.now() - Date.parse(stage.startedAt));
  return {
    slow: avg > 0 && elapsedMs > avg * 2,
    stalled: avg > 0 && elapsedMs > avg * 3,
    elapsedMs,
  };
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function joinLabels(values: string[]): string {
  if (values.length === 0) return "none";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, 2).join(", ")} +${values.length - 2}`;
}

function statusTone(status: Stage["status"]): string {
  switch (status) {
    case "complete":
      return "border-emerald-400/45 bg-emerald-500/10 text-emerald-50";
    case "running":
      return "border-sky-400/55 bg-sky-500/10 text-sky-50";
    case "failed":
      return "border-rose-400/55 bg-rose-500/10 text-rose-50";
    case "skipped":
      return "border-slate-500/65 bg-slate-500/10 text-slate-200";
    default:
      return "border-rc-border bg-rc-card text-rc-text";
  }
}

function statusBadgeTone(status: Stage["status"]): string {
  switch (status) {
    case "complete":
      return "border-emerald-400/40 bg-emerald-500/12 text-emerald-100";
    case "running":
      return "border-sky-400/40 bg-sky-500/12 text-sky-100";
    case "failed":
      return "border-rose-400/40 bg-rose-500/12 text-rose-100";
    case "skipped":
      return "border-slate-400/40 bg-slate-500/12 text-slate-200";
    default:
      return "border-rc-border bg-rc-code/70 text-rc-text-secondary";
  }
}

function verdictTone(verdict: "active" | "blocked" | "settled" | "warning"): string {
  switch (verdict) {
    case "active":
      return "border-sky-400/35 bg-sky-500/10 text-sky-100";
    case "blocked":
      return "border-rose-400/35 bg-rose-500/10 text-rose-100";
    case "warning":
      return "border-amber-300/35 bg-amber-400/10 text-amber-100";
    default:
      return "border-emerald-400/35 bg-emerald-500/10 text-emerald-100";
  }
}

function parseIterationLog(task: Task): Array<{ iteration: number; verdicts: Array<{ stageId: string; state: string }> }> {
  return (task.iterationLog ?? "")
    .split(/^# Iteration /m)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [header, ...rest] = chunk.split("\n");
      const iteration = Number.parseInt(header.match(/\d+/)?.[0] ?? `${task.currentIteration}`, 10);
      const verdicts = rest
        .filter((line) => line.startsWith("## "))
        .map((line) => line.replace(/^##\s*/, ""))
        .map((entry) => {
          const match = entry.match(/^(.+?)\s+\((.+)\)$/);
          return {
            stageId: match?.[1]?.trim() ?? entry.trim(),
            state: match?.[2]?.trim() ?? "observed",
          };
        });
      return { iteration, verdicts };
    });
}

interface AttemptInsight {
  title: string;
  verdict: "active" | "blocked" | "settled" | "warning";
  headline: string;
  evidence: string[];
}

function buildAttemptInsights(task: Task): AttemptInsight[] {
  const stageById = new Map(task.stages.map((stage) => [stage.id, stage]));
  const parsed = parseIterationLog(task);
  const artifactStages = task.stages.filter((stage) => (stage.artifacts?.length ?? 0) > 0);
  const retriedStages = task.stages.filter((stage) => stage.retries > 0);

  if (parsed.length === 0) {
    const failed = task.stages.filter((stage) => stage.status === "failed");
    const running = task.stages.filter((stage) => stage.status === "running");
    const settled = task.stages.filter((stage) => stage.status === "complete");
    const verdict = failed.length > 0 ? "blocked" : running.length > 0 ? "active" : "settled";
    const headline = failed.length > 0
      ? `${joinLabels(failed.map((stage) => stage.id))} needs intervention`
      : running.length > 0
        ? `${joinLabels(running.map((stage) => stage.id))} is still executing`
        : `${pluralize(settled.length, "stage")} settled cleanly`;
    const evidence = [
      `${pluralize(retriedStages.length, "stage")} retried`,
      `${pluralize(artifactStages.length, "stage")} emitted artifacts`,
    ];
    if (task.campaignAlert) evidence.unshift(task.campaignAlert.message);
    return [{
      title: `Attempt ${task.currentIteration}`,
      verdict,
      headline,
      evidence,
    }];
  }

  return parsed.slice(-4).reverse().map((attempt) => {
    const failed = attempt.verdicts.filter((entry) => /fail/i.test(entry.state));
    const active = attempt.verdicts.filter((entry) => /run|progress|active/i.test(entry.state));
    const settled = attempt.verdicts.filter((entry) => /complete|pass|done/i.test(entry.state));
    const verdict = task.campaignAlert?.iteration === attempt.iteration
      ? "warning"
      : failed.length > 0
        ? "blocked"
        : active.length > 0
          ? "active"
          : "settled";

    const headline = task.campaignAlert?.iteration === attempt.iteration
      ? `Campaign monitor escalated after iteration ${attempt.iteration}`
      : failed.length > 0
        ? `${joinLabels(failed.map((entry) => entry.stageId))} blocked the run`
        : active.length > 0
          ? `${joinLabels(active.map((entry) => entry.stageId))} carried the next pass`
          : settled.length > 0
            ? `${pluralize(settled.length, "stage")} landed without intervention`
            : "Run state changed without explicit verdict lines";

    const evidence: string[] = [];
    const retriedInAttempt = attempt.verdicts
      .flatMap((entry) => {
        const stage = stageById.get(entry.stageId);
        return stage && stage.retries > 0 ? [`${stage.id} (attempt ${stage.retries + 1})`] : [];
      });
    if (failed.length > 0) evidence.push(`Blocked: ${joinLabels(failed.map((entry) => entry.stageId))}`);
    if (active.length > 0) evidence.push(`Active: ${joinLabels(active.map((entry) => entry.stageId))}`);
    if (retriedInAttempt.length > 0) evidence.push(`Retries: ${joinLabels(retriedInAttempt)}`);
    if (artifactStages.length > 0) evidence.push(`Evidence available from ${pluralize(artifactStages.length, "stage")}`);
    if (task.campaignAlert?.iteration === attempt.iteration) evidence.push(task.campaignAlert.message);
    if (evidence.length === 0) evidence.push("No additional evidence recorded");

    return {
      title: `Attempt ${attempt.iteration}`,
      verdict,
      headline,
      evidence,
    };
  });
}

function buildLineage(stages: Stage[], selectedStageId: string | null): Set<string> {
  if (!selectedStageId) return new Set();

  const ancestors = new Set<string>([selectedStageId]);
  const descendants = new Set<string>([selectedStageId]);
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const dependents = new Map<string, string[]>();

  for (const stage of stages) {
    for (const dep of stage.dependsOn) {
      const next = dependents.get(dep) ?? [];
      next.push(stage.id);
      dependents.set(dep, next);
    }
  }

  const walkUp = (id: string) => {
    const stage = byId.get(id);
    if (!stage) return;
    for (const dep of stage.dependsOn) {
      if (ancestors.has(dep)) continue;
      ancestors.add(dep);
      walkUp(dep);
    }
  };

  const walkDown = (id: string) => {
    for (const dep of dependents.get(id) ?? []) {
      if (descendants.has(dep)) continue;
      descendants.add(dep);
      walkDown(dep);
    }
  };

  walkUp(selectedStageId);
  walkDown(selectedStageId);
  return new Set([...ancestors, ...descendants]);
}

interface PositionedStage {
  stage: Stage;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RoutedEdge {
  key: string;
  from: string;
  to: string;
  path: string;
  kind: "serial" | "branch" | "merge" | "retry";
}

function buildEdgePath(source: PositionedStage, target: PositionedStage): string {
  const forward = target.x >= source.x;
  const startX = forward ? source.x + source.width : source.x;
  const startY = source.y + source.height / 2;
  const endX = forward ? target.x : target.x + target.width;
  const endY = target.y + target.height / 2;
  const direction = forward ? 1 : -1;
  const middleX = startX + direction * Math.max(54, Math.abs(endX - startX) / 2);

  if (Math.abs(startY - endY) < 6) {
    return `M ${startX} ${startY} L ${endX} ${endY}`;
  }

  const verticalInset = startY < endY ? 18 : -18;
  return [
    `M ${startX} ${startY}`,
    `L ${middleX - direction * 18} ${startY}`,
    `Q ${middleX} ${startY} ${middleX} ${startY + verticalInset}`,
    `L ${middleX} ${endY - verticalInset}`,
    `Q ${middleX} ${endY} ${middleX + direction * 18} ${endY}`,
    `L ${endX} ${endY}`,
  ].join(" ");
}

function buildRetryPath(node: PositionedStage): string {
  const startX = node.x + node.width - 28;
  const startY = node.y;
  const endX = node.x + node.width - 76;
  const endY = node.y;
  const loopTop = Math.max(12, node.y - 28);
  return `M ${startX} ${startY} C ${startX + 26} ${loopTop}, ${endX - 26} ${loopTop}, ${endX} ${endY}`;
}

function isLinearChain(stages: Stage[]): boolean {
  if (stages.length <= 1) return true;
  const dependents = new Map<string, string[]>();
  let roots = 0;

  for (const stage of stages) {
    if (stage.dependsOn.length === 0) roots += 1;
    if (stage.dependsOn.length > 1) return false;
    for (const dep of stage.dependsOn) {
      const next = dependents.get(dep) ?? [];
      next.push(stage.id);
      dependents.set(dep, next);
      if (next.length > 1) return false;
    }
  }

  return roots === 1;
}

function buildLinearSnakeLayout(stages: Stage[], viewportWidth = 0): {
  nodes: Map<string, PositionedStage>;
  edges: RoutedEdge[];
  width: number;
  height: number;
  contentWidth: number;
  nodeWidth: number;
  mode: "linear-snake";
} {
  const ordered = topoSortStages(stages);
  const nodeWidth = NODE_MIN_WIDTH;
  const measuredWidth = Math.max(0, viewportWidth);
  const columns = Math.max(1, Math.floor((measuredWidth - GRAPH_PADDING_X * 2 + COLUMN_GAP) / (nodeWidth + COLUMN_GAP)));
  const safeColumns = Math.min(Math.max(1, ordered.length), columns || 1);
  const rowCount = Math.max(1, Math.ceil(ordered.length / safeColumns));
  const contentWidth = GRAPH_PADDING_X * 2 + safeColumns * nodeWidth + Math.max(0, safeColumns - 1) * COLUMN_GAP;
  const width = Math.max(contentWidth, Math.ceil(measuredWidth));
  const xOffset = GRAPH_PADDING_X + Math.max(0, (width - contentWidth) / 2);
  const rowSpan = NODE_HEIGHT + ROW_GAP;
  const contentHeight = GRAPH_PADDING_Y * 2 + rowCount * NODE_HEIGHT + Math.max(0, rowCount - 1) * ROW_GAP;
  const height = Math.max(contentHeight, GRAPH_MIN_HEIGHT);
  const yOffset = GRAPH_PADDING_Y + Math.max(0, (height - contentHeight) / 2);
  const nodes = new Map<string, PositionedStage>();

  ordered.forEach((stage, index) => {
    const row = Math.floor(index / safeColumns);
    const offset = index % safeColumns;
    const rowLength = Math.min(safeColumns, ordered.length - row * safeColumns);
    const visualOffset = row % 2 === 0 ? offset : rowLength - 1 - offset;
    nodes.set(stage.id, {
      stage,
      x: xOffset + visualOffset * (nodeWidth + COLUMN_GAP),
      y: yOffset + row * rowSpan,
      width: nodeWidth,
      height: NODE_HEIGHT,
    });
  });

  const edges = buildRoutedEdges(stages, nodes);

  return { nodes, edges, width, height, contentWidth, nodeWidth, mode: "linear-snake" };
}

function buildRoutedEdges(stages: Stage[], nodes: Map<string, PositionedStage>): RoutedEdge[] {
  const dependentCounts = new Map<string, number>();
  for (const stage of stages) {
    for (const dep of stage.dependsOn) {
      dependentCounts.set(dep, (dependentCounts.get(dep) ?? 0) + 1);
    }
  }

  const edges: RoutedEdge[] = [];
  for (const stage of stages) {
    const target = nodes.get(stage.id);
    if (!target) continue;
    for (const dep of stage.dependsOn) {
      const source = nodes.get(dep);
      if (!source) continue;
      edges.push({
        key: `${dep}->${stage.id}`,
        from: dep,
        to: stage.id,
        path: buildEdgePath(source, target),
        kind: stage.dependsOn.length > 1 ? "merge" : (dependentCounts.get(dep) ?? 0) > 1 ? "branch" : "serial",
      });
    }
    if (stage.retries > 0) {
      edges.push({
        key: `${stage.id}->${stage.id}:retry`,
        from: stage.id,
        to: stage.id,
        path: buildRetryPath(target),
        kind: "retry",
      });
    }
  }
  return edges;
}

function buildGraphLayout(stages: Stage[], viewportWidth = 0): {
  nodes: Map<string, PositionedStage>;
  edges: RoutedEdge[];
  width: number;
  height: number;
  contentWidth: number;
  nodeWidth: number;
  mode: "linear-snake" | "parallel-layered";
} {
  if (isLinearChain(stages)) return buildLinearSnakeLayout(stages, viewportWidth);

  const ordered = topoSortStages(stages);
  const depths = computeDepths(stages);
  const stageIndex = new Map(ordered.map((stage, index) => [stage.id, index]));
  const grouped = new Map<number, Stage[]>();

  for (const stage of ordered) {
    const depth = depths.get(stage.id) ?? 0;
    const next = grouped.get(depth) ?? [];
    next.push(stage);
    grouped.set(depth, next);
  }

  const laneHints = new Map<string, number>();
  const maxDepth = Math.max(0, ...depths.values());
  let maxRows = 1;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const stagesAtDepth = [...(grouped.get(depth) ?? [])];
    stagesAtDepth.sort((left, right) => {
      const leftHint = left.dependsOn.length === 0
        ? (stageIndex.get(left.id) ?? 0)
        : left.dependsOn.reduce((sum, dep) => sum + (laneHints.get(dep) ?? 0), 0) / left.dependsOn.length + left.retries * 0.35;
      const rightHint = right.dependsOn.length === 0
        ? (stageIndex.get(right.id) ?? 0)
        : right.dependsOn.reduce((sum, dep) => sum + (laneHints.get(dep) ?? 0), 0) / right.dependsOn.length + right.retries * 0.35;
      if (leftHint !== rightHint) return leftHint - rightHint;
      return (stageIndex.get(left.id) ?? 0) - (stageIndex.get(right.id) ?? 0);
    });
    stagesAtDepth.forEach((stage, lane) => laneHints.set(stage.id, lane));
    maxRows = Math.max(maxRows, stagesAtDepth.length);
    grouped.set(depth, stagesAtDepth);
  }

  const rowSpan = NODE_HEIGHT + ROW_GAP;
  const nodes = new Map<string, PositionedStage>();
  const depthCount = maxDepth + 1;
  const sizing = computeGraphSizing(stages.length, depthCount, viewportWidth);
  const contentHeight = GRAPH_PADDING_Y * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
  const surfaceHeight = Math.max(contentHeight, GRAPH_MIN_HEIGHT);
  const yOffset = GRAPH_PADDING_Y + Math.max(0, (surfaceHeight - contentHeight) / 2);

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const stagesAtDepth = grouped.get(depth) ?? [];
    const verticalOffset = ((maxRows - stagesAtDepth.length) * rowSpan) / 2;
    stagesAtDepth.forEach((stage, lane) => {
      nodes.set(stage.id, {
        stage,
        x: sizing.xOffset + depth * (sizing.nodeWidth + COLUMN_GAP),
        y: yOffset + verticalOffset + lane * rowSpan,
        width: sizing.nodeWidth,
        height: NODE_HEIGHT,
      });
    });
  }

  const edges = buildRoutedEdges(stages, nodes);

  return {
    nodes,
    edges,
    width: sizing.surfaceWidth,
    height: surfaceHeight,
    contentWidth: sizing.contentWidth,
    nodeWidth: sizing.nodeWidth,
    mode: "parallel-layered",
  };
}

function LiveTerminal({ liveUrl }: { liveUrl: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      theme: { background: "#10192d", foreground: "#d9e6ff" },
      fontSize: 13,
      fontFamily: "JetBrains Mono, Fira Code, Menlo, monospace",
      disableStdin: true,
      cursorBlink: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(containerRef.current);

    let queue: string[] = [];
    let rafId = 0;
    const flush = () => {
      rafId = 0;
      if (queue.length === 0) return;
      term.write(queue.join(""));
      queue = [];
    };

    const es = new EventSource(liveUrl);
    es.onmessage = (event) => {
      try {
        const chunk = JSON.parse(event.data) as string;
        queue.push(chunk.replace(/\r?\n/g, "\r\n"));
        if (!rafId) rafId = requestAnimationFrame(flush);
      } catch {
        // Ignore malformed chunks.
      }
    };
    es.onerror = () => es.close();

    return () => {
      resizeObserver.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      es.close();
      term.dispose();
    };
  }, [liveUrl]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function RunOverview({
  task,
  selectedStage,
  health,
}: {
  task: Task;
  selectedStage?: Stage;
  health?: HealthInfo;
}) {
  const completed = task.stages.filter((stage) => stage.status === "complete").length;
  const running = task.stages.filter((stage) => stage.status === "running").length;
  const failed = task.stages.filter((stage) => stage.status === "failed").length;
  const focus = selectedStage
    ? `${selectedStage.id} is the active focus`
    : `${pluralize(task.stages.length, "stage")} in this run`;

  return (
    <section className="glass-panel rounded-card p-4 space-y-4" data-testid="monitor-summary">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-rc-text">Run Summary</h3>
        <p className="text-sm text-rc-text-secondary">
          {task.campaignId ? `${task.campaignName ?? task.campaignId} #${task.campaignSeq ?? "?"} • ` : ""}
          Iteration {task.currentIteration}/{task.maxIterations}
        </p>
      </div>

      {task.campaignAlert && (
        <div className="rounded-card border border-amber-300/35 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          Campaign trigger: {task.campaignAlert.message}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-card border border-rc-border bg-rc-code/70 p-3 text-center">
          <div className="text-xl font-semibold text-rc-text">{completed}</div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-rc-muted">Complete</div>
        </div>
        <div className="rounded-card border border-rc-border bg-rc-code/70 p-3 text-center">
          <div className="text-xl font-semibold text-sky-200">{running}</div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-rc-muted">Running</div>
        </div>
        <div className="rounded-card border border-rc-border bg-rc-code/70 p-3 text-center">
          <div className="text-xl font-semibold text-rose-200">{failed}</div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-rc-muted">Failed</div>
        </div>
      </div>

      <div className="rounded-card border border-rc-border bg-rc-code/55 px-3 py-3">
        <div className="text-[10px] uppercase tracking-[0.22em] text-rc-muted">Focus</div>
        <div className="mt-1 text-sm text-rc-text">{focus}</div>
        {selectedStage && (
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-rc-text-secondary">
            <span className={`rounded-input border px-2 py-0.5 uppercase tracking-wider ${statusBadgeTone(selectedStage.status)}`}>
              {selectedStage.status}
            </span>
            <span className="rounded-input bg-rc-code px-2 py-0.5 font-mono">{selectedStage.role}</span>
            {selectedStage.status === "running" && health && <span className="font-mono">Elapsed {fmtDuration(health.elapsedMs)}</span>}
            {selectedStage.status !== "running" && selectedStage.duration_ms != null && <span className="font-mono">{fmtDuration(selectedStage.duration_ms)}</span>}
          </div>
        )}
      </div>
    </section>
  );
}

function AttemptsSummary({ task }: { task: Task }) {
  const attempts = useMemo(() => buildAttemptInsights(task), [task]);

  return (
    <section className="glass-panel rounded-card p-4 space-y-3" data-testid="attempts-summary">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-rc-text">AI-derived Attempts</h3>
        <span className="text-xs font-mono text-rc-muted">{task.currentIteration}/{task.maxIterations}</span>
      </div>

      <div className="space-y-3">
        {attempts.map((attempt) => (
          <article key={`${attempt.title}-${attempt.headline}`} className="rounded-card border border-rc-border bg-rc-code/55 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-rc-muted">{attempt.title}</div>
              <span className={`rounded-input border px-2 py-0.5 text-[10px] uppercase tracking-[0.22em] ${verdictTone(attempt.verdict)}`}>
                {attempt.verdict}
              </span>
            </div>
            <div className="mt-2 text-sm text-rc-text">{attempt.headline}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {attempt.evidence.map((entry) => (
                <span key={entry} className="rounded-input border border-rc-border bg-rc-card/70 px-2 py-1 text-[11px] text-rc-text-secondary">
                  {entry}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function edgeEmphasis(edge: RoutedEdge, selectedStageId: string | null, lineage: Set<string>): "direct" | "context" | "dim" | "base" {
  if (!selectedStageId) return "base";
  if (edge.from === selectedStageId || edge.to === selectedStageId) return "direct";
  if (lineage.has(edge.from) && lineage.has(edge.to)) return "context";
  return "dim";
}

function nodeLayer(selected: boolean, related: boolean, dimmed: boolean): number {
  if (selected) return 30;
  if (related) return 20;
  if (dimmed) return 5;
  return 10;
}

function NodeCard({
  stage,
  selected,
  related,
  dimmed,
  health,
  position,
  registerNode,
  onSelect,
}: {
  stage: Stage;
  selected: boolean;
  related: boolean;
  dimmed: boolean;
  health: HealthInfo;
  position: PositionedStage;
  registerNode: (id: string, node: HTMLButtonElement | null) => void;
  onSelect: () => void;
}) {
  return (
    <button
      ref={(node) => registerNode(stage.id, node)}
      type="button"
      data-testid={`dag-node-${stage.id}`}
      data-stage-id={stage.id}
      data-selected={selected ? "true" : "false"}
      data-related={related ? "true" : "false"}
      onClick={onSelect}
      className={`monitor-node-shell absolute rounded-card border px-4 py-3 text-left ${statusTone(stage.status)} ${selected ? "ring-2 ring-sky-300/70 shadow-glow" : ""} ${dimmed ? "opacity-35" : "opacity-100"} ${related && !selected ? "border-sky-300/35" : ""}`}
      style={{
        left: position.x,
        top: position.y,
        width: position.width,
        height: position.height,
        zIndex: nodeLayer(selected, related, dimmed),
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${stage.status === "failed" ? "bg-rose-300" : stage.status === "running" ? "bg-sky-300" : stage.status === "complete" ? "bg-emerald-300" : "bg-slate-400"}`} />
            <span className="truncate text-sm font-semibold">{stage.id}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.22em]">
            <span className="rounded-input bg-rc-code/80 px-2 py-1 text-rc-text-secondary">{stage.role}</span>
            <span className={`rounded-input border px-2 py-1 ${statusBadgeTone(stage.status)}`}>{stage.status}</span>
            {stage.isGate && <span className="rounded-input border border-amber-300/40 bg-amber-400/10 px-2 py-1 text-amber-100">Gate</span>}
          </div>
        </div>
        <div className="text-right text-[11px] text-rc-text-secondary">
          {stage.status === "running" && <div className="font-mono">{fmtDuration(health.elapsedMs)}</div>}
          {stage.status !== "running" && stage.duration_ms != null && <div className="font-mono">{fmtDuration(stage.duration_ms)}</div>}
          {stage.retries > 0 && <div className="mt-1 font-mono text-amber-100">Attempt {stage.retries + 1}</div>}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 text-[11px] text-rc-text-secondary">
        <span>{stage.dependsOn.length > 0 ? `Waits on ${joinLabels(stage.dependsOn)}` : "Root stage"}</span>
        <span>{stage.retries > 0 ? "Retry path" : stage.dependsOn.length > 1 ? "Merge point" : "Primary path"}</span>
      </div>

      {stage.retries > 0 && (
        <div className="pointer-events-none absolute bottom-3 right-3 flex gap-1">
          {Array.from({ length: Math.min(stage.retries + 1, 4) }, (_, index) => (
            <span key={index} className="h-1.5 w-5 rounded-full bg-amber-300/35" />
          ))}
        </div>
      )}
    </button>
  );
}

function DagViewport({
  task,
  selectedStageId,
  onSelectStage,
  healthMap,
}: {
  task: Task;
  selectedStageId: string | null;
  onSelectStage: (id: string) => void;
  healthMap: Map<string, HealthInfo>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const [viewportWidth, setViewportWidth] = useState(0);
  const layout = useMemo(() => buildGraphLayout(task.stages, viewportWidth), [task.stages, viewportWidth]);
  const lineage = useMemo(() => buildLineage(task.stages, selectedStageId), [task.stages, selectedStageId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const updateWidth = (width = measureElementWidth(node)) => {
      setViewportWidth((current) => (Math.abs(current - width) > 1 ? width : current));
    };

    updateWidth();
    const observer = new ResizeObserver((entries) => {
      const nextWidth = Math.round(entries[0]?.contentRect.width ?? measureElementWidth(node));
      updateWidth(nextWidth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedStageId) return;
    const node = nodeRefs.current.get(selectedStageId);
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
  }, [selectedStageId]);

  return (
    <section
      className="glass-panel rounded-card flex min-h-0 flex-col overflow-hidden"
      data-testid="monitor-dag-panel"
      style={{ minHeight: DAG_PANEL_MIN_HEIGHT }}
    >
      <div className="border-b border-rc-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-rc-text">{task.name}</h2>
            <p className="text-sm text-rc-text-secondary">
              {task.campaignId ? `${task.campaignName ?? task.campaignId} #${task.campaignSeq ?? "?"} • ` : ""}
              Iteration {task.currentIteration}/{task.maxIterations}
            </p>
          </div>
          <div className="rounded-input bg-rc-code px-2 py-1 text-xs font-mono text-rc-text-secondary">
            {pluralize(task.stages.length, "stage")}
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="monitor-scroll-area flex-1 overflow-auto p-4" data-testid="monitor-dag-scroll">
        <div
          data-testid="monitor-graph-surface"
          data-content-width={layout.contentWidth}
          data-node-width={layout.nodeWidth}
          data-viewport-width={viewportWidth}
          data-layout-mode={layout.mode}
          className="monitor-grid-surface relative isolate rounded-card border border-rc-border"
          style={{ width: layout.width, height: layout.height }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            style={{ width: layout.width, height: layout.height }}
            aria-hidden="true"
          >
            {layout.edges.map((edge) => {
              const emphasis = edgeEmphasis(edge, selectedStageId, lineage);
              return (
                <path
                  key={edge.key}
                  d={edge.path}
                  data-testid={edge.kind === "retry" ? `dag-retry-loop-${edge.from}` : `dag-edge-${edge.from}-${edge.to}`}
                  data-emphasis={emphasis}
                  data-edge-kind={edge.kind}
                  className="monitor-edge"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={emphasis === "direct" ? 3.5 : emphasis === "context" ? 2.8 : 2.2}
                />
              );
            })}
          </svg>

          {[...layout.nodes.values()].map((position) => {
            const stage = position.stage;
            const selected = selectedStageId === stage.id;
            const related = selectedStageId == null ? false : lineage.has(stage.id);
            return (
              <NodeCard
                key={stage.id}
                stage={stage}
                selected={selected}
                related={related}
                dimmed={selectedStageId != null && !related}
                health={healthMap.get(stage.id) ?? { elapsedMs: 0 }}
                position={position}
                registerNode={(id, node) => {
                  if (node) nodeRefs.current.set(id, node);
                  else nodeRefs.current.delete(id);
                }}
                onSelect={() => onSelectStage(stage.id)}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ActivityPane({
  taskId,
  task,
  stage,
  health,
  onOpenDetail,
}: {
  taskId: string;
  task: Task;
  stage?: Stage;
  health?: HealthInfo;
  onOpenDetail: (stageId: string) => void;
}) {
  const dependents = useMemo(() => {
    if (!stage) return [];
    return task.stages.filter((candidate) => candidate.dependsOn.includes(stage.id)).map((candidate) => candidate.id);
  }, [task.stages, stage]);

  return (
    <section
      className="glass-panel rounded-card flex min-h-0 flex-col overflow-hidden"
      data-testid="monitor-activity-pane"
      style={{ minHeight: ACTIVITY_PANEL_MIN_HEIGHT }}
    >
      <div className="border-b border-rc-border px-4 py-3">
        <h3 className="text-sm font-semibold text-rc-text">Activity & Output</h3>
        <p className="text-sm text-rc-text-secondary">
          {stage ? `${stage.id} (${stage.role})` : "Select a stage to follow its current activity and live output"}
        </p>
      </div>

      <div className="monitor-scroll-area flex-1 overflow-auto p-4" data-testid="monitor-activity-scroll">
        {stage ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-card border border-rc-border bg-rc-code/65 p-3">
                <div className="text-[10px] uppercase tracking-[0.22em] text-rc-muted">Status</div>
                <div className={`mt-2 inline-flex rounded-input border px-2 py-1 text-[10px] uppercase tracking-wider ${statusBadgeTone(stage.status)}`}>
                  {stage.status}
                </div>
              </div>
              <div className="rounded-card border border-rc-border bg-rc-code/65 p-3">
                <div className="text-[10px] uppercase tracking-[0.22em] text-rc-muted">Elapsed</div>
                <div className="mt-2 font-mono text-sm text-rc-text">
                  {stage.status === "running" && health ? fmtDuration(health.elapsedMs) : stage.duration_ms != null ? fmtDuration(stage.duration_ms) : "Pending"}
                </div>
              </div>
              <div className="rounded-card border border-rc-border bg-rc-code/65 p-3">
                <div className="text-[10px] uppercase tracking-[0.22em] text-rc-muted">Attempts</div>
                <div className="mt-2 font-mono text-sm text-rc-text">{stage.retries + 1}</div>
              </div>
              <div className="rounded-card border border-rc-border bg-rc-code/65 p-3">
                <div className="text-[10px] uppercase tracking-[0.22em] text-rc-muted">Graph Links</div>
                <div className="mt-2 text-sm text-rc-text">
                  {pluralize(stage.dependsOn.length, "dependency")} / {pluralize(dependents.length, "dependent")}
                </div>
              </div>
            </div>

            <div className="rounded-card border border-rc-border bg-rc-card/80 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-base font-semibold text-rc-text">{stage.id}</h4>
                    <span className="rounded-input bg-rc-code px-2 py-0.5 font-mono text-xs text-rc-text-secondary">{stage.role}</span>
                    {stage.isGate && <span className="rounded-input border border-amber-300/40 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-100">Gate</span>}
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-rc-text-secondary">
                    <span className="rounded-input border border-rc-border bg-rc-code/70 px-2 py-1">
                      {stage.dependsOn.length > 0 ? `Depends on ${joinLabels(stage.dependsOn)}` : "Entry stage"}
                    </span>
                    <span className="rounded-input border border-rc-border bg-rc-code/70 px-2 py-1">
                      {dependents.length > 0 ? `Unlocks ${joinLabels(dependents)}` : "No downstream stages"}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {stage.status === "complete" && (
                    <button onClick={() => onOpenDetail(stage.id)} className="btn-ghost border border-rc-border px-3 py-1.5 text-xs">
                      Open Detail
                    </button>
                  )}
                  {(stage.status === "failed" || health?.stalled) && (
                    <button onClick={() => rerunFromHere(task.id, stage.id).catch(() => {})} className="btn-accent px-3 py-1.5 text-xs">
                      Rerun From Here
                    </button>
                  )}
                  {stage.isGate && (stage.status === "failed" || health?.stalled) && (
                    <button onClick={() => reevalGate(task.id, stage.id).catch(() => {})} className="btn-ghost border border-rc-border px-3 py-1.5 text-xs">
                      Re-evaluate Gate
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {health?.slow && (
                  <span className="rounded-input border border-amber-300/35 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-100">
                    Running slower than prior settled stages
                  </span>
                )}
                {health?.stalled && (
                  <span className="rounded-input border border-rose-300/35 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-100">
                    Likely stalled
                  </span>
                )}
                {task.campaignAlert && (
                  <span className="rounded-input border border-amber-300/35 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-100">
                    Campaign trigger: {task.campaignAlert.message}
                  </span>
                )}
              </div>
            </div>

            <div className="overflow-hidden rounded-card border border-rc-border bg-[#0b1220]">
              <div className="border-b border-rc-border px-4 py-3 text-sm text-rc-text-secondary">Live output</div>
              <div style={{ height: LIVE_OUTPUT_HEIGHT }} data-testid="monitor-live-output">
                <LiveTerminal key={`${taskId}-${stage.id}`} liveUrl={`/api/tasks/${taskId}/stages/${stage.id}/live`} />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-[240px] items-center justify-center rounded-card border border-dashed border-rc-border bg-rc-code/35 text-sm text-rc-muted">
            No stage selected
          </div>
        )}
      </div>
    </section>
  );
}

export default function LiveMonitor() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const tasks = useTasks();
  const routedTask = tasks.find((task) => task.id === id);
  const [taskState, setTaskState] = useState<Task | undefined>(routedTask);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (routedTask) setTaskState(routedTask);
  }, [routedTask]);

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/tasks/${id}/events`);
    es.onmessage = (event) => {
      try {
        const nextTask = JSON.parse(event.data) as Task;
        startTransition(() => setTaskState(nextTask));
      } catch {
        // Ignore malformed updates.
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [id]);

  useEffect(() => {
    if (!taskState || !id) return;
    if (taskState.status === "pending") nav(`/task/${id}/discuss`, { replace: true });
    if (taskState.status === "awaiting_approval") nav(`/task/${id}/plan`, { replace: true });
  }, [taskState, id, nav]);

  useEffect(() => {
    if (!taskState) return;
    if (selectedStageId && taskState.stages.some((stage) => stage.id === selectedStageId)) return;
    const firstInteresting = taskState.stages.find((stage) => stage.status === "running")
      ?? taskState.stages.find((stage) => stage.status === "failed")
      ?? taskState.stages[0];
    if (firstInteresting) setSelectedStageId(firstInteresting.id);
  }, [taskState, selectedStageId]);

  useEffect(() => {
    const hasRunning = taskState?.stages.some((stage) => stage.status === "running");
    if (!hasRunning) return;
    const interval = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(interval);
  }, [taskState]);

  const task = taskState;
  const avg = useMemo(() => (task ? avgDuration(task.stages) : 0), [task, tick]);
  const healthMap = useMemo(() => {
    const map = new Map<string, HealthInfo>();
    if (!task) return map;
    for (const stage of task.stages) map.set(stage.id, getStageHealth(stage, avg));
    return map;
  }, [task, avg, tick]);

  if (!task || !id) return <div className="text-rc-muted">Task not found</div>;

  const selectedStage = selectedStageId ? task.stages.find((stage) => stage.id === selectedStageId) : undefined;

  return (
    <div className="flex min-h-[960px] flex-col gap-4 lg-wide:flex-row lg-wide:items-stretch" data-testid="monitor-layout">
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(640px,1fr)_minmax(340px,auto)] gap-4 lg-wide:w-[62%]">
        <DagViewport task={task} selectedStageId={selectedStageId} onSelectStage={setSelectedStageId} healthMap={healthMap} />
        <ActivityPane
          taskId={id}
          task={task}
          stage={selectedStage}
          health={selectedStage ? healthMap.get(selectedStage.id) : undefined}
          onOpenDetail={(stageId) => nav(`/task/${id}/stage/${stageId}`)}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto lg-wide:w-[38%]">
        <RunOverview task={task} selectedStage={selectedStage} health={selectedStage ? healthMap.get(selectedStage.id) : undefined} />
        <AttemptsSummary task={task} />
      </div>
    </div>
  );
}
