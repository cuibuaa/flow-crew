import { buildGateDispatchPreamble, gateArchiveCoordinate, gateArchiveArtifactPath } from '../../src/scheduler/sched_settlement/gate-archives.js';

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

