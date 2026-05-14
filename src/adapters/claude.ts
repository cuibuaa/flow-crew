import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult, DiscussOpts, ChildProcess, InteractiveSession } from './base.js';
import { execWithTimeout, execWithStdin, execWithStreaming, tryImportPty, spawnFallbackInteractive } from './base.js';

/** Parse token usage from claude output */
function parseTokens(output: string): { tokens_in?: number; tokens_out?: number } {
  const m = output.match(/[Tt]okens[^:]*:\s*([\d,]+)\s*(?:in(?:put)?)\s*[/,]\s*([\d,]+)\s*(?:out(?:put)?)/);
  if (m) return { tokens_in: parseInt(m[1].replace(/,/g, ''), 10), tokens_out: parseInt(m[2].replace(/,/g, ''), 10) };
  const inM = output.match(/input_tokens\s*[:=]\s*([\d,]+)/);
  const outM = output.match(/output_tokens\s*[:=]\s*([\d,]+)/);
  if (inM || outM) return {
    tokens_in: inM ? parseInt(inM[1].replace(/,/g, ''), 10) : undefined,
    tokens_out: outM ? parseInt(outM[1].replace(/,/g, ''), 10) : undefined,
  };
  return {};
}

/**
 * Anthropic Claude Code CLI adapter.
 *
 * Non-interactive: `claude -p "prompt"` (print mode, exits after response)
 * Resume: `claude -c -p "follow-up"` (continue last session)
 * Resume by ID: `claude -r <session> -p "follow-up"`
 * Interactive: `claude` (TUI mode, needs PTY)
 *
 * Flags:
 *   -p / --print: non-interactive, print response and exit
 *   -c / --continue: resume most recent session in cwd
 *   -r / --resume <id>: resume specific session
 *   --dangerously-skip-permissions: no approval prompts
 *   --output-format text|json|stream-json: output format
 *   --model sonnet|opus: model selection
 *   --effort low|medium|high|xhigh|max: reasoning effort level
 *   --system-prompt "text": override system prompt
 *   --append-system-prompt "text": append to default system prompt
 *   --max-turns N: limit agentic turns
 */
export class ClaudeAdapter implements Adapter {

  async run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult> {
    const args = [
      '-p',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (role.model && role.model !== 'default') args.push('--model', role.model);
    if (role.reasoning_effort && role.reasoning_effort !== 'default') args.push('--effort', role.reasoning_effort);

    // Write system prompt to file to avoid ARG_MAX on long role prompts
    const stageDir = join(opts.runDir, 'stages', opts.stageId);
    mkdirSync(stageDir, { recursive: true });
    if (role.prompt) {
      const systemPromptPath = join(stageDir, 'system_prompt.md');
      writeFileSync(systemPromptPath, role.prompt, 'utf-8');
      args.push('--append-system-prompt-file', systemPromptPath);
    }

    // Use stream-json for live output visibility — parse text from JSON stream
    const liveLogPath = join(opts.runDir, 'stages', opts.stageId, 'live.log');
    mkdirSync(stageDir, { recursive: true });

    let lineBuf = '';
    let extractedText = '';
    // Track whether the `claude` CLI has emitted its terminal {"type":"result"}
    // event. Upstream the CLI sometimes fails to close its stdio pipes after
    // emitting this, which would leave our scheduler awaiting the child
    // forever. When we see the event, we schedule a force-kill after a short
    // grace period so the stage doesn't hang for the full stage timeout.
    let resultReceived = false;
    let resultIsSuccess = false;
    let childKill: (() => void) | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const POST_RESULT_GRACE_MS = 5000;
    const result = await execWithStdin('claude', args, prompt, {
      cwd: opts.workDir,
      timeout_ms: opts.timeout_ms,
      liveLogPath, // raw stream-json goes to live.log for debugging
      onChild: ({ kill }) => { childKill = kill; },
      onStdout: (chunk: string) => {
        // Parse stream-json lines and extract text content for clean live output
        lineBuf += chunk;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            let text = '';
            if (parsed.type === 'assistant' && typeof parsed.content === 'string') {
              text = parsed.content;
            } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              text = parsed.delta.text;
            } else if (parsed.type === 'result' && typeof parsed.result === 'string') {
              text = parsed.result;
            }
            // Detect terminal result event: schedule a force-kill if the CLI
            // doesn't exit gracefully within the grace period.
            if (parsed.type === 'result' && !resultReceived) {
              resultReceived = true;
              resultIsSuccess = parsed.is_error !== true && parsed.subtype !== 'error';
              if (!killTimer) {
                killTimer = setTimeout(() => {
                  if (childKill) childKill();
                }, POST_RESULT_GRACE_MS);
              }
            }
            if (text) {
              extractedText += text;
              try { appendFileSync(liveLogPath + '.txt', text); } catch { /* non-critical */ }
            }
          } catch { /* non-JSON line, skip */ }
        }
      },
    });
    if (killTimer) clearTimeout(killTimer);

    // Use extracted text as the output (clean, no JSON wrappers)
    const finalOutput = extractedText || result.output;
    const tokens = parseTokens(result.output);
    // Override exit code when the CLI emitted a successful result event but we
    // had to force-kill its hung process to recover. The actual work succeeded;
    // the non-zero code is just a stdio-cleanup artifact upstream.
    const overrideExitCode = result.exitCode !== 0 && resultReceived && resultIsSuccess;
    return {
      ...result,
      output: finalOutput,
      exitCode: overrideExitCode ? 0 : result.exitCode,
      tokens_in: tokens.tokens_in,
      tokens_out: tokens.tokens_out,
    };
  }

  async discuss(message: string, role: AgentConfig, opts: DiscussOpts): Promise<RunResult> {
    mkdirSync(opts.sessionDir, { recursive: true });
    // Claude uses cwd-based session tracking — -c continues the last session in this dir
    const hasSession = existsSync(join(opts.sessionDir, '.claude'));
    const args = [
      '-p',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
    ];
    if (role.model && role.model !== 'default') args.push('--model', role.model);
    if (role.reasoning_effort && role.reasoning_effort !== 'default') args.push('--effort', role.reasoning_effort);
    if (role.prompt) {
      const spPath = join(opts.sessionDir, 'system_prompt.md');
      writeFileSync(spPath, role.prompt, 'utf-8');
      args.push('--append-system-prompt-file', spPath);
    }
    if (hasSession) args.push('-c');
    args.push(message);

    // Parse stream-json: each line is a JSON object, extract assistant text
    let lineBuf = '';
    const onChunk = opts.onChunk ?? (() => {});

    return execWithStreaming('claude', args, {
      cwd: opts.sessionDir,
      timeout_ms: 300000,
      onChunk: (text) => {
        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            // stream-json emits various event types; extract text content
            if (parsed.type === 'assistant' && typeof parsed.content === 'string') {
              onChunk(parsed.content);
            } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              onChunk(parsed.delta.text);
            } else if (parsed.type === 'result' && parsed.result) {
              onChunk(typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result));
            }
          } catch { /* ignore non-JSON lines */ }
        }
      },
    });
  }

  spawnDiscuss(message: string, role: AgentConfig, opts: DiscussOpts): ChildProcess {
    mkdirSync(opts.sessionDir, { recursive: true });
    const hasSession = existsSync(join(opts.sessionDir, '.claude'));
    const args = [
      '-p',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
    ];
    if (role.model && role.model !== 'default') args.push('--model', role.model);
    if (role.reasoning_effort && role.reasoning_effort !== 'default') args.push('--effort', role.reasoning_effort);
    if (role.prompt) {
      const spPath = join(opts.sessionDir, 'system_prompt.md');
      writeFileSync(spPath, role.prompt, 'utf-8');
      args.push('--append-system-prompt-file', spPath);
    }
    if (hasSession) args.push('-c');
    args.push(message);
    return spawn('claude', args, { cwd: opts.sessionDir, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  async spawnInteractive(role: AgentConfig, opts: DiscussOpts): Promise<InteractiveSession> {
    mkdirSync(opts.sessionDir, { recursive: true });
    const pty = await tryImportPty();
    const args = ['--dangerously-skip-permissions'];
    if (role.model && role.model !== 'default') args.push('--model', role.model);
    if (role.reasoning_effort && role.reasoning_effort !== 'default') args.push('--effort', role.reasoning_effort);
    if (role.prompt) {
      const spPath = join(opts.sessionDir, 'system_prompt.md');
      writeFileSync(spPath, role.prompt, 'utf-8');
      args.push('--append-system-prompt-file', spPath);
    }

    if (pty) {
      const proc = pty.spawn('claude', args, {
        cwd: opts.workDir,
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
      return {
        onData: (cb: (data: string) => void) => proc.onData(cb),
        write: (data: string) => proc.write(data),
        resize: (cols: number, rows: number) => proc.resize(cols, rows),
        kill: () => proc.kill(),
        onExit: (cb: (exitCode: number) => void) => proc.onExit(({ exitCode }: { exitCode: number }) => cb(exitCode)),
      };
    }
    return spawnFallbackInteractive('claude', args, {
      cwd: opts.workDir,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  }
}

export function createAdapter(): Adapter {
  return new ClaudeAdapter();
}
