/**
 * P3 live glue — wires the tested outer-loop engine (runCampaignLoop) to real infrastructure.
 *
 * The engine + policy + campaign_planner role + guard are task-agnostic and unit-tested with
 * mocks. This module supplies the two REAL injected dependencies:
 *   - propose:          invoke the campaign_planner agent (via the adapter) with {ledger_digest}
 *                       + {context_inventory}, parse its JSON verdict for the next direction.
 *   - executeDirection: launch a real inner research run for the direction (injected launcher),
 *                       then read its best measured result.
 * Both halves are injectable so this module itself stays unit-testable (mock adapter + launcher);
 * the CLI (`flowcrew campaign-loop`) supplies the production launcher/reader.
 */
import type { Adapter, AgentConfig, RunOpts } from './adapters/base.js';
import { type ResearchConfig, isSuccessfulRunStatus } from './store.js';
import { summarizeContext } from './context-inventory.js';
import { summarizeLedger } from './campaign-ledger.js';
import { runCampaignLoop, type CampaignLoopDeps, type CampaignLoopResult, type DirectionOutcome } from './campaign-loop.js';

/**
 * Parse the campaign_planner's output for the next direction. Scans last-to-first for a balanced
 * JSON object (tolerant of surrounding prose). Returns the direction label, or null on a frontier
 * verdict / no parseable direction.
 */
export function parseNextDirection(output: string): string | null {
  if (!output) return null;
  for (let i = output.lastIndexOf('{'); i >= 0; i = output.lastIndexOf('{', i - 1)) {
    let depth = 0;
    for (let j = i; j < output.length; j++) {
      if (output[j] === '{') depth++;
      else if (output[j] === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(output.slice(i, j + 1)) as { next_direction?: unknown; frontier?: unknown };
            if (obj.frontier === true) return null;
            if (typeof obj.next_direction === 'string' && obj.next_direction.trim()) return obj.next_direction.trim();
            if (obj.next_direction === null) return null;
          } catch { /* not this object — keep scanning */ }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Parse the campaign_scout's output for NEW candidate direction labels (tolerant of surrounding
 * prose). Returns the `new_directions` array, or [] if none / unparseable.
 */
export function parseScoutDirections(output: string): string[] {
  if (!output) return [];
  for (let i = output.lastIndexOf('{'); i >= 0; i = output.lastIndexOf('{', i - 1)) {
    let depth = 0;
    for (let j = i; j < output.length; j++) {
      if (output[j] === '{') depth++;
      else if (output[j] === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(output.slice(i, j + 1)) as { new_directions?: unknown };
            if (Array.isArray(obj.new_directions)) {
              return obj.new_directions
                .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
                .map((s) => s.trim());
            }
          } catch { /* not this object — keep scanning */ }
          break;
        }
      }
    }
  }
  return [];
}

export interface ScoutOpts {
  projectDir: string;
  campaignId: string;
  objective: ResearchConfig;
  scoutRole: AgentConfig;
  adapter: Adapter;
  runOpts: RunOpts;
  briefContext?: string;
}

/**
 * Run the LITERATURE SCOUT once, BEFORE the campaign explores. It MUST web_search the external
 * literature for methods not in the ledger that are expressible on the on-disk assets, and returns
 * the NEW candidate direction labels to ADD to the campaign portfolio. The caller merges these into
 * objective.directions, so the deterministic coverage floor (runCampaignLoop) then forces them to be
 * tried before any frontier — this is what lets the campaign autonomously discover breakthroughs
 * OUTSIDE the brief's static list, instead of confabulating a frontier from the ledger alone.
 * On scout failure the campaign still proceeds (returns []) — it just isn't expanded.
 */
export async function scoutDirections(opts: ScoutOpts): Promise<string[]> {
  const prompt = opts.scoutRole.prompt
    .replace(/\{ledger_digest\}/g, summarizeLedger(opts.projectDir, opts.campaignId))
    .replace(/\{context_inventory\}/g, summarizeContext(opts.projectDir, opts.objective.contextRoots ?? ['data']))
    + (opts.briefContext ? `\n\n--- CAMPAIGN TASK (goal, gates, ledger, data) ---\n${opts.briefContext}` : '')
    + `\n\nWrite literature_scan.md under report dir: ${opts.objective.reportDir ?? 'docs'}.`;
  const res = await opts.adapter.run(prompt, opts.scoutRole, opts.runOpts);
  if (res.exitCode !== 0) return [];
  return parseScoutDirections(res.output);
}

export interface LiveCampaignDepsOpts {
  projectDir: string;
  campaignId: string;
  objective: ResearchConfig;
  proposeRole: AgentConfig;
  adapter: Adapter;
  proposeRunOpts: RunOpts;
  /** Launch a real inner research run for the direction; resolve with its runId. */
  launchInner: (direction: string) => Promise<string>;
  /** Read the best (running-best) measured result of a finished inner run. */
  readBest: (runId: string) => number;
  /**
   * Read the inner run's terminal status (e.g. from its run.json). If it did NOT reach a successful
   * terminal — most importantly `reality_gate_failed`, where the inner safety net REJECTED the
   * round's claimed numbers — the outer loop must NOT count the journaled result as a beat. Without
   * this, a false positive the inner reality gate already caught would leak through as a false ship.
   * Omitted → the outcome is trusted (back-compat for callers with no run-status channel).
   */
  readRunStatus?: (runId: string) => string;
  /**
   * Optional campaign brief text (goal, gates, and the DOMAIN ledger of directions already
   * tried/dead). Appended to the propose prompt so the proposer avoids re-proposing directions
   * the campaign already knows are dead — the engine's {ledger_digest} only carries THIS
   * campaign's journaled runs, which is empty on a fresh campaign and never includes the
   * domain's historical catalog. Keeping the historical ledger in the brief (not the engine)
   * preserves the engine's task-agnosticism.
   */
  briefContext?: string;
}

/** Build the real {propose, executeDirection, objective} for runCampaignLoop. */
export function createLiveCampaignDeps(opts: LiveCampaignDepsOpts): CampaignLoopDeps {
  return {
    objective: opts.objective,
    propose: async (tried: string[]): Promise<string | null> => {
      const prompt = opts.proposeRole.prompt
        .replace(/\{ledger_digest\}/g, summarizeLedger(opts.projectDir, opts.campaignId))
        .replace(/\{context_inventory\}/g, summarizeContext(opts.projectDir, opts.objective.contextRoots ?? ['data']))
        + `\n\nAlready tried this campaign (do NOT repeat): ${tried.length ? tried.join(', ') : '(none)'}`
        + `\nCampaign objective: baseline ${opts.objective.baseline}, target ${opts.objective.stop?.beat ?? 'n/a'}.`
        + (opts.briefContext ? `\n\n--- CAMPAIGN BRIEF (goal, gates, and the FULL ledger of directions already tried/dead — do NOT re-propose anything it lists as tried or dead) ---\n${opts.briefContext}` : '');
      const res = await opts.adapter.run(prompt, opts.proposeRole, opts.proposeRunOpts);
      // A proposer that CRASHED (non-zero exit) must NOT masquerade as a frontier: returning null
      // here would make the outer loop conclude "no new direction" when really the call errored
      // (e.g. a model 400). Throw so the campaign aborts loudly instead of a false negative.
      if (res.exitCode !== 0) {
        throw new Error(`campaign proposer failed (exit ${res.exitCode}) — not a frontier. Tail: ${res.output.slice(-400)}`);
      }
      return parseNextDirection(res.output);
    },
    executeDirection: async (direction: string): Promise<DirectionOutcome> => {
      const runId = await opts.launchInner(direction);
      // Respect the inner run's reality-gate verdict: a run that did not reach a successful terminal
      // (e.g. reality_gate_failed) had its claimed numbers REJECTED by the inner safety net. Scoring
      // it at baseline (no improvement) instead of its journaled claim is what stops a caught false
      // positive from leaking out of the outer loop as a false ship.
      const status = opts.readRunStatus ? opts.readRunStatus(runId) : 'complete';
      if (!isSuccessfulRunStatus(status)) {
        return { direction, bestResult: opts.objective.baseline, status, rejected: true };
      }
      return { direction, bestResult: opts.readBest(runId), status };
    },
  };
}

export async function runLiveCampaign(opts: LiveCampaignDepsOpts): Promise<CampaignLoopResult> {
  return runCampaignLoop(createLiveCampaignDeps(opts));
}
