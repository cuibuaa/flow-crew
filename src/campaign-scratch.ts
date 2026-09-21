import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Campaign proposals are ephemeral adapter work, not run identities. */
export function createCampaignProposerScratch(temporaryRoot = tmpdir()): string {
  return mkdtempSync(join(temporaryRoot, 'flowcrew-campaign-propose-'));
}
