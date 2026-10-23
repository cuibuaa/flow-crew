import { initializeReservedRun, reserveRun } from '../../src/store.js';

export function createRun(
  projectDir: string,
  workflowName: string,
  workflowYaml: string,
  stageIds: string[],
): { runId: string; runDirPath: string } {
  const reservation = reserveRun(projectDir);
  return initializeReservedRun(projectDir, reservation.runId, workflowName, workflowYaml, stageIds);
}
