import { stageLiveLogPath } from '../stage-live-log.js';
import { atomicWrite, appendFileSync, mkdirSync } from '../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AgentConfig, ExecResult, RunOpts, RunResult } from './base.js';
import { execWithStdin } from './base.js';
import { isRetryableAdapterFailure } from './failure.js';
import { NativeEventSummary, normalizeNativeEvent } from './native-events.js';
import { providerDiagnosticReason, providerFailureFromDiagnostic, type ProviderFailure } from '../provider-result.js';
import { extractFinalMessage } from './transcript.js';
import { AdapterParameterRepair, diagnoseAdapterFailure, CLI_BUILTIN_DEFAULT, resolveAdapterCapabilityIdentity, type AdapterCapabilityIdentity, type Diagnosis } from './diagnose.js';
import { prepareAdapterHome, withAdapterCredentials } from '../adapter-home.js';
import { captureCodexRollouts, codexRolloutInterval, parsePrintedTokenUsage, sumInvocationUsage, type NativeInvocationUsage } from '../invocation-usage.js';
import { generationCompatibleSchema } from '../reality-gate/checks/json-schema-match.js';
import { finalizeSessionHome, isSessionUuid, settleSession, stageSessionHome, shouldStartFreshSession } from '../adapter-session.js';

/** Parse token usage from codex CLI output */
function parseTokens(output: string): { tokens_in?: number; tokens_out?: number } {
  const counters = parsePrintedTokenUsage(output);
  if (counters.tokens_in !== undefined || counters.tokens_out !== undefined) return counters;
  // codex `exec` prints a total-usage footer "tokens used\n<n>"; best-effort capture
  // it as output tokens so codex token telemetry isn't silently always undefined.
  const used = output.match(/tokens used\s*\n\s*([\d,]+)/i);
  if (used) return { tokens_out: parseInt(used[1].replace(/,/g, ''), 10) };
  return {};
}

// Compatibility exports preserve the public Codex surface while the engine uses
// the shared session primitive.
export type { SessionMetadata as CodexSessionMetadata } from '../adapter-session.js';
export { isSessionUuid as isCodexSessionUuid, finalizeSessionHome as finalizeCodexHome } from '../adapter-session.js';

function numericUsage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export interface ParsedCodexJsonl {
  eventCount: number;
  output: string;
  /** Diagnostic from a terminal CLI event, separate from agent-authored text. */
  terminalError?: string;
  providerFailure?: ProviderFailure;
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
  const summary = new NativeEventSummary(workDir);

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    eventCount++;
    const normalized = normalizeNativeEvent(event, 'codex');
    if (normalized.sessionId) sessionId = normalized.sessionId;
    summary.observe(normalized);

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

  const terminalError = summary.diagnostic;
  return {
    eventCount,
    output: summary.output,
    ...(terminalError ? { terminalError } : {}),
    providerFailure: summary.providerFailure,
    sessionId,
    tokens_in: sawTokensIn ? tokensIn : undefined,
    tokens_out: sawTokensOut ? tokensOut : undefined,
    tokens_cached: tokensCached,
    tokens_reasoning: tokensReasoning,
    completed: summary.completed,
    writes: [...summary.writes].sort(),
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function userCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
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
export { CLI_BUILTIN_DEFAULT } from './diagnose.js';
export type CodexCapabilityIdentity = AdapterCapabilityIdentity;

/** Preserve Codex configuration inheritance while sharing native capability memory. */
export function resolveCodexCapabilityIdentity(
  role: Pick<AgentConfig, 'model' | 'reasoning_effort'>,
  overrides: Partial<CodexCapabilityIdentity> & { cwd?: string } = {},
): CodexCapabilityIdentity {
  return resolveAdapterCapabilityIdentity(role, {
    executable: 'codex',
    provider: globalCodexConfigValue('model_provider') ?? 'codex',
    model: role.model === CLI_BUILTIN_DEFAULT ? CLI_BUILTIN_DEFAULT
      : role.model && role.model !== 'default' ? role.model : globalCodexConfigValue('model') ?? 'cli_builtin_default',
    reasoningEffort: role.reasoning_effort === CLI_BUILTIN_DEFAULT ? CLI_BUILTIN_DEFAULT
      : role.reasoning_effort && role.reasoning_effort !== 'default' ? role.reasoning_effort
        : globalCodexConfigValue('model_reasoning_effort') ?? 'cli_builtin_default',
    ...overrides,
  });
}

export function writeCodexConfig(codexHome: string, role: AgentConfig, sessionHome?: string): string {
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
  prepareAdapterHome({ home: codexHome,
    plugins: process.env.CODEX_PLUGINS_CACHE || join(homedir(), '.codex-plugins-shared'),
    skills: process.env.CODEX_SKILLS_CACHE || join(homedir(), '.codex-skills-shared'),
    sessionHome, config: `${lines.join('\n')}\n` });
  return configPath;
}

export function stageCodexHome(runDir: string, stageId: string): string {
  return stageSessionHome(runDir, stageId);
}

export function codexArgs(tools?: readonly string[]): string[] {
  // An empty role tool list forbids Codex judge writes. Read-only still permits
  // inspection tools; the judge prompt restricts comparison to the supplied text.
  return tools?.length === 0 ? ['--sandbox', 'read-only'] : ['--dangerously-bypass-approvals-and-sandbox'];
}

export function buildCodexExecArgs(_prompt: string, sessionId?: string, schemaPath?: string, tools?: readonly string[]): string[] {
  if (sessionId !== undefined && !isSessionUuid(sessionId)) {
    throw new Error('Codex session resume requires an explicit UUID');
  }
  const permissions = codexArgs(tools);
  // resume inherits the parent exec sandbox flag; its own parser does not accept --sandbox.
  const args = sessionId
    ? tools?.length === 0 ? ['exec', ...permissions, 'resume', '--json', sessionId]
      : ['exec', 'resume', '--json', ...permissions, sessionId]
    : ['exec', '--json', ...permissions];
  // Terminate option parsing, then tell Codex to read the prompt from stdin.
  // Keeping prompt bytes out of argv avoids the OS per-argument size ceiling.
  if (schemaPath) args.push('--output-schema', schemaPath);
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
  readonly sessionKind = 'codex';
  readonly capturesInvocationInput = true;

  async run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult> {
    const ownerStageId = opts.stageId;
    const codexHome = stageCodexHome(opts.runDir, ownerStageId);
    let sessionHome = opts.resumeSessionId && opts.sessionOwnerStageId && opts.sessionOwnerStageId !== opts.stageId
      ? stageCodexHome(opts.runDir, opts.sessionOwnerStageId) : undefined;
    let resumeSessionId = opts.resumeSessionId;
    let invocationPrompt = prompt;
    // Materialize only the schema this CLI will consume, outside its write authority.
    const schemaPath = opts.outputSchema && generationCompatibleSchema(opts.outputSchema)
      ? join(opts.runDir, 'stages', opts.stageId, 'output_schema.json') : undefined;

    let result: ExecResult | undefined;
    const invocations: NativeInvocationUsage[] = [];
    let durationMs = 0;
    let parsed: ParsedCodexJsonl;
    const liveLogPath = stageLiveLogPath(opts.runDir, opts.stageId, opts.attemptIndex, opts.attemptStartedAt);
    try {
      if (schemaPath) {
        mkdirSync(join(opts.runDir, 'stages', opts.stageId), { recursive: true });
        atomicWrite(schemaPath, JSON.stringify(opts.outputSchema));
      }
      // SURGICAL param-fix retry: when the failure output NAMES a fixable
      // parameter, fix exactly that and retry — instead of a blind same-config
      // retry that re-sends the request the server just rejected (and, with a
      // 30-minute stage timeout, burns real wall time to fail identically).
      // At most 2 fixes, each fix applied at most once.
      const capabilityIdentity = resolveCodexCapabilityIdentity(role, { cwd: opts.workDir });
      const repair = new AdapterParameterRepair(role, opts.runDir, capabilityIdentity, 'codex');
      let diagnosis: Diagnosis = { fix: 'none', friendly: '', matched: '' };
      for (;;) {
        const args = buildCodexExecArgs(invocationPrompt, resumeSessionId, schemaPath, repair.role.tools);
        const configToml = readFileSync(writeCodexConfig(codexHome, repair.role, sessionHome), 'utf8');
        const suppliedModel = configToml.match(/^model = (.+)$/m)?.[1];
        sessionHome = undefined;
        const countersBefore = captureCodexRollouts(codexHome);
        const invocationStartedAt = new Date().toISOString();
        opts.onInvocationInput?.({
          systemPrompt: repair.role.prompt,
          userPrompt: invocationPrompt,
          model: suppliedModel ? JSON.parse(suppliedModel) as string : 'provider-default-unresolved',
          resumeSessionId,
          transport: { kind: 'request', payload: JSON.stringify({ executable: 'codex', argv: args, stdin: invocationPrompt,
            configToml, outputSchema: schemaPath ? readFileSync(schemaPath, 'utf8') : undefined }) },
        });
        result = await withAdapterCredentials(codexHome, userCodexHome(), () => execWithStdin('codex', args, invocationPrompt, {
          cwd: opts.workDir,
          timeout_ms: opts.timeout_ms,
          liveLogPath,
          env: { CODEX_HOME: codexHome },
          captureStreams: true,
          execution: opts,
          onStdout: (chunk, activity) => activity?.feed(chunk),
          abortSignal: opts.abortSignal,
        }));
        // Settle before any diagnosis can replace this native call, and before
        // successful-home cleanup removes its rollout evidence.
        const events = parsed = parseCodexJsonl(result.stdout ?? result.output, opts.workDir);
        if (result.exitCode === 0 && events.terminalError) result.exitCode = 1;
        const sessionId = events.sessionId ?? resumeSessionId;
        const interval = sessionId
          ? codexRolloutInterval(countersBefore, captureCodexRollouts(codexHome), sessionId)
          : { reason: 'session_id_unavailable' };
        const stdoutUsage = events.eventCount > 0 ? events : parseTokens(result.output);
        const usage = interval.usage ?? stdoutUsage;
        invocations.push({
          startedAt: invocationStartedAt, completedAt: new Date().toISOString(), exitCode: result.exitCode, sessionId,
          tokens_in: usage.tokens_in, tokens_out: usage.tokens_out,
          tokens_cached: 'tokens_cached' in usage ? numericUsage(usage.tokens_cached) : undefined,
          tokens_reasoning: 'tokens_reasoning' in usage ? numericUsage(usage.tokens_reasoning) : undefined,
          tokenUsage: result.exitCode === 0 && events.completed && usage.tokens_in !== undefined && usage.tokens_out !== undefined
            ? 'known' : usage.tokens_in !== undefined || usage.tokens_out !== undefined ? 'partial' : 'unknown',
          source: interval.usage ? 'rollout_interval' : events.eventCount > 0 ? 'native_stdout' : 'unknown',
          reason: interval.reason,
        });
        durationMs += result.duration_ms;
        if (result.exitCode === 0) break;
        const failureEvidence = events.eventCount > 0
          ? [events.terminalError, result.stderr].filter(Boolean).join('\n') : result.output;
        if (![124, 125, 137].includes(result.exitCode) && !result.spawnError) {
          result.providerFailure = events.providerFailure
            ?? providerFailureFromDiagnostic({ provider: 'codex', eventType: 'cli_diagnostic', message: events.eventCount ? result.stderr ?? '' : result.output });
        }
        diagnosis = result.spawnError && result.exitCode !== 124 && result.exitCode !== 137
          ? { fix: 'none', friendly: `Could not launch Codex: ${result.spawnError.message}. Check the executable, its interpreter and working directory ${result.spawnError.cwd}.`, matched: result.spawnError.code ?? 'spawn error' }
          : diagnoseAdapterFailure(failureEvidence, result.exitCode);
        if (!isRetryableAdapterFailure(result.providerFailure?.kind)) break;
        if (!repair.apply(diagnosis)) {
          if (!shouldStartFreshSession(result, resumeSessionId, events.sessionId)) break;
          resumeSessionId = undefined;
          invocationPrompt = opts.freshSessionPrompt ?? prompt;
          continue;
        }
        try {
          appendFileSync(liveLogPath,
            `\n↪︎ flowcrew: exit ${result.exitCode} matched "${diagnosis.matched}" → retrying once with ${diagnosis.fix}\n`);
        } catch { /* non-critical */ }
      }
      if (result.exitCode !== 0) result.friendlyError = providerDiagnosticReason(
        [diagnosis.friendly, parsed.terminalError].filter(Boolean).join(' — ')) || undefined;
      const rawOutput = result.output;
      Object.assign(result, sumInvocationUsage(invocations), { invocations, duration_ms: durationMs });
      settleSession(opts.runDir, opts.stageId, result, parsed.sessionId, resumeSessionId, opts.sessionOwnerStageId, {
        adapter: this.sessionKind, mismatchMessage: 'Codex resume returned a different thread UUID; continuation was not verified',
      });
      if (parsed.writes.length > 0) {
        result.writes = parsed.writes;
        result.writeAttribution = 'structured';
      } else {
        result.writeAttribution = 'unknown';
      }
      result.output = result.spawnError ? rawOutput
        : parsed.output || extractFinalMessage(result.stdout ?? rawOutput);
      if (result.exitCode !== 0 && result.stderr?.trim() && !result.output.includes(result.stderr.trim())) {
        result.output = [result.output, result.stderr.trim()].filter(Boolean).join('\n');
      }
      if (result.exitCode === 137 && !result.output.includes('[stage cancelled by control plane]')) {
        result.output += '\n[stage cancelled by control plane]\n';
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
        && isSessionUuid(result.sessionId);
      finalizeSessionHome(codexHome, result?.exitCode ?? 1, keepForSuccessor);
    }
  }

}

export function createAdapter(): Adapter {
  return new CodexAdapter();
}
