# Brief contract

For authors writing a self-contained goal and evidence contract. A brief has YAML
(or JSON) frontmatter between `---` delimiters followed by an opaque UTF-8 body.
Code validates declarations without deriving policy from prose. The run receives the
parsed declaration and complete body, not the originating conversation. Original bytes
and their digest remain evidence; setup and start print its SHA-256 digest.

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

All six fields are required. An optional `title` string declares the run name. The status publisher uses it, otherwise the body’s first `# ` heading, otherwise no title; it never infers a name from prose. Criteria must be nonempty; the other arrays may be empty.
An optional boolean `decompose` chooses the graph. Without it (or `false`) the run uses a fixed graph: one
author stage, then an independent gate that reviews the whole brief and runs the required commands, with a repair
stage that runs again after a repairable rejection. With `decompose: true` a planner first proposes the graph, which core
admission checks before it runs.
Unrelated unknown fields, duplicate YAML keys and duplicate IDs within a collection are refused.
IDs start with an ASCII letter and then contain letters, digits, `_` or `-`.

## Inputs outputs and validation

| Field | Declaration |
|---|---|
| `criteria` | `{id, text}` outcome obligations with nonempty text |
| `inputs` | `{id, path, kind, frozen, sha256?}`; kind is `file` or `directory`; frozen is a required boolean |
| `outputs` | `{path, kind, existing}`; existing is `create`, `update`, `append` or `replace` |
| `commands` | `{id, argv, env, inputs, required, durationMs?, dependsOn?}`; inputs are declared input IDs |
| `results` | `{id, text}` finite allowed result labels with nonempty text |
| `allowBlocked` | Whether a gate may accept a blocked outcome |

Input and output paths must each be unique. Paths are literal relative or absolute
paths, with nonempty components; dot/dot-dot, glob syntax, backslash, colon and control
characters are refused. A path in prose is only a reference. Declare gitignored inputs
and intentional reuse of existing outputs. `frozen: true` declares a file/tree for content audits and checkpoint handling; use
`false` for mutable input. This detects observed changes rather than denying writes. A supplied file `sha256` is a
lowercase SHA-256 identity; preparation measures and binds actual input identities.

For outputs, `create` requires absence; `update` and `append` require existing content;
`replace` accepts either. Existing type must match `kind`. Append preservation checks
the original content. These declarations identify required products, original baselines
and what evidence is preserved. They do not restrict filesystem permissions. Authors,
providers and commands have host-account rights, with a per-run project copy as the
default workspace. See the [execution boundary](operations.md#platform-boundaries).

Commands declare exact argv (nonempty executable), explicit non-secret `env` map,
input IDs and `required` boolean. The optional positive safe-integer `durationMs`
belongs to that command alone. Avoid shell strings when argv suffices. Commands receive
no PATH unless declared; use an absolute executable path. A declared TMPDIR is used
unchanged; when absent it defaults to invocation scratch. Setup checks declarations,
input/output facts and effective runtime settings using the same preparation owner as
start. It accepts the same `--config <file>` and creates no run or runtime pin, calls
no provider and executes no declared command. Actual execution establishes command
feasibility. Report direct exits and totals after the final relevant write. Required
command/output obligations constrain delivery even when a model approves it. There
is no separate brief `validation` block.

The retired `commands[].unconfined` key is accepted and ignored regardless of value.
One visible advisory at the existing parse boundary explains that all authors, providers
and commands run with host-account rights and the key constrains nothing. It is omitted
from new declarations and admitted command metadata. Original brief bytes and digest
remain unchanged; unrelated unknown command keys still reject. Runtime `sharedCaches`,
`devices` and `providerHomes` are retired in the same way; see
[configuration](configuration.md). Retiring keys does not waive review of the execution
boundary. Approve the exact saved brief digest, source and start options; editing any
brief byte requires renewed approval. The engine adds no interactive approval prompt.

The delivery gate command phase supplies evidence for every declared `required: true`
command, even when its planner command list omits one. It runs commands unless the
rule below accepts their latest reservation. Publication requires a committed,
complete receipt on intact lineage whose result tree satisfies delivery, with exit 0 or with a
`pre-existing` failure (see [required commands that already fail on the base](#required-commands-that-already-fail-on-the-base)).
Commands may produce delivered bytes during this phase.

An optional `dependsOn: string[]` declares every project path the command result depends
on, for example `dependsOn: [src/, tests/check.mjs, package.json]`. A file names itself;
a directory includes everything beneath it. Paths must be literal, project-relative
and normalized: no absolute paths, dot/dot-dot, globs, backslashes or empty components.
A trailing directory slash is accepted and removed. The array must be nonempty when
present. Setup validates declarations and refuses dependency paths through
symlinks because checkpoint trees record links, not their targets. Future paths are
allowed: later additions and deletions are changes too. Checkpoints include ignored
project files as well as ordinary files.

With `dependsOn`, an earlier committed complete exit-0 result for the same command and
run context may count when Git finds no changes intersecting those paths between its
result tree and delivery. The latest reservation decides: a later failed, unfinished or interrupted
request requires execution, even when an older result passed. Restores, retired work,
a changed content hash of any input the command declares in `inputs`, or an unavailable
diff prevent reuse. Gate evidence lists the
satisfied receipt, source tree, stage/attempt/invocation and empty dependency intersection.
Status and the report retain that source; an earlier invocation is labelled
`reused from <stage/attempt>` for display. Without `dependsOn`, any author change requires
a rerun: the result counts only while nothing but command executions (which may write
files into the delivered tree) has happened since it ran, with no restore in between.

Do not declare `dependsOn` when the result depends on hardware, network, time or
anything outside the checkpoint tree. Omitting it makes any author change invalidate
evidence; with no author change since the result it still counts. The engine does not
observe whether external conditions stayed fixed. An incomplete dependency list can retain a
result whose real inputs changed; listing every dependency is the brief author's
responsibility.

Planners select command IDs only; the strict plan schema cannot redefine commands.
`identifyCommand` binds the admitted command declaration before execution. Every launch
uses the same supervision, durable streams, duration handling, receipts and invocation
closure. Linux cgroup v2 containment, when available, covers descendants even when they
create another group or session. Elsewhere, invocation environment markers provide
best-effort closure; processes that clear their marker are outside that guarantee.
Unreadable environments are reported, left unsignalled, and do not retain ownership
forever. See [platform boundaries](operations.md#platform-boundaries).
Non-local effects such as Windows scheduled tasks are not engine-managed. The command
that creates such an effect owns its cleanup on every exit path, including failure
and cancellation.

Result IDs are opaque labels, not code-inferred scientific conclusions. A final
accepting gate selects a declared result when labels exist. Set `allowBlocked`
explicitly; a missing capability is evidence to judge, not automatic permission to
waive required products. Research policy belongs in the task's criteria, declared
evaluators/commands and evidence; there is no special research frontmatter.

The retired `bounds` key is accepted and ignored regardless of value, with one advisory
naming every supplied retired key at parsing. It is absent from admitted metadata and agent input;
original evidence bytes remain intact. It supplies no execution limit. C2 parks after
three consecutive gate rejections (counting the one that last set the best pass count) or
four failures without a completion, retaining work. Provider
context exhaustion is native; provider-internal loops need operator cancellation.

### Required commands that already fail on the base

A required command that exits non-zero when the delivery gate runs it is run once more, with the same
argv, environment and `durationMs`, on the run's base: the project tree that setup recorded before any
author or command wrote. The receipt keeps both results. If that base run completes and also exits
non-zero, the failure is `pre-existing`: the gate records the receipt with basis `pre-existing`, status shows
`basis: pre-existing` on the command, and the failure does not block acceptance, because the change did
not cause it. In every other case the basis is `introduced` and the non-zero exit blocks delivery as
`command_nonzero`: the base run passed, did not complete (it was cut off by `durationMs`, killed or
unfinished), or could not be run. Only complete non-zero exits count; an unfinished or not-started
command is never `pre-existing`. The base run happens only for a required command at the delivery gate.
Ask the report to name any pre-existing failure so a reader sees it; it stays visible in the
evidence either way, and a model's approval cannot turn an `introduced` failure into success.

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

- **Save expensive real-environment commands for the final gate.** Declare each as
  `required: true` and let intermediate gates choose cheap checks. When all dependencies
  are in the project tree, declare `dependsOn` so a repair reruns only commands whose
  dependencies it touched. For hardware, network or time-dependent measurements, omit
  it so any author change requires a rerun, and state how fresh environmental evidence
  is obtained when nothing was changed. State where each expensive command runs and
  the smallest sample a work stage uses after a code change.
- **Replay in real time only for clock-bound metrics.** Run accuracy-type metrics offline
  at full speed. Reason: wall-clock pacing adds no evidence about accuracy.
- **Freeze an approved visual mock as a declared input.** Acceptance renders the real UI
  with the mock's content, at its size, in the real environment, saves paired screenshots,
  and has a model list every difference without a pixel threshold; a property check alone
  cannot accept a look. Reason: matching attributes does not establish matching appearance.
- **Prove each claimed visual difference with paired crops.** For every difference the reviewer
  reports ("missing", "different"), save a crop of the product and a crop of the mock at the same
  coordinates and size, and quote both. A description of a whole screenshot is a hint to look
  where, not evidence. Reason: a whole-image description is easily wrong about where something is,
  and a difference that cannot be shown side by side has not been established.
- **Freeze the old version's user-facing contracts before a rewrite.** When old code is
  reference only, first inventory keys, mouse buttons, menus, buttons, settings, file
  formats and CLI flags in a table. Declare it as a frozen input; each row is kept or
  changed by a recorded decision. Acceptance exercises every row. Reason: a rewrite
  otherwise redesigns contracts users rely on without anyone deciding to.
- **Make errors fail fast at process boundaries.** Decode messages against a schema;
  unexpected errors produce a log entry plus an exit or restart, never a modal dialog.
  Every verification wait has a no-progress limit and reports its cause. Reason: malformed
  messages and hidden waits must become visible failures rather than unattended stalls.
- **Adopt a proven approach when one exists.** Measure to verify it; compare candidates
  only when the choice itself is the question. Reason: a search adds cost when existing
  evidence already settles the design choice.
- **Keep the data that decides adoption where the run cannot read it.** Assets the run can see while
  it searches, including "replication" checks, become tuning data once many candidates are
  compared against them: the best of many looks good on data it was chosen on. Keep a sealed set outside the
  run, and score the finalist there once, in a step the run cannot influence. Reason: a result that
  passes only on data the search could see has been selected for it, so it says little about
  new data.

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

## Research briefs

A research brief is an ordinary brief; there is no research mode. Four fields carry it:

- **The evaluator is a frozen declared command.** Declare the evaluator and its data
  as `inputs` with `frozen: true`, and run it as a `commands` entry with `required: true`
  that lists them in its `inputs`. Frozen files are restored or quarantined if the author
  changes them, so the evaluator's number cannot be edited into place. The command's
  receipt is the measurement: the report quotes it and its exit code.
- **The candidate is an `outputs` entry** the author edits, usually with `existing: update`.
- **`criteria` say what counts**: the report states the measured baseline, the candidate
  measurement and the evaluator receipt, and gives the reason for any ceiling.
- **`results` name every honest ending**, including negative ones such as `improved`,
  `no_improvement` and `blocked`. A final accepting gate must pick one declared label, so a
  run that finds nothing better can finish as accepted `no_improvement` with evidence,
  instead of looping or claiming a gain. Set `allowBlocked: true` only when a run may end
  blocked, for example because the evaluator cannot run; leave it `false` when the only
  acceptable endings are measured ones.

Frozen data the run can read is not sealed: a frozen evaluator and its data stop the run from editing
the measurement, but it can still tune against them. Keep the data that decides adoption outside
the run (see the sealed-set lesson in [authoring and verification principles](#authoring-and-verification-principles)).

Labels are opaque: the engine does not read a number and choose one. Reviewers compare
the label with the receipt. For a runnable pair, a positive case and a negative control
whose baseline cannot be beaten, see the [examples](../examples/README.md#research-briefs).

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
[public setup/start](../rewrite-src/ops/main.ts), [output facts and settings](../rewrite-src/exec/policy.ts),
[answers](../rewrite-src/contract/answers.ts), [holding pattern](../rewrite-src/core/retry.ts).
