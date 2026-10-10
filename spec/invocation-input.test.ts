import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter, readCodexSession } from '../src/adapters/codex.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import type { AgentConfig } from '../src/adapters/base.js';
import { HANDOFF_SCHEMA } from '../src/handoff.js';
import { readRunStateView } from '../src/run-state-view.js';
import { recordStageOutcome } from '../src/run-events.js';
import { createRun, fcGlobalDir, readStageStatus, runDir, setFcGlobalDir } from '../src/store.js';
import { runStage } from '../src/worker.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const freshUUID = '22222222-2222-4222-8222-222222222222';
const keys = ['PATH', 'CODEX_HOME', 'CODEX_PLUGINS_CACHE', 'CODEX_SKILLS_CACHE', 'FC_INPUT_MODE'] as const;
let root: string, project: string, directory: string, runId: string, previousStore: string;
let previousEnvironment: Record<string, string | undefined>;
const role: AgentConfig = { name: 'coder', description: 'fixture', model: 'destination-model', reasoning_effort: 'high', tools: [], prompt: 'Exact system\r\n界🧪' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-invocation-input-'));
  previousEnvironment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  project = join(root, 'project');
  const bin = join(root, 'bin');
  for (const path of [project, bin, join(root, 'source'), join(root, 'plugins'), join(root, 'skills')]) mkdirSync(path);
  process.env.CODEX_HOME = join(root, 'source');
  process.env.CODEX_PLUGINS_CACHE = join(root, 'plugins');
  process.env.CODEX_SKILLS_CACHE = join(root, 'skills');
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  runId = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['owner', 'writer']).runId;
  directory = runDir(project, runId);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version')) { console.log('credential-free-codex 1.0'); process.exit(0); }
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const home = process.env.CODEX_HOME, config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  const countPath = path.join(home, 'call-count');
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) + 1 : 1;
  fs.writeFileSync(countPath, String(count));
  if (process.env.FC_INPUT_MODE === 'repair' && count === 1) {
    const owner = path.join(home, '..', '..', 'owner', 'codex_home');
    if (fs.existsSync(path.join(home, 'state_5.sqlite'))) throw Error('source index with absolute paths was copied');
    if (!fs.existsSync(path.join(home, 'sessions', 'closed.jsonl'))) throw Error('conversation lost');
    try { fs.writeFileSync(path.join(owner, 'witness'), 'leaked'); throw Error('source home writable'); }
    catch (error) { if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error; }
    process.stderr.write('Error: thread/resume: no rollout found for thread id (code -32600)\n');
    process.exit(1);
  }
  if (process.env.FC_INPUT_MODE === 'repair' && count === 2) {
    process.stderr.write('error: reasoning effort is not supported with tools for this model\n');
    process.exit(1);
  }
  if (!config.includes('destination-model')) throw Error('stage model lost');
  const id = process.argv.find(arg => /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(arg)) || '22222222-2222-4222-8222-222222222222';
  console.log(JSON.stringify({type:'thread.started',thread_id:id}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'delivered',summary:'fixture-ok',files_modified:[],checks:[],caveats:[]})}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}));
});
`, { mode: 0o755 });
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}\n` + String.raw`
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',is_error:false,result:JSON.stringify({status:'delivered',summary:'fixture-ok',files_modified:[],checks:[],caveats:[]})})));
`, { mode: 0o755 });
});

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

const options = () => ({ stageId: 'writer', role, dependsOn: [], promptTemplate: 'Exact user duties\n🌿', timeout_ms: 10_000, projectDir: project, runId, runDir: directory, retries: 0, outputSchema: HANDOFF_SCHEMA, artifactContract: { version: 1 as const, produces: [], reads: [], groups: [], replays: [] }, projectWriteScope: [] });
const view = () => readRunStateView(project, runId, { includePromptText: true, resourceRegistryPath: join(root, 'resources.json') });

describe('one recoverable record per native invocation', () => {
  it('publishes settled events synchronously without mutating the run after completion', async () => {
    const result = await runStage(new CodexAdapter(), options());
    expect(result.exitCode, result.output).toBe(0);
    recordStageOutcome(project, runId, 'writer', undefined, readStageStatus(project, runId, 'writer'));
    const eventsPath = join(directory, 'events.jsonl');
    const settledEvents = readFileSync(eventsPath, 'utf8');
    expect(settledEvents.split('\n').filter(Boolean).map(line => JSON.parse(line).type)).toContain('stage_complete');
    expect(view().stages.writer?.status).toBe('complete');
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(readFileSync(eventsPath, 'utf8')).toBe(settledEvents);
  });

  it('records all parameter repairs and fresh-session fallback while keeping the predecessor home private', async () => {
    const owner = join(directory, 'stages', 'owner', 'codex_home');
    mkdirSync(join(owner, 'sessions'), { recursive: true });
    writeFileSync(join(owner, 'config.toml'), 'model = "author-model"\n');
    writeFileSync(join(owner, 'state_5.sqlite'), 'closed state');
    writeFileSync(join(owner, 'sessions', 'closed.jsonl'), 'closed conversation\n');
    process.env.FC_INPUT_MODE = 'repair';
    const result = await runStage(new CodexAdapter(), { ...options(), resumeSessionId: UUID, sessionOwnerStageId: 'owner', preserveSession: true });
    expect(result.exitCode, result.output).toBe(0);
    const inputs = view().prompts.invocations;
    expect(inputs).toHaveLength(3);
    expect(inputs.every(entry => entry.integrity === 'verified' && entry.attemptBinding === 'matched' && entry.record?.boundary === 'model')).toBe(true);
    const transports = inputs.map(entry => JSON.parse(entry.record!.transport!.payload!));
    expect(transports[0].argv).toContain('resume');
    expect(transports[1].argv).not.toContain('resume');
    expect(transports[0].configToml).toContain('model_reasoning_effort = "high"');
    expect(transports[2].configToml).not.toContain('model_reasoning_effort');
    expect(transports[2].outputSchema).toBe(JSON.stringify(HANDOFF_SCHEMA));
    for (const [index, entry] of inputs.entries()) {
      expect(entry.record!.userPrompt).toBe(transports[index].stdin);
      const developerInstructions = transports[index].configToml.match(/^developer_instructions = (.+)$/m)[1];
      expect(entry.record!.systemPrompt).toBe(JSON.parse(developerInstructions));
      expect(entry.record!.model).toBe('destination-model');
    }
    expect(readFileSync(join(owner, 'config.toml'), 'utf8')).toBe('model = "author-model"\n');
    expect(existsSync(join(owner, 'witness'))).toBe(false);
    expect(readCodexSession(directory, 'writer')).toMatchObject({ ownerStageId: 'writer', sessionId: freshUUID });
  });

  it('keeps same-stage continuation and technical attempts in the stage home', async () => {
    const first = await runStage(new CodexAdapter(), { ...options(), preserveSession: true });
    expect(first.exitCode).toBe(0);
    const second = await runStage(new CodexAdapter(), { ...options(), retries: 1, resumeSessionId: freshUUID, sessionOwnerStageId: 'writer', preserveSession: true });
    expect(second.exitCode).toBe(0);
    const inputs = view().prompts.invocations;
    expect(inputs).toHaveLength(2);
    expect(inputs.every(entry => entry.integrity === 'verified' && entry.attemptBinding === 'matched')).toBe(true);
    expect(inputs.map(entry => entry.record!.attemptIndex)).toEqual([1, 2]);
    expect(inputs[1].record?.resumeSessionId).toBe(freshUUID);
    expect(readFileSync(join(directory, 'stages', 'writer', 'codex_home', 'call-count'), 'utf8')).toBe('2');
  });

  it('recovers an inherited model and exact generated config after the transient home is deleted', async () => {
    writeFileSync(join(root, 'source', 'config.toml'), 'model = "destination-model"\nmodel_reasoning_effort = "low"\n');
    const result = await runStage(new CodexAdapter(), { ...options(), role: { ...role, model: 'default', reasoning_effort: 'default' } });
    expect(result.exitCode, result.output).toBe(0);
    expect(existsSync(join(directory, 'stages', 'writer', 'codex_home'))).toBe(false);
    const record = view().prompts.invocations[0].record!, transport = JSON.parse(record.transport!.payload!);
    expect(record.model).toBe('destination-model');
    expect(transport.configToml).toContain('model = "destination-model"');
    expect(transport.configToml).toContain('model_reasoning_effort = "low"');
    expect(transport.outputSchema).toBe(JSON.stringify(HANDOFF_SCHEMA));
  });

  it('records one Claude transport with exact appended system and stdin bytes', async () => {
    const result = await runStage(new ClaudeAdapter(), options());
    expect(result.exitCode, result.output).toBe(0);
    const inputs = view().prompts.invocations;
    expect(inputs).toHaveLength(1);
    const record = inputs[0].record!, transport = JSON.parse(record.transport!.payload!);
    expect(record.boundary).toBe('model');
    expect(transport.stdin).toBe(record.userPrompt);
    expect(transport.appendedSystemPrompt).toBe(record.systemPrompt);
  });
});
