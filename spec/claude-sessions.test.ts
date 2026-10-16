import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeInvocation, ClaudeAdapter } from '../src/adapters/claude.js';
import type { AgentConfig, RunOpts } from '../src/adapters/base.js';
import { prepareAdapterHome } from '../src/adapter-home.js';
import { readSession, stageSessionHome, writeSession } from '../src/adapter-session.js';
import {
  clearGateContinuationsForStages, gateContinuationSessionForStage, gateVerdictCorrectionPath,
  sessionResumeForStage, shouldPreserveSession,
} from '../src/scheduler/sched_admission/sessions.js';
import { StageConfigSchema, type StageConfig } from '../src/scheduler.js';
import { createRun, fcGlobalDir, setFcGlobalDir, type StageStatus, type StoreState } from '../src/store.js';
import { clearAttemptSummaryRefreshDebounce } from '../src/run-events.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';
const DUTIES = 'Complete the synthetic session fixture duties.';
const role: AgentConfig = {
  name: 'coder', description: 'offline session fixture', model: 'default', reasoning_effort: 'default',
  tools: [], prompt: 'Exact appended system\r\n界🧪', adapter: 'claude',
};
type Input = Parameters<NonNullable<RunOpts['onInvocationInput']>>[0];
interface Call { argv: string[]; stdin: string; home?: string; secureSource?: string; hadHistory: boolean }
let root: string, project: string, directory: string, previousStore: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-claude-sessions-'));
  project = join(root, 'project');
  const bin = join(root, 'bin');
  for (const dir of [project, bin, join(root, 'ambient')]) mkdirSync(dir);
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  ({ runDirPath: directory } = createRun(project, 'session-fixture', 'name: session-fixture\nstages: []\n', ['work', 'author', 'review', 'repair', 'next']));
  writeFileSync(join(directory, 'task_brief.md'), DUTIES);
  vi.stubEnv('PATH', bin);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'ambient'));
  vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', join(root, 'secure-source'));
  scenario({});
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), path = require('node:path');
const root = path.dirname(__dirname), fixture = JSON.parse(fs.readFileSync(path.join(root, 'scenario.json'), 'utf8'));
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const argv = process.argv.slice(2), home = process.env.CLAUDE_CONFIG_DIR;
  const log = path.join(root, 'calls.jsonl');
  const history = path.join(home ?? path.join(process.env.HOME, '.claude'), 'projects', 'fixture', 'conversation.jsonl');
  fs.appendFileSync(log, JSON.stringify({ argv, stdin: input, home, secureSource:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, hadHistory: fs.existsSync(history) }) + '\n');
  const resumed = argv.includes('--resume');
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  const counters = fixture.usage ? {usage:resumed
    ? {input_tokens:2,output_tokens:1,cache_read_input_tokens:3,cache_creation_input_tokens:4}
    : {input_tokens:5,output_tokens:6,cache_read_input_tokens:7,cache_creation_input_tokens:8},total_cost_usd:resumed ? 0.001 : 0.002,
    ...(fixture.sessionCumulative ? {modelUsage:{'claude-fixture-resolved':{inputTokens:23,outputTokens:45,cacheReadInputTokens:67,cacheCreationInputTokens:89}}} : {})} : {};
  if (fixture.rejectPins || fixture.rejectEffort) {
    const parameter = argv.includes('--effort') ? 'effort' : fixture.rejectPins && argv.includes('--model') ? 'model' : undefined;
    if (parameter) {
      emit({type:'system',subtype:'init',session_id:resumed ? argv[argv.indexOf('--resume') + 1] : '11111111-1111-4111-8111-111111111111'});
      emit({type:'result',is_error:true,error:{param:parameter,message:'synthetic rejected parameter'},...counters}); process.exit(1);
    }
  }
  if (fixture.failResume && resumed) { emit({type:'result',is_error:true,result:'synthetic unavailable session',...counters}); process.exit(1); }
  if (fixture.failAll) { emit({type:'result',is_error:true,result:'synthetic unavailable session'}); process.exit(1); }
  if (fixture.control && resumed) {
    if (fixture.controlIdentity) emit({type:'system',subtype:'init',session_id:fixture.controlIdentity});
    if (fixture.controlRejection) emit({type:'result',is_error:true,error:{param:fixture.controlRejection,message:'synthetic rejected parameter'}});
    if (fixture.control === 'timeout') { setInterval(() => {}, 1000); return; }
    process.exit(fixture.control);
  }
  const sessionId = fixture.nativeId ?? (resumed ? argv[argv.indexOf('--resume') + 1] : '11111111-1111-4111-8111-111111111111');
  fs.mkdirSync(path.dirname(history), {recursive:true}); fs.appendFileSync(history, input + '\n');
  if (fixture.sessionField !== 'result') emit({type:'system',subtype:'init',session_id:sessionId,...(fixture.model === null ? {} : {model:fixture.model ?? 'claude-fixture-resolved'})});
  if (fixture.nativeFailure) { emit({type:'result',is_error:true,result:'synthetic failure',session_id:sessionId}); process.exit(1); }
  const result = JSON.stringify({status:'delivered',summary:'fixture-ok',files_modified:[],checks:[],caveats:[]});
  emit({type:'result',subtype:'success',is_error:false,result,...(fixture.sessionField === 'init' ? {} : {session_id:sessionId}),...counters});
});
`, { mode: 0o755 });
});

afterEach(() => {
  clearAttemptSummaryRefreshDebounce();
  setFcGlobalDir(previousStore);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function scenario(value: object): void { writeFileSync(join(root, 'scenario.json'), JSON.stringify(value)); }
function calls(): Call[] {
  const path = join(root, 'calls.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
function options(extra: Partial<RunOpts> = {}): RunOpts {
  return { stageId: 'work', workDir: project, runDir: directory, timeout_ms: 10_000, ...extra };
}
function stage(id: string, extra: Partial<StageConfig> = {}): StageConfig {
  return StageConfigSchema.parse({ id, role: 'coder', adapter: 'claude', scope: [`${id}.ts`], ...extra });
}
function successfulStatus(extra: Partial<StageStatus> = {}): StageStatus {
  return { status: 'complete', retries: 0, reruns: 0,
    attempts: [{ index: 1, startedAt: '2026-01-01T00:00:00Z', status: 'complete', exitCode: 0 }], ...extra };
}
async function seed(stageId: string): Promise<void> {
  const result = await new ClaudeAdapter().run(DUTIES, role, options({ stageId, preserveSession: true }));
  expect(result).toMatchObject({ exitCode: 0, sessionId: UUID });
}

describe('G01: Claude explicit native identity and bounded fresh fallback', () => {
  it.each(['init', 'result'])('captures UUID from %s, persists ownership, and resumes only that UUID', async sessionField => {
    scenario({ sessionField });
    await seed('author');
    const inputs: Input[] = [];
    const result = await new ClaudeAdapter().run('Synthetic correction only.\r\n🌿', role, options({
      resumeSessionId: UUID, sessionOwnerStageId: 'author', preserveSession: true,
      onInvocationInput: input => inputs.push(input),
    }));
    expect(result).toMatchObject({ exitCode: 0, sessionId: UUID });
    const call = calls()[1];
    expect(call.argv.slice(call.argv.indexOf('--resume'), call.argv.indexOf('--resume') + 2)).toEqual(['--resume', UUID]);
    expect(call.argv).not.toContain('--continue');
    expect(call.stdin).toBe('Synthetic correction only.\r\n🌿');
    expect(call.home).toBe(join(root, 'ambient'));
    expect(call.hadHistory).toBe(true);
    expect(readSession(directory, 'work', 'claude')).toMatchObject({
      version: 1, adapter: 'claude', sessionId: UUID, ownerStageId: 'work', resumedFromStageId: 'author',
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].resumeSessionId).toBe(UUID);
  });

  it('rejects a malformed requested UUID before spawning', async () => {
    await expect(new ClaudeAdapter().run(DUTIES, role, options({ resumeSessionId: 'latest' }))).rejects.toThrow(/UUID/);
    expect(calls()).toHaveLength(0);
  });

  it.each([true, false])('resumes with isolated flags, native schema and ambient authentication routing (explicit=%s)', async explicit => {
    if (!explicit) vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', undefined);
    await seed('author');
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
    const correction = 'Synthetic correction only.\r\n🌿';
    const result = await new ClaudeAdapter().run(correction, role, options({
      resumeSessionId: UUID, sessionOwnerStageId: 'author', preserveSession: true, outputSchema: schema,
    }));
    expect(result).toMatchObject({ exitCode: 0, sessionId: UUID });
    const call = calls()[1];
    expect(call.argv.slice(call.argv.indexOf('--resume'), call.argv.indexOf('--resume') + 2)).toEqual(['--resume', UUID]);
    expect(call.argv).toContain('--safe-mode');
    expect(call.argv).toContain('--setting-sources');
    expect(call.argv[call.argv.indexOf('--setting-sources') + 1]).toBe('');
    expect(call.argv).toContain('--strict-mcp-config');
    expect(JSON.parse(call.argv[call.argv.indexOf('--json-schema') + 1])).toEqual(schema);
    expect(call.home).toBe(join(root, 'ambient'));
    expect(call.secureSource).toBe(explicit ? join(root, 'secure-source') : undefined);
    expect(call.hadHistory).toBe(true);
    expect(call.stdin).toBe(correction);
  });

  it('leaves unset config and secure-storage routing unset for the operator default', async () => {
    vi.stubEnv('HOME', join(root, 'operator-home'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', undefined);
    const result = await new ClaudeAdapter().run(DUTIES, role, options());
    expect(result.exitCode).toBe(0);
    expect(calls()[0]).not.toHaveProperty('home');
    expect(calls()[0]).not.toHaveProperty('secureSource');
    expect(existsSync(stageSessionHome(directory, 'work', 'claude'))).toBe(false);
    expect(existsSync(join(root, 'operator-home', '.claude', 'projects', 'fixture', 'conversation.jsonl'))).toBe(true);
  });

  it('rejects a resumed native identity mismatch without persisting or retrying it', async () => {
    scenario({ nativeId: OTHER_UUID });
    const result = await new ClaudeAdapter().run('Synthetic correction.', role, options({ resumeSessionId: UUID, preserveSession: true }));
    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBeUndefined();
    expect(readSession(directory, 'work', 'claude')).toBeUndefined();
    expect(calls()).toHaveLength(1);
  });

  it('falls back once to complete fresh duties when a failed resume produces no native identity', async () => {
    scenario({ failResume: true, usage: true });
    const inputs: Input[] = [];
    const fresh = 'Complete synthetic duties with current correction and guidance.';
    const result = await new ClaudeAdapter().run('Correction only.', role, options({
      resumeSessionId: OTHER_UUID, sessionOwnerStageId: 'author', freshSessionPrompt: fresh,
      preserveSession: true, onInvocationInput: input => inputs.push(input),
    }));
    expect(result).toMatchObject({ exitCode: 0, sessionId: UUID });
    expect(result).toMatchObject({ tokens_in: 29, tokens_out: 7, tokens_cached: 10, tokens_cache_created: 12, tokenUsage: 'partial' });
    expect(result.cost_usd).toBe(0.002);
    expect(result.invocations).toHaveLength(2);
    expect(result.invocations?.[0]).toMatchObject({ exitCode: 1, source: 'native_stdout', tokens_in: 9, tokens_out: 1, tokens_cached: 3, tokens_cache_created: 4, tokenUsage: 'partial' });
    expect(result.invocations?.[0].cost_usd).toBeUndefined();
    expect(result.invocations?.[0].sessionId).toBeUndefined();
    expect(result.invocations?.[1]).toMatchObject({ exitCode: 0, sessionId: UUID, source: 'native_stdout', tokens_in: 20, tokens_out: 6, tokens_cached: 7, tokens_cache_created: 8, cost_usd: 0.002, tokenUsage: 'known' });
    expect(calls().map(call => call.stdin)).toEqual(['Correction only.', fresh]);
    expect(calls()[0].argv).toContain('--resume');
    expect(calls()[1].argv).not.toContain('--resume');
    expect(inputs.map(input => input.resumeSessionId)).toEqual([OTHER_UUID, undefined]);
    expect(inputs.map(input => input.userPrompt)).toEqual(['Correction only.', fresh]);
    expect(readSession(directory, 'work', 'claude')).toMatchObject({ ownerStageId: 'work', sessionId: UUID });
    expect(readSession(directory, 'work', 'claude')?.resumedFromStageId).toBeUndefined();
  });

  it('counts resumed interval usage without re-counting session-cumulative model usage or cost', async () => {
    await seed('author');
    scenario({ usage: true, sessionCumulative: true });
    const result = await new ClaudeAdapter().run('Synthetic correction.', role, options({
      resumeSessionId: UUID, sessionOwnerStageId: 'author', preserveSession: true,
    }));
    expect(result).toMatchObject({ exitCode: 0, sessionId: UUID, tokens_in: 9, tokens_out: 1,
      tokens_cached: 3, tokens_cache_created: 4, tokenUsage: 'known' });
    expect(result.cost_usd).toBeUndefined();
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations?.[0]).toMatchObject({ exitCode: 0, sessionId: UUID, source: 'native_stdout',
      tokens_in: 9, tokens_out: 1, tokens_cached: 3, tokens_cache_created: 4, tokenUsage: 'known' });
    expect(result.invocations?.[0].cost_usd).toBeUndefined();
    expect(result.invocations?.[0].models).toBeUndefined();
  });

  it('repairs rejected effort and model while retaining explicit resume and correction bytes', async () => {
    await seed('author');
    scenario({ rejectPins: true, usage: true });
    const correction = 'Synthetic correction only.\r\n🌿';
    const inputs: Input[] = [];
    const result = await new ClaudeAdapter().run(correction, { ...role, model: 'fixture-pin', reasoning_effort: 'low' }, options({
      resumeSessionId: UUID, sessionOwnerStageId: 'author', freshSessionPrompt: DUTIES,
      preserveSession: true, onInvocationInput: input => inputs.push(input),
    }));
    expect(result).toMatchObject({ exitCode: 0, sessionId: UUID });
    const resumedCalls = calls().slice(1);
    expect(resumedCalls).toHaveLength(3);
    expect(resumedCalls[0].argv).toContain('--effort');
    expect(resumedCalls[1].argv).not.toContain('--effort');
    expect(resumedCalls[1].argv).toContain('--model');
    expect(resumedCalls[2].argv).not.toContain('--effort');
    expect(resumedCalls[2].argv).not.toContain('--model');
    for (const call of resumedCalls) {
      expect(call.argv.slice(call.argv.indexOf('--resume'), call.argv.indexOf('--resume') + 2)).toEqual(['--resume', UUID]);
      expect(call.stdin).toBe(correction);
      expect(call.home).toBe(join(root, 'ambient'));
      expect(call.hadHistory).toBe(true);
      expect(call.argv).toContain('--safe-mode');
      expect(call.argv[call.argv.indexOf('--setting-sources') + 1]).toBe('');
      expect(call.argv).toContain('--strict-mcp-config');
    }
    expect(inputs).toHaveLength(3);
    expect(inputs.map(input => input.resumeSessionId)).toEqual([UUID, UUID, UUID]);
    expect(inputs.map(input => input.userPrompt)).toEqual([correction, correction, correction]);
    expect(result.invocations?.map(invocation => invocation.exitCode)).toEqual([1, 1, 0]);
    expect(readSession(directory, 'work', 'claude')).toMatchObject({ sessionId: UUID, resumedFromStageId: 'author' });
  });

  it('does not loop when the fresh fallback fails too', async () => {
    scenario({ failAll: true });
    const result = await new ClaudeAdapter().run('Correction only.', role, options({ resumeSessionId: UUID, freshSessionPrompt: DUTIES }));
    expect(result.exitCode).toBe(1);
    expect(calls()).toHaveLength(2);
    expect(readSession(directory, 'work', 'claude')).toBeUndefined();
  });

  it('does not fall back for an attested native session failure', async () => {
    scenario({ nativeFailure: true });
    const result = await new ClaudeAdapter().run(DUTIES, role, options({ resumeSessionId: UUID }));
    expect(result).toMatchObject({ exitCode: 1, sessionId: UUID });
    expect(calls()).toHaveLength(1);
  });

  it.each([125, 137, 'timeout'])('does not fall back across control exit %s', async control => {
    scenario({ control });
    const result = await new ClaudeAdapter().run(DUTIES, role, options({ resumeSessionId: UUID, timeout_ms: control === 'timeout' ? 300 : 10_000 }));
    expect(result.exitCode).toBe(control === 'timeout' ? 124 : control);
    expect(calls()).toHaveLength(1);
  });

  it.each([125, 137, 'timeout'])('preserves control exit %s despite a mismatched native identity', async control => {
    scenario({ control, controlIdentity: OTHER_UUID });
    const result = await new ClaudeAdapter().run('Synthetic correction.', role, options({
      resumeSessionId: UUID, freshSessionPrompt: DUTIES, preserveSession: true,
      timeout_ms: control === 'timeout' ? 300 : 10_000,
    }));
    expect(result.exitCode).toBe(control === 'timeout' ? 124 : control);
    expect(result.sessionId).toBeUndefined();
    expect(calls()).toHaveLength(1);
    expect(readSession(directory, 'work', 'claude')).toBeUndefined();
  });

  it('does not repair or fall back when a parameter rejection accompanies control exit 125', async () => {
    scenario({ control: 125, controlRejection: 'effort' });
    const result = await new ClaudeAdapter().run('Synthetic correction.', { ...role, reasoning_effort: 'low' }, options({
      resumeSessionId: UUID, freshSessionPrompt: DUTIES, preserveSession: true,
    }));
    expect(result.exitCode).toBe(125);
    expect(calls()).toHaveLength(1);
  });
});

describe('G14: resolved model and exact invocation input', () => {
  it('propagates invocation recording failure rather than silently completing without an honest record', async () => {
    const recordingFailure = new Error('Synthetic invocation recording failure.');
    await expect(new ClaudeAdapter().run(DUTIES, role, options({
      onInvocationInput: () => { throw recordingFailure; },
    }))).rejects.toBe(recordingFailure);
    expect(calls()).toHaveLength(1);
  });

  it.each([
    { model: 'claude-fixture-resolved', roleModel: 'default', expected: 'claude-fixture-resolved' },
    { model: 'claude-fixture-resolved', roleModel: 'fixture-alias', expected: 'claude-fixture-resolved' },
    { model: null, roleModel: 'default', expected: 'provider-default-unresolved' },
    { model: null, roleModel: 'fixture-pin', expected: 'fixture-pin' },
  ])('records model $expected and the delivered bytes once', async ({ model, roleModel, expected }) => {
    scenario({ model });
    const inputs: Input[] = [];
    const prompt = 'Exact user bytes\r\n🌿';
    const result = await new ClaudeAdapter().run(prompt, { ...role, model: roleModel }, options({
      resumeSessionId: UUID, preserveSession: true, onInvocationInput: input => inputs.push(input),
    }));
    expect(result.exitCode).toBe(0);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ model: expected, resumeSessionId: UUID, userPrompt: prompt, systemPrompt: role.prompt });
    const transport = JSON.parse(inputs[0].transport!.payload);
    expect(transport).toMatchObject({ executable: 'claude', stdin: prompt, appendedSystemPrompt: role.prompt });
    expect(transport.argv).toEqual(calls()[0].argv);
    expect(transport.argv).not.toContain(prompt);
    expect(readFileSync(transport.argv[transport.argv.indexOf('--append-system-prompt-file') + 1], 'utf8')).toBe(role.prompt);
  });
});

describe('Claude user settings inheritance', () => {
  const settings = (value: unknown) => writeFileSync(join(root, 'ambient', 'settings.json'), JSON.stringify(value));
  const flags = (agent: AgentConfig = role) => buildClaudeInvocation(agent, {}, 'system.md').args;

  it('inherits alias model and effort with settings isolation intact', async () => {
    settings({ model: 'opus', effortLevel: 'xhigh', hooks: { unused: 'must stay isolated' }, permissions: { defaultMode: 'bypassPermissions' } });
    const inputs: Input[] = [];
    const result = await new ClaudeAdapter().run(DUTIES, role, options({ onInvocationInput: input => inputs.push(input) }));
    expect(result.exitCode).toBe(0);
    const argv = calls()[0].argv;
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
    expect(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2)).toEqual(['--effort', 'xhigh']);
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('');
    expect(argv).toContain('--strict-mcp-config');
    const transport = JSON.parse(inputs[0].transport!.payload);
    expect(transport).toMatchObject({
      argv,
      model: { value: 'opus', source: 'user-settings' },
      effort: { value: 'xhigh', source: 'user-settings' },
    });
    expect(inputs[0].model).toBe('claude-fixture-resolved');
    expect(inputs[0].transport!.payload).not.toContain('must stay isolated');
    expect(inputs[0].transport!.payload).not.toContain('bypassPermissions');
  });

  it.each([
    { model: 'haiku', reasoning_effort: 'low', expectedModel: 'haiku', expectedEffort: 'low' },
    { model: 'haiku', reasoning_effort: 'default', expectedModel: 'haiku', expectedEffort: 'high' },
    { model: 'default', reasoning_effort: 'low', expectedModel: 'opus', expectedEffort: 'low' },
    { model: 'default', reasoning_effort: 'default', expectedModel: 'opus', expectedEffort: 'xhigh' },
  ])('resolves model=$model and effort=$reasoning_effort independently', async ({ model, reasoning_effort, expectedModel, expectedEffort }) => {
    settings({ model: 'opus', effortLevel: 'medium', modelSettings: { opus: { effortLevel: 'xhigh' }, haiku: { effortLevel: 'high' } } });
    scenario({ model: null });
    const inputs: Input[] = [];
    await new ClaudeAdapter().run(DUTIES, { ...role, model, reasoning_effort }, options({ onInvocationInput: input => inputs.push(input) }));
    const transport = JSON.parse(inputs[0].transport!.payload);
    expect(transport.model).toEqual({ value: expectedModel, source: model === 'default' ? 'user-settings' : 'role' });
    expect(transport.effort).toEqual({ value: expectedEffort, source: reasoning_effort === 'default' ? 'user-settings' : 'role' });
    expect(transport.argv[transport.argv.indexOf('--model') + 1]).toBe(expectedModel);
    expect(transport.argv[transport.argv.indexOf('--effort') + 1]).toBe(expectedEffort);
    expect(inputs[0].model).toBe(expectedModel);
  });

  it('uses a canonical per-model effort ahead of top-level effort for the selected model', () => {
    settings({ model: 'claude-fixture-model', effortLevel: 'medium', modelSettings: {
      'claude-fixture-model': { effortLevel: 'xhigh' }, 'unrelated-model': { effortLevel: 'low' },
    } });
    expect(flags()).toContain('xhigh');
    expect(flags({ ...role, model: 'unrelated-model' })).toContain('low');
    expect(flags({ ...role, model: 'other-model' })).toContain('medium');
  });

  it('inherits per-model effort without a top-level effort', () => {
    settings({ model: 'opus', modelSettings: { opus: { effortLevel: 'high' } } });
    expect(flags()).toContain('high');
  });

  it.each([undefined, 'default'])('inherits absent or default role values (%s)', value => {
    settings({ model: 'opus', effortLevel: 'high' });
    const argv = flags({ ...role, model: value, reasoning_effort: value });
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high');
  });

  it.each(['missing-file', 'missing-keys', 'invalid-json', 'null', 'array', 'invalid-values', 'unreadable-file'])('falls back to CLI defaults for %s', async fixture => {
    const path = join(root, 'ambient', 'settings.json');
    if (fixture === 'missing-keys') settings({ modelSettings: { opus: { effortLevel: 'high' } } });
    if (fixture === 'invalid-json') writeFileSync(path, '{');
    if (fixture === 'null') settings(null);
    if (fixture === 'array') settings([]);
    if (fixture === 'invalid-values') settings({ model: 7, effortLevel: false, modelSettings: null });
    if (fixture === 'unreadable-file') mkdirSync(path);
    scenario({ model: null });
    const inputs: Input[] = [];
    const result = await new ClaudeAdapter().run(DUTIES, role, options({ onInvocationInput: input => inputs.push(input) }));
    expect(result.exitCode).toBe(0);
    const transport = JSON.parse(inputs[0].transport!.payload);
    expect(transport.argv).not.toContain('--model');
    expect(transport.argv).not.toContain('--effort');
    expect(transport.model).toEqual({ value: null, source: 'cli-default' });
    expect(transport.effort).toEqual({ value: null, source: 'cli-default' });
    expect(inputs[0].model).toBe('provider-default-unresolved');
  });

  it.each([
    { config: { model: 'opus' }, model: 'opus', effort: undefined },
    { config: { effortLevel: 'high' }, model: undefined, effort: 'high' },
    { config: { model: 'opus', effortLevel: 'high', modelSettings: { opus: null } }, model: 'opus', effort: 'high' },
    { config: { model: 'opus', effortLevel: 'high', modelSettings: { opus: { effortLevel: 3 } } }, model: 'opus', effort: 'high' },
    { config: { model: '', effortLevel: ' ' }, model: undefined, effort: undefined },
  ])('handles partial and invalid settings independently: $config', ({ config, model, effort }) => {
    settings(config);
    const argv = flags();
    expect(argv.includes('--model')).toBe(model !== undefined);
    expect(argv.includes('--effort')).toBe(effort !== undefined);
    if (model) expect(argv[argv.indexOf('--model') + 1]).toBe(model);
    if (effort) expect(argv[argv.indexOf('--effort') + 1]).toBe(effort);
  });

  it('uses the isolated home settings only when CLAUDE_CONFIG_DIR is unset', () => {
    const home = join(root, 'operator-home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku', effortLevel: 'low' }));
    vi.stubEnv('HOME', home);
    settings({ model: 'opus', effortLevel: 'high' });
    expect(flags()).toContain('opus');
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'missing-config'));
    expect(flags()).not.toContain('--model');
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    expect(flags()).toContain('haiku');
    expect(flags()).toContain('low');
  });

  it('reads changed settings on every call of the same adapter', async () => {
    const adapter = new ClaudeAdapter();
    const inputs: Input[] = [];
    for (const [model, effortLevel] of [['opus', 'high'], ['haiku', 'low']]) {
      settings({ model, effortLevel });
      expect((await adapter.run(DUTIES, role, options({ onInvocationInput: input => inputs.push(input) }))).exitCode).toBe(0);
    }
    expect(inputs.map(input => JSON.parse(input.transport!.payload).model.value)).toEqual(['opus', 'haiku']);
    expect(inputs.map(input => JSON.parse(input.transport!.payload).effort.value)).toEqual(['high', 'low']);
  });

  it('reads changed user settings again for a fresh-session retry', async () => {
    settings({ model: 'opus', effortLevel: 'high' });
    scenario({ failResume: true });
    const inputs: Input[] = [];
    const result = await new ClaudeAdapter().run(DUTIES, role, options({ resumeSessionId: UUID, onInvocationInput: input => {
      inputs.push(input);
      settings({ model: 'haiku', effortLevel: 'low' });
    } }));
    expect(result.exitCode).toBe(0);
    expect(inputs.map(input => JSON.parse(input.transport!.payload).model.value)).toEqual(['opus', 'haiku']);
    expect(inputs.map(input => JSON.parse(input.transport!.payload).effort.value)).toEqual(['high', 'low']);
  });

  it('drops rejected inherited flags and records the source for each repair', async () => {
    settings({ model: 'opus', effortLevel: 'xhigh' });
    scenario({ rejectPins: true });
    const inputs: Input[] = [];
    const result = await new ClaudeAdapter().run(DUTIES, role, options({ onInvocationInput: input => inputs.push(input) }));
    expect(result.exitCode).toBe(0);
    expect(inputs.map(input => JSON.parse(input.transport!.payload).model)).toEqual([
      { value: 'opus', source: 'user-settings' }, { value: 'opus', source: 'user-settings' }, { value: null, source: 'cli-default' },
    ]);
    expect(inputs.map(input => JSON.parse(input.transport!.payload).effort)).toEqual([
      { value: 'xhigh', source: 'user-settings' }, { value: null, source: 'cli-default' }, { value: null, source: 'cli-default' },
    ]);
  });

  it('remembers rejection against the settings used by a fresh-session retry', async () => {
    settings({ model: 'opus', effortLevel: 'high' });
    scenario({ failResume: true });
    const adapter = new ClaudeAdapter();
    let count = 0;
    const result = await adapter.run(DUTIES, role, options({ resumeSessionId: UUID, onInvocationInput: () => {
      if (++count === 1) {
        settings({ model: 'haiku', effortLevel: 'low' });
        scenario({ rejectEffort: true });
      }
    } }));
    expect(result.exitCode).toBe(0);
    expect(calls()).toHaveLength(3);
    scenario({});
    settings({ model: 'opus', effortLevel: 'high' });
    expect((await adapter.run(DUTIES, role, options())).exitCode).toBe(0);
    expect(calls()[3].argv).toContain('--effort');
    settings({ model: 'haiku', effortLevel: 'low' });
    expect((await adapter.run(DUTIES, role, options())).exitCode).toBe(0);
    expect(calls()[4].argv).not.toContain('--effort');
  });

  it.each(['model', 'effort'])('scopes remembered effort rejection to the inherited %s', async changed => {
    settings({ model: 'opus', effortLevel: 'high' });
    scenario({ rejectPins: true });
    const adapter = new ClaudeAdapter();
    expect((await adapter.run(DUTIES, role, options())).exitCode).toBe(0);
    scenario({});
    expect((await adapter.run(DUTIES, role, options())).exitCode).toBe(0);
    expect(calls()[3].argv).not.toContain('--effort');
    settings({ model: changed === 'model' ? 'haiku' : 'opus', effortLevel: changed === 'effort' ? 'low' : 'high' });
    expect((await adapter.run(DUTIES, role, options())).exitCode).toBe(0);
    expect(calls()[4].argv).toContain('--effort');
  });
});

describe('G02: session ownership, admission and cleanup', () => {
  it('copies only the projects session directory into a private destination home', async () => {
    const source = stageSessionHome(directory, 'author', 'claude'), destination = stageSessionHome(directory, 'work', 'claude');
    mkdirSync(join(source, 'projects', 'fixture'), { recursive: true });
    writeFileSync(join(source, 'projects', 'fixture', 'conversation.jsonl'), `${DUTIES}\n`);
    writeFileSync(join(source, 'settings.json'), 'synthetic owner config');
    mkdirSync(join(source, 'sessions'));
    writeFileSync(join(source, 'sessions', 'unrelated.txt'), 'other adapter history');
    prepareAdapterHome({ home: destination, sessionHome: source, sessionDirectory: 'projects' });
    expect(readFileSync(join(destination, 'projects', 'fixture', 'conversation.jsonl'), 'utf8')).toBe(`${DUTIES}\n`);
    expect(existsSync(join(destination, 'settings.json'))).toBe(false);
    expect(existsSync(join(destination, 'sessions'))).toBe(false);
    writeFileSync(join(destination, 'projects', 'fixture', 'conversation.jsonl'), 'destination mutation');
    expect(readFileSync(join(source, 'projects', 'fixture', 'conversation.jsonl'), 'utf8')).toBe(`${DUTIES}\n`);
  });

  it.each([
    { preserve: false, failed: false },
    { preserve: true, failed: false },
    { preserve: false, failed: true },
  ])('leaves native sessions with the CLI for preserve=$preserve and failed=$failed', async ({ preserve, failed }) => {
    scenario({ nativeFailure: failed });
    const result = await new ClaudeAdapter().run(DUTIES, role, options({ preserveSession: preserve }));
    expect(result.exitCode).toBe(failed ? 1 : 0);
    expect(existsSync(stageSessionHome(directory, 'work', 'claude'))).toBe(false);
    expect(existsSync(join(root, 'ambient', 'projects', 'fixture', 'conversation.jsonl'))).toBe(true);
    expect(readSession(directory, 'work', 'claude')).toMatchObject({ ownerStageId: 'work', sessionId: UUID, adapter: 'claude' });
  });

  it('reads metadata by adapter, preserving legacy Codex records and rejecting cross-adapter reuse', async () => {
    await seed('work');
    expect(readSession(directory, 'work', 'claude')?.sessionId).toBe(UUID);
    expect(readSession(directory, 'work', 'codex')).toBeUndefined();
    writeSession(directory, 'author', { version: 1, sessionId: OTHER_UUID, ownerStageId: 'author', capturedAt: new Date().toISOString() });
    expect(readSession(directory, 'author', 'codex')?.sessionId).toBe(OTHER_UUID);
    expect(readSession(directory, 'author', 'claude')).toBeUndefined();
  });

  it('admits own retries only with owned Claude metadata', async () => {
    await seed('work');
    const work = stage('work'), state = { stages: { work: successfulStatus({ status: 'pending', retries: 1 }) } } as StoreState;
    expect(sessionResumeForStage(work, [work], state, directory, false, 'claude')).toEqual({ sessionId: UUID, ownerStageId: 'work' });
    expect(sessionResumeForStage(work, [work], state, directory, false, 'codex')).toBeUndefined();
    expect(sessionResumeForStage({ ...work, is_gate: true }, [work], state, directory, false, 'claude')).toBeUndefined();
    rmSync(join(directory, 'stages', 'work', 'session.json'));
    expect(sessionResumeForStage(work, [work], state, directory, false, 'claude')).toBeUndefined();
  });

  it('admits author repair without predecessor opt-in and retires retained Claude homes after the repair loop', async () => {
    await seed('author');
    await seed('review');
    // Session metadata names the latest adapter. Native homes retained by an
    // earlier adapter still belong to this same bounded repair lifecycle.
    for (const stageId of ['author', 'review']) {
      mkdirSync(stageSessionHome(directory, stageId, 'codex'));
      writeFileSync(join(directory, 'stages', stageId, 'output.md'), 'Retain settled synthetic evidence.');
    }
    const author = stage('author'), review = stage('review', { role: 'qa', is_gate: true, depends_on: ['author'] });
    const repair = stage('repair', { depends_on: ['review'], retry_to: ['review'] });
    const all = [author, review, repair], state = { stages: { author: successfulStatus() } } as StoreState;
    expect(sessionResumeForStage(repair, all, state, directory, false, 'claude')).toEqual({ sessionId: UUID, ownerStageId: 'author' });
    expect(sessionResumeForStage(review, all, state, directory, false, 'claude')).toBeUndefined();
    expect(shouldPreserveSession(author, all, false)).toBe(true);
    expect(shouldPreserveSession(review, all, false)).toBe(true);
    expect(shouldPreserveSession(repair, all, false)).toBe(true);
    clearGateContinuationsForStages(directory, all);
    expect(existsSync(stageSessionHome(directory, 'author', 'claude'))).toBe(false);
    expect(existsSync(stageSessionHome(directory, 'review', 'claude'))).toBe(false);
    expect(existsSync(stageSessionHome(directory, 'author', 'codex'))).toBe(false);
    expect(existsSync(stageSessionHome(directory, 'review', 'codex'))).toBe(false);
    for (const stageId of ['author', 'review']) expect(readFileSync(join(directory, 'stages', stageId, 'output.md'), 'utf8')).toBe('Retain settled synthetic evidence.');
    expect(readSession(directory, 'review', 'claude')).toBeUndefined();
    expect(sessionResumeForStage(repair, all, state, directory, false, 'claude')).toBeUndefined();
  });

  it('admits a sole successful predecessor only when opt-in is enabled and excludes validation', async () => {
    await seed('author');
    const author = stage('author'), next = stage('next', { depends_on: ['author'] });
    const all = [author, next], state = { stages: { author: successfulStatus(), next: { status: 'pending', retries: 0 } } } as StoreState;
    expect(sessionResumeForStage(next, all, state, directory, false, 'claude')).toBeUndefined();
    expect(sessionResumeForStage(next, all, state, directory, true, 'claude')).toEqual({ sessionId: UUID, ownerStageId: 'author' });
    expect(sessionResumeForStage({ ...next, role: 'qa', is_gate: true }, all, state, directory, true, 'claude')).toBeUndefined();
    expect(sessionResumeForStage(next, all, { stages: { ...state.stages, author: successfulStatus({ retries: 1 }) } } as StoreState, directory, true, 'claude')).toBeUndefined();
  });

  it('continues only an own gate session and retires a disproved verdict before starting fresh', async () => {
    await seed('review');
    const review = stage('review', { role: 'qa', is_gate: true });
    expect(gateContinuationSessionForStage(review, directory, false, 'claude')).toBeUndefined();
    expect(gateContinuationSessionForStage(review, directory, true, 'claude')).toEqual({ sessionId: UUID, ownerStageId: 'review' });
    const correction = gateVerdictCorrectionPath(directory, 'review');
    mkdirSync(join(directory, 'gate_reevaluation'), { recursive: true });
    writeFileSync(correction, JSON.stringify({ version: 1, gateId: 'review', previousVerdictWrong: true, reason: 'Synthetic verdict disproved.', evidence: 'Recorded synthetic check.' }));
    expect(gateContinuationSessionForStage(review, directory, true, 'claude')).toBeUndefined();
    expect(existsSync(correction)).toBe(false);
    expect(existsSync(stageSessionHome(directory, 'review', 'claude'))).toBe(false);
    expect(readSession(directory, 'review', 'claude')).toBeUndefined();
  });
});
