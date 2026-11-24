import { existsSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe,expect,it,vi } from 'vitest';
import { decideWake,observe,runHook,waitForWake } from '../integrations/claude/flowcrew-session.mjs';
import { type RunStatus,type RunStatusFile } from '../rewrite-src/contract/runtime.js';
import { stateFixture,get } from './fixtures/rewrite-state.js';
import { publishRunStatus } from '../dist-rewrite/ops/status.js';
import { fixture,reasons,source,status,terminal } from './fixtures/rewrite-hooks.js';
describe('Claude session hooks',()=>{
it.each(Object.keys(reasons) as RunStatus[])('projects %s using the verified seven fields and updates idempotently', async state => {
    const f = fixture(), value = status('RunOne', state); f.publish(value);
    expect(await f.invoke('SessionStart')).toEqual({ code: 0, stderr: '', stdout: '' });
    const [entry] = f.entries();
    expect(Object.keys(entry).sort()).toEqual(['id', 'subject', 'description', 'activeForm', 'status', 'blocks', 'blockedBy'].sort());
    expect(entry.id).toMatch(/^flowcrew-[1-9][0-9]*$/);
    expect(entry).toMatchObject({ subject: 'FlowCrew RunOne', blocks: [], blockedBy: [],
      status: terminal.includes(state) ? 'completed' : state === 'pending' ? 'pending' : 'in_progress' });
    expect(entry.description).toContain(`${state}${value.stopReason ? ` (${value.stopReason})` : ''}; stage ${value.focus ?? 'none'}`);
    expect(entry.description).toContain('usage unknown'); expect(entry.description).toContain(value.publishedAt);
    await f.invoke(); expect(f.entries()).toEqual([entry]);
    expect((await f.invoke('--statusline')).stdout).toBe(terminal.includes(state) ? '' : `FlowCrew: RunOne ${state}${value.focus ? `/${value.focus}` : ''}\n`);
    f.publish({ ...status(), currentStage: 'NextStage', focus: 'NextStage', journalCursor: 8, statusSince: 8 });
    await f.invoke(); expect(f.entries()).toHaveLength(1); expect(f.entries()[0].id).toBe(entry.id);
    expect(f.entries()[0].activeForm).toContain('stage NextStage'); expect(f.entries()[0].description).toContain('usage unknown');
  });
it('names the published parked stage in the session entry and statusline', async () => {
    const f = fixture(), publisher = await stateFixture();
    try {
      // The hook reads the publisher's actual file; the journal has already cleared execution.
      Object.assign(publisher.launch,{requester:'claude:session-one'});
      await publisher.admit();
      await publisher.append(publisher.execution,[{type:'invocation_reserved',invocation:{charge:'work',
        address:{kind:'stage',run:'Run',stage:'work',attempt:'Paused',invocation:1}}},
        {type:'stage_settled',stage:'work',state:'pending',evidence:[]},
        {type:'lifecycle',conclusion:{status:'parked',reason:'attempt_failed',detail:'Paused stage'}}]);
      get(publishRunStatus(publisher.location,new Date().toISOString(),0));
      const file=join(publisher.journal.root,'status.json');
      const value=JSON.parse(readFileSync(file,'utf8'));
      expect(value).toMatchObject({currentStage:null,focus:'work'});
      expect(value.stages[0]).toMatchObject({id:'work',state:'pending'});
      const config={storeRoots:[publisher.location.storeRoot],tasksRoot:f.tasksRoot};
      await runHook({session_id:'session-one'},config,'SessionStart');
      expect(f.entries()[0].description).toContain('parked (attempt_failed); stage work');
      expect((await runHook({session_id:'session-one'},config,'--statusline')).stdout).toBe('FlowCrew: Run parked/work\n');
    } finally { await publisher.close(); }
  });
it.each([3,4] as const)('reads v%s stage display through the hook file reader',async version=>{
    const f=fixture(),base=status('RunOne','complete');
    f.publish({...base,version,host:{interpretation:base.host.interpretation},focus:'WorkStage',stages:[{
      id:'WorkStage',purpose:'work',role:'author',after:[],goal:'Goal',instruction:'Instruction',commands:[],revision:'Revision',
      state:version===4?'pending':'needs-correction',attempts:1,lastEnding:'invalid_answer',verdict:null,
      startedAt:'2026-11-18T10:00:00Z',settledAt:'2026-11-18T11:00:00Z',
      segments:[{kind:'attempt',attempt:'Attempt',invocation:1,startedAt:'2026-11-18T10:00:00Z',
        endedAt:'2026-11-18T11:00:00Z',ending:'invalid_answer'}]}]});
    const path=join(f.store,'runs/RunOne/status.json'),before=readFileSync(path,'utf8');
    const snapshot=await observe(f.config,'session-one','SessionStart');
    expect(snapshot.observed[0].status?.stages?.[0]).toMatchObject({id:'WorkStage',state:'needs-correction'});
    expect(f.entries()[0].description).toContain('complete (completed); stage WorkStage');
    expect(readFileSync(path,'utf8')).toBe(before);
  });
it('owns only exact requesters across two sessions and configured stores', async () => {
    const f = fixture();
    for (const [run, requester] of [['Owned', 'claude:session-one'], ['Other', 'claude:session-two'], ['Prefix', 'claude:session-one-extra'],
      ['OtherFrontend', 'codex:session-one'], ['Case', 'Claude:session-one']]) f.publish(status(run, 'running', requester));
    const unowned = { ...status('NoRequester') }; delete unowned.requester; f.publish({...unowned,notification:{...unowned.notification,session:'unbound'}});
    f.publish(status('Owned'), f.secondStore);
    const ignored = join(f.store, 'nested/runs/Hidden'); mkdirSync(ignored, { recursive: true });
    writeFileSync(join(ignored, 'status.json'), JSON.stringify(status('Hidden')));
    await f.invoke(); expect(f.entries().map(e => e.subject)).toEqual(['FlowCrew Owned', 'FlowCrew Owned']);
    expect(new Set(f.entries().map(e => e.id)).size).toBe(2);
    await f.invoke('Stop', { session_id: 'session-two' }); expect(f.entries('session-two').map(e => e.subject)).toEqual(['FlowCrew Other']);
    f.publish(status('Owned', 'running', 'claude:session-two')); await f.invoke(); expect(f.entries()).toHaveLength(1);
    await f.invoke('Stop', { session_id: 'session-two' }); expect(f.entries('session-two')).toHaveLength(2);
  });
it.each(['missing-file', 'missing-directory', 'malformed', 'contradictory', 'wrong-run'])('retains an open entry as unavailable for %s', async problem => {
    const f = fixture(); f.publish(status()); await f.invoke();
    const path = join(f.store, 'runs/RunOne/status.json');
    if (problem === 'missing-file') rmSync(path);
    else if (problem === 'missing-directory') rmSync(join(f.store, 'runs/RunOne'), { recursive: true });
    else writeFileSync(path, problem === 'malformed' ? '{' : JSON.stringify({ ...status('RunOne', 'complete'),
      ...(problem === 'wrong-run' ? { run: 'Wrong' } : { stopReason: null }) }));
    await f.invoke(); expect(f.entries()[0]).toMatchObject({ status: 'in_progress', description: expect.stringContaining('unavailable') });
    expect((await observe(f.config, 'session-one', 'Wake')).kind).toBe('wait');
    expect((await f.invoke('--statusline')).stdout).toBe('FlowCrew: RunOne unavailable\n');
  });
it('keeps a closed entry closed after its source disappears', async () => {
    const f = fixture(); f.publish(status('RunOne', 'complete')); expect((await f.invoke('Wake')).code).toBe(2);
    rmSync(join(f.store, 'runs/RunOne'), { recursive: true });
    expect((await observe(f.config, 'session-one', 'Wake')).kind).toBe('done'); expect(f.entries()[0].status).toBe('completed');
  });
it('projects a newly addressed invalid file as unavailable and cannot infer unknown ownership', async () => {
    const f = fixture(); f.publish({ ...status(), version: 3 } as unknown as RunStatusFile);
    f.publish({ ...status('Other', 'complete', 'claude:session-two'), version: 3 } as unknown as RunStatusFile);
    mkdirSync(join(f.store, 'runs/Unknown'), { recursive: true });
    await f.invoke(); expect(f.entries()).toHaveLength(1); expect(f.entries()[0].description).toContain('unavailable');
  });
it('bounds retained publication proofs across 32 changed updates', async () => {
    const f = fixture(); f.publish(status()); await f.invoke();
    const dir = join(f.tasksRoot, 'session-one'), records = join(dir, '.flowcrew-state');
    const root = join(records, readdirSync(records).find(name => name !== 'ids')!), proofs = join(root, 'created');
    let allocated = 0;
    for (let update = 0; update < 32; update++) {
      f.publish({ ...status(), currentStage: `Stage${update}`, focus: `Stage${update}`, journalCursor: 8 + update, statusSince: 8 + update });
      expect((await f.invoke()).stderr).toBe('');
      const names = readdirSync(proofs); expect(names).toHaveLength(1);
      const task = statSync(join(dir, 'flowcrew-1.json')), proof = statSync(join(proofs, names[0]!));
      expect([proof.dev, proof.ino]).toEqual([task.dev, task.ino]);
      if (update === 0) allocated = proof.blocks;
      expect(proof.blocks).toBe(allocated);
      expect(f.entries()).toHaveLength(1); expect(f.entries()[0].id).toBe('flowcrew-1');
    }
  });
it.each(['initial', 'published'])('preserves ordinary task bytes, dependencies and extension fields after an edited title (%s inode)', async origin => {
    const f = fixture(), dir = join(f.tasksRoot, 'session-one'); mkdirSync(dir, { recursive: true });
    const ordinary = '{"id":"1","subject":"User task","description":"unchanged","activeForm":"","status":"pending","blocks":[],"blockedBy":[]}\n';
    writeFileSync(join(dir, '1.json'), ordinary);
    writeFileSync(join(dir, 'flowcrew-1.json'), ordinary); f.publish(status()); await f.invoke();
    if (origin === 'published') {
      f.publish({ ...status(), currentStage: 'NextStage', focus: 'NextStage', journalCursor: 8, statusSince: 8 }); await f.invoke();
    }
    const owned = f.entries().find(e => e.subject === 'FlowCrew RunOne')!; expect(owned.id).toBe('flowcrew-2');
    writeFileSync(join(dir, `${owned.id}.json`), JSON.stringify({ ...owned, subject: 'User-edited title', blocks: ['1'], blockedBy: ['3'], custom: 1 }));
    f.publish(status('RunOne', 'complete')); await f.invoke();
    expect(readFileSync(join(dir, '1.json'), 'utf8')).toBe(ordinary);
    expect(readFileSync(join(dir, 'flowcrew-1.json'), 'utf8')).toBe(ordinary);
    expect(f.entries().find(e => e.id === owned.id)).toMatchObject({ blocks: ['1'], blockedBy: ['3'], custom: 1, status: 'completed' });
  });

it.each(['replaced', 'unconfirmed', 'invalid', 'wrong-id'])('allocates a new FlowCrew entry for a %s target without touching its bytes', async problem => {
    const f = fixture(); f.publish(status()); await f.invoke();
    const dir = join(f.tasksRoot, 'session-one'), records = join(dir, '.flowcrew-state');
    const runRoot = join(records, readdirSync(records).find(name => name !== 'ids')!);
    const slot = JSON.parse(readFileSync(join(runRoot, 'slot-0'), 'utf8')) as { id: string };
    const taskPath = join(dir, `${slot.id}.json`);
    if (problem === 'unconfirmed') {
      f.publish({ ...status(), currentStage: 'NextStage', focus: 'NextStage', journalCursor: 8, statusSince: 8 }); await f.invoke();
      for (const name of readdirSync(runRoot)) if (name === `created-${slot.id}` || name === 'created') rmSync(join(runRoot, name), { recursive: true });
      // Equal bytes on a different inode do not prove that our link succeeded.
      writeFileSync(`${taskPath}.replacement`, JSON.stringify(f.entries()[0])); renameSync(`${taskPath}.replacement`, taskPath);
    } else if (problem === 'invalid') writeFileSync(taskPath, '{user bytes');
    else if (problem === 'wrong-id') writeFileSync(taskPath, JSON.stringify({ ...f.entries()[0], id: 'user-id' }));
    else {
      // A legacy boolean confirmation is not authority over a replacement inode.
      writeFileSync(join(runRoot, `created-${slot.id}`), 'true\n');
      writeFileSync(`${taskPath}.replacement`, JSON.stringify({ ...f.entries()[0], custom: 42 }));
      renameSync(`${taskPath}.replacement`, taskPath);
    }
    const original = readFileSync(taskPath, 'utf8');
    f.publish(status('RunOne', 'complete')); expect((await f.invoke()).stderr).toBe('');
    expect(readFileSync(taskPath, 'utf8')).toBe(original);
    expect(existsSync(join(dir, 'flowcrew-2.json'))).toBe(true);
    const replacement = JSON.parse(readFileSync(join(dir, 'flowcrew-2.json'), 'utf8'));
    expect(replacement).toMatchObject({ id: 'flowcrew-2', subject: 'FlowCrew RunOne', status: 'completed', blocks: [], blockedBy: [] });
    expect(replacement).not.toHaveProperty('custom');
    f.publish(status('RunOne', 'complete', 'claude:session-two')); await f.invoke();
    expect(readFileSync(taskPath, 'utf8')).toBe(original); expect(existsSync(join(dir, 'flowcrew-2.json'))).toBe(false);
  });

  it.each(['FlowCrew RunOne', 'User replacement'])('preserves a replaced entry titled %s when its requester is withdrawn before another sync', async subject => {
    const f = fixture(); f.publish(status()); await f.invoke();
    const path = join(f.tasksRoot, 'session-one/flowcrew-1.json'), original = JSON.stringify({ ...f.entries()[0], subject, custom: 42 });
    writeFileSync(path + '.replacement', original); renameSync(path + '.replacement', path); f.publish(status('RunOne', 'running', 'claude:session-two')); await f.invoke();
    expect(existsSync(path)).toBe(true); expect(readFileSync(path, 'utf8')).toBe(original);
  });

it('the emitted hook decoder accepts literal status domains and refuses malformed snapshots', async () => {
    const { valid: emittedValid } = await import(source);
    expect(emittedValid({...status(),usage:{...status().usage,state:'partial'}})).toBe(true);
    const pairs = [
      ['pending', null], ['running', null], ['parked', 'backstop'], ['parked', 'attempt_failed'], ['parked', 'recovery_unknown'],
      ['complete', 'completed'], ['accepted_blocked', 'accepted_blocked'], ['incomplete', 'command_missing'],
      ['incomplete', 'command_nonzero'], ['incomplete', 'command_unfinished'], ['incomplete', 'outputs_unpreserved'],
      ['failed', 'gate_irreparable'], ['failed', 'attempt_failed'], ['failed', 'contract_refused'], ['failed', 'isolation_refused'],
      ['escalated', 'recovery_unknown'], ['cancelled', 'cancelled'],
    ] as const;
    for (const [state, reason] of pairs) {
      const value = {...status('RunOne', state), stopReason: reason,
        attention: reason === null ? null : {reason,detail:'Opaque diagnostic',condition:reason === 'backstop' ? 'gate' : null},
        ...(reason === 'backstop' ? {backstop:{...status().backstop,gateSuffix:3,condition:'gate'}} : {})};
      expect(emittedValid(value), state + '/' + reason).toBe(true);
    }
    for (const patch of [{version:3},{status:'unknown'},{stopReason:'unknown'},
      {status:'complete',stopReason:null},{requester:42},{journalCursor:-1},{statusSince:8},
      {backstop:null},
      {gates:[{stage:'Gate',attempt:'Attempt',scope:'progress',outcome:'accepted',result:'label',
        answer:{path:'evidence/a',sha256:'a'.repeat(64)},cursor:7}]}])
      expect(emittedValid({...status(),...patch}),JSON.stringify(patch)).toBe(false);
    expect(emittedValid({...status(),requester:'opaque identity with spaces'})).toBe(true);
    for (const key of Object.keys(status()).filter(key => key !== 'requester')) {
      const value: Record<string,unknown> = {...status()}; delete value[key]; expect(emittedValid(value),key).toBe(false);
    }
  });
it.each([...terminal, 'parked', 'escalated'] as RunStatus[])('reports %s once per statusSince using immutable wake claims', async state => {
    const f = fixture(); f.publish(status('Attention', state));
    const first = await f.invoke('Wake'); expect(first.code).toBe(2); expect(first.stderr).toContain(`Attention: ${state}`);
    f.publish({ ...status('Attention', state), journalCursor: 8, publishedAt: '2021-01-01T00:00:00Z' });
    const repeated = await observe(f.config, 'session-one', 'Wake');
    expect(repeated.kind).toBe(terminal.includes(state) ? 'done' : 'wait'); expect(repeated.reports).toHaveLength(0);
    f.publish({ ...status('Attention', state), journalCursor: 9, statusSince: 9 });
    expect((await f.invoke('Wake')).code).toBe(2);
    const dir = join(f.tasksRoot, 'session-one');
    expect(readdirSync(join(dir, '.flowcrew-wakes'))).toHaveLength(2);
    expect(readdirSync(join(dir, '.flowcrew-state')).filter(name => name !== 'ids')).toHaveLength(1);
    expect(readdirSync(dir)).not.toContain('.flowcrew-lock');
  });
type Frame = RunStatus | 'invalid' | 'missing';
const sequences: { name: string; frames: Frame[]; expected: string[] }[] = [
    { name: 'parked reported resumed terminal', frames: ['parked', 'parked', 'running', 'complete', 'complete'], expected: ['report', 'wait', 'wait', 'report', 'done'] },
    { name: 'invalid and missing recover', frames: ['running', 'invalid', 'missing', 'parked', 'parked', 'running', 'failed'], expected: ['wait', 'wait', 'wait', 'report', 'wait', 'wait', 'report'] },
    { name: 'new parked transition after resume', frames: ['parked', 'running', 'parked', 'parked'], expected: ['report', 'wait', 'report', 'wait'] },
    { name: 'pending then terminal', frames: ['pending', 'running', 'accepted_blocked', 'accepted_blocked'], expected: ['wait', 'wait', 'report', 'done'] },
  ];
it.each(sequences)('pure Wake sequence: $name', ({ frames, expected }) => {
    let runs = { key: { storeRoot: '/private', run: 'RunOne', id: 'flowcrew-1', created: true, closed: false, reported: '' } };
    let since = 0, previous: Frame | undefined;
    const actual = frames.map((frame, cursor) => {
      if (frame !== previous) since = cursor; previous = frame;
      const snapshot = frame === 'invalid' || frame === 'missing' ? undefined : { ...status('RunOne', frame), journalCursor: cursor, statusSince: since };
      const observation = { key: 'key', run: 'RunOne', status: snapshot, closed: false };
      const before = structuredClone(runs), result = decideWake([observation], runs);
      expect(runs).toEqual(before); // decideWake leaves its input untouched.
      runs = result.runs as typeof runs;
      return result.kind;
    });
    expect(actual).toEqual(expected);
    expect(decideWake([], runs).kind).toBe('done');
  });
it('keeps waiting for any mutable owned run among already reported terminal runs', () => {
    const ended = { key: 'ended', run: 'Ended', status: status('Ended', 'complete'), closed: true };
    const open = { key: 'open', run: 'Open', status: status('Open', 'parked'), closed: false };
    const runs = Object.fromEntries([ended, open].map(item => [item.key, { storeRoot: '/private', run: item.run, id: item.key, created: true, closed: item.closed,
      reported: decideWake([item], {}).runs[item.key].reported }]));
    expect(decideWake([ended, open], runs).kind).toBe('wait');
    expect(decideWake([ended], runs).kind).toBe('done');
  });
it('async observation recovers invalid and missing files then reports owned completion', async () => {
    const f = fixture(); f.publish(status()); f.publish(status('Other', 'complete', 'claude:session-two'));
    const actions = [
      () => writeFileSync(join(f.store, 'runs/RunOne/status.json'), '{'),
      () => { expect(f.entries()[0].description).toContain('unavailable'); rmSync(join(f.store, 'runs/RunOne/status.json')); },
      () => { expect(f.entries()[0].description).toContain('unavailable'); f.publish(status('RunOne', 'complete')); },
    ];
    let pauses = 0;
    const result = await waitForWake(f.config, 'session-one', async () => { const action = actions[pauses++]; expect(action, `unexpected wait after recovery at pause ${pauses}`).toBeDefined(); action(); });
    expect(pauses).toBe(3); expect(result.code).toBe(2); expect(result.stderr).toContain('RunOne: complete'); expect(result.stderr).not.toContain('Other');
  });
it('waits after a reported park and escalation until a resumed run terminates', async () => {
    for (const parked of ['parked', 'escalated'] as const) {
      const f = fixture(); f.publish(status('RunOne', parked)); expect((await f.invoke('Wake')).code).toBe(2);
      let pauses = 0;
      const result = await waitForWake(f.config, 'session-one', async () => {
        pauses++;
        expect(pauses).toBeLessThanOrEqual(2);
        f.publish({ ...status('RunOne', pauses === 1 ? 'running' : 'complete'), journalCursor: 7 + pauses, statusSince: 7 + pauses });
      });
      expect(pauses).toBe(2); expect(result.code).toBe(2); expect(result.stderr).toContain('RunOne: complete');
    }
  });
it('bundles only builtins and the read-only native identity adapter, without evaluated code', () => {
    const code = readFileSync(source, 'utf8'), tree = ts.createSourceFile(source, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports: string[] = [], forbidden: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'node:child_process')
        expect(node.importClause?.namedBindings?.getText(tree)).toBe('{ execFile }');
      if ((ts.isCallExpression(node) && ['eval', 'Function', 'require', 'import'].includes(node.expression.getText(tree)))
        || (ts.isNewExpression(node) && node.expression.getText(tree) === 'Function')) forbidden.push(node.getText(tree));
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(imports.every(name => name.startsWith('node:'))).toBe(true); expect(forbidden).toEqual([]);
  });
it('rejects missing identity and nonexplicit configuration without waking', async () => {
    const f = fixture(); expect((await f.invoke('Wake')).code).toBe(0);
    for (const payload of [{}, { thread_id: 'session-one' }, { session_id: '../escape' }, null])
      expect((await f.invoke('Wake', payload)).stderr).toContain('Invalid Claude session_id');
    for (const config of [undefined, {}, { storeRoots: [], tasksRoot: f.tasksRoot }, { storeRoots: ['relative'], tasksRoot: f.tasksRoot },
      { storeRoots: [f.store], tasksRoot: 'relative' }, { ...f.config, storeRoots: [f.store, f.store] }, { ...f.config, cli: 'removed' }])
      expect((await runHook({ session_id: 'session-one' }, config, 'Wake')).stderr).toContain('hook config');
  });
it('ignores an unconfigured store under redirected HOME', async () => {
    const f = fixture(); vi.stubEnv('HOME', join(f.root, 'home'));
    f.publish(status('Implicit'), join(process.env.HOME!, '.fc')); expect((await f.invoke('--statusline')).stdout).toBe('');
  });
});

it('historical sandbox fields confer no current authority or statusline disclosure', async () => {
  const f = fixture();
  f.publish({ ...status(), unconfinedCommands: ['Outside', 'Windows'] });
  expect((await f.invoke('--statusline')).stdout).not.toContain('unconfined');
  expect(f.entries()[0].description).not.toContain('unconfined');
  f.publish({ ...status('RunOne', 'complete'), unconfinedCommands: ['Outside', 'Windows'] });
  const report = await f.invoke('Wake');
  expect(report.code).toBe(2);
  expect(report.stderr).not.toContain('unconfined');
});


it('running command inactivity wakes once across hook restarts, clears on progress, and does not close the task', async () => {
  const f = fixture();
  const value = { ...status(), journalCursor: 8, commandActivity: [{ command: 'Wait', stage: 'WorkStage', state: 'quiet' as const,
    notice: { cursor: 8, message: 'no observed progress for 10 min' as const } }] };
  f.publish(value);
  const first = await f.invoke('Wake');
  expect(first.code).toBe(2); expect(first.stderr).toContain('command Wait; stage WorkStage: no observed progress for 10 min');
  expect(f.entries()[0].status).toBe('in_progress');
  expect((await observe(f.config, 'session-one', 'Wake')).kind).toBe('wait');
  f.publish({ ...value, journalCursor: 9, commandActivity: [{ ...value.commandActivity[0], state: 'progress' }] });
  expect((await observe(f.config, 'session-one', 'Wake')).kind).toBe('wait');
  expect(f.entries()[0].description).not.toContain('no observed progress');
  f.publish({ ...value, journalCursor: 10 });
  expect((await observe(f.config, 'session-one', 'Wake')).reports).toHaveLength(0);
  f.publish({ ...status('RunOne', 'complete'), journalCursor: 11, statusSince: 11 });
  expect((await f.invoke('Wake')).code).toBe(2);
});


// A command past its declared limit is the run's attention while it keeps running: the hook wakes the session once per episode, and the
// episode is the journal cursor of the fact, so a second limit of a command that reads the same is a new wake.
it('a running command past its limit wakes once with its attention, again for a new episode, and clears when the command ends', async () => {
  const f = fixture();
  const limit = (cursor: number) => ({ reason: 'command_limit' as const, cursor, condition: null, detail: 'command Wait passed its time limit (600000 ms) and is still running; leave it to finish, or flowcrew cancel RunOne' });
  const value = { ...status(), journalCursor: 8, attention: limit(8) };
  f.publish(value);
  // `observe` answers at once; the blocking `invoke` would wait for a report that a reader ignoring the limit never makes.
  const first = await observe(f.config, 'session-one', 'Wake');
  expect(first.kind).toBe('report'); expect(first.reports).toHaveLength(1);
  expect(f.entries()[0].description).toContain('command Wait passed its time limit');
  expect(f.entries()[0].status).toBe('in_progress');
  expect((await observe(f.config, 'session-one', 'Wake')).kind).toBe('wait');
  f.publish({ ...value, journalCursor: 9, attention: null });
  expect((await observe(f.config, 'session-one', 'Wake')).reports).toHaveLength(0);
  f.publish({ ...value, journalCursor: 12, attention: limit(12) });
  expect((await observe(f.config, 'session-one', 'Wake')).reports).toHaveLength(1);
});

it('non-limit attention keeps its pre-upgrade transition identity and ignores additive cursor', () => {
  const value = { ...status('RunOne', 'parked'), attention: { reason: 'attempt_failed' as const, detail: 'Review needed', condition: null } };
  const first = { key: 'run', run: 'RunOne', closed: true, status: value };
  const oldIdentity = [[value.attention.reason, value.attention.detail, value.attention.condition, []], null];
  const oldTransition = JSON.stringify(['run', 'parked', value.statusSince, oldIdentity]);
  const recorded = decideWake([first], {});
  expect(recorded.runs.run.reported).toBe(oldTransition);
  expect(decideWake([{ ...first, status: { ...value, attention: { ...value.attention, cursor: 99 } } }], recorded.runs).reports).toHaveLength(0);
});

it('clearing quiet metadata after cancellation does not replay the notice or terminal report', async () => {
  const f = fixture();
  const activity = [{ command: 'Wait', stage: 'WorkStage', state: 'quiet' as const,
    notice: { cursor: 8, message: 'no observed progress for 10 min' as const } }];
  f.publish({ ...status(), journalCursor: 8, commandActivity: activity });
  expect((await f.invoke('Wake')).stderr).toContain('no observed progress for 10 min');
  const cancelled = { ...status('RunOne', 'cancelled'), journalCursor: 9, statusSince: 9, commandActivity: activity };
  f.publish(cancelled);
  const result = await f.invoke('Wake');
  expect(result.code).toBe(2); expect(result.stderr).not.toContain('no observed progress for 10 min');
  f.publish({ ...cancelled, journalCursor: 10, commandActivity: [] });
  expect((await observe(f.config, 'session-one', 'Wake')).kind).toBe('done');
});


it('uses the published readable planning label in statusline and task details, with additive stages accepted',async()=>{
  const f=fixture(),value=status();
  f.publish({...value,currentStage:'r_generated',focus:'r_generated',step:{...value.step,stageLabel:'plan (planner-role)'},stages:[]});
  expect((await f.invoke('--statusline')).stdout).toContain('/plan (planner-role)');
  expect((await f.invoke('--statusline')).stdout).not.toContain('r_generated');
  expect(f.entries()[0].description).toContain('stage plan (planner-role)');
  f.publish({...value,focus:null,step:{...value.step,stageLabel:'plan (planner-role)'}});
  expect((await f.invoke('--statusline')).stdout).not.toContain('/plan (planner-role)');
  expect(f.entries()[0].description).toContain('stage none');
});

it('accepts optional dashboard facts and the same historical file without them',async()=>{
  const f=fixture(),base=status();
  for(const extra of [{startedAt:'2026-11-18T10:00:00Z',lastActivityAt:'2026-11-18T11:00:00Z',stages:[{
    id:'WorkStage',purpose:'work',role:'author',after:[],goal:'Goal',instruction:'Instruction',commands:[],revision:'Revision',
    state:'running',attempts:1,lastEnding:null,verdict:null,startedAt:'2026-11-18T10:00:00Z',settledAt:null,
    summary:'Exact summary',segments:[{kind:'attempt',attempt:'Attempt',invocation:1,startedAt:'2026-11-18T10:00:00Z',endedAt:null}]}]},{}] as Partial<RunStatusFile>[]) {
    f.publish({...base,...extra});expect((await f.invoke('--statusline')).stdout).toContain('FlowCrew: RunOne running');
  }
});

it('delivers attention detail and each new obligation once without timestamp wakes', async () => {
  const f = fixture();
  const initial = status('RunOne', 'cancelled');
  f.publish(initial); expect((await f.invoke('Wake')).code).toBe(2);
  const owner = { pid: 42, start: 'birth', boot: 'boot', group: 42, authority: 'same-obligation', checkedAt: '2026-11-18T01:00:00Z' };
  const members = [{pid:10,state:'unknown',parent:null},{pid:11,state:'unknown',parent:10}];
  const attention = { reason: 'closure_unconfirmed' as const, condition: null,
    detail: 'Exact closure refusal; diagnostic git/objects/123',
    obligations: [{ kind: 'closure-unconfirmed' as const, detail: 'Group still unresolved', members, owner }] };
  const changed = { ...initial, attention };
  f.publish(changed);
  const next = await f.invoke('Wake');
  expect(next.code).toBe(2); expect(next.stderr).toContain(attention.detail);
  expect(f.entries()[0].description).toContain(attention.detail);
  expect((await f.invoke('Wake')).code).toBe(0);
  f.publish({ ...changed, publishedAt: '2026-11-18T00:00:00Z', journalCursor: changed.journalCursor + 1 });
  expect((await f.invoke('Wake')).code).toBe(0);
  const reordered = { ...changed, attention: { obligations: [{ owner: { checkedAt:'2026-11-18T02:00:00Z',authority:owner.authority,group:42,boot:'boot',start:'birth',pid:42 },
    members:[{parent:10,state:'unknown',pid:11},{parent:null,state:'unknown',pid:10}],detail:'Group still unresolved',kind:'closure-unconfirmed' as const }],
    condition:null,detail:attention.detail,reason:attention.reason } };
  f.publish(reordered); expect((await f.invoke('Wake')).code).toBe(0);
  f.publish({ ...changed, attention: { ...attention, obligations:[{...attention.obligations[0],owner:{...owner,authority:'new-obligation'}}] } });
  expect((await f.invoke('Wake')).code).toBe(2); expect((await f.invoke('Wake')).code).toBe(0);
  f.publish({ ...changed, attention: { ...attention, detail: 'Second obligation; diagnostic git/objects/456' } });
  expect((await f.invoke('Wake')).code).toBe(2);
  expect((await f.invoke('Wake')).code).toBe(0);
});


it('status-only wake-key withdrawal loses the second actionable obligation', async () => {
  const f = fixture(), code = readFileSync(source, 'utf8');
  const boundary = 'status.statusSince, actionIdentity(status),';
  expect(code.split(boundary)).toHaveLength(2);
  const path = join(f.root, 'status-only.mjs');
  writeFileSync(path, code.replace(boundary, 'status.statusSince,'));
  const mutant = await import(pathToFileURL(path).href);
  const first = { key: 'run', run: 'RunOne', closed: true, status: status('RunOne', 'cancelled') };
  const second = { ...first, status: { ...first.status, attention: { reason: 'closure_unconfirmed', condition: null,
    detail: 'New actionable closure obligation; diagnostic git/objects/123' } } };
  const result = mutant.decideWake([first], {});
  expect(result.kind).toBe('report');
  expect(mutant.decideWake([second], result.runs).kind).toBe('done');
  const positive = decideWake([first], {});
  expect(decideWake([second as typeof first], positive.runs).kind).toBe('report');
});

it('attention changes during a quiet episode change the wake identity', async () => {
  const f=fixture();
  const value={...status(),journalCursor:8,commandActivity:[{command:'Wait',stage:'WorkStage',state:'quiet' as const,
    notice:{cursor:8,message:'no observed progress for 10 min' as const}}]};
  f.publish(value); expect((await observe(f.config,'session-one','Wake')).reports).toHaveLength(1);
  const attention={reason:'closure_unconfirmed' as const,condition:null,detail:'Child closure unresolved',
    obligations:[{kind:'closure-unconfirmed' as const,detail:'Child closure unresolved',members:[]}]};
  f.publish({...value,journalCursor:9,attention});
  expect((await observe(f.config,'session-one','Wake')).reports).toHaveLength(1);
  expect((await observe(f.config,'session-one','Wake')).reports).toHaveLength(0);
  f.publish({...value,journalCursor:10,attention:{...attention,detail:'New recovery evidence'}});
  expect((await observe(f.config,'session-one','Wake')).reports).toHaveLength(1);
});

it('author quiet episodes wake once and share live tool facts with task details',async()=>{
  const f=fixture(),base=status(),invocation={charge:'work' as const,address:{kind:'stage' as const,run:base.run,stage:'WorkStage',attempt:'Attempt',invocation:1}};
  const activity={invocation,source:'author' as const,stage:'WorkStage',state:'current' as const,lastEventAt:'2001-01-01T00:00:00Z',
    lastTool:'Bash',summary:'npm test',toolRunning:true,observation:'quiet' as const,notice:{cursor:8,message:'no observed progress for 10 min' as const}};
  const owner={...await (await import('../rewrite-src/host/identity.mjs')).identity(),authority:'test-controller'};
  const value={...base,version:4 as const,host:{interpretation:[],boot:owner.boot,activation:{state:'active' as const,owner,checkedAt:null}},journalCursor:8,activity:[activity],attention:null};
  f.publish(value);
  expect((await f.invoke('Wake')).stderr).toContain('author Bash; stage WorkStage: no observed progress for 10 min');
  expect(f.entries()[0].description).toContain('author Bash: npm test; last progress 2001-01-01T00:00:00Z');
  expect((await observe(f.config,'session-one','Wake')).kind).toBe('wait');
  f.publish({...value,journalCursor:9,attention:null,activity:[{...activity,observation:'progress',notice:undefined}]});
  expect((await observe(f.config,'session-one','Wake')).kind).toBe('wait');
  f.publish({...value,journalCursor:10,activity:[{...activity,notice:{...activity.notice,cursor:10}}]});
  expect((await observe(f.config,'session-one','Wake')).reports).toHaveLength(1);
});
