import { readFileSync, mkdirSync, readdirSync, writeFileSync, existsSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { Adapter, AgentConfig } from './adapters/base.js';
import { evaluateCondition } from './condition.js';
import { createRun, readRunState, writeRunState, writeStageStatus, readStageStatus, readStageOutput } from './store.js';
import type { StoreState, StageStatus } from './store.js';
import { runStage } from './worker.js';
import pino from 'pino';

const log = pino({ name: 'scheduler' });

/** Load project defaults from config/defaults.yaml */
function loadDefaults(): { timeout_ms: number; model: string; reasoning_effort: string } {
  try {
    const raw = readFileSync(join(process.cwd(), 'config', 'defaults.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    return {
      timeout_ms: typeof parsed.default_timeout_ms === 'number' ? parsed.default_timeout_ms : 300000,
      model: typeof parsed.model === 'string' ? parsed.model : 'default',
      reasoning_effort: typeof parsed.reasoning_effort === 'string' ? parsed.reasoning_effort : 'default',
    };
  } catch { /* fallback */ }
  return { timeout_ms: 300000, model: 'default', reasoning_effort: 'default' };
}

const projectDefaults = loadDefaults();
const defaultTimeoutMs = projectDefaults.timeout_ms;

const AgentConfigSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  model: z.string().default('default'),
  reasoning_effort: z.string().default('default'),
  tools: z.array(z.string()).default([]),
  prompt: z.string(),
});

function parseAgent(raw: unknown): AgentConfig {
  const agent = AgentConfigSchema.parse(raw);
  if (agent.model === 'default') agent.model = projectDefaults.model;
  if (agent.reasoning_effort === 'default') agent.reasoning_effort = projectDefaults.reasoning_effort;
  return agent;
}

export const StageConfigSchema = z.object({
  id: z.string(),
  role: z.string(),
  depends_on: z.array(z.string()).optional().default([]),
  condition: z.string().optional(),
  prompt_template: z.string().optional().default(''),
  timeout_ms: z.number().optional(),
  max_retries: z.number().optional(),
  skills: z.array(z.string()).optional().default([]),
  dynamic_dispatch: z.boolean().optional().default(false),
  is_gate: z.boolean().optional().default(false),
  retry_to: z.array(z.string()).optional(),
});

export const WorkflowConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional().default(''),
  defaults: z.object({
    timeout_ms: z.number().default(defaultTimeoutMs),
    max_retries: z.number().default(1),
    max_iterations: z.number().default(3),
  }).default({ timeout_ms: defaultTimeoutMs, max_retries: 1, max_iterations: 3 }),
  stages: z.array(StageConfigSchema).min(1),
});

export type StageConfig = z.infer<typeof StageConfigSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

function topoSort(stages: StageConfig[]): StageConfig[] {
  const ids = new Set(stages.map((s) => s.id));
  if (ids.size !== stages.length) throw new Error('Duplicate stage IDs detected');
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of stages) {
    inDeg.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const s of stages) {
    for (const d of s.depends_on ?? []) {
      if (!ids.has(d)) throw new Error(`Unknown dependency "${d}" in stage "${s.id}"`);
      adj.get(d)!.push(s.id);
      inDeg.set(s.id, (inDeg.get(s.id) ?? 0) + 1);
    }
  }
  const queue = [...inDeg.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  const sorted: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    sorted.push(n);
    for (const nb of adj.get(n) ?? []) {
      const d = inDeg.get(nb)! - 1;
      inDeg.set(nb, d);
      if (d === 0) queue.push(nb);
    }
  }
  if (sorted.length !== stages.length) throw new Error('Cycle detected in workflow stages');
  const order = new Map(sorted.map((id, i) => [id, i]));
  return [...stages].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export function findAllReady(stages: StageConfig[], state: StoreState): StageConfig[] {
  const ready: StageConfig[] = [];
  for (const s of stages) {
    const ss = state.stages[s.id];
    if (!ss || ss.status !== 'pending') continue;
    const depsReady = (s.depends_on ?? []).every((d) => {
      const ds = state.stages[d];
      return ds && (ds.status === 'complete' || ds.status === 'skipped');
    });
    if (depsReady) ready.push(s);
  }
  return ready;
}

function allDone(state: StoreState): boolean {
  return Object.values(state.stages).every(
    (s) => s.status === 'complete' || s.status === 'skipped',
  );
}

function anyFailed(state: StoreState): boolean {
  return Object.values(state.stages).some((s) => s.status === 'failed');
}

export function loadWorkflow(yamlPath: string): { config: WorkflowConfig; raw: string } {
  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = parseYaml(raw);
  const config = WorkflowConfigSchema.parse(parsed);
  return { config, raw };
}

/** Load _base.md from agents dir and prepend to agent prompt */
export function loadBasePrompt(agentsDir: string): string {
  try {
    return readFileSync(join(agentsDir, '_base.md'), 'utf-8');
  } catch { return ''; }
}

export function applyBasePrompt(agent: AgentConfig, basePrompt: string): AgentConfig {
  if (!basePrompt) return agent;
  return { ...agent, prompt: basePrompt + '\n\n' + agent.prompt };
}

export function buildRoleRegistry(agentsDir: string): Map<string, { name: string; description: string }> {
  const registry = new Map<string, { name: string; description: string }>();
  try {
    const files = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));
    for (const f of files) {
      try {
        const parsed = parseYaml(readFileSync(join(agentsDir, f), 'utf-8'));
        if (parsed?.name) registry.set(parsed.name, { name: parsed.name, description: parsed.description ?? '' });
      } catch { /* skip malformed file */ }
    }
  } catch { /* agents dir may not exist */ }
  return registry;
}

export function parseDispatchBlock(
  output: string,
  roleRegistry: Map<string, { name: string; description: string }>,
): StageConfig[] {
  // Strip diff-format line prefixes (e.g. "  123, 150: " or "+      148: " or "- 143     : ")
  const cleaned = output.replace(/^[-+ ] *\d*[, ]*\d* *: /gm, '');
  const match = cleaned.match(/## DISPATCH\s*\n```(?:yaml)?\s*\n([\s\S]*?)```/);
  if (!match) return [];
  const items = parseYaml(match[1]);
  if (!Array.isArray(items)) return [];
  const stages: StageConfig[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;
    if (!item.id) item.id = `dispatch_${i}`;
    if (seenIds.has(item.id)) {
      log.warn({ id: item.id }, 'Duplicate stage ID in DISPATCH block, skipping');
      continue;
    }
    if (!roleRegistry.has(item.role)) {
      log.warn({ role: item.role, id: item.id }, 'Unknown role in DISPATCH block, skipping');
      continue;
    }
    try {
      // Bug 2: map task: to prompt_template: if planner used that format
      if (item.task && !item.prompt_template) {
        item.prompt_template = item.task;
        delete item.task;
      }
      stages.push(StageConfigSchema.parse(item));
      seenIds.add(item.id);
    } catch {
      log.warn({ id: item.id }, 'Invalid stage in DISPATCH block, skipping');
    }
  }
  return stages;
}

export function resolveDispatchDependencies(dispatched: StageConfig[], dispatchStageId: string): void {
  const plannedDependents = new Set(
    dispatched.filter((s) => s.depends_on.includes('__planned__')).map((s) => s.id),
  );
  const nonPlannedIds = dispatched.filter((s) => !plannedDependents.has(s.id)).map((s) => s.id);

  for (const s of dispatched) {
    if (s.depends_on.length === 0) {
      s.depends_on = [dispatchStageId];
    }
    if (s.depends_on.includes('__planned__')) {
      s.depends_on = [...new Set(s.depends_on.filter((d) => d !== '__planned__').concat(nonPlannedIds))];
      if (s.depends_on.length === 0) s.depends_on = [dispatchStageId];
    }
  }
}

/** Collect all stage IDs that transitively depend on the given stage */
export function collectTransitiveDependents(stageId: string, stages: StageConfig[]): Set<string> {
  const dependents = new Set<string>();
  const queue = [stageId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const s of stages) {
      if (!dependents.has(s.id) && s.id !== stageId && s.depends_on.includes(current)) {
        dependents.add(s.id);
        queue.push(s.id);
      }
    }
  }
  return dependents;
}

/** BFS: find all stages that transitively depend on stageId (returns array of IDs) */
export function findDownstream(stageId: string, stages: StageConfig[]): string[] {
  return [...collectTransitiveDependents(stageId, stages)];
}

function injectDispatchedStages(
  dispatchStageId: string,
  roleRegistry: Map<string, { name: string; description: string }>,
  sorted: StageConfig[],
  state: StoreState,
  projectDir: string,
  runId: string,
): StageConfig[] {
  // Read dispatch.yaml from run dir
  const runDir = join(projectDir, '.fc', 'runs', runId);
  const dispatchPath = join(runDir, 'dispatch.yaml');
  if (!existsSync(dispatchPath)) return [];

  let items: unknown;
  try {
    items = parseYaml(readFileSync(dispatchPath, 'utf-8'));
  } catch {
    log.warn('Failed to parse dispatch.yaml');
    return [];
  }
  if (!Array.isArray(items)) return [];

  const dispatched: StageConfig[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;
    if (!item.id) item.id = `dispatch_${i}`;
    if (seenIds.has(item.id)) {
      log.warn({ id: item.id }, 'Duplicate stage ID in dispatch.yaml, skipping');
      continue;
    }
    if (!roleRegistry.has(item.role)) {
      log.warn({ role: item.role, id: item.id }, 'Unknown role in dispatch.yaml, skipping');
      continue;
    }
    // Map task: to prompt_template:
    if (item.task && !item.prompt_template) {
      item.prompt_template = item.task;
      delete item.task;
    }
    try {
      dispatched.push(StageConfigSchema.parse(item));
      seenIds.add(item.id);
    } catch {
      log.warn({ id: item.id }, 'Invalid stage in dispatch.yaml, skipping');
    }
  }
  if (dispatched.length === 0) return [];

  resolveDispatchDependencies(dispatched, dispatchStageId);

  // Create stage directories and add to state
  for (const s of dispatched) {
    mkdirSync(join(projectDir, '.fc', 'runs', runId, 'stages', s.id), { recursive: true });
    state.stages[s.id] = { status: 'pending', retries: 0 };
  }

  // Mark static stages that transitively depend on dispatch stage as skipped
  const transitive = collectTransitiveDependents(dispatchStageId, sorted);
  for (const id of transitive) {
    if (state.stages[id]?.status === 'pending') {
      state.stages[id] = { status: 'skipped', retries: 0 };
      log.info({ stage: id }, 'Skipped (replaced by dispatched stages)');
    }
  }

  // Add dispatched stages to sorted list
  sorted.push(...dispatched);

  // Update stored workflow.yaml
  const wfPath = join(projectDir, '.fc', 'runs', runId, 'workflow.yaml');
  try {
    const wfRaw = readFileSync(wfPath, 'utf-8');
    const wfParsed = parseYaml(wfRaw) ?? {};
    if (!Array.isArray(wfParsed.stages)) wfParsed.stages = [];
    for (const s of dispatched) wfParsed.stages.push({ id: s.id, role: s.role, depends_on: s.depends_on, prompt_template: s.prompt_template, is_gate: s.is_gate || undefined, retry_to: s.retry_to?.length ? s.retry_to : undefined });
    writeFileSync(wfPath, stringifyYaml(wfParsed), 'utf-8');
  } catch { /* best effort */ }

  state.dispatchedStages = dispatched;
  state.status = 'awaiting_approval';
  writeRunState(projectDir, runId, state);

  return dispatched;
}

export function appendIterationLog(
  projectDir: string,
  runId: string,
  iteration: number,
  state: StoreState,
  dispatchedStageIds: string[],
): void {
  const runDir = join(projectDir, '.fc', 'runs', runId);
  const logPath = join(runDir, 'iteration_log.md');
  mkdirSync(runDir, { recursive: true });
  const lines: string[] = [`# Iteration ${iteration}`];
  for (const sid of dispatchedStageIds) {
    const ss = state.stages[sid];
    if (!ss) continue;
    lines.push(`## ${sid} (${ss.status})`);
    lines.push(`Output: .fc/runs/${runId}/stages/${sid}/output.md`);
    lines.push(`Artifacts: ${ss.artifacts?.join(', ') || 'none'}`);
    // For gate stages (last in chain), extract verdict from first line of output
    const output = readStageOutput(projectDir, runId, sid);
    if (output) {
      const firstLine = output.split('\n').find(l => l.trim()) || '';
      lines.push(`Verdict: ${firstLine.slice(0, 200)}`);
    }
  }
  lines.push('');
  const content = lines.join('\n');
  if (existsSync(logPath)) {
    const existing = readFileSync(logPath, 'utf-8');
    writeFileSync(logPath, existing + '\n' + content, 'utf-8');
  } else {
    writeFileSync(logPath, content, 'utf-8');
  }
}

/** Write campaign entry after run completes */
function writeCampaignEntry(projectDir: string, state: StoreState): void {
  if (!state.campaignId) return;
  const campaignsDir = join(projectDir, '.fc', 'campaigns');
  mkdirSync(campaignsDir, { recursive: true });
  const filePath = join(campaignsDir, `${state.campaignId}.jsonl`);
  const runPath = join(projectDir, '.fc', 'runs', state.runId);
  // Find scored verdict from gate stages (extended verdict format)
  const metric = findCampaignMetric(projectDir, state);
  // Only append to campaign JSONL if there's a scored verdict
  if (!metric) return;
  let gatesPassed = 0;
  let gatesTotal = 0;
  try {
    const files = readdirSync(runPath).filter(f => f.startsWith('verdict_') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const v = JSON.parse(readFileSync(join(runPath, f), 'utf-8'));
        if (typeof v.pass === 'boolean') { gatesTotal++; if (v.pass) gatesPassed++; }
      } catch { /* skip */ }
    }
  } catch { /* no verdicts */ }
  const entry = {
    seq: state.campaignSeq ?? 1,
    runId: state.runId,
    iteration: state.currentIteration ?? 1,
    score: metric.score,
    metric: metric.metric,
    gate: metric.gate,
    pass: metric.pass,
    gates: `${gatesPassed}/${gatesTotal}`,
    status: state.status,
    timestamp: new Date().toISOString(),
  };
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}

/** Find the last scored gate in pipeline order for campaign tracking */
export function findCampaignMetric(projectDir: string, state: StoreState): { score: number; metric: string; gate: string; pass: boolean; threshold?: number } | null {
  const runPath = join(projectDir, '.fc', 'runs', state.runId);

  // Determine pipeline order from dispatched stages if available
  let orderedGateIds: string[] | null = null;
  if (state.dispatchedStages && Array.isArray(state.dispatchedStages)) {
    orderedGateIds = (state.dispatchedStages as { id: string; is_gate?: boolean }[])
      .filter(s => s.is_gate)
      .map(s => s.id);
  }

  let best: { score: number; metric: string; gate: string; pass: boolean; threshold?: number } | null = null;
  try {
    const files = readdirSync(runPath).filter(f => f.startsWith('verdict_') && f.endsWith('.json'));

    // If we have pipeline order, iterate in that order; otherwise fall back to directory listing
    const gateIds = orderedGateIds ?? files.map(f => f.replace('verdict_', '').replace('.json', ''));

    for (const gateId of gateIds) {
      const f = `verdict_${gateId}.json`;
      const fPath = join(runPath, f);
      try {
        const v = JSON.parse(readFileSync(fPath, 'utf-8'));
        if (typeof v.score === 'number') {
          best = { score: v.score, metric: v.metric ?? '', gate: gateId, pass: v.pass === true, threshold: v.threshold };
        }
      } catch { /* skip */ }
    }
  } catch { /* no verdicts */ }
  return best;
}

export interface CampaignAlert {
  type: 'regression' | 'plateau' | 'repeated_failure';
  action: 'inject_researcher';
  message: string;
}

export interface CampaignEntry {
  seq: number;
  runId: string;
  iteration?: number;
  score: number;
  metric: string;
  gate: string;
  pass: boolean;
  timestamp: string;
}

/** Check campaign health from JSONL entries */
export function checkCampaignHealth(entries: CampaignEntry[], triggers?: { regressionAfter?: number; plateauAfter?: number; plateauThreshold?: number; repeatedFailureAfter?: number }): CampaignAlert | null {
  if (entries.length < 2) return null;
  const regAfter = triggers?.regressionAfter ?? 2;
  const platAfter = triggers?.plateauAfter ?? 3;
  const platThresh = triggers?.plateauThreshold ?? 5;
  const repAfter = triggers?.repeatedFailureAfter ?? 3;

  // Consecutive declines
  let declines = 0;
  for (let i = entries.length - 1; i > 0; i--) {
    if (entries[i].score < entries[i - 1].score) declines++;
    else break;
  }
  if (declines >= regAfter) return { type: 'regression', action: 'inject_researcher', message: `${declines} consecutive score declines` };

  // Plateau (±threshold% for N+ entries)
  if (entries.length >= platAfter) {
    const recent = entries.slice(-platAfter);
    const avg = recent.reduce((s, e) => s + e.score, 0) / recent.length;
    if (!isFinite(avg)) {
      // All non-finite (Infinity/-Infinity/NaN): treat identical non-finite values as plateau
      if (recent.every(e => e.score === recent[0].score)) return { type: 'plateau', action: 'inject_researcher', message: `${platAfter} entries within ±${platThresh}%` };
    } else if (avg === 0) {
      if (recent.every(e => Math.abs(e.score) <= platThresh / 100)) return { type: 'plateau', action: 'inject_researcher', message: `${platAfter} entries within ±${platThresh}%` };
    } else {
      const allWithin = recent.every(e => Math.abs(e.score - avg) / Math.abs(avg) * 100 <= platThresh);
      if (allWithin) return { type: 'plateau', action: 'inject_researcher', message: `${platAfter} entries within ±${platThresh}%` };
    }
  }

  // Repeated same-gate failure
  if (entries.length >= repAfter) {
    const recent = entries.slice(-repAfter);
    if (recent.every(e => !e.pass) && recent.every(e => e.gate === recent[0].gate)) {
      return { type: 'repeated_failure', action: 'inject_researcher', message: `${repAfter} consecutive failures on gate ${recent[0].gate}` };
    }
  }

  return null;
}

/** Read verdict for a specific gate stage from run dir verdict_<stageId>.json, falling back to verdict.json */
export function readGateVerdict(projectDir: string, stageId: string, runId?: string): { pass: boolean; reason?: string } | null {
  const base = runId ? join(projectDir, '.fc', 'runs', runId) : join(projectDir, 'docs');
  // Try per-gate verdict first
  const perGate = join(base, `verdict_${stageId}.json`);
  try {
    const v = JSON.parse(readFileSync(perGate, 'utf-8'));
    if (typeof v.pass === 'boolean') return v;
  } catch { /* not found */ }
  // Fall back to shared verdict.json
  const shared = join(base, 'verdict.json');
  try {
    const v = JSON.parse(readFileSync(shared, 'utf-8'));
    if (typeof v.pass === 'boolean') return v;
  } catch { /* not found */ }
  return null;
}

/** Check all is_gate stages. Returns { allPass, failedGateIds } */
export function checkGates(allStages: StageConfig[], state: StoreState, projectDir: string, runId?: string): { allPass: boolean; failedGateIds: string[] } {
  const gateStages = allStages.filter(s => s.is_gate && state.stages[s.id]?.status === 'complete');
  if (gateStages.length === 0) return { allPass: true, failedGateIds: [] };
  const failedGateIds: string[] = [];
  for (const g of gateStages) {
    const verdict = readGateVerdict(projectDir, g.id, runId);
    if (!verdict || verdict.pass !== false) continue; // pass or malformed → treat as pass
    failedGateIds.push(g.id);
  }
  return { allPass: failedGateIds.length === 0, failedGateIds };
}

/** Find the retry_to stage that references any of the failed gate IDs */
export function findRetryToStage(allStages: StageConfig[], failedGateIds: string[]): StageConfig | null {
  const failedSet = new Set(failedGateIds);
  for (const s of allStages) {
    if (s.retry_to && s.retry_to.some(id => failedSet.has(id))) return s;
  }
  return null;
}

/** Find ALL retry_to stages that reference any of the failed gate IDs */
export function findAllRetryToStages(allStages: StageConfig[], failedGateIds: string[]): StageConfig[] {
  const failedSet = new Set(failedGateIds);
  return allStages.filter(s => s.retry_to && s.retry_to.some(id => failedSet.has(id)));
}

export function lastGatePassed(state: StoreState, dispatchedStageIds: string[], allStages: StageConfig[], projectDir?: string, runId?: string): boolean {
  // If there are is_gate stages, use verdict-based checking
  const gateStages = allStages.filter(s => s.is_gate && dispatchedStageIds.includes(s.id));
  if (gateStages.length > 0 && projectDir) {
    const { allPass } = checkGates(allStages, state, projectDir, runId);
    return allPass;
  }

  // No is_gate stages: check verdict.json (legacy) then exit codes
  if (projectDir) {
    const base = runId ? join(projectDir, '.fc', 'runs', runId) : join(projectDir, 'docs');
    const verdictPath = join(base, 'verdict.json');
    try {
      const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
      return verdict.pass === true;
    } catch { /* no verdict.json — fall through to exit code check */ }
  }

  // Find terminal stages
  const hasDependent = new Set<string>();
  for (const s of allStages) {
    if (dispatchedStageIds.includes(s.id)) {
      for (const dep of s.depends_on ?? []) {
        if (dispatchedStageIds.includes(dep)) hasDependent.add(dep);
      }
    }
  }
  const terminalIds = dispatchedStageIds.filter(id => !hasDependent.has(id));
  if (terminalIds.length === 0) return true;

  return terminalIds.every(id => {
    const ss = state.stages[id];
    if (!ss) return false;
    if (ss.status === 'skipped') return true;
    return ss.status === 'complete' && (ss.exitCode === undefined || ss.exitCode === 0);
  });
}

export async function runWorkflow(
  workflow: WorkflowConfig,
  workflowYaml: string,
  projectDir: string,
  adapter: Adapter,
  agents: Map<string, AgentConfig>,
  skills?: string,
  agentsDir?: string,
  existingRunId?: string,
  taskDescription?: string,
): Promise<StoreState> {
  const baseStages = topoSort(workflow.stages);
  const stageIds = baseStages.map((s) => s.id);
  const maxIterations = workflow.defaults.max_iterations ?? 3;

  let runId: string;
  let runDirPath: string;
  if (existingRunId) {
    runId = existingRunId;
    runDirPath = join(projectDir, '.fc', 'runs', runId);
    mkdirSync(join(runDirPath, 'stages'), { recursive: true });
    for (const s of baseStages) {
      mkdirSync(join(runDirPath, 'stages', s.id), { recursive: true });
    }
    const state = readRunState(projectDir, runId);
    for (const s of baseStages) {
      if (!state.stages[s.id]) state.stages[s.id] = { status: 'pending', retries: 0 };
    }
    state.status = 'running';
    state.workflowName = workflow.name;
    state.maxIterations = maxIterations;
    state.currentIteration = 1;
    writeFileSync(join(runDirPath, 'workflow.yaml'), workflowYaml, 'utf-8');
    writeRunState(projectDir, runId, state);
  } else {
    const created = createRun(projectDir, workflow.name, workflowYaml, stageIds);
    runId = created.runId;
    runDirPath = created.runDirPath;
    const state = readRunState(projectDir, runId);
    state.maxIterations = maxIterations;
    state.currentIteration = 1;
    writeRunState(projectDir, runId, state);
  }

  log.info({ runId, workflow: workflow.name }, 'Run started');

  if (taskDescription) {
    const initState = readRunState(projectDir, runId);
    initState.taskDescription = taskDescription;
    writeRunState(projectDir, runId, initState);
  }

  const resolvedAgentsDir = agentsDir ?? join(process.cwd(), 'config', 'agents');
  const basePrompt = loadBasePrompt(resolvedAgentsDir);
  // Apply base prompt to all pre-loaded agents
  for (const [k, v] of agents) agents.set(k, applyBasePrompt(v, basePrompt));
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);

  // Iteration loop
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let state = readRunState(projectDir, runId);
    state.currentIteration = iteration;
    writeRunState(projectDir, runId, state);

    // Build sorted stages for this iteration: start from base stages
    const sorted: StageConfig[] = baseStages.map(s => ({ ...s }));
    const injectedDispatchStages = new Set<string>();

    // Delete dispatch.yaml before plan stage runs only on re-plan (iteration > 1)
    const dispatchPathPre = join(runDirPath, 'dispatch.yaml');
    if (iteration > 1 && existsSync(dispatchPathPre)) unlinkSync(dispatchPathPre);

    // Reset all base stages to pending for this iteration
    state = readRunState(projectDir, runId);
    // On iteration 2+, reset base stage statuses and clear old dispatched stages
    if (iteration > 1) {
      // Remove old dispatched stage entries from state
      const baseIds = new Set(baseStages.map(s => s.id));
      for (const sid of Object.keys(state.stages)) {
        if (!baseIds.has(sid)) delete state.stages[sid];
      }
      for (const s of baseStages) {
        state.stages[s.id] = { status: 'pending', retries: 0 };
        mkdirSync(join(runDirPath, 'stages', s.id), { recursive: true });
      }
      state.dispatchedStages = undefined;
      state.status = 'running';
      writeRunState(projectDir, runId, state);

      // Re-write workflow.yaml to base stages only
      writeFileSync(join(runDirPath, 'workflow.yaml'), workflowYaml, 'utf-8');
    }

    // Track dispatched stage IDs for this iteration
    let iterationDispatchedIds: string[] = [];

    // Campaign health check: inject researcher if regression/plateau detected
    if (state.campaignId && iteration > 1) {
      const campaignPath = join(projectDir, '.fc', 'campaigns', `${state.campaignId}.jsonl`);
      if (existsSync(campaignPath)) {
        try {
          const lines = readFileSync(campaignPath, 'utf-8').trim().split('\n').filter(Boolean);
          const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const triggers = (state as any).campaignTriggers;
          const alert = checkCampaignHealth(entries, triggers?.enabled === false ? undefined : triggers);
          if (alert) {
            log.info({ runId, alert: alert.type }, 'Campaign health alert — researcher will be injected via planner context');
          }
        } catch { /* ignore */ }
      }
    }

    // Inner execution loop for this iteration
    const iterationResult = await executeIteration(
      sorted, state, projectDir, runId, runDirPath, workflow, adapter, agents,
      resolvedAgentsDir, roleRegistry, injectedDispatchStages, skills, taskDescription,
    );

    state = readRunState(projectDir, runId);

    // Collect dispatched stage IDs
    iterationDispatchedIds = Object.keys(state.stages).filter(
      id => !baseStages.some(s => s.id === id),
    );

    // === INNER LOOP (retry_to) ===
    const maxInnerRetries = 3;
    let innerLoopCount = 0;
    if (iterationDispatchedIds.length > 0) {
      const { allPass, failedGateIds } = checkGates(sorted, state, projectDir, runId);
      if (!allPass) {
        const retryStages = findAllRetryToStages(sorted, failedGateIds);
        if (retryStages.length > 0) {
          for (let inner = 0; inner < maxInnerRetries; inner++) {
            innerLoopCount++;

            // Determine which retry stages need to run based on current failed gates
            const currentCheck = inner === 0
              ? { allPass: failedGateIds.length === 0, failedGateIds }
              : checkGates(sorted, state, projectDir, runId);
            const currentFailedGateIds = inner === 0 ? failedGateIds : currentCheck.failedGateIds;
            if (inner > 0 && currentCheck.allPass) break;

            const activeRetryStages = findAllRetryToStages(sorted, currentFailedGateIds);
            if (activeRetryStages.length === 0) break;

            // Clear verdict files for all gates referenced by active retry stages
            for (const retryStage of activeRetryStages) {
              for (const gid of retryStage.retry_to!) {
                const perGate = join(runDirPath, `verdict_${gid}.json`);
                if (existsSync(perGate)) unlinkSync(perGate);
              }
            }
            const sharedVerdict = join(runDirPath, 'verdict.json');
            if (existsSync(sharedVerdict)) unlinkSync(sharedVerdict);

            // Reset and run all active retry stages (possibly in parallel)
            for (const retryStage of activeRetryStages) {
              state.stages[retryStage.id] = { status: 'pending', retries: 0 };
              mkdirSync(join(runDirPath, 'stages', retryStage.id), { recursive: true });
            }
            writeRunState(projectDir, runId, state);

            await Promise.all(activeRetryStages.map(retryStage =>
              executeSingleStage(retryStage, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription)
            ));
            state = readRunState(projectDir, runId);

            // Collect all gates referenced by all active retry stages
            const allRetryGateIds = new Set<string>();
            for (const retryStage of activeRetryStages) {
              for (const gid of retryStage.retry_to!) allRetryGateIds.add(gid);
            }

            // Determine which gates to re-run
            const gatesToRerun = sorted.filter(s => {
              if (!s.is_gate || !allRetryGateIds.has(s.id)) return false;
              const v = readGateVerdict(projectDir, s.id, runId);
              return !v || v.pass !== true;
            });
            for (const gate of gatesToRerun) {
              const perGate = join(runDirPath, `verdict_${gate.id}.json`);
              if (existsSync(perGate)) unlinkSync(perGate);
              state.stages[gate.id] = { status: 'pending', retries: 0 };
              mkdirSync(join(runDirPath, 'stages', gate.id), { recursive: true });
              writeRunState(projectDir, runId, state);
            }
            if (existsSync(sharedVerdict)) unlinkSync(sharedVerdict);

            // Run gate stages (possibly in parallel)
            if (gatesToRerun.length > 0) {
              await Promise.all(gatesToRerun.map(gate =>
                executeSingleStage(gate, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription)
              ));
            }
            state = readRunState(projectDir, runId);

            // Check gates again
            const recheck = checkGates(sorted, state, projectDir, runId);
            if (recheck.allPass) break;
            if (inner === maxInnerRetries - 1) {
              log.info({ runId, iteration }, 'Inner loop exhausted, falling back to outer re-plan');
            }
          }
        }
      }
    }

    state = readRunState(projectDir, runId);

    // Issue 12 fix: finalize any retry_to stages still marked "running" after inner loop
    for (const s of sorted) {
      if (s.retry_to && s.retry_to.length > 0 && state.stages[s.id]?.status === 'running') {
        state.stages[s.id] = { ...state.stages[s.id], status: 'skipped' };
        writeRunState(projectDir, runId, state);
      }
    }

    // Append iteration log
    appendIterationLog(projectDir, runId, iteration, state, iterationDispatchedIds);

    // Check if last gate passed
    if (iterationDispatchedIds.length > 0 && lastGatePassed(state, iterationDispatchedIds, sorted, projectDir, runId)) {
      state.status = 'complete';
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      writeCampaignEntry(projectDir, state);
      log.info({ runId, iteration }, 'All gates passed, run complete');
      return state;
    }

    // If no dispatched stages, check if all base stages passed
    if (iterationDispatchedIds.length === 0 && !anyFailed(state) && allDone(state)) {
      if (state.status === 'failed') {
        writeCampaignEntry(projectDir, state);
        return state;
      }
      state.status = 'complete';
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      writeCampaignEntry(projectDir, state);
      return state;
    }

    // Max iterations reached
    if (iteration === maxIterations) {
      state.status = 'failed';
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      writeCampaignEntry(projectDir, state);
      log.info({ runId, iteration }, 'Max iterations reached, run failed');
      return state;
    }

    // Clear dispatch.yaml and verdict.json for re-plan
    const dispatchPath = join(runDirPath, 'dispatch.yaml');
    if (existsSync(dispatchPath)) {
      unlinkSync(dispatchPath);
    }
    const verdictPath = join(runDirPath, 'verdict.json');
    if (existsSync(verdictPath)) {
      unlinkSync(verdictPath);
    }

    log.info({ runId, iteration: iteration + 1 }, 'Re-planning...');
  }

  // Should not reach here, but safety net
  const finalState = readRunState(projectDir, runId);
  finalState.status = 'failed';
  finalState.completedAt = new Date().toISOString();
  writeRunState(projectDir, runId, finalState);
  writeCampaignEntry(projectDir, finalState);
  return finalState;
}

async function executeSingleStage(
  stage: StageConfig,
  projectDir: string,
  runId: string,
  runDirPath: string,
  workflow: WorkflowConfig,
  adapter: Adapter,
  agents: Map<string, AgentConfig>,
  resolvedAgentsDir: string,
  state: StoreState,
  allStages: StageConfig[],
  skills?: string,
  taskDescription?: string,
): Promise<void> {
  if (!agents.has(stage.role)) {
    const agentPath = join(resolvedAgentsDir, `${stage.role}.yaml`);
    if (!existsSync(agentPath)) throw new Error(`No agent config for role "${stage.role}"`);
    const raw = parseYaml(readFileSync(agentPath, 'utf-8'));
    agents.set(stage.role, applyBasePrompt(parseAgent(raw), loadBasePrompt(resolvedAgentsDir)));
  }
  const agent = agents.get(stage.role)!;
  const timeout = state.timeoutMs ?? stage.timeout_ms ?? workflow.defaults.timeout_ms;
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);

  let resolvedPrompt = stage.prompt_template || '';
  if (!resolvedPrompt) resolvedPrompt = taskDescription ?? '';

  let availableRoles: string | undefined;
  if (stage.dynamic_dispatch) {
    availableRoles = [...roleRegistry.entries()].map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
  }

  state.stages[stage.id] = { status: 'running', retries: 0, startedAt: new Date().toISOString() };
  writeRunState(projectDir, runId, state);

  const result = await runStage(adapter, {
    stageId: stage.id,
    role: agent,
    dependsOn: stage.depends_on ?? [],
    promptTemplate: resolvedPrompt,
    timeout_ms: timeout,
    projectDir,
    runId,
    runDir: runDirPath,
    retries: 0,
    skills,
    stageSkills: stage.skills,
    availableRoles,
    taskDescription: state.taskDescription || taskDescription,
    isGate: stage.is_gate,
  });

  state = readRunState(projectDir, runId);
  state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
  writeRunState(projectDir, runId, state);
}

async function executeIteration(
  sorted: StageConfig[],
  initialState: StoreState,
  projectDir: string,
  runId: string,
  runDirPath: string,
  workflow: WorkflowConfig,
  adapter: Adapter,
  agents: Map<string, AgentConfig>,
  resolvedAgentsDir: string,
  roleRegistry: Map<string, { name: string; description: string }>,
  injectedDispatchStages: Set<string>,
  skills?: string,
  taskDescription?: string,
): Promise<StoreState> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let state = readRunState(projectDir, runId);

    // Poll while awaiting approval
    if (state.status === 'awaiting_approval') {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // Inject dispatched stages
    for (const stage of sorted) {
      if (stage.dynamic_dispatch && !injectedDispatchStages.has(stage.id) &&
          state.stages[stage.id]?.status === 'complete') {
        injectedDispatchStages.add(stage.id);
        const injected = injectDispatchedStages(stage.id, roleRegistry, sorted, state, projectDir, runId);

        if (injected.length === 0) {
          // Check if there are static fallback stages
          const hasStaticFollowUp = sorted.some(s =>
            s.id !== stage.id && state.stages[s.id]?.status === 'pending'
          );
          if (!hasStaticFollowUp) {
            log.error({ stage: stage.id }, 'Planner did not write dispatch.yaml. No stages to execute.');
            state.status = 'failed';
            state.failureReason = 'Planner did not produce an execution plan (dispatch.yaml). Go back to discussion to clarify the task.';
            state.completedAt = new Date().toISOString();
            writeRunState(projectDir, runId, state);
            return state;
          }
          log.info({ stage: stage.id }, 'No dispatch.yaml — falling back to static stages');
        }

        state = readRunState(projectDir, runId);
      }
    }

    if (state.status === 'awaiting_approval') {
      // Auto-approve: skip plan review when autoApproveRetries is true, or on iteration 2+
      const currentIter = state.currentIteration ?? 1;
      if (state.autoApproveRetries === true || (currentIter > 1 && state.autoApproveRetries !== false)) {
        state.status = 'running';
        writeRunState(projectDir, runId, state);
        continue;
      }
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const ready = findAllReady(sorted, state);

    if (ready.length === 0) {
      // Don't set final status here — let the outer iteration loop check gates
      writeRunState(projectDir, runId, state);
      return state;
    }

    const toRun: StageConfig[] = [];
    for (const stage of ready) {
      if (stage.condition) {
        const met = evaluateCondition(stage.condition, projectDir, runId);
        if (!met) {
          const skipped: StageStatus = { status: 'skipped', retries: 0 };
          writeStageStatus(projectDir, runId, stage.id, skipped);
          state.stages[stage.id] = skipped;
          writeRunState(projectDir, runId, state);
          log.info({ stage: stage.id }, 'Skipped (condition not met)');
          continue;
        }
      }
      // Skip retry_to stages during initial execution; the inner loop handles them
      // But don't skip is_gate stages — they need to run to evaluate the gate
      if (stage.retry_to && stage.retry_to.length > 0 && !stage.is_gate) {
        const skipped: StageStatus = { status: 'skipped', retries: 0 };
        writeStageStatus(projectDir, runId, stage.id, skipped);
        state.stages[stage.id] = skipped;
        writeRunState(projectDir, runId, state);
        continue;
      }
      toRun.push(stage);
    }

    if (toRun.length === 0) continue;

    for (const stage of toRun) {
      const currentRetries = state.stages[stage.id]?.retries ?? 0;
      state.stages[stage.id] = { status: 'running', retries: currentRetries, startedAt: new Date().toISOString() };
    }
    writeRunState(projectDir, runId, state);

    const results = await Promise.all(toRun.map(async (stage) => {
      if (!agents.has(stage.role)) {
        const agentPath = join(resolvedAgentsDir, `${stage.role}.yaml`);
        if (!existsSync(agentPath)) throw new Error(`No agent config for role "${stage.role}"`);
        const raw = parseYaml(readFileSync(agentPath, 'utf-8'));
        agents.set(stage.role, applyBasePrompt(parseAgent(raw), loadBasePrompt(resolvedAgentsDir)));
      }
      const agent = agents.get(stage.role)!;
      const timeout = state.timeoutMs ?? stage.timeout_ms ?? workflow.defaults.timeout_ms;
      const currentRetries = state.stages[stage.id]?.retries ?? 0;
      log.info({ stage: stage.id, role: stage.role }, 'Running stage');

      let availableRoles: string | undefined;
      if (stage.dynamic_dispatch) {
        availableRoles = [...roleRegistry.entries()].map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
      }

      let resolvedPrompt = stage.prompt_template;
      if (!resolvedPrompt) {
        resolvedPrompt = (stage.depends_on ?? []).length === 0
          ? (taskDescription ?? '') + '\nProject: ' + projectDir
          : (taskDescription ?? '');
      }

      // Plan stage: prefer task_brief.md over taskDescription
      if ((stage.depends_on ?? []).length === 0) {
        const briefPath = join(runDirPath, 'task_brief.md');
        if (existsSync(briefPath)) {
          const briefContent = readFileSync(briefPath, 'utf-8').trim();
          if (briefContent) {
            resolvedPrompt = briefContent + '\nProject: ' + projectDir;
          }
        }
        // On re-plan, include iteration_log.md reference
        const iterLogPath = join(runDirPath, 'iteration_log.md');
        if (existsSync(iterLogPath)) {
          resolvedPrompt += `\n\nRead ${runDirPath}/iteration_log.md for previous iteration results. Fix the issues identified there.`;
        }
        // Campaign context: prepend history of previous runs
        if (state.campaignId) {
          const campaignPath = join(projectDir, '.fc', 'campaigns', `${state.campaignId}.jsonl`);
          if (existsSync(campaignPath)) {
            try {
              const lines = readFileSync(campaignPath, 'utf-8').trim().split('\n').filter(Boolean);
              const entries: CampaignEntry[] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
              if (entries.length > 0) {
                const rows = entries.map(e => `| ${e.seq} | ${e.score} | ${e.metric} | ${e.gate} | ${e.pass ? 'pass' : 'fail'} |`).join('\n');
                const best = entries.reduce((max, e) => e.score > max ? e.score : max, -Infinity);
                let ctx = `=== CAMPAIGN: ${state.campaignId} ===\n| # | Score | Metric | Gate | Status |\n|---|-------|--------|------|--------|\n${rows}\n\nBest ever: ${best}\n`;
                // Include file paths to previous run summaries
                const summaryPaths: string[] = [];
                for (const e of entries) {
                  const prevRunDir = join(projectDir, '.fc', 'runs', (e as any).runId);
                  const iterLog = join(prevRunDir, 'iteration_log.md');
                  if (existsSync(iterLog)) summaryPaths.push(iterLog);
                }
                if (summaryPaths.length > 0) {
                  ctx += `\nPrevious run summaries:\n${summaryPaths.map(p => `- ${p}`).join('\n')}\n`;
                }
                const triggers = (state as any).campaignTriggers;
                const alert = checkCampaignHealth(entries, triggers?.enabled === false ? undefined : triggers);
                if (alert) {
                  ctx += `\n⚠️ CAMPAIGN ALERT: ${alert.type} — ${alert.message}\nDO NOT retry approaches from failed runs. Propose a fundamentally different approach.\n`;
                }
                ctx += `=== END CAMPAIGN ===\n\n`;
                resolvedPrompt = ctx + resolvedPrompt;
              }
            } catch { /* ignore */ }
          }
        }
      }

      // Prepend timeout retry context if this is a retry after timeout
      if (currentRetries > 0) {
        const timeoutSec = Math.ceil(timeout / 1000);
        resolvedPrompt = `RETRY (attempt ${currentRetries + 1}): Previous attempt timed out after ${timeoutSec}s. Read partial output at .fc/runs/${runId}/stages/${stage.id}/output.md and continue from where you left off. Do not start over.\n\n${resolvedPrompt}`;
      }

      const result = await runStage(adapter, {
        stageId: stage.id,
        role: agent,
        dependsOn: stage.depends_on ?? [],
        promptTemplate: resolvedPrompt,
        timeout_ms: timeout,
        projectDir,
        runId,
        runDir: runDirPath,
        retries: currentRetries,
        skills,
        stageSkills: stage.skills,
        availableRoles,
        taskDescription: state.taskDescription || taskDescription,
        isGate: stage.is_gate,
      });
      return { stage, result, currentRetries };
    }));

    state = readRunState(projectDir, runId);
    let failed = false;

    for (const { stage, result, currentRetries } of results) {
      const maxRetries = stage.max_retries ?? workflow.defaults.max_retries;

      if (result.timedOut && currentRetries < maxRetries) {
        const nextRetry = currentRetries + 1;
        const retryStatus: StageStatus = { status: 'pending', retries: nextRetry };
        writeStageStatus(projectDir, runId, stage.id, retryStatus);
        state.stages[stage.id] = retryStatus;
        log.warn({ stage: stage.id, retry: nextRetry }, 'Retrying timed-out stage');
        continue;
      }

      if (result.exitCode !== 0 && currentRetries < maxRetries) {
        const retryStatus: StageStatus = { status: 'pending', retries: currentRetries + 1 };
        writeStageStatus(projectDir, runId, stage.id, retryStatus);
        state.stages[stage.id] = retryStatus;
        log.warn({ stage: stage.id, retry: currentRetries + 1 }, 'Retrying stage');
        continue;
      }

      if (result.exitCode !== 0) {
        log.error({ stage: stage.id }, 'Stage failed');
        failed = true;
        state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
        continue;
      }

      state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
      log.info({ stage: stage.id }, 'Stage complete');
    }

    writeRunState(projectDir, runId, state);

    if (failed) {
      // Don't set run status to failed here — let the iteration loop handle it
      return state;
    }
  }
}
