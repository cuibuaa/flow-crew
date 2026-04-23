import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync, unlinkSync, renameSync } from "node:fs";
import { join, extname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { listRuns, readRunState, readStageOutput, readStageInput, createRun, writeRunState } from "./store.js";
import type { StoreState } from "./store.js";
import { loadWorkflow, runWorkflow, WorkflowConfigSchema, findDownstream, StageConfigSchema } from "./scheduler.js";
import type { StageConfig } from "./scheduler.js";
import type { AgentConfig, Adapter } from "./adapters/base.js";
import { z } from "zod";

// --- Dynamic adapter loading ---
async function resolveAdapter(): Promise<Adapter> {
  const defaultsPath = join(process.cwd(), "config", "defaults.yaml");
  const defaults = existsSync(defaultsPath) ? parseYaml(readFileSync(defaultsPath, "utf-8")) as Record<string, unknown> : {};
  const name = (defaults.adapter as string) || "codex";
  const map: Record<string, string> = { codex: "./adapters/codex.js", claude: "./adapters/claude.js" };
  const mod = await import(map[name] || map.codex);
  return mod.createAdapter();
}

// --- Project defaults for agent config fallback ---
function loadProjectDefaults(): { model: string; reasoning_effort: string } {
  try {
    const raw = readFileSync(join(process.cwd(), 'config', 'defaults.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    return {
      model: typeof parsed.model === 'string' ? parsed.model : 'default',
      reasoning_effort: typeof parsed.reasoning_effort === 'string' ? parsed.reasoning_effort : 'default',
    };
  } catch { return { model: 'default', reasoning_effort: 'default' }; }
}

const DashboardAgentSchema = z.object({ name: z.string(), description: z.string().default(''), model: z.string().default('default'), reasoning_effort: z.string().default('default'), tools: z.array(z.string()).default([]), prompt: z.string() });

function parseAgentConfig(raw: unknown): AgentConfig {
  const defaults = loadProjectDefaults();
  const agent = DashboardAgentSchema.parse(raw);
  if (agent.model === 'default') agent.model = defaults.model;
  if (agent.reasoning_effort === 'default') agent.reasoning_effort = defaults.reasoning_effort;
  return agent;
}

// --- Shared helpers ---

function loadStageRoles(projectDir: string, runId: string): Record<string, { role: string; dependsOn: string[]; isGate?: boolean }> {
  try {
    const raw = readFileSync(join(projectDir, '.fc', 'runs', runId, 'workflow.yaml'), 'utf-8');
    const wf = parseYaml(raw) as { stages?: { id: string; role?: string; depends_on?: string[]; is_gate?: boolean }[] };
    const map: Record<string, { role: string; dependsOn: string[]; isGate?: boolean }> = {};
    for (const s of wf.stages ?? []) {
      map[s.id] = { role: s.role ?? '', dependsOn: s.depends_on ?? [], isGate: s.is_gate };
    }
    return map;
  } catch {
    return {};
  }
}

const agentsDir = join(process.cwd(), 'config', 'agents');

export function buildCampaignContext(projectDir: string, campaignId: string, currentRunId: string): string {
  const campaignPath = join(projectDir, '.fc', 'campaigns', `${campaignId}.jsonl`);
  const runsDir = join(projectDir, '.fc', 'runs');

  // Load JSONL entries
  let entries: { seq?: number; runId?: string; score?: number; metric?: string; gate?: string; pass?: boolean; timestamp?: string }[] = [];
  try {
    const lines = readFileSync(campaignPath, 'utf-8').trim().split('\n').filter(Boolean);
    entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* no JSONL */ }

  // Find sibling runs
  interface SiblingRun { runId: string; taskDescription?: string; startedAt?: string; briefPath: string }
  const siblings: SiblingRun[] = [];
  try {
    for (const dir of readdirSync(runsDir)) {
      if (dir === currentRunId) continue;
      const runJsonPath = join(runsDir, dir, 'run.json');
      try {
        const rState = JSON.parse(readFileSync(runJsonPath, 'utf-8'));
        if (rState.campaignId === campaignId) {
          const bp = join(runsDir, dir, 'task_brief.md');
          siblings.push({ runId: dir, taskDescription: rState.taskDescription, startedAt: rState.startedAt, briefPath: bp });
        }
      } catch { /* skip */ }
    }
  } catch { /* no runs dir */ }

  if (entries.length === 0 && siblings.length === 0) return '';

  let ctx = '# Campaign Context\n\nThis task belongs to a campaign. Use the information below to answer questions about previous explorations — do NOT search the filesystem for this information.\n\n';

  // Score history table
  if (entries.length > 0) {
    ctx += '## Score History\n\n| # | Run | Score | Metric | Gate | Pass |\n|---|-----|-------|--------|------|------|\n';
    for (const e of entries) {
      ctx += `| ${e.seq ?? '-'} | ${e.runId?.slice(0, 8) ?? '-'} | ${e.score ?? '-'} | ${e.metric ?? '-'} | ${e.gate ?? '-'} | ${e.pass ? '✅' : '❌'} |\n`;
    }
    ctx += '\n';
  }

  // Sort siblings by startedAt descending
  siblings.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

  // Recent 2-3: full task brief; older: one-line summary
  for (let i = 0; i < siblings.length; i++) {
    const s = siblings[i];
    if (i < 3) {
      try {
        const brief = readFileSync(s.briefPath, 'utf-8');
        ctx += `## Run ${s.runId.slice(0, 8)} — Full Brief\n\n${brief}\n\n`;
      } catch {
        ctx += `- Run ${s.runId.slice(0, 8)}: ${s.taskDescription ?? 'no description'}\n`;
      }
    } else {
      ctx += `- Run ${s.runId.slice(0, 8)}: ${s.taskDescription ?? 'no description'}\n`;
    }
  }

  return ctx;
}

function readBestScore(projectDir: string, runId: string): { bestScore?: number; metricName?: string } {
  const runPath = join(projectDir, '.fc', 'runs', runId);
  try {
    const files = readdirSync(runPath).filter(f => f.startsWith('metrics_') && f.endsWith('.json'));
    let best: number | undefined;
    let name: string | undefined;
    for (const f of files) {
      try {
        const m = JSON.parse(readFileSync(join(runPath, f), 'utf-8'));
        if (typeof m.score === 'number' && (best === undefined || m.score > best)) {
          best = m.score;
          name = m.metric_name;
        }
      } catch { /* skip */ }
    }
    return { bestScore: best, metricName: name };
  } catch { return {}; }
}

interface RunApiShape {
  runId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  stages: { id: string; role: string; status: string; duration_ms?: number; retries: number; dependsOn: string[] }[];
}

function stateToApi(state: StoreState, projectDir: string): RunApiShape {
  const roles = loadStageRoles(projectDir, state.runId);
  return {
    runId: state.runId,
    workflowName: state.workflowName,
    status: state.status,
    startedAt: state.startedAt,
    stages: Object.entries(state.stages).map(([id, s]) => ({
      id,
      role: roles[id]?.role ?? "",
      status: s.status,
      duration_ms: s.duration_ms,
      retries: s.retries,
      dependsOn: roles[id]?.dependsOn ?? [],
    })),
  };
}

interface TaskShape {
  id: string;
  name: string;
  type: string;
  workflow: string;
  status: string;
  stages: { id: string; role: string; status: string; duration_ms?: number; retries: number; artifacts?: string[]; dependsOn: string[]; dispatched: boolean; startedAt?: string; isGate?: boolean }[];
  startedAt: string;
  elapsed_ms: number;
  tokens: number;
  bestScore?: number;
  metricName?: string;
  discussion: unknown[];
  plan: unknown[];
  dispatchedStages?: unknown[];
  currentIteration: number;
  maxIterations: number;
  autoApproveRetries: boolean;
  iterationLog: string | null;
  campaignId?: string;
  campaignSeq?: number;
  failureReason?: string;
  completedAt?: string;
}

function stateToTask(state: StoreState, projectDir: string): TaskShape {
  const roles = loadStageRoles(projectDir, state.runId);
  const dsArr = Array.isArray(state.dispatchedStages) ? (state.dispatchedStages as { id?: string; is_gate?: boolean }[]).filter(Boolean) : [];
  const dispatchedIds = new Set(
    dsArr.map((s) => s.id).filter(Boolean),
  );
  const dispatchedArr = dsArr;
  const stages = Object.entries(state.stages).map(([id, s]) => ({
    id,
    role: roles[id]?.role ?? "",
    status: s.status,
    duration_ms: s.duration_ms,
    retries: s.retries,
    artifacts: s.artifacts ?? [],
    dependsOn: roles[id]?.dependsOn ?? [],
    dispatched: dispatchedIds.has(id),
    startedAt: s.startedAt,
    isGate: dispatchedArr.find(d => d.id === id)?.is_gate ?? roles[id]?.isGate,
  }));
  const elapsed_ms = state.status === 'running' || state.status === 'awaiting_approval'
    ? Math.max(0, Date.now() - Date.parse(state.startedAt)) || 0
    : stages.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
  const totalTokens = Object.values(state.stages).reduce((sum, s) => sum + (s.tokens_in ?? 0) + (s.tokens_out ?? 0), 0);
  const { bestScore, metricName } = readBestScore(projectDir, state.runId);
  const task: TaskShape = {
    id: state.runId,
    name: state.taskDescription || state.workflowName,
    type: '',
    workflow: state.workflowName,
    status: state.status === 'complete' ? 'completed' : state.status,
    stages,
    startedAt: state.startedAt,
    elapsed_ms,
    tokens: totalTokens,
    bestScore,
    metricName,
    discussion: state.discussion ?? [],
    plan: state.plan ?? [],
    currentIteration: state.currentIteration ?? 1,
    maxIterations: state.maxIterations ?? 3,
    autoApproveRetries: state.autoApproveRetries ?? true,
    iterationLog: null,
    campaignId: state.campaignId,
    campaignSeq: state.campaignSeq,
    failureReason: state.failureReason,
    completedAt: state.completedAt,
  };
  if (state.dispatchedStages) task.dispatchedStages = state.dispatchedStages;
  const logPath = join(projectDir, '.fc', 'runs', state.runId, 'iteration_log.md');
  try { task.iterationLog = readFileSync(logPath, 'utf-8'); } catch { /* not found */ }
  return task;
}

function isSafeId(id: string): boolean {
  return !id.includes('..') && !id.includes('/') && !id.includes('\\');
}

export async function startDashboard(projectDir: string, port = 3000) {
  // Migration: rename .omx to .fc if needed
  const oldDir = join(projectDir, '.omx');
  const newDir = join(projectDir, '.fc');
  if (existsSync(oldDir) && !existsSync(newDir)) {
    renameSync(oldDir, newDir);
  }

  const app = Fastify({ logger: false });

  await app.register(websocket);

  // CORS
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    return payload;
  });

  // Path traversal protection for mutation routes
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'OPTIONS') return;
    const params = req.params as Record<string, string> | undefined;
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (typeof val === 'string' && !isSafeId(val)) {
          return reply.code(400).send({ error: `invalid ${key}` });
        }
      }
    }
  });
  app.options('/*', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    reply.code(204).send();
  });

  // --- PTY session persistence ---
  interface PtySession {
    session: import('./adapters/base.js').InteractiveSession;
    outputBuffer: string[];
    alive: boolean;
    planPolling: boolean;
  }
  const ptySessions = new Map<string, PtySession>();

  // --- Static file serving ---
  const uiDist = join(import.meta.dirname ?? '.', '..', 'ui', 'dist');
  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, prefix: '/', wildcard: false });
  }

  // SPA fallback: non-API, non-file-extension GET requests serve index.html
  app.setNotFoundHandler(async (req, reply) => {
    // Reject mutation requests to unknown paths (likely path traversal attempts)
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      return reply.code(400).send({ error: 'invalid path' });
    }
    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
      return reply.code(204).send();
    }
    if (!req.url.startsWith('/api/') && !extname(req.url.split('?')[0])) {
      const indexPath = join(uiDist, 'index.html');
      if (existsSync(indexPath)) {
        reply.type('text/html').send(readFileSync(indexPath, 'utf-8'));
        return;
      }
    }
    reply.code(404).send({ error: 'not found' });
  });

  // ===================== Existing /api/runs endpoints =====================

  app.get("/api/runs", async () => {
    const ids = listRuns(projectDir);
    return ids.map((id) => {
      try { return stateToApi(readRunState(projectDir, id), projectDir); } catch { return null; }
    }).filter(Boolean);
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (req, reply) => {
    try {
      return stateToApi(readRunState(projectDir, req.params.runId), projectDir);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  app.get<{ Params: { runId: string; stageId: string } }>(
    "/api/runs/:runId/stages/:stageId/input",
    async (req, reply) => {
      const p = join(projectDir, '.fc', 'runs', req.params.runId, 'stages', req.params.stageId, 'input.md');
      if (!existsSync(p)) return reply.code(404).send("not found");
      reply.type("text/markdown").send(readStageInput(projectDir, req.params.runId, req.params.stageId));
    },
  );

  app.get<{ Params: { runId: string; stageId: string } }>(
    "/api/runs/:runId/stages/:stageId/output",
    async (req, reply) => {
      const p = join(projectDir, '.fc', 'runs', req.params.runId, 'stages', req.params.stageId, 'output.md');
      if (!existsSync(p)) return reply.code(404).send("not found");
      reply.type("text/markdown").send(readStageOutput(projectDir, req.params.runId, req.params.stageId));
    },
  );

  // ===================== Task endpoints =====================

  // 1. GET /api/tasks
  app.get("/api/tasks", async () => {
    const ids = listRuns(projectDir);
    return ids.map((id) => {
      try { return stateToTask(readRunState(projectDir, id), projectDir); } catch { return null; }
    }).filter(Boolean);
  });

  // 2. POST /api/tasks
  app.post<{ Body: { name: string; workflow: string; discussion?: unknown[]; plan?: unknown[]; planFile?: string; campaignId?: string; campaignSeq?: number } }>("/api/tasks", async (req, reply) => {
    if (!req.body || typeof req.body !== 'object') return reply.code(400).send({ error: 'missing body' });
    const { name, workflow, discussion, plan, planFile, campaignId, campaignSeq } = req.body;
    const safeName = typeof name === 'string' ? name : (name != null ? String(name) : undefined);
    const yamlName = typeof name === 'string' ? name : String(name ?? 'untitled');
    const minimalYaml = stringifyYaml({ name: yamlName, stages: [] });
    const { runId } = createRun(projectDir, workflow || 'default', minimalYaml, []);
    const state = readRunState(projectDir, runId);
    state.status = 'pending';
    state.taskDescription = safeName as any;
    state.autoApproveRetries = true;
    if (discussion) state.discussion = discussion;
    if (plan) state.plan = plan;
    if (campaignId) state.campaignId = campaignId;
    if (campaignSeq != null) state.campaignSeq = campaignSeq;
    writeRunState(projectDir, runId, state);
    if (planFile) {
      const runPath = join(projectDir, '.fc', 'runs', runId);
      mkdirSync(runPath, { recursive: true });
      writeFileSync(join(runPath, 'task_brief.md'), planFile, 'utf-8');
    }
    return { id: runId };
  });

  // 3. GET /api/tasks/:id
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    try {
      return stateToTask(readRunState(projectDir, req.params.id), projectDir);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  // GET /api/tasks/:id/iteration-log
  app.get<{ Params: { id: string } }>("/api/tasks/:id/iteration-log", async (req, reply) => {
    const logPath = join(projectDir, '.fc', 'runs', req.params.id, 'iteration_log.md');
    if (!existsSync(logPath)) return reply.code(404).send({ error: 'not found' });
    reply.type('text/markdown').send(readFileSync(logPath, 'utf-8'));
  });

  // 3b. PUT /api/tasks/:id
  app.put<{ Params: { id: string }; Body: { plan?: unknown[]; discussion?: unknown[]; name?: string; workflow?: string } }>("/api/tasks/:id", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    const { plan, discussion, name, workflow } = req.body ?? {};
    if (plan !== undefined) state.plan = plan;
    if (discussion !== undefined) state.discussion = discussion;
    if (name !== undefined) state.taskDescription = typeof name === 'string' ? name : String(name);
    if (workflow) state.workflowName = workflow;
    writeRunState(projectDir, req.params.id, state);
    return { ok: true };
  });

  // PATCH /api/tasks/:id — update task settings
  app.patch<{ Params: { id: string }; Body: { name?: string; timeoutMs?: number; maxIterations?: number; maxRetries?: number; autoApproveRetries?: boolean; campaignTriggers?: unknown; campaignId?: string; campaignSeq?: number } }>("/api/tasks/:id", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    const body = req.body ?? {};
    if (body.name !== undefined) state.taskDescription = body.name != null ? String(body.name) : undefined;
    if (body.timeoutMs !== undefined) {
      const t = Number(body.timeoutMs);
      if (isFinite(t) && t >= 0) state.timeoutMs = t;
    }
    if (body.maxIterations !== undefined) {
      const m = Number(body.maxIterations);
      if (isFinite(m) && m >= 0) state.maxIterations = m;
    }
    if (body.maxRetries !== undefined) {
      const r = Number(body.maxRetries);
      if (isFinite(r) && r >= 0) (state as any).maxRetries = r;
    }
    if (body.autoApproveRetries !== undefined) state.autoApproveRetries = !!body.autoApproveRetries;
    if (body.campaignTriggers !== undefined) (state as any).campaignTriggers = body.campaignTriggers;
    if (body.campaignId !== undefined) state.campaignId = body.campaignId;
    if (body.campaignSeq !== undefined) state.campaignSeq = body.campaignSeq;
    writeRunState(projectDir, req.params.id, state);
    return { ok: true };
  });

  // GET /api/tasks/:id/dispatch
  app.get<{ Params: { id: string } }>("/api/tasks/:id/dispatch", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    if (state.status === 'awaiting_approval' && state.dispatchedStages) {
      return { stages: state.dispatchedStages, status: state.status };
    }
    // Also try reading dispatch.yaml file directly
    const dispatchPath = join(projectDir, '.fc', 'runs', req.params.id, 'dispatch.yaml');
    if (existsSync(dispatchPath)) {
      try {
        const items = parseYaml(readFileSync(dispatchPath, 'utf-8'));
        if (Array.isArray(items)) return { stages: items, status: state.status };
      } catch { /* ignore */ }
    }
    return { stages: [], status: state.status };
  });

  // POST /api/tasks/:id/approve
  app.post<{ Params: { id: string }; Body: { autoApproveRetries?: boolean; maxIterations?: number; timeoutMs?: number } }>("/api/tasks/:id/approve", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    if (state.status !== 'awaiting_approval') {
      return reply.code(400).send({ error: 'not awaiting approval' });
    }
    if (req.body?.autoApproveRetries !== undefined) state.autoApproveRetries = !!req.body.autoApproveRetries;
    if (req.body?.maxIterations !== undefined) {
      const m = Number(req.body.maxIterations);
      if (isFinite(m) && m >= 0) state.maxIterations = m;
    }
    if (req.body?.timeoutMs !== undefined) {
      const t = Number(req.body.timeoutMs);
      if (isFinite(t) && t >= 0) state.timeoutMs = t;
    }
    state.status = 'running';
    writeRunState(projectDir, req.params.id, state);
    return { ok: true };
  });

  // GET /api/tasks/:id/stages/:stageId/output
  app.get<{ Params: { id: string; stageId: string } }>(
    "/api/tasks/:id/stages/:stageId/output",
    async (req, reply) => {
      const p = join(projectDir, '.fc', 'runs', req.params.id, 'stages', req.params.stageId, 'output.md');
      if (!existsSync(p)) return reply.code(404).send("not found");
      reply.type("text/markdown").send(readStageOutput(projectDir, req.params.id, req.params.stageId));
    },
  );

  // 4. POST /api/tasks/:id/execute
  app.post<{ Params: { id: string } }>("/api/tasks/:id/execute", async (req, reply) => {
    let state: StoreState;
    try {
      state = readRunState(projectDir, req.params.id);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    const workflowName = state.workflowName || 'default';
    const yamlPath = join(process.cwd(), 'config', 'workflows', `${workflowName}.yaml`);
    if (!existsSync(yamlPath)) {
      return reply.code(404).send({ error: `workflow not found: ${workflowName}` });
    }
    const { config, raw } = loadWorkflow(yamlPath);
    const roles = [...new Set(config.stages.map((s) => s.role))];
    const agents = new Map<string, AgentConfig>();
    for (const role of roles) {
      const agentPath = join(process.cwd(), 'config', 'agents', `${role}.yaml`);
      if (!existsSync(agentPath)) continue;
      const parsed = parseYaml(readFileSync(agentPath, 'utf-8'));
      agents.set(role, parseAgentConfig(parsed));
    }
    // Bug 3: preload all agent configs so dispatched roles are available
    try {
      const allFiles = readdirSync(join(process.cwd(), 'config', 'agents')).filter((f) => f.endsWith('.yaml'));
      for (const f of allFiles) {
        const name = f.replace('.yaml', '');
        if (agents.has(name)) continue;
        const parsed = parseYaml(readFileSync(join(process.cwd(), 'config', 'agents', f), 'utf-8'));
        agents.set(name, parseAgentConfig(parsed));
      }
    } catch { /* agents dir may not exist */ }
    const adapter = await resolveAdapter();
    const taskDescription = state.taskDescription || 'task';
    runWorkflow(config, raw, projectDir, adapter, agents, undefined, undefined, req.params.id, taskDescription).catch(console.error);
    return { ok: true };
  });

  // 5. POST /api/tasks/:id/stop — removed (use cancel instead)

  // DELETE /api/tasks/:id
  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params;
    // Kill PTY if active
    const pty = ptySessions.get(id);
    if (pty?.alive) { try { pty.session.kill(); } catch { /* ignore */ } }
    ptySessions.delete(id);
    // Remove run directory
    const runPath = join(projectDir, '.fc', 'runs', id);
    try { rmSync(runPath, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: true };
  });

  // POST /api/tasks/:id/cancel
  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req, reply) => {
    const { id } = req.params;
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }
    if (state.status === 'complete' || state.status === 'failed') {
      return { ok: true };
    }
    // Kill PTY if active
    const pty = ptySessions.get(id);
    if (pty?.alive) { try { pty.session.kill(); } catch { /* ignore */ } pty.alive = false; }
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    for (const [, s] of Object.entries(state.stages)) {
      if (s.status === 'running') s.status = 'failed';
      if (s.status === 'pending') s.status = 'skipped';
    }
    writeRunState(projectDir, id, state);
    return { ok: true };
  });

  // POST /api/tasks/:id/rerun
  app.post<{ Params: { id: string } }>("/api/tasks/:id/rerun", async (req, reply) => {
    const { id } = req.params;
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }
    for (const [, s] of Object.entries(state.stages)) {
      s.status = 'pending';
      s.duration_ms = undefined;
      s.error = undefined;
      s.retries = 0;
      s.exitCode = undefined;
      s.artifacts = undefined;
      s.startedAt = undefined;
      s.completedAt = undefined;
      s.tokens_in = undefined;
      s.tokens_out = undefined;
    }
    state.completedAt = undefined;
    state.startedAt = new Date().toISOString();

    // Reset iteration state on rerun
    state.currentIteration = 1;
    state.failureReason = undefined;

    // Issue 61: clean up orphaned dispatched stages
    // First, remove any stages listed in dispatchedStages (these were dynamically added)
    const dispatchedIds = new Set<string>(
      (Array.isArray(state.dispatchedStages) ? state.dispatchedStages as { id?: string }[] : []).map(s => s.id).filter((x): x is string => !!x),
    );
    for (const sid of dispatchedIds) {
      delete state.stages[sid];
    }
    // Then, also remove stages not in workflow.yaml base stages
    // (exclude dispatched IDs from the base set since workflow.yaml may include them)
    const baseStageIds = new Set<string>();
    const wfPath = join(projectDir, '.fc', 'runs', id, 'workflow.yaml');
    try {
      const wf = parseYaml(readFileSync(wfPath, 'utf-8')) as { stages?: unknown[] };
      if (Array.isArray(wf.stages)) {
        for (const item of wf.stages) {
          try {
            const sc = StageConfigSchema.parse(item);
            if (!dispatchedIds.has(sc.id)) baseStageIds.add(sc.id);
          } catch { /* skip */ }
        }
        // Reset workflow.yaml to base stages only
        wf.stages = wf.stages.filter((item: any) => {
          try { return !dispatchedIds.has(StageConfigSchema.parse(item).id); } catch { return true; }
        });
        writeFileSync(wfPath, stringifyYaml(wf), 'utf-8');
      }
    } catch { /* no workflow */ }
    if (baseStageIds.size > 0) {
      for (const sid of Object.keys(state.stages)) {
        if (!baseStageIds.has(sid)) delete state.stages[sid];
      }
    }
    state.dispatchedStages = undefined;

    // Clear stale artifacts from previous run
    const runPath = join(projectDir, '.fc', 'runs', id);
    // Clear stale stage status.json files so they don't leak into API responses
    for (const sid of Object.keys(state.stages)) {
      const stageStatusPath = join(runPath, 'stages', sid, 'status.json');
      if (existsSync(stageStatusPath)) unlinkSync(stageStatusPath);
    }
    const iterLogPath = join(runPath, 'iteration_log.md');
    if (existsSync(iterLogPath)) unlinkSync(iterLogPath);
    const dispatchPath = join(runPath, 'dispatch.yaml');
    if (existsSync(dispatchPath)) unlinkSync(dispatchPath);
    try {
      for (const f of readdirSync(runPath)) {
        if (f.startsWith('verdict') && f.endsWith('.json')) unlinkSync(join(runPath, f));
      }
    } catch { /* ignore */ }

    // Check if task_brief.md exists to decide route
    const briefPath = join(projectDir, '.fc', 'runs', id, 'task_brief.md');
    if (existsSync(briefPath)) {
      state.status = 'running';
      writeRunState(projectDir, id, state);
      // Trigger workflow (same pattern as stage-level rerun)
      const workflowName = state.workflowName || 'default';
      const yamlPath = join(process.cwd(), 'config', 'workflows', `${workflowName}.yaml`);
      if (existsSync(yamlPath)) {
        try {
          const { config, raw } = loadWorkflow(yamlPath);
          const agents = new Map<string, AgentConfig>();
          try {
            const allFiles = readdirSync(join(process.cwd(), 'config', 'agents')).filter(f => f.endsWith('.yaml'));
            for (const f of allFiles) {
              const parsed = parseYaml(readFileSync(join(process.cwd(), 'config', 'agents', f), 'utf-8'));
              agents.set(f.replace('.yaml', ''), parseAgentConfig(parsed));
            }
          } catch { /* agents dir may not exist */ }
          const adapter = await resolveAdapter();
          const taskDescription = state.taskDescription || 'task';
          runWorkflow(config, raw, projectDir, adapter, agents, undefined, undefined, id, taskDescription).catch(console.error);
        } catch { /* workflow load failed */ }
      }
      return { ok: true, route: 'monitor' };
    } else {
      state.status = 'pending';
      writeRunState(projectDir, id, state);
      return { ok: true, route: 'discuss' };
    }
  });

  // POST /api/tasks/:id/stages/:stageId/rerun — stage-level rerun
  app.post<{ Params: { id: string; stageId: string } }>("/api/tasks/:id/stages/:stageId/rerun", async (req, reply) => {
    const { id, stageId } = req.params;
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }
    if (!state.stages[stageId]) return reply.code(404).send({ error: 'stage not found' });

    // Build StageConfig[] from workflow.yaml for dependency graph
    const wfPath = join(projectDir, '.fc', 'runs', id, 'workflow.yaml');
    let stages: StageConfig[] = [];
    try {
      const wf = parseYaml(readFileSync(wfPath, 'utf-8')) as { stages?: unknown[] };
      if (Array.isArray(wf.stages)) {
        for (const item of wf.stages) {
          try { stages.push(StageConfigSchema.parse(item)); } catch { /* skip */ }
        }
      }
    } catch { /* no workflow */ }

    const downstream = findDownstream(stageId, stages);
    const resetIds = [stageId, ...downstream];

    // Reset target + downstream
    const runPath = join(projectDir, '.fc', 'runs', id);
    for (const sid of resetIds) {
      state.stages[sid] = { status: 'pending', retries: 0 };
      // Clear verdict files for gate stages
      const vp = join(runPath, `verdict_${sid}.json`);
      if (existsSync(vp)) unlinkSync(vp);
      // Clear stale status.json
      const sp = join(runPath, 'stages', sid, 'status.json');
      if (existsSync(sp)) unlinkSync(sp);
    }
    state.status = 'running';
    state.completedAt = undefined;
    state.failureReason = undefined;
    writeRunState(projectDir, id, state);

    // Resume execution
    const workflowName = state.workflowName || 'default';
    const yamlPath = join(process.cwd(), 'config', 'workflows', `${workflowName}.yaml`);
    if (existsSync(yamlPath)) {
      try {
        const { config, raw } = loadWorkflow(yamlPath);
        const agents = new Map<string, AgentConfig>();
        try {
          const allFiles = readdirSync(join(process.cwd(), 'config', 'agents')).filter(f => f.endsWith('.yaml'));
          for (const f of allFiles) {
            const parsed = parseYaml(readFileSync(join(process.cwd(), 'config', 'agents', f), 'utf-8'));
            agents.set(f.replace('.yaml', ''), parseAgentConfig(parsed));
          }
        } catch { /* ignore */ }
        const adapter = await resolveAdapter();
        runWorkflow(config, raw, projectDir, adapter, agents, undefined, undefined, id, state.taskDescription).catch(console.error);
      } catch { /* ignore */ }
    }

    return { ok: true, reset: resetIds };
  });

  // POST /api/tasks/:id/stages/:stageId/reeval — gate re-evaluation only
  app.post<{ Params: { id: string; stageId: string } }>("/api/tasks/:id/stages/:stageId/reeval", async (req, reply) => {
    const { id, stageId } = req.params;
    let state: StoreState;
    try { state = readRunState(projectDir, id); } catch { return reply.code(404).send({ error: 'not found' }); }
    if (!state.stages[stageId]) return reply.code(404).send({ error: 'stage not found' });

    const runPath = join(projectDir, '.fc', 'runs', id);
    // Clear verdict
    const vp = join(runPath, `verdict_${stageId}.json`);
    if (existsSync(vp)) unlinkSync(vp);
    // Clear stale status.json
    const sp = join(runPath, 'stages', stageId, 'status.json');
    if (existsSync(sp)) unlinkSync(sp);

    // Reset just this stage
    state.stages[stageId] = { status: 'pending', retries: 0 };
    state.status = 'running';
    state.completedAt = undefined;
    state.failureReason = undefined;
    writeRunState(projectDir, id, state);

    // Resume execution
    const workflowName = state.workflowName || 'default';
    const yamlPath = join(process.cwd(), 'config', 'workflows', `${workflowName}.yaml`);
    if (existsSync(yamlPath)) {
      try {
        const { config, raw } = loadWorkflow(yamlPath);
        const agents = new Map<string, AgentConfig>();
        try {
          const allFiles = readdirSync(join(process.cwd(), 'config', 'agents')).filter(f => f.endsWith('.yaml'));
          for (const f of allFiles) {
            const parsed = parseYaml(readFileSync(join(process.cwd(), 'config', 'agents', f), 'utf-8'));
            agents.set(f.replace('.yaml', ''), parseAgentConfig(parsed));
          }
        } catch { /* ignore */ }
        const adapter = await resolveAdapter();
        runWorkflow(config, raw, projectDir, adapter, agents, undefined, undefined, id, state.taskDescription).catch(console.error);
      } catch { /* ignore */ }
    }

    return { ok: true };
  });

  // 6. GET /api/tasks/:id/stages/:stageId
  app.get<{ Params: { id: string; stageId: string } }>(
    "/api/tasks/:id/stages/:stageId",
    async (req, reply) => {
      try {
        const state = readRunState(projectDir, req.params.id);
        const s = state.stages[req.params.stageId];
        if (!s) return reply.code(404).send({ error: "stage not found" });
        const roles = loadStageRoles(projectDir, req.params.id);
        const input = readStageInput(projectDir, req.params.id, req.params.stageId);
        const output = readStageOutput(projectDir, req.params.id, req.params.stageId);
        // Merge detailed fields from status.json but keep run.json status as authoritative
        let detailed = s;
        try {
          const fromDisk = JSON.parse(readFileSync(join(projectDir, '.fc', 'runs', req.params.id, 'stages', req.params.stageId, 'status.json'), 'utf-8'));
          detailed = { ...s, ...fromDisk, status: s.status };
        } catch { /* use run state */ }
        return {
          id: req.params.stageId,
          role: roles[req.params.stageId]?.role ?? "",
          status: detailed.status,
          duration_ms: detailed.duration_ms,
          retries: detailed.retries,
          artifacts: detailed.artifacts ?? [],
          dependsOn: roles[req.params.stageId]?.dependsOn ?? [],
          input,
          output,
          tokens_in: detailed.tokens_in ?? 0,
          tokens_out: detailed.tokens_out ?? 0,
        };
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
    },
  );

  // 7. GET /api/tasks/:id/stages/:stageId/live — SSE
  app.get<{ Params: { id: string; stageId: string } }>(
    "/api/tasks/:id/stages/:stageId/live",
    async (req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const logPath = join(projectDir, '.fc', 'runs', req.params.id, 'stages', req.params.stageId, 'live.log');
      let byteOffset = 0;

      const send = () => {
        try {
          const stat = statSync(logPath);
          if (stat.size > byteOffset) {
            const fd = readFileSync(logPath);
            let newContent = fd.subarray(byteOffset).toString('utf-8');
            byteOffset = stat.size;
            // Issue 14: normalize line endings for xterm (\n → \r\n)
            newContent = newContent.replace(/\r?\n/g, '\r\n');
            reply.raw.write(`data: ${JSON.stringify(newContent)}\n\n`);
          }
        } catch {
          // live.log doesn't exist yet — that's fine
        }
      };

      send();
      const interval = setInterval(send, 2000);

      req.raw.on('close', () => {
        clearInterval(interval);
        reply.raw.end();
      });
    },
  );

  // ===================== Campaign endpoints =====================

  // GET /api/campaigns
  app.get("/api/campaigns", async () => {
    const campaignsDir = join(projectDir, '.fc', 'campaigns');
    try {
      const files = readdirSync(campaignsDir).filter(f => f.endsWith('.jsonl'));
      return files.map(f => {
        const id = f.replace('.jsonl', '');
        const lines = readFileSync(join(campaignsDir, f), 'utf-8').trim().split('\n').filter(Boolean);
        const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const best = entries.reduce((max: number | null, e: { score?: number }) => (e.score != null && (max === null || e.score > max)) ? e.score : max, null);
        return { id, name: id, runCount: entries.length, bestScore: best, latestRun: entries[entries.length - 1]?.runId };
      });
    } catch { return []; }
  });

  // GET /api/campaigns/:id
  app.get<{ Params: { id: string } }>("/api/campaigns/:id", async (req, reply) => {
    if (!isSafeId(req.params.id)) return reply.code(404).send({ error: 'not found' });
    const filePath = join(projectDir, '.fc', 'campaigns', `${req.params.id}.jsonl`);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'not found' });
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  });

  // ===================== Agent endpoints =====================

  // 8. GET /api/agents
  app.get("/api/agents", async () => {
    try {
      const files = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));
      return files.map((f) => {
        try {
          const raw = readFileSync(join(agentsDir, f), 'utf-8');
          const parsed = parseYaml(raw) as Record<string, unknown>;
          return {
            name: parsed.name ?? f.replace('.yaml', ''),
            description: parsed.description ?? '',
            model: parsed.model ?? '',
            tools: parsed.tools ?? [],
          };
        } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  });

  // 9. GET /api/agents/:name
  app.get<{ Params: { name: string } }>("/api/agents/:name", async (req, reply) => {
    if (req.params.name.includes('..') || req.params.name.includes('/')) return reply.code(400).send({ error: 'invalid name' });
    const filePath = join(agentsDir, `${req.params.name}.yaml`);
    try {
      reply.type('text/yaml').send(readFileSync(filePath, 'utf-8'));
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  // ===================== Mock endpoints =====================

  // 11. Discuss setup (cached)
  let cachedAdapter: Adapter | null = null;
  let cachedAgentConfig: AgentConfig | null = null;
  let cachedSkillContent: string | null = null;

  async function ensureDiscussSetup(): Promise<{ adapter: Adapter; agentConfig: AgentConfig; skillContent: string }> {
    if (!cachedAdapter) {
      const defaultsPath = join(process.cwd(), 'config', 'defaults.yaml');
      const defaults = existsSync(defaultsPath) ? parseYaml(readFileSync(defaultsPath, 'utf-8')) as Record<string, unknown> : {};
      const adapterName = (defaults.adapter as string) || 'codex';
      const adapterMap: Record<string, string> = { codex: './adapters/codex.js', claude: './adapters/claude.js' };
      const mod = await import(adapterMap[adapterName] || adapterMap.codex);
      cachedAdapter = mod.createAdapter();
    }
    if (!cachedAgentConfig) {
      const agentPath = join(process.cwd(), 'config', 'agents', 'discussion.yaml');
      let parsed: any;
      try { parsed = parseYaml(readFileSync(agentPath, 'utf-8')); } catch { parsed = null; }
      if (!parsed) {
        const fallback = join(process.cwd(), 'config', 'agents', 'planner.yaml');
        parsed = parseYaml(readFileSync(fallback, 'utf-8'));
      }
      cachedAgentConfig = parseAgentConfig(parsed);
    }
    if (!cachedSkillContent) {
      cachedSkillContent = readFileSync(join(process.cwd(), 'config', 'skills', 'deep-interview.md'), 'utf-8');
    }
    return { adapter: cachedAdapter!, agentConfig: cachedAgentConfig!, skillContent: cachedSkillContent! };
  }

  // --- Binary framing helpers ---
  function sendData(socket: { send: (data: Buffer | Uint8Array) => void }, data: string) {
    const buf = Buffer.from(data, "utf-8");
    socket.send(Buffer.concat([Buffer.from([0x00]), buf]));
  }
  function sendControl(socket: { send: (data: Buffer | Uint8Array) => void }, obj: unknown) {
    socket.send(Buffer.concat([Buffer.from([0x01]), Buffer.from(JSON.stringify(obj))]));
  }
  function parseFrame(raw: Buffer): { tag: number; payload: Buffer } {
    if (raw.length === 0) return { tag: -1, payload: Buffer.alloc(0) };
    return { tag: raw[0], payload: raw.slice(1) };
  }

  // 11a. WS /api/discuss/ws — interactive terminal session with reconnect + binary framing
  app.get<{ Querystring: { taskId: string } }>('/api/discuss/ws', { websocket: true }, async (socket, req) => {
    try {
    const taskId = req.query.taskId;
    const runDir = join(projectDir, '.fc', 'runs', taskId);
    const sessionDir = join(runDir, 'discuss');
    mkdirSync(sessionDir, { recursive: true });

    let ptyEntry = ptySessions.get(taskId);

    // Reconnect to existing live session
    if (ptyEntry && ptyEntry.alive) {
      // Replay buffered output as binary frames
      for (const chunk of ptyEntry.outputBuffer) {
        try { sendData(socket, chunk); } catch { /* closed */ }
      }
      // Re-attach live streaming
      ptyEntry.session.onData((data: string) => {
        ptyEntry!.outputBuffer.push(data);
        try { sendData(socket, data); } catch { /* closed */ }
      });

      socket.on('message', (raw: Buffer | string) => {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string, 'binary');
        const { tag, payload } = parseFrame(buf);
        if (tag === 0x01) {
          try {
            const parsed = JSON.parse(payload.toString());
            if (parsed.type === 'generate_plan') {
              startPlanPolling(ptyEntry!, taskId, runDir, socket);
              return;
            }
            if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
              ptyEntry!.session.resize(Math.min(parsed.cols, 200), Math.min(parsed.rows, 60));
              return;
            }
          } catch { /* malformed */ }
        } else if (tag === 0x00) {
          if (ptyEntry!.alive) ptyEntry!.session.write(payload.toString('utf-8'));
        }
      });

      socket.on('close', () => { /* keep session alive */ });
      return;
    }

    // New session — deferred PTY spawn (wait for first resize)
    const oldBuffer = ptyEntry ? ptyEntry.outputBuffer : [];

    let spawned = false;

    async function spawnPty(cols: number, rows: number) {
      if (spawned) return;
      spawned = true;
      const { adapter, agentConfig } = await ensureDiscussSetup();
      let discussAgent = agentConfig;
      const discussAgentPath = join(process.cwd(), 'config', 'agents', 'discussion.yaml');
      if (existsSync(discussAgentPath)) {
        try {
          const parsed = parseYaml(readFileSync(discussAgentPath, 'utf-8'));
          discussAgent = parseAgentConfig(parsed);
        } catch { /* fall back to planner */ }
      }
      // Inject campaign context if applicable
      try {
        const runState = readRunState(projectDir, taskId);
        if (runState.campaignId) {
          const campCtx = buildCampaignContext(projectDir, runState.campaignId, taskId);
          if (campCtx) discussAgent = { ...discussAgent, prompt: discussAgent.prompt + '\n\n' + campCtx };
        }
      } catch { /* no run state yet */ }
      const session = await adapter.spawnInteractive(discussAgent, { workDir: projectDir, sessionDir, cols, rows });
      ptyEntry = { session, outputBuffer: [...oldBuffer], alive: true, planPolling: false };
      ptySessions.set(taskId, ptyEntry);

      for (const chunk of oldBuffer) {
        try { sendData(socket, chunk); } catch { /* closed */ }
      }

      session.onData((data: string) => {
        ptyEntry!.outputBuffer.push(data);
        try { sendData(socket, data); } catch { /* closed */ }
      });
      session.onExit((exitCode) => {
        ptyEntry!.alive = false;
        try { sendControl(socket, { type: 'done', exitCode }); } catch { /* closed */ }
      });
    }

    socket.on('message', async (raw: Buffer | string) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string, 'binary');
      const { tag, payload } = parseFrame(buf);
      if (tag === 0x01) {
        let parsed: any;
        try { parsed = JSON.parse(payload.toString()); } catch { return; }
        try {
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            if (!spawned) {
              await spawnPty(Math.min(parsed.cols, 200), Math.min(parsed.rows, 60));
            } else if (ptyEntry?.alive) {
              ptyEntry.session.resize(Math.min(parsed.cols, 200), Math.min(parsed.rows, 60));
            }
            return;
          }
          if (parsed.type === 'generate_plan') {
            if (ptyEntry) startPlanPolling(ptyEntry, taskId, runDir, socket);
            return;
          }
        } catch (err) {
          try { sendControl(socket, { type: 'error', message: String(err) }); } catch { /* ignore */ }
          socket.close();
        }
      } else if (tag === 0x00) {
        if (ptyEntry?.alive) ptyEntry.session.write(payload.toString('utf-8'));
      }
    });

    socket.on('close', () => { /* keep session alive */ });
    } catch (err) {
      try { sendControl(socket, { type: 'error', message: String(err) }); } catch { /* ignore */ }
      socket.close();
    }
  });

  function startPlanPolling(ptyEntry: PtySession, taskId: string, runDir: string, socket: { send: (data: Buffer | Uint8Array) => void }) {
    if (ptyEntry.planPolling) return;
    ptyEntry.planPolling = true;
    mkdirSync(runDir, { recursive: true });
    const cmd = `Summarize our discussion as a task brief. Write it to ${runDir}/task_brief.md. Include: task summary, requirements, scope, constraints, and acceptance criteria.`;
    ptyEntry.session.write(cmd);
    setTimeout(() => ptyEntry.session.write("\r"), 100);
    const briefPath = join(runDir, 'task_brief.md');
    let stableCount = 0;
    let lastSize = -1;
    const pollInterval = setInterval(() => {
      try {
        if (existsSync(briefPath)) {
          const stat = statSync(briefPath);
          if (stat.size > 0 && stat.size === lastSize) {
            stableCount++;
            if (stableCount >= 2) {
              clearInterval(pollInterval);
              try { sendControl(socket, { type: 'plan_ready' }); } catch { /* closed */ }
            }
          } else { stableCount = 0; lastSize = stat.size; }
        }
      } catch { /* file doesn't exist yet */ }
    }, 1000);
    setTimeout(() => clearInterval(pollInterval), 120000);
  }

  // 12. POST /api/plan
  app.post<{ Body: { taskId: string; workflow?: string } }>("/api/plan", async (req, reply) => {
    const workflow = req.body?.workflow || 'default';
    const yamlPath = join(process.cwd(), 'config', 'workflows', `${workflow}.yaml`);
    try {
      const raw = readFileSync(yamlPath, 'utf-8');
      const parsed = parseYaml(raw);
      const config = WorkflowConfigSchema.parse(parsed);
      return config.stages.map((s) => ({
        id: s.id,
        role: s.role,
        prompt_template: s.prompt_template,
        depends_on: s.depends_on,
        timeout_ms: s.timeout_ms ?? config.defaults.timeout_ms,
        max_retries: s.max_retries ?? config.defaults.max_retries,
      }));
    } catch (err) {
      return reply.code(404).send({ error: `workflow not found: ${workflow}` });
    }
  });

  // 13. GET /api/settings
  app.get("/api/settings", async () => {
    const defaultsPath = join(process.cwd(), 'config', 'defaults.yaml');
    const defaults = existsSync(defaultsPath) ? parseYaml(readFileSync(defaultsPath, 'utf-8')) as Record<string, unknown> : {};
    const workflowsDir = join(process.cwd(), 'config', 'workflows');
    const skillsDir = join(process.cwd(), 'config', 'skills');
    const workflows = existsSync(workflowsDir) ? readdirSync(workflowsDir).filter((f) => f.endsWith('.yaml')) : [];
    const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter((f) => f.endsWith('.md')) : [];
    return { projectDir, adapter: defaults.adapter ?? 'codex', workflows, skills, port, ...defaults };
  });

  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Dashboard running at http://localhost:${port}/`);
  return app;
}
