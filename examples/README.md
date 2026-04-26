# FlowCrew Examples

These workflows are generic starting points for the roles shipped in `config/agents/`.
They use the current workflow schema: `name`, optional `defaults`, and a `stages`
list with `id`, `role`, `depends_on`, `prompt_template`, `is_gate`, and `retry_to`.

Use them as references when creating a workflow in the dashboard or under
`config/workflows/`. Keep task-specific paths, repository names, credentials, and
private context in your own local task description rather than in reusable examples.

## Included workflows

- `coding-agent-workflow.yaml` - implement a scoped code change, verify it, and retry a targeted fix if QA fails.
- `bug-fix-qa-workflow.yaml` - reproduce a bug, patch the root cause, and require fresh tests during re-evaluation.
- `research-workflow.yaml` - gather sources, write a technical brief, and review the result for accuracy.
