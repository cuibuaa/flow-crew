import { expect, it } from 'vitest';
import { publicAcceptance, publicTestTimeoutMs } from './fixtures/public-cli.mjs';

it('public guidance reaches the next real author after explicit continuation', async ({ signal, onTestFinished }) => {
  const running = publicAcceptance({ signal, packageRoot: process.cwd(), scenario: 'matrix-unknown-work-text' });
  onTestFinished(async () => { await running.catch(() => {}); });
  const result = await running;
  const author = result.trace.filter(row => row.event === 'recovery-invocation').at(-1);
  expect(author.number).toBeGreaterThan(1);
  expect(author.guidance.map(guide => guide.text)).toEqual(['Inspect retained uncertainty and continue from the recovered base.']);
}, publicTestTimeoutMs);
