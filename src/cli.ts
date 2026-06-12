#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { ConfigError, defaultConfig, loadConfig } from "./config/loadConfig.js";
import { runWorkflow } from "./orchestration/runWorkflow.js";
import { renderTerminalSummary } from "./orchestration/report.js";
import { buildWorkers } from "./workers/factory.js";
import { startChat } from "./chat/repl.js";
import { startHttpServer } from "./http/server.js";
import { startMcpServer } from "./mcp/server.js";
import { runProject, loadProjectSpec, specFromText } from "./project/index.js";
import type { OrchestratorConfig } from "./config/schema.js";

type Command = "run" | "chat" | "serve" | "mcp" | "build-project" | "help" | "version";

interface CliArgs {
  command: Command;
  task?: string;
  taskText?: string;
  category?: string;
  config?: string;
  projectRoot?: string;
  runsDir?: string;
  quiet: boolean;
  // serve-only
  host?: string;
  port?: number;
  authToken?: string;
  // build-project-only
  spec?: string;
  specText?: string;
  projectsDir?: string;
  maxTasks?: number;
  maxWallClockSeconds?: number;
  noAutoCommit?: boolean;
  ack?: string[];
  resume?: string;
}

const HELP = `agent-orchestrator — coordinate AI coding agents (Claude Code, Codex CLI, Cursor)
                     as isolated workers with auditable, artifact-driven runs.

Usage:
  agent-orchestrator run           --task <path>     [options]    one-shot single-task run
  agent-orchestrator run           --task-text <s>   [options]    one-shot single-task run (inline)
  agent-orchestrator build-project --spec <path>     [options]    full-auto multi-task project builder
  agent-orchestrator build-project --spec-text <s>   [options]    full-auto project builder (inline spec)
  agent-orchestrator chat                            [options]    interactive chat REPL
  agent-orchestrator serve                           [options]    HTTP API (custom GPTs, scripts)
  agent-orchestrator mcp                             [options]    MCP server over stdio
  agent-orchestrator help
  agent-orchestrator version

Common options:
  --config <path>          orchestrator config JSON
  --project-root <path>    override projectRoot
  --runs-dir <path>        directory for run artifacts (default: <projectRoot>/runs)
  --quiet, -q              suppress progress logs

serve-only options:
  --host <addr>            bind host (default: 127.0.0.1)
  --port <n>               bind port (default: 4711)
  --auth-token <s>         bearer token required for non-localhost requests

build-project-only options:
  --spec <path>            project spec markdown file
  --spec-text <s>          inline project spec
  --projects-dir <path>    where project dirs are created (default: <projectRoot>/projects)
  --max-tasks <n>          hard cap on task executions (default: 30)
  --max-seconds <n>        hard cap on wall-clock seconds (default: 3600)
  --no-auto-commit         disable per-task git commits (default: auto-commit ON)
  --ack <risk>             acknowledge a risk project-wide (repeat for multiple)
  --category <c>           routing category for a single-task run (quick|standard|deep)
  --resume <projectId>     pick up a stopped project; backlog/state are reused

Exit codes (run mode):
  0  — approved (verifier passed and reviewer approved)
  10 — verifier failed after max rounds
  11 — review requested changes after max rounds
  12 — human approval required (risky operation or path violation)
  20 — orchestrator error
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "version":
      console.log("agent-orchestrator 0.1.0");
      return 0;
    case "help":
      console.log(HELP);
      return 0;
    case "run":
      return runCommand(args);
    case "chat":
      return chatCommand(args);
    case "serve":
      return serveCommand(args);
    case "mcp":
      return mcpCommand(args);
    case "build-project":
      return buildProjectCommand(args);
  }
}

async function loadCliConfig(args: CliArgs): Promise<OrchestratorConfig> {
  let config: OrchestratorConfig;
  if (args.config) {
    config = await loadConfig(args.config);
  } else {
    const root = args.projectRoot ? path.resolve(args.projectRoot) : process.cwd();
    config = defaultConfig(root);
  }
  if (args.projectRoot) {
    config = { ...config, projectRoot: path.resolve(args.projectRoot) };
  }
  return config;
}

async function runCommand(args: CliArgs): Promise<number> {
  if (!args.task && !args.taskText) {
    console.error("Error: --task <path> or --task-text <string> is required.\n\n" + HELP);
    return 20;
  }

  let config: OrchestratorConfig;
  try {
    config = await loadCliConfig(args);
  } catch (err) {
    return reportConfigError(err);
  }

  const workers = buildWorkers(config);

  try {
    const report = await runWorkflow({
      config,
      taskPath: args.task ? path.resolve(args.task) : undefined,
      taskText: args.taskText,
      workers: { claude: workers.claude, codex: workers.codex, cursor: workers.cursor },
      baseRunsDir: args.runsDir,
      quiet: args.quiet,
      category: args.category,
    });
    if (!args.quiet) console.log(renderTerminalSummary(report));
    return exitCodeFor(report.status);
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`Orchestrator error:\n${msg}`);
    return 20;
  }
}

async function chatCommand(args: CliArgs): Promise<number> {
  let config: OrchestratorConfig;
  try {
    config = await loadCliConfig(args);
  } catch (err) {
    return reportConfigError(err);
  }
  await startChat({ config, baseRunsDir: args.runsDir });
  return 0;
}

async function serveCommand(args: CliArgs): Promise<number> {
  let config: OrchestratorConfig;
  try {
    config = await loadCliConfig(args);
  } catch (err) {
    return reportConfigError(err);
  }
  try {
    const { url, stop } = await startHttpServer({
      config,
      baseRunsDir: args.runsDir,
      host: args.host,
      port: args.port,
      authToken: args.authToken,
    });
    console.log(`agent-orchestrator HTTP server listening on ${url}`);
    console.log(`OpenAPI spec: ${url}/openapi.json`);
    console.log("POST /runs   {task: \"...\"}    to start a run");
    console.log("GET  /runs                       list runs");
    console.log("GET  /runs/:id                   get final report");
    console.log("GET  /runs/:id/conversation      get conversation log");
    console.log("Ctrl-C to stop.");

    const shutdown = async () => {
      console.log("\nshutting down…");
      await stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Keep alive until a signal arrives.
    await new Promise(() => {});
    return 0;
  } catch (err) {
    console.error(`HTTP server failed: ${err instanceof Error ? err.message : String(err)}`);
    return 20;
  }
}

async function buildProjectCommand(args: CliArgs): Promise<number> {
  if (!args.spec && !args.specText && !args.resume) {
    console.error("Error: --spec, --spec-text, or --resume is required.\n\n" + HELP);
    return 20;
  }
  let config: OrchestratorConfig;
  try {
    config = await loadCliConfig(args);
  } catch (err) {
    return reportConfigError(err);
  }
  const workers = buildWorkers(config);
  const spec = args.spec
    ? await loadProjectSpec(path.resolve(args.spec))
    : args.specText
      ? specFromText(args.specText)
      : undefined;
  const projectOptions: { autoCommitBetweenTasks?: boolean; acknowledgedRisks?: string[] } = {};
  if (args.noAutoCommit) projectOptions.autoCommitBetweenTasks = false;
  if (args.ack && args.ack.length > 0) projectOptions.acknowledgedRisks = args.ack;
  try {
    const report = await runProject({
      ...(spec ? { spec } : {}),
      ...(args.resume ? { resumeProjectId: args.resume } : {}),
      config,
      workers: { claude: workers.claude, codex: workers.codex, cursor: workers.cursor },
      baseProjectsDir: args.projectsDir,
      budget: {
        ...(args.maxTasks !== undefined ? { maxTasks: args.maxTasks } : {}),
        ...(args.maxWallClockSeconds !== undefined ? { maxWallClockSeconds: args.maxWallClockSeconds } : {}),
      },
      options: projectOptions,
      quiet: args.quiet,
    });
    if (!args.quiet) {
      console.log("");
      console.log(`Project ${report.projectId} — status: ${report.status}`);
      console.log(`Stop reason: ${report.stopReason}`);
      console.log(`Project dir: ${report.projectDir}`);
      console.log(`Tasks: ${report.executions.length} executions over ${report.finalBacklog.length} tasks`);
      console.log(`Final report: ${path.join(report.projectDir, "final_report.md")}`);
    }
    return projectExitCode(report.status);
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`Project builder error:\n${msg}`);
    return 20;
  }
}

function projectExitCode(status: string): number {
  switch (status) {
    case "completed":
      return 0;
    case "stopped_failures":
      return 10;
    case "stopped_blocked":
      return 11;
    case "stopped_approval":
      return 12;
    case "stopped_budget":
      return 13;
    case "needs_clarification":
      return 14;
    default:
      return 20;
  }
}

async function mcpCommand(args: CliArgs): Promise<number> {
  let config: OrchestratorConfig;
  try {
    config = await loadCliConfig(args);
  } catch (err) {
    return reportConfigError(err);
  }
  await startMcpServer({ config, baseRunsDir: args.runsDir });
  return 0;
}

function reportConfigError(err: unknown): number {
  if (err instanceof ConfigError) {
    console.error(`Config error: ${err.message}`);
  } else {
    console.error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
  }
  return 20;
}

function exitCodeFor(status: string): number {
  switch (status) {
    case "approved":
      return 0;
    case "verifier_failed":
      return 10;
    case "review_changes_requested":
      return 11;
    case "requires_approval":
      return 12;
    default:
      return 20;
  }
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", quiet: false };
  }
  if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-v") {
    return { command: "version", quiet: false };
  }
  const cmd = argv[0];
  if (cmd !== "run" && cmd !== "chat" && cmd !== "serve" && cmd !== "mcp" && cmd !== "build-project") {
    throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
  }
  const out: CliArgs = { command: cmd, quiet: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case "--task":
        out.task = mustHaveValue("--task", next);
        i++;
        break;
      case "--task-text":
        out.taskText = mustHaveValue("--task-text", next);
        i++;
        break;
      case "--category":
        out.category = mustHaveValue("--category", next);
        i++;
        break;
      case "--config":
        out.config = mustHaveValue("--config", next);
        i++;
        break;
      case "--project-root":
        out.projectRoot = mustHaveValue("--project-root", next);
        i++;
        break;
      case "--runs-dir":
        out.runsDir = mustHaveValue("--runs-dir", next);
        i++;
        break;
      case "--host":
        out.host = mustHaveValue("--host", next);
        i++;
        break;
      case "--port": {
        const v = mustHaveValue("--port", next);
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0 || n > 65_535) {
          throw new Error(`--port must be a positive integer, got: ${v}`);
        }
        out.port = n;
        i++;
        break;
      }
      case "--auth-token":
        out.authToken = mustHaveValue("--auth-token", next);
        i++;
        break;
      case "--spec":
        out.spec = mustHaveValue("--spec", next);
        i++;
        break;
      case "--spec-text":
        out.specText = mustHaveValue("--spec-text", next);
        i++;
        break;
      case "--projects-dir":
        out.projectsDir = mustHaveValue("--projects-dir", next);
        i++;
        break;
      case "--max-tasks": {
        const v = mustHaveValue("--max-tasks", next);
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n < 1) throw new Error(`--max-tasks must be a positive integer, got: ${v}`);
        out.maxTasks = n;
        i++;
        break;
      }
      case "--max-seconds": {
        const v = mustHaveValue("--max-seconds", next);
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n < 60) throw new Error(`--max-seconds must be >= 60, got: ${v}`);
        out.maxWallClockSeconds = n;
        i++;
        break;
      }
      case "--no-auto-commit":
        out.noAutoCommit = true;
        break;
      case "--ack": {
        const v = mustHaveValue("--ack", next);
        out.ack = [...(out.ack ?? []), v];
        i++;
        break;
      }
      case "--resume":
        out.resume = mustHaveValue("--resume", next);
        i++;
        break;
      case "--quiet":
      case "-q":
        out.quiet = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}\n\n${HELP}`);
    }
  }
  return out;
}

function mustHaveValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Flag ${flag} requires a value.`);
  }
  return value;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(20);
  },
);
