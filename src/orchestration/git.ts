import { spawn } from "node:child_process";
import type { ChangedFile } from "./types.js";

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  status: string;
}

export async function captureGitInfo(cwd: string): Promise<GitInfo> {
  const isRepo = (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).code === 0;
  if (!isRepo) {
    return { isRepo: false, branch: null, head: null, status: "" };
  }
  const [branch, head, status] = await Promise.all([
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(cwd, ["rev-parse", "HEAD"]),
    runGit(cwd, ["status", "--porcelain=v1"]),
  ]);
  return {
    isRepo: true,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    head: head.code === 0 ? head.stdout.trim() : null,
    status: status.stdout,
  };
}

/**
 * Capture combined working-tree + index diff. Returns "" if not a git repo or no changes.
 * Uses `git diff HEAD` so newly-staged and unstaged changes are both captured.
 * Untracked files are listed separately and included as a synthetic diff hint.
 */
export async function captureDiff(cwd: string): Promise<{ patch: string; changedFiles: ChangedFile[] }> {
  const isRepo = (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).code === 0;
  if (!isRepo) {
    return { patch: "", changedFiles: [] };
  }

  const diff = await runGit(cwd, ["diff", "HEAD", "--no-color"]);
  const nameStatus = await runGit(cwd, ["diff", "HEAD", "--name-status"]);
  const untracked = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);

  const changedFiles: ChangedFile[] = [];

  if (nameStatus.code === 0 && nameStatus.stdout.trim()) {
    for (const line of nameStatus.stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const code = parts[0]!.trim();
      const tail = parts.slice(1);
      const file = tail[tail.length - 1] ?? "";
      if (!file) continue;
      changedFiles.push({ path: file, status: mapGitStatus(code) });
    }
  }

  if (untracked.code === 0 && untracked.stdout.trim()) {
    for (const file of untracked.stdout.split("\n")) {
      const trimmed = file.trim();
      if (!trimmed) continue;
      changedFiles.push({ path: trimmed, status: "added" });
    }
  }

  let patch = diff.code === 0 ? diff.stdout : "";
  if (untracked.code === 0 && untracked.stdout.trim()) {
    patch += "\n# Untracked files (not yet added):\n";
    for (const f of untracked.stdout.split("\n")) {
      if (f.trim()) patch += `# + ${f.trim()}\n`;
    }
  }

  return { patch, changedFiles };
}

/**
 * Stage every change and create a commit. Used between tasks in the project
 * builder so each task's working diff only contains that task's changes.
 *
 * Returns:
 *   - { ok: true,  commit: <sha>, message } on a successful commit
 *   - { ok: true,  noChanges: true }        when the working tree was clean
 *   - { ok: false, error: <stderr> }        if git commit failed
 */
export async function commitWorkingTree(cwd: string, message: string): Promise<{
  ok: boolean;
  commit?: string;
  noChanges?: boolean;
  error?: string;
  message: string;
}> {
  const isRepo = (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).code === 0;
  if (!isRepo) return { ok: false, error: "not a git repository", message };

  const status = await runGit(cwd, ["status", "--porcelain=v1"]);
  if (status.code !== 0) return { ok: false, error: status.stderr.trim(), message };
  if (status.stdout.trim() === "") return { ok: true, noChanges: true, message };

  const add = await runGit(cwd, ["add", "-A"]);
  if (add.code !== 0) return { ok: false, error: add.stderr.trim() || "git add failed", message };

  // Use --no-verify so user pre-commit hooks don't block the orchestrator's
  // bookkeeping commits. The orchestrator separately enforces safety.
  const commit = await runGit(cwd, ["commit", "-q", "--no-verify", "-m", message]);
  if (commit.code !== 0) return { ok: false, error: commit.stderr.trim() || "git commit failed", message };

  const head = await runGit(cwd, ["rev-parse", "HEAD"]);
  return { ok: true, commit: head.stdout.trim(), message };
}

function mapGitStatus(code: string): ChangedFile["status"] {
  const c = code[0] ?? "";
  switch (c) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "unknown";
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", () => resolve({ code: 127, stdout, stderr }));
    proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
