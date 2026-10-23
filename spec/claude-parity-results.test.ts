import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import type { AgentConfig, RunOpts } from '../src/adapters/base.js';
import { parseStreamJsonToText } from '../src/dashboard.js';

const role: AgentConfig = { name: 'fixture', description: '', model: 'haiku', reasoning_effort: 'low', tools: [], prompt: 'Stable duties\n界🧪' };
let root: string, oldPath: string | undefined;
const jsonl = (...events: object[]) => events.map(event => JSON.stringify(event)).join('\n');
const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const terminal = (result: string) => ({ type: 'result', subtype: 'success', result });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-native-parity-'));
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'project'));
  oldPath = process.env.PATH; process.env.PATH = `${join(root, 'bin')}:${oldPath ?? ''}`;
});
afterEach(() => { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); });

async function invoke(stdout: string, options: { stderr?: string; exit?: number; hang?: boolean; opts?: Partial<RunOpts>; role?: Partial<AgentConfig>; split?: boolean } = {}) {
  writeFileSync(join(root, 'bin', 'claude'), `#!${process.execPath}\n` + `
const fs=require('node:fs');
let stdin='';process.stdin.on('data',c=>stdin+=c);process.stdin.on('end',()=>{
 fs.writeFileSync(${JSON.stringify(join(root, 'capture.json'))},JSON.stringify({argv:process.argv.slice(2),stdin}));
 const text=${JSON.stringify(stdout)};
 const finish=()=>{process.stderr.write(${JSON.stringify(options.stderr ?? '')});${options.hang ? 'setInterval(()=>{},1000);' : `process.exitCode=${options.exit ?? 0};`}};
 ${options.split ? "process.stdout.write(text.slice(0,17));setTimeout(()=>{process.stdout.write(text.slice(17));finish()},20);" : 'process.stdout.write(text);finish();'}
});`, { mode: 0o755 });
  return new ClaudeAdapter().run('Tiny synthetic request', { ...role, ...options.role }, {
    workDir: join(root, 'project'), runDir: join(root, 'run'), stageId: 'fixture', timeout_ms: 10_000, ...options.opts,
  });
}
const capture = () => JSON.parse(readFileSync(join(root, 'capture.json'), 'utf8')) as { argv: string[]; stdin: string };

describe('Claude native result parity (zero provider tokens)', () => {
  it('G04 constrains compatible schemas and selects structured_output ahead of prose', async () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
    const result = await invoke(jsonl(assistant('Working...'), { ...terminal('prose'), structured_output: { answer: 'done' } }), { opts: { outputSchema: schema } });
    const args = capture().argv;
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1])).toEqual(schema);
    expect(readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')).toBe(role.prompt);
    expect(capture().stdin).toBe('Tiny synthetic request');
    expect(result.output).toBe('{"answer":"done"}');
  });

  it('G05 keeps timeout, cancellation and unrelated post-result process failures', async () => {
    const success = jsonl(terminal('done')) + '\n';
    expect(await invoke(success, { exit: 7 })).toMatchObject({ exitCode: 7, processExitCode: 7, output: 'done' });
    const timed = await invoke(success, { hang: true, opts: { timeout_ms: 200 } });
    expect(timed).toMatchObject({ exitCode: 124, timedOut: true });
    const abort = new AbortController();
    const invocation = invoke(success, { hang: true, opts: { abortSignal: abort.signal } });
    setTimeout(() => abort.abort(), 200);
    expect(await invocation).toMatchObject({ exitCode: 137 });
  });

  it('G05 recovers only its own hung-stdio SIGKILL and keeps the raw close facts', async () => {
    const result = await invoke(jsonl(terminal('done')) + '\n', { hang: true });
    expect(result).toMatchObject({ exitCode: 0, processExitCode: null, processSignal: 'SIGKILL', output: 'done' });
  }, 12_000);

  it.each([
    { type: 'result', is_error: true, errors: ['429 Too Many Requests', 'retry later'] },
    { type: 'error', error: '429 Too Many Requests' },
    { type: 'result', subtype: 'error_max_turns', result: '429 Too Many Requests' },
  ])('G06 interprets root and terminal error envelopes %j', async event => {
    const result = await invoke(jsonl(assistant('progress'), event));
    expect(result).toMatchObject({ exitCode: 1, providerFailure: { kind: 'transient' } });
    expect(result.output).toContain('429 Too Many Requests');
  });

  it('G06 uses the latest terminal outcome instead of latching the first', async () => {
    const recovered = await invoke(jsonl({ type: 'result', is_error: true, errors: ['429 Too Many Requests'] }, terminal('done')));
    expect(recovered).toMatchObject({ exitCode: 0, output: 'done' });
    expect(recovered.providerFailure).toBeUndefined();
    expect(await invoke(jsonl(terminal('done'), { type: 'result', subtype: 'error_max_turns' }))).toMatchObject({ exitCode: 1, output: 'done\nerror_max_turns' });
  });

  it('G06 retains explicit native failure even when its diagnostic is absent', async () => {
    for (const event of [{ type: 'result', is_error: true }, { type: 'error' }]) {
      const result = await invoke(jsonl(event));
      expect(result).toMatchObject({ exitCode: 1, output: event.type, friendlyError: event.type });
      expect(result.providerFailure).toBeUndefined();
    }
  });

  it.each([
    '429 Too Many Requests', 'overloaded', '403 Forbidden', 'ECONNRESET',
  ])('G07-G08 retain post-progress stderr diagnostics: %s', async stderr => {
    const result = await invoke(jsonl(assistant('progress')), { stderr, exit: 1 });
    expect(result).toMatchObject({ exitCode: 1, providerFailure: { kind: 'transient' }, output: `progress\n${stderr}` });
    expect(result).not.toHaveProperty('stderr');
  });

  it('G08 appends native diagnostics after progress', async () => {
    expect(await invoke(jsonl(assistant('progress'), { type: 'error', message: '502 Bad Gateway' }), { exit: 1 })).toMatchObject({ output: 'progress\n502 Bad Gateway', providerFailure: { kind: 'transient' } });
  });

  it('G09 returns only the last assistant message and never tool-only JSON', async () => {
    expect((await invoke(jsonl(assistant('progress'), assistant('{"answer":"done"}'), { ...assistant('child prose'), parent_tool_use_id: 'delegate' }))).output).toBe('{"answer":"done"}');
    expect((await invoke(jsonl({ type: 'system', subtype: 'init' }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'internal evidence' }] } }))).output).toBe('');
  });

  it('G09 reconstructs deltas without duplicating their final assistant message', async () => {
    const result = await invoke(jsonl({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'done' } } }, assistant('done')));
    expect(result.output).toBe('done');
  });

  it('G12 repairs native rejected pins, accounts for every call and remembers effort across invocations', async () => {
    const history = join(root, 'history.jsonl');
    writeFileSync(join(root, 'bin', 'claude'), `#!${process.execPath}\n` + `
const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{
 const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(history)},JSON.stringify(args)+'\\n');
 const parameter=args.includes('--effort')?'effort':args.includes('--model')?'model':undefined;
 console.log(JSON.stringify(parameter?{type:'result',is_error:true,error:{param:parameter,message:'rejected parameter'},usage:{input_tokens:1,output_tokens:0}}:{type:'result',subtype:'success',result:'done',usage:{input_tokens:2,output_tokens:1}}));
});`, { mode: 0o755 });
    const adapter = new ClaudeAdapter();
    const opts = { workDir: join(root, 'project'), runDir: join(root, 'run'), stageId: 'fixture', timeout_ms: 10_000 };
    const result = await adapter.run('tiny', role, opts);
    expect(result).toMatchObject({ exitCode: 0, output: 'done', tokens_in: 4, tokens_out: 1, tokenUsage: 'partial' });
    expect(result.invocations).toHaveLength(3);
    await adapter.run('tiny', role, { ...opts, stageId: 'next' });
    const calls: string[][] = readFileSync(history, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(5);
    expect(calls[0]).toContain('--effort');
    expect(calls[1]).not.toContain('--effort');
    expect(calls[2]).not.toContain('--model');
    expect(calls[3]).not.toContain('--effort');
    const previousProvider = process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDE_CODE_USE_BEDROCK = 'synthetic-provider-change';
    try { await adapter.run('tiny', role, { ...opts, stageId: 'changed-provider' }); }
    finally { if (previousProvider === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK; else process.env.CLAUDE_CODE_USE_BEDROCK = previousProvider; }
    const changedCalls: string[][] = readFileSync(history, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(changedCalls).toHaveLength(8);
    expect(changedCalls[5]).toContain('--effort');
  });

  it('G15 isolates settings and nesting in the actual adapter while retaining native auth routing', async () => {
    const previous = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT };
    process.env.CLAUDECODE = 'synthetic-nesting'; process.env.CLAUDE_CODE_ENTRYPOINT = 'synthetic-entry';
    try {
      let transport: any;
      await invoke(jsonl(terminal('done')), { opts: { onInvocationInput: input => { transport = JSON.parse(input.transport!.payload); } } });
      expect(transport.argv).toContain('--safe-mode');
      expect(transport.argv[transport.argv.indexOf('--setting-sources') + 1]).toBe('');
      expect(transport.argv).toContain('--strict-mcp-config');
      // The fake executable inspects only these synthetic nesting markers.
      writeFileSync(join(root, 'bin', 'claude'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',result:JSON.stringify({nested:process.env.CLAUDECODE,entry:process.env.CLAUDE_CODE_ENTRYPOINT})}))});`, { mode: 0o755 });
      const result = await new ClaudeAdapter().run('tiny', role, { workDir: join(root, 'project'), runDir: join(root, 'run'), stageId: 'environment', timeout_ms: 10_000 });
      expect(JSON.parse(result.output)).toEqual({});
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  it('G16 attributes completed writes, excluding intent, errors and outside paths', async () => {
    const tool = (id: string, name: string, file_path: string) => ({ type: 'tool_use', id, name, input: { file_path } });
    const result = await invoke(jsonl({ type: 'assistant', message: { content: [tool('write', 'Write', join(root, 'project', 'new.ts')), tool('edit', 'Edit', 'existing.ts'), tool('failed', 'Edit', 'failed.ts'), tool('intent', 'Write', 'intent.ts'), tool('outside', 'Write', '../outside.ts')] } },
      { type: 'assistant', parent_tool_use_id: 'delegate', message: { content: [tool('nested', 'Write', 'nested.ts')] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nested' }, { type: 'tool_result', tool_use_id: 'write' }, { type: 'tool_result', tool_use_id: 'edit' }, { type: 'tool_result', tool_use_id: 'failed', is_error: true }, { type: 'tool_result', tool_use_id: 'outside' }] } }, terminal('done')));
    expect(result).toMatchObject({ writes: ['existing.ts', 'nested.ts', 'new.ts'], writeAttribution: 'structured' });
  });

  it('G17 enables read-only inspection for empty tools and preserves nonempty shared semantics', async () => {
    await invoke(jsonl(terminal('done')));
    const args = capture().argv;
    expect(args).toContain('--restricted'); expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
    await invoke(jsonl(terminal('done')), { role: { tools: ['Read'] } });
    expect(capture().argv).toContain('--dangerously-skip-permissions'); expect(capture().argv).not.toContain('--tools');
  });

  it('G21 flushes split, unterminated command completion before tracker closure', async () => {
    const events: Array<{ phase: string; id: string }> = [];
    await invoke(jsonl({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'cmd', name: 'Bash', input: { command: 'timeout 3 true' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'cmd' }] } }), {
      split: true, opts: { attemptIndex: 1, attemptStartedAt: '2026-01-01T00:00:00.000Z', onCommandLifecycle: event => events.push(event) },
    });
    expect(events.map(({ phase, id }) => ({ phase, id }))).toEqual([{ phase: 'started', id: 'cmd' }, { phase: 'completed', id: 'cmd' }]);
    expect(JSON.parse(readFileSync(join(root, 'run', 'stages', 'fixture', 'command_activity.json'), 'utf8'))).toMatchObject({ completedCount: 1, streamClosed: true });
  });

  it('G22 presents one stream without repeated terminal text, including tools and trailing results', async () => {
    const raw = jsonl(assistant('done'), { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'file.ts' } }] } }, terminal('done'));
    await invoke(raw);
    expect(existsSync(join(root, 'run', 'stages', 'fixture', 'live.log.txt'))).toBe(false);
    const state = { lineBuf: '' };
    const visible = parseStreamJsonToText(raw.slice(0, 17), state) + parseStreamJsonToText(raw.slice(17), state) + parseStreamJsonToText('', state, true);
    expect(visible.match(/done/g)).toHaveLength(1); expect(visible).toContain('[Read] file.ts');
    const codex = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'unchanged' } }) + '\n';
    expect(parseStreamJsonToText(codex)).toBe(codex);
  });
});
