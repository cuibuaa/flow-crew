import * as host from '../../../dist-rewrite/host/process.js';
import * as state from '../../../dist-rewrite/records/state.js';
import { readEvidence } from '../../../dist-rewrite/records/evidence.js';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
const known = r => { if (!r.ok)
  throw Error(JSON.stringify(r)); return r.value; };
// A file's existence is the readiness signal; publish complete JSON atomically.
async function publish(path, value) {
  await writeFile(path + '.tmp', JSON.stringify(value));
  await rename(path + '.tmp', path);
}
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const journal = known(await state.openJournal(config.location, 'read'));
const held = config.mode === 'launcher' ? null : known(await state.claim(join(journal.root,
 config.mode === 'launcher' ? 'launch-control' : 'execution'), config.run, { database: journal.database, holder: journal.root }));
const writer = config.mode === 'launcher' ? config.writer : known(await state.openWriter(journal, held, 'execution'));
const recordProcess = async (payload) => state.appendEvents(writer, known(await state.readEvents(journal, 0)).at(-1)?.seq ?? 0, [payload]);
const ports = { scratch: config.scratch, streamRoot: journal.root, recordProcess,
  putEvidence: bytes => state.putEvidence(journal, bytes), storeEvidence: source => state.storeEvidence(journal, source),
   readEvidence: ref => readEvidence(journal, ref),
  operation: request => state.recordOperation(journal, 'construct', request),
  recordController: owner => recordProcess({ type: 'run_observed', observation: { unit: config.run, state: 'active', owner, evidence: [],
   detail: 'controller helper births' } }) };
if (config.mode === 'launcher') {
  const context = { database: journal.database, storeRoot: config.location.storeRoot, environment: {}, pending: async () => ({ ok: true,
   value: [] }), observation: async () => ({ ok: true, value: null }) };
  const result = await host.startRun(config.run, config.entry, ports, context);
  await publish(config.marker, result);
}
else {
  const code = ("const fs=require('fs');process.stdout.write('partial-stdout\\n');" +
    "process.stderr.write('partial-stderr\\n');fs.writeFileSync(process.argv[1],'started');" +
    "const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);" +
    "process.stdout.write('complete\\n');process.exitCode=7}},10)");
  const receipt = await host.launchInvocation({ writableRoots: [config.work], protectedRoots: [config.records] }, {
   argv: [process.execPath, '-e', code, config.marker, config.release], env: { PATH: process.env.PATH, HOME: config.home }, cwd: config.work,
   writableRoots: [config.work] }, ports, new AbortController().signal);
  await publish(config.result, receipt);
}
if (held)
  known(await state.release(held, 'retire'));
await host.closeController();
