import { mkdirSync, writeFileSync } from '../engine-fs.js';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult } from './base.js';
import { scriptedRecord } from './scripted.js';

type MockFixture = {
  output_text?: unknown;
  exit_code?: unknown;
  tokens_in?: unknown;
  tokens_out?: unknown;
  simulated_duration_ms?: unknown;
  write_files?: unknown;
};

function writeFixtureFiles(runDir: string, files: unknown): void {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return;
  const root = resolve(runDir);
  for (const [relativePath, content] of Object.entries(files as Record<string, unknown>)) {
    if (typeof content !== 'string') continue;
    const target = resolve(root, relativePath);
    const rel = relative(root, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
}

export class MockAdapter implements Adapter {
  async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
    const fixtureDir = process.env.MOCK_FIXTURE_DIR;
    if (!fixtureDir) return { output: '', exitCode: 1, duration_ms: 0 };

    try {
      const raw = readFileSync(join(fixtureDir, `${opts.stageId}.json`), 'utf-8');
      const fixture = JSON.parse(raw) as MockFixture;
      const result: RunResult = {
        output: typeof fixture.output_text === 'string' ? fixture.output_text : '',
        exitCode: typeof fixture.exit_code === 'number' ? fixture.exit_code : 0,
        duration_ms: typeof fixture.simulated_duration_ms === 'number' ? fixture.simulated_duration_ms : 0,
      };
      if (typeof fixture.tokens_in === 'number') result.tokens_in = fixture.tokens_in;
      if (typeof fixture.tokens_out === 'number') result.tokens_out = fixture.tokens_out;
      const finalPath = `verdict_${opts.stageId}.json`;
      const files = fixture.write_files && typeof fixture.write_files === 'object' && !Array.isArray(fixture.write_files)
        ? fixture.write_files as Record<string, unknown> : {};
      const finalRecord = typeof files[finalPath] === 'string' ? files[finalPath] as string : undefined;
      writeFixtureFiles(opts.runDir, Object.fromEntries(Object.entries(files).filter(([path]) => !opts.outputSchema || path !== finalPath)));
      if (result.exitCode === 0) result.output = scriptedRecord(result.output, opts, finalRecord);
      return result;
    } catch {
      return { output: '', exitCode: 1, duration_ms: 0 };
    }
  }

}

export function createAdapter(): Adapter {
  return new MockAdapter();
}
