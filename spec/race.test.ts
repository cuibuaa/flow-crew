import { describe, expect, it } from 'vitest';
import { comparisonPrompt, decideRace, runRace, type RaceCandidate, type RaceDeps } from '../src/cli-race.js';

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
  const statuses = over.statuses ?? ['complete', 'complete'];
  const deps: RaceDeps = {
    runCli: async (args) => { calls.push(args); return { code: 0, output: args[0] === 'ship-setup' ? 'Ship setup: READY' : 'done' }; },
    readRun: (t) => ({ runId: `run-${t}`, status: statuses[t.endsWith('-a') ? 0 : 1], repairs: 0, declaredOutputs: ['report.md'] }),
    diff: (t, _base, exclude) => `diff of ${t} without ${exclude.join(',')}\n`,
    judge: async (prompt) => { prompts.push(prompt); return { choice: 'A', reason: 'r' }; },
    write: (p, text) => { written[p] = text; },
    out: () => {},
    ...over,
  };
  return { deps, calls, written, prompts };
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
    expect(comparisonPrompt('task', 'x', 'y')).toContain('as its author intends it');
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
