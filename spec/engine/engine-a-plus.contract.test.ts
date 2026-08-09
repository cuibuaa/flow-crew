/**
 * engine-a-plus regression contracts — the 3 confirmed gaps + 3 A+ deltas of the
 * framework-pure engine hardening on branch engine-a-plus.
 *
 *   GAP-1  terminal-predicate unification + no-clobber: the scheduler-local
 *          isTerminalStatus now DEFERS to store.ts's single-source isTerminalRunStatus,
 *          so it returns true for reality_gate_failed + failed (the prior narrow set
 *          omitted them, letting post-iteration guards fall through and the max-iters
 *          handler clobber an already-terminal status to 'failed').
 *   A+(c)  first-class `incomplete` terminal status (budget exhausted mid-search,
 *          distinct from `failed`=crash and `ceiling_hit`=honest negative; NOT a success).
 *   GAP-3  parseBriefFrontmatter surfaces a frontmatterError instead of silently
 *          swallowing malformed YAML / an unclosed fence / a non-object mapping.
 *   GAP-2  detectStalledStages — deterministic, pure, per-running-stage no-progress
 *          watchdog (no LLM verdict): a stalled stage is reported for abort; a fresh /
 *          progressing stage is not.
 *
 * (A+(a) confirm gate is covered end-to-end in loop-engine.behavior.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isTerminalStatus, parseBriefFrontmatter, runWorkflow, type WorkflowConfig } from '../../src/scheduler.js';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../../src/adapters/base.js';
import {
  createRun,
  isTerminalRunStatus,
  isSuccessfulRunStatus,
  readRunState,
  runDir,
  writeRunState,
  TERMINAL_STATUSES,
} from '../../src/store.js';
import { detectStalledStages } from '../../src/supervisor.js';

describe('GAP-1 — scheduler isTerminalStatus is unified with store isTerminalRunStatus', () => {
  it('returns true for ALL terminal statuses, incl. reality_gate_failed and failed (the prior omission)', () => {
    expect(isTerminalStatus('reality_gate_failed')).toBe(true); // was FALSE before the fix
    expect(isTerminalStatus('failed')).toBe(true);              // was FALSE before the fix
    expect(isTerminalStatus('shipped')).toBe(true);
    expect(isTerminalStatus('ceiling_hit')).toBe(true);
    expect(isTerminalStatus('escalated')).toBe(true);
    expect(isTerminalStatus('phase_complete')).toBe(true);
    expect(isTerminalStatus('stopped')).toBe(true);
    expect(isTerminalStatus('complete')).toBe(true);
  });

  it('matches store.isTerminalRunStatus exactly for every terminal status', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(isTerminalStatus(s)).toBe(isTerminalRunStatus(s));
    }
  });

  it('returns false for non-terminal / undefined', () => {
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('awaiting_approval')).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});

describe('A+(c) — `incomplete` is a first-class terminal status (not a success)', () => {
  it('is terminal', () => {
    expect(isTerminalRunStatus('incomplete')).toBe(true);
    expect(isTerminalStatus('incomplete')).toBe(true);
    expect((TERMINAL_STATUSES as readonly string[]).includes('incomplete')).toBe(true);
  });
  it('is NOT a success (distinct from ceiling_hit/shipped/complete)', () => {
    expect(isSuccessfulRunStatus('incomplete')).toBe(false);
    // sanity: the honest-negative ceiling IS a success, so they are genuinely distinct
    expect(isSuccessfulRunStatus('ceiling_hit')).toBe(true);
  });
});

describe('GAP-3 — parseBriefFrontmatter surfaces frontmatter errors instead of swallowing them', () => {
  it('reports a YAML parse error (does not silently fall back)', () => {
    const brief = ['---', 'research:', '  baseline: 0', '  policy: [unterminated', '---', '# body'].join('\n');
    const out = parseBriefFrontmatter(brief);
    expect(out.frontmatterError).toBeDefined();
    expect(out.frontmatterError).toMatch(/YAML parse error/i);
    expect(out.research).toBeUndefined(); // it could not parse the block
  });

  it('reports an unclosed frontmatter fence', () => {
    const brief = ['---', 'research:', '  baseline: 0', '# no closing fence'].join('\n');
    const out = parseBriefFrontmatter(brief);
    expect(out.frontmatterError).toBeDefined();
    expect(out.frontmatterError).toMatch(/never closed/i);
  });

  it('reports a non-object frontmatter mapping', () => {
    const brief = ['---', 'just a scalar string', '---', '# body'].join('\n');
    const out = parseBriefFrontmatter(brief);
    expect(out.frontmatterError).toBeDefined();
    expect(out.frontmatterError).toMatch(/not a YAML mapping/i);
  });

  it('does NOT set frontmatterError for a brief with NO frontmatter at all', () => {
    const out = parseBriefFrontmatter('# just a plain brief\n\nno frontmatter here');
    expect(out.frontmatterError).toBeUndefined();
    expect(out.stripped).toContain('plain brief');
  });

  it('does NOT set frontmatterError for valid frontmatter (no false positive)', () => {
    const brief = ['---', 'research:', '  baseline: 1.0', '  policy: greedy_stack', '---', '# body'].join('\n');
    const out = parseBriefFrontmatter(brief);
    expect(out.frontmatterError).toBeUndefined();
    expect(out.research?.baseline).toBe(1.0);
  });

  it('parses the A+(a) research.confirm block when declared', () => {
    const brief = [
      '---', 'research:', '  baseline: 1.0', '  policy: greedy_stack',
      '  confirm:', '    command: ./scripts/reconfirm.sh', '    requires: beat on a fresh split', '    timeout_seconds: 120',
      '---', '# body',
    ].join('\n');
    const out = parseBriefFrontmatter(brief);
    expect(out.frontmatterError).toBeUndefined();
    expect(out.research?.confirm?.command).toBe('./scripts/reconfirm.sh');
    expect(out.research?.confirm?.requires).toBe('beat on a fresh split');
    expect(out.research?.confirm?.timeoutSeconds).toBe(120);
  });
});

describe('GAP-2 — detectStalledStages (pure, deterministic, no LLM verdict)', () => {
  const THRESHOLD = 600_000; // 10 min

  it('initializes a first-seen stage to now (not stalled)', () => {
    const now = 1_000_000;
    const r = detectStalledStages({ runningStages: ['impl'], progressedStageIds: new Set(), lastProgressMs: {}, now, thresholdMs: THRESHOLD });
    expect(r.stalledStageIds).toEqual([]);
    expect(r.nextLastProgressMs.impl).toBe(now);
  });

  it('does NOT abort a stage that progressed this tick (fresh bytes/artifact/transition)', () => {
    const now = 2_000_000;
    const prior = { impl: now - THRESHOLD - 5000 }; // would be stalled if no progress
    const r = detectStalledStages({ runningStages: ['impl'], progressedStageIds: new Set(['impl']), lastProgressMs: prior, now, thresholdMs: THRESHOLD });
    expect(r.stalledStageIds).toEqual([]);
    expect(r.nextLastProgressMs.impl).toBe(now); // clock reset
  });

  it('does NOT abort a stage still within the threshold', () => {
    const now = 3_000_000;
    const prior = { impl: now - (THRESHOLD - 1) };
    const r = detectStalledStages({ runningStages: ['impl'], progressedStageIds: new Set(), lastProgressMs: prior, now, thresholdMs: THRESHOLD });
    expect(r.stalledStageIds).toEqual([]);
    expect(r.nextLastProgressMs.impl).toBe(prior.impl); // carried forward, not reset
  });

  it('ABORTS a stage that has shown no progress for >= threshold', () => {
    const now = 4_000_000;
    const prior = { impl: now - THRESHOLD }; // exactly at threshold
    const r = detectStalledStages({ runningStages: ['impl'], progressedStageIds: new Set(), lastProgressMs: prior, now, thresholdMs: THRESHOLD });
    expect(r.stalledStageIds).toEqual(['impl']);
  });

  it('aborts only the stalled stage among several running', () => {
    const now = 5_000_000;
    const prior = { stuck: now - THRESHOLD - 1, busy: now - 1000 };
    const r = detectStalledStages({
      runningStages: ['stuck', 'busy'],
      progressedStageIds: new Set(['busy']),
      lastProgressMs: prior,
      now,
      thresholdMs: THRESHOLD,
    });
    expect(r.stalledStageIds).toEqual(['stuck']);
    expect(r.nextLastProgressMs.busy).toBe(now);
  });

  it('drops a stage that is no longer running (completed / iteration transition)', () => {
    const now = 6_000_000;
    const prior = { done: now - 50_000, impl: now - 1000 };
    const r = detectStalledStages({ runningStages: ['impl'], progressedStageIds: new Set(), lastProgressMs: prior, now, thresholdMs: THRESHOLD });
    expect(r.nextLastProgressMs.done).toBeUndefined();
    expect(r.nextLastProgressMs.impl).toBeDefined();
  });
});

// =====================================================================================
// GAP-1 + A+(c) — end-to-end: a non-research run whose gate never passes exhausts its
// iteration budget and resolves `incomplete` (NOT the old unconditional 'failed' clobber).
// =====================================================================================
describe('GAP-1 + A+(c) integration — max-iters yields `incomplete`, not a `failed` clobber', () => {
  let projectDir: string;
  beforeEach(() => { projectDir = join(tmpdir(), 'fc-ap-' + randomBytes(6).toString('hex')); mkdirSync(projectDir, { recursive: true }); });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  const planWorkflow: { config: WorkflowConfig; yaml: string } = {
    yaml: ['name: plan-only', 'defaults:', '  max_iterations: 3', 'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true'].join('\n'),
    config: { name: 'plan-only', defaults: { max_iterations: 3 }, stages: [{ id: 'plan', role: 'planner', depends_on: [], prompt_template: '', dynamic_dispatch: true, is_gate: false, skills: [] }] },
  };
  const ok = (output: string): RunResult => ({ output, exitCode: 0, duration_ms: 1 });

  function setupPlainRun(): string {
    const created = createRun(projectDir, 'plan-only', planWorkflow.yaml, ['plan']);
    const rd = runDir(projectDir, created.runId);
    writeFileSync(join(rd, 'scheduler.pid'), String(process.pid));
    writeFileSync(join(rd, 'task_brief.md'), '# Test task\nDo the thing.');
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    for (const role of ['planner', 'qa']) {
      writeFileSync(join(agentsDir, `${role}.yaml`), [`name: ${role}`, 'description: test role', 'model: default', 'reasoning_effort: default', 'tools: []', 'prompt: test'].join('\n'));
    }
    const state = readRunState(projectDir, created.runId);
    state.autoApprove = true;
    writeRunState(projectDir, created.runId, state);
    return created.runId;
  }

  it('a gate that never passes exhausts the budget → `incomplete` (terminal, not a success, not a crash)', async () => {
    const runId = setupPlainRun();
    const agentsDir = join(projectDir, 'config', 'agents');
    // Every iteration: plan a gate stage that writes a FAILING verdict, so gates never pass.
    const adapter = {
      async run(_p: string, _r: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === 'plan') {
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), ['stages:', '  - id: check', '    role: qa', '    depends_on: [plan]', '    is_gate: true', '    task: gate'].join('\n'));
          return ok('planned a gate');
        }
        if (opts.stageId === 'check') {
          writeFileSync(join(opts.runDir, 'verdict_check.json'), JSON.stringify({ pass: false, reason: 'not yet' }));
          return ok('gate failed');
        }
        return ok(`noop ${opts.stageId}`);
      },
      async discuss(): Promise<RunResult> { return ok(''); },
      spawnDiscuss() { throw new Error('unused'); },
      async spawnInteractive() { throw new Error('unused'); },
    } as unknown as Adapter;

    const final = await runWorkflow(planWorkflow.config, planWorkflow.yaml, projectDir, adapter, new Map(), undefined, agentsDir, runId);
    expect(final.status).toBe('incomplete');          // A+(c): budget exhausted mid-search
    expect(final.status).not.toBe('failed');          // no longer the unconditional 'failed' clobber
    expect(isTerminalRunStatus(final.status)).toBe(true);
    expect(isSuccessfulRunStatus(final.status)).toBe(false);
  });
});
