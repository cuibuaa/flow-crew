# FlowCrew Autonomous Loop

> Status: proposed (draft for review). Builds on [Atom Architecture](atom-architecture.md).

## The core idea

FlowCrew is a **general autonomous substrate**, not a research tool. Auto-research and auto-engineering are the *same loop* with *different atoms plugged in*:

```
given an Objective:
  while not Terminal:
    candidate = Propose(Objective, Ledger, Context)   # a new direction / change to try
    artifact  = Execute(candidate, Roles)             # planner composes → roles execute
    verdict   = Evaluate(artifact, Checks)            # deterministic pass/fail + score
    decision  = Policy(history + verdict)             # continue | ship | stop
    Ledger.record(candidate, verdict, decision)       # accumulate → next Propose dedups & converges
  → Terminal: shipped | ceiling | blocked→escalate
```

Research vs. engineering differ ONLY in which atoms fill `{Objective, Candidate, Checks, Policy}`. The loop structure, control flow, and termination are identical and task-agnostic.

The invariant (extends the Atom Architecture invariant from *composition* to the *loop itself*):

> **The loop is an engine parameterized by atoms. The engine never encodes what a goal/candidate/verdict/decision MEANS — those are self-describing atoms declared in the brief/contract and collected in registries. The same engine drives research, engineering, and any future task type. A new task type adds atoms, never engine branches.**

## Why (what's wrong today)

1. **The loop is hard-coded per workflow.** `default.yaml` (plan-execute-review) and `research.yaml` (dynamic-dispatch) are two *different* loops. Adding "auto-engineering with a fix-retry loop" means a third workflow, not an atom config. The loop is not yet an atom-composed primitive.
2. **Fragmented terminal authority.** Four mechanisms can end a run (terminal-file > research-policy > supervisor-DONE > gate-pass+nextPhase). On a research run the policy *should* be authoritative, but agents bypass it by under-journaling rounds or reframing a ceiling as `nextPhase=operator_decision` (observed). No single owner of "done."
3. **No outer loop.** The campaign driver (`campaign.ts:runCampaign`) is a synchronous, *human-authored-rule* diagnosis loop — not an agent that proposes the next direction. There is no `Propose` at campaign scope; a human launches each run and hand-maintains the tried-directions catalog.
4. **No world-model atom.** The proposer only sees what the brief hand-enumerates (it missed on-disk data assets and prior work → mis-signposted "acquire data we already have").

## The primitives (atom semantics)

A complete autonomous loop needs exactly eight primitives. Four already exist as atoms; four must be promoted to first-class atoms.

| Primitive | Declares | Research instance | Engineering instance | Today |
|---|---|---|---|---|
| **Objective** | the done-condition + a progress measure | `metric ≥ baseline + margin` | acceptance/AC checks all pass; feature implemented | partial (`research:` frontmatter) → **generalize to `objective:`** |
| **Candidate** | one proposed unit → artifact(s) + a schema-validated result | a mechanism → `round_result` | a change → `{build_ok, tests_passed, ac_status[]}` | implicit → **promote to first-class** |
| **Verdict (Check)** | a deterministic pass/fail + score on an artifact | 9 gates + gate-gated metric | build / tests / reality-gate checks | ✅ reality-gate atoms |
| **Policy** | `(history of verdicts) → continue \| ship \| stop` | best_of_n + beat/halt + significance margin | ship-when-AC-pass; fix-and-retry; stuck→escalate after N no-progress | ✅ research-policy → **generalize to `LoopPolicy`** |
| **Ledger** | append-only `{candidate, verdict, decision, scope}`; the frontier | tried directions + results | tried approaches + dead-ends + failing tests | partial (KG + campaign entries) → **promote + inject** |
| **Context** | the world-model: available data/code/tools + prior work | data inventory + prior V's | repo map + tool list + test suite | ❌ brief hand-feeds → **auto-inventory atom** |
| **Terminal / Escalation** | the done/stuck/blocked vocabulary + the operator-handoff contract | shipped / ceiling / need-new-data | shipped / blocked / needs-decision | ✅ terminal-vocab → **add escalation contract** |
| **Role** | an executor that realizes a candidate (planner composes, roles execute) | researcher / implementer / qa | coder / reviewer / qa / doc_* | ✅ full set kept |

### Descriptor shapes (sketch)

- **Objective** (brief frontmatter / `contract.yaml`): `{ kind: metric|acceptance, done: <condition>, progress: <how the policy reads progress>, ... }`. Research `kind: metric` reuses today's `baseline/beat/higher_is_better/margin`. Engineering `kind: acceptance` lists the checks that constitute "done."
- **Candidate**: `{ label, artifacts: [...], result }` where `result` conforms to the brief's `result_schema` atom (already single-sourced + engine-validated per iteration).
- **Policy**: a registered descriptor (like `RESEARCH_POLICIES`) exposing `decide(history, objective) → {action, reason}`. Research and engineering register different policies; the engine calls the same interface.
- **Ledger**: typed view over `knowledge-graph.json` + campaign entries; injected as `{ledger_digest}` (compact "what's been tried + verdict") — always-on even under `--no-inherit-campaign` (it is the dedup ledger, not verbose narrative).
- **Context**: engine scans configurable `context_roots` (default `data/`, the repo) → `{context_inventory}` (paths/schemas/tools + `prior_work_digest`). The proposer must consult it before signposting "acquire X."
- **Terminal/Escalation**: a `blocked`/`needs_decision` terminal carries `escalation: { blocked_on, needed, options }` for a clean operator handoff.

## The loop engine

Collapse `default.yaml` + `research.yaml` into ONE adaptive loop engine, parameterized by the atoms above:

```
runLoop(objective, policy, context, ledger, scope):
  plan = planner.compose(objective, available_roles, available_checks, context, ledger)
  while true:
    candidate = dispatch(plan)                 # roles execute
    verdict   = evaluate(candidate, checks)    # reality-gate
    decision  = policy.decide(ledger.history, verdict, objective)
    ledger.record(candidate, verdict, decision)
    if decision.action != 'continue': return terminal(decision)   # POLICY is the sole terminal authority
```

**Scopes are the same engine, nested:**
- **Inner (run):** a candidate is a *mechanism / change*; `Execute` = implement + measure.
- **Outer (campaign):** a candidate is a *direction*; `Execute` = spawn an inner loop; `Ledger` is the cross-run frontier. The missing campaign "T_planner" is just `Propose` at outer scope.

## Control convergence (the subtractions)

- **Policy is the sole terminal authority.** Remove the bypasses: on a loop run, the gate-pass+`nextPhase` completion path, supervisor-DONE, and under-journaling can no longer end the loop. The supervisor advises/aborts; it does not declare "done." A terminal requires `policy.decide → ship|stop` after the objective's minimum-evidence floor.
- **One launch channel.** Unify `campaign.ts`'s blocking loop with the daemon/orchestrator queue (today they don't integrate; pending tasks never drain). One mechanism launches + sequences runs.
- **One adaptive workflow** instead of `default` vs `research` (the brief's `objective:` selects the policy/loop shape).
- **Vocabularies → atoms, not hardcode.** `handoff.ts:DEFAULT_ROLE_VISIBILITY` and `worker.ts` `role.name === 'planner'` become agent-config self-declarations.

**Kept (NOT cut):** the dashboard/UI and the full role set (coder/reviewer/doc_*/paper_*) — they are the auto-engineering substrate. Only *confirmed* dead duplicates are candidates for removal, conservatively.

## Current → primitive mapping

| Primitive | Lives in (today) | Change |
|---|---|---|
| Objective | brief `research:` frontmatter; `store.ts` ResearchConfig | generalize to `objective:` (metric \| acceptance) |
| Candidate | `round_result.json` + `result_schema` | promote to a typed loop concept |
| Verdict | `reality-gate/checks/*` + `evaluateResearch` gate | keep; reuse for engineering checks |
| Policy | `research-policy.ts` (`RESEARCH_POLICIES`) | generalize → `LoopPolicy` registry |
| Ledger | `knowledge-graph.ts` + `campaigns.ts:writeCampaignEntry` | typed view + `{ledger_digest}` injection |
| Context | — (brief hand-fed) | NEW `data-inventory.ts` + `campaign-ledger.ts` |
| Terminal | `store.ts` TERMINAL_STATUSES | add escalation contract |
| Role | `config/agents/*` + roleRegistry | keep |
| Loop engine | `scheduler.ts` research advance gate + 2 workflows | one engine; collapse workflows |

## Roadmap

- **P1 — primitives + single terminal authority.** Promote Objective/Candidate/Ledger/Context to atoms; make Policy the sole terminal owner on loop runs (close the bypasses); add the empirical/evidence floor + round-journaling fidelity.
- **P2 — one loop engine.** Collapse `default`+`research` into one atom-parameterized loop; auto-select policy from `objective:`.
- **P3 — outer scope (autonomous campaign).** `Propose` at campaign scope (the campaign planner role) reads the Ledger + Context to propose the next direction; campaign-level frontier-stop. One launch channel.
- **P4 — convergence + cleanup.** Vocabularies→atoms; unify launch; remove confirmed dead duplicates only.

### Validation
A second task type proves generality: define an **auto-engineering** objective (`kind: acceptance`, checks = build+tests) and run it on the SAME loop engine with zero engine branches — only a different atom config.

### End state
One loop engine, eight self-describing primitives, two scopes (run, campaign). Adding a task type = adding atoms. The engine proposes, executes, evaluates, decides, and records autonomously until it ships or honestly escalates — for research, engineering, or anything composed from the same primitives.
