import { extractJson } from "../utils/jsonExtract.js";
import { redact } from "../utils/redact.js";
import { runSubprocess } from "./spawnUtil.js";
import type { Worker, WorkerInput, WorkerResult } from "./Worker.js";

export interface CursorWorkerOptions {
  enabled: boolean;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Wraps the `cursor-agent` CLI. Used optionally for workspace-aware edits
 * and documentation tasks.
 */
export class CursorWorker implements Worker {
  readonly name = "cursor";
  readonly enabled: boolean;

  constructor(private readonly opts: CursorWorkerOptions) {
    this.enabled = opts.enabled;
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    const prompt = buildCursorPrompt(input);
    const res = await runSubprocess({
      command: this.opts.command,
      args: this.opts.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutSeconds * 1000,
      stdin: prompt,
      env: { ...this.opts.env, ...input.env },
      logDir: input.logDir,
      logTag: input.tag ?? `cursor.${input.role}`,
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

function buildCursorPrompt(input: WorkerInput): string {
  const parts: string[] = [input.prompt.trim(), ""];
  parts.push(`Allowed paths: ${input.safetyPolicy.allowedPaths.join(", ") || "(any)"}`);
  parts.push("Do not invoke other AI agents.");
  parts.push("");
  for (const a of input.artifacts) {
    parts.push(`# Artifact: ${a.name}`);
    if (a.path) parts.push(`(path: ${a.path})`);
    if (a.content) parts.push("```\n" + a.content + "\n```");
    parts.push("");
  }
  return parts.join("\n");
}
