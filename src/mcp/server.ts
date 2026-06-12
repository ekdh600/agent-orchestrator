import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { OrchestratorConfig } from "../config/schema.js";
import { runWorkflow } from "../orchestration/runWorkflow.js";
import { buildWorkers } from "../workers/factory.js";
import { runProject, specFromText, loadProjectSpec } from "../project/index.js";

/**
 * Minimal Model Context Protocol (MCP) server over stdio.
 *
 * Implements just enough of MCP to be usable from Claude Code, Cursor, and
 * other MCP clients without depending on the full SDK. Speaks JSON-RPC 2.0
 * with line-delimited JSON over stdin/stdout (the format MCP clients use).
 *
 * Exposed tools:
 *   - run_task                — start a run with a task string or file path
 *   - list_runs               — recent run IDs
 *   - get_run_status          — final report summary
 *   - get_run_conversation    — chronological conversation events
 *   - get_run_artifact        — fetch a specific artifact file
 *
 * Logs go to STDERR only — STDOUT is reserved for protocol messages.
 */
export interface McpServerOptions {
  config: OrchestratorConfig;
  baseRunsDir?: string;
}

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "agent-orchestrator";
const SERVER_VERSION = "0.1.0";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: "run_task",
    description:
      "Start a new orchestrator run. Provide either `task` (inline Markdown) or `task_path` (absolute path to a task.md). Returns the run summary including status, requiresApproval, and changed files.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Inline task description (Markdown)" },
        task_path: { type: "string", description: "Absolute path to a task .md file" },
      },
    },
  },
  {
    name: "list_runs",
    description: "List recent orchestrator runs (most recent first).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_run_status",
    description: "Fetch the final report and verdict for a previous run.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Run ID returned by run_task or list_runs" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "get_run_conversation",
    description: "Fetch the chronological conversation log (every prompt/response between orchestrator and workers) for a run.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        limit: { type: "number", description: "Max number of events to return; defaults to all" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "get_run_artifact",
    description: "Fetch a single artifact file (e.g. plan.json, patch.diff, final_report.md) from a run.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        name: { type: "string", description: "Artifact filename (relative to run dir)" },
      },
      required: ["run_id", "name"],
    },
  },
  {
    name: "build_project",
    description:
      "Full-auto project builder. Decomposes a high-level project spec into a backlog of tasks, " +
      "executes each one through the plan→implement→verify→review pipeline, and stops when the " +
      "definition of done is met or the budget is exhausted. Returns the project report. " +
      "WARNING: long-running. Set max_tasks / max_seconds reasonably.",
    inputSchema: {
      type: "object",
      properties: {
        spec: { type: "string", description: "Inline project spec (Markdown)" },
        spec_path: { type: "string", description: "Absolute path to a project spec .md file" },
        resume_project_id: { type: "string", description: "Resume an existing project; reuses backlog/state" },
        max_tasks: { type: "number", description: "Hard cap on task executions (default: 30)" },
        max_seconds: { type: "number", description: "Hard cap on wall-clock seconds (default: 3600)" },
        acknowledged_risks: {
          type: "array",
          items: { type: "string" },
          description: "Project-wide acknowledged risks (e.g. [\"dependency_change\"])",
        },
      },
    },
  },
  {
    name: "list_projects",
    description: "List recent projects (most recent first).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_project_status",
    description: "Fetch a project's final report and backlog.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
  },
];

export async function startMcpServer(opts: McpServerOptions): Promise<void> {
  const baseRunsDir = path.resolve(opts.baseRunsDir ?? path.join(opts.config.projectRoot, "runs"));
  const workers = buildWorkers(opts.config);

  process.stderr.write(`[mcp] agent-orchestrator MCP server starting (protocol ${PROTOCOL_VERSION})\n`);

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch (err) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      handleRequest(req, opts, workers, baseRunsDir).then(
        (resp) => resp && send(resp),
        (err: unknown) => {
          send({
            jsonrpc: "2.0",
            id: req.id ?? null,
            error: {
              code: -32000,
              message: err instanceof Error ? err.message : String(err),
            },
          });
        },
      );
    }
  });

  // Hold the process open until stdin closes.
  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => resolve());
    process.stdin.on("close", () => resolve());
  });
}

/**
 * Pure request handler — exported so tests can drive the protocol without
 * spawning a subprocess.
 */
export async function handleMcpRequestForTesting(
  req: JsonRpcRequest,
  opts: McpServerOptions,
): Promise<JsonRpcResponse | null> {
  const baseRunsDir = path.resolve(opts.baseRunsDir ?? path.join(opts.config.projectRoot, "runs"));
  const workers = buildWorkers(opts.config);
  return handleRequest(req, opts, workers, baseRunsDir);
}

async function handleRequest(
  req: JsonRpcRequest,
  opts: McpServerOptions,
  workers: ReturnType<typeof buildWorkers>,
  baseRunsDir: string,
): Promise<JsonRpcResponse | null> {
  const { id = null, method, params = {} } = req;

  // Notifications (no id) get no response.
  const isNotification = req.id === undefined || req.id === null;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "notifications/initialized":
    case "initialized":
      return null;

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(name, args, opts, workers, baseRunsDir);
      return ok(id, result);
    }

    case "ping":
      return ok(id, {});

    default:
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      };
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: McpServerOptions,
  workers: ReturnType<typeof buildWorkers>,
  baseRunsDir: string,
): Promise<unknown> {
  switch (name) {
    case "run_task": {
      const task = typeof args.task === "string" ? args.task : undefined;
      const taskPath = typeof args.task_path === "string" ? args.task_path : undefined;
      if (!task && !taskPath) {
        return toolError("either 'task' or 'task_path' is required");
      }
      const report = await runWorkflow({
        config: opts.config,
        taskText: task,
        taskPath,
        workers: { claude: workers.claude, codex: workers.codex, cursor: workers.cursor },
        baseRunsDir,
        quiet: true,
      });
      const summary = {
        runId: report.runId,
        runDir: report.runDir,
        status: report.status,
        requiresApproval: report.requiresApproval,
        approvalReasons: report.approvalReasons,
        durationMs: report.durationMs,
        changedFiles: report.rounds[report.rounds.length - 1]?.diff.changedFiles ?? [],
        finalReportPath: path.join(report.runDir, "final_report.md"),
        conversationPath: path.join(report.runDir, "conversation.md"),
      };
      return toolText(
        `Run ${report.runId} → ${report.status}` +
          (report.requiresApproval ? ` (approval required: ${report.approvalReasons.join(", ")})` : ""),
        summary,
      );
    }

    case "list_runs": {
      let entries: string[] = [];
      try {
        entries = await readdir(baseRunsDir);
      } catch {
        return toolText("(no runs yet)", { runs: [] });
      }
      const runs: { runId: string; createdAt: string }[] = [];
      for (const e of entries) {
        try {
          const s = await stat(path.join(baseRunsDir, e));
          if (s.isDirectory()) runs.push({ runId: e, createdAt: s.birthtime.toISOString() });
        } catch {
          // ignore
        }
      }
      runs.sort((a, b) => b.runId.localeCompare(a.runId));
      return toolText(
        runs.length === 0 ? "(no runs)" : runs.map((r) => `${r.runId} (${r.createdAt})`).join("\n"),
        { runs },
      );
    }

    case "get_run_status": {
      const runId = String(args.run_id ?? "");
      if (!safeRunId(runId)) return toolError("invalid run id");
      try {
        const reportMd = await readFile(path.join(baseRunsDir, runId, "final_report.md"), "utf8");
        return toolText(reportMd, { runId });
      } catch {
        return toolError(`run not found: ${runId}`);
      }
    }

    case "get_run_conversation": {
      const runId = String(args.run_id ?? "");
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      if (!safeRunId(runId)) return toolError("invalid run id");
      try {
        const raw = await readFile(path.join(baseRunsDir, runId, "conversation.jsonl"), "utf8");
        let events = raw
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        if (limit && limit > 0) events = events.slice(-limit);
        const text = events
          .map((e) => `[${e.ts}] ${e.stage}/${e.actor} (${e.kind})${e.round ? ` r${e.round}` : ""}`)
          .join("\n");
        return toolText(text || "(no events)", { runId, events });
      } catch {
        return toolError(`conversation not found for run ${runId}`);
      }
    }

    case "get_run_artifact": {
      const runId = String(args.run_id ?? "");
      const name = String(args.name ?? "");
      if (!safeRunId(runId) || !safeArtifactName(name)) return toolError("invalid run id or artifact name");
      try {
        const content = await readFile(path.join(baseRunsDir, runId, name), "utf8");
        return toolText(content);
      } catch {
        return toolError(`artifact not found: ${name}`);
      }
    }

    case "build_project": {
      const inline = typeof args.spec === "string" ? args.spec : undefined;
      const specPath = typeof args.spec_path === "string" ? args.spec_path : undefined;
      const resumeId = typeof args.resume_project_id === "string" ? args.resume_project_id : undefined;
      if (!inline && !specPath && !resumeId) {
        return toolError("either 'spec', 'spec_path', or 'resume_project_id' is required");
      }
      const spec = inline ? specFromText(inline) : specPath ? await loadProjectSpec(specPath) : undefined;
      const baseProjectsDir = path.join(opts.config.projectRoot, "projects");
      const budget: Record<string, number> = {};
      if (typeof args.max_tasks === "number") budget.maxTasks = args.max_tasks;
      if (typeof args.max_seconds === "number") budget.maxWallClockSeconds = args.max_seconds;
      const acks = Array.isArray(args.acknowledged_risks)
        ? args.acknowledged_risks.filter((x): x is string => typeof x === "string")
        : [];
      const report = await runProject({
        ...(spec ? { spec } : {}),
        ...(resumeId ? { resumeProjectId: resumeId } : {}),
        config: opts.config,
        workers: { claude: workers.claude, codex: workers.codex, cursor: workers.cursor },
        baseProjectsDir,
        budget,
        options: acks.length > 0 ? { acknowledgedRisks: acks } : {},
        quiet: true,
      });
      const summary = {
        projectId: report.projectId,
        projectDir: report.projectDir,
        status: report.status,
        stopReason: report.stopReason,
        durationMs: report.durationMs,
        tasksTotal: report.finalBacklog.length,
        tasksDone: report.finalBacklog.filter((t) => t.status === "done").length,
        tasksFailed: report.finalBacklog.filter((t) => t.status === "failed").length,
        tasksBlocked: report.finalBacklog.filter((t) => t.status === "blocked").length,
        tasksNeedsApproval: report.finalBacklog.filter((t) => t.status === "needs_approval").length,
        finalReportPath: path.join(report.projectDir, "final_report.md"),
      };
      return toolText(
        `Project ${report.projectId} → ${report.status} (${summary.tasksDone}/${summary.tasksTotal} tasks done). ${report.stopReason}`,
        summary,
      );
    }

    case "list_projects": {
      const baseProjectsDir = path.join(opts.config.projectRoot, "projects");
      let entries: string[] = [];
      try {
        entries = await readdir(baseProjectsDir);
      } catch {
        return toolText("(no projects yet)", { projects: [] });
      }
      const projects: { projectId: string; createdAt: string }[] = [];
      for (const e of entries) {
        try {
          const s = await stat(path.join(baseProjectsDir, e));
          if (s.isDirectory()) projects.push({ projectId: e, createdAt: s.birthtime.toISOString() });
        } catch {
          // ignore
        }
      }
      projects.sort((a, b) => b.projectId.localeCompare(a.projectId));
      return toolText(
        projects.length === 0 ? "(no projects)" : projects.map((p) => `${p.projectId} (${p.createdAt})`).join("\n"),
        { projects },
      );
    }

    case "get_project_status": {
      const projectId = String(args.project_id ?? "");
      if (!safeRunId(projectId)) return toolError("invalid project id");
      const baseProjectsDir = path.join(opts.config.projectRoot, "projects");
      try {
        const reportMd = await readFile(path.join(baseProjectsDir, projectId, "final_report.md"), "utf8");
        const backlogRaw = await readFile(path.join(baseProjectsDir, projectId, "backlog.json"), "utf8").catch(() => "{}");
        return toolText(reportMd, { projectId, backlog: JSON.parse(backlogRaw) });
      } catch {
        return toolError(`project not found: ${projectId}`);
      }
    }

    default:
      return toolError(`unknown tool: ${name}`);
  }
}

function toolText(text: string, structured?: unknown) {
  const result: Record<string, unknown> = {
    content: [{ type: "text", text }],
  };
  if (structured !== undefined) {
    result.structuredContent = structured;
  }
  return result;
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function send(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function safeRunId(runId: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(runId);
}

function safeArtifactName(name: string): boolean {
  if (name.includes("..") || path.isAbsolute(name)) return false;
  return /^[a-zA-Z0-9._\-/]+$/.test(name);
}
