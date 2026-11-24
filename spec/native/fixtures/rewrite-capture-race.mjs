import { createRequire, syncBuiltinESMExports } from 'node:module';
import { writeFileSync, utimesSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { captureTree, hashInputs } from '../../../dist-rewrite/records/content.js';
import { runDeclaredCommand } from '../../../dist-rewrite/exec/command.js';
import { recorderFactory } from '../../../dist-rewrite/ops/main.js';
const cp = createRequire(import.meta.url)('node:child_process');

// The Python observer waits after write-tree and before validating stamps. The writer
// lives in its parent operation, outside the declared command's containment.
async function captureWrite(run, write, when, ready = () => true) {
  const spawn = cp.spawn;
  let injected = false, gitFailure;
  const change = () => { write(); injected = true; };
  cp.spawn = (file, args, options) => {
    const index = args.findIndex(arg => typeof arg === 'string' && arg.includes('def capture(root):'));
    if (index < 0 || !ready()) return spawn(file, args, options);
    if (when === 'before') { change(); return spawn(file, args, options); }
    const modified = [...args];
    if (when === 'git-change' || when === 'git-stable') {
      // The real update-index sees the changed file kind, or an unusable private
      // index with unchanged content. Retain its actual exit and stderr as evidence.
      const needle = '    r=subprocess.run(', failure = '    if r.returncode: raise';
      if (!modified[index].includes(needle) || !modified[index].includes(failure)) throw Error('Git injection seam missing');
      modified[index] = modified[index].replace(needle,
        "    if args[0]==b'update-index':\n        os.write(3,b'RACY_READY\\n');os.read(3,1)\n" +
        (when === 'git-stable' ? "        env[b'GIT_INDEX_FILE']=repo+b'/missing-parent/index'\n" : '') + needle)
        .replace(failure, "    if args[0]==b'update-index' and r.returncode:\n" +
          "        os.write(3,b'RACY_FAILED '+json.dumps({'exit':r.returncode,'stderr':r.stderr.decode('utf8','replace')}).encode()+b'\\n')\n" + failure);
    } else {
      const needle = "        tree=git(b'write-tree').strip().decode()";
      if (!modified[index].includes(needle)) throw Error('Capture injection seam missing');
      modified[index] = modified[index].replace(needle, needle + "\n        os.write(3,b'RACY_READY\\n');os.read(3,1)");
    }
    const child = spawn(file, modified, { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    createInterface({ input: child.stdio[3] }).on('line', line => {
      if (line === 'RACY_READY') { change(); child.stdio[3].end('x'); }
      if (line.startsWith('RACY_FAILED ')) gitFailure = JSON.parse(line.slice('RACY_FAILED '.length));
    });
    return child;
  };
  syncBuiltinESMExports();
  try { return { ok: true, value: { result: await run(), injected, gitFailure } }; }
  finally { cp.spawn = spawn; syncBuiltinESMExports(); }
}
export function captureGitFailure(scope, input, change) {
  return captureWrite(() => captureTree(scope), () => {
    if (change === 'replace') { unlinkSync(input); mkdirSync(input); }
    if (change === 'appear') writeFileSync(input, 'appeared during capture');
  }, change === 'replace' ? 'git-change' : 'git-stable');
}
export function captureRace(scope, input) {
  const before = statSync(input);
  return captureWrite(() => hashInputs(scope), () => {
    writeFileSync(input, 'bbbb'); utimesSync(input, before.atime, before.mtime);
  }, 'during');
}
export function commandCaptureRace(request, scope, writer, input, when) {
  const ports = recorderFactory()(writer), record = ports.recordProcess;
  let ended = false;
  ports.recordProcess = async payload => {
    const result = await record(payload);
    if (result.ok && payload.type === 'process') ended = true;
    return result;
  };
  return captureWrite(() => runDeclaredCommand(request, { scope, writer,
    process: ports, abort: new AbortController().signal }), () => writeFileSync(input, 'changed outside the command'), when, () => ended);
}
