# Engine defect batch settlement

The 19 original entries have these submitted dispositions: **4 fixed, 11 already fixed, 4 declined**.
Fixed means the reported failure reproduced on the base and the change addresses it.
Already fixed means the base already meets the reported requirement. Declined means
the requested behavior conflicts with the existing contract or isolation guarantee.
These classifications do not assert final acceptance or current validation totals.

The links below identify public code, retained specs and contract documentation.
Historical replay commands and raw receipts remain in the local ignored report;
they are deliberately not presented as portable repository evidence. Current
acceptance must rerun the retained specs against the final source.

| Entry | Disposition | Reason and public evidence |
|---|---|---|
| E01 | already fixed | Supervisor guidance preserves a brief-permitted blocked result; see [supervisor contract](../spec/supervisor-state-contract.test.ts). |
| E02 | already fixed | Operator cancellation remains available after a parked shim dies; see [cancellation specs](../spec/cancellation-park.test.ts). |
| E03 | already fixed | Missing acknowledged history does not prevent operator cancellation; see [cancellation specs](../spec/cancellation-park.test.ts). |
| E04 | already fixed | Old outward executable aliases do not move the next attempt's scratch root. See the [invocation scratch owner](../src/invocation-scratch.ts) and [carrier ownership](../src/engine-owned-carriers.ts). |
| E05 | already fixed | Explicit manual retry can resume a proven resumable parked run; see [retry and repair contract](../spec/repair-replan-budget.test.ts). |
| E06 | already fixed | Framework-owned isolated validation is engine-acknowledged; stages report unavailable resources under [operations](operations.md#unattended-execution). |
| E07 | declined | READY denotes setup admission, not a guarantee that an inferred pytest runner imports; see [project validation](../spec/project-validation.test.ts) and [operations](operations.md). |
| E08 | already fixed | Pending scope input does not preempt an admitted repair; see [repair and replan specs](../spec/repair-replan-budget.test.ts). |
| E09 | already fixed | The planner may publish its dispatch carrier while other roles remain constrained; see [planner carrier publication specs](../spec/planner-carrier.test.ts). |
| E10 | fixed | Domain hand/hands nouns no longer imply supplied operator figures; real supplied-number controls remain in [batch regressions](../spec/engine-batch-regressions.test.ts). |
| E11 | fixed | Tree identity includes declared ignored outputs and products, while ignored inputs retain their independent frozen checks; see [tree identity](../spec/tree-identity.test.ts) and [frozen inputs](../spec/frozen-field.test.ts). |
| E12 | already fixed | The reported watchdog carrier-deletion failure did not reproduce on the base: deletion controls returned 125 and restored the carrier. See [carrier integrity](../spec/engine-integrity-settlement.test.ts). No carrier-deletion repair or historical-flake cause is claimed. |
| E13 | already fixed | Later attempts preserve earlier native provider streams; see [per-attempt log specs](../spec/livelog-per-attempt.test.ts). |
| E14 | historical fix; machinery retired in C1 | Generic baseline resettlement is removed; actual content deltas remain in [settlement specs](../spec/write-scope-subtraction.test.ts). |
| E15 | historical fix; machinery retired in C1 | Generic byte retention and preimages are removed. [Frozen hashes and pinned Git restoration](../src/scheduler/sched_scope/frozen-inputs.ts) replace them. |
| E16 | declined | Independent setup copies preserve source isolation; hardlinks permit source mutation and copy failure already refuses READY. See [project validation](../spec/project-validation.test.ts). |
| E17 | declined | Older build members may be declared products or required evidence; directory names do not grant disposal authority. Disposable copies use [invocation scratch](../spec/validation-scratch.test.ts). |
| E18 | declined | Explicit pytest temporary trees inside declared artifacts retain that artifact's lifetime; default disposable fixtures use [invocation scratch](../spec/validation-scratch.test.ts). |
| E19 | fixed | Legacy publication inference is retired; changed-content submission and independent review now own research admission. See [research regressions](../spec/research-loop.test.ts). |

E12-progress is a separately repaired backward-clock progress defect, outside the
19 original dispositions. Execution identity and byte growth establish progress
without relying on increasing wall-clock timestamps; unchanged bytes do not count
twice. See [watchdog source](../src/stage-watchdog.ts) and the stream-growth control
in [batch regressions](../spec/engine-batch-regressions.test.ts). This does not
reclassify the original carrier-deletion entry or establish the historical flake's cause.

The first review also required two production corrections. R1 originally confined rollback; C1 confines frozen Git restoration
to a physically confined parent: a substituted outward ancestor yields an honest
restoration failure and leaves outside bytes untouched. Outward leaf aliases can
still be replaced safely; see [frozen Git restoration](../src/scheduler/sched_scope/frozen-inputs.ts)
and the ancestor-substitution controls in [batch regressions](../spec/engine-batch-regressions.test.ts).

The legacy result-slot publication mechanism has been retired. Research submissions are
identified by candidate-root content digests against the retained best. Unchanged content
is journaled without measurement. See [the loop](../src/scheduler/sched_policy/research.ts),
[regressions](../spec/research-loop.test.ts) and the [brief contract](brief-contract.md).


Current run retention retires invocation scratch while preserving historical stage workspaces.
The E17/E18 dispositions above record the original review; current behavior is documented
under [storage ownership](operations.md#storage-ownership).
