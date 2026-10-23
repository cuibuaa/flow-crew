import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Deterministic capacity, independent of the host disk and operator policy. */
export function installDiskGuardFixture(home: string, availableBytes: number): string {
  const log = join(home, 'disk-admission.jsonl');
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'disk-guard'), `#!${process.execPath}
const fs = require('node:fs');
const bytes = Number(process.argv[3]);
if (process.argv[2] !== 'need' || !Number.isSafeInteger(bytes) || bytes < 0) process.exit(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(bytes) + '\\n');
if (bytes > ${availableBytes}) { console.error('disk-guard need REFUSED: fixture reserve would be breached'); process.exit(1); }
`, { mode: 0o755 });
  return log;
}
