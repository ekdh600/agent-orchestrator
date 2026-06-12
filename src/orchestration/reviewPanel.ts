import type { OrchestratorConfig } from "../config/schema.js";
import type { DiffSummary, ReviewArtifact } from "./types.js";

/**
 * Multi-perspective review panel (adversarial review).
 *
 * N reviewers look at the same patch, each through a different lens
 * (correctness / security / testing by default), in parallel. Their verdicts
 * are merged into ONE ReviewArtifact so everything downstream (repair prompt,
 * round reports, final report) is unchanged.
 *
 * Merge rules:
 *   - `requires_human_review` from ANY member always escalates — safety wins
 *     over the configured decision mode.
 *   - `request_changes`: "strict" needs one vote, "majority" needs > half.
 *   - otherwise `approve`.
 *
 * Findings (bugs / missing_tests / risks / recommended_fixes) are merged with
 * a `[perspective]` prefix so the repair worker knows who said what.
 */

export interface PanelMemberResult {
  perspective: string;
  review: ReviewArtifact;
}

export function mergePanelReviews(
  members: PanelMemberResult[],
  decision: "strict" | "majority",
): ReviewArtifact {
  if (members.length === 0) {
    throw new Error("mergePanelReviews: empty panel");
  }

  const escalations = members.filter((m) => m.review.verdict === "requires_human_review");
  const changeRequests = members.filter((m) => m.review.verdict === "request_changes");

  let verdict: ReviewArtifact["verdict"];
  if (escalations.length > 0) {
    verdict = "requires_human_review";
  } else if (decision === "strict" ? changeRequests.length >= 1 : changeRequests.length * 2 > members.length) {
    verdict = "request_changes";
  } else {
    verdict = "approve";
  }

  const tag = (m: PanelMemberResult, items: string[]) => items.map((s) => `[${m.perspective}] ${s}`);
  return {
    verdict,
    bugs: members.flatMap((m) => tag(m, m.review.bugs)),
    missing_tests: members.flatMap((m) => tag(m, m.review.missing_tests)),
    risks: members.flatMap((m) => tag(m, m.review.risks)),
    recommended_fixes: members.flatMap((m) => tag(m, m.review.recommended_fixes)),
  };
}

/**
 * Should this round use the panel instead of the single reviewer?
 * Quick-category tasks always use the single reviewer (cost control).
 */
export function shouldRunPanel(args: {
  config: OrchestratorConfig;
  diff: DiffSummary;
  category?: string;
}): boolean {
  const panel = args.config.review.panel;
  if (!panel.enabled) return false;
  if (args.category === "quick") return false;
  if (panel.trigger === "always") return true;
  return (
    args.diff.detectedRisks.length > 0 ||
    args.diff.pathViolations.length > 0 ||
    args.diff.changedFiles.length >= panel.triggerFileThreshold
  );
}
