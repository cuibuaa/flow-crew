## Reality checks

```yaml
checks:
  - name: Exactly one declared terminal document exists
    type: exec-script-exit-zero
    params:
      script: |
        complete=0
        escalated=0
        test -s docs/diagram_shape/final_verification.md && complete=1
        test -s docs/diagram_shape/escalation_note.md && escalated=1
        test "$((complete + escalated))" -eq 1
  - name: Renderer CSP still permits only local self assets
    type: exec-script-exit-zero
    params:
      script: |
        node <<'NODE'
        const fs = require('fs');
        const html = fs.readFileSync('src/renderer/index.html', 'utf8');
        const tag = html.match(/<meta\s+[^>]*http-equiv="Content-Security-Policy"[^>]*>/i)?.[0];
        const content = tag?.match(/content="([^"]*)"/i)?.[1];
        if (!content) throw new Error('renderer CSP meta tag is missing');
        const normalized = content.replace(/\s+/g, ' ').trim();
        const expected = "default-src 'self'; script-src 'self'; style-src 'self';";
        if (normalized !== expected) throw new Error(`renderer CSP changed: ${normalized}`);
        NODE
  - name: Complete report embeds the four required bilingual before-after captures
    type: exec-script-exit-zero
    params:
      script: |
        if test -s docs/diagram_shape/escalation_note.md; then
          exit 0
        fi
        node <<'NODE'
        const fs = require('fs');
        const report = fs.readFileSync('docs/diagram_shape/final_verification.md', 'utf8');
        const images = report.match(/data:image\/(?:png|webp|jpeg|svg\+xml);base64,/g) || [];
        if (images.length < 4) throw new Error(`expected at least four embedded captures, found ${images.length}`);
        NODE
  - name: Complete state retains exactly the field-selected eight-failure baseline
    type: exec-script-exit-zero
    params:
      timeout_seconds: 1800
      script: |
        if test -s docs/diagram_shape/escalation_note.md; then
          exit 0
        fi
        node <<'NODE'
        const fs = require('fs');
        const path = require('path');
        const { spawnSync } = require('child_process');
        const baselinePath = '/home/qian/.fc/ship-setups/1b8252f31b69c1a65349af728d96880a6b9778a6dcc89323f3b24147f9928cbb.json';
        const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
        if (baseline.branch !== 'diagram-shape' || path.resolve(baseline.targetDir) !== process.cwd()) {
          throw new Error('governing setup fields do not identify this target');
        }
        const recorded = baseline.validationBaseline.results.find((entry) => entry.role === 'test');
        if (!recorded || recorded.failureIdentifiers.length !== 8) throw new Error('governing test baseline is malformed');
        const run = spawnSync(process.execPath, ['--test'], {
          cwd: process.cwd(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024
        });
        const tap = `${run.stdout || ''}\n${run.stderr || ''}`;
        const observed = [...tap.matchAll(/^\s*not ok \d+ - (.+)$/gm)]
          .map((match) => match[1].trim().replace(/\\#/g, '#'));
        const expected = [...recorded.failureIdentifiers];
        if (run.status !== 1) throw new Error(`node --test exit ${run.status}; expected governed red exit 1`);
        if (JSON.stringify(observed) !== JSON.stringify(expected)) {
          throw new Error(`failure identities differ\nexpected=${JSON.stringify(expected)}\nobserved=${JSON.stringify(observed)}`);
        }
        NODE
```
