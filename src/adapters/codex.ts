import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, AgentConfig, RunOpts, RunResult, DiscussOpts, ChildProcess, InteractiveSession } from './base.js';
import { execWithTimeout, execWithStreaming } from './base.js';

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
  return {};
}

/**
 * OpenAI Codex CLI adapter.
 *
 * Non-interactive: `codex exec "prompt"` (no sandbox/approval prompts)
 * Resume: `codex exec resume --last "follow-up"`
 * Interactive: `codex` (TUI mode, needs PTY)
 *
 * Flags:
 *   --dangerously-bypass-approvals-and-sandbox: no approval prompts/sandbox
 *   --model: override model
 *   --config reasoning_effort="<effort>": set reasoning effort
 */
export class CodexAdapter implements Adapter {
  private appendCommonArgs(args: string[], role: AgentConfig): void {
    args.push('--dangerously-bypass-approvals-and-sandbox');
    if (role.model && role.model !== 'default') args.push('--model', role.model);
    if (role.reasoning_effort && role.reasoning_effort !== 'default') {
      args.push('--config', `reasoning_effort="${role.reasoning_effort}"`);
    }
  }

  async run(prompt: string, role: AgentConfig, opts: RunOpts): Promise<RunResult> {
    const args = ['exec'];
    this.appendCommonArgs(args, role);
    // Codex uses AGENTS.md for system prompt — must be in process cwd
    if (role.prompt) {
      const cwd = opts.workDir;
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, 'AGENTS.md'), role.prompt);
    }
    args.push(prompt);

    const result = await execWithTimeout('codex', args, {
      cwd: opts.workDir,
      timeout_ms: opts.timeout_ms,
      liveLogPath: join(opts.runDir, 'stages', opts.stageId, 'live.log'),
    });
    const tokens = parseTokens(result.output);
    if (tokens.tokens_in !== undefined) result.tokens_in = tokens.tokens_in;
    if (tokens.tokens_out !== undefined) result.tokens_out = tokens.tokens_out;
    return result;
  }

  async discuss(message: string, role: AgentConfig, opts: DiscussOpts): Promise<RunResult> {
    mkdirSync(opts.sessionDir, { recursive: true });
    const hasSession = existsSync(join(opts.sessionDir, '.codex'));
    const args = ['exec'];
    this.appendCommonArgs(args, role);
    if (hasSession) args.push('resume', '--last', message);
    else args.push(message);

    if (role.prompt) {
      writeFileSync(join(opts.sessionDir, 'AGENTS.md'), role.prompt);
    }

    return execWithStreaming('codex', args, {
      cwd: opts.sessionDir,
      timeout_ms: 300000,
      onChunk: opts.onChunk ?? (() => {}),
    });
  }

  spawnDiscuss(message: string, role: AgentConfig, opts: DiscussOpts): ChildProcess {
    mkdirSync(opts.sessionDir, { recursive: true });
    const hasSession = existsSync(join(opts.sessionDir, '.codex'));
    const args = ['exec'];
    this.appendCommonArgs(args, role);
    if (hasSession) args.push('resume', '--last', message);
    else args.push(message);
    return spawn('codex', args, { cwd: opts.sessionDir, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  async spawnInteractive(role: AgentConfig, opts: DiscussOpts): Promise<InteractiveSession> {
    mkdirSync(opts.sessionDir, { recursive: true });
    if (role.prompt) {
      writeFileSync(join(opts.sessionDir, 'AGENTS.md'), role.prompt);
    }
    const pty = await import('node-pty');
    // Interactive TUI mode — no 'exec', just 'codex'
    const args: string[] = [];
    this.appendCommonArgs(args, role);
    const proc = pty.spawn('codex', args, {
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
}

export function createAdapter(): Adapter {
  return new CodexAdapter();
}
