// Synthetic protocol example; these numbers are not benchmark measurements.
const fs = require('node:fs');
const candidate = JSON.parse(fs.readFileSync(process.env.FC_RESEARCH_CANDIDATE + '/examples/research-instrument/candidate.json', 'utf8'));
const retention = JSON.parse(fs.readFileSync(__dirname + '/retention.json', 'utf8'));
const mode = process.argv[2];
console.log(JSON.stringify(mode === 'development'
  ? { items: Object.entries(retention.weights).map(([id, weight]) => ({ id, metrics: { cost: candidate.cost * weight } })) }
  : { pass: mode === 'guard' ? candidate.guard === true : candidate.cost >= retention.minimumCost }));
