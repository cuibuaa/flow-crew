import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runWorkflow } from '../../dist-rewrite/core/loop.js';
import { runDeclaredCommand } from '../../dist-rewrite/exec/command.js';
import { putEvidence } from '../../dist-rewrite/records/state.js';
import type { StageAnswer } from '../../dist-rewrite/contract/answers.js';
import { stateFixture, get } from '../fixtures/rewrite-state.js';
import { workflowFixture, attemptAudit } from '../fixtures/rewrite-workflow.js';
import { runServices } from '../fixtures/rewrite-run-services.js';

it('P6 preparation -> build -> verification effects retain source-valid evidence through report assembly', async () => {
  const commands = [
    { id: 'Install', argv: [process.execPath, '-e',
     "const fs=require('node:fs');fs.mkdirSync('deps',{recursive:true});fs.writeFileSync('deps/library','installed')"], env: {}, inputs: [], required: true },
    { id: 'Build', argv: [process.execPath, '-e',
     "const fs=require('node:fs');fs.writeFileSync('bundle',fs.readFileSync('deps/library')+' built')"], env: {}, inputs: [], required: true },
    { id: 'Verify', argv: [process.execPath, '-e', ("const fs=require('node:fs');if(fs.readFileSync('bundle','utf8')!=='installed " +
          "built')process.exit(1);fs.writeFileSync('verification','passed')")], env: {}, inputs: [], required: true },
  ];
  const graph = { stages: [{ id: 'source', role: 'author', purpose: 'work', after: [],
   instruction: 'Implement' }, { id: 'report', role: 'author', purpose: 'work', after: ['source'], commands: ['Install', 'Build',
   'Verify'], instruction: 'Assemble report' }, { id: 'gate', role: 'author', purpose: 'gate', after: ['report'], commands: [] }] };
  const f = await stateFixture({ commands }, graph as any);
  await f.admit();
  const { ports, seen } = workflowFixture(f);
  ports.command = request => runDeclaredCommand(request, { scope: f.scope, writer: f.execution, process: runServices(f).process(f.execution),
   abort: new AbortController().signal });
  ports.attempt = async (request) => {
    seen.push(request);
    const before = await f.tree();
    let answer: StageAnswer;
    if (request.stage.id === 'source') {
      await writeFile(join(f.project, 'source'), 'Implementation');
      await writeFile(join(f.project, 'package.json'), '{}');
    }
    if (request.stage.id === 'report')
      await writeFile(join(f.project, 'REPORT.md'), 'Report assembled after all actual build and test effects');
    if (request.stage.purpose === 'gate') {
      answer = { kind: 'gate', answer: { outcome: 'accepted', reason: 'Complete direct-zero chain and final source', criteria: {
       correct: { status: 'pass', evidence: 'Native install/build/verification effects' } }, findings: [], remainingWork: [] } };
    }
    else
      answer = { kind: 'work', answer: { status: 'delivered', summary: 'Finite work completed', caveats: [], remainingWork: [],
       blocks: null } };
    return { ok: true, value: { address: request.address, ending: 'delivered', before, after: await f.tree(), ...await attemptAudit(f, request),
     closure: 'dead', usage: { state: 'unknown', raw: [] }, evidence: [], inputChars: 1, answer, answerRef: get(await putEvidence(f.journal,
     Buffer.from(JSON.stringify(answer)))) } };
  };
  try {
    expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal }))).toMatchObject({status:'complete',reason:'completed'});
    expect((await f.projection()).commands.map(c => c.command)).toEqual(['Install', 'Build', 'Verify', 'Install', 'Build', 'Verify']);
    expect(seen.map(r => r.stage.id)).toEqual(['source', 'report', 'gate']);
  }
  finally {
    await f.close();
  }
});
