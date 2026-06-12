import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { OrchestratorConfigSchema } from "../src/config/schema.js";
import { MockWorker } from "../src/workers/MockWorker.js";
import { runProject } from "../src/project/runProject.js";
import { specWithAdoptedAssumptions } from "../src/project/clarify.js";
import { specFromText } from "../src/project/index.js";

async function withTempProject<T>(
  fn: (project: { root: string; projectsDir: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ao-clarify-"));
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

const clarifyWithQuestions = JSON.stringify({
  ready: false,
  questions: [
    {
      question: "Which database should the API persist to?",
      why: "The spec says 'store users' without naming a persistence layer.",
      default_assumption: "SQLite via better-sqlite3, file db.sqlite in the project root.",
    },
  ],
  assumptions: ["Node 20 runtime."],
});

const decomposeJson = JSON.stringify({
  summary: "One impl task.",
  definition_of_done: ["src/x.ts exists"],
  tasks: [
    { id: "T01", title: "Write x", description: "Create src/x.ts", kind: "impl", depends_on: [], estimated_complexity: "low" },
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

const approveJson = JSON.stringify({ verdict: "approve", bugs: [], missing_tests: [], risks: [], recommended_fixes: [] });

describe("specWithAdoptedAssumptions", () => {
  it("appends adopted defaults and standalone assumptions to the spec body", () => {
    const spec = specFromText("# P\n\nBuild it.\n");
    const out = specWithAdoptedAssumptions(spec, {
      ready: false,
      questions: [{ question: "Q1?", why: "w", default_assumption: "A1." }],
      assumptions: ["S1."],
    });
    expect(out.body).toContain("## Assumptions (auto-adopted)");
    expect(out.body).toContain("**Q:** Q1?");
    expect(out.body).toContain("**Adopted:** A1.");
    expect(out.body).toContain("- S1.");
  });

  it("returns the spec unchanged when there is nothing to adopt", () => {
    const spec = specFromText("# P\n\nBuild it.\n");
    expect(specWithAdoptedAssumptions(spec, { ready: true, questions: [], assumptions: [] })).toBe(spec);
  });
});

describe("runProject interview gate", () => {
  it('interview="required" stops with needs_clarification and surfaces the questions', async () => {
    await withTempProject(async ({ root, projectsDir }) => {
      let decomposeAsked = false;
      const claude = new MockWorker({
        name: "claude",
        responders: [
          ok(clarifyWithQuestions),
          async () => {
            decomposeAsked = true;
            return { exitCode: 0, stdout: decomposeJson, stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
          },
        ],
      });
      const codex = new MockWorker({ name: "codex", stdout: "noop" });

      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        workers: {
          claude: { enabled: true, command: "echo", args: [] },
          codex: { enabled: true, command: "echo", args: [] },
        },
        project: { interview: "required" },
        verifier: { commands: ["true"] },
      });

      const report = await runProject({
        spec: specFromText("# API\n\nStore users somewhere.\n"),
        config,
        workers: { claude, codex },
        baseProjectsDir: projectsDir,
        quiet: true,
      });

      expect(report.status).toBe("needs_clarification");
      expect(decomposeAsked).toBe(false); // stopped before decomposition
      expect(report.executions.length).toBe(0);
      expect(report.finalState.blockers[0]).toContain("Which database");

      const clarification = JSON.parse(await readFile(path.join(report.projectDir, "clarification.json"), "utf8"));
      expect(clarification.questions.length).toBe(1);
      expect(clarification._meta?.exchangeId).toContain("-clarify-");

      const md = await readFile(path.join(report.projectDir, "final_report.md"), "utf8");
      expect(md).toContain("needs_clarification");
      expect(md).toContain("Which database");
    });
  }, 30_000);

  it('interview="auto" adopts default assumptions into the spec and continues', async () => {
    await withTempProject(async ({ root, projectsDir }) => {
      let decomposeSawAssumptions = false;
      const claude = new MockWorker({
        name: "claude",
        responders: [
          ok(clarifyWithQuestions),
          async (input) => {
            decomposeSawAssumptions = input.artifacts.some(
              (a) => a.content?.includes("Assumptions (auto-adopted)") && a.content?.includes("SQLite"),
            );
            return { exitCode: 0, stdout: decomposeJson, stderr: "", durationMs: 1, outputFiles: [], timedOut: false };
          },
          ok(planJson),
          ok(approveJson),
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
        project: { interview: "auto" },
        verifier: { commands: ["true"] },
      });

      const report = await runProject({
        spec: specFromText("# API\n\nStore users somewhere.\n"),
        config,
        workers: { claude, codex },
        baseProjectsDir: projectsDir,
        quiet: true,
      });

      expect(report.status).toBe("completed");
      expect(decomposeSawAssumptions).toBe(true); // downstream prompts see the adopted defaults
      const specOnDisk = await readFile(path.join(report.projectDir, "spec.md"), "utf8");
      expect(specOnDisk).toContain("## Assumptions (auto-adopted)");
      expect(specOnDisk).toContain("SQLite");
    });
  }, 30_000);
});
