import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, mkdirSync } from './engine-fs.js';
import { fcGlobalDir, readRunState, withRunStateLock } from './store.js';
import { checkpointConsumers } from './checkpoint-liveness.js';
import { loadEngineDefaults } from './config.js';
import { processLiveness, processStartToken, type ProcessStartToken } from './process-liveness.js';
import { VALIDATION_FACT_VERSION, type ValidationExecution } from './evidence-ledger.js';
import { runProjectValidationBaseline, runValidationCommand, type ValidationCommand, type ValidationLimits, type ProjectValidationDependencies } from './project-validation.js';

export interface EngineValidationRecord {
  validationVersion: number;
  treeHash: string;
  resourceState: 'complete' | 'unfinished';
  recordPath: string;
  executions: ValidationExecution[];
  /** The numbers in force for the latest execution: the declaration; only the attempt count has an engine default. */
  limits: ValidationLimits & { attempts: number };
  /** Declared allowance consumed: each bounded execution is charged its full limit. */
  spentMs: number;
  pass: boolean;
}
interface Ticket { id: string; tree: string; pid: number; start?: ProcessStartToken; active: boolean; run?: { projectDir: string; runId: string } }
interface Queue { tickets: Ticket[] }

/** A store-wide FIFO replaces independent stage/gate batches. Schedulers are
 * separate daemon children, so an in-memory semaphore cannot enforce the bound.
 * The existing state-lock and durable publication primitives own both queue and
 * completed records. Dead process identities release their slots on recovery. */
export async function engineValidation(input: ProjectValidationDependencies & {
  projectDir: string; treeHash: string; commands: readonly ValidationCommand[];
  treeAfter: () => string | null;
  /** Declared by the brief/project; only attempts has an engine default. */
  limits?: ValidationLimits;
  completed?: ValidationExecution;
  run?: Ticket['run'];
}): Promise<EngineValidationRecord> {
  const defaults = loadEngineDefaults();
  const limits = { ...input.limits, attempts: input.limits?.attempts ?? defaults.validation_attempts };
  // Declared time is charged per batch; without a duration, only completed
  // execution/interrupt events consume attempts, never elapsed engine time.
  const allowance = limits.timeoutMs === undefined ? undefined : limits.timeoutMs * limits.attempts;
  const exhausted = (record: EngineValidationRecord): boolean => allowance === undefined
    ? record.executions.length >= limits.attempts : !(record.spentMs < allowance);
  const root = join(fcGlobalDir(), 'validation');
  mkdirSync(root, { recursive: true });
  const queuePath = join(root, 'queue.json'), recordPath = join(root, `${input.treeHash}.json`);
  const empty = (): EngineValidationRecord => ({ validationVersion: VALIDATION_FACT_VERSION, treeHash: input.treeHash,
    resourceState: 'unfinished', recordPath, executions: [], limits, spentMs: 0, pass: false });
  const ticket: Ticket = { id: randomUUID(), tree: input.treeHash, pid: process.pid, start: processStartToken(process.pid), active: false, run: input.run };
  const readRecord = (): EngineValidationRecord | undefined => existsSync(recordPath)
    ? JSON.parse(readFileSync(recordPath, 'utf8')) as EngineValidationRecord : undefined;
  const transaction = <T>(action: (queue: Queue) => T): T => withRunStateLock(root, () => {
    const queue: Queue = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, 'utf8')) : { tickets: [] };
    queue.tickets = queue.tickets.filter(entry => {
      if (processLiveness(entry.pid, entry.start) !== 'dead') return true;
      if (!entry.active || !entry.run) return false;
      // Reuse checkpoint ownership and retirement. A dead scheduler does not
      // release capacity while its validation command group can still execute.
      const checkpoint = readRunState(entry.run.projectDir, entry.run.runId).engineCheckpoint;
      return checkpoint?.pid === entry.pid && checkpointConsumers(checkpoint, { retire: true }).length > 0;
    });
    const result = action(queue);
    atomicWrite(queuePath, JSON.stringify(queue));
    return result;
  });
  let record: EngineValidationRecord | undefined;
  try {
    while (true) {
      const state = transaction(queue => {
        record = readRecord();
        if (!record && input.completed) {
          record = { ...empty(), resourceState: 'complete', executions: [input.completed],
            pass: input.completed.commands.every(command => command.exitCode === 0) };
          atomicWrite(recordPath, JSON.stringify(record));
        }
        // A completed record is never executed again, whatever limits ask for it.
        if (record && (record.resourceState === 'complete' || exhausted(record))) return 'cached';
        if (input.abortSignal?.aborted) return 'cancelled';
        if (!queue.tickets.some(entry => entry.id === ticket.id)) queue.tickets.push(ticket);
        const active = queue.tickets.filter(entry => entry.active);
        // Duplicate requests join their tree's owner, without occupying a slot
        // or blocking unrelated trees behind them in the arrival order.
        const trees = new Set(active.map(entry => entry.tree));
        const eligible = queue.tickets.filter(entry => {
          if (entry.active || trees.has(entry.tree)) return false;
          trees.add(entry.tree); return true;
        }).slice(0, Math.max(0, defaults.validation_concurrency - active.length));
        for (const entry of eligible) entry.active = true;
        const own = queue.tickets.find(entry => entry.id === ticket.id)!;
        return own.active ? 'execute' : 'queued';
      });
      if (state === 'cached') return record!;
      if (state === 'cancelled') return record ?? empty();
      if (state === 'execute') break;
      await delay(50);
    }
    record ??= empty();
    // Spent allowance is persisted and bounded independently of author and repair
    // attempts. Resuming cannot silently reset it; only a larger declared allowance
    // than the record has spent admits another execution.
    while (!exhausted(record) && !input.abortSignal?.aborted) {
      // A ticket binds content at admission, not when it joined the queue.
      // Refuse changed/unreadable content without executing it under an old hash.
      if (input.treeAfter() !== input.treeHash) break;
      const execution: ValidationExecution = { target: 'attempt', cwd: input.projectDir,
        treeHash: input.treeHash, treeAfterHash: null, commands: [] };
      record.executions.push(execution);
      record.limits = limits; record.spentMs += limits.timeoutMs ?? 0;
      atomicWrite(recordPath, JSON.stringify(record));
      const measured = await runProjectValidationBaseline(input.projectDir, { ...input,
        commands: input.commands, skipExecution: false, remainingMs: undefined,
        runCommand: input.runCommand ?? runValidationCommand,
        timeoutMs: limits.timeoutMs, priority: defaults.validation_priority });
      const after = input.treeAfter();
      execution.treeAfterHash = after;
      execution.commands = measured.results.map(result => ({ ...result, command: result.command!, args: result.args! }));
      const complete = after === input.treeHash && measured.results.length === input.commands.length
        && measured.results.every(result => Number.isInteger(result.exitCode) && !result.unfinished);
      record.resourceState = complete ? 'complete' : 'unfinished';
      record.pass = complete && measured.results.every(result => result.exitCode === 0);
      atomicWrite(recordPath, JSON.stringify(record));
      if (complete || after !== input.treeHash) break;
    }
    return record;
  } finally {
    transaction(queue => { queue.tickets = queue.tickets.filter(entry => entry.id !== ticket.id); });
  }
}
