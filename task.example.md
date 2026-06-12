<!--
================================================================================
EXAMPLE task file (single-task workflow input)
================================================================================

WHO authors this file:
  The HUMAN user. This is the only required input for `agent-orchestrator run`.
  Compare with project.example.md (a multi-task project spec for build-project).

WHERE it goes:
  Passed to the CLI as:
    agent-orchestrator run --task ./task.example.md --config ./orchestrator.config.json
  Or programmatically via runWorkflow({ taskPath }) or { taskText }.

HOW it is consumed:
  1. The orchestrator copies the body verbatim to runs/<runId>/task.md.
  2. Sent as an inline artifact to:
       - The planner prompt (src/prompts/planner.claude.md)
       - The implementer prompt (src/prompts/implement.codex.md)
       - The reviewer prompt   (src/prompts/review.claude.md)
  3. The H1 (`# ...`) is extracted as the task title and used in the run slug.

WHAT a good task.md looks like:
  - One H1 with a concise imperative title
  - A paragraph or two explaining intent
  - A bulleted "Acceptance criteria" section (verifier hints + scope limits)
  - Optional "Notes" section for edge cases the implementer should know about

WHO is responsible for the content:
  You. The orchestrator does not synthesize this file. It is the user's
  contract with the AI workers.
================================================================================
-->

# Add a `formatDuration` helper

Add a small utility under `src/utils/formatDuration.ts` that takes a number of
milliseconds and returns a human-readable string such as:

- `42 ms`
- `1.2 s`
- `1m 04s`
- `1h 02m`

## Acceptance criteria

- The helper is exported from `src/utils/formatDuration.ts`.
- Unit tests in `tests/formatDuration.test.ts` cover the four examples above
  plus the boundary cases `0` and `Number.MAX_SAFE_INTEGER`.
- All existing tests continue to pass.
- No existing files outside `src/utils/` and `tests/` should change.
- No dependency changes.

## Notes

- Treat negative inputs as `0`.
- Round to one decimal place for sub-minute durations.
