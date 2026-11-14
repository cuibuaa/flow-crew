import { prepareAdapterHome, withAdapterCredentials } from '../adapter-home.js';
import { runRecordPath } from '../run-layout.js';
import { stageLiveLogPath } from '../stage-live-log.js';
import { atomicWrite, writeFileSync, mkdirSync } from '../engine-fs.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isSessionUuid, settleSession, shouldStartFreshSession, stageSessionHome, finalizeSessionHome } from '../adapter-session.js';
import type { Adapter, AgentConfig, ExecResult, RunOpts, RunResult } from './base.js';
import { execWithStdin } from './base.js';
import { isRetryableAdapterFailure } from './failure.js';
import { providerDiagnosticReason, providerFailureFromDiagnostic } from '../provider-result.js';
import { NativeEventSummary, normalizeNativeEvent } from './native-events.js';
import { NativeUsageAccumulator, normalizeNativeUsage, sumInvocationUsage, type NativeInvocationUsage } from '../invocation-usage.js';
import { generationCompatibleSchema } from '../reality-gate/checks/json-schema-match.js';
import { AdapterParameterRepair, CLI_BUILTIN_DEFAULT, diagnoseAdapterFailure, resolveAdapterCapabilityIdentity,
  type NativeParameterRejection } from './diagnose.js';

interface ClaudeParameter {
  value: string | null;
  source: 'role' | 'local-default' | 'user-settings' | 'cli-default';
}

interface ClaudeSettings {
  model?: unknown;
  effortLevel?: unknown;
  modelSettings?: Record<string, { effortLevel?: unknown }>;
}

/** Inherit only model/effort, keeping hooks, tools and permissions isolated.
 * Read on every invocation so edits to the operator's settings take effect. */
function readClaudeSettings(): ClaudeSettings {
  try {
    return JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'), 'utf8')) ?? {};
  } catch { return {}; }
}

/** Machine-local FlowCrew default for Claude stages, `~/.config/flowcrew/claude.json` `{"model": "<id>"}`:
 * below an explicit role/engine model, above settings.json, so the lead's own model stays untouched.
 * Read on every invocation like settings.json. */
function readLocalClaudeModel(): string | undefined {
  try {
    const value = (JSON.parse(readFileSync(join(homedir(), '.config', 'flowcrew', 'claude.json'), 'utf8')) ?? {}).model;
    return typeof value === 'string' && value.trim() && value !== 'default' ? value : undefined;
  } catch { return undefined; }
}

function resolveClaudeSettings(role: AgentConfig, settings: ClaudeSettings,
  localModel = readLocalClaudeModel()): { model: ClaudeParameter; effort: ClaudeParameter } {
  const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
  const resolve = (value: string | undefined, inherited: unknown): ClaudeParameter => {
    if (value === CLI_BUILTIN_DEFAULT) return { value: null, source: 'cli-default' };
    if (value && value !== 'default') return { value, source: 'role' };
    const userValue = string(inherited);
    return userValue ? { value: userValue, source: 'user-settings' } : { value: null, source: 'cli-default' };
  };
  const roleModel = resolve(role.model, settings.model);
  const model: ClaudeParameter = localModel && roleModel.source !== 'role' && role.model !== CLI_BUILTIN_DEFAULT
    ? { value: localModel, source: 'local-default' } : roleModel;
  // Keep aliases intact for the CLI; per-model entries use the selected key.
  const effort = resolve(role.reasoning_effort,
    (model.value && string(settings.modelSettings?.[model.value]?.effortLevel)) || settings.effortLevel);
  return { model, effort };
}

/** Keep the CLI's ambient authentication routing; flags isolate stage settings and tools.
 * Resume always names the stage's captured UUID, never the operator's latest session. */
export function buildClaudeInvocation(role: AgentConfig, opts: Pick<RunOpts, 'outputSchema'>,
  systemPromptPath: string, resumeSessionId?: string, settings = readClaudeSettings()): { args: string[]; unsetEnv: string[]; model: ClaudeParameter; effort: ClaudeParameter } {
  const { model, effort } = resolveClaudeSettings(role, settings);
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--safe-mode', '--setting-sources', '', '--strict-mcp-config'];
  // Like Codex, an empty list permits inspection. Native file tools are the
  // only available tools; restricted mode confines their working directories.
  if (role.tools.length === 0) args.push('--restricted', '--tools', 'Read,Glob,Grep', '--permission-mode', 'plan', '--permission-prompts', 'none');
  else args.push('--dangerously-skip-permissions');
  if (model.value) args.push('--model', model.value);
  if (effort.value) args.push('--effort', effort.value);
  if (role.prompt) args.push('--append-system-prompt-file', systemPromptPath);
  if (opts.outputSchema && generationCompatibleSchema(opts.outputSchema)) args.push('--json-schema', JSON.stringify(opts.outputSchema));

  if (resumeSessionId) args.push('--resume', resumeSessionId);

  return { args, unsetEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'], model, effort };
}

/** Native print transport. Ambient authentication remains owned by the CLI;
 * stage duties, tools, settings and machine events are owned by this adapter. */
export class ClaudeAdapter implements Adapter {
  readonly sessionKind = 'claude';
  readonly capturesInvocationInput = true;

  async run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult> {
    if (opts.resumeSessionId !== undefined && !isSessionUuid(opts.resumeSessionId)) {
      throw new Error('Claude session resume requires an explicit UUID');
    }
    const nativeHome = stageSessionHome(opts.runDir, opts.stageId, this.sessionKind);
    prepareAdapterHome({ home: nativeHome, sessionDirectory: 'projects', sessionHome: opts.sessionOwnerStageId && opts.sessionOwnerStageId !== opts.stageId ? stageSessionHome(opts.runDir, opts.sessionOwnerStageId, this.sessionKind) : undefined });
    let resumeSessionId = opts.resumeSessionId;
    // A native session can move between stages; its baseline has one UUID owner.
    const costDir = runRecordPath(opts.runDir, 'run-history', 'native-session-costs');
    let invocationPrompt = prompt;
    let result: RunResult | undefined;
    const stageDir = runRecordPath(opts.runDir, 'stages', opts.stageId);
    mkdirSync(stageDir, { recursive: true });
    const systemPromptPath = join(stageDir, 'system_prompt.md');
    if (role.prompt) writeFileSync(systemPromptPath, role.prompt, 'utf-8');
    // Scope learned capabilities to native routing and model selection, without
    // persisting endpoint text or examining authentication values.
    const provider = createHash('sha256').update(JSON.stringify([
      process.env.CLAUDE_CODE_USE_BEDROCK, process.env.CLAUDE_CODE_USE_VERTEX,
      process.env.CLAUDE_CODE_USE_FOUNDRY, process.env.ANTHROPIC_BASE_URL,
      process.env.ANTHROPIC_MODEL, process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ])).digest('hex');
    let repair: AdapterParameterRepair<AgentConfig> | undefined;
    let selectionKey: string | undefined;
    const invocations: NativeInvocationUsage[] = [];
    const started = Date.now();
    for (;;) {
      const settings = readClaudeSettings();
      const selection = resolveClaudeSettings(role, settings);
      const key = JSON.stringify([selection.model.value, selection.effort.value]);
      if (!repair || key !== selectionKey) {
        const identity = resolveAdapterCapabilityIdentity(role, { executable: 'claude', provider, cwd: opts.workDir,
          model: selection.model.value ?? 'cli_builtin_default', reasoningEffort: selection.effort.value ?? 'cli_builtin_default' });
        if (repair) repair.select(role, identity);
        else repair = new AdapterParameterRepair(role, opts.runDir, identity);
        selectionKey = key;
      }
      const effectiveRole = repair.role;
      const { args, unsetEnv, model, effort } = buildClaudeInvocation(effectiveRole, opts, systemPromptPath, resumeSessionId, settings);

      const summary = new NativeEventSummary(opts.workDir);
      const usage = new NativeUsageAccumulator();
      let previousCost: number | undefined = resumeSessionId ? undefined : 0;
      if (resumeSessionId) try {
        const value = JSON.parse(readFileSync(join(costDir, `${resumeSessionId}.json`), 'utf8')).cumulativeCostUsd;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) previousCost = value;
      } catch { /* A missing session total is unknown, never zero. */ }
      let cumulativeCostUsd: number | undefined;
      let sessionId: string | undefined;
      let inputCaptured = false;
      let inputCaptureError: unknown;
      const captureInput = (nativeModel?: string): void => {
        if (inputCaptured) return;
        inputCaptured = true;
        try { opts.onInvocationInput?.({ systemPrompt: role.prompt, userPrompt: invocationPrompt,
          model: nativeModel || model.value || 'provider-default-unresolved',
          resumeSessionId,
          transport: { kind: 'request', payload: JSON.stringify({ executable: 'claude', argv: args, stdin: invocationPrompt, appendedSystemPrompt: role.prompt, model, effort }) } });
        } catch (error) { inputCaptureError = error; }
      };
      const requestContext: unknown[] = [
        { role: 'system', content: role.prompt }, { role: 'user', content: invocationPrompt },
      ];
      const requests = new Map<string, { input_tokens?: number; cached_input_tokens?: number;
        cache_creation_input_tokens?: number; output_tokens?: number; context: unknown[] }>();
      let carry = '';
      let eventCount = 0;
      let rejected: NativeParameterRejection | undefined;
      const consume = (line: string): void => {
        let event: Record<string, any>;
        try { event = JSON.parse(line); } catch { return; }
        if (!event || typeof event !== 'object') return;
        eventCount++;
        const normalized = normalizeNativeEvent(event, 'claude');
        summary.observe(normalized);
        if (normalized.sessionId) sessionId = normalized.sessionId;
        if (event.type === 'system' && event.subtype === 'init') captureInput(normalized.model);
        if (event.type === 'assistant') {
          usage.observe({ usage: event.message?.usage, id: event.message?.id });
          if (opts.onRequestEvidence && event.message?.usage) {
            const counters = normalizeNativeUsage(event.message.usage);
            const id = event.message.id ?? `event-${eventCount}`;
            requests.set(id, { input_tokens: counters.tokens_in, cached_input_tokens: counters.tokens_cached,
              cache_creation_input_tokens: counters.tokens_cache_created, output_tokens: counters.tokens_out,
              context: requests.get(id)?.context ?? [...requestContext] });
          }
        }
        if (opts.onRequestEvidence && (event.type === 'assistant' || event.type === 'user')) {
          requestContext.push({ role: event.type, content: event.message?.content });
        }
        if (event.type === 'result') {
          // Tokens describe this call; cost is a session total. An unknown
          // baseline cannot become a zero-cost continuation.
          const total = event.total_cost_usd;
          if (typeof total === 'number' && Number.isFinite(total) && total >= 0) cumulativeCostUsd = total;
          usage.observe({ usage: event.usage, cumulative: true,
            costUsd: cumulativeCostUsd !== undefined && previousCost !== undefined && cumulativeCostUsd >= previousCost
              && (!resumeSessionId || sessionId === resumeSessionId) ? cumulativeCostUsd - previousCost : undefined,
            models: resumeSessionId ? undefined : event.modelUsage });
        }
        if (normalized.terminal !== undefined) {
          rejected = normalized.terminal === false
            ? { parameter: event.error?.param ?? event.error?.parameter ?? event.param, message: normalized.diagnostic } : undefined;
        }
      };
      const invocationStartedAt = new Date().toISOString();
      let execution: ExecResult;
      try {
        execution = await withAdapterCredentials(nativeHome, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), () => execWithStdin('claude', args, invocationPrompt, {
          cwd: opts.workDir, timeout_ms: opts.timeout_ms === undefined ? undefined : Math.max(1, opts.timeout_ms - (Date.now() - started)),
          liveLogPath: stageLiveLogPath(opts.runDir, opts.stageId, opts.attemptIndex, opts.attemptStartedAt), captureStreams: true, execution: opts,
          unsetEnv, env: { CLAUDE_CONFIG_DIR: nativeHome },
          abortSignal: opts.abortSignal,
          onStdout: (chunk, activity) => {
            activity?.feed(chunk);
            carry += chunk;
            const lines = carry.split('\n');
            carry = lines.pop() ?? '';
            for (const line of lines) consume(line);
          },
        }), ['.credentials.json']);
        if (carry.trim()) consume(carry);
      } finally {
        captureInput();
      }
      opts.onRequestEvidence?.({ source: 'claude_stream', request_count: requests.size,
        requests: [...requests.values()],
        // Stream messages expose counters and visible context, not the CLI's
        // own system instructions/tool definitions. Do not invent attribution.
        native_context_unavailable: true,
      });
      if (inputCaptureError !== undefined) throw inputCaptureError;

      const exitCode = execution.exitCode === 0 && summary.terminal === false ? 1 : execution.exitCode;
      const counters = usage.settle(exitCode === 0 && summary.completed);
      if (isSessionUuid(sessionId)) {
        mkdirSync(costDir, { recursive: true });
        atomicWrite(join(costDir, `${sessionId}.json`), JSON.stringify({ cumulativeCostUsd }));
      }
      invocations.push({ ...counters, startedAt: invocationStartedAt, completedAt: new Date().toISOString(),
        exitCode, sessionId, source: eventCount ? 'native_stdout' : 'unknown' });
      const evidence = [summary.diagnostic, execution.stderr].filter(Boolean).join('\n');
      const diagnosis = execution.spawnError && ![124, 137].includes(exitCode)
        ? { fix: 'none' as const, friendly: `Could not launch Claude: ${execution.spawnError.message}. Check the executable, its interpreter and working directory ${execution.spawnError.cwd}.`, matched: execution.spawnError.code ?? 'spawn error' }
        : diagnoseAdapterFailure(eventCount ? evidence : execution.output, exitCode, rejected);
      const providerFailure = exitCode !== 0 && ![124, 125, 137].includes(exitCode) && !execution.spawnError
        ? summary.providerFailure
          ?? providerFailureFromDiagnostic({ provider: 'claude', eventType: 'cli_diagnostic', message: eventCount ? execution.stderr ?? '' : execution.output }) : undefined;
      let output = execution.spawnError ? execution.output : eventCount ? summary.output : execution.output;
      if (exitCode !== 0 && execution.stderr?.trim() && !output.includes(execution.stderr.trim())) output = [output, execution.stderr.trim()].filter(Boolean).join('\n');
      if (exitCode === 137) output += '\n[stage cancelled by control plane]\n';
      result = { ...execution, output, exitCode, sessionId, providerFailure,
        friendlyError: execution.writeGrantFailure ? execution.friendlyError : exitCode !== 0 ? providerDiagnosticReason(
          [diagnosis.friendly, summary.diagnostic].filter(Boolean).join(' — ')) || undefined : undefined,
        writes: [...summary.writes].sort(), writeAttribution: summary.writes.size ? 'structured' : 'unknown' };
      delete (result as ExecResult).stdout;
      delete (result as ExecResult).stderr;
      if ([124, 125, 137].includes(exitCode) || opts.timeout_ms !== undefined && Date.now() - started >= opts.timeout_ms) break;
      if (!isRetryableAdapterFailure(providerFailure?.kind)) break;
      if (!repair.apply(diagnosis)) {
        if (!shouldStartFreshSession(result, resumeSessionId, sessionId)) break;
        resumeSessionId = undefined;
        invocationPrompt = opts.freshSessionPrompt ?? prompt;
      }
    }
    Object.assign(result, sumInvocationUsage(invocations), { invocations, duration_ms: Date.now() - started });
    settleSession(opts.runDir, opts.stageId, result, result.sessionId, resumeSessionId, opts.sessionOwnerStageId,
      { adapter: this.sessionKind, mismatchMessage: 'Claude resume returned a different session UUID; continuation was not verified' });
    finalizeSessionHome(nativeHome, result.exitCode, opts.preserveSession, { runDir: opts.runDir, stageId: opts.stageId, adapter: this.sessionKind });
    return result;
  }
}

export function createAdapter(): Adapter { return new ClaudeAdapter(); }
