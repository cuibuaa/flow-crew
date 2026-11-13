import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { gitResultSync, gitSync, gitAsync, GitNotAnswered } from '../src/git-facts.js';

afterEach(() => vi.useRealTimers());

// Run the real owner in a worker so the test can explicitly release a native
// child while the synchronous caller is blocked. No loader, backend or daemon.
const owner = ts.transpileModule(readFileSync(new URL('../src/git-facts.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(owner).toString('base64')}`;

it('preserves genuine launch errors without mistaking them for a terminated child', async () => {
  const program = { file: join(process.env.FLOWCREW_VITEST_ROOT!, 'absent-executable'), prefixArgs: [] };
  const result = gitResultSync([], {}, program);
  expect(result.status).toBeNull(); expect(result.error).toMatchObject({ code: 'ENOENT' });
  expect(() => gitSync([], {}, program)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  try { gitSync([], {}, program); } catch (error) { expect(error).not.toBeInstanceOf(GitNotAnswered); }
  await expect(gitAsync([], {}, program)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps native Git execution in one owner, including exec aliases, namespaces, promisification and shell forms', () => {
  const root = new URL('../src/', import.meta.url).pathname;
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
  const bypasses: string[] = [];
  const native = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']);
  for (const file of files(root)) {
    if (file === join(root, 'git-facts.ts')) continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const aliases = new Set(native);
    const learn = (node: ts.Node) => {
      if (ts.isImportSpecifier(node) && native.has((node.propertyName ?? node.name).text)) aliases.add(node.name.text);
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name) && node.initializer) {
          const init = node.initializer;
          if (ts.isIdentifier(init) && aliases.has(init.text)
            || ts.isCallExpression(init) && init.arguments.some(arg => ts.isIdentifier(arg) && aliases.has(arg.text))) aliases.add(node.name.text);
        }
        if (ts.isObjectBindingPattern(node.name)) for (const binding of node.name.elements) {
          if (native.has((binding.propertyName ?? binding.name).getText(source)) && ts.isIdentifier(binding.name)) aliases.add(binding.name.text);
        }
      }
      ts.forEachChild(node, learn);
    };
    learn(source);
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(source);
        const command = node.arguments[0];
        if (aliases.has(name) && command && (
          ts.isStringLiteralLike(command) && /\bgit\b/.test(command.text)
          || ts.isPropertyAccessExpression(command) && command.name.text === 'command' && /cli-(land|ship-setup)\.ts$/.test(file)
        )) bypasses.push(`${file.slice(root.length)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  expect(bypasses).toEqual([]);
});

it.each([
  ['sync', 'answer'], ['sync', 'terminate'], ['async', 'answer'], ['async', 'terminate'],
] as const)('native %s Git stays held until explicit %s', async (shape, command) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  const program = {
    file: process.execPath,
    prefixArgs: ['-e', `
      const socket = require('node:net').connect(${port}, '127.0.0.1');
      socket.once('connect', () => socket.write(process.pid + '\\n'));
      socket.once('end', () => process.exit(0));
      socket.once('data', () => {
        process.stdout.write('fact'); socket.end();
      });
    `],
  };
  const childConnected = once(server, 'connection');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const owner = await import(workerData.moduleUrl);
      try {
        const value = workerData.shape === 'sync'
          ? owner.gitSync([], { encoding: 'utf8', env: workerData.env }, workerData.program)
          : await owner.gitAsync([], { env: workerData.env }, workerData.program);
        parentPort.postMessage({ value });
      } catch (error) {
        parentPort.postMessage({ typed: error instanceof owner.GitNotAnswered, code: error.code, signal: error.signal });
      }
    })();
  `, { eval: true, workerData: { moduleUrl, program, shape,
    env: { ...process.env, FC_HOME: process.env.FLOWCREW_VITEST_ROOT } } });
  let finished = false;
  const result = once(worker, 'message').then(([message]) => { finished = true; return message; });
  const exited = once(worker, 'exit');
  let socket: net.Socket | undefined;
  try {
    [socket] = await childConnected as [net.Socket];
    const ready = createInterface({ input: socket });
    const childPid = Number((await once(ready, 'line'))[0]); ready.close();
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
    vi.useFakeTimers();
    vi.advanceTimersByTime(10 ** 10);
    await Promise.resolve();
    expect(finished).toBe(false);
    if (command === 'terminate') process.kill(childPid, 'SIGTERM'); // Only this test's announced child.
    else socket.end(command);
    expect(await result).toEqual(command === 'answer'
      ? { value: 'fact' }
      : { typed: true, code: 'GIT_NOT_ANSWERED', signal: 'SIGTERM' });
    expect((await exited)[0]).toBe(0);
  } finally {
    socket?.destroy();
    await worker.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
