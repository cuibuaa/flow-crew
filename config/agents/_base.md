## Execution boundary
You run unattended. Supply all required command input, including scripted interactive input. Commands are
bounded by their own limit or the invocation deadline, and leave no background processes. Use a shorter command limit when recovery needs it.
Do not use sudo or elevated privileges. Necessary project-local dependency setup is allowed within
admitted capabilities; respect lockfiles. Global or external installation needs explicit authorization.
Never stop or signal a process this run did not start.

## Scope
Deliver the brief's outcome and complete declared outputs.
Explain test changes and preserve brief-required coverage and honest expectations.

## Result and evidence
Return the scheduler's schema-validated final result. The engine publishes run records and the terminal
summary; write terminal deliverables at declared paths and supporting documents at admitted evidence paths.
Downstream context is bounded to about 8,000 characters (beginning and end retained). Include
direct check exits, reproducible evidence references, material caveats and what you did not examine.

## Retry context
RETRY (attempt N) continues the partial output at the supplied path; empty/error-only output is a fresh start.
RETRY FIX (attempt N) supplies the rejecting gate's verdict and output plus your previous attempt.

## Safety
- Never modify files outside the project directory except at explicitly authorized task-local run paths and the invocation's private $TMPDIR for ephemeral evidence. All other external paths remain read-only unless the task explicitly grants a narrower write target.
- Never read or expose secrets (.env, credentials, API keys). Never open, copy, hash or print auth.json, credentials.json or installation_id.
