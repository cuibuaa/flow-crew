# Changelog

## [0.8.5] - 2026-09-04

A day of watching the engine run for real — a seventeen-hour research campaign and an
implementation batch, each with the daemon, supervisor, and gates in the loop — produced a
review of eighteen behaviours that wasted the operator's hours. Seventeen are changed here,
one is deliberately declined, and each change carries a replay that fails on 0.8.4 and passes
now. Two engine fixes that preceded the batch are included, as is one configuration change.
No new brief syntax.

### Fixed — a supervisor rejection built from two different attempts

When a gate attempt failed and the engine retried it, the retry started with a placeholder
metric file while the previous attempt's closing words were still the tail of the shared live
log. The supervisor read both, concluded the stage was contradicting itself, and its rejection
was then applied to the retry's correct output; repairs chased a phantom for two hours.
Supervisor evidence is now bound to the attempt it observed, and a rejection whose target has
moved on is dropped rather than applied.

### Fixed — scope revisions that vanished, stalled, or flooded the log

A revision request carrying the wrong attempt index was silently ignored, so the agent waited
for a decision that never came; a scope accepted in one attempt was forgotten by the next, so a
repair that reused it was rolled back as a violation; and the contract told the agent to wait
without saying how. Every request now receives a decision file, accepted scope survives into the
next attempt of the same stage, the contract names the attempt and the wait, and a stale
request is logged once — not on every twenty-millisecond poll, which had filled a task log to
168 MB.

### Fixed — tests pinned to the round that wrote them

Research rounds kept writing verifiers that asserted the shared result file named their own
round, true when written and false as soon as the next round succeeded, so every round repaired
the previous round's test. The rule reached only the planner and a post-hoc guard that missed
assertions of the shared artifact's existence. The temporal-test contract now reaches the stage
that writes tests, with the resolved paths, and the guard covers existence assertions.

### Fixed — a crash at the terminal gate left the daemon waiting forever

A scheduler that died between writing its terminal artifact and committing the run status left
the run marked running with no process behind it, and the daemon deferred on it every thirty
seconds indefinitely. The daemon now reconciles a dead scheduler against a non-terminal run
under the task's retry policy. The crash itself came from a rebuild deleting `dist` under a
live scheduler that loaded its reality-gate checks lazily; the build is now atomic through a
manifest, the checks are registered statically, and a build warns when it would touch a
deployed `dist`.

### Fixed — research conditions copied into non-research runs

A `research.*` dispatch condition copied into a run with no research block was admitted,
evaluated false forever, skipped the terminal owner, and ended a run `incomplete` with its
correct report on disk while the failure reason named neither cause nor remedy. Admission now
rejects the condition, and a skipped stage records why.

### Changed — the operator can see what a run is doing

`task list` shows the run, the current stage and attempt, and elapsed time; `task show` renders
the stage table, the last rejection reason, the current guidance, and pending scope requests
instead of hundreds of kilobytes of raw tick JSON; `status` carries a Now line. The run event
log is the canonical feed — guidance, attempt failures, scope decisions, admission rejections,
and status changes are emitted, every stage-scoped event carries its stage id, and a follow mode
streams them as JSON lines. `ship-preflight` announces each baseline command with elapsed time,
can skip the baseline, and warns when a live run shares the project. Help exits are consistent,
`watch` no longer reports test fixtures as unreadable runs, deadline journals and empty outputs
say what they are, and the three meanings of "attempt" are named apart.

### Changed — engine overhead no longer scales with the project tree

Every attempt walked the whole project tree twice and hashed every file once more, regardless
of the declared scope — about a minute per attempt on a 9p-mounted project, three times per
gate re-evaluation round. Snapshots are now scoped, shared between the closing walk and the
next opening one, and a large file contributes its size and mtime rather than its bytes. The
codex reasoning-effort diagnosis is remembered for the run instead of failing once per stage;
the supervisor's static goal is placed where the provider caches it, its elapsed clock is the
attempt's, and a tick with nothing new skips the call; the task registry no longer appends an
unchanged record every tick and readers no longer re-parse its whole history; two
twenty-millisecond polling loops watch the filesystem instead; the run state file is compact.

### Changed — the test suite runs in under a minute

The worker cap that assumed a 9p checkout is gone in favour of the machine's CPU count; the
fixed 300 ms sleep at the end of every spec file is replaced by flushing the pending refresh;
specs that execute `dist` assert its freshness instead of passing against a stale build; the
heap-bound child fixtures run with headroom and assert the signal they die by; and CI cancels
superseded runs and times out stuck ones. Measured on the same machine against the 0.8.4 suite,
the wall time fell by 41.8% at the median with no test identity regressing.

### Declined — rewriting a plan's mutable result path automatically

A fresh research campaign's first plan is still rejected when a hard reality check references
the optional numeric result path, which a valid no-candidate round never writes. Rewriting it to
the framework manifest automatically would admit a check whose producer is not guaranteed, so
the fail-closed admission stays; the rejection now carries the resolved rule and the remedy, and
the planner is told the rule with the resolved paths before it plans.

### Fixed — plan retries ratchet

A rejected plan's retry could repair one admission requirement while losing another it had
already satisfied, and oscillate. A requirement once satisfied is now held across retries while
the remaining ones are repaired.

### Fixed — a fresh campaign directory is plannable

Two admission rules pointed at each other for a campaign directory that did not exist yet: one
demanded the framework-emitted manifest instead of the mutable result path, the other refused
the manifest because nothing owned it. The framework's manifest emitter is now credited for
fresh directories; a path nothing will ever write is still rejected.

### Changed — the validation-command timeout comes from project configuration

`ship-setup` runs a project's build, test, and lint twice, and a project's suite grows as
research rounds add tests; the hardcoded fifteen-minute limit refused baselines and named the
timeout rather than the load. The limit is `default_validation_timeout_ms` in
`config/defaults.yaml` (forty-five minutes here), and the stage timeout `default_timeout_ms`
rises from one hour to three.

## [0.8.4] - 2026-09-01

Five fixes, all found by watching real runs on the day 0.8.3 went live. Four repair the engine's
own new admission and settlement machinery where practice disagreed with it; one makes a spec
independent of operator-tuned configuration. No new commands.

### Fixed — a task display that let a dead wait look alive

An entry recording "waiting on task N" stayed ordinary-looking for days after task N ended, and
whether it carried a run annotation at all depended on whether a task id happened to be persisted.
Entries are now linked deterministically, and an open entry whose referenced run has ended renders
with an explicit wrap-up-overdue marker and the run's terminal status, counted in the header. The
ship workflow records the task id explicitly at launch.

### Fixed — an admission that rejected what the planner emits

The 0.8.3 dispatch admission rejected sound shapes: a three-writer terminal topology with one path
per writer, narrow eligibility conditions expressing the same guarantee as the demanded literal,
and criteria owned by the terminal stage. Retries repeated the identical rejection without ever
showing the planner why. Recoverable shapes now admit, the two protected rejections — a measuring
stage owning a terminal path, and continue releasing a terminal write — keep their red tests, and
a rejected plan's retry receives the exact archived errors and converges or stops after bounded
identical refusals, with every rejected proposal quarantined durably.

### Fixed — code mistaken for paths

The admission's literal-path extraction claimed identifiers inside embedded check scripts as
project paths needing owners: property accesses, standard-library calls, even bare numerals. Plans
carrying ordinary node or shell reality checks were rejected for phantom paths across two
unrelated projects. Extraction now distinguishes a path from a token of code, on both sides of the
boundary, and a check that genuinely requires an artifact before its writer runs is still refused.

### Fixed — a finished campaign that could not say so

Three defects interacted so that a campaign whose stop condition had fired could burn its
remaining plan attempts and end failed with its ceiling report already on disk: gate pass was
conflated with beating the metric, which a ceiling by definition does not; settlement-only
iterations were held to work-iteration criteria coverage; and every recomposition of an
already-admitted reality check mangled its escaping. A verified losing ceiling now settles, a
winning metric cannot be labeled a ceiling, and admitted checks are reused byte-for-byte instead
of recomposed.

### Fixed — a spec whose budget moved with operator configuration

The negotiation spec asserted absolute retry budgets inherited from the repository's own
config/defaults.yaml, so retuning that operator-owned file failed two tests that had nothing to do
with the change. The spec now seeds its own default and asserts the doubling rule against it.

## [0.8.3] - 2026-08-31

Thirteen failure classes observed across a day of real runs, each reproduced before it was changed.
No public CLI command changed. Two compatibility tightenings are called out at the end.

### Fixed — instructions addressed to one stage reaching another

Supervisor and operator guidance was appended to a single run-level file and copied whole into every
stage. A stage told to finalize a plan handoff received that instruction while it was supposed to be
implementing a research round; it complied, finished in eighty-eight seconds, and reported that it
had implemented nothing. Guidance is now a framed envelope carrying an explicit stage target, and a
stage receives only entries addressed to it or to the run.

### Fixed — gates that only a later stage could satisfy

A reality check declared at planning time required exactly one terminal report to exist, while the
only stage allowed to write one ran after the check. Verification and repair cycled four times
against it. A measuring stage that also owned the terminal paths ended its own campaign after one
round of a twelve-round budget, skipping its audit. An iterative finalizer told to write exactly one
terminal artifact wrote an escalation for a campaign whose own audit said continue. Terminal
ownership is now admitted before work starts: one owner, downstream of every mandatory stage, and a
continuing campaign releases no terminal path.

### Fixed — criteria and evidence that quietly went missing

A numbered brief criterion could vanish between the brief and the stage that had to honour it.
Criteria now carry stable identities bound to the admitted brief digest, and a dispatch that leaves
one uncovered is rejected. Generated round tests that pinned a shared campaign file to one round, or
required a terminal artifact to stay absent, made a legitimate campaign close look like a failure;
those patterns are now rejected at attribution. A round with no acting candidate had no honest value
for a two-field result file, so it now records a sidecar with explicit provenance instead of a zero
indistinguishable from the baseline.

### Fixed — blockage and quiet work that nothing counted

Identical blockage recurred for iterations without escalating, because no durable mechanism
fingerprinted the cause. A long command whose output was fully redirected was killed as idle by the
Codex adapter's watchdog, which could see neither adapter output nor stage artifacts. Both are now
observable: repeated identical causes escalate, and an active structured command suppresses idle
inference without weakening deadlines.

### Changed — guidance is steering, not a new contract

`skills/ship.md` and the brief contract now state that mid-run guidance may clarify or repair a
property but cannot erase a criterion, widen authority, substitute a named result, or invalidate a
better conforming result. A real contract change requires new brief bytes and a fresh rehearsal.

### Compatibility

Malformed dynamic dispatch is refused rather than accepted. A non-empty existing target for a
declared create-only output blocks preflight, rehearsal and setup unless it is declared as input or
given an explicit disposition. Both refusals are intentional: each corresponds to a defect above
that reached a run because nothing checked.

## [0.8.2] - 2026-08-29

No product source changed in this release. It repairs how the suite decides, and how a brief hands
work over.

### Fixed — a suite whose verdict depended on how fast the machine ran it

A concurrency regression failed on a macOS runner and passed on a rerun of the same tree. The helper
it failed in waited five wall-clock seconds for a spawned Node process to write a readiness file,
which is a bet on machine speed rather than an assertion about the behaviour under test.

- **Thirty-seven cases carried that shape and now wait on events.** Enumerating every collected test
  found budgets a loaded runner can exceed and, more damagingly, path selectors: a fixed sleep of
  250 ms, and others at 10, 15, 30 and 900 ms, after which the test branched on whichever party
  happened to be ready. Those do not merely fail intermittently — they send fast and slow machines
  down different code paths, so a green run on one does not say what a green run on the other said.
  A shared `waitForPathEvent` helper observes atomic filesystem publication and checks on both sides
  of watch installation, closing the usual check/subscription race.

- **Forty-two cases remain intrinsically timed and say so.** Elapsed time is part of what they
  assert. Each is listed with the budget it needs and why it needs it, so the distinction between a
  necessary clock and an accidental one is visible rather than assumed.

- **Every changed case carries three pieces of evidence:** it passes intact, it fails when the
  production behaviour it guards is mutated, and it still passes under deliberate delay. The suite
  goes in and comes out at 171 files and 1,851 cases with four skipped.

### Changed — the `ship` skill asks what the run must find, not what you already concluded

Every constraint a brief states is treated as settled, including the ones its author did not know
they were stating. Naming the attributes of a problem closed the one that was never listed; naming a
prior report closed the modules sitting beside it; carrying a baseline forward as a number carried it
without the fact that nothing had to beat it; obeying a minimum update count left the batch size it
depended on unmentioned and unchanged. None of those exclusions were written down — each was inferred
from what the brief chose to enumerate.

- The section no longer asks for the approach. It asks for the outcome, the paths where evidence
  lives, the constraints that are real, and what the report must show.
- A summary the author writes is a claim the author asserts, so a prior artifact is pointed at rather
  than compressed; where a figure must appear, it appears as a cross-check with the anti-anchoring
  fields rather than as a premise.
- The anti-anchoring rule now covers configured values, which is where it was being skipped: a
  baseline asserts what a result must beat and can be wrong the way a measurement can.
- Criteria fix how a result is produced and shown rather than what it must be, each pinned to a
  moment — after the last write, not at some point.
- A path-shaped string in prose costs something whether the path exists or not: absent, preflight
  demands it; present, setup wants to overlay the working copy of it. An `Out of scope` heading is
  not an exemption.

Two tests come with it, both independent of the wording, because the guidance itself is a hypothesis
and a rule asserted into a test is harder to remove than to keep. Section cross-references must
resolve, since renumbering is otherwise silent. The revision stamp is pinned to a digest of the
guidance it describes, so an edit that leaves the stamp behind — and therefore leaves installed
copies reporting themselves current while carrying different guidance — fails instead of passing.

## [0.8.1] - 2026-08-28

**Breaking:** an unrecognised `research.policy` is refused instead of being silently coerced to
`greedy_stack`. A brief that names a policy which does not exist — a typo, or a value invented for
the occasion — used to launch anyway under a default nobody chose, and the run then behaved
correctly for a question nobody asked. A campaign was lost to exactly that: its brief named
`heuristic_policy_v1`, got `greedy_stack`, and no warning was emitted anywhere. Fix the value, or
keep the default deliberately by omitting the field.

This ships as a patch because what it refuses was never valid: a brief naming a policy that exists
is unaffected, and a brief naming one that does not was already running under a policy nobody chose.
Nothing else in this release changes an existing behaviour — the ledger below is a new command that
no current workflow touches.

### Added — a durable record of what a session still owes

A session accumulates obligations it must come back to: a launch to verify, a worktree to reclaim,
a finding to act on. Until now it carried them only in whatever its transcript happened to
preserve, which is to say it lost them. `flowcrew fc_tasks` gives that record a home outside the
conversation — entries created and patched by the CLI, rendered in the terminal, and repaired by a
tool built for the job when a write leaves one damaged.

- An update changes one field without the caller resending the whole entry. A caller obliged to
  resend everything in order to change a subject will eventually resend something stale.
- A damaged ledger is repaired rather than discarded, because the entries in it are the reason it
  exists.
- Every write publishes through a temporary file and a rename, so a reader never observes a
  half-written entry.

### Fixed — an acknowledged write that could not survive the crash it claimed to

The ledger above shipped with defects an independent review then found. Auditing the same diff a
second time found more, implementing the fixes found more still, and the gate that verified them
reproduced seven the implementation had missed: thirty-nine in total, each reproduced on unmodified
code before being fixed, each carrying a regression that fails on the pre-fix tree and passes after.

- **Success was reported before durability was established.** `fsyncDirectory` swallowed every
  error, so a directory flush returning `ENOSPC` or `EIO` still returned success to a caller that
  had already been told its entry was safe. A first create flushed only the child session directory
  and never the parent that had just acquired its entry, so a crash could lose the whole
  acknowledged session while the child flush reported fine.
- **Two updates to the same entry both succeeded and one of them vanished.** Each read the original
  record, each published with an unconditional rename, and no version check or shared lock sat
  between the read and the publication. The later writer's stale snapshot won, and the earlier
  writer had already been told its patch was durable.
- **A write that reported success left the ledger unreadable.** The scan limit rejected only a count
  *greater* than the maximum, so the entry that landed exactly on the limit was accepted — and the
  next default read, seeing one more file than it would scan, refused the ledger to renderers and
  writers alike.
- **An over-budget attempt was persisted as complete.** An adapter doing synchronous work across its
  deadline starved the timer that was supposed to enforce it; the resolved promise settled first,
  the still-pending timer was cleared on the way out, and exit zero was accepted. Three further
  settlement paths — a late rejection, an abort during starvation, and an abort between the deadline
  signal and the child's exit — each reported a different wrong cause or code.
- **Untrusted names reached places that trusted them.** The exported reader followed `..` out of its
  store root; a ledger filename could carry terminal control sequences into refusal output; a
  session directory swapped between the check and the open let an acknowledged create write outside
  its target; and the static scan's walk-before-filter let an excluded symlink either fail the gate
  or leave the project.

### Fixed — two adjacent claims that were true only by accident

- **A write conflict was claimed when only one stage had reported.** Parallel dispatch treated a
  single structured report as evidence of a collision, so a stage that wrote nothing could be told
  it had raced. The claim now requires both sides to have reported their writes.
- **A terminated attempt was killed before it could clean up.** Termination gave no window for the
  adapter to release what it held, so a cancelled run left its temporary state behind. The attempt
  now gets a bounded chance to finish cleanly before the process group goes.

## [0.8.0] - 2026-08-15

**Breaking:** `timeout_ms` and `timeout_total_ms` are no longer accepted in a brief's stage
frontmatter. A brief carrying either is refused with the migration in the message: stage duration is
governed by `config/defaults.yaml::default_timeout_ms` and nowhere else. This is the only change in
this release that requires editing an existing file.

### Fixed — a baseline that recorded a failure but could not name it

The validation baseline exists so a later failure can be attributed to the round or to the base it
started from. It was recording that a test command failed while leaving *which* tests failed
unknown, which makes the attribution it was built for impossible.

- **The failure extractor never saw the shape its own runners emit.** It recognised a `FAIL`-prefixed
  name, a cross-marked name, and a compiler diagnostic — and not TAP, which is what `node --test`
  produces. The count patterns all expected the number before the word, so `# fail 10` matched
  nothing either. The gap survived because this repository's own suite emits one of the recognised
  shapes, so the engine could always identify its own baseline and never its users'. Separately, the
  extractor was handed the byte-bounded copy of the output while the unbounded text was still in
  hand. A shared TAP reader now serves both the failure path and the population path, facts are read
  from the raw output while only a bounded copy is stored, and an unresolved identity carries a
  recorded cause — no output, truncated by capture, structurally incomplete TAP, complete TAP with no
  failing record, or an unrecognised format — which reaches the ready record and the operator-visible
  gate line.

- **The repair above refused too broadly, and the next launch showed it.** An invalid TAP parse
  returned immediately, so a truncated buffer never reached the line-oriented adapters below it. A
  recorded baseline carried a `FAIL` line and an explicit count inside the bytes it had kept and
  reported the identity as unavailable — something the previous extractor would have found.
  Truncation is a sound reason to distrust TAP, whose plan and version lines describe a whole run; it
  is not a reason to distrust a line. Per-line adapters now run when the structural reader cannot
  conclude, and what they recover is marked partial: bytes were dropped, so the identifiers are a
  lower bound. Partial evidence is barred from the red-to-red comparison — when either side is
  partial the delta is unresolved with that reason, because a partial list treated as complete would
  let a genuinely new failure be dismissed as pre-existing.

- **A test's identity moved when an unrelated test was inserted before it.** Population parity built
  each identity from a top-level ordinal joined to a name, so inserting one test renamed every test
  after it, and a real launch was refused with the same test listed as both missing and extra.
  Identities are now name-local and position-independent, duplicate names stay distinguishable, and a
  target that legitimately carries more tests than its source is reported as source-plus-additions
  rather than as a wholesale mismatch.

- **"I cannot verify this" shared an exit with "I refuse."** Parity was resolved with per-runner
  knowledge, and a runner it did not recognise produced `unavailable`, wired straight to a refusal
  before any baseline ran. A project was unshippable for choosing Node's own test runner, which has
  no collect-only mode at all, so no branch of the existing shape could be written for it. Adding a
  branch for `node --test` would have been the wrong repair — enumerating runners is the same losing
  game as enumerating shell forms — so the model now separates verified, unverified and refused.

### Fixed — state the engine could describe but not decide

- **A run finished, said so, and stayed `running`.** Every stage complete, the supervisor's own
  verdict `DONE`, the declared terminal artifact present and declaring complete — and the lifecycle
  status unchanged until a human intervened. The divergence was not invisible: the watch surface
  printed it in plain words. It was recognised where it was displayed and nowhere that could act on
  it. Every site that decides on a run status now supplies a value per status through an exhaustive
  record, so adding a member fails the build at each of them until someone answers for it there —
  listing a case is no longer enough. `resolveRunStatus` gives the archive a boundary: raw text
  becomes either a known status carrying its lifecycle semantics or an explicit unknown that keeps
  the raw value and states why, so a padded or differently-cased spelling stays unknown instead of
  being normalised into a status nobody wrote. Closure is automatic but gated — it runs only through
  the scheduler's existing full terminal check, on a declared artifact that is unique, safe and
  fresh, because a wrong automatic transition would be worse than the stall it replaces.

- **A dependent was released although its producer had been skipped.** A research round lost its only
  measurement and still produced a terminal document: the measuring stage carried a dispatch-level
  condition on the preceding audit, the audit passed, and the stage was recorded skipped with zero
  retries anyway. A passing gate now leaves only its `retry_to` repair branch skipped, and a
  dependent whose producer was skipped or failed stays pending while the run ends incomplete. A run
  that stops with nothing is recoverable; a run that reports on nothing is not. A frozen-rule scan
  of 1,998 readable terminal workflows found the affected edge in exactly one — the run that
  surfaced it.

- **A re-plan deleted the records it was replacing.** A repeatedly-rejecting gate triggered a
  re-plan, and the re-plan removed every completed stage record before persisting the replacement
  graph. One stage's output was zero bytes after an hour of work whose repairs were on disk and
  verified; in a later run the stage that vanished was the audit that would have checked a lint now
  live in this engine. The defect does not destroy deliverables — it destroys the account of how they
  were produced, which is worse in the case where the account was the deliverable. Evidence is now
  captured before deletion, into iteration-qualified records.

- **Stage duration had more than one control.** Overrides in brief frontmatter competed with project
  configuration, so the answer to "how long may this stage run" depended on where you looked. There
  is now one control: `config/defaults.yaml::default_timeout_ms`. See the breaking note above.

### Changed — rules a correct task can actually satisfy

- **Four instances of one defect had accumulated: a rule whose judgement is right but whose
  expression admits no compliant answer.** The test that separates it from a merely strict rule is
  not whether the rule is correct but whether a correct task can satisfy it. The trigger was a
  Reality-Gate check whose verdict was a validation command's raw exit status while the recorded
  criterion for that role was no-regression over nine known failing identities — exit zero was
  unreachable, so the check could never pass on a repository whose suite is red. The class was
  repaired rather than the instance.

- **Three more rules had the right intent and a form that made them either impossible to obey or safe
  to ignore.** The safety clause forbidding agents to touch other run directories bound reading to
  writing, so a task authorising the run corpus as read-only evidence collided with it — and the
  collision was not theoretical: two stages quoted the clause as a prohibition and the first skipped
  an entire audit, reporting its central claim as unverifiable. The mutation ban is now absolute and
  stated separately; read authorisation never grants mutation authority. A rule that must be worked
  around teaches that rules are advisory, which costs more than the rule protected.

- **A brief could not declare feasibility without also declaring a metric loop it did not have.** The
  lint demanded a machine-readable `research.feasibility` model from any brief committing to a
  selection procedure before measuring, and the parser recognised the block holding that model only
  when a numeric baseline was present. A diagnostic round has no metric to beat, so its only routes
  were to invent a baseline or to delete the wording that made the lint fire. Feasibility now parses
  ahead of the baseline gate; the research loop stays gated on the numeric baseline exactly as
  before.

- **A project that never declared its validation could not be shipped to at all.** `ship-setup`
  discovered build, test and lint from project configuration and refused when it found none — right
  when a target's dependencies are missing, wrong when a project simply never declared them
  anywhere. A brief may now supply argv-shaped commands in its frontmatter, resolved role-by-role and
  fail-closed: project configuration governs a role it declares, a brief fills a role configuration
  leaves empty, and a conflict refuses.

- **The pre-registration lint could not tell a task's own commitment from a description of one.** It
  fired whenever the vocabulary appeared beside a rule-like noun, so a brief about the detector, a
  post-mortem, and a guide section explaining the requirement were indistinguishable from a brief
  that actually froze a rule. A later gap left the opposite hole: a commitment stated in a single
  sentence escaped while full-length historical briefs were still caught, making detection depend on
  how much surrounding text a brief happened to carry. Both are closed, measured across a full
  traversal of the historical brief corpus, and checks now report what they saw rather than only
  their verdict.

- **Reality-Gate checks are authored fresh every run and were reviewed by nothing.** The suite audit
  that removed 31 value-fastened assertions could not reach them, so the habit survived exactly where
  it decides whether a run may succeed: two correct rounds were marked `reality_gate_failed` by
  checks they had written about themselves. The planner rule meant to prevent this named two bad
  shapes rather than what makes them bad, and both failures were shapes the enumeration did not
  reach; it now states the criterion. Prose alone was already the instrument that failed, so
  generated checks are inspected after planning and before dispatch, with findings tiered by whether
  the declaration a check refers to can be read.

### Changed — what the watcher believes, and what the published project contains

- **A stall was reported at three stage attempts, and measurement says that is not a stall.** One
  verify stage reached attempt four while converging from seventeen failing tests to one; another hit
  attempt three with its second gate round clean. The attempt threshold is removed rather than
  raised, because the count was never the signal. What replaces it is directional and read from
  archived rejected verdicts: a gate whose metric moves away from its threshold across rounds is not
  converging, and one whose count is identical across two rounds has stopped progressing.
  Reconstructing that history also corrected an operator claim — the real series is seven with one
  regression, not eight with two.

- **The private verification tree is no longer part of the published project.** Nothing under it is
  tracked, the test config no longer collects it, and the only places that still name it are the
  ignore rules and two past changelog entries describing what was true when those versions shipped.
  Editing a past entry so it stops mentioning a path that existed then would falsify the record. The
  published suite now stands alone and names its subjects, and only the fixtures a published test
  actually reads are tracked.

- **A spec that a lost round had covered is guarded again.** The condition-fact resolution it
  verified had no other coverage after the work was destroyed by a bad commit, and is now specified
  independently of that history.

- **Conventions that lived only in one machine's memory now live in the procedure.** Memory is scoped
  per working directory, so rules recorded while working from one path were invisible to a session
  started from another — same skill, same person, different behaviour. Work of one kind belongs in
  one task, because the planner parallelises inside it better than a chain can be sequenced from
  outside. And a launch held back on purpose still needs its task entry at rehearsal time, carrying
  its precondition and measured baseline and marked blocked by what it waits on: creating the entry
  is prompted by the launch, so work waiting on elapsed time gets no prompt at all.

- **The README described what a run does without saying what the thing is.** The Atom Architecture is
  referenced throughout the source — P1 through P4, role atoms, the context primitive — and had no
  statement anywhere a reader would find it. It is now named in the tagline, the opening, and where
  the design is explained: a self-evolving multi-agent system built on execution primitives and a
  harness loop, whose engine stays task-agnostic because every task-specific rule lives in the brief
  and its declared checks rather than in the core.

## [0.7.0] - 2026-08-11

### Changed — the launch path is composed of tested commands instead of remembered steps

- **`ship-preflight`, `ship-setup`, `watch`, `land`, and `audit-report` replace steps an
  operator used to carry in their head.** The `ship` skill drops from 995 lines to 300, not by
  cutting content but by moving each rule to the layer that has ground truth: what a command
  can check, it checks; what the planner owns, the planner states; only judgement stays as
  prose. Both front ends now derive the same procedure from the same file — verified by
  running the real `claude` and `codex` CLIs against one brief and comparing their rehearsal
  digests, which had silently diverged: one front end was executing an older contract because
  it inferred execution order from heading order.

### Fixed — guards that refused for the wrong reason, or never refused at all

- **`land --remove` could not succeed on any repository that gitignores its build output.** It
  graded regenerable paths for display and then refused on the raw count, so fail-closed had
  become fail-always, and an operator who cannot use a guard removes worktrees by hand. Hand
  removal is what lost a 2,379-line generator. Removal now takes
  `--acknowledge-regenerable=<count>` matching the audited figure, re-derived at removal time
  so a stale number refuses; anything the grader could not prove regenerable still refuses
  unconditionally and cannot be acknowledged away. An injected probe found the complementary
  hole: ignored source directly beneath a dependency root graded as an installed dependency,
  so a correct acknowledgement authorised deleting it. It now grades as source.

- **`ship-setup` recorded the validation baseline before dependencies existed and printed
  `READY`.** All three roles exited 127, every gate degraded to "failed with an unparseable
  identity", and the headline said the workspace was ready. A guard that never fires is worse
  than one that always does, because nothing about the run looks wrong. A target that cannot
  run the project's own commands now refuses and writes no ready record.

- **Explicitly declared brief inputs could vanish without a message.** The heuristic that
  keeps prose scanning from treating ordinary words as paths was also applied to the explicit
  declaration list, where the key already states that the value is a path. A bare directory
  name was discarded silently. Declarations are now taken at their word, and an unresolvable
  one is reported as unresolved rather than dropped.

- **Ready records are keyed by what the brief says, not only where it lives.** Five
  consecutive invocations with different briefs produced a byte-identical record path, so
  nothing downstream could verify that the brief being launched was the brief that was
  baselined.

- **Terminal evaluation was inside `if (!failed)`, and an unmatched terminal persisted no
  conclusion at quiescence.** A settled batch could therefore leave no decision at all.
  Evaluation is now unconditional and records an explicit `incomplete` rather than silence: a
  run that cannot decide must say so. Both directions of status mismatch are surfaced without
  changing what the persisted lifecycle status means.

- **A launch target silently ran a smaller suite than its baseline was measured on.** Version
  control cannot populate an ignored directory in a fresh worktree, so a target held 150 of
  the source's 193 discoverable test files and every "full suite green" claim covered that
  smaller set. This is the same root cause 0.6.2 named and could not act on — a contract test
  living in `tests/`, gitignored, never running. Setup now completes the target and refuses,
  before recording a baseline, when it cannot.

- **A gate whose brief supplied no metric could reject a passing verdict indefinitely.** The
  implementation had nothing left to change while the repair loop kept running. The contract
  is stated at the planner layer and checked mechanically. Adversarial verification then found
  the guard could be bypassed outright: raw JSON `1e400` parses to `Infinity`, which satisfied
  a finite threshold. The candidate search filters on `Number.isFinite` before selecting a
  value, which closes all four sources — the original defect was a guard present on one path
  and absent from another, so the shared selector was the place to fix it.

### Changed — the test suite verifies properties instead of fastening onto values

- **An audit of every collected test module found 35 weak verification sites**: 20 overfit a
  fixture value, 8 guarded source text where behaviour was claimed, 5 policed style, and 2
  could not fail under any input. The proportions are the finding. Tautologies are the shape
  that is easy to grep for and they were rarest; the common defect is a well-formed assertion
  aimed at the wrong thing, which goes red when a fixture changes legitimately and stays green
  when the logic breaks in a way that preserves the number. Finding those required tracing a
  value's provenance across functions — the one that motivated the audit had its literal and
  its assertion 23 lines apart, in different functions, and no same-line search finds it.

  31 sites became relational or structural checks derived from what they test, each proved
  capable of failing through a transcribed red-then-green mutation. Exact values that are
  genuine contracts stayed exact rather than being loosened into range checks, which would
  have widened what passes. The 4 assertions removed without replacement are listed with the
  property now unguarded and why that is acceptable.

- **Documentation describes the surface instead of tallying it.** Counts of commands and
  statuses helped no reader decide anything and needed editing in three places on every
  addition. The CLI reference is now checked against the dispatcher's own command list, which
  cannot go stale and fails when a command goes undocumented.

## [0.6.2] - 2026-08-09

### Fixed — three defects found while running research tasks through the engine

- **A gate could be made unpassable by a naming difference between two files it wrote
  itself.** A gate wrote `verdict.metric = "failing_checks"` — its own health metric, zero
  checks failing — beside `metric.json.metric = "max_abs_train_spearman_to_vanilla_momentum"`,
  the domain metric its brief had asked it to report. Both files agreed the gate passed.
  `validateVerdictAgainstMetricFile` rejected the pair for the naming difference alone, so
  `readGateVerdict` returned `pass:false` for a file that said `pass:true` — every time, no
  matter what the stage did. On one run all four audits were rejected this way, fifteen times
  in the log; it escaped only when the three-round repair budget ran out, after ~2.5h of
  repair rounds that had nothing to repair. A rename is evidence of self-deception only when
  there is a failure for it to hide, so the check now also requires the metric file to
  indicate one — an explicit `pass: false`, or a numeric value missing its own threshold. The
  case the guard exists for, a failing domain metric replaced by a different passing one,
  still rejects. The violation now names both sides; it was a bare `metric name redefined`
  carrying neither, so the clash could not be diagnosed from the message.

  The repair stage was also handed the archived verdict as its "rejection evidence" — a file
  saying `pass:true` — with no way to see what the engine had objected to.
  `engine_verdict_<gate>.json` now records the engine's effective verdict and reason beside
  it, and the re-evaluation preamble points at it.

  This was never caught because its contract test lives in `tests/`, which is gitignored
  **and** outside the CI command. Every existing case sets `metric.pass === false`, which
  returns at the first branch and never reaches the name comparison, so the breaking
  combination was never constructed. One fixture even uses that exact clash but asserts null
  via the `phaseComplete` early return. That file now lives in `spec/`.

- **A run is no longer called stale just because it is quiet.** Both stale sites demoted a
  running campaign purely because neither `state.json` nor `iteration_log.jsonl` had been
  touched for 30 minutes. A single long stage — a fetch, a test suite, a research backtest —
  is silent for far longer than that while its scheduler works normally, so live runs were
  reported lost. Silence is now checked against the process holding the run: only a live
  process bound to *that* run suppresses the warning, so an absent, malformed or dead
  `scheduler.pid` still goes stale, and a recycled pid bound to a different run does not
  suppress. This deliberately does not reuse `hasLiveScheduler`, which guards
  `performStartupRecovery` rewriting a run to `failed` and must therefore over-report
  liveness; the two fail safe in opposite directions and must not be merged.

### Changed — the default campaign follows the repository, not the directory

- **Worktrees of one repository now share one campaign.** The default campaign name was
  `slug(basename(projectDir))`, so every linked git worktree got a campaign of its own and a
  single line of work split across as many campaigns as there were worktrees — auditing what
  a project had actually tried meant opening all of them. Any directory inside a repository
  now resolves to its main worktree.

  Two cases move: a linked worktree, and a subdirectory of a repository — `repo/src/deep`
  gave `deep` and now gives `repo`. **A checkout's own root, the common case, is unchanged**,
  as are an explicit `--campaign`, `defaults.yaml::campaign`, and any directory that is not a
  repository. If you have been running from worktrees, your next run lands in a campaign
  named for the repository rather than the worktree; the earlier campaign directories stay as
  they are. Inside a worktree `flowcrew quick` now prints which directory the name came from,
  since it no longer matches the one you are standing in.

## [0.6.1] - 2026-08-08

### Fixed — a 0.6.0 launch regression, and nullable fields in declared schemas

- **The agent runs under a login shell again.** v0.5.0 used `bash -lc`; v0.6.0 dropped the
  `-l` while the supervisor was rewritten around the portable shim. The systemd user
  manager's PATH does not include nvm or `~/.local/bin`, and only the login profile puts
  them there, so on a machine where `codex` or `claude` was plainly installed every
  background launch failed with *"No adapter CLI is installed or visible on PATH"*. `-lc` is
  accepted by `/bin/bash`, `/bin/sh` and `/bin/dash`, so this does not narrow which shells
  can host a run. Three CI axes missed it because a runner's PATH is already complete.

- **`type: [string, "null"]` in a declared schema can pass.** A union arrived as an array,
  which is truthy, so validation ran — but every type comparison then checked a string
  against an array and could not match, so a nullable field failed for *both* `null` and a
  string, i.e. always, regardless of content. The error read `expected string,null`, which
  was the array flattened by string interpolation. Unions now pass if any member matches, an
  empty union constrains nothing, and errors render as `string|null`. This affected both
  reality-gate `json-schema-match` checks and the research loop's per-round `result_schema`
  enforcement, so a brief that declared an optional reason field the standard way had its
  terminal state blocked by a false negative.

## [0.6.0] - 2026-08-07

### Changed — supervision no longer requires a service manager

- **A background run is owned by a portable shim, not by systemd.** Off a systemd user
  session — macOS, a container, a WSL2 install without systemd enabled — `flowcrew task
  cancel` could never confirm: `NodeSystemd.isActive` threw `ENOENT`, the catch discarded a
  *terminal* process-fallback record and returned the string `unverified:systemctl-error`,
  which was in neither `STOPPED_UNIT_STATES` nor the active set. The task pinned in
  `cancelling`, the daemon retried the same failing cancellation every 30s with no timeout
  and no route out, and cancelling an already-finished task wiped its terminal record. A
  small Node shim now owns each run and writes its exit status to disk atomically, so the
  outcome survives even the death of FlowCrew's own daemon — the one capability nothing in
  the Node supervisor ecosystem provides, because every one of them learns of an exit from
  an in-memory `child.on('exit')` in a live parent. Where a systemd user session exists it
  is still used for cgroup cleanup and tree-kill, but the recorded exit status, not systemd,
  is what the engine treats as truth.
- **Unit state is a closed six-member union.** The same string was previously read with
  opposite fail directions in two files, and a third, unimported copy of
  `STOPPED_UNIT_STATES` lived in `cancellation-client.ts` behind a `typeof x === 'string'`
  guard: once the state became an object that guard would have rejected every valid daemon
  response and silently re-run the coordinator inside the CLI — while still printing
  `Task #N cancelled` and exiting 0. `unitIsStopped` is now an exhaustive switch with a
  `never` check, so a seventh variant is a compile error rather than a silently pinned task.
- **`terminal-unknown` is a first-class outcome.** A `SIGKILL`ed shim records no exit status
  and may leave its agent alive, reparented. The engine does not round that to `failed`:
  the run ends marked unrecoverable and `flowcrew task cancel` refuses to report success.
- **Process identity is portable.** Linux keeps its exact `/proc` start-time token; Darwin
  binds by `ps -o lstart=` plus the recorded argv. `ps` is resolved absolutely rather than
  through `PATH` — a caller that strips service-manager tools from `PATH` must not thereby
  lose the ability to identify its own processes. On Linux this was invisible because procfs
  answers first; on macOS, where there is no procfs fallback, it broke everything downstream.

### Added — CI that can actually catch this class of defect

- **Three supervision axes, not one.** `quality` (systemd present), a new
  `no-service-manager` job that symlink-farms a `PATH` without `systemctl`/`systemd-run`/
  `journalctl`, and the existing blocking `macos` job (no procfs at all). Varying one axis
  silently pins the other at its Linux value, which is why every earlier "macOS is covered"
  claim was untestable. `macos-latest` is pinned to `macos-15`: GitHub's docs page and the
  runner-images README currently disagree about which release it points at.
- **Distribution jobs.** `npm pack` + global install exercising the documented first steps
  (the only way to catch a missing `files` entry, which no in-repo test can see), a cold
  `git clone` over HTTPS with a cold npm cache, and the four adapter-installation states.
  They run on `main` and `tests` pushes.
- **Verified on real hardware.** Darwin 24.6.0 arm64, GitHub run 31162993188, all ten jobs
  green. Every prior macOS claim in this repository was inferred from Linux.

### Fixed

- **A passing gate still dispatched a fix stage.** `gate_phase0` passing correctly skipped
  its fix stage; `gate_phase2` passing dispatched one anyway, which then re-ran the gate —
  about 24 minutes per occurrence.
- **`flowcrew status` and `/fc-status` are project-scoped.** They reported the most recent
  run on the whole machine, possibly belonging to an unrelated project.
- **The stage timeout had two sources of truth.** `config/defaults.yaml` said 60 minutes and
  the ship skill's confirmation message said 5, so a run driven by the skill timed out on
  the first attempt of every substantial stage. The skill no longer carries a number.
- **Replanning could drop an undone stage while the run still reported `complete`.**
- **A task title took the YAML frontmatter delimiter as its name**, so any brief with
  frontmatter was listed as `---`.
- **Two timing-sensitive specs made "CI is green" unreliable** as a judgement.
- **`flowcrew quick --background` registered a task without checking that an adapter CLI
  existed** to execute it: the submit path returned before the availability check.

### Changed — documentation states only what has been verified

- Three false platform claims removed; two known issues that this release fixes removed.
  Known issues is now defects only — a deliberate limitation is stated where the feature is
  described, so fixing a bug cannot silently rewrite a design decision.
- The README leads with what the tool does rather than with prerequisites; the value
  proposition moved from 31% depth to the first screen, and about 670 words of restatement
  and design rationale moved to `guide/` or were cut. A `spec/readme-contract.test.ts`
  pins the properties that cut relied on, including the passages that carry the project's
  voice, so a future trim cannot quietly remove them.
- Worked examples are labelled as illustrative shapes rather than transcripts: the one
  brief in the repository that runs as written is `examples/hello-research.brief.md`.

## [0.5.0] - 2026-08-06

### Added — absorbed from openworker (code-level comparison)

- **Approval inbox / park-and-resume.** A run that reaches a consequential action no longer has to choose between doing it autonomously and escalating (killing the run). A stage writes `<run_dir>/approval_request.json`; the engine records it in an append-only `<run_dir>/approvals.jsonl` and either auto-approves it via a standing rule or PARKS the run — new non-terminal `parked` status, process exits, project lock and daemon queue slot freed. `flowcrew inbox list|show|approve|deny|rules|revoke` resolves it and resumes the SAME runId, DAG and iteration. Idempotent on `(runId, requestId)`; **first resolution wins**, so two operators on two surfaces can never produce two decisions (append order is the arbiter — no lock, no read-modify-write). Standing rules ("always allow") are mintable ONLY for an `external`-risk action bound to an exact target; shell/write/untargeted actions ask every time.
- **Daemon queue policies.** Single-in-flight is now enforced at ADMISSION (`src/run-lock.ts`), not only inside a launched run: a busy project defers the task (`deferred` + `not_before` + reason) instead of launching into a conflict that the child would discover and die on. Deferring never consumes the retry budget; retries are queued with 30s-doubling backoff (capped 10 min) instead of relaunching inline; the tick sweep is reentrancy-guarded, drains the launch queue serially and polls running units concurrently; a catch-up sweep runs at daemon start and ADOPTS a queued task whose unit is already live rather than double-launching it.
- **Surgical param-fix retry** (`src/adapters/diagnose.ts`). When a failure's output tail names a fixable parameter — anchored on the attested `400 invalid_request` wire shape, not on guessed markers — the codex adapter retries once with exactly that parameter omitted (a dedicated sentinel, because `default` now *inherits* the global config that may be the source of the bad value), at most two distinct fixes. Timeouts and supervisor aborts are never "fixed". `RunResult.friendlyError` surfaces one actionable sentence instead of a bare exit code.

### Added — operator can now prove what the engine is doing

- **`flowcrew daemon status` / `restart` / `stop` / `logs`.** The orchestrator is `dist/cli.js daemon serve`; `flowcrew start` is the web dashboard. Nothing previously distinguished them, so a restart script matching the wrong name left a stale orchestrator running — for two days, silently, while every fix shipped in that window sat unloaded in `dist/` and a terminal run had its brief replayed against its own committed tree. The daemon now records a SHA-256 build identity at startup; `daemon status` reports the socket-owning pid, startup time, loaded build and registry health, and exits nonzero with `STALE` when `dist/` no longer matches what the process loaded. `daemon restart` resolves the listener from the Unix-socket inode in `/proc` — never from a command-line pattern — and refuses by default when a running task has no `run_id`, because such a task would have its brief replayed.
- **RPC responses carry the daemon pid and build**, so a registration can be attributed to a specific process rather than to "some daemon".
- **Public `spec/` suite and CI.** A clean clone previously failed `npm test` with "No test files found" while the PR template asked contributors to run it. `spec/` now carries the portable suite; CI runs the quality pipeline plus a second job that executes `spec/` in a container with `--network none`, a tmpfs `$HOME` (no `~/.fc`), and assertions that `codex` and `claude` are absent from `PATH` — the mechanical form of "if a test needs anything on your machine, it does not belong in `spec/`".
- **`guide/`** — run lifecycle (all 13 statuses, each marked terminal/successful and who writes it), approvals, rehearse, the brief contract, CLI, contributing.
- **`--campaign-context=inherit|skip`** replaces `--no-inherit-campaign` (kept as an alias). The two campaign flags act on independent dimensions — `--no-campaign` drops *attribution*, `--campaign-context=skip` keeps attribution and drops only *prior-phase context* — and the near-identical old names made that invisible.
- **Dashboard inbox consolidates everything waiting on a human**: approvals, deferred tasks with their reason and retry time, stale runs, and pending brief patches, with a real empty state.

### Fixed

- **Adapter selection stopped guessing, and stopped lying about the guess.** With no agent CLI installed, `flowcrew start` used to print `Auto-detected: claude` — because the detector had no way to express "none found" and fell back to a hardcoded name — and then silently rewrote the project's `defaults.yaml` on that false premise. Selection now lives in one place (`src/adapters/availability.ts`), the shipped template seeds the `auto` sentinel instead of a hardcoded `codex`, `flowcrew init` decides once and says why, `flowcrew doctor` diagnoses read-only, and the new `flowcrew adapter [auto|codex|claude]` is the one place that writes. Runtime paths never prompt and never write; with no CLI at all a launch now refuses with both real install commands instead of creating a run that dies at its first stage.
- **`npm i -g @anthropic/claude-code` does not exist.** Both places that printed it — including the last line before a hard exit — named a package that 404s; the correct `@anthropic-ai/claude-code` appeared nowhere in the repo. A test now pins every install hint to a real package name.
- **A failed run prints why it failed.** The cause and its fix were already computed and stored in `run.json`, then discarded before printing, leaving only `plan: failed`.
- **A YAML typo under `## Reality checks` no longer deletes every gate in silence.** A parse failure fell through to an empty check list, which is indistinguishable from "no checks were declared", so `rehearse` printed `Contract ready` and the run reached a terminal state with zero evidence checks. A parse failure is now a hard failure; a brief that declares no such section remains admissible, as before.
- **`flowcrew doctor` can no longer go green for someone else's checkout.** Its PATH check was a bare `which`, so any other install's `npm link` satisfied it; it now resolves through realpath and names the other install when they differ.
- **A brief containing a single quote could not be launched in the background.** The daemon rebuilt the relaunch command with the brief embedded as raw text, which survives neither `shellJoin` nor systemd's own `ExecStart` unescaping, so the relaunched CLI digested different bytes than the operator admitted and refused before creating a run. The brief now travels `--brief-input-base64`, the byte-safe channel the admission record already used.
- **The published package was missing the CLI's runtime inputs.** `files` omitted `skills/` (which is what `/ship` is), `examples/` (the brief the quickstart tells you to rehearse) and `guide/`. A test now pins the allowlist, and a second one derives the README's command total from the dispatch table so the two cannot drift.
- **A terminal run is no longer retried as a crash.** systemd reports only "the process exited nonzero", which cannot distinguish a crash from an engine verdict (`failed` / `reality_gate_failed` / `escalated` / `incomplete`). The daemon now pre-allocates the run identity before launch and settles a bound terminal run instead of replaying the brief — replaying meant re-running a brief against a tree the first attempt had already modified and committed.
- **Exit 127 with a command-not-found diagnostic is an environment defect, not a failed check.** A reality check that cannot execute provides no evidence that the requirement is unmet; three consecutive successful runs were failed by a check invoking `rg`, which is not installed here. A bare 127 without that diagnostic still fails hard.
- **An RPC timeout no longer claims the daemon is not running.** Connection failure and "written but unanswered" were collapsed into one message, so an operator who had in fact cancelled a task was told it never arrived — and repeated a destructive command.
- **Every dashboard path that starts work now honors project admission control.** `isProjectBusy` appeared zero times in the dashboard: approve, execute, rerun, stage rerun, gate re-evaluation and task creation each spawned a run while checking only that *this* task was idle, never whether the *project* was. All six now return 409 with no launch and no pre-mutation side effects.
- **A registry lock left by a killed writer no longer bricks task registration permanently.** Locks record owner pid, acquisition time and a token; a lock whose owner no longer exists is taken over with a warning, a live owner's lock is never stolen, and release only unlinks its own token. Previously a zero-byte leftover produced a bare `EEXIST` that reached no log — only the abandoned client socket.
- **Run-status semantics are derived from one vocabulary.** 143 status-literal comparisons across 14 files are now zero outside `store.ts`, with an AST gate that fails on any new one and names file:line. Adding `parked` had touched 11 files, missed two, and shipped two defects that executed a high-risk action twice.
- **A clean clone passes `npm test` again.** Four UI suites imported React through a hardcoded `../../ui/node_modules` path — available only after a separate install under `ui/` — so a fresh checkout failed at import time.

- `campaign.ts` read terminality as an inverted denylist, so any newly-added run status was misread as terminal and `pollRunCompletion` would fabricate an outcome from an unfinished run. Both it and `run-summary.ts` (whose hand-copied terminal set had already drifted) now derive from the engine's single source of truth.
- `terminal_states` frontmatter may now only declare a REAL terminal status. A brief could previously declare a non-terminal one and have it written into run.json *with* `completedAt` while every terminal guard reported false — an agent-reachable way to forge a run that no consumer treats as finished or alive.
- The supervisor ABORT poller was torn down after the first stage attempt, but the adapter-error backoff ladder (30s+60s+120s) and the cross-adapter fallback that follow are four more full-length agent runs: a stage in backoff was unkillable for minutes. The signal is now both passed to those attempts and kept live for them, and the backoff sleep checks it instead of sleeping on.
- The catch-all stage retry now preserves the failed attempt's `error`, so `buildRetryPreamble` can state the real cause; without it every non-timeout failure was announced to the agent as "timed out".

### Fixed — honest terminals, all exit doors (engine bugs #1-#7, found by live audit + wind-tunnel)

- **Confirm-fail no longer kills the research program.** A ship candidate that fails the brief's confirm gate is marked `confirmFailed`, excluded from kept/running-best (so the same unconfirmed number cannot re-trigger ship→confirm→fail forever), and the loop continues under the normal stop rules instead of terminating as a premature ceiling.
- **Ceiling floors are enforced on the research loop.** A `terminal_states.ceiling_hit.floor` (research semantics: measured rounds are the attempted stages) defers a premature policy ceiling while round/wall budget remains; forced commits under exhausted hard budgets are annotated honestly.
- **Engine-initiated terminals honor the declared artifact contract.** Research-loop, unified-gate, and budget-exhausted terminals all mirror the terminal report to the brief-declared `paths[0]` (never clobbering an agent-authored artifact) and set `terminalArtifact`.
- **Leftover pending stages are swept to `skipped`** (with the reason) on every terminal commit instead of freezing `pending` in run.json forever.
- **Terminal reality gate no longer false-blocks on the consumed round result.** The engine restores the last consumed `round_result.json` before running planner-authored checks that reference it.
- **Agent-authored `ship_report.md` can no longer bypass the confirm gate.** The unified terminal-state gate runs the same brief-declared confirm on a research run's `shipped` terminal file and rejects the artifact on failure (guidance hint, run continues).
- **codex adapter effort key fixed** (`model_reasoning_effort`, not the silently-ignored bare `reasoning_effort`) — effort pins never took effect before.

### Added

- **Model/effort inheritance.** `model: default` / `reasoning_effort: default` now resolve explicit pin → the user's global `~/.codex/config.toml` → CLI built-in default, so projects follow the user's own codex setup with zero per-project maintenance across CLI upgrades.
- **`flowcrew rehearse <brief.md>`** — pre-flight wind tunnel: runs the brief through the REAL scheduler against a scripted fake agent in an isolated temp project + temp FC home (seconds, zero tokens), validating the engine × brief contract: frontmatter, confirm wiring, stop rules vs ceiling floor, declared terminal paths, round-result plumbing. `--static-only`, `--keep`.
- **ScriptedAdapter** (`src/adapters/scripted.ts`) — deterministic per-stage playback adapter powering rehearse and the repo-local engine-scenario regression suite.
- **`FC_HOME` env / `setFcGlobalDir()`** — structural isolation of the global state root for tests and rehearsal (never write runs/campaign ledgers into the real `~/.fc`).
- Supervisor `reasoning_effort` is now a role default (`low`, overridable via `supervisor.reasoning_effort`) instead of inheriting the work-agent effort — an inherited global `max` would blow the 30s assess timeout and silently un-steer runs.

## [0.4.1] - 2026-07-10

### Changed

- **Bounded run-directory disk growth.** Each codex stage's `codex_home` — transient CLI cruft (~90 MB/stage, dominated by the `.tmp/plugins` git packs, ~99% of a run's on-disk size) — is now purged automatically when the stage **succeeds**, and **kept on failure/abort/timeout** for debugging (dropping only the already-checkpointed SQLite WAL/SHM). Previously it accumulated unboundedly, so `~/.fc/runs` could grow to hundreds of GB; it now stays at result-file scale (~KB per run). Extends the existing WAL-only cleanup — same automatic-cruft-cleanup category, no new config. `flowcrew clean --keep N` remains the manual escape hatch for pruning old run residue.

## [0.4.0] - 2026-07-05

FlowCrew 0.4.0 hardens the autonomous loop so that honesty becomes a property of the engine, not of the operator's diligence. It internalizes *verify-before-trust*, makes honest negatives first-class, adds self-remediation, and is validated across 6 task domains and 2 objective kinds (research `metric` and engineering `acceptance`).

### Highlights

- **Confirm-gate (verify-before-trust).** A brief-declared `research.confirm` command runs as an independent check before any `shipped` terminal; a candidate that beats the metric but fails confirmation is downgraded, not shipped. Generalizes the Reality-Gate mechanism to the ship path.
- **Honest terminal taxonomy.** Added a first-class `incomplete` status (budget-exhausted mid-search — distinct from a crash and from an honest ceiling); unified the terminal-status guard so honest negatives are never mislabeled `failed` or scored at baseline by the outer loop.
- **Anti-smoke integrity floors.** Brief-declared `research.integrity.field_floors` reject token/"smoke" rounds (e.g. `real_train_iters >= 150`) instead of banking them as results.
- **Self-remediation.** Planner failures (empty/invalid `dispatch.yaml`) now bounded-retry with a specific re-prompt instead of a fatal punt (`default_plan_stage_retries`); the supervisor gains a **REJECT** verdict to send an insufficient deliverable back for re-work (`default_supervisor_max_rejects`); a deterministic no-progress stage watchdog aborts stalled stages.
- **Fail-loud on degraded config.** A `workflow=research` run whose frontmatter fails to parse now fails loud (a `research_mode_degraded` event) instead of silently degrading to plain dispatch.
- **Observability precision.** Integrity-rejected round counts surface in the terminal report; run summaries derive their decision label from the true terminal status; a declared confirm-gate that is skipped on a non-ship terminal is recorded rather than silently dropped.
- **Literature scout + portfolio coverage.** The outer loop can expand its portfolio from web search before exploring, with a deterministic coverage floor and domain-ledger awareness to avoid re-proposing dead directions.
- **Regression-guarded.** The hardening above is developed against a task-agnostic engine-contract suite (policy, terminal/verdict, dispatch retry/reject, stall detection, confirm-gate).

## [0.2.0] - 2026-05-28

FlowCrew 0.2.0 is the first release positioned as a full agent workflow control plane rather than a browser-first alpha. It adds a Codex-default execution path, campaign memory, run knowledge graphs, deterministic Reality-Gate checks, supervisor steering, daemon/background task surfaces, and a rebuilt dashboard/documentation experience.

### Highlights

- **Codex-default execution**: project defaults now route agent stages through Codex by default, while still supporting Claude as a per-run or per-role override.
- **Recommended Claude Code -> Codex workflow**: README and skills now present the intended loop: discuss and shape the plan in Claude Code, then `/ship` the confirmed task to FlowCrew for Codex-backed execution.
- **Workspace dashboard redesign**: added workspace/campaign views, run detail pages, campaign KPIs, phase progress, run lists, brief revision panels, and knowledge graph panels.
- **Run Memory Graph**: added dashboard and documentation support for persisted goals, approaches, findings, insights, results, user hints, and dead ends.
- **Campaign intelligence**: added campaign iteration state, brief versioning, diagnosis/review surfaces, cross-campaign knowledge graph support, plateau/regression triggers, and research workflow policy support.
- **Reality-Gate framework**: added deterministic evidence checks that can block unsupported terminal success, plus an audit command for retrospective verification.
- **Supervisor and daemon runtime**: added supervisor escalation, background task registry, daemon/task CLI surfaces, and run summary parsing.
- **Release-facing documentation refresh**: rewrote the README, refreshed screenshots and demo assets, and added focused reference docs for architecture, campaigns, CLI, configuration, Reality-Gate, and skills.

### Changed

- Raised the package version to `0.2.0`.
- Kept generated framework campaign logs local-only via `.gitignore`.
- Removed older dashboard screenshots and replaced them with current workspace, campaign, agent, architecture, and run-memory visuals.

## [0.1.0-alpha]

Public alpha release for early feedback on the browser-first multi-agent workflow experience.

### Added / Improved

- Added campaign iteration visibility in the dashboard.
- Added research-injection and campaign pivot surfaces.
- Improved campaign trigger logic with previous run history.
- Added safe campaign ID persistence.
- Added existing campaign selection when creating new tasks.
- Removed internal `new:` prefixes from campaign names.
- Improved the live monitor with DAG, attempt history, and output panels.
- Persisted task settings across page reloads.
