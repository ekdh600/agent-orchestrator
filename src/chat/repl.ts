import readline from "node:readline/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import type { OrchestratorConfig } from "../config/schema.js";
import { runWorkflow, type ProgressEvent } from "../orchestration/runWorkflow.js";
import { renderTerminalSummary } from "../orchestration/report.js";
import { buildWorkers } from "../workers/factory.js";

export interface ChatOptions {
  config: OrchestratorConfig;
  baseRunsDir?: string;
}

/**
 * Interactive chat REPL. The user types a natural-language task; the
 * orchestrator runs the full workflow and streams progress back. Each task
 * starts a new run; transcripts are still saved under runs/<id>/.
 *
 * Special inputs:
 *   - blank line          → submit current buffer
 *   - `:help`             → show commands
 *   - `:runs`             → list recent run IDs
 *   - `:show <runId>`     → print final report path
 *   - `:quit` / Ctrl-D    → exit
 */
export async function startChat(opts: ChatOptions): Promise<void> {
  const rl = readline.createInterface({ input, output, terminal: true });
  const workers = buildWorkers(opts.config);

  console.log("");
  console.log("agent-orchestrator chat — type a task, blank line to submit, :help for commands, Ctrl-D to exit.");
  console.log(`projectRoot: ${opts.config.projectRoot}`);
  console.log(
    `workers: claude=${opts.config.workers.claude?.enabled ?? false} ` +
      `codex=${opts.config.workers.codex?.enabled ?? false} ` +
      `cursor=${opts.config.workers.cursor?.enabled ?? false}`,
  );
  console.log("");

  let buffer: string[] = [];
  const recentRuns: string[] = [];

  const prompt = () => (buffer.length === 0 ? "you> " : "    | ");

  rl.on("close", () => {
    console.log("\nbye.");
    process.exit(0);
  });

  while (true) {
    let line: string;
    try {
      line = await rl.question(prompt());
    } catch {
      break; // Ctrl-D
    }

    // Slash-style commands
    if (buffer.length === 0 && line.startsWith(":")) {
      const cmd = line.trim();
      if (cmd === ":help") {
        printHelp();
        continue;
      }
      if (cmd === ":quit" || cmd === ":exit") {
        rl.close();
        break;
      }
      if (cmd === ":runs") {
        if (recentRuns.length === 0) console.log("(no runs yet in this session)");
        else for (const id of recentRuns) console.log(`  ${id}`);
        continue;
      }
      if (cmd.startsWith(":show ")) {
        const id = cmd.slice(":show ".length).trim();
        const baseRunsDir = opts.baseRunsDir ?? path.join(opts.config.projectRoot, "runs");
        console.log(`  ${path.join(baseRunsDir, id, "final_report.md")}`);
        continue;
      }
      console.log(`unknown command: ${cmd} (try :help)`);
      continue;
    }

    if (line.trim().length === 0) {
      // submit buffer
      if (buffer.length === 0) continue;
      const taskText = buffer.join("\n").trim();
      buffer = [];
      await runOnce(taskText, opts, workers, recentRuns);
      continue;
    }

    buffer.push(line);
  }
}

async function runOnce(
  taskText: string,
  opts: ChatOptions,
  workers: ReturnType<typeof buildWorkers>,
  recentRuns: string[],
): Promise<void> {
  // Ensure the task starts with a Markdown heading so reports look nice.
  const text = taskText.startsWith("#") ? taskText : `# ${firstLine(taskText)}\n\n${taskText}`;

  console.log("");
  console.log("--- starting run ---");

  const onProgress = (e: ProgressEvent) => {
    const tag = e.kind === "verifier_start" ? "verifier" : e.kind === "verifier_end" ? "verifier" : (e as { worker?: string }).worker ?? "orchestrator";
    switch (e.kind) {
      case "status":
        console.log(`  [${tag}] ${e.stage}${e.round ? ` r${e.round}` : ""}: ${e.message}`);
        break;
      case "worker_start":
        console.log(`  [${e.worker}] ${e.stage}${e.round ? ` r${e.round}` : ""} → working…`);
        break;
      case "worker_end":
        console.log(
          `  [${e.worker}] ${e.stage}${e.round ? ` r${e.round}` : ""} ← exit ${e.exitCode} (${e.durationMs}ms)`,
        );
        break;
      case "verifier_start":
        console.log(`  [verifier] r${e.round} $ ${e.command}`);
        break;
      case "verifier_end":
        console.log(
          `  [verifier] r${e.round} ${e.ok ? "✓" : "✗"} ${e.command} (exit ${e.exitCode}, ${e.durationMs}ms)`,
        );
        break;
    }
  };

  try {
    const report = await runWorkflow({
      config: opts.config,
      taskText: text,
      workers: { claude: workers.claude, codex: workers.codex, cursor: workers.cursor },
      baseRunsDir: opts.baseRunsDir,
      quiet: true,
      onProgress,
    });
    recentRuns.unshift(report.runId);
    console.log(renderTerminalSummary(report));
    console.log(`  conversation log: ${path.join(report.runDir, "conversation.md")}`);
    console.log(`  final report:     ${path.join(report.runDir, "final_report.md")}`);
    console.log("");
  } catch (err) {
    console.error(`run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function firstLine(s: string): string {
  const line = s.split("\n")[0]?.trim() ?? "task";
  return line.slice(0, 60);
}

function printHelp(): void {
  console.log(
    [
      "  blank line             submit current task buffer and start a run",
      "  :runs                  list run IDs created in this chat session",
      "  :show <runId>          print path to that run's final report",
      "  :quit / Ctrl-D         exit",
    ].join("\n"),
  );
}
