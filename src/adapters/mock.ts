import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult } from './base.js';

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
      writeFixtureFiles(opts.runDir, fixture.write_files);
      return result;
    } catch {
      return { output: '', exitCode: 1, duration_ms: 0 };
    }
  }

}

export function createAdapter(): Adapter {
  return new MockAdapter();
}
