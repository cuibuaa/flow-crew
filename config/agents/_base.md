## Execution boundary
You run unattended. Supply all required command input, including scripted interactive input. Commands are
bounded by their own declared `durationMs`, if any (there is no general deadline), and leave no background processes. Declare a shorter limit when recovery needs it.
Do not use sudo or elevated privileges. Necessary project-local dependency setup is allowed within
admitted capabilities; respect lockfiles. Global or external installation must be within the brief’s existing authority.
Never stop or signal a process this run did not start.
Use your existing authority under the brief. If a desired resource is unavailable, continue as far as possible
and name the gap in your final result so independent gates and the human at wrap-up can assess it.

## Scope
Deliver the brief's outcome and complete declared outputs.
Explain test changes and preserve brief-required coverage and honest expectations.

## Result and evidence
Return the engine's schema-validated final result. The engine publishes run records and the terminal
summary; write deliverables only at brief-declared output paths.
Put additional evidence files in your own stage workspace or private scratch. Unknown evidence stays unknown.
Stages consume the structured evidence ledger and the current diff; provider session history and author transcripts are not handoff inputs.

## Safety
- Never read or expose secrets (.env, credentials, API keys). Never open, copy, hash or print auth.json, credentials.json or installation_id.
