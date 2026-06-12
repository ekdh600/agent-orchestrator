import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { OrchestratorConfigSchema } from "../src/config/schema.js";
import { MockWorker } from "../src/workers/MockWorker.js";
import { runProject } from "../src/project/runProject.js";
import { applyReplan, failureSignature, lineageRoot } from "../src/project/replan.js";
import { specFromText } from "../src/project/index.js";
import type { Backlog, BacklogTask } from "../src/project/types.js";

const make = (overrides: Partial<BacklogTask> = {}): BacklogTask => ({
  id: "T01",
  title: "x",
  description: "",
  kind: "impl",
  depends_on: [],
  estimated_complexity: "low",
  status: "pending",
  attempts: 0,
  ...overrides,
});

describe("applyReplan", () => {
  it("supersedes replaced tasks, rewires dependents, unblocks blocked tasks, appends replacements", () => {
    const backlog: Backlog = {
      tasks: [
        make({ id: "T01", status: "failed" }),
        make({ id: "T02", status: "blocked", depends_on: ["T01"] }),
        make({ id: "T03", status: "done" }),
      ],
    };
    const replacement = make({ id: "R1-T01", replaces: ["T01"], depends_on: ["T03"] });
    const after = applyReplan(backlog, [replacement]);

    expect(after.tasks.find((t) => t.id === "T01")?.status).toBe("superseded");
    const t02 = after.tasks.find((t) => t.id === "T02")!;
    expect(t02.depends_on).toEqual(["R1-T01"]); // dep rewired to the replacement
    expect(t02.status).toBe("pending"); // unblocked for re-evaluation
    expect(after.tasks.find((t) => t.id === "T03")?.status).toBe("done"); // untouched
    expect(after.tasks.map((t) => t.id)).toContain("R1-T01");
  });

  it("is a no-op for replacements that replace nothing", () => {
    const backlog: Backlog = { tasks: [make({ id: "T01", status: "failed" })] };
    const after = applyReplan(backlog, []);
    expect(after).toBe(backlog);
  });
});

describe("failureSignature / lineageRoot", () => {
  it("same failure facts → same signature; different error → different signature", () => {
    const a = make({ id: "T01", status: "failed", lastRunStatus: "verifier_failed", lastError: "npm test exit 1" });
    const b = make({ id: "T01", status: "failed", lastRunStatus: "verifier_failed", lastError: "npm test exit 1" });
    const c = make({ id: "T01", status: "failed", lastRunStatus: "verifier_failed", lastError: "tsc exit 2" });
    expect(failureSignature(a, [])).toBe(failureSignature(b, []));
    expect(failureSignature(a, [])).not.toBe(failureSignature(c, []));
  });

  it("lineageRoot follows the replaces chain to the original task", () => {
    const backlog: Backlog = {
      tasks: [
        make({ id: "T01", status: "superseded" }),
        make({ id: "R1-T01", status: "superseded", replaces: ["T01"] }),
        make({ id: "R2-T01", status: "failed", replaces: ["R1-T01"] }),
      ],
    };
    expect(lineageRoot(backlog.tasks[2]!, backlog)).toBe("T01");
    expect(lineageRoot(backlog.tasks[0]!, backlog)).toBe("T01");
  });
});

// ---------------------------------------------------------------------------

async function withTempProject<T>(
  fn: (project: { root: string; projectsDir: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ao-replan-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  spawnSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: root });
  try {
    return await fn({ root, projectsDir: path.join(root, "projects") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ok = (stdout: string) => async () => ({
  exitCode: 0,
  stdout,
  stderr: "",
  durationMs: 1,
  outputFiles: [],
  timedOut: false,
});

const singleTaskDecompose = JSON.stringify({
  summary: "One impl task.",
  definition_of_done: ["src/x.ts exists"],
  tasks: [
    {
      id: "T01",
      title: "Write x",
      description: "Create src/x.ts via approach A",
      kind: "impl",
      depends_on: [],
      estimated_complexity: "low",
    },
  ],
});

const planJson = JSON.stringify({
  summary: "plan",
  target_files: ["src/x.ts"],
  risk_level: "low",
  risky_operations: [],
  proposed_steps: ["do it"],
  verification_strategy: ["true"],
});

const reviewOf = (verdict: string) =>
  JSON.stringify({ verdict, bugs: [], missing_tests: [], risks: [], recommended_fixes: [] });

describe("runProject replan integration", () => {
  it("replaces a failed task via replan and completes with the replacement", async () => {
    await withTempProject(async ({ root, projectsDir }) => {
      const replanJson = JSON.stringify({
        notes: "Approach A reviewed poorly; retry with approach B.",
        tasks: [
          {
            id: "T99",
            title: "Write x via approach B",
            description: "The previous attempt was rejected in review. Create src/x.ts using approach B instead.",
            kind: "impl",
            depends_on: [],
            replaces: ["T01"],
            category: "standard",
            estimated_complexity: "low",
          },
        ],
      });
      const claude = new MockWorker({
        name: "claude",
        responders: [
          ok(singleTaskDecompose), // decompose → T01
          ok(planJson), // T01 plan
          ok(reviewOf("request_changes")), // T01 review → fails the task (maxRounds=1, maxAttempts=1)
          ok(replanJson), // replan → R1-T01
          ok(planJson), // R1-T01 plan
          ok(reviewOf("approve")), // R1-T01 review → verifier passes → done
        ],
      });
      const codex = new MockWorker({
        name: "codex",
        responders: [
          async () => {
            await mkdir(path.join(root, "src"), { recursive: true });
            await writeFile(path.join(root, "src/x.ts"), "export const x = 1;\n", "utf8");
            return { exitCode: 0, stdout: "done", stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
          },
        ],
      });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 1,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        project: { maxReplans: 1 },
        verifier: { commands: ["true"] },
      });

      const report = await runProject({
        spec: specFromText("# One task project\n\nMake src/x.ts exist.\n"),
        config,
        workers: { claude, codex },
        baseProjectsDir: projectsDir,
        budget: { maxTasks: 10, maxWallClockSeconds: 60, maxConsecutiveFailures: 3, maxAttemptsPerTask: 1 },
        quiet: true,
      });

      expect(report.status).toBe("completed");
      const t01 = report.finalBacklog.find((t) => t.id === "T01")!;
      expect(t01.status).toBe("superseded");
      const replacement = report.finalBacklog.find((t) => t.id.startsWith("R1-"))!;
      expect(replacement.status).toBe("done");
      expect(replacement.replaces).toEqual(["T01"]);

      // replan artifact persisted
      const replanArtifact = JSON.parse(await readFile(path.join(report.projectDir, "replan.1.json"), "utf8"));
      expect(replanArtifact.tasks.length).toBe(1);
      expect(replanArtifact._meta?.exchangeId).toContain("-r1-replan-");
    });
  }, 30_000);

  it("does not replan when maxReplans is 0 (default)", async () => {
    await withTempProject(async ({ root, projectsDir }) => {
      let replanAsked = false;
      const claude = new MockWorker({
        name: "claude",
        responders: [
          ok(singleTaskDecompose),
          ok(planJson),
          async (input) => {
            if (input.prompt.includes("replanner")) replanAsked = true;
            return {
              exitCode: 0,
              stdout: reviewOf("request_changes"),
              stderr: "",
              durationMs: 1,
              outputFiles: [],
              timedOut: false,
            };
          },
        ],
      });
      const codex = new MockWorker({ name: "codex", stdout: "noop" });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 1,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        verifier: { commands: ["true"] },
      });

      const report = await runProject({
        spec: specFromText("# One task project\n\nMake src/x.ts exist.\n"),
        config,
        workers: { claude, codex },
        baseProjectsDir: projectsDir,
        budget: { maxTasks: 10, maxWallClockSeconds: 60, maxConsecutiveFailures: 3, maxAttemptsPerTask: 1 },
        quiet: true,
      });

      expect(report.status).toBe("stopped_blocked");
      expect(replanAsked).toBe(false);
    });
  }, 30_000);
});
