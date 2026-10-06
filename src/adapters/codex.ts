import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { Adapter, AdapterFailureKind, AgentConfig, ExecResult, RunOpts, RunResult } from './base.js';
import { execWithStdin } from './base.js';
import { classifyAdapterFailure } from './failure.js';
import { providerFailureFromEvent, type ProviderFailure } from '../provider-result.js';
import { extractFinalMessage } from './transcript.js';
import { applyFix, diagnoseAdapterFailure, type AdapterFix, type Diagnosis } from './diagnose.js';
import { CommandActivityTracker } from '../command-activity.js';
import { engineChildAdapterHome, execEngineChildSync } from '../write-boundary.js';
import { prepareAdapterHome } from '../adapter-home.js';
import { captureCodexRollouts, codexRolloutInterval, sumInvocationUsage, type NativeInvocationUsage } from '../invocation-usage.js';

/** Parse token usage from codex CLI output */
function parseTokens(output: string): { tokens_in?: number; tokens_out?: number } {
  const m = output.match(/[Tt]okens[^:]*:\s*([\d,]+)\s*(?:in(?:put)?)\s*[/,]\s*([\d,]+)\s*(?:out(?:put)?)/);
  if (m) return { tokens_in: parseInt(m[1].replace(/,/g, ''), 10), tokens_out: parseInt(m[2].replace(/,/g, ''), 10) };
  const inM = output.match(/input_tokens\s*[:=]\s*([\d,]+)/);
  const outM = output.match(/output_tokens\s*[:=]\s*([\d,]+)/);
  if (inM || outM) return {
    tokens_in: inM ? parseInt(inM[1].replace(/,/g, ''), 10) : undefined,
    tokens_out: outM ? parseInt(outM[1].replace(/,/g, ''), 10) : undefined,
  };
  // codex `exec` prints a total-usage footer "tokens used\n<n>"; best-effort capture
  // it as output tokens so codex token telemetry isn't silently always undefined.
  const used = output.match(/tokens used\s*\n\s*([\d,]+)/i);
  if (used) return { tokens_out: parseInt(used[1].replace(/,/g, ''), 10) };
  return {};
}

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CodexSessionMetadata {
  version: 1;
  sessionId: string;
  ownerStageId: string;
  capturedAt: string;
  resumedFromStageId?: string;
}

export function isCodexSessionUuid(value: unknown): value is string {
  return typeof value === 'string' && SESSION_UUID.test(value);
}

function sessionPath(runDir: string, stageId: string): string {
  return join(runDir, 'stages', stageId, 'session.json');
}

export function readCodexSession(runDir: string, stageId: string): CodexSessionMetadata | undefined {
  try {
    const parsed = JSON.parse(readFileSync(sessionPath(runDir, stageId), 'utf-8')) as Partial<CodexSessionMetadata>;
    if (parsed.version !== 1 || !isCodexSessionUuid(parsed.sessionId) || typeof parsed.ownerStageId !== 'string' || !parsed.ownerStageId) return undefined;
    return parsed as CodexSessionMetadata;
  } catch {
    return undefined;
  }
}

function writeCodexSession(runDir: string, stageId: string, metadata: CodexSessionMetadata): void {
  const dir = join(runDir, 'stages', stageId);
  mkdirSync(dir, { recursive: true });
  const target = sessionPath(runDir, stageId);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
    renameSync(tmp, target);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

function numericUsage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeReportedWrite(path: string, workDir?: string): string | undefined {
  let candidate = path.replace(/\\/g, '/');
  if (isAbsolute(candidate)) {
    if (!workDir) return undefined;
    candidate = relative(workDir, candidate).replace(/\\/g, '/');
  }
  candidate = candidate.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (!candidate || candidate === '..' || candidate.startsWith('../') || candidate.includes('/../')) return undefined;
  return candidate;
}

function collectFileChangePaths(value: unknown, out: Set<string>, workDir?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFileChangePaths(item, out, workDir);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'path' || key === 'file_path' || key === 'filePath') && typeof nested === 'string') {
      const normalized = normalizeReportedWrite(nested, workDir);
      if (normalized) out.add(normalized);
    } else if (typeof nested === 'object' && nested !== null) {
      collectFileChangePaths(nested, out, workDir);
    }
  }
}

export interface ParsedCodexJsonl {
  eventCount: number;
  output: string;
  /** Diagnostic from a terminal CLI event, separate from agent-authored text. */
  terminalError?: string;
  providerFailure?: ProviderFailure;
  adapterFailureKind?: AdapterFailureKind;
  sessionId?: string;
  tokens_in?: number;
  tokens_out?: number;
  tokens_cached?: number;
  tokens_reasoning?: number;
  completed: boolean;
  writes: string[];
}

/** Parse the machine-readable codex exec stream without trusting echoed prose. */
export function parseCodexJsonl(output: string, workDir?: string): ParsedCodexJsonl {
  let eventCount = 0;
  let sessionId: string | undefined;
  let tokensIn = 0;
  let tokensOut = 0;
  let sawTokensIn = false;
  let sawTokensOut = false;
  let tokensCached: number | undefined;
  let tokensReasoning: number | undefined;
  let completed = false;
  const messages: string[] = [];
  let terminalError: string | undefined;
  let providerFailure: ProviderFailure | undefined;
  const writes = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    eventCount++;
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'thread.started' && isCodexSessionUuid(event.thread_id)) sessionId = event.thread_id;

    const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : undefined;
    const itemType = typeof item?.type === 'string' ? item.type : '';
    if (itemType === 'agent_message' && typeof item?.text === 'string' && item.text.trim()) messages.push(item.text.trim());
    if (type === 'message' && event.role === 'assistant' && typeof event.content === 'string' && event.content.trim()) messages.push(event.content.trim());
    if (itemType === 'file_change' || type === 'file_change') collectFileChangePaths(item ?? event, writes, workDir);

    if (type === 'turn.completed') {
      completed = true;
      terminalError = undefined;
      providerFailure = undefined;
    }
    if (type === 'error' || type === 'turn.failed' || itemType === 'error') {
      completed = false;
      const nestedError = event.error && typeof event.error === 'object'
        ? event.error as Record<string, unknown>
        : undefined;
      const message = typeof event.message === 'string' ? event.message
        : typeof event.error === 'string' ? event.error
          : typeof nestedError?.message === 'string' ? nestedError.message
            : typeof item?.message === 'string' ? item.message
              : undefined;
      if (message?.trim()) terminalError = message.trim();
      if (type === 'error' || type === 'turn.failed') {
        providerFailure = providerFailureFromEvent('codex', event);
      }
    }

    const usage = event.usage && typeof event.usage === 'object' ? event.usage as Record<string, unknown> : undefined;
    const input = numericUsage(usage?.input_tokens ?? usage?.inputTokens);
    const outputTokens = numericUsage(usage?.output_tokens ?? usage?.outputTokens);
    if (input !== undefined) { tokensIn += input; sawTokensIn = true; }
    if (outputTokens !== undefined) { tokensOut += outputTokens; sawTokensOut = true; }
    const cached = numericUsage(usage?.cached_input_tokens);
    const reasoning = numericUsage(usage?.reasoning_output_tokens);
    if (cached !== undefined) tokensCached = (tokensCached ?? 0) + cached;
    if (reasoning !== undefined) tokensReasoning = (tokensReasoning ?? 0) + reasoning;
  }

  const finalMessage = messages.at(-1) ?? '';
  const adapterFailureKind = terminalError ? classifyAdapterFailure(terminalError) : undefined;
  return {
    eventCount,
    output: terminalError && terminalError !== finalMessage
      ? [finalMessage, terminalError].filter(Boolean).join('\n')
      : (terminalError ?? finalMessage),
    ...(terminalError ? { terminalError } : {}),
    ...(providerFailure ? { providerFailure } : {}),
    ...(adapterFailureKind ? { adapterFailureKind } : {}),
    sessionId,
    tokens_in: sawTokensIn ? tokensIn : undefined,
    tokens_out: sawTokensOut ? tokensOut : undefined,
    tokens_cached: tokensCached,
    tokens_reasoning: tokensReasoning,
    completed,
    writes: [...writes].sort(),
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function userCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function cleanupRunEndArtifacts(codexHome: string): void {
  // Codex writes SQLite write-ahead logs (state.sqlite-wal, logs.sqlite-wal)
  // alongside its main DB files. Once the process has exited the WAL has
  // already been checkpointed into the main DB, so we can drop the WAL bytes
  // (~1.3M per stage) without losing data.
  try {
    for (const name of readdirSync(codexHome)) {
      if (name.endsWith('.sqlite-wal') || name.endsWith('.sqlite-shm')) {
        try { rmSync(join(codexHome, name), { force: true }); } catch { /* ignore */ }
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Finalize a stage's codex_home once the stage's codex process has exited.
 * On SUCCESS (exitCode 0) purge it entirely — the codex CLI home is transient
 * cruft (~90M/stage, dominated by the `.tmp/plugins` git packs) with zero
 * post-run value; the stage's captured output (`live.log`) and deliverables live
 * OUTSIDE codex_home (siblings under stages/<id>/) and are untouched. On any
 * FAILURE / abort / timeout keep codex_home for debugging, dropping only the
 * already-checkpointed SQLite WAL/SHM. This bounds ~/.fc/runs disk growth: before
 * this, codex_home was 99% of a run's size and accumulated unboundedly.
 */
export function finalizeCodexHome(codexHome: string, exitCode: number): void {
  if (exitCode === 0) {
    try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  } else {
    cleanupRunEndArtifacts(codexHome);
  }
}

/**
 * Read a `key = "value"` string from the USER's global codex config.toml.
 * The per-stage codex_home is isolated (CODEX_HOME redirect), so the codex CLI
 * never reads the user's global config itself — any inheritance must be done
 * here explicitly. Returns undefined when the file or key is absent.
 */
function globalCodexConfigValue(key: string): string | undefined {
  try {
    const p = join(userCodexHome(), 'config.toml');
    if (!existsSync(p)) return undefined;
    const m = readFileSync(p, 'utf-8').match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'));
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sentinel meaning "write NO model/effort line at all — let the CLI's own
 * built-in default decide". Distinct from 'default', which INHERITS the user's
 * global ~/.codex/config.toml: when the failing pin came from that global config,
 * resolving to 'default' would re-send the exact value the server just rejected.
 */
export const CLI_BUILTIN_DEFAULT = '__cli_builtin_default__';

export interface CodexCapabilityIdentity {
  executable: string;
  version: string;
  provider: string;
  model: string;
  reasoningEffort: string;
}

export interface CodexCapabilityMemory {
  version: 1;
  capability: 'reasoning_effort_unsupported';
  identity: CodexCapabilityIdentity;
  learnedAt: string;
}

/** Versions learned outside any stage boundary, keyed by the executable's file
 * identity so a replaced binary is never mistaken for the one that was probed. */
const versionByExecutable = new Map<string, string>();

function executableFingerprint(executable: string): string | undefined {
  const candidates = executable.includes('/') ? [executable]
    : (process.env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, executable));
  for (const candidate of candidates) {
    try {
      const info = statSync(candidate);
      if (info.isFile()) return `${candidate}:${info.dev}:${info.ino}:${info.size}:${Math.trunc(info.mtimeMs)}`;
    } catch { /* not this PATH entry */ }
  }
  return undefined;
}

/** Inside a stage write boundary the adapter binary is never launched just to
 * learn its version: launching it there costs a full boundary installation and
 * can only fail the attempt. The identity falls back to the file fingerprint,
 * which still changes whenever the binary does. */
function detectedCodexVersion(executable: string): string {
  const fingerprint = executableFingerprint(executable);
  if (fingerprint && versionByExecutable.has(fingerprint)) return versionByExecutable.get(fingerprint)!;
  if (engineChildAdapterHome() !== undefined) return fingerprint ? `fingerprint:${fingerprint}` : 'unknown';
  let version = 'unknown';
  const result = execEngineChildSync(executable, ['--version'], 2_000);
  if (result.status === 0) version = result.stdout.trim() || 'unknown';
  if (fingerprint) versionByExecutable.set(fingerprint, version);
  return version;
}

/** Stable scope for learned adapter capabilities. A changed CLI, provider, or
 * model deliberately produces a different key and therefore gets re-probed. */
export function resolveCodexCapabilityIdentity(
  role: Pick<AgentConfig, 'model' | 'reasoning_effort'>,
  overrides: Partial<CodexCapabilityIdentity> = {},
): CodexCapabilityIdentity {
  const executable = overrides.executable ?? 'codex';
  const model = overrides.model ?? (
    role.model === CLI_BUILTIN_DEFAULT
      ? CLI_BUILTIN_DEFAULT
      : role.model && role.model !== 'default'
        ? role.model
        : globalCodexConfigValue('model') ?? 'cli_builtin_default'
  );
  const reasoningEffort = overrides.reasoningEffort ?? (
    role.reasoning_effort === CLI_BUILTIN_DEFAULT
      ? CLI_BUILTIN_DEFAULT
      : role.reasoning_effort && role.reasoning_effort !== 'default'
        ? role.reasoning_effort
        : globalCodexConfigValue('model_reasoning_effort') ?? 'cli_builtin_default'
  );
  return {
    executable,
    version: overrides.version ?? detectedCodexVersion(executable),
    provider: overrides.provider ?? globalCodexConfigValue('model_provider') ?? 'codex',
    model,
    reasoningEffort,
  };
}

function codexCapabilityPath(runDir: string, identity: CodexCapabilityIdentity): string {
  const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
  return join(runDir, 'adapter_capabilities', `codex_${digest}.json`);
}

export function readCodexCapabilityMemory(
  runDir: string,
  identity: CodexCapabilityIdentity,
): CodexCapabilityMemory | undefined {
  try {
    const parsed = JSON.parse(readFileSync(codexCapabilityPath(runDir, identity), 'utf-8')) as CodexCapabilityMemory;
    if (parsed.version !== 1 || parsed.capability !== 'reasoning_effort_unsupported') return undefined;
    if (JSON.stringify(parsed.identity) !== JSON.stringify(identity)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function rememberCodexUnsupportedEffort(runDir: string, identity: CodexCapabilityIdentity): void {
  const target = codexCapabilityPath(runDir, identity);
  try {
    mkdirSync(join(runDir, 'adapter_capabilities'), { recursive: true });
    if (existsSync(target)) return;
    const memory: CodexCapabilityMemory = {
      version: 1,
      capability: 'reasoning_effort_unsupported',
      identity,
      learnedAt: new Date().toISOString(),
    };
    // Immutable create-only publication is sufficient: all writers publish the
    // same capability for this identity, and a crash cannot acknowledge a
    // partially written record as valid JSON.
    writeFileSync(target, `${JSON.stringify(memory, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' });
  } catch { /* a lost optimization must not change adapter correctness */ }
}

export function writeCodexConfig(codexHome: string, role: AgentConfig): string {
  const lines = [
    '# Generated by FlowCrew. Do not edit global Codex config for this run.',
  ];
  // Resolution order for model/effort: explicit role pin > the user's global
  // ~/.codex/config.toml (so users follow their own codex setup with zero
  // per-project maintenance across CLI upgrades) > CLI built-in default
  // (which DRIFTS with codex releases — the June-2026 gpt-5.3-codex HTTP 400
  // incident was exactly such a drift; inheriting the global config shields
  // runs from it because interactive codex breaks loudly first).
  const model = role.model === CLI_BUILTIN_DEFAULT ? undefined
    : (role.model && role.model !== 'default') ? role.model
    : globalCodexConfigValue('model');
  if (model) lines.push(`model = ${tomlString(model)}`);
  // NOTE: the codex CLI config key is `model_reasoning_effort` — a bare
  // `reasoning_effort` key is silently ignored (verified empirically on
  // codex-cli 0.144.3: effort stayed "none" until the model_-prefixed key
  // was used), which is why effort pins never took effect before.
  const effort = role.reasoning_effort === CLI_BUILTIN_DEFAULT ? undefined
    : (role.reasoning_effort && role.reasoning_effort !== 'default') ? role.reasoning_effort
    : globalCodexConfigValue('model_reasoning_effort');
  if (effort) lines.push(`model_reasoning_effort = ${tomlString(effort)}`);
  lines.push(`developer_instructions = ${tomlString(role.prompt ?? '')}`);
  const configPath = join(codexHome, 'config.toml');
  prepareAdapterHome({ home: codexHome, sourceHome: userCodexHome(),
    plugins: process.env.CODEX_PLUGINS_CACHE || join(homedir(), '.codex-plugins-shared'),
    skills: process.env.CODEX_SKILLS_CACHE || join(homedir(), '.codex-skills-shared'),
    private: engineChildAdapterHome() !== undefined, config: `${lines.join('\n')}\n` });
  return configPath;
}

export function stageCodexHome(runDir: string, stageId: string): string {
  return join(runDir, 'stages', stageId, 'codex_home');
}

export function codexArgs(): string[] {
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

export function buildCodexExecArgs(_prompt: string, sessionId?: string): string[] {
  if (sessionId !== undefined && !isCodexSessionUuid(sessionId)) {
    throw new Error('Codex session resume requires an explicit UUID');
  }
  const args = sessionId
    ? ['exec', 'resume', '--json', ...codexArgs(), sessionId]
    : ['exec', '--json', ...codexArgs()];
  // Terminate option parsing, then tell Codex to read the prompt from stdin.
  // Keeping prompt bytes out of argv avoids the OS per-argument size ceiling.
  args.push('--', '-');
  return args;
}

/**
 * OpenAI Codex CLI adapter.
 *
 * Non-interactive: `printf prompt | codex exec -` (no sandbox/approval prompts)
 * Resume: `printf follow-up | codex exec resume <UUID> -`
 * Interactive: `codex` (TUI mode, needs PTY)
 *
 * Flags:
 *   --dangerously-bypass-approvals-and-sandbox: no approval prompts/sandbox
 *   --model: override model
 *   --config reasoning_effort="<effort>": set reasoning effort
 */
export class CodexAdapter implements Adapter {
  async run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult> {
    let ownerStageId = opts.resumeSessionId ? (opts.sessionOwnerStageId ?? opts.stageId) : opts.stageId;
    let codexHome = stageCodexHome(opts.runDir, ownerStageId);
    // Mutable because a dead session is recoverable: `fresh_session` abandons the resume
    // id and rebuilds these arguments. Tracking it here rather than reading
    // `opts.resumeSessionId` later matters — the session capture below falls back to the
    // resume id, which would otherwise record the dead session as this stage's own.
    let resumeSessionId = opts.resumeSessionId;
    let invocationPrompt = prompt;
    let args = buildCodexExecArgs(prompt, resumeSessionId);

    let result: ExecResult | undefined;
    const invocations: NativeInvocationUsage[] = [];
    let durationMs = 0;
    const liveLogPath = join(opts.runDir, 'stages', opts.stageId, 'live.log');
    try {
      // SURGICAL param-fix retry: when the failure output NAMES a fixable
      // parameter, fix exactly that and retry — instead of a blind same-config
      // retry that re-sends the request the server just rejected (and, with a
      // 30-minute stage timeout, burns real wall time to fail identically).
      // At most 2 fixes, each fix applied at most once.
      const capabilityIdentity = resolveCodexCapabilityIdentity(role);
      const rememberedEffortRejection = readCodexCapabilityMemory(opts.runDir, capabilityIdentity) !== undefined;
      let effectiveRole = rememberedEffortRejection ? applyFix(role, 'drop_effort') : role;
      const applied = new Set<AdapterFix>();
      if (rememberedEffortRejection) applied.add('drop_effort');
      let diagnosis: Diagnosis = { fix: 'none', friendly: '', matched: '' };
      for (;;) {
        writeCodexConfig(codexHome, effectiveRole);
        const countersBefore = captureCodexRollouts(codexHome);
        const invocationStartedAt = new Date().toISOString();
        const commandActivity = opts.attemptIndex !== undefined && opts.attemptStartedAt
          ? new CommandActivityTracker({
              runDir: opts.runDir,
              stageId: opts.stageId,
              attemptIndex: opts.attemptIndex,
              attemptStartedAt: opts.attemptStartedAt,
              onLifecycle: opts.onCommandLifecycle,
            })
          : undefined;
        try {
          opts.onInvocationInput?.({
            systemPrompt: effectiveRole.prompt,
            userPrompt: invocationPrompt,
            model: effectiveRole.model,
            resumeSessionId,
            transport: { kind: 'request', payload: JSON.stringify({ executable: 'codex', argv: args, stdin: invocationPrompt, developer_instructions: effectiveRole.prompt, reasoning_effort: effectiveRole.reasoning_effort }) },
          });
          result = await execWithStdin('codex', args, invocationPrompt, {
            cwd: opts.workDir,
            timeout_ms: opts.timeout_ms,
            liveLogPath,
            env: { CODEX_HOME: codexHome },
            captureStreams: true,
            onStdout: (chunk) => commandActivity?.feed(chunk),
            abortSignal: opts.abortSignal,
          });
        } finally {
          commandActivity?.close();
        }
        // Settle before any diagnosis can replace this native call, and before
        // successful-home cleanup removes its rollout evidence.
        const events = parseCodexJsonl(result.stdout ?? result.output, opts.workDir);
        const sessionId = events.sessionId ?? resumeSessionId;
        const interval = sessionId
          ? codexRolloutInterval(countersBefore, captureCodexRollouts(codexHome), sessionId)
          : { reason: 'session_id_unavailable' };
        const stdoutUsage = events.eventCount > 0 ? events : parseTokens(result.output);
        const usage = interval.usage ?? stdoutUsage;
        const mismatch = interval.usage && events.completed && events.tokens_in !== undefined && events.tokens_out !== undefined
          && (interval.usage.tokens_in !== events.tokens_in || interval.usage.tokens_out !== events.tokens_out);
        invocations.push({
          startedAt: invocationStartedAt, completedAt: new Date().toISOString(), exitCode: result.exitCode, sessionId,
          tokens_in: usage.tokens_in, tokens_out: usage.tokens_out,
          tokens_cached: 'tokens_cached' in usage ? numericUsage(usage.tokens_cached) : undefined,
          tokens_reasoning: 'tokens_reasoning' in usage ? numericUsage(usage.tokens_reasoning) : undefined,
          tokenUsage: result.exitCode === 0 && events.completed && !mismatch && usage.tokens_in !== undefined && usage.tokens_out !== undefined
            ? 'known' : usage.tokens_in !== undefined || usage.tokens_out !== undefined ? 'partial' : 'unknown',
          source: interval.usage ? 'rollout_interval' : events.eventCount > 0 ? 'native_stdout' : 'unknown',
          reason: mismatch ? 'rollout_stdout_disagreement' : interval.reason,
        });
        durationMs += result.duration_ms;
        if (result.exitCode === 0) break;
        // Machine events and the stderr stream are failure evidence. Agent
        // messages inside JSONL must not supply a CLI parameter-fix diagnosis.
        const attemptEvents = parseCodexJsonl(result.stdout ?? result.output);
        const failureEvidence = attemptEvents.eventCount > 0
          ? [attemptEvents.terminalError, result.stderr].filter(Boolean).join('\n')
          : result.output;
        diagnosis = result.spawnError && result.exitCode !== 124 && result.exitCode !== 137
          ? { fix: 'none', friendly: `Could not launch Codex: ${result.spawnError.message}. Check the executable, its interpreter and working directory ${result.spawnError.cwd}.`, matched: result.spawnError.code ?? 'spawn error' }
          : diagnoseAdapterFailure(failureEvidence, result.exitCode);
        if (diagnosis.fix === 'none' || applied.has(diagnosis.fix) || applied.size >= 2) break;
        applied.add(diagnosis.fix);
        if (diagnosis.fix === 'drop_effort') rememberCodexUnsupportedEffort(opts.runDir, capabilityIdentity);
        effectiveRole = applyFix(effectiveRole, diagnosis.fix);
        if (diagnosis.fix === 'fresh_session') {
          resumeSessionId = undefined;
          ownerStageId = opts.stageId;
          codexHome = stageCodexHome(opts.runDir, ownerStageId);
          invocationPrompt = opts.freshSessionPrompt ?? prompt;
          args = buildCodexExecArgs(invocationPrompt, undefined);
        }
        try {
          appendFileSync(liveLogPath,
            `\n↪︎ flowcrew: exit ${result.exitCode} matched "${diagnosis.matched}" → retrying once with ${diagnosis.fix}\n`);
        } catch { /* non-critical */ }
      }
      if (result.exitCode !== 0 && diagnosis.friendly) result.friendlyError = diagnosis.friendly;
      const rawOutput = result.output;
      const parsed = parseCodexJsonl(result.stdout ?? rawOutput, opts.workDir);
      Object.assign(result, sumInvocationUsage(invocations), { invocations, duration_ms: durationMs });
      const capturedSessionId = parsed.sessionId ?? (isCodexSessionUuid(resumeSessionId) ? resumeSessionId : undefined);
      // A different thread is not proof that the requested thread continued.
      if (resumeSessionId && parsed.sessionId && parsed.sessionId !== resumeSessionId) {
        result.exitCode = 1;
        result.friendlyError = 'Codex resume returned a different thread UUID; continuation was not verified';
      }
      if (capturedSessionId && !(resumeSessionId && parsed.sessionId && parsed.sessionId !== resumeSessionId)) {
        result.sessionId = capturedSessionId;
        writeCodexSession(opts.runDir, opts.stageId, {
          version: 1,
          sessionId: capturedSessionId,
          ownerStageId,
          capturedAt: new Date().toISOString(),
          resumedFromStageId: resumeSessionId ? opts.sessionOwnerStageId : undefined,
        });
      }
      if (parsed.writes.length > 0) {
        result.writes = parsed.writes;
        result.writeAttribution = 'structured';
      } else {
        result.writeAttribution = 'unknown';
      }
      // Return the agent's final message plus failure diagnostics from the
      // terminal event, stderr or launch error. `codex exec` echoes the entire session (banner + full prompt +
      // prior-stage transcripts + token footer). Returning that raw stream
      // would pollute output.md, downstream handoff context, and run summaries. The raw
      // transcript is preserved in live.log for debugging.
      // (Parse tokens above FIRST — cleaning strips the "tokens used" footer.)
      result.output = result.spawnError ? rawOutput
        : parsed.output || extractFinalMessage(result.stdout ?? rawOutput);
      if (result.exitCode !== 0 && result.stderr?.trim() && !result.output.includes(result.stderr.trim())) {
        result.output = [result.output, result.stderr.trim()].filter(Boolean).join('\n');
      }
      if (result.exitCode === 137 && !result.output.includes('[stage cancelled by control plane]')) {
        result.output += '\n[stage cancelled by control plane]\n';
      }
      if (result.exitCode !== 0 && result.exitCode !== 124 && result.exitCode !== 137) {
        const kind = result.spawnError ? undefined : parsed.eventCount > 0
          ? parsed.adapterFailureKind ?? classifyAdapterFailure(result.stderr ?? '')
          : classifyAdapterFailure(rawOutput);
        result.adapterError = kind !== undefined;
        result.adapterFailureKind = kind;
        if (result.exitCode !== 125 && !result.spawnError) result.providerFailure = parsed.providerFailure;
      }
      delete result.stdout;
      delete result.stderr;
      return result;
    } finally {
      // Preserve a successful owner home only when the scheduler proved there
      // is one eligible direct successor. All other successful homes retain the
      // existing eager cleanup behavior; failed homes remain for diagnosis.
      const keepForSuccessor = opts.preserveSession === true
        && result?.exitCode === 0
        && isCodexSessionUuid(result.sessionId);
      if (!keepForSuccessor) finalizeCodexHome(codexHome, result?.exitCode ?? 1);
    }
  }

}

export function createAdapter(): Adapter {
  return new CodexAdapter();
}
