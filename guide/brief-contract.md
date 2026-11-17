# Brief contract

For authors writing a self-contained goal and evidence contract. A brief has YAML
(or JSON) frontmatter between `---` delimiters followed by an opaque UTF-8 body.
Code validates declarations without deriving policy from prose. The run receives the
parsed declaration and complete body, not the originating conversation. Original bytes
and their digest remain evidence; public setup currently prints no digest.

```yaml
---
criteria:
  - {id: correct, text: Deliver independently reviewed work.}
inputs: []
outputs: []
commands: []
results: []
allowBlocked: false
---
Describe the goal, evidence, real constraints and what the report must show.
```

All six fields are required. Criteria must be nonempty; the other arrays may be empty.
Unknown fields, duplicate YAML keys and duplicate IDs within a collection are refused.
IDs start with an ASCII letter and then contain letters, digits, `_` or `-`.

## Inputs outputs and validation

| Field | Declaration |
|---|---|
| `criteria` | `{id, text}` outcome obligations with nonempty text |
| `inputs` | `{id, path, kind, frozen, sha256?}`; kind is `file` or `directory`; frozen is a required boolean |
| `outputs` | `{path, kind, existing}`; existing is `create`, `update`, `append` or `replace` |
| `commands` | `{id, argv, env, inputs, required, durationMs?}`; inputs are declared input IDs |
| `results` | `{id, text}` finite allowed result labels with nonempty text |
| `allowBlocked` | Whether a gate may accept a blocked outcome |

Input and output paths must each be unique. Paths are literal relative or absolute
paths, with nonempty components; dot/dot-dot, glob syntax, backslash, colon and control
characters are refused. A path in prose is only a reference. Declare gitignored inputs
and intentional reuse of existing outputs. `frozen: true` protects a file/tree; use
`false` for mutable input. Prose cannot enforce freezing. A supplied file `sha256` is a
lowercase SHA-256 identity; preparation measures and binds actual input identities.

For outputs, `create` requires absence; `update` and `append` require existing content;
`replace` accepts either. Existing type must match `kind`. Append preservation checks
the original content. External file mutation has [platform differences](operations.md#platform-boundaries).
Declaring an output does not grant its parent or siblings. Authors can write the isolated
project; exact external outputs and configured shared resources add authority. Inputs
alone do not grant arbitrary external writes.

Commands declare exact argv (nonempty executable), explicit non-secret `env` map,
input IDs and `required` boolean. The optional positive safe-integer `durationMs`
belongs to that command alone. Avoid shell strings when argv suffices. Public setup
checks syntax and host readiness, deferring all commands; start establishes resources
and runtime execution establishes feasibility. Report direct exits and totals after
the final relevant write. Required command/output obligations constrain delivery even
when a model approves it. There is no separate brief `validation` block.

Result IDs are opaque labels, not code-inferred scientific conclusions. A final
accepting gate selects a declared result when labels exist. Set `allowBlocked`
explicitly; a missing capability is evidence to judge, not automatic permission to
waive required products. Research policy belongs in the task's criteria, declared
evaluators/commands and evidence; there is no special research frontmatter.

The retired `bounds` key is accepted and ignored regardless of value, with one advisory
per supplied key at parsing. It is absent from admitted metadata and agent input;
original evidence bytes remain intact. It supplies no execution limit. C2 parks after
three gate rejections without a new best or four failures, retaining work. Provider
context exhaustion is native; provider-internal loops need operator cancellation.

## Authoring and verification principles

State the result and evidence needed, leaving approach and decomposition to the run.
Keep the brief self-contained: outcome, original evidence locations, real constraints,
observable criteria and required report/products. Label examples as illustrative;
state exact paths/APIs only when they are genuine requirements. Name dependencies of
supplied quantities and explain evidence gaps. Do not silently turn an operator's
preferred answer into an acceptance criterion.

Freeze supplied evaluators and original evidence that must remain unchanged. Require
complete configured validation with direct exits/totals after the last relevant write.
Separate operator numeric expectations from measured results; where applicable require
`within_expected_range` and `method_was_not_adjusted_to_match_expectation` in the report.
These are reporting conventions, not additional frontmatter fields.

For minimal rewrites, name production entrypoints and require a base/final reachability
and removal inventory, behavior parity on identical recorded inputs, production runtime
selection, module responsibilities, before/after size and a design account of added and
removed mechanisms. Require a parity witness that detects an injected change, full final
validation and a cutover/rollback description. Shared production state is read-only via
copies; deployment and pushes need separate authority. Leave suspected behavior bugs as
findings unless their repair is in scope. Ask for this evidence without prescribing a
shared skeleton or an order of implementation.

Human acceptance needs a second way to verify plausible results. Read actual artifacts,
rejected reviews and direct command evidence; reproduce a defect independently and
characterize recurrence with denominators. Inspect the deciding code, query, formula or
instrument before theorizing about a surprising value. A zero CLI exit, passing rerun
or summary alone is insufficient. Use real served/rendered paths when the property
depends on serving or presentation. Change tracked specifications only for an authorized
contradiction and explain the affected assertion. Preserve unique and invalid evidence
before cleanup; terminal status does not authorize deletion.

## Evidence authoring policy

Apply these judgments when relevant; ordinary engineering does not inherit research
rounds or metric-search policy merely by using FlowCrew.

- Research briefs declare baseline, measurement policy, allowed stopping results and
  the evidence needed to distinguish a supported ceiling from success. Missing
  author-owned facts must stay explicit rather than being invented.
- Reproduce baseline and candidate at the same scale against an unchanged incumbent
  or suitable constant control. Name existing evaluators and why they do or do not
  serve before creating a replacement.
- For aggregate claims show baseline/result distributions, per-item contributions,
  largest share, leave-one-out results and how concentrated contributions affect the
  conclusion. For intermittent defects give before/after rates and denominators.
- Verify a plausible numeric result another way, including what the instrument returns
  when broken. Prove the experiment varied the variable it claims. Preserve failed or
  invalid measurements unchanged and label their defect.
- Attribute prior conclusions or re-establish their evidence. Read original files;
  summaries and expected values are cross-checks, not measured facts. Record direct
  exits rather than the exit of a later pipe filter. Report residual uncertainty.

Sources: [brief grammar](../rewrite-src/contract/brief.ts),
[public setup/start](../rewrite-src/ops/main.ts), [authority](../rewrite-src/exec/policy.ts),
[answers](../rewrite-src/contract/answers.ts), [holding pattern](../rewrite-src/core/retry.ts).
