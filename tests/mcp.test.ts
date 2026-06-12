import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { handleMcpRequestForTesting } from "../src/mcp/server.js";
import { OrchestratorConfigSchema } from "../src/config/schema.js";

async function withProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ao-mcp-"));
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

const baseConfig = (root: string) =>
  OrchestratorConfigSchema.parse({
    projectRoot: root,
    maxRounds: 1,
    workers: {
      claude: { enabled: false, command: "echo", args: [] },
      codex: { enabled: false, command: "echo", args: [] },
    },
    verifier: { commands: ["true"] },
    safety: { allowedPaths: ["src/**"] },
  });

describe("MCP server", () => {
  it("responds to initialize with the protocol info", async () => {
    await withProject(async (root) => {
      const config = baseConfig(root);
      const resp = await handleMcpRequestForTesting(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { config, baseRunsDir: path.join(root, "runs") },
      );
      expect(resp).not.toBeNull();
      const result = resp!.result as { protocolVersion: string; serverInfo: { name: string } };
      expect(result.protocolVersion).toBeTruthy();
      expect(result.serverInfo.name).toBe("agent-orchestrator");
    });
  });

  it("lists the expected tools", async () => {
    await withProject(async (root) => {
      const config = baseConfig(root);
      const resp = await handleMcpRequestForTesting(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { config, baseRunsDir: path.join(root, "runs") },
      );
      const result = resp!.result as { tools: { name: string }[] };
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("run_task");
      expect(names).toContain("list_runs");
      expect(names).toContain("get_run_status");
      expect(names).toContain("get_run_conversation");
      expect(names).toContain("get_run_artifact");
    });
  });

  it("returns -32601 for unknown methods", async () => {
    await withProject(async (root) => {
      const config = baseConfig(root);
      const resp = await handleMcpRequestForTesting(
        { jsonrpc: "2.0", id: 3, method: "does/not/exist" },
        { config, baseRunsDir: path.join(root, "runs") },
      );
      expect(resp!.error?.code).toBe(-32601);
    });
  });

  it("returns null (no response) for notifications", async () => {
    await withProject(async (root) => {
      const config = baseConfig(root);
      const resp = await handleMcpRequestForTesting(
        // No id => notification
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { config, baseRunsDir: path.join(root, "runs") },
      );
      expect(resp).toBeNull();
    });
  });

  it("runs a task and exposes follow-up tool calls", async () => {
    await withProject(async (root) => {
      const config = baseConfig(root);
      const baseRunsDir = path.join(root, "runs");

      // run_task with inline task text
      const runResp = await handleMcpRequestForTesting(
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "run_task", arguments: { task: "# demo\nDo nothing." } },
        },
        { config, baseRunsDir },
      );
      const runResult = runResp!.result as {
        structuredContent: { runId: string; status: string };
        content: { type: string; text: string }[];
      };
      expect(runResult.structuredContent.runId).toBeTruthy();
      const runId = runResult.structuredContent.runId;

      // list_runs
      const listResp = await handleMcpRequestForTesting(
        { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "list_runs", arguments: {} } },
        { config, baseRunsDir },
      );
      const listResult = listResp!.result as { structuredContent: { runs: { runId: string }[] } };
      expect(listResult.structuredContent.runs.some((r) => r.runId === runId)).toBe(true);

      // get_run_conversation
      const convResp = await handleMcpRequestForTesting(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "tools/call",
          params: { name: "get_run_conversation", arguments: { run_id: runId } },
        },
        { config, baseRunsDir },
      );
      const convResult = convResp!.result as { structuredContent: { events: { kind: string }[] } };
      expect(convResult.structuredContent.events.length).toBeGreaterThan(0);
      expect(convResult.structuredContent.events.some((e) => e.kind === "status")).toBe(true);

      // get_run_artifact for task.md
      const artResp = await handleMcpRequestForTesting(
        {
          jsonrpc: "2.0",
          id: 13,
          method: "tools/call",
          params: { name: "get_run_artifact", arguments: { run_id: runId, name: "task.md" } },
        },
        { config, baseRunsDir },
      );
      const artResult = artResp!.result as { content: { type: string; text: string }[] };
      expect(artResult.content[0]!.text).toContain("demo");

      // Path traversal is rejected
      const badResp = await handleMcpRequestForTesting(
        {
          jsonrpc: "2.0",
          id: 14,
          method: "tools/call",
          params: { name: "get_run_artifact", arguments: { run_id: runId, name: "../etc/passwd" } },
        },
        { config, baseRunsDir },
      );
      const badResult = badResp!.result as { isError: boolean };
      expect(badResult.isError).toBe(true);
    });
  }, 30_000);

  it("returns a tool error if run_task is called without task or task_path", async () => {
    await withProject(async (root) => {
      const config = baseConfig(root);
      const resp = await handleMcpRequestForTesting(
        {
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: { name: "run_task", arguments: {} },
        },
        { config, baseRunsDir: path.join(root, "runs") },
      );
      const result = resp!.result as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/task|task_path/i);
    });
  });
});
