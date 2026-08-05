import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { CheckContext, CheckResult, RealityCheck, RealityGateExit } from '../types.js';
import { result } from './_utils.js';

interface Params {
  script?: string;
  args?: string[];
  timeout_seconds?: number;
  archive_paths?: string[];
  archive_ref?: string;
}

interface Execution {
  /** Complete shell text, with only secret-shaped literals redacted. */
  command: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exit: RealityGateExit;
}

const CLEAN_ARCHIVE_COMMAND = /(?:^|[;&|()\n])\s*git\s+archive(?:\s|$)/m;

function commandNotFound(stderr: string): string | undefined {
  const match = stderr.match(/^(?:.*?:\s*)?(?:line\s+\d+:\s*)?([^:\r\n]+?): command not found\r?$/m);
  const command = match?.[1]?.trim();
  return command || undefined;
}

export default class ExecScriptExitZeroCheck implements RealityCheck {
  static meta = { description: 'Run a shell command / inline script body (via `bash -c`, from the project dir) and require exit 0. `script` is the command or script TEXT — inline multi-line scripts and heredocs are fine, and relative paths resolve from the project dir; it is NOT restricted to a file path. Scripts that use `git archive` must declare every repository input in `archive_paths`; each path is verified in `archive_ref` (default `HEAD`) before the script runs. Exit 127 is advisory only when stderr contains a command-not-found diagnostic.', params: 'script: string (shell command or inline script body), args?: string[], timeout_seconds?: number, archive_paths?: string[] (required with git archive), archive_ref?: string (default HEAD)' };
  async run(raw: object, context: CheckContext) {
    const params = raw as Params;
    if (typeof params.script !== 'string') return result(false, 'script must be provided');
    const args = Array.isArray(params.args) ? params.args : [];
    const timeoutMs = Math.max(1, params.timeout_seconds ?? 60) * 1000;
    const archiveFailure = await preflightCommittedArchiveInputs(params, context, timeoutMs);
    if (archiveFailure) return archiveFailure;
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
    const diagnostic = execution.code !== 0
      && execution.stdout.trim().length === 0
      && execution.stderr.trim().length === 0
      ? executorDiagnostic(execution, cmd)
      : undefined;
    const missingCommand = execution.code === 127 ? commandNotFound(execution.stderr) : undefined;
    if (missingCommand) {
      return {
        ...result(
          false,
          `environment could not run check: command not found: ${missingCommand} (exit 127)`,
          { ...execution, environmentDefect: 'command_not_found', missingCommand },
        ),
        advisory: true,
      };
    }
    const status = execution.code === 0 ? 'script exited 0' : `script exited ${execution.code ?? 'without code'}`;
    return result(
      execution.code === 0,
      diagnostic ? `${status}; ${diagnostic}` : status,
      diagnostic ? { ...execution, executorDiagnostic: diagnostic } : execution,
    );
  }
}

async function preflightCommittedArchiveInputs(
  params: Params,
  context: CheckContext,
  timeoutMs: number,
): Promise<CheckResult | undefined> {
  if (!params.script || !CLEAN_ARCHIVE_COMMAND.test(params.script)) return undefined;
  if (!Array.isArray(params.archive_paths) || params.archive_paths.length === 0) {
    return result(
      false,
      'clean-archive scripts must declare every repository input in `archive_paths`',
      { stdout: '', stderr: 'Executor preflight stopped the check before `git archive`: `archive_paths` is missing or empty.' },
    );
  }
  if (params.archive_paths.some((value) => typeof value !== 'string')) {
    return result(false, '`archive_paths` must contain only repository-relative strings');
  }
  if (params.archive_ref !== undefined && (typeof params.archive_ref !== 'string' || params.archive_ref.trim().length === 0)) {
    return result(false, '`archive_ref` must be a nonempty git revision when provided');
  }
  const archiveRef = params.archive_ref?.trim() || 'HEAD';
  for (const value of params.archive_paths) {
    const archivePath = normalizeArchivePath(value);
    if (!archivePath) {
      return result(false, `archive path must be repository-relative and cannot traverse its root: ${JSON.stringify(value)}`);
    }
    const execution = await run(
      'git',
      ['cat-file', '-e', `${archiveRef}:${archivePath}`],
      context.projectDir,
      Math.min(timeoutMs, 10_000),
    );
    if (execution.code !== 0) {
      // `git cat-file` fails for two very different reasons. Only one of them
      // is about the path. Reporting "not present in HEAD" when there is no
      // HEAD states more than the evidence supports, and sends the reader
      // looking for a missing file that is not missing.
      const notARepository = /not a git repository|does not have any commits yet|unknown revision/i
        .test(execution.stderr);
      const summary = notARepository
        ? `clean archive preflight could not run: ${context.projectDir} is not a git repository with ${archiveRef}`
        : `clean archive preflight failed: ${archivePath} is not present in ${archiveRef}`;
      const stderr = execution.stderr.trim().length > 0
        ? execution.stderr
        : `Executor preflight could not resolve ${archivePath} in ${archiveRef}.`;
      return result(false, summary, { ...execution, stderr, archiveRef, archivePath });
    }
  }
  return undefined;
}

function normalizeArchivePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || isAbsolute(trimmed)) return undefined;
  const normalized = posix.normalize(trimmed.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

function executorDiagnostic(execution: Execution, command: string): string {
  const status = execution.timedOut
    ? 'timed out'
    : execution.signal
      ? `ended on signal ${execution.signal}`
      : `exited ${execution.code ?? 'without an exit code'}`;
  return `Executor diagnostic: the check ${status} and captured no stdout or stderr. Script excerpt: ${scriptExcerpt(command)}`;
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

function renderSpawnCommand(command: string, args: string[]): string {
  return [command, ...args].map((part) => {
    if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part)) return part;
    return `'${part.replace(/'/g, `'\\''`)}'`;
  }).join(' ');
}

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  evidenceCommand = renderSpawnCommand(command, args),
): Promise<Execution> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, finalStderr = stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exit: RealityGateExit = { code, signal, timedOut };
      resolve({
        command: redactCommand(evidenceCommand),
        code,
        signal,
        stdout,
        stderr: finalStderr,
        timedOut,
        exit,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    }, timeoutMs);
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => {
      finish(1, null, stderr + String(err));
    });
    // `close` follows process exit only after the stdio streams have closed, so
    // the durable report cannot miss output that arrived at the exit boundary.
    child.on('close', (code, signal) => finish(code, signal));
  });
}
