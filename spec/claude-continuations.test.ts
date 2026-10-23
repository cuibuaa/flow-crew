import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig, CommandLifecycleEvent, RunOpts, RunResult } from '../src/adapters/base.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { requestStageCommandInterrupt } from '../src/command-interrupt.js';
import { appendGuidanceEnvelope } from '../src/guidance.js';
import { HANDOFF_SCHEMA } from '../src/handoff.js';
import { readRunStateView } from '../src/run-state-view.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readStageStatus, setFcGlobalDir } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const duties = 'Unique original duties: inspect the synthetic evidence and report the completed work.';
const guidance = 'Keep the measured evidence and report the bounded result.';
const role: AgentConfig = {
  name: 'coder', adapter: 'claude', description: 'session continuation fixture', model: 'default',
  reasoning_effort: 'default', tools: ['default'], prompt: 'Synthetic session fixture.',
};
const environmentKeys = ['PATH', 'CLAUDE_CONFIG_DIR', 'FC_CLAUDE_CONTINUATION_MODE', 'FC_CLAUDE_CALLS'] as const;
let root: string, project: string, priorStore: string;
let priorEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-claude-continuations-'));
  project = join(root, 'project');
  const bin = join(root, 'bin');
  for (const directory of [project, bin, join(root, 'source')]) mkdirSync(directory);
  priorEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.CLAUDE_CONFIG_DIR = join(root, 'source');
  process.env.FC_CLAUDE_CALLS = join(root, 'calls.jsonl');
  priorStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const calls = process.env.FC_CLAUDE_CALLS;
  const count = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  fs.appendFileSync(calls, JSON.stringify({ argv: process.argv.slice(2), stdin: input, home: process.env.CLAUDE_CONFIG_DIR }) + '\n');
  const emit = event => console.log(JSON.stringify(event));
  const id = '11111111-1111-4111-8111-111111111111';
  emit({type:'system',subtype:'init',session_id:id,model:'synthetic-resolved-model'});
  const complete = () => emit({type:'result',subtype:'success',session_id:id,is_error:false,
    result:JSON.stringify({status:'delivered',summary:'fixture complete',files_modified:[],checks:[],caveats:[]})});
  if (count > 0) { complete(); return; }
  if (process.env.FC_CLAUDE_CONTINUATION_MODE === 'correction') {
    emit({type:'result',subtype:'success',session_id:id,is_error:false,result:'{"status":"delivered"}'});
    return;
  }
  emit({type:'assistant',session_id:id,message:{content:[{type:'tool_use',id:'fixture-command',name:'Bash',input:{command:'node synthetic-measurement.js'}}]}});
  if (process.env.FC_CLAUDE_CONTINUATION_MODE === 'guidance') {
    setTimeout(() => emit({type:'user',session_id:id,message:{content:[{type:'tool_result',tool_use_id:'fixture-command',content:'synthetic evidence'}]}}), 40);
    setTimeout(complete, 100);
  } else {
    setInterval(() => {}, 1000);
  }
});
`, { mode: 0o755 });
});

afterEach(() => {
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  setFcGlobalDir(priorStore);
  rmSync(root, { recursive: true, force: true });
});

describe('Claude same-attempt native session continuations (G03)', () => {
  it.each(['correction', 'guidance', 'interrupt'] as const)('resumes after %s without resending original duties', async mode => {
    process.env.FC_CLAUDE_CONTINUATION_MODE = mode;
    const created = createRun(project, 'fixture', 'name: fixture\nstages:\n  - id: work\n    role: coder\n', ['work']);
    mkdirSync(join(created.runDirPath, 'signals'), { recursive: true });
    writeFileSync(join(created.runDirPath, 'task_brief.md'), '# Synthetic session continuation\n');
    let injected = false;
    let injectionError: unknown;
    class ObservedClaudeAdapter extends ClaudeAdapter {
      override async run(prompt: string, agent: AgentConfig, opts: RunOpts): Promise<RunResult> {
        return super.run(prompt, agent, {
          ...opts,
          onCommandLifecycle(event: CommandLifecycleEvent) {
            opts.onCommandLifecycle?.(event);
            if (event.phase !== 'started' || injected) return;
            injected = true;
            try {
              if (mode === 'interrupt') {
                requestStageCommandInterrupt({ runDir: created.runDirPath, stageId: 'work', reason: guidance });
              } else {
                appendGuidanceEnvelope({ runDir: created.runDirPath, target: 'work', source: 'operator', body: guidance, knownStageIds: ['work'] });
              }
            } catch (error) { injectionError = error; }
          },
        });
      }
    }
    const result = await runStage(new ObservedClaudeAdapter(), {
      stageId: 'work', role, dependsOn: [], promptTemplate: duties,
      timeout_ms: 10_000, projectDir: project, runId: created.runId, runDir: created.runDirPath,
      retries: 0, outputSchema: HANDOFF_SCHEMA, artifactContract: fixtureArtifactContract('work'),
    });
    expect(injectionError).toBeUndefined();
    expect(result.exitCode, result.output).toBe(0);
    const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { argv: string[]; stdin: string; home: string });
    expect(calls).toHaveLength(2);
    expect(calls[0].argv).not.toContain('--resume');
    expect(calls[0].stdin).toContain(duties);
    expect(calls[1].argv[calls[1].argv.indexOf('--resume') + 1]).toBe(sessionId);
    expect(calls[1].stdin).not.toContain(duties);
    expect(calls[1].stdin).toContain(mode === 'correction' ? '# Stage result correction'
      : mode === 'guidance' ? '# Live guidance delivered at tool completion' : '# Operator command interrupt');
    if (mode !== 'correction') expect(calls[1].stdin).toContain(guidance);
    const status = readStageStatus(project, created.runId, 'work');
    expect(status.status).toBe('complete');
    expect(status.attempts).toHaveLength(1);
    expect(calls.map(call => call.home)).toEqual([
      join(root, 'source'),
      join(root, 'source'),
    ]);
    const inputs = readRunStateView(project, created.runId, {
      includePromptText: true,
    }).prompts.invocations;
    expect(inputs).toHaveLength(2);
    expect(inputs.map(input => input.record?.attemptIndex)).toEqual([1, 1]);
    expect(inputs.map(input => input.record?.model)).toEqual(['synthetic-resolved-model', 'synthetic-resolved-model']);
    expect(inputs[1].record?.resumeSessionId).toBe(sessionId);
    expect(inputs[1].record?.userPrompt).toBe(calls[1].stdin);
    expect(inputs.every(input => input.integrity === 'verified')).toBe(true);
    if (mode !== 'correction') {
      const events = readFileSync(join(created.runDirPath, 'events.jsonl'), 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as { type: string; boundary?: string; delivered?: boolean });
      expect(events.some(event => event.type === 'stage_command_started')).toBe(false);
      expect(events.some(event => mode === 'guidance'
        ? event.type === 'guidance_delivery_checked' && event.boundary === 'tool_call_completion' && event.delivered === true
        : event.type === 'stage_command_interrupted')).toBe(true);
    }
  });
});
