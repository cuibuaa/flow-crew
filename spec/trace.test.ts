import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  appendTraceEvent,
  readTraceEvents,
  readAllTraceEvents,
  summarizeTrace,
  type TraceEvent,
} from '../src/trace.js';
import { createRun, runDir } from '../src/store.js';

let projectDir: string;
let runId: string;

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    timestamp: new Date().toISOString(),
    stageId: 'stage-1',
    type: 'llm_call',
    inputSummary: 'test input',
    outputSummary: 'test output',
    durationMs: 100,
    ...overrides,
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'trace-test-'));
  runId = 'trace-' + randomBytes(6).toString('hex');
});

afterEach(() => {
  rmSync(runDir(projectDir, runId), { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

// 1. appendTraceEvent writes to trace.jsonl
describe('appendTraceEvent', () => {
  it('creates trace.jsonl with the event', () => {
    const event = makeEvent();
    appendTraceEvent(projectDir, runId, 'stage-1', event);
    const p = join(runDir(projectDir, runId), 'stages', 'stage-1', 'trace.jsonl');
    expect(existsSync(p)).toBe(true);
    const events = readTraceEvents(projectDir, runId, 'stage-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('llm_call');
    expect(events[0].inputSummary).toBe('test input');
  });
});

// 2. readTraceEvents returns all events for a stage
describe('readTraceEvents', () => {
  it('returns empty array when no file exists', () => {
    expect(readTraceEvents(projectDir, runId, 'nonexistent')).toEqual([]);
  });

  it('returns all events written to a stage', () => {
    const e1 = makeEvent({ timestamp: '2024-01-01T00:00:00Z', type: 'llm_call' });
    const e2 = makeEvent({ timestamp: '2024-01-01T00:01:00Z', type: 'tool_use' });
    const e3 = makeEvent({ timestamp: '2024-01-01T00:02:00Z', type: 'file_read' });
    appendTraceEvent(projectDir, runId, 'stage-1', e1);
    appendTraceEvent(projectDir, runId, 'stage-1', e2);
    appendTraceEvent(projectDir, runId, 'stage-1', e3);
    const events = readTraceEvents(projectDir, runId, 'stage-1');
    expect(events).toHaveLength(3);
    expect(events.map(e => e.type)).toEqual(['llm_call', 'tool_use', 'file_read']);
  });
});

// 3. readAllTraceEvents returns events across all stages sorted by timestamp
describe('readAllTraceEvents', () => {
  it('returns empty array when no stages exist', () => {
    expect(readAllTraceEvents(projectDir, runId)).toEqual([]);
  });

  it('returns events from multiple stages sorted by timestamp', () => {
    const e1 = makeEvent({ timestamp: '2024-01-01T00:00:00Z', stageId: 'stage-a' });
    const e2 = makeEvent({ timestamp: '2024-01-01T00:02:00Z', stageId: 'stage-a' });
    const e3 = makeEvent({ timestamp: '2024-01-01T00:01:00Z', stageId: 'stage-b' });
    appendTraceEvent(projectDir, runId, 'stage-a', e1);
    appendTraceEvent(projectDir, runId, 'stage-a', e2);
    appendTraceEvent(projectDir, runId, 'stage-b', e3);
    const all = readAllTraceEvents(projectDir, runId);
    expect(all).toHaveLength(3);
    expect(all[0].timestamp).toBe('2024-01-01T00:00:00Z');
    expect(all[1].timestamp).toBe('2024-01-01T00:01:00Z');
    expect(all[2].timestamp).toBe('2024-01-01T00:02:00Z');
  });
});

// 4. summarizeTrace computes correct totals
describe('summarizeTrace', () => {
  it('returns zeroed summary for empty events', () => {
    const summary = summarizeTrace([]);
    expect(summary.totalEvents).toBe(0);
    expect(summary.totalTokensIn).toBe(0);
    expect(summary.totalTokensOut).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.totalDurationMs).toBe(0);
    expect(summary.byType).toEqual({});
  });

  it('computes correct totals and byType counts', () => {
    const events: TraceEvent[] = [
      makeEvent({ type: 'llm_call', tokensIn: 100, tokensOut: 50, costUsd: 0.01, durationMs: 200 }),
      makeEvent({ type: 'llm_call', tokensIn: 200, tokensOut: 100, costUsd: 0.02, durationMs: 300 }),
      makeEvent({ type: 'tool_use', tokensIn: 10, tokensOut: 5, costUsd: 0.001, durationMs: 50 }),
      makeEvent({ type: 'file_write', durationMs: 20 }),
    ];
    const summary = summarizeTrace(events);
    expect(summary.totalEvents).toBe(4);
    expect(summary.totalTokensIn).toBe(310);
    expect(summary.totalTokensOut).toBe(155);
    expect(summary.totalCostUsd).toBeCloseTo(0.031);
    expect(summary.totalDurationMs).toBe(570);
    expect(summary.byType).toEqual({ llm_call: 2, tool_use: 1, file_write: 1 });
  });
});
