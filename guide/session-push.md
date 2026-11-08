# Launch-side delivery

Install from the FlowCrew package or checkout:

```bash
bash skills/install.sh --global
flowcrew doctor
```

The installer detects Claude Code and Codex. `--claude` and `--codex` select one;
`--project` selects project settings. It merges Stop/SessionStart hooks, preserves
other hooks, and installs the session status command. The previous status definition is saved for uninstall; it is not executed on each refresh. Codex's native config
editor enrolls only the two installed FlowCrew hook hashes. A project-local Codex
installation requires an already trusted project layer; otherwise install globally.
Claude Code >= 2.1.308 also gets an `asyncRewake` hook at Stop and SessionStart. Restart Claude after
installation to load it. Reinstall repairs an outdated installation. `--uninstall` removes the owned hooks,
their Codex trust state when the CLI is available, and unchanged skill files; it
restores the previous Claude status command. No other hook is trusted or disabled.

Both foreground `quick` and `quick --background` record the frontend and explicit session address from the
launching shell. Claude supplies `CLAUDE_CODE_SESSION_ID` and
`CLAUDE_CODE_MESSAGING_SOCKET`; Codex supplies `CODEX_THREAD_ID`. `--session` overrides
the ledger/session selector; it does not invent a frontend or discover another
session. Keep `FC_HOME` consistent between the launcher and its engine. The engine
creates one standalone Codex display thread and updates its title every sweep
(normally 30 seconds). Claude's `fc_tasks render` and status line use the same
elapsed/stage/history estimate. Without comparable workflow history, remaining
time is `unknown`. History is summarized and cached for ten minutes.
Foreground execution stays in the calling CLI and refreshes its own task every
two seconds without requiring a daemon to launch it. The daemon waits for that
exact foreground process to exit before taking over progress and outbox retries.
Keep the reviewed daemon running for delivery retries after the foreground CLI
exits, just as for background tasks. Claude's installed hooks automatically
starts one background waiter per launching session; no model worker is used.

Doctor asks Codex for the current effective hooks and checks their native identity,
definition and enabled trust against the installed FlowCrew definitions. Moving a
hook by inserting a neighbor, changing its timeout or disabling trust requires
reinstallation; a saved manifest alone never makes doctor report healthy.
For Claude it checks the exact wake definition, shim and installed CLI version;
missing/outdated hooks or an unsupported version produce a repair command.

Run events are replayed from durable engine records into `FC_HOME/session-push`.
Terminal, deployment-hold and failed-attempt events carry stable IDs. Historical kinds remain readable.
Claude delivery uses its live Stop waiter once the session has registered wake capability;
while that session is busy or closed it waits for the next live waiter. Only legacy
sessions that have never registered a waiter use the session inbox;
Codex delivery uses `codex queue`. Delivery
does not require installed hooks. Stop/SessionStart hooks add the turn gate; SessionStart
refreshes Claude's address after a reopen. They never launch an audit worker.
A closed session waits for reopening. Claude retries a missing socket; Codex's
queue persists its input until the session resumes. Once a transport accepts an
event, unacknowledged inbox/queue reminders wait thirty minutes. Failed sends back off by two,
four, eight, sixteen, then thirty minutes; a changed target is tried immediately.
After ten minutes without business ACK, the engine also
calls the existing `notify --source flowcrew --dedup-key <event-id>` notifier.
Configure its FlowCrew route to the operator's notification channel. A missing or
failing notifier retries every two minutes; it never closes the event.

Claude's hook wake works in every permission mode without changing inbound policy.
Each retry records exactly one transport before delivery. A live waiter emits the
fixed wrap-up prompt and exits 2; an immutable event/attempt claim prevents duplicate
hook wakes across concurrent Stops. That attempt does not also send an inbox frame.
ACK is shared by both paths. Registration records one immutable capability fact per
session in the existing session directory. Unlike the mutable socket address, a
concurrent hook cannot erase it. Pre-upgrade immutable wake claims also establish
this fact for their session, even if a later retry overwrote the delivery transport.
Capability survives waiter exits and reboots; liveness still requires matching
waiter and host process identities, an unexpired lease, and on Linux the current
boot ID. Old waiter files without boot identity cannot provide live coverage.
A wake-capable session never gets an inbox frame, including for new events during
wrap-up. Its Stop gate already blocks pending events; the engine keeps checking
for a live waiter without sending or consuming a transport attempt. A new waiter
bypasses an inbox deadline or a previously claimed wake deadline immediately.
Legacy inbox delivery obeys the user's inbound policy, which can hold/refuse
messages. Both paths retain notifier fallback and require an explicit business ACK.

SessionStart re-arms the same waiter when a session reopens; Stop arms it after
launch and subsequent turns. The waiter polls every second and lives for one hour. Later Stops reuse its coverage
and retire redundant waiters. Before its own deadline it wakes the session to renew
coverage at the next Stop, even for a longer run; the shim and native hook deadlines
are 3650 and 3660 seconds, respectively. The worker retires if its hook host exits.
Closed sessions retain pending events and fallback; reopen the launching session to
refresh its address and handle its existing obligations.

The fixed prompt asks the launcher to inspect current state, independently verify,
archive unique work, reclaim only when authorized, and explicitly close the ledger
after terminal wrap-up. Unfinished work keeps its ledger open. A model reply, successful socket write, queue
receipt, or terminal run status is not an ACK. After handling the exact event:

```bash
flowcrew session-push list --session <launch-session-id>
flowcrew session-push ack --event <event-id> --session <launch-session-id>
```

ACK is durable and idempotent. It does not mark the session ledger complete.
Only pending events and a Claude wake lease that must be renewed can open a model
turn. A live waiter covers all this session's open tasks, including terminal-before-event
publication. Codex's durable queue has no expiring lease, so open execution alone does
not block Stop. A pending event still blocks either frontend until explicit ACK.
Missing Codex display creation is retried by the service; a pending event can also
ask the frontend to create and bind a standalone display with `session-push bind-display`.
The engine never invokes wrap-up or creates a display subagent.

Nothing persists diagnostics. A Stop hook's model-visible result (`decision`, `reason`) comes only
from the session gate: a pending event, or wake coverage that must be renewed. A read or command
failure, an unreadable optional view, or a missing CLI reaches the operator alone, each time it
occurs: in Stop's `systemMessage`, on stderr of a non-blocking exit, or on the status line. A
failure that leaves the gate unknown never blocks the model and never exits 2. A recovered stale
lock is recorded only in `infrastructure-recoveries.jsonl`. The waiter retries state reads while
its lease is live. When the wake path cannot register a waiter (unsupported Claude version, process
identity, registration or lock failure, an unverifiable lease owner, a crashed or hung wake command)
it leaves one small fact for the session, `session-push/wake-unavailable/<hash>.json`: a closed reason
code and the time. It is overwritten by each failure and deleted when a waiter registers. While it
exists Stop does not ask the model to renew coverage; it shows the reason code to the operator in
`systemMessage` and the status line, and every Stop and SessionStart retries registration. An
unreadable fact counts as present. A missing or disabled async definition (`hook_disabled`) is read
live by the shim, which reports it with `--wake-unavailable`. Stop never probes the Claude version.
Pending events always take priority. Check `flowcrew doctor` and repair the integration to
restore automatic wake delivery.

Session reads open only the calling session's open state: the registry writer publishes
`tasks/<id>/current.json` and an open task index, event writers publish immutable links
in `session-push/pending/<session-key>/`, and ledger writers publish
`FC_HOME/task-ledger-open/<sha256(realpath(ledgerRoot))>/<session>.json` views
containing open entries plus a scalar completed count. `fc_tasks --engine-root` selects
the engine state root for its writes. Event ownership comes from
its recorded launcher, never message text. ACK atomically moves a pending event link
into `session-push/acks/`; old ACK receipts remain valid. Terminal tasks leave the index
after explicit ledger completion and ACK, as observed by the writer/service. A new run,
launch or session binding invalidates the closure receipt.

Readers never acquire the exclusive registry lock or rebuild a legacy store. A missing
or stale ledger view falls back to the bounded census of that session; an unreadable
or over-limit census is reported to the operator. Ledger writes still succeed when the
optional engine view cannot be written. Registry writers and the push service
repair/migrate views from canonical history; ordinary foreground/background sweeps do
this automatically. General registry inspection also reads without the writer lock;
mutations retain append, sync, integrity checks and PID/start-token stale-lock recovery.
Recovery diagnostics are appended to `FC_HOME/infrastructure-recoveries.jsonl` and never
sent as a blocking model error. Full historical ledger inspection remains available
through explicit `fc_tasks list`, `render` and `reconcile`; the installed status command
uses the open view and never delegates to an arbitrary previous status command. It
disables the manual renderer’s legacy description/filename-based agent ETA enrichment;
independent ledger rows remain visible without scanning global agent history. Published
workflow progress retains only stage statistics used by the current run.
The service migration requests a full history census through the existing explicit
larger-scan option; ordinary manual reads retain their 1,000-entry and 4,096-directory-entry
defaults. Larger explicit censuses retain the per-file, total data and directory-name
byte limits. A sweep reads each session ledger and the outbox once, rather than
repeating the same census for every task in that session.

The installer owns all command ceilings in `skills/session-integration.mjs`: synchronous
CLI work gets 40 seconds and its native hook gets 45 seconds, leaving 5 seconds to
publish the result under load. The bounded status read gets 10 seconds. The wake lease
renews at 3600 seconds, ahead of its 3650-second shim and 3660-second native deadlines.
Reinstall after deployment with `bash skills/install.sh --claude --global` (or the
original project scope), restart Claude, and run `flowcrew doctor`. Let the deployed
push service complete its writer-side migration before relying on the new status view.
These are operator deployment steps; installation does not change inbound permission policy.

The supported live transport baseline is Codex 0.163.0 and Claude Code 2.1.308 on
Linux. Earlier Claude releases report unsupported wake coverage even if they advertise asyncRewake;
the first supporting version is unknown. The inbox frame and Codex protocol must be checked when upgrading frontends;
inbox authentication on other platforms has not been established. A transport
failure is recorded and falls back through the notifier; it is never audit success.
