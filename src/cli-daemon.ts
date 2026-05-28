import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { TaskRegistry } from './task-registry.js';
import { Orchestrator } from './orchestrator.js';
import { defaultSocketPath, sendRpc, startRpcServer, DaemonUnavailableError, type RpcRequest, type RpcResponse } from './orchestrator-rpc.js';

export async function cmdDaemon(args: string[], opts: { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const sub = args[1];
  const socketPath = valueAfter(args, '--port') ?? valueAfter(args, '--socket') ?? process.env.FLOWCREW_DAEMON_SOCKET ?? defaultSocketPath();
  const baseDir = dirname(socketPath);
  const logPath = join(baseDir, 'daemon.log');

  try {
    if (sub === 'start') {
      if (await isRunning(socketPath)) {
        stdout.write(`daemon already running at ${socketPath}\n`);
        return 0;
      }
      mkdirSync(baseDir, { recursive: true });
      const cliPath = resolve(import.meta.dirname ?? '.', 'cli.js');
      const out = openLog(logPath);
      const child = spawn(process.execPath, [cliPath, 'daemon', 'serve', '--port', socketPath], {
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env, FLOWCREW_DAEMON_SOCKET: socketPath },
      });
      child.unref();
      for (let i = 0; i < 40; i++) {
        if (await isRunning(socketPath)) {
          stdout.write(`daemon started at ${socketPath}\n`);
          return 0;
        }
        await delay(100);
      }
      stderr.write(`daemon did not become ready; see ${logPath}\n`);
      return 1;
    }

    if (sub === 'serve') {
      await serve(socketPath, logPath);
      return 0;
    }

    if (sub === 'stop') {
      await sendRpc(socketPath, { cmd: 'stop' });
      stdout.write('daemon stopped\n');
      return 0;
    }

    if (sub === 'status') {
      const res = await sendRpc<{ uptime: number; watched_tasks: number }>(socketPath, { cmd: 'status' });
      stdout.write(`uptime: ${res.uptime}s\nwatched_tasks: ${res.watched_tasks}\n`);
      return 0;
    }

    if (sub === 'logs') {
      const tail = Number.parseInt(valueAfter(args, '--tail') ?? '100', 10);
      if (!existsSync(logPath)) return 0;
      const lines = readFileSync(logPath, 'utf-8').split(/\r?\n/);
      stdout.write(lines.slice(Math.max(0, lines.length - tail - 1)).join('\n'));
      if (args.includes('--follow')) {
        const child = spawn('tail', ['-f', logPath], { stdio: 'inherit' });
        await new Promise((resolve) => child.on('exit', resolve));
        return child.exitCode ?? 0;
      }
      return 0;
    }

    stderr.write('Usage: flowcrew daemon start|stop|status|logs ...\n');
    return 1;
  } catch (err) {
    if (err instanceof DaemonUnavailableError) stderr.write(`${err.message}\n`);
    else stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function serve(socketPath: string, logPath: string): Promise<void> {
  mkdirSync(dirname(socketPath), { recursive: true });
  const registry = new TaskRegistry({ baseDir: dirname(socketPath) });
  const orchestrator = new Orchestrator({ registry });
  let server: Awaited<ReturnType<typeof startRpcServer>>;

  const handler = async (req: RpcRequest): Promise<RpcResponse> => {
    appendFileSync(logPath, `${new Date().toISOString()} ${req.cmd}\n`, 'utf-8');
    if (req.cmd === 'register') {
      const task = await orchestrator.register(req.task);
      return { id: task.id, unit: task.systemd_unit };
    }
    if (req.cmd === 'list') return { tasks: registry.list(req.filter) };
    if (req.cmd === 'show') {
      const task = registry.get(req.id);
      if (!task) throw new Error(`Task not found: ${req.id}`);
      return { task, recent_ticks: registry.readRecentTicks(req.id) };
    }
    if (req.cmd === 'cancel') {
      await orchestrator.cancel(req.id);
      return { ok: true };
    }
    if (req.cmd === 'retry') {
      const task = await orchestrator.retry(req.id);
      return { new_attempt: task.attempt, unit: task.systemd_unit };
    }
    if (req.cmd === 'tail') return { output: await orchestrator.tail(req.id, req.lines, req.follow) };
    if (req.cmd === 'status') return orchestrator.status();
    if (req.cmd === 'stop') {
      orchestrator.stop();
      setTimeout(() => {
        server.close(() => {
          rmSync(socketPath, { force: true });
          process.exit(0);
        });
      }, 10);
      return { ok: true };
    }
    return { error: 'unknown command' };
  };

  server = await startRpcServer(socketPath, handler);
  orchestrator.start();
  appendFileSync(logPath, `${new Date().toISOString()} daemon started ${socketPath}\n`, 'utf-8');
}

async function isRunning(socketPath: string): Promise<boolean> {
  try {
    await sendRpc(socketPath, { cmd: 'status' }, 300);
    return true;
  } catch {
    return false;
  }
}

function openLog(logPath: string): number {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, existsSync(logPath) ? readFileSync(logPath) : '');
  return openSync(logPath, 'a');
}

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
