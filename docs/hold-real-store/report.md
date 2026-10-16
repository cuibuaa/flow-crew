# Deployment holds with historical tasks

The deployment-status path now takes one supervisor inventory before inspecting tasks.
A successfully observed manager inventory establishes that an unloaded unit is absent;
portable and legacy supervision records are still checked for local owners. Only loaded
units receive individual manager probes. Inventory failures remain unobservable, and
older injected supervisor backends retain their individual observation path.

Historical tasks are omitted only after their run is paused or terminal, their scheduler
has retired, their unit has stopped or is absent, and checkpoint-owned commands have
settled. Terminal registry status alone never establishes safety. Status reads compact
operational run projections rather than hydrating append-only history. The CLI's
2,000 ms RPC deadline is unchanged.

This adds one optional batch observation primitive to the existing supervisor contract
and replaces the per-task manager subprocess fan-out. Cheap registry/run metadata
inspection remains linear in registered tasks; expensive manager work is one inventory
plus detailed observations of loaded units. It introduces no lifecycle states, caches,
or operator options.

## Regression evidence

The public fixture contains 888 historical tasks: 661 cancelled, 132 stuck, 45 done,
30 reality-gate failures and 20 failed, with corresponding terminal runs and absent
units/schedulers, plus two running runs. Only those two block the hold; readiness
becomes true after both park. A separate timing assertion requires status computation
below 500 ms and exactly two detailed probes, using a controlled 2 ms per-probe cost
to expose linear subprocess work without spawning hundreds of fixture children.

Safety cases retain refusals for historical rows with live units, nonterminal or unknown
run states, corrupt scheduler identity, unresolved command fate, local supervision that
is active or unobservable, malformed inventories and manager failures.

Focused checks passed: the existing deployment lifecycle and supervisor contract suites
plus the new history suite (47 tests before three additional safety cases), then the
final history suite and public-spec purity suite (31 tests). TypeScript and lint passed;
lint reports 17 existing warnings outside the changed source.

## Private daemon proof

An operator-only adaptation of `fc-trial` built a private snapshot and seeded the same
888 historical tasks plus two running runs. It used a private state root, socket,
runtime and deterministic manager executable; no request reached the installed daemon
or the host service manager. All work ran at nice 19 on cores 6–11.

The initial hold refused exactly the two running runs. After the harness parked both,
`daemon hold --timeout-ms 5000` exited 0 with `ready: true` in 672 ms. Five subsequent
status RPCs took 145.5, 99.9, 133.0, 98.3 and 221.2 ms. `daemon continue` exited 0 in
333 ms with `released: true`, no errors and a persisted release timestamp. The harness
stopped its own daemon and cleaned up only owned process identities. These are
synthetic lifecycle transitions; the existing scheduler integration suite separately
exercises actual concurrent wave parking and continuation.

## Mutation checks and comparison

Both mutations were applied only to separate private snapshots, rebuilt and exercised
through normal Vitest freshness checks with at most two workers. The unchanged pair
of correctness/timing specs passed first.

| Same 890-row fixture | Status computation | Result |
| --- | ---: | --- |
| Inventory path | 122.0 ms | Pass |
| Per-row detailed-probe mutation | 1,973.9 ms | Timing assertion fails |
| Absent-to-unobservable mutation | — | Correctness assertion fails |

Restoring individual detailed probes increased controlled-cost status time by 16.2×;
returning unobservable for retired units made all 890 tasks appear instead of only the
two running tasks. These measurements include the identical metadata scan and the
fixture's controlled probe cost, not a claim about real systemd subprocess latency.
The private daemon RPC measurements above independently cover the actual transport.

The initial validation invocation passed dependency installation, both builds, lint,
TypeScript and UI tests, then refused all root-spec entry points before collecting tests:
the newly tracked report still matched the general `docs/*` ignore rule. The fix adds
the same narrow report exception used by the other checked-in reports. That failed
preflight receipt was preserved separately before running the full validation.

## Full validation

The complete validation passed all ten stages: clean dependency installs, combined
build, lint, TypeScript, UI rebuild/tests, the full root suite, public-spec isolation
and the no-service-manager suite. The root suite completed in 289 seconds. The
validator recorded `DONE` with every stage at `rc=0` and a clean tree at invocation.
Its public-isolation construction uses a private home and a user without a passwd
entry; it does not reproduce Docker's network-disabled image, as documented by the
validator. Final success checks require no nonzero stage code, `DONE`, and a clean
working tree. No runtime source changed after this full validation; this final edit
only records its result.


## Read-only status follow-up

Review issue 3 exposed a write in the new inventory path: observing a stale or
malformed legacy fallback record could repair it on disk. Batch observations now
explicitly disable legacy repair, including the loaded-unit path if its detailed
probe subsequently fails. Settlement still uses the same observed status, live
owners still veto readiness, and inventory errors remain fail closed. Existing
single-unit callers keep their repair behavior. The inventory optimization and
historical settlement rules are unchanged; no new state, files or backend contract
methods were added.

The regression fixture seeds stale, malformed, terminal, live and deactivating
legacy records. It snapshots every file's bytes and directory entries under the
private state root after requesting the hold, then compares them after repeated
status and batch observations. Four manager cases cover absent inventory entries,
invalid inventory, a missing executable, and loaded units whose detailed probes
fail. The hold request is outside the read-only comparison because it owns the
latch write.

Focused validation passed 159 tests across the history, deployment lifecycle,
orchestrator and portable-supervision safety suites, including the existing
single-unit repair regression. On the identical new fixture, restoring the original
source caused all four byte-preservation cases to fail with changed legacy record
bytes. Rebuilding the restored fix passed all four cases. These are byte-level
mutation checks rather than timing claims.

All follow-up commands and their helpers ran at nice 19 on cores 6–11, with at most
two Vitest workers. The required full validator is reserved for one invocation
against the committed follow-up; its external summary records the final result.
A temporary Node launcher supplies the two-worker limit even to the validator's
empty-environment isolation stages. No real manager or deployed daemon is used
by the new fixtures.
