/**
 * Engine wind-tunnel scenarios — the REAL scheduler run end-to-end against a
 * ScriptedAdapter (deterministic fake agent), replicating in milliseconds the
 * engine-fix validation campaigns that previously needed live codex runs:
 *
 *   Scenario A (research loop): confirm-fail must EXCLUDE the candidate and
 *   CONTINUE (fix 1a), a premature ceiling must be DEFERRED by the declared
 *   floor (fix 1b), the engine-initiated terminal must write the declared
 *   artifact path (fix 2), and a planner-authored reality check referencing
 *   the engine-consumed round_result.json must still pass at terminal time
 *   (fix 4: consumed-result restore).
 *
 *   Scenario B (unified terminal gate): an agent writing ship_report.md
 *   directly must be REJECTED by the confirm gate (hole 5), the run must end
 *   non-shipped via an honest ceiling, and stages left pending at terminal
 *   commit must be swept to 'skipped' (fix 3).
 *
 * Isolation: FC_HOME points at a temp dir (set BEFORE importing any src
 * module), so runs/campaign ledgers never touch the real ~/.fc.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

let fcHome: string;
let realFcHome: string;
let store: typeof import('../src/store.js');
let scheduler: typeof import('../src/scheduler.js');
let ScriptedAdapter: typeof import('../src/adapters/scripted.js').ScriptedAdapter;

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

beforeAll(async () => {
  fcHome = mkdtempSync(join(tmpdir(), `fc-home-${randomBytes(4).toString('hex')}-`));
  // Use the runtime setter (NOT the FC_HOME env var): vitest reuses workers
  // across test files, so module-level state must be restored in afterAll or
  // a later file in the same worker would inherit a deleted temp fc-home.
  store = await import('../src/store.js');
  realFcHome = store.fcGlobalDir();
  store.setFcGlobalDir(fcHome);
  scheduler = await import('../src/scheduler.js');
  ({ ScriptedAdapter } = await import('../src/adapters/scripted.js'));
});

afterAll(() => {
  store.setFcGlobalDir(realFcHome);
  rmSync(fcHome, { recursive: true, force: true });
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), `fc-proj-${randomBytes(4).toString('hex')}-`));
  mkdirSync(join(dir, 'research', 'val'), { recursive: true });
  return dir;
}

async function runScenario(
  brief: string,
  script: ConstructorParameters<typeof ScriptedAdapter>[0],
  maxIterations = 8,
  reuse?: { projectDir: string; runId?: string },
  adapterOverride?: InstanceType<typeof ScriptedAdapter>,
) {
  const projectDir = reuse?.projectDir ?? makeProject();
  const { config, raw } = scheduler.loadWorkflow(join(PROJECT_ROOT, 'config', 'workflows', 'research.yaml'));
  config.defaults.max_iterations = maxIterations;
  const adapter = adapterOverride ?? new ScriptedAdapter(script);
  const state = await scheduler.runWorkflow(
    config, raw, projectDir, adapter, new Map(), undefined,
    join(PROJECT_ROOT, 'config', 'agents'),
    reuse?.runId, brief,
    /* autoApprove */ true, /* supervise */ false,
    /* campaignId */ undefined, /* inheritCampaignContext */ false,
  );
  const runDirPath = join(fcHome, 'runs', state.runId!);
  const readRun = (name: string) => readFileSync(join(runDirPath, name), 'utf-8');
  const readProj = (name: string) => readFileSync(join(projectDir, name), 'utf-8');
  // Guidance is consumed by the next plan stage and archived under
  // guidance_history/ — collect the live file plus all archived generations.
  const allGuidance = () => {
    let out = '';
    const live = join(runDirPath, 'supervisor_guidance.md');
    if (existsSync(live)) out += readFileSync(live, 'utf-8');
    const hist = join(runDirPath, 'guidance_history');
    if (existsSync(hist)) for (const f of readdirSync(hist)) out += readFileSync(join(hist, f), 'utf-8');
    return out;
  };
  return { state, projectDir, runDirPath, readRun, readProj, allGuidance, adapter };
}

const dispatchOf = (id: string) => ({
  runFiles: {
    'dispatch.yaml': `- id: ${id}\n  role: researcher\n  prompt_template: |\n    scripted stage\n`,
  },
});

// ---------------------------------------------------------------------------

const BRIEF_A = `---
terminal_states:
  shipped:
    paths: [research/val/ship_report.md]
  ceiling_hit:
    paths: [research/val/ceiling_report.md]
    floor:
      min_attempted_stages: 4
research:
  baseline: 0.0
  policy: best_of_n
  higher_is_better: true
  result_file: research/val/round_result.json
  report_dir: research/val
  confirm:
    command: "grep -q PASS research/val/confirm_flag"
    requires: "confirm_flag must contain PASS (holdout analog)"
    timeout_seconds: 30
  stop:
    beat: 9.0
    max_rounds: 6
    halt_after_no_improvement: 2
---
# Scenario A — decoy must not ship; floor must force 4 rounds
`;

describe('Scenario A: research loop honesty (fixes 1a, 1b, 2, 4)', () => {
  it('confirm-fail continues, floor defers, declared path mirrored, gate passes on restored result', async () => {
    const round = (label: string, result: number) => ({
      projectFiles: {
        'research/val/round_result.json': JSON.stringify({ label, result }),
        'research/val/confirm_flag': 'FAIL',
      },
      output: `measured ${label}`,
    });
    const { state, readRun, projectDir, allGuidance } = await runScenario(BRIEF_A, {
      plan: [
        { ...dispatchOf('measure_r1'),
          runFiles: {
            ...dispatchOf('measure_r1').runFiles,
            'reality_checks.md': [
              '## Reality checks',
              '```yaml',
              'checks:',
              '  - name: result_file_present',
              '    type: exec-script-exit-zero',
              '    params:',
              '      timeout_seconds: 30',
              '      script: |',
              '        test -f research/val/round_result.json',
              '```',
            ].join('\n'),
          } },
        dispatchOf('measure_r2'),
        dispatchOf('measure_r3'),
        dispatchOf('measure_r4'),
        dispatchOf('measure_r5'),
      ],
      measure_r1: round('r1_baseline', 0.5),
      measure_r2: round('r2_decoy', 9.9),      // beats target 9.0 → ship → confirm FAILS
      measure_r3: round('r3_flat', 0.4),
      measure_r4: round('r4_flat', 0.3),
      measure_r5: round('r5_flat', 0.2),
    });

    // Fix 1a: the decoy was excluded, run did NOT die at round 2.
    const journal = JSON.parse(readRun('research_journal.json')) as { rounds: Array<{ label: string; confirmFailed?: boolean }> };
    const decoy = journal.rounds.find((r) => r.label === 'r2_decoy');
    expect(decoy?.confirmFailed).toBe(true);
    expect(journal.rounds.length).toBeGreaterThanOrEqual(4);

    // Confirm record exists and failed.
    const confirm = JSON.parse(readRun('research_confirm.json')) as { pass: boolean };
    expect(confirm.pass).toBe(false);

    // Fix 1b: a premature ceiling (streak of 2 at round 3 < floor 4) was deferred.
    expect(allGuidance()).toContain('[research-floor:round-3]');

    // Honest terminal: ceiling, never shipped.
    expect(state.status).toBe('ceiling_hit');

    // Fix 2: engine-initiated terminal mirrored the report to the DECLARED path.
    expect(existsSync(join(projectDir, 'research/val/ceiling_report.md'))).toBe(true);
    expect(state.terminalArtifact).toBe('ceiling_report.md');

    // Fix 4: planner-authored check referencing the consumed round_result.json
    // passed at terminal time (engine restored the last consumed result).
    const gate = JSON.parse(readRun('.reality-gate.json')) as { pass: boolean };
    expect(gate.pass).toBe(true);
  }, 60000);
});

// ---------------------------------------------------------------------------

const BRIEF_B = `---
terminal_states:
  shipped:
    paths: [research/val/ship_report.md]
  ceiling_hit:
    paths: [research/val/ceiling_report.md]
    floor:
      min_attempted_stages: 4
research:
  baseline: 0.0
  policy: best_of_n
  higher_is_better: true
  result_file: research/val/round_result.json
  report_dir: research/val
  confirm:
    command: "grep -q PASS research/val/confirm_flag"
    requires: "confirm_flag must contain PASS"
    timeout_seconds: 30
  stop:
    beat: 9.0
    max_rounds: 6
---
# Scenario B — direct ship_report.md must be rejected; pending stages swept
`;

describe('Scenario B: ship-bypass rejection + pending sweep (hole 5, fix 3)', () => {
  it('agent-authored ship file is rejected by confirm; run ends non-shipped; leftover stage skipped', async () => {
    // The floor's realness filter ignores files under MIN_STAGE_VERDICT_BYTES
    // (40) — verdicts must carry substantive content to count.
    const verdicts: Record<string, string> = {};
    for (let i = 1; i <= 4; i++) {
      verdicts[`research/val/stage_${i}_verdict.md`] = `# Verdict ${i}\n\nDirection ${i} measured via the harness; no candidate passed the gate.\n`;
    }

    const { state, readRun, allGuidance } = await runScenario(BRIEF_B, {
      plan: [{
        runFiles: {
          'dispatch.yaml': [
            '- id: bait',
            '  role: researcher',
            '  prompt_template: |',
            '    scripted',
            '- id: tail',
            '  role: researcher',
            '  depends_on: [bait]',
            '  prompt_template: |',
            '    scripted',
            '- id: never_runs',
            '  role: researcher',
            '  depends_on: [tail]',
            '  prompt_template: |',
            '    scripted',
          ].join('\n'),
        },
      }],
      // The bait: writes a ship claim DIRECTLY at the declared shipped path,
      // with a failing confirm flag — the pre-fix engine would commit 'shipped'
      // without ever running confirm.
      bait: {
        projectFiles: {
          'research/val/ship_report.md': '# Ship!\ntrain 9.9 — mission accomplished',
          'research/val/confirm_flag': 'FAIL',
        },
      },
      // Honest fallback the agent writes after the rejection guidance.
      tail: {
        projectFiles: {
          ...verdicts,
          'research/val/ceiling_report.md': '# Ceiling\nno candidate passed confirm',
        },
      },
    });

    // Hole 5: never shipped; rejection recorded with the terminal-file trigger.
    expect(state.status).not.toBe('shipped');
    expect(state.status).toBe('ceiling_hit');
    expect(allGuidance()).toContain('shipped-confirm');
    const confirm = JSON.parse(readRun('research_confirm.json')) as { pass: boolean; trigger?: string };
    expect(confirm.pass).toBe(false);
    expect(confirm.trigger).toContain('ship_report.md');

    // Fix 3: the stage that never got to run was swept to 'skipped', not left pending.
    expect(state.stages['never_runs']?.status).toBe('skipped');
  }, 60000);
});

// ---------------------------------------------------------------------------

const BRIEF_C = `---
terminal_states:
  shipped:
    paths: [research/val/ship_report.md]
  ceiling_hit:
    paths: [research/val/ceiling_report.md]
    floor:
      min_attempted_stages: 3
research:
  baseline: 0.0
  policy: best_of_n
  higher_is_better: true
  result_file: research/val/round_result.json
  report_dir: research/val
  stop:
    beat: 9.0
    halt_after_no_improvement: 2
---
# Scenario C — budget-exhausted terminal must honor the terminal contract too
`;

describe('Scenario C: budget-exhausted terminal honesty (bug #7)', () => {
  it('iteration exhaustion with banked rounds commits ceiling_hit WITH declared artifact + terminalArtifact', async () => {
    // Alternating improve/flat keeps the no-improvement streak below halt (2),
    // so the POLICY never terminates — iterations run out instead, exercising
    // the third exit door (finishResearchCeiling).
    const round = (label: string, result: number) => ({
      projectFiles: { 'research/val/round_result.json': JSON.stringify({ label, result }) },
    });
    const { state, projectDir } = await runScenario(BRIEF_C, {
      plan: [
        dispatchOf('measure_c1'), dispatchOf('measure_c2'), dispatchOf('measure_c3'),
        dispatchOf('measure_c4'), dispatchOf('measure_c5'),
      ],
      measure_c1: round('c1', 0.5),
      measure_c2: round('c2', 0.4),   // streak 1
      measure_c3: round('c3', 0.6),   // improvement — streak resets
      measure_c4: round('c4', 0.5),   // streak 1
      measure_c5: round('c5', 0.7),   // improvement — streak resets
    }, /* maxIterations */ 5);

    expect(state.status).toBe('ceiling_hit');
    // Bug #7: this exit door used to skip the terminal contract entirely.
    expect(state.terminalArtifact).toBe('ceiling_report.md');
    expect(existsSync(join(projectDir, 'research/val/ceiling_report.md'))).toBe(true);
    expect(readFileSync(join(projectDir, 'research/val/ceiling_report.md'), 'utf-8')).toContain('budget-exhausted');
  }, 60000);
});

// ---------------------------------------------------------------------------

const BRIEF_D = `---
terminal_states:
  shipped:
    paths: [research/val/ship_report.md]
research:
  baseline: 0.0
  policy: best_of_n
  higher_is_better: true
  result_file: research/val/round_result.json
  report_dir: research/val
  stop:
    beat: 9.0
    max_rounds: 4
---
# Scenario D — a consequential action must PARK for a human, then resume
`;

const REQUEST = (id: string, extra: Record<string, unknown> = {}) => ({
  runFiles: {
    'approval_request.json': JSON.stringify({
      id, action: 'deploy', target: 'mainnet', risk: 'external',
      title: 'deploy the strategy to mainnet', body: 'real money', ...extra,
    }),
  },
});

describe('Scenario D: approval park / resume (inbox)', () => {
  it('parks on an agent-written request, records it durably, and does NOT finish the run', async () => {
    const inbox = await import('../src/inbox.js');
    const { state, runDirPath, projectDir } = await runScenario(BRIEF_D, {
      plan: [{ runFiles: { 'dispatch.yaml': '- id: act\n  role: researcher\n  prompt_template: |\n    s\n' } }],
      act: REQUEST('deploy-1'),
    });

    // Paused, not terminal, not finished.
    expect(state.status).toBe('parked');
    expect(state.completedAt).toBeUndefined();
    expect(store.isTerminalRunStatus(state.status)).toBe(false);
    expect(store.isPausedRunStatus(state.status)).toBe(true);
    expect(state.parked).toMatchObject({ requestId: 'deploy-1', action: 'deploy', target: 'mainnet' });

    // The requesting stage must not be frozen 'running' — findAllReady only ever
    // picks 'pending', so a frozen stage makes the resumed iteration re-plan and
    // delete the dispatched DAG.
    expect(state.stages['act']?.status).toBe('complete');

    // Durable + idempotent inbox record.
    const items = inbox.foldItems(state.runId!);
    expect(items.get('deploy-1')?.state).toBe('pending');
    expect(existsSync(join(runDirPath, 'approvals', 'deploy-1.request.json'))).toBe(true);
    expect(existsSync(join(runDirPath, 'approval_request.json'))).toBe(false); // consumed

    // A park must never write a campaign ledger row (it has no outcome to score).
    const events = readFileSync(join(runDirPath, 'events.jsonl'), 'utf-8');
    expect(events).toContain('approval_parked');

    // ---- resume after approval: same runId, same iteration, run completes ----
    const res = inbox.resolveRequest(projectDir, state.runId!, 'deploy-1', 'approve', { by: 'tester' });
    expect(res.won).toBe(true);
    expect(inbox.foldItems(state.runId!).get('deploy-1')?.state).toBe('approved');

    const resumed = await runScenario(BRIEF_D, {
      plan: [{ runFiles: { 'dispatch.yaml': '- id: finish\n  role: researcher\n  prompt_template: |\n    s\n' } }],
      finish: { projectFiles: { 'research/val/round_result.json': JSON.stringify({ label: 'after_approval', result: 9.5 }) } },
    }, 8, { projectDir, runId: state.runId! });

    expect(resumed.state.runId).toBe(state.runId);
    expect(store.isPausedRunStatus(resumed.state.status)).toBe(false);
    expect(resumed.state.status).not.toBe('parked');
    // A resume continues the run's own iteration — it must NOT hand back a fresh
    // full budget (N park cycles would otherwise buy N x maxIterations of work).
    expect(resumed.state.currentIteration ?? 0).toBeGreaterThanOrEqual(state.parked!.atIteration);
  }, 60000);

  it('first resolution wins — a second, contradictory decision cannot land', async () => {
    const inbox = await import('../src/inbox.js');
    const { state, projectDir } = await runScenario(BRIEF_D, {
      plan: [{ runFiles: { 'dispatch.yaml': '- id: act\n  role: researcher\n  prompt_template: |\n    s\n' } }],
      act: REQUEST('race-1'),
    });
    const first = inbox.resolveRequest(projectDir, state.runId!, 'race-1', 'approve', { by: 'alice' });
    const second = inbox.resolveRequest(projectDir, state.runId!, 'race-1', 'deny', { by: 'bob' });

    expect(first.won).toBe(true);
    expect(second.won).toBe(false);
    expect(second.error).toContain('already approved');
    expect(inbox.foldItems(state.runId!).get('race-1')?.resolution?.by).toBe('alice');
  }, 60000);

  it('a standing rule auto-approves without parking; ineligible risks cannot mint one', async () => {
    const inbox = await import('../src/inbox.js');
    const projectDir = makeProject();
    inbox.addStandingRule({
      projectDir, action: 'deploy', target: 'mainnet',
      grantedBy: 'tester', grantedAt: new Date().toISOString(),
    });

    const { state } = await runScenario(BRIEF_D, {
      plan: [{ runFiles: { 'dispatch.yaml': '- id: act\n  role: researcher\n  prompt_template: |\n    s\n' } }],
      act: {
        ...REQUEST('auto-1'),
        projectFiles: { 'research/val/round_result.json': JSON.stringify({ label: 'auto', result: 9.9 }) },
      },
    }, 8, { projectDir });

    expect(state.status).not.toBe('parked');
    expect(inbox.foldItems(state.runId!).get('auto-1')?.state).toBe('approved');
    expect(inbox.foldItems(state.runId!).get('auto-1')?.resolution?.by).toBe('standing-rule');

    // "always" is only offered where it is bounded: external risk + exact target.
    expect(inbox.standingRuleEligible({
      kind: 'request', runId: 'r', projectDir, requestId: 'x', action: 'run_shell',
      risk: 'exec', title: 't', createdAt: 'now',
    }).ok).toBe(false);
    expect(inbox.standingRuleEligible({
      kind: 'request', runId: 'r', projectDir, requestId: 'y', action: 'deploy',
      risk: 'external', title: 't', createdAt: 'now',
    }).ok).toBe(false);   // no target
  }, 60000);
});

// ---------------------------------------------------------------------------

const BRIEF_E = `---
terminal_states:
  shipped:
    paths: [research/val/ship_report.md]
research:
  baseline: 0.0
  policy: best_of_n
  higher_is_better: true
  result_file: research/val/round_result.json
  report_dir: research/val
  stop:
    beat: 9.0
    max_rounds: 4
---
# Scenario E — iteration-two approval resume preserves the same DAG
`;

const ITERATION_TWO_DISPATCH = [
  '- id: safe_before',
  '  role: researcher',
  '  prompt_template: safe preparation',
  '- id: finish_after',
  '  role: researcher',
  '  depends_on: [approved_action]',
  '  prompt_template: finish after approval',
  '- id: approved_action',
  '  role: researcher',
  '  depends_on: [safe_before]',
  '  prompt_template: request approval before action',
  '',
].join('\n');

describe('Scenario E: iteration-two park resumes the exact DAG (C1/L3)', () => {
  it('preserves dispatch, completed stages, prior guidance, and executes the approved action once', async () => {
    const inbox = await import('../src/inbox.js');
    const script: ConstructorParameters<typeof ScriptedAdapter>[0] = {
      plan: [
        {
          runFiles: {
            'dispatch.yaml': '- id: round_one\n  role: researcher\n  prompt_template: first round\n',
            'supervisor_guidance.md': 'iteration-one-guidance\n',
          },
        },
        { runFiles: { 'dispatch.yaml': ITERATION_TWO_DISPATCH } },
        // A broken resume re-runs plan and re-dispatches the consequential stage.
        { runFiles: { 'dispatch.yaml': ITERATION_TWO_DISPATCH } },
      ],
      round_one: {
        projectFiles: {
          'research/val/round_result.json': JSON.stringify({ label: 'round-one', result: 1 }),
        },
      },
      safe_before: { output: 'prepared' },
      approved_action: {
        runFiles: {
          'stages/approved_action/approval_request.json': JSON.stringify({
            id: 'iter2-action',
            action: 'send_order',
            target: 'testnet',
            risk: 'external',
            title: 'send the approved testnet order',
          }),
        },
      },
      finish_after: {
        projectFiles: {
          'research/val/round_result.json': JSON.stringify({ label: 'after-approval', result: 9.5 }),
        },
      },
    };
    const adapter = new ScriptedAdapter(script);
    const parked = await runScenario(BRIEF_E, script, 4, undefined, adapter);

    expect(parked.state.status).toBe('parked');
    expect(parked.state.parked?.atIteration).toBe(2);
    expect(parked.state.stages.safe_before?.status).toBe('complete');
    expect(parked.state.stages.approved_action?.status).toBe('complete');
    expect(parked.state.stages.finish_after?.status).toBe('pending');

    const dispatchBefore = readFileSync(join(parked.runDirPath, 'dispatch.yaml'), 'utf-8');
    const guidanceArchive = join(parked.runDirPath, 'guidance_history', 'iter_1.md');
    const guidanceBefore = readFileSync(guidanceArchive, 'utf-8');
    expect(guidanceBefore).toContain('iteration-one-guidance');

    const resolution = inbox.resolveRequest(
      parked.projectDir,
      parked.state.runId!,
      'iter2-action',
      'approve',
      { by: 'scenario-e' },
    );
    expect(resolution.won).toBe(true);

    const resumed = await runScenario(
      BRIEF_E,
      script,
      4,
      { projectDir: parked.projectDir, runId: parked.state.runId! },
      adapter,
    );

    expect(resumed.state.status).toBe('shipped');
    expect(readFileSync(join(resumed.runDirPath, 'dispatch.yaml'), 'utf-8')).toBe(dispatchBefore);
    expect(resumed.state.stages.safe_before?.status).toBe('complete');
    expect(resumed.state.stages.approved_action?.status).toBe('complete');
    expect(resumed.state.stages.finish_after?.status).toBe('complete');
    expect(readFileSync(guidanceArchive, 'utf-8')).toBe(guidanceBefore);
    expect(adapter.calls.filter((call) => call.stageId === 'approved_action')).toHaveLength(1);
    expect(adapter.calls.filter((call) => call.stageId === 'plan')).toHaveLength(2);
  }, 60000);
});

describe('Scenario F: daemon reconciles the same bound run after approval (C2)', () => {
  it('moves parked → deferred → done without launching the brief as a new run', async () => {
    const [{ Orchestrator }, { TaskRegistry }, inbox] = await Promise.all([
      import('../src/orchestrator.js'),
      import('../src/task-registry.js'),
      import('../src/inbox.js'),
    ]);
    const projectDir = makeProject();
    const runId = 'scenario-f-bound-run';
    const runPath = join(fcHome, 'runs', runId);
    const registryPath = join(fcHome, 'scenario-f-registry');
    const startedAt = '2026-07-30T00:00:00.000Z';
    let nowMs = Date.parse('2026-07-30T00:01:00.000Z');
    mkdirSync(runPath, { recursive: true });
    writeFileSync(join(runPath, 'run.json'), JSON.stringify({
      runId,
      projectDir,
      status: 'parked',
      parked: {
        requestId: 'scenario-f-approval',
        pausedAt: '2026-07-30T00:00:30.000Z',
      },
    }, null, 2), 'utf-8');
    inbox.recordRequest({
      runId,
      projectDir,
      requestId: 'scenario-f-approval',
      action: 'deploy',
      target: 'scenario-f-target',
      risk: 'external',
      title: 'Scenario F approval',
      createdAt: '2026-07-30T00:00:30.000Z',
    });

    const registry = new TaskRegistry({ baseDir: registryPath, now: () => new Date(nowMs) });
    const task = registry.create({
      brief_text: 'Scenario F must never be launched again',
      projectDir,
      status: 'running',
      commit_prefix: 'feat(scenario-f)',
    });
    registry.update(task.id, { started_at: startedAt });
    const systemd = {
      runs: [] as { unit: string; command: string }[],
      async isActive() { return { kind: 'absent' as const }; },
      async runUnit(opts: { unit: string; command: string }) { this.runs.push(opts); },
      async stopUnit() {},
      async journalTail() { return ''; },
    };
    const git = {
      async findCommitByPrefix() { return 'scenariof123'; },
      async hasUncommittedChanges() { return false; },
      async findCommitSince() { return undefined; },
    };
    const orchestrator = new Orchestrator({
      registry,
      systemd,
      git,
      now: () => new Date(nowMs),
      isProjectBusy: () => null,
      cliPath: join(PROJECT_ROOT, 'dist', 'cli.js'),
    });

    try {
      await orchestrator.tickOnce();
      const parkedTask = registry.get(task.id)!;
      expect(parkedTask).toMatchObject({
        status: 'deferred',
        run_id: runId,
        defer_kind: 'wait',
      });
      expect(parkedTask.not_before).toBeTruthy();
      expect(systemd.runs).toHaveLength(0);

      writeFileSync(join(runPath, 'run.json'), JSON.stringify({
        runId,
        projectDir,
        status: 'complete',
      }, null, 2), 'utf-8');
      writeFileSync(join(runPath, 'task_summary.md'), [
        '# Task Summary',
        '',
        '**Verdict**: PASS',
        '',
        '## What was achieved',
        'The approved bound run completed exactly once.',
        '',
        '## Key numbers',
        '- 0 daemon relaunches',
        '',
        '## Files produced',
        '- task_summary.md',
        '',
        '## What operator should do next',
        'No action required.',
        '',
      ].join('\n'), 'utf-8');
      nowMs += 1_000;

      const launchesBefore = systemd.runs.length;
      await orchestrator.tickOnce();

      expect(systemd.runs).toHaveLength(launchesBefore);
      expect(registry.get(task.id)).toMatchObject({
        status: 'done',
        completing_commit: 'scenariof123',
        summary_source: join(runPath, 'task_summary.md'),
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('Approval request ingestion: isolated slots and failed batches (M3/L2)', () => {
  it('records every valid parallel request even when a peer fails and rejects unsafe ids', async () => {
    const inbox = await import('../src/inbox.js');
    const dispatch = [
      '- id: req_a',
      '  role: researcher',
      '  max_retries: 0',
      '  prompt_template: first request',
      '- id: req_b',
      '  role: researcher',
      '  prompt_template: second request',
      '- id: req_bad',
      '  role: researcher',
      '  prompt_template: unsafe request',
      '',
    ].join('\n');
    const result = await runScenario(BRIEF_D, {
      plan: [{ runFiles: { 'dispatch.yaml': dispatch } }],
      req_a: {
        exitCode: 1,
        runFiles: {
          'stages/req_a/approval_request.json': JSON.stringify({
            id: 'batch-a', action: 'deploy', target: 'alpha', risk: 'external',
          }),
        },
      },
      req_b: {
        runFiles: {
          'stages/req_b/approval_request.json': JSON.stringify({
            id: 'batch-b', action: 'spend', target: 'beta', risk: 'external',
          }),
        },
      },
      req_bad: {
        runFiles: {
          'stages/req_bad/approval_request.json': JSON.stringify({
            id: 'unsafe/request', action: 'write', risk: 'write',
          }),
        },
      },
    });

    expect(result.state.status).toBe('parked');
    const items = inbox.foldItems(result.state.runId!);
    expect([...items.keys()].sort()).toEqual(['batch-a', 'batch-b']);
    expect(existsSync(join(result.runDirPath, 'approvals', 'batch-a.request.json'))).toBe(true);
    expect(existsSync(join(result.runDirPath, 'approvals', 'batch-b.request.json'))).toBe(true);
    expect(existsSync(join(result.runDirPath, 'approvals', 'unsafe'))).toBe(false);
    expect(result.adapter.calls.find((call) => call.stageId === 'req_a')?.prompt)
      .toContain(join(result.runDirPath, 'stages', 'req_a', 'approval_request.json'));
  }, 60000);
});
