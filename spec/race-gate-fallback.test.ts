import { expect, it } from 'vitest';
import { runRace, type RaceDeps } from '../src/race.js';

it('records a rejected candidate launch and verifies the healthy alternative', async () => {
  const gated = new Set<string>(), attempts: string[] = [];
  let record = '';
  const deps: RaceDeps = {
    run: async target => {
      attempts.push(target);
      if (target === 'a') throw new Error('Gate launch refused');
      gated.add(target);
      return { code: 0, output: 'verified' };
    },
    readRun: target => gated.has(target) ? { runId: target, status: 'complete', gatePassed: true } : undefined,
    write: (_path, text) => { record = text; }, out: () => {},
  };
  expect(await runRace({ targets: ['a', 'b'], recordPath: 'race.json' }, deps)).toBe(0);
  expect(attempts).toEqual(['a', 'b']);
  expect(JSON.parse(record)).toMatchObject({ chosenTarget: 'b', decision: { choice: 'B', basis: 'gated-fallback' },
    gateAttempts: [{ label: 'A', pass: false, reason: 'Gate launch refused' }, { label: 'B', pass: true }] });
});
