import { initializeEvidence } from '../../dist-rewrite/records/evidence.js';
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claim, release, initializeState, openJournal, readEvents } from '../../dist-rewrite/records/state.js';
import { readEvidence } from '../../dist-rewrite/records/evidence.js';
import { tmpdir } from 'node:os';
import { execute as main } from '../../dist-rewrite/ops/main.js';
import type { Result } from '../../dist-rewrite/contract/brief.js';
import type { RunRef } from '../../dist-rewrite/contract/runtime.js';
function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value; }
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

import { stateFixture, get, digest } from "../fixtures/rewrite-state.js";
import { runWorkflow } from "../../dist-rewrite/core/loop.js";
import { workflowFixture, attemptAudit } from "../fixtures/rewrite-workflow.js";
import { runDeclaredCommand } from "../../dist-rewrite/exec/command.js";
import { appendEvents, putEvidence, recordOperation, storeEvidence } from "../../dist-rewrite/records/state.js";
import type { StageAnswer } from "../../dist-rewrite/contract/answers.js";
import type { AttemptReceipt } from "../../dist-rewrite/contract/runtime.js";
it.each(['valid', 'candidate-edit'] as const)('P6 fresh final receipts and independent report review after author changes: %s',
 async (fault) => {
  const evaluate = ("const fs=require('node:fs'),crypto=require('node:crypto');const " +
    "result={label:'delivered'," +
    "candidate_sha256:crypto.createHash('sha256').update(fs.readFileSync('candidate.txt'))" +
    ".digest('hex')};" +
    "fs.writeFileSync('final.json',JSON.stringify(result));" +
    "console.log(JSON.stringify(result));process.exit(" +
    '0' +
    ");");
  const commands = [{ id: 'Evaluate', argv: [process.execPath, '-e', evaluate], env: {}, inputs: [], required: true }, { id: 'Unit',
   argv: [process.execPath, '-e', "require('node:fs').writeFileSync('unit.json','verified')"], env: {}, inputs: [], required: true }];
  const node = (id: string, after: string[] = [], selected: string[] = []) => ({ id, role: 'author', purpose: 'work' as const, after,
   commands: selected, instruction: 'Explicit finite work',  });
  const graph = { stages: [node('candidate'), node('report', ['candidate'], ['Evaluate',
   'Unit']), { id: 'gate', role: 'author',
   purpose: 'gate' as const, after: ['report'], commands: [],
    }] };
  const f = await stateFixture({ commands, results: [{ id: 'delivered', text: 'Delivered' }, { id: 'alternate', text: 'Alternate' }] }, graph);
  await f.admit();
  const { ports, seen } = workflowFixture(f);
  const factory = runProcessFactory(f);
  ports.command = request => runDeclaredCommand(request, { scope: f.scope, writer: f.execution, process: factory,
   abort: new AbortController().signal });
  const reportSnapshots: string[] = [];
  const receipt = async (request: any, before: string, answer: StageAnswer): Promise<AttemptReceipt> => ({ address: request.address,
   ending: 'delivered', before, after: await f.tree(), ...await attemptAudit(f, request), closure: 'dead', usage: { state: 'unknown', raw: [] }, evidence: [],
   inputChars: 1, answer, answerRef: get(await putEvidence(f.journal, Buffer.from(JSON.stringify(answer)))) });
  const author: StageAnswer = { kind: 'work', answer: { status: 'delivered', summary: 'Finite authored result', caveats: [],
   remainingWork: [], blocks: null } };
  ports.attempt = async (request) => {
    seen.push(request);
    const before = await f.tree();
    if (request.stage.id === 'candidate') {
      await writeFile(join(f.project, 'candidate.txt'), 'Chosen candidate');
      await writeFile(join(f.project, 'dependency.txt'), 'Measured prerequisite');
      await writeFile(join(f.project, 'tests.txt'), 'Meaningful assertions');
      return { ok: true, value: await receipt(request, before, author) };
    }
    if (request.stage.id === 'report') {
      const p = await f.projection();
      const measured = JSON.parse(await readFile(join(f.project, 'final.json'), 'utf8'));
      const executions = p.commands.map(c => ({ command: c.command, context: c.key.context, stdout: c.stdout, execution: c.execution }));
      const report = { measured, executions: executions };
      await writeFile(join(f.project, 'REPORT.md'), JSON.stringify(report));
      reportSnapshots.push(JSON.stringify(report));
      if (fault === 'candidate-edit')
        await writeFile(join(f.project, 'candidate.txt'), 'Changed after evaluation');
      return { ok: true, value: await receipt(request, before, author) };
    }
    // The doubled independent reviewer owns semantic meaning, using actual stdout/product/report and source bytes.
    const p = await f.projection(), last = p.commands.findLast(c => c.command === 'Evaluate')!;
    const measured = JSON.parse(await readFile(join(f.project, 'final.json'), 'utf8')),
     report = JSON.parse(await readFile(join(f.project, 'REPORT.md'), 'utf8'));
    const stdout = JSON.parse(Buffer.from(get(await readEvidence(f.journal, last.stdout))).toString());
    const candidate = digest(await readFile(join(f.project, 'candidate.txt')));
    const truthful = JSON.stringify(stdout) === JSON.stringify(measured) && measured.candidate_sha256 === candidate &&
     JSON.stringify(report.executions) === JSON.stringify(p.commands.slice(0,2).map(c => ({ command: c.command, context: c.key.context, stdout: c.stdout,
     execution: c.execution }))) && JSON.stringify(report.measured) === JSON.stringify(measured);
    // Publication owns fresh direct receipts; semantic report validity belongs to independent review.
    const accepted = truthful;
    const answer: StageAnswer = { kind: 'gate', answer: { outcome: accepted ? 'accepted' : 'rejected_irreparable',
     reason: truthful ? 'Full source/result/report relation verified' : 'Actual evidence mismatch', criteria: { correct: {
     status: accepted ? 'pass' : 'fail', evidence: 'Actual native result, every execution, report and source bytes',
     ...(accepted ? {} : { briefQuote: f.brief.declaration.criteria[0].text }) } }, findings: [],
     remainingWork: [], result: measured.label } };
    return { ok: true, value: await receipt(request, before, answer) };
  };
  try {
    const result = get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
    expect(result.status === 'complete').toBe(fault === 'valid');
    const p = await f.projection();
    expect(p.commands.filter(c => c.command === 'Evaluate')).toHaveLength(2);
    expect(p.commands.slice(0,2).every(c => c.before !== c.after)).toBe(true);
    expect(p.commands.every(c => c.delta && c.key.generation)).toBe(true);
    expect(reportSnapshots).toHaveLength(1);
    expect(p.intervals.every(i => i.spentMs !== null)).toBe(true);
    if (fault === 'valid')
      expect(seen.map(r => r.stage.id)).toEqual(['candidate', 'report', 'gate']);
    if (fault === 'candidate-edit')
      expect(result).toMatchObject({status:'failed',reason:'gate_irreparable'});
  }
  finally {
    await f.close();
  }
});
function runProcessFactory(f: Awaited<ReturnType<typeof stateFixture>>): import('../../dist-rewrite/host/process.js').ProcessPorts { return { storeEvidence: (source: any) => storeEvidence(f.journal,
 source), streamRoot: f.journal.root, scratch: join(f.root, 'work'), operation: (request: any) => recordOperation(f.journal, 'construct',
 request), putEvidence: (bytes: Uint8Array) => putEvidence(f.journal, bytes), readEvidence: (ref: any) => readEvidence(f.journal, ref),
 recordProcess: async (payload: any) => appendEvents(f.execution, (await f.projection()).cursor, [payload]) }; }
it('main-bound ProcessPorts authenticate real journal evidence and refuse same-size tampering end to end', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rewrite-evidence-integration-'));
  await mkdir(join(root, 'units'));
  let acquired: import('../../dist-rewrite/host/process.js').Claim | undefined;
  const runModule = await import('../../dist-rewrite/ops/run.js');
  const spy = vi.spyOn(runModule, 'runUnitEntry');
  const { openWriter } = await import('../../dist-rewrite/records/state.js');
  try {
  const database = value(initializeState(join(root, 'units', 'state.sqlite')));
  const storeRoot = join(root, 'store'), runtimeRoot = join(storeRoot, 'pins/EngineIntegration');
  await mkdir(join(runtimeRoot, 'config'), { recursive: true });
  const configuration = Buffer.from(JSON.stringify({
    roles: [{ id: 'declared_role', description: 'No model called', prompt: 'Explicit prompt', backend: 'claude',
     model: 'declared-model', effort: 'low' }], devices: ['/dev/null'], providerHomes: { codex: [],
     claude: [] },
  }));
  const runtimeFile = join(runtimeRoot, 'config/runtime.json');
  await writeFile(runtimeFile, configuration);
  await chmod(runtimeFile, 0o444);
  const manifest = Buffer.from(JSON.stringify([{ path: 'config/runtime.json', sha256: hash(configuration), executable: false }]));
  const manifestFile = join(runtimeRoot, '.pin');
  await writeFile(manifestFile, manifest);
  await chmod(manifestFile, 0o444);
  const location = { database, storeRoot, run: 'EvidenceRun' };
  const unit: RunRef = { run: location.run, authority: 'synthetic-run',
    runtime: { path: 'pins/EngineIntegration/.pin', sha256: hash(manifest) } };
  let services: import('../../dist-rewrite/ops/run.js').RunServices | undefined;
  spy.mockImplementation(async (_location, _unit, supplied) => {
    services = supplied;
    return { ok: true, value: { status: 'complete', reason: 'completed', detail: 'Composition boundary only' } };
  });
  const stderr: string[] = [];
  expect(await main(['unit-entry', '--run', location.run, '--unit', JSON.stringify(unit)], {
    cwd: root, storeRoot, runtimeRoot, home: join(root, 'units'), environment: {}, stdin: new Uint8Array(),
    abort: new AbortController().signal, stdout: async () => { }, stderr: async (bytes) => { stderr.push(Buffer.from(bytes).toString()); },
  }), stderr.join('')).toBe(0);
  expect(services).toBeDefined();
  const journal = value(await openJournal(location, 'create'));
  await initializeEvidence(journal);
  acquired = value(await claim(join(root, 'execution-owner'), null, { database, holder: journal.root }));
  const writer = value(await openWriter(journal, acquired, 'execution'));
  const process = services!.process(writer);
  expect(await process.recordProcess({ type: 'ownership', owner: acquired.owner, state: 'live' })).toMatchObject({ ok: true });
  expect(value(await readEvents(journal, 0))).toHaveLength(1);
  const original = Buffer.from('real evidence original'), tampered = Buffer.from('real evidence tampered');
  expect(original.length).toBe(tampered.length);
  const ref = value(await process.putEvidence(original));
  expect(Buffer.from(value(await process.readEvidence(ref)))).toEqual(original);
  const oid = ref.path.split('/').at(-1)!;
  const evidenceFile = join(journal.root, 'git-common', 'objects', oid.slice(0, 2), oid.slice(2));
  await chmod(evidenceFile, 0o600);
  await writeFile(evidenceFile, (await import('node:zlib')).deflateSync(Buffer.concat([Buffer.from('blob ' + tampered.length + '\0'), tampered])));
  await chmod(evidenceFile, 0o444);
  expect((await import('node:zlib')).inflateSync(await readFile(evidenceFile)).subarray(Buffer.from('blob ' + tampered.length +
   '\0').length)).toEqual(tampered);
  expect(await process.readEvidence(ref)).toMatchObject({ ok: false, kind: 'invalid' });
  } finally {
    spy.mockRestore();
    if (acquired) value(await release(acquired));
    await rm(root, { recursive: true, force: true });
  }
});
