import { runRecordPath } from './run-layout.js';
import { parseCommandArgs, commandUsage } from './cli-args.js';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readRunState, runDir } from './store.js';
import { readAdmittedBriefContract } from './ship-inputs.js';
import { declaredOutputSource } from './declared-output-archive.js';
import { readRunStateView, type RunStateView } from './run-state-view.js';

/** A bounded projection of the same read view; omissions are explicit. */
export function summarizeRunStateView(view: RunStateView): object {
  return {
    version: view.version, observedAt: view.observedAt, snapshot: view.snapshot.runStateSha256, run: view.run,
    plan: { revision: view.plan.revision, stages: view.plan.stages.length, historyEntries: view.plan.history.length },
    ...(view.validation ? { validation: view.validation } : {}),
    stages: Object.fromEntries(Object.entries(view.stages).map(([id, stage]) => [id, { status: stage.status, attempt: stage.attempts?.at(-1)?.index, error: stage.error,
      ...(stage.gate?.validation || stage.acceptedFrom?.verdict.validation ? { validation: stage.gate?.validation ?? stage.acceptedFrom?.verdict.validation } : {}),
    }])),
    artifacts: view.artifacts.slice(0, 64), omittedArtifacts: Math.max(0, view.artifacts.length - 64),
    budget: view.budget,
    openFindings: view.audits.openFindings,
    guidance: { envelopes: view.guidance.length, queued: view.guidance.filter((entry) => entry.deliveryState === 'queued').length },
    prompts: { coverage: view.prompts.coverage, completeness: view.prompts.completeness, invocations: view.prompts.invocations.length, missing: view.prompts.missingAttemptInputs.length },
    diagnostics: view.diagnostics,
  };
}

/** Required products are engine facts, independent of a role's task excerpt or guidance. */
export function declaredOutputFacts(projectDir: string, runId: string, state = readRunState(projectDir, runId)) {
  const briefPath = runRecordPath(runDir(projectDir, runId), 'task_brief.md');
  const outputs = state.declaredOutputs ?? readAdmittedBriefContract(runDir(projectDir, runId), existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : '').outputs;
  return (outputs ?? []).map(output => {
    try {
      declaredOutputSource(projectDir, output);
      return { ...output, available: true as const };
    } catch (error) {
      return { ...output, available: false as const, reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function runStateContext(projectDir: string, runId: string, revision?: { revision: number; digest: string }): string {
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // Prompt construction needs a locator and admission binding, not a scan of
  // every artifact and immutable invocation. The explicit CLI retains that view.
  const outputs = existsSync(runRecordPath(runDir(projectDir, runId), 'run.json')) ? declaredOutputFacts(projectDir, runId) : [];
  return `# Engine state query\nRun binding: ${JSON.stringify({ runId })}.\n${revision ? `Admitted plan revision ${revision.revision}, digest ${revision.digest}.\n` : ''}`
    + `Read current state with flowcrew state --project ${shellQuote(projectDir)} --run ${shellQuote(runId)}. `
    + 'Use --summary for current engine state; use the evidence ledger and diff for stage decisions. '
    + 'An observation grants no permission and is not a successful verdict.'
    + (outputs.length ? `\n\n# Required declared outputs (current engine facts)\n${JSON.stringify(outputs)}\n`
      + 'These products must remain available with the declared type. Guidance cannot remove these obligations. '
      + 'Report conflicts with other brief constraints instead of deleting a required product. '
      + 'The engine refuses gate PASS while one is unavailable, except products assigned to later ordinary work; unavailable products need repair.' : '');
}

export function cmdState(args: string[], output: Pick<NodeJS.WriteStream, 'write'> = process.stdout, errors: Pick<NodeJS.WriteStream, 'write'> = process.stderr): number {
  try {
    const parsed = parseCommandArgs('state', args);
    if (parsed.help) {
      output.write(`${commandUsage('state')}\n`);
      return 0;
    }
    const project = parsed.values.get('--project'), runId = parsed.values.get('--run');
    if (!project || !runId) throw new Error('STATE_QUERY_REQUIRED: supply --project <path> and --run <run-id>');
    const view = readRunStateView(resolve(project), runId, { includePromptText: parsed.flags.has('--prompts') });
    output.write(`${JSON.stringify(parsed.flags.has('--summary') ? summarizeRunStateView(view) : view, null, 2)}\n`);
    return 0;
  } catch (error) {
    errors.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
