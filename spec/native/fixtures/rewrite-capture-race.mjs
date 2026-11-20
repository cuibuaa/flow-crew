import { createRequire, syncBuiltinESMExports } from 'node:module';
import { writeFileSync, utimesSync, statSync } from 'node:fs';
import { hashInputs } from "../../../dist-rewrite/records/content.js";
const cp = createRequire(import.meta.url)('node:child_process');
export async function captureRace(scope, input) {
  const spawn = cp.spawn, before = statSync(input);
  let injected = false;
  cp.spawn = (file, args, options) => {
    const index = args.findIndex(arg => typeof arg === 'string' && arg.includes('def capture(root):'));
    if (index < 0)
      return spawn(file, args, options);
    const modified = [...args], needle = "    tree=git(b'write-tree').strip().decode()";
    if (!modified[index].includes(needle))
      throw Error('Capture injection seam missing');
    modified[index] = modified[index].replace(needle, needle + "\n    os.write(2,b'RACY_READY\\n');os.read(3,1)");
    const child = spawn(file, modified, { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', bytes => {
      if (bytes.toString().includes('RACY_READY')) {
        injected = true;
        writeFileSync(input, 'bbbb');
        utimesSync(input, before.atime, before.mtime);
        child.stdio[3].end('x');
      }
    });
    return child;
  };
  syncBuiltinESMExports();
  try {
    return { ok: true, value: { result: await hashInputs(scope), injected } };
  }
  finally {
    cp.spawn = spawn;
    syncBuiltinESMExports();
  }
}
