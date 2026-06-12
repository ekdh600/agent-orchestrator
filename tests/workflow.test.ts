import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { runWorkflow } from "../src/orchestration/runWorkflow.js";
import { OrchestratorConfigSchema } from "../src/config/schema.js";
import { MockWorker } from "../src/workers/MockWorker.js";
import { renderFinalReport } from "../src/orchestration/report.js";

async function withTempProject<T>(
  fn: (project: { root: string; runsDir: string; commit: () => void }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ao-proj-"));
  // Init git so the diff-capture path works.
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  spawnSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: root });
  const runsDir = path.join(root, "runs");
  // Helper so each test can commit any baseline files (task.md, seed state) so
  // those don't show up as "untracked → added" in the post-run diff.
  const commit = () => {
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-m", "baseline", "-q", "--allow-empty"], { cwd: root });
  };
  try {
    return await fn({ root, runsDir, commit });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const planJson = JSON.stringify({
  summary: "Add a small helper.",
  target_files: ["src/helper.ts"],
  risk_level: "low",
  risky_operations: [],
  proposed_steps: ["Create helper", "Add tests"],
  verification_strategy: ["Run npm test"],
});

describe("runWorkflow integration", () => {
  it("plan → implement → fail verifier → repair → pass verifier → approve", async () => {
    await withTempProject(async ({ root, runsDir, commit }) => {
      // Seed a state file the implementer/repair workers will mutate.
      const stateFile = path.join(root, "state.txt");
      await writeFile(stateFile, "initial", "utf8");
      const taskFile = path.join(root, "task.md");
      await writeFile(taskFile, "# Add helper\n\nMake the helper exist.\n", "utf8");
      commit();

      // Implementer: write a file that fails the verifier.
      const codex = new MockWorker({
        name: "codex",
        responders: [
          // round 1: implement
          async () => {
            await mkdir(path.join(root, "src"), { recursive: true });
            await writeFile(path.join(root, "src/helper.ts"), "export const x = 0;\n", "utf8");
            await writeFile(stateFile, "broken", "utf8");
            return {
              exitCode: 0,
              stdout: "implemented",
              stderr: "",
              durationMs: 1,
              outputFiles: [],
              timedOut: false,
            };
          },
          // round 2: repair
          async () => {
            await writeFile(stateFile, "fixed", "utf8");
            return {
              exitCode: 0,
              stdout: "repaired",
              stderr: "",
              durationMs: 1,
              outputFiles: [],
              timedOut: false,
            };
          },
        ],
      });

      let claudeCallCount = 0;
      const claude = new MockWorker({
        name: "claude",
        responders: [
          async () => ({
            exitCode: 0,
            stdout: planJson,
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
          // reviewer first call → request_changes (verifier failed)
          async () => {
            claudeCallCount++;
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                verdict: "request_changes",
                bugs: ["state file broken"],
                missing_tests: [],
                risks: [],
                recommended_fixes: ["set state to 'fixed'"],
              }),
              stderr: "",
              durationMs: 1,
              outputFiles: [],
              timedOut: false,
            };
          },
          // reviewer second call → approve
          async () => {
            claudeCallCount++;
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                verdict: "approve",
                bugs: [],
                missing_tests: [],
                risks: [],
                recommended_fixes: [],
              }),
              stderr: "",
              durationMs: 1,
              outputFiles: [],
              timedOut: false,
            };
          },
        ],
      });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 3,
        timeoutSeconds: 10,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        verifier: {
          // grep returns 0 only when stateFile contains "fixed"
          commands: [`grep -q fixed ${stateFile}`],
        },
        safety: {
          allowedPaths: ["src/**", "state.txt"],
        },
      });

      const report = await runWorkflow({
        config,
        taskPath: taskFile,
        workers: { claude, codex },
        baseRunsDir: runsDir,
        quiet: true,
      });

      expect(report.status).toBe("approved");
      expect(report.requiresApproval).toBe(false);
      expect(report.rounds.length).toBe(2);
      // New review-first flow:
      //  Round 1 — review says request_changes ⇒ verify SKIPPED ⇒ repair fixes state
      //  Round 2 — review says approve ⇒ verify runs and passes ⇒ DONE
      expect(report.rounds[0]!.review.verdict).toBe("request_changes");
      expect(report.rounds[0]!.verifier).toBeNull();
      expect(report.rounds[0]!.decision).toBe("request_changes");
      expect(report.rounds[1]!.review.verdict).toBe("approve");
      expect(report.rounds[1]!.verifier?.passed).toBe(true);
      expect(report.rounds[1]!.decision).toBe("approved_passed");
      expect(claudeCallCount).toBe(2);

      // final_report.md is renderable
      const md = renderFinalReport(report);
      expect(md).toContain("Run report");
      expect(md).toContain("approved");

      // Run dir + key artifacts exist
      const runStat = await stat(report.runDir);
      expect(runStat.isDirectory()).toBe(true);
      const planRaw = await readFile(path.join(report.runDir, "plan.json"), "utf8");
      expect(JSON.parse(planRaw).summary).toContain("helper");
    });
  }, 30_000);

  it("review-first flow: request_changes skips verify and goes straight to repair", async () => {
    await withTempProject(async ({ root, runsDir, commit }) => {
      const taskFile = path.join(root, "task.md");
      await writeFile(taskFile, "# x\n", "utf8");
      commit();

      // Verifier marker so we can assert it ran (or didn't) per round.
      const verifierMarker = path.join(root, "verifier-runs.txt");

      let codexCalls = 0;
      const codex = new MockWorker({
        name: "codex",
        responders: [
          async () => {
            codexCalls++;
            await mkdir(path.join(root, "src"), { recursive: true });
            await writeFile(path.join(root, "src/x.ts"), `export const c = ${codexCalls};\n`, "utf8");
            return { exitCode: 0, stdout: `step ${codexCalls}`, stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
          },
        ],
      });
      const claude = new MockWorker({
        name: "claude",
        responders: [
          // plan
          async () => ({ exitCode: 0, stdout: planJson, stderr: "", durationMs: 1, outputFiles: [], timedOut: false }),
          // round 1 reviewer: request_changes (verify must be SKIPPED)
          async () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              verdict: "request_changes",
              bugs: ["needs more"],
              missing_tests: [],
              risks: [],
              recommended_fixes: ["expand"],
            }),
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
          // round 2 reviewer: approve
          async () => ({
            exitCode: 0,
            stdout: JSON.stringify({ verdict: "approve", bugs: [], missing_tests: [], risks: [], recommended_fixes: [] }),
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
        ],
      });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 2,
        timeoutSeconds: 10,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        // The verifier appends a line each time it runs so we can count.
        verifier: { commands: [`echo ran >> ${verifierMarker}`] },
        safety: { allowedPaths: ["src/**"] },
      });

      const report = await runWorkflow({
        config,
        taskPath: taskFile,
        workers: { claude, codex },
        baseRunsDir: runsDir,
        quiet: true,
      });

      expect(report.rounds.length).toBe(2);
      // Round 1: request_changes ⇒ verifier SKIPPED
      expect(report.rounds[0]!.review.verdict).toBe("request_changes");
      expect(report.rounds[0]!.verifier).toBeNull();
      expect(report.rounds[0]!.decision).toBe("request_changes");
      // Round 2: approve ⇒ verifier ran ⇒ passed
      expect(report.rounds[1]!.review.verdict).toBe("approve");
      expect(report.rounds[1]!.verifier?.passed).toBe(true);
      expect(report.rounds[1]!.decision).toBe("approved_passed");

      // Marker file should contain exactly ONE "ran" line — verifier ran in round 2 only.
      const markerContent = await readFile(verifierMarker, "utf8").catch(() => "");
      const lines = markerContent.split("\n").filter(Boolean);
      expect(lines.length).toBe(1);
    });
  }, 30_000);

  it("flags requires_approval when changes touch package.json", async () => {
    await withTempProject(async ({ root, runsDir, commit }) => {
      const taskFile = path.join(root, "task.md");
      await writeFile(taskFile, "# bump\n", "utf8");
      commit();

      const codex = new MockWorker({
        name: "codex",
        responders: [
          async () => {
            await writeFile(path.join(root, "package.json"), '{"name":"x"}\n', "utf8");
            return {
              exitCode: 0,
              stdout: "added package.json",
              stderr: "",
              durationMs: 1,
              outputFiles: [],
              timedOut: false,
            };
          },
        ],
      });

      const claude = new MockWorker({
        name: "claude",
        // Both planner and reviewer get the same fallback object; the reviewer
        // path will detect risks and raise requires_human_review.
        responders: [
          async () => ({
            exitCode: 0,
            stdout: planJson,
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
          async () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              verdict: "approve",
              bugs: [],
              missing_tests: [],
              risks: [],
              recommended_fixes: [],
            }),
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
        ],
      });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 1,
        timeoutSeconds: 10,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        verifier: { commands: ["true"] },
        safety: { allowedPaths: ["src/**", "package.json"] },
      });

      const report = await runWorkflow({
        config,
        taskPath: taskFile,
        workers: { claude, codex },
        baseRunsDir: runsDir,
        quiet: true,
      });

      expect(report.requiresApproval).toBe(true);
      expect(report.approvalReasons).toContain("dependency_change");
      expect(report.status).toBe("requires_approval");
    });
  }, 30_000);

  it("falls back to deterministic plan/review when claude is disabled", async () => {
    await withTempProject(async ({ root, runsDir, commit }) => {
      const taskFile = path.join(root, "task.md");
      await writeFile(taskFile, "# something\nUse `src/foo.ts`.\n", "utf8");
      commit();

      const codex = new MockWorker({
        name: "codex",
        responders: [
          async () => {
            await mkdir(path.join(root, "src"), { recursive: true });
            await writeFile(path.join(root, "src/foo.ts"), "export const ok = true;\n", "utf8");
            return {
              exitCode: 0,
              stdout: "did it",
              stderr: "",
              durationMs: 1,
              outputFiles: [],
              timedOut: false,
            };
          },
        ],
      });
      const claude = new MockWorker({ name: "claude", enabled: false });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 1,
        workers: {
          claude: { enabled: false, command: "claude", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        verifier: { commands: ["true"] },
        safety: { allowedPaths: ["src/**"] },
      });

      const report = await runWorkflow({
        config,
        taskPath: taskFile,
        workers: { claude, codex },
        baseRunsDir: runsDir,
        quiet: true,
      });

      expect(report.plan.summary).toMatch(/Fallback plan/);
      expect(["approve", "request_changes"]).toContain(report.rounds[0]!.review.verdict);
    });
  }, 30_000);

  it("stops the repair loop at maxRounds when reviewer keeps requesting changes", async () => {
    await withTempProject(async ({ root, runsDir, commit }) => {
      const taskFile = path.join(root, "task.md");
      await writeFile(taskFile, "# x\n", "utf8");
      const stateFile = path.join(root, "src/state.txt");
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(stateFile, "broken", "utf8");
      commit();

      const codex = new MockWorker({
        name: "codex",
        responders: [
          async () => ({
            exitCode: 0,
            stdout: "no-op",
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
        ],
      });
      const claude = new MockWorker({
        name: "claude",
        responders: [
          async () => ({
            exitCode: 0,
            stdout: planJson,
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
          async () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              verdict: "request_changes",
              bugs: ["still broken"],
              missing_tests: [],
              risks: [],
              recommended_fixes: ["fix it"],
            }),
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
        ],
      });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 2,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        verifier: { commands: [`grep -q fixed ${stateFile}`] },
        safety: { allowedPaths: ["src/**"] },
      });

      const report = await runWorkflow({
        config,
        taskPath: taskFile,
        workers: { claude, codex },
        baseRunsDir: runsDir,
        quiet: true,
      });

      expect(report.rounds.length).toBe(2);
      expect(report.status === "verifier_failed" || report.status === "review_changes_requested").toBe(true);
    });
  }, 30_000);

  it("discards JSON payloads that fail the exchange_id echo check (retry once, then fallback)", async () => {
    await withTempProject(async ({ root, runsDir, commit }) => {
      const taskFile = path.join(root, "task.md");
      await writeFile(taskFile, "# Echo test\n\nNothing to implement.\n", "utf8");
      commit();

      // Worker returns valid-looking JSON but never echoes the exchange_id.
      let claudeCalls = 0;
      const claude = new MockWorker({
        name: "claude",
        autoEcho: false,
        responders: [
          async () => {
            claudeCalls++;
            return {
              exitCode: 0,
              stdout: planJson,
              stderr: "",
              durationMs: 1,
              outputFiles: [],
              timedOut: false,
            };
          },
        ],
      });
      const codex = new MockWorker({ name: "codex", enabled: false });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 1,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: false, command: "echo", args: [] },
        },
        verifier: { commands: [] },
        safety: { allowedPaths: [] },
      });

      const report = await runWorkflow({
        config,
        taskPath: taskFile,
        workers: { claude, codex },
        baseRunsDir: runsDir,
        quiet: true,
      });

      // plan: 2 attempts (initial + retry), review round 1: 2 attempts
      expect(claudeCalls).toBe(4);
      // The suspect payload was discarded — the deterministic fallback ran instead.
      expect(report.plan.summary).toContain("Fallback plan");
      expect(report.plan._meta).toBeUndefined();

      const raw = await readFile(path.join(report.runDir, "conversation.jsonl"), "utf8");
      const events = raw.trim().split("\n").map((l) => JSON.parse(l) as { seq: number; kind: string; content: string });
      const echoErrors = events.filter((e) => e.kind === "error" && e.content.includes("echo check failed"));
      expect(echoErrors.length).toBe(4);
      expect(events.some((e) => e.content.includes("protocol_error"))).toBe(true);
      // bus-issued seq is strictly increasing across the persisted stream
      for (let i = 1; i < events.length; i++) expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
    });
  }, 30_000);

  it("routes stages per category (worker + model + maxRounds overrides)", async () => {
    await withTempProject(async ({ root, runsDir, commit }) => {
      const taskFile = path.join(root, "task.md");
      await writeFile(taskFile, "# Quick task\n\nTiny change.\n", "utf8");
      commit();

      const seen: { role: string; model?: string }[] = [];
      const respond = (stdout: string) => async (input: { role: string; model?: string }) => {
        seen.push({ role: input.role, model: input.model });
        return { exitCode: 0, stdout, stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
      };
      // cursor handles plan AND review under the "quick" category
      const cursor = new MockWorker({
        name: "cursor",
        responders: [
          respond(planJson),
          respond(JSON.stringify({ verdict: "approve", bugs: [], missing_tests: [], risks: [], recommended_fixes: [] })),
        ],
      });
      let claudeCalls = 0;
      const claude = new MockWorker({
        name: "claude",
        responders: [
          async () => {
            claudeCalls++;
            return { exitCode: 0, stdout: "{}", stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
          },
        ],
      });
      const codex = new MockWorker({ name: "codex", enabled: false });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 5,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: false, command: "echo", args: [] },
          cursor: { enabled: true, command: "echo", args: [] },
        },
        routing: {
          categories: {
            quick: {
              plan: { worker: "cursor", model: "haiku" },
              review: { worker: "cursor" },
              maxRounds: 1,
            },
          },
        },
        verifier: { commands: ["true"] },
        safety: { allowedPaths: [] },
      });

      const report = await runWorkflow({
        config,
        taskPath: taskFile,
        workers: { claude, codex, cursor },
        baseRunsDir: runsDir,
        quiet: true,
        category: "quick",
      });

      expect(report.status).toBe("approved");
      expect(claudeCalls).toBe(0); // claude bypassed entirely for this category
      expect(seen.map((s) => s.role)).toEqual(["planner", "reviewer"]);
      expect(seen[0]!.model).toBe("haiku"); // category model reached the worker input
      expect(seen[1]!.model).toBeUndefined();
      expect(report.rounds.length).toBe(1); // category maxRounds=1
    });
  }, 30_000);

  it("runs the multi-perspective review panel and merges verdicts (strict)", async () => {
    await withTempProject(async ({ root, runsDir, commit }) => {
      const taskFile = path.join(root, "task.md");
      await writeFile(taskFile, "# Panel task\n\nReview me thrice.\n", "utf8");
      commit();

      const reviewOf = (verdict: string, bugs: string[] = []) =>
        JSON.stringify({ verdict, bugs, missing_tests: [], risks: [], recommended_fixes: [] });
      const ok = (stdout: string) => async () => ({
        exitCode: 0,
        stdout,
        stderr: "",
        durationMs: 1,
        outputFiles: [],
        timedOut: false,
      });
      // 1 planner call, then panel members run in PARALLEL (order not
      // guaranteed) — the reviewer responder keys off the perspective block
      // injected into its prompt instead of relying on call order.
      const claude = new MockWorker({
        name: "claude",
        responders: [
          ok(planJson),
          async (input) => ({
            exitCode: 0,
            stdout: input.prompt.includes('"security" reviewer')
              ? reviewOf("request_changes", ["timing-unsafe token compare"])
              : reviewOf("approve"),
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
        ],
      });
      const codex = new MockWorker({ name: "codex", enabled: false });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 1,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: false, command: "echo", args: [] },
        },
        review: { panel: { enabled: true, trigger: "always", decision: "strict" } },
        verifier: { commands: ["true"] },
        safety: { allowedPaths: [] },
      });

      const report = await runWorkflow({
        config,
        taskPath: taskFile,
        workers: { claude, codex },
        baseRunsDir: runsDir,
        quiet: true,
      });

      const review = report.rounds[0]!.review;
      expect(review.verdict).toBe("request_changes"); // strict: 1 dissenter is enough
      expect(review.bugs).toEqual(["[security] timing-unsafe token compare"]);
      expect(report.rounds[0]!.verifier).toBeNull(); // request_changes skips verify
      expect(review._meta?.exchangeId).toContain("-review-panel-");

      // per-perspective artifacts persisted alongside the merged one
      for (const perspective of ["correctness", "security", "testing"]) {
        const memberFile = path.join(report.runDir, "rounds", `review.r1.${perspective}.json`);
        const member = JSON.parse(await readFile(memberFile, "utf8"));
        expect(member._meta?.exchangeId).toContain(`-review-${perspective}-`);
      }
    });
  }, 30_000);

  it("stamps _meta {runId, round, exchangeId} on plan/review artifacts when the echo succeeds", async () => {
    await withTempProject(async ({ root, runsDir, commit }) => {
      const taskFile = path.join(root, "task.md");
      await writeFile(taskFile, "# Meta test\n\nNothing to implement.\n", "utf8");
      commit();

      const claude = new MockWorker({
        name: "claude",
        responders: [
          async () => ({
            exitCode: 0,
            stdout: planJson,
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
          async () => ({
            exitCode: 0,
            stdout: JSON.stringify({ verdict: "approve", bugs: [], missing_tests: [], risks: [], recommended_fixes: [] }),
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
        ],
      });
      const codex = new MockWorker({ name: "codex", enabled: false });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 1,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: false, command: "echo", args: [] },
        },
        verifier: { commands: [] },
        safety: { allowedPaths: [] },
      });

      const report = await runWorkflow({
        config,
        taskPath: taskFile,
        workers: { claude, codex },
        baseRunsDir: runsDir,
        quiet: true,
      });

      expect(report.plan.summary).toBe("Add a small helper.");
      expect(report.plan._meta?.runId).toBe(report.runId);
      expect(report.plan._meta?.round).toBeNull();
      expect(report.plan._meta?.exchangeId).toMatch(/-plan-[a-f0-9]{4}$/);
      // the echoed exchange_id itself must NOT leak into the artifact
      expect((report.plan as Record<string, unknown>)["exchange_id"]).toBeUndefined();

      const review = report.rounds[0]!.review;
      expect(review._meta?.round).toBe(1);
      expect(review._meta?.exchangeId).toMatch(/-r1-review-[a-f0-9]{4}$/);

      // artifacts on disk carry the same binding
      const planOnDisk = JSON.parse(await readFile(path.join(report.runDir, "plan.json"), "utf8"));
      expect(planOnDisk._meta?.exchangeId).toBe(report.plan._meta?.exchangeId);
    });
  }, 30_000);
});
