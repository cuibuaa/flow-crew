# Brief contract

For authors writing a self-contained goal and evidence contract. A brief is a UTF-8 file with YAML
(or JSON) frontmatter between `---` delimiters followed by an opaque body.
Code validates declarations without deriving policy from prose. The run receives the
parsed declaration and complete body, not the originating conversation. Setup stores the
original bytes and SHA-256 digest in the run record.
Status shows the digest; `flowcrew status <run-id> --brief` prints the bytes until land
deletes raw evidence. Keep the saved brief if it must outlive the run.

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

All six fields are required. An optional `title` string names the run; otherwise the body’s first `# ` heading is used, or no title. Criteria must be nonempty; the other arrays may be empty.
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
paths, with nonempty components; dot/dot-dot, backslash and control characters are refused.
Characters `* ? [ ] { } :` are accepted literally, without glob expansion.
A path in prose is only a reference. Declare intentional reuse of existing outputs.
Setup copies the entire project except `.git`, including ignored files such as
`node_modules` and `.env.local`. `frozen: true` declares a file/tree for content audits and checkpoint handling; use
`false` for mutable input. This detects observed changes (restoring or quarantining where eligible; see [platform boundaries](operations.md#platform-boundaries)) rather than denying writes. A supplied file `sha256` is a
lowercase SHA-256 identity; preparation measures and binds actual input identities.

For outputs, `create` requires absence; `update` and `append` require existing content;
`replace` accepts either. Existing type must match `kind`. Append preservation checks
the original content. These declarations identify required products, original baselines
and what evidence is preserved. They do not restrict filesystem permissions; see the
[execution boundary](operations.md#platform-boundaries). Relative outputs belong to the
run’s private project copy; absolute outputs are held exclusively by one run until closure
and capture release them. A conflicting setup names the holding run.

Commands declare exact argv (nonempty executable), explicit non-secret `env` map,
input IDs and `required` boolean. The optional positive safe-integer `durationMs`
records a journal notice and run attention when that command passes the declared time; the
command keeps running and ends with its own receipt. If the notice cannot be recorded, the
command is stopped with process receipt cause `duration` and the operation fails as unknown;
inspect status before continuing. Commands receive the operator's PATH recorded at setup;
a declared `env.PATH` overrides it. No per-brief absolute PATH is needed.
FlowCrew supplies no HOME by default; the project's `npm test` decides HOME when needed.
A declared TMPDIR is used unchanged; when absent it defaults to the scratch directory of that execution. What setup
checks and does not establish: [preparation](operations.md#preparation-and-command-evidence).
Report direct exits and totals after the final relevant write. Required
command/output obligations constrain delivery even when a model approves it. There
is no separate brief `validation` block.

The retired keys `commands[].unconfined` and `bounds` are accepted and ignored; omit them.
Setup prints an advisory on stderr. Runtime retired keys are listed in
[configuration](configuration.md). All authors, providers and commands run with host-account
rights, with no interactive approval prompt. Run limits are in
[operations](operations.md#inspect-guide-and-stop).

The delivery gate runs every `required: true` command, even one a plan omits.
Publication needs exit 0 or a `pre-existing` failure (see
[required commands that already fail on the base](#required-commands-that-already-fail-on-the-base)).
Commands may produce delivered bytes during this phase.

An optional `dependsOn: string[]` declares every project path the command result depends
on, for example `dependsOn: [src/, tests/check.mjs, package.json]`. A file names itself;
a directory includes everything beneath it. Paths must be literal, project-relative
and normalized: no absolute paths, dot/dot-dot, backslashes or empty components.
A trailing directory slash is accepted and removed. The array must be nonempty when
present. Setup validates declarations and refuses dependency paths through
symlinks because checkpoint trees record links, not their targets. Future paths are
allowed: later additions and deletions are changes too. Checkpoints include ignored
project files as well as ordinary files.

With `dependsOn`, an earlier passing result for the same command may be reused when Git
finds no change under those paths since it ran. A later failed, unfinished or interrupted
run, a restore, a changed hash of a declared command input, or an unavailable diff requires
a rerun. Without `dependsOn`, any author change requires a rerun.

Do not declare `dependsOn` when the result depends on hardware, network, time or
anything outside the checkpoint tree. Omitting it makes any author change invalidate
evidence; with no author change since the result it still counts. The engine does not
observe whether external conditions stayed fixed. An incomplete dependency list can retain a
result whose real inputs changed; listing every dependency is the brief author's
responsibility.

A command that creates effects outside the process tree (scheduled tasks, services,
containers) must clean them up on every exit path, including failure and cancellation.

Result IDs are opaque labels. A final accepting gate selects a declared result when labels
exist. Set `allowBlocked` explicitly; a missing capability is evidence to judge, not
automatic permission to waive required products. Both accepting outcomes refuse a gate's
own failing criteria or `criterion_unmet`/`regression` findings. Every such violation in
a new answer quotes its brief sentence in `briefQuote`; the engine checks literal
membership with whitespace normalised. Final gates still assess every criterion. See
[gate answers and historical compatibility](agent-protocol.md#answers-and-gate-verdicts).

### Required commands that already fail on the base

A required command that exits non-zero when the delivery gate runs it is run once more, with the same
argv, environment and `durationMs`, on the run's base: the project tree that setup recorded before any
author or command wrote. The receipt keeps both results. If that base run completes and also exits
non-zero, the failure is `pre-existing`: the gate records the receipt with basis `pre-existing`, status shows
`basis: pre-existing` on the command, and the failure does not block acceptance, because the change did
not cause it. In every other case the basis is `introduced` and the non-zero exit blocks delivery as
`command_nonzero`: the base run passed, did not complete (it was cancelled, signalled or
otherwise unfinished), or could not be run. Only complete non-zero exits count; an unfinished or not-started
command is never `pre-existing`. The base run happens only for a required command at the delivery gate.

## Authoring and verification principles

State the outcome and the evidence that would establish it; leave approach and
decomposition to the run. Keep the brief self-contained: goal, original evidence
locations, real constraints, observable criteria, required products and report. Name an
exact path or API only when it is a requirement; label every other mechanism as an
example. Say where the evidence has gaps. A figure, list, conclusion or preferred answer
the operator supplies is a cross-check, not a premise or a criterion: say what it depends
on and whether it is complete, keep expected values apart from measured ones in the
report, and say whether the method was adjusted to match an expectation.

- **Freeze what must not change.** Choose the supplied evaluators and original evidence to
  declare `frozen: true` (field rules: [inputs and validation](#inputs-outputs-and-validation)).
- **Validate completely.** Declare the project's complete configured validation as
  `required: true` commands; the [command rules](#inputs-outputs-and-validation) say what to
  report and when.
- **Spend expensive checks once, at the end.** Declare an expensive or
  environment-dependent command `required: true` and let intermediate stages use cheap
  checks. State where it runs and the smallest sample a work stage uses after a change.
  When its result depends on the environment, say how fresh evidence is obtained if nothing
  changed (reuse rules: `dependsOn` in [inputs and validation](#inputs-outputs-and-validation)).
  Run every check at the cheapest fidelity that still tests the claim; add real time,
  devices or data only where the claim depends on them.
- **Reuse before replacing.** Adopt an existing approach, evaluator or tool and verify it.
  Compare candidates or build a new instrument only when that choice is the question, and
  then say why the existing one does not serve.
- **State what stays and what changes** when replacing behaviour users rely on; see the
  [reference-match and rewrite examples](#task-examples).
- **Make failures visible.** Every verification wait has a no-progress limit and reports
  its cause; an unexpected error reaches a log or an exit, never silence.

## Task examples

These checklists are examples for tasks whose acceptance calls for them.

- **Judge a match to a reference by paired evidence.** When acceptance is that the product
  matches an approved reference, freeze the reference as an input, exercise the real
  product in its real environment with the reference's content, and have a reviewer list
  every difference rather than relying on a threshold or property check. Each claimed
  difference needs side-by-side captures of both at the same position and size, quoted; a
  description of the whole artifact only says where to look.
- **Decide what happens to existing behaviour.** Where the work replaces, removes or could
  break behaviour that users or tests rely on, state what stays and what changes;
  otherwise the stage that speaks last decides. For a behaviour-preserving rewrite, also
  freeze an inventory of the old contracts and decide each one, and ask for: what
  production runs and what was removed, parity between base and final on identical
  recorded inputs with a check shown to fail on an injected change, size before and after,
  a design account of mechanisms added and removed, and a cutover and rollback
  description. Tracked specifications change only for an authorized contradiction, with the
  affected assertion explained. Shared production state is read only through copies;
  deployment and pushes need separate authority; suspected defects outside the scope are
  reported, not fixed.

## Research briefs

A research brief uses the ordinary fields; four carry it:

- **The evaluator is a frozen declared command.** Declare it and its data as `inputs`
  with `frozen: true` (what freezing does: [platform boundaries](operations.md#platform-boundaries)),
  and run it as a `required: true` command that lists them in its `inputs`. The command's
  receipt is the measurement: the report quotes it and its exit code.
- **The candidate is an `outputs` entry** the author edits, usually with `existing: update`.
- **`criteria` say what counts**: the measured baseline, the candidate measurement and the
  evaluator receipt, reproduced at the same scale against an unchanged incumbent or
  constant control, and the evidence that separates a supported ceiling from success.
- **`results` name every honest ending**, including negative ones such as `improved`,
  `no_improvement` and `blocked`, so a run that finds nothing better can finish accepted
  as `no_improvement` with evidence instead of looping or claiming a gain (label rules:
  [inputs and validation](#inputs-outputs-and-validation)). Set `allowBlocked: true` only
  when ending blocked is acceptable.

Frozen data the run can read is not sealed: freezing detects changes to the measurement,
but the run can still tune against it, and the best of many candidates looks good on the
data it was chosen on. Keep the data that decides adoption outside the run and score the
finalist there once, in a step the run cannot influence. For a runnable positive case and
a negative control, see `examples/README.md` (research briefs) in the FlowCrew checkout.

## Evidence authoring policy

Apply these when the task makes the claim; ordinary engineering does not inherit research
policy.

- Facts only the author owns, such as the baseline, measurement policy and allowed
  stopping results, stay explicit when missing; do not invent them.
- For aggregate claims show baseline and result distributions, per-item contributions,
  largest share, leave-one-out results and how concentrated contributions affect the
  conclusion. For intermittent defects give before and after rates with denominators.
- Verify a plausible numeric result another way, including what the instrument returns
  when broken, and prove the experiment varied the variable it claims. Preserve failed or
  invalid measurements unchanged and label their defect.
- Attribute prior conclusions or re-establish their evidence: read the original files and
  treat summaries as cross-checks.
