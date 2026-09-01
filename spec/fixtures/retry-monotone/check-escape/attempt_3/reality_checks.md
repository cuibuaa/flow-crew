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
  - name: run_manifest_round_labels_unique
    type: exec-script-exit-zero
    params:
      timeout_seconds: 30
      script: |
        set -eu
        manifest=docs/happymj_incumbent/run_manifest.json
        if ! test -f "$manifest"; then
          exit 0
        fi
        set +e
        sed -n 's/^[[:space:]]*"label"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | awk '
          NF {
            seen[$0] += 1
            if (seen[$0] > 1) {
              print "duplicate round label: " $0 > "/dev/stderr"
              bad = 1
            }
          }
          END { exit bad }
        '
        status=$?
        set -e
        exit "$status"
```
