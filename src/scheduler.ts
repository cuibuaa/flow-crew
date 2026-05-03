import { readFileSync, mkdirSync, readdirSync, writeFileSync, existsSync, unlinkSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { Adapter, AgentConfig } from './adapters/base.js';
import { evaluateCondition } from './condition.js';
import { createRun, readRunState, writeRunState, writeStageStatus, readStageStatus } from './store.js';
import type { StoreState, StageStatus } from './store.js';
import { runStage } from './worker.js';
import {
  canonicalCampaignId,
  collapseEntriesForHealth,
  readCampaignEntries,
  resolveCampaignStorageKey,
  summarizeCampaignPhaseProgress,
} from './campaigns.js';
import { recordRunEvent, recordStageOutcome } from './run-events.js';
import { readKG, summarizeKG, ratchetCheck, markDeadEnd, updateMetadata } from './knowledge-graph.js';
import { appendTraceEvent } from './trace.js';
import pino from 'pino';

const log = pino({ name: 'scheduler' });
const DEFAULT_GATE_RETRY_LOOPS = 1;
const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_STAGE_TECHNICAL_RETRIES = 1;

/** Load project defaults from config/defaults.yaml */
type ProjectDefaults = { timeout_ms: number; max_iterations: number; model: string; reasoning_effort: string; gate_retry_loops: number; stage_technical_retries: number };

const FALLBACK_DEFAULTS: ProjectDefaults = {
  timeout_ms: 300000,
  max_iterations: DEFAULT_MAX_ITERATIONS,
  model: 'default',
  reasoning_effort: 'default',
  gate_retry_loops: DEFAULT_GATE_RETRY_LOOPS,
  stage_technical_retries: DEFAULT_STAGE_TECHNICAL_RETRIES,
};

let _schedulerDefaultsCache: ProjectDefaults | null = null;
let _schedulerDefaultsMtime = 0;
let _schedulerDefaultsPath = '';

function loadDefaults(projectDir?: string): ProjectDefaults {
  const defaultsPath = join(projectDir ?? process.cwd(), 'config', 'defaults.yaml');
  try {
    const mtime = statSync(defaultsPath).mtimeMs;
    if (_schedulerDefaultsCache && mtime === _schedulerDefaultsMtime && defaultsPath === _schedulerDefaultsPath) return _schedulerDefaultsCache;
    _schedulerDefaultsMtime = mtime;
    _schedulerDefaultsPath = defaultsPath;
    const raw = readFileSync(defaultsPath, 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    _schedulerDefaultsCache = {
      timeout_ms: typeof parsed.default_timeout_ms === 'number' ? parsed.default_timeout_ms : 300000,
      max_iterations: typeof parsed.default_max_iterations === 'number' ? parsed.default_max_iterations : DEFAULT_MAX_ITERATIONS,
      model: typeof parsed.model === 'string' ? parsed.model : 'default',
      reasoning_effort: typeof parsed.reasoning_effort === 'string' ? parsed.reasoning_effort : 'default',
      gate_retry_loops: typeof parsed.default_gate_retry_loops === 'number' ? parsed.default_gate_retry_loops : DEFAULT_GATE_RETRY_LOOPS,
      stage_technical_retries: typeof parsed.default_stage_technical_retries === 'number' ? parsed.default_stage_technical_retries : DEFAULT_STAGE_TECHNICAL_RETRIES,
    };
    return _schedulerDefaultsCache;
  } catch { /* fallback */ }
  return _schedulerDefaultsCache ?? FALLBACK_DEFAULTS;
}

const AgentConfigSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  model: z.string().default('default'),
  reasoning_effort: z.string().default('default'),
  tools: z.array(z.string()).default([]),
  prompt: z.string(),
});

function parseAgent(raw: unknown, projectDir?: string): AgentConfig {
  const agent = AgentConfigSchema.parse(raw);
  if (agent.model === 'default') agent.model = loadDefaults(projectDir).model;
  if (agent.reasoning_effort === 'default') agent.reasoning_effort = loadDefaults(projectDir).reasoning_effort;
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
    timeout_ms: z.number().optional(),
    max_retries: z.number().optional(),
    max_iterations: z.number().optional(),
  }).optional().default({}),
  stages: z.array(StageConfigSchema).min(1),
});

export type StageConfig = z.infer<typeof StageConfigSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

type CampaignMetric = { score: number; metric: string; gate: string; pass: boolean; threshold?: number };
type CampaignPhaseMetadata = {
  gate: string;
  pass: boolean;
  phase?: string;
  phaseComplete?: boolean;
  nextPhase?: string;
  outcome?: string;
  artifactSummary?: string;
  reason?: string;
};
type GateMetricLookup = { found: boolean; metric: CampaignMetric | null };

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

function appendGateMetricInstruction(prompt: string, runDirPath: string, stageId: string): string {
  const metricPath = join(runDirPath, 'stages', stageId, 'metric.json');
  return `${prompt}

## Optional Campaign Metric Artifact

If this gate evaluates evidence that contains a numeric campaign metric, write a metric artifact to:

${metricPath}

Use exactly this JSON shape when a trustworthy numeric metric exists:

{
  "hasMetric": true,
  "metric": "metric name",
  "value": 0,
  "higherIsBetter": true,
  "threshold": null,
  "pass": false,
  "source": {
    "path": "path to the evidence file used",
    "evidence": "short exact evidence text"
  },
  "notes": "short explanation"
}

Rules:
- Write this file only from gate stages.
- Do not invent a metric.
- Use only evidence you verified in this gate stage.
- If multiple numeric metrics exist, choose the primary campaign metric stated in the task, workflow, or evidence.
- If no trustworthy numeric campaign metric exists, write:

{
  "hasMetric": false,
  "reason": "No trustworthy numeric campaign metric was found for this gate."
}

- Keep the normal workflow verdict file separate. The workflow verdict remains pass/reason only unless explicitly instructed otherwise.
- If this gate controls a campaign phase, also include phase metadata in the verdict or metric artifact:
  phase, phaseComplete, nextPhase, outcome, artifactSummary, reason.
  This lets future planner iterations use the existing campaign file to continue from the next phase instead of redispatching all phases.
- If you write a metric value, ensure it is a JSON number, not a string.`;
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

/** List available skill names from config/skills/ directory */
function listAvailableSkills(projectDir: string): string {
  const skillsDir = join(projectDir, 'config', 'skills');
  try {
    const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) return 'none';
    return files.map(f => f.replace('.md', '')).join(', ');
  } catch { return 'none'; }
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
  // Accept both bare list and {stages: [...]} wrapper
  let itemList: unknown[];
  if (Array.isArray(items)) {
    itemList = items;
  } else if (items && typeof items === 'object' && Array.isArray((items as Record<string, unknown>).stages)) {
    itemList = (items as Record<string, unknown>).stages as unknown[];
  } else {
    return [];
  }

  const dispatched: StageConfig[] = [];
  const skippedReasons: string[] = [];
  const seenIds = new Set<string>(sorted.map(s => s.id));
  for (let i = 0; i < itemList.length; i++) {
    const item = itemList[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') continue;
    if (!item.id) item.id = `dispatch_${i}`;
    if (seenIds.has(item.id as string)) {
      skippedReasons.push(`${item.id}: duplicate stage ID`);
      log.warn({ id: item.id }, 'Duplicate stage ID in dispatch.yaml, skipping');
      continue;
    }
    if (!roleRegistry.has(item.role as string)) {
      skippedReasons.push(`${item.id}: unknown role "${item.role}"`);
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
      seenIds.add(item.id as string);
    } catch (e) {
      skippedReasons.push(`${item.id}: invalid schema`);
      log.warn({ id: item.id }, 'Invalid stage in dispatch.yaml, skipping');
    }
  }
  if (dispatched.length === 0) {
    if (skippedReasons.length > 0) {
      log.warn({ skippedReasons }, 'All stages in dispatch.yaml were invalid');
    }
    return [];
  }

  resolveDispatchDependencies(dispatched, dispatchStageId);

  // Validate dependencies: remove references to non-existent stages and self-references to prevent hangs
  const allKnownIds = new Set([...sorted.map(s => s.id), ...dispatched.map(s => s.id)]);
  for (const s of dispatched) {
    const invalid = s.depends_on.filter(d => !allKnownIds.has(d) || d === s.id);
    if (invalid.length > 0) {
      log.warn({ stage: s.id, invalidDeps: invalid }, 'Removing invalid depends_on references');
      s.depends_on = s.depends_on.filter(d => allKnownIds.has(d) && d !== s.id);
      if (s.depends_on.length === 0) s.depends_on = [dispatchStageId];
    }
    // Validate retry_to references
    if (s.retry_to && s.retry_to.length > 0) {
      // Gate stages must not also be retry targets — strip retry_to to prevent confusing behavior
      if (s.is_gate) {
        log.warn({ stage: s.id }, 'Gate stage has retry_to — stripping retry_to (gates evaluate, fix stages retry)');
        s.retry_to = undefined;
      } else {
        const invalidRetry = s.retry_to.filter(r => !allKnownIds.has(r));
        if (invalidRetry.length > 0) {
          log.warn({ stage: s.id, invalidRetryTo: invalidRetry }, 'Removing invalid retry_to references');
          s.retry_to = s.retry_to.filter(r => allKnownIds.has(r));
          if (s.retry_to.length === 0) s.retry_to = undefined;
        }
        // Auto-add gate IDs to depends_on so retry_to stages wait for the gate
        if (s.retry_to) {
          const missing = s.retry_to.filter(g => !s.depends_on.includes(g));
          if (missing.length > 0) {
            log.info({ stage: s.id, addedDeps: missing }, 'Auto-adding gate IDs to depends_on for retry_to stage');
            s.depends_on = [...new Set([...s.depends_on, ...missing])];
          }
        }
      }
    }
  }

  // Cycle detection among dispatched stages to prevent hangs
  {
    const dispatchedIds = new Set(dispatched.map(s => s.id));
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const hasCycle = (id: string): boolean => {
      if (inStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      const stage = dispatched.find(s => s.id === id);
      if (stage) {
        for (const dep of stage.depends_on) {
          if (dispatchedIds.has(dep) && hasCycle(dep)) return true;
        }
      }
      inStack.delete(id);
      return false;
    };
    for (const s of dispatched) {
      if (hasCycle(s.id)) {
        log.warn({ stage: s.id }, 'Cycle detected in dispatched stages — breaking cycle by resetting depends_on to dispatch stage');
        s.depends_on = [dispatchStageId];
      }
    }
  }

  // Create stage directories and add to state (preserve existing status for reruns)
  let isReinjection = false;
  for (const s of dispatched) {
    mkdirSync(join(projectDir, '.fc', 'runs', runId, 'stages', s.id), { recursive: true });
    if (state.stages[s.id]) {
      isReinjection = true;
    } else {
      state.stages[s.id] = { status: 'pending', retries: 0 };
    }
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
  // Skip plan review when re-injecting stages during a stage-level rerun
  if (!isReinjection) {
    state.status = 'awaiting_approval';
  }
  writeRunState(projectDir, runId, state);

  return dispatched;
}

export function appendIterationLog(
  projectDir: string,
  runId: string,
  iteration: number,
  state: StoreState,
  dispatchedStageIds: string[],
  baseStageIds?: string[],
  innerRetriesUsed?: number,
  maxInnerRetries?: number,
): void {
  const runDir = join(projectDir, '.fc', 'runs', runId);
  const logPath = join(runDir, 'iteration_log.md');
  mkdirSync(runDir, { recursive: true });
  const lines: string[] = [`# Iteration ${iteration}`];
  if (innerRetriesUsed !== undefined && maxInnerRetries !== undefined && maxInnerRetries > 0) {
    lines.push(`Fix→gate retries used: ${innerRetriesUsed}/${maxInnerRetries}`);
  }
  // Include base stages (e.g. plan) so re-plan iterations have context on failures
  const allIds = [...(baseStageIds ?? []), ...dispatchedStageIds];
  const seen = new Set<string>();
  for (const sid of allIds) {
    if (seen.has(sid)) continue;
    seen.add(sid);
    const ss = state.stages[sid];
    if (!ss) continue;
    lines.push(`## ${sid} (${ss.status})`);
    lines.push(`Output: ${runDir}/stages/${sid}/output.md`);
    lines.push(`Artifacts: ${ss.artifacts?.join(', ') || 'none'}`);
    if (ss.error) {
      const isAdapter = ss.error === 'adapter connection failed';
      lines.push(`Error: ${ss.error}${isAdapter ? ' (transient — not a code issue, retry may succeed)' : ''}`);
    }
    if (ss.duration_ms !== undefined) lines.push(`Duration: ${Math.round(ss.duration_ms / 1000)}s`);
    // Include actual gate verdict if available
    const verdict = readGateVerdict(projectDir, sid, runId);
    if (verdict) {
      lines.push(`Gate verdict: ${verdict.pass ? 'PASS' : 'FAIL'}${verdict.reason ? ' — ' + verdict.reason : ''}`);
    }
    // Include campaign metric if available
    const metricLookup = parseGateMetric(projectDir, state, sid);
    if (metricLookup.metric) {
      const m = metricLookup.metric;
      lines.push(`Metric: ${m.metric} = ${m.score}${m.threshold !== undefined ? ` (threshold: ${m.threshold})` : ''}`);
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

/** Persist the latest scored and/or phase campaign entry for the current run iteration. */
export function writeCampaignEntry(projectDir: string, state: StoreState): void {
  const campaignStorageKey = resolveCampaignStorageKey({
    campaignId: state.campaignId,
    campaignStorageKey: state.campaignStorageKey,
    campaignName: state.campaignName,
  });
  if (!campaignStorageKey) return;
  const campaignsDir = join(projectDir, '.fc', 'campaigns');
  mkdirSync(campaignsDir, { recursive: true });
  const filePath = join(campaignsDir, `${campaignStorageKey}.jsonl`);
  const runPath = join(projectDir, '.fc', 'runs', state.runId);
  const metric = findCampaignMetric(projectDir, state);
  const phase = findCampaignPhaseMetadata(projectDir, state);
  if (!metric && !phase) return;
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
  const entry: Record<string, unknown> = {
    seq: state.campaignSeq ?? 1,
    runId: state.runId,
    iteration: state.currentIteration ?? 1,
    gate: metric?.gate ?? phase?.gate ?? 'campaign_phase',
    pass: metric?.pass ?? phase?.pass ?? false,
    gates: `${gatesPassed}/${gatesTotal}`,
    status: state.status,
    timestamp: new Date().toISOString(),
    campaignId: canonicalCampaignId(state.campaignId ?? state.campaignName ?? campaignStorageKey)
      ?? campaignStorageKey,
    campaignStorageKey,
    campaignName: state.campaignName,
  };
  if (metric) {
    entry.score = metric.score;
    entry.metric = metric.metric;
    entry.threshold = metric.threshold;
  }
  if (phase?.phase) entry.phase = phase.phase;
  if (typeof phase?.phaseComplete === 'boolean') entry.phaseComplete = phase.phaseComplete;
  if (phase?.nextPhase) entry.nextPhase = phase.nextPhase;
  if (phase?.outcome) entry.outcome = phase.outcome;
  if (phase?.artifactSummary) entry.artifactSummary = phase.artifactSummary;
  if (phase?.reason) entry.reason = phase.reason;
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}

function parseGateMetric(projectDir: string, state: StoreState, gateId: string): GateMetricLookup {
  const metricPath = join(projectDir, '.fc', 'runs', state.runId, 'stages', gateId, 'metric.json');
  if (!existsSync(metricPath)) return { found: false, metric: null };
  try {
    const artifact = JSON.parse(readFileSync(metricPath, 'utf-8'));
    if (artifact?.hasMetric !== true) return { found: true, metric: null };
    if (typeof artifact.value !== 'number' || !Number.isFinite(artifact.value)) return { found: true, metric: null };
    return {
      found: true,
      metric: {
        score: artifact.value,
        metric: typeof artifact.metric === 'string' ? artifact.metric : '',
        gate: gateId,
        pass: artifact.pass === true,
        threshold: typeof artifact.threshold === 'number' && Number.isFinite(artifact.threshold) ? artifact.threshold : undefined,
      },
    };
  } catch {
    return { found: true, metric: null };
  }
}

function parseLegacyVerdictMetric(projectDir: string, state: StoreState, gateId: string): CampaignMetric | null {
  const verdictPath = join(projectDir, '.fc', 'runs', state.runId, `verdict_${gateId}.json`);
  try {
    const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
    if (typeof verdict.score !== 'number' || !Number.isFinite(verdict.score)) return null;
    return {
      score: verdict.score,
      metric: typeof verdict.metric === 'string' ? verdict.metric : '',
      gate: gateId,
      pass: verdict.pass === true,
      threshold: typeof verdict.threshold === 'number' && Number.isFinite(verdict.threshold) ? verdict.threshold : undefined,
    };
  } catch {
    return null;
  }
}

function phaseMetadataFromArtifact(artifact: unknown, gateId: string): CampaignPhaseMetadata | null {
  if (!artifact || typeof artifact !== 'object') return null;
  const record = artifact as Record<string, unknown>;
  const phase = typeof record.phase === 'string' ? record.phase : undefined;
  const nextPhase = typeof record.nextPhase === 'string'
    ? record.nextPhase
    : typeof record.next_phase === 'string'
      ? record.next_phase
      : undefined;
  const outcome = typeof record.outcome === 'string' ? record.outcome : undefined;
  const artifactSummary = typeof record.artifactSummary === 'string'
    ? record.artifactSummary
    : typeof record.artifact_summary === 'string'
      ? record.artifact_summary
      : undefined;
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  const phaseComplete = typeof record.phaseComplete === 'boolean'
    ? record.phaseComplete
    : typeof record.phase_complete === 'boolean'
      ? record.phase_complete
      : undefined;
  const hasPhaseMetadata = phase !== undefined
    || nextPhase !== undefined
    || outcome !== undefined
    || artifactSummary !== undefined
    || reason !== undefined
    || phaseComplete !== undefined;
  if (!hasPhaseMetadata) return null;
  return {
    gate: gateId,
    pass: record.pass === true,
    phase,
    phaseComplete,
    nextPhase,
    outcome,
    artifactSummary,
    reason,
  };
}

function parseGatePhaseMetadata(projectDir: string, state: StoreState, gateId: string): CampaignPhaseMetadata | null {
  const paths = [
    join(projectDir, '.fc', 'runs', state.runId, 'stages', gateId, 'metric.json'),
    join(projectDir, '.fc', 'runs', state.runId, `verdict_${gateId}.json`),
  ];
  for (const artifactPath of paths) {
    try {
      const parsed = JSON.parse(readFileSync(artifactPath, 'utf-8'));
      const metadata = phaseMetadataFromArtifact(parsed, gateId);
      if (metadata) return metadata;
    } catch {
      // Missing or malformed artifacts are ignored for phase tracking.
    }
  }
  return null;
}

function orderedGateIdsForState(projectDir: string, state: StoreState): string[] {
  const runPath = join(projectDir, '.fc', 'runs', state.runId);
  if (state.dispatchedStages && Array.isArray(state.dispatchedStages)) {
    return (state.dispatchedStages as { id: string; is_gate?: boolean }[])
      .filter(s => s.is_gate)
      .map(s => s.id);
  }

  const ids = new Set<string>();
  try {
    const files = readdirSync(runPath).filter(f => f.startsWith('verdict_') && f.endsWith('.json'));
    for (const file of files) ids.add(file.replace('verdict_', '').replace('.json', ''));
  } catch {
    // No verdicts yet.
  }
  try {
    const stagesPath = join(runPath, 'stages');
    for (const stageId of readdirSync(stagesPath)) {
      if (existsSync(join(stagesPath, stageId, 'metric.json'))) ids.add(stageId);
    }
  } catch {
    // No stage metrics yet.
  }
  return [...ids];
}

/** Find the last scored gate in pipeline order for campaign tracking */
export function findCampaignMetric(projectDir: string, state: StoreState): CampaignMetric | null {
  let best: CampaignMetric | null = null;
  for (const gateId of orderedGateIdsForState(projectDir, state)) {
    const metricLookup = parseGateMetric(projectDir, state, gateId);
    const metric = metricLookup.found ? metricLookup.metric : parseLegacyVerdictMetric(projectDir, state, gateId);
    if (metric) best = metric;
  }
  return best;
}

/** Find the last gate phase metadata in pipeline order for campaign tracking. */
export function findCampaignPhaseMetadata(projectDir: string, state: StoreState): CampaignPhaseMetadata | null {
  let latest: CampaignPhaseMetadata | null = null;
  for (const gateId of orderedGateIdsForState(projectDir, state)) {
    const metadata = parseGatePhaseMetadata(projectDir, state, gateId);
    if (metadata) latest = metadata;
  }
  return latest;
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
  score?: number;
  metric?: string;
  gate?: string;
  pass: boolean;
  timestamp: string;
  phase?: string;
  phaseComplete?: boolean;
  nextPhase?: string;
  outcome?: string;
}

type ScoredCampaignEntry = CampaignEntry & { score: number; metric: string };

/** Check campaign health from JSONL entries */
export function checkCampaignHealth(entries: CampaignEntry[], triggers?: { enabled?: boolean; regressionAfter?: number; plateauAfter?: number; plateauThreshold?: number; repeatedFailureAfter?: number }): CampaignAlert | null {
  if (triggers?.enabled === false) return null;
  const scoredEntries = entries.filter((entry): entry is ScoredCampaignEntry => typeof entry.score === 'number' && typeof entry.metric === 'string');
  const scoped = collapseEntriesForHealth(scoredEntries) as ScoredCampaignEntry[];
  if (scoped.length < 2) return null;
  const regAfter = triggers?.regressionAfter ?? 2;
  const platAfter = triggers?.plateauAfter ?? 3;
  const platThresh = triggers?.plateauThreshold ?? 5;
  const repAfter = triggers?.repeatedFailureAfter ?? 3;
  const latestMetric = scoped.at(-1)?.metric;
  const comparable = latestMetric ? scoped.filter((entry) => entry.metric === latestMetric) : scoped;

  // Consecutive declines
  let declines = 0;
  for (let i = comparable.length - 1; i > 0; i--) {
    if (comparable[i].score < comparable[i - 1].score) declines++;
    else break;
  }
  if (declines >= regAfter) return { type: 'regression', action: 'inject_researcher', message: `${declines} consecutive score declines` };

  // Plateau (±threshold% for N+ entries)
  if (comparable.length >= platAfter) {
    const recent = comparable.slice(-platAfter);
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
  if (scoped.length >= repAfter) {
    const recent = scoped.slice(-repAfter);
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
  const seenGateIds = new Set<string>();
  const gateStages = allStages.filter((s) => {
    if (!s.is_gate || seenGateIds.has(s.id)) return false;
    seenGateIds.add(s.id);
    return true;
  });
  if (gateStages.length === 0) return { allPass: true, failedGateIds: [] };
  const failedGateIds: string[] = [];
  for (const g of gateStages) {
    const gateStatus = state.stages[g.id]?.status;
    // A gate only passes after it completed and wrote an explicit pass verdict.
    // Pending/running/skipped/missing gates must block run completion.
    if (gateStatus !== 'complete') {
      failedGateIds.push(g.id);
      continue;
    }
    const verdict = readGateVerdict(projectDir, g.id, runId);
    if (verdict && verdict.pass === true) continue; // explicit pass
    // Missing verdict or explicit fail → treat as failure
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
    const { allPass } = checkGates(gateStages, state, projectDir, runId);
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
  let maxIterations = workflow.defaults.max_iterations ?? loadDefaults(projectDir).max_iterations;

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
    maxIterations = state.maxIterations ?? maxIterations;
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

  // Use full task brief as taskDescription for template substitution in dispatched stages
  const briefPath = join(runDirPath, 'task_brief.md');
  if (existsSync(briefPath)) {
    const briefContent = readFileSync(briefPath, 'utf-8').trim();
    if (briefContent) taskDescription = briefContent;
  }

  const resolvedAgentsDir = agentsDir ?? join(projectDir, 'config', 'agents');
  const basePrompt = loadBasePrompt(resolvedAgentsDir);
  // Apply base prompt to all pre-loaded agents
  for (const [k, v] of agents) agents.set(k, applyBasePrompt(v, basePrompt));
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);
  const availableSkillsList = listAvailableSkills(projectDir);

  // Iteration loop
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let state = readRunState(projectDir, runId);

    // Exit if run was cancelled externally
    if (state.status === 'failed' || state.status === 'complete') {
      return state;
    }

    state.currentIteration = iteration;
    const campaignStorageKey = resolveCampaignStorageKey({
      campaignId: state.campaignId,
      campaignStorageKey: state.campaignStorageKey,
      campaignName: state.campaignName,
    });
    if (campaignStorageKey) {
      state.campaignStorageKey = campaignStorageKey;
      state.campaignIteration = iteration;
    } else {
      state.campaignIteration = undefined;
    }
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

      // Clean stale verdict files from previous iteration so new gates start fresh
      try {
        for (const f of readdirSync(runDirPath)) {
          if (f.startsWith('verdict') && f.endsWith('.json')) {
            unlinkSync(join(runDirPath, f));
          }
        }
      } catch { /* best effort */ }

      // Re-write workflow.yaml to base stages only
      writeFileSync(join(runDirPath, 'workflow.yaml'), workflowYaml, 'utf-8');
    }

    // Track dispatched stage IDs for this iteration
    let iterationDispatchedIds: string[] = [];

    // Campaign health check: inject researcher if regression/plateau detected
    if (campaignStorageKey && iteration > 1) {
      const entries = readCampaignEntries(projectDir, campaignStorageKey);
      const triggers = state.campaignTriggers;
      const alert = checkCampaignHealth(entries, triggers);
      if (alert) {
        const triggeredAt = new Date().toISOString();
        state.campaignAlert = {
          ...alert,
          source: 'campaign_health',
          triggeredAt,
          iteration,
        };
        state.researchInjection = {
          source: 'campaign_health',
          triggeredAt,
          iteration,
          alertType: alert.type,
          message: alert.message,
        };
        writeRunState(projectDir, runId, state);
        recordRunEvent(projectDir, runId, {
          type: 'campaign_alert',
          runId,
          timestamp: triggeredAt,
          iteration,
          detail: `${alert.type}: ${alert.message}`,
        });
        recordRunEvent(projectDir, runId, {
          type: 'research_injected',
          runId,
          timestamp: triggeredAt,
          iteration,
          detail: `${alert.type}: ${alert.message}`,
        });
        log.info({ runId, alert: alert.type }, 'Campaign health alert — researcher will be injected via planner context');
        // Auto-mark current approach nodes as dead ends
        try {
          const kg = readKG(projectDir, runId);
          for (const node of kg.nodes.filter(n => n.type === 'approach')) {
            markDeadEnd(projectDir, runId, node.id, `Marked dead_end by campaign health: ${alert.message}`);
          }
        } catch { /* non-fatal */ }
      } else if (state.campaignAlert) {
        state.campaignAlert = undefined;
        writeRunState(projectDir, runId, state);
      }
    }

    // Inner execution loop for this iteration
    const iterationResult = await executeIteration(
      sorted, state, projectDir, runId, runDirPath, workflow, adapter, agents,
      resolvedAgentsDir, roleRegistry, injectedDispatchStages, skills, taskDescription, availableSkillsList,
    );

    state = readRunState(projectDir, runId);

    // Collect dispatched stage IDs (only from stages in the current sorted pipeline, not orphans)
    const baseIds = new Set(baseStages.map(s => s.id));
    iterationDispatchedIds = sorted
      .filter(s => !baseIds.has(s.id))
      .map(s => s.id);

    // === INNER LOOP (retry_to) ===
    const maxInnerRetries = Math.max(0, Math.floor(Number(state.maxRetries ?? loadDefaults(projectDir).gate_retry_loops)));
    let innerRetriesUsed = 0;
    if (iterationDispatchedIds.length > 0) {
      const { allPass, failedGateIds } = checkGates(sorted, state, projectDir, runId);
      if (!allPass) {
        const retryStages = findAllRetryToStages(sorted, failedGateIds);
        if (retryStages.length > 0) {
          for (let inner = 0; inner < maxInnerRetries; inner++) {

            // Check for cancellation between retries
            state = readRunState(projectDir, runId);
            if (state.status === 'failed' || state.status === 'complete') break;

            // Determine which retry stages need to run based on current failed gates
            const currentCheck = inner === 0
              ? { allPass: failedGateIds.length === 0, failedGateIds }
              : checkGates(sorted, state, projectDir, runId);
            const currentFailedGateIds = inner === 0 ? failedGateIds : currentCheck.failedGateIds;
            if (inner > 0 && currentCheck.allPass) break;

            const activeRetryStages = findAllRetryToStages(sorted, currentFailedGateIds);
            if (activeRetryStages.length === 0) break;

            // Clear verdict and metric files for all gates referenced by active retry stages
            for (const retryStage of activeRetryStages) {
              for (const gid of retryStage.retry_to!) {
                const perGate = join(runDirPath, `verdict_${gid}.json`);
                if (existsSync(perGate)) unlinkSync(perGate);
                const gateMetric = join(runDirPath, 'stages', gid, 'metric.json');
                if (existsSync(gateMetric)) unlinkSync(gateMetric);
              }
            }
            const sharedVerdict = join(runDirPath, 'verdict.json');
            if (existsSync(sharedVerdict)) unlinkSync(sharedVerdict);

            // Reset and run all active retry stages (possibly in parallel)
            for (const retryStage of activeRetryStages) {
              state.stages[retryStage.id] = { status: 'pending', retries: 0 };
              mkdirSync(join(runDirPath, 'stages', retryStage.id), { recursive: true });
              // Clear live.log so the SSE feed shows only the current attempt's output
              const liveLog = join(runDirPath, 'stages', retryStage.id, 'live.log');
              if (existsSync(liveLog)) unlinkSync(liveLog);
            }
            writeRunState(projectDir, runId, state);

            await Promise.all(activeRetryStages.map(retryStage =>
              executeSingleStage(retryStage, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription, inner, undefined, availableSkillsList)
            ));
            innerRetriesUsed = inner + 1;
            syncStageStatuses(projectDir, runId, activeRetryStages.map(s => s.id));
            state = readRunState(projectDir, runId);

            // Check for cancellation after fix stages complete
            if (state.status === 'failed' || state.status === 'complete') break;

            // Skip gate re-runs if any fix stage itself failed (saves wasted agent calls)
            const anyFixFailed = activeRetryStages.some(s => state.stages[s.id]?.status === 'failed');
            if (anyFixFailed) {
              // If the failure is a transient adapter error, continue to next retry instead of aborting
              const allAdapterErrors = activeRetryStages
                .filter(s => state.stages[s.id]?.status === 'failed')
                .every(s => state.stages[s.id]?.error === 'adapter connection failed');
              if (allAdapterErrors && inner < maxInnerRetries - 1) {
                log.info({ runId, iteration, inner }, 'Fix stage failed due to adapter error — retrying');
                continue;
              }
              log.info({ runId, iteration, inner }, 'Fix stage failed — skipping gate re-evaluation');
              break;
            }

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
              // Clear live.log so the SSE feed shows only the current re-evaluation's output
              const liveLog = join(runDirPath, 'stages', gate.id, 'live.log');
              if (existsSync(liveLog)) unlinkSync(liveLog);
              writeRunState(projectDir, runId, state);
            }
            if (existsSync(sharedVerdict)) unlinkSync(sharedVerdict);

            // Run gate stages (possibly in parallel), passing fix stage IDs for context
            if (gatesToRerun.length > 0) {
              await Promise.all(gatesToRerun.map(gate =>
                executeSingleStage(gate, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription, inner, activeRetryStages.map(s => s.id), availableSkillsList)
              ));
              syncStageStatuses(projectDir, runId, gatesToRerun.map(s => s.id));
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
    appendIterationLog(projectDir, runId, iteration, state, iterationDispatchedIds, baseStages.map(s => s.id), innerRetriesUsed, maxInnerRetries);
    writeCampaignEntry(projectDir, state);

    // Update KG metadata with campaign metric
    try {
      const metricForKG = findCampaignMetric(projectDir, state);
      if (metricForKG) updateMetadata(projectDir, runId, metricForKG.score, metricForKG.metric);
    } catch { /* non-fatal */ }

    // Ratchet check: update knowledge graph with iteration score
    try {
      const metric = findCampaignMetric(projectDir, state);
      if (metric) {
        const result = ratchetCheck(projectDir, runId, metric.score, metric.metric, metric.gate);
        log.info({ runId, iteration, improved: result.improved, score: metric.score, previousBest: result.previousBest }, 'Ratchet check completed');
      }
    } catch (err) {
      log.warn({ runId, iteration, err }, 'Ratchet check failed (non-fatal)');
    }

    recordRunEvent(projectDir, runId, {
      type: 'iteration_completed',
      runId,
      timestamp: new Date().toISOString(),
      iteration,
      detail: `iteration ${iteration} completed`,
    });

    // Check if last gate passed
    if (iterationDispatchedIds.length > 0 && !anyFailed(state) && lastGatePassed(state, iterationDispatchedIds, sorted, projectDir, runId)) {
      state.status = 'complete';
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      writeCampaignEntry(projectDir, state);
      recordRunEvent(projectDir, runId, {
        type: 'run_completed',
        runId,
        timestamp: state.completedAt,
        iteration,
        detail: state.status,
      });
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
      recordRunEvent(projectDir, runId, {
        type: 'run_completed',
        runId,
        timestamp: state.completedAt,
        iteration,
        detail: state.status,
      });
      return state;
    }

    // Non-gate stage failure: if a stage failed and there are no gates to retry through,
    // fail immediately instead of silently re-planning
    const hasGates = sorted.some(s => s.is_gate);
    if (anyFailed(state) && !hasGates) {
      const failedStageIds = Object.entries(state.stages)
        .filter(([, s]) => s.status === 'failed')
        .map(([id]) => id);
      const details = failedStageIds.map(id => {
        const s = state.stages[id];
        return s?.error ? `${id} (${s.error})` : id;
      }).join(', ');
      state.status = 'failed';
      state.failureReason = `Stage(s) failed: ${details}`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      writeCampaignEntry(projectDir, state);
      recordRunEvent(projectDir, runId, {
        type: 'run_completed',
        runId,
        timestamp: state.completedAt,
        iteration,
        detail: state.status,
      });
      log.info({ runId, iteration, failedStageIds }, 'Stage failed with no gates — run failed');
      return state;
    }

    // Max iterations reached
    if (iteration === maxIterations) {
      state.status = 'failed';
      state.failureReason = `Max iterations reached (${maxIterations}). Gates did not pass after ${maxIterations} attempt(s).`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      writeCampaignEntry(projectDir, state);
      recordRunEvent(projectDir, runId, {
        type: 'run_completed',
        runId,
        timestamp: state.completedAt,
        iteration,
        detail: state.status,
      });
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
  finalState.failureReason = 'Workflow ended unexpectedly.';
  finalState.completedAt = new Date().toISOString();
  writeRunState(projectDir, runId, finalState);
  writeCampaignEntry(projectDir, finalState);
  recordRunEvent(projectDir, runId, {
    type: 'run_completed',
    runId,
    timestamp: finalState.completedAt,
    iteration: finalState.currentIteration,
    detail: finalState.status,
  });
  return finalState;
}

/** Re-sync run.json stage entries from individual status.json files after parallel execution. */
function syncStageStatuses(projectDir: string, runId: string, stageIds: string[]): void {
  const state = readRunState(projectDir, runId);
  for (const sid of stageIds) {
    try { state.stages[sid] = readStageStatus(projectDir, runId, sid); } catch { /* keep existing */ }
  }
  writeRunState(projectDir, runId, state);
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
  innerRetry?: number,
  fixStageIds?: string[],
  availableSkills?: string,
): Promise<void> {
  if (!agents.has(stage.role)) {
    const agentPath = join(resolvedAgentsDir, `${stage.role}.yaml`);
    if (!existsSync(agentPath)) throw new Error(`No agent config for role "${stage.role}"`);
    const raw = parseYaml(readFileSync(agentPath, 'utf-8'));
    agents.set(stage.role, applyBasePrompt(parseAgent(raw, projectDir), loadBasePrompt(resolvedAgentsDir)));
  }
  const agent = agents.get(stage.role)!;
  const timeout = stage.timeout_ms ?? state.timeoutMs ?? workflow.defaults.timeout_ms ?? loadDefaults(projectDir).timeout_ms;
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);

  let resolvedPrompt = stage.prompt_template || '';
  if (!resolvedPrompt) resolvedPrompt = taskDescription ?? '';

  // Inject inner retry context so the agent knows this is a repeated attempt
  if (innerRetry !== undefined) {
    if (stage.is_gate) {
      const fixOutputRefs = (fixStageIds ?? []).map(id => `- ${runDirPath}/stages/${id}/output.md`).join('\n');
      const fixContext = fixOutputRefs ? `\nFix stage output(s) to review:\n${fixOutputRefs}\n` : '';
      const prevGateRef = `\nYour previous evaluation output: ${runDirPath}/stages/${stage.id}/output.md — read it to see what you already tested and avoid duplicating those tests.\n`;
      resolvedPrompt = `RE-EVALUATION (round ${innerRetry + 1}): A fix was applied since the last evaluation. Write NEW and DIFFERENT tests targeting the fix — do not simply re-run the original tests.${fixContext}${prevGateRef}\n${resolvedPrompt}`;
    } else if (innerRetry > 0) {
      // Build references to the gate verdicts and outputs that triggered this retry
      const gateRefs = (stage.retry_to ?? []).map(gid =>
        `- Verdict: ${runDirPath}/verdict_${gid}.json\n- QA output: ${runDirPath}/stages/${gid}/output.md`
      ).join('\n');
      const gateContext = gateRefs ? `\nRead the latest gate results first:\n${gateRefs}\n` : '';
      resolvedPrompt = `RETRY FIX (attempt ${innerRetry + 1}): Previous fix attempt did not resolve all issues.${gateContext}\nRead your previous output at ${runDirPath}/stages/${stage.id}/output.md to see what you already tried. Try a DIFFERENT approach — do not repeat the same fix.\n\n${resolvedPrompt}`;
    }
  }

  // Knowledge Graph context: inject summary for dispatched stages
  try {
    const kgSummary = summarizeKG(readKG(projectDir, runId));
    if (kgSummary) resolvedPrompt = kgSummary + '\n\n' + resolvedPrompt;
  } catch { /* no KG yet */ }

  if (stage.is_gate) resolvedPrompt = appendGateMetricInstruction(resolvedPrompt, runDirPath, stage.id);

  let availableRoles: string | undefined;
  if (stage.dynamic_dispatch) {
    availableRoles = [...roleRegistry.entries()].map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
  }

  const maxTechnicalRetries = Math.max(0, Math.floor(Number(stage.max_retries ?? workflow.defaults.max_retries ?? loadDefaults(projectDir).stage_technical_retries)));
  let retries = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    state.stages[stage.id] = { status: 'running', retries, startedAt: new Date().toISOString() };
    writeStageStatus(projectDir, runId, stage.id, state.stages[stage.id]);
    writeRunState(projectDir, runId, state);

    const result = await runStage(adapter, {
      stageId: stage.id,
      role: agent,
      dependsOn: stage.depends_on ?? [],
      promptTemplate: retries > 0
        ? `RETRY (attempt ${retries + 1}): Previous attempt timed out after ${Math.ceil(timeout / 1000)}s. Read partial output at ${runDirPath}/stages/${stage.id}/output.md and continue from where you left off. Do not start over.\n\n${resolvedPrompt}`
        : resolvedPrompt,
      timeout_ms: timeout,
      projectDir,
      runId,
      runDir: runDirPath,
      retries,
      skills,
      stageSkills: stage.skills,
      availableRoles,
      availableSkills,
      taskDescription: taskDescription || state.taskDescription,
      isGate: stage.is_gate,
    });

    if (result.timedOut && retries < maxTechnicalRetries) {
      retries++;
      log.warn({ stage: stage.id, retry: retries }, 'Retrying timed-out stage (inner loop)');
      continue;
    }

    break;
  }

  // Stage status is already written to individual status.json by runStage/worker.
  // Record the outcome event using the authoritative per-stage file.
  try {
    const stageStatus = readStageStatus(projectDir, runId, stage.id);
    recordStageOutcome(projectDir, runId, stage.id, state.currentIteration, stageStatus);
    // Record trace event for stage completion
    try {
      appendTraceEvent(projectDir, runId, stage.id, {
        timestamp: new Date().toISOString(),
        stageId: stage.id,
        type: 'llm_call',
        inputSummary: `Stage ${stage.id} (${stage.role})`,
        outputSummary: `Completed in ${Math.round((stageStatus.duration_ms ?? 0) / 1000)}s`,
        tokensIn: stageStatus.tokens_in,
        tokensOut: stageStatus.tokens_out,
        durationMs: stageStatus.duration_ms ?? 0,
      });
    } catch { /* non-fatal */ }
  } catch { /* status file missing — should not happen */ }

  // After stage completion, check for KG updates
  try {
    readKG(state.projectDir, state.runId);
  } catch { /* no KG yet, that's fine */ }
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
  availableSkills?: string,
): Promise<StoreState> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let state = readRunState(projectDir, runId);

    // Exit if run was cancelled or failed externally
    if (state.status === 'failed' || state.status === 'complete') {
      return state;
    }

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
            const dispatchPath = join(projectDir, '.fc', 'runs', runId, 'dispatch.yaml');
            const dispatchExists = existsSync(dispatchPath);
            let reason: string;
            if (dispatchExists) {
              // Diagnose why all stages were rejected
              let detail = '';
              try {
                const raw = parseYaml(readFileSync(dispatchPath, 'utf-8'));
                const items = Array.isArray(raw) ? raw : (raw?.stages ?? []);
                const unknownRoles = (items as Record<string, unknown>[])
                  .filter(i => i?.role && !roleRegistry.has(i.role as string))
                  .map(i => `"${i.role}"`)
                  .filter((v, idx, arr) => arr.indexOf(v) === idx);
                if (unknownRoles.length > 0) {
                  detail = ` Unknown role(s): ${unknownRoles.join(', ')}. Available: ${[...roleRegistry.keys()].join(', ')}.`;
                }
              } catch { /* best effort */ }
              reason = `Planner wrote dispatch.yaml but it contained no valid stages.${detail} Go back to discussion to clarify the task.`;
            } else {
              reason = 'Planner did not produce an execution plan (dispatch.yaml). Go back to discussion to clarify the task.';
            }
            log.error({ stage: stage.id }, reason);
            state.status = 'failed';
            state.failureReason = reason;
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
      // Auto-approve on iteration 2+ (re-plans) when autoApproveRetries is not explicitly false.
      // First iteration always requires manual approval so the user can review the plan,
      // unless autoApprove is explicitly true (API-created autonomous tasks).
      const currentIter = state.currentIteration ?? 1;
      if ((currentIter > 1 && state.autoApproveRetries !== false) || state.autoApprove === true) {
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
    const stageEvents: Array<{ stageId: string; status: StageStatus }> = [];
    for (const stage of ready) {
      if (stage.condition) {
        const met = evaluateCondition(stage.condition, projectDir, runId);
        if (!met) {
          const skipped: StageStatus = { status: 'skipped', retries: 0 };
          writeStageStatus(projectDir, runId, stage.id, skipped);
          state.stages[stage.id] = skipped;
          writeRunState(projectDir, runId, state);
          recordStageOutcome(projectDir, runId, stage.id, state.currentIteration, skipped);
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
        recordStageOutcome(projectDir, runId, stage.id, state.currentIteration, skipped);
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
        agents.set(stage.role, applyBasePrompt(parseAgent(raw, projectDir), loadBasePrompt(resolvedAgentsDir)));
      }
      const agent = agents.get(stage.role)!;
      const timeout = stage.timeout_ms ?? state.timeoutMs ?? workflow.defaults.timeout_ms ?? loadDefaults(projectDir).timeout_ms;
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
        const campaignStorageKey = resolveCampaignStorageKey({
          campaignId: state.campaignId,
          campaignStorageKey: state.campaignStorageKey,
          campaignName: state.campaignName,
        });
        if (campaignStorageKey) {
          const entries = readCampaignEntries(projectDir, campaignStorageKey);
          if (entries.length > 0) {
            const scoredEntries = collapseEntriesForHealth(entries);
            const rows = scoredEntries
              .map(e => `| ${e.seq} | ${e.iteration ?? 1} | ${e.score ?? '-'} | ${e.metric ?? '-'} | ${e.gate ?? '-'} | ${e.pass ? 'pass' : 'fail'} |`)
              .join('\n');
            const best = scoredEntries.reduce((max, e) => typeof e.score === 'number' && e.score > max ? e.score : max, -Infinity);
            const phaseProgress = summarizeCampaignPhaseProgress(entries);
            let ctx = `=== CAMPAIGN: ${state.campaignName ?? state.campaignId} ===\n`;
            if (rows) {
              ctx += `| # | Iteration | Score | Metric | Gate | Status |\n|---|-----------|-------|--------|------|--------|\n${rows}\n\nBest ever: ${best}\n`;
            }
            if (phaseProgress.entries.length > 0) {
              ctx += `\nPhase progress:\n`;
              ctx += `- Completed phases: ${phaseProgress.completedPhases.length > 0 ? phaseProgress.completedPhases.join(', ') : 'none'}\n`;
              ctx += `- Current recommended phase: ${phaseProgress.currentPhase ?? 'not specified'}\n`;
              if (phaseProgress.latest) {
                ctx += `- Latest phase event: seq ${phaseProgress.latest.seq}, iteration ${phaseProgress.latest.iteration ?? 1}, phase ${phaseProgress.latest.phase ?? '-'}, phaseComplete ${phaseProgress.latest.phaseComplete === true ? 'true' : 'false'}, nextPhase ${phaseProgress.latest.nextPhase ?? '-'}, outcome ${phaseProgress.latest.outcome ?? '-'}\n`;
                if (phaseProgress.latest.artifactSummary) ctx += `- Latest artifact summary: ${phaseProgress.latest.artifactSummary}\n`;
                if (phaseProgress.latest.reason) ctx += `- Latest reason: ${phaseProgress.latest.reason}\n`;
              }
              ctx += `Planner rule: for multi-phase tasks, dispatch only the current recommended phase unless the task explicitly asks to restart from phase 0. Do not pack all future phases into one dispatch.\n`;
            }
            const summaryPaths: string[] = [];
            for (const e of entries) {
              const prevRunDir = join(projectDir, '.fc', 'runs', e.runId);
              const iterLog = join(prevRunDir, 'iteration_log.md');
              if (existsSync(iterLog) && !summaryPaths.includes(iterLog)) summaryPaths.push(iterLog);
            }
            if (summaryPaths.length > 0) {
              ctx += `\nPrevious run summaries:\n${summaryPaths.map(p => `- ${p}`).join('\n')}\n`;
            }
            const triggers = state.campaignTriggers;
            const alert = checkCampaignHealth(entries, triggers);
            if (alert) {
              ctx += `\n⚠️ CAMPAIGN ALERT: ${alert.type} — ${alert.message}\nDO NOT retry approaches from failed runs. Propose a fundamentally different approach.\n`;
            }
            ctx += `=== END CAMPAIGN ===\n\n`;
            resolvedPrompt = ctx + resolvedPrompt;
          }
        }
      }

      // Pivot context: inject into planner prompt when research injection is active
      if (state.researchInjection && (stage.depends_on ?? []).length === 0) {
        resolvedPrompt = `⚠️ PIVOT REQUIRED: The previous approach failed. Campaign health detected: ${state.researchInjection.alertType}. ${state.researchInjection.message}. You MUST plan a research stage to explore new directions before attempting implementation. Check dead_end nodes in the knowledge graph to understand what has been tried and failed.\n\n` + resolvedPrompt;
      }

      // Knowledge Graph context: inject summary for ALL roles
      try {
        const kgSummary = summarizeKG(readKG(projectDir, runId));
        if (kgSummary) resolvedPrompt = kgSummary + '\n\n' + resolvedPrompt;
      } catch { /* no KG yet */ }

      // Prepend timeout retry context if this is a retry after timeout
      if (currentRetries > 0) {
        const timeoutSec = Math.ceil(timeout / 1000);
        resolvedPrompt = `RETRY (attempt ${currentRetries + 1}): Previous attempt timed out after ${timeoutSec}s. Read partial output at ${runDirPath}/stages/${stage.id}/output.md and continue from where you left off. Do not start over.\n\n${resolvedPrompt}`;
      }

      if (stage.is_gate) resolvedPrompt = appendGateMetricInstruction(resolvedPrompt, runDirPath, stage.id);

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
        availableSkills,
        taskDescription: taskDescription || state.taskDescription,
        isGate: stage.is_gate,
      });
      return { stage, result, currentRetries };
    }));

    state = readRunState(projectDir, runId);
    let failed = false;

    for (const { stage, result, currentRetries } of results) {
      const maxRetries = Math.max(0, Math.floor(Number(stage.max_retries ?? workflow.defaults.max_retries ?? loadDefaults(projectDir).stage_technical_retries)));

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
        stageEvents.push({ stageId: stage.id, status: state.stages[stage.id] });
        continue;
      }

      state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
      stageEvents.push({ stageId: stage.id, status: state.stages[stage.id] });
      log.info({ stage: stage.id }, 'Stage complete');
    }

    writeRunState(projectDir, runId, state);
    for (const event of stageEvents) {
      recordStageOutcome(projectDir, runId, event.stageId, state.currentIteration, event.status);
    }

    if (failed) {
      // Don't set run status to failed here — let the iteration loop handle it
      return state;
    }
  }
}
