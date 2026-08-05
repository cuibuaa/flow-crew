---
research:
  baseline: 0
  policy: greedy_stack
  higher_is_better: true
  result_file: docs/hello-research/round_result.json
  report_dir: docs/hello-research
  result_schema:
    type: object
    required: [label, result]
    properties:
      label:
        type: string
      result:
        type: number
  confirm:
    command: |
      test "$(git ls-files '*.ts' | wc -l)" -ge 1
    requires: At least one tracked TypeScript file must exist.
  stop:
    beat: 1
    max_rounds: 3
    halt_after_no_improvement: 1
terminal_states:
  shipped:
    paths: [docs/hello-research/ship_report.md]
  ceiling_hit:
    paths: [docs/hello-research/ceiling_report.md]
    floor:
      min_attempted_stages: 1
---
# Hello Research: find tracked TypeScript

## Goal

Use a read-only command to establish whether this repository contains at least
one tracked TypeScript file.

## Round contract

- Try one read-only counting method per round; do not change project files.
- Record the method in `label` and the number of tracked `.ts` files in
  `result`.
- Write exactly one JSON object to
  `docs/hello-research/round_result.json`, for example:

```json
{"label":"git-ls-files","result":42}
```

The framework owns the ship or ceiling report. Do not create either terminal
artifact yourself.
