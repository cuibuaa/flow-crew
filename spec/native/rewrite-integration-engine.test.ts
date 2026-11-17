import { identifyEvidence } from "../../dist-rewrite/records/evidence.js";
import { claim, release } from "../../dist-rewrite/records/state.js";
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute as main, type MainContext } from "../../dist-rewrite/ops/main.js";
import { parseBrief, type AdmittedBrief, type Result } from "../../dist-rewrite/contract/brief.js";
import type { Launch, SetupEvidence, RunRef } from "../../dist-rewrite/contract/runtime.js";
import { startRun, observeRun, closeController } from "../../dist-rewrite/host/process.js";
import { initializeState, openJournal, readEvents } from "../../dist-rewrite/records/state.js";
import { readProjection } from "../../dist-rewrite/records/state.js";
import { readEvidence } from "../../dist-rewrite/records/evidence.js";
import { readRunStatus } from "../../dist-rewrite/ops/status.js";
// Only the detached supervisor is outside this deterministic test. All claims,
// confinement, owned children, protocols, records, accounting and routing are real.
vi.mock("../../dist-rewrite/host/process.js", async (importOriginal) => ({
  ...await importOriginal<typeof import('../../dist-rewrite/host/process.js')>(),
  startRun: vi.fn(), observeRun: vi.fn(),
}));
let root: string | undefined;
afterEach(async () => { await closeController(); if (root)
  await rm(root, { recursive: true, force: true }); root = undefined; });
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function value<T>(result: Result<T>): T { if (!result.ok)
  throw new Error(JSON.stringify(result)); return result.value; }
it.each([false, true])('composes real setup through completion; retired budgets ignored=%s', async (retired) => {
  const budgets = { actions: 908172635, runDurationMs: 908172636, inputLimitChars: 908172637 };
  const adapterLimits = { codex: 908172638, claude: 908172639 };
  const budgetValues = [...Object.values(budgets), ...Object.values(adapterLimits)].map(String);
  root = await mkdtemp(join(tmpdir(), 'rewrite-engine-integration-'));
  await mkdir(join(root, 'units'));
  const database = value(initializeState(join(root, 'units', 'state.sqlite')));
  const storeRoot = join(root, 'store'), runtimeRoot = join(storeRoot, 'pins/EngineIntegration');
  const source = join(root, 'source'), project = join(root, 'project'), bin = join(root, 'bin'), home = join(root, 'home');
  await Promise.all([mkdir(join(runtimeRoot, 'config/roles'), { recursive: true }), mkdir(source), mkdir(bin), mkdir(home)]);
  const configuration = {
    ...(retired ? { bounds: budgets, adapterInputLimitChars: adapterLimits } : {}),
    roles: ['plan', 'work', 'gate'].map(purpose => ({ id: `${purpose}_role`, description: purpose,
      prompt: `Execute the explicit ${purpose} instruction.`, backend: 'claude' as const, model: 'fixture-model', effort: 'low' })),
    sharedCaches: [], devices: ['/dev/null'], providerHomes: { codex: [],
     claude: [] },
  };
  const pinned = new Map<string, string>([['config/runtime.json', JSON.stringify(configuration)], ['cli.js',
   '// Entry never launched by the supervisor double.\n']]);
  for (const purpose of ['plan', 'work', 'gate'])
    pinned.set(`config/roles/${purpose}.md`, `Return the schema-bound ${purpose} answer.`);
  const files = [];
  for (const [path, text] of pinned) {
    await writeFile(join(runtimeRoot, path), text);
    await chmod(join(runtimeRoot, path), 0o444);
    files.push({ path, sha256: hash(text), executable: false });
  }
  const manifest = JSON.stringify(files.sort((a, b) => a.path.localeCompare(b.path)));
  await writeFile(join(runtimeRoot, '.pin'), manifest);
  await chmod(join(runtimeRoot, '.pin'), 0o444);
  const runtime = { path: 'pins/EngineIntegration/.pin', sha256: hash(manifest) };
  const unit: RunRef = { run: 'EngineIntegration', authority: 'synthetic-run', runtime };
  vi.mocked(startRun).mockImplementation(async (supplied) => ({ ok: true, value: { unit: supplied, state: 'active', owner: null,
   evidence: [], detail: 'Deterministic supervisor seam' } }));
  vi.mocked(observeRun).mockImplementation(async (supplied) => ({ ok: true, value: { unit: supplied, state: 'active', owner: null,
   evidence: [], detail: 'Deterministic supervisor seam' } }));
  const fakeClaude = ("#!" +
    `${process.execPath}` +
    "\nimport fs from 'node:fs';\nimport assert from 'node:assert/strict';\nimport { join } " +
    "from 'node:path';\nimport { spawnSync } from 'node:child_process';\nif " +
    "(process.argv.includes('--version')) { console.log('fixture-claude 1'); " +
    "process.exit(0); }\nconst prompt=JSON.parse(fs.readFileSync(0,'utf8'));\nconst " +
    "schema=JSON.parse(process.argv[process.argv.indexOf('--json-schema')+1]);\nconst " +
    "kind=schema.properties.kind.const;\nassert.equal(kind,prompt.stage.purpose);\nlet " +
    "protectedDenied=false;\ntry { fs.writeFileSync(join(prompt.evidenceRoot," +
    "'forbidden-native-write'),'forbidden'); } catch(error) { protectedDenied=['EACCES'," +
    "'EPERM','EROFS'].includes(error.code); }\nassert.equal(protectedDenied,true);" +
    "\nassert.ok(process.env.TMPDIR); fs.writeFileSync(join(process.env.TMPDIR," +
    "'native-scratch'),'allowed');\nlet answer;\nif(kind==='plan') {\n  " +
    "answer={baseRevision:schema.properties.answer.properties.baseRevision.const," +
    "plan:{observations:[{command:'verify',criterionIds:['addition']," +
    "sources:['specification.txt','sum.js','sum.test.js'],products:[]}],stages:[\n    " +
    "{id:'implementation',role:'work_role',purpose:'work',after:[],instruction:'Correct " +
    "addition.',skills:[]},\n    {id:'review',role:'gate_role',purpose:'gate'," +
    "after:['implementation'],instruction:'Verify addition independently.',skills:[]," +
    "commands:['verify']}\n  ]}};\n} else if(kind==='work') {\n  " +
    "fs.writeFileSync(join(prompt.project,'sum.js')," +
    `${JSON.stringify('export const sum = (a, b) => a + b;\n')}` +
    ");\n  answer={status:'delivered',summary:'Corrected addition.',caveats:[]," +
    "remainingWork:[],blocks:null};\n} else {\n  let projectDenied=false;\n  try { " +
    "fs.writeFileSync(join(prompt.project,'forbidden-review-write'),'forbidden'); } " +
    "catch(error) { projectDenied=['EACCES','EPERM','EROFS'].includes(error.code); }\n  " +
    "assert.equal(projectDenied,true);\n  const test=spawnSync(process.execPath,['--test'," +
    "'sum.test.js'],{cwd:prompt.project,env:process.env,encoding:'utf8',timeout:26*60_000,killSignal:'SIGKILL'});\n  " +
    "assert.equal(test.status,0,test.stdout+test.stderr);\n  const " +
    "evidence=prompt.commands.map(c=>({command:c.command,context:c.key.context," +
    "executions:prompt.commands.filter(x=>x.command===c.command).map(x=>x.key.context)}));" +
    "\n  answer={commandEvidence:evidence,outcome:'accepted',reason:'Independent Node test " +
    "passed under readonly project grant.',criteria:{addition:{status:'pass'," +
    "evidence:'Node test exit 0'}},findings:[],remainingWork:[]};" +
    "\n}\nconsole.log(JSON.stringify({type:'result',subtype:'success',is_error:false," +
    "structured_output:{kind,answer},usage:{input_tokens:12,output_tokens:7," +
    "cache_read_input_tokens:0,cache_creation_input_tokens:0},total_cost_usd:0}));\n");
  const executable = join(bin, 'claude');
  await writeFile(executable, fakeClaude);
  await chmod(executable, 0o755);
  await writeFile(join(bin, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(source, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(source, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
  await writeFile(join(source, 'sum.test.js'),
   "import assert from 'node:assert/strict'; import { sum } from './sum.js'; assert.equal(sum(2, 3), 5);\n");
  const specification = 'Addition returns the mathematical sum.\n';
  await writeFile(join(source, 'specification.txt'), specification);
  const commandCode = ("const fs=require('node:fs'),cp=require('node:child_process')," +
    "assert=require('node:assert/strict');\nassert.equal(process.env.DECLARED_ONLY,'yes'); " +
    "assert.equal(process.env.HOME,undefined); assert.equal(process.env.PATH,undefined); " +
    "assert.equal(process.env.PRIVATE_ONLY,undefined);\nfs.writeFileSync('/dev/null'," +
    "'device allowed'); fs.writeFileSync(process.env.TMPDIR+'/command-scratch','scratch " +
    "allowed');\nconst child=cp.spawnSync(process.execPath,['--test','sum.test.js'],{env:{}," +
    "encoding:'utf8',timeout:26*60_000,killSignal:'SIGKILL'}); process.stdout.write(child.stdout); " +
    "process.stderr.write(child.stderr); process.exit(child.status ?? 1);");
  const declaration = { criteria: [{ id: 'addition', text: 'Addition is correct.' }],
    inputs: [{ id: 'specification', path: 'specification.txt', kind: 'file', frozen: true }], outputs: [], results: [],
    commands: [{ id: 'verify', argv: [process.execPath, '-e', commandCode], env: { DECLARED_ONLY: 'yes' }, inputs: ['specification'],
     required: true }],
    ...(retired ? { bounds: budgets } : {}), allowBlocked: false };
  const briefBytes = Buffer.from(`---\n${JSON.stringify(declaration)}\n---\nFix the failing addition test.\n`);
  const brief: AdmittedBrief = { declaration: value(parseBrief(briefBytes)), bytes: identifyEvidence(briefBytes),
    digest: hash(briefBytes) };
  const briefFile = join(root, 'brief.md');
  await writeFile(briefFile, briefBytes);
  const environment = { PATH: bin, HOME: home, PRIVATE_ONLY: 'adapter-only' };
  const controller = new AbortController();
  async function invoke(argv: string[], stdin?: unknown): Promise<unknown> {
    const stdout: string[] = [], stderr: string[] = [];
    const context: MainContext = { cwd: root!, storeRoot, runtimeRoot, home: join(root!, 'units'), environment,
      stdin: stdin === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(stdin)), abort: controller.signal,
      stdout: async (bytes) => { stdout.push(Buffer.from(bytes).toString()); }, stderr: async (bytes) => {
       stderr.push(Buffer.from(bytes).toString()); } };
    const exit = await main(argv, context);
    const diagnostics: string[] = [];
    if (exit !== 0) {
      const opened = await openJournal({ database, storeRoot, run: unit.run }, 'read');
      if (opened.ok) {
        const events = await readEvents(opened.value, 0);
        if (events.ok)
          for (const event of events.value.filter(event => event.payload.type === 'process').slice(-4)) {
            if (event.payload.type !== 'process')
              continue;
            const bytes = await readEvidence(opened.value, event.payload.receipt.stderr);
            if (bytes.ok)
              diagnostics.push(Buffer.from(bytes.value).toString());
          }
      }
    }
    expect(exit, (stderr.join('') || stdout.join('')) + diagnostics.join('\n')).toBe(0);
    if (argv[0] === 'setup') {
      const advisories = stderr.join('').split('\n').filter(line => line.includes('retired and ignored'));
      expect(advisories.sort()).toEqual(retired ? ['bounds: retired and ignored',
        'config.adapterInputLimitChars: retired and ignored', 'config.bounds: retired and ignored'] : []);
    }
    return JSON.parse(stdout.join(''));
  }
  const setup = await invoke(['setup', '--backend', 'claude', '--run', unit.run, '--unit', JSON.stringify(unit), '--brief', briefFile], {
   project: source, target: project, brief, runtime }) as SetupEvidence;
  expect(setup.nativeGrant).toBe('applied');
  expect(setup.commands).toEqual([]);
  const launch: Launch = { backend: 'claude', run: unit.run, project, brief, runtime, roles: configuration.roles, unit,
    setup };
  expect(await invoke(['start', '--run', unit.run, '--intent', JSON.stringify({ id: 'StartFixture', kind: 'start', run: unit.run, unit }),
   '--planner-role', 'plan_role'], launch)).toMatchObject({ state: 'acknowledged' });
  expect(startRun).toHaveBeenCalledTimes(1);
  expect(await invoke(['unit-entry', '--run', unit.run, '--unit', JSON.stringify(unit)])).toMatchObject({ status: 'complete',
   reason: 'completed' });
  const location = { database, storeRoot, run: unit.run }, journal = value(await openJournal(location, 'read'));
  const projection = value(await readProjection(journal)), status = value(await readRunStatus(location));
  expect(projection.status).toBe('complete');
  expect(status.status).toBe('complete');
  const statusBytes = await readFile(join(journal.root, 'status.json'), 'utf8');
  const absent = (text: string) => {
    for (const key of ['bounds', 'adapterInputLimitChars', 'retiredBounds', 'provenance', 'enforcement', 'limits'])
      expect(text).not.toContain('"' + key + '"');
    for (const number of budgetValues) expect(text).not.toContain(number);
  };
  absent(statusBytes);
  absent(JSON.stringify(projection.launch));
  absent(JSON.stringify(projection.authority));
  for (const attempt of projection.attempts) {
    const input = Buffer.from(value(await readEvidence(journal, attempt.evidence[0]))).toString();
    absent(input);
    expect(JSON.parse(input).brief.body).toBe('Fix the failing addition test.\n');
  }

  expect(projection.attempts.map(attempt => attempt.answer?.kind)).toEqual(['plan', 'work', 'gate']);
  expect(projection.attempts.every(attempt => attempt.ending === 'delivered' && attempt.closure === 'dead' &&
   attempt.usage.output === 7)).toBe(true);
  expect(projection.reservations).toHaveLength(1);
  expect(projection.reservations.every(reservation => reservation.state === 'committed')).toBe(true);
  expect(projection.commands.map(command => command.execution)).toEqual([{ state: 'complete', exit: 0 }]);
  expect(projection.invocations).toHaveLength(4);
  expect(projection.intervals.every(interval => interval.spentMs !== null)).toBe(true);
  expect(projection.owners.every(owner => owner.state === 'dead')).toBe(true);
  expect(await readFile(join(project, 'sum.js'), 'utf8')).toBe('export const sum = (a, b) => a + b;\n');
  const events = value(await readEvents(journal, 0));
  const terminal = events.find(event => event.payload.type === 'lifecycle' && event.payload.conclusion.status === 'complete');
  expect(status.statusSince).toBe(terminal!.seq);
  expect(status.journalCursor).toBe(projection.cursor);
  process.stderr.write('Native evidence integration-complete ' + JSON.stringify({ platform: process.platform,
    nativeGrant: setup.nativeGrant, status: projection.status, commandExits: projection.commands.map(command => command.execution),
    allOwnersDead: projection.owners.every(owner => owner.state === 'dead') }) + '\n');
});
import { stateFixture, get, digest } from "../fixtures/rewrite-state.js";
import { runWorkflow } from "../../dist-rewrite/core/loop.js";
import { workflowFixture } from "../fixtures/rewrite-workflow.js";
import { runDeclaredCommand } from "../../dist-rewrite/exec/command.js";
import { appendEvents, putEvidence, recordOperation, storeEvidence } from "../../dist-rewrite/records/state.js";
import type { StageAnswer } from "../../dist-rewrite/contract/answers.js";
import type { AttemptReceipt } from "../../dist-rewrite/contract/runtime.js";
it.each(['valid', 'candidate-edit'] as const)('P6 actual final publication for evaluation -> authored report -> fresh independent gate: %s',
 async (fault) => {
  const evaluate = ("const fs=require('node:fs'),crypto=require('node:crypto');const " +
    "result={label:crypto.randomInt(2)?'delivered':'alternate'," +
    "candidate_sha256:crypto.createHash('sha256').update(fs.readFileSync('candidate.txt'))" +
    ".digest('hex'),reading:crypto.randomBytes(8).toString('hex')};" +
    "fs.writeFileSync('final.json',JSON.stringify(result));" +
    "console.log(JSON.stringify(result));process.exit(" +
    '0' +
    ");");
  const commands = [{ id: 'Evaluate', argv: [process.execPath, '-e', evaluate], env: {}, inputs: [], required: true }, { id: 'Unit',
   argv: [process.execPath, '-e', "require('node:fs').writeFileSync('unit.json','verified')"], env: {}, inputs: [], required: true }];
  const node = (id: string, after: string[] = [], selected: string[] = []) => ({ id, role: 'author', purpose: 'work' as const, after,
   commands: selected, instruction: 'Explicit finite work', skills: [] });
  const graph = { observations: [{ command: 'Evaluate', criterionIds: ['correct'], sources: ['candidate.txt', 'dependency.txt'], products: ['final.json'] }, { command: 'Unit', criterionIds: ['correct'],
   sources: ['candidate.txt', 'tests.txt'], products: ['unit.json'] }], stages: [node('candidate'), node('report', ['candidate'], ['Evaluate',
   'Unit']), { id: 'gate', role: 'author',
   purpose: 'gate' as const, after: ['report'], commands: [],
   instruction: 'Independent review of every result and final measured source', skills: [] }] };
  const f = await stateFixture({ commands, results: [{ id: 'delivered', text: 'Delivered' }, { id: 'alternate', text: 'Alternate' }] }, graph);
  await f.admit();
  const { ports, seen } = workflowFixture(f);
  const factory = runProcessFactory(f);
  ports.command = request => runDeclaredCommand(request, { scope: f.scope, writer: f.execution, process: factory,
   abort: new AbortController().signal });
  const reportSnapshots: string[] = [];
  const receipt = async (request: any, before: string, answer: StageAnswer): Promise<AttemptReceipt> => ({ address: request.address,
   ending: 'delivered', before, after: await f.tree(), audit: f.ref, closure: 'dead', usage: { state: 'unknown', raw: [] }, evidence: [],
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
      const p = await f.projection(), last = p.commands.findLast(c => c.command === 'Evaluate')!;
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
     JSON.stringify(report.executions) === JSON.stringify(p.commands.map(c => ({ command: c.command, context: c.key.context, stdout: c.stdout,
     execution: c.execution }))) && JSON.stringify(report.measured) === JSON.stringify(measured);
    // Source/context faults intentionally test the code floor even with a schema-valid accepted answer.
    const accepted = true; // Force the code floor to judge source validity independently.
    const evidence = commands.map(c => ({ command: c.id,
     context: p.commands.findLast(x => x.command === c.id)!.key.context,
     executions: p.commands.filter(x => x.command === c.id).map(x => x.key.context) }));
    const answer: StageAnswer = { kind: 'gate', answer: { outcome: accepted ? 'accepted' : 'rejected_irreparable',
     reason: truthful ? 'Full source/result/report relation verified' : 'Actual evidence mismatch', criteria: { correct: {
     status: truthful ? 'pass' : 'fail', evidence: 'Actual native result, every execution, report and source bytes' } }, findings: [],
     remainingWork: [], result: measured.label, commandEvidence: evidence } };
    // Accepted branch requires a full explicit-pass map; source validity remains an independent code check.
    if (accepted)
      answer.answer.criteria.correct.status = 'pass';
    return { ok: true, value: await receipt(request, before, answer) };
  };
  try {
    const result = get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }));
    expect(result.status === 'complete').toBe(fault === 'valid');
    const p = await f.projection();
    expect(p.commands.filter(c => c.command === 'Evaluate')).toHaveLength(1);
    expect(p.commands.every(c => c.before !== c.after)).toBe(true);
    expect(p.commands.every(c => c.delta && c.key.generation)).toBe(true);
    expect(reportSnapshots).toHaveLength(1);
    expect(p.intervals.every(i => i.spentMs !== null)).toBe(true);
    if (fault === 'valid')
      expect(seen.map(r => r.stage.id)).toEqual(['candidate', 'report', 'gate']);
    if (fault === 'candidate-edit')
      expect(p.backstop.failureSuffix).toBe(4);
  }
  finally {
    await f.close();
  }
});
function runProcessFactory(f: Awaited<ReturnType<typeof stateFixture>>) { return { storeEvidence: (source: any) => storeEvidence(f.journal,
 source), streamRoot: f.journal.root, scratch: join(f.root, 'work'), operation: (request: any) => recordOperation(f.journal, 'construct',
 request), putEvidence: (bytes: Uint8Array) => putEvidence(f.journal, bytes), readEvidence: (ref: any) => readEvidence(f.journal, ref),
 recordProcess: async (payload: any) => appendEvents(f.execution, (await f.projection()).cursor, [payload]) }; }
it('P6 preparation -> build -> verification effects retain source-valid evidence through report assembly', async () => {
  const commands = [
    { id: 'Install', argv: [process.execPath, '-e',
     "const fs=require('node:fs');fs.mkdirSync('deps');fs.writeFileSync('deps/library','installed')"], env: {}, inputs: [], required: true },
    { id: 'Build', argv: [process.execPath, '-e',
     "const fs=require('node:fs');fs.writeFileSync('bundle',fs.readFileSync('deps/library')+' built')"], env: {}, inputs: [], required: true },
    { id: 'Verify', argv: [process.execPath, '-e', ("const fs=require('node:fs');if(fs.readFileSync('bundle','utf8')!=='installed " +
          "built')process.exit(1);fs.writeFileSync('verification','passed')")], env: {}, inputs: [], required: true },
  ];
  const observation = [['Install', ['package.json'], ['deps']], ['Build', ['source', 'deps'], ['bundle']], ['Verify', ['source',
   'bundle'], ['verification']]].map(([command, sources, products]) => ({ command, criterionIds: ['correct'], sources, products }));
  const graph = { observations: observation, stages: [{ id: 'source', role: 'author', purpose: 'work', after: [],
   instruction: 'Implement', skills: [] }, { id: 'report', role: 'author', purpose: 'work', after: ['source'], commands: ['Install', 'Build',
   'Verify'], instruction: 'Assemble report', skills: [] }, { id: 'gate', role: 'author', purpose: 'gate', after: ['report'], commands: [],
   instruction: 'Review all source and effects', skills: [] }] };
  const f = await stateFixture({ commands }, graph as any);
  await f.admit();
  const { ports, seen } = workflowFixture(f);
  ports.command = request => runDeclaredCommand(request, { scope: f.scope, writer: f.execution, process: runProcessFactory(f),
   abort: new AbortController().signal });
  ports.attempt = async (request) => {
    seen.push(request);
    const before = await f.tree();
    let answer: StageAnswer;
    if (request.stage.id === 'source') {
      await writeFile(join(f.project, 'source'), 'Implementation');
      await writeFile(join(f.project, 'package.json'), '{}');
    }
    if (request.stage.id === 'report')
      await writeFile(join(f.project, 'REPORT.md'), 'Report assembled after all actual build and test effects');
    if (request.stage.purpose === 'gate') {
      const p = await f.projection();
      answer = { kind: 'gate', answer: { outcome: 'accepted', reason: 'Complete direct-zero chain and final source', criteria: {
       correct: { status: 'pass', evidence: 'Native install/build/verification effects' } }, findings: [], remainingWork: [],
       commandEvidence: commands.map(c => ({ command: c.id, context: p.commands.findLast(x => x.command === c.id)!.key.context,
       executions: p.commands.filter(x => x.command === c.id).map(x => x.key.context) })) } };
    }
    else
      answer = { kind: 'work', answer: { status: 'delivered', summary: 'Finite work completed', caveats: [], remainingWork: [],
       blocks: null } };
    return { ok: true, value: { address: request.address, ending: 'delivered', before, after: await f.tree(), audit: f.ref,
     closure: 'dead', usage: { state: 'unknown', raw: [] }, evidence: [], inputChars: 1, answer, answerRef: get(await putEvidence(f.journal,
     Buffer.from(JSON.stringify(answer)))) } };
  };
  try {
    expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
    expect((await f.projection()).commands.map(c => c.command)).toEqual(['Install', 'Build', 'Verify']);
    expect(seen.map(r => r.stage.id)).toEqual(['source', 'report', 'gate']);
  }
  finally {
    await f.close();
  }
});

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
     model: 'declared-model', effort: 'low' }],
    sharedCaches: [], devices: ['/dev/null'], providerHomes: { codex: [],
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
    if (acquired) value(await release(acquired, 'retire'));
    await rm(root, { recursive: true, force: true });
  }
});
