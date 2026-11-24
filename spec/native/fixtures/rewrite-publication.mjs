import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
export async function publish(journal, cut = '', kill = false) {
  const paths = [], native = fs.open;
  fs.open = async (...args) => { const file = await native(...args), sync = file.sync.bind(file); file.sync = async () => { await sync();
   const path = String(args[0]); paths.push(path); if (cut && path.endsWith(cut)) {
    if (kill)
      process.kill(process.pid, 'SIGKILL');
    throw Error('Injected durability failure');
  } }; return file; };
  syncBuiltinESMExports();
  try {
    const { putEvidence } = await import("../../../dist-rewrite/records/evidence.js");
    const result = await putEvidence(journal, Buffer.from('durable-publication'));
    return { ok: true, value: { result, paths } };
  }
  finally {
    fs.open = native;
    syncBuiltinESMExports();
  }
}
