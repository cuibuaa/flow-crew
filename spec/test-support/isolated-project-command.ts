import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Real project commands run inside a fixture-owned Node process and home. */
export function isolatedProjectCommand(command: string, args: string[], cwd: string, fixtureRoot: string): string {
  return execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { execFileSync } from 'node:child_process'; const [command, ...args] = process.argv.slice(1); process.stdout.write(execFileSync(command, args, { maxBuffer: 64 * 1024 * 1024 }));",
    '--', command, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HOME: fixtureRoot, FC_HOME: join(fixtureRoot, '.fc') },
  });
}
