---
research:
  protocol: research-instrument/v1
  frozen: [examples/research-instrument/evaluate.cjs, examples/research-instrument/retention.json]
  candidate: [examples/research-instrument/candidate.json]
  argv: [/usr/bin/node, examples/research-instrument/evaluate.cjs]
  environment: {}
  author:
    role: coder
    instruction: Propose a lower synthetic cost while preserving the project retention property. Read the complete instrument history and diagnostics.
  budget: {max_rounds: 6, invocation_seconds: 10}
  publication: reports/research-instrument.md
---
# Frozen project instrument demonstration

The controlled instrument decides whether each candidate is retained and supplies
its final report. These synthetic observations are a protocol example.
