// Boundary: fully author and independently gate A; spend B only when A cannot pass.
import { RUN_STATUS } from './store.js';

export interface RaceDecision {
  choice?: 'A' | 'B';
  basis: 'first-passed' | 'gated-fallback' | 'none-passed';
  reason: string;
}

export interface RaceDeps {
  /** Run one isolated candidate through its independent gates and bounded repairs. */
  run(target: string, label: 'A' | 'B', instruction: string): Promise<{ code: number; output: string }>;
  /** The exact run launched for the target, with effective scheduler gate facts. */
  readRun(target: string): { runId: string; status: string; gatePassed: boolean; repairs?: number; failureReason?: string } | undefined;
  write(path: string, text: string): void;
  out(line: string): void;
}

export interface RaceRequest {
  targets: readonly [string, string];
  recordPath: string;
}

// Stage instructions keep the admitted task and report criteria unchanged.
const RESTATE_INSTRUCTION = "Before changing any code, write down in one or two sentences the observable behaviour the task's author expects once it is resolved, using the author's own words wherever they state it. Then make the change deliver exactly that behaviour.\n\n";

export async function runRace({ targets, recordPath }: RaceRequest, deps: RaceDeps): Promise<number> {
  const candidates: Array<{ label: 'A' | 'B'; target: string; runId?: string; status: string;
    gatePassed?: boolean; repairs: number; failureReason?: string; launchExit: number }> = [];
  const gateAttempts: Array<{ label: 'A' | 'B'; runId?: string; exit: number; status?: string; pass: boolean; reason: string }> = [];
  let decision: RaceDecision = { basis: 'none-passed', reason: 'no candidate has passed independent gates' };
  const save = () => deps.write(recordPath, `${JSON.stringify({ version: 3, instructionCandidate: 'A',
    candidates, gateAttempts, decision, chosenTarget: candidates.find(candidate => candidate.label === decision.choice)?.target,
  }, null, 2)}\n`);
  for (const [i, label] of (['A', 'B'] as const).entries()) {
    const target = targets[i];
    deps.out(`Race: authoring and gating candidate ${label} on ${target}`);
    let launchError: string | undefined;
    const launched = await deps.run(target, label, i === 0 ? RESTATE_INSTRUCTION : '').catch(error => {
      launchError = error instanceof Error ? error.message : String(error);
      return { code: 1, output: launchError };
    });
    const run = deps.readRun(target);
    const pass = launched.code === 0 && run?.status === RUN_STATUS.COMPLETE && run.gatePassed;
    const reason = run?.failureReason ?? launchError ?? (pass ? 'all independent gates passed' : 'run did not complete with passing independent gates');
    candidates.push({ label, target, runId: run?.runId, status: run?.status ?? 'no bound run',
      gatePassed: run?.gatePassed, repairs: run?.repairs ?? 0, failureReason: run?.failureReason ?? launchError, launchExit: launched.code });
    gateAttempts.push({ label, runId: run?.runId, exit: launched.code, status: run?.status, pass, reason });
    decision = pass ? { choice: label, basis: i === 0 ? 'first-passed' : 'gated-fallback',
      reason: i === 0 ? 'A completed with all independent gates passing' : 'A could not pass; B completed with all independent gates passing' }
      : { basis: 'none-passed', reason: gateAttempts.map(attempt => `${attempt.label}: ${attempt.reason}`).join('; ') };
    save(); // Preserve A's failure before setting up or authoring the alternative.
    if (pass) {
      deps.out(`Race: kept candidate ${label} at ${target} (${decision.basis}: ${decision.reason})`);
      return 0;
    }
  }
  deps.out(`Race: ${decision.reason}`);
  return 1;
}
