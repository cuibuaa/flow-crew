import { runRecordPath } from '../src/run-layout.js';
import { withConfirmedRejections } from './test-support/confirmed-rejection.js';
import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it } from 'vitest';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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


async function fixture(options: { noValidation?: boolean; nativeCommands?: boolean; baseRed?: boolean; introduce?: boolean; invalidReading?: boolean;
  rejectFirstReview?: boolean; returnToFirstTree?: boolean; mutateValidation?: boolean; unchanged?: boolean; verbose?: boolean; input?: 'introduced' | 'mixed'; readonlyInput?: boolean } = {}) {
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
  const brief = `---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Deliver the independently reviewed value.\"}]\n${options.input ? 'inputs: [{path: data}]\n' : ''}${validationDeclaration}outputs: [{path: value.txt, on_existing: update}]\n---\n# Goal\nWrite a value.\n\n## Acceptance criteria\n1. Deliver the independently reviewed value.\n`;
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
      if (options.input === 'introduced') writeFileSync(join(target, 'data/value.txt'), 'BAD');
      if (options.input === 'mixed') writeFileSync(join(target, 'data/readme.txt'), 'authored member');
    }
    if (opts.stageId === 'repair') {
      writeFileSync(join(target, 'value.txt'), options.returnToFirstTree ? reviews === 1 ? 'intermediate\n' : 'write 3\n' : options.unchanged ? 'base\n' : 'repaired\n');
      if (options.input === 'introduced') writeFileSync(join(target, 'data/value.txt'), 'GOOD');
    }
    if (opts.stageId === 'review') {
      const criteria = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
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
    return { ...await scripted.run(prompt, role, opts), writes: ['value.txt',
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
    const output = JSON.parse(readFileSync(result.validations[0].recordPath!, 'utf8')).executions[0].commands[0].output;
    expect(output).toBe(command.output);
    expect(output).toContain('earlier bytes omitted');
    expect(Buffer.byteLength(output)).toBeLessThan(command.outputBytes!.stdout + command.outputBytes!.stderr);
    // Unstructured totals remain human evidence; they do not become failure identities.
    expect(command.testsRun).toBeNull();
    expect(command.identityOwner).toBe('unknown');
  });

  it('binds changed ignored inputs and validates their repair once', async () => {
    const result = await fixture({ input: 'introduced' });
    expect(result.final.status).toBe('complete'); expect(result.executions).toHaveLength(2);
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair', 'review']);
    expect(result.executions.map(value => value.input)).toEqual(['BAD', 'GOOD']);
    expect(result.validations.map(value => value.executions[0].commands[0].exitCode)).toEqual([1, 0]);
    expect(result.validations[0].treeHash).not.toBe(result.validations[1].treeHash);
    expect(result.validations[0].failures).toEqual([]);
  });

  it.each([false, true])('retains ignored descendant identity and modes without executing a base tree (readonly=%s)', async readonlyInput => {
    const result = await fixture({ input: 'mixed', readonlyInput });
    expect(result.final.status).toBe('incomplete');
    expect(result.executions.every(value => value.cwd === result.target)).toBe(true);
    expect(result.executions.every(value => value.input === 'BAD' && value.member === 'authored member')).toBe(true);
    expect(result.validations.every(value => value.executions.length === 1)).toBe(true);
    expect(result.validations[0].treeHash).not.toBe(result.baselineTree.hash);
    if (readonlyInput) for (const execution of result.executions) expect(execution).toMatchObject({ inputDirectoryMode: 0o555, inputFileMode: 0o640 });
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
    const result = await fixture({ introduce: true });
    expect(result.final.status).toBe('complete');
    expect(result.calls.map(call => call.stage)).toEqual(['implement', 'review', 'repair', 'review']);
    expect(result.executions).toHaveLength(2);
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

  it('rejects a completed nonzero exit with invalid identity and never retries a suite at a gate', async () => {
    const result = await fixture({ baseRed: true, invalidReading: true });
    expect(result.final.status).toBe('incomplete');
    expect(result.executions).toHaveLength(2);
    expect(result.validations.every(value => value.executions.length === 1)).toBe(true);
    expect(result.validations[0].failures).toEqual([]);
    expect(result.validations[0].pass).toBe(false);
    const settlement = await settleGateValidationEvidence(result.target, result.final.runId, 'review', { runCommand: () => { throw new Error('decision reran the suite'); } });
    expect(settlement.kind).toBe('unchanged'); expect(result.executions).toHaveLength(2);
  });

  it.each([false, true])('parks validation when its command changes source, before any review (base red=%s)', async baseRed => {
    const result = await fixture({ mutateValidation: true, baseRed });
    expect(result.final.status).toBe('parked'); expect(result.executions).toHaveLength(1);
    expect(result.validations[0].regressions ?? []).toEqual([]);
    expect(result.validations[0].failures.every(failure => failure.classification === 'unknown')).toBe(true);
    expect(result.validations[0].resourceState).toBe('unfinished');
    expect(result.calls.map(call => call.stage)).toEqual(['implement']);
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
    const result = await fixture();
    const legacy = readEvidence(result.rd).map(fact => fact.kind === 'validation' ? { ...fact, validationVersion } : fact);
    writeFileSync(runRecordPath(result.rd, 'evidence-ledger.jsonl'), legacy.map(fact => JSON.stringify(fact)).join('\n') + '\n');
    expect(readEvidence(result.rd).some(fact => fact.kind === 'validation')).toBe(true);
    expect(gateValidationRefusal(result.target, result.final.runId, 'review')).toBeUndefined();
    await recordAttemptValidation(result.target, result.final.runId, 'implement', { runCommand: () => { throw new Error('old receipt reran its suite'); } });
    expect(readFileSync(join(result.root, 'executions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
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
    expect(result.executions.map(execution => execution.value)).toEqual(['write 3\n', 'intermediate\n']);
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
