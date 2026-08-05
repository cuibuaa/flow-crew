# Reality-Gate

Reality-Gate prevents a run from reaching terminal success when required evidence is missing or fabricated.

## Purpose

LLM-only gates can be fooled by plausible-looking summaries. Reality-Gate moves final evidence checks into deterministic code.

When a brief declares a `checks:` list under an exact `## Reality checks`
heading, FlowCrew runs those checks before allowing terminal states such as
`complete`, `shipped`, or `ceiling_hit`. Planner-generated checks use the same
section shape in the run's `reality_checks.md`; both sources are evaluated.

Checks are hard by default: if a hard check fails, the run moves to
`reality_gate_failed` and writes failure reports under the run directory. A
heuristic wording or documentation expectation may explicitly set
`advisory: true`; its failure remains visible in `.reality-gate.json`, run
events, and the run summary, but does not block the terminal verdict. Evidence
checks such as file existence, command exit codes, schemas, and numeric
thresholds should remain hard.

There is one narrow runtime exception for `exec-script-exit-zero`: exit 127 is
treated as an advisory environment defect only when stderr also contains a
shell `command not found` diagnostic. The report, persisted JSON, and advisory
event name the unavailable command. Exit 1 and exit 127 without that diagnostic
remain hard failures, so a script cannot bypass an evidence check merely by
choosing exit code 127.

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

The heading is part of the contract. The parser only reads a `checks:` mapping
inside a `## Reality checks` section (optionally wrapped in one YAML fence).

## Reality checks

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
      schema:
        type: object
        required: [metric, value, evidence]
        properties:
          metric: {type: string}
          value: {type: number}
          evidence: {type: string}

  - name: project-smoke
    type: exec-script-exit-zero
    params:
      script: npm run build
```

## Example notes

Here `schema`, not a top-level `required` parameter, supplies the JSON schema;
`script`, not `command`, supplies shell text for `exec-script-exit-zero`.

A `script` that runs `git archive` must declare every repository path it reads via
`archive_paths`, verified against `archive_ref` (default `HEAD`) before the script runs.
This closes a real gap: without it, a check that rehearses against `git archive` output
could be satisfied by a file that was never committed — present in the working tree,
absent from the ref the check claims to verify.

## Framework Boundary

Reality-Gate check implementations must stay domain-agnostic. Project-specific requirements belong in briefs or scripts invoked by `exec-script-exit-zero`.

Framework code should not contain business-specific project names or one-off task strings.

Planner-authored shell checks should use only POSIX baseline commands (`grep`,
`sed`, `awk`, and `test`) plus the guaranteed `node` runtime. They must not
assume `rg`, `jq`, `fd`, or `yq` exists. If a non-standard tool is unavoidable,
probe it with `command -v`; when absent, explain that the check was skipped and
exit successfully instead of turning a missing local utility into contrary
evidence.
