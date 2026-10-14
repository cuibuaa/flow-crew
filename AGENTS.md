# Working on FlowCrew

## Design principle: the simplest architecture that solves the problem

FlowCrew turns a written goal into reviewed work. What it offers is a few guarantees (isolated writes, independent
verification, an honest report), not the number of mechanisms around them. Keep the core small, in the spirit of
minimal agent harnesses such as [Pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent), which ships four
tools and a system prompt under a thousand tokens and leaves everything else to extensions.

- Solve a problem by removing or restructuring the mechanism that causes it, not by adding a special case beside it.
- A new mechanism has to replace at least as much as it adds. If it cannot, say why in the change, and prefer not to
  build it.
- Prefer one general primitive over several narrow channels. Before adding a channel, check whether an existing one can
  carry the case.
- Measure before and after on the same work. A change that is not shown to help, or whose cost it does not pay back,
  is not kept.
- Keep the surface small: fewer options, fewer states, fewer files. Whatever is not needed for a guarantee belongs in
  an extension or in the operator's tooling, not in the core.
- Ask a stage for a result, not for its steps. A brief states the goal, the evidence, the real constraints and what the
  report must show; the run decides how. The engine should hold itself to the same rule.

Every other guide in this repository (`CONTRIBUTING.md`, `guide/`) is subordinate to this one when they pull in
different directions.
