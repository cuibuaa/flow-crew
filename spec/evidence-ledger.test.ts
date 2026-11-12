import { runRecordPath } from '../src/run-layout.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it } from 'vitest';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShipSetup } from '../src/cli-ship-setup.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { reviewFacts } from '../src/decision-context.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import type { Adapter, RunOpts } from '../src/adapters/base.js';
import { fcGlobalDir, runDir } from '../src/store.js';
import { captureProjectTree, readEvidence, VALIDATION_FACT_VERSION, type ValidationFact } from '../src/evidence-ledger.js';
import { readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { gateValidationRefusal, currentValidationResults, recordAttemptValidation, settleGateValidationEvidence } from '../src/scheduler/sched_settlement/gate-validation.js';
import { runProjectCommand } from '../src/project-validation.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  for (const leaf of ['source/data', 'target/data']) if (existsSync(join(root, leaf))) chmodSync(join(root, leaf), 0o700);
  rmSync(root, { recursive: true, force: true });
} });
const engine = resolve(import.meta.dirname, '..');


async function fixture(options: { requestBase?: boolean; noValidation?: boolean; nativeCommands?: boolean; baseRed?: boolean; introduce?: boolean; invalidReading?: boolean;
  rejectFirstReview?: boolean; returnToFirstTree?: boolean; mutateValidation?: boolean; unchanged?: boolean; verbose?: boolean; suiteError?: 'suite' | 'diagnostic' | 'unhandled'; input?: 'introduced' | 'mixed'; readonlyInput?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ledger-spec-')); roots.push(root);
  const source = join(root, 'source'), target = join(root, 'target'); mkdirSync(source);
  const counter = join(root, 'executions.jsonl');
  const git = (...args: string[]) => isolatedProjectCommand('git', args, source, root);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(source, 'value.txt'), 'base\n');
  writeFileSync(join(source, 'check.mjs'), `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(counter)},JSON.stringify({cwd:process.cwd(),value:fs.readFileSync('value.txt','utf8')})+'\\n');
const fail=${Boolean(options.baseRed)}||fs.readFileSync('value.txt','utf8').startsWith('introduced')||${Boolean(options.returnToFirstTree)}&&fs.readFileSync('value.txt','utf8')==='intermediate\\n';
${options.mutateValidation ? "fs.writeFileSync('value.txt','changed by validation\\n');" : ''}
console.log(JSON.stringify({complete:true,numTotalTests:1,numFailedTests:fail?1:0,numPassedTests:fail?0:1,testResults:[{name:'case.test',assertionResults:[{fullName:'fixture test',status:fail?'failed':'passed'}]}]}));process.exitCode=fail?1:0;`);
  if (options.invalidReading) writeFileSync(join(source, 'check.mjs'), `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(counter)},JSON.stringify({cwd:process.cwd(),value:fs.readFileSync('value.txt','utf8')})+'\\n');console.log('{invalid');process.exitCode=1;`);
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
  const validationDeclaration = options.noValidation ? '' : `validation:\n  commands:\n    test:\n      command: ${JSON.stringify(process.execPath)}\n      args: [check.mjs]\n${!options.verbose && !options.noValidation ? '      report: {format: vitest-json}\n' : ''}`;
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
      writeFileSync(join(target, 'value.txt'), options.returnToFirstTree ? reviews === 1 ? 'intermediate\n' : 'write 3\n' : options.unchanged ? 'base\n' : 'repaired\n');
      if (options.input === 'introduced') writeFileSync(join(target, 'data/value.txt'), 'GOOD');
    }
    if (opts.stageId === 'review') {
      const criteria = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
      if (options.requestBase && !prompt.startsWith('# Requested base evidence')) {
        const fact = readEvidence(opts.runDir).filter((entry): entry is typeof entry & ValidationFact => entry.kind === 'validation').at(-1)!;
        const failed = fact.executions[0].commands.filter(command => command.exitCode !== 0);
        if (failed.length && !fact.baseRequest) return { output: JSON.stringify({ pass: true, reason: 'Need base evidence to settle the failure',
          criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: 'pass', evidence: 'Pending comparison' }])),
          audit_findings: { version: 1, findings: [] }, validation_review: { commands: [], request_base: failed.map(command => ({ role: command.role, display: command.display })) } }),
          exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      reviews++;
      const defect = options.input === 'introduced' ? readFileSync(join(target, 'data/value.txt'), 'utf8') !== 'GOOD'
        : options.introduce ? readFileSync(join(target, 'value.txt'), 'utf8').startsWith('introduced') : false;
      let reproduction: number | undefined;
      if (defect) {
        const predicate = options.input === 'introduced'
          ? "require('node:fs').readFileSync('data/value.txt','utf8')!=='GOOD'"
          : "require('node:fs').readFileSync('value.txt','utf8').startsWith('introduced')";
        const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.exit(${predicate}?1:0)`)}`;
        const client = prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
        const request = JSON.stringify({ command, cwd: target, shell: '/bin/sh' });
        const probe = await runProjectCommand({ role: 'test', command: '/bin/sh',
          args: ['-c', `${client} '${request.replaceAll("'", "'\\''")}'`], display: 'Value reproduction', cwd: target, timeoutMs: 5000 });
        expect(probe.exitCode).toBe(0);
        const record = JSON.parse(probe.stdout!).record;
        expect(record.exitCode).toBe(1); reproduction = record.sequence;
      }
      const pass = !defect && (options.returnToFirstTree ? reviews > 2 : !options.rejectFirstReview || reviews > 1);
      return { output: JSON.stringify({ pass, reason: pass ? 'Independent acceptance.' : 'Check the value again.',
        criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: pass ? 'pass' : 'fail', evidence: 'value.txt' }])),
        audit_findings: { version: 1, findings: defect ? [{ id: 'value', paths: [options.input ? 'data/value.txt' : 'value.txt'], reason: 'Value predicate reproduced', criterion_ids: [], invalidates_plan: false, repair_role: 'coder', reproduction }] : [] },
        ...(!pass ? { repairability: { version: 1, disposition: 'repairable', evidence: 'value.txt' } } : {}) }),
        exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured', tokens_in: 1, tokens_out: 1 };
    }
    return { ...await scripted.run(prompt, role, opts), writes: ['value.txt', ...(options.suiteError ? [options.suiteError === 'suite' ? 'load.test.mjs' : options.suiteError === 'diagnostic' ? 'extra.diagnostic' : 'background.test.mjs'] : []),
      ...(options.input === 'introduced' ? ['data/value.txt'] : options.input === 'mixed' ? ['data/readme.txt'] : [])], writeAttribution: 'structured', tokens_in: 1, tokens_out: 1,
      sessionId: '12345678-1234-4234-8234-123456789abc' };
  } };
  const { config, raw } = loadWorkflow(join(engine, 'config/workflows/direct.yaml')); config.defaults.max_iterations = 1;
  const final = await runWorkflow(config, raw, target, withConfirmedRejections(adapter), new Map(), undefined, join(engine, 'config/agents'), undefined, brief, true);
  const rd = runDir(target, final.runId), ledger = readEvidence(rd);
  // Base evidence appends a supplement; expose the latest fact for each judged tree.
  const validations = [...new Map(ledger.filter((entry): entry is ValidationFact & typeof entry => entry.kind === 'validation').map(fact => [fact.treeHash, fact])).values()];
  const executions = existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { cwd: string; value: string; input?: string; member?: string; inputDirectoryMode?: number; inputFileMode?: number }) : [];
  return { root, target, final, rd, ledger, validations, calls, executions, writes, baselineTree };
}

describe('one evidence lifecycle through the real scheduler and scripted adapter', () => {
  it('retains a bounded configured command log and raw byte counts, without another validation', async () => {
    const result = await fixture({ verbose: true });
    expect(result.final.status, result.final.failureReason).toBe('complete');
    expect(result.executions).toHaveLength(1);
    expect(result.validations).toHaveLength(1);
    const [command] = result.validations[0].executions[0].commands;
    expect(command.exitCode).toBe(0);
    expect(Buffer.byteLength(command.output)).toBeLessThanOrEqual(25 * 1024);
    const output = readFileSync(runRecordPath(result.rd, command.outputPath!), 'utf8');
    expect(output).toBe(command.output);
    expect(output).toContain('earlier bytes omitted');
    expect(Buffer.byteLength(output)).toBeLessThan(command.outputBytes!.stdout + command.outputBytes!.stderr);
    // Unstructured totals remain human evidence; they do not become failure identities.
    expect(command.testsRun).toBeNull();
    expect(command.identityOwner).toBe('unknown');
  });

  it.each(['suite', 'diagnostic', 'unhandled'] as const)('uses structured identity while retaining unrepresented native Vitest %s failures as unknown', async suiteError => {
    const result = await fixture({ suiteError, requestBase: true });
    expect(result.final.status).toBe('complete'); expect(result.executions, JSON.stringify({ validations: result.validations, calls: result.calls.map(call => call.stage) })).toHaveLength(4);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review', 'review']);
    const [fact] = result.validations; expect(fact.pass).toBe(false);
    for (const execution of fact.executions) expect(execution.treeAfterHash).toBe(execution.treeHash);
    expect(fact.executions[0].commands[0]).toMatchObject({ exitCode: 1, failureEvidence: suiteError === 'diagnostic' ? 'complete' : 'partial', identityOwner: 'runner-json', testsRun: suiteError === 'unhandled' ? 2 : 1 });
    expect(fact.executions[3].commands[0]).toMatchObject({ exitCode: 1, failureEvidence: suiteError === 'unhandled' ? 'partial' : 'complete', identityOwner: 'runner-json' });
    expect(fact.executions[3].commands[0].outputBytes?.stderr).toBe(0);
    expect(fact.executions.map(execution => [execution.target, execution.rerun])).toEqual([['attempt', undefined], ['attempt', true], ['base', true], ['base', undefined]]);
    if (suiteError === 'diagnostic') expect(fact.executions[0].commands[0].outputBytes!.stderr).toBeGreaterThan(0);
    expect(fact.delta.find(value => value.role === 'test')?.state).toBe('unverified');
    expect(fact.failures).toEqual([]);
  });

  it('compares a changed ignored input with its pre-author bytes and enforces introduction before repair', async () => {
    const result = await fixture({ input: 'introduced', requestBase: true });
    expect(result.final.status).toBe('complete'); expect(result.executions).toHaveLength(6);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review', 'review', 'repair', 'review']);
    expect(result.executions.map(value => value.input)).toEqual(['BAD', 'BAD', 'GOOD', 'GOOD', 'GOOD', 'GOOD']);
    expect(result.validations[0].executions.map(value => value.commands[0].exitCode)).toEqual([1, 1, 0, 0]);
    expect(result.validations[0].executions[2].treeHash).toBe(result.baselineTree.hash);
    expect(result.validations[0].failures).toEqual([]);
    expect(result.validations[0].baseInputSnapshot).toMatchObject({ bytes: 4, files: 2, manifestSha256: expect.any(String) });
  });

  it.each([false, true])('restores ignored descendants and modes without replacing base tracked source or repairing a pre-existing failure (readonly=%s)', async readonlyInput => {
    const result = await fixture({ input: 'mixed', readonlyInput, requestBase: true });
    expect(result.final.status).toBe('complete'); expect(result.executions, JSON.stringify({ validations: result.validations, calls: result.calls.map(call => call.stage) })).toHaveLength(4);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review', 'review']);
    expect(result.executions.map(value => value.input)).toEqual(['BAD', 'BAD', 'BAD', 'BAD']);
    expect(result.executions.map(value => value.member)).toEqual(['authored member', 'authored member', 'committed member', 'committed member']);
    expect(result.validations[0].executions.map(value => value.commands[0].exitCode)).toEqual([1, 1, 1, 1]);
    expect(result.validations[0].executions[2].treeHash).toBe(result.baselineTree.hash);
    expect(result.validations[0].failures).toEqual([]);
    expect(result.validations[0].baseInputSnapshot).toMatchObject({ bytes: 3, files: 2 });
    if (readonlyInput) for (const execution of result.executions) expect(execution).toMatchObject({ inputDirectoryMode: 0o555, inputFileMode: 0o640 });
  });

  it('records the batch, alone confirmation and requested base after three writes; pre-existing alone never repairs', async () => {
    const result = await fixture({ baseRed: true, requestBase: true });
    expect(result.final.status).toBe('complete'); expect(result.writes).toBe(3);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review', 'review']);
    expect(result.executions, JSON.stringify({ validations: result.validations, calls: result.calls.map(call => call.stage) })).toHaveLength(4);
    expect(result.executions[0]).toMatchObject({ cwd: result.target, value: 'write 3\n' });
    expect(result.executions[1]).toMatchObject({ cwd: result.target, value: 'write 3\n' });
    for (const execution of result.executions.slice(2)) {
      expect(execution.cwd).not.toBe(result.target); expect(execution.value).toBe('base\n');
      expect(existsSync(execution.cwd)).toBe(false);
    }
    expect(result.validations).toHaveLength(1);
    const [validation] = result.validations;
    expect(validation.validationVersion).toBe(VALIDATION_FACT_VERSION);
    expect(validation.failures).toEqual([]);
    expect(validation.executions.map(execution => [execution.target, execution.rerun])).toEqual([['attempt', undefined], ['attempt', true], ['base', true], ['base', undefined]]);
    expect(validation.executions[2].treeHash).toBe(result.baselineTree.hash);
    expect(validation.regressions ?? []).toEqual([]);
    for (const execution of validation.executions) {
      expect(execution.treeHash).toMatch(/^[a-f0-9]{64}$/); expect(execution.treeAfterHash).toBe(execution.treeHash);
      expect(execution.commands).toEqual([expect.objectContaining({ exitCode: 1, testsRun: 1, identityOwner: 'runner-json' })]);
    }
    expect(validation.pass).toBe(false);
  });

  it('records observed work without empty validation facts or receipts when no suite is configured', async () => {
    const result = await fixture({ noValidation: true });
    expect(result.final.status, result.final.failureReason).toBe('complete');
    expect(result.executions).toEqual([]); expect(result.validations).toEqual([]);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review']);
    expect(result.ledger.some(fact => fact.kind === 'attempt')).toBe(true);
    expect(existsSync(runRecordPath(result.rd, 'validation_delta_review.json'))).toBe(false);
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
    expect(result.final.status, result.final.failureReason).toBe('complete'); expect(result.executions).toHaveLength(1);
    expect(result.validations[0].treeHash).toBe(result.baselineTree.hash);
    expect(result.validations[0].executions).toHaveLength(1);
  });

  it('takes an introduced failure to an independent gate and validates the repair once before a fresh re-review', async () => {
    setEngineDefaults({ session_reuse: true });
    const result = await fixture({ introduce: true, requestBase: true });
    expect(result.final.status).toBe('complete');
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review', 'review', 'repair', 'review']);
    expect(result.executions).toHaveLength(6);
    expect(result.validations.map(value => value.stageId)).toEqual(['implement', 'repair']);
    expect(result.validations[0].failures).toEqual([]);
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
    const evidenceRoot = runRecordPath(result.rd, 'stage_evidence');
    const patches = readdirSync(evidenceRoot, { recursive: true }).filter(path => String(path).endsWith('/change.diff'))
      .map(path => ({ path: join(evidenceRoot, String(path)), bytes: readFileSync(join(evidenceRoot, String(path)), 'utf8') }));
    const reviewedPatch = patches.find(patch => patch.bytes.includes('+introduced 3'));
    expect(reviewedPatch, 'the first review diff survives repair and re-review').toBeDefined();
    expect(firstReview.prompt).toContain(reviewedPatch!.path);
    expect(patches.some(patch => patch.bytes.includes('+repaired'))).toBe(true);
    expect(firstReview.schema).toHaveProperty('anyOf');
    expect(result.calls[0].schema?.properties).not.toHaveProperty('checks');
    expect(result.calls[0].schema?.properties).not.toHaveProperty('files_modified');
    const ledgerText = readFileSync(runRecordPath(result.rd, 'evidence-ledger.jsonl'), 'utf8');
    expect(ledgerText).toContain('AUTHOR_TRANSCRIPT_SENTINEL');
    const ownRecord = result.ledger.find(entry => entry.kind === 'attempt' && entry.stageId === 'implement');
    expect(ownRecord?.kind === 'attempt' && ownRecord.finalRecord?.summary).toBe('AUTHOR_TRANSCRIPT_SENTINEL');
    const changes = result.ledger.filter(entry => entry.kind === 'attempt' && entry.stageId === 'implement');
    expect(changes).toEqual([expect.objectContaining({ files: [expect.objectContaining({ path: 'value.txt', content: expect.objectContaining({ sha256: expect.any(String) }) })] })]);
  });

  it('does not infer identity or trigger repairs from invalid readings, and never retries a suite at a gate', async () => {
    const result = await fixture({ baseRed: true, invalidReading: true });
    expect(result.final.status).toBe('complete');
    expect(result.executions, JSON.stringify({ validations: result.validations, calls: result.calls.map(call => call.stage) })).toHaveLength(3); expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review']);
    expect(result.validations[0].failures).toEqual([]);
    expect(result.validations[0].pass).toBe(false);
    const settlement = await settleGateValidationEvidence(result.target, result.final.runId, 'review', { runCommand: () => { throw new Error('decision reran the suite'); } });
    expect(settlement.kind).toBe('unchanged'); expect(result.executions).toHaveLength(3);
  });

  it.each([false, true])('invalidates validation when source changes and lets the independent gate judge the stated gap (base red=%s)', async baseRed => {
    const result = await fixture({ mutateValidation: true, baseRed });
    expect(result.final.status).toBe('complete'); expect(result.executions).toHaveLength(baseRed ? 3 : 1);
    expect(result.validations[0].regressions ?? []).toEqual([]);
    expect(result.validations[0].failures.every(failure => failure.classification === 'unknown')).toBe(true);
    expect(result.final.validation?.every(entry => entry.measurement === 'unverified')).toBe(true);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review']);
  });

  it('rejects a stale receipt after a later source write without rerunning validation', async () => {
    const result = await fixture(); const before = result.executions.length;
    writeFileSync(join(result.target, 'value.txt'), 'later write\n');
    expect(gateValidationRefusal(result.target, result.final.runId, 'review')).toBeUndefined();
    expect(currentValidationResults(result.target, result.final.runId)).toEqual([expect.objectContaining({ exitCode: null, state: 'unverified' })]);
    expect(readGateEvaluation(result.target, 'review', result.final.runId)?.pass).toBe(true);
    expect(result.executions).toHaveLength(before);
  });

  it.each([undefined, 99])('retains unsupported validation receipts for audit without trusting or rerunning them (version=%j)', async validationVersion => {
    const result = await fixture({ baseRed: true });
    const legacy = readEvidence(result.rd).map(fact => fact.kind === 'validation' ? { ...fact, validationVersion } : fact);
    writeFileSync(runRecordPath(result.rd, 'evidence-ledger.jsonl'), legacy.map(fact => JSON.stringify(fact)).join('\n') + '\n');
    expect(readEvidence(result.rd).some(fact => fact.kind === 'validation')).toBe(true);
    expect(gateValidationRefusal(result.target, result.final.runId, 'review')).toBeUndefined();
    await recordAttemptValidation(result.target, result.final.runId, 'implement', { runCommand: () => { throw new Error('old receipt reran its suite'); } });
    expect(readFileSync(join(result.root, 'executions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('reuses a tree-bound fact on an unchanged tree without repeating uncertain or passing evidence', async () => {
    const result = await fixture({ unchanged: true, rejectFirstReview: true });
    expect(result.final.status).toBe('complete'); expect(result.validations).toHaveLength(1);
    expect(result.executions).toHaveLength(1);
    // Re-reading one already-recorded attempt is idempotent, never a third suite.
    await recordAttemptValidation(result.target, result.final.runId, 'repair', { runCommand: () => { throw new Error('duplicate suite'); } });
    expect(readEvidence(result.rd).filter(entry => entry.kind === 'validation')).toHaveLength(1);
  });

  it('returns to an earlier measured tree without rerunning it or consuming the later different tree receipt', async () => {
    const result = await fixture({ returnToFirstTree: true });
    expect(result.final.status, JSON.stringify(result.final.stages.review.gate)).toBe('complete');
    expect(result.executions.map(execution => execution.value)).toEqual(['write 3\n', 'intermediate\n', 'intermediate\n', 'base\n', 'write 3\n']);
    expect(result.validations).toHaveLength(2);
    const [first, later] = result.validations;
    expect(first.treeHash).not.toBe(later.treeHash);
    expect(later.delta[0].state).toBe('unverified');
    const input = result.calls.filter(call => call.stage === 'review').at(-1)!.prompt;
    const facts = JSON.parse(input.split('Ledger facts:\n')[1].split('\nValidation command selection')[0]).facts;
    expect(facts.filter((fact: { kind: string }) => fact.kind === 'validation').map((fact: { sequence: number }) => fact.sequence)).toEqual([first.sequence]);
    expect(JSON.parse(readFileSync(runRecordPath(result.rd, 'validation_delta_review.json'), 'utf8')).ledgerSequence).toBe(first.sequence);
    expect(reviewFacts(result.target, result.rd, result.final).validation).toMatchObject({ sequence: first.sequence, pass: true });

  });
});
