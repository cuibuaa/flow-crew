import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.js';
import type { AgentConfig } from '../src/adapters/base.js';

let root: string;
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });

it('CodexAdapter emits the request ledger before removing the successful native home', async () => {
  root = mkdtempSync(join(tmpdir(), 'fc-request-evidence-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  vi.stubEnv('PATH', bin);
  vi.stubEnv('CODEX_HOME', join(root, 'ambient'));
  vi.stubEnv('CODEX_PLUGINS_CACHE', join(root, 'no-plugins'));
  vi.stubEnv('CODEX_SKILLS_CACHE', join(root, 'no-skills'));
  const id = '11111111-1111-4111-8111-111111111111';
  const events = [
    { type: 'session_meta', payload: { base_instructions: { text: 'native instructions' } } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'task' }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 } } } },
  ];
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n` + `
const fs = require('node:fs'), path = require('node:path');
process.stdin.resume(); process.stdin.on('end', () => {
 const home = process.env.CODEX_HOME, dir = path.join(home, 'sessions', '2026', '11', '05');
 fs.mkdirSync(dir, { recursive: true });
 fs.writeFileSync(path.join(dir, 'rollout-fixture-${id}.jsonl'), ${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n'))});
 console.log(JSON.stringify({type:'thread.started',thread_id:'${id}'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:20,output_tokens:5}}));
});`, { mode: 0o700 });
  const record = vi.fn();
  const role: AgentConfig = { name: 'brief_writer', description: '', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'role' };
  const result = await new CodexAdapter().run('task', role, { workDir: root, runDir: join(root, 'run'),
    stageId: 'brief_writer', timeout_ms: 10000, onRequestEvidence: record });
  expect(result.exitCode).toBe(0);
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0][0]).toMatchObject({ source: 'codex_rollout', request_count: 1,
    requests: [{ input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 }] });
  expect(JSON.stringify(record.mock.calls[0][0])).toContain('native instructions');
  expect(existsSync(join(root, 'run', 'stages', 'brief_writer', 'codex_home'))).toBe(false);
});
