import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadProjectDefaults } from './config.js';
import { readOperatorCriterionRulings, type GuidanceEnvelope } from './guidance.js';
import { STAGE_STATUS } from './store.js';

export interface StageAuthoredCheck {
  criterionId: string;
  path: string;
  authorStageId: string;
}

export interface CriterionCheckConflict extends StageAuthoredCheck {
  guidanceId: string;
  reason: string;
}

export interface GateControlValidation {
  violation?: string;
  conflicts: CriterionCheckConflict[];
}

interface DispatchStageShape {
  id?: unknown;
  depends_on?: unknown;
  criterion_refs?: unknown;
  is_gate?: unknown;
}

interface StageStatusShape {
  status?: unknown;
  writes?: unknown;
  artifacts?: unknown;
  writeAttribution?: unknown;
  timeout?: { budgetMs?: unknown };
  attempts?: Array<{
    index?: unknown;
    status?: unknown;
    writes?: unknown;
    timeout?: { budgetMs?: unknown };
  }>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readDispatchStages(runDir: string): DispatchStageShape[] {
  try {
    const parsed = parseYaml(readFileSync(join(runDir, 'dispatch.yaml'), 'utf-8')) as {
      stages?: unknown;
    };
    return Array.isArray(parsed?.stages) ? parsed.stages as DispatchStageShape[] : [];
  } catch {
    return [];
  }
}

function readStatus(runDir: string, stageId: string): StageStatusShape | undefined {
  try {
    return JSON.parse(readFileSync(join(runDir, 'stages', stageId, 'status.json'), 'utf-8')) as StageStatusShape;
  } catch {
    return undefined;
  }
}

function authoredCheckPath(path: string): boolean {
  const normalized = path.replace(/^run:/, '').replace(/\\/g, '/');
  if (path.startsWith('run:')) return false;
  return /(?:^|\/)(?:spec|tests?|checks?)(?:\/|$)/i.test(normalized)
    || /(?:^|\/)(?:verify|audit|check)[^/]*\.(?:[cm]?[jt]sx?|py|sh)$/i.test(normalized)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(normalized);
}

/** Check candidates are derived only from completed, attributed ancestor
 * writes that share an admitted criterion with the gate and an operator ruling. */
export function collectStageAuthoredChecks(
  runDir: string,
  gateStageId: string,
  criterionRefs: readonly string[],
): StageAuthoredCheck[] {
  const rulings = readOperatorCriterionRulings(runDir, criterionRefs);
  const ruledIds = new Set(rulings.flatMap((ruling) => ruling.criterionIds ?? []));
  if (ruledIds.size === 0) return [];
  const stages = readDispatchStages(runDir);
  const byId = new Map(stages
    .filter((stage): stage is DispatchStageShape & { id: string } => typeof stage.id === 'string')
    .map((stage) => [stage.id, stage]));
  const ancestors = new Set<string>();
  const visit = (id: string): void => {
    const stage = byId.get(id);
    for (const dependency of strings(stage?.depends_on)) {
      if (ancestors.has(dependency)) continue;
      ancestors.add(dependency);
      visit(dependency);
    }
  };
  visit(gateStageId);

  const candidates: StageAuthoredCheck[] = [];
  for (const authorStageId of ancestors) {
    const stage = byId.get(authorStageId);
    const refs = strings(stage?.criterion_refs).filter((id) => (
      criterionRefs.includes(id) && ruledIds.has(id)
    ));
    if (refs.length === 0) continue;
    const status = readStatus(runDir, authorStageId);
    if (status?.status !== STAGE_STATUS.COMPLETE
      || !['structured', 'snapshot'].includes(String(status.writeAttribution ?? ''))) continue;
    const writes = [...new Set([...strings(status.writes), ...strings(status.artifacts)])]
      .filter(authoredCheckPath);
    for (const criterionId of refs) {
      for (const path of writes) candidates.push({ criterionId, path, authorStageId });
    }
  }
  return candidates.sort((a, b) => (
    a.criterionId.localeCompare(b.criterionId)
    || a.authorStageId.localeCompare(b.authorStageId)
    || a.path.localeCompare(b.path)
  ));
}

export function renderCriterionRulings(
  runDir: string,
  criterionRefs: readonly string[],
): string {
  const rulings = readOperatorCriterionRulings(runDir, criterionRefs);
  if (rulings.length === 0) return '';
  return [
    '## Operator criterion rulings (binding reasoning context)',
    'These notes do not lower an explicit threshold or widen authority. Every later evaluation of a named criterion must account for them.',
    ...rulings.map((ruling) => [
      `- Guidance ${ruling.id}; criteria: ${(ruling.criterionIds ?? []).join(', ')}`,
      `  Exact note: ${JSON.stringify(ruling.body)}`,
    ].join('\n')),
  ].join('\n');
}

export function renderGateControlContract(input: {
  projectDir: string;
  runDir: string;
  gateStageId: string;
  criterionRefs: readonly string[];
}): string {
  const candidates = collectStageAuthoredChecks(input.runDir, input.gateStageId, input.criterionRefs);
  const recordedCosts = collectExplicitUnitCosts(input.projectDir, input.runDir);
  let defaultBudget = 'unknown';
  try { defaultBudget = String(loadProjectDefaults(input.projectDir).timeout_ms); } catch { /* explicit unknown */ }
  const recordedBudgets: string[] = [];
  try {
    for (const stageId of readdirSync(join(input.runDir, 'stages'))) {
      const status = readStatus(input.runDir, stageId);
      const attempts = status?.attempts ?? [];
      const latest = attempts.at(-1);
      const budget = latest?.timeout?.budgetMs ?? status?.timeout?.budgetMs;
      if (typeof budget === 'number' && Number.isFinite(budget)) recordedBudgets.push(`${stageId}=${budget}ms`);
    }
  } catch { /* no completed stage directory yet */ }
  return [
    '## Quantified-remedy feasibility contract',
    `Default stage budget: ${defaultBudget} ms. Recorded stage budgets: ${recordedBudgets.join(', ') || 'none'}.`,
    'If a rejecting reason or failed criterion prescribes a sample, block, or iteration quantity, add a matching remedyFeasibility entry.',
    'Known cost shape: {"criterionId":"...","targetStageId":"...","targetQuantity":10000,"unit":"blocks","cost":{"status":"known","unitCostMs":839,"costedQuantity":10000,"unit":"blocks","source":{"stageId":"measure","attemptIndex":1,"path":"docs/measurement.json","elapsedPath":"repair_measurement.measurement_summary.elapsed_seconds","quantityPath":"repair_measurement.measurement_summary.new_records","elapsedUnit":"seconds"}},"impliedWallTimeMs":8390000,"stageBudgetMs":3600000,"fitsStageBudget":false,"disposition":"infeasible","statement":"The 10000-block target implies 8390000ms and is infeasible within the 3600000ms stage budget."}. Put the same feasibility statement in the verdict reason or matching criterion evidence; do not leave an infeasible target as an imperative remedy.',
    'Unknown cost shape: use cost.status="unknown" with a non-empty reason, impliedWallTimeMs=null, fitsStageBudget=null, disposition="unknown", and a statement explicitly saying the cost is unknown. Do not invent unit conversions.',
    'A known source must be attributed to the named completed attempt. targetStageId must name an admitted run stage; an admitted stage with no attempt yet uses the project default budget. Arithmetic, budget, fit, and disposition are checked by the scheduler.',
    'The feasibility statement must include the computed implied wall-time value with a time unit, not only a qualitative feasible/infeasible conclusion.',
    recordedCosts.length > 0
      ? `Recorded attributable unit costs: ${recordedCosts.map((cost) => `${cost.stageId}/${cost.attemptIndex} ${cost.path}#${cost.unitCostPath} = ${cost.unitCostMs} ms/${cost.unit}`).join('; ')}.`
      : 'No explicit structured unit-cost field was discovered in completed-attempt JSON writes; use unknown only after checking the relevant artifacts.',
    candidates.length > 0
      ? [
          '## Stage-authored checks requiring ruling comparison',
          ...candidates.map((candidate) => `- [${candidate.criterionId}] ${candidate.path} (author stage ${candidate.authorStageId})`),
          'For each listed check, the matching criterion entry must include checkAssessments: [{"path":"...","authorStageId":"...","guidanceId":"...","status":"consistent"|"conflict"|"not_applicable","reason":"..."}]. A conflict is reported; the check does not silently decide the criterion.',
        ].join('\n')
      : '',
    'For each failed criterion covered by an operator ruling, include rulingTreatments: [{"guidanceId":"...","quote":"exact excerpt from the note","explanation":"why the ruling does not apply"}]. Omitting this makes the verdict an unreasoned rejection.',
  ].filter(Boolean).join('\n\n');
}

interface RemedyMention {
  criterionId?: string;
  targetQuantity: number;
  unit: 'samples' | 'blocks' | 'iterations';
  text: string;
}

function normalizeUnit(value: string): RemedyMention['unit'] | undefined {
  const unit = value.toLowerCase().replace(/s$/, '');
  if (unit === 'sample') return 'samples';
  if (unit === 'block') return 'blocks';
  if (unit === 'iteration') return 'iterations';
  return undefined;
}

function numeric(value: string): number | undefined {
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function remedyMentionsInText(text: string, criterionId?: string): RemedyMention[] {
  const found: RemedyMention[] = [];
  const add = (quantityText: string, unitText: string, source: string): void => {
    const targetQuantity = numeric(quantityText);
    const unit = normalizeUnit(unitText);
    if (!targetQuantity || !unit) return;
    found.push({ ...(criterionId ? { criterionId } : {}), targetQuantity, unit, text: source.trim() });
  };
  for (const sentence of text.split(/[.!?\n]+/)) {
    for (const match of sentence.matchAll(/\b(?:require(?:d|s)?|request(?:ed|s)?|must|need(?:ed|s)?|target(?:ed|s)?|reach(?:es|ed)?|increase(?:d)?|collect|measure|run)\b[^.!?\n]{0,120}?(\d[\d,]*(?:\.\d+)?)\s*(?:-|\s)?(samples?|blocks?|iterations?)\b/gi)) {
      add(match[1], match[2], sentence);
    }
    for (const match of sentence.matchAll(/\b(\d[\d,]*(?:\.\d+)?)\s*(?:-|\s)?(samples?|blocks?|iterations?)\b[^.!?\n]{0,60}\b(?:required|requested|needed|target|scale)\b/gi)) {
      add(match[1], match[2], sentence);
    }
    for (const match of sentence.matchAll(/\b(sample size|block count|iteration count)\b[^.!?\n]{0,60}?(\d[\d,]*(?:\.\d+)?)/gi)) {
      add(match[2], match[1].split(' ')[0], sentence);
    }
  }
  const seen = new Set<string>();
  return found.filter((mention) => {
    const key = `${mention.criterionId ?? ''}:${mention.targetQuantity}:${mention.unit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function quantifiedRemedies(verdict: Record<string, unknown>): RemedyMention[] {
  if (verdict.pass !== false) return [];
  const mentions = typeof verdict.reason === 'string'
    ? remedyMentionsInText(verdict.reason)
    : [];
  if (verdict.criteria && typeof verdict.criteria === 'object' && !Array.isArray(verdict.criteria)) {
    for (const [criterionId, raw] of Object.entries(verdict.criteria as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (String(entry.status).toLowerCase() !== 'fail' || typeof entry.evidence !== 'string') continue;
      mentions.push(...remedyMentionsInText(entry.evidence, criterionId));
    }
  }
  const seen = new Set<string>();
  return mentions.filter((mention) => {
    const key = `${mention.criterionId ?? ''}:${mention.targetQuantity}:${mention.unit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function valueAtArtifactPath(root: unknown, rawPath: string): unknown {
  const segments = rawPath.startsWith('/')
    ? rawPath.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    : rawPath.split('.');
  let current = root;
  for (const segment of segments) {
    if (!segment || !current || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length
        || !Object.prototype.hasOwnProperty.call(current, index)) return undefined;
      current = current[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function recordedUnitCostMs(
  artifactPath: string,
  source: Record<string, unknown>,
): { value?: number; unit?: RemedyMention['unit']; error?: string } {
  try {
    if (statSync(artifactPath).size > 1_000_000) {
      return { error: 'unit cost source exceeds the 1 MB structured-evidence limit' };
    }
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8')) as unknown;
    const unitCostPath = typeof source.unitCostPath === 'string' ? source.unitCostPath.trim() : '';
    const elapsedPath = typeof source.elapsedPath === 'string' ? source.elapsedPath.trim() : '';
    const quantityPath = typeof source.quantityPath === 'string' ? source.quantityPath.trim() : '';
    if (unitCostPath) {
      const recorded = Number(valueAtArtifactPath(artifact, unitCostPath));
      const costTimeUnit = source.unitCostUnit;
      const multiplier = costTimeUnit === 'seconds' ? 1_000 : costTimeUnit === 'ms' ? 1 : undefined;
      if (!Number.isFinite(recorded) || recorded <= 0 || multiplier === undefined) {
        return { error: 'unitCostPath must resolve to a positive number and unitCostUnit must be ms or seconds' };
      }
      const unitPath = typeof source.unitPath === 'string' ? source.unitPath.trim() : '';
      const recordedQuantityUnit = unitPath
        ? normalizeUnit(String(valueAtArtifactPath(artifact, unitPath) ?? ''))
        : undefined;
      if (unitPath && !recordedQuantityUnit) return { error: 'unitPath must resolve to samples, blocks, or iterations' };
      return {
        value: recorded * multiplier,
        ...(recordedQuantityUnit ? { unit: recordedQuantityUnit } : {}),
      };
    }
    if (elapsedPath && quantityPath) {
      const elapsed = Number(valueAtArtifactPath(artifact, elapsedPath));
      const quantity = Number(valueAtArtifactPath(artifact, quantityPath));
      const multiplier = source.elapsedUnit === 'seconds' ? 1_000 : source.elapsedUnit === 'ms' ? 1 : undefined;
      if (!Number.isFinite(elapsed) || elapsed <= 0 || !Number.isFinite(quantity) || quantity <= 0
        || multiplier === undefined) {
        return { error: 'elapsedPath/quantityPath must resolve to positive numbers and elapsedUnit must be ms or seconds' };
      }
      return { value: (elapsed * multiplier) / quantity };
    }
    return { error: 'known cost source needs unitCostPath/unitCostUnit or elapsedPath/quantityPath/elapsedUnit' };
  } catch (error) {
    return { error: `unit cost source is not readable structured JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

interface ExplicitUnitCostCandidate {
  stageId: string;
  attemptIndex: number;
  path: string;
  unit: RemedyMention['unit'];
  unitCostMs: number;
  unitCostPath: string;
}

function explicitUnitCostsInValue(
  value: unknown,
  prefix = '',
): Array<Pick<ExplicitUnitCostCandidate, 'unit' | 'unitCostMs' | 'unitCostPath'>> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((nested, index) => (
      explicitUnitCostsInValue(nested, prefix ? `${prefix}.${index}` : String(index))
    ));
  }
  const record = value as Record<string, unknown>;
  const unit = normalizeUnit(String(record.unit ?? record.units ?? ''));
  const milliseconds = Number(record.unitCostMs ?? record.unit_cost_ms);
  const seconds = Number(record.unitCostSeconds ?? record.unit_cost_seconds);
  const own: Array<Pick<ExplicitUnitCostCandidate, 'unit' | 'unitCostMs' | 'unitCostPath'>> = [];
  if (unit && Number.isFinite(milliseconds) && milliseconds > 0) {
    own.push({
      unit, unitCostMs: milliseconds,
      unitCostPath: prefix ? `${prefix}.${record.unitCostMs !== undefined ? 'unitCostMs' : 'unit_cost_ms'}` : record.unitCostMs !== undefined ? 'unitCostMs' : 'unit_cost_ms',
    });
  } else if (unit && Number.isFinite(seconds) && seconds > 0) {
    own.push({
      unit, unitCostMs: seconds * 1_000,
      unitCostPath: prefix ? `${prefix}.${record.unitCostSeconds !== undefined ? 'unitCostSeconds' : 'unit_cost_seconds'}` : record.unitCostSeconds !== undefined ? 'unitCostSeconds' : 'unit_cost_seconds',
    });
  }
  for (const [key, nested] of Object.entries(record)) {
    if (!nested || typeof nested !== 'object') continue;
    own.push(...explicitUnitCostsInValue(nested, prefix ? `${prefix}.${key}` : key));
  }
  return own;
}

function collectExplicitUnitCosts(projectDir: string, runDir: string): ExplicitUnitCostCandidate[] {
  const candidates: ExplicitUnitCostCandidate[] = [];
  let stageIds: string[];
  try { stageIds = readdirSync(join(runDir, 'stages')); } catch { return candidates; }
  for (const stageId of stageIds) {
    const status = readStatus(runDir, stageId);
    for (const attempt of status?.attempts ?? []) {
      if (attempt.status !== STAGE_STATUS.COMPLETE || !Number.isSafeInteger(attempt.index)) continue;
      for (const path of strings(attempt.writes)) {
        if (!/\.json$/i.test(path)) continue;
        const normalizedPath = normalizedEvidencePath(projectDir, runDir, path);
        if (!normalizedPath) continue;
        const absolutePath = path.startsWith('run:')
          ? join(runDir, path.slice(4))
          : join(projectDir, normalizedPath);
        try {
          if (statSync(absolutePath).size > 1_000_000) continue;
          const value = JSON.parse(readFileSync(absolutePath, 'utf-8')) as unknown;
          for (const cost of explicitUnitCostsInValue(value)) {
            candidates.push({
              stageId,
              attemptIndex: Number(attempt.index),
              path: normalizedPath,
              ...cost,
            });
          }
        } catch { /* malformed/nonexistent artifacts are not positive cost evidence */ }
      }
    }
  }
  return candidates;
}

function verdictNarrative(verdict: Record<string, unknown>, criterionId?: string): string {
  const parts = typeof verdict.reason === 'string' ? [verdict.reason] : [];
  const criteria = object(verdict.criteria);
  if (criterionId) {
    const evidence = object(criteria?.[criterionId])?.evidence;
    if (typeof evidence === 'string') parts.push(evidence);
  } else if (criteria) {
    for (const raw of Object.values(criteria)) {
      const evidence = object(raw)?.evidence;
      if (typeof evidence === 'string') parts.push(evidence);
    }
  }
  return parts.join('\n');
}

const STAGE_ID_PATTERN = /^[a-z][a-z0-9_]{0,19}$/;

function runNamesStage(runDir: string, stageId: string): boolean {
  if (!STAGE_ID_PATTERN.test(stageId)) return false;
  try {
    const state = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8')) as { stages?: unknown };
    const stages = object(state.stages);
    if (stages && Object.prototype.hasOwnProperty.call(stages, stageId)) return true;
  } catch { /* a recorded stage status remains valid legacy run evidence */ }
  return readStatus(runDir, stageId) !== undefined;
}

function resolveStageBudgetMs(projectDir: string, runDir: string, stageId: string): number | undefined {
  const status = readStatus(runDir, stageId);
  const budget = status?.attempts?.at(-1)?.timeout?.budgetMs ?? status?.timeout?.budgetMs;
  if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) return budget;
  try { return loadProjectDefaults(projectDir).timeout_ms; } catch { return undefined; }
}

function statementIncludesDurationMs(statement: string, expectedMs: number): boolean {
  const durations = statement.matchAll(/\b(\d[\d,]*(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h)\b/gi);
  for (const match of durations) {
    const numericText = match[1].replace(/,/g, '');
    const value = Number(numericText);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = match[2].toLowerCase();
    const multiplier = unit === 'ms' || unit.startsWith('millisecond') || unit.startsWith('msec')
      ? 1
      : unit === 's' || unit.startsWith('second') || unit.startsWith('sec')
        ? 1_000
        : unit.startsWith('minute') || unit.startsWith('min')
          ? 60_000
          : 3_600_000;
    const decimalPlaces = numericText.includes('.') ? numericText.split('.')[1].length : 0;
    const displayedPrecision = multiplier * 0.5 * (10 ** -decimalPlaces);
    const tolerance = Math.max(1, expectedMs * 1e-6, displayedPrecision);
    if (Math.abs((value * multiplier) - expectedMs) <= tolerance) return true;
  }
  return false;
}

function normalizedEvidencePath(projectDir: string, runDir: string, path: string): string | undefined {
  if (!path || path.includes('\0')) return undefined;
  const base = path.startsWith('run:') ? runDir : projectDir;
  const relativePath = path.startsWith('run:') ? path.slice(4) : path;
  const absolute = isAbsolute(relativePath) ? relativePath : join(base, relativePath);
  const rel = relative(base, absolute).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../')) return undefined;
  return path.startsWith('run:') ? `run:${rel}` : rel;
}

function validateRemedyFeasibility(
  projectDir: string,
  runDir: string,
  verdict: Record<string, unknown>,
): string | undefined {
  const mentions = quantifiedRemedies(verdict);
  if (mentions.length === 0) return undefined;
  if (!Array.isArray(verdict.remedyFeasibility)) {
    return `Gate remedy feasibility contract violation: quantified remedy has no remedyFeasibility entry (${mentions[0].text})`;
  }
  const entries = verdict.remedyFeasibility.map(object).filter((entry): entry is Record<string, unknown> => Boolean(entry));
  for (const mention of mentions) {
    const entry = entries.find((candidate) => (
      Number(candidate.targetQuantity) === mention.targetQuantity
      && normalizeUnit(String(candidate.unit ?? '')) === mention.unit
      && (!mention.criterionId || candidate.criterionId === mention.criterionId)
    ));
    if (!entry) {
      return `Gate remedy feasibility contract violation: no cost entry for ${mention.targetQuantity} ${mention.unit}${mention.criterionId ? ` on ${mention.criterionId}` : ''}`;
    }
    if (typeof entry.targetStageId !== 'string' || !entry.targetStageId.trim()) {
      return 'Gate remedy feasibility contract violation: targetStageId is required';
    }
    if (!runNamesStage(runDir, entry.targetStageId)) {
      return `Gate remedy feasibility contract violation: targetStageId ${entry.targetStageId} does not name an admitted stage`;
    }
    const cost = object(entry.cost);
    if (!cost || (cost.status !== 'known' && cost.status !== 'unknown')) {
      return 'Gate remedy feasibility contract violation: cost.status must be known or unknown';
    }
    const expectedBudget = resolveStageBudgetMs(projectDir, runDir, entry.targetStageId);
    if (!expectedBudget || Number(entry.stageBudgetMs) !== expectedBudget) {
      return `Gate remedy feasibility contract violation: ${entry.targetStageId} stageBudgetMs must equal ${expectedBudget ?? 'the recorded budget'}`;
    }
    const statement = typeof entry.statement === 'string' ? entry.statement.trim() : '';
    if (!statement || !verdictNarrative(verdict, mention.criterionId).includes(statement)) {
      return 'Gate remedy feasibility contract violation: the feasibility statement must appear in the verdict reason or matching criterion evidence';
    }
    if (cost.status === 'unknown') {
      const recorded = collectExplicitUnitCosts(projectDir, runDir)
        .find((candidate) => candidate.unit === mention.unit);
      if (recorded) {
        return `Gate remedy feasibility contract violation: cost cannot be unknown; completed attempt ${recorded.stageId}/${recorded.attemptIndex} recorded ${recorded.unitCostMs} ms/${recorded.unit} in ${recorded.path}#${recorded.unitCostPath}`;
      }
      if (typeof cost.reason !== 'string' || !cost.reason.trim()
        || entry.impliedWallTimeMs !== null
        || entry.fitsStageBudget !== null
        || entry.disposition !== 'unknown'
        || !/unknown/i.test(statement)) {
        return 'Gate remedy feasibility contract violation: unknown cost must state why, use null time/fit, and explicitly say cost is unknown';
      }
      continue;
    }

    const unitCostMs = Number(cost.unitCostMs);
    const costedQuantity = Number(cost.costedQuantity ?? entry.targetQuantity);
    const impliedWallTimeMs = Number(entry.impliedWallTimeMs);
    if (normalizeUnit(String(cost.unit ?? '')) !== mention.unit
      || costedQuantity !== mention.targetQuantity
      || !Number.isFinite(unitCostMs) || unitCostMs <= 0
      || !Number.isFinite(costedQuantity) || costedQuantity <= 0
      || !Number.isFinite(impliedWallTimeMs) || impliedWallTimeMs <= 0) {
      return `Gate remedy feasibility contract violation: known cost must use ${mention.targetQuantity} ${mention.unit} with positive finite unitCostMs and impliedWallTimeMs`;
    }
    const source = object(cost.source);
    if (!source || typeof source.stageId !== 'string'
      || !Number.isSafeInteger(source.attemptIndex)
      || typeof source.path !== 'string') {
      return 'Gate remedy feasibility contract violation: known cost needs a completed-attempt source';
    }
    const sourceStatus = readStatus(runDir, source.stageId);
    const sourceAttempt = sourceStatus?.attempts?.find((attempt) => attempt.index === source.attemptIndex);
    const normalizedPath = normalizedEvidencePath(projectDir, runDir, source.path);
    const attributed = new Set(strings(sourceAttempt?.writes));
    if (sourceAttempt?.status !== STAGE_STATUS.COMPLETE || !normalizedPath || !attributed.has(normalizedPath)) {
      return `Gate remedy feasibility contract violation: unit cost source ${source.path} is not attributed to completed attempt ${source.stageId}/${source.attemptIndex}`;
    }
    const absoluteSourcePath = source.path.startsWith('run:')
      ? join(runDir, source.path.slice(4))
      : join(projectDir, normalizedPath);
    if (!existsSync(absoluteSourcePath)) {
      return `Gate remedy feasibility contract violation: unit cost source ${source.path} does not exist`;
    }
    const recorded = recordedUnitCostMs(absoluteSourcePath, source);
    if (recorded.error || recorded.value === undefined) {
      return `Gate remedy feasibility contract violation: ${recorded.error ?? 'unit cost source did not yield a rate'}`;
    }
    if (recorded.unit && recorded.unit !== mention.unit) {
      return `Gate remedy feasibility contract violation: recorded source unit ${recorded.unit} does not match ${mention.unit}`;
    }
    const recordedTolerance = Math.max(1e-6, recorded.value * 1e-6);
    if (Math.abs(unitCostMs - recorded.value) > recordedTolerance) {
      return `Gate remedy feasibility contract violation: unitCostMs ${unitCostMs} does not equal the recorded source rate ${recorded.value}`;
    }
    const expectedTime = unitCostMs * costedQuantity;
    const tolerance = Math.max(1, expectedTime * 1e-6);
    if (Math.abs(impliedWallTimeMs - expectedTime) > tolerance) {
      return `Gate remedy feasibility contract violation: impliedWallTimeMs ${impliedWallTimeMs} does not equal ${unitCostMs} × ${costedQuantity}`;
    }
    const expectedFits = impliedWallTimeMs <= expectedBudget;
    const expectedDisposition = expectedFits ? 'feasible' : 'infeasible';
    if (entry.fitsStageBudget !== expectedFits || entry.disposition !== expectedDisposition) {
      return `Gate remedy feasibility contract violation: implied wall time must state ${expectedDisposition} against the stage budget`;
    }
    if (!statementIncludesDurationMs(statement, expectedTime)) {
      return `Gate remedy feasibility contract violation: statement must include the computed implied wall time (${expectedTime} ms)`;
    }
    if (!new RegExp(expectedDisposition, 'i').test(statement)) {
      return `Gate remedy feasibility contract violation: implied wall time must state ${expectedDisposition} against the stage budget`;
    }
  }
  return undefined;
}

function validateRulingTreatments(
  runDir: string,
  criterionRefs: readonly string[],
  verdict: Record<string, unknown>,
): string | undefined {
  const rulings = readOperatorCriterionRulings(runDir, criterionRefs);
  if (rulings.length === 0) return undefined;
  const criteria = object(verdict.criteria);
  if (!criteria) return undefined; // canonical coverage validation owns this error
  for (const criterionId of criterionRefs) {
    const entry = object(criteria[criterionId]);
    if (!entry || String(entry.status).toLowerCase() !== 'fail') continue;
    const attached = rulings.filter((ruling) => ruling.criterionIds?.includes(criterionId));
    if (attached.length === 0) continue;
    const treatments = Array.isArray(entry.rulingTreatments)
      ? entry.rulingTreatments.map(object).filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    for (const ruling of attached) {
      const treatment = treatments.find((item) => item.guidanceId === ruling.id);
      const quote = typeof treatment?.quote === 'string' ? treatment.quote.trim() : '';
      const explanation = typeof treatment?.explanation === 'string' ? treatment.explanation.trim() : '';
      if (!treatment || !quote || !ruling.body.includes(quote) || !explanation) {
        return `Unreasoned criterion failure: ${criterionId} ignores operator guidance ${ruling.id}; quote it exactly and explain why it does not apply`;
      }
    }
  }
  return undefined;
}

function validateCheckAssessments(
  runDir: string,
  gateStageId: string,
  criterionRefs: readonly string[],
  verdict: Record<string, unknown>,
): GateControlValidation {
  const candidates = collectStageAuthoredChecks(runDir, gateStageId, criterionRefs);
  if (candidates.length === 0) return { conflicts: [] };
  const rulings = readOperatorCriterionRulings(runDir, criterionRefs);
  const criteria = object(verdict.criteria);
  if (!criteria) return { conflicts: [] }; // canonical coverage validation owns this error
  const conflicts: CriterionCheckConflict[] = [];
  for (const candidate of candidates) {
    const entry = object(criteria[candidate.criterionId]);
    const assessments = Array.isArray(entry?.checkAssessments)
      ? entry.checkAssessments.map(object).filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    const assessment = assessments.find((item) => (
      item.path === candidate.path && item.authorStageId === candidate.authorStageId
    ));
    const status = String(assessment?.status ?? '');
    const reason = typeof assessment?.reason === 'string' ? assessment.reason.trim() : '';
    const guidanceId = typeof assessment?.guidanceId === 'string' ? assessment.guidanceId : '';
    const ruling = rulings.find((item) => (
      item.id === guidanceId && item.criterionIds?.includes(candidate.criterionId)
    ));
    if (!assessment || !['consistent', 'conflict', 'not_applicable'].includes(status)
      || !reason || !ruling) {
      return {
        conflicts: [],
        violation: `Gate check/ruling contract violation: ${candidate.path} by ${candidate.authorStageId} must be assessed against an operator ruling on ${candidate.criterionId}`,
      };
    }
    if (status === 'conflict') {
      conflicts.push({ ...candidate, guidanceId, reason });
    }
  }
  if (conflicts.length > 0) {
    const first = conflicts[0];
    return {
      conflicts,
      violation: `Criterion check conflict: ${first.path} by ${first.authorStageId} conflicts with operator guidance ${first.guidanceId} on ${first.criterionId}: ${first.reason}`,
    };
  }
  return { conflicts };
}

export function validateGateControls(input: {
  projectDir: string;
  runDir: string;
  gateStageId: string;
  criterionRefs: readonly string[];
  verdict: Record<string, unknown>;
}): GateControlValidation {
  const remedyViolation = validateRemedyFeasibility(input.projectDir, input.runDir, input.verdict);
  if (remedyViolation) return { violation: remedyViolation, conflicts: [] };
  const rulingViolation = validateRulingTreatments(input.runDir, input.criterionRefs, input.verdict);
  if (rulingViolation) return { violation: rulingViolation, conflicts: [] };
  return validateCheckAssessments(input.runDir, input.gateStageId, input.criterionRefs, input.verdict);
}

export function criterionRulingsFor(
  runDir: string,
  criterionRefs: readonly string[],
): GuidanceEnvelope[] {
  return readOperatorCriterionRulings(runDir, criterionRefs);
}
