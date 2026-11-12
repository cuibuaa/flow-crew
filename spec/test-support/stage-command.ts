import { afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ValidationRunRequest, ValidationRunResponse } from '../../src/project-validation.js';

const active = new Set<() => Promise<void>>();
afterEach(async () => { await Promise.all([...active].map(stop => stop())); });

/** Fixture predicates/recorder clients have a finite result, not a duration
 * contract. Await owned-process close, retaining command isolation and engine
 * integrity. Actual validation and recorder execution keep production limits. */
export async function stageFixtureCommand(request: Pick<ValidationRunRequest,
  'command' | 'args' | 'cwd' | 'env' | 'role' | 'display' | 'runDir'>): Promise<ValidationRunResponse> {
  const { spawnOwnedCommand } = await import('../../src/adapters/base.js');
  const { validationEnvironment } = await import('../../src/validation-environment.js');
  const { withEngineIntegrity } = await import('../../src/engine-integrity.js');
  return withEngineIntegrity({ projectDir: request.cwd, runDir: request.runDir, stageId: '_validation' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-command-'));
    try {
      const environment = validationEnvironment(root, process.env,
        request.env && { ...process.env, ...request.env });
      for (const path of ['home/.fc', 'home/.config', 'codex', 'runtime']) mkdirSync(join(root, path), { recursive: true });
      const { child, stop } = spawnOwnedCommand(request.command, request.args, { cwd: request.cwd, env: environment.env });
      active.add(stop);
      try {
        return await new Promise<ValidationRunResponse>(resolve => {
          let stdout = '', stderr = '', error: string | undefined;
          child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
          child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
          child.once('error', failure => { error = failure.message; });
          child.once('close', (exitCode, signal) => resolve({ exitCode, stdout, stderr,
            ...(signal ? { unfinished: true } : {}), ...(error ? { error } : {}) }));
        });
      } finally { active.delete(stop); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
