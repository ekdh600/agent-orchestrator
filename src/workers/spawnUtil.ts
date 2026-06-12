import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { redact } from "../utils/redact.js";

export interface RunSubprocessOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Optional string written to the child's stdin. */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /** Where to write raw and redacted logs. */
  logDir: string;
  logTag: string;
}

export interface RunSubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  rawStdoutPath: string;
  rawStderrPath: string;
}

/**
 * Spawn a child process WITHOUT a shell. Captures stdout/stderr, enforces a
 * timeout via SIGKILL after SIGTERM, and saves redacted logs to disk.
 */
export async function runSubprocess(opts: RunSubprocessOptions): Promise<RunSubprocessResult> {
  const start = Date.now();

  const spawnOpts: SpawnOptionsWithoutStdio = {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    // shell:false is the default; we are explicit because untrusted strings
    // can otherwise be interpreted by the shell.
    shell: false,
  };

  const proc = spawn(opts.command, opts.args, spawnOpts);

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (d) => (stdout += d.toString()));
  proc.stderr?.on("data", (d) => (stderr += d.toString()));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 2000).unref();
  }, opts.timeoutMs);
  timer.unref();

  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.end(opts.stdin);
  } else if (proc.stdin) {
    proc.stdin.end();
  }

  const exitCode: number = await new Promise((resolve) => {
    proc.on("error", () => resolve(127));
    proc.on("close", (code) => resolve(code ?? 0));
  });
  clearTimeout(timer);

  const durationMs = Date.now() - start;

  const rawStdoutPath = path.join(opts.logDir, `${opts.logTag}.stdout.log`);
  const rawStderrPath = path.join(opts.logDir, `${opts.logTag}.stderr.log`);
  await Promise.all([
    writeFile(rawStdoutPath, redact(stdout), "utf8"),
    writeFile(rawStderrPath, redact(stderr), "utf8"),
  ]);

  return { exitCode, stdout, stderr, durationMs, timedOut, rawStdoutPath, rawStderrPath };
}
