---
inputs:
  - src
  - scripts
  - config
  - guide
  - spec
  - ui/src
  - ui/public
  - ui/package.json
  - ui/package-lock.json
  - ui/index.html
  - ui/vite.config.ts
  - ui/tsconfig.json
  - ui/tsconfig.node.json
  - package.json
  - package-lock.json
  - tsconfig.json
  - {path: bench/instrument, frozen: true}
  - {path: bench/stage-tokens-fast-cal-1.json, frozen: true}
outputs:
  - path: bench/REPORT.md
research:
  measurement:
    frozen: [bench/instrument]
    candidate:
      - src
      - scripts
      - config
      - spec
      - guide
      - package.json
      - package-lock.json
      - tsconfig.json
      - ui/src
      - ui/public
      - ui/package.json
      - ui/package-lock.json
      - ui/index.html
      - ui/vite.config.ts
      - ui/tsconfig.json
      - ui/tsconfig.node.json
    environment: {}
    replicates: 2
    metrics:
      cost: {direction: min, scale: fraction}
    primary: [cost]
    development:
      command: /usr/bin/node
      args: [bench/instrument/evaluate.cjs]
    guards:
      - name: retention
        command: /usr/bin/node
        args: [bench/instrument/evaluate.cjs, guard]
        pass: {field: passes, equals: true}
    timeout_seconds: 3600
  stop: {max_rounds: 2, max_wall_hours: 6, halt_after_no_improvement: 2}
terminal_states:
  ceiling_hit:
    paths: [bench/REPORT.md]
---
# Improve ordinary engine cost

## Required properties of the final tree
1. General change within the candidate roots. No task-specific shortcuts.
2. Checks keep their power. No edits to the frozen instrument.

## Report criteria
1. Baseline, noise, instrument fingerprint and each round comparison and guards.
2. Label producer hypotheses and evidence separately from engine numbers.
