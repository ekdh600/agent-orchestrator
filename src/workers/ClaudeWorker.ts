import { extractJson } from "../utils/jsonExtract.js";
import { redact } from "../utils/redact.js";
import { runSubprocess } from "./spawnUtil.js";
import type { Worker, WorkerInput, WorkerResult } from "./Worker.js";

export interface ClaudeWorkerOptions {
  enabled: boolean;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Wraps the `claude` CLI (Claude Code) in non-interactive print mode.
 * Default args are `["-p"]` so the prompt text is read from stdin and
 * the response is printed to stdout.
 */
export class ClaudeWorker implements Worker {
  readonly name = "claude";
  readonly enabled: boolean;

  constructor(private readonly opts: ClaudeWorkerOptions) {
    this.enabled = opts.enabled;
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    const fullPrompt = buildClaudePrompt(input);
    const res = await runSubprocess({
      command: this.opts.command,
      args: input.model ? [...this.opts.args, "--model", input.model] : this.opts.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutSeconds * 1000,
      stdin: fullPrompt,
      env: { ...this.opts.env, ...input.env },
      logDir: input.logDir,
      logTag: input.tag ?? `claude.${input.role}`,
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

function buildClaudePrompt(input: WorkerInput): string {
  const parts: string[] = [];
  parts.push(input.prompt.trim());
  parts.push("");
  parts.push("---");
  parts.push("Working directory:");
  parts.push(input.cwd);
  parts.push("");
  parts.push("Safety policy (must respect):");
  parts.push(`- Allowed paths: ${input.safetyPolicy.allowedPaths.join(", ") || "(any)"}`);
  parts.push(
    `- Operations requiring approval: ${input.safetyPolicy.approvalRequiredFor.join(", ") || "(none)"}`,
  );
  parts.push(
    `- Forbidden actions: ${(input.safetyPolicy.forbiddenActions ?? []).join(", ") || "(none)"}`,
  );
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
