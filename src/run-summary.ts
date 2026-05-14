import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, AgentConfig } from './adapters/base.js';
import { runsRoot } from './store.js';
import type { StoreState } from './store.js';
import pino from 'pino';

const log = pino({ name: 'run-summary' });

const SUMMARY_SYSTEM_PROMPT = `You are a technical writer summarizing the results of a multi-agent workflow run.
Given the run state and stage outputs, produce a concise, structured summary in markdown.

Format:
# Run Summary

## What was done
- [2-5 bullet points of key changes/actions, focusing on WHAT changed not HOW]

## Files changed
- [file path] — [one-line description of change]
- [limit to 15 most important files; say "+N more" if there are more]

## Key decisions
- [important choices the agents made, e.g., "split into 3 parallel stages", "used threading locks instead of async"]

## Stages
- [stage_id]: [one-line summary] (Xs)

## QA Result
[Pass/Fail + key findings]

## Risks / Notes
- [anything the user should verify or be aware of]

Rules:
- Be concise. Each bullet should be one line.
- Focus on WHAT changed and WHY, not the process.
- Extract file paths from stage artifacts and outputs.
- If a stage failed, explain why briefly.
- Output ONLY the markdown summary. No preamble.`;

export async function generateRunSummary(
  projectDir: string,
  runId: string,
  adapter: Adapter,
): Promise<string | null> {
  const runDir = join(runsRoot(), runId);
  if (!existsSync(join(runDir, 'run.json'))) return null;

  try {
    const state: StoreState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'));
    if (state.status !== 'complete' && state.status !== 'failed') return null;

    // Collect stage outputs (truncated to keep prompt reasonable)
    const stageOutputs: string[] = [];
    const stagesDir = join(runDir, 'stages');
    if (existsSync(stagesDir)) {
      for (const stageId of readdirSync(stagesDir)) {
        const outputPath = join(stagesDir, stageId, 'output.md');
        if (!existsSync(outputPath)) continue;
        let output = readFileSync(outputPath, 'utf-8');
        if (output.length > 3000) output = output.slice(0, 1500) + '\n...(truncated)...\n' + output.slice(-1500);
        const status = state.stages[stageId]?.status ?? 'unknown';
        const duration = state.stages[stageId]?.duration_ms ? `${Math.round(state.stages[stageId].duration_ms! / 1000)}s` : '';
        stageOutputs.push(`## Stage: ${stageId} (${status}${duration ? ', ' + duration : ''})\n${output}`);
      }
    }

    // Build the prompt
    const prompt = `Summarize this workflow run:

# Run Info
- Run ID: ${runId}
- Project: ${state.projectDir}
- Status: ${state.status}
- Task: ${(state.taskDescription ?? '').slice(0, 500)}
- Iterations: ${state.currentIteration ?? 1}/${state.maxIterations ?? '?'}
- Total stages: ${Object.keys(state.stages).length}

# Stage Results
${stageOutputs.join('\n\n')}

# Dispatch Plan
${existsSync(join(runDir, 'dispatch.yaml')) ? readFileSync(join(runDir, 'dispatch.yaml'), 'utf-8').slice(0, 2000) : '(none)'}
`;

    // Use the adapter to generate summary (cheap model)
    const summaryAgent: AgentConfig = {
      name: 'summarizer',
      description: 'Run summary generator',
      model: 'sonnet',
      reasoning_effort: 'low',
      tools: [],
      prompt: SUMMARY_SYSTEM_PROMPT,
    };

    const result = await adapter.run(prompt, summaryAgent, {
      timeout_ms: 30000,
      workDir: projectDir,
      runDir,
      stageId: '_summary',
    });

    if (result.exitCode !== 0 || !result.output.trim()) {
      log.warn({ runId, exitCode: result.exitCode }, 'Summary generation failed');
      return null;
    }

    const summary = result.output.trim();
    writeFileSync(join(runDir, 'summary.md'), summary, 'utf-8');
    log.info({ runId }, 'Run summary generated');
    return summary;
  } catch (err) {
    log.warn({ runId, err }, 'Failed to generate run summary');
    return null;
  }
}
