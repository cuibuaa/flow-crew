// One synthetic public-entry acceptance driver for the checkout and installed tarball.
// Internal imports below only READ evidence or authenticate cleanup; all lifecycle
// requests and workload dispatch go through the public executable.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { providerProtocol, nativePrompt } from './provider-protocol.mjs';

// One real witness per recovery control mechanism; policy cross products live
// in the portable decision owners. Keep this list shared with installed consumers.
const recoveryCases = [
  {reason:'unknown',phase:'work',control:'text',scenario:'matrix-unknown-work-text'},
  {reason:'dead',phase:'settlement',control:'plan',scenario:'matrix-dead-settlement-plan'},
  {reason:'restore',phase:'installed',control:'resume',scenario:'matrix-restore-installed-resume'},
  {reason:'dead',phase:'command',control:'resume',scenario:'matrix-dead-command-resume'},
];
export const controlCases = [
  ...['plan','work','gate'].map(nativeKind=>({scenario:'cancel-native-'+nativeKind,action:'cancel',nativeKind,point:''})),
  ...['input','reserved','exited','received','capture','transition'].map(point=>({scenario:'cancel-boundary-'+point,action:'cancel',nativeKind:'',point})),
  ...['plan','work','gate'].map(nativeKind=>({scenario:'guide-native-'+nativeKind,action:'guide',nativeKind,point:''})),
];
export const acceptanceCases = ['host-claude', 'host-codex', 'plan-repair', 'fixed-graph', 'fixed-repair', 'frozen-copy',
  'dependency-reuse', 'many-command-later-gate', 'stale-source', 'mutable-input', 'frozen-input',
  'dead-controller', 'external-signal', 'reconcile', 'fresh-request', 'inactivity', 'inactivity-unknown', 'fatal-result', 'cancel-stage-start', 'resume-guide', 'resume-direct', 'resume-cancel', 'refusal-schema', 'refusal-plan', 'command-preparation', 'gate-tree',
  ...recoveryCases.map(cell=>cell.scenario),
  ...['staging','artifact','published','evidence','user-directory'].map(phase=>'reclaim-'+phase),
  ...controlCases.map(cell=>cell.scenario),'terminal-accepted_blocked','terminal-failed'];
// Passing public history: maximum 418,624 ms for a current scenario
// (step-9-G1/logs/specs.log, many-command-later-gate). 50% margin, rounded up.
export const publicTestTimeoutMs = 11 * 60_000;
const backstop = publicTestTimeoutMs;
/** @param {import('node:crypto').BinaryLike} bytes */
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** @template T @param {import('../../../rewrite-src/contract/brief.js').Result<T>} result @returns {T} */
const value = result => { assert(result.ok, JSON.stringify(result)); return result.value; };
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
/** @template T @param {()=>Promise<T|false>} probe @param {string} label @param {AbortSignal} [signal] @returns {Promise<T>} */
async function waitFor(probe, label, signal) {
  const start = performance.now();
  for (;;) {
    signal?.throwIfAborted();
    const result = await probe();
    if (result) return result;
    assert(performance.now() - start < backstop, `acceptance backstop: ${label}`);
    await pause();
  }
}

// Serialized into two test-owned native executables. They never call a model,
// discover credentials, or fall back to an installed provider.
export async function provider() {
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  /** @type {typeof import('node:assert/strict')} */
  const assert = (await import('node:assert/strict')).default;
  const fixture = JSON.parse(fs.readFileSync(String(globalThis.process.env.ACCEPTANCE_FIXTURE), 'utf8'));
  const backend = process.argv.includes('--output-schema') ? 'codex' : 'claude';
  await providerProtocol(backend, async (message, turn) => {
  const prompt = /** @type {any} */ (nativePrompt(backend, message));
  const kind = prompt.stage.purpose;
  const recovery = fixture.recovery;
  const control = fixture.control;
  const target = recovery && recovery.reason !== 'dead' && kind === 'work';
  /** @param {string[]} argv @param {Partial<import('node:child_process').SpawnSyncOptionsWithStringEncoding>} [options] */
  const call = (argv, options = {}) => spawnSync('nice', ['-n', '19', ...argv], {
    cwd: prompt.project, env: process.env, encoding: 'utf8', timeout: publicTestTimeoutMs, killSignal: 'SIGKILL', ...options });
  // Stage ids are not sent to the model; the fixture recognises the stages it planned by their goal text.
  const stageId = prompt.text.includes('Change only a/ after the first review.') ? 'repair'
    : prompt.text.includes('Perform the next work obligation.') ? 'measurement' : kind;
/** @param {Record<string,unknown>} row */
  const trace = row => fs.appendFileSync(fixture.trace, JSON.stringify({ kind, backend, ...row }) + '\n');
/** @param {string} path */
  const wait = async path => { while (!fs.existsSync(path)) await new Promise(resolve => setTimeout(resolve, 25)); };
/** @param {unknown} object */
  const emit = object => console.log(JSON.stringify(object));
/** @param {import('node:child_process').SpawnSyncReturns<string>} result */
  function tool(result) {
    const output = result.stdout + result.stderr;
    if (backend === 'codex') emit({ type: 'item.completed', item: { type: 'command_execution', command: 'node check.mjs',
      exit_code: result.status, aggregated_output: output } });
    else {
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'check', name: 'Bash', input: { command: 'node check.mjs' } }] } });
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'check', content: output, is_error: result.status !== 0 }] } });
      turn.boundary();
    }
  }
  assert.equal(process.env.PRIVATE_ONLY, 'adapter-only');
  assert.equal(process.env.SSL_CERT_FILE, fixture.ca);
  assert.equal(process.env.HTTPS_PROXY, 'http://synthetic.invalid');
  assert.equal(process.env.CLAUDE_CODE_TMPDIR, fixture.nativeTmp);
  assert(process.argv.includes('synthetic-model'));
  fs.writeFileSync(join(String(process.env.TMPDIR), 'provider-scratch'), 'native context');
  trace({ event: 'entered', pid: process.pid, parent: process.ppid, project: prompt.project });
  if (control?.nativeKind === kind && !fs.existsSync(join(fixture.root,'control-ready'))) {
    fs.writeFileSync(join(fixture.root,'control-ready'),'native entered');
    await wait(join(fixture.root,'control-release'));
  }
  // Four actual malformed author answers exercise C2 through the native adapter.
  let failAuthor = false;
  if (['resume-guide','resume-direct','resume-cancel'].includes(fixture.scenario) && kind === 'work') {
    const counter = join(fixture.root, 'authors');
    const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(count + 1));
    trace({ event: 'author-invocation', number: count + 1, guidance: prompt.guidance });
    failAuthor = count < 4;
    if (!failAuthor && fixture.scenario === 'resume-cancel') {
      fs.writeFileSync(join(fixture.root, 'resumed-ready'), 'yes');
      await wait(join(fixture.root, 'resumed-release'));
    }
  }
  if (target) {
    const counter = join(fixture.root, 'recovery-count');
    const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter,'utf8')) : 0;
    fs.writeFileSync(counter,String(count+1));
    trace({event:'recovery-invocation',number:count+1,guidance:prompt.guidance});
    if (count === 0) {
      trace({event:'structured-error'});
      if (backend === 'codex') emit({type:'turn.failed',error:{code:'synthetic_unknown'}});
      else emit({type:'result',subtype:'error',is_error:true});
      return;
    }
  }
  const correctionText = prompt.correction ?? '';
  /** @param {string} text */
  const saw = text => correctionText.includes(text);
  trace({ event: 'input-contract', purpose: prompt.instruction, correction: prompt.correction });
  // The role text arrives through the provider's instruction option, the task as Markdown, the schema only natively.
  if (fixture.scenario.startsWith('fixed-')) assert.notEqual(kind, 'plan', 'a brief that does not declare decomposition never reaches a planner');
  if (kind === 'gate') assert.equal(prompt.section('This stage'), undefined, 'a gate input carries no planner-written instruction');
  assert(!prompt.text.includes(prompt.instruction.slice(0, 40)), 'role text is not repeated in the user message');
  assert(!prompt.text.includes('"baseRevision"') && !prompt.text.includes('"oneOf"') && !prompt.text.includes('"properties"'), 'no schema copy in the user message');
  // The message names the copy the model works in, the read-only source it was made from, and the invocation workspace.
  for (const path of [prompt.project, join(fixture.root, 'source'), prompt.workspace]) assert(prompt.text.includes(path), 'message names ' + path);
  // The instruction is the shipped role text plus the role's own prompt, whatever those say.
  assert.equal(prompt.instruction, fixture.roleText[kind], 'the instruction is the shipped ' + kind + ' role text');
  if (kind === 'plan') {
    assert(!JSON.stringify(prompt.schema).includes('"skills"'), 'live grammar has no stage skills');
    assert(!Object.hasOwn(prompt, 'skills'), 'no stage-skill loader/catalog');
  }
  let answer;
  if (failAuthor) answer = {};
  else if (kind === 'plan') {
    const counter = join(fixture.root, 'plans');
    const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(count + 1));
    const stages = [
      { id: 'implementation', role: 'work', purpose: 'work', after: [], instruction: 'Use measured host feedback to repair.',
        ...((['reconcile','cancel-stage-start','dead-controller'].includes(fixture.scenario) || ['command','exited'].includes(recovery?.phase) || ['reserved','exited'].includes(control?.point)) ? { commands: ['Verify'] } : {}) },
      ...(fixture.scenario === 'stale-source' ? [{id:'early',role:'gate',purpose:'gate',after:['implementation'],
        commands:['Verify']}] : []),
      ...(['fresh-request','stale-source'].includes(fixture.scenario) ? [{ id: 'measurement', role: 'work', purpose: 'work', after: [fixture.scenario==='stale-source'?'early':'implementation'],
        instruction: 'Perform the next work obligation.',  ...(fixture.scenario==='fresh-request'?{commands:['Verify']}:{}) }] : []),
      { id: 'review', role: 'gate', purpose: 'gate', after: [['fresh-request','stale-source'].includes(fixture.scenario) ? 'measurement' : 'implementation'],
        commands: fixture.scenario==='many-command-later-gate'
          ? fixture.commands.slice(0,-1) : ['stale-source','mutable-input','frozen-input'].includes(fixture.scenario)?[]:['Verify'] }
    ];
    if (fixture.scenario === 'dependency-reuse') {
      const review = stages.at(-1); assert(review);
      Object.assign(review,{commands:['A','B'],repair:{stage:'repair',returnsTo:'review'}});
      stages.push({id:'repair',role:'work',purpose:'work',after:[],instruction:'Change only a/ after the first review.'});
    }
    if(fixture.scenario==='plan-repair'&&count===0)stages[0].role='unknown';
    if (fixture.scenario === 'refusal-plan' && !saw('Graph requires one unique last delivery gate')) stages.pop();
    answer = { baseRevision: prompt.schema.properties.answer.properties.baseRevision.const,
      plan: { stages } };
    if (fixture.scenario === 'refusal-schema' && !saw('constructor')) Object.assign(answer.plan, { constructor: { unexpected: true } });
  } else if (kind === 'work') {
    if (fixture.scenario === 'fixed-repair' && prompt.section('Findings to address') !== undefined) {
      // The repair author (the only work stage that follows a rejection) receives the gate's findings only through its actual input.
      const found = prompt.section('Findings to address');
      assert(found.includes('Synthetic finding to repair'), 'repair author receives the rejecting gate findings through its actual input');
      trace({ event: 'repair-findings', finding: found });
      answer = {status:'delivered',summary:'Addressed the finding.',caveats:[],remainingWork:[],blocks:null};
    } else if (fixture.scenario === 'dependency-reuse' && stageId === 'repair') {
      fs.writeFileSync(join(prompt.project,'a','input.txt'),'repaired');
      answer = {status:'delivered',summary:'Changed only a/.',caveats:[],remainingWork:[],blocks:null};
    } else if (stageId === 'measurement') {
      if(fixture.scenario==='stale-source')fs.appendFileSync(join(prompt.project,'sum.mjs'),'// source changed after the earlier gate\n');
      answer = { status: 'delivered', summary: 'Observed without mutation.', caveats: [], remainingWork: [], blocks: null };
    } else {
      await wait(fixture.release); // Launcher shell has exited before any author work can complete.
      const run = () => call([process.execPath, 'check.mjs', fixture.socket]);
      const before = run(); tool(before); trace({ event: 'before', exit: before.status, stdout: before.stdout, stderr: before.stderr });
      assert.equal(before.signal, null);
      assert(before.status !== null && [0,1].includes(before.status), 'author retains host access: '+before.stderr);
      const measured = JSON.parse(before.stdout);
      if (before.status === 1) {
      assert.notEqual(measured.actual, measured.expected);
      assert(['+', '*'].includes(measured.operator));
      const repaired = `export const sum = (a,b) => a ${measured.operator} b;\n`;
      fs.writeFileSync(join(prompt.project, 'sum.mjs'), repaired);
      } else assert.equal(measured.actual, measured.expected);
      fs.writeFileSync(join(prompt.project, 'future.txt'), 'Created after plan admission.\n');
      if(fixture.scenario==='many-command-later-gate')fs.writeFileSync(join(prompt.project,'phase.txt'),'0');
      const after = run(); tool(after); trace({ event: 'after', exit: after.status, stdout: after.stdout, stderr: after.stderr });
      assert.equal(after.status, 0, after.stdout + after.stderr);
      fs.writeFileSync(join(prompt.project, 'product.json'), after.stdout);
      if (fixture.scenario === 'frozen-copy' && !fs.existsSync(join(fixture.root, 'mutated'))) {
        fs.writeFileSync(join(prompt.project, 'spec.txt'), 'authored frozen mutation');
        fs.writeFileSync(join(fixture.root, 'mutated'), 'yes');
      }
      if(['mutable-input','frozen-input'].includes(fixture.scenario))fs.writeFileSync(fixture.input,'changed between stages');
      answer = { status: 'delivered', summary: 'Repaired from actual host measurement and reran successfully.',
        caveats: [], remainingWork: [], blocks: null };
    }
  } else {
    assert.deepEqual(prompt.guidance, [], 'independent gate receives no author guidance');
    const checked = call([process.execPath, 'check.mjs', fixture.socket]); tool(checked);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(prompt.project,'product.json'),'utf8')),JSON.parse(checked.stdout), 'delivered product matches independent measurement');
    // The change and its base are real files and a real command the reviewer can run.
    const change = prompt.section('Change under review');
    const patch = join(prompt.workspace, 'change.patch');
    assert(change?.includes(patch), 'gate input names the change file');
    assert(fs.readFileSync(patch, 'utf8').includes('future.txt'), 'the change file holds the author change');
    const baseCommand = /run:\n\n(`+)\n(.+)\n\1/.exec(change)?.[2];
    assert(baseCommand, 'gate input gives a command that extracts the base');
    const extracted = spawnSync('sh', ['-c', baseCommand], { encoding: 'utf8', env: { ...process.env, PATH: `${process.env.PATH}:/usr/bin:/bin` } });
    assert.equal(extracted.status, 0, extracted.stderr);
    assert(!fs.existsSync(join(prompt.workspace, 'base', 'future.txt')) && fs.existsSync(join(prompt.workspace, 'base', 'sum.mjs')),
      'the extracted base is the project before the author ran');
    for (const command of prompt.commands) assert(fs.existsSync(command.log) && fs.readFileSync(command.log, 'utf8').startsWith('exit: '), 'command log is a file');
    trace({ event: 'gate-input', commands: prompt.commands.length, patchBytes: fs.statSync(patch).size });
    answer = { outcome: fixture.scenario==='terminal-accepted_blocked'?'accepted_blocked':fixture.scenario==='terminal-failed'?'rejected_irreparable':'accepted', reason: 'Independent real subprocess and source evidence passed.',
      criteria: { correct: { status: 'pass', evidence: checked.stdout } }, findings: [], remainingWork: [] };
    if (fixture.scenario === 'fixed-repair') {
      const counter = join(fixture.root,'reviews');
      const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter,'utf8')) : 0;
      fs.writeFileSync(counter,String(count+1));
      if (count === 0) answer = { outcome: 'rejected_repairable', reason: 'Synthetic first rejection.',
        criteria: { correct: { status: 'fail', evidence: 'Synthetic failing evidence.' } },
        findings: [{ id: 'finding_one', paths: [], reason: 'Synthetic finding to repair', criterionIds: ['correct'], class: 'criterion_unmet' }], remainingWork: ['Repair'] };
    }
    if (fixture.scenario === 'dependency-reuse') {
      const counter = join(fixture.root,'reviews');
      const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter,'utf8')) : 0;
      fs.writeFileSync(counter,String(count+1));
      answer.outcome = count === 0 ? 'rejected_repairable' : 'accepted';
      if (count > 0) {
        assert.deepEqual(prompt.commands.map(/** @param {any} item */ item=>item.command).sort(),['A','B']);
        const fresh = prompt.commands.find(/** @param {any} item */ item=>item.command==='A');
        const reused = prompt.commands.find(/** @param {any} item */ item=>item.command==='B');
        assert.equal(fresh.earlierStage,undefined,'a result produced for this gate is not labelled reused');
        assert.equal(reused.earlierStage,'review','a satisfied earlier result names the stage that produced it');
      }
      trace({event:'reuse-evidence',reused:prompt.commands});
    }

  }
  assert(!JSON.stringify({schema:prompt.schema,answer}).includes('observations'),'only the real generation grammar is used');
  if (fixture.scenario === 'gate-tree' && kind === 'gate') {
    // The reviewer accepts, and its tools leave a byproduct in the project it reviewed.
    fs.writeFileSync(join(prompt.project, 'gate-write.txt'), 'byproduct of the reviewer\'s tools');
    trace({ event: 'gate-wrote', project: prompt.project });
  }
  trace({ event: 'answer', stage:stageId, answer, correctionText });
  if (fixture.scenario === 'reconcile' && kind === 'plan' && Number(fs.readFileSync(join(fixture.root,'plans'),'utf8')) === 1) {
    emit({type:'result',subtype:'error',is_error:true});return;
  }
  if (backend === 'codex') {
    emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ kind, answer }) } });
    emit({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 7, cached_input_tokens: 0 } });
  } else emit({ type: 'result', subtype: 'success', is_error: false, structured_output: { kind, answer },
    usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0 });
  });
}

/** @param {{packageRoot:string,scenario:string,evidenceDirectory?:string,signal?:AbortSignal}} options */
export async function publicAcceptance({ packageRoot, scenario, evidenceDirectory, signal }) {
  assert(acceptanceCases.includes(scenario));
  let cleaning = false;
  /** @template T @param {()=>Promise<T|false>} probe @param {string} label @returns {Promise<T>} */
  const until = (probe, label) => waitFor(probe, label, cleaning ? undefined : signal);

  packageRoot = resolve(packageRoot);
  const recovery = recoveryCases.find(cell=>cell.scenario===scenario);
  const control = controlCases.find(cell=>cell.scenario===scenario);
  let artifact;
  if (['inactivity', 'inactivity-unknown', 'fatal-result', 'dead-controller', 'command-preparation'].includes(scenario) || recovery && ['closure','claim','receipt','dead','restore','capture'].includes(recovery.reason) || scenario.startsWith('reclaim-') || control?.point) {
    artifact = await disposablePackage(packageRoot);
    packageRoot = artifact.path;
    if (scenario === 'command-preparation') await replaceArtifact(packageRoot, 'exec/command.js',
      'const spawned = await launchInvocation',
      "const spawned = await (async () => ({ok:false,kind:'unavailable',detail:'Synthetic command preparation refusal: native recorder unavailable'}))");
    if (scenario === 'dead-controller') await replaceArtifact(packageRoot, 'host/process.js',
      'controllerOwner = { ...controllerOwner, members: await groupMembers(controllerOwner) };',
      `const testSurvivor=spawn('nice',['-n','19',process.execPath,'-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
       await new Promise((resolve,reject)=>{testSurvivor.once('spawn',resolve);testSurvivor.once('error',reject)});
       controllerOwner = { ...controllerOwner, members: await groupMembers(controllerOwner) };`);
    if(control?.point){
      const barrier=`const fs=await import('node:fs');const root=JSON.parse(fs.readFileSync(globalThis.process.env.ACCEPTANCE_FIXTURE,'utf8')).root;
        if(!fs.existsSync(root+'/control-release')){fs.writeFileSync(root+'/control-ready','engine boundary');
          while(!fs.existsSync(root+'/control-release'))await new Promise(resolve=>setTimeout(resolve,25));}`;
      /** @type {Record<string,[string,string,string]>} */
      const points={
        input:['exec/attempt.js','const dispatch = await readEvents(scope.journal, 0);',''],
        reserved:['exec/command.js','const facts = await readEvents(scope.journal, 0);',''],
        exited:['exec/command.js','const after = await captureGeneration(scope);',''],
        received:['core/settlement.js','const original = receipt;',"receipt.address.stage==='implementation'"],
        capture:['records/content.js','const manifest = known(await putEvidence(scope.journal, bytes(await tree(scope))));',"address.stage==='implementation'"],
        transition:['core/loop.js',"if (next.value.kind === 'transition') {",''],
      };
      const [file,point,condition]=points[control.point];
      const injected=condition?`if(${condition}){${barrier}}`:`{${barrier}}`;
      await replaceArtifact(packageRoot,file,point,control.point==='transition'?point+'\n'+injected:injected+'\n'+point);
    }
    if (recovery?.reason === 'restore' || scenario.startsWith('reclaim-')) {
      const barrier = `const fs=await import('node:fs');const root=JSON.parse(fs.readFileSync(globalThis.process.env.ACCEPTANCE_FIXTURE,'utf8')).root;
        if(!fs.existsSync(root+'/recovery-release')){fs.writeFileSync(root+'/recovery-ready',String(globalThis.process.pid));
          while(!fs.existsSync(root+'/recovery-release'))await new Promise(resolve=>setTimeout(resolve,25));}`;
      if (recovery?.reason === 'restore') {
        const point = 'const frozen = known(await settleFrozenInputs(scope));';
        await replaceArtifact(packageRoot,'records/content.js',point,`{${barrier}}\n`+point);
      } else if (scenario !== 'reclaim-user-directory') {
        /** @type {Record<string,[string,string]>} */
        const points = {
          staging:['records/content.js','await fs.mkdir(staging);'],
          artifact:['records/content.js','known(await restoreTask(journal, target, checkedSnapshot(output.snapshot)));'],
          published:['records/content.js','await publishNoReplace(staging, destination);'],
          evidence:['ops/land.js',"const directory = await fs.open(journal.root, 'r');"]
        };
        const point=points[scenario.slice('reclaim-'.length)];assert(point);
        await replaceArtifact(packageRoot,point[0],point[1],scenario==='reclaim-evidence'?`{${barrier}}\n`+point[1]:point[1]+`\n{${barrier}}`);
      }
    }
    if (recovery?.phase === 'settlement') await replaceArtifact(packageRoot,'core/settlement.js',
      'const original = receipt;',
      `const original = receipt;
       if(receipt.address.stage==='implementation'){
         const fs=await import('node:fs');const root=JSON.parse(fs.readFileSync(globalThis.process.env.ACCEPTANCE_FIXTURE,'utf8')).root;
         if(!fs.existsSync(root+'/recovery-ready')){fs.writeFileSync(root+'/recovery-ready','raw receipt durable');
           while(!fs.existsSync(root+'/recovery-release'))await new Promise(resolve=>setTimeout(resolve,25));}
       }`);
    if (scenario === 'inactivity-unknown') await replaceArtifact(packageRoot,'host/activity.js',
      'export async function sampleActivity(owner) {','export async function sampleActivity(owner) { return null;');
    if (scenario === 'fatal-result') await replaceArtifact(packageRoot, 'ops/run.js',
      'return await runWorkflow({ writer, scope: scope.value, ports, abort });',
      `const fs=await import('node:fs');const marker=JSON.parse(fs.readFileSync(globalThis.process.env.ACCEPTANCE_FIXTURE,'utf8')).root+'/fatal-once';
       if(!fs.existsSync(marker)){fs.writeFileSync(marker,'yes');return {ok:false,kind:"invalid",detail:"Synthetic catchable boundary Result"};}
       return await runWorkflow({ writer, scope: scope.value, ports, abort });`);
  }
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'fc-public-')));
/** @param {string} path @returns {Promise<any>} */
  const load = path => import(pathToFileURL(join(packageRoot, 'dist-rewrite', path)).href);
  const state = /** @type {typeof import('../../../rewrite-src/records/state.js')} */ (await load('records/state.js'));
  const host = /** @type {typeof import('../../../rewrite-src/host/process.js')} */ (await load('host/process.js'));
  const { parseRunStatusFile, parsePublicRunStatus } = /** @type {typeof import('../../../rewrite-src/contract/runtime.js')} */ (await load('contract/runtime.js'));
  const nativeIdentity = /** @type {typeof import('../../../rewrite-src/host/identity.mjs')} */ (await load('host/identity.mjs'));
  const source = join(root, 'source'), storeRoot = join(root, 'store'), home = join(root, 'home'), fcHome = join(root, 'state');
  // A Unix socket path is limited to 104-108 bytes, so the socket lives in its own short directory, whatever TMPDIR is.
  const socketRoot = await fs.mkdtemp('/tmp/fc-');
  const bin = join(root, 'bin'), trace = join(root, 'trace.jsonl'), socket = join(socketRoot, 'host.sock');
  const release = join(root, 'release'), entry = join(packageRoot, 'dist-rewrite/cli.js');
  let run = '';
  /** @type {import('node:net').Server | undefined} */ let server;
  /** @type {import('node:child_process').ChildProcess | undefined} */ let launcher;
/** @type {string[]} */ const requests = [];
  /** @type {Set<import('node:child_process').ChildProcess>} */ const children = new Set();
  const startedAt = performance.now();
  /** @type {Record<string,any>} */
  let report = { scenario, packageRoot, root, platform: process.platform };
  for (const path of [source, home, bin, fcHome]) await fs.mkdir(path);
  // The role text the engine must hand each stage: the shipped file composed with the role's own prompt by the engine's one composer.
  /** @param {string} purpose */
  const rolePrompt = purpose => 'Return the typed ' + purpose + ' result.';
  const { roleInstruction } = await load('exec/input.js');
  const roleText = Object.fromEntries(await Promise.all(['plan', 'work', 'gate'].map(async purpose =>
    [purpose, roleInstruction(await fs.readFile(join(packageRoot, 'config/roles', purpose + '.md'), 'utf8'), rolePrompt(purpose))])));
  const fixture = { root, scenario, recovery, control, trace, socket, release, roleText, input:join(root,'external-input.txt'), commands:/** @type {string[]} */([]), preload: '', ca: join(root, 'explicit-ca'), nativeTmp: join(root, 'explicit-native-tmp') };
  await fs.writeFile(join(root, 'fixture.json'), JSON.stringify(fixture));
  // Copy raw module bytes: a test runner may transform imported functions, so
  // serializing function.toString() is not a native executable source boundary.
  await fs.copyFile(new URL(import.meta.url), join(bin, 'provider.mjs'));
  await fs.copyFile(new URL('./provider-protocol.mjs', import.meta.url), join(bin, 'provider-protocol.mjs'));
  await fs.writeFile(join(bin, 'package.json'), '{"type":"module"}\n');
  for (const backend of ['claude', 'codex']) await fs.writeFile(join(bin, backend),
    `#!${process.execPath}\nimport {provider} from './provider.mjs';\nprovider().catch(error=>{console.error(error);process.exitCode=1});\n`, { mode: 0o755 });
  const clockFile = join(root, 'clock-offset');
  if (scenario.startsWith('inactivity')) {
    await fs.writeFile(clockFile, '0');
    const preload = join(root, 'clock.mjs');
    await fs.writeFile(preload, `import { readFileSync } from 'node:fs';
const RealDate=Date;const offset=()=>Number(readFileSync(${JSON.stringify(clockFile)},'utf8'));
globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[RealDate.now()+offset()]))}static now(){return RealDate.now()+offset()}};
const now=performance.now.bind(performance);Object.defineProperty(performance,'now',{value:()=>now()+offset()});
const interval=globalThis.setInterval;globalThis.setInterval=(fn,ms,...args)=>interval(fn,Math.min(ms,25),...args);
const timeout=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timeout(fn,Math.min(ms,25),...args);
`);
    fixture.preload = preload;
  }
  const env = { PATH: bin + ':' + process.env.PATH, HOME: home, USERPROFILE: home, FC_HOME: fcHome,
    CODEX_HOME: join(home, '.codex'), FLOWCREW_STORE_ROOT: storeRoot, ACCEPTANCE_FIXTURE: join(root, 'fixture.json'),
    PRIVATE_ONLY: 'adapter-only', SSL_CERT_FILE: fixture.ca, HTTPS_PROXY: 'http://synthetic.invalid',
    CLAUDE_CODE_TMPDIR: fixture.nativeTmp, NODE_NO_WARNINGS: '1',
    ...(fixture.preload ? { NODE_OPTIONS: '--import=' + fixture.preload } : {}) };
/** @param {string[]} args @param {number|null} [expected] */
  const invoke = async (args, expected = 0) => {
    if (!cleaning) signal?.throwIfAborted();
    const child = spawn('nice', ['-n', '19', process.execPath, entry, ...args], { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'], timeout:backstop, killSignal:'SIGKILL' });
    children.add(child); let stdout = '', stderr = '';
    const cancel = () => { child.kill('SIGKILL'); };
    if (!cleaning) signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    children.delete(child);
    signal?.removeEventListener('abort', cancel);
    if (!cleaning) signal?.throwIfAborted();
    (report.cli ??= []).push({argv:args,exit:code,stdout,stderr});
    if (expected !== null) assert.equal(code, expected, JSON.stringify({ args, code, stdout, stderr }));
    return { code, stdout, stderr, json: () => JSON.parse(stdout) };
  };
/** @type {import('../../../rewrite-src/contract/runtime.js').Journal} */
  let journal = {database:'',root:''};
  const projection = () => until(async () => {
    const current = await state.readProjection(journal);
    if (!current.ok) {assert.equal(current.kind, 'unknown', JSON.stringify(current));return false;}
    return current.value;
  }, 'coherent current projection');
  const events = async () => value(await state.readEvents(journal, 0));
  const observeReaders = async () => {
    const hook=await load('flowcrew-session.mjs');
    const observed=await hook.observe({storeRoots:[storeRoot],tasksRoot:join(root,'tasks')},'synthetic-acceptance','--statusline');
    const monitor=await import(pathToFileURL(join(packageRoot,'dist-monitor/rewrite-monitor/server.js')).href);
    const server=await monitor.startMonitor({storeRoots:[storeRoot],port:0});
    let page;
    try{
      if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
      page=await(await fetch(`http://127.0.0.1:${server.address().port}`)).text();
    }finally{await new Promise(resolve=>server.close(()=>resolve(undefined)));}
    return {hook:observed.observed.map(/** @param {any} row */row=>row.status.status),page};
  };
  const settled = () => until(async () => {
    // Observe the controller's existing atomic publication while it owns live work.
    // Read SQL only to authenticate an outcome or an observed controller death.
    const snapshot = value(parseRunStatusFile(JSON.parse(await fs.readFile(join(journal.root, 'status.json'), 'utf8'))));
    const owner = snapshot.host.activation?.owner;
    if (['pending', 'running'].includes(snapshot.journalStatus ?? snapshot.status)
      && (!owner || await nativeIdentity.observeController(owner) !== 'inactive')) return false;
    const p = await projection();
    if (!['pending', 'running'].includes(p.status)) return p;
    const observed = value(state.readHostState(journal)).observation;
    if (observed?.owner && await nativeIdentity.observeController(observed.owner) === 'inactive') {
      assert.fail('controller exited without a durable lifecycle outcome: ' + JSON.stringify({status:p.status,conclusion:p.conclusion}));
    }
    return false;
  }, 'durable lifecycle outcome');
/** @param {import('../../../rewrite-src/contract/runtime.js').RunProjection} p */
  const assertComplete = p => {
    assert.equal(p.status, 'complete', JSON.stringify({ status: p.status, conclusion: p.conclusion, attempts: p.attempts.map(a => a.ending) }));
    assert(p.owners.every(o => o.state === 'dead'), 'all recorded invocation owners closed');
    assert(p.commands.every(c => c.execution.state === 'complete' && c.execution.exit === 0));
    assert(p.attempts.every(attempt=>attempt.closure==='dead'&&attempt.usage.output===7), 'native closure and usage retained');
    assert(p.reservations.every(reservation=>reservation.state==='committed'));
    assert(p.intervals.every(interval=>interval.spentMs!==null), 'active intervals durably settled');
    assert.equal(p.invocations.length,p.attempts.length+p.commands.length, 'one reservation per actual native invocation');
  };
  try {
    if (scenario.startsWith('inactivity')) await fs.writeFile(join(root, 'progress'), 'yes');
    const hostServer = server = createServer(connection => { requests.push('request'); connection.end(JSON.stringify({ a: 7, b: 4, operator: '*', expected: 28 }) + '\n'); });
    await new Promise((resolve, reject) => { hostServer.once('error', reject); hostServer.listen(socket, ()=>resolve(undefined)); });
    await fs.writeFile(join(source, 'sum.mjs'), 'export const sum = (a,b) => a - b;\n');
    await fs.writeFile(join(source, 'spec.txt'), 'Synthetic frozen specification.\n');
    await fs.link(join(source, 'spec.txt'), join(root, 'spec-alias'));
    await fs.writeFile(join(source, 'check.mjs'), `import { createConnection } from 'node:net';
import { sum } from './sum.mjs';
const socket=createConnection(process.argv[2]);let bytes='';
socket.on('data',chunk=>bytes+=chunk);socket.on('error',error=>{console.error(error);process.exitCode=2});
socket.on('end',()=>{const challenge=JSON.parse(bytes);const actual=sum(challenge.a,challenge.b);
console.log(JSON.stringify({...challenge,actual}));process.exitCode=actual===challenge.expected?0:1});\n`);
    const commandCode = `const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
assert.equal(process.env.DECLARED_ONLY,'yes');assert.equal(process.env.EMPTY,'');
for(const key of ['HOME','PATH','PRIVATE_ONLY','SSL_CERT_FILE','HTTPS_PROXY','CLAUDE_CODE_TMPDIR'])assert.equal(process.env[key],undefined,key);
assert(process.env.TMPDIR);fs.writeFileSync(process.env.TMPDIR+'/declared-scratch','exact env');
fs.appendFileSync(${JSON.stringify(join(root,'command-dispatches'))},process.env.TMPDIR+'\\n');
${(['external-signal', 'inactivity', 'inactivity-unknown', 'dead-controller', 'cancel-stage-start'].includes(scenario) || recovery?.phase === 'command') ? `if(!fs.existsSync(${JSON.stringify(join(root,'command-continue'))})){fs.appendFileSync(${JSON.stringify(join(root,'command-effects'))},'effect\\n');fs.writeFileSync(${JSON.stringify(join(root, 'command-ready'))},String(globalThis.process.pid));console.log('command ready; external effect recorded');setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, 'progress'))}))console.log('observed progress')},25);}else{const result=cp.spawnSync('nice',['-n','19',process.execPath,'check.mjs',${JSON.stringify(socket)}],{env:{},encoding:'utf8'});if(result.status===0)fs.writeFileSync('product.json',result.stdout);process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??1);}` : `const result=cp.spawnSync('nice',['-n','19',process.execPath,'check.mjs',${JSON.stringify(socket)}],{env:{},encoding:'utf8'});
if(result.status===0)fs.writeFileSync('product.json',result.stdout);
${scenario==='many-command-later-gate'?"const prior=Number(fs.readFileSync('phase.txt','utf8'));fs.writeFileSync('phase.txt',String(prior+1));":''}
process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??1);`}`;
    // With an exact environment there is no PATH lookup: use the resolved nice executable.
    const nice = spawnSync('nice', ['-n', '19', 'which', 'nice'], { encoding: 'utf8' }).stdout.trim();
    assert(nice.startsWith('/'));
    fixture.input=join(root,'external-input.txt');
    if(['mutable-input','frozen-input'].includes(scenario)){
      await fs.writeFile(fixture.input,'initial external input');
      await fs.writeFile(join(root,'fixture.json'),JSON.stringify(fixture));
    }
    const declaration = { criteria: [{ id: 'correct', text: 'Match the host measurement.' }], inputs: [
      { id: 'specification', path: 'spec.txt', kind: 'file', frozen: true },
      ...(['mutable-input','frozen-input'].includes(scenario)?[{id:'external',path:fixture.input,kind:'file',frozen:scenario==='frozen-input'}]:[])], outputs: [{path:'product.json',kind:'file',existing:'create'}], results: [], allowBlocked: scenario==='terminal-accepted_blocked',
      // Every scenario below that names planner-written stages declares decomposition; the fixed-* scenarios declare nothing.
      ...(scenario.startsWith('fixed-') ? {} : {decompose:true}),
      ...(scenario === 'host-claude' ? {bounds:{actions:908172635}} : {}),
      commands: [{ id: 'Verify', argv: [nice, '-n', '19', process.execPath, '-e', commandCode.replace("spawnSync('nice'", `spawnSync(${JSON.stringify(nice)}`)],
        env: { DECLARED_ONLY: 'yes', EMPTY: '' }, inputs: ['specification'], required: true, unconfined: true }] };
    if(scenario==='many-command-later-gate')declaration.commands=Array.from({length:16},(_,i)=>({...declaration.commands[0],id:'Verify'+i}));
    if(scenario==='stale-source')declaration.commands[0].argv[declaration.commands[0].argv.length-1]=
      String(declaration.commands[0].argv.at(-1)).replace('process.exit(result.status??1);',
        "const marker="+JSON.stringify(join(root,'measured-once'))+";const exit=fs.existsSync(marker)?7:(result.status??1);fs.writeFileSync(marker,'yes');process.exit(exit);");
    if (scenario === 'dependency-reuse') {
      for (const directory of ['a','b']) {
        await fs.mkdir(join(source,directory));
        await fs.writeFile(join(source,directory,'input.txt'),'original');
      }
      declaration.commands = ['A','B'].map(id => ({...declaration.commands[0],id,argv:[process.execPath,'-e',
        `console.log(require('node:fs').readFileSync('${id.toLowerCase()}/input.txt','utf8'))`],inputs:[],required:true,dependsOn:[id.toLowerCase()+'/']}));
    }
    fixture.commands=declaration.commands.map(command=>command.id);
    await fs.writeFile(join(root,'fixture.json'),JSON.stringify(fixture));
    const brief = join(root, 'brief.md'), bytes = Buffer.from('---\n' + JSON.stringify(declaration) + '\n---\nUse measured host feedback.\n');
    await fs.writeFile(brief, bytes);
    const config = JSON.parse(await fs.readFile(join(packageRoot, 'config/runtime.json'), 'utf8'));
    const custom = join(root, 'runtime.json');
    const backend = scenario === 'host-codex' ? 'codex' : 'claude';
    await fs.writeFile(custom, JSON.stringify({ ...config,
      ...(scenario === 'host-claude' ? {bounds:{actions:908172635},adapterInputLimitChars:{codex:908172636,claude:908172637}} : {}), sharedCaches: [source], devices: ['missing'], providerHomes: { ignored: true },
      roles: ['plan', 'work', 'gate'].map(purpose => ({ id: purpose, description: purpose, prompt: rolePrompt(purpose),
        backend, model: 'synthetic-model', effort: 'low' })) }));
    const args = [brief, '--project', source, '--config', custom];
    const setup = await invoke(['setup', ...args]);
    assert(setup.stderr.includes('these keys constrain nothing'));
    assert.equal(setup.json().briefDigest, hash(bytes));
    await assert.rejects(fs.stat(join(fcHome, 'state.sqlite')), { code: 'ENOENT' });
    // Disposable shell and its stdio really exit after acknowledgment, while the author waits.
    const launchChild = launcher = spawn('nice', ['-n', '19', 'sh', '-c', 'nice -n 19 "$@"', 'acceptance-launcher',
      process.execPath, entry, 'start', ...args, '--requester', 'claude:synthetic-acceptance'],
      { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'], timeout:backstop, killSignal:'SIGKILL' });
    children.add(launchChild);
    const cancelLaunch = () => { launchChild.kill('SIGKILL'); };
    signal?.addEventListener('abort', cancelLaunch, { once: true });
    let acknowledgment = '', launcherError = '';
    launchChild.stdout.on('data', b => acknowledgment += b); launchChild.stderr.on('data', b => launcherError += b);
    const exit = await new Promise((resolve, reject) => { launchChild.once('error', reject); launchChild.once('close', resolve); });
    children.delete(launchChild);
    signal?.removeEventListener('abort', cancelLaunch);
    signal?.throwIfAborted();
    try {run=JSON.parse(acknowledgment).run;} catch { /* Optional synthetic evidence may be absent on an earlier failure. */ }
    assert.equal(exit, 0, acknowledgment + launcherError);
    (report.cli ??= []).push({argv:['start',...args,'--requester','claude:synthetic-acceptance'],exit,stdout:acknowledgment,stderr:launcherError});
    const acknowledged = JSON.parse(acknowledgment); run = acknowledged.run;
    assert.equal(acknowledged.briefDigest, hash(bytes));
    assert.equal(acknowledged.operation.state, 'acknowledged');
    assert.throws(() => process.kill(Number(launcher?.pid), 0), { code: 'ESRCH' }, 'launcher has exited');
    journal = value(await state.openJournal({ database: join(fcHome, 'state.sqlite'), storeRoot, run }, 'read'));
    const activation = (await events()).flatMap(e=>e.payload.type==='run_observed'?[e.payload.observation]:[]).at(-1);
    assert(activation?.owner);
    const activationOwner=activation.owner;
    assert.notEqual(activation.owner.pid, launcher.pid);
    assert.notEqual(activation.owner.group, launcher.pid, 'controller session/group must differ from launcher');
    assert.equal(activation.owner.group, activation.owner.pid, 'controller owns a detached session/group');
    const copied = join(storeRoot, 'work', run, 'project');
    const originalStat = await fs.stat(join(source, 'spec.txt')), copiedStat = await fs.stat(join(copied, 'spec.txt'));
    assert.notDeepEqual([originalStat.dev, originalStat.ino], [copiedStat.dev, copiedStat.ino], 'source/copy inode independence');
    assert.equal(originalStat.nlink, 2);
    for (const file of ['sum.mjs', 'check.mjs']) {
      const a = await fs.stat(join(source, file)), b = await fs.stat(join(copied, file));
      assert.notDeepEqual([a.dev, a.ino], [b.dev, b.ino]);
    }
    await fs.writeFile(release, 'launcher exited');
    if(control){
      await until(async()=>{const current=await projection();assert(['pending','running'].includes(current.status),'control boundary must be reached before an ending: '+JSON.stringify(current.conclusion));
        try{await fs.stat(join(root,'control-ready'));return true;}catch{return false;}},'operator control boundary');
      const before=await projection();const status=(await invoke(['status',run])).json();
      assert(['pending','running'].includes(status.status));
      const operatorPlan={stages:[
        {id:'implementation',role:'work',purpose:'work',after:[],instruction:'Use measured host feedback to repair.'},
        {id:'review',role:'gate',purpose:'gate',after:['implementation'],commands:['Verify']}]};
      const planFile=join(root,'operator-plan.json');await fs.writeFile(planFile,JSON.stringify(operatorPlan));
      if(control.action==='guide'){
        await invoke(['guide',run,'Use the retained facts and continue.']);
        await invoke(['guide',run,'Use this pending graph.','--plan',planFile],1);
        await invoke(['status',run]);
        await invoke(['resume',run]);
        await fs.writeFile(join(root,'control-release'),'continue');
        const completed=await settled();assertComplete(completed);
        assert(completed.attempts.some(receipt=>!before.attempts.some(old=>JSON.stringify(old.address)===JSON.stringify(receipt.address))&&receipt.ending==='delivered'),
          'guide sequence settles actual subsequent work');
        const guides=completed.intents.filter(intent=>intent.kind==='guide');
        assert(guides.every(guide=>completed.guideDeliveries?.some(delivery=>delivery.guide===guide.id)), 'completion delivers every accepted guide to an author');
        assert(completed.attempts.filter(receipt=>completed.plan.plan.stages.find(stage=>stage.id===receipt.address.stage)?.purpose==='gate')
          .every(receipt=>!receipt.guidance?.length), 'independent gates receive zero guidance');
        report.control={...control,status:completed.status};
      }else{
        await invoke(['cancel',run],null);
        await fs.writeFile(join(root,'control-release'),'allow fenced code to unwind');
        await until(async()=>await nativeIdentity.observeController(activationOwner)==='inactive','cancelled controller exits');
        const cancelled=await projection();assert.equal(cancelled.status,'cancelled');
        assert.equal(cancelled.invocations.length,before.invocations.length,'cancel admits no later request at this phase');
        await invoke(['status',run]);await invoke(['cancel',run],null);await invoke(['status',run]);
        assert.notEqual((await invoke(['guide',run,'Continue'],null)).code,0);
        assert.notEqual((await invoke(['guide',run,'Continue','--plan',planFile],null)).code,0);
        assert.notEqual((await invoke(['resume',run],null)).code,0);
        assert.equal((await projection()).invocations.length,before.invocations.length,'terminal controls never revive cancellation');
        report.control={...control,status:cancelled.status};
      }
    } else if (recovery) {
      const matrixStart = performance.now();
      let before;
      if (recovery.reason === 'dead') {
        await until(async()=>{const current=await projection();assert(['pending','running'].includes(current.status),'crash boundary must be reached before an ending: '+JSON.stringify(current.conclusion));
          try {await fs.stat(join(root,recovery.phase==='command'?'command-ready':'recovery-ready'));return true;}catch{return false;}},'matrix crash boundary');
        before = await projection();
        assert.equal(await nativeIdentity.observeController(activationOwner),'active');
        process.kill(activationOwner.pid,'SIGKILL');
        await until(async()=>await nativeIdentity.observeController(activationOwner)==='inactive','matrix dead controller');
        assert.equal((await invoke(['status',run])).json().status,'interrupted');
        const listed=(await invoke(['status'])).json().find(/** @param {any} row */ row=>row.ok&&row.value.run===run)?.value;assert.equal(listed?.status,'interrupted');
      } else {
        before = await settled();
        assert.equal(before.status,'parked');
        assert.equal(before.conclusion?.reason,'recovery_unknown');
        await until(async()=>await nativeIdentity.observeController(activationOwner)==='inactive','matrix parked controller exits');
        before=await projection(); // Claim-release attention is committed while the controller closes.
        assert.equal((await invoke(['status',run])).json().status,'parked');
      }
      if (recovery.reason === 'restore') {
        await fs.writeFile(join(copied,'sum.mjs'),'Interrupted workspace bytes.\n');
        await invoke(['resume',run]);
        await until(async()=>{try {await fs.stat(join(root,'recovery-ready'));return true;}catch{return false;}},'checkpoint restore crash boundary');
        const restoring=await projection();assert(restoring.restoring,'restore intent precedes byte replacement');
        const owner=(await events()).flatMap(e=>e.payload.type==='run_observed'&&e.payload.observation.owner?[e.payload.observation.owner]:[]).at(-1);
        assert(owner);assert.equal(await nativeIdentity.observeController(owner),'active');process.kill(owner.pid,'SIGKILL');
        await until(async()=>await nativeIdentity.observeController(owner)==='inactive','restore controller killed');
        before=await projection();
        const stale=await fs.readFile(join(journal.root,'status.json'),'utf8');
        const readers=await observeReaders();
        assert.deepEqual(readers.hook,['interrupted'],'hook observes pending restore controller death');
        assert(readers.page.includes('data-status="interrupted"'),'monitor observes pending restore controller death');
        assert.equal(await fs.readFile(join(journal.root,'status.json'),'utf8'),stale,'reader observation never rewrites the producer file');
        const stopped=(await invoke(['status',run])).json();
        assert(['pending','interrupted'].includes(stopped.status),'restore precedes the next scheduling interval');
        assert.equal(stopped.host.activation.state,'inactive','restore controller is actually dead');
      }
      if(scenario==='matrix-dead-command-resume'){
        for(let index=0;index<2;index++){
          const refused=await invoke(['land',run],1);
          assert.match(JSON.parse(refused.stderr).detail,new RegExp('flowcrew cancel '+run+' first'),'nonterminal work is refused with its remedy');
          await invoke(['status',run]);
        }
        assert.equal((await invoke(['land',run,'--reclaim'],2)).stdout,'','the retired --reclaim option is refused as unknown');
        assert(!(await projection()).reclaimed);await fs.stat(copied);
      }
      const oldAttempts = before.attempts.map(receipt=>JSON.stringify(receipt.address));
      const oldReservations = before.reservations;
      await fs.writeFile(join(root,'recovery-release'),'fault resolved');
      await fs.writeFile(join(root,'command-continue'),'new independent verification may run');
      if (recovery.control === 'text') await invoke(['guide',run,'Inspect retained uncertainty and continue from the recovered base.']);
      if (recovery.control === 'plan') {
        // The operator owns this pending graph; never synthesize it from a private projection.
        const pending=[
          {id:'replacement',role:'work',purpose:'work',after:[],instruction:'Use measured host feedback to repair.',},
          {id:'review',role:'gate',purpose:'gate',after:['replacement'],commands:['Verify']}];
        const planFile=join(root,'operator-plan.json');await fs.writeFile(planFile,JSON.stringify({stages:pending}));
        await invoke(['guide',run,'Continue with the operator supplied pending graph.','--plan',planFile]);
      }
      await invoke(['resume',run]);
      const completed=await settled();
      assert.equal(completed.status,'complete','matrix next work settles through independent delivery: '+JSON.stringify(completed.conclusion));
      assert(completed.attempts.some(receipt=>!oldAttempts.includes(JSON.stringify(receipt.address))&&receipt.ending==='delivered'),
        'matrix continuation settles a new native invocation');
      for (const raw of before.received) assert.deepEqual(completed.received.find(receipt=>JSON.stringify(receipt.address)===JSON.stringify(raw.address)),raw,'original native receipt is retained even if the operator retires its request');
      for (const old of before.attempts) assert.deepEqual(completed.attempts.find(receipt=>JSON.stringify(receipt.address)===JSON.stringify(old.address)),old,'old unknown/failure receipt is immutable');
      assert(completed.invocations.filter(i=>i.charge!=='command').every(invocation=>
        completed.attempts.some(receipt=>JSON.stringify(invocation.address)===JSON.stringify({kind:'stage',...receipt.address}))
        || completed.closedInvocations.some(closed=>JSON.stringify(closed)===JSON.stringify(invocation))),
        'every author invocation is settled or explicitly closed unmeasured');
      assert(completed.attempts.some(receipt=>receipt.address.stage==='review'&&receipt.ending==='delivered'),'independent review actually settled');
      assert.deepEqual(completed.launch.runtime,before.launch.runtime,'original runtime pin retained');
      if (recovery.phase === 'command') {
        const interrupted=completed.reservations.filter(r=>r.invocation.address.kind==='stage'&&r.invocation.address.stage==='implementation');
        assert.equal(interrupted.length,2,'each implementation attempt owns its command request');
        assert.deepEqual(interrupted[0],{...oldReservations[0],state:'closed-unmeasured'},'original request remains spent');
        assert.equal(interrupted[1].state,'committed');
        assert(interrupted[0].invocation.address.kind==='stage' && interrupted[1].invocation.address.kind==='stage');
        assert.notEqual(interrupted[1].invocation.address.attempt,interrupted[0].invocation.address.attempt,'new attempt requests afresh');
        assert.equal(interrupted[0].state,'closed-unmeasured');
        assert.equal(completed.commands.length,2,'new implementation and independent review are measured');
        assert.equal((await fs.readFile(join(root,'command-dispatches'),'utf8')).trim().split('\n').length,3,'one request per attempt plus independent review');
        assert.equal(oldReservations.length,1);
      }
      if(recovery.reason==='dead' && recovery.control==='resume')assert.equal((await invoke(['land',run])).json().state,'reclaimed','recovered facts remain usable by landing');
      report.matrix={...recovery,status:completed.status,wallMs:performance.now()-matrixStart,
        beforeAttempts:before.attempts.length,afterAttempts:completed.attempts.length,
        reservations:completed.reservations.map(r=>({state:r.state,invocation:r.invocation}))};
    } else if(scenario.startsWith('terminal-')){
      const completed=await settled();const expected=scenario.slice('terminal-'.length);
      assert.equal(completed.status,expected);
      await until(async()=>await nativeIdentity.observeController(activationOwner)==='inactive','terminal controller exits');
      const planFile=join(root,'terminal-plan.json');await fs.writeFile(planFile,JSON.stringify({stages:[]}));
      await invoke(['status',run]);
      for(const args of [['guide',run,'Continue'],['guide',run,'Continue','--plan',planFile],['resume',run]])
        assert.notEqual((await invoke(args,null)).code,0,'terminal state refuses continuation');
      assert.equal((await projection()).invocations.length,completed.invocations.length,'terminal state admits no work');
      assert.equal((await invoke(['status',run])).json().status,expected);
      if(expected==='accepted_blocked'){
        const product=await fs.readFile(join(copied,'product.json'));
        assert.equal((await invoke(['land',run])).json().state,'reclaimed');
        assert.equal((await invoke(['land',run])).json().state,'reclaimed');
        assert.deepEqual(await fs.readFile(join(storeRoot,'deliveries',run,'product.json')),product);
        assert.notEqual((await invoke(['resume',run],null)).code,0);
      }
      report.terminal={status:expected,invocations:completed.invocations.length};
    } else if (scenario.startsWith('reclaim-')) {
      const completed=await settled();assertComplete(completed);
      await until(async()=>await nativeIdentity.observeController(activationOwner)==='inactive','complete controller exits before reclaim');
      await invoke(['status',run]);
      const delivery=join(storeRoot,'deliveries',run), stage=scenario.slice('reclaim-'.length);
      const product=await fs.readFile(join(copied,'product.json'));
      const start=performance.now();
      if(stage==='user-directory'){
        await fs.mkdir(delivery,{recursive:true});await fs.writeFile(join(delivery,'operator-owned'),'user bytes');
        assert.notEqual((await invoke(['land',run],null)).code,0,'foreign delivery refuses reclaim');
        assert.equal(await fs.readFile(join(delivery,'operator-owned'),'utf8'),'user bytes','user delivery is never overwritten');
        assert(!(await projection()).reclaimed,'refused archive never becomes reclaimed');
        await fs.rm(delivery,{recursive:true});
      } else {
        /** @type {Awaited<ReturnType<typeof invoke>>|undefined} */
        let early;
        const interrupted=invoke(['land',run],null).then(result=>{early=result;return result;});
        const pid=await until(async()=>{assert(!early,'reclaim must reach the crash boundary: '+JSON.stringify(early));
          try{return Number(await fs.readFile(join(root,'recovery-ready'),'utf8'));}catch{return false;}},'reclaim crash boundary');
        // This is the test-owned recorded operation process, never a guessed PID.
        const stateDb=(await import('node:sqlite')).DatabaseSync;
        const db=new stateDb(journal.database);let owners;
        try {owners=db.prepare("SELECT owner FROM resources WHERE holder=? AND id LIKE 'record:%'").all(journal.root).map(row=>JSON.parse(String(row.owner)));}finally{db.close();}
        const owner=owners.find(owner=>owner.pid===pid);assert(owner,'crash PID is a recorded operation owner');
        assert.equal(await host.probeOwner(owner),'live');process.kill(pid,'SIGKILL');
        assert.notEqual((await interrupted).code,0,'interrupted reclaim never reports success');
        const after=await projection();
        assert.equal(!!after.reclaimed,stage==='evidence','reclaimed fact follows complete archive and precedes deletion');
        if(['staging','artifact'].includes(stage))await assert.rejects(fs.stat(delivery),{code:'ENOENT'},'partial archive is never published');
        else assert.deepEqual(await fs.readFile(join(delivery,'product.json')),product,'complete published bytes survive interruption');
        await invoke(['status',run]);
        await fs.writeFile(join(root,'recovery-release'),'retry can finish');
      }
      const reclaimed=(await invoke(['land',run])).json();assert.equal(reclaimed.state,'reclaimed','reclaim retry completes');
      assert.deepEqual(await fs.readFile(join(delivery,'product.json')),product,'delivered bytes preserved exactly');
      for (const path of [copied,dirname(join(storeRoot,completed.launch.runtime.path)),join(journal.root,'git-common')])
        await assert.rejects(fs.stat(path),{code:'ENOENT'},'retry finishes every deletion');
      assert.equal((await invoke(['land',run])).json().state,'reclaimed','completed reclaim retry is idempotent');
      assert.equal((await invoke(['status',run])).json().status,'complete');
      assert.notEqual((await invoke(['resume',run],null)).code,0,'reclaimed run cannot resume');
      report.reclaim={stage,status:'reclaimed',wallMs:performance.now()-start};
    } else if (scenario === 'cancel-stage-start') {
      await until(async()=>{const current=await projection();assert(['pending','running'].includes(current.status),JSON.stringify(current.conclusion));
        try{return Number(await fs.readFile(join(root,'command-ready'),'utf8'));}catch{return false;}},'stage-start command ready');
      const before=await projection();
      assert.equal(before.currentStage,'implementation');
      const started=performance.now();
      const cancel=await invoke(['cancel',run],3);
      const operation=cancel.json();
      assert.equal(operation.state,'in_progress');
      assert.equal(operation.observation.owner.pid,activation.owner.pid);
      assert(operation.detail.includes(String(activation.owner.pid)), 'in-progress cancellation names the controller');
      await until(async()=>{const current=await projection();
        return current.commands.length && current.intervals.every(i=>i.spentMs!==null) && await host.probeOwner(activationOwner)==='dead';},'controller durably ends without a second cancel');
      const cancelledProjection=await projection();
      assert.deepEqual(cancelledProjection.commands.at(-1)?.execution,{state:'unfinished',reason:'cancelled'});
      assert.equal(cancelledProjection.obligations.length,0);
      assert(!cancelledProjection.attempts.some(attempt=>attempt.address.stage==='implementation'),'cancel fence admits no author after the command');
      report.cancel={wallMs:performance.now()-started,operation};
      assert.equal((await projection()).status,'cancelled');
    } else if (['resume-guide','resume-direct','resume-cancel'].includes(scenario)) {
      const parked=await settled();
      assert.equal(parked.status,'parked');assert.equal(parked.conclusion?.reason,'backstop');
      assert.equal(parked.backstop.failureSuffix,4);
      await until(async()=>await host.probeOwner(activationOwner)==='dead','parked controller exits before resume');
      if (scenario === 'resume-guide') {
        const planFile = join(root, 'replacement-plan.json');
        const publicStatus = (await invoke(['status', run])).json();
        assert(publicStatus.plan?.pending?.stages.length, 'public status supplies the editable pending plan');
        assert(publicStatus.stages.some(/** @param {any} stage */ stage => stage.state === 'parked'), 'public pipeline names the parked stage');
        await fs.writeFile(planFile, JSON.stringify(publicStatus.plan.pending));
        await invoke(['guide', run, 'Continue the retained work with this admitted plan.', '--plan', planFile]);
        assert.notEqual((await projection()).plan.revision, parked.plan.revision);
      }
      await invoke(['status', run]);
      await invoke(['resume', run]);
      if (scenario === 'resume-cancel') {
        await until(async()=>{
          const current=await projection();
          assert(['pending','running'].includes(current.status), 'resumed author must dispatch before cancellation: '+JSON.stringify(current.conclusion));
          try { await fs.stat(join(root,'resumed-ready')); return true; } catch { return false; }
        }, 'resumed native author entered');
        await invoke(['cancel', run], null);
        await until(async()=>{
          const current=await projection();
          const observed=value(state.readHostState(journal)).observation;
          return current.status==='cancelled' && observed?.owner && await host.probeOwner(observed.owner)==='dead';
        },'cancel after resume closes controller');
        const cancelled=await projection();
        assert.equal(cancelled.invocations.filter(invocation=>invocation.address.kind==='stage' && invocation.address.stage==='implementation').length,5);
        assert(!cancelled.invocations.some(invocation=>invocation.address.kind==='stage' && invocation.address.stage==='review'), 'cancel fences subsequent stage dispatch');
        const rows=(await fs.readFile(trace,'utf8')).trim().split('\n').map(row=>JSON.parse(row));
        assert.equal(rows.filter(row=>row.event==='author-invocation').length,5,'cancel admits no further author');
        assert(!rows.some(row=>row.kind==='gate'),'cancel admits no gate');
        assert.equal(cancelled.backstop.segment,parked.backstop.segment+1);
        report.resumed={status:cancelled.status,segment:cancelled.backstop.segment};
      } else {
        const resumed=await settled();
        const delivered=resumed.attempts.filter(attempt=>attempt.address.stage==='implementation' && attempt.ending==='delivered');
        assert.equal(delivered.length,1,'resume dispatches and settles the next actual author invocation');
        assert(resumed.attempts.some(attempt=>attempt.address.stage==='review' && attempt.ending==='delivered'),'resume proceeds through the next stage');
        assert.equal(resumed.backstop.segment,parked.backstop.segment+1);
        assert.equal(resumed.attempts.filter(attempt=>attempt.ending==='invalid_answer').length,4,'historical failures remain retained');
        assertComplete(resumed);
        assert.equal(resumed.commands.length,1,'next-stage declared command also executes after the historical park');
        const rows=(await fs.readFile(trace,'utf8')).trim().split('\n').map(row=>JSON.parse(row));
        const authors=rows.filter(row=>row.event==='author-invocation');
        assert.equal(authors.length,5);
        assert.equal(authors.at(-1).guidance.length,scenario==='resume-guide'?1:0,'guidance is consumed only by the resumed author');
        assert.equal(rows.filter(row=>row.kind==='gate' && row.event==='entered').length,1,'independent native gate actually runs');
        report.resumed={status:resumed.status,segment:resumed.backstop.segment,authorAttempts:5,nextStage:'review',guidance:authors.at(-1).guidance.length};
      }
      report.parked={status:parked.status,reason:parked.conclusion?.reason,segment:parked.backstop.segment,failureSuffix:parked.backstop.failureSuffix};
    } else if (scenario === 'dead-controller') {
      const held = {pid:await until(async () => {try {return Number(await fs.readFile(join(root, 'command-ready'),'utf8'));}catch{return false;}}, 'live declared command')};
      const interrupted = await projection();
      const invocationOwner = await until(async()=>{const current=await projection();
        return current.owners.find(row=>row.owner.members?.some(member=>member.pid===held.pid))?.owner;
      }, 'live command has a recorded native owner');
      const commandReservations = interrupted.invocations.filter(invocation=>invocation.charge==='command').length;
      const observed = (await events()).flatMap(e=>e.payload.type==='run_observed'?[e.payload.observation]:[]).at(-1);
      assert(observed?.owner);
      const observedOwner=observed.owner;
      assert.equal(await host.probeOwner(observed.owner), 'live');
      process.kill(observed.owner.pid, 'SIGKILL');
      await until(async () => { try { const text = await fs.readFile(`/proc/${observedOwner.pid}/stat`, 'utf8'); return text.split(') ')[1].startsWith('Z'); }
        catch { try { process.kill(observedOwner.pid, 0); return false; } catch { return true; } } }, 'controller dead');
      assert(observed.owner.members?.length, 'controller recorded an authenticated group member');
      const survivor = observed.owner.members.find(member => {try {process.kill(member.pid,0);return true;} catch{return false;}});
      assert(survivor, 'authenticated group member survives controller SIGKILL');
      report.survivingMember = survivor;
      const foreign = {...observed.owner, start: observed.owner.start+'-reused', members: []};
      assert.equal(await host.probeOwner(foreign), 'unknown');
      assert.equal((await host.closeOperation(foreign)).ok, false, 'birth mismatch grants no signal authority');
      process.kill(survivor.pid, 0); // Refused signalling leaves the real owned member alive.
      const staleFile=await fs.readFile(join(journal.root,'status.json'),'utf8');
      assert.equal(JSON.parse(staleFile).status,'running','static file retains its last historical observation before read');
      const readers=await observeReaders(),page=readers.page;
      assert(!page.includes('Historical workflow snapshot'),'monitor does not mislabel every observation as historical');
      assert.equal(await fs.readFile(join(journal.root,'status.json'),'utf8'),staleFile,'file readers never refresh producer bytes');
      const single = value(parsePublicRunStatus((await invoke(['status', run])).json()));
      const listed = value(parsePublicRunStatus((await invoke(['status'])).json().find(/** @param {any} row */ row => row.ok && row.value.run === run)?.value));
      const shared = JSON.parse(await fs.readFile(join(journal.root, 'status.json'), 'utf8'));
      report.deadStatus = { single: single.status, list: listed?.status, shared: shared.status };

      report.deadStatus.hook = readers.hook;
      report.deadStatus.monitorRunning = page.includes('data-status="running"');
      assert.equal(single.status, 'interrupted', 'dead controller must never be shown running by public status');
      assert.equal(listed?.status, 'interrupted', 'dead controller must never be shown running by list');
      assert.equal(shared.status, 'running', 'producer retains journal lifecycle while readers observe interruption');
      assert.deepEqual(readers.hook,['interrupted'],'hook must reflect controller interruption');
      assert(!page.includes('data-status="running"'), 'monitor must reflect controller interruption');
      const originalPin = (await projection()).launch.runtime;
      report.operator = [{argv:['status',run],result:single}];
      await fs.writeFile(join(root,'command-continue'),'The interrupted request is closed; independent review will measure a new request.');
      const resumed = await invoke(['resume', run]);
      report.operator.push({argv:['resume',run],result:resumed.json()});
      const completed = await settled();
      assert.equal(completed.status,'complete','dead command continuation settles the next author and independent review: '+JSON.stringify(completed.conclusion));
      assert.deepEqual(completed.launch.runtime,originalPin);
      assert.equal(await host.probeOwner(observedOwner),'dead','resume closes owned survivors');
      const stageCommands=completed.reservations.filter(r=>r.invocation.address.kind==='stage'&&r.invocation.address.stage==='implementation');
      assert.equal(stageCommands.length,2,'each implementation attempt owns its command request');
      assert.deepEqual(stageCommands[0],{...interrupted.reservations[0],state:'closed-unmeasured'},'interrupted request remains spent in its reserving attempt');
      assert.equal(stageCommands[1].state,'committed');
      assert(stageCommands[0].invocation.address.kind==='stage' && stageCommands[1].invocation.address.kind==='stage');
      assert.notEqual(stageCommands[1].invocation.address.attempt,stageCommands[0].invocation.address.attempt,'new attempt requests afresh');
      assert.equal((await fs.readFile(join(root,'command-dispatches'),'utf8')).trim().split('\n').length,3,'one dispatch per attempt plus independent review');
      assert.equal(await fs.readFile(join(root,'command-effects'),'utf8'),'effect\n');
      assert.equal(completed.invocations.filter(invocation=>invocation.charge==='command').length,commandReservations+2);
      assert(invocationOwner);
      const oldProcesses=(await events()).flatMap(e=>e.payload.type==='process'&&e.payload.receipt.owner?.authority===invocationOwner.authority?[e.payload.receipt]:[]);
      assert(oldProcesses.length && oldProcesses.every(receipt=>receipt.state==='closure_unknown'),'original command exit stays unknown');
      const evidence=await load('records/evidence.js');
      const streams=await Promise.all(oldProcesses.map(receipt=>evidence.readEvidence(journal,receipt.stdout)));
      assert(streams.some(item=>item.ok&&Buffer.from(item.value).toString().includes('external effect recorded')),'unknown command streams survive');
      assert(completed.attempts.some(a=>a.address.stage==='implementation'&&a.ending==='delivered'));
      assert(completed.attempts.some(a=>a.address.stage==='review'&&a.ending==='delivered'));
      report.recovery={status:completed.status,reservations:completed.reservations};
    } else if (scenario === 'external-signal' || scenario.startsWith('inactivity')) {
      const pid = await until(async () => { try { return Number(await fs.readFile(join(root, 'command-ready'), 'utf8')); } catch { return false; } }, 'idle real command');
      if (scenario === 'external-signal') {
        process.kill(pid, 'SIGTERM');
        const p = await until(async()=>{const current=await projection();return current.commands.length?current:false;},'direct signal receipt');
        assert.deepEqual(p.commands.at(-1)?.execution, { state: 'unfinished', reason: 'signalled', signal:'SIGTERM' }, 'external SIGTERM remains known signalled');
        const receipt = (await events()).flatMap(e=>e.payload.type==='process'&&e.payload.receipt.signal==='SIGTERM'?[e.payload.receipt]:[]).at(-1);
        assert(receipt?.owner); assert.equal(await host.probeOwner(receipt.owner), 'dead');
        const terminal = await settled();
        assert.equal(terminal.status, 'incomplete', 'required signalled command cannot become a successful delivery');
        assert.equal(terminal.conclusion?.reason, 'command_unfinished');
      } else {
        // Virtual time is a Node preload in this test's disposable process tree;
        // there is no production timeout option or production source edit.
        const observedStatus = await until(async()=>{const status=JSON.parse(await fs.readFile(join(journal.root,'status.json'),'utf8'));return status.status==='running'&&status.commandActivity?.some(/** @param {any} row */ row=>row.state===(scenario==='inactivity-unknown'?'unknown':'progress'))?status:false;},'live controller with progressing or unavailable native activity observation');
        const progress = {status:observedStatus,events:await events()};
        assert.equal(progress.events.filter(e=>['command_activity','execution_activity'].includes(e.payload.type)).length,0,'progressing native child produces zero activity journal events');
        if(scenario==='inactivity-unknown') {
          assert.equal(progress.status.commandActivity[0].state,'unknown','unavailable native observation remains unknown');
          assert.equal(progress.status.journalStatus,'running','unavailable activity does not change the journal lifecycle');
          process.kill(pid,0);report.unavailableObservation=true;
        } else {
        assert(!JSON.stringify(progress).includes('no observed progress for 10 min'), 'growing stdout prevents an inactivity notice');
        await fs.rm(join(root, 'progress'));
        await until(async()=>{const status=JSON.parse(await fs.readFile(join(journal.root,'status.json'),'utf8'));return status.commandActivity?.some(/** @param {any} row */ row=>row.state==='observing');},'quiet native baseline after stdout stops');
        await fs.writeFile(clockFile, String(10 * 60_000 + 1));
        const status = await until(async()=>{const status=JSON.parse(await fs.readFile(join(journal.root,'status.json'),'utf8'));return status.journalStatus==='running' && status.activity?.some(/** @param {any} row */ row=>row.source==='command' && row.observation==='quiet' && row.notice)?status:false;},'one notify-only notice after the virtual clock window');
        assert.equal(status.activity.find(/** @param {any} row */ row=>row.source==='command').notice.message, 'no observed progress for 10 min');
        const count = value(state.readAdvisoryActivity(journal)).filter(activity=>activity.observation==='quiet').length;
        assert.equal(count, 1, 'one durable activity notice per quiet episode');
        const after = Date.now() + 30 * 60_000 + 1;
        await fs.writeFile(clockFile, String(30 * 60_000 + 1));
        const later = await until(async()=>{const status=JSON.parse(await fs.readFile(join(journal.root,'status.json'),'utf8'));return Date.parse(status.publishedAt)>=after && status.journalStatus==='running' && status.activity?.some(/** @param {any} row */ row=>row.source==='command' && row.observation==='quiet' && row.notice)?status:false;},'producer has observed the later virtual clock window');
        assert.equal(value(state.readAdvisoryActivity(journal)).filter(activity=>activity.observation==='quiet').length, count, 'no inactivity notice replay');
        assert.equal(later.journalStatus, 'running', 'inactivity is notify-only');
        report.inactivity={status:later.journalStatus,quietRecords:count};
        process.kill(pid, 0);
        assert(!(await projection()).conclusion, 'idle command is never killed, retried or parked');
        }
      }
    } else if (scenario === 'reconcile') {
      const p = await settled();assert.equal(p.status, 'parked');
      await until(async()=>await host.probeOwner(activationOwner)==='dead','parked controller exits before reconciliation');
      const selected = async () => (await events()).filter(e => ['owner_closed', 'accounting_interrupted'].includes(e.payload.type)).map(e => e.payload);
      await invoke(['guide', run, 'First reconciliation of the parked run']);
      const before = await selected(), usage = (await invoke(['status', run])).json().usage;
      for (let i = 0; i < 3; i++) await invoke(['guide', run, 'Reconcile the same closed owners']);
      assert.deepEqual(await selected(), before, 'repeated reconciliation adds no closure/accounting facts');
      assert.deepEqual((await invoke(['status', run])).json().usage, usage, 'reconciliation never inflates usage');
      await invoke(['resume',run]);
      assert.equal((await settled()).status,'complete','reconciliation must allow the next planner, author and review to settle');
    } else if (scenario === 'fatal-result') {
      const p = await settled();
      assert(p.conclusion && ['parked', 'interrupted'].includes(p.status), 'catchable Result must have durable activation end before writer release');
      await until(async()=>await host.probeOwner(activationOwner)==='dead','failed controller releases its writer and exits');
      const facts = await events();
      const diagnostic = 'Synthetic catchable boundary Result';
      let retained = JSON.stringify(facts).includes(diagnostic);
      if (!retained) {
/** @type {Map<string,import('../../../rewrite-src/contract/brief.js').Ref>} */
        const refs = new Map();
/** @param {any} object */
        const visit = object => {if (!object || typeof object !== 'object') return;
          if (typeof object.path === 'string' && typeof object.sha256 === 'string') refs.set(object.path,object);
          for (const child of Object.values(object)) visit(child);
        };visit(facts);
        const evidence = await load('records/evidence.js');
        for (const ref of refs.values()) {const bytes=await evidence.readEvidence(journal,ref);
          if (bytes.ok && Buffer.from(bytes.value).toString().includes(diagnostic)) {retained=true;break;}
        }
      }
      assert(retained, 'durable diagnostic retains exact Result detail');
      assert(facts.some(e => e.payload.type === 'lifecycle'), 'fatal Result has durable lifecycle end');
      await invoke(['resume',run]);
      assert.equal((await settled()).status,'complete','resolved fatal boundary allows actual continuation');
    } else if (scenario === 'gate-tree') {
      // A reviewer that accepts and leaves bytes behind completes the run; what is delivered is the tree it reviewed.
      const p = await settled();
      assertComplete(p);
      const wrote = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(row => JSON.parse(row)).filter(row => row.event === 'gate-wrote');
      assert.equal(wrote.length, 1, 'the reviewer wrote once');
      const gate = p.attempts.find(attempt => attempt.address.stage === 'review');
      assert(gate && gate.ending === 'delivered', 'the accepting gate is delivered');
      const content = await load('records/content.js');
      assert.deepEqual(value(await content.changedTreePaths(journal, gate.before, gate.after)), ['gate-write.txt'], 'the reviewer left exactly the byproduct');
      assert.equal(p.checkpoints.at(-1)?.tree, gate.before, 'the delivered tree is the tree the gate reviewed');
      assert.equal(p.checkpoints.at(-1)?.state, 'safe');
      await assert.rejects(fs.access(join(wrote[0].project, 'gate-write.txt')), { code: 'ENOENT' }, 'the byproduct is not delivered');
      report.status = p.status; report.conclusion = p.conclusion;
    } else if (scenario === 'command-preparation') {
      const p = await settled();
      const diagnostic = 'Synthetic command preparation refusal: native recorder unavailable';
      assert.notEqual(p.status, 'complete');
      const receipt = p.commands.at(-1); assert(receipt);
      assert.equal(receipt.execution.state, 'not_started');
      const evidence = await load('records/evidence.js');
      assert.equal(Buffer.from(value(await evidence.readEvidence(journal,receipt.stdout))).toString(), '', 'unstarted command has no fabricated stdout');
      assert.deepEqual(JSON.parse(Buffer.from(value(await evidence.readEvidence(journal,receipt.stderr))).toString()),
        {refusal:{ok:false,kind:'unavailable',detail:diagnostic}}, 'preparation Result retained exactly in diagnostic stderr');
      const status = (await invoke(['status', run])).json();
      assert(status.attention?.detail.includes(diagnostic), 'operator attention retains exact preparation Result detail');
      assert(status.attention?.detail.includes('diagnostic git/objects/'), 'operator receives diagnostic locator');
      const hook = await import(pathToFileURL(join(packageRoot, 'dist-rewrite/flowcrew-session.mjs')).href);
      const wake = await hook.runHook({session_id:'synthetic-acceptance'}, {storeRoots:[storeRoot],tasksRoot:join(root,'tasks')}, 'Wake');
      assert(wake.stderr.includes(diagnostic), 'hook text retains preparation refusal');
      report.status = p.status; report.conclusion = p.conclusion;
    } else {
      const p = await settled();
      if (scenario === 'dependency-reuse') {
        assertComplete(p);
        assert.match(p.conclusion?.detail ?? '',/B: reused from review\//);
        assert.deepEqual(p.commands.map(receipt=>receipt.command),['A','B','A']);
        const reviews = p.attempts.filter(attempt=>attempt.address.stage==='review');
        assert.equal(reviews.length,2);
        assert.equal(reviews[1]?.reusedCommands?.find(/** @param {any} item */ item=>item.receipt.command==='B')?.receipt.command,'B');
        const status = (await invoke(['status',run])).json();
        const progress = status.stages.find(/** @param {any} stage */ stage=>stage.id==='review').commandProgress;
        assert.equal(progress.find(/** @param {any} command */ command=>command.command==='B').reused,`reused from review/${reviews[0].address.attempt}`);
        assert.match(progress.find(/** @param {any} command */ command=>command.command==='A').source,/^from review\//);
        assert.equal(progress.find(/** @param {any} command */ command=>command.command==='A').reused,undefined);
        for (const command of progress) assert.match(command.source,/tree [a-f0-9]{64}/);
        report.reuseStatus = progress;
      }
      if (scenario.startsWith('fixed-')) {
        assertComplete(p);
        assert.deepEqual(p.attempts.map(/** @param {any} attempt */ attempt=>attempt.address.stage), scenario === 'fixed-graph' ? ['work','gate'] : ['work','gate','repair','gate'],
          'the fixed graph runs work, then the gate, and after a rejection repair, then the gate again');
        assert.equal(p.revisions.length, 1, 'no planner ever revised the graph');
        assert(!p.attempts.some(/** @param {any} attempt */ attempt=>p.plan.plan.stages.find(/** @param {any} stage */ stage=>stage.id===attempt.address.stage)?.purpose==='plan'));
        const gate = p.plan.plan.stages.find(/** @param {any} stage */ stage=>stage.purpose==='gate');
        assert(gate && !Object.hasOwn(gate, 'instruction'), 'the admitted gate stage has no instruction');
        const rows = (await fs.readFile(trace,'utf8')).trim().split('\n').map(row=>JSON.parse(row));
        assert(!rows.some(row=>row.kind==='plan'), 'no planner provider call');
        if (scenario === 'fixed-repair') assert.equal(rows.filter(row=>row.event==='repair-findings').length, 1);
      }
      if (scenario === 'fresh-request') assert.equal(p.commands.length, 2, 'each new request executes even when source bytes are unchanged');
      if (scenario.startsWith('refusal-')) {
        assert.equal(p.status, 'complete', 'refusal reason must reach actual next author input; four unchanged refused answers cannot count as recovery');
        const invalid = p.attempts.filter(attempt=>attempt.ending==='invalid_plan'||attempt.ending==='invalid_answer');
        assert.equal(invalid.length, 1, 'only one refused answer before reason-driven correction');
        const rows = (await fs.readFile(trace,'utf8')).trim().split('\n').map(row=>JSON.parse(row));
        const correction = rows.find(row=>row.event==='input-contract' && row.correction?.refusals?.length);
        assert(correction?.correction.answer, 'prior answer accompanies refusal');
        assert(correction.correction.refusals.every(/** @param {any} item */ item=>item.result.ok===false && item.evidence.path), 'exact Result and evidence delivered');
      }
      assert(requests.length > 0, 'author retains host access to the outside-project socket');
      if (scenario === 'frozen-copy') {
        assert.equal(await fs.readFile(join(root, 'mutated'), 'utf8'), 'yes');
        assert.equal(await fs.readFile(join(copied, 'spec.txt'), 'utf8'), 'Synthetic frozen specification.\n', 'copied frozen mutation restored');
        assert(p.attempts.some(a => a.ending === 'isolation_failure'), 'copied frozen mutation causes isolation_failure');
        assert.equal(p.status,'complete', 'retry succeeds after frozen copy restoration');
        assert(!p.attempts.some(a=>a.ending==='provider_unknown'), 'fake provider succeeds on retry');
      } else if(scenario==='stale-source') {
        assert.equal(p.status,'incomplete','earlier-tree pass cannot satisfy final delivery');
        assert.equal(p.conclusion?.reason,'command_nonzero');
        assert.match(p.conclusion?.detail??'',/Verify.*exit 7/);
        assert.deepEqual(p.commands.map(c=>c.execution),[{state:'complete',exit:0},{state:'complete',exit:7}]);
        assert.notEqual(p.commands[0].before,p.commands[1].before,'source changed after earlier pass');
        const status=(await invoke(['status',run])).json();
        assert(JSON.stringify(status.attention).includes('Verify'),'attention names the failed command');
      } else if(scenario==='frozen-input') {
        assert(p.attempts.some(a=>a.ending==='isolation_failure'),'frozen external change retains isolation_failure');
        assert(p.checkpoints.some(c=>c.state==='quarantined'));
      } else assertComplete(p);
      if(scenario==='many-command-later-gate') {
        assert.equal(p.commands.length,16,'engine runs every required command, including planner omission');
        assert(p.commands.every(c=>c.before!==c.after),'read-and-produced writes belong to the delivered command phase');
        assert.equal(await fs.readFile(join(copied,'phase.txt'),'utf8'),'16');
        const review=p.plan.plan.stages.find(s=>s.id==='review');assert(review?.commands);assert.equal(review.commands.length,15);
        assert(p.attempts.every(a=>a.ending==='delivered'),'later commands never rewrite the first safe work answer');
        assert(!JSON.stringify(p.plan.plan).includes('observations'));
      }
      if(scenario==='mutable-input') {
        assert(p.checkpoints.every(c=>c.state==='safe'),'mutable change never quarantines');
        const input=await fs.readFile(fixture.input,'utf8');assert.equal(input,'changed between stages');
        assert.notDeepEqual(p.checkpoints.at(-1)?.inputHashes,p.launch.setup.inputs,'mutable hashes remain recorded');
      }
      if (scenario === 'plan-repair') {
        assert.equal(p.attempts[0].ending, 'invalid_plan', 'unknown role refused at author boundary');
        assert(p.attempts[0].answerRef, 'rejected raw answer remains evidence');
        assert.equal(p.attempts[1].ending, 'delivered', 'valid graph is admitted without relations');
        assert.equal(p.revisions.length, 2, 'rejected plan never committed');
      }
      const rows = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
      const before = rows.find(row => row.event === 'before'), after = rows.find(row => row.event === 'after');
      assert.equal(before.exit, 1, 'fixture branches on actual failure'); assert.equal(after.exit, 0);
      assert.equal(JSON.parse(before.stdout).actual, 3); assert.equal(JSON.parse(after.stdout).actual, 28);
      assert(requests.length >= 2, 'real subprocesses reached the outside-project Unix service');
      const evidence = await load('records/evidence.js');
/** @param {string} text */
      const absent = text => {
        for (const key of ['bounds','adapterInputLimitChars','retiredBounds','provenance','enforcement','limits'])
          assert(!text.includes('"'+key+'"'), 'retired control leaked into semantic records: '+key);
        for (const number of ['908172635','908172636','908172637']) assert(!text.includes(number));
      };
      absent(JSON.stringify(p.launch));absent(JSON.stringify(p.authority));
      absent(await fs.readFile(join(journal.root,'status.json'),'utf8'));
      for (const attempt of p.attempts) {
        const input = Buffer.from(value(await evidence.readEvidence(journal,attempt.evidence[0]))).toString();
        absent(input);assert(input.includes('Use measured host feedback.\n') && !input.startsWith('{'), 'the brief body arrives unescaped in a Markdown message');
      }
      const workPid=rows.find(row=>row.kind==='work'&&row.event==='entered')?.pid;
      const gatePid=rows.find(row=>row.kind==='gate'&&row.event==='entered')?.pid;
      if (!['frozen-copy','frozen-input'].includes(scenario)) assert(workPid && gatePid && workPid !== gatePid, 'independent gate is a separate native invocation');
      const streams = await Promise.all((await events()).flatMap(e=>e.payload.type==='process'?[e.payload.receipt]:[]).map(async receipt => ({
        stdout: Buffer.from(value(await evidence.readEvidence(journal, receipt.stdout))).toString(),
        stderr: Buffer.from(value(await evidence.readEvidence(journal, receipt.stderr))).toString() })));
      assert(streams.some(row => row.stdout.includes(backend === 'codex' ? 'command_execution' : 'tool_result')), 'native author tool traces retained');
      report = { ...report, status: p.status, attempts: p.attempts.map(a => a.ending), commandExecutions: p.commands.map(c => c.execution),
        requests: requests.length, sourceInode: originalStat.ino, copyInode: copiedStat.ino, launcherExit: exit,
        controllerPid: activation.owner.pid, trace: rows, streams };
    }
    if(['host-claude','external-signal'].includes(scenario)){
      const terminal=await projection();
      await until(async()=>await nativeIdentity.observeController(activationOwner)==='inactive','terminal controller releases before controls');
      const planFile=join(root,'terminal-plan.json');await fs.writeFile(planFile,JSON.stringify({stages:[]}));
      await invoke(['status',run]);
      for(const args of [['guide',run,'Continue'],['guide',run,'Continue','--plan',planFile],['resume',run]])
        assert.notEqual((await invoke(args,null)).code,0,'terminal state refuses all continuation controls');
      assert.equal((await projection()).invocations.length,terminal.invocations.length);
      assert.equal((await invoke(['status',run])).json().status,terminal.status);
    }
    await assert.rejects(fs.stat(join(source,'product.json')),{code:'ENOENT'},'delivered product never writes into source');
    assert.equal(await fs.readFile(join(source, 'sum.mjs'), 'utf8'), 'export const sum = (a,b) => a - b;\n');
    assert.equal(await fs.readFile(join(source, 'spec.txt'), 'utf8'), 'Synthetic frozen specification.\n');
    assert.equal(await fs.readFile(join(root, 'spec-alias'), 'utf8'), 'Synthetic frozen specification.\n');
    assert.equal(hash(await fs.readFile(brief)), hash(bytes));
    report.ok = true;
    return report;
  } catch (error) {
    report = { ...report, ok: false, error: error instanceof Error ? error.message : String(error) };
    throw error;
  } finally {
    cleaning = true; // Cancellation cannot abort its own cleanup.
    const cleanupErrors = [];
    await Promise.all(['closure-denied','claim-denied','receipt-unknown'].map(name=>fs.rm(join(root,name),{force:true})));
    await Promise.all(['control-release','recovery-release','resumed-release'].map(name=>fs.writeFile(join(root,name),'fixture cleanup')));
    // Admission can outlive a killed launcher before its acknowledgement. Discover
    // every run in this fixture's private database, never the user's store/units.
    const database = join(fcHome, 'state.sqlite');
    const listed = await fs.stat(database).then(() => state.listProjections(storeRoot, database), () => undefined);
    const runs = listed?.ok ? listed.value.map(row => row.location) : run ? [{database,storeRoot,run}] : [];
    report.remainingOwners = [];
    report.cleanupOwners = [];
    for (const location of runs) {
      try {
        const opened = value(await state.openJournal(location, 'read'));
        if (!journal.root) journal = opened;
        try { await invoke(['cancel', location.run], null); } catch { /* Authenticated fallback below. */ }
        const facts = value(await state.readEvents(opened, 0));
        const controllers = facts.flatMap(e=>e.payload.type === 'run_observed' && e.payload.observation.owner ? [e.payload.observation.owner] : []);
        // Stop the producer before collecting its final descendant ownership facts.
        for (const owner of new Map(controllers.map(owner=>[owner.authority,owner])).values()) value(await host.closeOperation(owner));
        const current = value(await state.readProjection(opened));
        const owners = new Map([...controllers,...current.owners.map(row=>row.owner)].map(owner=>[owner.authority,owner]));
        report.cleanupOwners.push(...owners.values());
        for (const owner of owners.values()) {
          try { value(await host.closeOperation(owner)); } catch (error) { cleanupErrors.push(error); }
        }
        value(await state.reclaimRecordOperations(opened));
        report.remainingOwners.push(...await Promise.all([...owners.values()].map(owner=>host.probeOwner(owner))));
      } catch (error) { cleanupErrors.push(error); }
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise(resolve=>child.once('close', resolve));
        child.kill('SIGKILL'); await closed;
      }
    }
    report.cleanupErrors = cleanupErrors.map(error=>String(error));
    if (server) { const closingServer=server; await new Promise(resolve => closingServer.close(()=>resolve(undefined))); }
    report.wallMs = performance.now() - startedAt;
    if (journal.root) {
      report.events = await events();
      report.activity = value(state.readAdvisoryActivity(journal));
      try{report.commandDispatches=(await fs.readFile(join(root,'command-dispatches'),'utf8')).trim().split('\n');}catch { /* This phase may not have dispatched a declared native command. */ }
      if (!report.streams && !(await projection()).reclaimed) {
        const evidence=await load('records/evidence.js');
        report.streams=await Promise.all((await events()).flatMap(e=>e.payload.type==='process'?[e.payload.receipt]:[]).map(async receipt=>({
          stdout:Buffer.from(value(await evidence.readEvidence(journal,receipt.stdout))).toString(),
          stderr:Buffer.from(value(await evidence.readEvidence(journal,receipt.stderr))).toString()
        })));
      }
      try { report.trace ??= (await fs.readFile(trace, 'utf8')).trim().split('\n').map(row => JSON.parse(row)); } catch { /* Optional synthetic evidence may be absent on an earlier failure. */ }
    }
    if (evidenceDirectory) {
      await fs.mkdir(evidenceDirectory, { recursive: true });
      await fs.writeFile(join(evidenceDirectory, scenario + '.json'), JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(JSON.stringify({publicCLI:report})+'\n');
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(socketRoot, { recursive: true, force: true });
    if (artifact) await fs.rm(artifact.root, { recursive: true, force: true });
    assert(report.remainingOwners.every(/** @param {string} status */ status => status === 'dead'), 'no fixture-owned survivors');
    assert.deepEqual(report.cleanupErrors, [], 'public fixture cleanup failed');
  }
}

// Exact source deleted by G1 (9069b4d..4aa33fb); restored helpers retain their original bodies.
export const retiredLateReclassification = `  if (receipt.ending === 'delivered') {
    const completed = {...delivered,checkpoints:[...delivered.checkpoints,checkpoint.value],
      lineage:[...delivered.lineage,{kind:'checkpoint' as const,checkpoint:checkpoint.value}]};
    const candidate = admitted?.ok ? {...completed,plan:admitted.value,revisions:[...delivered.revisions,admitted.value],
      stageStates:planStageStates(delivered.stageStates,admitted.value)} : completed;
    const relations = receipt.answer?.kind !== 'work' || admitRelations(receipt.answer.answer.observations ?? [], current.brief.declaration).ok;
    if (!relations || !dispatchableFrontier(candidate).ok) receipt = {...receipt,ending:stage.purpose === 'plan' ? 'invalid_plan' : 'invalid_answer'};
  }
`;
export const retiredAdmitRelations = `function admitRelations(relations: readonly CommandRelation[], brief: Brief): Result<true> {
  for (const relation of relations) {
    const command = brief.commands.find(item => item.id === relation.command);
    if (!command || relation.criterionIds.some(id => !brief.criteria.some(item => item.id === id))
      || command.inputs.some(id => !relation.sources.includes(brief.inputs.find(item => item.id === id)!.path)))
      return invalid('Command observation omits declared inputs or references unknown identities');
  }
  return { ok: true, value: true };
}
`;

// Mutation targets are fresh, disposable package artifacts. Original runtime pins,
// checkout outputs and installed producer files are never modified by these controls.
/** @param {string} packageRoot */
async function disposablePackage(packageRoot) {
  const root = await fs.mkdtemp(join(tmpdir(), 'fc-withdraw-')), path = join(root, 'package');
  await fs.mkdir(path);
  for (const name of ['dist-rewrite', 'dist-monitor', 'config', 'skills', 'package.json'])
    await fs.cp(join(packageRoot, name), join(path, name), { recursive: true });
  const require = createRequire(join(packageRoot, 'package.json'));
  await fs.symlink(dirname(dirname(require.resolve('zod/package.json'))), join(path, 'node_modules'));
  return { root, path };
}
/** @param {string} root @param {string} file @param {string} before @param {string} after */
async function replaceArtifact(root, file, before, after) {
  const path = join(root, 'dist-rewrite', file), text = await fs.readFile(path, 'utf8');
  assert.equal(text.split(before).length, 2, `mutation must match exactly one boundary: ${file}`);
  await fs.chmod(path, 0o644);
  await fs.writeFile(path, text.replace(before, after));
}
