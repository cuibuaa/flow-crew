import './test-support/policy-runtime.js';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureProjectTree, readEvidence, validationForTree } from '../src/evidence-ledger.js';
import { beginStageAttempt, completeStageAttempt, updateRunState } from '../src/store.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { recordAttemptValidation, currentValidationResults } from '../src/scheduler/sched_settlement/gate-validation.js';
import { createRun } from './test-support/create-run.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(input = 'node_modules', output = { path: 'products', type: 'directory' }) {
  const root = mkdtempSync(join(tmpdir(), 'tree-identity-')); roots.push(root);
  const write = (path: string, bytes: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes);
  };
  write('.gitignore', `# ${randomUUID()}\n${input}/\nproducts/\n`);
  write('source.txt', 'tracked');
  isolatedProjectCommand('git', ['init', '-q'], root, root);
  isolatedProjectCommand('git', ['add', '.'], root, root);
  write('untracked.txt', 'untracked');
  write(`${input}/baseline.txt`, 'input');
  const brief = `---\ninputs: [{path: ${input}, type: directory}]\noutputs: [${JSON.stringify(output)}]\nvalidation: {attempts: 1, commands: {test: {command: fixture, args: []}}}\n---\n# Goal\n`;
  const { runId, runDirPath } = createRun(root, 'fixture', '', ['author', 'review'], brief);
  for (const stage of ['author', 'review']) {
    beginStageAttempt(root, runId, stage, 0);
    completeStageAttempt(root, runId, stage, 0, { exitCode: 0, duration_ms: 1 });
  }
  return { root, write, brief, runId, runDirPath,
    tree: () => captureProjectTree(root, brief, runDirPath) };
}

it.each([0, 1])('reuses validation after an ignored dependency cache rewrite across boundaries (exit=%s)', async exitCode => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
  const f = fixture(); let calls = 0, elapsed = 0;
  const cache = join('node_modules', '.vite', 'vitest', 'fixture', 'results.json');
  const runCommand = () => { calls++; elapsed += 10; f.write(cache, String(calls)); return { exitCode }; };
  const facts = [];
  for (const stage of ['author', 'review', 'author']) {
    vi.setSystemTime(elapsed);
    facts.push(await recordAttemptValidation(f.root, f.runId, stage, { runCommand, now: () => elapsed }));
  }
  const observation = { calls, states: facts.map(fact => fact.resourceState),
    hashes: facts.map(fact => [fact.treeHash, fact.executions.at(-1)?.treeAfterHash]) };
  expect(observation).toMatchObject({ calls: 1, states: ['complete', 'complete', 'complete'] });
  expect(facts[1]).toEqual(facts[0]); expect(facts[2]).toEqual(facts[0]);
  expect(facts[0].pass).toBe(exitCode === 0);
  expect(facts[0].executions[0].commands[0].exitCode).toBe(exitCode);
  expect(validationForTree(readEvidence(f.runDirPath), f.tree().hash)).toEqual(facts[0]);
  expect(currentValidationResults(f.root, f.runId)?.[0].exitCode).toBe(exitCode);
  expect(readFileSync(join(f.root, cache), 'utf8')).toBe('1');
});

it.each(['source.txt', 'untracked.txt', 'products/report.md'])('keeps source or output mutation unbound and exposes the per-tree attempt bound (%s)', async path => {
  const f = fixture(); let calls = 0;
  const facts = [];
  for (let boundary = 0; boundary < 3; boundary++) {
    facts.push(await recordAttemptValidation(f.root, f.runId, 'author', { now: () => 0,
      runCommand: () => { f.write(path, String(++calls)); return { exitCode: 0 }; } }));
  }
  expect(calls).toBe(3);
  expect(new Set(facts.map(fact => fact.treeHash)).size).toBe(3);
  for (const fact of facts) {
    expect(fact.resourceState).toBe('unfinished'); expect(fact.pass).toBe(false);
    expect(fact.executions[0].treeAfterHash).not.toBe(fact.treeHash);
  }
  expect(validationForTree(readEvidence(f.runDirPath), f.tree().hash)).toBeUndefined();
  expect(currentValidationResults(f.root, f.runId)).toEqual([expect.objectContaining({ exitCode: null, state: 'unverified' })]);
});

it.each(['docs', 'data', 'node_modules'])('uses the source inventory inside a declared ignored input (%s)', input => {
  const f = fixture(input), before = f.tree();
  f.write(`${input}/baseline.txt`, 'changed');
  expect(f.tree()).toEqual(before);
  f.write(`${input}/tracked.txt`, 'tracked ignored member');
  isolatedProjectCommand('git', ['add', '-f', `${input}/tracked.txt`], f.root, f.root);
  const tracked = f.tree();
  expect(tracked.hash).not.toBe(before.hash);
  f.write(`${input}/tracked.txt`, 'changed tracked member');
  expect(f.tree().hash).not.toBe(tracked.hash);
});

it.each([{ path: 'products', type: 'directory' }, { path: 'products/report.md', type: 'file' }])('keeps ignored declared output files and directory members in the shared identity (%j)', output => {
  const f = fixture('node_modules', output), before = f.tree();
  f.write('products/report.md', 'first');
  const written = f.tree(); expect(written.hash).not.toBe(before.hash);
  f.write('products/report.md', 'second');
  expect(f.tree().hash).not.toBe(written.hash);
});

it.each(['terminal', 'stage'])('keeps ignored admitted products in the shared identity (%s)', owner => {
  const f = fixture(), path = join('node_modules', 'report.md');
  updateRunState(f.root, f.runId, state => {
    if (owner === 'terminal') state.terminalStates = { complete: { paths: [path] } };
    else state.planControl = { version: 1, stages: [StageConfigSchema.parse({ id: 'author', role: 'coder',
      artifact_contract: { version: 1, produces: [{ id: 'report', root: 'project', path, kind: 'file' }], reads: [] } })] };
  });
  const before = f.tree(); f.write(path, 'first');
  const written = f.tree(); expect(written.hash).not.toBe(before.hash);
  f.write(path, 'second'); expect(f.tree().hash).not.toBe(written.hash);
});

it('does not bind ignored bytes through a source symlink declared as an input', () => {
  const f = fixture(); symlinkSync(join('node_modules', 'baseline.txt'), join(f.root, 'alias.txt'));
  const brief = '---\ninputs: [alias.txt]\n---\n';
  const before = captureProjectTree(f.root, brief);
  expect(before.files.map(file => file.path)).toContain('alias.txt');
  f.write(join('node_modules', 'baseline.txt'), 'changed');
  expect(captureProjectTree(f.root, brief)).toEqual(before);
});

it.each(['file', 'directory'])('retains ignored output aliases also declared as inputs (%s)', type => {
  const f = fixture(), target = join('node_modules', 'baseline.txt');
  symlinkSync(type === 'file' ? target : 'node_modules', join(f.root, 'alias'), type === 'file' ? 'file' : 'dir');
  const brief = `---\ninputs: [alias]\noutputs: [{path: alias, type: ${type}}]\n---\n`;
  const before = captureProjectTree(f.root, brief);
  expect(before.hash).not.toBeNull();
  f.write(target, 'changed');
  expect(captureProjectTree(f.root, brief).hash).not.toBe(before.hash);
});
