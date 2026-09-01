## Reality checks
```yaml
checks:
  - name: terminal_artifact_exclusivity
    type: exec-script-exit-zero
    params:
      timeout_seconds: 30
      script: |
        count=0
        test -s docs/happymj_explore6/ship_report.md && count=$((count + 1))
        test -s docs/happymj_explore6/ceiling_report.md && count=$((count + 1))
        test -s docs/happymj_explore6/escalation_note.md && count=$((count + 1))
        test "$count" -le 1
  - name: exactly_one_round_outcome
    type: exec-script-exit-zero
    params:
      timeout_seconds: 30
      script: |
        count=0
        test -s docs/happymj_explore6/round_result.json && count=$((count + 1))
        test -s docs/happymj_explore6/round_result.json.no_candidate.json && count=$((count + 1))
        test "$count" -eq 1
```
