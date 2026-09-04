import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoricalSupervisorReplayCall } from '../../src/supervisor-events.js';

export interface MeasurementDistribution {
  name: string;
  unit: string;
  phase: 'before' | 'after';
  samples: number[];
  sampleCount: number;
  mean: number;
  median: number;
  reportedValue: number;
  reportedRank: number;
  reportedPercentile: number;
  percentileMethod: string;
  within_expected_range: boolean;
  method_was_not_adjusted_to_match_expectation: boolean;
}

export interface ClosedLoopEngineEvidence {
  version: 1;
  evidenceRunId: string;
  baseFailures: Record<'behavior1' | 'behavior2', {
    exitCode: number;
    logBytes: number;
    logSha256: string;
  }>;
  anchors: {
    historicalConstraintAudit: {
      sourcePath: string;
      bytes: number;
      sha256: string;
      slice: { label: string; byteStart: number; byteEndExclusive: number; sha256: string };
      unauthorizedPath: string;
      recordedElapsedMs: number;
      childCloseToAuditCompleteMs: number;
    };
    falseAbort1: { sourcePath: string; byteStart: number; byteEndExclusive: number; sha256: string };
    falseAbort2: { sourcePath: string; byteStart: number; byteEndExclusive: number; sha256: string };
    effectiveAbortSuppression: { sourcePath: string; byteStart: number; byteEndExclusive: number; sha256: string };
    replayInputSha256: string;
  };
  before: { calls: number; tokensIn: number; tokensOut: number; verdictCounts: Record<string, number> };
  finalHistoricalStateForDisclosure: { calls: number; tokensIn: number; tokensOut: number; verdictCounts: Record<string, number> };
  expectedCounterfactual: {
    calls: number;
    tokensInUsingHistoricalCallSizes: number;
    tokensOutUsingHistoricalCallSizes: number;
    caveat: string;
  };
  calls: HistoricalSupervisorReplayCall[];
  falseAborts: Array<HistoricalSupervisorReplayCall & {
    clockComparison: { stageElapsedMs: number; activeAttemptElapsedMs: number; activeAttemptId: string };
    expectedCurrentDisposition: string;
  }>;
}

export function loadClosedLoopEngineEvidence(): ClosedLoopEngineEvidence {
  const path = join(import.meta.dirname, '..', 'fixtures', 'closed-loop-engine-evidence.json');
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ClosedLoopEngineEvidence;
  if (parsed.version !== 1 || parsed.calls.length !== 120) {
    throw new Error('closed-loop engine evidence fixture is incomplete');
  }
  return parsed;
}

export function summarizeDistribution(input: {
  name: string;
  unit: string;
  phase: 'before' | 'after';
  samples: readonly number[];
  reportedValue?: number;
  withinExpectedRange?: boolean;
}): MeasurementDistribution {
  if (input.samples.length === 0 || input.samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error(`${input.name} requires at least one finite sample`);
  }
  const samples = [...input.samples];
  const ordered = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
  const reportedValue = input.reportedValue ?? median;
  const reportedRank = ordered.filter((sample) => sample < reportedValue).length;
  const equalCount = ordered.filter((sample) => sample === reportedValue).length;
  return {
    name: input.name,
    unit: input.unit,
    phase: input.phase,
    samples,
    sampleCount: samples.length,
    mean: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
    median,
    reportedValue,
    reportedRank,
    reportedPercentile: ((reportedRank + equalCount / 2) / samples.length) * 100,
    percentileMethod: 'midrank percentage; rank is zero-based count strictly below reportedValue',
    within_expected_range: input.withinExpectedRange ?? true,
    method_was_not_adjusted_to_match_expectation: true,
  };
}
