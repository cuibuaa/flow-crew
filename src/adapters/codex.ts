import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult } from './base.js';
import { execWithTimeout } from './base.js';
import { extractFinalMessage } from './transcript.js';
import { applyFix, diagnoseAdapterFailure, type AdapterFix, type Diagnosis } from './diagnose.js';

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
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  sessionId?: string;
  tokens_in?: number;
  tokens_out?: number;
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
  const messages: string[] = [];
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

    const usage = event.usage && typeof event.usage === 'object' ? event.usage as Record<string, unknown> : undefined;
    const input = numericUsage(usage?.input_tokens ?? usage?.inputTokens);
    const outputTokens = numericUsage(usage?.output_tokens ?? usage?.outputTokens);
    if (input !== undefined) { tokensIn += input; sawTokensIn = true; }
    if (outputTokens !== undefined) { tokensOut += outputTokens; sawTokensOut = true; }
  }

  return {
    eventCount,
    output: messages.at(-1) ?? '',
    sessionId,
    tokens_in: sawTokensIn ? tokensIn : undefined,
    tokens_out: sawTokensOut ? tokensOut : undefined,
    writes: [...writes].sort(),
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function userCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function syncCodexAuthFiles(codexHome: string): void {
  const sourceHome = userCodexHome();
  if (sourceHome === codexHome) return;

  for (const fileName of ['auth.json', 'credentials.json', 'installation_id']) {
    const sourcePath = join(sourceHome, fileName);
    const targetPath = join(codexHome, fileName);
    try {
      if (!existsSync(sourcePath)) continue;
      if (!statSync(sourcePath).isFile()) continue;
      // Codex login refreshes rotate auth data. Long-running FlowCrew retries
      // must not keep using a stale per-stage copy after the global login state
      // has moved forward.
      copyFileSync(sourcePath, targetPath);
    } catch {
      // Missing auth files are fine for environments that authenticate another way.
    }
  }
}

function linkSharedPluginsCache(codexHome: string): void {
  // Codex CLI clones a plugins repo into $CODEX_HOME/.tmp/plugins/ on first
  // run. Without intervention every per-stage codex_home re-clones it
  // (~13-19M per spawn -> 100s of GB across long-running FlowCrew campaigns).
  // Symlink that path to a single shared cache so Codex sees it as already
  // present and skips the clone.
  const sharedDir = process.env.CODEX_PLUGINS_CACHE
    || join(homedir(), '.codex-plugins-shared');
  try {
    if (!existsSync(sharedDir)) mkdirSync(sharedDir, { recursive: true });
    const tmpDir = join(codexHome, '.tmp');
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const pluginsLink = join(tmpDir, 'plugins');
    if (!existsSync(pluginsLink)) {
      symlinkSync(sharedDir, pluginsLink, 'dir');
    }
  } catch {
    // best-effort; fall back to per-stage clone if symlink fails
  }
}

function linkSharedSkillsCache(codexHome: string): void {
  // Codex CLI populates $CODEX_HOME/skills/ with built-in skill assets
  // (.system/imagegen etc, ~500K per stage). Same pattern as plugins:
  // symlink to a shared dir so the first stage populates it and subsequent
  // stages re-use the bytes.
  const sharedDir = process.env.CODEX_SKILLS_CACHE
    || join(homedir(), '.codex-skills-shared');
  try {
    if (!existsSync(sharedDir)) mkdirSync(sharedDir, { recursive: true });
    const link = join(codexHome, 'skills');
    if (!existsSync(link)) {
      symlinkSync(sharedDir, link, 'dir');
    }
  } catch {
    // best-effort
  }
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

export function writeCodexConfig(codexHome: string, role: AgentConfig): string {
  mkdirSync(codexHome, { recursive: true });
  syncCodexAuthFiles(codexHome);
  linkSharedPluginsCache(codexHome);
  linkSharedSkillsCache(codexHome);
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
  writeFileSync(configPath, `${lines.join('\n')}\n`);
  return configPath;
}

export function stageCodexHome(runDir: string, stageId: string): string {
  return join(runDir, 'stages', stageId, 'codex_home');
}

export function codexArgs(): string[] {
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

export function buildCodexExecArgs(prompt: string, sessionId?: string): string[] {
  if (sessionId !== undefined && !isCodexSessionUuid(sessionId)) {
    throw new Error('Codex session resume requires an explicit UUID');
  }
  const args = sessionId
    ? ['exec', 'resume', '--json', ...codexArgs(), sessionId]
    : ['exec', '--json', ...codexArgs()];
  // Terminate option parsing before prompts that begin with YAML fences/dashes.
  args.push('--', prompt);
  return args;
}

/**
 * OpenAI Codex CLI adapter.
 *
 * Non-interactive: `codex exec "prompt"` (no sandbox/approval prompts)
 * Resume: `codex exec resume <UUID> "follow-up"`
 * Interactive: `codex` (TUI mode, needs PTY)
 *
 * Flags:
 *   --dangerously-bypass-approvals-and-sandbox: no approval prompts/sandbox
 *   --model: override model
 *   --config reasoning_effort="<effort>": set reasoning effort
 */
export class CodexAdapter implements Adapter {
  async run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult> {
    const ownerStageId = opts.resumeSessionId ? (opts.sessionOwnerStageId ?? opts.stageId) : opts.stageId;
    const codexHome = stageCodexHome(opts.runDir, ownerStageId);
    // Mutable because a dead session is recoverable: `fresh_session` abandons the resume
    // id and rebuilds these arguments. Tracking it here rather than reading
    // `opts.resumeSessionId` later matters — the session capture below falls back to the
    // resume id, which would otherwise record the dead session as this stage's own.
    let resumeSessionId = opts.resumeSessionId;
    let args = buildCodexExecArgs(prompt, resumeSessionId);

    let result: RunResult | undefined;
    const liveLogPath = join(opts.runDir, 'stages', opts.stageId, 'live.log');
    try {
      // SURGICAL param-fix retry: when the failure output NAMES a fixable
      // parameter, fix exactly that and retry — instead of a blind same-config
      // retry that re-sends the request the server just rejected (and, with a
      // 30-minute stage timeout, burns real wall time to fail identically).
      // At most 2 fixes, each fix applied at most once.
      let effectiveRole = role;
      const applied = new Set<AdapterFix>();
      let diagnosis: Diagnosis = { fix: 'none', friendly: '', matched: '' };
      for (;;) {
        writeCodexConfig(codexHome, effectiveRole);
        result = await execWithTimeout('codex', args, {
          cwd: opts.workDir,
          timeout_ms: opts.hard_timeout_ms ?? opts.timeout_ms,
          liveLogPath,
          env: { CODEX_HOME: codexHome },
          abortSignal: opts.abortSignal && opts.hardAbortSignal
            ? AbortSignal.any([opts.abortSignal, opts.hardAbortSignal])
            : (opts.abortSignal ?? opts.hardAbortSignal),
        });
        if (result.exitCode === 0) break;
        diagnosis = diagnoseAdapterFailure(result.output, result.exitCode);
        if (diagnosis.fix === 'none' || applied.has(diagnosis.fix) || applied.size >= 2) break;
        applied.add(diagnosis.fix);
        effectiveRole = applyFix(effectiveRole, diagnosis.fix);
        if (diagnosis.fix === 'fresh_session') {
          resumeSessionId = undefined;
          args = buildCodexExecArgs(prompt, undefined);
        }
        try {
          appendFileSync(liveLogPath,
            `\n↪︎ flowcrew: exit ${result.exitCode} matched "${diagnosis.matched}" → retrying once with ${diagnosis.fix}\n`);
        } catch { /* non-critical */ }
      }
      if (result.exitCode !== 0 && diagnosis.friendly) result.friendlyError = diagnosis.friendly;
      const rawOutput = result.output;
      const parsed = parseCodexJsonl(rawOutput, opts.workDir);
      const tokens = parsed.eventCount > 0
        ? { tokens_in: parsed.tokens_in, tokens_out: parsed.tokens_out }
        : parseTokens(rawOutput);
      if (tokens.tokens_in !== undefined) result.tokens_in = tokens.tokens_in;
      if (tokens.tokens_out !== undefined) result.tokens_out = tokens.tokens_out;
      const capturedSessionId = parsed.sessionId ?? (isCodexSessionUuid(resumeSessionId) ? resumeSessionId : undefined);
      if (capturedSessionId) {
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
      // Return ONLY the agent's final message. `codex exec` echoes the entire
      // session (banner + full prompt + prior-stage transcripts + token footer);
      // returning that raw polluted output.md, downstream handoff context, and run
      // summaries. The raw transcript is preserved in live.log for debugging.
      // (Parse tokens above FIRST — cleaning strips the "tokens used" footer.)
      result.output = parsed.output || extractFinalMessage(rawOutput);
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
