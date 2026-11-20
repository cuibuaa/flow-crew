import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {publishRunStatus} from '../../../dist-rewrite/ops/status.js';
import {appendEvents} from '../../../dist-rewrite/records/state.js';
const input=JSON.parse(process.argv[2] ?? 'null');
if (input === null) process.exit(0);
const wait=phase=>{process.send?.({barrier:true,phase});fs.readSync(0,Buffer.alloc(1),0,1,null);};
const original={open:fs.openSync,sync:fs.fsyncSync,rename:fs.renameSync,exec:DatabaseSync.prototype.exec};
const names=new Map();
fs.openSync=(...args)=>{const fd=original.open(...args);names.set(fd,String(args[0]));return fd;};
fs.fsyncSync=fd=>{
  original.sync(fd);
  if(input.boundary==='sync'&&names.get(fd)?.endsWith('.tmp'))wait();
  if(input.boundary==='directory'&&names.get(fd)?.endsWith('/'+input.location.run))wait();
};
fs.renameSync=(...args)=>{
  if(input.boundary==='replace')wait('before');
  original.rename(...args);
  if(input.boundary==='replace')wait('after');
  else if(input.boundary==='rename')wait();
};
DatabaseSync.prototype.exec=function(sql){if(input.boundary==='end'&&sql==='COMMIT')wait();return original.exec.call(this,sql);};
syncBuiltinESMExports();
if(input.action==='transition') {
  process.send?.({attempting:true});
  const start=performance.now();
  const result=await appendEvents(input.writer,input.cursor,[{type:'control_intent',intent:{id:input.id??'Cancel',kind:'cancel',
    run:input.location.run,unit:input.unit,expectedCursor:input.cursor}}]);
  process.send?.({result,elapsedMs:performance.now()-start});
} else {
  const start=performance.now();
  const result=publishRunStatus(input.location,input.at??'2030-01-01T00:00:00.000Z',0);
  process.send?.({result,elapsedMs:performance.now()-start});
}
process.disconnect?.();
