/**
 * ScriptedAdapter — a deterministic "agent" that plays back a per-stage script.
 *
 * Purpose: engine-behavior testing ("wind tunnel"). Real campaigns always run
 * on a real CLI adapter; this one exists so that engine × brief CONTRACT
 * mechanics (confirm gates, terminal floors, declared artifact paths, stage
 * sweeps, ship-bypass rejection) can be exercised end-to-end through the REAL
 * scheduler in milliseconds with zero tokens — the openworker ScriptedProvider
 * pattern applied to flow-crew's per-stage adapter seam.
 *
 * Script shape: stageId → one turn, or an ARRAY of turns consumed one per call
 * (a stage that runs once per iteration, like the research planner, scripts a
 * sequence). Files can be written relative to the PROJECT dir (deliverables,
 * round results) and/or the RUN dir (dispatch.yaml, reality_checks.md), with
 * the same containment check the mock adapter uses.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult } from './base.js';

export interface ScriptedTurn {
  /** Final text output of the "agent" for this call. */
  output?: string;
  /** Process exit code (default 0). */
  exitCode?: number;
  /** Files written relative to the project dir (opts.workDir). */
  projectFiles?: Record<string, string>;
  /** Files written relative to the run dir (opts.runDir) — dispatch.yaml etc. */
  runFiles?: Record<string, string>;
  tokens_out?: number;
}

export type StageScript = ScriptedTurn | ScriptedTurn[];

function writeContained(root: string, files: Record<string, string> | undefined): void {
  if (!files) return;
  const base = resolve(root);
  for (const [rel, content] of Object.entries(files)) {
    const target = resolve(base, rel);
    const r = relative(base, target);
    if (r === '' || r.startsWith('..') || isAbsolute(r)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
}

export class ScriptedAdapter implements Adapter {
  /** Every call, in order — assert on this to verify which stages actually ran. */
  readonly calls: Array<{ stageId: string; nthCall: number; prompt: string }> = [];
  private counts = new Map<string, number>();

  constructor(
    private script: Record<string, StageScript>,
    private fallback: ScriptedTurn = { output: 'no script for this stage', exitCode: 1 },
  ) {}

  async run(prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
    const n = (this.counts.get(opts.stageId) ?? 0) + 1;
    this.counts.set(opts.stageId, n);
    this.calls.push({ stageId: opts.stageId, nthCall: n, prompt });

    const entry = this.script[opts.stageId];
    let turn: ScriptedTurn | undefined;
    if (Array.isArray(entry)) turn = entry[Math.min(n - 1, entry.length - 1)];
    else turn = entry;
    if (!turn) turn = this.fallback;

    writeContained(opts.workDir, turn.projectFiles);
    writeContained(opts.runDir, turn.runFiles);
    return {
      output: turn.output ?? '',
      exitCode: turn.exitCode ?? 0,
      duration_ms: 1,
      ...(turn.tokens_out !== undefined ? { tokens_out: turn.tokens_out } : {}),
    };
  }
}

export function createAdapter(): Adapter {
  return new ScriptedAdapter({});
}
