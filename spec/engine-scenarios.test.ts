import { runRecordPath } from '../src/run-layout.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import { atomicWrite } from '../src/engine-fs.js';
import { declaredDispatch, fixtureArtifactContract } from './test-support/declared-dispatch.js';
/**
 * Engine wind-tunnel scenarios — the REAL scheduler run end-to-end against a
 * ScriptedAdapter (deterministic fake agent), replicating in milliseconds the
 * engine-fix validation campaigns that previously needed live codex runs:
 *
 *   Scenario A (research loop): confirm-fail must EXCLUDE the candidate and
 *   CONTINUE (fix 1a), a premature ceiling must be DEFERRED by the declared
 *   floor (fix 1b), the engine-initiated terminal must write the declared
 *   artifact path (fix 2), a planner-authored reality check may rely on a
 *   pre-gate stage artifact, and terminal checks must use the framework-owned
 *   manifest instead of the optional shared round slot (fix 4).
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
    config, raw, projectDir, withConfirmedRejections(adapter), new Map(), undefined,
    join(PROJECT_ROOT, 'config', 'agents'),
    reuse?.runId, brief,
    /* autoApprove */ true, /* supervise */ undefined, /* inheritCampaignContext */ false,
  );
  const runDirPath = join(fcHome, 'runs', state.runId!);
  const readRun = (name: string) => readFileSync(runRecordPath(runDirPath, name), 'utf-8');
  const readProj = (name: string) => readFileSync(join(projectDir, name), 'utf-8');
  // Guidance is consumed by the next plan stage and archived under
  // guidance_history/ — collect the live file plus all archived generations.
  const allGuidance = () => {
    let out = '';
    const live = runRecordPath(runDirPath, 'supervisor_guidance.md');
    if (existsSync(live)) out += readFileSync(live, 'utf-8');
    const hist = runRecordPath(runDirPath, 'guidance_history');
    if (existsSync(hist)) for (const f of readdirSync(hist)) out += readFileSync(join(hist, f), 'utf-8');
    return out;
  };
  return { state, projectDir, runDirPath, readRun, readProj, allGuidance, adapter };
}

interface ScriptedDispatchStage {
  id: string;
  dependsOn?: string[];
  condition?: string;
  scope?: string[];
  maxRetries?: number;
  isGate?: boolean;
  retryTo?: string[];
}

const DEFAULT_RESEARCH_SCOPE = [
  'research/val/round_result.json',
  'research/val/round_result.json.no_candidate.json',
  'research/val/confirm_flag',
  'research/val/stage_*_verdict.md',
];

function strictResearchDispatch(
  stages: ScriptedDispatchStage[],
  terminalPaths = ['research/val/ship_report.md'],
  contracts: NonNullable<Parameters<typeof declaredDispatch>[1]> = {},
): string {
  const rows = stages.map((stage) => {
    const dependencies = stage.dependsOn ?? [];
    return { artifact_contract: contracts[stage.id] ?? fixtureArtifactContract(stage.id, stage.isGate === true),
      id: stage.id,
      role: 'researcher',
      depends_on: dependencies,
      scope: stage.scope ?? DEFAULT_RESEARCH_SCOPE,
      dependency_reasons: Object.fromEntries(dependencies.map((dependency) => [dependency, `scripted dependency on ${dependency}`])),
      ...(stage.condition ? { condition: stage.condition } : {}),
      ...(stage.maxRetries !== undefined ? { max_retries: stage.maxRetries } : {}),
      ...(stage.isGate ? { is_gate: true } : {}),
      ...(stage.retryTo ? { retry_to: stage.retryTo } : {}),
      prompt_template: 'scripted stage',
    };
  });
  const mandatory = stages.filter((stage) => !stage.condition).map((stage) => stage.id);
  rows.push({ artifact_contract: fixtureArtifactContract('research_finalize', false),
    id: 'research_finalize',
    role: 'researcher',
    depends_on: mandatory,
    scope: terminalPaths,
    dependency_reasons: Object.fromEntries(mandatory.map((dependency) => [dependency, `terminal decision follows ${dependency}`])),
    condition: 'research.decision != continue',
    prompt_template: 'write only the terminal path selected by research_decision.json',
  });
  return JSON.stringify(rows, null, 2);
}

const dispatchOf = (id: string, terminalPaths = ['research/val/ship_report.md', 'research/val/ceiling_report.md'], checkConfirmation = false) => ({
  runFiles: {
    'dispatch.yaml': strictResearchDispatch([{ id }], terminalPaths, checkConfirmation ? {
      [id]: { version: 1, produces: [{ id: 'confirm', root: 'project', path: 'research/val/confirm_flag' }], reads: [] },
    } : {}),
    ...(checkConfirmation ? {'reality_checks.md':['## Reality checks','```yaml','checks:',
      ' - name: confirmation_input_present','   type: exec-script-exit-zero',
      `   reads: [{id: confirm, root: project, path: research/val/confirm_flag, source: {kind: stage, stage: ${id}, artifact: confirm}}]`,
      '   params: {script: "test -f research/val/confirm_flag", timeout_seconds: 30}','```'].join('\n')} : {}),
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
  policy: greedy_stack
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
        dispatchOf('measure_r1',undefined,true),
        dispatchOf('measure_r2',undefined,true),
        dispatchOf('measure_r3',undefined,true),
        dispatchOf('measure_r4',undefined,true),
        dispatchOf('measure_r5',undefined,true),
      ],
      measure_r1: round('r1_baseline', 0.5),
      measure_r2: round('r2_decoy', 9.9),      // beats target 9.0 → ship → confirm FAILS
      measure_r3: round('r3_flat', 0.4),
      measure_r4: round('r4_flat', 0.3),
      measure_r5: round('r5_flat', 0.2),
      research_finalize: {
        projectFiles: { 'research/val/ceiling_report.md': '# Ceiling\npolicy-selected terminal report' },
      },
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
    expect(state.terminalArtifact).toBe('research/val/ceiling_report.md');

    // A later round may replace/remove the optional shared slot. The manifest
    // retains the consumed population and the rejected candidate's outcome.
    const manifest = JSON.parse(readFileSync(join(projectDir, 'research/val/run_manifest.json'), 'utf8')) as { rounds: Array<{ label: string; confirmFailed?: boolean }> };
    expect(manifest.rounds).toHaveLength(journal.rounds.length);
    expect(manifest.rounds.find(row => row.label === decoy?.label)?.confirmFailed).toBe(true);
    const gate = JSON.parse(readRun('.reality-gate.json')) as { pass: boolean };
    expect(gate.pass).toBe(true);
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
  policy: greedy_stack
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
      research_finalize: {
        projectFiles: { 'research/val/ceiling_report.md': '# Ceiling\nbudget-exhausted terminal report' },
      },
    }, /* maxIterations */ 5);

    expect(state.status).toBe('ceiling_hit');
    // Bug #7: this exit door used to skip the terminal contract entirely.
    expect(state.terminalArtifact).toBe('research/val/ceiling_report.md');
    expect(existsSync(join(projectDir, 'research/val/ceiling_report.md'))).toBe(true);
    expect(readFileSync(join(projectDir, 'research/val/ceiling_report.md'), 'utf-8')).toContain('budget-exhausted');
    // A later terminal writer must not resurrect a scheduler-consumed slot.
    expect(existsSync(join(projectDir, 'research/val/round_result.json'))).toBe(false);
  }, 60000);
});

// ---------------------------------------------------------------------------
