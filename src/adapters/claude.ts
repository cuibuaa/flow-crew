import { stageLiveLogPath } from '../stage-live-log.js';
import { writeFileSync, mkdirSync } from '../engine-fs.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isSessionUuid, settleSession } from '../adapter-session.js';
import type { Adapter, AgentConfig, ExecResult, RunOpts, RunResult } from './base.js';
import { execWithStdin } from './base.js';
import { classifyAdapterFailure, isRetryableAdapterFailure } from './failure.js';
import { providerRefusal, type ProviderFailure } from '../provider-result.js';
import { NativeEventSummary, normalizeNativeEvent } from './native-events.js';
import { NativeUsageAccumulator, sumInvocationUsage, type NativeInvocationUsage } from '../invocation-usage.js';
import { generationCompatibleSchema } from '../reality-gate/checks/json-schema-match.js';
import { AdapterParameterRepair, CLI_BUILTIN_DEFAULT, diagnoseAdapterFailure, resolveAdapterCapabilityIdentity,
  type NativeParameterRejection } from './diagnose.js';

interface ClaudeParameter {
  value: string | null;
  source: 'role' | 'user-settings' | 'cli-default';
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

function resolveClaudeSettings(role: AgentConfig, settings: ClaudeSettings): { model: ClaudeParameter; effort: ClaudeParameter } {
  const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
  const resolve = (value: string | undefined, inherited: unknown): ClaudeParameter => {
    if (value === CLI_BUILTIN_DEFAULT) return { value: null, source: 'cli-default' };
    if (value && value !== 'default') return { value, source: 'role' };
    const userValue = string(inherited);
    return userValue ? { value: userValue, source: 'user-settings' } : { value: null, source: 'cli-default' };
  };
  const model = resolve(role.model, settings.model);
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
    let resumeSessionId = opts.resumeSessionId;
    let invocationPrompt = prompt;
    let result: RunResult | undefined;
    const stageDir = join(opts.runDir, 'stages', opts.stageId);
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
        repair = new AdapterParameterRepair(role, opts.runDir, identity);
        selectionKey = key;
      }
      const effectiveRole = repair.role;
      const { args, unsetEnv, model, effort } = buildClaudeInvocation(effectiveRole, opts, systemPromptPath, resumeSessionId, settings);

      const summary = new NativeEventSummary(opts.workDir);
      const usage = new NativeUsageAccumulator();
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
      let carry = '';
      let eventCount = 0;
      let providerFailure: ProviderFailure | undefined;
      let rejected: NativeParameterRejection | undefined;
      let childKill: (() => void) | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let cleanupKill = false;
      const consume = (line: string): void => {
        let event: Record<string, any>;
        try { event = JSON.parse(line); } catch { return; }
        if (!event || typeof event !== 'object') return;
        eventCount++;
        const normalized = normalizeNativeEvent(event);
        summary.observe(normalized);
        if (normalized.sessionId) sessionId = normalized.sessionId;
        if (event.type === 'system' && event.subtype === 'init') captureInput(normalized.model);
        if (event.type === 'assistant') usage.observe({ usage: event.message?.usage, id: event.message?.id });
        if (event.type === 'result') {
          // usage describes this invocation; resumed model/cost totals include
          // earlier session calls and cannot be added to the invocation ledger.
          usage.observe({ usage: event.usage, cumulative: true,
            costUsd: resumeSessionId ? undefined : event.total_cost_usd,
            models: resumeSessionId ? undefined : event.modelUsage });
          killTimer ??= setTimeout(() => { if (childKill) { cleanupKill = true; childKill(); } }, 5000);
        }
        if (normalized.terminal !== undefined) {
          providerFailure = normalized.diagnostic && (event.type === 'error' || event.type === 'result')
            ? providerRefusal({ provider: 'claude', eventType: event.type, message: normalized.diagnostic }) : undefined;
          rejected = normalized.terminal === false
            ? { parameter: event.error?.param ?? event.error?.parameter ?? event.param, message: normalized.diagnostic } : undefined;
        }
      };
      const invocationStartedAt = new Date().toISOString();
      let execution: ExecResult;
      try {
        execution = await execWithStdin('claude', args, invocationPrompt, {
          cwd: opts.workDir, timeout_ms: Math.max(1, opts.timeout_ms - (Date.now() - started)),
          liveLogPath: stageLiveLogPath(opts.runDir, opts.stageId, opts.attemptIndex, opts.attemptStartedAt), captureStreams: true, execution: opts,
          unsetEnv,
          onChild: ({ kill }) => { childKill = kill; }, abortSignal: opts.abortSignal,
          onStdout: (chunk, activity) => {
            activity?.feed(chunk);
            carry += chunk;
            const lines = carry.split('\n');
            carry = lines.pop() ?? '';
            for (const line of lines) consume(line);
          },
        });
        if (carry.trim()) consume(carry);
      } finally {
        if (killTimer) clearTimeout(killTimer);
        captureInput();
      }
      if (inputCaptureError !== undefined) throw inputCaptureError;

      // Only our own post-result SIGKILL can turn a failed close into success.
      // Executor timeout/abort outcomes always win, and close facts stay intact.
      const recovered = cleanupKill && summary.completed && execution.processSignal === 'SIGKILL'
        && execution.exitCode !== 124 && execution.exitCode !== 137;
      const exitCode = recovered ? 0 : execution.exitCode === 0 && summary.terminal === false ? 1 : execution.exitCode;
      const counters = usage.settle(exitCode === 0 && summary.completed);
      invocations.push({ ...counters, startedAt: invocationStartedAt, completedAt: new Date().toISOString(),
        exitCode, sessionId, source: eventCount ? 'native_stdout' : 'unknown' });
      const evidence = [summary.diagnostic, execution.stderr].filter(Boolean).join('\n');
      const diagnosis = execution.spawnError && ![124, 137].includes(exitCode)
        ? { fix: 'none' as const, friendly: `Could not launch Claude: ${execution.spawnError.message}. Check the executable, its interpreter and working directory ${execution.spawnError.cwd}.`, matched: execution.spawnError.code ?? 'spawn error' }
        : diagnoseAdapterFailure(eventCount ? evidence : execution.output, exitCode, rejected);
      const kind = exitCode !== 0 && ![124, 137].includes(exitCode) && !execution.spawnError
        ? classifyAdapterFailure(eventCount ? evidence : execution.output) : undefined;
      let output = execution.spawnError ? execution.output : eventCount ? summary.output : execution.output;
      if (exitCode !== 0 && execution.stderr?.trim() && !output.includes(execution.stderr.trim())) output = [output, execution.stderr.trim()].filter(Boolean).join('\n');
      if (exitCode === 137) output += '\n[stage cancelled by control plane]\n';
      result = { ...execution, output, exitCode, sessionId, adapterError: kind !== undefined, adapterFailureKind: kind,
        ...(diagnosis.friendly && exitCode !== 0 ? { friendlyError: diagnosis.friendly } : {}),
        ...(exitCode !== 0 && ![124, 125, 137].includes(exitCode) && !execution.spawnError && providerFailure ? { providerFailure } : {}),
        writes: [...summary.writes].sort(), writeAttribution: summary.writes.size ? 'structured' : 'unknown' };
      delete (result as ExecResult).stdout;
      delete (result as ExecResult).stderr;
      if ([124, 125, 137].includes(exitCode) || Date.now() - started >= opts.timeout_ms) break;
      if (!isRetryableAdapterFailure(kind)) break;
      // An unattested failed resume retries fresh once. Retain every call in
      // the same ledger and budget; attested/control/spawn failures do not replay.
      if (resumeSessionId && exitCode !== 0 && ![124, 125, 137].includes(exitCode)
          && !execution.spawnError && !sessionId) {
        resumeSessionId = undefined;
        invocationPrompt = opts.freshSessionPrompt ?? prompt;
        continue;
      }
      if (diagnosis.fix === 'fresh_session' || !repair.apply(diagnosis)) break;
    }
    Object.assign(result, sumInvocationUsage(invocations), { invocations, duration_ms: Date.now() - started });
    settleSession(opts.runDir, opts.stageId, result, result.sessionId, resumeSessionId, opts.sessionOwnerStageId,
      { adapter: this.sessionKind, mismatchMessage: 'Claude resume returned a different session UUID; continuation was not verified' });
    return result;
  }
}

export function createAdapter(): Adapter { return new ClaudeAdapter(); }
