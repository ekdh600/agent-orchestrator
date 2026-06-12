import { describe, it, expect } from "vitest";
import { OrchestratorConfigSchema } from "../src/config/schema.js";
import { mergePanelReviews, shouldRunPanel, type PanelMemberResult } from "../src/orchestration/reviewPanel.js";
import type { DiffSummary, ReviewArtifact } from "../src/orchestration/types.js";

function member(perspective: string, verdict: ReviewArtifact["verdict"], bugs: string[] = []): PanelMemberResult {
  return {
    perspective,
    review: { verdict, bugs, missing_tests: [], risks: [], recommended_fixes: [] },
  };
}

describe("mergePanelReviews", () => {
  it("approves only when no member objects", () => {
    const merged = mergePanelReviews(
      [member("correctness", "approve"), member("security", "approve"), member("testing", "approve")],
      "strict",
    );
    expect(merged.verdict).toBe("approve");
  });

  it("strict: a single request_changes vote requests changes", () => {
    const merged = mergePanelReviews(
      [member("correctness", "approve"), member("security", "request_changes", ["sql injection"]), member("testing", "approve")],
      "strict",
    );
    expect(merged.verdict).toBe("request_changes");
    expect(merged.bugs).toEqual(["[security] sql injection"]);
  });

  it("majority: a lone dissenter does not flip the verdict, a majority does", () => {
    const lone = mergePanelReviews(
      [member("a", "approve"), member("b", "request_changes"), member("c", "approve")],
      "majority",
    );
    expect(lone.verdict).toBe("approve");

    const majority = mergePanelReviews(
      [member("a", "request_changes"), member("b", "request_changes"), member("c", "approve")],
      "majority",
    );
    expect(majority.verdict).toBe("request_changes");
  });

  it("requires_human_review from any member escalates regardless of decision mode", () => {
    for (const decision of ["strict", "majority"] as const) {
      const merged = mergePanelReviews(
        [member("a", "approve"), member("b", "requires_human_review"), member("c", "approve")],
        decision,
      );
      expect(merged.verdict).toBe("requires_human_review");
    }
  });

  it("tags merged findings with the perspective that raised them", () => {
    const merged = mergePanelReviews(
      [
        { perspective: "security", review: { verdict: "approve", bugs: [], missing_tests: [], risks: ["uses eval"], recommended_fixes: ["drop eval"] } },
        { perspective: "testing", review: { verdict: "approve", bugs: [], missing_tests: ["no boundary test"], risks: [], recommended_fixes: [] } },
      ],
      "strict",
    );
    expect(merged.risks).toEqual(["[security] uses eval"]);
    expect(merged.recommended_fixes).toEqual(["[security] drop eval"]);
    expect(merged.missing_tests).toEqual(["[testing] no boundary test"]);
  });

  it("throws on an empty panel", () => {
    expect(() => mergePanelReviews([], "strict")).toThrow();
  });
});

describe("shouldRunPanel", () => {
  const diff = (over: Partial<DiffSummary>): DiffSummary => ({
    patchPath: "p",
    changedFiles: [],
    detectedRisks: [],
    pathViolations: [],
    ...over,
  });
  const config = (panel: Record<string, unknown>) =>
    OrchestratorConfigSchema.parse({ projectRoot: ".", review: { panel } });

  it("is off by default", () => {
    const c = OrchestratorConfigSchema.parse({ projectRoot: "." });
    expect(shouldRunPanel({ config: c, diff: diff({ detectedRisks: ["migration"] }) })).toBe(false);
  });

  it("trigger=always runs on every diff except quick-category tasks", () => {
    const c = config({ enabled: true, trigger: "always" });
    expect(shouldRunPanel({ config: c, diff: diff({}) })).toBe(true);
    expect(shouldRunPanel({ config: c, diff: diff({}), category: "quick" })).toBe(false);
    expect(shouldRunPanel({ config: c, diff: diff({}), category: "deep" })).toBe(true);
  });

  it("trigger=risky requires risk tags, path violations, or a wide diff", () => {
    const c = config({ enabled: true, trigger: "risky", triggerFileThreshold: 3 });
    expect(shouldRunPanel({ config: c, diff: diff({}) })).toBe(false);
    expect(shouldRunPanel({ config: c, diff: diff({ detectedRisks: ["security_change"] }) })).toBe(true);
    expect(shouldRunPanel({ config: c, diff: diff({ pathViolations: ["etc/passwd"] }) })).toBe(true);
    const wide = diff({
      changedFiles: [
        { path: "a", status: "modified" },
        { path: "b", status: "modified" },
        { path: "c", status: "modified" },
      ],
    });
    expect(shouldRunPanel({ config: c, diff: wide })).toBe(true);
  });
});
