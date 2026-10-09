// Boundary: Initialize per-attempt metric evidence and build the existing gate instruction; share the archive coordinate type and receive archive paths.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GateArchiveCoordinate {
  iteration: number;
  round: number;
}

export function initializeGateMetricAttempt(
  runDirPath: string,
  stageId: string,
  iteration: number,
  round: number,
  technicalRetry: number,
): void {
  const metricDirectory = join(runDirPath, 'stages', stageId);
  const metricPath = join(metricDirectory, 'metric.json');
  mkdirSync(metricDirectory, { recursive: true });
  if (existsSync(metricPath)) unlinkSync(metricPath);
  writeFileSync(metricPath, JSON.stringify({
    version: 1,
    hasMetric: false,
    reason: 'This gate attempt did not supply a trustworthy numeric campaign metric.',
    source: {
      kind: 'engine_attempt_default',
      iteration,
      round,
      technicalRetry,
    },
  }, null, 2) + '\n', 'utf-8');
}

export interface GateArchiveServices {
  gateArchiveCoordinate(iteration: number, round: number): GateArchiveCoordinate;
  canonicalGateRoundArtifactDir(runDirPath: string, coordinate: GateArchiveCoordinate): string;
  archivedGateVerdictWritePath(runDirPath: string, coordinate: GateArchiveCoordinate, stageId: string): string;
}

export function createGateAttemptServices(services: Pick<GateArchiveServices, 'gateArchiveCoordinate' | 'archivedGateVerdictWritePath'>) {
  const { gateArchiveCoordinate, archivedGateVerdictWritePath } = services;

  function gateAttemptCoordinate(iteration: number, innerRetry?: number): GateArchiveCoordinate {
    return gateArchiveCoordinate(iteration, innerRetry === undefined ? 1 : innerRetry + 2);
  }

  function appendGateMetricInstruction(
    prompt: string,
    runDirPath: string,
    stageId: string,
    coordinate: GateArchiveCoordinate,
  ): string {
    const metricPath = join(runDirPath, 'stages', stageId, 'metric.json');
    const durableVerdictPath = archivedGateVerdictWritePath(runDirPath, coordinate, stageId);
    return `${prompt}

## Gate evidence
Return your verdict as the final JSON answer. The engine publishes
${join(runDirPath, `verdict_${stageId}.json`)} and archives a rejecting attempt.
Durable rejected-verdict citation: ${durableVerdictPath}

An optional trustworthy numeric campaign observation belongs at ${metricPath},
which the scheduler and campaign readers consume. Use:
${JSON.stringify({ hasMetric: true, metric: 'metric name', value: 0, higherIsBetter: true, threshold: null, pass: false, source: { path: 'checked evidence path', evidence: 'exact evidence' }, notes: 'explanation' })}
Write it only from a gate and only from checked evidence. Choose the primary
metric declared by the task or acceptance contract; never invent a score.
If no numeric observation exists, keep the engine's hasMetric:false default.
For a campaign phase also include phase, phaseComplete, nextPhase, outcome,
artifactSummary and reason in the verdict or metric. Values must be JSON numbers.
The verdict remains the one independent review; metric agreement and contracted
thresholds are enforced by the engine.`;
  }

  return { gateAttemptCoordinate, appendGateMetricInstruction };
}
