import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { bumpVersion, ensureBriefDir, readHead } from './brief-versioning.js';
import type { BriefVersionInfo } from './brief-versioning.js';
import { campaignDir, runDir, runsRoot, updateRunState, isTerminalRunStatus, RUN_STATUS } from './store.js';
import { loadAdapterByName } from './adapters/loader.js';
import { appendPendingReview } from './campaign-review.js';
import { findSimilar, persistCampaignArc } from './cross-campaign-kg.js';
import { readEscalations } from './supervisor-escalation.js';
import { DaemonUnavailableError, defaultSocketPath, sendRpc } from './orchestrator-rpc.js';
import type { CancellationResult } from './run-control.js';
import { Orchestrator } from './orchestrator.js';

export interface CampaignConfig {
  id: string;
  briefPath?: string;
  briefDir?: string;
  projectDir: string;
  goal: { metric: string; validRange: [number, number] };
  budget: { maxRuns: number; maxWallHours?: number };
  diagnosisRules: DiagnosisRule[];
  stop?: string[];
  launch: {
    systemdUnit: string;
    launchScript: string;
  };
}

export interface DiagnosisRule {
  mode?: 'rule' | 'llm';
  signal?: string;
  supervisor?: string;
  promptTemplate?: string;
  action?: BriefPatch | 'llm_generated';
  approval?: 'auto' | 'human';
}

export interface BriefPatch {
  type: 'brief_patch';
  section: string;
  op: 'append' | 'replace_value' | 'edit';
  value: string;
}

export interface DiagnosisContext {
  rejections: Record<string, number>;
  decision: any;
  journal: any;
  noImprovementRuns: number;
  iteration: number;
  campaignId?: string;
  projectDir?: string;
  briefDir?: string;
  brief?: string;
  briefVersion?: string;
  runId?: string;
  journalSummary?: string;
  awaitingReview?: boolean;
}

export type CampaignResult =
  | { status: 'dry_run'; iter: 0; plan: Record<string, unknown> }
  | { status: 'shipped'; iter: number; outcome: RunOutcome }
  | { status: 'awaiting_review'; iter: number; ctx: DiagnosisContext }
  | { status: 'stuck'; iter: number; ctx: DiagnosisContext }
  | { status: 'budget_exhausted'; iter: number }
  | { status: 'stopped'; iter: number };

interface RunOutcome {
  runId: string;
  status?: string;
  result?: number;
  decision?: any;
  journal?: any;
  state?: any;
}

const CAMPAIGN_OUTCOME_STATUS = {
  SHIPPED: RUN_STATUS.SHIPPED,
  VALID_SHIP: 'valid_ship',
} as const;

export const BriefPatchSchema = z.object({
  type: z.literal('brief_patch'),
  section: z.string().min(1),
  op: z.enum(['append', 'replace_value', 'edit']),
  value: z.string(),
});

const CampaignConfigSchema = z.object({
  id: z.string().min(1),
  briefPath: z.string().min(1).optional(),
  briefDir: z.string().min(1).optional(),
  projectDir: z.string().min(1),
  goal: z.object({
    metric: z.string().min(1),
    validRange: z.tuple([z.number(), z.number()]),
  }),
  budget: z.object({
    maxRuns: z.number().int().positive(),
    maxWallHours: z.number().positive().optional(),
  }),
  diagnosisRules: z.array(z.object({
    mode: z.enum(['rule', 'llm']).optional(),
    signal: z.string().min(1).optional(),
    supervisor: z.string().min(1).optional(),
    promptTemplate: z.string().min(1).optional(),
    action: z.union([BriefPatchSchema, z.literal('llm_generated')]).optional(),
    approval: z.enum(['auto', 'human']).optional(),
  }).refine((rule) => rule.mode === 'llm' || !!rule.signal, { message: 'Rule-mode diagnosis rules require signal' })
    .refine((rule) => rule.mode === 'llm' || !!rule.action, { message: 'Rule-mode diagnosis rules require action' })),
  stop: z.array(z.string()).optional(),
  launch: z.object({
    systemdUnit: z.string().min(1),
    launchScript: z.string().min(1),
  }),
}).refine((cfg) => cfg.briefPath || cfg.briefDir, { message: 'Either briefPath or briefDir is required' });

function normalizePath(value: string, baseDir: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

export async function loadCampaignConfig(path: string): Promise<CampaignConfig> {
  if (!existsSync(path)) {
    throw new Error(`Campaign config not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as unknown;
  const candidate = parsed && typeof parsed === 'object' && 'campaign' in parsed
    ? (parsed as { campaign: unknown }).campaign
    : parsed;
  const cfg = CampaignConfigSchema.parse(candidate);
  const projectDir = resolve(cfg.projectDir);
  return {
    ...cfg,
    projectDir,
    briefPath: cfg.briefPath ? normalizePath(cfg.briefPath, projectDir) : undefined,
    briefDir: cfg.briefDir ? normalizePath(cfg.briefDir, projectDir) : undefined,
    launch: {
      ...cfg.launch,
      launchScript: normalizePath(cfg.launch.launchScript, projectDir),
    },
  };
}

function isUnsafeExpression(expr: string): boolean {
  const blocked = /\b(?:constructor|prototype|__proto__|globalThis|global|process|Function|eval|import|require|module|exports|this|new|class|while|for|async|await|return)\b/;
  if (blocked.test(expr)) return true;
  if (/[A-Za-z0-9_$]\s*\(/.test(expr)) return true;
  if (/(^|[^<>=!])=([^=]|$)/.test(expr)) return true;
  return !/^[A-Za-z0-9_.$\s<>=!&|()+\-*/%,[\]]+$/.test(expr);
}

function evalSignal(expr: string, context: DiagnosisContext): boolean {
  if (isUnsafeExpression(expr)) {
    throw new Error(`Unsafe diagnosis expression rejected: ${expr}`);
  }
  const fn = new Function(
    'rejections',
    'decision',
    'journal',
    'noImprovementRuns',
    'iteration',
    `"use strict"; return Boolean(${expr});`,
  );
  return Boolean(fn(
    context.rejections,
    context.decision,
    context.journal,
    context.noImprovementRuns,
    context.iteration,
  ));
}

function stringifyPromptValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? {}, null, 2);
}

function renderTemplate(template: string, context: DiagnosisContext): string {
  const values: Record<string, string> = {
    rejections: stringifyPromptValue(context.rejections),
    decision: stringifyPromptValue(context.decision),
    journal: stringifyPromptValue(context.journal),
    journal_summary: context.journalSummary ?? stringifyPromptValue(context.journal),
    brief: context.brief ?? '',
    briefVersion: context.briefVersion ?? '',
  };
  return template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_match, key: string) => values[key] ?? '');
}

function defaultPromptTemplatePath(): string {
  return resolve(import.meta.dirname, '..', 'docs', 'framework_campaign', 'llm_diagnosis_prompt_default.md');
}

function extractJsonObject(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate.trim()) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function parseLlmPatch(output: string): { patch: BriefPatch; reason: string } | null {
  const parsed = extractJsonObject(output);
  if (!parsed || typeof parsed !== 'object') return null;
  const data = parsed as Record<string, unknown>;
  const candidate = data.patch && typeof data.patch === 'object'
    ? data.patch
    : { type: 'brief_patch', section: data.section, op: data.op, value: data.value };
  const patch = BriefPatchSchema.safeParse(candidate);
  if (!patch.success) return null;
  return {
    patch: patch.data,
    reason: typeof data.reason === 'string' && data.reason.trim() ? data.reason : 'LLM diagnosis proposed brief patch',
  };
}

async function evaluateLlmDiagnosis(rule: DiagnosisRule, context: DiagnosisContext): Promise<BriefPatch | null> {
  const campaignId = context.campaignId;
  const projectDir = context.projectDir ?? process.cwd();
  const templatePath = rule.promptTemplate
    ? (isAbsolute(rule.promptTemplate) ? rule.promptTemplate : resolve(projectDir, rule.promptTemplate))
    : defaultPromptTemplatePath();
  const template = readFileSync(templatePath, 'utf-8');
  const prompt = renderTemplate(template, context);
  const adapter = await loadAdapterByName(rule.supervisor ?? 'codex');
  const llmDir = campaignId
    ? join(campaignDir(campaignId), 'llm-diagnosis', `iter-${context.iteration}`)
    : join(projectDir, '.fc', 'llm-diagnosis', `iter-${context.iteration}`);
  mkdirSync(llmDir, { recursive: true });
  const result = await adapter.run(prompt, {
    name: 'llm-diagnosis',
    description: 'Campaign diagnosis supervisor',
    model: 'default',
    reasoning_effort: 'default',
    tools: [],
    prompt,
    adapter: rule.supervisor,
  }, {
    timeout_ms: 300000,
    workDir: projectDir,
    runDir: llmDir,
    stageId: 'llm_diagnosis',
  });
  if (result.exitCode !== 0) {
    console.warn(`LLM diagnosis adapter exited ${result.exitCode}`);
    return null;
  }
  const proposed = parseLlmPatch(result.output);
  if (!proposed) {
    console.warn('LLM diagnosis returned malformed brief patch JSON');
    return null;
  }
  const approval = rule.approval ?? 'human';
  if (approval === 'auto') return proposed.patch;
  if (!campaignId) {
    console.warn('LLM diagnosis requested human approval without campaignId');
    return null;
  }
  appendPendingReview(campaignId, {
    reason: proposed.reason,
    severity: 'medium',
    patch: proposed.patch,
    source: `llm:${rule.supervisor ?? 'codex'}`,
    briefDir: context.briefDir,
    briefVersion: context.briefVersion,
    rule: rule.promptTemplate ?? 'llm',
    runId: context.runId,
  });
  context.awaitingReview = true;
  return null;
}

export async function evaluateDiagnosis(rules: DiagnosisRule[], context: DiagnosisContext): Promise<BriefPatch | null> {
  for (const rule of rules) {
    if ((rule.mode ?? 'rule') === 'llm') continue;
    if (!rule.signal || !rule.action || rule.action === 'llm_generated') continue;
    if (evalSignal(rule.signal, context)) return rule.action;
  }
  const llmRule = rules.find((rule) => rule.mode === 'llm');
  if (llmRule) return evaluateLlmDiagnosis(llmRule, context);
  return null;
}

function resolveBriefDir(cfg: CampaignConfig): string {
  if (cfg.briefDir) return cfg.briefDir;
  if (!cfg.briefPath) throw new Error('Campaign config requires briefDir or briefPath');
  return join(dirname(cfg.briefPath), '.brief-versions');
}

function ensureCampaignBrief(cfg: CampaignConfig): BriefVersionInfo {
  const briefDir = resolveBriefDir(cfg);
  if (cfg.briefDir) return ensureBriefDir(briefDir);
  if (!cfg.briefPath) return ensureBriefDir(briefDir);
  return ensureBriefDir(briefDir, readFileSync(cfg.briefPath, 'utf-8'));
}

function findSection(lines: string[], section: string): { start: number; end: number; level: number } {
  const target = section.trim();
  const start = lines.findIndex((line) => line.trim() === target);
  if (start < 0) throw new Error(`Section not found: ${section}`);
  const match = /^(#{1,6})\s+/.exec(lines[start]);
  if (!match) throw new Error(`Section is not a markdown header: ${section}`);
  const level = match[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const next = /^(#{1,6})\s+/.exec(lines[i]);
    if (next && next[1].length <= level) {
      end = i;
      break;
    }
  }
  return { start, end, level };
}

function replaceSectionRange(content: string, section: string, mutate: (lines: string[], start: number, end: number) => string[]): string {
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();
  const { start, end } = findSection(lines, section);
  const nextLines = mutate(lines, start, end);
  return nextLines.join('\n') + (hasTrailingNewline ? '\n' : '');
}

export function applyPatchToText(content: string, patch: BriefPatch): string {
  return replaceSectionRange(content, patch.section, (lines, start, end) => {
    const next = [...lines];
    if (patch.op === 'append') {
      const insert = patch.value.split(/\r?\n/);
      const prefix = end > start + 1 && next[end - 1].trim() !== '' ? [''] : [];
      const suffix = end < next.length && insert[insert.length - 1]?.trim() !== '' ? [''] : [];
      next.splice(end, 0, ...prefix, ...insert, ...suffix);
      return next;
    }

    if (patch.op === 'replace_value') {
      const sectionLines = next.slice(start + 1, end);
      const preferred = sectionLines.findIndex((line) => {
        const trimmed = line.trim();
        return trimmed !== '' && !trimmed.startsWith('#') && (trimmed.includes('[') || trimmed.includes(':') || trimmed.includes('='));
      });
      const fallback = sectionLines.findIndex((line) => line.trim() !== '' && !line.trim().startsWith('#'));
      const localIndex = preferred >= 0 ? preferred : fallback;
      if (localIndex < 0) throw new Error(`No replaceable value found in section: ${patch.section}`);
      next[start + 1 + localIndex] = patch.value;
      return next;
    }

    const arrow = /\s->\s/.exec(patch.value);
    if (!arrow) throw new Error(`Edit patch must use "old -> new": ${patch.value}`);
    const oldValue = patch.value.slice(0, arrow.index);
    const newValue = patch.value.slice(arrow.index + arrow[0].length);
    const sectionText = next.slice(start + 1, end).join('\n');
    if (!sectionText.includes(oldValue)) {
      throw new Error(`Edit target not found in section ${patch.section}: ${oldValue}`);
    }
    const replacement = sectionText.replace(oldValue, newValue).split('\n');
    next.splice(start + 1, end - start - 1, ...replacement);
    return next;
  });
}

export function applyVersionedPatch(
  briefDir: string,
  patch: BriefPatch,
  reason: string,
): BriefVersionInfo {
  const current = readHead(briefDir);
  const newContent = applyPatchToText(readFileSync(current.path, 'utf-8'), patch);
  return bumpVersion(briefDir, newContent, reason);
}

export function applyBriefPatch(briefPath: string, patch: BriefPatch): void {
  const updated = applyPatchToText(readFileSync(briefPath, 'utf-8'), patch);
  writeFileSync(briefPath, updated, 'utf-8');
}

function readJsonIfExists(path: string): any {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

function appendJsonl(path: string, entry: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n', { encoding: 'utf-8', flag: 'a' });
}

function writeSummary(dir: string, status: string, data: Record<string, unknown>): void {
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ status, timestamp: new Date().toISOString(), ...data }, null, 2) + '\n', 'utf-8');
}

function writeCampaignState(dir: string, status: string, cfg: CampaignConfig, data: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    id: cfg.id,
    status,
    projectDir: cfg.projectDir,
    briefPath: cfg.briefPath,
    briefDir: resolveBriefDir(cfg),
    goal: cfg.goal,
    budget: cfg.budget,
    launch: cfg.launch,
    updatedAt: new Date().toISOString(),
    ...data,
  }, null, 2) + '\n', 'utf-8');
}

function latestRunIdAfter(previous: Set<string>, projectDir: string): string | null {
  const root = runsRoot();
  if (!existsSync(root)) return null;
  const candidates = Array.from(new Set(readdirSync(root)));
  const fresh = candidates.filter((id) => {
    if (previous.has(id) || !existsSync(join(root, id, 'run.json'))) return false;
    const state = readJsonIfExists(join(root, id, 'run.json'));
    return state?.projectDir === projectDir;
  });
  fresh.sort((a, b) => {
    const aState = readJsonIfExists(join(root, a, 'run.json'));
    const bState = readJsonIfExists(join(root, b, 'run.json'));
    return String(bState?.startedAt ?? b).localeCompare(String(aState?.startedAt ?? a));
  });
  return fresh[0] ?? null;
}

async function launchRun(cfg: CampaignConfig): Promise<string> {
  mkdirSync(runsRoot(), { recursive: true });
  const before = new Set(readdirSync(runsRoot()).filter((id) => existsSync(join(runsRoot(), id, 'run.json'))));
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn('bash', [cfg.launch.launchScript], {
      cwd: cfg.projectDir,
      env: { ...process.env, FC_CAMPAIGN_ID: cfg.id },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Launch script exited ${code}: ${output.trim()}`));
      else resolveLaunch();
    });
  });
  const runId = latestRunIdAfter(before, cfg.projectDir);
  if (!runId) throw new Error('Launch script completed but no new FlowCrew run was found');
  return runId;
}

/**
 * Terminal per the ENGINE's single source of truth. This used to be an inverted
 * denylist (anything not pending/running/awaiting_approval), which silently
 * misread every newly-added status — e.g. a `parked` run waiting on a human
 * would be treated as finished and pollRunCompletion would fabricate an outcome
 * from an unfinished run.
 */
function isTerminalStatus(status?: string): boolean {
  return !!status && isTerminalRunStatus(status);
}

async function pollRunCompletion(cfg: CampaignConfig, runId: string): Promise<RunOutcome> {
  const started = Date.now();
  const maxMs = (cfg.budget.maxWallHours ?? 24) * 3600000;
  const statePath = join(runDir(cfg.projectDir, runId), 'run.json');
  while (Date.now() - started < maxMs) {
    const state = readJsonIfExists(statePath);
    if (state && isTerminalStatus(state.status)) {
      const dir = runDir(cfg.projectDir, runId);
      const decision = readJsonIfExists(join(dir, 'research_decision.json'));
      const journal = readJsonIfExists(join(dir, 'research_journal.json'));
      const metricValue = Number(state?.[cfg.goal.metric] ?? decision?.[cfg.goal.metric] ?? decision?.runningBest ?? decision?.result);
      return {
        runId,
        status: state.status,
        result: Number.isFinite(metricValue) ? metricValue : undefined,
        decision,
        journal,
        state,
      };
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 5000));
  }
  throw new Error(`Timed out waiting for run completion: ${runId}`);
}

function isValidShip(outcome: RunOutcome, goal: CampaignConfig['goal']): boolean {
  if (outcome.status !== CAMPAIGN_OUTCOME_STATUS.SHIPPED && outcome.status !== CAMPAIGN_OUTCOME_STATUS.VALID_SHIP) return false;
  if (typeof outcome.result !== 'number') return false;
  const [min, max] = goal.validRange;
  return outcome.result >= min && outcome.result <= max;
}

function readRejections(cfg: CampaignConfig, runId: string): Record<string, number> {
  const parsed = readJsonIfExists(join(runDir(cfg.projectDir, runId), 'research_integrity_rejections.json'));
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

function addCounts(target: Record<string, number>, counts: Record<string, number>): void {
  for (const [key, value] of Object.entries(counts)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function topRejection(counts: Record<string, number>): string | undefined {
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function samePatch(a: BriefPatch | 'llm_generated' | undefined, b: BriefPatch): boolean {
  return typeof a === 'object'
    && a.type === b.type
    && a.section === b.section
    && a.op === b.op
    && a.value === b.value;
}

function matchedRuleForPatch(rules: DiagnosisRule[], patch: BriefPatch): DiagnosisRule | undefined {
  return rules.find((rule) => samePatch(rule.action, patch));
}

export async function runCampaign(cfg: CampaignConfig, opts: { dryRun?: boolean } = {}): Promise<CampaignResult> {
  if (opts.dryRun) {
    const briefDir = resolveBriefDir(cfg);
    const plan = {
      id: cfg.id,
      projectDir: cfg.projectDir,
      briefPath: cfg.briefPath,
      briefDir,
      maxRuns: cfg.budget.maxRuns,
      maxWallHours: cfg.budget.maxWallHours,
      launch: cfg.launch,
      diagnosisRules: cfg.diagnosisRules.map((rule) => rule.mode === 'llm' ? `llm:${rule.supervisor ?? 'codex'}` : rule.signal),
    };
    console.log('Campaign dry run:');
    console.log(JSON.stringify(plan, null, 2));
    return { status: 'dry_run', iter: 0, plan };
  }

  const dir = campaignDir(cfg.id);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'iteration_log.jsonl');
  const initialBrief = ensureCampaignBrief(cfg);
  const briefDir = resolveBriefDir(cfg);
  const campaignStartedAt = new Date().toISOString();
  writeCampaignState(dir, 'running', cfg, { initialBriefVersion: initialBrief.version, startedAt: campaignStartedAt });
  const hints = findSimilar({
    campaignId: cfg.id,
    projectDir: cfg.projectDir,
    briefMetric: cfg.goal.metric,
  });
  if (hints.length > 0) {
    console.log(`[campaign:${cfg.id}] ${hints.length} similar past campaign(s) found; see ${join(dir, 'kg_hints.json')}`);
    writeFileSync(join(dir, 'kg_hints.json'), JSON.stringify(hints, null, 2) + '\n', 'utf-8');
  }
  let noImprovementRuns = 0;
  let lastResult: number | undefined;
  const aggregatedRejections: Record<string, number> = {};
  let lastDiagnosis: Record<string, unknown> | undefined;
  let lastAppliedPatch: (BriefPatch & { brief_version_before?: string; brief_version_after?: string }) | undefined;

  const persistArcForTermination = (kind: 'valid_ship' | 'stuck' | 'budget_exhausted', iter: number, data: { result?: number; ctx?: DiagnosisContext } = {}) => {
    const symptomKind = Object.keys(aggregatedRejections).length > 0
      ? 'rejection'
      : noImprovementRuns > 0
        ? 'no_improvement'
        : 'ceiling';
    persistCampaignArc({
      campaignId: cfg.id,
      symptom: {
        kind: symptomKind,
        counts: aggregatedRejections,
        iteration_at_detection: iter,
        projectDir: cfg.projectDir,
        briefMetric: cfg.goal.metric,
        campaignStartedAt,
      },
      diagnosis: lastDiagnosis ?? {
        rule_signal: 'none',
        approved_by: 'auto',
        reason: data.ctx?.awaitingReview ? 'Campaign awaiting human review' : `Campaign terminated as ${kind}`,
      },
      patch: lastAppliedPatch ? {
        section: lastAppliedPatch.section,
        op: lastAppliedPatch.op,
        value: lastAppliedPatch.value,
        brief_version_before: lastAppliedPatch.brief_version_before,
        brief_version_after: lastAppliedPatch.brief_version_after,
      } : undefined,
      outcome: {
        kind,
        result: data.result,
        iterations_used: iter,
        wall_time_min: Math.max(0, (Date.now() - Date.parse(campaignStartedAt)) / 60000),
      },
    });
  };

  for (let iter = 1; iter <= cfg.budget.maxRuns; iter++) {
    if (existsSync(join(dir, 'halt'))) {
      writeSummary(dir, 'stopped', { iter });
      writeCampaignState(dir, 'stopped', cfg, { iter });
      return { status: 'stopped', iter };
    }
    const head = readHead(briefDir);
    writeFileSync(join(dir, 'active.json'), JSON.stringify({ id: cfg.id, iter, systemdUnit: cfg.launch.systemdUnit, briefVersion: head.version, briefDir, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf-8');
    const runId = await launchRun(cfg);
    writeFileSync(join(dir, 'active.json'), JSON.stringify({
      id: cfg.id,
      iter,
      runId,
      systemdUnit: cfg.launch.systemdUnit,
      briefVersion: head.version,
      briefDir,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf-8');
    updateRunState(cfg.projectDir, runId, (state) => {
      state.campaign_id = cfg.id;
      state.brief_version = head.version;
      state.brief_dir = briefDir;
    });
    const outcome = await pollRunCompletion(cfg, runId);
    appendJsonl(logPath, { iter, runId, outcome });
    for (const escalation of readEscalations(runDir(cfg.projectDir, runId))) {
      if (!escalation.proposedPatch) continue;
      appendPendingReview(cfg.id, {
        reason: escalation.reason,
        severity: escalation.severity,
        patch: escalation.proposedPatch,
        source: 'supervisor_escalation',
        briefDir,
        briefVersion: head.version,
        runId,
      });
    }

    if (isValidShip(outcome, cfg.goal)) {
      writeSummary(dir, 'shipped', { iter, outcome });
      writeCampaignState(dir, 'shipped', cfg, { iter, outcome });
      persistArcForTermination('valid_ship', iter, { result: outcome.result });
      return { status: 'shipped', iter, outcome };
    }

    if (typeof outcome.result === 'number' && outcome.result === lastResult) noImprovementRuns++;
    else noImprovementRuns = 0;
    lastResult = outcome.result;

    const ctx: DiagnosisContext = {
      rejections: readRejections(cfg, runId),
      decision: outcome.decision ?? {},
      journal: outcome.journal ?? {},
      noImprovementRuns,
      iteration: iter,
      campaignId: cfg.id,
      projectDir: cfg.projectDir,
      briefDir,
      brief: readFileSync(head.path, 'utf-8'),
      briefVersion: head.version,
      runId,
    };
    addCounts(aggregatedRejections, ctx.rejections);
    const patch = await evaluateDiagnosis(cfg.diagnosisRules, ctx);
    if (!patch) {
      const status = ctx.awaitingReview ? 'awaiting_review' : 'stuck';
      writeSummary(dir, status, { iter, ctx });
      writeCampaignState(dir, status, cfg, { iter, briefVersion: head.version });
      if (!ctx.awaitingReview) persistArcForTermination('stuck', iter, { result: outcome.result, ctx });
      return ctx.awaitingReview ? { status: 'awaiting_review', iter, ctx } : { status: 'stuck', iter, ctx };
    }
    const matchedRule = matchedRuleForPatch(cfg.diagnosisRules, patch);
    lastDiagnosis = {
      rule_signal: matchedRule?.signal ?? 'llm_generated',
      llm_prompt_template: matchedRule?.mode === 'llm' ? matchedRule.promptTemplate ?? 'default' : undefined,
      approved_by: matchedRule?.approval ?? 'auto',
      reason: matchedRule?.signal
        ? `Rule matched: ${matchedRule.signal}`
        : `Patch selected for ${topRejection(ctx.rejections) ?? 'campaign diagnosis'}`,
    };
    const nextBrief = applyVersionedPatch(briefDir, patch, `campaign ${cfg.id} iteration ${iter}`);
    lastAppliedPatch = { ...patch, brief_version_before: head.version, brief_version_after: nextBrief.version };
    appendJsonl(logPath, { iter, patch, briefVersion: nextBrief.version, fromVersion: nextBrief.fromVersion });
  }

  writeSummary(campaignDir(cfg.id), 'budget_exhausted', { iter: cfg.budget.maxRuns, briefVersion: readHead(briefDir).version, initialBriefVersion: initialBrief.version });
  writeCampaignState(campaignDir(cfg.id), 'budget_exhausted', cfg, { iter: cfg.budget.maxRuns, briefVersion: readHead(briefDir).version, initialBriefVersion: initialBrief.version });
  persistArcForTermination('budget_exhausted', cfg.budget.maxRuns, { result: lastResult });
  return { status: 'budget_exhausted', iter: cfg.budget.maxRuns };
}

export async function stopCampaign(id: string): Promise<CancellationResult | undefined> {
  const dir = campaignDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'halt'), new Date().toISOString() + '\n', 'utf-8');
  const active = readJsonIfExists(join(dir, 'active.json'));
  const unit = typeof active?.systemdUnit === 'string' ? active.systemdUnit : undefined;
  const runId = typeof active?.runId === 'string' ? active.runId : undefined;
  if (!runId) {
    if (!unit) return undefined;
    throw new Error(`Campaign ${id}: stop recorded, but the active scheduler run is not bound yet; retry once its run id is visible.`);
  }
  let result: CancellationResult;
  try {
    result = await sendRpc<CancellationResult>(
      defaultSocketPath(),
      { cmd: 'cancel-run', runId, unit },
      5_000,
    );
  } catch (error) {
    if (!(error instanceof DaemonUnavailableError)) throw error;
    result = await new Orchestrator().cancelRun(runId, unit);
  }
  if (!result.ok) throw new Error(result.message);
  return result;
}
