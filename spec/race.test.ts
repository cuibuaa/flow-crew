import { describe, expect, it } from 'vitest';
import { runRace, type RaceDeps, type RaceRequest } from '../src/race.js';

const request: RaceRequest = { targets: ['/w/cand-a', '/w/cand-b'], recordPath: '/w/cand-race.json' };

function fixture(options: { statuses?: string[]; passes?: boolean[]; exits?: number[] } = {}) {
  const calls: Array<{ target: string; label: 'A' | 'B'; instruction: string }> = [];
  const written: Record<string, string> = {};
  const deps: RaceDeps = {
    async run(target, label, instruction) {
      calls.push({ target, label, instruction });
      return { code: options.exits?.[label === 'A' ? 0 : 1] ?? 0, output: 'settled' };
    },
    readRun(target) {
      const i = target.endsWith('-a') ? 0 : 1;
      return { runId: `run-${i}`, status: options.statuses?.[i] ?? 'complete', gatePassed: options.passes?.[i] ?? true,
        failureReason: options.statuses?.[i] === 'incomplete' ? 'bounded repairs exhausted' : undefined };
    },
    write: (path, text) => { written[path] = text; }, out: () => {},
  };
  const record = () => JSON.parse(written[request.recordPath]);
  return { deps, calls, record };
}

describe('single-first race', () => {
  it('does not author the alternative while the first candidate is pending or after it passes', async () => {
    const { deps, calls, record } = fixture();
    const run = deps.run;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    deps.run = async (...args) => { const result = await run(...args); await pending; return result; };
    const race = runRace(request, deps);
    await Promise.resolve();
    expect(calls.map(call => call.label)).toEqual(['A']);
    finish();
    expect(await race).toBe(0);
    expect(calls.map(call => call.label)).toEqual(['A']);
    expect(record()).toMatchObject({ version: 3, decision: { choice: 'A', basis: 'first-passed' },
      candidates: [{ label: 'A', launchExit: 0 }], gateAttempts: [{ label: 'A', pass: true }], chosenTarget: '/w/cand-a' });
    expect(record()).not.toHaveProperty('selection'); expect(record()).not.toHaveProperty('judgments');
  });

  it('saves the first failed gate before setting up and authoring the alternative', async () => {
    const { deps, calls, record } = fixture({ statuses: ['incomplete', 'complete'] });
    const run = deps.run;
    deps.run = async (...args) => {
      if (args[1] === 'B') expect(record()).toMatchObject({ candidates: [{ label: 'A' }],
        gateAttempts: [{ label: 'A', pass: false, reason: 'bounded repairs exhausted' }], decision: { basis: 'none-passed' } });
      return run(...args);
    };
    expect(await runRace(request, deps)).toBe(0);
    expect(calls.map(call => call.label)).toEqual(['A', 'B']);
    expect(record()).toMatchObject({ decision: { choice: 'B', basis: 'gated-fallback' },
      gateAttempts: [{ label: 'A', pass: false }, { label: 'B', pass: true }] });
  });

  it.each([
    { statuses: ['complete', 'complete'], passes: [false, true] },
    { statuses: ['parked', 'complete'] },
    { exits: [1, 0] },
  ])('requires successful completion and independent gates before delivery (%j)', async options => {
    const { deps, record } = fixture(options);
    expect(await runRace(request, deps)).toBe(0);
    expect(record().decision).toMatchObject({ choice: 'B', basis: 'gated-fallback' });
  });

  it('records thrown candidate failures and waits for the fallback to settle', async () => {
    const { deps, record } = fixture();
    const run = deps.run;
    let closed = false;
    deps.run = async (...args) => {
      if (args[1] === 'A') throw new Error('Candidate setup refused');
      await Promise.resolve(); closed = true; return run(...args);
    };
    expect(await runRace(request, deps)).toBe(0); expect(closed).toBe(true);
    expect(record().gateAttempts[0]).toMatchObject({ pass: false, exit: 1, reason: 'Candidate setup refused' });
  });

  it('records missing bound runs without delivering a completion claim', async () => {
    const { deps, record } = fixture(); deps.readRun = () => undefined;
    expect(await runRace(request, deps)).toBe(1);
    expect(record().candidates).toHaveLength(2);
    expect(record().gateAttempts.map((attempt: { pass: boolean }) => attempt.pass)).toEqual([false, false]);
    expect(record().chosenTarget).toBeUndefined();
  });

  it('durably records both failures without choosing a parked or ungated candidate', async () => {
    const { deps, record } = fixture({ statuses: ['incomplete', 'parked'] });
    expect(await runRace(request, deps)).toBe(1);
    expect(record().decision.basis).toBe('none-passed'); expect(record().chosenTarget).toBeUndefined();
    expect(record().gateAttempts.map((attempt: { pass: boolean }) => attempt.pass)).toEqual([false, false]);
    expect(record().decision.reason).toContain('bounded repairs exhausted');
  });

  it('passes restatement guidance only to A as a stage instruction', async () => {
    const { deps, calls, record } = fixture({ passes: [false, true] });
    expect(await runRace(request, deps)).toBe(0);
    expect(calls[0].instruction).toBe("Before changing any code, write down in one or two sentences the observable behaviour the task's author expects once it is resolved, using the author's own words wherever they state it. Then make the change deliver exactly that behaviour.\n\n");
    expect(calls[1].instruction).toBe(''); expect(record().instructionCandidate).toBe('A');
  });
});
