# Launch-side delivery

Install from the FlowCrew package or checkout:

```bash
bash skills/install.sh --global
flowcrew doctor
```

The installer detects Claude Code and Codex. `--claude` and `--codex` select one;
`--project` selects project settings. It merges Stop/SessionStart hooks, preserves
other hooks, and wraps an existing Claude status command. Codex's native config
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
Terminal, parked, awaiting-approval, and failed-attempt events carry stable IDs.
Claude delivery selects its live Stop waiter, otherwise its session inbox;
Codex delivery uses `codex queue`. Delivery
does not require installed hooks. Stop/SessionStart hooks add the turn gate and
refresh Claude's address after a reopen; they never launch an audit worker.
A closed session waits for reopening. Claude retries a missing socket; Codex's
queue persists its input until the session resumes. Both retry unacknowledged
events every two minutes. After ten minutes without business ACK, the engine also
calls the existing `notify --source flowcrew --dedup-key <event-id>` notifier.
Configure its FlowCrew route to the operator's notification channel. A missing or
failing notifier remains retryable; it never closes the event.

Claude's hook wake works in every permission mode without changing inbound policy.
Each retry records exactly one transport before delivery. A live waiter emits the
fixed wrap-up prompt and exits 2; an immutable event/attempt claim prevents duplicate
hook wakes across concurrent Stops. That attempt does not also send an inbox frame.
ACK is shared by both paths. Without a live waiter, inbox delivery still obeys the
user's inbound policy, which can hold/refuse messages; pending events retain retries
and notifier fallback. A successful socket write does not prove acceptance.

SessionStart re-arms the same waiter when a session reopens; Stop arms it after
launch and subsequent turns. The waiter polls every second and lives for one hour. Later Stops reuse its coverage
and retire redundant waiters. Before its own deadline it wakes the session to renew
coverage at the next Stop, even for a longer run; the shim and native hook deadlines
are 3650 and 3660 seconds, respectively. The worker retires if its hook host exits.
Closed sessions retain pending events and fallback; reopen the launching session to
refresh its address and handle its existing obligations.

The fixed prompt asks the launcher to inspect current state, independently verify,
archive unique work, reclaim only when authorized, and explicitly close the ledger
after terminal wrap-up. Approval and parked events do not authorize bypassing an
approval or closing an active task. A model reply, successful socket write, queue
receipt, or terminal run status is not an ACK. After handling the exact event:

```bash
flowcrew session-push list --session <launch-session-id>
flowcrew session-push ack --event <event-id> --session <launch-session-id>
```

ACK is durable and idempotent. It does not mark the session ledger complete.
The shared gate lets an executing Claude task end its turn when a live waiter covers
that session and no event is pending. It still blocks unacknowledged events, terminal
wrap-up, and unreadable state. Without a supported installed wake hook and live
waiter it retains the previous foreground blocking behavior. Codex keeps its existing
gate. The engine
does not invoke the wrap-up itself. If standalone Codex creation fails, the gate
reports the error and asks the frontend to create a standalone thread, then bind
that newly created thread with `session-push bind-display` and the exact task and
launching-session IDs. It never uses a subagent for display.

The supported live transport baseline is Codex 0.163.0 and Claude Code 2.1.308 on
Linux. Earlier Claude releases retain blocking even if they advertise asyncRewake;
the first supporting version is unknown. The inbox frame and Codex protocol must be checked when upgrading frontends;
inbox authentication on other platforms has not been established. A transport
failure is recorded and falls back through the notifier; it is never audit success.
