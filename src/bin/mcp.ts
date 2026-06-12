#!/usr/bin/env node
/**
 * Direct MCP entrypoint, spawned by Claude Code / Cursor / other MCP clients.
 * Reads the same config from $AGENT_ORCH_CONFIG (or default) and starts the
 * MCP server on stdio. Stdout is reserved for protocol messages — never write
 * anything else there.
 */
import path from "node:path";
import process from "node:process";
import { defaultConfig, loadConfig } from "../config/loadConfig.js";
import { startMcpServer } from "../mcp/server.js";

async function main(): Promise<void> {
  const configPath = process.env.AGENT_ORCH_CONFIG;
  const projectRoot = process.env.AGENT_ORCH_PROJECT_ROOT
    ? path.resolve(process.env.AGENT_ORCH_PROJECT_ROOT)
    : process.cwd();
  const baseRunsDir = process.env.AGENT_ORCH_RUNS_DIR
    ? path.resolve(process.env.AGENT_ORCH_RUNS_DIR)
    : undefined;

  let config = configPath ? await loadConfig(configPath) : defaultConfig(projectRoot);
  if (!configPath && process.env.AGENT_ORCH_PROJECT_ROOT) {
    config = { ...config, projectRoot };
  }
  await startMcpServer({ config, baseRunsDir });
}

main().catch((err) => {
  process.stderr.write(`[mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
