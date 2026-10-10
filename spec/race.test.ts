import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { comparisonPrompt, decideRace, runRace, type RaceCandidate, type RaceDeps } from '../src/cli-race.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { inspectBrief } from '../src/brief-preflight.js';

const cand = (label: 'A' | 'B', status = 'complete', repairs = 0): RaceCandidate => ({ label, target: `/t-${label}`, status, repairs });

describe('race decision', () => {
  it('keeps the candidate both comparison orders prefer', () => {
    // Shown first as A it chose A; shown first as B it chose B: both name candidate A.
    expect(decideRace([cand('A'), cand('B')], [{ first: 'A', choice: 'A' }, { first: 'B', choice: 'B' }]))
      .toMatchObject({ choice: 'A', basis: 'comparison' });
    expect(decideRace([cand('A'), cand('B')], [{ first: 'A', choice: 'B' }, { first: 'B', choice: 'A' }]))
      .toMatchObject({ choice: 'B', basis: 'comparison' });
  });
  it('falls back to the candidate whose gate needed fewer repairs when the orders disagree', () => {
    // Always picking the first-shown letter is position, not preference.
    expect(decideRace([cand('A', 'complete', 2), cand('B', 'complete', 0)], [{ first: 'A', choice: 'A' }, { first: 'B', choice: 'A' }]))
      .toMatchObject({ choice: 'B', basis: 'fallback-fewer-repairs' });
  });
  it('keeps the only complete candidate and reports when none completed', () => {
    expect(decideRace([cand('A', 'escalated'), cand('B')], [])).toMatchObject({ choice: 'B', basis: 'only-complete' });
    const none = decideRace([cand('A', 'failed'), cand('B', 'parked')], []);
    expect(none.choice).toBeUndefined();
    expect(none.basis).toBe('none-complete');
  });
});

function fakeDeps(over: Partial<RaceDeps> & { statuses?: string[] } = {}) {
  const calls: string[][] = [];
  const written: Record<string, string> = {};
  const prompts: string[] = [];
  const setupBriefs: string[] = [], quickBriefs: string[] = [];
  const statuses = over.statuses ?? ['complete', 'complete'];
  const deps: RaceDeps = {
    runCli: async (args, stdin) => {
      calls.push(args);
      if (args[0] === 'ship-setup') setupBriefs.push(readFileSync(args[args.indexOf('--brief') + 1], 'utf-8'));
      else quickBriefs.push(stdin ?? '');
      return { code: 0, output: args[0] === 'ship-setup' ? 'Ship setup: READY' : 'done' };
    },
    readRun: (t) => ({ runId: `run-${t}`, status: statuses[t.endsWith('-a') ? 0 : 1], repairs: 0, declaredOutputs: ['report.md'] }),
    diff: (t, _base, exclude) => `diff of ${t} without ${exclude.join(',')}\n`,
    judge: async (prompt) => { prompts.push(prompt); return { choice: 'A', reason: 'r' }; },
    write: (p, text) => { written[p] = text; },
    out: () => {},
    ...over,
  };
  return { deps, calls, written, prompts, setupBriefs, quickBriefs };
}

describe('race command', () => {
  const args = ['--brief', 'spec/race.test.ts', '--project', '/src', '--base', 'main', '--target', '/w/cand', '--branch', 'cand',
    '--acknowledge-brief-warnings=abc'];

  it('sets up and launches two candidates, compares their changes in both orders and records the choice', async () => {
    const { deps, calls, written, prompts } = fakeDeps();
    expect(await runRace(args, deps)).toBe(0);
    expect(calls.filter((c) => c[0] === 'ship-setup').map((c) => c[c.indexOf('--target') + 1])).toEqual(['/w/cand-a', '/w/cand-b']);
    expect(calls.filter((c) => c[0] === 'quick')).toHaveLength(2);
    expect(calls.find((c) => c[0] === 'quick')).toContain('--acknowledge-brief-warnings=abc');
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('without report.md');
    const record = JSON.parse(written['/w/cand-race.json']);
    // The judge always answered "A": first order names candidate A, second names B -> disagreement -> fallback.
    expect(record.decision).toMatchObject({ basis: 'fallback-fewer-repairs', choice: 'A' });
    // The judge favoured the change that kept existing behaviour and tests even where the task required changing them
    // (34 discordant SWE pairs: 76% right; with this framing 97%, and 14.5/15 on earlier pairs it was not tuned on).
    expect(comparisonPrompt('task', 'x', 'y')).toContain("behaviour is what the task's author intends");
    expect(comparisonPrompt('task', 'x', 'y')).toContain('changing them is part of the task, not a regression');
    expect(comparisonPrompt('task', 'x', 'y')).not.toContain('breaks nothing that should keep working');
  });

  it('launches nothing when a candidate workspace is not ready', async () => {
    const { deps, calls } = fakeDeps({ runCli: async (a) => ({ code: a[0] === 'ship-setup' ? 1 : 0, output: 'Ship setup: REFUSED' }) });
    const seen: string[][] = [];
    deps.runCli = async (a) => { seen.push(a); calls.push(a); return { code: 1, output: 'Ship setup: REFUSED' }; };
    expect(await runRace(args, deps)).toBe(1);
    expect(seen.some((c) => c[0] === 'quick')).toBe(false);
  });

  it('keeps the only complete candidate without asking the judge', async () => {
    const { deps, prompts, written } = fakeDeps({ statuses: ['escalated', 'complete'] });
    expect(await runRace(args, deps)).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(JSON.parse(written['/w/cand-race.json']).decision).toMatchObject({ choice: 'B', basis: 'only-complete' });
  });
});

describe('race candidate instructions', () => {
  // Verbatim from the evidence (docs/race-diverse/inputs/restate-instruction.txt, gitignored, so not read here).
  const instruction = "Before changing any code, write down in one or two sentences the observable behaviour the task's author "
    + "expects once it is resolved, using the author's own words wherever they state it. Then make the change deliver "
    + 'exactly that behaviour.\n\n';
  // No trailing newline: appended guidance must not continue the last report criterion.
  const brief = '# Goal\nThe implementation must import `probe.ts`.\n\n# What the report must show\n1. The requested behaviour works.';
  let scratch: string, args: string[];
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'flowcrew-race-spec-'));
    const path = join(scratch, 'brief.md');
    writeFileSync(path, brief);
    args = ['--brief', path, '--project', '/src', '--base', 'main', '--target', '/w/cand', '--branch', 'cand'];
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  function admissionDeps() {
    const fake = fakeDeps();
    const runCli = fake.deps.runCli;
    const exits = new Map<string, number>();
    const readRun = fake.deps.readRun;
    fake.deps.readRun = (t) => exits.get(t) === 0 ? readRun(t) : undefined;
    fake.deps.runCli = async (a, stdin) => {
      const result = await runCli(a, stdin);
      if (a[0] !== 'quick') return result;
      // Enforce quick's exact-input digest and acknowledgement checks using its shared inspector.
      const report = inspectBrief(stdin!);
      const ack = a.find((arg) => arg.startsWith('--acknowledge-brief-warnings='))?.split('=')[1];
      const code = ack === report.digest || (!ack && !report.requiresAcknowledgement) ? 0 : 2;
      exits.set(a[a.indexOf('--project') + 1], code);
      return { ...result, code };
    };
    return fake;
  }

  it('gives only A the verbatim instruction in setup and quick, keeps criteria and both comparisons blind, and records A', async () => {
    const { deps, calls, setupBriefs, quickBriefs, prompts, written } = fakeDeps();
    expect(await runRace(args, deps)).toBe(0);
    expect(setupBriefs).toEqual(quickBriefs);
    expect(quickBriefs[0].startsWith(brief)).toBe(true);
    expect(quickBriefs[0].endsWith(instruction)).toBe(true);
    expect(quickBriefs[1]).toBe(brief);
    expect(readFileSync(args[1], 'utf-8')).toBe(brief);
    expect(extractBriefCriteria(quickBriefs[0]).criteria).toEqual(extractBriefCriteria(brief).criteria);
    const a = deps.diff('/w/cand-a', 'main', ['report.md']), b = deps.diff('/w/cand-b', 'main', ['report.md']);
    expect(prompts).toEqual([comparisonPrompt(brief, a, b), comparisonPrompt(brief, b, a)]);
    for (const prompt of prompts) {
      for (const sentence of instruction.trim().split(/(?<=\.) /)) expect(prompt).not.toContain(sentence);
      expect(prompt).not.toContain('Authoring instruction');
    }
    expect(JSON.parse(written['/w/cand-race.json']).instructionCandidate).toBe('A');
    const aPath = calls[0][calls[0].indexOf('--brief') + 1];
    expect(() => readFileSync(aPath)).toThrow();
  });

  it('launches A with its own digest when the operator acknowledged the original brief', async () => {
    const { deps, calls, setupBriefs, quickBriefs, written } = admissionDeps();
    const original = inspectBrief(brief);
    expect(original.requiresAcknowledgement).toBe(true);
    expect(await runRace([...args, `--acknowledge-brief-warnings=${original.digest}`], deps)).toBe(0);
    expect(quickBriefs[0].endsWith(instruction)).toBe(true);
    expect(setupBriefs).toEqual(quickBriefs);
    expect(quickBriefs[1]).toBe(brief);
    const launches = calls.filter((a) => a[0] === 'quick');
    expect(launches[0]).toContain(`--acknowledge-brief-warnings=${inspectBrief(quickBriefs[0]).digest}`);
    expect(launches[1]).toContain(`--acknowledge-brief-warnings=${original.digest}`);
    expect(JSON.parse(written['/w/cand-race.json']).candidates.map((c: { launchExit: number }) => c.launchExit)).toEqual([0, 0]);
  });

  it.each([undefined, 'stale-digest'])('grants no extra acknowledgement when the supplied digest is %s', async (ack) => {
    const { deps, calls, quickBriefs, written } = admissionDeps();
    expect(await runRace([...args, ...(ack ? [`--acknowledge-brief-warnings=${ack}`] : [])], deps)).toBe(1);
    expect(quickBriefs[0].endsWith(instruction)).toBe(true);
    expect(quickBriefs[1]).toBe(brief);
    for (const call of calls) {
      expect(call.filter((a) => a.startsWith('--acknowledge-brief-warnings')))
        .toEqual(call[0] === 'quick' && ack ? [`--acknowledge-brief-warnings=${ack}`] : []);
    }
    expect(JSON.parse(written['/w/cand-race.json']).candidates.map((c: { launchExit: number }) => c.launchExit)).toEqual([2, 2]);
  });
});
