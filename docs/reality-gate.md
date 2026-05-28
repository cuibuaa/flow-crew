# Reality-Gate

Reality-Gate prevents a run from reaching terminal success when required evidence is missing or fabricated.

## Purpose

LLM-only gates can be fooled by plausible-looking summaries. Reality-Gate moves final evidence checks into deterministic code.

When a brief declares `checks:`, FlowCrew runs those checks before allowing terminal states such as `complete`, `shipped`, or `ceiling_hit`.

If a check fails, the run moves to `reality_gate_failed` and writes failure reports under the run directory.

## Check Types

| Type | Purpose |
|---|---|
| `http-reachability` | Verify URLs return expected status codes |
| `file-exists-nonempty` | Verify artifacts exist and are not empty |
| `json-schema-match` | Verify JSON result shape |
| `variance-floor` | Detect suspiciously identical metric values |
| `static-ast-scan` | Block forbidden source patterns |
| `exec-script-exit-zero` | Run a project-specific deterministic script |

## Brief Example

```yaml
checks:
  - name: docs-generated
    type: file-exists-nonempty
    params:
      paths:
        - docs/output.md

  - name: result-shape
    type: json-schema-match
    params:
      file: result.json
      required:
        - metric
        - value
        - evidence

  - name: project-smoke
    type: exec-script-exit-zero
    params:
      command: npm run build
```

## Framework Boundary

Reality-Gate check implementations must stay domain-agnostic. Project-specific requirements belong in briefs or scripts invoked by `exec-script-exit-zero`.

Framework code should not contain business-specific project names or one-off task strings.
