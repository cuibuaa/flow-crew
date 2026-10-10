// Boundary: runs one brief as two independent candidate runs through the existing ship-setup and quick commands,
// then keeps the candidate an independent text-only comparison prefers. No scheduler or stage machinery changes.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RUN_STATUS, runsRoot } from './store.js';
import { shipSetupBriefDigest } from './ship-setup-record.js';

/** A candidate as the decision sees it. */
export interface RaceCandidate {
  label: 'A' | 'B';
  target: string;
  status: string;
  /** Repair attempts the run needed; fewer means the candidate's own gate found less to fix. */
  repairs: number;
}

/** One comparison: which candidate was shown first, and which letter the judge chose. */
export interface RaceJudgment {
  first: 'A' | 'B';
  choice?: 'A' | 'B';
  reason?: string;
}

export interface RaceDecision {
  choice?: 'A' | 'B';
  basis: 'only-complete' | 'comparison' | 'fallback-fewer-repairs' | 'none-complete';
  reason: string;
}

/**
 * Keep a complete candidate. With two, the comparison asked in both orders decides when it agrees with itself; when the
 * two orders disagree the judgment is position-driven, so the candidate whose own gate needed fewer repairs is kept.
 */
export function decideRace(candidates: readonly RaceCandidate[], judgments: readonly RaceJudgment[]): RaceDecision {
  const complete = candidates.filter((c) => c.status === RUN_STATUS.COMPLETE);
  if (complete.length === 0) return { basis: 'none-complete', reason: `no candidate completed (${candidates.map((c) => `${c.label}=${c.status}`).join(', ')})` };
  if (complete.length === 1) return { choice: complete[0].label, basis: 'only-complete', reason: `only ${complete[0].label} completed` };
  // A judgment names the preferred candidate by the letter it was shown under; map it back to the candidate.
  const preferred = judgments.map((j) => !j.choice ? undefined : j.first === 'A' ? j.choice : (j.choice === 'A' ? 'B' : 'A'));
  if (preferred.length === 2 && preferred[0] && preferred[0] === preferred[1]) {
    return { choice: preferred[0], basis: 'comparison', reason: judgments.find((j) => j.reason)?.reason ?? 'both orders agree' };
  }
  const [a, b] = complete;
  const choice = b.repairs < a.repairs ? b.label : a.label;
  return { choice, basis: 'fallback-fewer-repairs', reason: `the two orders disagreed or did not answer; kept ${choice}, whose gate needed ${Math.min(a.repairs, b.repairs)} repair(s)` };
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
  /** The newest run whose project is the target. */
  readRun(target: string): { runId: string; status: string; repairs: number; declaredOutputs: string[] } | undefined;
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
      'quick', '--project', t, ...(args.includes('--no-supervise') ? ['--no-supervise'] : ['--supervise']),
      ...(workflow ? ['--workflow', workflow] : []), ...(acknowledgements[i] ? [`--acknowledge-brief-warnings=${acknowledgements[i]}`] : []), '-',
    ], briefs[i])));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const runs = targets.map((t) => deps.readRun(t));
  const candidates: RaceCandidate[] = labels.map((label, i) => ({
    label, target: targets[i], status: runs[i]?.status ?? `no run (exit ${launches[i].code})`, repairs: runs[i]?.repairs ?? 0,
  }));
  const judgments: RaceJudgment[] = [];
  if (candidates.every((c) => c.status === RUN_STATUS.COMPLETE)) {
    const exclude = [...new Set(runs.flatMap((r) => r?.declaredOutputs ?? []))];
    const diffs = targets.map((t) => {
      const d = deps.diff(t, base, exclude);
      return d.length <= DIFF_LIMIT ? d : `${d.slice(0, DIFF_LIMIT)}\n[... ${d.length - DIFF_LIMIT} more bytes of this change omitted ...]\n`;
    });
    for (const first of labels) {
      const [x, y] = first === 'A' ? [diffs[0], diffs[1]] : [diffs[1], diffs[0]];
      const answer = await deps.judge(comparisonPrompt(briefText, x, y));
      judgments.push({ first, ...(answer?.choice ? { choice: answer.choice } : {}), ...(answer?.reason ? { reason: answer.reason } : {}) });
    }
  }
  const decision = decideRace(candidates, judgments);
  const record = {
    version: 1, brief: resolve(brief), base, instructionCandidate: 'A',
    candidates: candidates.map((c, i) => ({ ...c, runId: runs[i]?.runId, launchExit: launches[i].code })),
    judgments, decision, chosenTarget: decision.choice ? targets[labels.indexOf(decision.choice)] : undefined,
  };
  deps.write(`${resolve(target)}-race.json`, `${JSON.stringify(record, null, 2)}\n`);
  if (!decision.choice) {
    deps.out(`Race: ${decision.reason}`);
    return 1;
  }
  deps.out(`Race: kept candidate ${decision.choice} at ${record.chosenTarget} (${decision.basis}: ${decision.reason})`);
  return 0;
}

function nodeDeps(): RaceDeps {
  const cli = join(import.meta.dirname ?? '.', 'cli.js');
  return {
    runCli: (args, stdin) => new Promise((resolveRun) => {
      const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { output += String(chunk); });
      child.on('close', (code) => resolveRun({ code: code ?? 1, output }));
      child.stdin.end(stdin ?? '');
    }),
    readRun: (target) => {
      const root = runsRoot();
      const wanted = resolve(target);
      const found = (existsSync(root) ? readdirSync(root) : []).sort().reverse().find((id) => {
        try { return resolve(JSON.parse(readFileSync(join(root, id, 'run.json'), 'utf-8')).projectDir) === wanted; } catch { return false; }
      });
      if (!found) return undefined;
      const run = JSON.parse(readFileSync(join(root, found, 'run.json'), 'utf-8')) as {
        status?: string; stages?: Record<string, { attempts?: unknown[] }>; declaredOutputs?: Array<{ path: string }>;
      };
      const repairs = Object.entries(run.stages ?? {}).filter(([id]) => id.startsWith('repair'))
        .reduce((n, [, s]) => n + (s.attempts?.length ?? 0), 0);
      return { runId: found, status: run.status ?? 'unknown', repairs, declaredOutputs: (run.declaredOutputs ?? []).map((o) => o.path) };
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
