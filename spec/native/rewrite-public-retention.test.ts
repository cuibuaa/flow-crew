import {it} from 'vitest';
import {publicTestTimeoutMs} from './fixtures/public-cli.mjs';
import {publicRetention} from './fixtures/public-retention.mjs';
it('public cancel exports author changes, releases the external directory in the same store and preserves A after B completes',async({task,signal,onTestFinished})=>{
  const running=publicRetention(process.cwd(),undefined,signal);
  onTestFinished(async()=>{await running.catch(()=>{});});
  const report=await running;
  task.meta.retention=report;
  process.stderr.write('public retention witness '+JSON.stringify({bytes:report.retainedBytes,
    cli:report.cli.map(({args,exit,ms})=>({command:args[0],exit,ms}))})+'\n');
},publicTestTimeoutMs);
