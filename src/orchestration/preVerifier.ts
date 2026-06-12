import { spawn } from "node:child_process";
import { writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { redact, redactedTail } from "../utils/redact.js";
import type { ChangedFile } from "./types.js";

/**
 * Decide which install command to run, if any, based on:
 *   - which package manifest files are in the diff
 *   - which lockfiles exist on disk
 *   - the user's autoInstall mode
 *
 * Returns null when no install should run.
 */
export interface PreVerifierDecision {
  command: string;
  reason: string;
}

const NPM_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json"]);
const YARN_FILES = new Set(["package.json", "yarn.lock"]);
const PNPM_FILES = new Set(["package.json", "pnpm-lock.yaml"]);

export async function decidePreVerifier(args: {
  cwd: string;
  changedFiles: ChangedFile[];
  mode: "if-changed" | "always" | "off";
  installCommand: string;
}): Promise<PreVerifierDecision | null> {
  if (args.mode === "off") return null;

  const changedSet = new Set(args.changedFiles.map((c) => path.basename(c.path)));

  if (args.mode === "if-changed") {
    const anyManifest =
      changedSet.has("package.json") ||
      changedSet.has("package-lock.json") ||
      changedSet.has("yarn.lock") ||
      changedSet.has("pnpm-lock.yaml") ||
      changedSet.has("npm-shrinkwrap.json");
    if (!anyManifest) return null;
  }

  let command = args.installCommand;
  if (command === "auto") {
    command = await pickInstallCommand(args.cwd);
  }

  return { command, reason: `manifests changed: ${[...changedSet].filter((f) => NPM_FILES.has(f) || YARN_FILES.has(f) || PNPM_FILES.has(f)).join(", ") || "auto-install always"}` };
}

async function pickInstallCommand(cwd: string): Promise<string> {
  const has = async (rel: string) => {
    try {
      await stat(path.join(cwd, rel));
      return true;
    } catch {
      return false;
    }
  };
  if (await has("pnpm-lock.yaml")) return "pnpm install --no-frozen-lockfile";
  if (await has("yarn.lock")) return "yarn install --no-immutable";
  // Default: npm install. Use --no-audit/--no-fund to keep stdout small.
  return "npm install --no-audit --no-fund";
}

/** Run the install command, capturing logs to disk (redacted). */
export async function runPreVerifier(args: {
  command: string;
  cwd: string;
  logsDir: string;
  timeoutMs: number;
  round?: number;
}): Promise<{
  ok: boolean;
  exitCode: number;
  durationMs: number;
  command: string;
  stdoutPath: string;
  stderrPath: string;
  truncatedTail: string;
  timedOut: boolean;
}> {
  const start = Date.now();
  const tag = `preverifier${args.round !== undefined ? `.r${args.round}` : ""}`;

  return await new Promise((resolve) => {
    const proc = spawn(args.command, {
      cwd: args.cwd,
      shell: true, // mirrors verifier.ts; trusted config
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
    }, args.timeoutMs);
    timer.unref();

    proc.on("error", () => done(127));
    proc.on("close", (code) => done(code ?? 0));

    async function done(code: number) {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const stdoutPath = path.join(args.logsDir, `${tag}.stdout.log`);
      const stderrPath = path.join(args.logsDir, `${tag}.stderr.log`);
      await Promise.all([
        writeFile(stdoutPath, redact(stdout), "utf8"),
        writeFile(stderrPath, redact(stderr), "utf8"),
      ]);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: timedOut ? 124 : code,
        durationMs,
        command: args.command,
        stdoutPath,
        stderrPath,
        truncatedTail: redactedTail((stderr || stdout).trim(), 1500),
        timedOut,
      });
    }
  });
}
