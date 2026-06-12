import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { OrchestratorConfigSchema } from "../src/config/schema.js";
import { loadConfig, defaultConfig, ConfigError } from "../src/config/loadConfig.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ao-config-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("OrchestratorConfigSchema", () => {
  it("applies defaults to a minimal config", () => {
    const parsed = OrchestratorConfigSchema.parse({});
    expect(parsed.projectRoot).toBe(".");
    expect(parsed.maxRounds).toBe(3);
    expect(parsed.timeoutSeconds).toBe(900);
    expect(parsed.verifier.commands).toEqual([]);
    expect(parsed.safety.allowedPaths).toEqual([]);
    expect(parsed.safety.approvalRequiredFor.length).toBeGreaterThan(0);
  });

  it("rejects unknown top-level fields", () => {
    const r = OrchestratorConfigSchema.safeParse({ surprise: true });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-range maxRounds", () => {
    const r = OrchestratorConfigSchema.safeParse({ maxRounds: 0 });
    expect(r.success).toBe(false);
  });

  it("accepts custom worker entries beyond the well-known three", () => {
    const r = OrchestratorConfigSchema.parse({
      workers: {
        claude: { enabled: true, command: "claude", args: ["-p"] },
        codex: { enabled: true, command: "codex", args: ["exec"] },
        gemini: { enabled: false, command: "gemini", args: [] },
      },
    });
    expect(r.workers.gemini?.command).toBe("gemini");
  });
});

describe("loadConfig", () => {
  it("returns an error for invalid JSON with a clear message", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "bad.json");
      await writeFile(file, "{not json", "utf8");
      await expect(loadConfig(file)).rejects.toBeInstanceOf(ConfigError);
    });
  });

  it("resolves projectRoot relative to the config file", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "c.json");
      await writeFile(file, JSON.stringify({ projectRoot: "./sub" }), "utf8");
      const cfg = await loadConfig(file);
      expect(cfg.projectRoot).toBe(path.join(dir, "sub"));
    });
  });

  it("emits descriptive messages for invalid fields", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "c.json");
      await writeFile(file, JSON.stringify({ maxRounds: -1 }), "utf8");
      await expect(loadConfig(file)).rejects.toMatchObject({
        message: expect.stringContaining("maxRounds"),
      });
    });
  });

  it("defaultConfig produces a usable config", () => {
    const cfg = defaultConfig("/tmp/proj");
    expect(cfg.projectRoot).toBe("/tmp/proj");
    expect(cfg.maxRounds).toBeGreaterThan(0);
  });
});
