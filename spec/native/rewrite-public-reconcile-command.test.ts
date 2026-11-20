import { it } from 'vitest';
import { publicAcceptance, publicTestTimeoutMs } from './fixtures/public-cli.mjs';

it('public resume reconciles a dead command without replay and land refuses a run that has not ended', async ({ signal, onTestFinished }) => {
  const running = publicAcceptance({ signal, packageRoot: process.cwd(), scenario: 'matrix-dead-command-resume' });
  onTestFinished(async () => { await running.catch(() => {}); });
  await running;
}, publicTestTimeoutMs);
