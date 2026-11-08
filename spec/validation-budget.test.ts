import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { join, resolve } from 'node:path';
import type { Adapter, RunOpts } from '../src/adapters/base.js';
import * as commandOwner from '../src/adapters/base.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { readEvidence, evidenceContext, type ValidationFact } from '../src/evidence-ledger.js';
import { runDir, readStageStatus } from '../src/store.js';
import { renderRunSummary } from '../src/run-summary.js';
import { currentAuthorValidationRefusal, recordAttemptValidation, snapshotShipSetupValidationBaseline } from '../src/scheduler/sched_settlement/gate-validation.js';
import { evaluateValidationDelta, runProjectValidationBaseline, runProjectCommand } from '../src/project-validation.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { processLiveness, processStartToken, type ProcessStartToken } from '../src/process-liveness.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() { const root = mkdtempSync(join(tmpdir(), 'validation-budget-')); roots.push(root); return root; }
const success = (output: unknown, writes: string[] = []) => ({ output: JSON.stringify(output), exitCode: 0, duration_ms: 1, writes, writeAttribution: 'structured' as const });
function verdict(opts: RunOpts, pass = true, findings: unknown[] = []) {
  const criteria = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8')).criteria as Array<{ id: string }>;
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
      expect(result.validations[0]).toMatchObject({ pass: false, executions: [{ commands: [{ unfinished: true, state: 'not_measured' }] }] });
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
    expect(test).toMatchObject({ unfinished: true, state: 'not_measured', measurement: 'not_measured', failureIdentity: 'unknown' });
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
    expect(result.validations[0]).toMatchObject({ pass: false, executions: [{ target: 'attempt', commands: [{ unfinished: true, state: 'not_measured' }] }] });
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

  it('bounds the batch as a whole, retaining completed failures and not launching commands after expiry', async () => {
    setEngineDefaults({ validation_timeout_ms: 100 });
    const root = project();
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === 'review') return success(verdict(opts));
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'value');
      return success({ status: 'delivered', summary: 'Complete', caveats: [], remaining_work: [] }, ['docs/value.txt']);
    } };
    const { validations } = await workflow(root, adapter, `validation:\n  commands:\n    build:\n      command: ${JSON.stringify(process.execPath)}\n      args: ['-e', 'setInterval(()=>{},1000)']\n    lint:\n      command: ${JSON.stringify(process.execPath)}\n      args: ['-e', "require('fs').writeFileSync('unexpected','ran')"]\n`);
    expect(existsSync(join(root, 'unexpected'))).toBe(false);
    expect(validations[0].executions[0].commands.every(command => command.unfinished && command.state === 'not_measured')).toBe(true);
  });
});

describe('final results own the comparison population', () => {
  it('accepts a passing final command despite an unrelated failed base command', async () => {
    const build = { role: 'build' as const, command: 'fixture-build', args: [], display: 'fixture-build' };
    const test = { role: 'test' as const, command: 'fixture-test', args: [], display: 'fixture-test' };
    const base = await runProjectValidationBaseline(project(), { commands: [build, test],
      runCommand: request => ({ exitCode: request.role === 'test' ? 1 : 0 }) });
    const final = await runProjectValidationBaseline(project(), { commands: [build], runCommand: () => ({ exitCode: 0 }) });
    expect(evaluateValidationDelta(base, final.results, undefined, [build])).toEqual([
      expect.objectContaining({ role: 'build', state: 'pass' }),
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

  it.each(['selected', 'empty', 'omitted'] as const)('settles %s selection in the author result without another model call', async shape => {
    const root = project(), calls: string[] = []; let gateInput = '';
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'do-not-guess' }, packageManager: 'npm@10' }));
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push(opts.stageId);
      if (opts.stageId === 'review') { gateInput = prompt; return success(verdict(opts)); }
      expect(prompt).toContain('# Validation command selection');
      expect(opts.outputSchema?.properties?.validation).toBeDefined();
      mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs/value.txt'), 'value');
      const validation = { commands: shape === 'empty' ? {} : { test: { command: process.execPath, args: ['-e', 'process.exitCode=0'] } }, reason: 'Read the fixture repository and choose its command explicitly.' };
      return success({ status: 'delivered', summary: 'Complete', caveats: [], remaining_work: [], ...(shape === 'omitted' ? {} : { validation }) }, ['docs/value.txt']);
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
      const refusal = currentAuthorValidationRefusal(root, readRunId(opts));
      expect(refusal?.refusal?.kind, JSON.stringify({ refusal, validation: readEvidence(opts.runDir).filter(fact => fact.kind === 'validation') })).toBe('validation_regression');
      if (!confirm) return success(verdict(opts)); // engine must still block a mechanical introduction
      const predicate = `require('fs').readFileSync('resource.txt','utf8')===${JSON.stringify(kind === 'cache' ? 'STATE' : '0-5')}`;
      const request = { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.exit(${predicate}?0:1)`)}`, cwd: root, shell: '/bin/sh' };
      const client = prompt.split('## Engine-recorded command\nRun ')[1].split(" '<JSON>'")[0];
      const response = await runProjectCommand({ role: 'test', command: '/bin/sh', args: ['-c', `${client} '${JSON.stringify(request).replaceAll("'", "'\\''")}'`], display: 'Independent audit predicate', cwd: root, timeoutMs: 30000 });
      expect(response.exitCode).toBe(0); const record = JSON.parse(response.stdout!).record; expect(record.exitCode).toBe(1);
      return success(verdict(opts, false, [{ id: kind, paths: ['resource.txt'], reason: kind === 'cache' ? 'Shared cache must persist with tool state' : 'Worker must honor declared CPUs; integration adaptation, not algorithm regression', criterion_ids: [], invalidates_plan: false, repair_role: 'coder', reproduction: record.sequence }]));
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
function readRunId(opts: RunOpts): string { return JSON.parse(readFileSync(join(opts.runDir, 'run.json'), 'utf8')).runId; }

describe('11/05 useful catches survive delayed validation', () => {
  it.each(['cache', 'cpu'] as const)('blocks the audit %s assertion even when a gate tries to accept it', { timeout: 60_000 }, async kind => {
    const result = await catchFixture(kind, false);
    expect(result.final.status, JSON.stringify({ gate: result.final.stages.review.gate, validations: result.validations })).toBe('incomplete');
    expect(result.final.stages.review.gate).toMatchObject({ pass: false, refusal: { kind: 'validation_regression' } });
    expect(result.calls).toEqual(['implement', 'review']);
    expect(result.validations[0].delta.find(entry => entry.role === 'test')?.state).toBe('regression');
  });

  it.each(['cache', 'cpu'] as const)('authorizes confirmed %s repair while retaining the original assertion and prior failures', { timeout: 120_000 }, async kind => {
    const result = await catchFixture(kind, true);
    expect(result.final.status, JSON.stringify({ gate: result.final.stages.review, validations: result.validations, calls: result.calls })).toBe('complete'); expect(result.calls).toEqual(['implement', 'review', 'repair', 'review']);
    const first = result.validations[0]; expect(first.delta.find(entry => entry.role === 'test')?.state).toBe('regression');
    expect(first.executions.map(execution => execution.commands.map(command => command.role))).toEqual([['build','test'], ['test']]);
    expect(first.failures.filter(failure => failure.classification === 'introduced')).toHaveLength(1);
    if (kind === 'cache') {
      expect(first.executions.map(execution => execution.commands.find(command => command.role === 'test')!.failureCount)).toEqual([3, 2]);
      expect(first.failures.filter(failure => failure.classification === 'pre-existing')).toHaveLength(2);
      expect(first.delta.find(entry => entry.role === 'test')!.newFailureIdentifiers.join('')).toContain('test_vast_shared_search_state_lives_with_tool_state_not_tmp');
    }
    expect(result.validations).toHaveLength(2); expect(result.validations[1].pass, JSON.stringify(result.validations[1])).toBe(true);
    expect(readEvidence(result.rd).some(entry => entry.kind === 'command' && entry.reproductionOf !== undefined && entry.exitCode === 0)).toBe(true);
    expect(evidenceContext(result.root, result.rd)).not.toContain('AUTHOR_TRANSCRIPT');
  });
});
