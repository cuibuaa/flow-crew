import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvidence, captureProjectTree, VALIDATION_FACT_VERSION } from '../../src/evidence-ledger.js';
import { completeStageAttempt, readStageStatus, runDir } from '../../src/store.js';
import { evaluateValidationDelta, type ProjectValidationBaseline, type ValidationCommandResult, type ValidationDeltaResult } from '../../src/project-validation.js';
import { readRunValidationBaseline } from '../../src/scheduler/sched_settlement/gate-validation.js';

/** Declared measurement facts for consumer unit tests. This fixture never
 * executes a command or extracts identity from output. Real execution/count,
 * reporter/model reading and base isolation live in evidence-ledger.test.ts. */
export function seedAttemptValidation(projectDir: string, runId: string, current: ValidationCommandResult[],
  options: { stageId?: string; baseline?: ProjectValidationBaseline; delta?: ValidationDeltaResult[] } = {}) {
  const base = runDir(projectDir, runId), plan = readRunValidationBaseline(base);
  if (!plan) throw new Error('Fixture needs a validation declaration');
  const stageId = options.stageId ?? 'author';
  let prior;
  try { prior = options.stageId ? readStageStatus(projectDir, runId, stageId) : undefined; } catch { /* no prior fixture attempt */ }
  const status = prior?.attempts?.at(-1)?.status === 'complete' ? prior : completeStageAttempt(projectDir, runId, stageId, 0, { exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' });
  const attempt = status.attempts!.at(-1)!;
  let brief = ''; try { brief = readFileSync(join(base, 'task_brief.md'), 'utf8'); } catch { /* consumer-only fixture */ }
  const tree = captureProjectTree(projectDir, brief);
  const delta = options.delta ?? evaluateValidationDelta(options.baseline ?? plan.baseline, current);
  return appendEvidence(base, { kind: 'validation', validationVersion: VALIDATION_FACT_VERSION, stageId, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt,
    treeHash: tree.hash, executions: [{ target: 'attempt', cwd: projectDir, treeHash: tree.hash, treeAfterHash: tree.hash,
      commands: current.map(result => ({ ...result, ...plan.baseline.discovery.commands.find(command => command.role === result.role && (command.display === result.display || !result.display)), command: 'declared-fixture', args: [] })) }],
    delta, failures: current.filter(result => result.state === 'failed').flatMap(result => result.failureIdentifiers.map(identifier => ({
      role: result.role, identifier, classification: delta.find(entry => entry.role === result.role)?.state === 'regression' ? 'introduced' as const : 'pre-existing' as const,
    }))), pass: delta.every(entry => entry.state === 'pass') });
}
