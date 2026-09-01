## Reality checks
```yaml
checks:
  - name: at_most_one_terminal_report
    type: exec-script-exit-zero
    params:
      timeout_seconds: 30
      script: |
        set -eu
        count=0
        for f in docs/happymj_incumbent/ship_report.md docs/happymj_incumbent/ceiling_report.md docs/happymj_incumbent/escalation_note.md; do
          if test -e "$f"; then
            count=$((count + 1))
          fi
        done
        if test "$count" -le 1; then
          exit 0
        fi
        echo "conflicting terminal reports present: $count" >&2
        exit 1
  - name: shipped_result_survives_confirmation
    type: exec-script-exit-zero
    params:
      timeout_seconds: 3600
      script: |
        set -eu
        if test ! -e docs/happymj_incumbent/ship_report.md; then
          exit 0
        fi
        python3 -m happymj.research_confirm --result docs/happymj_incumbent/round_result.json
```
