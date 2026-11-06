import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { AVAILABLE_ADAPTER_NAMES } from '../src/adapters/loader.js';
import { MockAdapter } from '../src/adapters/mock.js';
import type { AgentConfig, RunOpts } from '../src/adapters/base.js';
import { buildStagePrompt, MAX_PREDECESSOR_CONTEXT_BYTES, HANDOFF_SCHEMA, parseStageRecord, stageRecordSchema } from '../src/handoff.js';
import { generationCompatibleSchema } from '../src/reality-gate/checks/json-schema-match.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

const SESSION_UUID = '123e4567-e89b-42d3-a456-426614174000';
const ENVIRONMENT_KEYS = [
  'PATH',
  'CODEX_HOME',
  'CODEX_PLUGINS_CACHE',
  'CODEX_SKILLS_CACHE',
  'FC_PROMPT_ADAPTER',
  'FC_PROMPT_CAPTURE_DIR',
  'MOCK_FIXTURE_DIR',
] as const;
const initialEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;
const initialFcGlobalDir = fcGlobalDir();
const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const [key, value] of Object.entries(initialEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setFcGlobalDir(initialFcGlobalDir);
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('size-independent adapter prompt delivery', () => {
  it('refuses incomplete handoffs and verdicts using the same schema sent to generation', () => {
    expect(generationCompatibleSchema(HANDOFF_SCHEMA)).toBe(true);
    expect(() => parseStageRecord('{"status":"delivered"}', HANDOFF_SCHEMA)).toThrow('required');
    const verdict = stageRecordSchema({ isGate: true, criterionRefs: ['criterion'] });
    expect(() => parseStageRecord('{"pass":true,"reason":"accepted"}', verdict)).toThrow('anyOf');
    expect(() => parseStageRecord(JSON.stringify({ pass: false, reason: 'rejected', criteria: { criterion: { status: 'fail', evidence: 'spec/proof.test.ts' } }, audit_findings: { version: 1, findings: [] } }), verdict)).toThrow('anyOf');
  });
  it('preserves launch provenance when the stdin-backed Codex spawn fails', async () => {
    const root = temporaryRoot('flowcrew-prompt-missing-codex-');
    const emptyPath = join(root, 'empty-path');
    const runDir = join(root, 'run');
    mkdirSync(emptyPath, { recursive: true });
    mkdirSync(runDir, { recursive: true });

    process.env.PATH = emptyPath;
    process.env.CODEX_HOME = join(root, 'user-codex-home');
    process.env.CODEX_PLUGINS_CACHE = join(root, 'plugins-cache');
    process.env.CODEX_SKILLS_CACHE = join(root, 'skills-cache');

    const result = await new CodexAdapter().run('small prompt', {
      name: 'coder',
      description: 'missing executable fixture',
      model: 'default',
      reasoning_effort: 'default',
      tools: [],
      prompt: '',
    }, {
      timeout_ms: 5_000,
      workDir: root,
      runDir,
      stageId: 'missing_codex',
    });

    expect(result).toMatchObject({
      exitCode: 1,
      spawnError: { code: 'ENOENT', syscall: 'spawn codex', path: 'codex', cwd: root },
    });
    expect(result.output).toContain('spawn codex ENOENT');
    expect(result.output).toContain(root);
    expect(result.friendlyError).toContain('executable, its interpreter and working directory');
  });

  it('delivers a prompt above the OS single-argument limit through every shipped adapter', async () => {
    const root = temporaryRoot('flowcrew-prompt-adapters-');
    const binDir = join(root, 'bin');
    const captureDir = join(root, 'capture');
    const fixtureDir = join(root, 'fixtures');
    const runDir = join(root, 'run');
    const workDir = join(root, 'project');
    for (const directory of [binDir, captureDir, fixtureDir, runDir, workDir]) {
      mkdirSync(directory, { recursive: true });
    }

    const prompt = `oversized-stage-prompt\n${'界🧪'.repeat(60_000)}`;
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    const promptSha256 = createHash('sha256').update(prompt).digest('hex');
    expect(promptBytes).toBeGreaterThan(131_072);

    const childPreamble = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const crypto = require('node:crypto');",
      "if (process.argv.includes('--version')) { console.log('flowcrew-test-shim 1.0'); process.exit(0); }",
      'const chunks = [];',
      "process.stdin.on('data', (chunk) => chunks.push(chunk));",
      "process.stdin.on('end', () => {",
      '  const prompt = Buffer.concat(chunks);',
      "  const sha256 = crypto.createHash('sha256').update(prompt).digest('hex');",
      `  const mode = process.argv.includes('${SESSION_UUID}') ? 'resume' : 'fresh';`,
      "  const receipt = { bytes: prompt.length, sha256, argv: process.argv.slice(2) };",
      "  fs.writeFileSync(path.join(process.env.FC_PROMPT_CAPTURE_DIR, process.env.FC_PROMPT_ADAPTER + '-' + mode + '.json'), JSON.stringify(receipt));",
    ].join('\n');
    writeFileSync(join(binDir, 'codex'), [
      '#!/usr/bin/env node',
      childPreamble,
      "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex-ok' } }));",
      '});',
      'process.stdin.resume();',
    ].join('\n'));
    writeFileSync(join(binDir, 'claude'), [
      '#!/usr/bin/env node',
      childPreamble,
      "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude-ok' }] } }));",
      "  console.log(JSON.stringify({ type: 'result', result: 'claude-ok', is_error: false }));",
      '});',
      'process.stdin.resume();',
    ].join('\n'));
    chmodSync(join(binDir, 'codex'), 0o755);
    chmodSync(join(binDir, 'claude'), 0o755);

    process.env.PATH = `${binDir}:${initialEnvironment.PATH ?? ''}`;
    process.env.CODEX_HOME = join(root, 'user-codex-home');
    process.env.CODEX_PLUGINS_CACHE = join(root, 'plugins-cache');
    process.env.CODEX_SKILLS_CACHE = join(root, 'skills-cache');
    process.env.FC_PROMPT_CAPTURE_DIR = captureDir;
    mkdirSync(process.env.CODEX_HOME, { recursive: true });

    const role: AgentConfig = {
      name: 'coder',
      description: 'adapter launch fixture',
      model: 'default',
      reasoning_effort: 'default',
      tools: [],
      prompt: '',
    };
    const opts = (stageId: string, overrides: Partial<RunOpts> = {}): RunOpts => ({
      timeout_ms: 10_000,
      workDir,
      runDir,
      stageId,
      ...overrides,
    });

    process.env.FC_PROMPT_ADAPTER = 'codex';
    const codex = new CodexAdapter();
    const codexFresh = await codex.run(prompt, role, opts('codex_fresh'));
    const codexResume = await codex.run(prompt, role, opts('codex_resume', {
      resumeSessionId: SESSION_UUID,
      sessionOwnerStageId: 'codex_fresh',
    }));

    process.env.FC_PROMPT_ADAPTER = 'claude';
    const claude = await new ClaudeAdapter().run(prompt, role, opts('claude_fresh'));

    writeFileSync(join(fixtureDir, 'mock_fresh.json'), JSON.stringify({
      output_text: 'mock-ok',
      exit_code: 0,
    }));
    process.env.MOCK_FIXTURE_DIR = fixtureDir;
    const mock = await new MockAdapter().run(prompt, role, opts('mock_fresh'));

    const results = {
      codex: codexFresh.exitCode,
      claude: claude.exitCode,
      mock: mock.exitCode,
    };
    expect(Object.keys(results).sort()).toEqual([...AVAILABLE_ADAPTER_NAMES].sort());
    expect(results).toEqual({ codex: 0, claude: 0, mock: 0 });
    expect(codexResume.exitCode).toBe(0);

    const receipt = (adapter: string, mode = 'fresh') => JSON.parse(
      readFileSync(join(captureDir, `${adapter}-${mode}.json`), 'utf8'),
    ) as { bytes: number; sha256: string; argv: string[] };
    const codexFreshReceipt = receipt('codex');
    const codexResumeReceipt = receipt('codex', 'resume');
    const claudeReceipt = receipt('claude');
    for (const received of [codexFreshReceipt, codexResumeReceipt, claudeReceipt]) {
      expect(received).toMatchObject({ bytes: promptBytes, sha256: promptSha256 });
      expect(received.argv).not.toContain(prompt);
    }
    expect(codexFreshReceipt.argv.slice(-2)).toEqual(['--', '-']);
    expect(codexResumeReceipt.argv).toContain(SESSION_UUID);
    expect(codexResumeReceipt.argv.slice(-2)).toEqual(['--', '-']);
  }, 30_000);
});

interface ContextFixture {
  depDir: string;
  projectDir: string;
  runDir: string;
  runId: string;
}

function contextFixture(): ContextFixture {
  const root = temporaryRoot('flowcrew-predecessor-context-');
  const projectDir = join(root, 'project');
  const fcHome = join(root, 'fc-home');
  const runId = 'bounded-run';
  const runDir = join(fcHome, 'runs', runId);
  const depDir = join(runDir, 'stages', 'upstream');
  mkdirSync(join(projectDir, 'config'), { recursive: true });
  mkdirSync(depDir, { recursive: true });
  setFcGlobalDir(fcHome);
  return { depDir, projectDir, runDir, runId };
}

function writePredecessor(
  depDir: string,
  artifacts: string[],
  output: string,
): void {
  writeFileSync(join(depDir, 'status.json'), JSON.stringify({
    status: 'complete',
    retries: 0,
    artifacts,
  }));
  writeFileSync(join(depDir, 'output.md'), output);
}

function renderPrompt(
  fixture: ContextFixture,
  handoffVisibility: 'full' | 'minimal' | 'none' = 'full',
  dependsOn = ['upstream'],
): string {
  return buildStagePrompt({
    dependsOn,
    promptTemplate: 'BODY',
    projectDir: fixture.projectDir,
    runId: fixture.runId,
    runDir: fixture.runDir,
    stageId: 'successor',
    handoffVisibility,
  });
}

function dependencyContext(prompt: string): string {
  const bodyOffset = prompt.indexOf('\n\nBODY');
  expect(bodyOffset).toBeGreaterThan(0);
  return prompt.slice(0, bodyOffset);
}

describe('one bounded evidence context replaces predecessor narratives', () => {
  it('ignores author narrative size across the old 8,000-byte threshold', () => {
    const fixture = contextFixture();
    writePredecessor(fixture.depDir, ['artifact.ts'], '');
    const baseline = dependencyContext(renderPrompt(fixture));
    for (const bytes of [7999, 8000, 8001, 100000]) {
      writePredecessor(fixture.depDir, ['artifact.ts'], 'AUTHOR-TRANSCRIPT-' + 'x'.repeat(bytes));
      const context = dependencyContext(renderPrompt(fixture));
      expect(context).toBe(baseline);
      expect(context).toContain('evidence-ledger.jsonl');
      expect(context).toContain('change.diff');
      expect(context).not.toContain('AUTHOR-TRANSCRIPT-');
      expect(context).not.toContain('output.md');
    }
  });

  it('keeps UTF-8 facts bounded and complete facts inspectable for every visibility setting', () => {
    const fixture = contextFixture();
    const ledger = join(fixture.runDir, 'evidence-ledger.jsonl');
    const fact = { version: 1, sequence: 1, at: 'fixture', kind: 'declaration', owner: 'declaration',
      stageId: 'upstream', attemptIndex: 1, status: 'blocked', reason: 'HEAD-' + '界🧪'.repeat(6000) + '-TAIL', caveats: [] };
    writeFileSync(ledger, JSON.stringify(fact) + '\n');
    writePredecessor(fixture.depDir, ['artifact.ts'], 'AUTHOR-PRIVATE-HISTORY');
    for (const visibility of ['full', 'minimal', 'none'] as const) {
      const context = dependencyContext(renderPrompt(fixture, visibility));
      expect(Buffer.byteLength(context)).toBeLessThan(8000);
      expect(context).toContain(ledger);
      expect(context).toContain('HEAD-');
      expect(context).toContain('-TAIL');
      expect(context).toContain('[excerpt; read the complete artifact above]');
      expect(context).not.toContain('AUTHOR-PRIVATE-HISTORY');
      expect(context).not.toContain('\uFFFD');
      expect(JSON.parse(readFileSync(ledger, 'utf8')).reason).toBe(fact.reason);
    }
  });

  it('uses one ledger and diff for multiple dependencies without repeating predecessor blocks', () => {
    const fixture = contextFixture();
    const second = join(fixture.runDir, 'stages', 'upstream_two');
    mkdirSync(second, { recursive: true });
    writePredecessor(fixture.depDir, ['a.js'], 'FIRST-AUTHOR-PRIVATE');
    writePredecessor(second, ['b.js'], 'SECOND-AUTHOR-PRIVATE');
    const one = dependencyContext(renderPrompt(fixture, 'full', ['upstream']));
    const two = dependencyContext(renderPrompt(fixture, 'full', ['upstream', 'upstream_two']));
    expect(two).toBe(one);
    expect(two.split('## Evidence ledger and diff')).toHaveLength(2);
    expect(two).not.toContain('FIRST-AUTHOR-PRIVATE');
    expect(two).not.toContain('SECOND-AUTHOR-PRIVATE');
  });
});
