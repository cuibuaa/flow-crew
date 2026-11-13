import { createBriefAdmission, inspectBrief } from '../../src/brief-preflight.js';
import { writeBriefCriteriaArtifact } from '../../src/brief-criteria.js';
import { initializeReservedRun, reserveRun } from '../../src/store.js';

export function createRun(
  projectDir: string,
  workflowName: string,
  workflowYaml: string,
  stageIds: string[],
  brief = '',
  admission = createBriefAdmission(inspectBrief(brief), { kind: 'not_required' }),
): { runId: string; runDirPath: string } {
  const reservation = reserveRun(projectDir);
  const created = initializeReservedRun(projectDir, reservation.runId, workflowName, workflowYaml, stageIds, admission);
  writeBriefCriteriaArtifact(created.runDirPath, brief);
  return created;
}
