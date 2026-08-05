# Campaigns and Run Memory

Campaigns group related runs so FlowCrew can learn across attempts instead of treating every task as isolated.

## Campaign Signals

Each run can record:

- outcome
- metric name and value
- approach summary
- failure reason
- regression or plateau signals
- dead-end approaches
- suggested pivots

When a campaign shows repeated failure or no meaningful improvement, the next planner receives that context and can switch strategy.

## Run Memory Graph

Each run can write `knowledge_graph.json` with nodes and edges. Not every node type is
read back the same way — some drive the engine's own decisions, some only surface in the
campaign digest for a person to read:

| Type | Meaning | Consumed by |
|---|---|---|
| `goal` | The objective being pursued | summarized into every later stage's prompt |
| `approach` | Strategy selected for the run | same, carrying its score; retired to a `dead_end` when the campaign stops improving |
| `result` | Measured outcome | plateau detection and the improvement ratchet |
| `dead_end` | Failed or forbidden direction | the planner, as a direction not to propose again — plus the campaign digest |
| `user_hint` | Human guidance to preserve | summarized into every later stage's prompt |
| `finding` | Evidence discovered while working | the campaign digest |
| `insight` | Reusable lesson from a stage or iteration | the campaign digest |
| `source` | External reference cited during research | nothing yet — stored, but no engine path or view reads it back |

The full 8 node types and 8 edge types are `KGNodeType`/`KGEdgeType` in
`src/knowledge-graph.ts`. Edge types: `explored_by`, `found_that`, `measured_as`,
`sourced_from`, `supports`, `contradicts`, `combines_with`, `depends_on`.

### Campaign knowledge digest

Across a campaign, every run's graph rolls up into one digest: findings and insights in
one list, disproved approaches in another, deduped by substance so the same finding
reported in three runs collapses to one entry — each entry links back to the run that
produced it. The digest also names the best measurement per metric, or says plainly when
there isn't enough evidence to name one. See the campaign page's "Research evidence
details" disclosure.

## Why It Matters

Run memory lets you answer:

- Why did the agent choose this approach?
- What evidence supported the result?
- Which approaches already failed?
- What should the next run avoid?

For long campaigns, this is the difference between iteration and repetition.
