import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { OrchestratorConfigSchema } from "../src/config/schema.js";
import { MockWorker } from "../src/workers/MockWorker.js";
import { runProject } from "../src/project/runProject.js";
import { pickReadyTasks, pathSetsOverlap } from "../src/project/scheduler.js";
import {
  createTaskWorktree,
  mergeTaskWorktree,
  removeTaskWorktree,
} from "../src/orchestration/worktree.js";
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

describe("pathSetsOverlap", () => {
  it("treats missing/empty scopes as overlapping everything", () => {
    expect(pathSetsOverlap(undefined, ["src/a/**"])).toBe(true);
    expect(pathSetsOverlap([], ["src/a/**"])).toBe(true);
  });

  it("disjoint prefixes do not overlap; nested prefixes do", () => {
    expect(pathSetsOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
    expect(pathSetsOverlap(["src/**"], ["src/b/**"])).toBe(true);
    expect(pathSetsOverlap(["src/a/**", "docs/**"], ["docs/api/**"])).toBe(true);
  });
});

describe("pickReadyTasks", () => {
  it("selects up to limit non-overlapping ready tasks", () => {
    const backlog: Backlog = {
      tasks: [
        make({ id: "T01", allowed_paths: ["src/a/**"] }),
        make({ id: "T02", allowed_paths: ["src/b/**"] }),
        make({ id: "T03", allowed_paths: ["src/a/x/**"] }), // overlaps T01
        make({ id: "T04", depends_on: ["T01"] }), // deps not done
      ],
    };
    const picked = pickReadyTasks(backlog, 3);
    expect(picked.map((t) => t.id)).toEqual(["T01", "T02"]); // T03 skipped (overlap), T04 not ready
  });

  it("a task without allowed_paths runs alone", () => {
    const backlog: Backlog = {
      tasks: [make({ id: "T01" }), make({ id: "T02", allowed_paths: ["src/b/**"] })],
    };
    expect(pickReadyTasks(backlog, 2).map((t) => t.id)).toEqual(["T01"]);
    // and nothing joins while it runs
    expect(pickReadyTasks(backlog, 2, [backlog.tasks[0]!]).map((t) => t.id)).toEqual([]);
  });

  it("exclusive ids are forced solo even with allowed_paths", () => {
    const backlog: Backlog = {
      tasks: [
        make({ id: "T01", allowed_paths: ["src/a/**"] }),
        make({ id: "T02", allowed_paths: ["src/b/**"] }),
      ],
    };
    const picked = pickReadyTasks(backlog, 2, [], new Set(["T01"]));
    expect(picked.map((t) => t.id)).toEqual(["T01"]); // T02 can't join the exclusive T01
  });
});

// ---------------------------------------------------------------------------

function initRepo(root: string) {
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  spawnSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: root });
}

async function withTempRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ao-wt-"));
  initRepo(root);
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("worktree lifecycle", () => {
  it("creates a worktree, merges changes back, and cleans up", async () => {
    await withTempRepo(async (root) => {
      const wt = await createTaskWorktree(root, "T01", 1);
      expect((await stat(wt.dir)).isDirectory()).toBe(true);

      await mkdir(path.join(wt.dir, "src"), { recursive: true });
      await writeFile(path.join(wt.dir, "src/a.ts"), "export const a = 1;\n", "utf8");

      const merge = await mergeTaskWorktree(root, wt, "ao: T01 add a");
      expect(merge.ok).toBe(true);
      expect(merge.commit).toBeTruthy();

      // change landed in the base checkout
      const merged = await readFile(path.join(root, "src/a.ts"), "utf8");
      expect(merged).toContain("a = 1");

      await removeTaskWorktree(root, wt);
      await expect(stat(wt.dir)).rejects.toThrow();
      // branch deleted
      const branches = spawnSync("git", ["branch", "--list", wt.branch], { cwd: root }).stdout.toString();
      expect(branches.trim()).toBe("");
    });
  }, 20_000);

  it("reports a conflict (and aborts) when base and worktree touch the same file", async () => {
    await withTempRepo(async (root) => {
      await writeFile(path.join(root, "shared.txt"), "base\n", "utf8");
      spawnSync("git", ["add", "-A"], { cwd: root });
      spawnSync("git", ["commit", "-m", "seed", "-q"], { cwd: root });

      const wt = await createTaskWorktree(root, "T01", 1);
      await writeFile(path.join(wt.dir, "shared.txt"), "from-worktree\n", "utf8");
      // conflicting commit on base AFTER the worktree branched
      await writeFile(path.join(root, "shared.txt"), "from-base\n", "utf8");
      spawnSync("git", ["add", "-A"], { cwd: root });
      spawnSync("git", ["commit", "-m", "base change", "-q"], { cwd: root });

      const merge = await mergeTaskWorktree(root, wt, "ao: T01 conflicting");
      expect(merge.ok).toBe(false);
      expect(merge.conflict).toBe(true);

      // base tree left clean (merge aborted)
      const statusOut = spawnSync("git", ["status", "--porcelain=v1"], { cwd: root }).stdout.toString();
      expect(statusOut.trim()).toBe("");
      expect(await readFile(path.join(root, "shared.txt"), "utf8")).toBe("from-base\n");

      await removeTaskWorktree(root, wt);
    });
  }, 20_000);

  it("merge with no changes is a clean no-op", async () => {
    await withTempRepo(async (root) => {
      const wt = await createTaskWorktree(root, "T02", 1);
      const merge = await mergeTaskWorktree(root, wt, "ao: T02 nothing");
      expect(merge.ok).toBe(true);
      expect(merge.noChanges).toBe(true);
      await removeTaskWorktree(root, wt);
    });
  }, 20_000);
});

// ---------------------------------------------------------------------------

const ok = (stdout: string) => async () => ({
  exitCode: 0,
  stdout,
  stderr: "",
  durationMs: 1,
  outputFiles: [],
  timedOut: false,
});

const twoTaskDecompose = JSON.stringify({
  summary: "Two independent modules.",
  definition_of_done: ["src/a/a.ts exists", "src/b/b.ts exists"],
  tasks: [
    {
      id: "T01",
      title: "Write module A",
      description: "Create src/a/a.ts",
      kind: "impl",
      depends_on: [],
      allowed_paths: ["src/a/**"],
      estimated_complexity: "low",
    },
    {
      id: "T02",
      title: "Write module B",
      description: "Create src/b/b.ts",
      kind: "impl",
      depends_on: [],
      allowed_paths: ["src/b/**"],
      estimated_complexity: "low",
    },
  ],
});

const planJson = JSON.stringify({
  summary: "plan",
  target_files: [],
  risk_level: "low",
  risky_operations: [],
  proposed_steps: ["do it"],
  verification_strategy: ["true"],
});

const approveJson = JSON.stringify({ verdict: "approve", bugs: [], missing_tests: [], risks: [], recommended_fixes: [] });

describe("runProject parallel integration", () => {
  it("runs disjoint tasks concurrently in worktrees and merges both into the base repo", async () => {
    await withTempRepo(async (root) => {
      const projectsDir = path.join(root, "projects");
      let maxConcurrentImplementers = 0;
      let currentImplementers = 0;

      const claude = new MockWorker({
        name: "claude",
        responders: [
          ok(twoTaskDecompose),
          // plan/review for both tasks, in any order, keyed off the role
          async (input) => ({
            exitCode: 0,
            stdout: input.role === "planner" ? planJson : approveJson,
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          }),
        ],
      });
      const codex = new MockWorker({
        name: "codex",
        responders: [
          // Writes into ITS OWN worktree (input.cwd), proving isolation.
          async (input) => {
            currentImplementers++;
            maxConcurrentImplementers = Math.max(maxConcurrentImplementers, currentImplementers);
            const isA = input.prompt.includes("module A") || input.artifacts.some((a) => a.content?.includes("module A"));
            const sub = isA ? "a" : "b";
            await new Promise((r) => setTimeout(r, 50)); // hold the slot so runs overlap
            await mkdir(path.join(input.cwd, "src", sub), { recursive: true });
            await writeFile(path.join(input.cwd, "src", sub, `${sub}.ts`), `export const ${sub} = 1;\n`, "utf8");
            currentImplementers--;
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
        project: { maxParallelTasks: 2 },
        verifier: { commands: ["true"] },
      });

      const report = await runProject({
        spec: specFromText("# Two modules\n\nMake A and B.\n"),
        config,
        workers: { claude, codex },
        baseProjectsDir: projectsDir,
        budget: { maxTasks: 10, maxWallClockSeconds: 120, maxConsecutiveFailures: 3, maxAttemptsPerTask: 2 },
        quiet: true,
      });

      expect(report.status).toBe("completed");
      expect(report.finalBacklog.filter((t) => t.status === "done").length).toBe(2);
      expect(maxConcurrentImplementers).toBe(2); // they really overlapped

      // both merged into the BASE repo
      expect(await readFile(path.join(root, "src/a/a.ts"), "utf8")).toContain("a = 1");
      expect(await readFile(path.join(root, "src/b/b.ts"), "utf8")).toContain("b = 1");

      // worktrees cleaned up
      await expect(stat(path.join(root, ".orchestrator", "worktrees", "t01-a1"))).rejects.toThrow();
      // per-task merge commits exist on the base branch
      const gitLog = spawnSync("git", ["log", "--oneline"], { cwd: root }).stdout.toString();
      expect(gitLog).toContain("T01");
      expect(gitLog).toContain("T02");
    });
  }, 60_000);

  it("rejects parallel mode without autoCommitBetweenTasks", async () => {
    await withTempRepo(async (root) => {
      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        workers: { claude: { enabled: false, command: "claude", args: [] }, codex: { enabled: false, command: "codex", args: [] } },
        project: { maxParallelTasks: 2 },
      });
      const claude = new MockWorker({ name: "claude", enabled: false });
      const codex = new MockWorker({ name: "codex", enabled: false });
      await expect(
        runProject({
          spec: specFromText("# X\n\n- do x\n"),
          config,
          workers: { claude, codex },
          baseProjectsDir: path.join(root, "projects"),
          options: { autoCommitBetweenTasks: false },
          quiet: true,
        }),
      ).rejects.toThrow(/autoCommitBetweenTasks/);
    });
  }, 20_000);
});
