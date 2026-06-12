import type { OrchestratorConfig } from "../config/schema.js";
import type { ArtifactMeta } from "./envelope.js";

export type RiskLevel = "low" | "medium" | "high";

export type RiskTag =
  | "dependency_change"
  | "migration"
  | "delete_file"
  | "ci_change"
  | "secret_change"
  | "security_change"
  | "path_violation";

export interface PlanArtifact {
  summary: string;
  target_files: string[];
  risk_level: RiskLevel;
  risky_operations: string[];
  proposed_steps: string[];
  verification_strategy: string[];
  /** Binds this artifact to the exchange that produced it (audit + stale-round detection). */
  _meta?: ArtifactMeta;
}

export interface ReviewArtifact {
  verdict: "approve" | "request_changes" | "requires_human_review";
  bugs: string[];
  missing_tests: string[];
  risks: string[];
  recommended_fixes: string[];
  /** Binds this artifact to the exchange that produced it (audit + stale-round detection). */
  _meta?: ArtifactMeta;
}

export interface VerifierCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  ok: boolean;
  truncatedTail: string; // short tail used for re-prompting workers
}

export interface VerifierReport {
  passed: boolean;
  results: VerifierCommandResult[];
}

export interface DiffSummary {
  patchPath: string;
  changedFiles: ChangedFile[];
  detectedRisks: RiskTag[];
  pathViolations: string[];
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
}

export interface RoundReport {
  round: number;
  diff: DiffSummary;
  /** Review always runs each round (placed BEFORE verify in the cycle). */
  review: ReviewArtifact;
  /**
   * Verifier runs only when the review approves. When the reviewer requests
   * changes, the loop skips verification and jumps straight to repair so the
   * implementer doesn't waste time on a code path the reviewer already
   * rejected. `null` therefore means "review wanted changes, verify skipped".
   */
  verifier: VerifierReport | null;
  /** Why the loop did what it did this round, for the timeline. */
  decision: "approved_passed" | "approved_failed_verify" | "request_changes" | "requires_human_review";
}

export type RunStatus =
  | "approved"
  | "requires_approval"
  | "verifier_failed"
  | "review_changes_requested"
  | "error";

export interface RunReport {
  runId: string;
  runDir: string;
  task: { path: string; title: string };
  config: OrchestratorConfig;
  plan: PlanArtifact;
  rounds: RoundReport[];
  status: RunStatus;
  requiresApproval: boolean;
  approvalReasons: RiskTag[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
