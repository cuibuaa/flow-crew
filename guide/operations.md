# Operations

For operators preparing, steering, verifying and preserving a run.
[CLI](cli.md) owns command syntax; the [brief contract](brief-contract.md) owns declarations.

## Identities and lifecycle

Setup admits a run and returns its `run` id; start launches that record. A run has a pinned
runtime, admitted brief, graph, attempts, command receipts and independent reviews. Use that id for all controls.

| Status | Meaning |
|---|---|
| `preparing`, `refused` | Setup in progress or setup refused; inspect the preparation reason |
| `pending`, `running` | Admitted but unstarted, or executing work |
| `parked` | Retained work waiting for explicit continuation or recovery |
| `complete` | Completed accepted delivery |
| `accepted_blocked` | Independent gate accepted a brief-permitted blocked result |
| `incomplete` | Required commands or output preservation did not establish completion |
| `failed` | Irreparable gate, or frozen-input isolation failure that could not be restored |
| `cancelled` | Explicit terminal cancellation |

Unresolved recovery ownership shows as `parked` with `stopReason: recovery_unknown`; this engine never writes the status `escalated`, though readers accept it. Public status can also show `interrupted` and `unknown`, which are availability overlays, not journal states.

Inspect `stopReason`, `attention`, gate evidence and deliverables together. A lifecycle
label does not prove a scientific conclusion or human acceptance. Do not edit an active
run's workspace concurrently; unrelated edits cannot be attributed to its author.

## Preparation and command evidence

`flowcrew setup <brief>` (syntax and printed fields: [CLI](cli.md#setup-and-start)) admits
and records a run: it captures the brief, checks declarations, input identities, output
dispositions, source/record separation and effective settings, pins the runtime and prepares
the project copy. The copy includes everything except `.git`, including ignored files.
Setup rechecks imported content facts before committing preparation evidence. It executes
no provider or declared command, so success establishes neither command feasibility nor
validation success. `flowcrew start <run-id>` launches exactly that admitted record.
A prepared but unstarted run can be cancelled and landed; a failed setup that created a
record also reports its id for inspection and cleanup. Before the first run record commits,
mkdir, schema setup and existing-run conflicts report no run effects and do not say setup began.
An uncertain creation reports the attempted id and store address as unconfirmed, retains
the directory and exits 3. Inspect status when readable, then cancel and land a confirmed
record; do not retry creation there or delete it as an empty attempt. A confirmed creation
survives later setup failures. Failure exits preserve their cause: invalid 2, conflict 1,
unavailable or unknown 3.

Command receipts record completed exits or explicit unfinished/not-started outcomes,
streams, tree identities and elapsed time. If a declared output changes during post-command
capture (`output_changed`), the command receipt keeps an `unpinned` result and the run parks
with `command_unfinished`; stop the outside writer before resuming, or cancel to keep the
evidence. Declarations and delivery obligations are in the
[brief contract](brief-contract.md#inputs-outputs-and-validation).

## Platform boundaries

All authors, providers and commands run with the OS account's ordinary rights.
FlowCrew no longer prevents writes outside the project, writes to frozen sources or
engine records, access to provider homes or credentials, use of host sockets, devices
or network, or interaction with other account processes. Invocation containment controls
local descendant lifetime; it does not restrict these account rights. FlowCrew retains
an accountable default workspace, cooperative ownership, observed
content/effect evidence and independent review. These are not OS security confinement.

The default workspace is the per-run project copy.
Absolute paths and copied symlinks can still lead outside it. Engine path checks prevent its own import, restore and reclaim operations
from targeting overlapping source/record destinations. They cannot stop other programs
running under the same account from changing source, records, runtime pins or credentials.

Frozen-input hashes and snapshots detect changes at observation boundaries, retain
evidence, restore eligible in-copy content and quarantine unproven or external changes.
External frozen inputs are not automatically rolled back. Changes made and restored
between observations can go undetected. Gate (review) invocations are independent and
receive no guidance. A plan or gate invocation never delivers bytes: at settlement the engine
restores the project and declared exact outputs to the tree it reviewed, whatever its tools
left behind, and the attempt's after-capture keeps those bytes on record. Their tools
still have host rights, and out-of-project changes are not comprehensively audited.
A same-account journal is not a tamper-proof security boundary.

On Linux with a systemd user manager, author invocations and engine commands use a
delegated cgroup v2 scope, requiring `busctl`, `systemctl`, readable `cgroup.events` and
writable `cgroup.kill`. Its `cgroup` receipt proves recursive descendant closure,
including children that create their own group or session.

Elsewhere, including macOS and Linux containers without a user manager, every invocation
inherits a unique `FLOWCREW_INVOCATION` environment marker. Closure kills its authenticated
group, then repeatedly scans only current-user processes, killing exact marker matches
until no readable match remains. The `marker` guarantee is best effort: a child that
removed its marker is outside the guarantee. The owner retires after this close, so later
runs can start. Linux reads `/proc/<pid>/environ`; macOS reads `KERN_PROCARGS2` with the
existing Python native helper facility. No environment contents are printed. Permission
denials and macOS SIP-hidden/absent environments are reported as unknown PIDs, left
unsignalled, and do not hold ownership forever. If the entire scan is unavailable, the
receipt says descendant fate is unknown and retires the marker owner after group closure.
A genuine group drain or marked-process signal failure remains a failed close.

Normal ending, cancellation and controller recovery use the same recorded containment
field. Receipts carry `guarantee`, `detail` and any `unknownPids`; status includes the
latest closure detail in `host.interpretation`. Old records without containment keep
group-only closure. Recovery retains unknown direct exit when no exit was recorded,
while independently retiring successfully closed ownership.

Effects outside the process tree, such as scheduled tasks, services and containers, are
outside engine-managed closure; their cleanup duty is in the [brief contract](brief-contract.md#inputs-outputs-and-validation).

Host OS permissions, device availability, service access and native trust settings
still apply. Removing engine restrictions does not prove hardware or service availability.
Container and root execution require their own validation; they are not certified here.

Declared command argv and environment values are retained as supplied. At launch,
`FLOWCREW_INVOCATION` is reserved for ownership: marker-owned invocations receive the
recorded marker, replacing any inherited value; cgroup-owned invocations carry none.
PATH and TMPDIR defaults for commands are in the
[brief contract](brief-contract.md#inputs-outputs-and-validation). FlowCrew does not infer
permissions from environment paths, export a trust bundle or inject proxy/CA settings.
Provider invocations retain caller context and selected native configuration. Explicit
proxy/CA settings remain ordinary program inputs. Never put secrets in a brief's
recorded environment.

## Inspect, guide and stop

```text
flowcrew status <run-id>
flowcrew guide <run-id> "Keep the public API stable"
flowcrew cancel <run-id>
flowcrew resume <run-id>
```

Text guidance records the
cursor and stage/attempt observed by the operator and never interrupts the author.
On its five-second observation cadence, the controller offers pending guidance to a
running Claude author's native stream-json queue. The Codex adapter streams live activity but
refuses same-turn steering in this release, so guidance waits for its next author
invocation. Refused or ended offers also remain pending for the next author input.
Pending guides stay ordered and apply to author planning, repair or continuation.
When only a gate remains, the affected author continues with the guide and dependent
stages are reviewed again. Independent reviewers never receive guidance. Mid-turn
messages remain within the brief and cannot widen its authority.

Status lists each guide as `pending` or `delivered` with its invocation. A guide shows
`pending` until the invocation that received it ends, and `delivered` after that: delivery is
recorded in the receiving invocation's receipt, which is written when the invocation ends,
so a Claude author can have read the guide hours before status says so. The receipt confirms
initial and steered delivery. Claude acknowledges a steered
guide by echoing it when it takes the guide into a turn; a write Claude has not echoed is
not delivery, and the invocation does not end at a result while such a guide is waiting
(Claude runs one more turn for it). At most one guide message is in flight per invocation:
guides accepted while one waits for its acknowledgement are held and sent together as one
message (separated by a blank line) once it is acknowledged, and the acknowledgement of that
message delivers all of them. The guide remains pending until its receipt is recorded; if the invocation ends or dies first, the guide is delivered again. Delivery does not prove
that the requested change occurred.

Both provider adapters emit tool-start, tool-end, message and turn-end activity while
the provider is running. Summaries are at most 200 characters and omit potentially
secret command arguments, message bodies and environment values. Activity is provisional
observation; final answers still require authenticated closure, content and schema. One reader
consumes new raw-file bytes without filesystem watchers, so unavailable watch resources
do not affect invocation completion. The reader reuses one 64 KiB buffer per invocation
and polls every 100 ms for new bytes. Steering does not depend on that poll: the
controller offers accepted guidance to a running Claude author about every five seconds
(its observation cadence, which also refreshes the display), and Claude takes it into a turn
when it can; the echo of the message is what counts as delivery. Live read errors are logged and retried from the unchanged offset;
only the final authoritative read/decode can fail completion. Final decoding consumes the
retained bytes and closes Claude input on the root result or native exit. The root result
ends a Claude invocation: after it Claude has 2 s to exit by itself, then the invocation's
owner is closed, which ends every process it started, even one still blocked on input. That
receipt is `closed` with no exit code or signal and the answer stays delivered; an exit or
signal observed before then still decides, as for any native exit.

Status JSON includes `stages` in current-plan order, followed by replaced definitions
marked with `replacedBy`. A replaced definition keeps its own execution state,
engine-attempt count, ending, verdict, summary and times. `attempts` counts distinct
engine attempts; continuation invocations are separate `segments`, not extra attempts.
Optional segments carry attempt outcomes and recorded attempt/pause times. Older projections
can publish outcomes with a null start and measured gaps between controller intervals,
without replaying the journal. Per-try times remain unavailable when never retained. Optional `summary`
is the stage's own recorded work summary or review reason verbatim. A running gate's
optional `commandProgress` carries the declared commands and their recorded execution
states. Gates retain satisfied-command sources after settlement: stage, attempt, invocation and
result tree. Earlier invocations include `reused from <stage/attempt>` as a display label. Optional `startedAt`, `lastActivityAt` and `endedAt` describe recorded run times.
Optional `activity` shows current author tools, independent reviewer tools and engine commands before they end:
source, last relevant event time, tool and summary. The dashboard displays those facts
on the running stage; the session hook reads the same facts from the published v4 status file.
Activity does not advance the decision journal, and failed activity writes are logged and ignored. A running tool or
command with no observed progress for ten minutes creates one attention notice per
quiet episode. Recorded command samples retain the episode across controller restarts. New relevant activity clears the notice; a later quiet episode can
notify again. Silence never kills, fails or retries execution. Missing observations
stay unknown. Controller polls, PID liveness and CPU use are not progress; unrelated
provider chatter does not refresh an open tool. Engine commands use changes to their
own captured streams. A silent intentional wait can produce the same advisory.

The last-activity age fades without judging liveness. See [the status field table](cli.md#status-output)
for the wire fields. Old files without these fields remain readable; missing facts stay absent.

Start the read-only dashboard with `flowcrew monitor` and open its printed URL
(default `http://127.0.0.1:8795`). Without `--store-root` it reads the CLI's selected
store; repeat `--store-root DIR` for multiple stores. `--port N` and `--host H`
change the listener; the default host is `127.0.0.1`.

The header counts **Needs you**, **Running** and **Ended · 24h**. It shows one time track per run, a current-stage
position, owning-session notification binding and collapsed evidence. An ended run that has
not been landed also shows the space it holds, and the header adds a **held, not landed**
total over those runs (see [held space](#held-space-of-ended-runs)). Expand details
for tries, review results, saved checkpoints and the reason a run stopped. It only serves GET;
act in the Claude Code or Codex session owning the run. Its single existing poll updates
published facts while retaining details and theme. It shares the hook and publisher's
read-only controller observation and single run/stage availability derivation; it never
infers liveness from elapsed time or writes the status file. Unsupported status values
make the file unavailable. Active totals sum recorded track time (with missing try times
disclosed); ended rows show age only when an end time was recorded.

To obtain a replacement using public output alone, save `flowcrew status <run-id>`
as `status.json`, extract its `plan.pending` object into a plan JSON file, and edit that
object. A human `guide --plan` cannot change the definition of an already-attempted
stage, even if that stage remains in `plan.pending` or is parked: `admitPlan` refuses
that change. Preserve attempted definitions and edit only unattempted work. For example, `node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync("status.json","utf8")); fs.writeFileSync("plan.json",JSON.stringify(s.plan.pending,null,2))'`.
The pending object contains exact stage definitions (IDs, purposes, roles, `after`,
full instructions, command IDs and repair/checkpoint fields), omitting settled/skipped
stages; dependencies may still name retained executed stages. Keep the independent
last gate and required verification obligations. Submit it with
`flowcrew guide <run-id> "Explain the revised pending work" --plan plan.json`, then
`flowcrew resume <run-id>`. `plan.revision` identifies the snapshot's admitted revision;
guide binds the replacement to the current revision when submitted. Inspect a fresh
status before submitting if the run has progressed.

Replacement plans via `guide <run-id> <text> --plan <file>` require no open attempt or
unsettled command reservation. An active attempt yields an actionable refusal; wait
for the current step to finish or for the run to park. There is no park command. Replacement plans
retain executed history and declared obligations. Guidance cannot widen brief authority.

After a controller dies, use `flowcrew status <run-id>` and then
`flowcrew resume <run-id>`. Resume authenticates and closes owned survivors, retains
captured streams and marks interrupted accounting `closed-unmeasured`. That state
means the command may have changed the project or external systems; it is never a
successful command receipt. The interrupted request is spent and is never dispatched
again. Continuation starts from the retained safe base, lets the author inspect and
repair, and still requires independent review and current measured verification.

Inspect the retained streams and actual effects before resuming. Text guidance can
explain what to repair; `guide <run-id> <text> --plan <file>` can replace pending work
when a different graph is required. Supply your pending graph as plan JSON, retaining
the independent delivery gate and the brief's verification obligations. A later stage
can select a deliberate new verification request. Resume consumes the stop it ended;
it preserves the old uncertain result without immediately re-deciding that ending.
The old reservation and unknown result remain in history; they do not become
successful or silently execute again. Historical parks
do not fence a newly reserved invocation, while cancellation remains terminal.

Cancel records a fence without requiring the operator's cursor to match concurrent
progress and interrupts work. An operation result of `not_confirmed_closed` retains
cancelled lifecycle and publishes `closure_unconfirmed` attention until closure can
be confirmed. Inspect the reported group and reaper, then repeat cancel to retry
closure. Other refused, unknown or in-progress control results retain their own
meaning and do not create closure attention. Unconfirmed claim cleanup adds
`claim-unreleased`; interrupted accounting adds `accounting-unsettled`. Status lists
open obligations (`closure-unconfirmed`, `accounting-unsettled`, `claim-unreleased`)
as attention on any lifecycle, including final runs. The corresponding attention
reasons are `closure_unconfirmed`, `accounting_unsettled`, and `claim_unreleased`;
`attention.reason` names the earliest-recorded open obligation, in the same order as
`attention.obligations` (the state row reader orders by recording cursor, then key).
`stopReason` retains the conclusion's reason: when a blocking obligation parks a running run,
it names the obligation that parked it, even if that obligation is later discharged.
Obligations never replace a final conclusion or lift a cancellation fence. Only
`closure-unconfirmed` and `claim-unreleased` block new work; `accounting-unsettled`
records dead-activation bookkeeping and is discharged by reconcile.
Parked work resumes as a continuation segment. Terminal and cancelled work refuse guide
and resume; use retained evidence in a new brief when another run is needed. Unknown ownership/effects require inspection, never blind retry.

C2 parks after three consecutive gate rejections, counting the one that last set the best
pass count (so two rejections after the best that fail to beat it), or after four failures
without an intervening completion, retaining work. Provider context exhaustion is a provider outcome; provider-internal loops need operator
cancellation. There is no general iteration or stage deadline; a command may declare its own `durationMs`.

## Runtime pin and restart

Setup pins the built runtime and production dependency closure in a private copy. Its
manifest identity is recorded. Supervisor, operation workers and resume use that pin;
an ordinary package upgrade affects new runs only. External Node, providers and project
tools remain external dependencies.

Missing or changed pins refuse continuation with an actionable original-pin restore
or new-run instruction. A host restart does not automatically resume work or install
a login item. Status/monitor interpret a differing boot identity as **interrupted by
restart** and show the exact `flowcrew resume <run-id>` command. Inspect and resume manually.
Processes never survive a restart, so cancel, resume and land close an invocation owner
recorded on an earlier boot as dead, whatever its closure facility, without probing or
signalling anything; no `closure-unconfirmed` obligation is recorded for it.

Cancel first records durable cancellation, cooperatively wakes the recorded controller,
then waits for its lifetime lock before reconciliation. Land waits before taking claims
needed for final capture. The observation window is 30,758 ms (6,500 + 24,258 ms from recorded
exit/capture observations); it is a refusal backstop, not a healthy-exit bound or kill timer.
On timeout the unavailable refusal includes the run, controller identity and elapsed wait:
“Controller exit is not confirmed. Evidence and work are retained. Inspect the controller
and its capture/I/O; after it exits, repeat `flowcrew cancel <run-id>` to finish reconciliation,
or `flowcrew land <run-id>` to preserve and land ended work.” Only cancel says
“Cancellation intent is durable.” Lock-access errors ask for repair before retrying.
Timeout retains work and evidence; it never kills the recorder or reclaims bytes.

If cancel or land finds a live controller from an earlier build without a lifetime lock, it refuses rather than
controlling that run through the new build. Follow the refusal's guidance: use the earlier
build to cancel the run, or wait for it to finish, then retry. Do not delete its
records or workspace to bypass the refusal.

## Preserve and reclaim

Preserve unique files outside the declared output inventory, failed or invalid evidence and
any raw evidence you still need before reclaiming.

`flowcrew land <run-id>` is the only way to keep and free a run. It is not a read-only
audit and does not decide product acceptance: it preserves the declared outputs and then
deletes the run's bytes (listed below) in one step. It prints
`location`, `state` (`reclaimed`, or `partial` when preservation failed and nothing was
deleted; `partial` exits 1), `outputs`, `executionBoundary`, `evidence` (the raw-evidence and
output-artifact references observed; empty once reclaimed) and `delivery` (present once
reclaimed), and `acceptedUnmet` (acceptance recorded or recovered during publication;
empty on a cleanup-only repeat); a refusal prints `kind` and `detail` instead. A run that
has not ended (`pending`, `running` or `parked`, including one shown as interrupted) is
refused: run `flowcrew cancel <run-id>` first, then land it. Every ended run can retain its
current declared outputs, including cancelled and failed work. No execution pin or safe
checkpoint is needed. The receipt says **Reviewed accepted delivery** when its
artifact identities match the accepted delivery, or **Unreviewed retained observation**
otherwise. Capture records bytes; the accepted delivery record determines that label.
Retention never accepts a delivery, resumes a cancelled run, restores frozen inputs or
overwrites current work with a checkpoint. Output disposition checks remain publication
obligations; a missing or unreadable output makes retention partial.

When a human accepts an unmet criterion, stop the run with cancel before land. Guidance
cannot change frozen criteria. Record that decision with a reason:

```text
flowcrew cancel <run-id>
flowcrew land <run-id> --accept-unmet 'C3=Accept plateau at 0.842'
```

Repeat `--accept-unmet` for more criteria. Land checks each id against the frozen brief
and refuses unknown ids or criteria passed by the latest gate as invalid (exit 2), before
preserving or deleting anything. It copies the latest gate's criterion status and evidence
verbatim, or records status `not_assessed` and evidence `not assessed` if no gate judged it,
alongside the human's reason and the recording time. The record belongs to the delivery;
the run stays cancelled, failed or otherwise ended as before, with its gate verdict intact.
It does not relabel the output receipt as reviewed.

Land requires invocation owners retired under their recorded closure
guarantee and settled claim obligations. Cgroup closure proves recursive descendant
closure; marker closure is best effort after authenticated group drainage and a scan of
same-user processes. Unreadable environments or an unavailable scan remain visible as
unknown descendant fate, but do not prevent marker retirement or retention. This guarantee
does not cover processes that cleared their marker or prove that an escaped writer cannot
change bytes later; see [Platform boundaries](#platform-boundaries).

Owners with a recorded `closed_owner` fact are not probed or signalled again. A dead or
reused owner observation alone does not skip the probe; a reused PGID belongs to its new
owner and cannot authorize signalling it. A closed time interval records accounting,
not descendant closure. Reconciliation probes unresolved owners, closes them under their
recorded guarantee and records `owner_closed` (stored as `closed_owner`) before output
capture. Output capture requires that recorded retirement; a dead group alone does not
retire its descendants. An unresolved closure obligation clears only after closure succeeds.

An external capture failure keeps that extent held and opens `claim-unreleased` attention
with the capture error. It never blocks retention of the other declared bytes. Ordinary
refusals, including a live prior claim, answer the caller without opening an obligation.

To reclaim an ended run, use:

```text
flowcrew cancel <run-id>   # if the run has not ended
flowcrew land <run-id>
```

Preservation failure deletes nothing. On success land materializes
outputs under `store/deliveries/<run-id>/` and deletes the project copy, the work root (which
holds scratch), the runtime pin and the raw evidence (everything in `runs/<run-id>/` except
`status.json` and the controller lock with its SQLite sidecars). It retains SQLite events,
current rows and `status.json`; status shows reclamation time and delivery location.
Every admitted-run delivery uses one layout, with `manifest.json` and `changes.patch`
always present; a never-admitted preparation has no workload outputs:

```text
deliveries/<run-id>/
  project/<path>   # relative declared outputs
  external/<n>    # absolute declared outputs
  manifest.json   # outputs and acceptedUnmet (human acceptance records)
  changes.patch   # Git-representable relative output changes; empty without relative outputs
```

New manifests are objects: `outputs` lists each declared `path`, `archive` slot and
retained artifact `ref`; `acceptedUnmet` lists `criterionId`, `status`, `evidence`, `reason`
and ISO time `at`. Older manifests are output arrays and have no acceptance record.
The complete manifest is published with the archive before reclaim. Once a delivery
exists, land with acceptance records refuses without editing it. Repeat land without
records to finish interrupted cleanup; this needs only the journal's delivery fact, even
if the delivery directory was moved or removed. Read stored acceptance in the manifest.
This keeps the delivery immutable, including after reclaim, without a separate amendment store.

Land leaves absolute outputs in place; it never restores an absolute path from the archive.
From the original source project, apply the patch with
`git apply <delivery-dir>/changes.patch`, where `<delivery-dir>` is the reported delivery
location. This reproduces only git-representable changes. The full output archive keeps
content Git cannot represent, such as empty directories; restore that content from the
archive as needed. The patch reuses the preserved output snapshots against setup's base;
an unknown base produces an explicit comment instead of claiming an empty change.
Land does not apply the patch or merge into the source project.
Resume refuses reclaimed work. Archives are built privately and published without
replacing a delivery directory. `run_reclaimed` is durable before raw bytes are removed.
After an interrupted reclaim, repeating `land` authenticates the archive or
finishes the remaining deletions, including when workspace, runtime or scratch directories
are already gone. Deletion skips absent targets and creates no missing directories,
including outside the store. The reclaim fact retires ownerless reservations matching
the run's recorded admission and writer epochs in its own transaction; land then
retires its held claims by their exact epochs. A later claimant keeps its row, and a later run can claim
the reclaimed project and external paths. An existing different delivery refuses without being
overwritten.
An external output extent belongs to execution only while that run can still act on it.
Terminal runs release these extents after confirmed execution closure and an authenticated
snapshot of the external bytes during closure reconciliation, independently of land or reclaim.
If cancel refuses because controller exit is unconfirmed, inspect capture/I/O and repeat
cancel after exit to reconcile before reuse. Closure unknown or a
failed capture keeps the extent held; a conflicting setup names the holding run and tells
how to reconcile it. Reconciliation alone decides run closure from the unit observation, owner probes and
settled accounting and claims. Retirement consumes that result and checks the journal
cursor and exact resource epochs in its transaction; a changed cursor retires nothing
and opens attention. Output quiescence for snapshots and publication only probes owners
and can hold while the unit is active. There is no TTL. Replacing a dead operation owner deactivates its writer epoch in
the same claim transaction. Private workspace and record extents stay protected for later maintenance.
Once released, land uses the old run's retained refs, even if another run has overwritten
the external directory. Reclaim does not delete that directory or the new run's bytes.
Old stores use the same closure reconciliation and snapshots; no old pin is executed.

Explicit status regenerates its stdout view from committed journal facts and applies a
read-only controller observation; it never rewrites `status.json` or repairs measurements.
The ending/control writer publishes `status.json`; the dashboard reads that publication.

No automatic or age-based deletion runs. Land preserves declared outputs, not a full raw
run archive, source merge, push or conversation-ledger closure.

### Held space of ended runs

An ended run that has not been landed still holds its project copy, runtime pin, work root and
raw evidence. Status publishes `heldBytes` for it ([field](cli.md#status-output)), which is what land would free.
Natural completion measures under the finishing writer after final capture, outside the SQLite
write transaction; external cancellation leaves measurement to control/reconciliation after controller exit.
Pending or failed measurement, including old ended unlanded runs, publishes `heldSpacePending: true`
without `heldBytes`; the dashboard shows `held · incomplete` until all included runs are measured.
Repeat cancel or land to recover. Failed or interrupted land retains the frozen
measurement until cleanup completes. The controller lock identity survives land and is excluded from the measurement.
The dashboard shows it ([monitor](#inspect-guide-and-stop)). Land the runs you have reviewed to free the space;
nothing is deleted automatically.

## Storage ownership

Storage defaults and overrides are in [configuration](configuration.md#storage-and-runtime).
One SQLite database owns events/current rows, writer epochs, command reservations
and resource ownership. Use a local filesystem with SQLite WAL support. `status.json` is
a derived atomic view, not a second authority. Missing/invalid views remain unknown until
a later mutating operation republishes them. Status reads current SQLite state without writing or walking trees. Raw command/native evidence and
checkpoint content live in the run's evidence repository until reclaim.
