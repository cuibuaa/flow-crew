// Boundary: Canonical iteration/round coordinates, compatible archived-record reads, evidence copies and gate framing; no live verdict policy or provider execution.
import { GATE_VERDICT_CORRECTION_VERSION, gateVerdictCorrectionPath } from '../sched_admission/sessions.js';
import { GateArchiveCoordinate } from '../sched_scope/gate-attempt.js';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateRuntimeFacts } from './gate-recovery.js';
import type { GateVerdict } from '../../store.js';

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

export function legacyGateRoundArtifactDir(runDirPath: string, round: number): string {
  return join(gateReevaluationArchiveRoot(runDirPath), `round_${round}`);
}

export function hasIterationGateArchiveNamespace(runDirPath: string): boolean {
  const archiveRoot = gateReevaluationArchiveRoot(runDirPath);
  try {
    return readdirSync(archiveRoot, { withFileTypes: true })
      .some((entry) => /^iteration_\d+$/.test(entry.name));
  } catch {
    // Compatibility is allowed only when absence of an iteration namespace is
    // observable. An unreadable/non-directory archive root therefore fails closed.
    return existsSync(archiveRoot);
  }
}

export function canonicalGateArchiveArtifactPath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  artifactName: string,
): string {
  return join(canonicalGateRoundArtifactDir(runDirPath, coordinate), artifactName);
}

export function compatibleGateArchiveArtifactReadPath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  artifactName: string,
): string {
  const canonicalPath = canonicalGateArchiveArtifactPath(runDirPath, coordinate, artifactName);
  if (existsSync(canonicalPath) || hasIterationGateArchiveNamespace(runDirPath)) {
    return canonicalPath;
  }
  const legacyPath = join(legacyGateRoundArtifactDir(runDirPath, coordinate.round), artifactName);
  return existsSync(legacyPath) ? legacyPath : canonicalPath;
}

const GATE_ARCHIVE_ARTIFACT_NAMES = {
  verdict: ['rejected_verdict', 'json'],
  effectiveVerdict: ['engine_verdict', 'json'],
  metric: ['metric', 'json'],
  output: ['previous_output', 'md'],
  input: ['evaluated_input', 'md'],
} as const;

export function gateArchiveArtifactPath(
  runDirPath: string, coordinate: GateArchiveCoordinate, gateId: string,
  artifact: keyof typeof GATE_ARCHIVE_ARTIFACT_NAMES, access: 'read' | 'write',
): string {
  const [prefix, extension] = GATE_ARCHIVE_ARTIFACT_NAMES[artifact];
  const artifactName = `${prefix}_${gateId}.${extension}`;
  return access === 'read'
    ? compatibleGateArchiveArtifactReadPath(runDirPath, coordinate, artifactName)
    : canonicalGateArchiveArtifactPath(runDirPath, coordinate, artifactName);
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
    const perGateVerdict = join(runDirPath, `verdict_${gateId}.json`);
    const verdict = existsSync(perGateVerdict) ? perGateVerdict : join(runDirPath, 'verdict.json');
    const output = join(runDirPath, 'stages', gateId, 'output.md');
    const metric = join(runDirPath, 'stages', gateId, 'metric.json');
    const input = join(runDirPath, 'stages', gateId, 'input.md');
    try { if (existsSync(verdict)) copyFileSync(verdict, archivedGateVerdictWritePath(runDirPath, coordinate, gateId)); } catch { /* best effort */ }
    try { if (existsSync(output)) copyFileSync(output, gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'output', 'write')); } catch { /* best effort */ }
    try { if (existsSync(metric)) copyFileSync(metric, gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'metric', 'write')); } catch { /* best effort */ }
    try { if (existsSync(input)) copyFileSync(input, gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'input', 'write')); } catch { /* best effort */ }
    // The archived verdict is the file the gate WROTE. The engine can reject it
    // for reasons the file cannot show — a metric.json inconsistency, a contract
    // violation — and a repair handed only the written file then sees `pass:
    // true` with nothing to fix, and burns the retry budget. Archive what the
    // engine concluded, and why, beside it.
    const effective = effectiveVerdicts?.get(gateId);
    if (effective) {
      try {
        writeFileSync(
          gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'effectiveVerdict', 'write'),
          JSON.stringify({
            gateId,
            written_verdict_pass: readWrittenVerdictPass(verdict),
            engine_effective_pass: effective.pass,
            engine_rejection_reason: effective.reason ?? null,
            ...(effective.repairability ? { repairability: effective.repairability } : {}),
            note: 'The engine\'s conclusion. If engine_effective_pass is false while '
              + 'written_verdict_pass is true, the gate file is not the thing to fix — '
              + 'engine_rejection_reason is.',
          }, null, 2) + '\n',
          'utf-8',
        );
      } catch { /* best effort */ }
    }
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
 * that happens to be asking. Replans, restart recovery, supervisor rework and
 * bounded repair therefore all receive the same framing decision. */
export function archivedGateRejections(runDirPath: string, gateId: string): ArchivedGateRejection[] {
  const root = gateReevaluationArchiveRoot(runDirPath);
  const legacyCoordinates: Array<{ iteration: number; round: number; directory: string }> = [];
  const canonicalCoordinates: Array<{ iteration: number; round: number; directory: string }> = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const legacy = /^round_(\d+)$/.exec(entry.name);
      if (legacy) {
        legacyCoordinates.push({ iteration: 0, round: Number(legacy[1]), directory: join(root, entry.name) });
        continue;
      }
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
    // contradiction, and legacy archives may not be parseable JSON.
    const rejected = existsSync(verdictPath);
    if (!rejected) return [];
    return [{
      iteration,
      round,
      verdictPath,
      outputPath: join(directory, `previous_output_${gateId}.md`),
      inputPath: join(directory, `evaluated_input_${gateId}.md`),
      metricPath: join(directory, `metric_${gateId}.json`),
      effectiveVerdictPath,
    }];
  });
  const canonicalRejections = rejectionsFor(canonicalCoordinates);
  const legacyRejections = rejectionsFor(legacyCoordinates);
  // Precedence is per gate identity. An unrelated canonical namespace cannot
  // erase a durable rejection for this gate, while a canonical rejection for
  // this gate supersedes its legacy compatibility copy.
  return (canonicalRejections.length > 0 ? canonicalRejections : legacyRejections)
    .sort((left, right) => left.iteration - right.iteration || left.round - right.round);
}

export function buildGateDispatchPreamble(input: {
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
  const fixOutputs = (input.fixStageIds ?? [])
    .map((id) => `- ${join(input.runDirPath, 'stages', id, 'output.md')}`).join('\n');
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
        'Evidence retained from the interrupted attempt:',
        ...(input.interruptedInputPath && existsSync(input.interruptedInputPath)
          ? [`- Exact input seen by the interrupted gate: ${input.interruptedInputPath}`]
          : ['- Exact input seen by the interrupted gate: unavailable']),
        ...(input.interruptedOutputPath && existsSync(input.interruptedOutputPath)
          ? [`- Partial prior gate output: ${input.interruptedOutputPath}`]
          : []),
        'No rejected verdict was recorded, so there is no prior decision to reproduce or repair.',
        'Review as a first evaluation: check every assigned criterion against the change in proportion to its size and risk. The engine runs the configured validation for this gate.',
      ].join('\n');
    }
    return [
      `FIRST EVALUATION (round ${input.evaluationRound}): No prior execution or durable rejected verdict exists for gate ${input.gateId}.`,
      'Check every assigned criterion against the change in proportion to its size and risk. The engine runs the configured validation for this gate.',
    ].join('\n');
  }

  const firstCoverageOutput = rejections.find((entry) => existsSync(entry.outputPath))?.outputPath
    ?? latest.outputPath;
  return [
    `RE-EVALUATION (round ${input.evaluationRound}): Continue the same gate's audit after a durable rejection.`,
    '',
    'Evidence you must read:',
    `- Rejected verdict: ${latest.verdictPath}`,
    ...(existsSync(latest.inputPath)
      ? [`- Exact input evaluated by the rejected gate: ${latest.inputPath}`]
      : ['- Exact input evaluated by the rejected gate: unavailable (this round predates input archiving or did not retain an input)']),
    `- The engine's own conclusion and rejection reason: ${latest.effectiveVerdictPath}`,
    '  If that file shows engine_effective_pass=false while written_verdict_pass=true, the',
    '  verdict file is not the defect — engine_rejection_reason names what the engine',
    '  objected to, and that is what must change.',
    `- Metric artifact actually evaluated: ${latest.metricPath}`,
    `- Original first-pass gate output: ${firstCoverageOutput}`,
    ...(existsSync(latest.outputPath) && latest.outputPath !== firstCoverageOutput
      ? [`- Immediately previous gate output: ${latest.outputPath}`]
      : []),
    ...(input.roundDiffPath
      ? [`- Complete, untruncated repair-round diff: ${input.roundDiffPath}`]
      : ['- Complete repair-round diff: unavailable on this dispatch route; inspect the archived input/output and current repository diff.']),
    ...(fixOutputs ? ['- Fix stage output(s):', fixOutputs] : []),
    '',
    'Check each rejected finding against the repair diff, and re-check earlier conclusions only where the diff touches them. The engine re-runs the configured validation for this gate.',
    'Do not treat a repair summary or the existence of changed code as proof.',
  ].join('\n');
}

export function buildGateReevaluationPreamble(input: {
  evaluationRound: number;
  iteration: number;
  repairRound: number;
  runDirPath: string;
  gateId: string;
  fixStageIds: string[];
  roundDiffPath: string;
}): string {
  const coordinate = gateArchiveCoordinate(input.iteration, input.repairRound);
  return buildGateDispatchPreamble({
    runDirPath: input.runDirPath,
    gateId: input.gateId,
    evaluationRound: input.evaluationRound,
    priorAttemptCount: Math.max(1, input.evaluationRound - 1),
    fixStageIds: input.fixStageIds,
    roundDiffPath: input.roundDiffPath,
    interruptedInputPath: gateArchiveArtifactPath(input.runDirPath, coordinate, input.gateId, 'input', 'read'),
    interruptedOutputPath: gateArchiveArtifactPath(input.runDirPath, coordinate, input.gateId, 'output', 'read'),
  });
}

export function buildGateFixCorrectionContract(
  runDirPath: string,
  gateIds: string[],
  coordinate: GateArchiveCoordinate,
): string {
  const entries = gateIds.map((gateId) => {
    const evaluatedInput = gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'input', 'read');
    return [
      `- Gate ${gateId}:`,
      `  - archived rejected verdict: ${gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'verdict', 'read')}`,
      existsSync(evaluatedInput)
        ? `  - archived evaluated input: ${evaluatedInput}`
        : '  - archived evaluated input: unavailable (this round predates input archiving or did not retain an input)',
      `  - archived evaluated metric: ${gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'metric', 'read')}`,
      `  - archived QA output: ${gateArchiveArtifactPath(runDirPath, coordinate, gateId, 'output', 'read')}`,
      `  - optional correction marker: ${gateVerdictCorrectionPath(runDirPath, gateId)}`,
    ].join('\n');
  }).join('\n');
  return [
    `Gate repair round ${coordinate.round}: read the archived rejection evidence before changing anything:`,
    entries,
    '',
    'Wrong-verdict cold-start contract: only if reproducible evidence proves the previous rejection itself was wrong (rather than an implementation defect being repaired), write that gate\'s optional correction marker with exactly this JSON shape:',
    `{"version":${GATE_VERDICT_CORRECTION_VERSION},"gateId":"<exact gate id>","previousVerdictWrong":true,"reason":"<why the prior reasoning was wrong>","evidence":"<reproducible command/probe and result>"}`,
    'Do not write a correction marker for an ordinary fix. The marker invalidates only the prior validator session; it never changes the gate verdict or acceptance criteria.',
  ].join('\n');
}
