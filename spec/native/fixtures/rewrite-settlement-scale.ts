import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runAttempt } from '../../../dist-rewrite/exec/attempt.js';
import { decideNext } from '../../../dist-rewrite/core/decisions.js';
import { settle } from '../../../dist-rewrite/core/settlement.js';
import { hashInputs, captureTree } from '../../../dist-rewrite/records/content.js';
import { putEvidence } from '../../../dist-rewrite/records/state.js';
import type { AttemptRequest, Adapter } from '../../../dist-rewrite/contract/runtime.js';
import { get, stateFixture } from '../../fixtures/rewrite-state.js';
import { runServices } from '../../fixtures/rewrite-run-services.js';

/** Allocated synthetic TS/Python repository, real Git/SQL/closure, inert native author. */
export async function settlementScale() {
  const f = await stateFixture({ inputs: [{ id: 'reference', path: 'reference', kind: 'directory', frozen: true }] });
  try {
    const inventory = createHash('sha256');
    let files = 0, bytes = 0;
    for (const [directory, count, size] of [['src', 1024, 4096], ['dependencies', 1024, 49152],
      ['reference', 128, 16384]] as const) {
      for (let index = 0; index < count; index++) {
        const path = `${directory}/package_${index % 32}/module_${index}.${index % 2 ? 'py' : 'ts'}`;
        const line = index % 2 ? `# synthetic module ${index}\nvalue = ${index}\n` : `// synthetic module ${index}\nexport const value = ${index};\n`;
        const content = Buffer.from(line.repeat(Math.ceil(size / line.length)).slice(0, size));
        await mkdir(join(f.project, directory, 'package_' + index % 32), { recursive: true });
        await writeFile(join(f.project, path), content);
        inventory.update(path + '\0').update(content);
        files++; bytes += size;
      }
    }
    Object.assign(f.scope, { inputBaseline: get(await hashInputs(f.scope)) });
    Object.assign(f.launch.setup, { inputs: f.scope.inputBaseline, tree: get(await captureTree(f.scope)) });
    const setupRequest = { project: f.launch.setup.project, target: f.project, brief: f.brief, runtime: f.runtime };
    const baselines = { inputs: f.scope.inputBaseline, outputs: f.scope.outputBaseline, tree: f.launch.setup.tree };
    await f.append(f.control, [{ type: 'run_authority', authority: f.scope.authority },
      { type: 'setup_prepared', request: setupRequest, unit: f.launch.unit, baselines, measured: null },
      { type: 'setup_prepared', request: setupRequest, unit: f.launch.unit, baselines, measured: f.launch.setup },
      { type: 'admitted', launch: f.launch }, { type: 'plan_committed', plan: { revision: 'Revision', plan: f.plan,
        digest: createHash('sha256').update(JSON.stringify(f.plan)).digest('hex'), executed: [] } }]);
    await mkdir(join(f.configRoot, 'roles'));
    await writeFile(join(f.configRoot, 'roles', 'work.md'), 'Deliver the synthetic module edit.');
    const scope = { ...f.scope, authority: { ...f.scope.authority, preferences: [{ role: 'author', backend: 'codex' as const,
      settings: { model: 'fixture', effort: 'fixture', source: { model: 'role' as const, effort: 'role' as const } } }] } };
    const projection = await f.projection(), next = get(decideNext(projection));
    if (next.kind !== 'stage') throw Error('Expected work frontier');
    const address = { run: 'Run', stage: next.stage.id, attempt: 'ScaleAttempt', invocation: 1 };
    const invocation = { charge: 'work' as const, address: { kind: 'stage' as const, ...address } };
    await f.append(f.execution, [{ type: 'invocation_reserved', invocation }]);
    const request: AttemptRequest = { address, invocation, stage: next.stage, role: f.configuration.roles[0], brief: f.brief,
      plan: projection.plan, evidence: [], context: next.context };
    const traces = await Promise.all([0, 1].map(index => putEvidence(f.journal,
      Buffer.from((`synthetic tool trace ${index}\n`).repeat(32768))).then(get)));
    let nativeExit = 0;
    const adapter: Adapter = { invoke: async backend => {
      const child = spawn('/usr/bin/nice', ['-n', '19', process.execPath, '-e',
        `const fs=require('node:fs'); const p=process.argv[1]; const b=fs.readFileSync(p); b[0]=35; fs.writeFileSync(p,b);`,
        join(f.project, 'src/package_0/module_0.ts')], { env: {}, stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => { nativeExit = performance.now(); if (code !== 0) reject(Error('Inert author exit ' + code)); });
        child.once('close', code => { if (code === 0) resolve(); });
      });
      const answerBytes = get(await putEvidence(f.journal, Buffer.from(JSON.stringify({ kind: 'work', answer: {
        status: 'delivered', summary: 'Changed one module after native feedback', caveats: [], remainingWork: [], blocks: null } }))));
      const schema = get(await putEvidence(f.journal, Buffer.from(JSON.stringify(backend.schema))));
      const raw = get(await putEvidence(f.journal, Buffer.from(JSON.stringify({ attempt: backend.attempt, role: backend.role,
        input: backend.input, schema, answerBytes }))));
      return { ok: true, value: { raw, exit: 0, signal: null, ending: 'delivered', answerBytes, closure: 'dead',
        usage: { state: 'unknown', raw: [] }, nativeCommands: traces } };
    } };
    return { f, scope, request, corpus: { files, bytes, digest: inventory.digest('hex') },
      async receive() {
        const receipt = get(await runAttempt(request, { scope, adapter, process: runServices(f).process(f.execution),
          configRoot: f.configRoot, privateEnvironment: {}, abort: new AbortController().signal }));
        return { receipt, nativeExit, returned: performance.now() };
      },
      async settle(receipt: Parameters<typeof settle>[1]) {
        return settle(await f.projection(), receipt, f.execution, scope);
      },
      async changedModule() { return readFile(join(f.project, 'src/package_0/module_0.ts')); },
    };
  } catch (error) { await f.close(); throw error; }
}
