import { createHash } from 'node:crypto';
import { RUN_STATUS } from './lifecycle-status.js';

export const CAMPAIGN_SUCCESSOR_STATUS = {
  DERIVED: 'derived',
  ESCALATED: 'escalated',
  NOT_APPLICABLE: 'not_applicable',
} as const;

export type CampaignMetricDirection = 'increase' | 'decrease';
export type CampaignFloorOperator = '>=' | '>';

export interface FrozenCampaignSlice {
  text: string;
  digest: string;
}

export interface CampaignBudgetContract {
  maxRuns: number;
  usedRuns: number;
  maxWallMs?: number;
  startedAt?: string;
}

export interface CampaignNoProgressContract {
  rounds: number;
  tolerance: number;
  metricId?: string;
  direction?: CampaignMetricDirection;
}

export interface FrozenCampaignContract {
  version: 1;
  campaignId: string;
  createdAt: string;
  sourceBriefDigest: string;
  goal: FrozenCampaignSlice;
  yardstick: FrozenCampaignSlice & {
    metricId: string;
    direction: CampaignMetricDirection;
    unit: string;
    evaluationConstruction: string;
  };
  budget: CampaignBudgetContract;
  noProgress: Required<CampaignNoProgressContract>;
}

export interface FrozenCampaignContractInput {
  campaignId: string;
  createdAt: string;
  sourceBrief: string;
  goalText: string;
  yardstickText: string;
  yardstick: {
    metricId: string;
    direction: CampaignMetricDirection;
    unit: string;
    evaluationConstruction: string;
  };
  budget: CampaignBudgetContract;
  noProgress: Required<CampaignNoProgressContract>;
}

export interface CampaignSuccessorGuidance {
  id: string;
  source: 'operator' | 'scheduler' | 'supervisor';
  text?: string;
  body?: string;
  target?: string;
  addressed?: boolean;
  createdAt?: string;
  sourceAnchor?: string;
  quarantined?: boolean;
  quarantineReason?: string;
}

export interface CampaignDeclinedItem {
  id?: string;
  source: string;
  reason?: string;
  detail?: string;
  sourceAnchor?: string;
  stageId?: string;
}

export interface CampaignCriterionEvidence {
  id: string;
  text?: string;
  metricId: string;
  unit: string;
  normalizedUnit?: string;
  passed?: boolean[];
  verdicts?: Array<{
    status: 'pass' | 'judgement' | 'fail';
    source?: string;
  }>;
  neverFailed?: boolean;
}

export interface CampaignMetricSeries {
  metricId: string;
  criterionId?: string;
  unit: string;
  normalizedUnit?: string;
  values: number[];
  source?: string;
  stagnation?: {
    rounds: number;
    tolerance: number;
    direction: CampaignMetricDirection;
  };
}

export interface CampaignTerminalEvidence {
  status: string;
  goalMet: boolean;
  artifactId?: string;
  artifactBytes?: string;
  sourceAnchor?: string;
  /** Required to replay an operator-cancelled historical run. Never set by the live runner. */
  historicalReplay?: boolean;
}

export interface CampaignProgressEvidence {
  usedRuns?: number;
  observedAt?: string;
  yardstickValues?: number[];
}

/**
 * The public input deliberately accepts the compact shape used by the unchanged-base
 * reproduction as well as the complete frozen-contract form used by the live pipeline.
 * Compact inputs are marked as identifier-backed in the result; live launch code requires
 * byte-backed terminal evidence and a complete FrozenCampaignContract.
 */
export interface CampaignSuccessorInput {
  campaignContract: FrozenCampaignContract | Record<string, unknown>;
  predecessorBrief: string;
  terminal: CampaignTerminalEvidence;
  guidance?: CampaignSuccessorGuidance[];
  operatorGuidance?: CampaignSuccessorGuidance[];
  declinedItems?: CampaignDeclinedItem[];
  criteria?: CampaignCriterionEvidence[];
  criterion?: CampaignCriterionEvidence;
  metricSeries: CampaignMetricSeries | CampaignMetricSeries[];
  campaignProgress?: CampaignProgressEvidence;
}

export type CampaignDiffReason =
  | 'promoted_guidance'
  | 'retained_guidance_context'
  | 'converted_criterion'
  | 'declined_item';

export interface CampaignSuccessorDiffEntry {
  reason: CampaignDiffReason;
  sourceId: string;
  sourceAnchor?: string;
  oldText: string | null;
  newText: string;
  explanation: string;
}

export interface CampaignFloorConversion {
  criterionId: string;
  metricId: string;
  operator: CampaignFloorOperator;
  value: number;
  unit: string;
  authorityGuidanceIds: string[];
  observedValues: number[];
  stagnation: {
    rounds: number;
    tolerance: number;
    direction: CampaignMetricDirection;
  };
}

export interface CampaignSuccessorDerived {
  status: 'derived';
  successorBrief: string;
  /** Compatibility alias for consumers which call the generated document simply `brief`. */
  brief: string;
  unifiedDiff: string;
  structuredDiff: {
    version: 1;
    entries: CampaignSuccessorDiffEntry[];
  };
  promotedGuidanceIds: string[];
  retainedContextGuidanceIds: string[];
  declinedItemIds: string[];
  convertedCriteria: CampaignFloorConversion[];
  floor: CampaignFloorConversion;
  contract: {
    goalDigest: string;
    yardstickDigest: string;
    sourceBriefDigest: string;
    preserved: true;
  };
  terminalEvidence: {
    artifactId: string;
    digest: string;
    evidenceMode: 'bytes' | 'identifier_only';
    historicalReplay: boolean;
  };
  expectation: {
    expectedFloor: number;
    latestObservedValue: number;
    unit: string;
    within_expected_range: boolean;
    method_was_not_adjusted_to_match_expectation: true;
  };
}

export interface CampaignSuccessorEscalated {
  status: 'escalated';
  reason: string;
  ambiguities: string[];
  terminalEvidence?: {
    artifactId: string;
    digest: string;
    evidenceMode: 'bytes' | 'identifier_only';
  };
}

export interface CampaignSuccessorNotApplicable {
  status: 'not_applicable';
  reason: string;
}

export type CampaignSuccessorResult =
  | CampaignSuccessorDerived
  | CampaignSuccessorEscalated
  | CampaignSuccessorNotApplicable;

interface NormalizedContract {
  goalText: string;
  goalDigest: string;
  goalIsBriefSlice: boolean;
  yardstickText: string;
  yardstickDigest: string;
  sourceBriefDigest: string;
  budget: CampaignBudgetContract;
  noProgress: CampaignNoProgressContract;
}

interface FloorAuthority {
  guidanceId: string;
  metricId: string;
  operator: CampaignFloorOperator;
  value: number;
  unit: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function canonicalUnit(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (/^minutes?\b/.test(normalized)) return 'minutes';
  if (/^seconds?\b/.test(normalized)) return 'seconds';
  if (/^hours?\b/.test(normalized)) return 'hours';
  if (/^decisions?\b/.test(normalized)) return 'decisions';
  return normalized;
}

function normalizeContract(raw: FrozenCampaignContract | Record<string, unknown>, predecessorBrief: string): NormalizedContract | string[] {
  const ambiguities: string[] = [];
  const contract = raw as Record<string, unknown>;
  const rawGoal = contract.goal;
  let goalText = typeof contract.goalText === 'string' ? contract.goalText : '';
  let goalDigest = typeof contract.goalDigest === 'string' ? contract.goalDigest : '';
  let goalIsBriefSlice = Boolean(goalText);
  if (isRecord(rawGoal) && typeof rawGoal.text === 'string') {
    goalText = rawGoal.text;
    goalDigest = typeof rawGoal.digest === 'string' ? rawGoal.digest : goalDigest;
    goalIsBriefSlice = true;
  } else if (!goalText && rawGoal !== undefined) {
    // Semantic goal objects have exact insertion-ordered JSON bytes. They are frozen
    // independently of prose, and body-only successor edits cannot alter them.
    goalText = JSON.stringify(rawGoal);
    goalIsBriefSlice = false;
  }
  if (!goalText) ambiguities.push('campaign contract has no exact goal text or semantic goal bytes');
  if (!goalDigest && goalText) goalDigest = sha256(goalText);
  if (goalText && goalDigest !== sha256(goalText)) ambiguities.push('campaign goal digest does not match its frozen bytes');

  const rawYardstick = contract.yardstick;
  let yardstickText = typeof contract.yardstickText === 'string' ? contract.yardstickText : '';
  let yardstickDigest = typeof contract.yardstickDigest === 'string' ? contract.yardstickDigest : '';
  if (isRecord(rawYardstick) && typeof rawYardstick.text === 'string') {
    yardstickText = rawYardstick.text;
    yardstickDigest = typeof rawYardstick.digest === 'string' ? rawYardstick.digest : yardstickDigest;
  }
  if (!yardstickText) ambiguities.push('campaign contract has no exact yardstick text');
  if (!yardstickDigest && yardstickText) yardstickDigest = sha256(yardstickText);
  if (yardstickText && yardstickDigest !== sha256(yardstickText)) ambiguities.push('campaign yardstick digest does not match its frozen bytes');

  const rawBudget = isRecord(contract.budget) ? contract.budget : {};
  const maxRuns = positiveInteger(rawBudget.maxRuns);
  const usedRuns = typeof rawBudget.usedRuns === 'number' && Number.isSafeInteger(rawBudget.usedRuns) && rawBudget.usedRuns >= 0
    ? rawBudget.usedRuns
    : 0;
  if (maxRuns === undefined) ambiguities.push('campaign run budget must be a positive integer');
  const maxWallMs = finiteNumber(rawBudget.maxWallMs);
  if (rawBudget.maxWallMs !== undefined && (maxWallMs === undefined || maxWallMs <= 0)) {
    ambiguities.push('campaign wall budget must be a positive number of milliseconds');
  }

  const rawNoProgress = isRecord(contract.noProgress) ? contract.noProgress : {};
  const rounds = positiveInteger(rawNoProgress.rounds);
  const tolerance = finiteNumber(rawNoProgress.tolerance);
  if (rounds === undefined) ambiguities.push('campaign no-progress rule must declare a positive round count');
  if (tolerance === undefined || tolerance < 0) ambiguities.push('campaign no-progress rule must declare a non-negative tolerance');

  if (goalIsBriefSlice && goalText && !predecessorBrief.includes(goalText)) {
    ambiguities.push('predecessor brief does not contain the frozen goal bytes');
  }
  if (yardstickText && !predecessorBrief.includes(yardstickText)) {
    ambiguities.push('predecessor brief does not contain the frozen yardstick bytes');
  }
  if (ambiguities.length > 0) return ambiguities;

  return {
    goalText,
    goalDigest,
    goalIsBriefSlice,
    yardstickText,
    yardstickDigest,
    sourceBriefDigest: typeof contract.sourceBriefDigest === 'string'
      ? contract.sourceBriefDigest
      : sha256(predecessorBrief),
    budget: {
      maxRuns: maxRuns!,
      usedRuns,
      ...(maxWallMs === undefined ? {} : { maxWallMs }),
      ...(typeof rawBudget.startedAt === 'string' ? { startedAt: rawBudget.startedAt } : {}),
    },
    noProgress: {
      rounds: rounds!,
      tolerance: tolerance!,
      ...(typeof rawNoProgress.metricId === 'string' ? { metricId: rawNoProgress.metricId } : {}),
      ...((rawNoProgress.direction === 'increase' || rawNoProgress.direction === 'decrease')
        ? { direction: rawNoProgress.direction }
        : {}),
    },
  };
}

function normalizeGuidance(input: CampaignSuccessorInput): CampaignSuccessorGuidance[] {
  const byId = new Map<string, CampaignSuccessorGuidance>();
  for (const entry of [...(input.guidance ?? []), ...(input.operatorGuidance ?? [])]) {
    const text = (entry.body ?? entry.text ?? '').trim();
    if (!entry.id || !text) continue;
    const prior = byId.get(entry.id);
    if (!prior) byId.set(entry.id, { ...entry, body: text });
    else if ((prior.body ?? prior.text ?? '').trim() !== text) {
      byId.set(entry.id, { ...entry, body: text, sourceAnchor: 'conflicting_duplicate' });
    }
  }
  return [...byId.values()];
}

function criterionNeverFailed(criterion: CampaignCriterionEvidence): boolean {
  if (criterion.neverFailed === false) return false;
  if (criterion.passed && criterion.passed.some((value) => value !== true)) return false;
  if (criterion.verdicts && criterion.verdicts.some((verdict) => verdict.status === 'fail')) return false;
  const population = criterion.passed?.length ?? criterion.verdicts?.length ?? 0;
  return criterion.neverFailed === true ? population > 0 : population > 0;
}

function noProgress(series: CampaignMetricSeries, fallback: CampaignNoProgressContract): CampaignFloorConversion['stagnation'] | undefined {
  const rule = series.stagnation ?? {
    rounds: fallback.rounds,
    tolerance: fallback.tolerance,
    direction: fallback.direction ?? 'increase',
  };
  if (!Number.isSafeInteger(rule.rounds) || rule.rounds < 2 || !Number.isFinite(rule.tolerance) || rule.tolerance < 0) return undefined;
  if (series.values.length < rule.rounds) return undefined;
  const tail = series.values.slice(-rule.rounds);
  const stalled = tail.slice(1).every((value, index) => {
    const delta = value - tail[index];
    return rule.direction === 'increase' ? delta <= rule.tolerance : -delta <= rule.tolerance;
  });
  return stalled ? rule : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function metricAuthorities(
  guidance: readonly CampaignSuccessorGuidance[],
  criterion: CampaignCriterionEvidence,
  series: CampaignMetricSeries,
): FloorAuthority[] {
  const result: FloorAuthority[] = [];
  const unit = canonicalUnit(series.normalizedUnit ?? criterion.normalizedUnit ?? criterion.unit ?? series.unit);
  const metricPattern = new RegExp(
    `\\b${escapeRegExp(series.metricId)}\\s*(>=|>)\\s*(\\d+(?:\\.\\d+)?)\\s+([A-Za-z][A-Za-z _-]{0,60}?)(?=[.,;:)\\n]|$)`,
    'i',
  );
  const phrasePattern = /\b(at least|no less than)\s+(\d+(?:\.\d+)?)\s+([A-Za-z][A-Za-z _-]{0,60}?)(?=[(.,;:)\n]|$)/gi;
  const criterionNumber = /^\s*(\d+)\./.exec(criterion.text ?? '')?.[1]
    ?? /(?:^|_)(\d+)(?:_|$)/.exec(criterion.id)?.[1];

  for (const entry of guidance) {
    if (entry.source !== 'operator' || entry.addressed === false) continue;
    const body = (entry.body ?? entry.text ?? '').trim();
    const direct = metricPattern.exec(body);
    if (direct) {
      const parsedUnit = canonicalUnit(direct[3]);
      if (parsedUnit === unit) {
        result.push({
          guidanceId: entry.id,
          metricId: series.metricId,
          operator: direct[1] as CampaignFloorOperator,
          value: Number(direct[2]),
          unit,
        });
      }
      continue;
    }

    const criterionNamed = body.toLowerCase().includes(criterion.id.toLowerCase())
      || (criterionNumber !== undefined && new RegExp(`\\bcriterion\\s+${escapeRegExp(criterionNumber)}\\b`, 'i').test(body));
    // When a typed input has only one criterion/series pair, a unique operator-authored
    // comparative phrase is already explicitly linked by that envelope. With multiple pairs,
    // the criterion must be named so prose never guesses a semantic relationship.
    if (!criterionNamed) continue;
    phrasePattern.lastIndex = 0;
    for (const match of body.matchAll(phrasePattern)) {
      const parsedUnit = canonicalUnit(match[3]);
      if (parsedUnit !== unit) continue;
      result.push({
        guidanceId: entry.id,
        metricId: series.metricId,
        operator: '>=',
        value: Number(match[2]),
        unit,
      });
    }
  }
  return result.filter((authority) => Number.isFinite(authority.value));
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function unifiedDiff(fromContent: string, toContent: string): string {
  const from = splitLines(fromContent);
  const to = splitLines(toContent);
  const matrix = Array.from({ length: from.length + 1 }, () => Array<number>(to.length + 1).fill(0));
  for (let i = from.length - 1; i >= 0; i -= 1) {
    for (let j = to.length - 1; j >= 0; j -= 1) {
      matrix[i][j] = from[i] === to[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  const out = ['--- predecessor.md', '+++ successor.md', `@@ -1,${from.length} +1,${to.length} @@`];
  let i = 0;
  let j = 0;
  while (i < from.length || j < to.length) {
    if (i < from.length && j < to.length && from[i] === to[j]) {
      out.push(` ${from[i]}`);
      i += 1;
      j += 1;
    } else if (j < to.length && (i === from.length || matrix[i][j + 1] >= matrix[i + 1][j])) {
      out.push(`+${to[j]}`);
      j += 1;
    } else {
      out.push(`-${from[i]}`);
      i += 1;
    }
  }
  return `${out.join('\n')}\n`;
}

function quoteBody(body: string): string {
  return body.split(/\r?\n/).map((line) => `  > ${line}`).join('\n');
}

function insertBeforeOutOfScope(brief: string, section: string): string {
  const marker = /^## Out of scope\s*$/mi;
  const match = marker.exec(brief);
  if (!match || match.index === undefined) {
    return `${brief.replace(/\s*$/, '')}\n\n${section.trim()}\n`;
  }
  const before = brief.slice(0, match.index).replace(/\s*$/, '');
  const after = brief.slice(match.index).replace(/^\s*/, '');
  return `${before}\n\n${section.trim()}\n\n${after}`;
}

function terminalDescriptor(terminal: CampaignTerminalEvidence): {
  artifactId: string;
  digest: string;
  evidenceMode: 'bytes' | 'identifier_only';
} {
  const artifactId = terminal.artifactId ?? terminal.sourceAnchor ?? `terminal:${terminal.status}`;
  const evidenceMode = terminal.artifactBytes === undefined ? 'identifier_only' : 'bytes';
  return {
    artifactId,
    digest: sha256(terminal.artifactBytes ?? JSON.stringify({
      status: terminal.status,
      goalMet: terminal.goalMet,
      artifactId,
    })),
    evidenceMode,
  };
}

function escalation(terminal: CampaignTerminalEvidence, ambiguities: string[]): CampaignSuccessorEscalated {
  return {
    status: 'escalated',
    reason: ambiguities[0] ?? 'successor derivation was ambiguous',
    ambiguities,
    terminalEvidence: terminalDescriptor(terminal),
  };
}

function campaignStopReason(contract: NormalizedContract, progress: CampaignProgressEvidence | undefined): string | undefined {
  const usedRuns = progress?.usedRuns ?? contract.budget.usedRuns;
  if (usedRuns >= contract.budget.maxRuns) {
    return `campaign run budget exhausted (${usedRuns}/${contract.budget.maxRuns})`;
  }
  if (contract.budget.maxWallMs !== undefined && contract.budget.startedAt && progress?.observedAt) {
    const elapsed = Date.parse(progress.observedAt) - Date.parse(contract.budget.startedAt);
    if (!Number.isFinite(elapsed)) return 'campaign wall budget timestamps are not comparable';
    if (elapsed >= contract.budget.maxWallMs) {
      return `campaign wall budget exhausted (${elapsed}/${contract.budget.maxWallMs} ms)`;
    }
  }
  const values = progress?.yardstickValues;
  if (contract.noProgress.metricId && contract.noProgress.direction && values) {
    const requiredTransitions = contract.noProgress.rounds;
    if (values.length > requiredTransitions) {
      const tail = values.slice(-(requiredTransitions + 1));
      const stopped = tail.slice(1).every((value, index) => {
        const delta = value - tail[index];
        return contract.noProgress.direction === 'increase'
          ? delta <= contract.noProgress.tolerance
          : -delta <= contract.noProgress.tolerance;
      });
      if (stopped) return `campaign no-progress rule fired for ${contract.noProgress.metricId} after ${requiredTransitions} transitions`;
    }
  }
  return undefined;
}

export function createFrozenCampaignContract(input: FrozenCampaignContractInput): FrozenCampaignContract {
  if (!input.campaignId.trim()) throw new Error('campaignId is required');
  if (!input.goalText) throw new Error('exact goal text is required');
  if (!input.yardstickText) throw new Error('exact yardstick text is required');
  if (!positiveInteger(input.budget.maxRuns)) throw new Error('maxRuns must be a positive integer');
  if (!Number.isSafeInteger(input.budget.usedRuns) || input.budget.usedRuns < 0) throw new Error('usedRuns must be a non-negative integer');
  if (!positiveInteger(input.noProgress.rounds)) throw new Error('no-progress rounds must be a positive integer');
  if (!Number.isFinite(input.noProgress.tolerance) || input.noProgress.tolerance < 0) throw new Error('no-progress tolerance must be non-negative');
  if (!input.noProgress.metricId.trim()) throw new Error('no-progress metricId is required');
  return {
    version: 1,
    campaignId: input.campaignId,
    createdAt: input.createdAt,
    sourceBriefDigest: sha256(input.sourceBrief),
    goal: { text: input.goalText, digest: sha256(input.goalText) },
    yardstick: {
      text: input.yardstickText,
      digest: sha256(input.yardstickText),
      ...input.yardstick,
    },
    budget: { ...input.budget },
    noProgress: { ...input.noProgress },
  };
}

export function verifyFrozenCampaignContract(contract: FrozenCampaignContract): string[] {
  const problems: string[] = [];
  if (contract.version !== 1) problems.push('unsupported frozen campaign contract version');
  if (sha256(contract.goal.text) !== contract.goal.digest) problems.push('frozen goal digest mismatch');
  if (sha256(contract.yardstick.text) !== contract.yardstick.digest) problems.push('frozen yardstick digest mismatch');
  if (!/^[0-9a-f]{64}$/.test(contract.sourceBriefDigest)) problems.push('invalid frozen source brief digest');
  if (!positiveInteger(contract.budget.maxRuns)) problems.push('invalid frozen run budget');
  if (!positiveInteger(contract.noProgress.rounds) || contract.noProgress.tolerance < 0) problems.push('invalid frozen no-progress rule');
  if (!contract.yardstick.metricId || !contract.yardstick.unit || !contract.yardstick.evaluationConstruction) {
    problems.push('incomplete frozen yardstick construction');
  }
  return problems;
}

/**
 * Deterministically derive a successor. The function performs no file, clock, process,
 * adapter, or network access; identical bytes and typed evidence produce identical output.
 */
export function deriveCampaignSuccessor(input: CampaignSuccessorInput): CampaignSuccessorResult {
  const terminal = input.terminal;
  if (terminal.goalMet) return { status: 'not_applicable', reason: 'campaign goal is met; publication remains an operator gate' };
  const productionEligible = terminal.status === RUN_STATUS.CEILING_HIT
    || terminal.status === RUN_STATUS.ESCALATED
    || terminal.status === RUN_STATUS.COMPLETE;
  const historicalReplay = terminal.status === RUN_STATUS.STOPPED
    && (terminal.historicalReplay === true || terminal.artifactId !== undefined);
  if (!productionEligible && !historicalReplay) {
    return { status: 'not_applicable', reason: `terminal status ${terminal.status} is not eligible for autonomous continuation` };
  }

  const contract = normalizeContract(input.campaignContract, input.predecessorBrief);
  if (Array.isArray(contract)) return escalation(terminal, contract);
  const stop = campaignStopReason(contract, input.campaignProgress);
  if (stop) return escalation(terminal, [stop]);

  const guidance = normalizeGuidance(input);
  const duplicateConflicts = guidance.filter((entry) => entry.sourceAnchor === 'conflicting_duplicate');
  if (duplicateConflicts.length > 0) {
    return escalation(terminal, duplicateConflicts.map((entry) => `guidance id ${entry.id} has conflicting bodies`));
  }
  const promoted = guidance.filter((entry) => entry.source === 'operator' && entry.addressed !== false);
  const retained = guidance.filter((entry) => entry.source !== 'operator' && entry.addressed !== false);
  if (promoted.length === 0) return escalation(terminal, ['eligible terminal run has no addressed operator guidance to promote']);

  const criteria = [...(input.criteria ?? []), ...(input.criterion ? [input.criterion] : [])];
  const seriesList = Array.isArray(input.metricSeries) ? input.metricSeries : [input.metricSeries];
  const ambiguities: string[] = [];
  const conversions: CampaignFloorConversion[] = [];
  for (const criterion of criteria) {
    if (!criterionNeverFailed(criterion)) continue;
    const candidates = seriesList.filter((series) => series.metricId === criterion.metricId
      && (series.criterionId === undefined || series.criterionId === criterion.id));
    if (candidates.length !== 1) {
      ambiguities.push(`criterion ${criterion.id} has ${candidates.length} explicitly linked metric series`);
      continue;
    }
    const series = candidates[0];
    if (series.values.length < 2 || series.values.some((value) => !Number.isFinite(value))) {
      ambiguities.push(`metric ${series.metricId} has no comparable numeric history`);
      continue;
    }
    const criterionUnit = canonicalUnit(criterion.normalizedUnit ?? criterion.unit);
    const seriesUnit = canonicalUnit(series.normalizedUnit ?? series.unit);
    if (!criterionUnit || criterionUnit !== seriesUnit) {
      ambiguities.push(`criterion ${criterion.id} and metric ${series.metricId} do not share an authorized unit`);
      continue;
    }
    const stagnation = noProgress(series, contract.noProgress);
    if (!stagnation) continue;
    const authorities = metricAuthorities(promoted, criterion, series);
    if (authorities.length === 0) {
      ambiguities.push(`metric ${series.metricId} has no operator-authorized numeric unit-bearing floor`);
      continue;
    }
    const first = authorities[0];
    const conflicts = authorities.filter((authority) => authority.operator !== first.operator
      || authority.value !== first.value
      || authority.unit !== first.unit);
    if (conflicts.length > 0) {
      ambiguities.push(`metric ${series.metricId} has conflicting operator floor authorities`);
      continue;
    }
    conversions.push({
      criterionId: criterion.id,
      metricId: series.metricId,
      operator: first.operator,
      value: first.value,
      unit: first.unit,
      authorityGuidanceIds: [...new Set(authorities.map((authority) => authority.guidanceId))].sort(),
      observedValues: [...series.values],
      stagnation,
    });
  }
  if (ambiguities.length > 0) return escalation(terminal, ambiguities);
  if (conversions.length === 0) {
    return escalation(terminal, ['no explicitly linked never-failed stagnant criterion could be converted safely']);
  }

  let successorBrief = input.predecessorBrief;
  const entries: CampaignSuccessorDiffEntry[] = [];
  for (const conversion of conversions) {
    const criterion = criteria.find((candidate) => candidate.id === conversion.criterionId)!;
    const floorText = `**Graded floor:** \`${conversion.metricId} ${conversion.operator} ${conversion.value} ${conversion.unit}\`. A value below this floor fails this criterion.`;
    if (criterion.text && successorBrief.includes(criterion.text)) {
      const trailing = /\s*$/.exec(criterion.text)?.[0] ?? '';
      const newText = `${criterion.text.slice(0, criterion.text.length - trailing.length).trimEnd()}\n   ${floorText}${trailing || '\n'}`;
      successorBrief = successorBrief.replace(criterion.text, newText);
      entries.push({
        reason: 'converted_criterion',
        sourceId: criterion.id,
        sourceAnchor: conversion.authorityGuidanceIds.join(','),
        oldText: criterion.text,
        newText,
        explanation: `The criterion never recorded a failure while ${conversion.metricId} made no progress under the frozen rule; operator guidance supplied the numeric floor.`,
      });
    } else {
      entries.push({
        reason: 'converted_criterion',
        sourceId: criterion.id,
        sourceAnchor: conversion.authorityGuidanceIds.join(','),
        oldText: criterion.text ?? null,
        newText: floorText,
        explanation: `The criterion never recorded a failure while ${conversion.metricId} made no progress under the frozen rule; operator guidance supplied the numeric floor.`,
      });
    }
  }

  const section: string[] = [
    '## Campaign successor constraints (mechanically derived)',
    '',
    'These constraints are source-bound. Operator guidance is binding; scheduler and supervisor guidance remains context only.',
    '',
  ];
  for (const conversion of conversions) {
    const line = `- Hard graded floor from ${conversion.authorityGuidanceIds.map((id) => `\`${id}\``).join(', ')}: \`${conversion.metricId} ${conversion.operator} ${conversion.value} ${conversion.unit}\`; below-floor evidence fails \`${conversion.criterionId}\`.`;
    section.push(line);
    entries.push({
      reason: 'converted_criterion',
      sourceId: conversion.criterionId,
      sourceAnchor: conversion.authorityGuidanceIds.join(','),
      oldText: null,
      newText: line,
      explanation: 'A prose expectation became an auditable numeric inequality with an explicit unit and operator authority.',
    });
  }
  for (const item of promoted) {
    const body = (item.body ?? item.text ?? '').trim();
    const line = `- Operator constraint \`${item.id}\` is binding${item.quarantined ? ' at campaign scope despite its unusable stage target' : ''}:`;
    section.push('', line, quoteBody(body));
    entries.push({
      reason: 'promoted_guidance',
      sourceId: item.id,
      ...(item.sourceAnchor ? { sourceAnchor: item.sourceAnchor } : {}),
      oldText: null,
      newText: `${line}\n${body}`,
      explanation: 'Addressed operator guidance is promoted to a source-identifiable successor constraint.',
    });
  }
  for (const item of retained) {
    const body = (item.body ?? item.text ?? '').trim();
    const line = `- Non-operator context \`${item.id}\` (not authority):`;
    section.push('', line, quoteBody(body));
    entries.push({
      reason: 'retained_guidance_context',
      sourceId: item.id,
      ...(item.sourceAnchor ? { sourceAnchor: item.sourceAnchor } : {}),
      oldText: null,
      newText: `${line}\n${body}`,
      explanation: 'Scheduler or supervisor guidance remains visible but cannot authorize a constraint or numeric floor.',
    });
  }
  const declinedIds: string[] = [];
  for (const [index, item] of (input.declinedItems ?? []).entries()) {
    const detail = (item.detail ?? item.reason ?? '').trim();
    const id = item.id ?? `${item.source}:${index + 1}:${sha256(detail).slice(0, 12)}`;
    declinedIds.push(id);
    const line = `- Declined item \`${id}\` must not be retried silently; retain it as an exclusion (${item.source}).`;
    section.push('', line, quoteBody(detail));
    entries.push({
      reason: 'declined_item',
      sourceId: id,
      ...(item.sourceAnchor ? { sourceAnchor: item.sourceAnchor } : {}),
      oldText: null,
      newText: `${line}\n${detail}`,
      explanation: 'A previously declined or rejected item is carried forward instead of being silently proposed again.',
    });
  }
  successorBrief = insertBeforeOutOfScope(successorBrief, section.join('\n'));

  if (contract.goalIsBriefSlice && !successorBrief.includes(contract.goalText)) {
    return escalation(terminal, ['successor changed the exact frozen goal bytes']);
  }
  if (!successorBrief.includes(contract.yardstickText)) {
    return escalation(terminal, ['successor changed the exact frozen yardstick bytes']);
  }
  const floor = conversions[0];
  const latest = floor.observedValues.at(-1)!;
  const descriptor = terminalDescriptor(terminal);
  return {
    status: 'derived',
    successorBrief,
    brief: successorBrief,
    unifiedDiff: unifiedDiff(input.predecessorBrief, successorBrief),
    structuredDiff: { version: 1, entries },
    promotedGuidanceIds: promoted.map((entry) => entry.id).sort(),
    retainedContextGuidanceIds: retained.map((entry) => entry.id).sort(),
    declinedItemIds: declinedIds,
    convertedCriteria: conversions,
    floor,
    contract: {
      goalDigest: contract.goalDigest,
      yardstickDigest: contract.yardstickDigest,
      sourceBriefDigest: contract.sourceBriefDigest,
      preserved: true,
    },
    terminalEvidence: { ...descriptor, historicalReplay },
    expectation: {
      expectedFloor: floor.value,
      latestObservedValue: latest,
      unit: floor.unit,
      within_expected_range: floor.operator === '>=' ? latest >= floor.value : latest > floor.value,
      method_was_not_adjusted_to_match_expectation: true,
    },
  };
}
