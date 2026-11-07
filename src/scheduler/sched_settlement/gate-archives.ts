// Boundary: Canonical iteration/round coordinates, archived-record reads, evidence copies and gate framing; no live verdict policy or provider execution.
import { copyFileSync, mkdirSync, writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GateRuntimeFacts } from './gate-recovery.js';
import { readArchivedRunStateFromDirectory, type GateVerdict } from '../../store.js';
import { latestInvocationInput } from '../../run-state-view.js';

export interface GateArchiveCoordinate { iteration: number; round: number }

export interface GateArchiveServices {
  gateArchiveCoordinate: typeof gateArchiveCoordinate;
  canonicalGateRoundArtifactDir: typeof canonicalGateRoundArtifactDir;
}

/** The archive owns attempt coordinates and the durable rejected-verdict citation. */
export function appendGateEvidenceInstruction(prompt: string, runDirPath: string, stageId: string, iteration: number, innerRetry?: number): string {
  const coordinate = gateArchiveCoordinate(iteration, innerRetry === undefined ? 1 : innerRetry + 2);
  return `${prompt}

## Gate evidence
Return your verdict as the final JSON answer. The engine publishes
${join(runDirPath, `verdict_${stageId}.json`)} and archives a rejecting attempt.
Durable rejected-verdict citation: ${archivedGateVerdictWritePath(runDirPath, coordinate, stageId)}
Accepting metric claims include value and metric; the contract owns the threshold. For campaign phase progress,
include phase, phaseComplete, nextPhase, outcome, artifactSummary and reason there.
Research comparisons use the research loop's own baseline and immutable round evidence.`;
}

export function gateArchiveCoordinate(iteration: number, round: number): GateArchiveCoordinate {
  if (!Number.isSafeInteger(iteration) || iteration < 1) {
    throw new Error(`Gate archive iteration must be a positive integer, got ${iteration}`);
  }
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new Error(`Gate archive round must be a positive integer, got ${round}`);
  }
  return { iteration, round };
}

export function gateReevaluationArchiveRoot(runDirPath: string): string {
  return join(runDirPath, 'gate_reevaluation');
}

export function canonicalGateRoundArtifactDir(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
): string {
  return join(
    gateReevaluationArchiveRoot(runDirPath),
    `iteration_${coordinate.iteration}`,
    `round_${coordinate.round}`,
  );
}

export function canonicalGateArchiveArtifactPath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  artifactName: string,
): string {
  return join(canonicalGateRoundArtifactDir(runDirPath, coordinate), artifactName);
}

const GATE_ARCHIVE_ARTIFACT_NAMES = {
  verdict: ['rejected_verdict', 'json'],
  effectiveVerdict: ['engine_verdict', 'json'],
  metric: ['metric', 'json'],
} as const;

export function gateArchiveArtifactPath(
  runDirPath: string, coordinate: GateArchiveCoordinate, gateId: string,
  artifact: keyof typeof GATE_ARCHIVE_ARTIFACT_NAMES | 'input' | 'output',
): string {
  if (artifact === 'input' || artifact === 'output') {
    try {
      const reference = JSON.parse(readFileSync(gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'effectiveVerdict'), 'utf8'));
      if (artifact === 'output') {
        // A replan already preserves attempt outputs before reusing stage indices.
        const retired = readArchivedRunStateFromDirectory(runDirPath).state.stageEvidence?.find(entry => entry.iteration === coordinate.iteration && entry.stageId === gateId);
        const output = retired?.attemptOutputPaths.find(entry => entry.attemptIndex === reference.attemptIndex);
        if (output) return join(runDirPath, output.path);
      }
      return reference[`${artifact}Path`] ?? '';
    } catch { return ''; }
  }
  const [prefix, extension] = GATE_ARCHIVE_ARTIFACT_NAMES[artifact];
  const artifactName = `${prefix}_${gateId}.${extension}`;
  return canonicalGateArchiveArtifactPath(runDirPath, coordinate, artifactName);
}

export function archivedGateVerdictWritePath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  gateId: string,
): string {
  return canonicalGateArchiveArtifactPath(runDirPath, coordinate, `rejected_verdict_${gateId}.json`);
}

export function archiveGateRoundEvidence(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  gateIds: string[],
  effectiveVerdicts?: Map<string, GateVerdict>,
): void {
  const artifactDir = canonicalGateRoundArtifactDir(runDirPath, coordinate);
  mkdirSync(artifactDir, { recursive: true });
  for (const gateId of gateIds) {
    const verdict = join(runDirPath, `verdict_${gateId}.json`);
    const stage = join(runDirPath, 'stages', gateId);
    let attempt: { index: number } | undefined;
    try { attempt = JSON.parse(readFileSync(join(stage, 'status.json'), 'utf8')).attempts?.at(-1); } catch { /* no completed attempt */ }
    const output = attempt ? join(stage, `output_attempt_${attempt.index}.md`) : '';
    const metric = join(runDirPath, 'stages', gateId, 'metric.json');
    const input = latestInvocationInput(runDirPath, gateId)?.path;
    try { if (existsSync(verdict)) copyFileSync(verdict, archivedGateVerdictWritePath(runDirPath, coordinate, gateId)); } catch { /* best effort */ }
    try { if (existsSync(metric)) copyFileSync(metric, gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'metric')); } catch { /* best effort */ }
    // The archived verdict is the file the gate WROTE. The engine can reject it
    // for reasons the file cannot show — a contract
    // violation — and a repair handed only the written file then sees `pass:
    // true` with nothing to fix, and burns the retry budget. Archive what the
    // engine concluded, and why, beside it.
    const effective = effectiveVerdicts?.get(gateId);
    try {
      writeFileSync(
          gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'effectiveVerdict'),
          JSON.stringify({
            gateId,
            attemptIndex: attempt?.index,
            outputPath: output,
            inputPath: input,
            written_verdict_pass: readWrittenVerdictPass(verdict),
            engine_effective_pass: effective?.pass ?? null,
            kind: effective?.refusal?.kind ?? (effective?.pass ? 'pass' : effective?.repairability?.disposition ?? 'repairable'),
            engine_rejection_reason: effective?.reason ?? null,
            ...(effective?.repairability ? { repairability: effective.repairability } : {}),
            note: 'The engine\'s conclusion. If engine_effective_pass is false while '
              + 'written_verdict_pass is true, the gate file is not the thing to fix — '
              + 'engine_rejection_reason is.',
          }, null, 2) + '\n',
          'utf-8',
        );
    } catch { /* best effort */ }
  }
}

export function archiveRejectedGateRuntimeFacts(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  facts: GateRuntimeFacts,
): void {
  if (facts.rejectedGateIds.length === 0) return;
  const rejected = new Set(facts.rejectedGateIds);
  archiveGateRoundEvidence(
    runDirPath,
    coordinate,
    facts.rejectedGateIds,
    new Map(
      facts.evaluations
        .filter((evaluation) => rejected.has(evaluation.id) && evaluation.effectiveVerdict)
        .map((evaluation) => [evaluation.id, evaluation.effectiveVerdict!] as const),
    ),
  );
}

export function readWrittenVerdictPass(verdictPath: string): boolean | null {
  try {
    const parsed = JSON.parse(readFileSync(verdictPath, 'utf-8')) as Record<string, unknown>;
    return typeof parsed.pass === 'boolean' ? parsed.pass : null;
  } catch {
    return null;
  }
}

export interface ArchivedGateRejection {
  iteration: number;
  round: number;
  verdictPath: string;
  outputPath: string;
  inputPath: string;
  metricPath: string;
  effectiveVerdictPath: string;
}

/** Enumerate the durable archive by gate identity, not by the dispatch route
 * that happens to be asking. Replans, restart recovery, gate rework and
 * bounded repair therefore all receive the same framing decision. */
export function archivedGateRejections(runDirPath: string, gateId: string): ArchivedGateRejection[] {
  const root = gateReevaluationArchiveRoot(runDirPath);
  const canonicalCoordinates: Array<{ iteration: number; round: number; directory: string }> = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const iteration = /^iteration_(\d+)$/.exec(entry.name);
      if (!iteration) continue;
      const iterationDir = join(root, entry.name);
      for (const roundEntry of readdirSync(iterationDir, { withFileTypes: true })) {
        const round = roundEntry.isDirectory() ? /^round_(\d+)$/.exec(roundEntry.name) : null;
        if (round) {
          canonicalCoordinates.push({
            iteration: Number(iteration[1]),
            round: Number(round[1]),
            directory: join(iterationDir, roundEntry.name),
          });
        }
      }
    }
  } catch { return []; }

  const rejectionsFor = (
    coordinates: Array<{ iteration: number; round: number; directory: string }>,
  ): ArchivedGateRejection[] => coordinates.flatMap(({ iteration, round, directory }) => {
    const verdictPath = join(directory, `rejected_verdict_${gateId}.json`);
    const effectiveVerdictPath = join(directory, `engine_verdict_${gateId}.json`);
    // The scheduler owns this basename and writes it only for a rejected gate.
    // Its preserved bytes may be pass:true when the engine rejected a metric
    // contradiction.
    const rejected = existsSync(verdictPath);
    if (!rejected) return [];
    return [{
      iteration,
      round,
      verdictPath,
      outputPath: gateArchiveArtifactPath(runDirPath, { iteration, round }, gateId, 'output'),
      inputPath: gateArchiveArtifactPath(runDirPath, { iteration, round }, gateId, 'input'),
      metricPath: join(directory, `metric_${gateId}.json`),
      effectiveVerdictPath,
    }];
  });
  return rejectionsFor(canonicalCoordinates)
    .sort((left, right) => left.iteration - right.iteration || left.round - right.round);
}

/** Gate and repair handoffs carry records, never earlier prompts or outputs.
 * Archives remain a read compatibility source for runs predating the ledger. */
export function buildGateDispatchPreamble(input: {
  runDirPath: string; gateId: string; evaluationRound: number; priorAttemptCount: number;
  authorIds?: readonly string[]; fixStageIds?: string[]; roundDiffPath?: string;
  interruptedInputPath?: string; interruptedOutputPath?: string;
}): string {
  return `# Gate evaluation facts\n${JSON.stringify({
    gateId: input.gateId, evaluationRound: input.evaluationRound,
    priorAttemptCount: input.priorAttemptCount,
    rejections: archivedGateRejections(input.runDirPath, input.gateId).map(rejection => rejectionRecord(rejection)),
    ...(input.roundDiffPath ? { repairDiffPath: input.roundDiffPath } : {}),
  })}\nCheck every assigned criterion against the current tree using your own experiments. Consume configured validation from the ledger without rerunning it. A reported blocker needs independent reproduction; it does not establish irreparability. Use repairability "irreparable" only with reproduced evidence that no available repair can meet the brief.
When structured rejections exist: Check each rejected finding against the repair diff, and re-check earlier conclusions only where the diff touches them. Consume the repair attempt's configured validation from the ledger without rerunning it.
Reject again only for a rejected finding the repair did not resolve, a regression the repair introduced, or a failure that a user of the outcome the brief describes would meet; record any other difference you find as a stated limitation in the verdict and pass.
The repairDiffPath names the complete, untruncated repair-round diff. With no structured rejection, run a complete initial evaluation.`;
}

function rejectionRecord(rejection: ArchivedGateRejection): object {
  return {
    iteration: rejection.iteration, round: rejection.round,
    verdictPath: rejection.verdictPath,
    effectiveVerdictPath: rejection.effectiveVerdictPath,
    ...(existsSync(rejection.metricPath) ? { metricPath: rejection.metricPath } : {}),
  };
}

export function buildGateFixCorrectionContract(
  runDirPath: string, gateIds: string[], coordinate: GateArchiveCoordinate,
): string {
  return `# Gate repair facts\n${JSON.stringify({ ...coordinate, gateIds,
    rejections: gateIds.flatMap(gateId => archivedGateRejections(runDirPath, gateId)
      .filter(rejection => rejection.iteration === coordinate.iteration && rejection.round === coordinate.round)
      .map(rejection => rejectionRecord(rejection))),
    ledgerPath: join(runDirPath, 'evidence-ledger.jsonl'),
  })}\nResolve the structured rejected findings against the current diff. A fresh independent gate checks every still-required criterion. If the rejection was mistaken, supply a reproducible counterexample in declared evidence.`;
}
