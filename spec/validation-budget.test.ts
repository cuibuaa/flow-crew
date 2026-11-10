import { runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { join, resolve } from 'node:path';
import type { Adapter, RunOpts } from '../src/adapters/base.js';
import * as commandOwner from '../src/adapters/base.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { readEvidence, evidenceContext, type ValidationFact } from '../src/evidence-ledger.js';
import { runDir, readStageStatus } from '../src/store.js';
import { renderRunSummary } from '../src/run-summary.js';
import { recordAttemptValidation, snapshotShipSetupValidationBaseline } from '../src/scheduler/sched_settlement/gate-validation.js';
import * as validationOwner from '../src/project-validation.js';
import { evaluateValidationDelta, runProjectValidationBaseline, runProjectCommand } from '../src/project-validation.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { processLiveness, processStartToken, type ProcessStartToken } from '../src/process-liveness.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() { const root = mkdtempSync(join(tmpdir(), 'validation-budget-')); roots.push(root); return root; }
const success = (output: unknown, writes: string[] = []) => ({ output: JSON.stringify(output), exitCode: 0, duration_ms: 1, writes, writeAttribution: 'structured' as const });
function verdict(opts: RunOpts, pass = true, findings: unknown[] = []) {
  const criteria = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
  return { pass, reason: 'Independent fixture checked the product and the stated validation limits.',
    criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: pass ? 'pass' : 'fail', evidence: 'Independent product predicate and ledger' }])),
    audit_findings: { version: 1, findings },
    ...(!pass ? { repairability: { version: 1, disposition: 'repairable', evidence: 'Recorded independent predicate' } } : {}) };
}
async function workflow(root: string, adapter: Adapter, validation: string) {
  // The liveness oracle must also exercise the exact base declaration reader.
  // Keep selection out of this mutation: both trees receive the same explicit commands.
  if (validation) { mkdirSync(join(root, 'config'), { recursive: true }); writeFileSync(join(root, 'config/validation.json'), JSON.stringify(parseYaml(validation).validation)); }
  const { config, raw } = loadWorkflow(resolve('config/workflows/direct.yaml')); config.defaults.max_iterations = 1;
  const brief = `---\noutputs: [docs/value.txt]\n${validation}---\n# Deliver a value\n\n## Acceptance criteria\n1. Independently check the value, using available validation evidence and stating its limits.\n`;
  const final = await runWorkflow(config, raw, root, adapter, new Map(), undefined, resolve('config/agents'), undefined, brief, true);
  const rd = runDir(root, final.runId);
  const validations = readEvidence(rd).filter((entry): entry is typeof entry & ValidationFact => entry.kind === 'validation');
  return { final, rd, validations };
}

describe('completed author work reaches its independent gate within the validation budget', () => {
  it.each(['timeout', 'abort'] as const)('settles on %s even if process transport never closes', async boundary => {
    const stdout = new PassThrough(), stderr = new PassThrough(), stop = vi.fn(), unref = vi.fn();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null, signalCode: null, unref });
    vi.spyOn(commandOwner, 'spawnOwnedCommand').mockReturnValue({ child: child as unknown as commandOwner.ChildProcess, stop });
    const started = Date.now();
    const result = await runProjectCommand({ role: 'test', command: 'fixture', args: [], display: 'unclosed transport', cwd: project(),
      timeoutMs: boundary === 'timeout' ? 60 : 5000, ...(boundary === 'abort' ? { abortSignal: AbortSignal.timeout(60) } : {}) });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({ exitCode: null, unfinished: true });
    expect(stop).toHaveBeenCalledOnce(); expect(unref).toHaveBeenCalledOnce();
    expect(stdout.destroyed).toBe(true); expect(stderr.destroyed).toBe(true);
  });

  it.skipIf(process.platform !== 'linux').each(['running', 'exited'] as const)('retires a detached validation worker with its leader %s without waiting for inherited output pipes', async leader => {
    setEngineDefaults({ default_timeout_ms: 2000, validation_timeout_ms: 1200 });
    const root = project(), childPath = join(project(), 'child.json'), calls: string[] = [];
    let gateInput = '', gateAt = 0, childReadyAt = 0, cleanedAt: number | undefined;
    let owned: { pid: number; token: ProcessStartToken } | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const retire = () => { if (owned && processLiveness(owned.pid, owned.token) === 'alive') process.kill(owned.pid, 'SIGKILL'); };
    const watch = setInterval(() => {
      if (owned || !existsSync(childPath)) return;
      const { pid } = JSON.parse(readFileSync(childPath, 'utf8'));
      const token = processStartToken(pid);
      if (!token) return;
      owned = { pid, token }; childReadyAt = Date.now();
      // Independent cleanup makes the old hang bounded and red, while the
      // passing path must retire its own worker before this timer fires.
      cleanupTimer = setTimeout(() => { cleanedAt = Date.now(); retire(); }, 8000);
    }, 25);
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'review') { gateAt = Date.now(); gateInput = prompt; return success(verdict(opts)); }
      setEngineDefaults({ default_timeout_ms: 20000 }); // the gate has its own budget
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'value');
      return success({ status: 'delivered', summary: 'Complete', caveats: [], remaining_work: [] }, ['docs/value.txt']);
    } };
    const program = `const cp=require('node:child_process'),fs=require('node:fs');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});fs.writeFileSync(${JSON.stringify(childPath)},JSON.stringify({pid:c.pid}));${leader === 'exited' ? 'setTimeout(()=>process.exit(0),200)' : 'setInterval(()=>{},1000)'};`;
    try {
      const result = await workflow(root, adapter, `validation:\n  commands:\n    test:\n      command: ${JSON.stringify(process.execPath)}\n      args: ['-e', ${JSON.stringify(program)}]\n`);
      expect(owned).toBeDefined(); expect(childReadyAt).toBeGreaterThan(0);
      expect(cleanedAt, 'gate required independent cleanup of the validation worker').toBeUndefined();
      expect(gateAt - childReadyAt).toBeLessThan(8000);
      expect(processLiveness(owned!.pid, owned!.token)).toBe('dead');
      expect(result.final.status).toBe('complete'); expect(calls).toEqual(['implement', 'review']);
      expect(result.validations[0]).toMatchObject({ pass: false, executions: [{ commands: [{ unfinished: true, state: 'unverified' }] }] });
      expect(gateInput).toContain('"unfinished":true'); expect(gateInput).toContain('"pass":false');
      expect(renderRunSummary(root, result.rd, result.final)).toContain('Validation unfinished');
    } finally { clearInterval(watch); clearTimeout(cleanupTimer); retire(); }
  });

  it.each(['slow', 'silent', 'failed-build-then-silent'] as const)('retires %s validation, preserves the author and states incomplete evidence', async shape => {
    // Scale the existing timeout, not command-name heuristics. The configured
    // command exceeds the remaining 20-second author deadline; batch ends first.
    setEngineDefaults({ default_timeout_ms: 20000, validation_timeout_ms: 5000 });
    const root = project();
    const calls: string[] = []; let gateInput = '', authorClosedAt = 0, gateAt = 0;
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'review') { gateAt = performance.now(); gateInput = prompt; return success(verdict(opts)); }
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'value');
      authorClosedAt = performance.now();
      return success({ status: 'delivered', summary: 'Product complete', caveats: [], remaining_work: [] }, ['docs/value.txt']);
    } };
    const program = shape === 'slow' ? 'setTimeout(()=>{},30000)' : 'setInterval(()=>{},1000)';
    const validation = `validation:\n  commands:\n${shape === 'failed-build-then-silent' ? `    build:\n      command: /bin/sh\n      args: ['-c', 'exit 2']\n` : ''}    test:\n      command: ${JSON.stringify(process.execPath)}\n      args: ['-e', ${JSON.stringify(program)}]\n`;
    const result = await workflow(root, adapter, validation);
    expect(result.final.status, JSON.stringify({ final: result.final, validations: result.validations, calls })).toBe('complete'); expect(calls).toEqual(['implement', 'review']);
    // Gate arrival must fit the declared author-stage envelope. Filesystem
    // settlement and prompt capture also consume wall time on a loaded host.
    expect(gateAt - authorClosedAt).toBeLessThan(20000);
    expect(readStageStatus(root, result.final.runId, 'implement')).toMatchObject({ status: 'complete', exitCode: 0 });
    const [fact] = result.validations; expect(result.validations).toHaveLength(1); expect(fact.pass).toBe(false);
    expect(fact.executions).toHaveLength(1); // no eager base and no time to compare the build
    const test = fact.executions[0].commands.find(command => command.role === 'test')!;
    expect(test).toMatchObject({ unfinished: true, state: 'unverified', measurement: 'unverified', failureIdentity: 'unknown' });
    expect(test.exitCode).not.toBe(0); expect(test.reason).toContain('unfinished');
    expect(gateInput).toContain('"unfinished":true'); expect(gateInput).toContain('"pass":false');
    expect(renderRunSummary(root, result.rd, result.final)).toContain('Validation unfinished');
    if (shape === 'failed-build-then-silent') {
      expect(fact.executions[0].commands[0], JSON.stringify(fact.executions[0].commands[0])).toMatchObject({ role: 'build', exitCode: 2, state: 'failed' });
      expect(gateInput).toContain('"exitCode":2');
    }
    const unchanged = await recordAttemptValidation(root, result.final.runId, 'implement', { runCommand: () => { throw Error('identical uncertain evidence reran'); } });
    expect(unchanged).toMatchObject({ sequence: fact.sequence });
  });

  it('reaches review after validation exhausts the remaining author budget while preserving completed model work', { timeout: 60_000 }, async () => {
    setEngineDefaults({ default_timeout_ms: 20000, validation_timeout_ms: 60000 });
    const root = project(), calls: string[] = []; let gateInput = '', gateAt = 0;
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'review') { gateAt = Date.now(); gateInput = prompt; return success(verdict(opts)); }
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'value');
      return success({ status: 'delivered', summary: 'Model work complete', caveats: [], remaining_work: [] }, ['docs/value.txt']);
    } };
    const result = await workflow(root, adapter, `validation:\n  commands:\n    test:\n      command: ${JSON.stringify(process.execPath)}\n      args: ['-e', 'setInterval(()=>{},1000)']\n`);
    const author = readStageStatus(root, result.final.runId, 'implement');
    expect(author).toMatchObject({ status: 'complete', exitCode: 0 });
    expect(author.timeout?.budgetDeadlineAt).toEqual(expect.any(String));
    expect(gateAt).toBeGreaterThanOrEqual(Date.parse(author.timeout!.budgetDeadlineAt!));
    expect(result.final.status, JSON.stringify(result.final)).toBe('complete');
    expect(calls).toEqual(['implement', 'review']);
    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]).toMatchObject({ pass: false, executions: [{ target: 'attempt', commands: [{ unfinished: true, state: 'unverified' }] }] });
    expect(gateInput).toContain('"unfinished":true');
    expect(renderRunSummary(root, result.rd, result.final)).toContain('Validation unfinished');
    console.log('BUDGET_CLAMP_FACTS=' + JSON.stringify({ authorExit: author.exitCode,
      authorDeadlineAt: author.timeout!.budgetDeadlineAt, gateAt: new Date(gateAt).toISOString(),
      validationCount: result.validations.length, validation: result.validations[0] }));
  });

  it('waits for a successful author settlement instead of validating a failed model attempt', async () => {
    const root = project(), counter = join(project(), 'count'); let attempts = 0;
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === 'review') return success(verdict(opts));
      attempts++;
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'value');
      return { ...success({ status: 'delivered', summary: 'Retained value', caveats: [], remaining_work: [] }, ['docs/value.txt']), exitCode: attempts === 1 ? 1 : 0 };
    } };
    const program = `require('fs').appendFileSync(${JSON.stringify(counter)}, 'one\\n')`;
    const result = await workflow(root, adapter, `validation:\n  commands:\n    test:\n      command: ${JSON.stringify(process.execPath)}\n      args: ['-e', ${JSON.stringify(program)}]\n`);
    expect(result.final.status).toBe('complete'); expect(attempts).toBe(2);
    expect(readFileSync(counter, 'utf8')).toBe('one\n'); expect(result.validations).toHaveLength(1);
    expect(result.validations[0].attemptIndex).toBe(2);
  });

  it('reserves test and lint allowance even when the build hangs silently', { timeout: 60_000 }, async () => {
    setEngineDefaults({ validation_timeout_ms: 12000 });
    const root = project();
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === 'review') return success(verdict(opts));
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'value');
      return success({ status: 'delivered', summary: 'Complete', caveats: [], remaining_work: [] }, ['docs/value.txt']);
    } };
    const { final, validations, rd } = await workflow(root, adapter, `validation:\n  commands:\n    build:\n      command: ${JSON.stringify(process.execPath)}\n      args: ['-e', 'setInterval(()=>{},1000)']\n    test:\n      command: /bin/sh\n      args: ['-c', 'exit 0']\n    lint:\n      command: /bin/sh\n      args: ['-c', 'exit 0']\n`);
    const commands = validations[0].executions[0].commands;
    expect(commands[0]).toMatchObject({ unfinished: true, state: 'unverified' });
    expect(commands.slice(1).map(command => command.exitCode)).toEqual([0, 0]);
    expect(final.status).toBe('complete');
    expect(final.validation?.[0]).toMatchObject({ measurement: 'unverified' });
    expect(renderRunSummary(root, rd, final)).toContain('unverified');
  });

  it('bounds a near-idle suite after its worker dies and still starts the next command', { timeout: 60_000 }, async () => {
    setEngineDefaults({ validation_timeout_ms: 12000 });
    const root = project(); let gateInput = '';
    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === 'review') { gateInput = prompt; return success(verdict(opts)); }
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'value');
      return success({ status: 'delivered', summary: 'Complete', caveats: [], remaining_work: [] }, ['docs/value.txt']);
    } };
    const program = `const c=require('child_process').spawn(process.execPath,['-e','process.kill(process.pid,"SIGKILL")']);c.once('exit',(_code,signal)=>{console.log('worker died '+signal);setInterval(()=>{},1000)});`;
    const result = await workflow(root, adapter, `validation:\n  commands:\n    test:\n      command: ${JSON.stringify(process.execPath)}\n      args: ['-e', ${JSON.stringify(program)}]\n    lint: {command: /bin/sh, args: ['-c', 'exit 0']}\n`);
    const commands = result.validations[0].executions[0].commands;
    expect(commands[1]).toMatchObject({ exitCode: 0, state: 'passed' });
    expect(commands[0]).toMatchObject({ unfinished: true, state: 'unverified', measurement: 'unverified' });
    expect(commands[0].output).toContain('worker died SIGKILL');
    expect(gateInput).toContain('worker died SIGKILL');
    expect(result.final.status).toBe('complete');
    expect(result.final.validation?.[0].measurement).toBe('unverified');
  });

});

it('reserves each command its share of the remaining batch without a stall detector', async () => {
  setEngineDefaults({ validation_timeout_ms: 6000 });
  let elapsed = 0;
  const allowances: number[] = [];
  const batch = await runProjectValidationBaseline(project(), { now: () => elapsed,
    commands: (['build', 'test', 'lint'] as const).map(role => ({ role, command: 'fixture', args: [], display: role })),
    runCommand: request => {
      allowances.push(request.timeoutMs!);
      elapsed += request.role === 'build' ? request.timeoutMs! : 10;
      return request.role === 'build' ? { exitCode: null, unfinished: true } : { exitCode: 0 };
    },
  });
  expect(allowances).toEqual([2000, 2000, 3990]);
  expect(batch.results.map(result => result.exitCode)).toEqual([null, 0, 0]);
});

describe('final results own the comparison population', () => {
  it('accepts a passing final command despite an unrelated failed base command', async () => {
    const build = { role: 'build' as const, command: 'fixture-build', args: [], display: 'fixture-build' };
    const test = { role: 'test' as const, command: 'fixture-test', args: [], display: 'fixture-test' };
    const base = await runProjectValidationBaseline(project(), { commands: [build, test],
      runCommand: request => ({ exitCode: request.role === 'test' ? 1 : 0 }) });
    const final = await runProjectValidationBaseline(project(), { commands: [build], runCommand: () => ({ exitCode: 0 }) });
    expect(evaluateValidationDelta(base, final.results, undefined, [build])).toEqual([
      expect.objectContaining({ role: 'build', state: 'verified' }),
    ]);
    expect(base.results.find(result => result.role === 'test')).toMatchObject({ state: 'failed', failureIdentity: 'unknown' });
  });
});

describe('declarations or one repository-reading model choose commands', () => {
  it('refuses conflicting declarations before an undeclared model-selection fallback', () => {
    const root = project(); mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config/validation.json'), JSON.stringify({ commands: { test: { command: 'declared', args: ['project'] } } }));
    expect(() => snapshotShipSetupValidationBaseline(root,
      '---\nvalidation: {commands: {test: {command: declared, args: [brief]}}}\n---\n# Goal', project())).toThrow('Validation command conflict');
  });

  it.each(['selected', 'empty', 'omitted', 'invalid'] as const)('settles %s selection in the author result without another model call', async shape => {
    const root = project(), calls: string[] = []; let gateInput = '';
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'do-not-guess' }, packageManager: 'npm@10' }));
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'review') { gateInput = prompt; return success(verdict(opts)); }
      expect(prompt).toContain('# Validation command selection');
      expect(opts.outputSchema?.properties?.validation).toBeDefined();
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'value');
      const validation = { commands: shape === 'empty' ? {} : { test: { command: process.execPath, args: ['-e', 'process.exitCode=0'] } }, reason: 'Read the fixture repository and choose its command explicitly.' };
      return success({ status: 'delivered', summary: 'Complete', caveats: [], remaining_work: [], ...(shape === 'omitted' ? {} : { validation: shape === 'invalid' ? { commands: 'invalid', reason: 'Unavailable selection' } : validation }) }, ['docs/value.txt']);
    } };
    const result = await workflow(root, adapter, '');
    expect(result.final.status, JSON.stringify({ final: result.final, validations: result.validations, calls })).toBe('complete'); expect(calls).toEqual(['implement', 'review']);
    expect(result.validations).toHaveLength(shape === 'selected' ? 1 : 0);
    expect(gateInput).toContain('Validation command selection (unconfigured roles are unmeasured)');
    if (shape !== 'selected') { expect(gateInput).toContain('"commands":[]'); expect(gateInput).toContain('Model selection:'); }
  });
});

async function catchFixture(kind: 'cache' | 'cpu', confirm: boolean) {
  setEngineDefaults({ validation_timeout_ms: 60000 });
  const root = project(), calls: string[] = [];
  const git = (...args: string[]) => isolatedProjectCommand('git', args, root, root);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'contract.txt'), 'old'); writeFileSync(join(root, 'resource.txt'), kind === 'cache' ? 'TMP' : '0-5');
  // This finite reporter fixture reproduces the audit assertion and independent
  // existing environment failures, rather than imitating their console output.
  writeFileSync(join(root, 'check.mjs'), `import fs from 'node:fs';
const kind=${JSON.stringify(kind)};const resource=fs.readFileSync('resource.txt','utf8');
const defect=kind==='cache'?fs.readFileSync('contract.txt','utf8')==='new'&&resource!=='STATE':resource!=='0-5';
const ids=kind==='cache'?['environment_missing_key_a','environment_missing_key_b']:[];
if(defect)ids.push(kind==='cache'?'test_vast_shared_search_state_lives_with_tool_state_not_tmp':'declared_worker_cpu_affinity');
console.log(JSON.stringify({complete:true,numTotalTests:ids.length,numFailedTests:ids.length,numPassedTests:0,testResults:[{name:'audit.test',assertionResults:ids.map(fullName=>({fullName,status:'failed'}))}]}));process.exitCode=ids.length?1:0;`);
  git('add', '.'); git('commit', '-qm', 'audit base');
  const adapter: Adapter = { async run(prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'review') {
      const defect = readFileSync(join(root, 'resource.txt'), 'utf8') !== (kind === 'cache' ? 'STATE' : '0-5');
      if (!defect) return success(verdict(opts));
      const results = readEvidence(opts.runDir).filter(entry => entry.kind === 'validation').at(-1)!;
      if (results.kind !== 'validation') throw Error('No validation facts');
      const test = results.executions[0].commands.find(command => command.role === 'test')!;
      expect(test.exitCode).toBe(1);
      const review = { commands: [{ role: 'test', display: test.display, disposition: 'caused_by_change',
        reason: kind === 'cache' ? 'The added cache contract is unmet atop two independent environment failures; not proof of a newly introduced business bug' : 'Worker CPU execution differs from the declared constraint; integration mismatch' }], request_base: [] };
      if (!confirm) return success({ ...verdict(opts), validation_review: review });
      const predicate = `require('fs').readFileSync('resource.txt','utf8')===${JSON.stringify(kind === 'cache' ? 'STATE' : '0-5')}`;
      const request = { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.exit(${predicate}?0:1)`)}`, cwd: root, shell: '/bin/sh' };
      const client = prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
      const response = await runProjectCommand({ role: 'test', command: '/bin/sh', args: ['-c', `${client} '${JSON.stringify(request).replaceAll("'", "'\\''")}'`], display: 'Independent audit predicate', cwd: root, timeoutMs: 30000 });
      expect(response.exitCode).toBe(0); const record = JSON.parse(response.stdout!).record; expect(record.exitCode).toBe(1);
      return success({ ...verdict(opts, false, [{ id: kind, paths: ['resource.txt'], reason: kind === 'cache' ? 'Shared cache must persist with tool state' : 'Worker must honor declared CPUs; integration adaptation, not algorithm regression', criterion_ids: [], invalidates_plan: false, repair_role: 'coder', reproduction: record.sequence }]), validation_review: review });
    }
    if (opts.stageId === 'implement') {
      writeFileSync(join(root, 'contract.txt'), 'new'); if (kind === 'cpu') writeFileSync(join(root, 'resource.txt'), '6-7');
    } else writeFileSync(join(root, 'resource.txt'), kind === 'cache' ? 'STATE' : '0-5');
    mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'value');
    return success({ status: 'delivered', summary: 'Product updated', caveats: [], remaining_work: [] }, ['contract.txt', 'resource.txt', 'docs/value.txt']);
  } };
  const result = await workflow(root, adapter, `validation:\n  commands:\n    build:\n      command: ${JSON.stringify(process.execPath)}\n      args: ['-e', 'process.exitCode=0']\n    test:\n      command: ${JSON.stringify(process.execPath)}\n      args: [check.mjs]\n      report: {format: vitest-json}\n`);
  return { ...result, root, calls };
}

describe('11/05 useful catches survive delayed validation', () => {
  it.each(['cache', 'cpu'] as const)('retains the audit %s refusal and admits repair only with a confirmed reproduction', { timeout: 60_000 }, async kind => {
    const result = await catchFixture(kind, false);
    if (kind === 'cpu') {
      // The operator's serial candidate/base pair independently confirms this regression.
      expect(result.validations[0].regressions).toHaveLength(1);
      expect(result.final.status).toBe('complete');
      expect(result.calls).toEqual(['implement', 'review', 'repair', 'review']);
      expect(readEvidence(result.rd).some(entry => entry.kind === 'command' && entry.reproductionOf === result.validations[0].regressions![0].record.sequence && entry.exitCode === 0)).toBe(true);
    } else {
      expect(result.final.status, JSON.stringify({ gate: result.final.stages.review.gate, validations: result.validations })).toBe('incomplete');
      expect(result.final.stages.review.gate).toMatchObject({ pass: false, refusal: { kind: 'audit_findings' } });
      expect(result.calls).toEqual(['implement', 'review']);
      expect(result.validations[0].regressions ?? []).toEqual([]);
    }
    expect(result.validations[0].delta.find(entry => entry.role === 'test')?.state).toBe('unverified');
  });

  it.each(['cache', 'cpu'] as const)('authorizes confirmed %s repair while retaining the original assertion and prior failures', { timeout: 120_000 }, async kind => {
    const result = await catchFixture(kind, true);
    expect(result.final.status, JSON.stringify({ gate: result.final.stages.review, validations: result.validations, calls: result.calls })).toBe('complete'); expect(result.calls).toEqual(['implement', 'review', 'repair', 'review']);
    const first = result.validations[0]; expect(first.delta.find(entry => entry.role === 'test')?.state).toBe('unverified');
    expect(first.executions.map(execution => execution.commands.map(command => command.role))).toEqual([['build','test'], ['test'], ['test']]);
    expect(first.executions.map(execution => execution.rerun)).toEqual([undefined, true, true]);
    expect(first.failures).toEqual([]);
    if (kind === 'cache') {
      expect(first.executions.map(execution => execution.commands.find(command => command.role === 'test')!.failureCount)).toEqual([3, 3, 2]);
      expect(first.executions[0].commands.find(command => command.role === 'test')!.failureIdentifiers.filter(id => id.includes('environment_missing_key'))).toHaveLength(2);
      expect(first.delta.find(entry => entry.role === 'test')!.state).toBe('unverified');
      expect(result.validations[1].executions[0].commands.find(command => command.role === 'test')).toMatchObject({ exitCode: 1, failureCount: 2 });
      expect(result.final.validation?.find(command => command.role === 'test')).toMatchObject({ exitCode: 1, measurement: 'unverified' });
    }
    expect(result.validations).toHaveLength(2); expect(result.validations[1].pass, JSON.stringify(result.validations[1])).toBe(kind !== 'cache');
    expect(readEvidence(result.rd).some(entry => entry.kind === 'command' && entry.reproductionOf !== undefined && entry.exitCode === 0)).toBe(true);
    expect(evidenceContext(result.root, result.rd)).not.toContain('AUTHOR_TRANSCRIPT');
  });
});


describe('declared validation environment preserves data isolation', () => {
  it('keeps outside data unchanged through a worktree symlink and records the isolating input', async () => {
    const root = project(), outside = project(), isolated = project();
    writeFileSync(join(outside, 'ledger'), 'original');
    symlinkSync(outside, join(root, 'data'), 'dir');
    const program = "require('fs').appendFileSync(require('path').join(process.env.PROJECT_STATE || 'data','ledger'),'measured')";
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === 'review') return success(verdict(opts));
      const measured = await runProjectCommand({ role: 'test', command: process.execPath, args: ['-e', program],
        display: 'stage measurement', cwd: root, env: { PROJECT_STATE: isolated }, timeoutMs: 5000 });
      expect(measured.exitCode).toBe(0);
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'value');
      return success({ status: 'delivered', summary: 'Complete', caveats: [], remaining_work: [] }, ['docs/value.txt']);
    } };
    const result = await workflow(root, adapter, `validation:\n  commands:\n    test:\n      command: ${JSON.stringify(process.execPath)}\n      args: ['-e', ${JSON.stringify(program)}]\n      env: {PROJECT_STATE: ${JSON.stringify(isolated)}}\n`);
    expect(result.final.status).toBe('complete');
    expect(readFileSync(join(outside, 'ledger'), 'utf8')).toBe('original');
    expect(readFileSync(join(isolated, 'ledger'), 'utf8')).toBe('measuredmeasured');
    expect(result.validations[0].executions[0].commands[0]).toMatchObject({ exitCode: 0, env: { PROJECT_STATE: isolated } });
    expect(renderRunSummary(root, result.rd, result.final)).toContain(JSON.stringify({ PROJECT_STATE: isolated }));
  });

  it('does not execute when control isolation would drop an explicitly selected environment variable', async () => {
    const root = project();
    const result = await runProjectValidationBaseline(root, { commands: [{ role: 'test', display: 'explicit reserved input',
      command: process.execPath, args: ['-e', "require('fs').writeFileSync('executed','bad')"], env: { NODE_OPTIONS: '--no-warnings' } }] });
    expect(existsSync(join(root, 'executed'))).toBe(false);
    expect(result.results[0]).toMatchObject({ exitCode: null, state: 'unverified', reason: expect.stringContaining('cannot be preserved') });
  });
});


describe('the independent gate owns unconfirmed failure causation', () => {
  it.each(['already_failing', 'environment', 'unknown', 'omitted', 'invalid', 'duplicate'] as const)('accepts a failed command honestly with %s disposition', async shape => {
    const root = project(); let gateInput = '';
    const display = '/bin/sh -c exit 127';
    const entry = { role: 'test', display, disposition: shape === 'omitted' || shape === 'invalid' || shape === 'duplicate' ? 'unknown' : shape, reason: 'Independent fixture inspected the failure and product' };
    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === 'review') {
        gateInput = prompt;
        return success({ ...verdict(opts), ...(shape === 'omitted' ? {} : { validation_review: shape === 'invalid' ? { commands: 'invalid', request_base: [] } : {
          commands: shape === 'duplicate' ? [entry, { ...entry, disposition: 'caused_by_change' }] : [entry], request_base: [],
        } }) });
      }
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'correct');
      return success({ status: 'delivered', summary: 'Complete', caveats: [], remaining_work: [] }, ['docs/value.txt']);
    } };
    const result = await workflow(root, adapter, "validation:\n  commands:\n    build: {command: /bin/sh, args: ['-c', 'exit 0']}\n    test: {command: /bin/sh, args: ['-c', 'exit 127']}\n");
    expect(gateInput).toContain('"exitCode":127');
    expect(result.final.status).toBe('complete');
    expect(result.validations).toHaveLength(1);
    expect(result.validations[0].executions.map(execution => [execution.target, execution.rerun])).toEqual([['attempt', undefined], ['attempt', true], ['base', true]]);
    expect(result.validations[0].regressions ?? []).toEqual([]);
    expect(result.final.validation?.find(command => command.role === 'test')).toMatchObject({ exitCode: 127, state: 'failed', measurement: 'unverified' });
    expect(result.final.stages.review.gate?.validation?.find(command => command.role === 'test')).toMatchObject({
      exitCode: 127, measurement: 'unverified', disposition: ['omitted', 'invalid', 'duplicate'].includes(shape) ? 'unknown' : shape,
    });
    expect(renderRunSummary(root, result.rd, result.final)).toContain('failed (unverified)');
  });

  it('leaves a known flake unverified after a passing alone rerun and gate-requested failing base', async () => {
    const root = project(), counter = join(project(), 'flaky-count');
    const program = "import fs from 'node:fs';const p=process.argv[2];const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));const code=n%2===0?1:0;console.log('flaky assertion invocation '+n+' exit '+code);process.exitCode=code;";
    writeFileSync(join(root, 'check.mjs'), program);
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'flaky base']]) isolatedProjectCommand('git', args, root, root);
    // The unchanged base program demonstrably alternates red and green. The
    // subsequent configured batch/alone pair is red/green without a code change;
    // the gate's later base supplement is red again.
    const probes = [];
    for (let n = 0; n < 2; n++) probes.push((await runProjectCommand({ role: 'test', command: process.execPath, args: ['check.mjs', counter], display: 'independent base flake probe', cwd: root, timeoutMs: 5000 })).exitCode);
    expect(probes).toEqual([1, 0]);
    let reviews = 0; const observedTargets: string[][] = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === 'review') {
        reviews++;
        const commands = [{ role: 'test', display: `${process.execPath} check.mjs ${counter}`, disposition: reviews === 1 ? 'unknown' : 'already_failing', reason: 'The unchanged base program was independently observed red and green; a green sample cannot establish introduction' }];
        if (reviews === 1) {
          const facts = readEvidence(opts.runDir).filter(entry => entry.kind === 'validation');
          observedTargets.push((facts[0] as ValidationFact).executions.map(execution => execution.target));
        } else {
          expect(prompt).toContain('# Requested base evidence');
          expect(prompt).toContain('flaky assertion invocation');
          expect(prompt).toContain('"target":"base"');
        }
        return success({ ...verdict(opts), validation_review: { commands, request_base: reviews === 1 ? [{ role: 'test', display: `${process.execPath} check.mjs ${counter}` }] : [] } });
      }
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'correct');
      return success({ status: 'delivered', summary: 'Complete', caveats: [], remaining_work: [] }, ['docs/value.txt']);
    } };
    const result = await workflow(root, adapter, `validation:\n  commands:\n    test: {command: ${JSON.stringify(process.execPath)}, args: [check.mjs, ${JSON.stringify(counter)}]}\n`);
    expect(observedTargets).toEqual([['attempt', 'attempt']]);
    expect(reviews).toBe(2); expect(result.final.status).toBe('complete');
    expect(result.validations).toHaveLength(2);
    expect(result.validations[1].executions.map(execution => [execution.target, execution.commands[0].exitCode])).toEqual([['attempt', 1], ['attempt', 0], ['base', 1]]);
    expect(result.validations[1].regressions ?? []).toEqual([]);
    expect(result.final.stages.review.gate?.validation?.[0]).toMatchObject({ disposition: 'already_failing', measurement: 'unverified' });
    expect(result.final.validation?.[0]).toMatchObject({ measurement: 'unverified', exitCode: 1 });
  });

  it('keeps failed, unfinished and unrun commands unknown without a valid gate output', () => {
    const results = [
      { role: 'build' as const, display: 'build', state: 'failed' as const, exitCode: 4 },
      { role: 'test' as const, display: 'test', state: 'unverified' as const, exitCode: 0, unfinished: true },
      { role: 'lint' as const, display: 'lint', state: 'unverified' as const, exitCode: null },
    ].map(value => ({ ...value, durationMs: 0, output: '', failureIdentity: 'unknown' as const, failureIdentifiers: [] }));
    for (const review of [undefined, {}, { commands: [{ role: 'build', display: 'build', disposition: 'made_up', reason: 'no' }], request_base: [] }]) {
      expect(validationOwner.validationDispositions(results, review).map(entry => entry.disposition)).toEqual(['unknown', 'unknown', 'unknown']);
      expect(evaluateValidationDelta(undefined, results).map(entry => entry.state)).toEqual(['unverified', 'unverified', 'unverified']);
    }
  });
});


it('accepts a repository-selected missing test honestly alongside a working build', async () => {
  const root = project(), calls: string[] = []; let gateInput = '';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"', test: 'exit 127' } }));
  const adapter: Adapter = { async run(prompt, _role, opts) {
    calls.push(opts.stageId);
    if (opts.stageId === 'review') { gateInput = prompt; return success(verdict(opts)); }
    expect(prompt).toContain('# Validation command selection');
    mkdirSync(join(root, 'docs')); writeFileSync(join(root, 'docs/value.txt'), 'correct');
    return success({ status: 'delivered', summary: 'Correct value', caveats: [], remaining_work: [], validation: {
      commands: { build: { command: 'npm', args: ['run', 'build'] }, test: { command: 'npm', args: ['run', 'test'] } },
      reason: 'Read the repository scripts and select both declared entry points',
    } }, ['docs/value.txt']);
  } };
  const result = await workflow(root, adapter, '');
  expect(calls).toEqual(['implement', 'review']);
  expect(gateInput).toContain('"exitCode":127');
  expect(result.validations[0].executions[0].commands.map(command => command.exitCode)).toEqual([0, 127]);
  expect(result.final.status).toBe('complete');
  expect(result.final.stages.review.gate?.validation?.find(command => command.role === 'test')).toMatchObject({ disposition: 'unknown', exitCode: 127, measurement: 'unverified' });
  expect(result.final.validation?.find(command => command.role === 'test')).toMatchObject({ state: 'failed', exitCode: 127, measurement: 'unverified' });
  expect(renderRunSummary(root, result.rd, result.final)).toContain('npm run test: unverified');
});

it('reuses declared destructive preparation on the same tree at a later stage', async () => {
  const root = project();
  isolatedProjectCommand('git', ['init', '-q'], root, root);
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  const prepare = "const f=require('fs');f.rmSync('node_modules',{recursive:true,force:true});f.mkdirSync('node_modules');f.writeFileSync('node_modules/prepared','once')";
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    if (opts.stageId === 'review') return success(verdict(opts));
    mkdirSync(join(root, 'docs')); writeFileSync(join(root, 'docs/value.txt'), 'value');
    return success({ status: 'delivered', summary: 'Complete', caveats: [], remaining_work: [] }, ['docs/value.txt']);
  } };
  const result = await workflow(root, adapter, `validation:\n  commands:\n    build: {command: ${JSON.stringify(process.execPath)}, args: ['-e', ${JSON.stringify(prepare)}]}\n    test: {command: /bin/sh, args: ['-c', 'exit 0']}\n`);
  expect(result.final.status).toBe('complete');
  expect(readFileSync(join(root, 'node_modules', 'prepared'), 'utf8')).toBe('once');
  writeFileSync(join(root, 'node_modules', 'keep'), 'later installed data');
  const receipt = await recordAttemptValidation(root, result.final.runId, 'review', { runCommand: () => { throw Error('Repeated preparation'); } });
  expect(receipt).toMatchObject({ sequence: result.validations[0].sequence });
  expect(readFileSync(join(root, 'node_modules', 'keep'), 'utf8')).toBe('later installed data');
  expect(readEvidence(result.rd).filter(entry => entry.kind === 'validation')).toHaveLength(1);
});
