import { expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateFixture, get } from '../fixtures/rewrite-state.js';
import { identifyCommand, runDeclaredCommand } from '../../dist-rewrite/exec/command.js';
import { recorderFactory } from '../../dist-rewrite/ops/main.js';
import { readEvents, reserveCommand } from '../../dist-rewrite/records/state.js';

const gate = vi.hoisted(() => ({ beforeLimit: undefined as undefined | (() => Promise<void>),
  afterOperation: undefined as undefined | ((result: { ok: boolean; kind?: string }) => void) }));
vi.mock('../../dist-rewrite/records/state.js', async original => {
  const state = await original<typeof import('../../dist-rewrite/records/state.js')>();
  return { ...state, recordOperation: async <T>(...args: Parameters<typeof state.recordOperation<T>>) => {
    const result = await state.recordOperation<T>(...args);
    gate.afterOperation?.(result);
    return result;
  }, appendEvents: async (...args: Parameters<typeof state.appendEvents>) => {
    if (args[2][0]?.type === 'command_limit') await gate.beforeLimit?.();
    return state.appendEvents(...args);
  } };
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function prepare(body: string, durationMs?: number) {
  const command = { id: 'Check', argv: [process.execPath, '-e', body], env: {}, inputs: [], required: true,
    ...(durationMs === undefined ? {} : { durationMs }) };
  const f = await stateFixture({ commands: [command] });
  await f.admit();
  const key = get(await identifyCommand(command, f.scope));
  const reservation = get(await reserveCommand(f.execution, (await f.projection()).cursor, command.id, key,
    { charge: 'command', address: { kind: 'stage', run: 'Run', stage: 'work', attempt: 'Attempt', invocation: 1 } }));
  const ports = recorderFactory()(f.execution);
  await mkdir(ports.scratch, { recursive: true });
  const abort = new AbortController();
  return { f, command, key, reservation, ports, abort,
    run: (againstBase = false) => runDeclaredCommand({ command, key, reservation, againstBase },
      { scope: f.scope, writer: f.execution, process: ports, abort: abort.signal }) };
}

it('a command ending while its limit append is held commits all invocation records in order', async () => {
  const t = await prepare("const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(process.env.TMPDIR+'/end'))clearInterval(timer)},10)", 500);
  const held = deferred(), ending = deferred(), entered = deferred();
  gate.beforeLimit = async () => { entered.resolve(); await writeFile(join(t.key.execution!.scratch, 'end'), 'end'); await held.promise; };
  const record = t.ports.recordProcess;
  t.ports.recordProcess = payload => { if (payload.type === 'process') ending.resolve(); return record(payload); };
  const running = t.run();
  try {
    await Promise.race([entered.promise, running.then(result => { throw Error(JSON.stringify(result)); })]);
    await Promise.race([ending.promise, running.then(result => { throw Error(JSON.stringify(result)); })]);
    held.resolve();
    expect(await running).toMatchObject({ ok: true, value: { execution: { state: 'complete', exit: 0 } } });
    const types = get(await readEvents(t.f.journal, 0)).map(event => event.payload.type);
    expect(types.filter(type => type === 'command_limit')).toHaveLength(1);
    expect(types.indexOf('command_limit')).toBeLessThan(types.indexOf('process'));
    expect(types.at(-1)).toBe('command');
  } finally { gate.beforeLimit = undefined; held.resolve(); t.abort.abort(); await running; await t.f.close(); }
});

it('a base-run limit record failure fails the run without committing the main receipt', async () => {
  const t = await prepare("if(process.cwd().endsWith('_base.tree'))setTimeout(()=>process.exit(1),8000);else process.exit(1)", 5000);
  let limits = 0;
  const record = t.ports.recordProcess;
  t.ports.recordProcess = payload => payload.type === 'command_limit'
    ? (limits++, Promise.resolve({ ok: false, kind: 'unavailable', detail: 'base limit journal refused' })) : record(payload);
  try {
    expect(await t.run(true)).toMatchObject({ ok: false, kind: 'unknown', detail: expect.stringContaining('base limit journal refused') });
    expect(limits).toBe(1);
    expect((await t.f.projection()).commands).toHaveLength(0);
    expect(get(await readEvents(t.f.journal, 0)).filter(event => event.payload.type === 'process')).toHaveLength(2);
  } finally { t.abort.abort(); await t.f.close(); }
});

it('main and base limits share exactly one journal fact for their reservation', async () => {
  const t = await prepare('setTimeout(()=>process.exit(1),1200)', 500);
  try {
    expect(await t.run(true)).toMatchObject({ ok: true, value: { base: { ok: true, execution: { state: 'complete', exit: 1 } } } });
    expect(get(await readEvents(t.f.journal, 0)).filter(event => event.payload.type === 'command_limit')).toHaveLength(1);
  } finally { t.abort.abort(); await t.f.close(); }
});

it('a real record-operation conflict during after-capture stays run-level with no command receipt', async () => {
  const t = await prepare('process.exit(0)');
  let conflicts = 0;
  // Release the actual SQL claim after the native operation refuses it. A mutant that turns this capture failure into a
  // command result can then commit, so this test cannot pass merely because the same claim blocks receipt construction too.
  gate.afterOperation = result => {
    if (!result.ok && result.kind === 'conflict') {
      conflicts++;
      const db = new DatabaseSync(t.f.database);
      try { db.prepare('DELETE FROM resources WHERE id=?').run('record:held'); } finally { db.close(); }
    }
  };
  const record = t.ports.recordProcess;
  t.ports.recordProcess = async payload => {
    const result = await record(payload);
    if (payload.type === 'owner_closed') {
      const db = new DatabaseSync(t.f.database);
      try { db.prepare('INSERT INTO resources VALUES(?,?,?,?,?,?,?,?)').run('record:held', t.f.journal.root, t.f.journal.root,
        'exclusive-write', null, JSON.stringify(t.f.owner), null, 'HeldEpoch'); } finally { db.close(); }
    }
    return result;
  };
  try {
    expect(await t.run()).toEqual({ ok: false, kind: 'conflict', detail: 'Record construction or maintenance remains unresolved' });
    expect(conflicts).toBe(1);
    expect((await t.f.projection()).commands).toHaveLength(0);
  } finally {
    gate.afterOperation = undefined;
    const db = new DatabaseSync(t.f.database);
    try { db.prepare('DELETE FROM resources WHERE id=?').run('record:held'); } finally { db.close(); }
    t.abort.abort(); await t.f.close();
  }
});
