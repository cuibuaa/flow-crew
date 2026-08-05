import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFinalMessage, generateRunSummary } from '../src/run-summary.js';
import type { Adapter } from '../src/adapters/base.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';

describe('extractFinalMessage', () => {
  it('returns claude-style clean output unchanged', () => {
    const clean = '## What was done\n- a\n- b';
    expect(extractFinalMessage(clean)).toBe(clean);
  });

  it('recovers the final agent message from a codex transcript', () => {
    // Codex echoes the whole prompt (which itself contains prior `codex` /
    // `tokens used` markers from polluted stage outputs), then the real answer.
    const raw = [
      'OpenAI Codex v0.130.0',
      'user',
      '# Stage Results',
      '## Stage: plan',
      'codex',           // marker inside the echoed prompt — must be ignored
      'old stage answer',
      'tokens used',
      '111,485',
      '# Dispatch Plan',
      '  some yaml',
      '',
      'codex',           // the real final turn
      '## What was tried & learned',
      '- the real answer',
      'tokens used',
      '6,883',
      '## What was tried & learned',  // duplicate reprint after footer
      '- the real answer',
    ].join('\n');
    expect(extractFinalMessage(raw)).toBe('## What was tried & learned\n- the real answer');
  });

  it('drops the tokens-used footer even without a leading codex marker', () => {
    const raw = '## Next steps\n- ship it\ntokens used\n42';
    expect(extractFinalMessage(raw)).toBe('## Next steps\n- ship it');
  });
});

describe('Reality-Gate advisory summary', () => {
  it('renders failed advisory checks into the deterministic run summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-summary-advisory-'));
    const previousFcGlobalDir = fcGlobalDir();
    try {
      setFcGlobalDir(join(root, 'fc-home'));
      const projectDir = join(root, 'project');
      mkdirSync(projectDir);
      const created = createRun(projectDir, 'test', 'name: test', []);
      const state = readRunState(projectDir, created.runId);
      state.status = 'complete';
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, created.runId, state);
      writeFileSync(join(runDir(projectDir, created.runId), '.reality-gate.json'), JSON.stringify({
        pass: true,
        checkedAt: new Date().toISOString(),
        checksRun: 1,
        results: [{
          name: 'authentication-wording',
          type: 'exec-script-exit-zero',
          pass: false,
          advisory: true,
          details: 'script exited 1',
        }],
      }, null, 2), 'utf-8');
      const adapter: Adapter = {
        run: async () => ({
          output: '## What was done\n- completed with an advisory',
          exitCode: 0,
          duration_ms: 1,
        }),
      };

      const summary = await generateRunSummary(projectDir, created.runId, adapter);

      expect(summary).toContain('## Reality-Gate advisories');
      expect(summary).toContain('authentication-wording');
      expect(summary).toContain('script exited 1');
    } finally {
      setFcGlobalDir(previousFcGlobalDir);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
