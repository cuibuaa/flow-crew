import { resolve } from 'node:path';
import { readRunStateView, type RunStateView } from './run-state-view.js';

/** A bounded projection of the same read view; omissions are explicit. */
export function summarizeRunStateView(view: RunStateView): object {
  return {
    version: view.version, observedAt: view.observedAt, snapshot: view.snapshot.runStateSha256, run: view.run,
    plan: { revision: view.plan.revision, stages: view.plan.stages.length, historyEntries: view.plan.history.length },
    stages: Object.fromEntries(Object.entries(view.stages).map(([id, stage]) => [id, { status: stage.status, attempt: stage.attempts?.at(-1)?.index, error: stage.error }])),
    artifacts: view.artifacts.slice(0, 64), omittedArtifacts: Math.max(0, view.artifacts.length - 64),
    budget: view.budget,
    resources: view.resources.status === 'available' ? { status: 'available', path: view.resources.path, revision: view.resources.snapshot.revision, active: view.resources.snapshot.leases.filter((lease) => lease.status === 'active') } : view.resources,
    resourceWaits: view.resourceWaits,
    openFindings: view.audits.openFindings,
    guidance: { envelopes: view.guidance.length, queued: view.guidance.filter((entry) => entry.deliveryState === 'queued').length },
    prompts: { coverage: view.prompts.coverage, completeness: view.prompts.completeness, invocations: view.prompts.invocations.length, missing: view.prompts.missingAttemptInputs.length },
    diagnostics: view.diagnostics,
  };
}

export function runStateContext(projectDir: string, runId: string): string {
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    const view = readRunStateView(projectDir, runId);
    return `# Shared engine state\n${JSON.stringify(summarizeRunStateView(view))}\n\nQuery the same read-only view with flowcrew state --project ${shellQuote(projectDir)} --run ${shellQuote(runId)}. Add --prompts for immutable engine-supplied invocation bytes; legacy aliases are marked inexact. A snapshot is an observation, never a permission or a successful verdict.`;
  } catch (error) {
    return `# Shared engine state\nState query unavailable: ${error instanceof Error ? error.message : String(error)}. Retry the read-only flowcrew state query; unavailable state must not be interpreted as completed work.`;
  }
}

export function cmdState(args: string[], output: Pick<NodeJS.WriteStream, 'write'> = process.stdout, errors: Pick<NodeJS.WriteStream, 'write'> = process.stderr): number {
  if (args.includes('--help') || args.includes('-h')) {
    output.write('Usage: flowcrew state --project <path> --run <run-id> [--prompts] [--summary]\nRead-only state, plan, outputs, budgets, resources, findings, guidance and invocation inputs.\n');
    return 0;
  }
  try {
    const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
    const project = value('--project'), runId = value('--run');
    if (!project || !runId) throw new Error('STATE_QUERY_REQUIRED: supply --project <path> and --run <run-id>');
    const view = readRunStateView(resolve(project), runId, { includePromptText: args.includes('--prompts') });
    output.write(`${JSON.stringify(args.includes('--summary') ? summarizeRunStateView(view) : view, null, 2)}\n`);
    return 0;
  } catch (error) {
    errors.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
