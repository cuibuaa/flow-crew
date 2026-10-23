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
 * Native error envelopes and CLI diagnostics share the same parameter fixes and
 * capability memory. Detect CLI changes from file identity, without launching it.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { mkdirSync, writeFileSync } from '../engine-fs.js';
import { findExecutableOnPath } from './availability.js';

/** Drop a rejected pin without inheriting it again from global configuration. */
export const CLI_BUILTIN_DEFAULT = '__cli_builtin_default__';

export interface AdapterCapabilityIdentity {
  executable: string;
  version: string;
  provider: string;
  model: string;
  reasoningEffort: string;
}

export interface AdapterCapabilityMemory {
  version: 1;
  capability: 'reasoning_effort_unsupported';
  identity: AdapterCapabilityIdentity;
  learnedAt: string;
}

function detectedCliVersion(executable: string, cwd: string): string {
  const selected = findExecutableOnPath(executable, process.env.PATH, cwd);
  if (!selected) return 'unknown';
  try {
    const info = statSync(selected, { bigint: true });
    return `fingerprint:${realpathSync(selected)}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`;
  } catch { return 'unknown'; }
}

export function resolveAdapterCapabilityIdentity(
  role: { model?: string; reasoning_effort?: string },
  input: Partial<AdapterCapabilityIdentity> & { executable: string; cwd?: string },
): AdapterCapabilityIdentity {
  const pin = (value: string | undefined) => value && value !== 'default' ? value : 'cli_builtin_default';
  return {
    executable: input.executable,
    version: input.version ?? detectedCliVersion(input.executable, input.cwd ?? process.cwd()),
    provider: input.provider ?? input.executable,
    model: input.model ?? pin(role.model),
    reasoningEffort: input.reasoningEffort ?? pin(role.reasoning_effort),
  };
}

function capabilityPath(runDir: string, identity: AdapterCapabilityIdentity, namespace: string): string {
  const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
  return join(runDir, 'adapter_capabilities', `${basename(namespace)}_${digest}.json`);
}

export function readAdapterCapabilityMemory(
  runDir: string, identity: AdapterCapabilityIdentity, namespace = identity.executable,
): AdapterCapabilityMemory | undefined {
  try {
    const parsed = JSON.parse(readFileSync(capabilityPath(runDir, identity, namespace), 'utf-8')) as AdapterCapabilityMemory;
    if (parsed.version !== 1 || parsed.capability !== 'reasoning_effort_unsupported') return undefined;
    if (JSON.stringify(parsed.identity) !== JSON.stringify(identity)) return undefined;
    return parsed;
  } catch { return undefined; }
}

export function rememberUnsupportedEffort(
  runDir: string, identity: AdapterCapabilityIdentity, namespace = identity.executable,
): void {
  const target = capabilityPath(runDir, identity, namespace);
  try {
    mkdirSync(join(runDir, 'adapter_capabilities'), { recursive: true });
    if (existsSync(target)) return;
    const memory: AdapterCapabilityMemory = { version: 1, capability: 'reasoning_effort_unsupported',
      identity, learnedAt: new Date().toISOString() };
    writeFileSync(target, `${JSON.stringify(memory, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' });
  } catch { /* Losing an optimization must not change adapter correctness. */ }
}

/** A single-parameter fix to apply to exactly one retry attempt. */
export type AdapterFix =
  /** The pinned model is unavailable → drop the pin and let the CLI default decide. */
  | 'drop_model'
  /** Reasoning effort is not accepted for this model/request shape → drop it. */
  | 'drop_effort'
  /** Nothing safe to change automatically. */
  | 'none';

export interface Diagnosis {
  fix: AdapterFix;
  /** One actionable sentence, surfaced as the stage error. */
  friendly: string;
  /** The marker that matched — kept so logs can show WHY a fix was chosen. */
  matched: string;
}

/** Only rejected parameters named by native protocol evidence can drive repair.
 * Agent-authored text and generic request errors cannot attest a parameter. */
export interface NativeParameterRejection {
  parameter?: string;
  message?: string;
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
    // MUST precede the model rules: the real text "reasoning effort is not
    // supported with tools for this model" contains both 'model' and 'not
    // supported', so a generic model rule listed first would steal it and drop
    // the model pin instead of the effort (caught by test, not by review).
    all: ['reasoning', 'not supported'],
    any: ['400', 'invalid_request', 'stream error', 'reasoning effort'],
    fix: 'drop_effort',
    friendly: 'This model rejected the reasoning-effort setting. Retried once without it and remembered that capability for later stages in this run.',
  },
  {
    all: ['reasoning_effort', 'unsupported'],
    fix: 'drop_effort',
    friendly: 'The reasoning-effort value was rejected. Retried once without it and remembered that capability for later stages in this run.',
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
    friendly: 'The pinned model is not available on this account. Retried once without the pin (the CLI default is used); set an available model in the engine config/defaults.yaml to make it permanent.',
  },
  {
    all: ['unsupported model'],
    any: ATTESTED_MODEL_ERROR,
    fix: 'drop_model',
    friendly: 'The pinned model was rejected as unsupported. Retried once without the pin; set an available model in the engine config/defaults.yaml.',
  },
  {
    all: ['model', 'does not exist'],
    any: ATTESTED_MODEL_ERROR,
    fix: 'drop_model',
    friendly: 'The pinned model does not exist for this account. Retried once without the pin; fix the model in the engine config/defaults.yaml.',
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

export function diagnoseAdapterFailure(output: string, exitCode: number, native?: NativeParameterRejection): Diagnosis {
  // Timeouts (124) and engine aborts (137) are not parameter problems; the
  // caller already classifies them and a "fix" here would be wrong.
  if (exitCode === 0 || exitCode === 124 || exitCode === 137) {
    return { fix: 'none', friendly: '', matched: '' };
  }
  if (native?.parameter === 'model' || native?.parameter === 'effort' || native?.parameter === 'reasoning_effort') {
    const fix = native.parameter === 'model' ? 'drop_model' : 'drop_effort';
    return { fix, friendly: fix === 'drop_model'
      ? 'The pinned model was rejected. Retried once without it; select an available model in the engine configuration.'
      : 'The effort setting was rejected. Retried once without it and remembered the capability for later stages in this run.',
    matched: `native rejected parameter: ${native.parameter}` };
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

/** One bounded decision point for native parameter repairs across adapters. */
export class AdapterParameterRepair<T extends { model?: string; reasoning_effort?: string }> {
  role: T;
  private readonly applied = new Set<AdapterFix>();

  constructor(role: T, private readonly runDir: string, private readonly identity: AdapterCapabilityIdentity,
    private readonly namespace = identity.executable) {
    const remembered = readAdapterCapabilityMemory(runDir, identity, namespace) !== undefined;
    this.role = remembered ? applyFix(role, 'drop_effort') : role;
    if (remembered) this.applied.add('drop_effort');
  }

  apply(diagnosis: Diagnosis): boolean {
    const fix = diagnosis.fix;
    if (fix === 'none' || this.applied.has(fix) || this.applied.size >= 2) return false;
    this.applied.add(fix);
    if (fix === 'drop_effort') rememberUnsupportedEffort(this.runDir, this.identity, this.namespace);
    this.role = applyFix(this.role, fix);
    return true;
  }
}
