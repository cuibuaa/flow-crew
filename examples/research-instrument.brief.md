---
research:
  measurement:
    frozen: [examples/research-instrument/evaluate.cjs, examples/research-instrument/retention.json]
    candidate: [examples/research-instrument/candidate.json]
    replicates: 4
    metrics:
      cost: {direction: min, scale: fraction}
    primary: [cost]
    development: {command: /usr/bin/node, args: [examples/research-instrument/evaluate.cjs, development]}
    guards:
      - name: retention
        command: /usr/bin/node
        args: [examples/research-instrument/evaluate.cjs, guard]
        pass: {field: pass, equals: true}
    held_out:
      command: /usr/bin/node
      args: [examples/research-instrument/evaluate.cjs, held-out]
      allowance: 2
      pass: {field: pass, equals: true}
    timeout_seconds: 10
  stop: {max_rounds: 6, halt_after_no_improvement: 3}
terminal_states:
  ceiling_hit:
    paths: [docs/research-instrument/ceiling_report.md]
---
# Synthetic engine-owned instrument demonstration

Choose a lower synthetic cost in the declared candidate JSON, preserving its
structured retention guard. The engine measures candidates with a frozen
instrument, calibrates four baseline replicates, requires the guard, and charges
at most two held-out uses. This demonstrates the protocol, not an optimization
or a benchmark result. Independent review checks the candidate before settlement.
Write the final report only when the engine selects its declared terminal path.

## Report criteria

1. Show the engine's baseline replicate count and calibrated noise, candidate
   digest and frozen instrument fingerprint.
2. Show each kept or rejected candidate with its numeric comparison and guard
   output, and the recorded held-out uses and terminal reason.
