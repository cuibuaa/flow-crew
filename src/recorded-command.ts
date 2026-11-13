import { createServer, type Socket } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { writeFileSync } from './engine-fs.js';
import { createInvocationScratch } from './invocation-scratch.js';
import { GitNotAnswered } from './git-facts.js';

export const RecordedCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().refine(isAbsolute),
  shell: z.string().refine(isAbsolute),
}).strict();
export type RecordedCommand = z.infer<typeof RecordedCommandSchema>;

// A native shell only transports this request. The parent executes and records
// the command; neither native event fields nor child-written receipts own it.
const client = `const net = require('node:net');
const socket = net.connect(process.argv[2]);
let response = '';
socket.setTimeout(65000, () => socket.destroy(new Error('Recorder response timed out')));
socket.on('connect', () => socket.end(process.argv[3]));
socket.on('data', chunk => { response += chunk; process.stdout.write(chunk); });
socket.on('end', () => { try { if (JSON.parse(response).code === 'GIT_NOT_ANSWERED') process.exitCode = 1; } catch {} });
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
`;
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** One invocation-local command endpoint, sharing the attempt's cancellation
 * and command runner. It never publishes a configured validation. */
export async function startCommandRecorder(runDir: string,
  execute: (request: RecordedCommand, signal: AbortSignal) => Promise<unknown>) {
  const scratch = createInvocationScratch(runDir), path = join(scratch.path, 'command.sock');
  const clientPath = join(scratch.path, 'record-command.cjs');
  writeFileSync(clientPath, client, { mode: 0o600 });
  const controller = new AbortController(), sockets = new Set<Socket>(), jobs = new Set<Promise<void>>();
  let failure: GitNotAnswered | undefined;
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on('error', () => { /* a disconnected caller cannot publish facts */ });
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(65000, () => socket.destroy());
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) socket.destroy();
    });
    socket.on('end', () => {
      const job = (async () => {
        try {
          if (controller.signal.aborted || socket.destroyed) return;
          const request = RecordedCommandSchema.parse(JSON.parse(input));
          socket.end(JSON.stringify(await execute(request, controller.signal)) + '\n');
        } catch (error) {
          if (error instanceof GitNotAnswered) {
            failure ??= error;
            controller.abort();
          }
          socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error),
            ...(error instanceof GitNotAnswered ? { code: error.code } : {}) }) + '\n');
        }
      })();
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) { scratch.cleanup(); throw error; }
  return {
    command: `${quote(process.execPath)} ${quote(clientPath)} ${quote(path)}`,
    async close() {
      controller.abort();
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...jobs]);
      try {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally { scratch.cleanup(); }
      if (failure) throw failure;
    },
  };
}
