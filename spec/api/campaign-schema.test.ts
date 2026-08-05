import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { startDashboard } from "../../src/dashboard.js";
import { runsRoot } from "../../src/store.js";

let app: FastifyInstance;
let projectDir: string;
let homeDir: string;
let oldHome: string | undefined;
let runId: string;

const metric = z.object({ name: z.string(), value: z.number().nullable(), format: z.enum(["currency_usd", "rating_0_to_10", "pct", "count", "duration_min", "raw"]), target: z.any().optional(), sublabel: z.string().optional() }).nullable();
const campaign = z.object({
  id: z.string(), name: z.string(), status: z.string(), badges: z.array(z.object({ text: z.string(), kind: z.string() })),
  metric, iterations: z.array(z.any()).nullable(), phases: z.array(z.any()).nullable(), brief_revisions: z.array(z.any()).nullable(), runs: z.array(z.any()),
});
const runDetail = z.object({ runId: z.string(), projectDir: z.string(), workflowName: z.string(), status: z.string(), stages: z.array(z.any()), kg: z.object({ nodes: z.array(z.any()), edges: z.array(z.any()) }), events: z.array(z.any()), stage_outputs: z.record(z.string(), z.string()) });

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

beforeEach(async () => {
  projectDir = mkdtempSync(join(tmpdir(), "fc-api-project-"));
  homeDir = mkdtempSync(join(tmpdir(), "fc-api-home-"));
  oldHome = process.env.HOME;
  process.env.HOME = homeDir;
  mkdirSync(join(projectDir, "config", "agents"), { recursive: true });
  mkdirSync(join(projectDir, "config", "workflows"), { recursive: true });
  writeFileSync(join(projectDir, "config", "agents", "planner.yaml"), "name: planner\ndescription: Plans\ntools: [read]\nmodel: hidden\nprompt: p\n", "utf-8");
  writeFileSync(join(projectDir, "config", "workflows", "default.yaml"), "name: default\nstages: []\n", "utf-8");
  runId = `api-contract-${Date.now().toString(36)}-abcd12`;
  mkdirSync(join(runsRoot(), runId, "stages", "plan"), { recursive: true });
  writeJson(join(runsRoot(), runId, "run.json"), { runId, workflowName: "default", projectDir, status: "complete", stages: { plan: { status: "complete", retries: 0, artifacts: [] } }, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:05:00.000Z", taskDescription: "Task", campaignId: "camp" });
  writeFileSync(join(runsRoot(), runId, "stages", "plan", "output.md"), "ok", "utf-8");
  const campDir = join(homeDir, ".fc", "campaigns", "camp");
  mkdirSync(campDir, { recursive: true });
  writeJson(join(campDir, "state.json"), { status: "running", started_at: "2026-01-01T00:00:00.000Z" });
  app = await startDashboard(projectDir, 0);
}, 30000);

afterEach(async () => {
  await app?.close();
  if (runId) rmSync(join(runsRoot(), runId), { recursive: true, force: true });
  process.env.HOME = oldHome;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

describe("workspace API contract", () => {
  it("validates campaign endpoints and CORS", async () => {
    const list = await app.inject({ method: "GET", url: "/api/campaigns" });
    expect(list.statusCode).toBe(200);
    expect(list.headers["access-control-allow-origin"]).toBe("*");
    const campaigns = z.array(campaign).parse(list.json());
    expect(campaigns.length).toBeGreaterThanOrEqual(1);
    expect(list.json()[0]).not.toHaveProperty("config");
    expect(list.json()[0]).not.toHaveProperty("kg_node_count");
    const one = await app.inject({ method: "GET", url: `/api/campaigns/${campaigns[0].id}` });
    expect(one.statusCode).toBe(200);
    campaign.parse(one.json());
  });

  it("validates run, KG, standalone, and agents endpoints", async () => {
    const runs = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    expect(runs.statusCode).toBe(200);
    runDetail.parse(runs.json());
    expect(z.array(z.any()).parse((await app.inject({ method: "GET", url: "/api/cross-campaign-kg/nodes" })).json())).toBeDefined();
    expect(z.array(z.any()).parse((await app.inject({ method: "GET", url: "/api/cross-campaign-kg/edges" })).json())).toBeDefined();
    expect(z.array(z.any()).parse((await app.inject({ method: "GET", url: "/api/standalone-runs" })).json())).toBeDefined();
    const agents = (await app.inject({ method: "GET", url: "/api/agents" })).json();
    expect(agents[0]).not.toHaveProperty("model");
  });

  it("returns graceful missing values instead of 500", async () => {
    expect((await app.inject({ method: "GET", url: "/api/campaigns/missing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/cross-campaign-kg/nodes" })).statusCode).toBe(200);
    expect((await app.inject({ method: "OPTIONS", url: "/api/campaigns" })).statusCode).toBe(204);
  });
});
