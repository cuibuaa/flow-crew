# Operations

For operators preparing, steering, verifying and preserving a run.
[CLI](cli.md) owns command syntax; the [brief contract](brief-contract.md) owns declarations.

## Identities and lifecycle

Start returns a `run` id. A run has a pinned runtime, admitted brief, graph, attempts,
command receipts and independent reviews. Use that id for all controls.

| Status | Meaning |
|---|---|
| `pending`, `running` | Prepared or executing work |
| `parked` | Retained work waiting for explicit continuation or recovery |
| `complete` | Completed accepted delivery |
| `accepted_blocked` | Independent gate accepted a brief-permitted blocked result |
| `incomplete` | Required commands or output preservation did not establish completion |
| `failed` | Irreparable gate or execution/contract/isolation failure |
| `escalated` | Recovery ownership remains unresolved |
| `cancelled` | Explicit terminal cancellation |

Inspect `stopReason`, `attention`, gate evidence and deliverables together. A lifecycle
label does not prove a scientific conclusion or human acceptance. Do not edit an active
run's workspace concurrently; unrelated edits cannot be attributed to its author.

## Preparation and command evidence

`flowcrew setup <brief>` checks grammar and performs a real benign sandbox launch.
It prints no digest, executes no brief command and establishes no validation baseline.
Start copies and authenticates the run-local runtime, imports the source and declared
inputs into isolated work, and prepares exact authority before launching.

Commands are declared with exact argv/env and input IDs. Their receipts record completed
exits or explicit unfinished/not-started outcomes, streams, tree identities and elapsed
time. Required command success and output preservation remain delivery obligations;
an approving model cannot waive them. A required program that tries to write frozen
input can pass setup and fail when executed. No static command-feasibility guarantee
is claimed. Keep direct exits and totals in the report after the last relevant write.

## Platform boundaries

The host uses pinned `@anthropic-ai/sandbox-runtime` (srt), with no weaker isolation
fallback. Authors get the isolated project and admitted external outputs; read-only
plan/gate invocations do not get a project write grant. Shared caches/devices and the
selected provider's home have explicit grants; declared commands get neither provider
home. Frozen inputs, source and engine records are protected. Srt also has implicit
writable paths (including its scratch, npm logs, Claude debug paths and devices);
inspect recorded authority and host interpretation rather than assuming output paths
are the whole writable set. This boundary confines writes, not arbitrary reads or
all network activity. Provider approval prompts are bypassed inside the host sandbox.

- **macOS:** an exact external writable file grant can also delete, rename or replace
  that file. **Linux:** the corresponding grant permits contents only. Frozen and
  ungranted paths are protected on both platforms.
- **macOS HTTPS:** inside the sandbox, programs that verify TLS through the macOS
  Security framework (Apple curl and many Go tools) cannot reach HTTPS. Srt's strict
  profile omits `com.apple.trustd.agent`; FlowCrew does not enable srt's weaker isolation.
  Choose tools whose TLS implementation works under the strict profile.
- **Process closure:** closure confirmation for every run covers the recorded group only.
  A process that leaves that group is outside this guarantee and can outlive it; macOS
  lacks Linux's additional PID namespace containment. Do not interpret group closure
  as proof that every escaped process has exited.
- **Linux prerequisites:** bubblewrap, socat and ripgrep. On Ubuntu 23.10+ an administrator
  must perform the namespace/AppArmor step printed by `flowcrew doctor`. Doctor shows
  the actual launch diagnostic first; it does not apply administrator changes.
- **Containers:** not supported. The sandbox needs kernel features Docker blocks by
  default; `flowcrew doctor` refuses and explains the sandbox launch failure.
  Running as root has not been decided as a supported mode.

Declared command environment values are exact overlays, including TMPDIR and proxy/CA
variables. Declared TMPDIR must fall within that command's writable grant; absent TMPDIR
uses run-private scratch. Overriding proxy/CA variables can break networking and is not
a sandbox bypass. Never put secrets in a brief's recorded environment.

## Inspect, guide and stop

```text
flowcrew status <run-id>
flowcrew guide <run-id> "Keep the public API stable"
flowcrew cancel <run-id>
flowcrew resume <run-id>
```

Status with no id lists all runs in the selected store. Text guidance never interrupts.
It records the cursor and stage/attempt observed by the operator, then delivers pending
guides in commit order once to the next author-side invocation (including planning,
repair or continuation). Independent reviewers never receive it. Receipt of a guide
is evidence of delivery, not evidence that its requested change occurred.

Replacement plans via `guide <run-id> <text> --plan <file>` require no open attempt or
unsettled command reservation. An active attempt yields an actionable refusal; wait
for the current step or for it to park. There is no park command. Replacement plans
retain executed history and declared obligations. Guidance cannot widen brief authority.

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
Repeating cancel after confirmed end succeeds without replay.
Resume of active work succeeds as a no-op; parked work starts a continuation segment.
Terminal and cancelled work refuse resume; use retained evidence in a new brief when
another run is needed. Unknown ownership/effects require inspection, never blind retry.

C2 parks after three gate rejections without a new best or four failures, retaining
work. Provider context exhaustion is a provider outcome. There is no general iteration
or stage deadline; a command may declare its own `durationMs`.

## Runtime pin and restart

Start makes a private copy of the built runtime and production dependency closure,
using clone/reflink where possible, otherwise ordinary copies, never hardlinks. Its
manifest identity is recorded. Supervisor, operation workers and resume use that pin;
an ordinary package upgrade affects new runs only. External Node, providers and project
tools remain external dependencies.

Missing or changed pins refuse continuation with an actionable original-pin restore
or new-run instruction. A host restart does not automatically resume work or install
a login item. Status/monitor interpret a differing boot identity as **interrupted by
restart** and show the exact `flowcrew resume <run-id>` command. Inspect and resume manually.

## Preserve and reclaim

Read the terminal report, all relevant rejected reviews and command evidence. Verify
criteria independently against actual deliverables. Preserve unique files outside the
declared output inventory and any raw evidence you still need before reclaiming.

`flowcrew land <run-id>` actively checks and preserves declared outputs; it is not a
read-only audit and does not decide product acceptance. Inspect its `state`, `outputs`,
`evidence` and optional `delivery` result. Safe checkpoint, output disposition and proven
process/accounting closure are prerequisites; a refusal is not permission to delete.
Both preserve and reclaim require recorded-group closure (fresh ESRCH on that group
or the recorder's confirmed closure) and settled claim obligations; escaped processes are
outside the guarantee stated under [Platform boundaries](#platform-boundaries).

Only after acceptance and explicit reclamation authority use:

```text
flowcrew land <run-id> --reclaim
```

Preservation failure deletes nothing. Successful reclaim materializes relative outputs
under `store/deliveries/<run-id>/`, leaves external outputs in place, and deletes the
workspace, scratch, runtime pin and raw evidence repository. It retains SQLite events,
current rows and `status.json`; status shows reclamation time and delivery location.
Resume refuses reclaimed work. Repeating successful reclaim is a no-op success. A partial
or unknown reclaim requires reconciliation; it is not an invitation to retry blindly.
No automatic or age-based deletion runs. Land preserves declared outputs, not a full raw
run archive, source merge, push or conversation-ledger closure.

## Storage ownership

Storage defaults and overrides are in [configuration](configuration.md#storage-and-runtime).
One protected SQLite database owns events/current rows, writer epochs, command reservations
and resource ownership. Use a local filesystem with SQLite WAL support. `status.json` is
a derived atomic view, not a second authority. Missing/invalid views remain unknown until
an explicit status or later commit regenerates them. Raw command/native evidence and
checkpoint content live in the run's evidence repository until reclaim.

Sources: [entry and defaults](../rewrite-src/cli.ts), [controls](../rewrite-src/ops/run.ts),
[authority](../rewrite-src/exec/policy.ts), [sandbox](../rewrite-src/host/srt.ts),
[pin](../rewrite-src/records/pin.ts), [landing](../rewrite-src/ops/land.ts),
[status](../rewrite-src/contract/status.mjs).
