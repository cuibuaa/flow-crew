// Boundary: author two isolated candidates, compare text in both orders, then resume only the preferred run
// through the existing independent gates and bounded repairs; try the alternative only if it cannot pass.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RUN_STATUS, readRunState } from './store.js';
import { shipSetupBriefDigest } from './ship-setup-record.js';
import { collectGateRuntimeFacts } from './scheduler/sched_settlement/gate-recovery.js';

/** A candidate as the decision sees it. */
export interface RaceCandidate {
  label: 'A' | 'B';
  target: string;
  status: string;
  /** True only at the scheduler's parked gate frontier, without an approval request. */
  gatesDeferred?: boolean;
  /** Executed repairs remain telemetry; they do not determine pre-gate preference. */
  repairs?: number;
}

/** One comparison: which candidate was shown first, and which letter the judge chose. */
export interface RaceJudgment {
  first: 'A' | 'B';
  choice?: 'A' | 'B';
  reason?: string;
}

export interface RaceDecision {
  choice?: 'A' | 'B';
  basis: 'only-ready' | 'comparison' | 'fallback-order' | 'none-ready' | 'gated-fallback' | 'none-passed';
  reason: string;
}

/** Both orders must agree on the same authored candidate. A missing/position-driven answer
 * has no reliable preference; use stable author order, then let the independent gate decide eligibility. */
export function decideRace(candidates: readonly RaceCandidate[], judgments: readonly RaceJudgment[]): RaceDecision {
  const ready = candidates.filter(c => c.status === RUN_STATUS.PARKED && c.gatesDeferred);
  if (ready.length === 0) return { basis: 'none-ready', reason: `no candidate reached its gate frontier (${candidates.map(c => `${c.label}=${c.status}`).join(', ')})` };
  if (ready.length === 1) return { choice: ready[0].label, basis: 'only-ready', reason: `only ${ready[0].label} reached its gate frontier` };
  const preferred = judgments.map(j => j.choice !== 'A' && j.choice !== 'B' ? undefined
    : j.first === 'A' ? j.choice : (j.choice === 'A' ? 'B' : 'A'));
  if (judgments.length === 2 && judgments[0].first !== judgments[1].first && preferred[0] && preferred[0] === preferred[1]) {
    return { choice: preferred[0], basis: 'comparison', reason: judgments.find(j => j.reason)?.reason ?? 'both orders agree' };
  }
  return { choice: 'A', basis: 'fallback-order', reason: 'the two orders disagreed or did not answer; verify A first, then B if A cannot pass' };
}

export function comparisonPrompt(brief: string, first: string, second: string): string {
  return 'Two candidate changes, A and B, each attempt to achieve the task below.\n\n'
    + `Task:\n\n${brief.trim()}\n\n`
    + "Judge only from the task and the diffs; do not open files or run anything. Prefer the change whose behaviour is what "
    + "the task's author intends, not only what its words can be read to allow. Where that behaviour contradicts existing "
    + 'code or tests, changing them is part of the task, not a regression; only behaviour the task does not ask to change '
    + 'should keep working.\n\n'
    + `Change A:\n\`\`\`diff\n${first}\`\`\`\n\nChange B:\n\`\`\`diff\n${second}\`\`\`\n\n`
    + 'Reply with only JSON: {"choice": "A" or "B", "reason": "<one sentence>"}';
}

export interface RaceDeps {
  /** Run this CLI with arguments (and stdin); resolves the exit code and combined output. */
  runCli(args: string[], stdin?: string): Promise<{ code: number; output: string }>;
  /** The exact run launched for the target, with gate facts evaluated by the scheduler reader. */
  readRun(target: string): { runId: string; status: string; gatesDeferred?: boolean; gatePassed: boolean; repairs?: number; failureReason?: string; declaredOutputs: string[] } | undefined;
  /** The candidate's change against the base, new files included, declared outputs excluded. */
  diff(target: string, base: string, exclude: readonly string[]): string;
  /** One text-only comparison; resolves the parsed answer or undefined. */
  judge(prompt: string): Promise<{ choice?: 'A' | 'B'; reason?: string } | undefined>;
  write(path: string, text: string): void;
  out(line: string): void;
}

function valueOf(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

const DIFF_LIMIT = 120_000;
// Verbatim docs/race-diverse/inputs/restate-instruction.txt; embedded for the packaged CLI.
const RESTATE_INSTRUCTION = "Before changing any code, write down in one or two sentences the observable behaviour the task's author expects once it is resolved, using the author's own words wherever they state it. Then make the change deliver exactly that behaviour.\n\n";

export async function runRace(args: readonly string[], deps: RaceDeps): Promise<number> {
  const brief = valueOf(args, '--brief'), project = valueOf(args, '--project'), base = valueOf(args, '--base');
  const target = valueOf(args, '--target'), branch = valueOf(args, '--branch');
  if (!brief || !project || !base || !target || !branch) {
    deps.out('Usage: flowcrew race --brief <path> --project <dir> --base <ref> --target <path-prefix> --branch <prefix> '
      + '[--acknowledge-brief-warnings=<digest>] [--workflow <name>] [--no-supervise]');
    return 2;
  }
  const briefText = readFileSync(brief, 'utf-8');
  const ack = valueOf(args, '--acknowledge-brief-warnings');
  const workflow = valueOf(args, '--workflow');
  const labels = ['A', 'B'] as const;
  const targets = labels.map((l) => `${resolve(target)}-${l.toLowerCase()}`);
  // A top-level heading closes the report criteria before adding authoring guidance.
  const briefs = [`${briefText}\n\n# Authoring instruction\n\n${RESTATE_INSTRUCTION}`, briefText];
  const acknowledgements = [ack === shipSetupBriefDigest(briefText) ? shipSetupBriefDigest(briefs[0]) : ack, ack];
  const scratch = mkdtempSync(join(tmpdir(), 'flowcrew-race-brief-'));
  let launches: Awaited<ReturnType<RaceDeps['runCli']>>[];
  try {
    const briefPaths = [join(scratch, 'a.md'), resolve(brief)];
    writeFileSync(briefPaths[0], briefs[0], 'utf-8');
    for (const [i, t] of targets.entries()) {
      const setup = await deps.runCli(['ship-setup', '--brief', briefPaths[i], '--project', resolve(project), '--target', t,
        '--base', base, '--branch', `${branch}-${labels[i].toLowerCase()}`]);
      if (setup.code !== 0 || !setup.output.includes('Ship setup: READY')) {
        deps.out(`Race: setup for candidate ${labels[i]} was not ready (exit ${setup.code}); nothing launched.`);
        return 1;
      }
    }
    deps.out(`Race: launching ${labels.length} candidates on ${targets.join(' and ')}`);
    launches = await Promise.all(targets.map((t, i) => deps.runCli([
      'quick', '--project', t, '--defer-gates', ...(args.includes('--no-supervise') ? ['--no-supervise'] : ['--supervise']),
      ...(workflow ? ['--workflow', workflow] : []), ...(acknowledgements[i] ? [`--acknowledge-brief-warnings=${acknowledgements[i]}`] : []), '-',
    ], briefs[i])));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const runs = targets.map((t) => deps.readRun(t));
  const candidates: RaceCandidate[] = labels.map((label, i) => ({
    label, target: targets[i], status: runs[i]?.status ?? `no run (exit ${launches[i].code})`, gatesDeferred: runs[i]?.gatesDeferred, repairs: runs[i]?.repairs ?? 0,
  }));
  const judgments: RaceJudgment[] = [];
  if (candidates.every((c) => c.status === RUN_STATUS.PARKED && c.gatesDeferred)) {
    const exclude = [...new Set(runs.flatMap((r) => r?.declaredOutputs ?? []))];
    const diffs = targets.map((t) => {
      const d = deps.diff(t, base, exclude);
      return d.length <= DIFF_LIMIT ? d : `${d.slice(0, DIFF_LIMIT)}\n[... ${d.length - DIFF_LIMIT} more characters of this change omitted ...]\n`;
    });
    for (const first of labels) {
      const [x, y] = first === 'A' ? [diffs[0], diffs[1]] : [diffs[1], diffs[0]];
      const answer = await deps.judge(comparisonPrompt(briefText, x, y));
      judgments.push({ first, ...(answer?.choice ? { choice: answer.choice } : {}), ...(answer?.reason ? { reason: answer.reason } : {}) });
    }
  }
  const selection = decideRace(candidates, judgments);
  let decision: RaceDecision = { basis: 'none-passed', reason: selection.reason };
  const gateAttempts: Array<{ label: 'A' | 'B'; runId: string; exit: number; status?: string; pass: boolean; reason?: string }> = [];
  const record = () => ({
    version: 2, brief: resolve(brief), base, instructionCandidate: 'A',
    candidates: candidates.map((c, i) => ({ ...c, runId: runs[i]?.runId, launchExit: launches[i].code })),
    judgments, selection, gateAttempts, decision,
    chosenTarget: decision.choice ? targets[labels.indexOf(decision.choice)] : undefined,
  });
  const save = () => deps.write(`${resolve(target)}-race.json`, `${JSON.stringify(record(), null, 2)}\n`);
  save(); // Keep the preference and every failed gate even if a later continuation is interrupted.
  const order = selection.choice ? [selection.choice, ...labels.filter(l => l !== selection.choice)] : [];
  for (const label of order) {
    const i = labels.indexOf(label), run = runs[i];
    if (!run?.gatesDeferred || run.status !== RUN_STATUS.PARKED) continue;
    const gated = await deps.runCli(['quick', '--project', targets[i], '--existing-run-id', run.runId,
      ...(args.includes('--no-supervise') ? ['--no-supervise'] : ['--supervise']),
      ...(workflow ? ['--workflow', workflow] : []), ...(acknowledgements[i] ? [`--acknowledge-brief-warnings=${acknowledgements[i]}`] : []),
    ]);
    const final = deps.readRun(targets[i]);
    const pass = gated.code === 0 && final?.runId === run.runId && final.status === RUN_STATUS.COMPLETE && final.gatePassed;
    gateAttempts.push({ label, runId: run.runId, exit: gated.code, status: final?.status, pass,
      reason: final?.failureReason ?? (pass ? 'all independent gates passed' : 'run did not complete with passing independent gates') });
    candidates[i].status = final?.status ?? 'no bound run';
    candidates[i].gatesDeferred = final?.gatesDeferred;
    candidates[i].repairs = final?.repairs ?? 0;
    if (pass) {
      decision = label === selection.choice ? selection : { choice: label, basis: 'gated-fallback', reason: `${selection.choice} could not pass; ${label} completed with all independent gates passing` };
      save();
      deps.out(`Race: kept candidate ${label} at ${targets[i]} (${decision.basis}: ${decision.reason})`);
      return 0;
    }
    decision = { basis: 'none-passed', reason: gateAttempts.map(a => `${a.label}: ${a.reason}`).join('; ') };
    save();
  }
  deps.out(`Race: ${decision.reason}`);
  return 1;
}

function nodeDeps(): RaceDeps {
  const cli = join(import.meta.dirname ?? '.', 'cli.js');
  const runIds = new Map<string, string>();
  return {
    runCli: (args, stdin) => new Promise((resolveRun) => {
      const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { output += String(chunk); });
      child.on('error', error => resolveRun({ code: 1, output: String(error) }));
      child.on('close', (code) => {
        const id = output.match(/^FlowCrew run: ([a-zA-Z0-9_-]+)$/m)?.[1];
        const target = valueOf(args, '--project');
        if (id && target && args[0] === 'quick') runIds.set(resolve(target), id);
        resolveRun({ code: code ?? 1, output });
      });
      child.stdin.end(stdin ?? '');
    }),
    readRun: (target) => {
      const runId = runIds.get(resolve(target));
      if (!runId) return undefined;
      const run = readRunState(target, runId);
      if (resolve(run.projectDir) !== resolve(target)) return undefined;
      const stages = run.planControl?.stages ?? [];
      return { runId, status: run.status, failureReason: run.failureReason,
        gatesDeferred: run.gatesDeferred === true && !run.parked,
        gatePassed: stages.some(s => s.is_gate) && collectGateRuntimeFacts(stages, run, target, runId).allPass,
        repairs: stages.filter(s => !s.is_gate && s.retry_to?.length).reduce((n, s) => n + (run.stages[s.id]?.attempts?.length ?? 0), 0),
        declaredOutputs: (run.declaredOutputs ?? []).map(o => o.path) };
    },
    diff: (target, base, exclude) => {
      const scratch = mkdtempSync(join(tmpdir(), 'flowcrew-race-index-'));
      try {
        const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
        execFileSync('git', ['read-tree', 'HEAD'], { cwd: target, env });
        execFileSync('git', ['add', '-A'], { cwd: target, env });
        return execFileSync('git', ['diff', '--cached', base, '--', '.', ...exclude.map((p) => `:(exclude)${p}`)],
          { cwd: target, env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    judge: async (prompt) => {
      const scratch = mkdtempSync(join(tmpdir(), 'flowcrew-race-judge-'));
      try {
        const last = join(scratch, 'last.txt');
        execFileSync('codex', ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check',
          '-c', 'model_reasoning_effort="high"', '-o', last, '-'], { cwd: scratch, input: prompt, stdio: ['pipe', 'ignore', 'ignore'], timeout: 900_000 });
        const text = existsSync(last) ? readFileSync(last, 'utf-8') : '';
        const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { choice?: string; reason?: string };
        return { ...(parsed.choice === 'A' || parsed.choice === 'B' ? { choice: parsed.choice } : {}), ...(parsed.reason ? { reason: String(parsed.reason) } : {}) };
      } catch {
        return undefined;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    write: (path, text) => writeFileSync(path, text, 'utf-8'),
    out: (line) => console.log(line),
  };
}

export async function cmdRace(args: string[]): Promise<number> {
  return runRace(args.slice(1), nodeDeps());
}
