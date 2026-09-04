import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { REGISTRY_COMPACTION_THRESHOLDS } from './task-registry.js';
import { supervisionPaths } from './supervision.js';

export const RUN_DRIFT_ROW_IDS = [
  'research_dose',
  'first_plan_admission',
  'supervisor_rejections',
  'engine_overhead',
  'registry_growth',
  'log_growth',
] as const;

export type RunDriftRowId = typeof RUN_DRIFT_ROW_IDS[number];
export type RunDriftCrossing = 'below' | 'at' | 'above' | 'unavailable';
export type RunDriftSourceAvailability = 'read' | 'partial' | 'missing' | 'malformed' | 'legacy';

export interface RunDriftThreshold {
  kind: 'floor' | 'expectation' | 'target' | 'budget' | 'warning' | 'unavailable';
  operator?: '>=' | '>' | '<=' | '<' | '=';
  value?: number;
  unit: string;
  display: string;
  source: string;
}

export interface RunDriftSource {
  availability: RunDriftSourceAvailability;
  reference: string;
  observedAt?: string;
  eventId?: string;
}

export interface RunDriftDistribution {
  samples: number[];
  sampleCount: number;
  mean: number;
  median: number;
  reportedValue: number;
  reportedRank: number;
  reportedPercentile: number;
  percentileMethod: 'midrank percentage; rank is zero-based count strictly below reportedValue';
}

export interface RunDriftTrend {
  values: number[];
  direction: 'increasing' | 'decreasing' | 'flat' | 'mixed' | 'unavailable';
  unit: string;
}

export interface RunDriftRow {
  id: RunDriftRowId;
  label: string;
  value: number | string | null;
  /** Numeric operand used for threshold comparison when value is a composite display. */
  comparisonValue?: number;
  unit: string;
  threshold: RunDriftThreshold;
  source: RunDriftSource;
  crossing: RunDriftCrossing;
  distribution?: RunDriftDistribution;
  trend?: RunDriftTrend;
  annotations: string[];
}

export interface RunDriftProjection {
  version: 1;
  rows: RunDriftRow[];
}

export interface RunDriftReadOptions {
  state?: unknown;
  events?: readonly unknown[];
  eventsCoverage?: 'read' | 'missing' | 'unreadable';
  registryPath?: string;
}

interface JsonObject {
  [key: string]: unknown;
}

interface FileObservation {
  path: string;
  size: number;
  mtimeMs: number;
}

interface JsonReadResult {
  availability: Extract<RunDriftSourceAvailability, 'read' | 'missing' | 'malformed'>;
  path: string;
  value?: JsonObject;
  observation?: FileObservation;
}

interface RegistryTaskRef {
  runId: string;
  unit: string;
}

interface RegistryObservation extends FileObservation {
  records: number;
  recordsExact: boolean;
  taskRefs: Map<string, RegistryTaskRef>;
}

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_RESEARCH_ROUNDS = 64;
const MAX_OVERHEAD_SAMPLES = 512;
const MAX_EVENT_ROWS = 2_000;
const MAX_EVENT_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_REGISTRY_SCAN_BYTES = REGISTRY_COMPACTION_THRESHOLDS.bytes;
const MAX_REGISTRY_TAIL_BYTES = 4 * 1024 * 1024;
const LOG_WARNING_BYTES = 64 * 1024 * 1024;
const OVERHEAD_WARNING_MS = 60_000;
const DRIFT_SCHEMA_KEY = 'x-flowcrew-drift';
const MIDRANK_METHOD = 'midrank percentage; rank is zero-based count strictly below reportedValue' as const;

let registryCache: {
  path: string;
  size: number;
  mtimeMs: number;
  value: RegistryObservation;
} | undefined;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function timestampMs(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function observedAt(mtimeMs: number | undefined): string | undefined {
  return mtimeMs === undefined || !Number.isFinite(mtimeMs)
    ? undefined
    : new Date(mtimeMs).toISOString();
}

function regularFile(path: string): FileObservation | undefined {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    return { path, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return undefined;
  }
}

function readJsonObject(path: string, maxBytes = MAX_JSON_BYTES): JsonReadResult {
  if (!existsSync(path)) return { availability: 'missing', path };
  const observation = regularFile(path);
  if (!observation || observation.size > maxBytes) return { availability: 'malformed', path, observation };
  try {
    const value = object(JSON.parse(readFileSync(path, 'utf-8')) as unknown);
    return value
      ? { availability: 'read', path, value, observation }
      : { availability: 'malformed', path, observation };
  } catch {
    return { availability: 'malformed', path, observation };
  }
}

function source(
  availability: RunDriftSourceAvailability,
  reference: string,
  observation?: FileObservation,
  eventId?: string,
  eventTimestamp?: string,
): RunDriftSource {
  const fileObservedAt = observedAt(observation?.mtimeMs);
  const eventObservedMs = timestampMs(eventTimestamp);
  const eventObservedAt = eventObservedMs === undefined ? undefined : new Date(eventObservedMs).toISOString();
  const sourceObservedAt = eventObservedAt ?? fileObservedAt;
  return {
    availability,
    reference,
    ...(sourceObservedAt ? { observedAt: sourceObservedAt } : {}),
    ...(eventId ? { eventId } : {}),
  };
}

function distribution(samples: readonly number[], reportedValue: number): RunDriftDistribution | undefined {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample))) return undefined;
  const values = [...samples];
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
  const reportedRank = ordered.filter((sample) => sample < reportedValue).length;
  const equalCount = ordered.filter((sample) => sample === reportedValue).length;
  return {
    samples: values,
    sampleCount: values.length,
    mean: values.reduce((sum, sample) => sum + sample, 0) / values.length,
    median,
    reportedValue,
    reportedRank,
    reportedPercentile: ((reportedRank + equalCount / 2) / values.length) * 100,
    percentileMethod: MIDRANK_METHOD,
  };
}

function compare(value: number | undefined, threshold: number | undefined): RunDriftCrossing {
  if (value === undefined || threshold === undefined || !Number.isFinite(value) || !Number.isFinite(threshold)) {
    return 'unavailable';
  }
  if (value < threshold) return 'below';
  if (value > threshold) return 'above';
  return 'at';
}

function trend(values: readonly number[], unit: string): RunDriftTrend {
  if (values.length < 2) return { values: [...values], direction: 'unavailable', unit };
  const changes = values.slice(1).map((value, index) => Math.sign(value - values[index]));
  const direction = changes.every((change) => change === 0)
    ? 'flat'
    : changes.every((change) => change >= 0) && changes.some((change) => change > 0)
      ? 'increasing'
      : changes.every((change) => change <= 0) && changes.some((change) => change < 0)
        ? 'decreasing'
        : 'mixed';
  return { values: [...values], direction, unit };
}

function unavailableThreshold(unit: string, sourceName: string): RunDriftThreshold {
  return {
    kind: 'unavailable',
    unit,
    display: 'unavailable',
    source: sourceName,
  };
}

function unavailableRow(
  id: RunDriftRowId,
  label: string,
  unit: string,
  threshold: RunDriftThreshold,
  reference: string,
  availability: RunDriftSourceAvailability = 'missing',
  annotations: string[] = [],
): RunDriftRow {
  return {
    id,
    label,
    value: null,
    unit,
    threshold,
    source: source(availability, reference),
    crossing: 'unavailable',
    annotations,
  };
}

interface DoseDefinition {
  field: string;
  metricId: string;
  unit: string;
  threshold: RunDriftThreshold;
  definitionSource: string;
}

function doseDefinition(state: unknown): DoseDefinition | undefined {
  const research = object(object(state)?.research);
  const schema = object(research?.resultSchema);
  const hasSchemaExtension = Boolean(schema && Object.hasOwn(schema, DRIFT_SCHEMA_KEY));
  const extension = object(schema?.[DRIFT_SCHEMA_KEY]);
  const declared = object(extension?.researchDose);
  if (!declared && !hasSchemaExtension) {
    const brief = text(object(state)?.taskDescription);
    if (!brief) return undefined;
    const pattern = /\*\*Graded floor:\*\*\s*`([A-Za-z][A-Za-z0-9_.-]{0,80})\s*(>=|>)\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s+([A-Za-z][A-Za-z0-9 _/-]{0,60})`\./gu;
    const matches = [...brief.matchAll(pattern)].filter((match) => /dose/iu.test(match[1]));
    if (matches.length !== 1) return undefined;
    const [, metricId, operator, numeric, rawUnit] = matches[0];
    const thresholdValue = Number(numeric);
    const unit = rawUnit.trim().replaceAll(/\s+/g, ' ');
    if (!Number.isFinite(thresholdValue) || thresholdValue < 0 || !unit) return undefined;
    const definitionSource = 'run.json#taskDescription[mechanically-derived graded floor]';
    return {
      field: metricId,
      metricId,
      unit,
      threshold: {
        kind: 'floor',
        operator: operator as '>=' | '>',
        value: thresholdValue,
        unit,
        display: `${operator} ${thresholdValue}`,
        source: definitionSource,
      },
      definitionSource,
    };
  }
  const field = text(declared?.field);
  const metricId = text(declared?.metricId);
  const unit = text(declared?.unit);
  const properties = object(schema?.properties);
  const property = field ? object(properties?.[field]) : undefined;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if (!field || !metricId || !unit || property?.type !== 'number' || !required.includes(field)) return undefined;

  const rawThreshold = object(declared!.threshold);
  const thresholdValue = finite(rawThreshold?.value);
  const operator = text(rawThreshold?.operator);
  const kind = text(rawThreshold?.kind);
  const validOperator = operator === '>=' || operator === '>' || operator === '<=' || operator === '<';
  const validKind = kind === 'floor' || kind === 'expectation';
  const threshold: RunDriftThreshold = validOperator && validKind && thresholdValue !== undefined
    ? {
        kind,
        operator,
        value: thresholdValue,
        unit,
        display: `${operator} ${thresholdValue}`,
        source: text(rawThreshold?.source)
          ?? `run.json#research.resultSchema.${DRIFT_SCHEMA_KEY}.researchDose.threshold`,
      }
    : unavailableThreshold(unit, `run.json#research.resultSchema.${DRIFT_SCHEMA_KEY}.researchDose.threshold`);
  return {
    field,
    metricId,
    unit,
    threshold,
    definitionSource: `run.json#research.resultSchema.${DRIFT_SCHEMA_KEY}.researchDose`,
  };
}

function researchDoseRow(state: unknown, runDirectory?: string): RunDriftRow {
  const definition = doseDefinition(state);
  if (!definition) {
    return unavailableRow(
      'research_dose',
      'Research dose and trend',
      'unknown',
      unavailableThreshold('unknown', `run.json#research.resultSchema.${DRIFT_SCHEMA_KEY}.researchDose`),
      `run.json#research.resultSchema.${DRIFT_SCHEMA_KEY}.researchDose`,
      object(object(state)?.research) ? 'legacy' : 'missing',
      ['typed dose-to-round linkage is absent; research prose and mutable latest-round files were not parsed'],
    );
  }
  if (!runDirectory) {
    return unavailableRow(
      'research_dose',
      'Research dose and trend',
      definition.unit,
      definition.threshold,
      'research_journal.json + research_round_<n>_consumed.json',
      'missing',
      ['durable round directory was not supplied'],
    );
  }

  const journal = readJsonObject(join(runDirectory, 'research_journal.json'));
  const rounds = Array.isArray(journal.value?.rounds) ? journal.value.rounds : undefined;
  if (journal.availability !== 'read' || !rounds) {
    return unavailableRow(
      'research_dose',
      'Research dose and trend',
      definition.unit,
      definition.threshold,
      'research_journal.json',
      journal.availability,
      ['scheduler-owned immutable round journal is unavailable'],
    );
  }

  const selected = rounds.slice(-MAX_RESEARCH_ROUNDS);
  const offset = rounds.length - selected.length;
  const values: number[] = [];
  const missingRounds: number[] = [];
  let latestObservation: FileObservation | undefined;
  for (let localIndex = 0; localIndex < selected.length; localIndex++) {
    const roundIndex = offset + localIndex + 1;
    const round = object(selected[localIndex]);
    const expectedLabel = text(round?.label);
    const noCandidate = round?.outcome === 'no_candidate';
    const preferred = join(
      runDirectory,
      `research_round_${roundIndex}_${noCandidate ? 'no_candidate_' : ''}consumed.json`,
    );
    const alternate = join(
      runDirectory,
      `research_round_${roundIndex}_${noCandidate ? '' : 'no_candidate_'}consumed.json`,
    );
    const result = existsSync(preferred) ? readJsonObject(preferred) : readJsonObject(alternate);
    const value = finite(result.value?.[definition.field]);
    const label = text(result.value?.label);
    if (result.availability !== 'read' || value === undefined || !expectedLabel || label !== expectedLabel) {
      missingRounds.push(roundIndex);
      continue;
    }
    values.push(value);
    latestObservation = result.observation;
  }

  if (values.length === 0) {
    return unavailableRow(
      'research_dose',
      'Research dose and trend',
      definition.unit,
      definition.threshold,
      'research_journal.json + research_round_<n>_consumed.json',
      missingRounds.length > 0 ? 'malformed' : 'missing',
      ['no journal-labelled consumed round carried the required finite typed dose'],
    );
  }
  const latest = values.at(-1)!;
  const partial = missingRounds.length > 0 || rounds.length > MAX_RESEARCH_ROUNDS;
  return {
    id: 'research_dose',
    label: 'Research dose and trend',
    value: latest,
    comparisonValue: latest,
    unit: definition.unit,
    threshold: definition.threshold,
    source: source(
      partial ? 'partial' : 'read',
      'research_journal.json + research_round_<n>_consumed.json',
      latestObservation ?? journal.observation,
    ),
    crossing: compare(latest, definition.threshold.value),
    distribution: distribution(values, latest),
    trend: trend(values, definition.unit),
    annotations: [
      `metric=${definition.metricId}`,
      `definition=${definition.definitionSource}`,
      `rounds=${values.length}/${rounds.length}`,
      ...(missingRounds.length > 0 ? [`unavailable_rounds=${missingRounds.join(',')}`] : []),
      ...(rounds.length > MAX_RESEARCH_ROUNDS ? [`bounded_to_latest=${MAX_RESEARCH_ROUNDS}`] : []),
      ...(definition.threshold.kind === 'expectation' ? ['expectation is advisory, not a hard floor'] : []),
    ],
  };
}

function eventsAsObjects(events: readonly unknown[]): JsonObject[] {
  const objects: JsonObject[] = [];
  for (const event of events.slice(-MAX_EVENT_ROWS)) {
    const parsed = object(event);
    if (parsed) objects.push(parsed);
  }
  return objects;
}

function firstPlanAdmissionRow(events: readonly JsonObject[], runDirectory?: string): RunDriftRow {
  const threshold: RunDriftThreshold = {
    kind: 'target',
    operator: '=',
    value: 1,
    unit: 'accepted(1=yes)',
    display: 'accepted on attempt 1',
    source: 'fail-closed plan admission invariant',
  };
  if (runDirectory) {
    const state = readJsonObject(join(runDirectory, 'plan_retry_state.json'));
    const attempts = Array.isArray(state.value?.attempts) ? state.value.attempts : undefined;
    if (state.availability === 'read' && attempts) {
      const records: JsonObject[] = [];
      for (const attempt of attempts) {
        const record = object(attempt);
        if (record) records.push(record);
      }
      const first = records.find((attempt) => integer(attempt.attemptIndex) === 1);
      if (first) {
        const disposition = text(first.disposition);
        const admitted = disposition === 'admitted';
        const later = records.find((attempt) => (
          (integer(attempt.attemptIndex) ?? 0) > 1 && text(attempt.disposition) === 'admitted'
        ));
        const unsatisfied = Array.isArray(first.unsatisfied) ? first.unsatisfied.length : undefined;
        return {
          id: 'first_plan_admission',
          label: 'First-plan admission',
          value: admitted ? 'accepted' : 'rejected',
          comparisonValue: admitted ? 1 : 0,
          unit: 'admission outcome',
          threshold,
          source: source('read', 'plan_retry_state.json#attempts[attemptIndex=1]', state.observation),
          crossing: compare(admitted ? 1 : 0, 1),
          annotations: [
            ...(unsatisfied === undefined ? [] : [`unsatisfied_requirements=${unsatisfied}`]),
            ...(later ? [`later_admitted_attempt=${integer(later.attemptIndex)}`] : []),
          ],
        };
      }
    }
    if (state.availability === 'malformed') {
      return unavailableRow(
        'first_plan_admission',
        'First-plan admission',
        'admission outcome',
        threshold,
        'plan_retry_state.json',
        'malformed',
        ['attempt-1 admission outcome was not inferred from malformed state'],
      );
    }
  }

  const firstRejected = events.find((event) => (
    text(event.type) === 'admission_rejected' && integer(event.attemptIndex) === 1
  ));
  if (firstRejected) {
    return {
      id: 'first_plan_admission',
      label: 'First-plan admission',
      value: 'rejected',
      comparisonValue: 0,
      unit: 'admission outcome',
      threshold,
      source: source(
        'read',
        'events.jsonl#admission_rejected[attemptIndex=1]',
        undefined,
        text(firstRejected.eventId),
        text(firstRejected.timestamp),
      ),
      crossing: 'below',
      annotations: ['later admission outcome unavailable without plan_retry_state.json'],
    };
  }
  const legacyRejection = events.find((event) => text(event.type) === 'admission_rejected');
  return unavailableRow(
    'first_plan_admission',
    'First-plan admission',
    'admission outcome',
    threshold,
    legacyRejection ? 'events.jsonl#admission_rejected' : 'plan_retry_state.json',
    legacyRejection ? 'legacy' : 'missing',
    [legacyRejection
      ? 'legacy rejection lacks an attempt index; first-plan outcome was not guessed'
      : 'no attempt-1 admission evidence'],
  );
}

function stageCompletionTimes(state: unknown, events: readonly JsonObject[]): Map<string, number[]> {
  const times = new Map<string, number[]>();
  const add = (stageId: string | undefined, at: number | undefined) => {
    if (!stageId || at === undefined) return;
    const entries = times.get(stageId) ?? [];
    entries.push(at);
    times.set(stageId, entries);
  };
  for (const event of events) {
    if (text(event.type) === 'stage_complete') add(text(event.stageId), timestampMs(event.timestamp));
  }
  const addStages = (rawStages: unknown) => {
    const stages = object(rawStages);
    if (!stages) return;
    for (const [stageId, rawStage] of Object.entries(stages)) {
      const stage = object(rawStage);
      add(stageId, timestampMs(stage?.completedAt));
      if (!Array.isArray(stage?.attempts)) continue;
      for (const rawAttempt of stage.attempts) add(stageId, timestampMs(object(rawAttempt)?.completedAt));
    }
  };
  addStages(object(state)?.stages);
  const retired = object(state)?.retiredStageUsage;
  if (Array.isArray(retired)) {
    for (const rawUsage of retired) {
      const usage = object(rawUsage);
      const stageId = text(usage?.stageId);
      const stage = object(usage?.status);
      add(stageId, timestampMs(stage?.completedAt));
      if (Array.isArray(stage?.attempts)) {
        for (const rawAttempt of stage.attempts) add(stageId, timestampMs(object(rawAttempt)?.completedAt));
      }
    }
  }
  return times;
}

function typedSupervisorRejectBudget(state: unknown): number | undefined {
  const attempts = object(object(state)?.supervisor)?.attempts;
  if (!Array.isArray(attempts)) return undefined;
  for (const rawAttempt of [...attempts].reverse()) {
    const trigger = object(object(rawAttempt)?.trigger);
    const quantities = object(trigger?.quantities);
    const maximum = finite(object(quantities?.supervisorRejectBudget)?.maximum);
    if (maximum !== undefined && maximum >= 0) return maximum;
  }
  return undefined;
}

function legacySupervisorRejectBudget(events: readonly JsonObject[]): number | undefined {
  const values = new Set<number>();
  for (const event of events) {
    if (text(event.type) !== 'supervisor_reject') continue;
    const match = /^reject\s+\d+\/(\d+):/i.exec(text(event.detail) ?? '');
    if (match) values.add(Number(match[1]));
  }
  return values.size === 1 ? [...values][0] : undefined;
}

function supervisorRejectionRow(state: unknown, events: readonly JsonObject[], runDirectory?: string): RunDriftRow {
  const countsPath = runDirectory ? join(runDirectory, 'signals', 'reject_counts.json') : undefined;
  const counts = countsPath ? readJsonObject(countsPath) : undefined;
  const perStage = new Map<string, number>();
  if (counts?.availability === 'read') {
    for (const [stageId, rawCount] of Object.entries(counts.value ?? {}).slice(0, 1_000)) {
      const count = integer(rawCount);
      if (count !== undefined && count >= 0) perStage.set(stageId, count);
    }
  }
  const rejectionEvents = events.filter((event) => text(event.type) === 'supervisor_reject');
  if (perStage.size === 0) {
    for (const event of rejectionEvents) {
      const stageId = text(event.stageId);
      if (stageId) perStage.set(stageId, (perStage.get(stageId) ?? 0) + 1);
    }
  }
  const total = [...perStage.values()].reduce((sum, count) => sum + count, 0);
  const maxPerStage = perStage.size > 0 ? Math.max(...perStage.values()) : undefined;
  const completions = stageCompletionTimes(state, events);
  const overturned = rejectionEvents.filter((event) => {
    const stageId = text(event.stageId);
    const rejectedAt = timestampMs(event.timestamp);
    return Boolean(stageId && rejectedAt !== undefined
      && completions.get(stageId)?.some((completedAt) => completedAt > rejectedAt));
  }).length;
  const typedBudget = typedSupervisorRejectBudget(state);
  const legacyBudget = typedBudget === undefined ? legacySupervisorRejectBudget(events) : undefined;
  const budget = typedBudget ?? legacyBudget;
  const threshold: RunDriftThreshold = budget === undefined
    ? unavailableThreshold('rejections/stage', 'typed supervisor triggering event')
    : {
        kind: 'budget',
        operator: '<=',
        value: budget,
        unit: 'rejections/stage',
        display: `<= ${budget} per stage`,
        source: typedBudget === undefined
          ? 'legacy canonical supervisor_reject event detail'
          : 'supervisor trigger quantities.supervisorRejectBudget.maximum',
      };
  if (maxPerStage === undefined) {
    return unavailableRow(
      'supervisor_rejections',
      'Supervisor rejections and overturns',
      'rejections/stage',
      threshold,
      countsPath ? 'signals/reject_counts.json + events.jsonl' : 'events.jsonl',
      counts?.availability === 'malformed' ? 'malformed' : 'missing',
      ['no durable rejection count was treated as zero'],
    );
  }
  const coverage = rejectionEvents.length >= total ? 'read' : 'partial';
  const latestEvent = rejectionEvents.at(-1);
  return {
    id: 'supervisor_rejections',
    label: 'Supervisor rejections and overturns',
    value: `${total} total; max ${maxPerStage}/stage; ${overturned} overturned`,
    comparisonValue: maxPerStage,
    unit: 'rejections/stage',
    threshold,
    source: source(
      typedBudget === undefined && budget !== undefined ? 'legacy' : coverage,
      countsPath ? 'signals/reject_counts.json + events.jsonl' : 'events.jsonl',
      counts?.observation,
      text(latestEvent?.eventId),
      text(latestEvent?.timestamp),
    ),
    crossing: compare(maxPerStage, budget),
    annotations: [
      `total_rejections=${total}`,
      `later_overturned=${overturned}`,
      `overturn_evidence=${rejectionEvents.length}/${total}`,
    ],
  };
}

interface OverheadSample {
  stageId: string;
  attemptIndex: number;
  completedAt: string;
  wallMs: number;
  adapterMs: number;
  overheadMs: number;
}

function overheadSamples(state: unknown): OverheadSample[] {
  const samples = new Map<string, OverheadSample>();
  const collect = (stageId: string | undefined, rawStatus: unknown) => {
    const status = object(rawStatus);
    if (!stageId || !Array.isArray(status?.attempts)) return;
    for (const rawAttempt of status.attempts) {
      const attempt = object(rawAttempt);
      const attemptIndex = integer(attempt?.index);
      const start = timestampMs(attempt?.startedAt);
      const end = timestampMs(attempt?.completedAt);
      const adapterMs = finite(attempt?.duration_ms);
      const completedAt = text(attempt?.completedAt);
      if (attemptIndex === undefined || start === undefined || end === undefined
        || adapterMs === undefined || !completedAt || end < start) continue;
      const wallMs = end - start;
      const sample = { stageId, attemptIndex, completedAt, wallMs, adapterMs, overheadMs: wallMs - adapterMs };
      samples.set(`${stageId}\0${attemptIndex}\0${String(attempt!.startedAt)}`, sample);
    }
  };
  const stages = object(object(state)?.stages);
  for (const [stageId, status] of Object.entries(stages ?? {})) collect(stageId, status);
  const retired = object(state)?.retiredStageUsage;
  if (Array.isArray(retired)) {
    for (const rawUsage of retired) {
      const usage = object(rawUsage);
      collect(text(usage?.stageId), usage?.status);
    }
  }
  return [...samples.values()]
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt))
    .slice(-MAX_OVERHEAD_SAMPLES);
}

function engineOverheadRow(state: unknown, stateObservation?: FileObservation): RunDriftRow {
  const threshold: RunDriftThreshold = {
    kind: 'warning',
    operator: '<=',
    value: OVERHEAD_WARNING_MS,
    unit: 'ms/attempt',
    display: `<= ${OVERHEAD_WARNING_MS}`,
    source: 'closed-loop operator warning threshold',
  };
  const samples = overheadSamples(state);
  if (samples.length === 0) {
    return unavailableRow(
      'engine_overhead',
      'Engine overhead per attempt',
      'ms/attempt',
      threshold,
      'run.json#stages[*].attempts',
      object(state) ? 'missing' : 'malformed',
      ['requires settled attempt startedAt/completedAt/duration_ms operands'],
    );
  }
  const values = samples.map((sample) => sample.overheadMs);
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const reported = ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
  const stats = distribution(values, reported)!;
  const latest = samples.at(-1)!;
  return {
    id: 'engine_overhead',
    label: 'Engine overhead per attempt',
    value: reported,
    comparisonValue: reported,
    unit: 'ms/attempt',
    threshold,
    source: source('read', 'run.json#stages[*].attempts', stateObservation),
    crossing: compare(reported, OVERHEAD_WARNING_MS),
    distribution: stats,
    annotations: [
      'raw=attempt wall span - adapter duration; negative values are retained',
      `latest_operands=${latest.stageId}#${latest.attemptIndex}:${latest.wallMs}-${latest.adapterMs}`,
      ...(samples.length === MAX_OVERHEAD_SAMPLES ? [`bounded_to_latest=${MAX_OVERHEAD_SAMPLES}`] : []),
    ],
  };
}

function countRegistryRecords(path: string, bytesToScan: number): { records: number; exact: boolean } {
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  let records = 0;
  let lineHasContent = false;
  try {
    while (offset < bytesToScan) {
      const wanted = Math.min(buffer.length, bytesToScan - offset);
      const bytesRead = readSync(fd, buffer, 0, wanted, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      for (let index = 0; index < bytesRead; index++) {
        const byte = buffer[index];
        if (byte === 0x0a) {
          if (lineHasContent) records += 1;
          lineHasContent = false;
        } else if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) {
          lineHasContent = true;
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  const exact = offset === regularFile(path)?.size;
  if (exact && lineHasContent) records += 1;
  return { records, exact };
}

function readRegistryTailTaskRefs(path: string, size: number): Map<string, RegistryTaskRef> {
  const refs = new Map<string, RegistryTaskRef>();
  const start = Math.max(0, size - MAX_REGISTRY_TAIL_BYTES);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    let value = buffer.subarray(0, bytesRead).toString('utf-8');
    if (start > 0) {
      const newline = value.indexOf('\n');
      value = newline < 0 ? '' : value.slice(newline + 1);
    }
    for (const line of value.split(/\r?\n/).slice(-20_000)) {
      if (!line.trim()) continue;
      try {
        const row = object(JSON.parse(line) as unknown);
        const runId = text(row?.run_id);
        const unit = text(row?.systemd_unit);
        if (runId && unit) refs.set(runId, { runId, unit });
      } catch { /* malformed registry rows do not become routing facts */ }
    }
  } finally {
    closeSync(fd);
  }
  return refs;
}

function readRegistryObservation(path: string): RegistryObservation | undefined {
  const observation = regularFile(path);
  if (!observation) return undefined;
  if (registryCache
    && registryCache.path === path
    && registryCache.size === observation.size
    && registryCache.mtimeMs === observation.mtimeMs) return registryCache.value;
  const bytesToScan = Math.min(observation.size, MAX_REGISTRY_SCAN_BYTES);
  const counted = countRegistryRecords(path, bytesToScan);
  const value: RegistryObservation = {
    ...observation,
    records: counted.records,
    recordsExact: counted.exact,
    taskRefs: readRegistryTailTaskRefs(path, observation.size),
  };
  registryCache = { path, size: observation.size, mtimeMs: observation.mtimeMs, value };
  return value;
}

function registryCrossing(registry: RegistryObservation): RunDriftCrossing {
  const byteCrossing = compare(registry.size, REGISTRY_COMPACTION_THRESHOLDS.bytes);
  const recordCrossing = compare(registry.records, REGISTRY_COMPACTION_THRESHOLDS.records);
  if (byteCrossing === 'above' || recordCrossing === 'above') return 'above';
  if (byteCrossing === 'at' || recordCrossing === 'at') return 'at';
  return 'below';
}

function registryGrowthRow(registry: RegistryObservation | undefined, registryPath: string): RunDriftRow {
  const threshold: RunDriftThreshold = {
    kind: 'warning',
    operator: '>=',
    value: REGISTRY_COMPACTION_THRESHOLDS.bytes,
    unit: 'bytes (or records)',
    display: `>= ${REGISTRY_COMPACTION_THRESHOLDS.bytes} bytes OR >= ${REGISTRY_COMPACTION_THRESHOLDS.records} records`,
    source: 'task-registry.REGISTRY_COMPACTION_THRESHOLDS',
  };
  if (!registry) {
    return unavailableRow(
      'registry_growth',
      'Registry growth',
      'bytes',
      threshold,
      registryPath,
      existsSync(registryPath) ? 'malformed' : 'missing',
      ['a missing or non-regular registry was not treated as zero bytes'],
    );
  }
  const recordDisplay = registry.recordsExact ? String(registry.records) : `>=${registry.records}`;
  return {
    id: 'registry_growth',
    label: 'Registry growth',
    value: `${registry.size} bytes; ${recordDisplay} records`,
    comparisonValue: registry.size,
    unit: 'bytes + records',
    threshold,
    source: source(registry.recordsExact ? 'read' : 'partial', registry.path, registry),
    crossing: registryCrossing(registry),
    distribution: distribution([registry.size], registry.size),
    annotations: [
      registry.recordsExact ? 'record_count=exact' : `record_count=lower_bound_after_${MAX_REGISTRY_SCAN_BYTES}_bytes`,
      'registry total is shown because no run-start byte baseline is durably emitted',
    ],
  };
}

function logGrowthRow(runDirectory: string | undefined, registry: RegistryObservation | undefined, runId: string | undefined): RunDriftRow {
  const threshold: RunDriftThreshold = {
    kind: 'warning',
    operator: '>=',
    value: LOG_WARNING_BYTES,
    unit: 'bytes',
    display: `>= ${LOG_WARNING_BYTES}`,
    source: 'closed-loop run/service-log warning threshold',
  };
  if (!runDirectory) {
    return unavailableRow('log_growth', 'Run/service log growth', 'bytes', threshold, 'run/service log', 'missing');
  }
  const fcRoot = dirname(dirname(resolve(runDirectory)));
  const unit = runId ? registry?.taskRefs.get(runId)?.unit : undefined;
  const portablePath = unit ? supervisionPaths(fcRoot, unit).log : undefined;
  const fallbackPath = join(runDirectory, 'supervisor_log.md');
  const selected = portablePath && regularFile(portablePath)
    ? regularFile(portablePath)
    : regularFile(fallbackPath);
  if (!selected) {
    return unavailableRow(
      'log_growth',
      'Run/service log growth',
      'bytes',
      threshold,
      portablePath ?? fallbackPath,
      'missing',
      [unit ? 'mapped service log is unavailable' : 'registry tail does not map this run to a service unit'],
    );
  }
  return {
    id: 'log_growth',
    label: 'Run/service log growth',
    value: selected.size,
    comparisonValue: selected.size,
    unit: 'bytes',
    threshold,
    source: source('read', selected.path, selected),
    crossing: compare(selected.size, LOG_WARNING_BYTES),
    distribution: distribution([selected.size], selected.size),
    annotations: [selected.path === portablePath ? 'source=portable service log' : 'source=run supervisor log'],
  };
}

function readEventTail(runDirectory: string): { events: JsonObject[]; coverage: 'read' | 'missing' | 'unreadable' } {
  const path = join(runDirectory, 'events.jsonl');
  const observation = regularFile(path);
  if (!observation) return { events: [], coverage: existsSync(path) ? 'unreadable' : 'missing' };
  const start = Math.max(0, observation.size - MAX_EVENT_TAIL_BYTES);
  let value: string;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(observation.size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    value = buffer.subarray(0, bytesRead).toString('utf-8');
  } catch {
    return { events: [], coverage: 'unreadable' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (start > 0) {
    const newline = value.indexOf('\n');
    value = newline < 0 ? '' : value.slice(newline + 1);
  }
  const events: JsonObject[] = [];
  for (const line of value.split(/\r?\n/).filter(Boolean).slice(-MAX_EVENT_ROWS)) {
    try {
      const parsed = object(JSON.parse(line) as unknown);
      if (parsed) events.push(parsed);
    } catch { /* malformed tail rows are omitted, never interpreted */ }
  }
  return { events, coverage: 'read' };
}

function resolveState(runDirectory: string | undefined, supplied: unknown): unknown {
  if (supplied !== undefined || !runDirectory) return supplied;
  return readJsonObject(join(runDirectory, 'run.json')).value;
}

/**
 * Pure, bounded projection for callers which already own state/event bytes. Filesystem-backed
 * quantities remain visibly unavailable rather than being guessed.
 */
export function buildRunDriftProjection(
  state: unknown,
  events: readonly unknown[] = [],
): RunDriftProjection {
  const eventObjects = eventsAsObjects(events);
  return {
    version: 1,
    rows: [
      researchDoseRow(state),
      firstPlanAdmissionRow(eventObjects),
      supervisorRejectionRow(state, eventObjects),
      engineOverheadRow(state),
      registryGrowthRow(undefined, 'tasks.jsonl'),
      logGrowthRow(undefined, undefined, text(object(state)?.runId)),
    ],
  };
}

/** Read only fixed, bounded run artifacts and filesystem metadata; never writes a cursor or action. */
export function readRunDriftProjection(
  runDirectory: string,
  options: RunDriftReadOptions = {},
): RunDriftProjection {
  const stateObservation = regularFile(join(runDirectory, 'run.json'));
  const state = resolveState(runDirectory, options.state);
  const eventRead = options.events === undefined
    ? readEventTail(runDirectory)
    : { events: eventsAsObjects(options.events), coverage: options.eventsCoverage ?? 'read' as const };
  const events = eventRead.events;
  const registryPath = options.registryPath ?? join(dirname(dirname(resolve(runDirectory))), 'tasks.jsonl');
  const registry = readRegistryObservation(registryPath);
  return {
    version: 1,
    rows: [
      researchDoseRow(state, runDirectory),
      firstPlanAdmissionRow(events, runDirectory),
      supervisorRejectionRow(state, events, runDirectory),
      engineOverheadRow(state, stateObservation),
      registryGrowthRow(registry, registryPath),
      logGrowthRow(runDirectory, registry, text(object(state)?.runId)),
    ].map((row) => eventRead.coverage === 'unreadable'
      && (row.id === 'first_plan_admission' || row.id === 'supervisor_rejections')
      && row.source.availability === 'missing'
      ? { ...row, source: { ...row.source, availability: 'malformed' as const }, annotations: [...row.annotations, 'events.jsonl is unreadable'] }
      : row),
  };
}

function compact(value: string, maximum = 240): string {
  const oneLine = value.replaceAll(/\s+/g, ' ').trim();
  return oneLine.length <= maximum ? oneLine : `${oneLine.slice(0, maximum - 3)}...`;
}

function numberText(value: number): string {
  return String(value);
}

/** One canonical row formatter shared byte-for-byte by status, watch, and task show. */
export function formatRunDriftRow(row: RunDriftRow): string {
  const value = row.value === null
    ? 'unavailable'
    : typeof row.value === 'number'
      ? numberText(row.value)
      : compact(row.value, 160);
  const threshold = compact(`${row.threshold.display} ${row.threshold.unit} (${row.threshold.kind}; ${row.threshold.source})`, 220);
  const sourceText = compact([
    `${row.source.reference} [${row.source.availability}]`,
    ...(row.source.observedAt ? [`observed=${row.source.observedAt}`] : []),
    ...(row.source.eventId ? [`event=${row.source.eventId}`] : []),
  ].join('; '), 320);
  const distributionText = row.distribution
    ? `; distribution=n=${row.distribution.sampleCount},mean=${numberText(row.distribution.mean)},median=${numberText(row.distribution.median)},reported-rank=${row.distribution.reportedRank}/${row.distribution.sampleCount},percentile=${numberText(row.distribution.reportedPercentile)}`
    : '';
  const trendText = row.trend
    ? `; trend=${row.trend.direction}[${row.trend.values.map(numberText).join(' -> ')}]`
    : '';
  const annotations = row.annotations.length > 0 ? `; notes=${compact(row.annotations.join(', '), 260)}` : '';
  return `Drift ${row.id}: value=${value}; unit=${row.unit}; threshold=${threshold}; source=${sourceText}; crossing=${row.crossing}${trendText}${distributionText}${annotations}`;
}

export function formatRunDriftProjection(projection: RunDriftProjection | undefined): string[] {
  return projection?.rows.map(formatRunDriftRow) ?? [];
}
