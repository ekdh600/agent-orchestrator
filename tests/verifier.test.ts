import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runVerifier } from "../src/orchestration/verifier.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ao-verifier-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runVerifier", () => {
  it("returns passed=true when every command succeeds", async () => {
    await withTempDir(async (dir) => {
      const r = await runVerifier({
        commands: ["true", "echo hi"],
        cwd: dir,
        logsDir: dir,
        timeoutMs: 5_000,
        denyShellPatterns: [],
      });
      expect(r.passed).toBe(true);
      expect(r.results.length).toBe(2);
      for (const c of r.results) expect(c.ok).toBe(true);
    });
  });

  it("aggregates failures but still returns each result", async () => {
    await withTempDir(async (dir) => {
      const r = await runVerifier({
        commands: ["true", "false", "echo done"],
        cwd: dir,
        logsDir: dir,
        timeoutMs: 5_000,
        denyShellPatterns: [],
      });
      expect(r.passed).toBe(false);
      expect(r.results.map((x) => x.ok)).toEqual([true, false, true]);
    });
  });

  it("blocks denied commands without executing them", async () => {
    await withTempDir(async (dir) => {
      const r = await runVerifier({
        commands: ["sudo make install"],
        cwd: dir,
        logsDir: dir,
        timeoutMs: 5_000,
        denyShellPatterns: ["sudo"],
      });
      expect(r.passed).toBe(false);
      expect(r.results[0]!.exitCode).toBe(126);
      const err = await readFile(r.results[0]!.stderrPath, "utf8");
      expect(err).toContain("blocked");
    });
  });

  it("kills processes that exceed the timeout", async () => {
    await withTempDir(async (dir) => {
      const r = await runVerifier({
        commands: ["sleep 5"],
        cwd: dir,
        logsDir: dir,
        timeoutMs: 200,
        denyShellPatterns: [],
      });
      expect(r.passed).toBe(false);
      expect(r.results[0]!.exitCode).toBe(124);
    });
  });

  it("returns passed=false for an empty command list", async () => {
    await withTempDir(async (dir) => {
      const r = await runVerifier({
        commands: [],
        cwd: dir,
        logsDir: dir,
        timeoutMs: 1_000,
        denyShellPatterns: [],
      });
      expect(r.passed).toBe(false);
      expect(r.results).toEqual([]);
    });
  });
});
