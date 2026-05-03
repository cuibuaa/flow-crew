import type { KGNode, KGEdge } from "../types";

export interface SimNode extends KGNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export const NODE_CARD_WIDTH = 110;
export const NODE_CARD_HEIGHT = 56;
export const NODE_COLLISION_GAP_X = 22;
export const NODE_COLLISION_GAP_Y = 16;

export const NODE_COLORS: Record<string, string> = {
  goal: "#3fb950",
  approach: "#58a6ff",
  finding: "#d29922",
  result: "#39d353",
  dead_end: "#f85149",
  user_hint: "#bc8cff",
  insight: "#39d3c3",
};

export const NODE_ICONS: Record<string, string> = {
  goal: "G",
  approach: "A",
  finding: "F",
  result: "R",
  insight: "I",
  dead_end: "X",
  user_hint: "U",
};

export function edgeEndpoints(edge: KGEdge) {
  return {
    from: edge.from ?? edge.source,
    to: edge.to ?? edge.target,
  };
}

export function runSimulation(nodes: SimNode[], edges: KGEdge[], width: number, height: number) {
  const cx = width / 2, cy = height / 2;
  for (let iter = 0; iter < 180; iter++) {
    const damping = 0.9 - iter * 0.004;
    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[i].x - nodes[j].x;
        let dy = nodes[i].y - nodes[j].y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = 8000 / (dist * dist);
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        nodes[i].vx += dx; nodes[i].vy += dy;
        nodes[j].vx -= dx; nodes[j].vy -= dy;
      }
    }
    // Rectangular collision. Nodes render as 110x56 cards, so point-distance
    // repulsion alone can still leave labels and rectangles overlapping.
    separateNodeOverlaps(nodes, width, height, 1.15);
    // Attraction along edges
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    for (const e of edges) {
      const endpoints = edgeEndpoints(e);
      const a = endpoints.from ? nodeMap.get(endpoints.from) : undefined;
      const b = endpoints.to ? nodeMap.get(endpoints.to) : undefined;
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = dist * 0.03;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // Center gravity
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.01;
      n.vy += (cy - n.y) * 0.01;
      n.x += n.vx * damping;
      n.y += n.vy * damping;
      n.vx *= damping;
      n.vy *= damping;
      n.x = Math.max(60, Math.min(width - 60, n.x));
      n.y = Math.max(30, Math.min(height - 30, n.y));
    }
  }
  separateNodeOverlaps(nodes, width, height, 2.5, 80);
}

export function layoutNodesGrid(nodes: SimNode[], width: number) {
  const marginX = 80;
  const marginY = 70;
  const stepX = NODE_CARD_WIDTH + 50;
  const stepY = NODE_CARD_HEIGHT + 44;
  const columns = Math.max(1, Math.floor((width - marginX * 2) / stepX));
  nodes.forEach((node, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    node.x = marginX + col * stepX;
    node.y = marginY + row * stepY;
    node.vx = 0;
    node.vy = 0;
  });
}

const TYPE_ORDER = ["goal", "user_hint", "approach", "finding", "result", "insight", "dead_end"];

export function layoutNodesClustered(nodes: SimNode[], width: number, height: number) {
  const byType = new Map<string, SimNode[]>();
  for (const node of nodes) {
    const group = byType.get(node.type) ?? [];
    group.push(node);
    byType.set(node.type, group);
  }

  const groups = TYPE_ORDER
    .map(type => [type, byType.get(type) ?? []] as const)
    .filter(([, group]) => group.length > 0);
  const fallbackGroups = [...byType.entries()].filter(([type]) => !TYPE_ORDER.includes(type));
  for (const group of fallbackGroups) groups.push(group as [string, SimNode[]]);

  const defaultCenter = { x: width / 2, y: height / 2 };
  const sectionCenters: Record<string, { x: number; y: number }> = {
    dead_end: { x: width * 0.23, y: height * 0.28 },
    result: { x: width * 0.55, y: height * 0.34 },
    goal: { x: width * 0.52, y: height * 0.50 },
    finding: { x: width * 0.42, y: height * 0.70 },
    approach: { x: width * 0.82, y: height * 0.58 },
    user_hint: { x: width * 0.82, y: height * 0.22 },
    insight: { x: width * 0.22, y: height * 0.76 },
  };

  for (const [type, group] of groups) {
    const center = sectionCenters[type] ?? defaultCenter;
    const columns = Math.max(1, Math.ceil(Math.sqrt(group.length * 1.15)));
    const stepX = NODE_CARD_WIDTH + 12;
    const stepY = NODE_CARD_HEIGHT + 10;
    const rows = Math.ceil(group.length / columns);
    group.forEach((node, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const jitter = ((i * 9301 + 49297) % 233280) / 233280 - 0.5;
      const rowOffset = row % 2 === 0 ? -8 : 8;
      node.x = center.x + (col - (columns - 1) / 2) * stepX + rowOffset + jitter * 8;
      node.y = center.y + (row - (rows - 1) / 2) * stepY - Math.abs(col - (columns - 1) / 2) * 2 - jitter * 6;
      node.vx = 0;
      node.vy = 0;
      node.x = Math.max(NODE_CARD_WIDTH / 2, Math.min(width - NODE_CARD_WIDTH / 2, node.x));
      node.y = Math.max(NODE_CARD_HEIGHT / 2, Math.min(height - NODE_CARD_HEIGHT / 2, node.y));
    });
  }
}

export function separateNodeOverlaps(
  nodes: SimNode[],
  width: number,
  height: number,
  strength = 1,
  passes = 1,
  options?: { minX?: number; minY?: number },
) {
  const minX = options?.minX ?? NODE_CARD_WIDTH + NODE_COLLISION_GAP_X;
  const minY = options?.minY ?? NODE_CARD_HEIGHT + NODE_COLLISION_GAP_Y;
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const overlapX = minX - Math.abs(dx);
        const overlapY = minY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        if (dx === 0 && dy === 0) {
          const angle = ((i + 1) * 12.9898 + (j + 1) * 78.233) % (Math.PI * 2);
          dx = Math.cos(angle) || 0.01;
          dy = Math.sin(angle) || 0.01;
        }

        if (overlapX < overlapY) {
          const push = (overlapX / 2) * Math.sign(dx || 1) * strength;
          a.x -= push;
          b.x += push;
          a.vx -= push * 0.02;
          b.vx += push * 0.02;
        } else {
          const push = (overlapY / 2) * Math.sign(dy || 1) * strength;
          a.y -= push;
          b.y += push;
          a.vy -= push * 0.02;
          b.vy += push * 0.02;
        }

        a.x = Math.max(NODE_CARD_WIDTH / 2, Math.min(width - NODE_CARD_WIDTH / 2, a.x));
        b.x = Math.max(NODE_CARD_WIDTH / 2, Math.min(width - NODE_CARD_WIDTH / 2, b.x));
        a.y = Math.max(NODE_CARD_HEIGHT / 2, Math.min(height - NODE_CARD_HEIGHT / 2, a.y));
        b.y = Math.max(NODE_CARD_HEIGHT / 2, Math.min(height - NODE_CARD_HEIGHT / 2, b.y));
        moved = true;
      }
    }
    if (!moved) return;
  }
}

export function truncate(s: string, max = 20) {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function filterByTime(simNodes: SimNode[], edges: KGEdge[], timeSlider: number) {
  if (simNodes.length === 0) return { visibleNodes: [] as SimNode[], visibleEdges: [] as KGEdge[] };
  if (timeSlider >= 100) return { visibleNodes: simNodes, visibleEdges: edges };
  const sorted = [...simNodes].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const cutoff = Math.max(1, Math.floor(sorted.length * timeSlider / 100));
  const ids = new Set(sorted.slice(0, cutoff).map(n => n.id));
  return {
    visibleNodes: simNodes.filter(n => ids.has(n.id)),
    visibleEdges: edges.filter(e => {
      const endpoints = edgeEndpoints(e);
      return Boolean(endpoints.from && endpoints.to && ids.has(endpoints.from) && ids.has(endpoints.to));
    }),
  };
}
