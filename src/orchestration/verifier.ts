import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { redact, redactedTail } from "../utils/redact.js";
import type { VerifierCommandResult, VerifierReport } from "./types.js";
import { shellCommandIsDenied } from "./safety.js";

export interface RunVerifierOptions {
  commands: string[];
  cwd: string;
  logsDir: string;
  timeoutMs: number;
  denyShellPatterns: string[];
  /** If provided, the round number is included in the log filenames. */
  round?: number;
}

/**
 * Run all verifier commands sequentially. Each command is executed via the
 * user's shell so pipes/aliases work, but it is checked against the deny list
 * BEFORE execution. Continues on individual failure but records each result.
 */
export async function runVerifier(opts: RunVerifierOptions): Promise<VerifierReport> {
  const results: VerifierCommandResult[] = [];
  for (const [i, cmd] of opts.commands.entries()) {
    const denied = shellCommandIsDenied(cmd, opts.denyShellPatterns);
    if (denied) {
      const tag = makeTag(opts.round, i, cmd);
      const stdoutPath = path.join(opts.logsDir, `verifier.${tag}.stdout.log`);
      const stderrPath = path.join(opts.logsDir, `verifier.${tag}.stderr.log`);
      const note = `[blocked] verifier command matched deny pattern "${denied}"\n`;
      await Promise.all([writeFile(stdoutPath, "", "utf8"), writeFile(stderrPath, note, "utf8")]);
      results.push({
        command: cmd,
        exitCode: 126,
        durationMs: 0,
        stdoutPath,
        stderrPath,
        ok: false,
        truncatedTail: note,
      });
      continue;
    }
    results.push(await runOneCommand(cmd, i, opts));
  }
  return { passed: results.length > 0 && results.every((r) => r.ok), results };
}

async function runOneCommand(
  command: string,
  index: number,
  opts: RunVerifierOptions,
): Promise<VerifierCommandResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    // We use shell:true here intentionally: verifier commands come from the
    // user's config (e.g. "npm test && npm run lint") and are trusted strings
    // already passed through the deny-list check.
    const proc = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 2000).unref();
    }, opts.timeoutMs);
    timer.unref();

    proc.on("error", () => finish(127));
    proc.on("close", (code) => finish(code ?? 0));

    async function finish(code: number) {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const tag = makeTag(opts.round, index, command);
      const stdoutPath = path.join(opts.logsDir, `verifier.${tag}.stdout.log`);
      const stderrPath = path.join(opts.logsDir, `verifier.${tag}.stderr.log`);
      await Promise.all([
        writeFile(stdoutPath, redact(stdout), "utf8"),
        writeFile(stderrPath, redact(stderr), "utf8"),
      ]);
      const ok = !timedOut && code === 0;
      const tail = redactedTail((stderr || stdout).trim(), 1500);
      resolve({
        command,
        exitCode: timedOut ? 124 : code,
        durationMs,
        stdoutPath,
        stderrPath,
        ok,
        truncatedTail: tail,
      });
    }
  });
}

function makeTag(round: number | undefined, index: number, command: string): string {
  const slug = command
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "cmd";
  const r = round !== undefined ? `r${round}.` : "";
  return `${r}${index}.${slug}`;
}
