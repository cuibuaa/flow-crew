import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { engineValidation } from '../src/engine-validation.js';
import { runProjectCommand, projectValidationResult, parseBriefValidationCommands, parseValidationCommands, type ValidationCommand } from '../src/project-validation.js';
import * as validationOwner from '../src/project-validation.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { runDir, fcGlobalDir, readStageStatus } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import * as evidenceOwner from '../src/evidence-ledger.js';
import { captureProjectTree, projectValidationFact, validationBatch, readEvidence, type ValidationFact } from '../src/evidence-ledger.js';
import { WorkflowConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() { const root = mkdtempSync(join(tmpdir(), 'validation-owner-')); roots.push(root); return root; }
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(code = 0, output = '') {
  const root = project(), counter = join(root, 'count');
  writeFileSync(join(root, 'check.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(counter)},'x');console.log(${JSON.stringify(output)});process.exit(${code});`);
  const commands: ValidationCommand[] = [{ role: 'test', command: process.execPath, args: ['check.cjs'], display: 'declared check' }];
  const treeHash = createHash('sha256').update(root).digest('hex');
  return { root, counter, input: { projectDir: root, treeHash, commands, treeAfter: () => treeHash } };
}

describe('engine validation ownership', () => {
  it('engine-runs-it: refuses changed queued content before any command can restore its requested hash', async () => {
    const holder = fixture(), root = project(), counter = join(project(), 'observations');
    writeFileSync(join(root, 'value'), 'bad');
    writeFileSync(join(root, 'check.cjs'), `const fs=require('node:fs'),v=fs.readFileSync('value','utf8');fs.appendFileSync(${JSON.stringify(counter)},v);fs.writeFileSync('value','bad');process.exit(v==='good'?0:7);`);
    const treeHash = captureProjectTree(root).hash!;
    const command = { role: 'test', command: process.execPath, args: ['check.cjs'], display: 'chosen exit' };
    expect((await runProjectCommand({ ...command, cwd: root })).exitCode).toBe(7);
    const entered = deferred(), release = deferred();
    const first = engineValidation({ ...holder.input, runCommand: async request => { entered.resolve(); await release.promise; return runProjectCommand(request); } });
    await entered.promise;
    const pending = engineValidation({ projectDir: root, treeHash, commands: [command], treeAfter: () => captureProjectTree(root).hash });
    writeFileSync(join(root, 'value'), 'good'); release.resolve();
    const [, record] = await Promise.all([first, pending]);
    expect(record.resourceState).toBe('unfinished'); expect(record.executions).toEqual([]);
    expect(readFileSync(counter, 'utf8')).toBe('bad'); expect(readFileSync(join(root, 'value'), 'utf8')).toBe('good');
  });

  it('review-reads-record: legacy confirmations never replace the primary configured batch', () => {
    const command = (role: string, exitCode: number) => ({ role, display: role, command: role, args: [], exitCode, durationMs: 1, output: '', state: 'unverified' as const, failureIdentifiers: [], failureIdentity: 'unknown' as const });
    const execution = (commands: ReturnType<typeof command>[]) => ({ target: 'attempt' as const, cwd: '/workspace', treeHash: 'tree', treeAfterHash: 'tree', commands });
    const primary = execution([command('build', 0), command('test', 1), command('lint', 0)]);
    const fact: ValidationFact = { kind: 'validation', validationVersion: 3, stageId: 'author', attemptIndex: 1, attemptStartedAt: 'start', treeHash: 'tree',
      executions: [primary, { ...execution([command('test', 0)]), rerun: true }], delta: [], failures: [], pass: false };
    const projected = projectValidationFact(fact);
    expect(projected.pass).toBe(false);
    expect(projected.delta.map(result => [result.role, result.state])).toEqual([['build', 'verified'], ['test', 'unverified'], ['lint', 'verified']]);
    expect(validationBatch(projected)?.commands.map(result => result.exitCode)).toEqual([0, 1, 0]);
    expect(projectValidationFact({ ...fact, executions: [execution([command('test', 1)]), fact.executions[1]] }).pass).toBe(false);
    expect(projectValidationFact({ ...fact, validationVersion: 4 }).pass).toBe(true);
  });
  it('once-per-tree: joins simultaneous requests and reuses a completed record across owners', async () => {
    const f = fixture();
    const entered = deferred(), release = deferred(); let calls = 0;
    const runCommand = async (request: Parameters<typeof runProjectCommand>[0]) => { calls++; entered.resolve(); await release.promise; return runProjectCommand(request); };
    const first = engineValidation({ ...f.input, runCommand }); await entered.promise;
    const second = engineValidation({ ...f.input, runCommand }); release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b); expect(calls).toBe(1); expect(readFileSync(f.counter, 'utf8')).toBe('x');
    const third = await engineValidation({ ...f.input, runCommand: () => { throw Error('completed tree executed again'); } });
    expect(third).toEqual(a); expect(third.resourceState).toBe('complete');
  });

  it.each([0, 7])('exit-code-only: exit %s decides despite contradictory output and report diagnostics', async code => {
    const f = fixture(code, code === 0 ? '0 tests passed; ALL FAILED; timeout' : '999 tests passed; success');
    const record = await engineValidation({ ...f.input, runCommand: async request => ({ ...await runProjectCommand(request),
      error: 'arbitrary auxiliary diagnostic', reportError: 'invalid totals', dependencyPreparationFailed: true }) });
    expect(record.resourceState).toBe('complete'); expect(record.pass).toBe(code === 0);
    expect(record.executions).toHaveLength(1); expect(readFileSync(f.counter, 'utf8')).toBe('x');
    expect(projectValidationResult(record.executions[0].commands[0]).state).toBe(code === 0 ? 'passed' : 'failed');
  });

  it('unfinished-is-resource-state: retries an injected interruption, then caches the completed nonzero exit', async () => {
    const f = fixture(3); let calls = 0;
    const record = await engineValidation({ ...f.input, runCommand: request => ++calls === 1
      ? { exitCode: 0, unfinished: true, stdout: 'all passed' } : runProjectCommand(request) });
    expect(calls).toBe(2); expect(record.resourceState).toBe('complete'); expect(record.pass).toBe(false);
    expect(record.executions.map(execution => execution.commands[0].exitCode)).toEqual([0, 3]);
    expect(readFileSync(f.counter, 'utf8')).toBe('x');
    await engineValidation({ ...f.input, runCommand: () => { throw Error('nonzero completed record rerun'); } });
  });

  it.skipIf(process.platform !== 'linux').each(['KILL', 'PIPE', 'XFSZ', 'TERM'])('unfinished-is-resource-state: SIG%s stays unfinished through the declared resource allowance', async name => {
    const f = fixture(); setEngineDefaults({ validation_attempts: 3 });
    f.input.commands[0] = { role: 'test', command: '/bin/sh', args: ['-c', `printf x >> "$1"; kill -s ${name} $$`, 'declared-check', f.counter], display: 'declared check' };
    const record = await engineValidation(f.input);
    expect(record.resourceState).toBe('unfinished'); expect(record.pass).toBe(false);
    expect(record.executions).toHaveLength(3);
    expect(record.executions.map(execution => execution.commands[0])).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ exitCode: null, unfinished: true })));
    expect(readFileSync(f.counter, 'utf8')).toBe('xxx');
    const resumed = await engineValidation({ ...f.input, runCommand: () => { throw Error('exhausted allowance executed again'); } });
    expect(resumed).toEqual(record);
  });

  it('bounded-concurrency: uses one FIFO across independent owners, skips duplicate waiters, and removes cancellation', async () => {
    setEngineDefaults({ validation_concurrency: 1 });
    const fixtures = [fixture(), fixture(), fixture(), fixture()];
    const releases = fixtures.map(() => deferred()), entered = fixtures.map(() => deferred());
    const order: number[] = []; let active = 0, peak = 0;
    const request = (index: number, abortSignal?: AbortSignal) => engineValidation({ ...fixtures[index].input, abortSignal,
      runCommand: async command => { order.push(index); peak = Math.max(peak, ++active); entered[index].resolve();
        await releases[index].promise; try { return await runProjectCommand(command); } finally { active--; } } });
    const first = request(0); await entered[0].promise;
    const duplicate = request(0);
    const second = request(1), control = new AbortController(), cancelled = request(2, control.signal), fourth = request(3);
    control.abort(); await cancelled;
    releases[0].resolve(); await entered[1].promise; expect(order).toEqual([0, 1]);
    releases[1].resolve(); await entered[3].promise; releases[3].resolve();
    await Promise.all([first, duplicate, second, fourth]);
    expect(order).toEqual([0, 1, 3]); expect(peak).toBe(1);
    expect(existsSync(fixtures[2].counter)).toBe(false);
    expect(JSON.parse(readFileSync(join(fcGlobalDir(), 'validation/queue.json'), 'utf8')).tickets).toEqual([]);
  });

  it('bounded-concurrency: admits the configured number of distinct trees', async () => {
    setEngineDefaults({ validation_concurrency: 2 });
    const a = fixture(), b = fixture(), entered = deferred(), release = deferred(); let active = 0;
    const runCommand = async (command: Parameters<typeof runProjectCommand>[0]) => { if (++active === 2) entered.resolve(); await release.promise; return runProjectCommand(command); };
    const requests = [engineValidation({ ...a.input, runCommand }), engineValidation({ ...b.input, runCommand })];
    await entered.promise; expect(active).toBe(2); release.resolve(); await Promise.all(requests);
  });
});

function verdict(directory: string) {
  const criteria = JSON.parse(readFileSync(runRecordPath(directory, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
  const record = readEvidence(directory).filter(entry => entry.kind === 'validation').at(-1)!;
  return { pass: true, reason: `Independent review cites engine evidence-ledger.jsonl sequence ${record.sequence}`,
    criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: 'pass', evidence: `Engine record ${record.sequence} and independent value inspection` }])),
    audit_findings: { version: 1, findings: [] } };
}
async function engineering(root: string, adapter: Parameters<typeof runWorkflow>[3], existing?: string) {
  const { config, raw } = loadWorkflow(resolve('config/workflows/direct.yaml'));
  const brief = '---\ncriteria: [{id: value, text: Deliver a reviewed value}]\noutputs: [value.txt]\n---\nDeliver the value.';
  return runWorkflow(config, raw, root, adapter, new Map(), undefined, resolve('config/agents'), existing, brief, true);
}
function projectValidation(root: string) {
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'identity.txt'), root);
  writeFileSync(join(root, 'check.cjs'), "const fs=require('node:fs');process.exit(fs.readFileSync('value.txt','utf8')==='good'?0:9);");
  writeFileSync(join(root, 'config/validation.json'), JSON.stringify({ commands: { test: { command: process.execPath, args: ['check.cjs'] } } }));
}

describe('scheduler owns validation after author settlement', () => {
  it('engine-runs-it: terminal hook writes cannot inherit acceptance from the author tree', async () => {
    const root = project(); projectValidation(root);
    const config = WorkflowConfigSchema.parse({ name: 'terminal-hook', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{ id: 'author', role: 'coder', scope: ['value.txt'] }] });
    const brief = '---\noutputs: [value.txt]\nreality_checks:\n  - name: finalize\n    type: exec-script-exit-zero\n    reads: []\n    params: {script: "printf bad > value.txt"}\n---\nDeliver value.';
    const final = await runWorkflow(config, JSON.stringify(config), root, { async run() {
      writeFileSync(join(root, 'value.txt'), 'good');
      return { output: JSON.stringify({ status: 'delivered', summary: 'Done', caveats: [], remaining_work: [] }),
        exitCode: 0, duration_ms: 1, writes: ['value.txt'], writeAttribution: 'structured' };
    } }, new Map(), undefined, resolve('config/agents'), undefined, brief, true);
    expect(final.realityGate?.pass).toBe(true);
    expect(readFileSync(join(root, 'value.txt'), 'utf8')).toBe('bad');
    expect(final.status).toBe('incomplete'); expect(final.reasonCode).toBe('validation_unresolved');
    expect(final.validation?.map(command => command.exitCode)).toEqual([null]);
    const records = readEvidence(runDir(root, final.runId)).filter(entry => entry.kind === 'validation');
    expect(records).toHaveLength(1); expect(records[0].pass).toBe(true);
    expect(records[0].treeHash).not.toBe(captureProjectTree(root, brief, runDir(root, final.runId)).hash);
  });

  it.each([false, true])('exit-code-only: refuses terminal acceptance for a nonzero final tree (earlier gate=%s)', async earlierGate => {
    const root = project(); projectValidation(root);
    const stages = [{ id: 'author', role: 'coder', scope: ['value.txt'] }, ...(earlierGate ? [
      { id: 'review', role: 'qa', is_gate: true, scope: [], depends_on: ['author'] },
      { id: 'finish', role: 'coder', scope: ['value.txt'], depends_on: ['review'] },
      { id: 'repair', role: 'coder', scope: ['value.txt'], depends_on: ['review'], retry_to: ['review'] },
    ] : [])];
    const config = WorkflowConfigSchema.parse({ name: 'terminal-validation', defaults: { max_iterations: 1, max_retries: 0 }, stages });
    const final = await runWorkflow(config, JSON.stringify(config), root, { async run(_prompt, _role, opts) {
      if (opts.stageId === 'review') return { output: JSON.stringify(verdict(opts.runDir)), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      writeFileSync(join(root, 'value.txt'), earlierGate && opts.stageId === 'author' ? 'good' : 'bad');
      return { output: JSON.stringify({ status: 'delivered', summary: 'Done', caveats: [], remaining_work: [] }), exitCode: 0, duration_ms: 1, writes: ['value.txt'], writeAttribution: 'structured' };
    } }, new Map(), undefined, resolve('config/agents'), undefined, '---\n' + (earlierGate ? 'criteria: [{id: value, text: Deliver a good value}]\n' : '') + 'outputs: [value.txt]\n---\nDeliver value.', true);
    expect(final.status, final.failureReason).toBe('incomplete'); expect(final.reasonCode).toBe('validation_unresolved');
    expect(final.validation?.map(command => command.exitCode)).toEqual([9]);
    expect(readEvidence(runDir(root, final.runId)).filter(entry => entry.kind === 'validation').at(-1)?.pass).toBe(false);
  });

  it('engine-runs-it: covers repair-closure writes before review and never replays the closure at repeated barriers', async () => {
    const root = project(); projectValidation(root); const counter = join(project(), 'closure-count');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const program = `const fs=require('node:fs'),v=fs.readFileSync('value.txt','utf8');if(v==='good'){const p=${JSON.stringify(counter)},n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8'))+1:1;fs.writeFileSync(p,String(n));fs.writeFileSync('stamp.txt',String(n));}process.exit(v==='good'?0:1);`;
    const command = `nice -n 19 ${quote(process.execPath)} -e ${quote(program)}`;
    let reviews = 0;
    const final = await engineering(root, { async run(prompt, _role, opts) {
      if (opts.stageId !== 'review') {
        writeFileSync(join(root, 'value.txt'), opts.stageId === 'repair' ? 'good' : 'bad');
        return { output: JSON.stringify({ status: 'delivered', summary: 'Done', caveats: [], remaining_work: [] }), exitCode: 0, duration_ms: 1, writes: ['value.txt'], writeAttribution: 'structured' };
      }
      const fact = readEvidence(opts.runDir).filter(entry => entry.kind === 'validation').at(-1)!;
      expect(fact.treeHash).toBe(captureProjectTree(root, '', opts.runDir).hash);
      const first = ++reviews === 1;
      let reproduction: number | undefined;
      if (first) {
        const client = prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
        const response = await runProjectCommand({ role: 'test', command: '/bin/sh', args: ['-c', client + ' ' + quote(JSON.stringify({ command, cwd: root, shell: '/bin/sh' }))], display: 'independent reproduction', cwd: root });
        const record = JSON.parse(response.stdout!).record; expect(record.exitCode).toBe(1); reproduction = record.sequence;
      }
      const value = verdict(opts.runDir); value.pass = !first;
      return { output: JSON.stringify({ ...value, ...(first ? { repairability: { version: 1, disposition: 'repairable', evidence: 'Replace bad value' } } : {}),
        audit_findings: { version: 1, findings: first ? [{ id: 'value', paths: ['value.txt'], reason: 'Value should be good', reproduction, criterion_ids: ['value'], invalidates_plan: false, repair_role: 'coder' }] : [] } }),
        exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } });
    expect(reviews).toBe(2); expect(readFileSync(counter, 'utf8')).toBe('1');
    const ledger = readEvidence(runDir(root, final.runId));
    const closure = ledger.find(entry => entry.kind === 'command' && entry.reproductionOf !== undefined)!;
    const validation = ledger.filter(entry => entry.kind === 'validation').at(-1)!;
    expect(closure.sequence).toBeLessThan(validation.sequence); expect(closure.treeAfterHash).toBe(validation.treeHash);
    // A source-writing reproduction cannot itself prove a read-only closure.
    expect(final.status).toBe('incomplete');
  });
  it('engine-runs-it and review-reads-record: author and repair end first; each tree has one execution and independent review consumes it', async () => {
    const root = project(); projectValidation(root); const calls: string[] = [];
    const final = await engineering(root, { async run(prompt, role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'review') {
        const record = readEvidence(opts.runDir).filter(entry => entry.kind === 'validation').at(-1) as ValidationFact;
        expect(record.resourceState).toBe('complete'); expect(record.executions).toHaveLength(1);
        expect(prompt).toContain(record.treeHash!); expect(prompt).toContain('\"recordPath\":' + JSON.stringify(record.recordPath));
        return { output: JSON.stringify(verdict(opts.runDir)), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      expect(role.prompt).toContain('Run only tests related');
      expect(readStageStatus(root, JSON.parse(readFileSync(join(opts.runDir, 'run.json'), 'utf8')).runId, opts.stageId).status).toBe('running');
      writeFileSync(join(root, 'value.txt'), opts.stageId === 'repair' ? 'good' : 'bad');
      return { output: JSON.stringify({ status: 'delivered', summary: 'Code and related tests done', caveats: [], remaining_work: [] }),
        exitCode: 0, duration_ms: 1, writes: ['value.txt'], writeAttribution: 'structured' };
    } });
    expect(final.status).toBe('complete'); expect(calls).toEqual(['implement', 'review', 'repair', 'review']);
    const ledger = readEvidence(runDir(root, final.runId));
    const records = ledger.filter(entry => entry.kind === 'validation');
    expect(records).toHaveLength(2); expect(new Set(records.map(entry => entry.treeHash)).size).toBe(2);
    for (const record of records) {
      expect(record.executions).toHaveLength(1);
      const author = ledger.find(entry => entry.kind === 'attempt' && entry.stageId === record.stageId && entry.attemptIndex === record.attemptIndex)!;
      expect(author.sequence).toBeLessThan(record.sequence);
    }
    expect(final.stages.repair.attempts).toHaveLength(1);
    expect(final.stages.review.gate?.reason).toContain('engine evidence-ledger.jsonl sequence');
    expect(ledger.filter(entry => entry.kind === 'command' && entry.reproductionOf !== undefined)).toEqual([]);
  });

  it('once-per-tree: refuses a different declaration without executing it or reopening the settled author', async () => {
    const root = project(); projectValidation(root); writeFileSync(join(root, 'value.txt'), 'good');
    const calls: string[] = [];
    const adapter: Parameters<typeof engineering>[1] = { async run(_prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'review') return { output: JSON.stringify(verdict(opts.runDir)), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      return { output: JSON.stringify({ status: 'delivered', summary: 'Unchanged value checked', caveats: [], remaining_work: [] }),
        exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } };
    const run = (extra: string) => {
      const { config, raw } = loadWorkflow(resolve('config/workflows/direct.yaml'));
      return runWorkflow(config, raw, root, adapter, new Map(), undefined, resolve('config/agents'), undefined,
        '---\ncriteria: [{id: value, text: Deliver a reviewed value}]\ninputs: [value.txt]\noutputs: [{path: value.txt, on_existing: update}]\n'
        + extra + '---\nDeliver the value.', true);
    };
    const first = await run(''); expect(first.status).toBe('complete');
    calls.length = 0;
    const next = await run('validation: {commands: {lint: {command: '+JSON.stringify(process.execPath)+", args: ['-e', 'process.exit(7)']}}}\n");
    expect(next.status).toBe('failed'); expect(next.failureReason).toContain('VALIDATION_DECLARATION_CONFLICT');
    expect(calls).toEqual(['implement']); expect(next.stages.implement.status).toBe('complete');
    expect(next.stages.implement.attempts).toHaveLength(1);
    expect(readEvidence(runDir(root, next.runId)).filter(entry => entry.kind === 'validation')).toEqual([]);
  });

  it('engine-runs-it: validation keeps its resource allowance after the author clock has expired', async () => {
    const root = project(); projectValidation(root);
    writeFileSync(join(root, 'config/validation.json'), JSON.stringify({ commands: Object.fromEntries(['build', 'test', 'lint'].map(role =>
      [role, { command: process.execPath, args: ['check.cjs'] }])) }));
    const budget = 30_000; let elapsed = 0;
    setEngineDefaults({ default_timeout_ms: budget, validation_timeout_ms: budget, validation_attempts: 1 });
    const clock = { monotonicNow: () => elapsed, wallNow: () => Date.now() + elapsed,
      setTimer: () => ({} as ReturnType<typeof setTimeout>), clearTimer: () => {} };
    vi.spyOn(validationOwner, 'runValidationCommand').mockImplementation(async command => {
      const response = await runProjectCommand(command); elapsed = budget * 2; return response;
    });
    const { config, raw } = loadWorkflow(resolve('config/workflows/direct.yaml'));
    const final = await runWorkflow(config, raw, root, { async run(_prompt, _role, opts) {
      if (opts.stageId === 'review') return { output: JSON.stringify(verdict(opts.runDir)), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      writeFileSync(join(root, 'value.txt'), 'good');
      return { output: JSON.stringify({ status: 'delivered', summary: 'Done', caveats: [], remaining_work: [] }),
        exitCode: 0, duration_ms: 1, writes: ['value.txt'], writeAttribution: 'structured' };
    } }, new Map(), undefined, resolve('config/agents'), undefined,
      '---\ncriteria: [{id: value, text: Deliver a reviewed value}]\noutputs: [value.txt]\n---\nDeliver the value.', true, undefined, true, undefined, () => clock);
    expect(final.status).toBe('complete');
    const record = readEvidence(runDir(root, final.runId)).find(entry => entry.kind === 'validation') as ValidationFact;
    expect(record.executions[0].commands.map(command => command.exitCode)).toEqual([0, 0, 0]);
    expect(record.resourceState).toBe('complete'); expect(final.stages.implement.attempts).toHaveLength(1);
  });

  it('unfinished-is-resource-state: exhausts resources without review or repair and resumes without another author attempt', async () => {
    const root = project(); projectValidation(root); const calls: string[] = [];
    setEngineDefaults({ validation_attempts: 1 });
    const capture = evidenceOwner.captureProjectTree; let identityUnavailable = false;
    const identity = vi.spyOn(evidenceOwner, 'captureProjectTree').mockImplementation((...args) => identityUnavailable
      ? { hash: null, files: [], reason: 'Injected unavailable identity' } : capture(...args));
    const runner = vi.spyOn(validationOwner, 'runValidationCommand').mockResolvedValue({ exitCode: null, unfinished: true });
    const adapter: Parameters<typeof engineering>[1] = { async run(_prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'review') return { output: JSON.stringify(verdict(opts.runDir)), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      writeFileSync(join(root, 'value.txt'), 'good'); identityUnavailable = true;
      return { output: JSON.stringify({ status: 'delivered', summary: 'Done', caveats: [], remaining_work: [] }), exitCode: 0, duration_ms: 1, writes: ['value.txt'], writeAttribution: 'structured' };
    } };
    const parked = await engineering(root, adapter);
    expect(parked.status).toBe('parked'); expect(calls).toEqual(['implement']);
    expect(parked.stages.implement.attempts).toHaveLength(1); expect(parked.stages.repair.attempts ?? []).toHaveLength(0);
    identity.mockRestore();
    const interrupted = await engineering(root, adapter, parked.runId);
    expect(interrupted.status).toBe('parked'); expect(calls).toEqual(['implement']);
    setEngineDefaults({ validation_attempts: 2 }); runner.mockImplementation(runProjectCommand);
    const resumed = await engineering(root, adapter, parked.runId);
    expect(resumed.status).toBe('complete'); expect(calls).toEqual(['implement', 'review']);
    expect(resumed.stages.implement.attempts).toHaveLength(1); expect(resumed.stages.repair.attempts ?? []).toHaveLength(0);
  });
});

describe('the project declares its validation limits', () => {
  // Engine defaults are made small so a half-second script exceeds them; the
  // declaration, not the engine, grants the time.
  const slow = (code = 0) => {
    const f = fixture();
    writeFileSync(join(f.root, 'check.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(f.counter)},'x');setTimeout(()=>process.exit(${code}),1200);`);
    return f;
  };
  const killed = () => {
    const f = fixture();
    f.input.commands[0] = { role: 'test', command: '/bin/sh', args: ['-c', 'printf x >> "$1"; kill -s KILL $$', 'declared-check', f.counter], display: 'declared check' };
    return f;
  };
  const brief = (validation: string) => `---\nvalidation: ${validation}\n---\nDeliver the value.`;
  const command = '{test: {command: node, args: [check.cjs]}}';

  it('declared-limits: a command needing longer than the engine default completes under a larger declared timeout', async () => {
    setEngineDefaults({ validation_timeout_ms: 500, validation_attempts: 1 });
    const f = slow(3);
    const record = await engineValidation({ ...f.input, limits: { timeoutMs: 20_000 } });
    expect(record.resourceState).toBe('complete'); expect(record.pass).toBe(false);
    expect(record.executions.map(execution => execution.commands[0].exitCode)).toEqual([3]);
    expect(record.limits).toEqual({ timeoutMs: 20_000, attempts: 1 }); expect(record.spentMs).toBe(20_000);
  });

  it('declared-limits: the same command is unfinished without the declaration', async () => {
    setEngineDefaults({ validation_timeout_ms: 500, validation_attempts: 1 });
    const f = slow();
    const record = await engineValidation(f.input);
    expect(record.resourceState).toBe('unfinished'); expect(record.pass).toBe(false);
    expect(record.executions.map(execution => execution.commands[0])).toEqual([expect.objectContaining({ exitCode: null, unfinished: true })]);
    expect(record.limits).toEqual({ timeoutMs: 500, attempts: 1 });
  });

  it.skipIf(process.platform !== 'linux')('declared-limits: declared attempts bound the retries in either direction', async () => {
    setEngineDefaults({ validation_attempts: 3 });
    const fewer = killed();
    const two = await engineValidation({ ...fewer.input, limits: { attempts: 2 } });
    expect(two.executions).toHaveLength(2); expect(readFileSync(fewer.counter, 'utf8')).toBe('xx');
    setEngineDefaults({ validation_attempts: 1 });
    const more = killed();
    const four = await engineValidation({ ...more.input, limits: { attempts: 4 } });
    expect(four.executions).toHaveLength(4); expect(readFileSync(more.counter, 'utf8')).toBe('xxxx');
    expect(four.limits.attempts).toBe(4);
  });

  it.skipIf(process.platform !== 'linux')('declared-limits: identity is decided by the numbers in the record', async () => {
    const f = killed(), request = (limits: { timeoutMs?: number; attempts?: number }) => engineValidation({ ...f.input, limits });
    const executed = () => readFileSync(f.counter, 'utf8').length;
    const first = await request({ timeoutMs: 1000, attempts: 1 });
    expect(first.executions).toHaveLength(1); expect(first.spentMs).toBe(1000);
    // The same, a smaller and an equal allowance of other shape spend nothing more.
    for (const limits of [{ timeoutMs: 1000, attempts: 1 }, { timeoutMs: 500, attempts: 1 }, { timeoutMs: 250, attempts: 4 }]) {
      expect((await request(limits)).executions).toHaveLength(1);
    }
    expect(executed()).toBe(1);
    // A larger allowance runs again until the record has spent it, then stops.
    const second = await request({ timeoutMs: 1000, attempts: 2 });
    expect(second.executions).toHaveLength(2); expect(second.spentMs).toBe(2000); expect(second.limits).toEqual({ timeoutMs: 1000, attempts: 2 });
    expect(executed()).toBe(2);
    expect((await request({ timeoutMs: 1000, attempts: 2 })).executions).toHaveLength(2);
    const third = await request({ timeoutMs: 5000, attempts: 1 });
    expect(third.executions).toHaveLength(3); expect(third.spentMs).toBe(7000); expect(executed()).toBe(3);
    // Spent time stays charged: the earlier, smaller numbers no longer reopen the record.
    expect((await request({ timeoutMs: 1000, attempts: 3 })).executions).toHaveLength(3);
  });

  it('declared-limits: a completed record is never executed again under other limits', async () => {
    const f = fixture(7);
    const done = await engineValidation({ ...f.input, limits: { timeoutMs: 1000, attempts: 1 } });
    expect(done.resourceState).toBe('complete');
    for (const limits of [{ timeoutMs: 600_000, attempts: 50 }, { timeoutMs: 10, attempts: 1 }, undefined]) {
      const again = await engineValidation({ ...f.input, limits, runCommand: () => { throw Error('completed tree executed again'); } });
      expect(again).toEqual(done);
    }
    expect(readFileSync(f.counter, 'utf8')).toBe('x');
  });

  it.each([
    ['timeoutMs: "slow"', 'timeoutMs'], ['timeoutMs: 0', 'timeoutMs'], ['timeoutMs: -5', 'timeoutMs'], ['timeoutMs: 1.5', 'timeoutMs'],
    ['timeoutMs: 9999999999999', 'timeoutMs'], ['attempts: "3"', 'attempts'], ['attempts: 0', 'attempts'], ['attempts: -1', 'attempts'],
    ['attempts: 2.5', 'attempts'], ['attempts: null', 'attempts'], ['retries: 2', 'retries'],
  ])('declared-limits: refuses %s by field name', (field, name) => {
    const parsed = parseBriefValidationCommands(brief(`{commands: ${command}, ${field}}`), 'brief.md');
    expect(parsed.error).toContain('Invalid validation declaration'); expect(parsed.error).toContain(name);
    expect(parsed.commands).toEqual([]);
  });

  it('declared-limits: accepts the two limits and reports only what was declared', () => {
    expect(parseBriefValidationCommands(brief(`{commands: ${command}, timeoutMs: 900000, attempts: 2}`), 'brief.md').limits).toEqual({ timeoutMs: 900000, attempts: 2 });
    expect(parseBriefValidationCommands(brief(`{commands: ${command}, attempts: 2}`), 'brief.md').limits).toEqual({ attempts: 2 });
    const none = parseBriefValidationCommands(brief(`{commands: ${command}}`), 'brief.md');
    expect(none.error).toBeUndefined(); expect(none.limits).toBeUndefined();
    // The project's own declaration file states commands only.
    expect(parseValidationCommands({ commands: { test: { command: 'node', args: [] } }, timeoutMs: 5 }, 'config/validation.json', true).error).toContain('timeoutMs');
  });

  it.each(['concurrency: 8', 'priority: 0', 'validation_concurrency: 8', 'validation_priority: 0'])('declared-limits: a brief cannot set %s', field => {
    const parsed = parseBriefValidationCommands(brief(`{commands: ${command}, timeoutMs: 1000, ${field}}`), 'brief.md');
    expect(parsed.error).toContain(field.split(':')[0]); expect(parsed.commands).toEqual([]); expect(parsed.limits).toBeUndefined();
  });

  it('declared-limits: the scheduler carries the declaration to the engine record; without it the run parks', async () => {
    setEngineDefaults({ validation_timeout_ms: 600, validation_attempts: 1 });
    const run = async (limits: string) => {
      const root = project();
      // Content identity is shared across projects: distinct text keeps the two runs on distinct trees.
      writeFileSync(join(root, 'check.cjs'), `// ${JSON.stringify(limits)}\nconst fs=require('node:fs');setTimeout(()=>process.exit(fs.readFileSync('value.txt','utf8')==='good'?0:9),1200);`);
      const { config, raw } = loadWorkflow(resolve('config/workflows/direct.yaml'));
      const declaration = `validation: {commands: {test: {command: ${JSON.stringify(process.execPath)}, args: [check.cjs]}}${limits}}\n`;
      const final = await runWorkflow(config, raw, root, { async run(_prompt, _role, opts) {
        if (opts.stageId === 'review') return { output: JSON.stringify(verdict(opts.runDir)), exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
        writeFileSync(join(root, 'value.txt'), 'good');
        return { output: JSON.stringify({ status: 'delivered', summary: 'Done', caveats: [], remaining_work: [] }), exitCode: 0, duration_ms: 1, writes: ['value.txt'], writeAttribution: 'structured' };
      } }, new Map(), undefined, resolve('config/agents'), undefined,
        `---\ncriteria: [{id: value, text: Deliver a reviewed value}]\noutputs: [value.txt]\n${declaration}---\nDeliver the value.`, true);
      return { final, root };
    };
    const declared = await run(', timeoutMs: 20000');
    expect(declared.final.status, declared.final.failureReason).toBe('complete');
    const record = readEvidence(runDir(declared.root, declared.final.runId)).find(entry => entry.kind === 'validation') as ValidationFact & { limits: unknown };
    expect(record.limits).toEqual({ timeoutMs: 20000, attempts: 1 });
    const undeclared = await run('');
    expect(undeclared.final.status).toBe('parked');
    expect(undeclared.final.stages.implement.attempts).toHaveLength(1);
  });
});
