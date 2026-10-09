import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRunSummary } from "../ui/src/api";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from '../src/dashboard.js';
import { createRun, fcGlobalDir, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';

describe("run summary read semantics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats only HTTP 404 as a known missing summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    await expect(fetchRunSummary("missing-summary")).resolves.toBeNull();
  });

  it("surfaces non-404 and network failures instead of turning them into empty data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "summary backend unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(fetchRunSummary("backend-error")).rejects.toThrow("summary backend unavailable");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    await expect(fetchRunSummary("network-error")).rejects.toThrow("connection refused");
  });

  it("rejects malformed success payloads while accepting text content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
    await expect(fetchRunSummary("invalid-json")).rejects.toThrow("not valid JSON");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: 42 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(fetchRunSummary("invalid-content")).rejects.toThrow("did not contain text content");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: "# Progress\n\nStill running" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(fetchRunSummary("progress-fallback")).resolves.toBe("# Progress\n\nStill running");
  });
});

describe('dashboard iteration history', () => {
  it('reports malformed optional iteration history without hiding a readable run or valid retired rows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'run-page-optional-history-'));
    const previous = fcGlobalDir();
    let app: Awaited<ReturnType<typeof startDashboard>> | undefined;
    try {
      const project = join(root, 'project'); mkdirSync(project);
      setFcGlobalDir(join(root, 'store'));
      const { runId } = createRun(project, 'fixture', 'name: fixture\nstages: []', ['active']);
      // Raw persisted optional data can be malformed even when core hydration
      // succeeds. Use the gate's damaged iteration, with a valid-row control.
      const path = join(runDir(project, runId), 'run.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      state.status = 'complete';
      const status = { status: 'failed', retries: 0 };
      state.retiredStageUsage = [
        { stageId: 'work', iteration: 'damaged-optional-iteration', status },
        { stageId: 'valid', iteration: 1, status },
      ];
      writeFileSync(path, JSON.stringify(state));
      app = await startDashboard(project, 0, { listTasks: async () => [] });
      const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
      expect(response.statusCode).toBe(200);
      const detail = response.json();
      expect(detail.status).toBe('complete');
      expect(detail.stages.map((stage: { id: string }) => stage.id)).toEqual(['active']);
      expect(detail.stageHistory).toEqual([{ stageId: 'valid', iteration: 1, status }]);
      expect(detail.stageHistoryDiagnostics).toEqual([expect.objectContaining({ code: 'RUN_STAGE_HISTORY_INVALID', path: 'retiredStageUsage[0]' })]);
    } finally {
      if (app) await app.close();
      setFcGlobalDir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps retired stages separate and returns the canonical execution budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'run-page-history-'));
    const previous = fcGlobalDir();
    let app: Awaited<ReturnType<typeof startDashboard>> | undefined;
    try {
      const project = join(root, 'project');
      mkdirSync(project);
      setFcGlobalDir(join(root, 'store'));
      const { runId } = createRun(project, 'fixture', 'name: fixture\nstages: []', ['active']);
      updateRunState(project, runId, state => {
        const status = { status: 'failed' as const, retries: 0, attempts: [{ index: 1, status: 'failed' as const, startedAt: '2026-01-01T00:00:00.000Z', tokens_in: 700, tokens_out: 300 }] };
        state.retiredStageUsage = [{ stageId: 'old', iteration: 1, status }];
        state.stageEvidence = [{ stageId: 'old', iteration: 1, status, statusPath: 'unused.json', attemptOutputPaths: [] }];
      });
      app = await startDashboard(project, 0, { listTasks: async () => [] });
      const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
      expect(response.statusCode).toBe(200);
      const detail = response.json();
      expect(detail.stages.map((stage: { id: string }) => stage.id)).toEqual(['active']);
      expect(detail.stageHistory).toHaveLength(1);
      expect(detail.stageHistory[0]).toMatchObject({ stageId: 'old', iteration: 1, status: { status: 'failed' } });
      expect(detail.budget.tokens).toMatchObject({ knownInputTokens: 700, knownOutputTokens: 300 });
    } finally {
      if (app) await app.close();
      setFcGlobalDir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
