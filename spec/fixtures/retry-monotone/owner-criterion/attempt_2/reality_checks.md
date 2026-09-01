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
  - name: current_round_has_single_outcome
    type: exec-script-exit-zero
    params:
      timeout_seconds: 30
      script: |
        result=docs/happymj_explore6/round_result.json
        sidecar=docs/happymj_explore6/round_result.json.no_candidate.json
        count=0
        test -s "$result" && count=$((count + 1))
        test -s "$sidecar" && count=$((count + 1))
        test "$count" -eq 1
        if test -s "$sidecar"; then
          node - <<'NODE'
          const fs = require('fs');
          const sidecar = JSON.parse(fs.readFileSync('docs/happymj_explore6/round_result.json.no_candidate.json', 'utf8'));
          const keys = Object.keys(sidecar).sort();
          const expected = ['label', 'outcome', 'reason'];
          if (JSON.stringify(keys) !== JSON.stringify(expected)) {
            throw new Error('no-candidate sidecar must contain exactly label, outcome, and reason');
          }
          if (sidecar.outcome !== 'no_candidate') {
            throw new Error('no-candidate sidecar outcome must be no_candidate');
          }
          for (const key of ['label', 'reason']) {
            if (typeof sidecar[key] !== 'string' || sidecar[key].length === 0) {
              throw new Error('no-candidate sidecar ' + key + ' must be a nonempty string');
            }
          }
          NODE
        fi
  - name: run_manifest_has_unique_round_labels
    type: exec-script-exit-zero
    params:
      timeout_seconds: 30
      script: |
        node - <<'NODE'
        const fs = require('fs');
        const path = 'docs/happymj_explore6/run_manifest.json';
        const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
        if (!Array.isArray(manifest.rounds) || manifest.rounds.length < 1) {
          throw new Error('run_manifest.json must contain at least one journaled round');
        }
        const labels = new Set();
        for (const [index, round] of manifest.rounds.entries()) {
          if (!round || typeof round.label !== 'string' || round.label.length === 0) {
            throw new Error('round ' + index + ' is missing a nonempty label');
          }
          if (labels.has(round.label)) {
            throw new Error('duplicate round label: ' + round.label);
          }
          labels.add(round.label);
        }
        NODE
```
