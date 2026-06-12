# agent-orchestrator

A local-first orchestration service that coordinates multiple AI coding tools — **Claude Code**, **OpenAI Codex CLI**, **Cursor**, and (later) any MCP-compatible agent — as **isolated workers**. The orchestrator is the only component that invokes workers; it owns task state, routing, permissions, cost limits, retries, timeouts, and logs.

> **Goal:** safe, auditable, artifact-driven multi-agent coding.
> **Non-goal:** letting agents freely chat with each other.

---

## Why centralized orchestration

When agents call each other directly, you lose:

- a single source of truth for task state,
- an enforcement point for safety policy,
- consistent cost/timeout limits,
- an audit trail.

You also accumulate the worst kind of failure mode: one model hallucinates a tool name, another model dutifully “invokes” it, and nothing about the failure is reproducible.

This service inverts that. **Workers are dumb**: they receive an instruction and a small set of structured artifacts, and they return text + JSON. **The orchestrator is smart**: it owns the workflow, captures every artifact under `runs/<timestamp>-<slug>/`, and is the only thing that decides what runs next.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            orchestrator                                  │
│  ┌──────────┐    ┌────────────┐    ┌──────────┐    ┌──────────┐          │
│  │  plan    │ →  │ implement  │ →  │  review  │ →  │  verify  │ → DONE   │
│  │ (claude) │    │  (codex)   │    │ (claude) │    │  (shell) │          │
│  └──────────┘    └────────────┘    └────┬─────┘    └────┬─────┘          │
│                                         │               │                 │
│                                request_changes      verifier failed       │
│                                         ↓               ↓                 │
│                                       ┌─────── repair (codex) ───┐        │
│                                       └─→ next round (≤ maxRounds)        │
└──────────────────────────────────────────────────────────────────────────┘
              ▲                                                ▲
       artifacts in/out                                 deterministic
       (task.md, plan.json,                              checks only
        patch.diff, review.json)
```

The cycle is **review-first**: every round begins by asking the reviewer to look at the current patch (and the previous round's verifier output, if any). The reviewer chooses one of three:

- **`approve`** → the orchestrator runs the verifier. If it passes, the run is **DONE**. If it fails, the next round repairs.
- **`request_changes`** → the orchestrator **skips** the verifier this round (no point running tests against code the reviewer already rejected) and routes the patch back to the implementer with the feedback.
- **`requires_human_review`** → the orchestrator stops and escalates.

This matches the natural shape of a code review on a PR: reviewer comments first, CI runs after the reviewer is satisfied, and the author iterates on both signals together.

Workers never invoke other workers. Risky changes (dependencies, migrations, deletions, CI, secrets, security) are flagged as `requires_approval` instead of being auto-merged.

---

## Setup

```bash
cd agent-orchestrator
npm install
npm run build      # compiles TypeScript and copies prompt templates to dist/
```

You can run the CLI without installing globally:

```bash
node dist/cli.js run --task ./task.example.md --config ./orchestrator.config.example.json
```

…or in dev mode:

```bash
npm run dev -- run --task ./task.example.md --config ./orchestrator.config.example.json
```

### Required external tools

The orchestrator only spawns the worker CLIs you enable in the config. For the defaults you’ll want:

- `claude` — [Claude Code CLI](https://docs.claude.com/claude-code), used in non-interactive `-p` mode
- `codex` — OpenAI Codex CLI, used as `codex exec`
- `cursor-agent` — optional, only if you enable the Cursor worker

If a worker is disabled the orchestrator uses a **deterministic fallback** for planning and review so the workflow still runs end-to-end (useful in CI and for tests).

---

## Configuration

`orchestrator.config.example.json`:

```json
{
  "projectRoot": ".",
  "maxRounds": 3,
  "timeoutSeconds": 900,
  "workers": {
    "claude": { "enabled": true,  "command": "claude",       "args": ["-p"] },
    "codex":  { "enabled": true,  "command": "codex",        "args": ["exec"] },
    "cursor": { "enabled": false, "command": "cursor-agent", "args": ["-p"] }
  },
  "verifier": {
    "commands": ["npm test", "npm run lint", "npm run typecheck"]
  },
  "safety": {
    "allowedPaths": ["src/**", "tests/**", "docs/**"],
    "approvalRequiredFor": [
      "dependency_change", "migration", "delete_file",
      "ci_change", "secret_change", "security_change"
    ],
    "denyShellPatterns": [
      "rm -rf /", "curl * | sh", "wget * | sh", "chmod 777", "sudo"
    ]
  }
}
```

Validation is strict (zod). The error messages tell you exactly which field is wrong and why.

### Routing: per-stage workers/models and task categories

By default the stage→worker mapping is fixed (plan/review/decompose → claude, implement/repair → codex). The optional `routing` section overrides it:

```json
{
  "routing": {
    "stages": {
      "plan":   { "model": "opus" },
      "review": { "model": "sonnet" }
    },
    "categories": {
      "quick": {
        "implement": { "worker": "claude", "model": "haiku" },
        "review":    { "model": "haiku" },
        "maxRounds": 1
      },
      "deep": {
        "maxRounds": 5
      }
    }
  }
}
```

- **`stages`** sets the default worker and/or model per stage. `model` is passed to the worker CLI (`claude --model …`, `codex -m …`).
- **`categories`** overrides stages per task category, plus an optional per-category `maxRounds`. Resolution order: category route → stage route → built-in default.
- **Categories** are `quick` / `standard` / `deep` by convention. The decomposer assigns one to every backlog task (consistent with `estimated_complexity`); single-task runs take `--category <c>`.
- A worker named **explicitly** in a route must exist and be enabled — the run fails fast with a `RoutingError` instead of silently falling back. Built-in defaults resolving to a disabled worker keep today's deterministic-fallback behavior.

### Multi-perspective review panel

Instead of one reviewer, N reviewers can examine the same patch in parallel, each through a different lens, with their verdicts merged:

```json
{
  "review": {
    "panel": {
      "enabled": true,
      "decision": "strict",
      "trigger": "risky",
      "triggerFileThreshold": 10,
      "perspectives": [
        { "name": "correctness", "focus": "logic errors, edge cases, regressions" },
        { "name": "security",    "focus": "injection, authz, secret exposure" },
        { "name": "testing",     "focus": "coverage of changed behavior", "model": "haiku" }
      ]
    }
  }
}
```

- Verdict merge: `requires_human_review` from **any** member always escalates; `request_changes` needs one vote (`strict`) or more than half (`majority`); otherwise `approve`.
- Findings are merged with a `[perspective]` prefix, so the repair prompt shows who raised what. Downstream (repair / reports) consumes the merged `review.r<N>.json` — per-member verdicts are kept as `review.r<N>.<perspective>.json`.
- `trigger: "risky"` runs the panel only when the diff carries risk tags / path violations or touches ≥ `triggerFileThreshold` files; `quick`-category tasks always use the single reviewer (cost control).
- Each perspective may pin its own `worker`/`model`; unset fields inherit the review stage route.

---

## Example task

`task.example.md`:

```markdown
# Add a `formatDuration` helper

Add a small utility under `src/utils/formatDuration.ts` that takes a number of
milliseconds and returns a human-readable string …

## Acceptance criteria
- The helper is exported from `src/utils/formatDuration.ts`.
- Unit tests in `tests/formatDuration.test.ts` cover the boundary cases.
- All existing tests continue to pass.
- No dependency changes.
```

---

## Two execution scopes

The orchestrator runs at two levels:

1. **Single-task workflow** (`runs/<id>/`) — one `task.md` → plan → implement → verify → review → repair. Good for "fix this bug", "add this helper".
2. **Full-auto project builder** (`projects/<id>/`) — one `project.md` spec → automatic decomposition into a backlog → loop over tasks (each one runs the single-task workflow under the hood) → completion or budgeted stop. Good for "build me a tiny CLI / API / library".

```
project.md ─────► decompose ─────► backlog
                                     │
                                     ▼
                       ┌────────── pick next ready task ◄─────────┐
                       │                                          │
                       ▼                                          │
              renderTaskBriefing(task, state, history)            │
                       │                                          │
                       ▼                                          │
        runWorkflow:  plan → implement → verify → review          │
                       │                                          │
                       ▼                                          │
              update state, mark task done/failed/blocked  ───────┘
                       │
                       ▼  (when no runnable task remains, or budget hits)
                final_report.md
```

Both scopes share the same workers, safety policy, and conversation log.

## Four ways to call it

The orchestrator exposes both scopes through four front-ends — pick whichever fits the caller:

| caller                 | mode                                  | single-task                            | full-auto project              |
| ---------------------- | ------------------------------------- | -------------------------------------- | ------------------------------- |
| terminal users         | one-shot CLI                          | `agent-orchestrator run …`             | `agent-orchestrator build-project --spec ...` |
| terminal users         | **interactive chat REPL**             | `agent-orchestrator chat`              | (use the CLI directly)          |
| Claude Code / Cursor   | **MCP server** (stdio)                | `run_task` tool                        | `build_project` tool            |
| ChatGPT custom GPTs    | **HTTP API** with OpenAPI spec        | `POST /runs`                           | `POST /projects`                |

All four record the same conversation log under `runs/<id>/conversation.jsonl` + `conversation.md`. Project mode adds a project-level audit log under `projects/<id>/timeline.jsonl`.

### A. One-shot CLI

```bash
agent-orchestrator run \
  --task ./task.example.md \
  --config ./orchestrator.config.example.json
```

You can also pass the task body inline (no file needed):

```bash
agent-orchestrator run --task-text "$(cat <<'EOF'
# Add formatDuration helper

Implement `src/utils/formatDuration.ts` with unit tests.
EOF
)" --config ./orchestrator.config.example.json
```

### A2. Full-auto project builder

> **Dogfood result**: this mode was used to drive a full Express + SQLite + EJS bulletin-board project end-to-end (8 tasks: setup → DB → auth → posts → views → server → tests → verify) with the orchestrator handling auto-install of dependencies, producing one git commit per task, running `npm test` after every task, then `curl http://localhost:3000/` returned 200 with working signup/login/post-creation flows. Total wall time: ~25 s for the full pipeline. Dogfood surfaced six structural fixes now part of the orchestrator:
>
> 1. **Runtime export of zod schemas** — consumers can validate config programmatically.
> 2. **Per-task auto-commit** (`autoCommitBetweenTasks`) — each task starts from a clean working tree; produces a clean per-task git history.
> 3. **`acknowledged_risks`** (per-task and project-wide via `--ack`) — a `Build auth router` task can legitimately touch security-sensitive paths without tripping the manual-approval gate.
> 4. **Auto-install before verifier** (`verifier.autoInstall`) — when `package.json` / lockfiles change, the orchestrator runs `npm install` (or `yarn`/`pnpm`, auto-detected) before `npm test`. Without this, every fresh project's first verifier round trips on missing deps.
> 5. **`--resume <projectId>`** — pick up a stopped project; backlog and state load from disk; failed tasks auto-reset to pending so retries pick up cleanly.
> 6. **Project totals + per-task duration/round counters** — `final_report.md` shows aggregate wall time, repair rounds, file change counts.


For projects bigger than one task — the orchestrator decomposes the spec into a backlog and runs each task to completion (or hits a budget cap).

```bash
agent-orchestrator build-project \
  --spec ./project.md \
  --config ./orchestrator.config.json \
  --max-tasks 30 \
  --max-seconds 3600
```

Inline spec:

```bash
agent-orchestrator build-project --spec-text "$(cat <<'EOF'
# Tiny hello CLI

## Setup
Initialize a TypeScript project under src/.

## Implement
Add `src/hello.ts` exporting `hello(name?)`.

## Test
Add `tests/hello.test.ts` covering both cases.
EOF
)" --config ./orchestrator.config.json
```

What happens:

1. **Decompose** — Claude turns the spec into a strict-JSON backlog of 5–15 atomic tasks with `depends_on` edges. (If Claude is disabled, a deterministic fallback splits by `##` sections / bullets.)
2. **Loop** — for each ready task (deps satisfied), build a task briefing that includes the spec, definition of done, files-touched-so-far, recent task outcomes, and open blockers. Hand it to `runWorkflow` (which is the existing single-task pipeline).
3. **Reconcile** — mark the task `done` / `failed` / `blocked` / `needs_approval` based on the run's status. Failed dependents transitively become `blocked`. Retryable failures (verifier failed, review requested changes) get re-queued up to `maxAttemptsPerTask`.
4. **Stop** when the backlog is exhausted, or `maxTasks` / `maxWallClockSeconds` / `maxConsecutiveFailures` is hit.

Generated artifacts:

```
projects/20260509-094200-tiny-hello-cli/
├── spec.md                 input spec
├── decomposition.json      initial backlog (immutable)
├── backlog.json            current backlog state (mutated as tasks finish)
├── state.json              cross-task working memory (knownFiles, blockers)
├── timeline.jsonl          append-only project-level audit log
├── final_report.md         human-readable summary
├── final_report.json       same data, machine-readable
└── tasks/
    ├── 20260509-094200-setup/      ← each = a complete runs/ dir
    ├── 20260509-094215-implement/
    └── 20260509-094230-test/
```

Exit codes (project mode):

| code | meaning                                              |
| ---: | ---------------------------------------------------- |
|    0 | completed (every task `done`)                         |
|   10 | stopped — too many consecutive failures               |
|   11 | stopped — remaining tasks all blocked                 |
|   12 | stopped — one or more tasks need human approval       |
|   13 | stopped — task / wall-clock budget exhausted          |
|   14 | stopped — spec needs clarification (interview mode)   |
|   20 | internal error                                        |

Reading the result:

- `final_report.md` — quick triage; backlog table with per-task status; suggested human action.
- `timeline.jsonl` — chronological audit of every project-level event (task picked / finished / blocked / budget exhausted).
- Per-task `tasks/<runId>/conversation.md` — the prompt/response trail for that one task.

### A3. Interview gate and completion loop (project builder)

Two optional `project` settings push the builder closer to "give it a spec, get a finished project":

```json
{
  "project": {
    "interview": "auto",
    "maxReplans": 2
  }
}
```

- **`interview`** — before decomposing, a clarifier reads the spec and surfaces genuinely ambiguous points (0–5 questions, each with a workable default):
  - `off` (default) — skip.
  - `auto` — adopt each question's default assumption, record them in the spec under `## Assumptions (auto-adopted)`, continue. Every downstream prompt sees the adopted defaults.
  - `required` — stop with status `needs_clarification` (exit code **14**); the questions land in `clarification.json` and the final report. Answer them by editing the spec, then re-run.
  - The gate **fails open**: a disabled worker or an invalid clarifier response skips it rather than blocking the project.
- **`maxReplans`** — when the backlog would stop with failed/blocked tasks, a replanner gets the failed tasks + their errors and may emit replacement tasks with a *different approach* (ids `R<n>-…`). Replaced tasks become `superseded`, their dependents are rewired to the replacements, and the loop continues. Guarantees:
  - Budgets (maxTasks / wall-clock / consecutive failures) always win over replans.
  - `needs_approval` tasks are **never** replanned — no bypassing the human gate.
  - **Stall detection**: a lineage that fails twice with the same failure signature (status + error + files touched) is never replanned again.
  - Artifacts: `replan.<n>.json` per round, `replan` events in `timeline.jsonl`.

### A4. Parallel task execution (git worktrees)

```json
{
  "project": {
    "maxParallelTasks": 3
  }
}
```

With `maxParallelTasks > 1`, the project builder runs independent tasks concurrently, each in its **own git worktree** branched from the current HEAD (`.orchestrator/worktrees/…`, self-ignored). The full single-task pipeline — diff capture, review, verifier, safety checks — runs inside the task's worktree; on success the coordinator merges the task branch back with `--no-ff` (one merge commit per task).

- **Concurrency guard**: only tasks whose `allowed_paths` don't overlap run together (conservative prefix check). A task with no `allowed_paths` always runs alone. Dependency edges are respected as before.
- **Merge conflicts** fail the task; it's requeued and retried **solo** against the updated HEAD (counts toward `maxAttemptsPerTask`).
- All backlog/state/timeline writes happen in the single coordinator loop — no concurrent file writes. Slots refill as each task finishes (`Promise.race`), so one slow task doesn't hold up the others.
- Requirements (validated at start): `projectRoot` must be a git repository, and `autoCommitBetweenTasks` must stay enabled. Default is `1` — behavior identical to the sequential builder.

### B. Interactive chat REPL

```bash
agent-orchestrator chat --config ./orchestrator.config.example.json
```

```
agent-orchestrator chat — type a task, blank line to submit, :help for commands, Ctrl-D to exit.
projectRoot: /Users/me/work/my-project
workers: claude=true codex=true cursor=false

you> # Add formatDuration helper
    | Add a small util that takes ms and returns "1m 04s" etc.
    | Tests in tests/formatDuration.test.ts.
    |       (blank line submits)

--- starting run ---
  [orchestrator] plan: running planner
  [claude] plan → working…
  [claude] plan ← exit 0 (4321ms)
  [codex] implement r1 → working…
  [codex] implement r1 ← exit 0 (12013ms)
  [verifier] r1 $ npm test
  [verifier] r1 ✓ npm test (exit 0, 1820ms)
  [claude] review r1 → working…
  [claude] review r1 ← exit 0 (3110ms)

Run 20260508-103045-add-formatduration-helper — status: approved
  conversation log: …/runs/20260508-103045-add-formatduration-helper/conversation.md
  final report:     …/runs/20260508-103045-add-formatduration-helper/final_report.md

you>
```

REPL commands: `:runs`, `:show <runId>`, `:help`, `:quit` (or Ctrl-D).

### C. MCP server (Claude Code, Cursor, any MCP client)

```bash
agent-orchestrator mcp --config ./orchestrator.config.example.json
```

#### Install straight from GitHub (no clone needed)

The package builds itself on install (`prepare` script), so any machine with Node ≥ 18.17 can run the MCP server directly from this repository:

```bash
# one-liner registration in Claude Code (user scope):
claude mcp add agent-orchestrator --scope user \
  --env AGENT_ORCH_CONFIG=/abs/path/to/orchestrator.config.json \
  --env AGENT_ORCH_PROJECT_ROOT=/abs/path/to/your/project \
  -- npx -y -p github:ekdh600/agent-orchestrator agent-orchestrator-mcp
```

…or install the CLIs globally and reference the binary:

```bash
npm install -g github:ekdh600/agent-orchestrator
# → agent-orchestrator / agent-orchestrator-mcp on your PATH
```

Wire it up in **Claude Code** via the `claude mcp add` command above, or directly in `~/.claude.json`:

```json
{
  "mcpServers": {
    "agent-orchestrator": {
      "command": "npx",
      "args": ["-y", "-p", "github:ekdh600/agent-orchestrator", "agent-orchestrator-mcp"],
      "env": {
        "AGENT_ORCH_CONFIG": "/abs/path/to/orchestrator.config.json",
        "AGENT_ORCH_PROJECT_ROOT": "/abs/path/to/your/project"
      }
    }
  }
}
```

(If you installed globally or run from a local checkout, set `"command": "agent-orchestrator-mcp"` instead — the rest is identical.)

In **Cursor** add to `.cursor/mcp.json` with the same shape. Once registered, the model gets these tools:

| tool                    | purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `run_task`              | single-task workflow with `task` (inline) or `task_path`         |
| `list_runs`             | recent run IDs (most recent first)                               |
| `get_run_status`        | final report Markdown for a given run                            |
| `get_run_conversation`  | full chronological prompt/response log for a given run           |
| `get_run_artifact`      | fetch a single artifact file (`plan.json`, `patch.diff`, …)      |
| `build_project`         | **full-auto project builder** — decomposes a spec and loops over tasks |
| `list_projects`         | recent project IDs                                               |
| `get_project_status`    | a project's final report and backlog                             |

The model can now ask "run this task and tell me what the verifier said" and the MCP client will call `run_task` followed by `get_run_conversation`.

### D. HTTP API (ChatGPT custom GPTs, scripts, internal tools)

```bash
agent-orchestrator serve \
  --config ./orchestrator.config.example.json \
  --host 127.0.0.1 --port 4711
```

Endpoints:

```
GET  /healthz                              liveness
GET  /openapi.json                         OpenAPI 3.1 spec (paste into ChatGPT custom GPT)

POST /runs        { "task": "…" }          start a single-task run
GET  /runs                                 list recent runs
GET  /runs/{id}                            final report + verifier + review JSON
GET  /runs/{id}/conversation               chronological conversation events
GET  /runs/{id}/artifact?name=plan.json    fetch a single artifact file

POST /projects    { "spec": "…",           full-auto project builder
                    "max_tasks": 30,
                    "max_seconds": 3600 }
GET  /projects                             list recent projects
GET  /projects/{id}                        final report + final backlog
```

Security defaults:

- Binds to `127.0.0.1` by default — refuses to bind to a non-localhost host without `--auth-token`.
- When `--auth-token <s>` is set, requests must carry `Authorization: Bearer <s>`.
- Artifact paths are validated to prevent traversal (`../etc/passwd` is rejected).

Quick test:

```bash
curl http://127.0.0.1:4711/healthz
curl -X POST -H 'content-type: application/json' \
  -d '{"task":"# Add formatDuration helper\n\nImplement it with tests."}' \
  http://127.0.0.1:4711/runs
```

To use from a **ChatGPT custom GPT**: paste the contents of `GET /openapi.json` into the GPT's Actions schema. The GPT then sees the same five operations as the MCP tools.

The orchestrator:

1. Creates `runs/<UTC-timestamp>-<slug>/`.
2. Writes `task.md` and `config.resolved.json`.
3. Captures `git.initial.json`.
4. Asks Claude to produce `plan.json`.
5. Asks Codex to implement; saves `patch.diff` + `changed_files.json`.
6. Detects risky operations and path-policy violations.
7. Runs the verifier commands; saves `verifier.json` and per-command logs under `logs/`.
8. Asks Claude to review; saves `review.json`.
9. If verifier failed or reviewer requested changes, runs the **repair loop** up to `maxRounds`, feeding only `review.json`, the failing log tails, and the current `patch.diff` to Codex.
10. Writes `final_report.md` and prints a one-screen summary.

### Exit codes

| code | meaning                                     |
| ---: | ------------------------------------------- |
|    0 | approved (verifier passed, reviewer approved) |
|   10 | verifier failed after `maxRounds`            |
|   11 | reviewer requested changes after `maxRounds` |
|   12 | requires human approval (risky or out-of-policy) |
|   20 | orchestrator error                           |

---

## Safety model

- **Allowed paths.** Each changed file is checked against `safety.allowedPaths` (glob patterns). Violations don’t crash the run — they’re recorded and force `requires_approval`.
- **Risky operation tags.** `dependency_change`, `migration`, `delete_file`, `ci_change`, `secret_change`, `security_change`. Detected automatically from the post-change git diff. Each tag in `safety.approvalRequiredFor` triggers `requires_approval`.
- **Deny patterns.** Verifier commands are matched against `safety.denyShellPatterns` BEFORE execution. A blocked command is recorded with exit code `126`.
- **No nested agents.** Workers receive prompts that explicitly forbid invoking other AI tools. The orchestrator is the only invoker.
- **Secret redaction.** Worker stdout/stderr and verifier logs are redacted for common credential patterns (Anthropic, OpenAI, GitHub, AWS, Bearer tokens, PEM private keys, generic `api_key=…`) before they’re written to disk or sent to other workers.
- **Timeouts.** Each subprocess gets `timeoutSeconds` then SIGTERM → SIGKILL.
- **Project-root sandbox.** `projectRoot` must resolve inside the configured repo root.

---

## Generated artifacts

```
runs/20260508-031245-add-formatduration-helper/
├── task.md
├── config.resolved.json
├── git.initial.json
├── plan.json
├── patch.diff
├── changed_files.json
├── verifier.json
├── review.json
├── final_report.md
├── conversation.jsonl     ← every prompt/response, one JSON event per line
├── conversation.md        ← human-readable transcript of the same events
├── logs/
│   ├── plan.stdout.log
│   ├── plan.stderr.log
│   ├── round.1.implement.stdout.log
│   ├── verifier.r1.0.npm-test.stdout.log
│   ├── verifier.r1.0.npm-test.stderr.log
│   └── …
└── rounds/
    ├── patch.r1.diff
    ├── patch.r2.diff
    ├── changed_files.r1.json
    ├── verifier.r1.json
    └── review.r1.json
```

Everything is plain text or pretty-printed JSON.

### Conversation log format

Every interaction the orchestrator has with a worker (or the verifier shell) is appended to `conversation.jsonl` as a single line. The schema:

```json
{
  "seq": 7,
  "ts": "2026-05-08T03:12:45.812Z",
  "round": 1,
  "stage": "plan|implement|verify|review|repair|prepare|report",
  "actor": "orchestrator|user|claude|codex|cursor|verifier|fallback",
  "kind": "status|prompt|response|verifier_command|verifier_output|error",
  "content": "<redacted text>",
  "durationMs": 4321,
  "exitCode": 0,
  "meta": { "exchangeId": "20260508-031245-r1-review-9f3a" }
}
```

`seq` is a monotonic per-run sequence number issued by the in-process **event bus** (`run:<runId>` topic) that all stages publish to and that the conversation log, progress renderers, and (later) live streams subscribe to. It gives a deterministic event order independent of millisecond timestamp collisions. `timeline.jsonl` events carry a per-project `seq` the same way.

### Message envelope (worker exchanges)

Every worker call carries an `exchange_id`. JSON-producing stages (plan / review / decompose) must **echo it at the top level of their JSON output**; the orchestrator rejects payloads whose echo is missing or wrong — one retry with a stronger reminder, then the payload is **discarded** and the deterministic fallback takes over (the suspect JSON is never consumed silently; the rejection is recorded as an `error` event). This prevents a model from satisfying `extractJson` with an example object copied out of the prompt. File-editing stages (implement / repair) return work via `git diff`, so their envelope is correlation-only.

Accepted JSON artifacts are stamped with `_meta: { runId, round, exchangeId }`, binding each `plan.json` / `review.r<N>.json` to the exchange that produced it; the repair step refuses a review bound to a different round.

The companion `conversation.md` renders the same events as a Markdown transcript with round headers — the easiest way to skim "what did the orchestrator say to Claude, what did Claude say back, then what did `npm test` print?" in one sitting. All content is redacted for credentials before it touches disk.

---

## Markdown / artifact ownership inventory

Every `.md` and machine-readable file the system touches has exactly one owner. Use this table to know "who creates this, when does it get rewritten, can I edit it by hand."

### Source-controlled (you / project maintainer edit these)

| File | Owner | What it is | When to touch |
|---|---|---|---|
| `README.md` | Maintainer | This document. | When you change behavior or contracts. |
| `task.example.md` | Maintainer | Example single-task input. Author template. | When the recommended shape of a task changes. |
| `orchestrator.config.example.json` | Maintainer | Example config. Users copy and adapt. | When you add a new config field. |
| `src/prompts/planner.claude.md` | Maintainer → **Claude (planner)** reads | Strict-JSON plan generation prompt. | Tune wording / rules / output schema. |
| `src/prompts/implement.codex.md` | Maintainer → **Codex (implementer)** reads | Implementer safety contract + role. | Tune hard constraints. |
| `src/prompts/review.claude.md` | Maintainer → **Claude (reviewer)** reads | Review-first verdict logic. | Tune verdict decision rules. |
| `src/prompts/repair.codex.md` | Maintainer → **Codex (repair)** reads | Repair-step constraints. | When you change repair semantics. |
| `src/project/prompts/decompose.claude.md` | Maintainer → **Claude (decomposer)** reads | Project-spec → backlog. Drives `build-project`. | When you change task schema / DoD shape. |
| `src/project/prompts/task-context.codex.md` | Maintainer (doc only) | Documents the project-builder ↔ implementer contract. | When you change `renderTaskBriefing`. |
| `tests/**/*.test.ts` | Maintainer | Test fixtures lock workflow behavior. | When semantics change. |

> **Every prompt template has an HTML-comment header** at the top of the file that names the worker, loader, caller, attached artifacts, and downstream consumer. That header is the canonical answer to "who reads this and when?".

### User-authored at runtime (you create per-job)

| File | Owner | What it is | Consumed by |
|---|---|---|---|
| `orchestrator.config.json` (yours) | You | Project-local config (workers enabled? verifier commands? allowed paths?) | `loadConfig()` → every workflow stage |
| `task.md` (yours) | You | Single-task input for `run` mode. | `runWorkflow({ taskPath })` |
| `project.md` / `spec.md` (yours) | You | Project spec for `build-project` mode. | `runProject({ spec })` |

### Orchestrator-generated per single-task run — `runs/<runId>/`

Auto-generated. **Treat as read-only.** Lives under `runs/` which is gitignored.

| File | Created by | When | Consumed by |
|---|---|---|---|
| `task.md` | Orchestrator (copy of your input) | Run start | All worker prompts, for traceability |
| `config.resolved.json` | Orchestrator | Run start | Audit / debugging |
| `git.initial.json` | Orchestrator | Run start | Audit ("what was HEAD before this run?") |
| `plan.json` | **Claude (planner)** → orchestrator writes | After planner | Implementer prompt, reviewer prompt |
| `patch.diff` | Orchestrator (from `git diff`) | After implement / repair, every round | Reviewer prompt, final report |
| `changed_files.json` | Orchestrator | Every round | Risk detection, final report |
| `rounds/patch.r<N>.diff` | Orchestrator | Per round | Audit trail |
| `rounds/verifier.r<N>.json` | Orchestrator | Per round where review approved | Reviewer prompt next round, final report |
| `rounds/review.r<N>.json` | **Claude (reviewer)** → orchestrator writes | Every round | Repair prompt, final report |
| `rounds/changed_files.r<N>.json` | Orchestrator | Every round | Audit |
| `verifier.json` | Orchestrator (last round's result) | Run end | Final report, MCP/HTTP responses |
| `review.json` | Orchestrator (last round's result) | Run end | Final report |
| **`final_report.md`** | Orchestrator (via `renderFinalReport`) | Run end | **Humans** — start here when investigating |
| `conversation.jsonl` | Orchestrator (every event) | Streaming | Machine consumers, MCP `get_run_conversation` |
| **`conversation.md`** | Orchestrator (via `renderTranscript`) | Run end | **Humans** — full prompt/response trail |
| `logs/<tag>.{stdout,stderr}.log` | Orchestrator (per subprocess) | Each worker / verifier call | Debugging |

### Orchestrator-generated per multi-task project — `projects/<projectId>/`

Auto-generated. Read-only except `backlog.json` (you may edit between runs to force a re-try, but `--resume` auto-resets failed/blocked tasks). Lives under `projects/` which is gitignored.

| File | Created by | When | Mutable? |
|---|---|---|---|
| `spec.md` | Orchestrator (copy of your spec) | Project start | No |
| `decomposition.json` | **Claude (decomposer)** → orchestrator writes | After decompose | No (immutable record of the initial plan) |
| `backlog.json` | Orchestrator | Init + after every task | Yes (state machine) |
| `state.json` | Orchestrator | After every task | Yes (knownFiles, blockers, summary) |
| `timeline.jsonl` | Orchestrator | Append-only | No (audit log) |
| **`final_report.md`** | Orchestrator (via `renderProjectReport`) | Project end | No |
| `final_report.json` | Orchestrator | Project end | No |
| `tasks/<runId>/...` | Orchestrator | Per task | Same structure as `runs/<runId>/` above |

### Worker-authored (inside their subprocess)

These never persist outside the worker stdout, but they're how workers communicate:

| Output | Author | Format | How orchestrator reads it |
|---|---|---|---|
| Plan response | Claude (planner) | Strict JSON on stdout | `extractJson` → saved as `plan.json` |
| Implementation | Codex (implementer) | Direct file edits in cwd | `git diff` after process exit |
| Review verdict | Claude (reviewer) | Strict JSON on stdout | `extractJson` → saved as `review.r<N>.json` |
| Repair | Codex (repair) | Direct file edits in cwd | `git diff` after process exit |
| Decomposition | Claude (decomposer) | Strict JSON on stdout | `extractJson` → saved as `decomposition.json` |

### Quick rule of thumb

- **Want to change AGENT behavior?** Edit a file under `src/prompts/` or `src/project/prompts/`. Each has an HTML-comment header naming exactly who reads it.
- **Want to change ORCHESTRATOR behavior?** Edit `src/orchestration/runWorkflow.ts` (single-task) or `src/project/runProject.ts` (multi-task).
- **Want to inspect what happened?** Open `runs/<id>/final_report.md` then `conversation.md`. For a project, `projects/<id>/final_report.md` then `timeline.jsonl`.
- **Never hand-edit** anything under `runs/` or `projects/` while the orchestrator is running. Between runs it's fine, but `--resume` will reset most state automatically.

---

## Development

```bash
npm test            # vitest run
npm run typecheck   # tsc --noEmit
npm run build       # tsc + copy prompt templates
```

Tests do **not** require Claude/Codex/Cursor credentials and never call external services. The integration test uses a `MockWorker` that simulates a full `plan → fail → repair → pass → approve` cycle in a temporary git repo.

---

## Current limitations

- Single project root per run; no per-worker git worktrees yet.
- No interactive approval UI — `requires_approval` is encoded in the run report and the CLI exit code (`12`).
- Prompt cost / token usage is not tracked.
- The Cursor worker passes prompts via stdin like the others; full Cursor workspace integration is on the roadmap.
- Risk detection is path-based; semantic-change detection (e.g. AST-level CSP changes) is not implemented.
- The CLI exposes one workflow (`run`); there’s no resume/replay yet.
- Verifier commands run via the user’s shell because pipes/aliases matter; deny-list checks happen before execution but the shell is otherwise trusted.

---

## Roadmap

Recently shipped: per-run **event bus** with seq-stamped logs, worker **message envelope** (exchange_id echo verification), **stage/category routing** with per-stage models, **multi-perspective review panel**, **interview gate** (`project.interview`), **completion loop** (`project.maxReplans` + stall detection), and **parallel task execution** in git worktrees (`project.maxParallelTasks`).

- **MCP server integration.** Replace the artifact passthrough with first-class MCP tool calls (file search, GitHub, logs, DB schema, browser). Worker prompts already include a `forbiddenActions` list to disallow nested agent invocation.
- **GitHub PR creation.** Open a PR from the run branch with the `final_report.md` body when status is `approved`.
- **Jira / Linear integration.** Pull the task body from a ticket; post run summaries back.
- **Browser / e2e verifier.** A separate verifier kind that drives Playwright / Chromium DevTools.
- **Web dashboard.** Stream artifacts live, approve `requires_approval` runs from the browser.
- **Per-round git worktrees for single-task runs.** Each implementation/repair round operates in an isolated worktree (the project builder already isolates whole tasks).
- **Cost tracking.** Capture model + token + dollar usage per worker call.
- **OpenTelemetry traces.** Span per stage, attributes for risk tags / verifier outcomes.
- **More worker kinds.** Antigravity, Aider, Continue, custom internal CLIs.

---

## File map

```
src/
├── cli.ts                     CLI entrypoint (run / chat / serve / mcp / help / version)
├── index.ts                   programmatic entry
├── bin/
│   └── mcp.ts                 MCP stdio entrypoint (env-driven, for clients to spawn)
├── chat/
│   └── repl.ts                interactive chat REPL with progress streaming
├── http/
│   └── server.ts              HTTP API + OpenAPI spec
├── mcp/
│   └── server.ts              JSON-RPC over stdio MCP server (5 tools)
├── config/
│   ├── schema.ts              zod schema for orchestrator.config.json
│   └── loadConfig.ts          loader + descriptive error messages
├── orchestration/
│   ├── runWorkflow.ts         the pipeline (taskText or taskPath)
│   ├── conversationLog.ts     append-only JSONL + Markdown transcript
│   ├── types.ts               artifact types
│   ├── artifacts.ts           run dir, JSON/text helpers
│   ├── git.ts                 git status/diff capture
│   ├── safety.ts              allowed paths, deny patterns, risk detection
│   ├── verifier.ts            shell verifier with timeout + deny-list
│   └── report.ts              final_report.md + terminal summary
├── workers/
│   ├── Worker.ts              Worker / WorkerInput / WorkerResult
│   ├── ClaudeWorker.ts        wraps `claude -p`
│   ├── CodexWorker.ts         wraps `codex exec`
│   ├── CursorWorker.ts        wraps `cursor-agent -p`
│   ├── MockWorker.ts          deterministic test worker
│   ├── factory.ts             builds the WorkerSet from config
│   └── spawnUtil.ts           subprocess + redacted logs + timeouts
├── prompts/
│   ├── planner.claude.md
│   ├── implement.codex.md
│   ├── review.claude.md
│   ├── repair.codex.md
│   └── index.ts               prompt loader (works in dev + dist)
└── utils/
    ├── jsonExtract.ts         strict-JSON extraction from noisy stdout
    └── redact.ts              credential redaction
tests/
├── config.test.ts
├── safety.test.ts
├── verifier.test.ts
├── workers.test.ts
├── conversationLog.test.ts
├── http.test.ts
├── mcp.test.ts
└── workflow.test.ts           integration: plan → fail → repair → pass → approve
```
