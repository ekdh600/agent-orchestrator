import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { decidePreVerifier, runPreVerifier } from "../src/orchestration/preVerifier.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ao-preverifier-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("decidePreVerifier", () => {
  it("returns null when mode is 'off'", async () => {
    await withTempDir(async (dir) => {
      const r = await decidePreVerifier({
        cwd: dir,
        changedFiles: [{ path: "package.json", status: "modified" }],
        mode: "off",
        installCommand: "auto",
      });
      expect(r).toBeNull();
    });
  });

  it("returns null when mode is 'if-changed' and no manifest changed", async () => {
    await withTempDir(async (dir) => {
      const r = await decidePreVerifier({
        cwd: dir,
        changedFiles: [{ path: "src/foo.ts", status: "added" }],
        mode: "if-changed",
        installCommand: "auto",
      });
      expect(r).toBeNull();
    });
  });

  it("triggers when package.json appears in the diff", async () => {
    await withTempDir(async (dir) => {
      const r = await decidePreVerifier({
        cwd: dir,
        changedFiles: [{ path: "package.json", status: "added" }],
        mode: "if-changed",
        installCommand: "auto",
      });
      expect(r).not.toBeNull();
      expect(r!.command).toMatch(/npm install/);
    });
  });

  it("picks pnpm when pnpm-lock.yaml exists", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 6\n", "utf8");
      const r = await decidePreVerifier({
        cwd: dir,
        changedFiles: [{ path: "package.json", status: "modified" }],
        mode: "if-changed",
        installCommand: "auto",
      });
      expect(r!.command).toMatch(/pnpm install/);
    });
  });

  it("picks yarn when yarn.lock exists", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "yarn.lock"), "# yarn\n", "utf8");
      const r = await decidePreVerifier({
        cwd: dir,
        changedFiles: [{ path: "package.json", status: "modified" }],
        mode: "if-changed",
        installCommand: "auto",
      });
      expect(r!.command).toMatch(/yarn install/);
    });
  });

  it("respects an explicit installCommand override", async () => {
    await withTempDir(async (dir) => {
      const r = await decidePreVerifier({
        cwd: dir,
        changedFiles: [{ path: "package.json", status: "added" }],
        mode: "always",
        installCommand: "echo custom",
      });
      expect(r!.command).toBe("echo custom");
    });
  });
});

describe("runPreVerifier", () => {
  it("captures stdout/stderr to disk and returns exit code", async () => {
    await withTempDir(async (dir) => {
      const r = await runPreVerifier({
        command: "echo hello && (echo err 1>&2)",
        cwd: dir,
        logsDir: dir,
        timeoutMs: 5_000,
      });
      expect(r.ok).toBe(true);
      expect(r.exitCode).toBe(0);
      expect(r.command).toMatch(/echo hello/);
      // Files exist
      expect(r.stdoutPath).toMatch(/preverifier\.stdout\.log$/);
    });
  });

  it("times out long-running commands", async () => {
    await withTempDir(async (dir) => {
      const r = await runPreVerifier({
        command: "sleep 5",
        cwd: dir,
        logsDir: dir,
        timeoutMs: 200,
      });
      expect(r.timedOut).toBe(true);
      expect(r.exitCode).toBe(124);
    });
  });
});
