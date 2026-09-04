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
import { buildStagePrompt, MAX_PREDECESSOR_CONTEXT_BYTES } from '../src/handoff.js';
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
  it('preserves missing-CLI diagnostics when the stdin-backed Codex spawn fails', async () => {
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
      output: 'Command not found: codex. Install the adapter CLI and try again.',
      friendlyError: 'The adapter CLI is not installed or not on PATH. Run `flowcrew doctor`.',
    });
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
  writeFileSync(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 1000\n');
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

describe('whole-predecessor UTF-8 context bound', () => {
  it('switches only after the complete rendered block exceeds 8,000 bytes', () => {
    const fixture = contextFixture();
    writePredecessor(fixture.depDir, ['artifact.ts'], '');
    const fixedBytes = Buffer.byteLength(dependencyContext(renderPrompt(fixture)), 'utf8');

    for (const targetBytes of [MAX_PREDECESSOR_CONTEXT_BYTES - 1, MAX_PREDECESSOR_CONTEXT_BYTES]) {
      writePredecessor(fixture.depDir, ['artifact.ts'], 'x'.repeat(targetBytes - fixedBytes));
      const context = dependencyContext(renderPrompt(fixture));
      expect(Buffer.byteLength(context, 'utf8')).toBe(targetBytes);
      expect(context).toContain('Artifacts: artifact.ts');
      expect(context).not.toContain('Inline predecessor block:');
    }

    writePredecessor(fixture.depDir, ['artifact.ts'], 'x'.repeat(
      MAX_PREDECESSOR_CONTEXT_BYTES + 1 - fixedBytes,
    ));
    const bounded = dependencyContext(renderPrompt(fixture));
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(MAX_PREDECESSOR_CONTEXT_BYTES);
    expect(bounded).toContain(`Inline predecessor block: ${MAX_PREDECESSOR_CONTEXT_BYTES + 1} UTF-8 bytes`);
    expect(bounded).toContain(fixture.depDir);
    expect(bounded).toContain('status.json');
    expect(bounded).toContain('output.md');
  });

  it('bounds artifact and multibyte output overflow in full and minimal visibility', () => {
    const fixture = contextFixture();
    const artifacts = Array.from(
      { length: 18_000 },
      (_, index) => `ui/node_modules/package-${index}/deep/file.js`,
    );
    const output = `HEAD-${'界🧪'.repeat(6_000)}-TAIL`;
    writePredecessor(fixture.depDir, artifacts, output);
    expect(existsSync(fixture.depDir)).toBe(true);

    for (const visibility of ['full', 'minimal'] as const) {
      const context = dependencyContext(renderPrompt(fixture, visibility));
      expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(MAX_PREDECESSOR_CONTEXT_BYTES);
      expect(context.split(fixture.depDir)).toHaveLength(2);
      expect(context).toContain('Artifact names omitted from this prompt: 18000');
      expect(context).toContain('status.json');
      expect(context).toContain('output.md');
      expect(context).toContain('HEAD-');
      expect(context).toContain('-TAIL');
      expect(context).toMatch(/\d+ UTF-8 output bytes omitted/);
      expect(context).not.toContain(artifacts.at(-1));
      expect(context).not.toContain('\uFFFD');
      expect(Buffer.from(context, 'utf8').toString('utf8')).toBe(context);
    }

    writePredecessor(fixture.depDir, ['small-artifact.ts'], 'small complete summary');
    const full = dependencyContext(renderPrompt(fixture, 'full'));
    const minimal = dependencyContext(renderPrompt(fixture, 'minimal'));
    expect(full).toContain('small-artifact.ts');
    expect(full).toContain('small complete summary');
    expect(minimal).toContain('small-artifact.ts');
    expect(minimal).not.toContain('small complete summary');
    expect(renderPrompt(fixture, 'none')).not.toContain('## Context from stage:');
    expect(renderPrompt(fixture, 'none')).not.toContain('## Previous stage:');
  });

  it('caps each dependency independently and only adds two-byte separators', () => {
    const fixture = contextFixture();
    const secondDepDir = join(fixture.runDir, 'stages', 'upstream_two');
    mkdirSync(secondDepDir, { recursive: true });
    const artifacts = Array.from({ length: 18_000 }, (_, index) => `artifact-${index}.js`);
    writePredecessor(fixture.depDir, artifacts, `FIRST-HEAD-${'界'.repeat(8_000)}-FIRST-TAIL`);
    writePredecessor(secondDepDir, artifacts, `SECOND-HEAD-${'🧪'.repeat(8_000)}-SECOND-TAIL`);

    const context = dependencyContext(renderPrompt(
      fixture,
      'full',
      ['upstream', 'upstream_two'],
    ));
    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(
      2 * MAX_PREDECESSOR_CONTEXT_BYTES + 2,
    );
    expect(context).toContain(fixture.depDir);
    expect(context).toContain(secondDepDir);
    expect(context).toContain('FIRST-HEAD');
    expect(context).toContain('FIRST-TAIL');
    expect(context).toContain('SECOND-HEAD');
    expect(context).toContain('SECOND-TAIL');
  });
});
