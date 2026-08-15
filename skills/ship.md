---
name: ship
description: Turn the current conversation into a self-contained FlowCrew brief, rehearse it, and launch the workflow. Use when the user asks to hand off or ship work to FlowCrew.
---
<!-- flowcrew-skill-revision: 9 -->

# ship — Hand off a plan to FlowCrew

Use `/ship <flag>` in Claude Code or `$ship <flag>` in Codex. This skill authors and
launches a brief; the public [CLI reference](https://github.com/cuibuaa/flow-crew/blob/main/guide/cli.md)
owns the complete flag catalogue.

## 1. Compose the handoff

Do not infer execution order from the heading order. Enforce each section's local precondition.
Execute the procedure as `ship-preflight` → draft → saved-brief preflight and `rehearse` →
digest-bound confirmation → `ship-setup` → `quick` → `watch`.

**Command firewall:** Before digest-bound confirmation, invoke the FlowCrew executable only with
`ship-preflight` or `rehearse`. Treat `--help`, `--version`, capability discovery, and dry probes as
invocations: never call `ship-setup`, `quick`, or any other FlowCrew command in this phase.

### 1.1 `ship-preflight`: gather workspace facts

**Precondition — begin here:** Run this initial fact-gathering step from the source project before
drafting, and do not draft until it has completed successfully.

Run `flowcrew ship-preflight` from the source project before drafting, then run it again with
`--brief docs/task_brief.md` once the draft exists. Add `--campaign <name>` only for an explicit
campaign choice. It reports the canonical project, prior runs, campaign resolution and hygiene,
daemon/build freshness, declared inputs and assertions, and the configuration-discovered build,
test, and lint baseline.

Exit 0 means those facts were gathered; it does not mean they are favorable. Invalid arguments,
an unreadable requested brief, or a collection failure exit non-zero. Missing or unproven input
evidence and stale code are launch blockers. Adverse history or a red baseline is information to
understand and encode as a delta, not a result about the task's subject.

The command cannot decide what prior state means. Route it deliberately:

- For `pending`, `running`, `parked`, or `awaiting_approval`, report the run id and stop instead
  of re-shipping.
- For `escalated`, `ceiling_hit`, `incomplete`, `phase_complete`, or `stopped`, carry forward the
  blocker, evidence, unfinished obligation, or intentional cancellation decision.
- For `failed` or `reality_gate_failed`, apply the independent acceptance procedure in §2.3.
- For `complete`, `shipped`, or no prior run, continue; useful evidence may still be context.
- Stop on an unknown lifecycle status until its meaning is established.

If campaign resolution is unknown, ask. `--campaign-context=skip` omits verbose history without
detaching ownership; use it only after the user chooses that tradeoff. Never rewrite runtime
campaign ledgers to make their grouping look tidier.

### 1.2 `ship-setup`: prove the launch workspace

**Precondition — do not invoke setup yet:** Do not invoke `ship-setup` for any purpose—not even
`--help`, capability inspection, or another probe—until §1.5 records a new confirmation of the
unchanged brief digest and launch identity.

`flowcrew ship-setup --brief <path> --project <source> --target <target> --base <ref>
--branch <name>` answers whether the exact base, branch, target, ignored inputs, input assertions,
and validation baseline can be established together. Introduce this boundary now, but run it only
after §1.5 confirms an exact draft and launch identity.

Exit 0 and `Ship setup: READY` mean the verified ready record was written. A non-zero refusal names
the blocker and writes no ready record; an already-created target may remain for diagnosis. Do not
replace a refusal with manual Git or link commands. Setup cannot choose the target identity, decide
whether an input is the only durable copy, or judge the future result. Its baseline, not §1.1's, is
what the gates enforce — preflight measures the source and setup the target — so never quote
preflight's as a brief's permitted failure set.

### 1.3 Draft a self-contained brief

**Precondition — draft only after preflight:** Write the brief only after §1.1 has gathered the
source-project facts and no active-run blocker requires stopping.

**Scope by class before drafting.** Work of one kind belongs in one task, because the planner can
decompose and parallelise inside it far better than a chain of tasks can be sequenced from outside.
Split only when the kinds genuinely differ — and then launch the pieces in parallel rather than in
series, since a queue of related tasks is the shape that looks organised and finishes last.

The planner does not receive this conversation. Write `docs/task_brief.md` so a capable practitioner
who has never seen it knows the outcome, context, constraints, approach, success criteria, relevant
paths, and exclusions. Never refer to “above”, “as discussed”, or an unstated plan.

**Write the property, not the answer you derived by hand.** A figure you measured is measured in
your environment, not the run's, and a brief that states it converts a check the run could perform
into a fact it must accept. State what must be true and require the run to establish it in the
target. Supply your figure only as a cross-check, alongside the anti-anchoring fields, so a
disagreement surfaces instead of being reconciled silently.

Follow the [canonical brief and file contract](https://github.com/cuibuaa/flow-crew/blob/main/guide/brief-contract.md)
for frontmatter, research/program loops, Reality checks, approvals, verdicts, and terminal artifacts.
Do not duplicate those schemas here.

Declare every source input in a leading frontmatter `inputs:` block. A path in prose or a table is
only a reference, not a declaration; declare gitignored inputs there so setup can link and verify them.

The planner owns planner-created stages. Its hard rules reserve every declared terminal path for the
status-committing final stage and give any gate that may write tests, probes, snapshots, reports, or
generated output a complete writable scope. Preflight/rehearsal still lint explicit writable mappings
in an authored staged brief and countable `stage_glob` floors.

Declare `terminal_states` only for an artifact whose appearance should end the entire run. Omit it
for an intermediate or mid-pipeline output, because declaring that path terminal would skip pending
verification and repair rather than preserve the intended pipeline.

Treat `min_wall_minutes` at or below 10 as an anti-instant-quit guard only. To prove enough work
happened, name substantive evidence files and their writers. A clock is not evidence, and a floor does
not make an earlier terminal writer safe.

For a survey or implementation, make every task-local criterion independent of a shared running total.
Require the complete relevant validation set discovered from project configuration, with direct exit
codes and totals; never read `$?` after a pipe.

Choose loop mode by decision structure, not keywords. Convergence to a known pass/fail outcome is
engineering; candidate generation where a supported ceiling is valid is research. Propose the mode and
ask the user—do not silently choose. Research requires the canonical `research:` frontmatter.

### 1.4 `rehearse`: exercise the exact contract

**Precondition — save before rehearsing:** Rehearse only after `docs/task_brief.md` exists. Run both
commands against those exact saved bytes, never against an unsaved draft or reconstructed text.

Run both commands against the exact saved bytes:

```bash
flowcrew ship-preflight --brief docs/task_brief.md
flowcrew rehearse docs/task_brief.md
```

Preflight exit 0 retains the fact-versus-judgment boundary from §1.1. Rehearsal exit 0 ending in
`✅ Contract ready` means the static contract and scripted scheduler exercise have no failures;
non-zero means fix the brief or environment and rerun. Rehearsal launches no model and does not prove
implementation or research quality.

Treat criterion-wording warnings, wall floors above 10, unassigned `stage_glob` evidence, and missing
writable mappings in an authored staged brief as blocking authoring errors. Review every other warning
and state why it is intentional. Show the complete report and exact digest. If any byte changes, rerun
both commands.

### 1.5 Confirm the digest, identity, and authority

**Precondition — request confirmation only after proof:** Ask only after the brief file exists and
successful rehearsal has emitted its exact digest. The human confirms the bytes identified by that
digest, which is impossible before the file exists and rehearsal identifies it.

Show the final brief, complete preflight/rehearsal reports, and these exact choices:

- source project, target worktree, new branch, and base ref;
- workflow/mode, adapter, supervision, foreground/background, campaign, and context policy;
- max iterations from `config/defaults.yaml` `default_max_iterations` (currently 5);
- stage timeout from `config/defaults.yaml` `default_timeout_ms` (currently 60 minutes);
- every retained warning and its risk; and
- execution authority: workers run unattended shell commands with normal approval, permission, and
  sandbox prompts bypassed. The project is an intended work scope, not a host security boundary. Use
  a dedicated workspace or isolated environment and do not expose unrelated credentials.

Then ask:

> Rehearsal reported the findings above. Start this exact brief digest `<digest>` with these settings?

Wait for a new explicit answer. Do not treat the original `/ship` request or an earlier “ship it” as
this answer. If the user changes the brief or settings, update the file, rerun preflight/rehearsal,
show the new digest, and ask again. Only the answer after the last content change authorizes launch
and, when required, the digest-valued acknowledgement flag.

### 1.6 `quick`: launch the approved bytes

**Precondition — launch only after digest-bound confirmation:** Launch only after a new explicit
confirmation given against the exact rehearsal digest and unchanged settings. If any brief byte or
setting changes, return to saved-brief preflight, rehearsal, digest display, and confirmation.
Do not invoke `quick` for any purpose—not even `--help`, capability inspection, or another probe—
before that digest-bound confirmation.

After confirmation, run setup with the approved identity and absolute brief path. Proceed only on
`Ship setup: READY`. For the default background launch, `flowcrew daemon status` exits 0 when fresh,
1 when no listener exists, and 2 when stale or unverified. Start the daemon after 1 and fall back to
foreground only if that confirmed start fails; status 2 is an inspect/rebuild/restart blocker. An
explicit `--foreground` selection skips the daemon probe.

Launch by stdin so trailing newlines—and therefore the reviewed digest—are preserved:

```bash
flowcrew quick --background --project <target> --supervise - < docs/task_brief.md
flowcrew quick --project <target> --supervise - < docs/task_brief.md
```

Add `--acknowledge-brief-warnings=<digest>` only after the consent in §1.5. Add the confirmed campaign,
context, workflow, or adapter flags as needed. Keep project execution limits in `config/defaults.yaml`
unless the user explicitly changes the shared configuration.

`quick` always re-inspects the submitted bytes. Consequential unacknowledged findings or a digest
mismatch refuse before launch. A zero background exit means registration succeeded, not that the run
passed; capture the `Task #<id> registered` id. A foreground command blocks and its run id, terminal
status, and exit code must be reported. Any non-zero launch or run exit is evidence to inspect, not an
acceptance verdict.

After any successful launch, use the front-end's persistent session task mechanism and record this
exact sentence, replacing `<id>` with the registered task id:
`FlowCrew task <id> is registered; wrap-up remains: read the result, verify it independently, archive unique output, and reclaim the worktree and branch.`
After cancellation, update or remove that entry. After re-shipping, replace its id with the new one.
Record the exact brief digest and the governing baseline's failing identities beside it, so a later
failure can be attributed without re-deriving them. Creating the entry is prompted by the launch;
keeping it true is prompted by nothing, which is why an entry naming a cancelled id outlives the run
it described. Close it when the wrap-up above is finished, not when the run reaches a terminal
status — the run ending is what starts the work of accepting it.

A launch you deliberately hold back has no launch to prompt the entry. When rehearsal has produced a
digest you intend to use later — because a prerequisite round must land first, or because data must
still accrue — record the entry at that point, carrying the digest, the precondition, and the
baseline you measured, and mark it blocked by the task it waits on so the dependency is visible to
the watcher rather than only to you. Work waiting on elapsed time needs this most, because no event
will arrive to prompt it.

Report the actual mode and settings. For background work, give `flowcrew task list`,
`flowcrew task show <id>`, `flowcrew task cancel <id>`, and `flowcrew watch`; do not claim daemon
ownership for a foreground run. `quick` starts work—it does not prove the deliverable.

### 1.7 `watch`: observe stalls without changing state

**Precondition — watch only after registration:** Start watching only after a successful launch has
returned a `Task #<id> registered` identity; do not invent an id after a refusal or failed launch.

Use `flowcrew watch` for a first-pass heartbeat and edge-triggered alerts, or `flowcrew watch --once`
for one deterministic scan. `--once` exits 0 after a completed scan; invalid options exit 1. Continuous
mode runs until stopped. The command is read-only: it does not write run or task status, decide whether
human wrap-up is complete, or turn a terminal status into acceptance.

## 2. Verification procedures and bars

### 2.1 Write criteria a gate cannot misread

- State the property to prove, not the instrument to use. Mark examples as examples, including a final
  note that parenthetical material is illustrative rather than a criterion.
- If an exact means really is required, say that the precise path/API/format is itself the criterion and
  alternatives are not accepted. Otherwise avoid “must contain/call” wording.
- Put boundaries, counter-examples, and unacceptable outcomes in the brief. `flowcrew guide` is for a
  fact the executor cannot obtain or correction of the operator's error, not delayed scope. Repeated
  engineering guidance is evidence the brief was incomplete; research loops are different because
  steering on intermediate evidence is their purpose.

Guidance is a request, not an effect. It reaches a stage on the supervisor's next tick, which may
be after that stage has already acted, and a stage can be overruled by an earlier instruction or by
a scope the engine enforces mechanically. Check the artifact you asked to change rather than the
fact that you sent the message: a correction that silently did not land looks exactly like one that
was ignored on purpose.

### 2.2 Demand decision-grade evidence

- For a stateful defect, reproduce it on the unfixed code, then prove the fix changes the result. For a
  probabilistic defect, compare a failure *rate* before and after. For a guard or mutation, isolate a case
  where only that guard protects the behavior.
- Name the repository's reproducible runtime selector. A failed launch, build, test, or lint is an
  environment fact, never a domain finding.
- Decide an input's lifetime before teardown. If it is the only copy of something a later consumer needs,
  preserve it in a documented durable location and bind useful row-count, date-span, file-count, or hash
  assertions for preflight/setup to verify.
- When supplying an expected number, require both `within_expected_range` and
  `method_was_not_adjusted_to_match_expectation`; without the second field, agreement may be anchoring.
- Before freezing a pre-registered rule, compute its expected qualifying-member count from structural
  quantities, set a numeric feasibility floor, and revise below that floor before outcomes are seen.
- For a shared accumulating record, require append/no restructure and a line count to be non-decreasing.
  Permit an in-place, visibly traced correction of the task's own bad claim.
- For every census item, state its user-visible consequence. Classify entries with none as drift and say
  why they are or are not worth fixing; do not automatically turn a count into a zero-target.
- Every headline statistic must carry its mean, median, and location in its own distribution. Every
  aggregate must also carry its distribution for both result and baseline: per-item contribution,
  largest share, leave-one-out, and the smallest number of highest-contributing items whose removal flips
  the conclusion.

### 2.3 Accept a run independently

The terminal status is **not** the acceptance verdict. Read the durable `<run dir>/.reality-gate.json`
and the actual deliverables. Reproduce the failing declaration independently; for an executed script,
rerun its recorded command verbatim with full stdout/stderr and its direct exit code.

A green rerun only makes a false negative plausible. Repeat enough to characterize recurrence,
identify the first failure's mechanism, and assess residual uncertainty against task risk. Distinguish
an execution failure from a verdict: a near-instant, zero-token attempt calls for inspecting its
`live.log` and adapter transition before treating it as substantive evidence.

Before reporting a decision-changing number, ask what the probe returns when it is broken. If the answer
is something plausible, verify it a second way. Prefer structured parsing to lossy shell pipelines.

### 2.4 A conclusion you did not derive arrives without its evidence

Relaying what a subagent, a report, or an earlier document concluded preserves its confident tone
and drops the chain that earned it. State whose conclusion it is, or re-establish it yourself before
adopting it — the version that collapses under one question was never yours to assert.

The same discipline applies to explanations you reach for. **"Flaky" is an observation awaiting a
cause, not a cause.** A second failure of the same family obliges you to look for a shared external
variable rather than label it again; the fastest way to find one is a controlled comparison that
changes a single condition. Three separate flaky labels in one session turned out to be one
mechanism, and each label had ended the investigation that would have found it.

### 2.5 Review the deciding artifact and mechanism

For a UI, generated report, document, or CLI output, inspect the actual rendered, served, or readable
artifact—not only source and metric totals. Match environment to property: use the real served path for
latency, authentication, caching, and integration; deterministic headless rendering is enough only for
rendering properties.

When a result surprises you, inspect the deciding code, query, formula, protocol, instrument setting,
rubric, predicate, or other mechanism before theorizing. Also prove an experiment actually varied the
variable it claims to test.

### 2.6 Divide ownership by whether failure announces itself

FlowCrew's research loop explores within the question in the brief; the operator changes the question.
The split is not mechanical work versus judgement. Ask whether the failure announces itself or returns
a plausible value. Announcing failures—missing inputs, impossible counts, mismatched bytes, contradicted
claims—belong in commands and gates. Plausible values can still answer the wrong framing, so the operator
must expose assumptions, challenge the question, and judge the result independently. The boundary moves:
after a check reliably forces an operator error into the open, that failure belongs on the machine side.

### 2.7 Archive, reclaim, and stop safely

Read and independently verify the result, archive unique output, stop any watcher you started, then
inspect committed, modified, untracked, and ignored state before removing a disposable worktree/branch:

```bash
git -C <worktree> status --short --untracked-files=all
git -C <worktree> ls-files --others --ignored --exclude-standard
git -C <mainrepo> log --oneline <main>..<branch>
git -C <mainrepo> worktree remove <path>
git -C <mainrepo> worktree prune
git -C <mainrepo> branch -d <branch>
```

If non-force removal refuses, investigate. Archive failed or invalid results unchanged with an
`INVALID.md` or `SUPERSEDED.md` marker explaining the defect.

Do not edit a project while its run is active; scope attribution can restore the edit as an unauthorized
stage write. Permanent machine-independent tests belong in the tracked specification suite. One-off,
networked, browser-dependent, or host-specific harnesses belong under the operating-system temporary
root or the run directory. The scheduler owns one-active-run and scope behavior; status commands own
freshness. The operator still owns acceptance and cleanup.

If `flowcrew` is unavailable, stop and provide:
`git clone https://github.com/cuibuaa/flow-crew.git && cd flow-crew && npm install && npm link`.
