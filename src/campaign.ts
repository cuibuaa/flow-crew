import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { bumpVersion, ensureBriefDir, readHead } from './brief-versioning.js';
import type { BriefVersionInfo } from './brief-versioning.js';
import {
  atomicWrite,
  campaignDir,
  isTerminalRunStatus,
  requireKnownRunStatus,
  runDir,
  RUN_STATUS,
  runsRoot,
  updateRunState,
} from './store.js';
import { loadAdapterByName } from './adapters/loader.js';
import { appendPendingReview } from './campaign-review.js';
import { findSimilar, persistCampaignArc } from './cross-campaign-kg.js';
import { readEscalations } from './supervisor-escalation.js';
import { DaemonUnavailableError, defaultSocketPath, sendRpc } from './orchestrator-rpc.js';
import type { CancellationResult } from './run-control.js';
import { Orchestrator } from './orchestrator.js';
import {
  canDeriveBriefAdmission,
  createBriefAdmission,
  inspectBrief,
  verifyBriefAdmission,
} from './brief-preflight.js';
import type { BriefAdmissionRecord } from './brief-preflight.js';
import { inspectBriefOutputs } from './ship-inputs.js';
import { projectBriefPreflightContext, rehearseBriefIsolated } from './rehearse.js';
import type { IsolatedRehearsalResult } from './rehearse.js';
import {
  CAMPAIGN_SUCCESSOR_STATUS,
  createFrozenCampaignContract,
  deriveCampaignSuccessor,
  verifyFrozenCampaignContract,
} from './campaign-successor.js';
import type {
  CampaignDeclinedItem,
  CampaignMetricSeries,
  CampaignProgressEvidence,
  CampaignSuccessorDerived,
  CampaignSuccessorGuidance,
  CampaignSuccessorInput,
  CampaignTerminalEvidence,
  CampaignCriterionEvidence,
  FrozenCampaignContract,
} from './campaign-successor.js';
import type { TaskCreateInput, TaskEntry } from './task-registry.js';
import { parseGuidanceLedger } from './guidance.js';

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
  closedLoop?: {
    goalText: string;
    yardstick: {
      text: string;
      metricId: string;
      direction: 'increase' | 'decrease';
      unit: string;
      evaluationConstruction: string;
    };
    noProgress: {
      metricId: string;
      direction: 'increase' | 'decrease';
      rounds: number;
      tolerance: number;
    };
    /** Run-relative, framework/project-produced typed evidence. */
    evidenceFile: string;
    /** Optional admission sidecar for an initial brief with consequential warnings. */
    parentAdmissionPath?: string;
  };
}

export interface CampaignSuccessorEvidence {
  terminal: CampaignTerminalEvidence;
  guidance?: CampaignSuccessorGuidance[];
  operatorGuidance?: CampaignSuccessorGuidance[];
  declinedItems?: CampaignDeclinedItem[];
  criteria?: CampaignCriterionEvidence[];
  criterion?: CampaignCriterionEvidence;
  metricSeries: CampaignMetricSeries | CampaignMetricSeries[];
  campaignProgress?: CampaignProgressEvidence;
}

export interface CampaignSuccessorRuntime {
  /** Complete, immutable campaign contract. Legacy campaigns omit this runtime and remain manual. */
  contract: FrozenCampaignContract;
  /** Admission of the exact initial/current predecessor brief. */
  parentAdmission: BriefAdmissionRecord;
  collectEvidence(input: {
    campaignId: string;
    iteration: number;
    runId: string;
    runDir: string;
    predecessorBrief: string;
    outcome: Readonly<RunOutcome>;
  }): Promise<CampaignSuccessorEvidence> | CampaignSuccessorEvidence;
  registerAndLaunch?: CampaignSuccessorRegistration;
  rehearse?: (brief: string, options: { projectDir: string; label: string }) => Promise<IsolatedRehearsalResult>;
}

export interface CampaignRunOptions {
  dryRun?: boolean;
  successor?: CampaignSuccessorRuntime;
}

export type CampaignSuccessorRegistration = (task: TaskCreateInput) => Promise<TaskEntry>;

export type CampaignSuccessorAdvanceResult =
  | {
      status: 'launched';
      derivation: CampaignSuccessorDerived;
      briefVersion: string;
      admission: BriefAdmissionRecord;
      rehearsal: IsolatedRehearsalResult;
      task: TaskEntry;
    }
  | {
      status: 'escalated';
      reason: string;
      derivationStatus?: 'escalated' | 'not_applicable';
      rehearsal?: IsolatedRehearsalResult;
    }
  | {
      status: 'not_applicable';
      reason: string;
    };

export interface AdvanceCampaignSuccessorInput {
  campaignId: string;
  projectDir: string;
  campaignStateDir: string;
  briefDir: string;
  predecessorBrief: string;
  parentAdmission: BriefAdmissionRecord;
  contract: FrozenCampaignContract;
  evidence: CampaignSuccessorEvidence;
  registerAndLaunch?: CampaignSuccessorRegistration;
  rehearse?: CampaignSuccessorRuntime['rehearse'];
  now?: string;
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
  | { status: 'goal_met'; iter: number; outcome: RunOutcome }
  | { status: 'successor_launched'; iter: number; runId: string; briefVersion: string }
  | { status: 'escalated'; iter: number; reason: string }
  | { status: 'awaiting_review'; iter: number; ctx: DiagnosisContext }
  | { status: 'stuck'; iter: number; ctx: DiagnosisContext }
  | { status: 'budget_exhausted'; iter: number }
  | { status: 'stopped'; iter: number };

export interface RunOutcome {
  runId: string;
  status?: string;
  result?: number;
  decision?: any;
  journal?: any;
  state?: any;
}

const CAMPAIGN_OUTCOME_STATUS = {
  SHIPPED: RUN_STATUS.SHIPPED,
  COMPLETE: RUN_STATUS.COMPLETE,
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
  closedLoop: z.object({
    goalText: z.string().min(1),
    yardstick: z.object({
      text: z.string().min(1),
      metricId: z.string().min(1),
      direction: z.enum(['increase', 'decrease']),
      unit: z.string().min(1),
      evaluationConstruction: z.string().min(1),
    }),
    noProgress: z.object({
      metricId: z.string().min(1),
      direction: z.enum(['increase', 'decrease']),
      rounds: z.number().int().positive(),
      tolerance: z.number().nonnegative(),
    }),
    evidenceFile: z.string().min(1).refine((value) => {
      const normalized = value.replace(/\\/g, '/');
      return !isAbsolute(value) && normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../');
    }, { message: 'closedLoop.evidenceFile must stay within the run directory' }),
    parentAdmissionPath: z.string().min(1).optional(),
  }).optional(),
}).refine((cfg) => cfg.briefPath || cfg.briefDir, { message: 'Either briefPath or briefDir is required' })
  .refine((cfg) => !cfg.closedLoop || cfg.closedLoop.yardstick.metricId === cfg.goal.metric, {
    message: 'closedLoop.yardstick.metricId must equal goal.metric',
  })
  .refine((cfg) => !cfg.closedLoop
    || (cfg.closedLoop.noProgress.metricId === cfg.closedLoop.yardstick.metricId
      && cfg.closedLoop.noProgress.direction === cfg.closedLoop.yardstick.direction), {
    message: 'closedLoop.noProgress must govern the frozen yardstick metric and direction',
  });

const CampaignCriterionEvidenceSchema = z.object({
  id: z.string().min(1),
  text: z.string().optional(),
  metricId: z.string().min(1),
  unit: z.string().min(1),
  normalizedUnit: z.string().min(1).optional(),
  passed: z.array(z.boolean()).optional(),
  verdicts: z.array(z.object({
    status: z.enum(['pass', 'judgement', 'fail']),
    source: z.string().optional(),
  })).optional(),
  neverFailed: z.boolean().optional(),
});

const CampaignMetricSeriesSchema = z.object({
  metricId: z.string().min(1),
  criterionId: z.string().min(1).optional(),
  unit: z.string().min(1),
  normalizedUnit: z.string().min(1).optional(),
  values: z.array(z.number().finite()).min(2),
  source: z.string().optional(),
  stagnation: z.object({
    rounds: z.number().int().min(2),
    tolerance: z.number().nonnegative(),
    direction: z.enum(['increase', 'decrease']),
  }).optional(),
});

const CampaignSuccessorEvidenceArtifactSchema = z.object({
  version: z.literal(1),
  criteria: z.array(CampaignCriterionEvidenceSchema).optional(),
  criterion: CampaignCriterionEvidenceSchema.optional(),
  metricSeries: z.union([CampaignMetricSeriesSchema, z.array(CampaignMetricSeriesSchema).min(1)]),
  declinedItems: z.array(z.object({
    id: z.string().optional(),
    source: z.string().min(1),
    reason: z.string().optional(),
    detail: z.string().optional(),
    sourceAnchor: z.string().optional(),
    stageId: z.string().optional(),
  })).default([]),
  campaignProgress: z.object({
    usedRuns: z.number().int().nonnegative().optional(),
    observedAt: z.string().optional(),
    yardstickValues: z.array(z.number().finite()).optional(),
  }).optional(),
}).refine((value) => (value.criteria?.length ?? 0) > 0 || value.criterion !== undefined, {
  message: 'successor evidence must include criterion history',
});

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
    ...(cfg.closedLoop ? {
      closedLoop: {
        ...cfg.closedLoop,
        ...(cfg.closedLoop.parentAdmissionPath
          ? { parentAdmissionPath: normalizePath(cfg.closedLoop.parentAdmissionPath, projectDir) }
          : {}),
      },
    } : {}),
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
    const status = state
      ? requireKnownRunStatus(state.status, `score campaign run ${runId}`)
      : undefined;
    if (state && status && isTerminalStatus(status)) {
      const dir = runDir(cfg.projectDir, runId);
      const decision = readJsonIfExists(join(dir, 'research_decision.json'));
      const journal = readJsonIfExists(join(dir, 'research_journal.json'));
      const metricValue = Number(state?.[cfg.goal.metric] ?? decision?.[cfg.goal.metric] ?? decision?.runningBest ?? decision?.result);
      return {
        runId,
        status,
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

function resultMeetsCampaignGoal(outcome: RunOutcome, goal: CampaignConfig['goal']): boolean {
  if (typeof outcome.result !== 'number') return false;
  const [min, max] = goal.validRange;
  return outcome.result >= min && outcome.result <= max;
}

function isValidShip(outcome: RunOutcome, goal: CampaignConfig['goal']): boolean {
  if (outcome.status !== CAMPAIGN_OUTCOME_STATUS.SHIPPED && outcome.status !== CAMPAIGN_OUTCOME_STATUS.VALID_SHIP) return false;
  return resultMeetsCampaignGoal(outcome, goal);
}

function isCampaignGoalMet(outcome: RunOutcome, goal: CampaignConfig['goal']): boolean {
  if (outcome.status !== CAMPAIGN_OUTCOME_STATUS.COMPLETE
      && outcome.status !== CAMPAIGN_OUTCOME_STATUS.SHIPPED
      && outcome.status !== CAMPAIGN_OUTCOME_STATUS.VALID_SHIP) return false;
  return resultMeetsCampaignGoal(outcome, goal);
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

function readCampaignGuidanceHistory(runPath: string): CampaignSuccessorGuidance[] {
  const candidates: string[] = [];
  const historyDir = join(runPath, 'guidance_history');
  if (existsSync(historyDir)) {
    for (const name of readdirSync(historyDir).filter((value) => value.endsWith('.md')).sort()) {
      candidates.push(join(historyDir, name));
    }
  }
  const current = join(runPath, 'supervisor_guidance.md');
  if (existsSync(current)) candidates.push(current);
  const byId = new Map<string, CampaignSuccessorGuidance>();
  for (const path of candidates) {
    const ledger = readFileSync(path, 'utf-8');
    const envelopes = parseGuidanceLedger(ledger);
    if (ledger.trim() && envelopes.length === 0) {
      throw new Error(`guidance ledger has no valid attributable envelopes: ${path}`);
    }
    for (const envelope of envelopes) {
      const prior = byId.get(envelope.id);
      if (prior && (prior.body ?? prior.text) !== envelope.body) {
        throw new Error(`guidance id ${envelope.id} has conflicting durable bodies`);
      }
      if (prior) continue;
      byId.set(envelope.id, {
        ...envelope,
        addressed: true,
        sourceAnchor: path,
      });
    }
  }
  return [...byId.values()];
}

/** Build the adapter-independent filesystem evidence provider for configured campaigns. */
export function createConfiguredCampaignSuccessorRuntime(
  cfg: CampaignConfig,
  sourceBrief: string,
  startedAt: string,
): CampaignSuccessorRuntime | undefined {
  const closed = cfg.closedLoop;
  if (!closed) return undefined;
  const contract = createFrozenCampaignContract({
    campaignId: cfg.id,
    createdAt: startedAt,
    sourceBrief,
    goalText: closed.goalText,
    yardstickText: closed.yardstick.text,
    yardstick: {
      metricId: closed.yardstick.metricId,
      direction: closed.yardstick.direction,
      unit: closed.yardstick.unit,
      evaluationConstruction: closed.yardstick.evaluationConstruction,
    },
    budget: {
      maxRuns: cfg.budget.maxRuns,
      usedRuns: 0,
      ...(cfg.budget.maxWallHours === undefined ? {} : { maxWallMs: cfg.budget.maxWallHours * 3_600_000 }),
      startedAt,
    },
    noProgress: { ...closed.noProgress },
  });
  const parentReport = inspectBrief(sourceBrief, projectBriefPreflightContext(cfg.projectDir, sourceBrief));
  let parentAdmission: BriefAdmissionRecord | undefined;
  if (closed.parentAdmissionPath) {
    try {
      parentAdmission = JSON.parse(readFileSync(closed.parentAdmissionPath, 'utf-8')) as BriefAdmissionRecord;
    } catch (error) {
      throw new Error(`Closed-loop parent admission is unreadable: ${closed.parentAdmissionPath}`, { cause: error });
    }
  } else if (!parentReport.requiresAcknowledgement) {
    parentAdmission = createBriefAdmission(parentReport, { kind: 'not_required' });
  }
  if (!parentAdmission) {
    throw new Error(`Closed-loop campaign brief ${parentReport.digest} requires a configured parent admission`);
  }
  const parentVerification = verifyBriefAdmission(
    sourceBrief,
    parentAdmission,
    projectBriefPreflightContext(cfg.projectDir, sourceBrief),
  );
  if (parentVerification.status !== 'valid') {
    throw new Error(`Closed-loop parent admission is ${parentVerification.status}`);
  }
  return {
    contract,
    parentAdmission,
    collectEvidence({ runId, runDir: runPath, outcome }) {
      const terminalPath = join(runPath, 'run.json');
      let terminalBytes: string;
      try {
        terminalBytes = readFileSync(terminalPath, 'utf-8');
      } catch (error) {
        throw new Error(`Terminal run artifact is unreadable: ${terminalPath}`, { cause: error });
      }
      const terminalState = JSON.parse(terminalBytes) as { status?: unknown };
      if (typeof terminalState.status !== 'string') throw new Error('Terminal run artifact has no status');
      const evidencePath = join(runPath, closed.evidenceFile);
      let artifact: z.infer<typeof CampaignSuccessorEvidenceArtifactSchema>;
      try {
        artifact = CampaignSuccessorEvidenceArtifactSchema.parse(JSON.parse(readFileSync(evidencePath, 'utf-8')));
      } catch (error) {
        throw new Error(`Typed campaign successor evidence is unavailable or invalid: ${evidencePath}`, { cause: error });
      }
      return {
        terminal: {
          status: terminalState.status,
          goalMet: isCampaignGoalMet(outcome, cfg.goal),
          artifactId: `${runId}/run.json`,
          artifactBytes: terminalBytes,
          sourceAnchor: terminalPath,
        },
        guidance: readCampaignGuidanceHistory(runPath),
        declinedItems: artifact.declinedItems,
        ...(artifact.criteria ? { criteria: artifact.criteria } : {}),
        ...(artifact.criterion ? { criterion: artifact.criterion } : {}),
        metricSeries: artifact.metricSeries,
        ...(artifact.campaignProgress ? { campaignProgress: artifact.campaignProgress } : {}),
      };
    },
  };
}

function frozenContractPath(stateDir: string): string {
  return join(stateDir, 'campaign_contract.json');
}

/**
 * Persist the campaign's goal, yardstick, and budgets once. A later invocation may
 * re-read the identical contract, but cannot reinterpret or replace it.
 */
export function ensureFrozenCampaignContract(
  stateDir: string,
  contract: FrozenCampaignContract,
  sourceBrief: string,
): FrozenCampaignContract {
  const problems = verifyFrozenCampaignContract(contract);
  if (problems.length > 0) throw new Error(`Invalid frozen campaign contract: ${problems.join('; ')}`);
  const sourceDigest = inspectBrief(sourceBrief).digest;
  if (contract.sourceBriefDigest !== sourceDigest) {
    throw new Error(`Frozen campaign source digest mismatch: expected ${contract.sourceBriefDigest}, received ${sourceDigest}`);
  }
  if (!sourceBrief.includes(contract.goal.text)) {
    throw new Error('Frozen campaign goal is not an exact slice of the admitted source brief');
  }
  if (!sourceBrief.includes(contract.yardstick.text)) {
    throw new Error('Frozen campaign yardstick is not an exact slice of the admitted source brief');
  }
  mkdirSync(stateDir, { recursive: true });
  const path = frozenContractPath(stateDir);
  if (existsSync(path)) {
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (error) {
      throw new Error(`Frozen campaign contract is unreadable: ${path}`, { cause: error });
    }
    if (!isDeepStrictEqual(existing, contract)) {
      throw new Error('Frozen campaign contract drifted after campaign start');
    }
    return existing as FrozenCampaignContract;
  }
  atomicWrite(path, `${JSON.stringify(contract, null, 2)}\n`);
  return contract;
}

function recordSuccessorEscalation(
  stateDir: string,
  reason: string,
  details: Record<string, unknown> = {},
): void {
  mkdirSync(stateDir, { recursive: true });
  atomicWrite(join(stateDir, 'successor_escalation.json'), `${JSON.stringify({
    version: 1,
    reason,
    ...details,
  }, null, 2)}\n`);
}

async function ordinarySuccessorRegistration(task: TaskCreateInput): Promise<TaskEntry> {
  return new Orchestrator().register(task);
}

/**
 * Execute every gate between pure derivation and launch. Registration is deliberately
 * last, after the exact successor bytes have passed project-aware preflight, output
 * inventory, isolated rehearsal, and derived admission.
 */
export async function advanceCampaignSuccessor(
  input: AdvanceCampaignSuccessorInput,
): Promise<CampaignSuccessorAdvanceResult> {
  const strictContractProblems = verifyFrozenCampaignContract(input.contract);
  if (strictContractProblems.length > 0) {
    const reason = `frozen campaign contract is invalid: ${strictContractProblems.join('; ')}`;
    recordSuccessorEscalation(input.campaignStateDir, reason);
    return { status: 'escalated', reason };
  }
  if (!input.evidence.terminal.artifactBytes) {
    const reason = 'live successor launch requires byte-backed terminal evidence';
    recordSuccessorEscalation(input.campaignStateDir, reason);
    return { status: 'escalated', reason };
  }
  if (input.evidence.terminal.status === RUN_STATUS.STOPPED) {
    const reason = 'a stopped run is replay-only and cannot launch an autonomous successor';
    recordSuccessorEscalation(input.campaignStateDir, reason);
    return { status: 'escalated', reason };
  }

  const derivationInput: CampaignSuccessorInput = {
    campaignContract: input.contract,
    predecessorBrief: input.predecessorBrief,
    ...input.evidence,
  };
  const derivation = deriveCampaignSuccessor(derivationInput);
  if (derivation.status === 'not_applicable') return derivation;
  if (derivation.status === CAMPAIGN_SUCCESSOR_STATUS.ESCALATED) {
    recordSuccessorEscalation(input.campaignStateDir, derivation.reason, {
      ambiguities: derivation.ambiguities,
      terminalEvidence: derivation.terminalEvidence,
    });
    return { status: 'escalated', reason: derivation.reason, derivationStatus: 'escalated' };
  }

  const head = readHead(input.briefDir);
  if (readFileSync(head.path, 'utf-8') !== input.predecessorBrief) {
    const reason = 'brief HEAD changed between successor evidence collection and admission';
    recordSuccessorEscalation(input.campaignStateDir, reason, { expectedVersion: head.version });
    return { status: 'escalated', reason };
  }
  const context = projectBriefPreflightContext(input.projectDir, input.predecessorBrief);
  const parentVerification = verifyBriefAdmission(input.predecessorBrief, input.parentAdmission, context);
  if (parentVerification.status !== 'valid') {
    const reason = `predecessor brief admission is ${parentVerification.status}`;
    recordSuccessorEscalation(input.campaignStateDir, reason, { digest: parentVerification.report.digest });
    return { status: 'escalated', reason };
  }
  const childContext = projectBriefPreflightContext(input.projectDir, derivation.successorBrief);
  const childReport = inspectBrief(derivation.successorBrief, childContext);
  if (!childReport.contractReady) {
    const reason = 'derived successor failed brief preflight';
    recordSuccessorEscalation(input.campaignStateDir, reason, {
      digest: childReport.digest,
      failures: childReport.findings.filter((finding) => finding.level === 'fail'),
    });
    return { status: 'escalated', reason };
  }
  const inventory = inspectBriefOutputs(derivation.successorBrief, input.projectDir);
  if (inventory.blocking.length > 0) {
    const reason = `derived successor has ${inventory.blocking.length} blocking output path(s)`;
    recordSuccessorEscalation(input.campaignStateDir, reason, { blocking: inventory.blocking });
    return { status: 'escalated', reason };
  }
  if (!canDeriveBriefAdmission(input.parentAdmission, parentVerification.report, childReport)) {
    const reason = 'derived successor introduced a new consequential finding or degraded contract readiness';
    recordSuccessorEscalation(input.campaignStateDir, reason, { digest: childReport.digest });
    return { status: 'escalated', reason };
  }

  const rehearsal = await (input.rehearse ?? rehearseBriefIsolated)(derivation.successorBrief, {
    projectDir: input.projectDir,
    label: `campaign:${input.campaignId}:successor`,
  });
  if (rehearsal.exitCode !== 0 || !rehearsal.simulated) {
    const reason = 'derived successor failed isolated scheduler rehearsal';
    recordSuccessorEscalation(input.campaignStateDir, reason, { rehearsal });
    return { status: 'escalated', reason, rehearsal };
  }

  const admission = createBriefAdmission(childReport, {
    kind: 'derived',
    source: 'campaign_loop',
    at: input.now ?? new Date().toISOString(),
    parentDigest: parentVerification.report.digest,
    transformation: 'outer_loop_directive_v1',
  });
  const childVerification = verifyBriefAdmission(derivation.successorBrief, admission, childContext);
  if (childVerification.status !== 'valid') {
    const reason = `derived successor admission did not verify (${childVerification.status})`;
    recordSuccessorEscalation(input.campaignStateDir, reason, { digest: childReport.digest });
    return { status: 'escalated', reason };
  }

  const next = bumpVersion(
    input.briefDir,
    derivation.successorBrief,
    `closed-loop successor for campaign ${input.campaignId}`,
  );
  const evidenceDir = join(input.campaignStateDir, 'successors', next.version);
  mkdirSync(evidenceDir, { recursive: true });
  atomicWrite(join(evidenceDir, 'structured_diff.json'), `${JSON.stringify(derivation.structuredDiff, null, 2)}\n`);
  atomicWrite(join(evidenceDir, 'successor.diff'), derivation.unifiedDiff);
  atomicWrite(join(evidenceDir, 'rehearsal.json'), `${JSON.stringify(rehearsal, null, 2)}\n`);
  atomicWrite(join(evidenceDir, 'brief_admission.json'), `${JSON.stringify(admission, null, 2)}\n`);

  const register = input.registerAndLaunch ?? ordinarySuccessorRegistration;
  let task: TaskEntry;
  try {
    task = await register({
      kind: 'quick',
      name: `${input.campaignId} successor ${next.version}`,
      brief_text: derivation.successorBrief,
      brief_admission: admission,
      projectDir: input.projectDir,
      notes: `Closed-loop successor of ${head.version}; evidence ${evidenceDir}`,
      launch_args: ['--workflow', 'research', '--campaign', input.campaignId, '--campaign-context=skip'],
    });
  } catch (error) {
    const reason = `ordinary successor registration failed: ${error instanceof Error ? error.message : String(error)}`;
    recordSuccessorEscalation(input.campaignStateDir, reason, {
      briefVersion: next.version,
      admissionDigest: admission.digest,
    });
    return { status: 'escalated', reason, rehearsal };
  }
  atomicWrite(join(evidenceDir, 'launch.json'), `${JSON.stringify({
    version: 1,
    taskId: task.id,
    runId: task.run_id,
    status: task.status,
    briefVersion: next.version,
    admissionDigest: admission.digest,
  }, null, 2)}\n`);
  return {
    status: 'launched',
    derivation,
    briefVersion: next.version,
    admission,
    rehearsal,
    task,
  };
}

export async function runCampaign(cfg: CampaignConfig, opts: CampaignRunOptions = {}): Promise<CampaignResult> {
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
  const initialBriefBytes = readFileSync(initialBrief.path, 'utf-8');
  const campaignStartedAt = new Date().toISOString();
  let successorRuntime: CampaignSuccessorRuntime | undefined;
  try {
    successorRuntime = opts.successor
      ?? createConfiguredCampaignSuccessorRuntime(cfg, initialBriefBytes, campaignStartedAt);
    if (successorRuntime) {
      ensureFrozenCampaignContract(dir, successorRuntime.contract, initialBriefBytes);
    }
  } catch (error) {
    const reason = `closed-loop campaign initialization failed: ${error instanceof Error ? error.message : String(error)}`;
    recordSuccessorEscalation(dir, reason);
    writeSummary(dir, 'escalated', { iter: 0, reason });
    writeCampaignState(dir, 'escalated', cfg, { iter: 0, reason, startedAt: campaignStartedAt });
    return { status: 'escalated', iter: 0, reason };
  }
  let successorAdmission = successorRuntime?.parentAdmission;
  let queuedSuccessor: { runId: string; systemdUnit: string } | undefined;
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
  const campaignYardstickValues: number[] = [];
  const aggregatedRejections: Record<string, number> = {};
  let lastDiagnosis: Record<string, unknown> | undefined;
  let lastAppliedPatch: (BriefPatch & { brief_version_before?: string; brief_version_after?: string }) | undefined;

  const persistArcForTermination = (kind: 'valid_ship' | 'goal_met' | 'stuck' | 'budget_exhausted', iter: number, data: { result?: number; ctx?: DiagnosisContext } = {}) => {
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
    const activeSystemdUnit = queuedSuccessor?.systemdUnit ?? cfg.launch.systemdUnit;
    writeFileSync(join(dir, 'active.json'), JSON.stringify({ id: cfg.id, iter, systemdUnit: activeSystemdUnit, briefVersion: head.version, briefDir, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf-8');
    const runId = queuedSuccessor?.runId ?? await launchRun(cfg);
    queuedSuccessor = undefined;
    writeFileSync(join(dir, 'active.json'), JSON.stringify({
      id: cfg.id,
      iter,
      runId,
      systemdUnit: activeSystemdUnit,
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
    if (typeof outcome.result === 'number' && Number.isFinite(outcome.result)) {
      campaignYardstickValues.push(outcome.result);
    }
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

    if (isCampaignGoalMet(outcome, cfg.goal)) {
      writeSummary(dir, 'goal_met', { iter, outcome });
      writeCampaignState(dir, 'goal_met', cfg, { iter, outcome });
      persistArcForTermination('goal_met', iter, { result: outcome.result });
      return { status: 'goal_met', iter, outcome };
    }

    if (successorRuntime && successorAdmission) {
      if (typeof outcome.result !== 'number' || !Number.isFinite(outcome.result)) {
        const reason = `closed-loop yardstick ${successorRuntime.contract.yardstick.metricId} is absent from terminal run ${runId}`;
        recordSuccessorEscalation(dir, reason, { runId, iter });
        appendJsonl(logPath, { iter, successor: 'escalated', reason });
        writeSummary(dir, 'escalated', { iter, reason });
        writeCampaignState(dir, 'escalated', cfg, { iter, reason });
        return { status: 'escalated', iter, reason };
      }
      const predecessorBrief = readFileSync(head.path, 'utf-8');
      let evidence: CampaignSuccessorEvidence;
      try {
        evidence = await successorRuntime.collectEvidence({
          campaignId: cfg.id,
          iteration: iter,
          runId,
          runDir: runDir(cfg.projectDir, runId),
          predecessorBrief,
          outcome,
        });
      } catch (error) {
        const reason = `closed-loop evidence collection failed: ${error instanceof Error ? error.message : String(error)}`;
        recordSuccessorEscalation(dir, reason, { runId, iter });
        appendJsonl(logPath, { iter, successor: 'escalated', reason });
        writeSummary(dir, 'escalated', { iter, reason });
        writeCampaignState(dir, 'escalated', cfg, { iter, reason });
        return { status: 'escalated', iter, reason };
      }
      const advanced = await advanceCampaignSuccessor({
        campaignId: cfg.id,
        projectDir: cfg.projectDir,
        campaignStateDir: dir,
        briefDir,
        predecessorBrief,
        parentAdmission: successorAdmission,
        contract: successorRuntime.contract,
        evidence: {
          ...evidence,
          campaignProgress: {
            ...evidence.campaignProgress,
            // Budget clocks and the yardstick history are engine-owned. Typed run
            // evidence can add criterion measurements, but cannot under-count runs,
            // backdate the wall clock, or redefine campaign-level no progress.
            usedRuns: iter,
            observedAt: new Date().toISOString(),
            yardstickValues: [...campaignYardstickValues],
          },
        },
        registerAndLaunch: successorRuntime.registerAndLaunch,
        rehearse: successorRuntime.rehearse,
      });
      appendJsonl(logPath, {
        iter,
        successor: advanced.status,
        ...(advanced.status === 'launched'
          ? { briefVersion: advanced.briefVersion, taskId: advanced.task.id, successorRunId: advanced.task.run_id }
          : { reason: advanced.reason }),
      });
      if (advanced.status === 'launched') {
        if (!advanced.task.run_id) {
          const reason = `successor task ${advanced.task.id} was registered without a run binding`;
          recordSuccessorEscalation(dir, reason, { taskId: advanced.task.id, briefVersion: advanced.briefVersion });
          writeSummary(dir, 'escalated', { iter, reason });
          writeCampaignState(dir, 'escalated', cfg, { iter, reason });
          return { status: 'escalated', iter, reason };
        }
        successorAdmission = advanced.admission;
        queuedSuccessor = { runId: advanced.task.run_id, systemdUnit: advanced.task.systemd_unit };
        continue;
      }
      if (advanced.status === CAMPAIGN_SUCCESSOR_STATUS.ESCALATED) {
        writeSummary(dir, 'escalated', { iter, reason: advanced.reason });
        writeCampaignState(dir, 'escalated', cfg, { iter, reason: advanced.reason });
        return { status: 'escalated', iter, reason: advanced.reason };
      }
      // A non-eligible terminal status retains the legacy/manual diagnosis path below.
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
