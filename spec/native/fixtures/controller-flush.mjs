// Exercise the real controller lock across its entry's final writes without changing engine source.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [entry, root, ...args] = process.argv.slice(2);
process.argv = [process.argv[0], entry, ...args];
process.on('SIGTERM', () => writeFileSync(join(root, 'signalled'), 'SIGTERM'));
await import(entry);
writeFileSync(join(root, 'flushing'), 'final writes pending');
while (!existsSync(join(root, 'finish-flush'))) await new Promise(resolve => setTimeout(resolve, 10));
writeFileSync(join(root, 'flushed'), 'done');
