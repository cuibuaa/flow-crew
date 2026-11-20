// Step-0 same-physical-work baseline. No provider, manager, network or workload command.
// Each invocation owns a temporary physical project shared by its measurement arms.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';

const work = fs.mkdtempSync(join(tmpdir(), 'flowcrew-content-physical-'));
try {
const logs = process.argv[2] ?? fs.mkdtempSync(join(tmpdir(), 'flowcrew-content-evidence-'));
assert.ok(logs && resolve(logs) === logs, 'absolute evidence directory required');
fs.mkdirSync(logs, { recursive: true });
for (const name of ['physical-workload.json', 'baseline-cost.json', 'physical-restored.json']) {
  assert.equal(fs.existsSync(join(logs, name)), false, 'use a new evidence directory; never overwrite a previous measurement');
}
const project = join(work, 'project');
const dependencies = join(project, 'dependencies');
const large = join(project, 'large.bin');
{
  fs.mkdirSync(dependencies, { recursive: true });
  const chunk = Buffer.alloc(4 * 1024 * 1024, 0x5a);
  const fd = fs.openSync(large, 'wx', 0o640);
  for (let n = 0; n < 768; n++) fs.writeSync(fd, chunk);
  fs.fsyncSync(fd); fs.closeSync(fd);
  for (let n = 0; n < 42296; n++) fs.writeFileSync(join(dependencies, String(n).padStart(5, '0') + '.txt'), 'dependency ' + n + '\n', { flag: 'wx', mode: 0o640 });
  fs.chmodSync(project, 0o750); fs.chmodSync(dependencies, 0o750);
}
function inventory() {
  const hash = createHash('sha256'); let files = 0, bytes = 0, allocatedBytes = 0;
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory).sort()) {
      const path = join(directory, entry), stat = fs.lstatSync(path);
      const relative = path.slice(project.length + 1);
      if (stat.isDirectory()) { hash.update(JSON.stringify([relative, 'directory', stat.mode & 0o7777])); visit(path); }
      else {
        const content = createHash('sha256'); const fd = fs.openSync(path, 'r'); const buffer = Buffer.alloc(4 * 1024 * 1024);
        for (;;) { const size = fs.readSync(fd, buffer); if (!size) break; content.update(buffer.subarray(0, size)); }
        fs.closeSync(fd); files++; bytes += stat.size; allocatedBytes += stat.blocks * 512;
        hash.update(JSON.stringify([relative, stat.mode & 0o7777, stat.size, content.digest('hex')]));
      }
    }
  };
  visit(project); return { digest: hash.digest('hex'), files, bytes, allocatedBytes };
}
const initial = inventory();
assert.equal(initial.digest, 'a43efc6df4ecb5031870f3dcb10f5755b88f038e6736fadbbb404d28fdf6cd7d', 'retained fixture must match the frozen byte/name/mode inventory');
assert.equal(initial.files, 42297); assert.ok(fs.statSync(large).blocks * 512 >= 3 * 1024 ** 3);
// Observe filesystem operations without changing their values or ordering.
const counters = { lstat: 0, stat: 0, realpath: 0, readdir: 0, open: 0,
  handleStat: 0, streamReadBytes: 0, readFileBytes: 0, writeFileBytes: 0 };
for (const name of ['lstat', 'stat', 'realpath', 'readdir', 'open'] as const) {
  const original = (fs.promises as any)[name];
  (fs.promises as any)[name] = async (...args: any[]) => {
    counters[name]++; const result = await original(...args);
    if (name === 'open') {
      const handle = result;
      const stream = handle.createReadStream.bind(handle);
      handle.createReadStream = (...options: any[]) => {
        const opened = stream(...options);
        opened.on('data', (chunk: Uint8Array) => { counters.streamReadBytes += chunk.byteLength; });
        return opened;
      };
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...options: any[]) => {
        const bytes = await read(...options); counters.readFileBytes += Buffer.byteLength(bytes); return bytes;
      };
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (bytes: Uint8Array | string, ...options: any[]) => {
        await write(bytes, ...options); counters.writeFileBytes += Buffer.byteLength(bytes);
      };
      const stat = handle.stat.bind(handle);
      handle.stat = (...options: any[]) => { counters.handleStat++; return stat(...options); };
    }
    return result;
  };
}
syncBuiltinESMExports();
const { captureTree, gitAuthority } = await import('../../../../dist-rewrite/records/content.js');
const { openJournal, initializeState, claim, release } = await import('../../../../dist-rewrite/records/state.js');
const { interpretAuthority } = await import('../../../../dist-rewrite/exec/policy.js');
const value = <T,>(result: { ok: true; value: T } | { ok: false; detail: string }): T => {
  if (!result.ok) throw new Error(result.detail); return result.value;
};
// Each measurement starts with an empty store while retaining earlier evidence.
const storeRoot = fs.mkdtempSync(join(work, 'baseline-store-'));
const database = value(initializeState(join(storeRoot, 'state.sqlite')));
const location = { database, storeRoot, run: 'baseline' };
const journal = value(await openJournal(location, 'create'));
const held = value(await claim(project, null, { database, holder: journal.root }));
const declaration = { criteria: [{ id: 'correct', text: 'Physical fixture; no model' }], inputs: [], outputs: [], commands: [], results: [], allowBlocked: false, body: '' };
const brief = { bytes: { path: 'blobs/' + 'a'.repeat(64), sha256: 'a'.repeat(64) }, digest: 'a'.repeat(64), declaration };
const authority = value(interpretAuthority(declaration,
  { project, protectedRoots: [journal.root], workRoot: join(work, 'scratch') }, []));
const scope = { journal, layout: { location, project, protectedRoots: [journal.root] }, brief,
  inputBaseline: [], outputBaseline: [], projectClaim: held, authority, git: gitAuthority(location, project) };
const io = () => { const usage = process.resourceUsage(); return { fsReadBlocks: usage.fsRead, fsWriteBlocks: usage.fsWrite }; };
const diff = (after: Record<string, number>, before: Record<string, number>) => Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]]));
fs.writeFileSync(join(logs, 'physical-workload.json'), JSON.stringify({ project, work, initial, storeRoot: location.storeRoot,
  specification: { largeBytes: 3 * 1024 ** 3, largeFill: '5a', chunkBytes: 4 * 1024 ** 2,
    dependencyFiles: 42296, dependencyName: 'dependencies/<zero-padded-5-digit-index>.txt',
    dependencyContent: 'dependency <index> + LF', fileMode: '0640', directoryMode: '0750' },
  order: ['first', 'repeat', 'one-edit', 'delete'],
  note: 'First is API-first with page cache already touched by inventory; not OS cold cache. Physical fixture isolated per invocation. No sparse/reflink data; no cache drop.' }, null, 2) + '\n');
const rows: object[] = [];
try {
  for (const operation of ['first', 'repeat', 'one-edit', 'delete']) {
    if (operation === 'one-edit') fs.writeFileSync(join(dependencies, '00000.txt'), 'changed dependency 0\n');
    if (operation === 'delete') fs.unlinkSync(join(dependencies, '00001.txt'));
    const before = io(), counts = { ...counters }, started = performance.now();
    const result = await captureTree(scope);
    const elapsedMs = performance.now() - started;
    assert.equal(result.ok, true, operation + ': direct capture result');
    rows.push({ operation, directResult: result, wallMs: elapsedMs, peakRssKiB: process.resourceUsage().maxRSS,
      io: diff(io(), before), operations: diff(counters, counts), physicalInventory: inventory() });
    fs.writeFileSync(join(logs, 'baseline-cost.json'), JSON.stringify({ executable: process.execPath, node: process.version,
      priority: fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ')[16],
      source: 'current rewrite engine; retained step-0 physical workload', scope: 'real durable captureTree, not an in-memory substitute',
      measurement: 'JS fs operation/stream/readFile/writeFile counters and rusage block I/O; /proc/self/io absent in this kernel. Logical byte channels, not disk-byte counts; native child I/O excluded.', rows }, null, 2) + '\n');
    console.log(JSON.stringify(rows.at(-1)));
  }
} finally {
  // Restore even if a capture fails, to verify the same physical inventory after the measurement.
  // Restore exact initial bytes/names on the SAME physical fixture used by all arms in this invocation.
  fs.writeFileSync(join(dependencies, '00000.txt'), 'dependency 0\n');
  fs.writeFileSync(join(dependencies, '00001.txt'), 'dependency 1\n', { mode: 0o640 });
  const restored = inventory(); assert.equal(restored.digest, initial.digest);
  fs.writeFileSync(join(logs, 'physical-restored.json'), JSON.stringify({ ...restored, initialDigestMatches: true,
    retainedForBenchmark: false, project, ownedLiveChildren: 0 }, null, 2) + '\n');
  value(await release(held, 'retire'));
}
console.log(JSON.stringify({ complete: true, captures: rows.length, fixtureRestored: true }));

} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
