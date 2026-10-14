---
name: ship
description: Turn the current conversation into a self-contained FlowCrew brief, rehearse it, and launch the workflow. Use when the user asks to hand off or ship work to FlowCrew.
---
<!-- flowcrew-skill-revision: 29 -->

# Ship a conversation to FlowCrew

This is a procedure for the coding agent, not an engine promise of model obedience.
Use `/ship` in Claude Code or `$ship` in Codex. The repository's
[brief contract](../guide/brief-contract.md), [CLI](../guide/cli.md) and
[operations](../guide/operations.md) own detailed engine facts and travel with installed copies.

## Gather facts and author the brief

Precondition: before drafting, run `flowcrew ship-preflight` from the source project. Before exact-digest
confirmation, invoke FlowCrew only for preflight and rehearsal; do not probe setup/quick
with help or launch options. Treat `--help`, `--version`, capability discovery and dry probes
as invocations too. Exit zero means facts were gathered, not that they are favorable;
collection failure exits nonzero. Preflight cannot decide what prior state means. It discovers
validation commands but does not execute a baseline.

If a prior run is pending/running/parked/awaiting approval, show its identity and stop instead
of duplicating it. For terminal failure/incomplete/ceiling/phase/stop, carry forward the
relevant blocker and durable evidence. Unknown status needs inspection. Use prior reports
as inputs, not paraphrased facts or a promise to repeat their outcome.

Write a self-contained brief at `docs/task_brief.md` only after preflight facts are available. The run does not receive this
conversation. Include outcome, evidence paths, real constraints, extractable numbered
criteria, required human outputs and allowed stopping outcomes. State required observable
properties; label example mechanisms explicitly. Declare every source input in a leading
frontmatter `inputs:` block. A path in prose or a table is only a reference, not a declaration;
preflight can still discover candidate requirements there. Declare gitignored inputs in the
block and intentional reuse of existing outputs. Explain evidence gaps and dependencies of quantities.

Choose engineering for a known pass/fail outcome and research for candidate search with an
allowed supported ceiling. Propose the mode/workflow and explain it to the operator. Use
`workflow: direct` for coherent author-plus-review work and `workflow: planner` for decomposable
work or loops. Do not create an acceptance-only `objective.confirm` envelope. Map writable
paths for authored stages; leave schema details in the canonical references.

Require the complete configured validation with direct exits/totals after the last relevant
write. Separate an operator numeric expectation from measured evidence; use exact fields
`within_expected_range` and `method_was_not_adjusted_to_match_expectation` where applicable.
Use the [evidence authoring policy](../guide/brief-contract.md#evidence-authoring-policy) for
judgments about statistics, recurrence, concentrated contributions and supplied mechanisms. Do not invent measurements
or apply research-round rules to an ordinary engineering task.
Apply the [authoring and verification principles](../guide/brief-contract.md#authoring-and-verification-principles) when drafting and accepting work.

### Minimal, modular rewrites

For “minimal, modular rewrite” or “simplify what actually runs” tasks, require a small core
preserving the base commit's production behaviour. Name production entrypoints (services,
timers, cron, CLIs); code they do not reach may be removed, with every removal inventoried.
The design standard lives only in report criterion 3, as evidence the report must show; do not
restate it as a requirement on how the code is structured (no shared skeleton, variant mechanism,
or order of work), because the run chooses the means.

Require discovery of production's interpreter/runtime from service and other entrypoint
definitions and its use for parity and tests. Production processes, deploys and pushes are
outside the run's authority: describe cutover, never perform it. Use shared production state
(user data, caches) read-only via copies. A suspected behaviour bug is a finding left unchanged.

Give the brief numbered report criteria pinned to the base commit and final tree after the
last write, with evidence locations:

1. Reachability inventory from the named entrypoints at base: every module reached/unreached,
   method and direct exit code; every removed module and test listed.
2. Base/final behaviour parity: identical recorded inputs and clock/network stubs; decisions,
   outputs, error/failure paths (alerts, error records, notifications), and old-format records
   already on disk readable by every consumer (readers, dashboards, notifiers). Report harness
   location, inputs, compared-item counts per entrypoint, mismatches and direct exit code;
   demonstrate detection of an injected one-line change. Name existing parity/test facilities
   and why they do or do not serve.
3. Design account: final module map with responsibilities/interfaces; before/after `file:line`
   for each removed patch, special case or duplicate; every place where variants of one flow still
   carry duplicated execution code, with `file:line` and why; non-test line counts per module at
   base/end and method; each added mechanism with what it replaced, and every unpaired addition
   justified; any special case keyed on an error string or name; each retained restriction or
   special case with the consumer or failure it protects.
4. Full configured validation after the last write: direct exit codes and totals; direct
   import check for every retained module and execution check for every CLI entrypoint under
   the production runtime. List every removed test with the deleted code it exercised.
5. Final report with criteria 1–4 evidence, behaviour findings left unchanged, ordered operator cutover and rollback.

## Rehearse and confirm exact bytes

Precondition: `docs/task_brief.md` exists. Run these against its exact saved bytes:

```bash
flowcrew ship-preflight --brief docs/task_brief.md
flowcrew rehearse docs/task_brief.md
```

Fix blocking findings; treat ambiguous criterion wording, unexplained authored writable maps
and unassigned evidence floors as authoring problems. Review every retained warning and
explain it. Rehearsal is mandatory for this skill, including an engineering brief's static
pass. Exit zero ending in `✅ Contract ready` establishes wiring, not implementation or
research quality. Nonzero means correct the brief/environment. It calls no model but can
run declared shell confirmation; review that text first.
If bytes change, repeat preflight and rehearsal.

Show the final brief, complete findings, exact 64-hex digest and launch identity: source,
target, base, new branch, workflow/mode, adapter, foreground/background, campaign/context,
iteration bound and stage deadline read from engine configuration (`default_max_iterations`
and `default_timeout_ms`). Do not hardcode defaults.
Explain unattended shell authority and the scope-versus-host-isolation boundary.

Ask: “Start this exact brief digest `<digest>` with these settings?”
Wait for a new explicit answer after the final bytes/settings were shown.
Do not treat the original `/ship` request or an earlier “ship it” as approval of unseen
bytes/findings. Any change returns to saved-byte preflight/rehearsal and confirmation.

## Set up and launch

### Prepare the target

Precondition: a new explicit answer confirmed the unchanged exact digest and launch identity.
Do not invoke `ship-setup` for any purpose, including help or probes, before that confirmation.
Setup cannot choose the target identity. Run it with the approved identity and absolute brief path:

```text
flowcrew ship-setup --brief <brief-path> --project <source> --target <target> --base <ref> --branch <name>
```

Proceed only on exit zero and `Ship setup: READY`; nonzero is a refusal. Do not replace refusals with manual links/worktree
creation. The target baseline and ready record govern later checks. Unsupported population
comparison remains unverified; show that limitation rather than claiming source-suite parity.

### Register or run

Precondition: exact-digest confirmation and successful setup remain valid. Do not invoke
`quick`, even for help or a probe, before those conditions. For a background launch, inspect daemon status. Fresh verified status permits registration;
no listener calls for an explicitly authorized daemon start. Stale/unverified/nonresponsive
status requires reading identity/provenance, not assuming a hash difference names missing
fixes. Do not restart a daemon serving other work. If a required fix cannot be proven loaded,
stop or return for an explicit foreground choice. Foreground is absence of `--background`;
there is no `--foreground` CLI flag. Do not silently change the approved launch mode.

Transport unchanged bytes through stdin:

```text
flowcrew quick --background --project <target> - < docs/task_brief.md
flowcrew quick --project <target> - < docs/task_brief.md
```

Choose the approved one. Add only approved adapter/workflow/campaign/iteration flags and,
for changed-run continuation, `--acknowledge-brief-warnings=<digest>`. Do not use command substitution to
transport brief text or acknowledge a new digest automatically. A changed brief/settings
requires returning to confirmation. A zero background exit means registration succeeded,
not that the run passed. A nonzero launch/run exit needs diagnosis; neither proves the deliverable.
Report the returned task/run identity. For a registered task, record this wrap-up obligation
in existing conversation bookkeeping or the optional ledger:

“FlowCrew task <id> is registered; wrap-up remains: read the result, verify it independently, archive unique output, and reclaim the worktree and branch.”

After cancellation, update or remove that entry. After re-shipping, replace its id with the new one.

### Observe

Precondition: successful background registration returned an exact task identity. Run the
read-only watch command; `--once` exits 0, invalid options exit 1. It does not write run or task status:

```bash
flowcrew watch --once
```

## Ownership and verification

As an instruction for this skill, keep the research loop within the question in the brief;
the operator changes the question. The split is not mechanical work versus judgement: ask
whether failure announces itself or returns a plausible value. A new reproducible failure
belongs in a mechanical check when possible; the boundary moves as evidence improves.
Human acceptance still needs a second way to verify plausible results, actual rendered/served
artifacts when required, and inspection of the deciding code, query, formula or instrument.
Reproduce a claimed defect independently, characterize recurrence and its first mechanism,
and assess residual uncertainty. Archive failed or invalid results unchanged; preserve the
only copy of unique work. The tracked specification suite expresses intended behavior;
change it only for a task-authorized contradiction and explain which assertion and why.
Keep environment-specific probes in the invocation's private temporary root or declared
run files, outside the collected public specification directory.

## Human wrap-up

When work ends, read the terminal report, durable rejection/repair evidence, configured
validation delta and preservation inventory. Assess every criterion and unresolved limitation.
A terminal status, exit zero or a model's summary alone does not establish acceptance.
Do not discard a failed run's useful artifacts or infer that a ceiling is a metric win.
Use `land` audit before any authorized removal; removal and optional ledger closure are
explicit operator decisions. [Operations](../guide/operations.md#preserve-and-reclaim)
defines the preservation boundary.

Once the result is accepted and independent verification/archival are complete, use
`flowcrew land --run <run-id>` to audit preservation. Removal remains an explicit authorized
choice. If the operator retained an exact ledger closure identity, carry
`--complete-fc-task <entry-id> --fc-task-session <session-id>` into that authorized removal;
otherwise omit the closure identity and leave the entry open. Closure occurs only after
worktree removal, prune and non-force branch deletion all succeed. It is not an automatic
reaction to terminal status; [operations](../guide/operations.md#preserve-and-reclaim) owns
the full removal and closure contract.
