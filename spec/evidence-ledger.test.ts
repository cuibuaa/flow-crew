import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it } from 'vitest';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShipSetup } from '../src/cli-ship-setup.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import type { Adapter, RunOpts } from '../src/adapters/base.js';
import { fcGlobalDir, runDir } from '../src/store.js';
import { captureProjectTree, readEvidence, VALIDATION_FACT_VERSION, type ValidationFact } from '../src/evidence-ledger.js';
import { readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { gateValidationRefusal, recordAttemptValidation, settleGateValidationEvidence } from '../src/scheduler/sched_settlement/gate-validation.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  for (const leaf of ['source/data', 'target/data']) if (existsSync(join(root, leaf))) chmodSync(join(root, leaf), 0o700);
  rmSync(root, { recursive: true, force: true });
} });
const engine = resolve(import.meta.dirname, '..');
const reading = { version: 1, testsRun: 1, complete: true,
  failures: [{ testId: 'fixture test', file: 'case.test', messageClass: 'assertion' }] };

async function fixture(options: { noValidation?: boolean; nativeCommands?: boolean; baseRed?: boolean; introduce?: boolean; invalidReading?: boolean;
  rejectFirstReview?: boolean; mutateValidation?: boolean; unchanged?: boolean; verbose?: boolean; suiteError?: 'suite' | 'diagnostic' | 'unhandled'; input?: 'introduced' | 'mixed'; readonlyInput?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ledger-spec-')); roots.push(root);
  const source = join(root, 'source'), target = join(root, 'target'); mkdirSync(source);
  const counter = join(root, 'executions.jsonl');
  const git = (...args: string[]) => isolatedProjectCommand('git', args, source, root);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(source, 'value.txt'), 'base\n');
  writeFileSync(join(source, 'check.mjs'), `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(counter)},JSON.stringify({cwd:process.cwd(),value:fs.readFileSync('value.txt','utf8')})+'\\n');
const fail=${Boolean(options.baseRed)}||fs.readFileSync('value.txt','utf8').startsWith('introduced');
${options.mutateValidation ? "fs.writeFileSync('value.txt','changed by validation\\n');" : ''}
console.log(fail?'FAIL case.test > fixture test 0.375s\\nTests 1 failed':'Tests 1 passed');process.exitCode=fail?1:0;`);
  if (options.verbose) writeFileSync(join(source, 'check.mjs'), `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(counter)},JSON.stringify({cwd:process.cwd(),value:fs.readFileSync('value.txt','utf8')})+'\\n');
console.log('Test Files 1 passed (1)\\nTests 1 passed (1)');
process.stderr.write('diagnostic '.repeat(10000));`);
  if (options.suiteError) {
    const packageURL = import.meta.resolve('vitest/package.json');
    const cli = fileURLToPath(new URL(JSON.parse(readFileSync(new URL(packageURL), 'utf8')).bin.vitest, packageURL));
    writeFileSync(join(source, '.gitignore'), 'node_modules\n');
    writeFileSync(join(source, 'vitest.config.mjs'), "export default {test:{include:['*.test.mjs'],maxWorkers:1}};");
    writeFileSync(join(source, 'case.test.mjs'), `import {test,expect} from ${JSON.stringify(import.meta.resolve('vitest'))};test('known',()=>expect(1).toBe(2));`);
    writeFileSync(join(source, 'check.mjs'), `import fs from 'node:fs';import {spawnSync} from 'node:child_process';
fs.appendFileSync(${JSON.stringify(counter)},JSON.stringify({cwd:process.cwd(),value:fs.readFileSync('value.txt','utf8')})+'\\n');
const result=spawnSync(process.execPath,[${JSON.stringify(cli)},'run','--config','vitest.config.mjs','--reporter=json'],{encoding:'utf8',timeout:30000});
const report=JSON.parse(result.stdout);${options.suiteError !== 'unhandled' ? 'report.complete=true;' : ''}
process.stdout.write(JSON.stringify(report));process.stderr.write(result.stderr??'');if(fs.existsSync('extra.diagnostic'))process.stderr.write(fs.readFileSync('extra.diagnostic'));process.exitCode=result.status??1;`);
  }
  if (options.input) {
    writeFileSync(join(source, '.gitignore'), 'data/\n'); mkdirSync(join(source, 'data'));
    writeFileSync(join(source, 'data/value.txt'), options.input === 'mixed' ? 'BAD' : 'GOOD');
    if (options.input === 'mixed') writeFileSync(join(source, 'data/readme.txt'), 'committed member');
    if (options.readonlyInput) { chmodSync(join(source, 'data/value.txt'), 0o640); chmodSync(join(source, 'data'), 0o555); }
    writeFileSync(join(source, 'check.mjs'), `import fs from 'node:fs';
const input=fs.readFileSync('data/value.txt','utf8'),member=fs.existsSync('data/readme.txt')?fs.readFileSync('data/readme.txt','utf8'):null;
fs.appendFileSync(${JSON.stringify(counter)},JSON.stringify({cwd:process.cwd(),value:fs.readFileSync('value.txt','utf8'),input,member,inputDirectoryMode:fs.statSync('data').mode&0o777,inputFileMode:fs.statSync('data/value.txt').mode&0o777})+'\\n');
const fail=input!=='GOOD';console.log(JSON.stringify({complete:true,numTotalTests:1,numFailedTests:fail?1:0,numPassedTests:fail?0:1,testResults:[{name:'case.test',status:fail?'failed':'passed',message:'',assertionResults:[{fullName:'input validity',status:fail?'failed':'passed'}]}]}));process.exitCode=fail?1:0;`);
  }
  git('add', '.'); if (options.input === 'mixed') git('add', '-f', 'data/readme.txt'); git('commit', '-qm', 'base');
  const validationDeclaration = options.noValidation ? '' : `validation:\n  commands:\n    test:\n      command: ${JSON.stringify(process.execPath)}\n      args: [check.mjs]\n${options.suiteError || options.input ? '      report: {format: vitest-json}\n' : ''}`;
  const brief = `---\n${options.input ? 'inputs: [{path: data}]\n' : ''}${validationDeclaration}outputs: [{path: value.txt, on_existing: update}]\n---\n# Goal\nWrite a value.\n\n## Acceptance criteria\n1. Deliver the independently reviewed value.\n`;
  const briefPath = join(root, 'brief.md'); writeFileSync(briefPath, brief);
  const setup = await runShipSetup(['--project', source, '--target', target, '--base', 'HEAD', '--branch', 'trial', '--brief', briefPath], { globalDir: fcGlobalDir });
  expect(setup.state, JSON.stringify(setup)).toBe('ready');
  // Setup merges this input with a Git-created directory; establish the actual
  // pre-author read-only environment rather than assuming copy preserves mode.
  if (options.readonlyInput) { chmodSync(join(target, 'data/value.txt'), 0o640); chmodSync(join(target, 'data'), 0o555); }
  // Semantic mutation kill: eager setup must not execute even a successful suite.
  expect(existsSync(counter), 'setup discovers commands without running them').toBe(false);
  const baselineTree = captureProjectTree(target, brief);
  const calls: Array<{ stage: string; prompt: string; resume?: string; schema: RunOpts['outputSchema'] }> = [];
  let writes = 0, reviews = 0;
  const scripted = new ScriptedAdapter({ implement: { output: 'AUTHOR_TRANSCRIPT_SENTINEL' }, repair: { output: 'REPAIR_TRANSCRIPT_SENTINEL' } });
  const adapter: Adapter = { async run(prompt, role, opts) {
    if (opts.stageId === '_validation_identity') {
      expect(opts.resumeSessionId).toBeUndefined(); expect(role.tools).toEqual([]);
      expect(Buffer.byteLength(prompt)).toBeLessThan(26 * 1024);
      return { output: JSON.stringify(options.invalidReading ? { failures: ['invalid'] } : reading), exitCode: 0, duration_ms: 1 };
    }
    calls.push({ stage: opts.stageId, prompt, resume: opts.resumeSessionId, schema: opts.outputSchema });
    if (opts.stageId === 'implement') {
      if (options.nativeCommands) {
        opts.onCommandLifecycle?.({ phase: 'started', id: 'closed-command', command: 'node targeted.mjs' });
        opts.onCommandLifecycle?.({ phase: 'completed', id: 'closed-command', exitCode: 0 });
        opts.onCommandLifecycle?.({ phase: 'started', id: 'unclosed-command', command: 'node interrupted.mjs' });
      }
      for (let i = 1; i <= 3; i++) { writeFileSync(join(target, 'value.txt'), options.unchanged ? 'base\n' : options.introduce ? `introduced ${i}\n` : `write ${i}\n`); writes++; }
      if (options.suiteError === 'suite') writeFileSync(join(target, 'load.test.mjs'), "throw new Error('new suite startup failure');");
      if (options.suiteError === 'diagnostic') writeFileSync(join(target, 'extra.diagnostic'), 'opaque project runner diagnostic');
      if (options.suiteError === 'unhandled') writeFileSync(join(target, 'background.test.mjs'), `import {test} from ${JSON.stringify(import.meta.resolve('vitest'))};test('background',async()=>{setTimeout(()=>{Promise.reject(new Error('unhandled runtime failure'));},0);await new Promise(resolve=>setTimeout(resolve,30));});`);
      if (options.input === 'introduced') writeFileSync(join(target, 'data/value.txt'), 'BAD');
      if (options.input === 'mixed') writeFileSync(join(target, 'data/readme.txt'), 'authored member');
    }
    if (opts.stageId === 'repair') {
      writeFileSync(join(target, 'value.txt'), options.unchanged ? 'base\n' : 'repaired\n');
      if (options.input === 'introduced') writeFileSync(join(target, 'data/value.txt'), 'GOOD');
    }
    if (opts.stageId === 'review') {
      const criteria = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
      const pass = !options.rejectFirstReview || ++reviews > 1;
      return { output: JSON.stringify({ pass, reason: pass ? 'Independent acceptance.' : 'Check the value again.',
        criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: pass ? 'pass' : 'fail', evidence: 'value.txt' }])),
        audit_findings: { version: 1, findings: [] },
        ...(!pass ? { repairability: { version: 1, disposition: 'repairable', evidence: 'value.txt' } } : {}) }),
        exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured', tokens_in: 1, tokens_out: 1 };
    }
    return { ...await scripted.run(prompt, role, opts), writes: ['value.txt', ...(options.suiteError ? [options.suiteError === 'suite' ? 'load.test.mjs' : options.suiteError === 'diagnostic' ? 'extra.diagnostic' : 'background.test.mjs'] : []),
      ...(options.input === 'introduced' ? ['data/value.txt'] : options.input === 'mixed' ? ['data/readme.txt'] : [])], writeAttribution: 'structured', tokens_in: 1, tokens_out: 1,
      sessionId: '12345678-1234-4234-8234-123456789abc' };
  } };
  const { config, raw } = loadWorkflow(join(engine, 'config/workflows/direct.yaml')); config.defaults.max_iterations = 1;
  const final = await runWorkflow(config, raw, target, adapter, new Map(), undefined, join(engine, 'config/agents'), undefined, brief, true);
  const rd = runDir(target, final.runId), ledger = readEvidence(rd);
  const validations = ledger.filter((entry): entry is ValidationFact & typeof entry => entry.kind === 'validation');
  const executions = existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { cwd: string; value: string; input?: string; member?: string; inputDirectoryMode?: number; inputFileMode?: number }) : [];
  return { root, target, final, rd, ledger, validations, calls, executions, writes, baselineTree };
}

describe('one evidence lifecycle through the real scheduler and scripted adapter', () => {
  it('retains the complete configured command log including totals before large stderr, without another validation', async () => {
    const result = await fixture({ verbose: true });
    expect(result.final.status).toBe('complete');
    expect(result.executions).toHaveLength(1);
    expect(result.validations).toHaveLength(1);
    const [command] = result.validations[0].executions[0].commands;
    expect(command.exitCode).toBe(0);
    expect(command.output).toBe('');
    const output = readFileSync(join(result.rd, command.outputPath!), 'utf8');
    expect(output).toContain('Test Files 1 passed (1)\nTests 1 passed (1)');
    expect(output).not.toContain('earlier bytes omitted');
    expect(Buffer.byteLength(output)).toBeGreaterThanOrEqual(command.outputBytes!.stdout + command.outputBytes!.stderr);
    // Unstructured totals remain human evidence; they do not become failure identities.
    expect(command.testsRun).toBeNull();
    expect(command.identityOwner).toBe('unknown');
  });

  it.each(['suite', 'diagnostic', 'unhandled'] as const)('does not accept a new native Vitest %s failure as an unchanged pre-existing assertion', async suiteError => {
    const result = await fixture({ suiteError });
    expect(result.final.status).toBe('failed'); expect(result.executions).toHaveLength(2);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review']);
    const [fact] = result.validations; expect(fact.pass).toBe(false);
    for (const execution of fact.executions) expect(execution.treeAfterHash).toBe(execution.treeHash);
    expect(fact.executions[0].commands[0]).toMatchObject({ exitCode: 1, failureEvidence: 'partial', identityOwner: 'runner-json', testsRun: suiteError === 'unhandled' ? 2 : 1 });
    expect(fact.executions[1].commands[0]).toMatchObject({ exitCode: 1, failureEvidence: suiteError === 'unhandled' ? 'partial' : 'complete', identityOwner: 'runner-json' });
    expect(fact.executions[1].commands[0].outputBytes?.stderr).toBe(0);
    if (suiteError === 'diagnostic') expect(fact.executions[0].commands[0].outputBytes!.stderr).toBeGreaterThan(0);
    expect(fact.delta.find(value => value.role === 'test')?.state).toBe('unresolved');
    expect(fact.failures).toEqual([expect.objectContaining({ classification: 'pre-existing' })]);
  });

  it('compares a changed ignored input with its pre-author bytes and enforces introduction before repair', async () => {
    const result = await fixture({ input: 'introduced' });
    expect(result.final.status).toBe('complete'); expect(result.executions).toHaveLength(3);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair', 'review']);
    expect(result.executions.map(value => value.input)).toEqual(['BAD', 'GOOD', 'GOOD']);
    expect(result.validations[0].executions.map(value => value.commands[0].exitCode)).toEqual([1, 0]);
    expect(result.validations[0].executions[1].treeHash).toBe(result.baselineTree.hash);
    expect(result.validations[0].failures).toEqual([expect.objectContaining({ classification: 'introduced' })]);
    expect(result.validations[0].baseInputSnapshot).toMatchObject({ bytes: 4, files: 2, manifestSha256: expect.any(String) });
  });

  it.each([false, true])('restores ignored descendants and modes without replacing base tracked source or repairing a pre-existing failure (readonly=%s)', async readonlyInput => {
    const result = await fixture({ input: 'mixed', readonlyInput });
    expect(result.final.status).toBe('complete'); expect(result.executions).toHaveLength(2);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review']);
    expect(result.executions.map(value => value.input)).toEqual(['BAD', 'BAD']);
    expect(result.executions.map(value => value.member)).toEqual(['authored member', 'committed member']);
    expect(result.validations[0].executions.map(value => value.commands[0].exitCode)).toEqual([1, 1]);
    expect(result.validations[0].executions[1].treeHash).toBe(result.baselineTree.hash);
    expect(result.validations[0].failures).toEqual([expect.objectContaining({ classification: 'pre-existing' })]);
    expect(result.validations[0].baseInputSnapshot).toMatchObject({ bytes: 3, files: 2 });
    if (readonlyInput) for (const execution of result.executions) expect(execution).toMatchObject({ inputDirectoryMode: 0o555, inputFileMode: 0o640 });
  });

  it('runs exactly once after three writes and once on the isolated failing base; pre-existing alone never repairs', async () => {
    const result = await fixture({ baseRed: true });
    expect(result.final.status).toBe('complete'); expect(result.writes).toBe(3);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review']);
    expect(result.executions).toHaveLength(2);
    expect(result.executions[0]).toMatchObject({ cwd: result.target, value: 'write 3\n' });
    expect(result.executions[1].cwd).not.toBe(result.target); expect(result.executions[1].value).toBe('base\n');
    expect(existsSync(result.executions[1].cwd)).toBe(false);
    expect(result.validations).toHaveLength(1);
    const [validation] = result.validations;
    expect(validation.validationVersion).toBe(VALIDATION_FACT_VERSION);
    expect(validation.failures).toEqual([expect.objectContaining({ classification: 'pre-existing' })]);
    expect(validation.executions.map(execution => execution.target)).toEqual(['attempt', 'base']);
    expect(validation.executions[1].treeHash).toBe(result.baselineTree.hash);
    for (const execution of validation.executions) {
      expect(execution.treeHash).toMatch(/^[a-f0-9]{64}$/); expect(execution.treeAfterHash).toBe(execution.treeHash);
      expect(execution.commands).toEqual([expect.objectContaining({ exitCode: 1, testsRun: 1, identityOwner: 'closed-schema-model' })]);
    }
    expect(validation.pass).toBe(true);
  });

  it('records observed work without empty validation facts or receipts when no suite is configured', async () => {
    const result = await fixture({ noValidation: true });
    expect(result.final.status).toBe('complete');
    expect(result.executions).toEqual([]); expect(result.validations).toEqual([]);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review']);
    expect(result.ledger.some(fact => fact.kind === 'attempt')).toBe(true);
    expect(existsSync(join(result.rd, 'validation_delta_review.json'))).toBe(false);
  });

  it('records native structured command exits and an unknown outcome when the stream closes without an exit', async () => {
    const result = await fixture({ nativeCommands: true });
    const commands = result.ledger.filter(entry => entry.kind === 'command');
    expect(commands).toEqual([
      expect.objectContaining({ commandId: 'closed-command', command: 'node targeted.mjs', exitCode: 0, invocationIndex: 1, owner: 'adapter-event' }),
      expect.objectContaining({ commandId: 'unclosed-command', command: 'node interrupted.mjs', exitCode: null, invocationIndex: 1, owner: 'adapter-event' }),
    ]);
  });

  it('runs a successful suite once without a base replay, including an unchanged tree', async () => {
    const result = await fixture({ unchanged: true });
    expect(result.final.status).toBe('complete'); expect(result.executions).toHaveLength(1);
    expect(result.validations[0].treeHash).toBe(result.baselineTree.hash);
    expect(result.validations[0].executions).toHaveLength(1);
  });

  it('takes an introduced failure to an independent gate and validates the repair once before a fresh re-review', async () => {
    setEngineDefaults({ session_reuse: true });
    const result = await fixture({ introduce: true });
    expect(result.final.status).toBe('complete');
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair', 'review']);
    expect(result.executions).toHaveLength(3);
    expect(result.validations.map(value => value.stageId)).toEqual(['implement', 'repair']);
    expect(result.validations[0].failures).toEqual([expect.objectContaining({ classification: 'introduced' })]);
    expect(result.validations[1].executions).toHaveLength(1); expect(result.validations[1].pass).toBe(true);
    for (const call of result.calls) {
      expect(call.resume).toBeUndefined();
      expect(call.prompt).toContain('evidence-ledger.jsonl'); expect(call.prompt).toContain('change.diff');
      expect(call.prompt).not.toContain('AUTHOR_TRANSCRIPT_SENTINEL'); expect(call.prompt).not.toContain('REPAIR_TRANSCRIPT_SENTINEL');
      expect(call.prompt).not.toContain('--prompts');
      expect(call.prompt).not.toContain('output.md'); expect(call.prompt).not.toContain('output_attempt_');
    }
    const firstReview = result.calls.find(call => call.stage === 'review')!;
    expect(firstReview.prompt).toContain('introduced');
    expect(firstReview.prompt).toContain('+introduced 3');
    const evidenceRoot = join(result.rd, 'stage_evidence');
    const patches = readdirSync(evidenceRoot, { recursive: true }).filter(path => String(path).endsWith('/change.diff'))
      .map(path => ({ path: join(evidenceRoot, String(path)), bytes: readFileSync(join(evidenceRoot, String(path)), 'utf8') }));
    const reviewedPatch = patches.find(patch => patch.bytes.includes('+introduced 3'));
    expect(reviewedPatch, 'the first review diff survives repair and re-review').toBeDefined();
    expect(firstReview.prompt).toContain(reviewedPatch!.path);
    expect(patches.some(patch => patch.bytes.includes('+repaired'))).toBe(true);
    expect(firstReview.schema).toHaveProperty('anyOf');
    expect(result.calls[0].schema?.properties).not.toHaveProperty('checks');
    expect(result.calls[0].schema?.properties).not.toHaveProperty('files_modified');
    const ledgerText = readFileSync(join(result.rd, 'evidence-ledger.jsonl'), 'utf8');
    expect(ledgerText).not.toContain('AUTHOR_TRANSCRIPT_SENTINEL');
    const changes = result.ledger.filter(entry => entry.kind === 'attempt' && entry.stageId === 'implement');
    expect(changes).toEqual([expect.objectContaining({ files: [expect.objectContaining({ path: 'value.txt', content: expect.objectContaining({ sha256: expect.any(String) }) })] })]);
  });

  it('does not infer identity or trigger repairs from invalid readings, and never retries a suite at a gate', async () => {
    const result = await fixture({ baseRed: true, invalidReading: true });
    expect(result.final.status).toBe('failed');
    expect(result.executions).toHaveLength(2); expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review']);
    expect(result.validations[0].failures).toEqual([expect.objectContaining({ identifier: null, classification: 'unknown' })]);
    expect(result.validations[0].pass).toBe(false);
    const settlement = await settleGateValidationEvidence(result.target, result.final.runId, 'review', { runCommand: () => { throw new Error('decision reran the suite'); } });
    expect(settlement.kind).toBe('refused'); expect(result.executions).toHaveLength(2);
  });

  it.each([false, true])('does not certify source changed by validation, or repair an evidence gap (base red=%s)', async baseRed => {
    const result = await fixture({ mutateValidation: true, baseRed });
    expect(result.final.status).toBe('failed'); expect(result.executions).toHaveLength(baseRed ? 2 : 1);
    expect(result.validations[0].failures.every(failure => failure.classification === 'unknown')).toBe(true);
    expect(result.validations[0].delta.every(entry => entry.state === 'unresolved')).toBe(true);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review']);
  });

  it('rejects a stale receipt after a later source write without rerunning validation', async () => {
    const result = await fixture(); const before = result.executions.length;
    writeFileSync(join(result.target, 'value.txt'), 'later write\n');
    expect(gateValidationRefusal(result.target, result.final.runId, 'review')?.refusal?.kind).toBe('validation_unresolved');
    expect(readGateEvaluation(result.target, 'review', result.final.runId)?.refusal?.kind).toBe('validation_unresolved');
    expect(result.executions).toHaveLength(before);
  });

  it.each([undefined, 99])('retains unsupported validation receipts for audit without trusting or rerunning them (version=%j)', async validationVersion => {
    const result = await fixture({ baseRed: true });
    const legacy = readEvidence(result.rd).map(fact => fact.kind === 'validation' ? { ...fact, validationVersion } : fact);
    writeFileSync(join(result.rd, 'evidence-ledger.jsonl'), legacy.map(fact => JSON.stringify(fact)).join('\n') + '\n');
    expect(readEvidence(result.rd).some(fact => fact.kind === 'validation')).toBe(true);
    expect(gateValidationRefusal(result.target, result.final.runId, 'review')?.refusal?.kind).toBe('validation_unresolved');
    await recordAttemptValidation(result.target, result.final.runId, 'implement', { runCommand: () => { throw new Error('old receipt reran its suite'); } });
    expect(readFileSync(join(result.root, 'executions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('validates separate attempts on an unchanged tree instead of reusing a result by tree hash', async () => {
    const result = await fixture({ unchanged: true, rejectFirstReview: true });
    expect(result.final.status).toBe('complete'); expect(result.validations).toHaveLength(2);
    expect(result.executions).toHaveLength(2);
    expect(result.validations[0].treeHash).toBe(result.validations[1].treeHash);
    // Re-reading one already-recorded attempt is idempotent, never a third suite.
    await recordAttemptValidation(result.target, result.final.runId, 'repair', { runCommand: () => { throw new Error('duplicate suite'); } });
    expect(readEvidence(result.rd).filter(entry => entry.kind === 'validation')).toHaveLength(2);
  });
});
