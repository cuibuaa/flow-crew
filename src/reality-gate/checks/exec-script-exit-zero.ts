import { spawn } from 'node:child_process';
import type { CheckContext, RealityCheck } from '../types.js';
import { result } from './_utils.js';

interface Params {
  script?: string;
  args?: string[];
  timeout_seconds?: number;
}

export default class ExecScriptExitZeroCheck implements RealityCheck {
  static meta = { description: 'Run a shell command / inline script body (via `bash -c`, from the project dir) and require exit 0. `script` is the command or script TEXT — inline multi-line scripts and heredocs are fine, and relative paths resolve from the project dir; it is NOT restricted to a file path.', params: 'script: string (shell command or inline script body), args?: string[], timeout_seconds?: number' };
  async run(raw: object, context: CheckContext) {
    const params = raw as Params;
    if (typeof params.script !== 'string') return result(false, 'script must be provided');
    const args = Array.isArray(params.args) ? params.args : [];
    const timeoutMs = Math.max(1, params.timeout_seconds ?? 60) * 1000;
    // Run the script BODY through the shell from the project dir, so inline scripts and
    // relative paths (docs/...) work. A bare path is still a valid command → backward-compatible.
    const cmd = args.length
      ? `${params.script} ${args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ')}`
      : params.script;
    const execution = await run('bash', ['-c', cmd], context.projectDir, timeoutMs);
    return result(execution.code === 0, execution.code === 0 ? 'script exited 0' : `script exited ${execution.code ?? 'without code'}`, execution);
  }
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, signal: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), timedOut });
    });
  });
}
