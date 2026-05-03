import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type TraceEventType = 'llm_call' | 'tool_use' | 'web_search' | 'file_read' | 'file_write' | 'kg_update';

export interface TraceEvent {
  timestamp: string;
  stageId: string;
  type: TraceEventType;
  inputSummary: string;
  outputSummary: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs: number;
  kgNodesAdded?: string[];
}

function tracePath(projectDir: string, runId: string, stageId: string): string {
  return join(projectDir, '.fc', 'runs', runId, 'stages', stageId, 'trace.jsonl');
}

export function appendTraceEvent(projectDir: string, runId: string, stageId: string, event: TraceEvent): void {
  const p = tracePath(projectDir, runId, stageId);
  mkdirSync(join(projectDir, '.fc', 'runs', runId, 'stages', stageId), { recursive: true });
  appendFileSync(p, JSON.stringify(event) + '\n', 'utf-8');
}

export function readTraceEvents(projectDir: string, runId: string, stageId: string): TraceEvent[] {
  const p = tracePath(projectDir, runId, stageId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e): e is TraceEvent => e !== null);
}

export function readAllTraceEvents(projectDir: string, runId: string): TraceEvent[] {
  const stagesDir = join(projectDir, '.fc', 'runs', runId, 'stages');
  if (!existsSync(stagesDir)) return [];
  const events: TraceEvent[] = [];
  try {
    for (const stageId of readdirSync(stagesDir)) {
      events.push(...readTraceEvents(projectDir, runId, stageId));
    }
  } catch { /* no stages */ }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export interface TraceSummary {
  totalEvents: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  totalDurationMs: number;
  byType: Record<string, number>;
}

export function summarizeTrace(events: TraceEvent[]): TraceSummary {
  const byType: Record<string, number> = {};
  let totalTokensIn = 0, totalTokensOut = 0, totalCostUsd = 0, totalDurationMs = 0;
  for (const e of events) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    totalTokensIn += e.tokensIn ?? 0;
    totalTokensOut += e.tokensOut ?? 0;
    totalCostUsd += e.costUsd ?? 0;
    totalDurationMs += e.durationMs;
  }
  return { totalEvents: events.length, totalTokensIn, totalTokensOut, totalCostUsd, totalDurationMs, byType };
}
