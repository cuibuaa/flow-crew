// Boundary: Canonical iteration/round coordinates, archived-record reads, evidence copies and gate framing; no live verdict policy or provider execution.
import { copyFileSync, mkdirSync, writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence } from '../../evidence-ledger.js';
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

/** Frame a gate's evaluation, and name any blocker reported by the authors it reviews (by default its fix stages). */
export function buildGateDispatchPreamble(input: Parameters<typeof gateEvaluationFraming>[0] & { authorIds?: readonly string[] }): string {
  const authors = input.authorIds ?? input.fixStageIds ?? [];
  const blocked = readEvidence(input.runDirPath).some(entry => entry.kind === 'declaration' && authors.includes(entry.stageId));
  return [gateEvaluationFraming(input), ...(blocked ? [
    'REPORTED BLOCKER: unverified author declarations and declared checks are recorded in the evidence ledger. Judge each blocker from your own reproduction.',
    'A confirmed blocker does not establish irreparability. If a repair or accepted scope revision can resolve it, reject with repairability "repairable" and findings showing that route. Engine enforcement or a scope denial alone is not evidence that delivery is impossible.',
    'Use repairability "irreparable" only with reproduced evidence that no available repair can meet the brief. Pass only when every assigned criterion holds, including any explicitly permitted blocked outcome.',
  ] : [])].join('\n\n');
}

/** An author may answer "blocked" instead of delivering; its gate is the independent check of that claim. */
function gateEvaluationFraming(input: {
  runDirPath: string;
  gateId: string;
  evaluationRound: number;
  priorAttemptCount: number;
  fixStageIds?: string[];
  roundDiffPath?: string;
  interruptedInputPath?: string;
  interruptedOutputPath?: string;
}): string {
  const rejections = archivedGateRejections(input.runDirPath, input.gateId);
  const latest = rejections.at(-1);
  if (!latest) {
    const liveVerdictPass = readWrittenVerdictPass(join(input.runDirPath, `verdict_${input.gateId}.json`));
    if (liveVerdictPass === true) {
      return [
        `INITIAL EVALUATION (round ${input.evaluationRound}): A prior passing verdict exists for gate ${input.gateId}, but no durable rejected verdict exists.`,
        'Run a complete initial evaluation; a passing decision is not a rejected decision to reproduce or repair.',
      ].join('\n');
    }
    if (input.priorAttemptCount > 0) {
      return [
        `INTERRUPTED EVALUATION (round ${input.evaluationRound}): A prior execution ended without a durable rejected verdict; run the gate as an initial evaluation, not as a re-evaluation of a rejection.`,
        '',
        `Use the evidence ledger and current diff in ${input.runDirPath}; prior transcripts are not decision input.`,
        'No rejected verdict was recorded, so there is no prior decision to reproduce or repair.',
        'Review as a first evaluation: check every assigned criterion against the change in proportion to its size and risk. The engine records configured validation once per author attempt; consume the ledger without rerunning it.',
      ].join('\n');
    }
    return [
      `FIRST EVALUATION (round ${input.evaluationRound}): No prior execution or durable rejected verdict exists for gate ${input.gateId}.`,
      'Check every assigned criterion against the change in proportion to its size and risk. The engine records configured validation once per author attempt; consume the ledger without rerunning it.',
    ].join('\n');
  }

  return [
    `RE-EVALUATION (round ${input.evaluationRound}): Continue the same gate's audit after a durable rejection.`,
    '',
    'Evidence you must read:',
    `- Rejected verdict: ${latest.verdictPath}`,
    `- The engine's own conclusion and rejection reason: ${latest.effectiveVerdictPath}`,
    '  If that file shows engine_effective_pass=false while written_verdict_pass=true, the',
    '  verdict file is not the defect — engine_rejection_reason names what the engine',
    '  objected to, and that is what must change.',
    ...(existsSync(latest.metricPath) ? [`- Historical metric artifact: ${latest.metricPath}`] : []),
    ...(input.roundDiffPath
      ? [`- Complete, untruncated repair-round diff: ${input.roundDiffPath}`]
      : ['- Complete repair-round diff: inspect the evidence ledger and current repository diff.']),
    '',
    'Check each rejected finding against the repair diff, and re-check earlier conclusions only where the diff touches them. Consume the repair attempt\'s configured validation from the ledger without rerunning it.',
    'Reject again only for a rejected finding the repair did not resolve, a regression the repair introduced, or a failure that a user of the outcome the brief describes would meet; record any other difference you find as a stated limitation in the verdict and pass.',
    'Do not treat a repair summary or the existence of changed code as proof.',
  ].join('\n');
}

export function buildGateFixCorrectionContract(
  runDirPath: string,
  gateIds: string[],
  coordinate: GateArchiveCoordinate,
): string {
  return [
    `Gate repair round ${coordinate.round}: resolve the structured rejected findings.`,
    ...gateIds.map(gateId => `- Gate ${gateId}: archived rejected verdict: ${gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'verdict')}`),
    `Retained facts: ${join(runDirPath, 'evidence-ledger.jsonl')}; inspect the current diff.`,
    'A fresh independent gate will check the repair and every still-required criterion. If the rejection was mistaken, supply a reproducible counterexample in declared evidence. Never treat an author summary as proof.',
  ].join('\n');
}
