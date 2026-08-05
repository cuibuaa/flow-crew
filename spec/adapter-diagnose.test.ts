/**
 * Surgical param-fix diagnosis (adapters/diagnose.ts).
 *
 * Anchored on REAL failure text: the June-2026 codex incident where the CLI's
 * built-in default moved to a model the ChatGPT account could not use, which
 * failed the plan stage instantly and was then retried blindly with the same
 * config until the budget ran out.
 */
import { describe, expect, it } from 'vitest';
import { applyFix, diagnoseAdapterFailure } from '../src/adapters/diagnose.js';
import { CLI_BUILTIN_DEFAULT, writeCodexConfig } from '../src/adapters/codex.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const REAL_MODEL_400 = `
codex exec
--------
workdir: /project
model: gpt-5.3-codex
--------
stream error: unexpected status 400 Bad Request: {"error":{"message":"The requested model is not supported when using Codex with a ChatGPT account.","type":"invalid_request_error"}}
`;

describe('diagnoseAdapterFailure', () => {
  it('names the model fix on the real 400 text', () => {
    const d = diagnoseAdapterFailure(REAL_MODEL_400, 1);
    expect(d.fix).toBe('drop_model');
    expect(d.friendly).toContain('not available on this account');
  });

  it('names the effort fix when reasoning is rejected', () => {
    const d = diagnoseAdapterFailure('error: reasoning effort is not supported with tools for this model', 1);
    expect(d.fix).toBe('drop_effort');
  });

  it('never fixes a timeout or a supervisor abort', () => {
    expect(diagnoseAdapterFailure(REAL_MODEL_400, 124).fix).toBe('none');
    expect(diagnoseAdapterFailure(REAL_MODEL_400, 137).fix).toBe('none');
    expect(diagnoseAdapterFailure(REAL_MODEL_400, 0).fix).toBe('none');
  });

  it('only scans the tail — a brief that merely mentions the words is not a server verdict', () => {
    const brief = 'Task: document why an unsupported model breaks the plan stage.\n' + 'x'.repeat(9000);
    expect(diagnoseAdapterFailure(brief, 1).fix).toBe('none');
  });

  it('does not treat bare agent prose markers as an attested model error (L4)', () => {
    const prose = [
      'Agent report: the document discusses an unsupported model migration.',
      'The analysis sampled 400 records and calls one category invalid_request.',
      'This is task output, not an HTTP or API error envelope.',
    ].join('\n');
    expect(diagnoseAdapterFailure(prose, 1).fix).toBe('none');
  });

  it('still accepts a strict HTTP marker for an unsupported-model failure (L4)', () => {
    const wire = 'HTTP 400 Bad Request: {"error":{"message":"unsupported model"}}';
    expect(diagnoseAdapterFailure(wire, 1).fix).toBe('drop_model');
  });

  it('reports a friendly sentence with no fix for unfixable failures', () => {
    const d = diagnoseAdapterFailure('bash: line 1: codex: command not found', 1);
    expect(d.fix).toBe('none');
    expect(d.friendly).toContain('not installed');
  });
});

describe('applyFix writes a config that truly drops the parameter', () => {
  let globalHome: string;
  let stageHome: string;
  let saved: string | undefined;

  it('drop_model omits the model line even when the global config pins one', () => {
    globalHome = mkdtempSync(join(tmpdir(), `dg-global-${randomBytes(4).toString('hex')}-`));
    stageHome = mkdtempSync(join(tmpdir(), `dg-stage-${randomBytes(4).toString('hex')}-`));
    saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = globalHome;
    try {
      // The rejected pin came from the GLOBAL config — resolving the fix to
      // 'default' would inherit it again and re-send the same request.
      writeFileSync(join(globalHome, 'config.toml'), 'model = "gpt-5.3-codex"\n');
      const fixed = applyFix({ model: 'default', reasoning_effort: 'max', prompt: '' }, 'drop_model');
      expect(fixed.model).toBe(CLI_BUILTIN_DEFAULT);
      const cfg = readFileSync(writeCodexConfig(stageHome, fixed as never), 'utf-8');
      expect(cfg).not.toContain('model =');
      expect(cfg).toContain('model_reasoning_effort = "max"');   // untouched
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
      rmSync(globalHome, { recursive: true, force: true });
      rmSync(stageHome, { recursive: true, force: true });
    }
  });
});

describe('dead session recovery', () => {
  // Verbatim tail from verify_m7 attempt 3 (run 2026-08-04T04-04-43), which died in
  // 1,781 ms having spent zero tokens. verify_e13 attempt 3 failed the same way.
  const REAL_TAIL = [
    'Error: thread/resume: thread/resume failed: no rollout found for thread id',
    '019fcb52-9967-7931-adc0-1506817cf3fd (code -32600)',
  ].join(' ');

  it('recognises the resume failure and asks for a fresh session', () => {
    const diagnosis = diagnoseAdapterFailure(REAL_TAIL, 1);
    expect(diagnosis.fix).toBe('fresh_session');
    expect(diagnosis.friendly).toContain('no longer exists');
    // The operator has to learn that continuity was lost, not just that it retried.
    expect(diagnosis.friendly).toContain('not recoverable');
  });

  it('leaves the role config untouched, since the request changes rather than the model', () => {
    const role = { model: 'pinned-model', reasoning_effort: 'high' };
    expect(applyFix(role, 'fresh_session')).toEqual(role);
  });

  it('does not fire when a task merely quotes the phrase without the JSON-RPC envelope', () => {
    // codex echoes every subprocess line the agent produced, so a stage that greps its own
    // logs for this message must not be diagnosed as the CLI reporting it.
    const quoted = [
      'The regression reproduces: the adapter reports',
      '"thread/resume failed: no rollout found for thread id <uuid>"',
      'and the stage ends with no tokens spent.',
    ].join(' ');
    expect(diagnoseAdapterFailure(quoted, 1).fix).toBe('none');
  });

  it('is not diagnosed for a timeout or an abort, which are not request problems', () => {
    expect(diagnoseAdapterFailure(REAL_TAIL, 124).fix).toBe('none');
    expect(diagnoseAdapterFailure(REAL_TAIL, 137).fix).toBe('none');
  });
});
