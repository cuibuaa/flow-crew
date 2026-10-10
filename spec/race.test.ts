import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { comparisonPrompt, decideRace, runRace, type RaceCandidate, type RaceDeps } from '../src/cli-race.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { inspectBrief } from '../src/brief-preflight.js';

const cand = (label: 'A' | 'B', status = 'parked', gatesDeferred = true): RaceCandidate => ({ label, target: `/t-${label}`, status, gatesDeferred });

describe('race decision', () => {
  it('keeps the authored candidate both distinct presentation orders prefer', () => {
    expect(decideRace([cand('A'), cand('B')], [{ first: 'A', choice: 'A' }, { first: 'B', choice: 'B' }]))
      .toMatchObject({ choice: 'A', basis: 'comparison' });
    expect(decideRace([cand('A'), cand('B')], [{ first: 'A', choice: 'B' }, { first: 'B', choice: 'A' }]))
      .toMatchObject({ choice: 'B', basis: 'comparison' });
  });
  it.each([
    [{ first: 'A', choice: 'A' }, { first: 'B', choice: 'A' }],
    [{ first: 'A' }, { first: 'B' }],
    [{ first: 'A', choice: 'B' }, { first: 'A', choice: 'B' }],
    [{ first: 'A', choice: 'invalid' }, { first: 'B', choice: 'invalid' }],
  ])('verifies stable author order when the comparison is not a valid agreement (%j, %j)', (a, b) => {
    expect(decideRace([cand('B'), cand('A')], [a, b] as Parameters<typeof decideRace>[1]))
      .toMatchObject({ choice: 'A', basis: 'fallback-order' });
  });
  it('selects only scheduler gate holds, never ordinary approval parks or ungated complete claims', () => {
    expect(decideRace([cand('A', 'failed'), cand('B')], [])).toMatchObject({ choice: 'B', basis: 'only-ready' });
    const unavailable = decideRace([cand('A', 'complete', false), cand('B', 'parked', false)], []);
    expect(unavailable.basis).toBe('none-ready'); expect(unavailable.choice).toBeUndefined();
  });
});

function fakeDeps(over: Partial<RaceDeps> & { statuses?: string[]; gateStatuses?: string[]; gatePasses?: boolean[] } = {}) {
  const calls: string[][] = [], prompts: string[] = [];
  const written: Record<string, string> = {};
  const setupBriefs: string[] = [], quickBriefs: string[] = [];
  const statuses = [...(over.statuses ?? ['parked', 'parked'])];
  const gateStatuses = over.gateStatuses ?? ['complete', 'complete'];
  const resumed = new Set<number>();
  const deps: RaceDeps = {
    runCli: async (args, stdin) => {
      calls.push(args);
      if (args.includes('--existing-run-id')) {
        const i = args[args.indexOf('--project') + 1].endsWith('-a') ? 0 : 1;
        statuses[i] = gateStatuses[i]; resumed.add(i);
        return { code: statuses[i] === 'complete' || statuses[i] === 'parked' ? 0 : 1, output: 'gated' };
      }
      if (args[0] === 'ship-setup') setupBriefs.push(readFileSync(args[args.indexOf('--brief') + 1], 'utf-8'));
      else quickBriefs.push(stdin ?? '');
      return { code: 0, output: args[0] === 'ship-setup' ? 'Ship setup: READY' : 'authored' };
    },
    readRun: t => {
      const i = t.endsWith('-a') ? 0 : 1;
      return { runId: `run-${i}`, status: statuses[i], gatesDeferred: !resumed.has(i),
        gatePassed: resumed.has(i) && (over.gatePasses?.[i] ?? statuses[i] === 'complete'),
        failureReason: statuses[i] === 'failed' ? 'bounded repairs exhausted' : undefined, declaredOutputs: ['report.md'] };
    },
    diff: (t, _base, exclude) => `diff of ${t} without ${exclude.join(',')}\n`,
    judge: async prompt => { prompts.push(prompt); return { choice: prompts.length === 1 ? 'B' : 'A', reason: 'B meets the task' }; },
    write: (p, text) => { written[p] = text; }, out: () => {}, ...over,
  };
  return { deps, calls, written, prompts, setupBriefs, quickBriefs };
}

const args = ['--brief', 'AGENTS.md', '--project', '/src', '--base', 'main', '--target', '/w/cand', '--branch', 'cand',
  '--workflow', 'custom', '--acknowledge-brief-warnings=abc'];

describe('race command', () => {
  it('authors independently, compares before verification, and resumes only the preferred exact run', async () => {
    const { deps, calls, written, prompts } = fakeDeps();
    const launch = deps.runCli;
    deps.runCli = async (a, text) => {
      if (a.includes('--existing-run-id')) expect(prompts).toHaveLength(2);
      return launch(a, text);
    };
    expect(await runRace(args, deps)).toBe(0);
    expect(calls.filter(c => c[0] === 'ship-setup').map(c => c[c.indexOf('--target') + 1])).toEqual(['/w/cand-a', '/w/cand-b']);
    const author = calls.filter(c => c[0] === 'quick' && c.includes('--defer-gates'));
    const gate = calls.filter(c => c.includes('--existing-run-id'));
    expect(author).toHaveLength(2); expect(gate).toHaveLength(1);
    for (const call of [...author, ...gate]) {
      expect(call).toContain('--acknowledge-brief-warnings=abc'); expect(call).toContain('custom'); expect(call).toContain('--supervise');
    }
    expect(gate[0]).toContain('run-1'); expect(gate[0]).not.toContain('--defer-gates');
    expect(prompts[0]).toContain('without report.md');
    expect(prompts[0].indexOf('/w/cand-a')).toBeLessThan(prompts[0].indexOf('/w/cand-b'));
    expect(prompts[1].indexOf('/w/cand-b')).toBeLessThan(prompts[1].indexOf('/w/cand-a'));
    expect(JSON.parse(written['/w/cand-race.json'])).toMatchObject({ version: 2, selection: { choice: 'B', basis: 'comparison' },
      decision: { choice: 'B', basis: 'comparison' }, gateAttempts: [{ label: 'B', pass: true }] });
    expect(comparisonPrompt('task', 'x', 'y')).toContain("behaviour is what the task's author intends");
    expect(comparisonPrompt('task', 'x', 'y')).toContain('changing them is part of the task, not a regression');
    expect(comparisonPrompt('task', 'x', 'y')).toContain('do not open files or run anything');
  });

  it('preserves output exclusion and the 120000-character comparison boundary in both orders', async () => {
    const { deps, prompts } = fakeDeps({ diff: (_t, _b, exclude) => { expect(exclude).toEqual(['report.md']); return 'x'.repeat(120_001) + 'HIDDEN_TAIL'; } });
    expect(await runRace(args, deps)).toBe(0);
    for (const prompt of prompts) { expect(prompt).not.toContain('HIDDEN_TAIL'); expect(prompt).toContain('omitted'); }
  });

  it('launches nothing when either workspace is not ready', async () => {
    const { deps, calls } = fakeDeps();
    deps.runCli = async a => { calls.push(a); return { code: 1, output: 'Ship setup: REFUSED' }; };
    expect(await runRace(args, deps)).toBe(1); expect(calls.some(c => c[0] === 'quick')).toBe(false);
  });

  it('gates the only authored candidate without asking the judge', async () => {
    const { deps, prompts, written } = fakeDeps({ statuses: ['failed', 'parked'] });
    expect(await runRace(args, deps)).toBe(0); expect(prompts).toHaveLength(0);
    expect(JSON.parse(written['/w/cand-race.json']).decision).toMatchObject({ choice: 'B', basis: 'only-ready' });
  });

  it('requires the effective independent gate pass, even after an exit-zero complete claim', async () => {
    const { deps, written } = fakeDeps({ gatePasses: [true, false] });
    expect(await runRace(args, deps)).toBe(0);
    expect(JSON.parse(written['/w/cand-race.json'])).toMatchObject({ decision: { choice: 'A', basis: 'gated-fallback' },
      gateAttempts: [{ label: 'B', pass: false }, { label: 'A', pass: true }] });
  });

  it('durably records both failures without choosing an ungated candidate', async () => {
    const { deps, written } = fakeDeps({ gateStatuses: ['failed', 'failed'] });
    expect(await runRace(args, deps)).toBe(1);
    const record = JSON.parse(written['/w/cand-race.json']);
    expect(record.chosenTarget).toBeUndefined(); expect(record.decision).toMatchObject({ basis: 'none-passed' });
    expect(record.gateAttempts).toEqual([expect.objectContaining({ label: 'B', pass: false, reason: 'bounded repairs exhausted' }),
      expect.objectContaining({ label: 'A', pass: false, reason: 'bounded repairs exhausted' })]);
  });

  it('does not deliver a different run from the one selected for continuation', async () => {
    const { deps, written, calls } = fakeDeps(); const read = deps.readRun;
    deps.readRun = t => { const r = read(t)!; return calls.some(c => c.includes('--existing-run-id')) ? { ...r, runId: 'unrelated' } : r; };
    expect(await runRace(args, deps)).toBe(1); expect(JSON.parse(written['/w/cand-race.json']).chosenTarget).toBeUndefined();
  });

  it('keeps an approval park ineligible when neither candidate reached the gate hold', async () => {
    const { deps, written } = fakeDeps(); const read = deps.readRun;
    deps.readRun = t => ({ ...read(t)!, gatesDeferred: false });
    expect(await runRace(args, deps)).toBe(1); expect(JSON.parse(written['/w/cand-race.json']).selection.basis).toBe('none-ready');
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
      if (a[0] !== 'quick' || a.includes('--existing-run-id')) return result;
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
