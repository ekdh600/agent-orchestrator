import type { OrchestratorConfig } from "../config/schema.js";
import { ClaudeWorker } from "./ClaudeWorker.js";
import { CodexWorker } from "./CodexWorker.js";
import { CursorWorker } from "./CursorWorker.js";
import type { Worker } from "./Worker.js";

export interface WorkerSet {
  claude: Worker;
  codex: Worker;
  cursor: Worker;
  /** Lookup by name, including any extra workers configured. */
  byName: Map<string, Worker>;
}

export function buildWorkers(config: OrchestratorConfig): WorkerSet {
  const claudeCfg = config.workers.claude ?? { enabled: false, command: "claude", args: ["-p"] };
  const codexCfg = config.workers.codex ?? { enabled: false, command: "codex", args: ["exec"] };
  const cursorCfg = config.workers.cursor ?? { enabled: false, command: "cursor-agent", args: ["-p"] };

  const claude = new ClaudeWorker({ enabled: claudeCfg.enabled, command: claudeCfg.command, args: claudeCfg.args, env: claudeCfg.env });
  const codex = new CodexWorker({ enabled: codexCfg.enabled, command: codexCfg.command, args: codexCfg.args, env: codexCfg.env });
  const cursor = new CursorWorker({ enabled: cursorCfg.enabled, command: cursorCfg.command, args: cursorCfg.args, env: cursorCfg.env });

  const byName = new Map<string, Worker>([
    ["claude", claude],
    ["codex", codex],
    ["cursor", cursor],
  ]);

  return { claude, codex, cursor, byName };
}
