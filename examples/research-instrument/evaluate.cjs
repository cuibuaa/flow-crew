// Controlled project policy; these numbers are not benchmark measurements.
const fs = require('node:fs');
const path = require('node:path');
const request = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8'));
const candidate = JSON.parse(fs.readFileSync(path.join(request.candidate.path, 'examples/research-instrument/candidate.json'), 'utf8'));
const retention = JSON.parse(fs.readFileSync(path.join(__dirname, 'retention.json'), 'utf8'));
const previous = request.history.filter(entry => ['baseline', 'keep'].includes(entry.outcome)).at(-1);
const response = {
  protocol: request.protocol, run_id: request.run_id, invocation_id: request.invocation_id,
  phase: request.phase, round: request.round, instrument_sha256: request.instrument_sha256,
  candidate_sha256: request.candidate.sha256, status: 'ok', reason: 'Controlled project comparison',
  observations: { cost: candidate.cost }, diagnostics: { retention: candidate.guard === true },
  artifacts: [], next_state: { evaluated: request.history.length + 1 },
};
if (request.phase === 'finalize') response.report = { content: '# Controlled project report\n\n' + JSON.stringify({ incumbent: request.incumbent, history: request.history }, null, 2) + '\n' };
else response.verdict = request.phase === 'initialize' ? 'baseline'
  : candidate.guard === true && candidate.cost >= retention.minimumCost && candidate.cost < previous.response.observations.cost ? 'keep' : 'reject';
console.log(JSON.stringify(response));
