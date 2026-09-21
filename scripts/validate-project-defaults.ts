import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

async function main(): Promise<void> {
  const projectDir = resolve(process.argv[2] ?? process.cwd());
  try {
    const candidate = await import(`${pathToFileURL(join(projectDir, 'src', 'config.ts')).href}?candidate-defaults=1`) as {
      loadProjectDefaultsLocally?: (projectDir: string) => unknown;
      loadProjectDefaults?: (projectDir: string) => unknown;
    };
    const validate = candidate.loadProjectDefaultsLocally ?? candidate.loadProjectDefaults;
    if (typeof validate !== 'function') throw new Error('candidate src/config.ts exports no defaults validator');
    const defaults = validate(projectDir);
    process.stdout.write(`${JSON.stringify({ version: 1, ok: true, defaults })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      version: 1,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 2;
  }
}

await main();
