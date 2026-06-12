import type { OrchestratorConfig } from "../config/schema.js";
import type { ArtifactMeta } from "../orchestration/envelope.js";
import type { RunReport } from "../orchestration/types.js";

export type TaskKind = "setup" | "impl" | "test" | "doc" | "fix" | "verify";
export type TaskCategory = "quick" | "standard" | "deep";
export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "needs_approval"
  // Replaced by replanned task(s) — terminal, but not a failure. Dependents
  // are rewired to the replacement tasks when the replan is applied.
  | "superseded";
export type Complexity = "low" | "medium" | "high";

export interface BacklogTask {
  id: string;                      // "T01", "T02" — stable, never reused
  title: string;
  description: string;             // markdown body
  kind: TaskKind;
  depends_on: string[];            // task IDs that must reach `done` first
  allowed_paths?: string[];        // overrides config.safety.allowedPaths for this task only
  /**
   * Risks the decomposer (or the user) is *intentionally* introducing in this
   * task — e.g. the task is "build the auth router" so a `security_change`
   * detection on that task is expected and should not trigger a manual-approval
   * gate. Acknowledged risks bypass `safety.approvalRequiredFor` for THIS task
   * only; the same risk in a different task still requires approval.
   */
  acknowledged_risks?: string[];
  /**
   * Routing category. Selects the matching `routing.categories` override
   * (worker / model / maxRounds) when the task runs. Assigned by the
   * decomposer; defaults to "standard".
   */
  category?: TaskCategory;
  /** Set on replanned tasks: ids of the task(s) this one replaces. */
  replaces?: string[];
  estimated_complexity: Complexity;
  status: TaskStatus;
  attempts: number;
  // Filled in after execution:
  lastRunId?: string;
  lastRunStatus?: string;          // "approved" / "verifier_failed" / etc.
  lastError?: string;
}

export interface DefinitionOfDone {
  /** Bullet list of conditions that must hold for the project to be "complete". */
  conditions: string[];
}

export interface Backlog {
  tasks: BacklogTask[];
}

/** Cross-task working memory. Updated after every task. */
export interface ProjectState {
  /** Short markdown summary of "where the project is now". */
  summary: string;
  /** Files the agents have created or modified across all tasks. */
  knownFiles: string[];
  /** Open issues / blockers / things-to-watch. */
  blockers: string[];
  /** Per-task last-known status snapshot (for quick context injection). */
  taskNotes: Record<string, string>;
}

export interface ProjectSpec {
  /** Title — first H1 in spec.md or first non-empty line. */
  title: string;
  /** Full markdown body of the spec the user provided. */
  body: string;
  /** Path to the spec source file, or "<inline>" if passed via --spec-text. */
  source: string;
}

export interface ProjectBudget {
  /** Hard cap on the number of task executions across the whole project. */
  maxTasks: number;
  /** Hard cap on wall-clock seconds. */
  maxWallClockSeconds: number;
  /** Stop after this many consecutive failures (without any task succeeding). */
  maxConsecutiveFailures: number;
  /** Stop after this many *attempts* on a single task without succeeding. */
  maxAttemptsPerTask: number;
}

export interface ProjectOptions {
  /**
   * When true, the orchestrator runs `git add -A && git commit` after every
   * task that ends in `done`. Without this, file changes from earlier tasks
   * accumulate in the working tree and trip up the next task's path-policy
   * check. Strongly recommended for the project builder. Default: true.
   */
  autoCommitBetweenTasks: boolean;
  /** Prefix used for orchestrator-generated commit messages. */
  commitMessagePrefix: string;
  /**
   * Project-wide acknowledged risks. Merged with each task's own
   * acknowledged_risks (the union is what runWorkflow sees). Use this to
   * acknowledge a risk for ALL tasks without modifying the decomposer's
   * output (e.g. "I know this is a fresh project, dependency_change is
   * expected everywhere").
   */
  acknowledgedRisks: string[];
}

export const DEFAULT_BUDGET: ProjectBudget = {
  maxTasks: 30,
  maxWallClockSeconds: 60 * 60, // 1 hour
  maxConsecutiveFailures: 3,
  maxAttemptsPerTask: 2,
};

export const DEFAULT_PROJECT_OPTIONS: ProjectOptions = {
  autoCommitBetweenTasks: true,
  commitMessagePrefix: "ao",
  acknowledgedRisks: [],
};

export type ProjectStatus =
  | "completed"
  | "stopped_budget"
  | "stopped_failures"
  | "stopped_blocked"
  | "stopped_approval"
  // Interview mode "required": the clarifier produced open questions and the
  // project stopped before decomposition. Answer them in the spec and re-run.
  | "needs_clarification"
  | "error";

export interface TaskExecution {
  taskId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  runId: string;
  runDir: string;
  /** Mirrors RunReport.status — "approved" / "verifier_failed" / "requires_approval" / etc. */
  status: string;
  /** Files that changed during this task. */
  changedFiles: string[];
  /** Wall-clock duration of this task execution in milliseconds. */
  durationMs: number;
  /** Number of repair rounds executed inside this task. */
  rounds: number;
}

/** Aggregate across all task executions in a project. */
export interface ProjectTotals {
  totalDurationMs: number;
  totalRounds: number;
  totalChangedFiles: number;
  perStatus: Record<string, number>;
  averageTaskDurationMs: number;
}

export interface ProjectReport {
  projectId: string;
  projectDir: string;
  spec: ProjectSpec;
  config: OrchestratorConfig;
  budget: ProjectBudget;
  decomposition: {
    summary: string;
    definitionOfDone: DefinitionOfDone;
    initialBacklog: BacklogTask[];
  };
  finalBacklog: BacklogTask[];
  finalState: ProjectState;
  executions: TaskExecution[];
  totals: ProjectTotals;
  status: ProjectStatus;
  /** When status != completed, why we stopped. */
  stopReason: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface DecompositionResult {
  summary: string;
  definitionOfDone: DefinitionOfDone;
  tasks: BacklogTask[];
  /** Binds this artifact to the exchange that produced it (audit). */
  _meta?: ArtifactMeta;
}

/** Result of executing a single task — used by the replanner. */
export interface TaskOutcome {
  task: BacklogTask;
  report: RunReport;
}
