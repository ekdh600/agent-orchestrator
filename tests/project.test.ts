import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { OrchestratorConfigSchema } from "../src/config/schema.js";
import { MockWorker } from "../src/workers/MockWorker.js";
import { runProject } from "../src/project/runProject.js";
import { fallbackDecompose } from "../src/project/decompose.js";
import { applyTaskOutcome, pickNextTask, backlogProgress } from "../src/project/scheduler.js";
import { specFromText } from "../src/project/index.js";
import type { Backlog, BacklogTask } from "../src/project/types.js";

async function withTempProject<T>(
  fn: (project: { root: string; projectsDir: string; commit: () => void }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ao-proj-builder-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  spawnSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: root });
  const projectsDir = path.join(root, "projects");
  const commit = () => {
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-m", "baseline", "-q", "--allow-empty"], { cwd: root });
  };
  try {
    return await fn({ root, projectsDir, commit });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const decomposeJson = JSON.stringify({
  summary: "Build a tiny CLI that prints hello and has a test.",
  definition_of_done: ["src/hello.ts exports `hello()`", "tests/hello.test.ts passes"],
  tasks: [
    {
      id: "T01",
      title: "Add hello function",
      description: "Create src/hello.ts that exports `hello(name?)` returning 'Hello, <name>!'",
      kind: "impl",
      depends_on: [],
      estimated_complexity: "low",
    },
    {
      id: "T02",
      title: "Add unit test for hello",
      description: "Add tests/hello.test.ts checking hello() and hello('world').",
      kind: "test",
      depends_on: ["T01"],
      estimated_complexity: "low",
    },
    {
      id: "T03",
      title: "Verify project",
      description: "Run the verifier and confirm hello passes.",
      kind: "verify",
      depends_on: ["T01", "T02"],
      estimated_complexity: "low",
    },
  ],
});

describe("scheduler", () => {
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

  it("picks the lowest-id ready task", () => {
    const backlog: Backlog = {
      tasks: [
        make({ id: "T02" }),
        make({ id: "T01" }),
      ],
    };
    expect(pickNextTask(backlog)?.id).toBe("T01");
  });

  it("respects depends_on", () => {
    const backlog: Backlog = {
      tasks: [
        make({ id: "T01", depends_on: ["T02"] }),
        make({ id: "T02" }),
      ],
    };
    expect(pickNextTask(backlog)?.id).toBe("T02");
  });

  it("returns null when no candidates exist", () => {
    const backlog: Backlog = {
      tasks: [
        make({ id: "T01", status: "done" }),
        make({ id: "T02", status: "done" }),
      ],
    };
    expect(pickNextTask(backlog)).toBeNull();
  });

  it("applyTaskOutcome propagates blocked status to dependents", () => {
    const backlog: Backlog = {
      tasks: [
        make({ id: "T01" }),
        make({ id: "T02", depends_on: ["T01"] }),
        make({ id: "T03", depends_on: ["T02"] }),
      ],
    };
    const after = applyTaskOutcome(backlog, "T01", "failed", 1, { error: "boom" });
    expect(after.tasks.find((t) => t.id === "T01")?.status).toBe("failed");
    expect(after.tasks.find((t) => t.id === "T02")?.status).toBe("blocked");
    expect(after.tasks.find((t) => t.id === "T03")?.status).toBe("blocked");
  });

  it("counts progress correctly", () => {
    const backlog: Backlog = {
      tasks: [
        make({ id: "T01", status: "done" }),
        make({ id: "T02", status: "failed" }),
        make({ id: "T03", status: "blocked" }),
        make({ id: "T04", status: "needs_approval" }),
        make({ id: "T05", status: "pending" }),
      ],
    };
    const p = backlogProgress(backlog);
    expect(p).toEqual({ total: 5, done: 1, failed: 1, blocked: 1, needsApproval: 1, superseded: 0, remaining: 1 });
  });
});

describe("fallbackDecompose", () => {
  it("turns H2 sections into tasks", () => {
    const spec = specFromText(`# Cool project\n\n## Setup\nMake a thing.\n\n## Add feature\nDo X.\n`);
    const r = fallbackDecompose(spec);
    expect(r.tasks.length).toBeGreaterThanOrEqual(2);
    expect(r.tasks[r.tasks.length - 1]!.kind).toBe("verify");
    expect(r.tasks[0]!.kind).toBe("setup"); // "Setup" section
  });

  it("falls back to bullets when no H2 sections exist", () => {
    const spec = specFromText("# x\n\n- thing one\n- thing two\n- thing three\n");
    const r = fallbackDecompose(spec);
    expect(r.tasks.length).toBe(4); // 3 bullets + verify
  });

  it("emits a single impl task when neither sections nor bullets exist", () => {
    const spec = specFromText("# x\n\nJust do everything.\n");
    const r = fallbackDecompose(spec);
    expect(r.tasks.length).toBe(2); // 1 impl + verify
  });
});

describe("runProject integration", () => {
  it("decomposes via Claude mock and runs every task to completion", async () => {
    await withTempProject(async ({ root, projectsDir }) => {
      // Codex implementer: each call creates a marker file inside src/.
      let codexCalls = 0;
      const codex = new MockWorker({
        name: "codex",
        responders: [
          async () => {
            codexCalls++;
            await mkdir(path.join(root, "src"), { recursive: true });
            await writeFile(path.join(root, "src", `marker.${codexCalls}.ts`), `export const x = ${codexCalls};\n`, "utf8");
            return { exitCode: 0, stdout: `step ${codexCalls}`, stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
          },
        ],
      });

      // Claude: 1st response = decomposition. Subsequent calls = approve reviews.
      const claude = new MockWorker({
        name: "claude",
        responders: [
          async () => ({
            exitCode: 0,
            stdout: decomposeJson,
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
        safety: { allowedPaths: ["src/**", "tests/**"] },
      });

      const report = await runProject({
        spec: specFromText("# Tiny CLI\n\nBuild a small hello CLI.\n"),
        config,
        workers: { claude, codex },
        baseProjectsDir: projectsDir,
        budget: { maxTasks: 10, maxWallClockSeconds: 60, maxConsecutiveFailures: 5, maxAttemptsPerTask: 2 },
        quiet: true,
      });

      expect(report.status).toBe("completed");
      expect(report.finalBacklog.length).toBe(3);
      expect(report.finalBacklog.every((t) => t.status === "done")).toBe(true);
      expect(report.executions.length).toBe(3);

      // Disk artifacts
      const dirStat = await stat(report.projectDir);
      expect(dirStat.isDirectory()).toBe(true);
      const reportMd = await readFile(path.join(report.projectDir, "final_report.md"), "utf8");
      expect(reportMd).toContain("Status:** `completed`");
      expect(reportMd).toContain("T01");
      const backlog = JSON.parse(await readFile(path.join(report.projectDir, "backlog.json"), "utf8"));
      expect(backlog.tasks.length).toBe(3);

      // Per-task run dirs exist
      const tasksDir = path.join(report.projectDir, "tasks");
      const { readdir } = await import("node:fs/promises");
      const taskDirs = await readdir(tasksDir);
      expect(taskDirs.length).toBe(3);

      // Timeline has the expected events
      const timeline = (await readFile(path.join(report.projectDir, "timeline.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(timeline[0]!.kind).toBe("project_started");
      expect(timeline.find((e) => e.kind === "decomposed")).toBeTruthy();
      expect(timeline.filter((e) => e.kind === "task_finished").length).toBe(3);
      expect(timeline[timeline.length - 1]!.kind).toBe("project_finished");
    });
  }, 60_000);

  it("stops at maxTasks budget when too many tasks are generated", async () => {
    await withTempProject(async ({ root, projectsDir }) => {
      // Decomposition with 5 tasks; budget caps at 2.
      const bigDecomp = JSON.stringify({
        summary: "many tasks",
        definition_of_done: ["all done"],
        tasks: Array.from({ length: 5 }, (_, i) => ({
          id: `T${String(i + 1).padStart(2, "0")}`,
          title: `Task ${i + 1}`,
          description: `step ${i + 1}`,
          kind: "impl",
          depends_on: i === 0 ? [] : [`T${String(i).padStart(2, "0")}`],
          estimated_complexity: "low",
        })),
      });
      const codex = new MockWorker({
        name: "codex",
        stdout: "ok",
      });
      const claude = new MockWorker({
        name: "claude",
        responders: [
          async () => ({ exitCode: 0, stdout: bigDecomp, stderr: "", durationMs: 1, outputFiles: [], timedOut: false }),
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
        maxRounds: 1,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        verifier: { commands: ["true"] },
        safety: { allowedPaths: ["src/**"] },
      });

      const report = await runProject({
        spec: specFromText("# many"),
        config,
        workers: { claude, codex },
        baseProjectsDir: projectsDir,
        budget: { maxTasks: 2, maxWallClockSeconds: 60, maxConsecutiveFailures: 5, maxAttemptsPerTask: 2 },
        quiet: true,
      });

      expect(report.status).toBe("stopped_budget");
      expect(report.executions.length).toBe(2);
      expect(report.stopReason).toMatch(/maxTasks/);
    });
  }, 30_000);

  it("auto-commits between tasks so each task starts from a clean diff", async () => {
    await withTempProject(async ({ root, projectsDir }) => {
      const ts = JSON.stringify({
        summary: "two tasks, second uses narrow allowed_paths",
        definition_of_done: ["both done"],
        tasks: [
          {
            id: "T01",
            title: "first",
            description: "Create src/a.ts",
            kind: "impl",
            depends_on: [],
            allowed_paths: ["src/a.ts"],
            estimated_complexity: "low",
          },
          {
            id: "T02",
            title: "second",
            description: "Create src/b.ts only",
            kind: "impl",
            depends_on: ["T01"],
            allowed_paths: ["src/b.ts"],
            estimated_complexity: "low",
          },
        ],
      });

      let codexCall = 0;
      const codex = new MockWorker({
        name: "codex",
        responders: [
          async () => {
            codexCall++;
            await mkdir(path.join(root, "src"), { recursive: true });
            const file = codexCall === 1 ? "src/a.ts" : "src/b.ts";
            await writeFile(path.join(root, file), `export const x = ${codexCall};\n`, "utf8");
            return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
          },
        ],
      });
      const claude = new MockWorker({
        name: "claude",
        responders: [
          async () => ({ exitCode: 0, stdout: ts, stderr: "", durationMs: 1, outputFiles: [], timedOut: false }),
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
        maxRounds: 1,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        verifier: { commands: ["true"] },
        // The base allowedPaths is permissive; the task-level overrides are
        // narrow. Without auto-commit, T02 would see src/a.ts as a path
        // violation because T01's file is still in the working tree.
        safety: { allowedPaths: ["src/**"] },
      });

      const report = await runProject({
        spec: specFromText("# auto-commit smoke"),
        config,
        workers: { claude, codex },
        baseProjectsDir: projectsDir,
        budget: { maxTasks: 5, maxWallClockSeconds: 30, maxConsecutiveFailures: 3, maxAttemptsPerTask: 1 },
        quiet: true,
      });

      expect(report.status).toBe("completed");
      expect(report.finalBacklog.every((t) => t.status === "done")).toBe(true);

      // Each task became its own commit.
      const log = spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" });
      const commits = log.stdout.split("\n").filter(Boolean);
      // baseline + T01 + T02 = 3 commits
      expect(commits.length).toBeGreaterThanOrEqual(3);
      expect(commits.some((c) => c.includes("T01"))).toBe(true);
      expect(commits.some((c) => c.includes("T02"))).toBe(true);
    });
  }, 30_000);

  it("acknowledged_risks bypasses approval for THAT task only", async () => {
    await withTempProject(async ({ root, projectsDir }) => {
      const ts = JSON.stringify({
        summary: "one task that creates an auth file (security_change risk)",
        definition_of_done: ["src/auth.ts exists"],
        tasks: [
          {
            id: "T01",
            title: "Build auth router",
            description: "Create src/auth.ts",
            kind: "impl",
            depends_on: [],
            allowed_paths: ["src/**"],
            acknowledged_risks: ["security_change"], // ← key: pre-declares the risk
            estimated_complexity: "low",
          },
        ],
      });
      const codex = new MockWorker({
        name: "codex",
        responders: [
          async () => {
            await mkdir(path.join(root, "src"), { recursive: true });
            await writeFile(path.join(root, "src/auth.ts"), "export const auth = true;\n", "utf8");
            return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
          },
        ],
      });
      const claude = new MockWorker({
        name: "claude",
        responders: [
          async () => ({ exitCode: 0, stdout: ts, stderr: "", durationMs: 1, outputFiles: [], timedOut: false }),
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
        maxRounds: 1,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        verifier: { commands: ["true"] },
        safety: {
          allowedPaths: ["src/**"],
          // security_change is in approvalRequiredFor by default
        },
      });

      const report = await runProject({
        spec: specFromText("# auth"),
        config,
        workers: { claude, codex },
        baseProjectsDir: projectsDir,
        budget: { maxTasks: 5, maxWallClockSeconds: 30, maxConsecutiveFailures: 3, maxAttemptsPerTask: 1 },
        quiet: true,
      });

      expect(report.status).toBe("completed");
      expect(report.finalBacklog[0]!.status).toBe("done");
    });
  }, 30_000);

  it("project-wide acknowledgedRisks (CLI --ack) overrides without changing tasks", async () => {
    await withTempProject(async ({ root, projectsDir }) => {
      // Decomposer never adds acknowledged_risks; we ack them via project options.
      const ts = JSON.stringify({
        summary: "auth task",
        definition_of_done: ["auth.ts exists"],
        tasks: [
          {
            id: "T01",
            title: "Build auth router",
            description: "Create src/auth.ts",
            kind: "impl",
            depends_on: [],
            allowed_paths: ["src/**"],
            estimated_complexity: "low",
          },
        ],
      });
      const codex = new MockWorker({
        name: "codex",
        responders: [
          async () => {
            await mkdir(path.join(root, "src"), { recursive: true });
            await writeFile(path.join(root, "src/auth.ts"), "export const a = 1;\n", "utf8");
            return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
          },
        ],
      });
      const claude = new MockWorker({
        name: "claude",
        responders: [
          async () => ({ exitCode: 0, stdout: ts, stderr: "", durationMs: 1, outputFiles: [], timedOut: false }),
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
        maxRounds: 1,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        verifier: { commands: ["true"] },
        safety: { allowedPaths: ["src/**"] },
      });

      const report = await runProject({
        spec: specFromText("# auth"),
        config,
        workers: { claude, codex },
        baseProjectsDir: projectsDir,
        budget: { maxTasks: 5, maxWallClockSeconds: 30, maxConsecutiveFailures: 3, maxAttemptsPerTask: 1 },
        options: { acknowledgedRisks: ["security_change"] }, // ← project-wide
        quiet: true,
      });

      expect(report.status).toBe("completed");
      expect(report.finalBacklog[0]!.status).toBe("done");
      expect(report.totals.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(report.totals.totalRounds).toBeGreaterThanOrEqual(1);
    });
  }, 30_000);

  it("resumes a project from disk and continues from the next pending task", async () => {
    await withTempProject(async ({ root, projectsDir, commit }) => {
      // First run: T01 succeeds, T02 codex throws so the project stops mid-way.
      const ts = JSON.stringify({
        summary: "two tasks",
        definition_of_done: ["both done"],
        tasks: [
          { id: "T01", title: "first", description: "src/a.ts", kind: "impl", depends_on: [], allowed_paths: ["src/**"], estimated_complexity: "low" },
          { id: "T02", title: "second", description: "src/b.ts", kind: "impl", depends_on: ["T01"], allowed_paths: ["src/**"], estimated_complexity: "low" },
        ],
      });
      let codexCalls = 0;
      const flakyCodex = new MockWorker({
        name: "codex",
        responders: [
          async () => {
            codexCalls++;
            if (codexCalls === 1) {
              await mkdir(path.join(root, "src"), { recursive: true });
              await writeFile(path.join(root, "src/a.ts"), "export const x = 1;\n", "utf8");
              return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
            }
            // T02 throws — runWorkflow rejects, runProject marks the task failed.
            throw new Error("simulated implementer crash");
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
        verifier: { commands: ["true"] },
        safety: { allowedPaths: ["src/**"] },
      });
      const claude = new MockWorker({
        name: "claude",
        responders: [
          async () => ({ exitCode: 0, stdout: ts, stderr: "", durationMs: 1, outputFiles: [], timedOut: false }),
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

      commit();
      const first = await runProject({
        spec: specFromText("# resume me"),
        config,
        workers: { claude, codex: flakyCodex },
        baseProjectsDir: projectsDir,
        budget: { maxTasks: 5, maxWallClockSeconds: 30, maxConsecutiveFailures: 5, maxAttemptsPerTask: 1 },
        quiet: true,
      });
      expect(first.status).not.toBe("completed");
      expect(first.finalBacklog.find((t) => t.id === "T01")?.status).toBe("done");
      expect(first.finalBacklog.find((t) => t.id === "T02")?.status).toBe("failed");

      // Second run with resume. We manually un-fail T02 (simulating "user decided
      // to retry the failed task") and provide a happy codex. The new codex is
      // a fresh MockWorker so its responder queue starts at 0; it only needs to
      // handle the single T02 invocation.
      // No manual reset needed — runProject's resume logic auto-recovers
      // failed/blocked tasks back to pending with attempts=0.

      const happyCodex = new MockWorker({
        name: "codex",
        responders: [
          async () => {
            await writeFile(path.join(root, "src/b.ts"), "export const y = 2;\n", "utf8");
            return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
          },
        ],
      });
      // Reset claude responders so queue restarts (decomposer is skipped on resume).
      const resumeClaude = new MockWorker({
        name: "claude",
        responders: [
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

      const second = await runProject({
        config,
        workers: { claude: resumeClaude, codex: happyCodex },
        baseProjectsDir: projectsDir,
        resumeProjectId: first.projectId,
        budget: { maxTasks: 5, maxWallClockSeconds: 30, maxConsecutiveFailures: 5, maxAttemptsPerTask: 1 },
        quiet: true,
      });
      expect(second.projectId).toBe(first.projectId);
      expect(second.finalBacklog.find((t) => t.id === "T02")?.status).toBe("done");
    });
  }, 60_000);

  it("uses the deterministic fallback decomposer when claude is disabled", async () => {
    await withTempProject(async ({ root, projectsDir }) => {
      const codex = new MockWorker({ name: "codex", stdout: "ok" });
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

      const report = await runProject({
        spec: specFromText("# Auto\n\n## one\n## two\n"),
        config,
        workers: { claude, codex },
        baseProjectsDir: projectsDir,
        budget: { maxTasks: 5, maxWallClockSeconds: 30, maxConsecutiveFailures: 3, maxAttemptsPerTask: 1 },
        quiet: true,
      });

      // Fallback decomposer creates: section1, section2, verify = 3 tasks.
      expect(report.finalBacklog.length).toBe(3);
      // With no claude reviewer, fallback review is used. As long as the verifier
      // passes and there are no path violations, tasks should be `done`.
      expect(report.executions.length).toBeGreaterThanOrEqual(1);
    });
  }, 30_000);
});
