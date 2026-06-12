import { extractJson } from "../utils/jsonExtract.js";
import { redact } from "../utils/redact.js";
import { runSubprocess } from "./spawnUtil.js";
import type { Worker, WorkerInput, WorkerResult } from "./Worker.js";

export interface CodexWorkerOptions {
  enabled: boolean;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Wraps the `codex` CLI in non-interactive `exec` mode. The prompt is piped via
 * stdin so it does not appear on the process command line.
 */
export class CodexWorker implements Worker {
  readonly name = "codex";
  readonly enabled: boolean;

  constructor(private readonly opts: CodexWorkerOptions) {
    this.enabled = opts.enabled;
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    const fullPrompt = buildCodexPrompt(input);
    const res = await runSubprocess({
      command: this.opts.command,
      args: input.model ? [...this.opts.args, "-m", input.model] : this.opts.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutSeconds * 1000,
      stdin: fullPrompt,
      env: { ...this.opts.env, ...input.env },
      logDir: input.logDir,
      logTag: input.tag ?? `codex.${input.role}`,
    });

    return {
      exitCode: res.exitCode,
      stdout: redact(res.stdout),
      stderr: redact(res.stderr),
      durationMs: res.durationMs,
      outputFiles: [res.rawStdoutPath, res.rawStderrPath],
      parsedJson: extractJson(res.stdout) ?? undefined,
      timedOut: res.timedOut,
    };
  }
}

function buildCodexPrompt(input: WorkerInput): string {
  const parts: string[] = [];
  parts.push(input.prompt.trim());
  parts.push("");
  parts.push("Constraints:");
  parts.push(
    `- You may ONLY modify files matching: ${input.safetyPolicy.allowedPaths.join(", ") || "(any)"}`,
  );
  parts.push(`- Avoid these operations unless absolutely necessary: ${input.safetyPolicy.approvalRequiredFor.join(", ") || "(none)"}`);
  parts.push("- Do not invoke other AI agents.");
  parts.push("- Do not run destructive shell commands.");
  parts.push("- Add or update tests when changing logic.");
  parts.push("");
  for (const a of input.artifacts) {
    parts.push(`# Artifact: ${a.name}${a.description ? ` — ${a.description}` : ""}`);
    if (a.path) parts.push(`(path: ${a.path})`);
    if (a.content) {
      parts.push("```");
      parts.push(a.content);
      parts.push("```");
    }
    parts.push("");
  }
  return parts.join("\n");
}
