import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { startHttpServer } from "../src/http/server.js";
import { OrchestratorConfigSchema } from "../src/config/schema.js";

async function withProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ao-http-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  spawnSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: root });
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("HTTP server", () => {
  it("rejects non-localhost binds without an auth token", async () => {
    const config = OrchestratorConfigSchema.parse({ projectRoot: "." });
    await expect(startHttpServer({ config, host: "0.0.0.0" })).rejects.toThrow(/auth token/i);
  });

  it("answers /healthz, /openapi.json, and a full POST /runs flow", async () => {
    await withProject(async (root) => {
      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        maxRounds: 1,
        workers: {
          claude: { enabled: false, command: "echo", args: [] },
          codex: { enabled: false, command: "echo", args: [] },
        },
        verifier: { commands: ["true"] },
        safety: { allowedPaths: ["src/**"] },
      });
      const baseRunsDir = path.join(root, "runs");
      const { url, stop } = await startHttpServer({ config, baseRunsDir, port: 0 });
      try {
        // /healthz
        const health = await fetch(`${url}/healthz`).then((r) => r.json());
        expect(health).toEqual({ ok: true });

        // /openapi.json
        const openapi = (await fetch(`${url}/openapi.json`).then((r) => r.json())) as Record<string, unknown>;
        expect(openapi.openapi).toBe("3.1.0");

        // POST /runs with inline task
        const start = await fetch(`${url}/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "# demo\nDo nothing." }),
        }).then((r) => r.json() as Promise<Record<string, unknown>>);
        expect(start.runId).toBeTruthy();
        expect(start.status).toBeTruthy();

        // GET /runs
        const list = (await fetch(`${url}/runs`).then((r) => r.json())) as { runs: { runId: string }[] };
        expect(list.runs.length).toBeGreaterThan(0);

        // GET /runs/:id
        const detail = (await fetch(`${url}/runs/${start.runId as string}`).then((r) => r.json())) as Record<
          string,
          unknown
        >;
        expect(detail.runId).toBe(start.runId);
        expect(typeof detail.finalReport).toBe("string");

        // GET /runs/:id/conversation
        const conv = (await fetch(`${url}/runs/${start.runId as string}/conversation`).then((r) => r.json())) as {
          events: { kind: string }[];
        };
        expect(Array.isArray(conv.events)).toBe(true);
        expect(conv.events.some((e) => e.kind === "status")).toBe(true);

        // GET /runs/:id/artifact?name=task.md
        const artifactRes = await fetch(`${url}/runs/${start.runId as string}/artifact?name=task.md`);
        const artifactText = await artifactRes.text();
        expect(artifactRes.status).toBe(200);
        expect(artifactText).toContain("demo");

        // 404 for unknown route
        const notFound = await fetch(`${url}/nope`);
        expect(notFound.status).toBe(404);

        // 400 for malformed POST
        const bad = await fetch(`${url}/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(bad.status).toBe(400);
      } finally {
        await stop();
      }
    });
  }, 30_000);

  it("requires the bearer token when configured", async () => {
    await withProject(async (root) => {
      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        workers: { claude: { enabled: false, command: "echo", args: [] }, codex: { enabled: false, command: "echo", args: [] } },
        verifier: { commands: ["true"] },
      });
      const { url, stop } = await startHttpServer({
        config,
        baseRunsDir: path.join(root, "runs"),
        port: 0,
        authToken: "secret-123",
      });
      try {
        const noAuth = await fetch(`${url}/healthz`);
        expect(noAuth.status).toBe(401);
        const ok = await fetch(`${url}/healthz`, {
          headers: { authorization: "Bearer secret-123" },
        });
        expect(ok.status).toBe(200);
      } finally {
        await stop();
      }
    });
  });

  it("rejects path traversal in artifact requests", async () => {
    await withProject(async (root) => {
      const config = OrchestratorConfigSchema.parse({
        projectRoot: root,
        workers: { claude: { enabled: false, command: "echo", args: [] }, codex: { enabled: false, command: "echo", args: [] } },
        verifier: { commands: ["true"] },
      });
      const { url, stop } = await startHttpServer({ config, baseRunsDir: path.join(root, "runs"), port: 0 });
      try {
        // Need a run id of any shape — server should refuse the unsafe artifact name early.
        const r = await fetch(`${url}/runs/some-run/artifact?name=../../etc/passwd`);
        expect(r.status).toBe(400);
      } finally {
        await stop();
      }
    });
  });
});
