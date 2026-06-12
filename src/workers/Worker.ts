/**
 * Worker abstraction. Workers are isolated subprocess wrappers around AI coding
 * CLIs (Claude Code, Codex CLI, Cursor agent, …). The orchestrator is the only
 * component that invokes workers; workers never invoke other workers.
 */

export type WorkerRole = "planner" | "implementer" | "reviewer" | "repair" | "custom";

export interface WorkerArtifact {
  name: string;
  /** Either inline content or a path to a file the worker may read. */
  content?: string;
  path?: string;
  description?: string;
}

export interface SafetyPolicy {
  allowedPaths: string[];
  approvalRequiredFor: string[];
  denyShellPatterns: string[];
  /** Anything the worker should treat as outright forbidden. */
  forbiddenActions?: string[];
}

export interface WorkerInput {
  role: WorkerRole;
  prompt: string;
  artifacts: WorkerArtifact[];
  cwd: string;
  timeoutSeconds: number;
  env?: Record<string, string>;
  safetyPolicy: SafetyPolicy;
  /** Per-worker log directory; the worker is expected to write logs here. */
  logDir: string;
  /** Optional run-scoped tag for log filenames. */
  tag?: string;
  /**
   * Model override for this call (routing decides per stage/category).
   * Workers translate it to their CLI's flag (`--model` / `-m`); workers
   * without model selection ignore it.
   */
  model?: string;
}

export interface WorkerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  outputFiles: string[];
  parsedJson?: unknown;
  /** True if the orchestrator killed the process due to timeout. */
  timedOut: boolean;
}

export interface Worker {
  readonly name: string;
  readonly enabled: boolean;
  run(input: WorkerInput): Promise<WorkerResult>;
}
