import type { Backlog, BacklogTask } from "./types.js";

/**
 * Pick the next task to run.
 *
 * Rules:
 *   - status must be "pending" or "ready"
 *   - all deps must be in "done"
 *   - if no candidates, returns null (caller decides whether to stop)
 *   - among candidates, prefer the lowest id (preserves the decomposer's order)
 */
export function pickNextTask(backlog: Backlog): BacklogTask | null {
  const doneIds = new Set(backlog.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const candidates = backlog.tasks.filter((t) => {
    if (t.status !== "pending" && t.status !== "ready") return false;
    return t.depends_on.every((dep) => doneIds.has(dep));
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return candidates[0]!;
}

/**
 * Glob → literal path prefix (everything before the first wildcard segment).
 * "src/auth/**" → "src/auth/", "src/*.ts" → "src/", "**" → "".
 */
function globPrefix(glob: string): string {
  const wildcard = glob.search(/[*?[]/);
  const literal = wildcard === -1 ? glob : glob.slice(0, wildcard);
  // Cut back to the last full segment so "src/au" (from "src/au*") doesn't
  // falsely diverge from "src/auth/".
  const lastSlash = literal.lastIndexOf("/");
  return lastSlash === -1 ? "" : literal.slice(0, lastSlash + 1);
}

/**
 * Conservative overlap check between two tasks' allowed_paths.
 * Unknown scope (no allowed_paths) overlaps everything. Two globs overlap
 * when one's literal prefix contains the other's.
 */
export function pathSetsOverlap(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || a.length === 0 || !b || b.length === 0) return true;
  for (const ga of a) {
    for (const gb of b) {
      const pa = globPrefix(ga);
      const pb = globPrefix(gb);
      if (pa.startsWith(pb) || pb.startsWith(pa)) return true;
    }
  }
  return false;
}

/**
 * Pick up to `limit` tasks that can run CONCURRENTLY:
 *   - same eligibility rules as pickNextTask (pending/ready, deps done)
 *   - none may overlap (by allowed_paths) with a running task or with each other
 *   - a task without allowed_paths can only run alone (its scope is unknown)
 *   - ids in `exclusive` are forced to run alone (e.g. after a merge conflict)
 */
export function pickReadyTasks(
  backlog: Backlog,
  limit: number,
  running: BacklogTask[] = [],
  exclusive: ReadonlySet<string> = new Set(),
): BacklogTask[] {
  const doneIds = new Set(backlog.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const runningIds = new Set(running.map((t) => t.id));
  const candidates = backlog.tasks
    .filter((t) => {
      if (t.status !== "pending" && t.status !== "ready") return false;
      if (runningIds.has(t.id)) return false;
      return t.depends_on.every((dep) => doneIds.has(dep));
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const scopeOf = (t: BacklogTask): string[] | undefined => (exclusive.has(t.id) ? undefined : t.allowed_paths);

  const selected: BacklogTask[] = [];
  const active = [...running];
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (active.some((other) => pathSetsOverlap(scopeOf(candidate), scopeOf(other)))) continue;
    selected.push(candidate);
    active.push(candidate);
  }
  return selected;
}

/**
 * After a task ends, reconcile the backlog:
 *   - Mark the task with the new status
 *   - For tasks whose deps include any task that's now blocked or failed
 *     terminally, mark them as blocked (they can't make progress).
 *
 * Returns a new Backlog object — does not mutate input.
 */
export function applyTaskOutcome(
  backlog: Backlog,
  taskId: string,
  outcome: "done" | "failed" | "blocked" | "needs_approval",
  attempts: number,
  meta: { runId?: string; runStatus?: string; error?: string },
): Backlog {
  const tasks = backlog.tasks.map((t) => {
    if (t.id === taskId) {
      return {
        ...t,
        status: outcome,
        attempts,
        ...(meta.runId !== undefined ? { lastRunId: meta.runId } : {}),
        ...(meta.runStatus !== undefined ? { lastRunStatus: meta.runStatus } : {}),
        ...(meta.error !== undefined ? { lastError: meta.error } : {}),
      };
    }
    return t;
  });

  // Iterate to a fixed point so blocking propagates through chains
  // (e.g. T01 fails → T02 blocked → T03 blocked transitively).
  let propagated = tasks;
  for (let i = 0; i < propagated.length + 1; i++) {
    const terminallyBad = new Set(
      propagated
        .filter((t) => t.status === "failed" || t.status === "blocked" || t.status === "needs_approval")
        .map((t) => t.id),
    );
    let changed = false;
    propagated = propagated.map((t) => {
      if (t.status === "pending" || t.status === "ready") {
        const blockedByDep = t.depends_on.some((d) => terminallyBad.has(d));
        if (blockedByDep) {
          changed = true;
          return { ...t, status: "blocked" as const };
        }
      }
      // Un-block tasks whose blocking dep has since recovered (e.g. a failed
      // dep was requeued for retry, or got replanned away).
      if (t.status === "blocked" && !t.depends_on.some((d) => terminallyBad.has(d))) {
        changed = true;
        return { ...t, status: "pending" as const };
      }
      return t;
    });
    if (!changed) break;
  }

  return { tasks: propagated };
}

export interface BacklogProgress {
  total: number;
  done: number;
  failed: number;
  blocked: number;
  needsApproval: number;
  superseded: number;
  remaining: number;
}

export function backlogProgress(backlog: Backlog): BacklogProgress {
  const total = backlog.tasks.length;
  let done = 0;
  let failed = 0;
  let blocked = 0;
  let needsApproval = 0;
  let superseded = 0;
  for (const t of backlog.tasks) {
    if (t.status === "done") done++;
    else if (t.status === "failed") failed++;
    else if (t.status === "blocked") blocked++;
    else if (t.status === "needs_approval") needsApproval++;
    else if (t.status === "superseded") superseded++;
  }
  const remaining = total - done - failed - blocked - needsApproval - superseded;
  return { total, done, failed, blocked, needsApproval, superseded, remaining };
}
