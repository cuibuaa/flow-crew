/**
 * Surgical failure diagnosis for CLI adapters.
 *
 * The point is NOT to retry blindly. A blind same-config retry re-sends the
 * exact request the server just rejected and fails identically, burning a stage
 * attempt and (with a 30-minute stage timeout) real wall time. When the failure
 * output NAMES a fixable parameter, fix exactly what was named and retry once.
 *
 * Modeled on openworker's param-fix retry (fix only what the server complained
 * about, at most twice) plus its friendly-error mapping: one actionable sentence
 * for the operator instead of a wall of transcript.
 *
 * This module is deliberately pure and string-only so it can be unit-tested
 * against real captured failure text with no process spawning.
 */

import { CLI_BUILTIN_DEFAULT } from './codex.js';

/** A single-parameter fix to apply to exactly one retry attempt. */
export type AdapterFix =
  /** The pinned model is unavailable → drop the pin and let the CLI default decide. */
  | 'drop_model'
  /** Reasoning effort is not accepted for this model/request shape → drop it. */
  | 'drop_effort'
  /**
   * The session this attempt tried to resume no longer exists → abandon it and start a
   * fresh one. Unlike the model fixes this changes the request, not the role config, so
   * `applyFix` leaves the role untouched and the adapter rebuilds its arguments.
   */
  | 'fresh_session'
  /** Nothing safe to change automatically. */
  | 'none';

export interface Diagnosis {
  fix: AdapterFix;
  /** One actionable sentence, surfaced as the stage error. */
  friendly: string;
  /** The marker that matched — kept so logs can show WHY a fix was chosen. */
  matched: string;
}

interface Rule {
  /** All must appear (case-insensitive) in the failure tail. */
  all: string[];
  /** At least one must also appear — used to require the ATTESTED wire shape. */
  any?: string[];
  fix: AdapterFix;
  friendly: string;
}

/**
 * Model fixes require evidence from the CLI/API error envelope, not a number or
 * token the agent could have emitted in ordinary prose.
 */
const ATTESTED_MODEL_ERROR = [
  'status 400',
  'http 400',
  'invalid_request_error',
  'stream error: unexpected status',
];

/**
 * Ordered most-specific-first. Every entry must be anchored on text the CLI or
 * API actually emits — a guessed marker silently never fires, which is worse
 * than no rule at all.
 */
const RULES: Rule[] = [
  {
    // Observed twice, both on the re-verification that follows a repair stage: the attempt
    // died in under two seconds with zero tokens because the session it meant to resume was
    // gone, and with no rule here the stage ended as a verdict nobody had reached. Anchored
    // on the JSON-RPC envelope as well as the message so a task whose own output happens to
    // quote "no rollout found" cannot be misread as the CLI saying it — codex echoes every
    // subprocess line the agent produced.
    all: ['thread/resume', 'no rollout found for thread id'],
    any: ['-32600', 'code:'],
    fix: 'fresh_session',
    friendly: 'The session this stage tried to resume no longer exists. Retried once with a fresh session; prior conversation context for this stage is not recoverable.',
  },
  {
    // MUST precede the model rules: the real text "reasoning effort is not
    // supported with tools for this model" contains both 'model' and 'not
    // supported', so a generic model rule listed first would steal it and drop
    // the model pin instead of the effort (caught by test, not by review).
    all: ['reasoning', 'not supported'],
    any: ['400', 'invalid_request', 'stream error', 'reasoning effort'],
    fix: 'drop_effort',
    friendly: 'This model rejected the reasoning-effort setting. Retried once without it; set reasoning_effort: default in config/defaults.yaml to make it permanent.',
  },
  {
    all: ['reasoning_effort', 'unsupported'],
    fix: 'drop_effort',
    friendly: 'The reasoning-effort value was rejected. Retried once without it; set reasoning_effort: default in config/defaults.yaml.',
  },
  {
    // codex CLI + ChatGPT-account model gating (the June-2026 gpt-5.3-codex incident).
    // The `any` guard is load-bearing: codex echoes the ENTIRE prompt and every
    // subprocess line the agent produced, so a REAL task failure whose tail
    // merely contains "model" and "not supported" would otherwise be
    // misdiagnosed as a config problem — dropping the model pin and re-running
    // the whole stage, masking the actual failure. Only the attested 400
    // invalid_request wire shape counts (the sole codex hard-failure shape found
    // across the on-disk corpus of 3405 runs).
    all: ['model', 'not supported'],
    any: ATTESTED_MODEL_ERROR,
    fix: 'drop_model',
    friendly: 'The pinned model is not available on this account. Retried once without the pin (the CLI default is used); set an available model in config/defaults.yaml to make it permanent.',
  },
  {
    all: ['unsupported model'],
    any: ATTESTED_MODEL_ERROR,
    fix: 'drop_model',
    friendly: 'The pinned model was rejected as unsupported. Retried once without the pin; set an available model in config/defaults.yaml.',
  },
  {
    all: ['model', 'does not exist'],
    any: ATTESTED_MODEL_ERROR,
    fix: 'drop_model',
    friendly: 'The pinned model does not exist for this account. Retried once without the pin; fix the model in config/defaults.yaml.',
  },
  {
    all: ['unexpected argument'],
    fix: 'none',
    friendly: 'The adapter CLI rejected its own arguments — the installed CLI version likely changed its flags. Run `flowcrew doctor` and check the CLI version.',
  },
  {
    all: ['command not found'],
    fix: 'none',
    friendly: 'The adapter CLI is not installed or not on PATH. Run `flowcrew doctor`.',
  },
  {
    all: ['not logged in'],
    fix: 'none',
    friendly: 'The adapter CLI is not authenticated. Log in with the CLI, then retry the task.',
  },
];

/** Only the tail is scanned: codex echoes the whole prompt, so a brief that merely
 *  mentions "unsupported model" must not be read as the server saying it. */
const TAIL_BYTES = 4096;

export function diagnoseAdapterFailure(output: string, exitCode: number): Diagnosis {
  // Timeouts (124) and supervisor aborts (137) are not parameter problems; the
  // caller already classifies them and a "fix" here would be wrong.
  if (exitCode === 0 || exitCode === 124 || exitCode === 137) {
    return { fix: 'none', friendly: '', matched: '' };
  }
  const tail = (output.length > TAIL_BYTES ? output.slice(-TAIL_BYTES) : output).toLowerCase();
  for (const rule of RULES) {
    if (rule.all.every((m) => tail.includes(m)) && (!rule.any || rule.any.some((m) => tail.includes(m)))) {
      return { fix: rule.fix, friendly: rule.friendly, matched: rule.all.join(' + ') };
    }
  }
  return { fix: 'none', friendly: '', matched: '' };
}

/**
 * Apply a fix to a role config, returning a COPY (never mutate shared config).
 *
 * Uses the CLI-builtin sentinel, NOT 'default': 'default' inherits the user's
 * global codex config, and when the rejected pin CAME from that global config,
 * resolving to 'default' would re-send the exact value the server just rejected.
 */
export function applyFix<T extends { model?: string; reasoning_effort?: string }>(role: T, fix: AdapterFix): T {
  if (fix === 'drop_model') return { ...role, model: CLI_BUILTIN_DEFAULT };
  if (fix === 'drop_effort') return { ...role, reasoning_effort: CLI_BUILTIN_DEFAULT };
  return role;
}
