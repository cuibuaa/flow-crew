import { expect, it, vi } from 'vitest';
import type { CommandReceipt, RunProjection } from '../dist-rewrite/contract/runtime.js';
import { commandBasis, commandEvidenceLabel } from '../dist-rewrite/contract/runtime.js';
import { coreProjection } from './fixtures/rewrite-core-projection.js';
import { baseConclusion, requiredCommandResult, selectedCommandIds, reviewCommandEvidence, decidePublication } from '../dist-rewrite/core/decisions.js';
import { commandDeclarationIdentity } from '../dist-rewrite/exec/command.js';
import { changedTreePaths, frozenInputsMatch } from '../dist-rewrite/records/content.js';
import { readEvents } from '../dist-rewrite/records/state.js';
const journal = {root:'/synthetic',database:'/synthetic/state.sqlite'};
vi.mock('../dist-rewrite/records/content.js', () => ({ changedTreePaths:vi.fn(), frozenInputsMatch:vi.fn() }));
vi.mock('../dist-rewrite/records/state.js', async original => ({...await original<typeof import('../dist-rewrite/records/state.js')>(),readEvents:vi.fn()}));

it.each([
  ['undeclared identical tree','satisfied'], ['undeclared then tree-writing command','satisfied'],
  ['undeclared author change','run'], ['undeclared diff','run'], ['undeclared inputs changed','run'],
  ['file dependency','run'], ['directory dependency','run'], ['other paths','satisfied'],
  ['nonzero','run'], ['nonzero, also fails on the base','satisfied'], ['nonzero, passes on the base','run'],
  ['nonzero, base run did not complete','run'], ['unfinished','run'], ['different key','run'],
  ['uncommitted','run'], ['restore','run'], ['retired','run'], ['diff unavailable','run'], ['diff throws','run'],
  ['declared inputs equal','satisfied'], ['declared inputs changed','run'],
  ['latest passing','satisfied'], ['latest failed, older passed','run'], ['latest unfinished, older passed','run'],
  ['latest interrupted, older passed','run'], ['accounting_interrupted final gate then dispatch','run'],
  ['accounting_interrupted completed final gate','satisfied'],
  ['same invocation','satisfied'], ['same invocation failed','run'], ['same attempt earlier invocation','satisfied'],
  ['renamed dependency ancestor','run'], ['unknown history','run'],
] as const)('required-command reuse decision table: %s → %s', async (scenario, expected) => {
  const bound = scenario.includes('inputs');
  const command = {id:'Check',argv:['/synthetic/check'],env:{},inputs:bound ? ['Source'] : [],required:true,
    ...(scenario.startsWith('undeclared') || scenario.startsWith('accounting_interrupted') ? {} : {dependsOn:['a/file','b']})};
  const ref = {path:'authored/ref',sha256:'a'.repeat(64)};
  const receipt = (id: string): CommandReceipt => ({command:'Check',key:{tree:ref.sha256,generation:ref,
    declaration:commandDeclarationIdentity(command),inputHashes:bound ? ['e'.repeat(64)] : [],context:id.repeat(64)},before:ref.sha256,
    after:id.repeat(64),execution:{state:'complete',exit:0},stdout:ref,stderr:ref,delta:ref,spent:{durationMs:1}});
  let first = receipt('b'), second = receipt('c');
  if (['nonzero','same invocation failed'].includes(scenario)) first = {...first,execution:{state:'complete',exit:7}};
  const onBase = (execution: CommandReceipt['execution']): CommandReceipt['base'] => ({tree:'0'.repeat(64),ok:true,execution,stdout:ref,stderr:ref,spent:{durationMs:1}});
  if (scenario === 'nonzero, also fails on the base') first = {...first,execution:{state:'complete',exit:7},base:onBase({state:'complete',exit:2})};
  if (scenario === 'nonzero, passes on the base') first = {...first,execution:{state:'complete',exit:7},base:onBase({state:'complete',exit:0})};
  if (scenario === 'nonzero, base run did not complete') first = {...first,execution:{state:'complete',exit:7},base:{tree:'0'.repeat(64),ok:false,kind:'unknown',detail:'closure not confirmed'}};
  if (['unfinished','accounting_interrupted final gate then dispatch'].includes(scenario)) first = {...first,execution:{state:'unfinished',reason:'closure_unknown'}};
  if (scenario === 'different key') first = {...first,key:{...first.key,declaration:'d'.repeat(64)}};
  if (scenario === 'latest failed, older passed') second = {...second,execution:{state:'complete',exit:2}};
  if (scenario === 'latest unfinished, older passed') second = {...second,execution:{state:'unfinished',reason:'closure_unknown'}};
  const commands = scenario.startsWith('latest ') || scenario === 'diff unavailable' ? [first,second] : [first];
  // A later command that starts from the tree Check left and writes delivered bytes.
  const writer: CommandReceipt = {...second,command:'Write',key:{...second.key,tree:first.after,generation:{...ref,sha256:first.after}},before:first.after};
  const chained = scenario === 'undeclared then tree-writing command';
  if (chained) commands.push(writer);
  const base = coreProjection(true), gate = base.plan.plan.stages.find(stage => stage.id === 'gate')!;
  const sameAttempt = scenario.startsWith('same ') || scenario.startsWith('accounting_interrupted');
  const target = {tree:sameAttempt || ['undeclared identical tree','undeclared inputs changed'].includes(scenario) ? first.after : chained ? writer.after : 'f'.repeat(64),
    inputHashes:bound ? [{path:'authored/source',sha256:(scenario.endsWith('changed') ? 'd' : 'e').repeat(64)}] : []};
  const paid = {charge:'work' as const,address:{kind:'stage' as const,...base.checkpoints[0].address}};
  const reservations: RunProjection['reservations'] = commands.map((item,index) => ({
    state:'committed',identity:item.command,key:item.key,
    receipt:item,invocation:{charge:'command',address:{kind:'stage',run:'Run',stage:scenario === 'retired' ? 'retired' : 'gate',
      attempt:sameAttempt || chained ? 'GateAttempt' : 'Earlier'+index,invocation:1}}}));
  if (scenario === 'uncommitted') reservations.length = 0;
  if (scenario === 'latest interrupted, older passed') {
    const {key,identity,invocation} = reservations[1];
    reservations[1] = {key,identity,invocation,state:'closed-unmeasured'};
    commands.pop();
  }
  const interrupted = scenario.startsWith('accounting_interrupted');
  // The author's checkpoint after the command changed the tree.
  const authored = scenario === 'undeclared author change' ? [{kind:'checkpoint' as const,checkpoint:{...base.checkpoints[0],tree:target.tree}}] : [];
  const p: RunProjection = {...base,commands,lineage:[...commands.map(item => ({kind:'command' as const,receipt:item})),...authored],
    brief:{...base.brief,declaration:{...base.brief.declaration,commands:[command],
      inputs:bound ? [{id:'Source',path:'source',kind:'file',frozen:true}] : []}},reservations,
    ...(interrupted ? {attempts:[],transitions:[],checkpoints:[],invocations:[paid],closedInvocations:[paid],
      stageStates:base.stageStates.map(state => state.stage === 'gate' ? {...state,state:'running' as const} : state)} : {})};
  const facts: any[] = commands.map((item,index) => ({seq:index+1,payload:{type:'command',receipt:item}}));
  if (scenario === 'restore') facts.push({seq:facts.length+1,payload:{type:'checkpoint_restore_started',checkpoint:'Earlier'}});
  if (interrupted) facts.push({seq:2,payload:{type:'accounting_interrupted'}});
  vi.mocked(readEvents).mockResolvedValue(scenario === 'unknown history' ? {ok:false,kind:'unknown',detail:'unavailable'} : {ok:true,value:facts});
  vi.mocked(frozenInputsMatch).mockResolvedValue(true);
  vi.mocked(changedTreePaths).mockClear();
  vi.mocked(changedTreePaths).mockImplementation(async (_, before) => {
    if (scenario === 'diff throws') throw Error('unavailable');
    return scenario === 'diff unavailable' && before === second.after ? {ok:false,kind:'unknown',detail:'No Git objects'} : {ok:true,value:
      scenario === 'file dependency' ? ['a/file'] : scenario === 'directory dependency' ? ['b/nested/file']
        : scenario === 'renamed dependency ancestor' ? ['a'] : ['other/file']};
  });
  const result = await requiredCommandResult(journal,p,command,target);
  expect(result.kind).toBe(expected);
  if (result.kind === 'satisfied') {
    const chosen = scenario === 'latest passing' ? second : first;
    expect(result).toMatchObject({receipt:chosen,sourceTree:chosen.after,
      source:{stage:'gate',attempt:sameAttempt || chained ? 'GateAttempt' : scenario === 'latest passing' ? 'Earlier1' : 'Earlier0',invocation:1},dependencyIntersection:[]});
    expect(await reviewCommandEvidence(journal,p,gate,true,target)).toEqual({commands:[chosen],reusedCommands:[{
      receipt:result.receipt,sourceTree:result.sourceTree,source:result.source,dependencyIntersection:[]} ]});
    const label = commandEvidenceLabel(result,{...base.checkpoints[0].address,...(interrupted ? {attempt:'Next'} : {}),invocation:scenario === 'same attempt earlier invocation' ? 2 : 1});
    expect(Boolean(label.reused)).toBe(scenario !== 'same invocation' && !chained);
    expect(label.source).toContain(result.sourceTree);
  }
  if (['latest failed, older passed','latest unfinished, older passed'].includes(scenario)) {
    const review = await reviewCommandEvidence(journal,p,gate,true,target);
    expect(review.commands).toEqual([second]);
    expect(review.reusedCommands[0]).toMatchObject({receipt:second,source:{stage:'gate',attempt:'Earlier1'}});
    expect(review.reusedCommands[0]).not.toHaveProperty('dependencyIntersection');
  }
  if (scenario === 'latest interrupted, older passed')
    expect(await reviewCommandEvidence(journal,p,gate,true,target)).toEqual({commands:[],reusedCommands:[]});
  // Dispatch consumes the same verdict: run selects the command, satisfied withholds it.
  expect(await selectedCommandIds(gate,p,journal,target,true)).toEqual(expected === 'run' ? ['Check'] : []);
  if (scenario.startsWith('undeclared')) expect(changedTreePaths).not.toHaveBeenCalled();
});

/** A final gate whose only required command ran in `source` (a stage and attempt of its own for the two `earlier` sources); `via` says
 * what happened to the tree afterwards. The gate's checkpoint always follows, so it is a checkpoint from another stage unless the
 * command ran in the gate attempt itself. */
function gateFixture(dependsOn: string[] | undefined, source: 'earlier attempt' | 'earlier stage' | 'same delivery',
  via: 'nothing' | 'tree-writing command' | 'unrelated command' | 'author change', required = true) {
  const base = coreProjection(true), checkpoint = base.checkpoints[0];
  const command = {id:'Check',argv:['/synthetic/check'],env:{},inputs:[],required,...(dependsOn ? {dependsOn} : {})};
  const ref = checkpoint.manifest, left = via === 'nothing' ? checkpoint.tree : 'e'.repeat(64);
  const receipt = (id: string, before: string, after: string): CommandReceipt => ({command:id,key:{tree:before,generation:{...ref,sha256:before},
    declaration:commandDeclarationIdentity(command),inputHashes:[],context:'c'.repeat(64)},before,after,
    execution:{state:'complete',exit:0},stdout:ref,stderr:ref,delta:ref,spent:{durationMs:1}});
  const check = receipt('Check',ref.sha256,left);
  // An unrelated command starts from some other tree than the one Check left.
  const writer = receipt('Write',via === 'unrelated command' ? 'a'.repeat(64) : left,checkpoint.tree);
  const commands = via === 'tree-writing command' || via === 'unrelated command' ? [check,writer] : [check];
  const address = {kind:'stage' as const,...checkpoint.address,...(source === 'earlier stage' ? {stage:'work'} : {}),
    attempt:source === 'same delivery' ? checkpoint.address.attempt : 'Earlier'};
  const p: RunProjection = {...base,commands,brief:{...base.brief,declaration:{...base.brief.declaration,commands:[command]}},
    reservations:commands.map(item => ({state:'committed' as const,identity:item.command,key:item.key,receipt:item,invocation:{charge:'command' as const,address}})),
    lineage:[...commands.map(item => ({kind:'command' as const,receipt:item})),{kind:'checkpoint',checkpoint}]};
  const facts: any[] = [...commands.map((item,index) => ({seq:index+1,payload:{type:'command',receipt:item}})),{seq:commands.length+1,payload:{type:'checkpoint',checkpoint}}];
  vi.mocked(readEvents).mockResolvedValue({ok:true,value:facts});
  vi.mocked(frozenInputsMatch).mockResolvedValue(true);
  vi.mocked(changedTreePaths).mockResolvedValue({ok:true,value:[]});
  return {p,command,checkpoint,facts,gate:p.plan.plan.stages.find(stage => stage.id === 'gate')!};
}
const outputs = {preserved:true,artifacts:[],detail:''};

it.each([['declared','earlier attempt'],['declared','same delivery'],['undeclared','same delivery']] as const)(
  'a restore appended after the last checkpoint makes dispatch and publication require execution: %s command from %s', async (kind, source) => {
  const {p,command,checkpoint,facts,gate} = gateFixture(kind === 'declared' ? ['a'] : undefined,source,'nothing');
  expect(await selectedCommandIds(gate,p,journal,checkpoint,true)).toEqual([]);
  expect(await decidePublication(journal,p,checkpoint,outputs)).toMatchObject({ok:true,value:{status:'complete'}});
  facts.push({seq:3,payload:{type:'checkpoint_restore_started',checkpoint:checkpoint.id}},
    {seq:4,payload:{type:'checkpoint_materialized',checkpoint:checkpoint.id}});
  expect((await requiredCommandResult(journal,p,command,checkpoint)).kind).toBe('run');
  expect(await selectedCommandIds(gate,p,journal,checkpoint,true)).toEqual(['Check']);
  expect(await decidePublication(journal,p,checkpoint,outputs)).toMatchObject({ok:true,value:{status:'incomplete',reason:'command_missing'}});
});

// Final-gate commands write evidence into the delivery tree, so a later command must not invalidate an earlier undeclared one;
// an author change must.
it.each([['a tree-writing command','complete','tree-writing command'],['an author change','command_missing','author change']] as const)(
  'an undeclared command followed by %s reaches publication as %s and is selected at dispatch accordingly', async (_title, outcome, via) => {
  const {p,checkpoint,gate} = gateFixture(undefined,'same delivery',via);
  // Publication first: a rule that rejects the chain must fail here, not at the dispatch selection below.
  expect(await decidePublication(journal,p,checkpoint,outputs)).toMatchObject({ok:true,value:outcome === 'complete'
    ? {status:'complete'} : {status:'incomplete',reason:outcome}});
  expect(await selectedCommandIds(gate,p,journal,checkpoint,true)).toEqual(outcome === 'complete' ? [] : ['Check']);
});

// The chain is by tree, not by address: the command ran in another stage and attempt than the checkpoint that follows it. With the
// same tree nothing was authored in between (satisfied); a different tree, or a later command that does not start from the tree
// the receipt left, breaks the chain (run).
it.each([
  ['a checkpoint of another stage with the same tree','complete','nothing'],
  ['a checkpoint of another stage with a different tree','command_missing','author change'],
  ['a later command that does not start from the receipt\'s tree','command_missing','unrelated command'],
] as const)('an undeclared command from another stage followed by %s reaches publication as %s', async (_title, outcome, via) => {
  const {p,command,checkpoint,gate} = gateFixture(undefined,'earlier stage',via);
  expect(p.lineage.some(item => item.kind === 'checkpoint' && item.checkpoint.address.stage !== 'work')).toBe(true);
  expect((await requiredCommandResult(journal,p,command,checkpoint)).kind).toBe(outcome === 'complete' ? 'satisfied' : 'run');
  expect(await decidePublication(journal,p,checkpoint,outputs)).toMatchObject({ok:true,value:outcome === 'complete'
    ? {status:'complete'} : {status:'incomplete',reason:outcome}});
  expect(await selectedCommandIds(gate,p,journal,checkpoint,true)).toEqual(outcome === 'complete' ? [] : ['Check']);
});

// A failing required command is judged against the base tree by the one publication owner: the same measured facts give the same
// publication result, the same dispatch selection and the same displayed classification.
const treeOf = '0'.repeat(64);
// What `base` holds is exactly what the executor stored: (a) the receipt measure produced, (b) measure's failure verbatim,
// (c) the executor's own failure before measure was called. Only a complete non-zero base run is pre-existing; the conclusion is
// rendered from the stored data alone.
it.each([
  ['(a) fails on the base too', ref => ({tree:treeOf,ok:true,execution:{state:'complete',exit:2},stdout:ref,stderr:ref,spent:{durationMs:1}}),
    'complete', 'pre-existing', ''],
  ['(a) passes on the base', ref => ({tree:treeOf,ok:true,execution:{state:'complete',exit:0},stdout:ref,stderr:ref,spent:{durationMs:1}}),
    'command_nonzero', 'introduced', 'passes on the base tree'],
  ['(a) was refused a launch on the base', ref => ({tree:treeOf,ok:true,execution:{state:'not_started',reason:'preparation_failed'},stdout:ref,stderr:ref,
    spent:{durationMs:0},refusal:{kind:'unavailable',detail:'unsupported'}}), 'command_nonzero', 'introduced',
    'base run did not complete: not_started: preparation_failed: unavailable: unsupported'],
  ['(b) has a base launch that measure refused as unknown', () => ({tree:treeOf,ok:false,kind:'unknown',detail:'closure not confirmed'}),
    'command_nonzero', 'introduced', 'base run did not complete: unknown: closure not confirmed'],
  ['(c) has a base copy that could not be placed', () => ({tree:treeOf,ok:false,kind:'not_placed',detail:'unavailable: copy refused'}),
    'command_nonzero', 'introduced', 'base run did not complete: not_placed: unavailable: copy refused'],
  ['was never measured on the base', () => undefined, 'command_nonzero', undefined, 'exit 7'],
] as const)('a required command that exits non-zero and %s reaches publication', async (_title, stored, outcome, basis, text) => {
  const {p,command,checkpoint,gate} = gateFixture(['a'],'same delivery','nothing');
  const ref = checkpoint.manifest;
  const failed = (receipt: CommandReceipt): CommandReceipt => ({...receipt,execution:{state:'complete',exit:7},
    ...(stored(ref) ? {base:stored(ref)} : {})});
  const receipts = p.commands.map(failed);
  const failing: RunProjection = {...p,commands:receipts,
    reservations:p.reservations.map(item => item.state === 'committed' ? {...item,receipt:failed(item.receipt)} : item),
    lineage:p.lineage.map(item => item.kind === 'command' ? {...item,receipt:failed(item.receipt)} : item)};
  vi.mocked(readEvents).mockResolvedValue({ok:true,value:[...receipts.map((item,index) => ({seq:index+1,payload:{type:'command',receipt:item}})),
    {seq:receipts.length+1,payload:{type:'checkpoint',checkpoint}}] as any});
  expect((await requiredCommandResult(journal,failing,command,checkpoint)).kind).toBe(outcome === 'complete' ? 'satisfied' : 'run');
  const published = await decidePublication(journal,failing,checkpoint,outputs);
  expect(published).toMatchObject({ok:true,value:outcome === 'complete' ? {status:'complete'} : {status:'incomplete',reason:outcome}});
  // A blocking failure names why in the conclusion; a pre-existing one is data only (`basis`), never prose in the label.
  if (outcome !== 'complete') expect(published.ok && published.value.detail).toContain(text);
  // Dispatch withholds a pre-existing failure it need not run again; the gate and author still see the receipt, classified.
  expect(await selectedCommandIds(gate,failing,journal,checkpoint,true)).toEqual(outcome === 'complete' ? [] : ['Check']);
  const review = await reviewCommandEvidence(journal,failing,gate,true,checkpoint);
  expect(review.commands).toEqual(receipts);
  expect(commandBasis(review.commands[0])).toBe(basis);
  // The conclusion is derived from the stored base alone, its exit included.
  if (stored(ref)) expect(baseConclusion(stored(ref)!)).toBe(outcome === 'complete' ? 'fails on the base tree too' : text);
  if (outcome === 'complete') expect(commandEvidenceLabel(review.reusedCommands[0],checkpoint.address).source).not.toMatch(/base/);
});

// One reuse rule for every command: required or not, in the final gate or any other stage, a passing receipt on unchanged inputs that
// still leads to the target is not run again; one that no longer does is. Required commands join a stage's own only on the final gate.
it.each([
  ['an optional command of a non-final stage, tree unchanged', false, 'nothing', true, false, []],
  ['an optional command of a non-final stage, author change since', false, 'author change', true, false, ['Check']],
  ['an optional command of the final gate, tree unchanged', false, 'nothing', true, true, []],
  ['a required command the stage does not list, non-final stage, author change since', true, 'author change', false, false, []],
  ['a required command the stage does not list, final gate, author change since', true, 'author change', false, true, ['Check']],
] as const)('selection runs only commands without an applicable passing receipt: %s', async (_title, required, via, listed, final, expected) => {
  const {p,checkpoint,gate} = gateFixture(undefined,'same delivery',via,required);
  expect(await selectedCommandIds({...gate,commands:listed ? ['Check'] : []},p,journal,checkpoint,final)).toEqual(expected);
});
