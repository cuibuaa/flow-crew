# FlowCrew Atom Architecture

> Status: adopted. P0–P4 complete.

## The core idea

FlowCrew is built on **self-describing atomic semantics**:

> atoms (self-describing semantics) → a **registry** collects them → they are **injected into the planner** at runtime → the planner **composes** them into a run → each semantic **maps to concrete roles** that execute → a complex task is accomplished.

The invariant that makes this maintainable:

> **Semantics live at the atom's own source (its code/config), injected at runtime. The planner prompt is a STABLE composition engine — never a semantics dictionary. Domain-specific semantics live in the project/brief layer, never in the engine.**

The reference atom is the **role**: each `config/agents/*.yaml` self-describes via `description:`; `buildRoleRegistry()` collects them; `{available_roles}` is injected into the planner prompt; the planner emits `role:` per stage; the engine validates against the registry. Adding a role requires **zero** planner-prompt edits. Every composable primitive should reach this bar.

## Why (the drift problem)

When an atom's semantics live in the planner prompt (or are duplicated between prompt and engine), every change to that semantic requires a hand-edit to the prompt, and the two copies drift. Today only `role` (and partially `skill`) are registry-injected; everything else — checks, the dispatch-DSL schema, the verdict/terminal/phase contracts, research policies, campaign triggers, supervisor verdicts — is prose-only or double-sourced. Net: changing a check type / gate semantic / terminal condition / policy all currently require editing `config/agents/planner.yaml`, and at least one drift already exists (`condition:` is implemented + validated but undocumented to the planner).

## The unifying abstraction

Every composable primitive exports a uniform descriptor and is collected into one registry:

```ts
interface AtomDescriptor {
  kind: 'role' | 'skill' | 'check' | 'policy' | 'terminal' | 'health';
  id: string;                 // the name the planner references
  description: string;        // what it does / when to use — the semantic the planner reads
  params?: JSONSchema;        // declared param shape; the engine validates the planner's usage
  mapsToRoles?: string[];     // which role(s) execute this semantic
}
```

- `buildAtomRegistry()` (generalizes `buildRoleRegistry`) collects descriptors from each source.
- `{available_atoms}` (grouped by kind) is injected into the planner prompt (generalizes `{available_roles}` / `{available_skills}`).
- The planner composes by referencing atom `id` + params; the engine **validates the dispatch against each atom's `params` schema** — this replaces the hand-mirrored Zod-vs-prose dispatch schema, killing that drift.
- Adding/changing any atom = edit its descriptor next to its code/config; the planner auto-syncs. **No planner-prompt edits.**

### Two layers of semantics

- **HOW (atom vocabulary)** — flow-crew's self-describing atom registry. General, public.
- **WHAT (domain constraints)** — a project-local acceptance contract (`<project>/.flowcrew/contract.yaml`) + the brief. The planner reads it and wires deterministic gates from atoms. Domain specifics never enter the engine.

Hard constraints (e.g. survival/no-liquidation in trading) must be enforced by **deterministic** atoms (checks), not by an agent-judged QA prompt (gameable). The planner may *derive* what to check from the goal, but enforcement goes through deterministic check atoms.

## Inventory (state at adoption)

| atom | self-describing | registry | injected to planner | planner composes | semantics live |
|---|:--:|:--:|:--:|:--:|---|
| role ✅ reference | yes | yes | yes | yes | config/agents/*.yaml |
| skill | no (name only) | partial | partial (names) | yes (blind) | config/skills/*.md |
| check (reality-gate) | no | engine-internal | no | no | reality-gate/checks/* |
| dispatch-DSL | no (double) | no | prose | yes | Zod scheduler.ts + planner prose (drifted: `condition`) |
| verdict/terminal/phase contract | no | no | prose | emit (blind) | store.ts + prose |
| research policy | no (enum ×2) | no | no | no | research-policy.ts + brief |
| campaign trigger/health | no (if-ladder) | no | thresholds only | no | scheduler.ts |
| supervisor verdict | no (double) | no | (supervisor only) | — | supervisor.ts |
| workflow / adapter | partial | no | operator-selected | no | config (acceptable — not a planner atom) |

## Roadmap

- **P0 — done.** Extract trading-domain logic from the general engine (research integrity gates → brief-declared `research.integrity`; terminal-study-completion gate → generic verdict contract). `src/` is now task-agnostic.
- **P1 — checks + skills to the role bar.** Each reality-gate check exports a descriptor (name/description/params); `buildCheckRegistry` + `{available_checks}` injection. Skills get front-matter (`name`/`description`); `buildSkillRegistry` surfaces descriptions (not just filenames). The planner can now compose deterministic checks, not only free-text QA prose.
- **P2 — single source of truth.** Generate the planner's dispatch schema, verdict contract, terminal vocabulary, and phase-metadata field list from the engine's own definitions (no prose mirror); document `condition`; the engine validates the dispatch against atom param schemas.
- **P3 — project contract.** Read `<project>/.flowcrew/contract.yaml` (domain hard constraints + metric); inject it; the planner wires deterministic gates from atoms + contract. Realizes "planner ↔ project semantics" coupling. The planner authors its deterministic checks to `{run_dir}/reality_checks.md` (a `## Reality checks` block); `enforceRealityGateBeforeTerminal` runs brief-authored AND planner-authored checks at terminal — this is how the planner's choice of deterministic gates actually takes effect.

### Validation

A planner-matrix test exercises the planner against a task matrix. Deterministic layer (capturing adapter): asserts every atom is injected into the planner's resolved prompt and that planner-authored `reality_checks.md` is enforced (passes when the deliverable exists, blocks terminal when missing). Real-LLM layer: the live planner composes coder+qa with deterministic checks for a build task, reaches for the `researcher` atom on an exploratory task, and — given a project contract — wires the contract's hard constraints as deterministic `exec-script-exit-zero` / `file-exists-nonempty` checks.
- **P4 — remaining atoms.** Research policies, campaign health triggers, supervisor verdicts become single-source, descriptor-driven (extensible; no if-ladders / double sources).

### End state

`config/agents/planner.yaml` shrinks to a stable composition contract: "Here are the available atoms `{available_atoms}` (roles/skills/checks/policies/terminals, each with description + params). Here is the project contract (hard constraints). Compose a run: map each needed semantic to atoms; enforce hard constraints with deterministic check atoms; end at the goal gate." No specific semantics, no hand-mirrored schema. The engine is the single source of truth; the planner and project semantics stay in sync at runtime with zero drift.
