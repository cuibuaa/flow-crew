// Application data I/O counter for the built CLI. Module-loader and procfs
// startup reads are outside the private fixture; no speed threshold is used.
import fs from 'node:fs';
import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const fixturePath = process.env.SESSION_COST_FIXTURE;
const outputPath = process.env.SESSION_COST_IO;
const operation = process.env.SESSION_COST_OPERATION;
// Importing the optional counter without fixture input leaves the process alone.
if (fixturePath) {
  if (outputPath) {
    if (operation) {
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      const original = Object.fromEntries(['openSync', 'closeSync', 'readFileSync', 'readSync', 'readdirSync', 'opendirSync'].map(name => [name, fs[name]]));
      const fds = new Map();
      let depth = 0;
      let active = operation !== 'wakeTick';
      let counts = { files: 0, registryRecords: 0, historicalLedgerRecords: 0, globalEventRecords: 0 };
      const path = value => typeof value === 'number' ? fds.get(value) || '' : String(value);
      const opened = value => { if (active && path(value).startsWith(fixture.root + '/')) counts.files++; };
      const consumed = (value, bytes) => {
        const name = path(value);
        if (!active || !name.startsWith(fixture.root + '/')) return;
        if (name.endsWith('/tasks.jsonl')) counts.registryRecords += String(bytes).split('\n').length - 1;
        if (name.endsWith('/current.json')) counts.registryRecords++;
        if (name.includes('/ledger/cost-session/') && name.endsWith('.json')) counts.historicalLedgerRecords++;
        if (name.includes('/session-push/events/') && name.endsWith('.json')) counts.globalEventRecords++;
      };
      fs.openSync = function(file, ...args) {
        const fd = original.openSync(file, ...args); fds.set(fd, path(file));
        if (!depth) opened(file); return fd;
      };
      fs.closeSync = function(fd) { fds.delete(fd); return original.closeSync(fd); };
      fs.readFileSync = function(file, ...args) {
        depth++;
        try { const bytes = original.readFileSync(file, ...args); if (typeof file !== 'number') opened(file); consumed(file, bytes); return bytes; }
        finally { depth--; }
      };
      fs.readSync = function(fd, buffer, offset, length, position) {
        const count = original.readSync(fd, buffer, offset, length, position);
        if (!depth) consumed(fd, buffer.subarray(offset, offset + count)); return count;
      };
      for (const name of ['readdirSync', 'opendirSync']) fs[name] = function(file, ...args) { const result = original[name](file, ...args); opened(file); return result; };
      function finish() {
        active = false;
        fs.writeFileSync(outputPath, JSON.stringify(counts));
      }
      if (operation === 'wakeTick') {
        let tick = 0;
        const pause = timers.setTimeout;
        timers.setTimeout = function(ms, ...args) {
          if (++tick === 1) { active = true; return Promise.resolve(); }
          if (tick === 2) {
            finish(); // one complete steady-state iteration, excluding registration
            fs.writeFileSync(fixture.index, '[]');
            fs.writeFileSync(join(fixture.fc, 'session-push', 'acks', fixture.openEvent.eventId + '.json'), '{}');
            return Promise.resolve();
          }
          return pause(ms, ...args);
        };
      } else process.once('exit', finish);
      syncBuiltinESMExports();
    }
  }
}
