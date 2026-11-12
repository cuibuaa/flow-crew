import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResearchInstrumentSchema, type ResearchConfig } from '../../src/research-instrument.js';

/** Project policy belongs to this controlled instrument, never the engine. */
export const instrumentProgram = `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const requestPath = process.argv.at(-1);
const r = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
const c = JSON.parse(fs.readFileSync(path.join(r.candidate.path, 'candidate.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync('instrument/config.json', 'utf8'));
const readOnly = Object.fromEntries(Object.entries({ request: requestPath,
  candidate: path.join(r.candidate.path, 'candidate.json'),
  instrument: path.join(r.instrument_path, 'instrument/run.cjs'),
  config: path.join(r.instrument_path, 'instrument/config.json') }).map(([name, file]) => {
    try { const fd = fs.openSync(file, 'r+'); fs.closeSync(fd); return [name, false]; }
    catch (error) { return [name, error.code === 'EACCES']; }
  }));
let value = c.value;
if (r.phase !== 'finalize') {
  if (c.fail) { console.error('controlled executable failure'); process.exit(2); }
  if (c.attack) {
    const targets = { source: path.join(cfg.project, 'instrument/config.json'), snapshot: path.join(r.instrument_path, 'instrument/config.json'), candidate: path.join(r.candidate.path, 'candidate.json'), request: requestPath };
    const target = targets[c.attack];
    const before = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, '{"value":1}'); value = 1; fs.writeFileSync(target, before);
  }
  if (c.metadata) {
    const mode = fs.statSync(__filename).mode;
    fs.chmodSync(__filename, mode ^ 64); fs.chmodSync(__filename, mode);
  }
  if (c.operations) {
    const p = path.join(r.instrument_path, 'instrument/config.json'), out = path.join(process.env.TMPDIR, 'scratch');
    fs.writeFileSync(out, 'scratch works');
    for (const op of [() => fs.truncateSync(p), () => fs.renameSync(p, out), () => fs.linkSync(p, out + '-link')]) {
      let refused = false; try { op(); } catch (e) { refused = ['EACCES','EXDEV'].includes(e.code); }
      if (!refused) process.exit(10);
    }
  }
}
const response = {
  protocol: r.protocol, run_id: r.run_id, invocation_id: r.invocation_id, phase: r.phase, round: r.round,
  instrument_sha256: r.instrument_sha256, candidate_sha256: r.candidate.sha256,
  status: c.unavailable && r.phase === 'evaluate' ? 'unavailable' : 'ok',
  reason: 'controlled project decision',
  observations: { value, extra: { provenance: ['retained', { signed: -3 }], arbitrary: null } },
  diagnostics: { nested: { stages: [{ name: 'fixture', values: [1, null, false, { text: '雪\\nquoted"' }] }] }, request: r },
  artifacts: [], next_state: { prior: r.previous_state, nested: ['opaque', { round: r.round, extra: true }] }
};
response.diagnostics.readOnly = readOnly;
if (r.phase === 'finalize') response.report = { content: '# Project report\\nIncumbent ' + r.candidate.sha256 + '\\nHistory ' + r.history.length + '\\n' };
else if (response.status === 'ok') response.verdict = r.phase === 'initialize' ? 'baseline' : value < r.history.filter(h => h.response && ['baseline','keep'].includes(h.outcome)).at(-1).response.observations.value ? 'keep' : 'reject';
if (c.stop && r.phase === 'evaluate') response.stop = { reason: 'Project is done', outcome: { arbitrary: ['project', 'outcome'] } };
if (c.artifact && r.phase === 'evaluate') {
  const content = Buffer.from('opaque artifact\\n'); fs.writeFileSync(path.join(process.env.HOME, 'details.bin'), content);
  response.artifacts = [{ path: 'details.bin', sha256: crypto.createHash('sha256').update(content).digest('hex') }];
}
if (r.phase !== 'finalize') {
  if (c.mismatch) response[c.mismatch] = c.mismatch.endsWith('sha256') ? '0'.repeat(64) : c.mismatch === 'phase' ? 'initialize' : typeof response[c.mismatch] === 'number' ? 999 : 'different';
  if (c.invalid) { console.log('{ invalid'); process.exit(0); }
  if (c.binary) { process.stdout.write(Buffer.from([255, 0, 254]), () => process.exit(0)); return; }
  if (c.badVerdict) response.verdict = c.badVerdict;
  if (c.overflow) { process.stdout.write('x'.repeat(5 * 1024 * 1024), () => process.exit(0)); return; }
}
if (c.exact) {
  const raw = { integer: 'large_raw_number', fraction: 'fraction_raw_number', huge: 'huge_raw_number' };
  response.observations.raw = raw; response.diagnostics.raw = raw; response.next_state.raw = raw;
}
const emit = () => console.log(JSON.stringify(response).replaceAll('"large_raw_number"', '9007199254740993').replaceAll('"fraction_raw_number"', '0.123456789012345678901').replaceAll('"huge_raw_number"', '1e999'));
// Stay live until the owning timeout/cancellation retires us, independent of host speed.
if (c.sleep && r.phase === 'evaluate') { console.error('PID=' + process.pid); setInterval(() => {}, 1000); }
else emit();
`;
export function makeInstrument(project: string, change: Partial<ResearchConfig> = {}): ResearchConfig {
  mkdirSync(join(project, 'instrument'), { recursive: true });
  writeFileSync(join(project, 'instrument/run.cjs'), instrumentProgram);
  writeFileSync(join(project, 'instrument/config.json'), JSON.stringify({ value: 100, project }));
  writeFileSync(join(project, 'candidate.json'), '{"value":100}');
  return ResearchInstrumentSchema.parse({ protocol: 'research-instrument/v1', frozen: ['instrument'], candidate: ['candidate.json'],
    argv: [process.execPath, 'instrument/run.cjs'], environment: {}, author: { role: 'coder', instruction: 'Propose the next candidate. Read all instrument history.' },
    budget: { max_rounds: 3, invocation_seconds: 5 }, ...change });
}
