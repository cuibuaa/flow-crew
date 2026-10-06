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

## Gate Verdict Evidence Lifetime

Write the live verdict to ${join(runDirPath, `verdict_${stageId}.json`)}. If the verdict rejects,
the scheduler archives that exact attempt after evaluation. Reports must cite the durable archive,
not the live root path that a retry or later iteration clears.

Durable rejected-verdict citation: ${durableVerdictPath}

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

  return { gateAttemptCoordinate, appendGateMetricInstruction };
}
