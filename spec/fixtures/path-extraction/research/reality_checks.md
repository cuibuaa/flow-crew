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
  - name: shipped_manifest_records_positive_round
    type: exec-script-exit-zero
    params:
      timeout_seconds: 30
      script: |
        set -eu
        if test ! -e docs/happymj_incumbent/ship_report.md; then
          exit 0
        fi
        node <<'NODE'
        const fs = require('fs');
        const path = 'docs/happymj_incumbent/run_manifest.json';
        if (!fs.existsSync(path)) {
          console.error('ship_report.md exists but run_manifest.json is missing');
          process.exit(1);
        }
        const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
        if (!manifest || !Array.isArray(manifest.rounds) || manifest.rounds.length === 0) {
          console.error('ship_report.md exists but run_manifest.json has no rounds');
          process.exit(1);
        }
        const latest = manifest.rounds[manifest.rounds.length - 1];
        if (!latest || typeof latest.result !== 'number' || !Number.isFinite(latest.result)) {
          console.error('latest manifest round lacks a finite numeric result');
          process.exit(1);
        }
        if (!(latest.result > 0.05)) {
          console.error(`latest manifest result ${latest.result} does not clear beat threshold 0.05`);
          process.exit(1);
        }
        NODE
```
