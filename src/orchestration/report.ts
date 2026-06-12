import path from "node:path";
import type { RunReport } from "./types.js";

/** Render the Markdown final report. */
export function renderFinalReport(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Run report — ${report.runId}`);
  lines.push("");
  lines.push(`- **Task:** ${report.task.title}`);
  lines.push(`- **Run dir:** \`${report.runDir}\``);
  lines.push(`- **Started:** ${report.startedAt}`);
  lines.push(`- **Finished:** ${report.finishedAt}`);
  lines.push(`- **Duration:** ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- **Status:** \`${report.status}\``);
  lines.push(`- **Requires human approval:** ${report.requiresApproval ? "**yes**" : "no"}`);
  if (report.approvalReasons.length > 0) {
    lines.push(`- **Approval reasons:** ${report.approvalReasons.join(", ")}`);
  }
  lines.push("");

  lines.push("## Plan");
  lines.push("```json");
  lines.push(JSON.stringify(report.plan, null, 2));
  lines.push("```");
  lines.push("");

  for (const round of report.rounds) {
    lines.push(`## Round ${round.round}`);
    lines.push("");
    lines.push("### Changed files");
    if (round.diff.changedFiles.length === 0) {
      lines.push("_No file changes detected._");
    } else {
      for (const cf of round.diff.changedFiles) {
        lines.push(`- \`${cf.status}\` ${cf.path}`);
      }
    }
    if (round.diff.detectedRisks.length > 0) {
      lines.push("");
      lines.push(`**Detected risks:** ${round.diff.detectedRisks.join(", ")}`);
    }
    if (round.diff.pathViolations.length > 0) {
      lines.push("");
      lines.push("**Path-policy violations:**");
      for (const p of round.diff.pathViolations) lines.push(`- ${p}`);
    }
    lines.push("");
    lines.push("### Review");
    lines.push(`- Decision: \`${round.decision}\``);
    lines.push("```json");
    lines.push(JSON.stringify(round.review, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("### Verifier");
    if (!round.verifier) {
      lines.push("_skipped — review requested changes before verification._");
    } else {
      lines.push(`- Passed: **${round.verifier.passed}**`);
      for (const r of round.verifier.results) {
        lines.push(
          `  - \`${r.command}\` → exit ${r.exitCode} (${r.durationMs}ms) ${r.ok ? "✓" : "✗"}`,
        );
      }
    }
    lines.push("");
  }

  lines.push("## Next suggested human action");
  lines.push("");
  lines.push(suggestedAction(report));
  lines.push("");

  lines.push("## Artifact paths");
  lines.push(`- task: \`${path.basename(report.runDir)}/task.md\``);
  lines.push(`- plan: \`${path.basename(report.runDir)}/plan.json\``);
  lines.push(`- final patch: \`${path.basename(report.runDir)}/patch.diff\``);
  lines.push(`- final verifier: \`${path.basename(report.runDir)}/verifier.json\``);
  lines.push(`- final review: \`${path.basename(report.runDir)}/review.json\``);
  lines.push("");

  return lines.join("\n");
}

function suggestedAction(report: RunReport): string {
  if (report.requiresApproval) {
    return [
      "Human approval is required before this change can be merged.",
      `Reasons: ${report.approvalReasons.join(", ") || "policy violation"}.`,
      "Inspect `patch.diff`, `verifier.json`, and `review.json` in the run directory.",
    ].join(" ");
  }
  switch (report.status) {
    case "approved":
      return "Verifier passed and reviewer approved. You can apply or merge the change.";
    case "verifier_failed":
      return "Verifier failed after the maximum repair rounds. Inspect verifier logs and either rerun with a higher `maxRounds` or fix manually.";
    case "review_changes_requested":
      return "Reviewer requested changes after the maximum repair rounds. Address the recommended fixes manually.";
    case "error":
      return "An internal orchestrator error occurred. See `error.log` in the run directory.";
    default:
      return "Inspect the run directory for details.";
  }
}

/** Short one-screen summary printed to the terminal at the end of the run. */
export function renderTerminalSummary(report: RunReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Run ${report.runId} — status: ${report.status}`);
  lines.push(`Run dir: ${report.runDir}`);
  if (report.requiresApproval) {
    lines.push(`Requires approval: yes (${report.approvalReasons.join(", ") || "policy violation"})`);
  } else {
    lines.push("Requires approval: no");
  }
  const last = report.rounds[report.rounds.length - 1];
  if (last) {
    const verifyStr = last.verifier ? `verifier=${last.verifier.passed ? "pass" : "fail"}` : "verifier=skipped";
    lines.push(
      `Rounds: ${report.rounds.length} (last decision: ${last.decision}, verdict: ${last.review.verdict}, ${verifyStr})`,
    );
    lines.push(`Changed files: ${last.diff.changedFiles.length}`);
  }
  lines.push("");
  return lines.join("\n");
}
