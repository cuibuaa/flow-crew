// Repair transport projects actual attempt identities; it carries no rollback authority.
import { mkdirSync, writeFileSync } from '../../engine-fs.js';
import { join } from 'node:path';
import { readEvidence } from '../../evidence-ledger.js';
import type { StageConfig } from '../sched_admission/configuration.js';
import type { StageStatus } from '../../store.js';
import type { GateArchiveServices } from '../sched_settlement/gate-archives.js';

export function createRepairDiffWriter(services: Pick<GateArchiveServices, 'gateArchiveCoordinate' | 'canonicalGateRoundArtifactDir'>) {
  function writeRepairRoundDiffArtifact(input: {
    runDirPath: string; iteration: number; round: number; repairStages: StageConfig[]; statuses: Record<string, StageStatus>;
  }): string {
    const ledger = readEvidence(input.runDirPath);
    const attempts = input.repairStages.flatMap(stage => {
      const executions = input.statuses[stage.id]?.attempts;
      return (executions?.length ? executions : [undefined]).map(attempt => ({ stageId: stage.id, attempt }));
    });
    const facts = attempts.map(({ stageId, attempt }) => ledger.find(entry => entry.kind === 'attempt' && entry.stageId === stageId
      && entry.attemptIndex === attempt?.index && entry.attemptStartedAt === attempt?.startedAt));
    const available = attempts.length > 0 && facts.every(fact => fact?.kind === 'attempt' && fact.treeHash !== null);
    const files = new Map<string, object>();
    for (const fact of [...facts].sort((left, right) => (left?.sequence ?? 0) - (right?.sequence ?? 0))) if (fact?.kind === 'attempt') for (const file of fact.files) {
      files.set(file.path, { path: file.path, status: file.content.state === 'absent' ? 'deleted'
        : file.content.state === 'unavailable' ? 'content-unavailable' : 'changed', after: file.content, mode: file.mode });
    }
    const directory = services.canonicalGateRoundArtifactDir(input.runDirPath, services.gateArchiveCoordinate(input.iteration, input.round));
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'repair_diff.json');
    writeFileSync(path, JSON.stringify({ version: 1, iteration: input.iteration, round: input.round,
      completedAt: new Date().toISOString(), truncated: false, repairStageIds: input.repairStages.map(stage => stage.id),
      attempts: attempts.map(({ stageId, attempt }) => ({ stageId, attemptIndex: attempt?.index, attemptStartedAt: attempt?.startedAt })),
      available,
      files: available ? [...files.values()] : null }, null, 2) + '\n');
    return path;
  }
  return { writeRepairRoundDiffArtifact };
}
