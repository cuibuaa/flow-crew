import { spawn } from 'node:child_process';
import type { CheckContext, RealityCheck } from '../types.js';
import { resolvePath, result } from './_utils.js';

interface Params {
  script?: string;
  args?: string[];
  timeout_seconds?: number;
}

export default class ExecScriptExitZeroCheck implements RealityCheck {
  async run(raw: object, context: CheckContext) {
    const params = raw as Params;
    if (typeof params.script !== 'string') return result(false, 'script must be provided');
    const script = resolvePath(params.script, context);
    const args = Array.isArray(params.args) ? params.args : [];
    const timeoutMs = Math.max(1, params.timeout_seconds ?? 60) * 1000;
    const execution = await run(script, args, context.projectDir, timeoutMs);
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
