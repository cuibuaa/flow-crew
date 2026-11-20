import { it } from 'vitest';
import { publicAcceptance, publicTestTimeoutMs } from './fixtures/public-cli.mjs';

it('public resume completes the next author, command and independent gate after a historical park', async ({ signal, onTestFinished }) => {
  const running = publicAcceptance({ signal, packageRoot: process.cwd(), scenario: 'resume-direct' });
  onTestFinished(async () => { await running.catch(() => {}); });
  await running;
}, publicTestTimeoutMs);
