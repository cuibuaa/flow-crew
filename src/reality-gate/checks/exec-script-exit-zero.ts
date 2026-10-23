import { withEngineIntegrity } from '../../engine-integrity.js';
import { spawnOwnedCommand } from '../../adapters/base.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { CheckContext, RealityCheck, RealityGateExit } from '../types.js';
import { result } from './_utils.js';

interface Params {
  script?: string;
  args?: string[];
  timeout_seconds?: number;
}

interface Execution {
  /** Complete shell text, with only secret-shaped literals redacted. */
  command: string;
  stdout: string;
  stderr: string;
  exit: RealityGateExit;
}

function commandNotFound(stderr: string): string | undefined {
  const match = stderr.match(/^(?:.*?:\s*)?(?:line\s+\d+:\s*)?([^:\r\n]+?): command not found\r?$/m);
  const command = match?.[1]?.trim();
  return command || undefined;
}

export default class ExecScriptExitZeroCheck implements RealityCheck {
  static meta = { description: 'Run a shell command / inline script body (via `bash -c`, from the project dir) and require exit 0. `script` is the command or script TEXT — inline multi-line scripts and heredocs are fine, and relative paths resolve from the project dir; it is NOT restricted to a file path. Exit 127 with a command-not-found diagnostic is advisory with its failed execution preserved.', params: 'script: string (shell command or inline script body), args?: string[], timeout_seconds?: number' };
  async run(raw: object, context: CheckContext) {
    return withEngineIntegrity(context.commandBoundary ?? {
      projectDir: context.projectDir,
      runDir: resolve(context.taskDir) === resolve(context.projectDir) ? undefined : context.taskDir,
      stageId: '_reality',
    }, () => this.runChecked(raw, context));
  }
  private async runChecked(raw: object, context: CheckContext) {
    const params = raw as Params;
    if (typeof params.script !== 'string') return result(false, '`params.script` must be provided; add a failure-capable script and rerun the check.');
    const args = Array.isArray(params.args) ? params.args : [];
    const timeoutMs = Math.max(1, params.timeout_seconds ?? 60) * 1000;
    // Run the script BODY through the shell from the project dir, so inline scripts and
    // relative paths (docs/...) work. A bare command is still valid → backward-compatible.
    // Edge: a bare relative filename (no slash) that exists in the project dir is a project
    // SCRIPT, but `bash -c "name"` would PATH-resolve it and miss it — so prefix `./` to run
    // the project-relative file (makes the "relative paths resolve from the project dir" claim true).
    let scriptText = params.script;
    const firstTok = params.script.trim().split(/\s+/)[0] ?? '';
    if (firstTok && !firstTok.includes('/') && existsSync(join(context.projectDir, firstTok))) {
      scriptText = './' + params.script.trim();
    }
    const cmd = args.length
      ? `${scriptText} ${args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ')}`
      : scriptText;
    const execution = await run('bash', ['-c', cmd], context.projectDir, timeoutMs, cmd);
    const diagnostic = execution.exit.code !== 0
      && execution.stdout.trim().length === 0
      && execution.stderr.trim().length === 0
      ? executorDiagnostic(execution, cmd)
      : undefined;
    const missingCommand = execution.exit.code === 127 ? commandNotFound(execution.stderr) : undefined;
    if (missingCommand) {
      return {
        ...result(
          false,
          `Environment could not run check: command not found: ${missingCommand} (exit 127). Install or replace the named command, then rerun the check.`,
          { ...execution, environmentDefect: 'command_not_found', missingCommand },
        ),
        advisory: true,
      };
    }
    const status = execution.exit.code === 0
      ? 'script exited 0'
      : execution.exit.timedOut
        ? 'script timed out'
        : execution.exit.signal
          ? `script ended on signal ${execution.exit.signal}`
          : `script exited ${execution.exit.code ?? 'without code'}`;
    const actionableFailure = execution.exit.code === 0 || diagnostic
      ? status
      : `${status} for script ${scriptExcerpt(cmd)}. Rerun it from the project root, inspect the captured stdout/stderr, and fix the named failing condition.`;
    return result(
      execution.exit.code === 0,
      diagnostic ? `${status}; ${diagnostic}` : actionableFailure,
      diagnostic ? { ...execution, executorDiagnostic: diagnostic } : execution,
    );
  }
}

function executorDiagnostic(execution: Execution, command: string): string {
  const status = execution.exit.timedOut
    ? 'timed out'
    : execution.exit.signal
      ? `ended on signal ${execution.exit.signal}`
      : `exited ${execution.exit.code ?? 'without an exit code'}`;
  return `Executor diagnostic: the check ${status} and captured no stdout or stderr. Script excerpt: ${scriptExcerpt(command)}. Rerun the script from the project root, make each condition emit a named diagnostic, and inspect exit, signal, and timeout evidence.`;
}

function scriptExcerpt(command: string): string {
  const redacted = stripVTControlCharacters(redactCommand(command))
    .replace(/\s+/g, ' ')
    .trim();
  if (redacted.length <= 360) return redacted || '(empty script)';
  return `${redacted.slice(0, 178)} … ${redacted.slice(-178)}`;
}

function redactCommand(command: string): string {
  return command
    .replace(/(((?:[A-Za-z_][A-Za-z0-9_]*_)?(?:api[_-]?key|authorization|password|secret(?:_(?:access_)?key)?|token))\s*=\s*)(?:'[^']*'|"[^"]*"|[^\s;&|()]+)/gi, '$1[redacted]')
    .replace(/((?:--)(?:[a-z0-9]+[-_])*(?:api[_-]?key|authorization|password|secret|token)(?:\s+|=))(?:'[^']*'|"[^"]*"|[^\s;&|()]+)/gi, '$1[redacted]')
    .replace(/(Bearer\s+)(?:'[^']*'|"[^"]*"|[^\s;&|()]+)/gi, '$1[redacted]');
}

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  evidenceCommand: string,
): Promise<Execution> {
  return new Promise((resolve) => {
    const { child, stop } = spawnOwnedCommand(command, args, { cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let spawnError: string | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null, finalStderr = stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exit: RealityGateExit = { code, signal, timedOut };
      resolve({
        command: redactCommand(evidenceCommand),
        stdout,
        stderr: finalStderr,
        exit,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => {
      spawnError = String(err);
    });
    // `close` follows process exit only after the stdio streams have closed, so
    // the durable report cannot miss output that arrived at the exit boundary.
    child.on('close', (code, signal) => {
      const error = spawnError;
      finish(error ? code || 1 : code, signal, error ? `${stderr}\n${error}` : stderr);
    });
  });
}
