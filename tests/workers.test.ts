import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ClaudeWorker } from "../src/workers/ClaudeWorker.js";
import { CodexWorker } from "../src/workers/CodexWorker.js";
import { CursorWorker } from "../src/workers/CursorWorker.js";
import { MockWorker } from "../src/workers/MockWorker.js";
import { runSubprocess } from "../src/workers/spawnUtil.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ao-workers-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const policy = {
  allowedPaths: ["src/**"],
  approvalRequiredFor: ["dependency_change"],
  denyShellPatterns: [],
};

describe("real workers (subprocess)", () => {
  it("ClaudeWorker forwards prompt via stdin and parses JSON output", async () => {
    await withTempDir(async (dir) => {
      // `cat` reads stdin and prints to stdout — perfect stand-in for a model.
      const w = new ClaudeWorker({ enabled: true, command: "cat", args: [] });
      const out = await w.run({
        role: "planner",
        prompt: '{"summary":"hi","target_files":[],"risk_level":"low","risky_operations":[],"proposed_steps":[],"verification_strategy":[]}',
        artifacts: [],
        cwd: dir,
        timeoutSeconds: 5,
        logDir: dir,
        safetyPolicy: policy,
        tag: "t",
      });
      expect(out.exitCode).toBe(0);
      expect(out.parsedJson).toBeTruthy();
      expect((out.parsedJson as Record<string, unknown>).summary).toBe("hi");
      expect(out.outputFiles.length).toBeGreaterThan(0);
    });
  });

  it("CodexWorker captures stdout/stderr and writes log files", async () => {
    await withTempDir(async (dir) => {
      const w = new CodexWorker({ enabled: true, command: "sh", args: ["-c", "echo hello && echo err 1>&2"] });
      const out = await w.run({
        role: "implementer",
        prompt: "implement",
        artifacts: [],
        cwd: dir,
        timeoutSeconds: 5,
        logDir: dir,
        safetyPolicy: policy,
        tag: "impl",
      });
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toContain("hello");
      expect(out.stderr).toContain("err");
      const stdoutLog = await readFile(out.outputFiles[0]!, "utf8");
      expect(stdoutLog).toContain("hello");
    });
  });

  it("CursorWorker is constructible and exposes its enabled flag", () => {
    const w = new CursorWorker({ enabled: false, command: "cursor-agent", args: ["-p"] });
    expect(w.enabled).toBe(false);
    expect(w.name).toBe("cursor");
  });

  it("redacts secrets in worker stdout", async () => {
    await withTempDir(async (dir) => {
      const w = new ClaudeWorker({ enabled: true, command: "sh", args: ["-c", "echo 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa'"] });
      const out = await w.run({
        role: "reviewer",
        prompt: "x",
        artifacts: [],
        cwd: dir,
        timeoutSeconds: 5,
        logDir: dir,
        safetyPolicy: policy,
      });
      expect(out.stdout).not.toContain("sk-ant-aaaa");
      expect(out.stdout).toContain("[REDACTED:");
    });
  });
});

describe("runSubprocess timeout", () => {
  it("kills children that exceed the timeout", async () => {
    await withTempDir(async (dir) => {
      const r = await runSubprocess({
        command: "sh",
        args: ["-c", "sleep 5"],
        cwd: dir,
        timeoutMs: 200,
        logDir: dir,
        logTag: "to",
      });
      expect(r.timedOut).toBe(true);
    });
  });
});

describe("MockWorker", () => {
  it("returns static stdout when no responders are configured", async () => {
    const w = new MockWorker({ name: "mock", stdout: '{"x":1}' });
    const r = await w.run({
      role: "custom",
      prompt: "p",
      artifacts: [],
      cwd: ".",
      timeoutSeconds: 1,
      logDir: ".",
      safetyPolicy: policy,
    });
    expect(r.parsedJson).toEqual({ x: 1 });
  });

  it("supports a queue of responders and reuses the last one", async () => {
    let calls = 0;
    const w = new MockWorker({
      name: "mock",
      responders: [
        () => {
          calls++;
          return {
            exitCode: 0,
            stdout: "first",
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          };
        },
        () => {
          calls++;
          return {
            exitCode: 0,
            stdout: "second",
            stderr: "",
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          };
        },
      ],
    });
    const r1 = await w.run({} as never);
    const r2 = await w.run({} as never);
    const r3 = await w.run({} as never);
    expect(r1.stdout).toBe("first");
    expect(r2.stdout).toBe("second");
    expect(r3.stdout).toBe("second"); // reused
    expect(calls).toBe(3);
  });

  it("can simulate timeouts", async () => {
    const w = new MockWorker({ name: "mock", simulateTimeout: true });
    const r = await w.run({} as never);
    expect(r.timedOut).toBe(true);
  });
});
