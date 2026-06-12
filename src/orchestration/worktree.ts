import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { runGit } from "./git.js";

/**
 * Git-worktree isolation for parallel task execution.
 *
 * Each parallel task runs in its own worktree (branched from the current
 * HEAD) so concurrent implementers can't trample each other's working tree.
 * On success the task's branch is merged back with --no-ff; a merge conflict
 * fails the task (the caller requeues it for a solo retry against the
 * updated HEAD). Worktrees live under <repoRoot>/.orchestrator/worktrees/.
 */

export interface TaskWorktree {
  taskId: string;
  dir: string;
  branch: string;
}

export class WorktreeError extends Error {}

const WORKTREES_SUBDIR = path.join(".orchestrator", "worktrees");

export async function isGitRepo(repoRoot: string): Promise<boolean> {
  return (await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"])).code === 0;
}

export async function createTaskWorktree(repoRoot: string, taskId: string, attempt: number): Promise<TaskWorktree> {
  const slug = taskId.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const branch = `orch/task/${slug}-a${attempt}`;
  const dir = path.join(repoRoot, WORKTREES_SUBDIR, `${slug}-a${attempt}`);

  // .orchestrator/ lives inside the repo — self-ignore it so nested worktrees
  // never show up in the base checkout's status/diff.
  const orchestratorDir = path.join(repoRoot, ".orchestrator");
  await mkdir(orchestratorDir, { recursive: true });
  await writeFile(path.join(orchestratorDir, ".gitignore"), "*\n", "utf8");

  // A stale branch/worktree from a crashed run would block creation — clear it.
  await runGit(repoRoot, ["worktree", "remove", "--force", dir]);
  await runGit(repoRoot, ["branch", "-D", branch]);

  const add = await runGit(repoRoot, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  if (add.code !== 0) {
    throw new WorktreeError(`git worktree add failed for ${taskId}: ${add.stderr.trim() || add.stdout.trim()}`);
  }
  return { taskId, dir, branch };
}

export interface MergeResult {
  ok: boolean;
  /** True when the merge hit a conflict (merge was aborted, base untouched). */
  conflict?: boolean;
  /** True when the worktree had no changes to merge. */
  noChanges?: boolean;
  commit?: string;
  error?: string;
}

/**
 * Commit everything in the worktree on its branch, then merge the branch into
 * the base checkout with --no-ff. On conflict the merge is aborted so the
 * base tree stays clean.
 */
export async function mergeTaskWorktree(repoRoot: string, wt: TaskWorktree, message: string): Promise<MergeResult> {
  const status = await runGit(wt.dir, ["status", "--porcelain=v1"]);
  if (status.code !== 0) return { ok: false, error: status.stderr.trim() };

  if (status.stdout.trim() !== "") {
    const add = await runGit(wt.dir, ["add", "-A"]);
    if (add.code !== 0) return { ok: false, error: add.stderr.trim() || "git add failed" };
    const commit = await runGit(wt.dir, ["commit", "-q", "--no-verify", "-m", message]);
    if (commit.code !== 0) return { ok: false, error: commit.stderr.trim() || "git commit failed" };
  } else {
    // Nothing changed in the worktree — nothing to merge.
    const branchHead = await runGit(wt.dir, ["rev-parse", "HEAD"]);
    const baseHead = await runGit(repoRoot, ["rev-parse", "HEAD"]);
    if (branchHead.stdout.trim() === baseHead.stdout.trim()) {
      return { ok: true, noChanges: true };
    }
  }

  const merge = await runGit(repoRoot, ["merge", "--no-ff", "--no-edit", "--no-verify", "-q", wt.branch]);
  if (merge.code !== 0) {
    await runGit(repoRoot, ["merge", "--abort"]);
    const conflicted = /conflict/i.test(merge.stdout + merge.stderr);
    return {
      ok: false,
      conflict: conflicted,
      error: (merge.stderr.trim() || merge.stdout.trim()).slice(0, 500),
    };
  }
  const head = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  return { ok: true, commit: head.stdout.trim() };
}

export async function removeTaskWorktree(repoRoot: string, wt: TaskWorktree): Promise<void> {
  const removed = await runGit(repoRoot, ["worktree", "remove", "--force", wt.dir]);
  if (removed.code !== 0) {
    // Fall back to a plain delete + prune so a stuck worktree can't wedge the loop.
    await rm(wt.dir, { recursive: true, force: true }).catch(() => undefined);
    await runGit(repoRoot, ["worktree", "prune"]);
  }
  await runGit(repoRoot, ["branch", "-D", wt.branch]);
}

/** Clean up leftovers from crashed runs. Called once at project start. */
export async function pruneTaskWorktrees(repoRoot: string): Promise<void> {
  await runGit(repoRoot, ["worktree", "prune"]);
}
