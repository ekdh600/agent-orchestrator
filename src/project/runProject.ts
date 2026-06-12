import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { OrchestratorConfig } from "../config/schema.js";
import { resolveStage } from "../orchestration/routing.js";
import {
  createTaskWorktree,
  isGitRepo,
  mergeTaskWorktree,
  pruneTaskWorktrees,
  removeTaskWorktree,
  type TaskWorktree,
} from "../orchestration/worktree.js";
import { runWorkflow, type ProgressEvent } from "../orchestration/runWorkflow.js";
import { clarifySpec, specWithAdoptedAssumptions, type ClarificationResult } from "./clarify.js";
import { applyReplan, failureSignature, lineageRoot, replanProject } from "./replan.js";
import { commitWorkingTree } from "../orchestration/git.js";
import type { RunReport } from "../orchestration/types.js";
import type { Worker, SafetyPolicy } from "../workers/Worker.js";
import { decomposeProject } from "./decompose.js";
import { applyTaskOutcome, backlogProgress, pickNextTask, pickReadyTasks } from "./scheduler.js";
import {
  appendTimeline,
  createProjectDir,
  existingProjectPaths,
  loadBacklog,
  loadState,
  saveBacklog,
  saveReport,
  saveState,
  updateStateAfterTask,
  type ProjectPaths,
} from "./stateStore.js";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_BUDGET,
  DEFAULT_PROJECT_OPTIONS,
  type Backlog,
  type BacklogTask,
  type ProjectBudget,
  type ProjectOptions,
  type ProjectReport,
  type ProjectSpec,
  type ProjectState,
  type ProjectStatus,
  type TaskExecution,
} from "./types.js";

export type ProjectProgressEvent =
  | { kind: "clarifying"; message: string }
  | { kind: "clarified"; questionCount: number }
  | { kind: "decomposing"; message: string }
  | { kind: "decomposed"; taskCount: number }
  | { kind: "replanned"; replanRound: number; newTaskCount: number }
  | { kind: "task_starting"; task: BacklogTask; attempt: number }
  | { kind: "task_finished"; task: BacklogTask; runId: string; status: string; attempt: number }
  | { kind: "stopping"; reason: string }
  | { kind: "completed"; reason: string }
  | ProgressEvent;

export interface RunProjectOptions {
  spec?: ProjectSpec;
  config: OrchestratorConfig;
  workers: { claude: Worker; codex: Worker; cursor?: Worker };
  /** Where the project directory will be created. Defaults to <projectRoot>/projects/. */
  baseProjectsDir?: string;
  budget?: Partial<ProjectBudget>;
  options?: Partial<ProjectOptions>;
  /**
   * Resume an existing project by id. When set, the orchestrator skips
   * decomposition and reads the existing backlog / state / spec from disk,
   * then continues from the next runnable task.
   */
  resumeProjectId?: string;
  now?: () => Date;
  onProgress?: (event: ProjectProgressEvent) => void;
  quiet?: boolean;
}

/**
 * Build a project end-to-end:
 *   spec → decompose → loop { pick → run → reconcile } → report
 *
 * Each task is executed by calling the existing single-task workflow
 * (runWorkflow) as a sub-routine. The orchestrator stays the only invoker —
 * workers can never call each other.
 */
export async function runProject(opts: RunProjectOptions): Promise<ProjectReport> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const budget: ProjectBudget = { ...DEFAULT_BUDGET, ...(opts.budget ?? {}) };
  const options: ProjectOptions = { ...DEFAULT_PROJECT_OPTIONS, ...(opts.options ?? {}) };

  const baseProjectsDir = path.resolve(
    opts.baseProjectsDir ?? path.join(opts.config.projectRoot, "projects"),
  );

  const log = (msg: string) => {
    if (!opts.quiet) console.log(`[project] ${msg}`);
  };
  const emit = (e: ProjectProgressEvent) => {
    try {
      opts.onProgress?.(e);
    } catch {
      // never let an observer crash the loop
    }
  };

  // 1. Resolve paths + spec — either fresh project or resume an existing one.
  let paths: ProjectPaths;
  let resolvedSpec: ProjectSpec;
  const isResume = Boolean(opts.resumeProjectId);

  if (opts.resumeProjectId) {
    paths = existingProjectPaths(baseProjectsDir, opts.resumeProjectId);
    const specBody = await readFile(paths.specFile, "utf8").catch((err) => {
      throw new Error(
        `Cannot resume project ${opts.resumeProjectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    resolvedSpec = opts.spec ?? {
      title: extractMarkdownTitle(specBody),
      body: specBody,
      source: paths.specFile,
    };
    log(`resuming existing project ${opts.resumeProjectId}`);
  } else {
    if (!opts.spec) {
      throw new Error("runProject: either spec or resumeProjectId is required");
    }
    resolvedSpec = opts.spec;
    paths = await createProjectDir(baseProjectsDir, opts.spec, startedAt);
    await writeFile(paths.specFile, opts.spec.body, "utf8");
  }

  await appendTimeline(paths, {
    kind: "project_started",
    ts: now().toISOString(),
    spec_title: resolvedSpec.title,
    budget,
  });

  const safetyPolicy: SafetyPolicy = {
    allowedPaths: opts.config.safety.allowedPaths,
    approvalRequiredFor: opts.config.safety.approvalRequiredFor,
    denyShellPatterns: opts.config.safety.denyShellPatterns,
    forbiddenActions: ["invoke_other_agent", "destructive_shell"],
  };

  // Clarify / decompose / replan are all project-level planning — they share
  // the "decompose" stage route.
  const planningRoute = resolveStage({
    stage: "decompose",
    config: opts.config,
    workers: { claude: opts.workers.claude, codex: opts.workers.codex, cursor: opts.workers.cursor },
  });

  // 1.5 Interview gate (fresh projects only — a resumed spec was already
  // clarified or hand-edited).
  if (!isResume && opts.config.project.interview !== "off") {
    emit({ kind: "clarifying", message: "interviewing spec for ambiguities" });
    const clarification = await clarifySpec({
      spec: resolvedSpec,
      config: opts.config,
      safetyPolicy,
      worker: planningRoute.worker,
      model: planningRoute.model,
      logDir: paths.projectDir,
      log,
    });
    await writeFile(
      path.join(paths.projectDir, "clarification.json"),
      JSON.stringify(clarification, null, 2) + "\n",
      "utf8",
    );
    await appendTimeline(paths, {
      kind: "clarified",
      ts: now().toISOString(),
      question_count: clarification.questions.length,
    });
    emit({ kind: "clarified", questionCount: clarification.questions.length });

    if (clarification.questions.length > 0) {
      if (opts.config.project.interview === "required") {
        log(`spec needs clarification — ${clarification.questions.length} question(s); stopping`);
        await appendTimeline(paths, {
          kind: "needs_clarification",
          ts: now().toISOString(),
          question_count: clarification.questions.length,
        });
        return needsClarificationReport({
          paths,
          spec: resolvedSpec,
          config: opts.config,
          budget,
          clarification,
          startedAt,
          finishedAt: now(),
        });
      }
      // interview === "auto": adopt defaults, record them in the spec.
      resolvedSpec = specWithAdoptedAssumptions(resolvedSpec, clarification);
      await writeFile(paths.specFile, resolvedSpec.body, "utf8");
      await appendTimeline(paths, {
        kind: "assumptions_adopted",
        ts: now().toISOString(),
        count: clarification.questions.length + clarification.assumptions.length,
      });
      log(`adopted ${clarification.questions.length} default assumption(s) — see "Assumptions (auto-adopted)" in spec.md`);
    }
  }

  // 2. Decompose (or load existing backlog if resuming)
  let decomposition: Awaited<ReturnType<typeof decomposeProject>>;
  let backlog: Backlog;
  let state: ProjectState;

  if (isResume) {
    const decompRaw = await readFile(paths.decompositionFile, "utf8");
    decomposition = JSON.parse(decompRaw);
    const loadedBacklog = await loadBacklog(paths);
    // On resume:
    //  - any "running" task → "pending" (was mid-flight when the prior run stopped)
    //  - any "failed" task → "pending" with attempts reset to 0 (user is asking
    //    for a fresh retry). If the user doesn't want this, they can edit
    //    backlog.json manually before resuming.
    //  - "blocked" tasks are unblocked so the scheduler re-evaluates dependencies.
    backlog = {
      tasks: loadedBacklog.tasks.map((t) => {
        if (t.status === "running") return { ...t, status: "pending" as const };
        if (t.status === "failed") return { ...t, status: "pending" as const, attempts: 0 };
        if (t.status === "blocked") return { ...t, status: "pending" as const };
        return t;
      }),
    };
    await saveBacklog(paths, backlog);
    state = await loadState(paths).catch(() => ({
      summary: `Resumed project: ${resolvedSpec.title}`,
      knownFiles: [],
      blockers: [],
      taskNotes: {},
    }));
    log(`resumed: ${countByStatus(backlog)}`);
    emit({ kind: "decomposed", taskCount: backlog.tasks.length });
  } else {
    emit({ kind: "decomposing", message: "asking decomposer for backlog" });
    decomposition = await decomposeProject({
      spec: resolvedSpec,
      config: opts.config,
      safetyPolicy,
      workers: { claude: planningRoute.worker },
      model: planningRoute.model,
      logDir: paths.projectDir,
      log,
    });
    await writeFile(paths.decompositionFile, JSON.stringify(decomposition, null, 2) + "\n", "utf8");
    await appendTimeline(paths, {
      kind: "decomposed",
      ts: now().toISOString(),
      task_count: decomposition.tasks.length,
    });
    emit({ kind: "decomposed", taskCount: decomposition.tasks.length });
    log(`decomposed into ${decomposition.tasks.length} task(s)`);

    backlog = { tasks: decomposition.tasks.map((t) => ({ ...t })) };
    await saveBacklog(paths, backlog);

    state = {
      summary: `Project: ${resolvedSpec.title}`,
      knownFiles: [],
      blockers: [],
      taskNotes: {},
    };
    await saveState(paths, state);
  }

  // 3. Main loop -----------------------------------------------------------
  const executions: TaskExecution[] = [];
  let consecutiveFailures = 0;
  let stopReason = "";
  let status: ProjectStatus = "completed";
  let replanCount = 0;
  const maxParallel = opts.config.project.maxParallelTasks;
  // Stall detection: lineage root → failure signatures seen. A lineage whose
  // replacement fails with an already-seen signature is never replanned again.
  const lineageSignatures = new Map<string, Set<string>>();
  const stalledLineages = new Set<string>();

  const maybeReplan = async (): Promise<boolean> => {
    if (replanCount >= opts.config.project.maxReplans) return false;
    const eligible = backlog.tasks.filter(
      (t) =>
        (t.status === "failed" || t.status === "blocked") &&
        // needs_approval is excluded by status; also exclude stalled lineages.
        !stalledLineages.has(lineageRoot(t, backlog)),
    );
    if (eligible.length === 0) return false;

    replanCount++;
    const result = await replanProject({
      spec: resolvedSpec,
      backlog,
      failedTasks: eligible,
      executions,
      replanRound: replanCount,
      config: opts.config,
      safetyPolicy,
      worker: planningRoute.worker,
      model: planningRoute.model,
      logDir: paths.projectDir,
      log,
    });
    await writeFile(
      path.join(paths.projectDir, `replan.${replanCount}.json`),
      JSON.stringify(result, null, 2) + "\n",
      "utf8",
    );
    if (result.tasks.length === 0) {
      log(`replan ${replanCount}: replanner produced no replacements — stopping normally`);
      return false;
    }
    backlog = applyReplan(backlog, result.tasks);
    await saveBacklog(paths, backlog);
    consecutiveFailures = 0;
    await appendTimeline(paths, {
      kind: "replan",
      ts: now().toISOString(),
      details: `round ${replanCount}: ${result.tasks.length} replacement task(s) [${result.tasks.map((t) => t.id).join(", ")}] — ${result.notes}`,
    });
    emit({ kind: "replanned", replanRound: replanCount, newTaskCount: result.tasks.length });
    log(`replan ${replanCount}: ${result.tasks.length} replacement task(s) appended`);
    return true;
  };

  const runSequentialLoop = async (): Promise<void> => {
  for (let i = 0; ; i++) {
    if (i >= budget.maxTasks) {
      stopReason = `task budget exhausted (maxTasks=${budget.maxTasks})`;
      status = "stopped_budget";
      await appendTimeline(paths, {
        kind: "budget_exhausted",
        ts: now().toISOString(),
        reason: stopReason,
      });
      log(stopReason);
      emit({ kind: "stopping", reason: stopReason });
      break;
    }
    const elapsed = (now().getTime() - startedAt.getTime()) / 1000;
    if (elapsed > budget.maxWallClockSeconds) {
      stopReason = `wall-clock budget exhausted (${Math.round(elapsed)}s > ${budget.maxWallClockSeconds}s)`;
      status = "stopped_budget";
      await appendTimeline(paths, {
        kind: "budget_exhausted",
        ts: now().toISOString(),
        reason: stopReason,
      });
      log(stopReason);
      emit({ kind: "stopping", reason: stopReason });
      break;
    }
    if (consecutiveFailures >= budget.maxConsecutiveFailures) {
      if (await maybeReplan()) continue;
      stopReason = `${consecutiveFailures} consecutive failures — bailing out`;
      status = "stopped_failures";
      log(stopReason);
      emit({ kind: "stopping", reason: stopReason });
      break;
    }

    const task = pickNextTask(backlog);
    if (!task) {
      const progress = backlogProgress(backlog);
      if ((progress.failed > 0 || progress.blocked > 0) && (await maybeReplan())) continue;
      if (progress.remaining === 0 && progress.failed === 0 && progress.blocked === 0 && progress.needsApproval === 0) {
        stopReason = "all tasks completed";
        status = "completed";
      } else if (progress.needsApproval > 0) {
        stopReason = `${progress.needsApproval} task(s) need human approval`;
        status = "stopped_approval";
      } else if (progress.blocked > 0 || progress.failed > 0) {
        stopReason = `${progress.blocked} blocked / ${progress.failed} failed — no executable task remains`;
        status = "stopped_blocked";
      } else {
        stopReason = "no runnable task available";
        status = "stopped_blocked";
      }
      log(stopReason);
      emit({ kind: "completed", reason: stopReason });
      break;
    }

    const attempt = task.attempts + 1;
    if (attempt > budget.maxAttemptsPerTask) {
      backlog = applyTaskOutcome(backlog, task.id, "failed", task.attempts, {
        error: `exceeded maxAttemptsPerTask (${budget.maxAttemptsPerTask})`,
      });
      await saveBacklog(paths, backlog);
      consecutiveFailures++;
      await appendTimeline(paths, {
        kind: "task_failed",
        ts: now().toISOString(),
        task_id: task.id,
        reason: "max attempts exceeded",
      });
      continue;
    }

    emit({ kind: "task_starting", task, attempt });
    await appendTimeline(paths, {
      kind: "task_picked",
      ts: now().toISOString(),
      task_id: task.id,
      attempt,
    });

    const taskMd = renderTaskBriefing(task, resolvedSpec, decomposition.summary, decomposition.definitionOfDone, state, executions);

    // Merge per-task acks with project-wide acks. The project-wide list is a
    // user-level escape hatch; the per-task list is what the decomposer
    // pre-declared.
    const mergedAcks = Array.from(
      new Set([...(task.acknowledged_risks ?? []), ...options.acknowledgedRisks]),
    );

    let report: RunReport;
    try {
      report = await runWorkflow({
        config: maybeOverrideAllowedPaths(opts.config, task.allowed_paths),
        taskText: taskMd,
        workers: opts.workers,
        baseRunsDir: paths.tasksDir,
        // Anything inside the project's working directory is orchestrator
        // book-keeping, not a user change. Exclude it from risk detection.
        extraIgnorePrefixes: [paths.projectDir],
        acknowledgedRisks: mergedAcks,
        category: task.category,
        quiet: opts.quiet,
        onProgress: (e) => emit(e),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      backlog = applyTaskOutcome(backlog, task.id, "failed", attempt, { error: reason });
      await saveBacklog(paths, backlog);
      await appendTimeline(paths, {
        kind: "task_failed",
        ts: now().toISOString(),
        task_id: task.id,
        reason,
      });
      consecutiveFailures++;
      continue;
    }

    const taskExec: TaskExecution = {
      taskId: task.id,
      attempt,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      runId: report.runId,
      runDir: report.runDir,
      status: report.status,
      changedFiles: (report.rounds[report.rounds.length - 1]?.diff.changedFiles ?? []).map((c) => c.path),
      durationMs: report.durationMs,
      rounds: report.rounds.length,
    };
    executions.push(taskExec);

    const outcome = mapStatusToOutcome(report.status);
    backlog = applyTaskOutcome(backlog, task.id, outcome, attempt, {
      runId: report.runId,
      runStatus: report.status,
    });
    await saveBacklog(paths, backlog);

    state = updateStateAfterTask(state, { ...task, attempts: attempt, status: outcome }, taskExec);
    await saveState(paths, state);

    await appendTimeline(paths, {
      kind: "task_finished",
      ts: now().toISOString(),
      task_id: task.id,
      run_id: report.runId,
      status: report.status,
      attempt,
    });
    emit({ kind: "task_finished", task, runId: report.runId, status: report.status, attempt });

    if (outcome === "done") {
      consecutiveFailures = 0;
      // Auto-commit so the next task starts from a clean working tree.
      // Without this, files from earlier tasks accumulate in the diff and
      // trip up later tasks' allowed_paths checks.
      if (options.autoCommitBetweenTasks) {
        const msg = `${options.commitMessagePrefix}: ${task.id} ${task.title}`;
        const result = await commitWorkingTree(opts.config.projectRoot, msg);
        if (result.ok && result.commit) {
          log(`auto-committed ${task.id} → ${result.commit.slice(0, 7)}`);
        } else if (result.ok && result.noChanges) {
          // Not necessarily a problem (e.g. verify task), but worth noting.
          log(`auto-commit skipped for ${task.id}: working tree clean`);
        } else {
          log(`auto-commit failed for ${task.id}: ${result.error}`);
        }
      }
    } else {
      consecutiveFailures++;
      // Stall detection bookkeeping: same lineage + same failure signature
      // twice → that lineage is exhausted, no further replans for it.
      const updatedTask = backlog.tasks.find((t) => t.id === task.id);
      if (updatedTask && (outcome === "failed" || outcome === "blocked")) {
        const root = lineageRoot(updatedTask, backlog);
        const sig = failureSignature(updatedTask, executions);
        const seen = lineageSignatures.get(root) ?? new Set<string>();
        if (seen.has(sig)) {
          stalledLineages.add(root);
          log(`lineage ${root} failed twice with signature ${sig} — marked stalled (no further replans)`);
        }
        seen.add(sig);
        lineageSignatures.set(root, seen);
      }
      // If the task is retryable (failed verifier / change request), reset its
      // status to pending so a future iteration can pick it up — but only if
      // we haven't exceeded per-task attempts.
      if (
        attempt < budget.maxAttemptsPerTask &&
        (report.status === "verifier_failed" || report.status === "review_changes_requested")
      ) {
        backlog = {
          tasks: backlog.tasks.map((t) =>
            t.id === task.id ? { ...t, status: "pending" as const } : t,
          ),
        };
        await saveBacklog(paths, backlog);
      }
    }
  }

  };

  const runParallelLoop = async (): Promise<void> => {
    interface TaskCompletion {
      task: BacklogTask;
      attempt: number;
      report: RunReport | null;
      worktree: TaskWorktree | null;
      error?: string;
    }
    const running = new Map<string, { task: BacklogTask; attempt: number; promise: Promise<TaskCompletion> }>();
    // Tasks whose merge conflicted: their retry runs ALONE (exclusive) against
    // the updated HEAD.
    const exclusiveRetries = new Set<string>();
    let tasksLaunched = 0;

    const launch = async (task: BacklogTask, attempt: number): Promise<TaskCompletion> => {
      let worktree: TaskWorktree | null = null;
      try {
        worktree = await createTaskWorktree(opts.config.projectRoot, task.id, attempt);
        const taskMd = renderTaskBriefing(task, resolvedSpec, decomposition.summary, decomposition.definitionOfDone, state, executions);
        const mergedAcks = Array.from(
          new Set([...(task.acknowledged_risks ?? []), ...options.acknowledgedRisks]),
        );
        const report = await runWorkflow({
          // The whole single-task pipeline (diff capture, verifier, safety
          // checks) runs inside the task's own worktree.
          config: { ...maybeOverrideAllowedPaths(opts.config, task.allowed_paths), projectRoot: worktree.dir },
          taskText: taskMd,
          workers: opts.workers,
          baseRunsDir: paths.tasksDir,
          extraIgnorePrefixes: [paths.projectDir],
          acknowledgedRisks: mergedAcks,
          category: task.category,
          quiet: opts.quiet,
          onProgress: (e) => emit(e),
        });
        return { task, attempt, report, worktree };
      } catch (err) {
        return {
          task,
          attempt,
          report: null,
          worktree,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    for (;;) {
      const elapsed = (now().getTime() - startedAt.getTime()) / 1000;
      const withinBudgets =
        tasksLaunched < budget.maxTasks &&
        elapsed <= budget.maxWallClockSeconds &&
        consecutiveFailures < budget.maxConsecutiveFailures;

      // Fill free slots. Worktrees branch from the CURRENT HEAD, so launching
      // happens here in the coordinator, between merges — never concurrently.
      if (withinBudgets) {
        while (running.size < maxParallel && tasksLaunched < budget.maxTasks) {
          const ready = pickReadyTasks(
            backlog,
            1,
            [...running.values()].map((r) => r.task),
            exclusiveRetries,
          );
          if (ready.length === 0) break;
          const task = ready[0]!;
          const attempt = task.attempts + 1;
          if (attempt > budget.maxAttemptsPerTask) {
            backlog = applyTaskOutcome(backlog, task.id, "failed", task.attempts, {
              error: `exceeded maxAttemptsPerTask (${budget.maxAttemptsPerTask})`,
            });
            await saveBacklog(paths, backlog);
            consecutiveFailures++;
            await appendTimeline(paths, {
              kind: "task_failed",
              ts: now().toISOString(),
              task_id: task.id,
              reason: "max attempts exceeded",
            });
            continue;
          }
          backlog = {
            tasks: backlog.tasks.map((t) => (t.id === task.id ? { ...t, status: "running" as const } : t)),
          };
          await saveBacklog(paths, backlog);
          emit({ kind: "task_starting", task, attempt });
          await appendTimeline(paths, {
            kind: "task_picked",
            ts: now().toISOString(),
            task_id: task.id,
            attempt,
          });
          tasksLaunched++;
          log(`launching ${task.id} (attempt ${attempt}) [${running.size + 1}/${maxParallel} slots]`);
          running.set(task.id, { task, attempt, promise: launch(task, attempt) });
        }
      }

      if (running.size === 0) {
        // Nothing in flight and nothing was launchable — decide why and stop
        // (or replan). Mirrors the sequential loop's terminal logic.
        const progress = backlogProgress(backlog);
        const anyReady = pickReadyTasks(backlog, 1, [], exclusiveRetries).length > 0;
        if (anyReady && !withinBudgets) {
          if (consecutiveFailures >= budget.maxConsecutiveFailures) {
            if (await maybeReplan()) continue;
            stopReason = `${consecutiveFailures} consecutive failures — bailing out`;
            status = "stopped_failures";
          } else {
            stopReason =
              tasksLaunched >= budget.maxTasks
                ? `task budget exhausted (maxTasks=${budget.maxTasks})`
                : `wall-clock budget exhausted (${Math.round(elapsed)}s > ${budget.maxWallClockSeconds}s)`;
            status = "stopped_budget";
            await appendTimeline(paths, {
              kind: "budget_exhausted",
              ts: now().toISOString(),
              reason: stopReason,
            });
          }
          log(stopReason);
          emit({ kind: "stopping", reason: stopReason });
          break;
        }
        if ((progress.failed > 0 || progress.blocked > 0) && (await maybeReplan())) continue;
        if (progress.remaining === 0 && progress.failed === 0 && progress.blocked === 0 && progress.needsApproval === 0) {
          stopReason = "all tasks completed";
          status = "completed";
        } else if (progress.needsApproval > 0) {
          stopReason = `${progress.needsApproval} task(s) need human approval`;
          status = "stopped_approval";
        } else if (progress.blocked > 0 || progress.failed > 0) {
          stopReason = `${progress.blocked} blocked / ${progress.failed} failed — no executable task remains`;
          status = "stopped_blocked";
        } else {
          stopReason = "no runnable task available";
          status = "stopped_blocked";
        }
        log(stopReason);
        emit({ kind: "completed", reason: stopReason });
        break;
      }

      // Wait for ONE task to finish; all reconciliation (backlog/state/
      // timeline writes, merges) happens here, single-threaded.
      const settled = await Promise.race([...running.values()].map((r) => r.promise));
      running.delete(settled.task.id);
      const { task, attempt, worktree } = settled;

      let failureReason = settled.error;
      let outcome: "done" | "failed" | "blocked" | "needs_approval" = settled.report
        ? mapStatusToOutcome(settled.report.status)
        : "failed";

      if (worktree) {
        if (outcome === "done") {
          const msg = `${options.commitMessagePrefix}: ${task.id} ${task.title}`;
          const merge = await mergeTaskWorktree(opts.config.projectRoot, worktree, msg);
          if (merge.ok) {
            log(
              merge.commit
                ? `merged ${task.id} → ${merge.commit.slice(0, 7)}`
                : `merge skipped for ${task.id}: no changes`,
            );
          } else {
            outcome = "failed";
            failureReason = `${merge.conflict ? "merge conflict" : "merge failed"}${merge.error ? `: ${merge.error}` : ""}`;
            if (merge.conflict) exclusiveRetries.add(task.id);
            log(`${failureReason} (${task.id})`);
          }
        }
        await removeTaskWorktree(opts.config.projectRoot, worktree);
      }

      if (!settled.report) {
        backlog = applyTaskOutcome(backlog, task.id, "failed", attempt, {
          error: failureReason ?? "unknown error",
        });
        await saveBacklog(paths, backlog);
        await appendTimeline(paths, {
          kind: "task_failed",
          ts: now().toISOString(),
          task_id: task.id,
          reason: failureReason ?? "unknown error",
        });
        consecutiveFailures++;
        continue;
      }

      const report = settled.report;
      const taskExec: TaskExecution = {
        taskId: task.id,
        attempt,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        runId: report.runId,
        runDir: report.runDir,
        status: report.status,
        changedFiles: (report.rounds[report.rounds.length - 1]?.diff.changedFiles ?? []).map((c) => c.path),
        durationMs: report.durationMs,
        rounds: report.rounds.length,
      };
      executions.push(taskExec);

      backlog = applyTaskOutcome(backlog, task.id, outcome, attempt, {
        runId: report.runId,
        runStatus: report.status,
        ...(failureReason !== undefined ? { error: failureReason } : {}),
      });
      await saveBacklog(paths, backlog);

      state = updateStateAfterTask(state, { ...task, attempts: attempt, status: outcome }, taskExec);
      await saveState(paths, state);

      await appendTimeline(paths, {
        kind: "task_finished",
        ts: now().toISOString(),
        task_id: task.id,
        run_id: report.runId,
        status: report.status,
        attempt,
      });
      emit({ kind: "task_finished", task, runId: report.runId, status: report.status, attempt });

      if (outcome === "done") {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        const updatedTask = backlog.tasks.find((t) => t.id === task.id);
        if (updatedTask && (outcome === "failed" || outcome === "blocked")) {
          const root = lineageRoot(updatedTask, backlog);
          const sig = failureSignature(updatedTask, executions);
          const seen = lineageSignatures.get(root) ?? new Set<string>();
          if (seen.has(sig)) {
            stalledLineages.add(root);
            log(`lineage ${root} failed twice with signature ${sig} — marked stalled (no further replans)`);
          }
          seen.add(sig);
          lineageSignatures.set(root, seen);
        }
        const retryable =
          report.status === "verifier_failed" ||
          report.status === "review_changes_requested" ||
          exclusiveRetries.has(task.id);
        if (outcome === "failed" && retryable && attempt < budget.maxAttemptsPerTask) {
          backlog = {
            tasks: backlog.tasks.map((t) => (t.id === task.id ? { ...t, status: "pending" as const } : t)),
          };
          await saveBacklog(paths, backlog);
        }
      }
    }
  };

  if (maxParallel > 1) {
    if (!options.autoCommitBetweenTasks) {
      throw new Error(
        "project.maxParallelTasks > 1 requires autoCommitBetweenTasks — per-task commits are how worktrees merge back",
      );
    }
    if (!(await isGitRepo(opts.config.projectRoot))) {
      throw new Error("project.maxParallelTasks > 1 requires projectRoot to be a git repository (worktree isolation)");
    }
    await pruneTaskWorktrees(opts.config.projectRoot);
    log(`parallel mode: up to ${maxParallel} concurrent task(s), each in its own git worktree`);
    await runParallelLoop();
  } else {
    await runSequentialLoop();
  }

  // 4. Final report --------------------------------------------------------
  const finishedAt = now();
  const report: ProjectReport = {
    projectId: paths.projectId,
    projectDir: paths.projectDir,
    spec: resolvedSpec,
    config: opts.config,
    budget,
    decomposition: {
      summary: decomposition.summary,
      definitionOfDone: decomposition.definitionOfDone,
      initialBacklog: decomposition.tasks,
    },
    finalBacklog: backlog.tasks,
    finalState: state,
    executions,
    totals: computeTotals(executions),
    status,
    stopReason,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
  const md = renderProjectReport(report);
  await saveReport(paths, report, md);
  await appendTimeline(paths, {
    kind: "project_finished",
    ts: finishedAt.toISOString(),
    status,
    stop_reason: stopReason,
  });
  return report;
}

interface NeedsClarificationArgs {
  paths: ProjectPaths;
  spec: ProjectSpec;
  config: OrchestratorConfig;
  budget: ProjectBudget;
  clarification: ClarificationResult;
  startedAt: Date;
  finishedAt: Date;
}

async function needsClarificationReport(args: NeedsClarificationArgs): Promise<ProjectReport> {
  const { paths, clarification } = args;
  const stopReason = `spec needs clarification — ${clarification.questions.length} open question(s); see clarification.json`;
  const report: ProjectReport = {
    projectId: paths.projectId,
    projectDir: paths.projectDir,
    spec: args.spec,
    config: args.config,
    budget: args.budget,
    decomposition: {
      summary: "(not decomposed — spec needs clarification first)",
      definitionOfDone: { conditions: [] },
      initialBacklog: [],
    },
    finalBacklog: [],
    finalState: {
      summary: stopReason,
      knownFiles: [],
      // Render the questions where humans look first: the blockers section.
      blockers: clarification.questions.map(
        (q) => `Q: ${q.question} (why: ${q.why}; default: ${q.default_assumption || "none"})`,
      ),
      taskNotes: {},
    },
    executions: [],
    totals: computeTotals([]),
    status: "needs_clarification",
    stopReason,
    startedAt: args.startedAt.toISOString(),
    finishedAt: args.finishedAt.toISOString(),
    durationMs: args.finishedAt.getTime() - args.startedAt.getTime(),
  };
  const md = renderProjectReport(report);
  await saveReport(paths, report, md);
  await appendTimeline(paths, {
    kind: "project_finished",
    ts: args.finishedAt.toISOString(),
    status: report.status,
    stop_reason: stopReason,
  });
  return report;
}

function mapStatusToOutcome(status: string): "done" | "failed" | "blocked" | "needs_approval" {
  switch (status) {
    case "approved":
      return "done";
    case "requires_approval":
      return "needs_approval";
    case "verifier_failed":
    case "review_changes_requested":
      return "failed";
    default:
      return "blocked";
  }
}

function maybeOverrideAllowedPaths(
  config: OrchestratorConfig,
  override?: string[],
): OrchestratorConfig {
  if (!override || override.length === 0) return config;
  return {
    ...config,
    safety: { ...config.safety, allowedPaths: override },
  };
}

function renderTaskBriefing(
  task: BacklogTask,
  spec: ProjectSpec,
  summary: string,
  definitionOfDone: { conditions: string[] },
  state: ProjectState,
  executions: TaskExecution[],
): string {
  const lines: string[] = [];
  lines.push(`# ${task.title}`);
  lines.push("");
  lines.push(`> Task **${task.id}** (${task.kind}, ${task.estimated_complexity}). Part of project: ${spec.title}.`);
  lines.push("");
  lines.push("## What to do now");
  lines.push("");
  lines.push(task.description.trim() || "(no description provided)");
  lines.push("");
  if (task.allowed_paths && task.allowed_paths.length > 0) {
    lines.push(`Allowed paths for this task: ${task.allowed_paths.join(", ")}`);
    lines.push("");
  }
  lines.push("## Project context");
  lines.push("");
  lines.push(`Project summary: ${summary}`);
  lines.push("");
  lines.push("Definition of done:");
  for (const c of definitionOfDone.conditions) lines.push(`- ${c}`);
  lines.push("");
  lines.push("## State so far");
  lines.push("");
  if (state.knownFiles.length > 0) {
    lines.push("Files touched by previous tasks:");
    for (const f of state.knownFiles.slice(0, 50)) lines.push(`- ${f}`);
  } else {
    lines.push("(no files have been modified yet)");
  }
  lines.push("");
  if (executions.length > 0) {
    lines.push("Recent task outcomes:");
    for (const e of executions.slice(-5)) {
      lines.push(`- ${e.taskId} attempt ${e.attempt} → ${e.status}`);
    }
    lines.push("");
  }
  if (state.blockers.length > 0) {
    lines.push("Open blockers (be aware, do not silently ignore):");
    for (const b of state.blockers.slice(-10)) lines.push(`- ${b}`);
    lines.push("");
  }
  lines.push("## Original spec");
  lines.push("");
  lines.push(spec.body);
  return lines.join("\n");
}

function renderProjectReport(report: ProjectReport): string {
  const lines: string[] = [];
  lines.push(`# Project report — ${report.projectId}`);
  lines.push("");
  lines.push(`- **Title:** ${report.spec.title}`);
  lines.push(`- **Status:** \`${report.status}\``);
  lines.push(`- **Stop reason:** ${report.stopReason}`);
  lines.push(`- **Duration:** ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- **Tasks:** ${report.executions.length} executions over ${report.finalBacklog.length} tasks`);
  lines.push(`- **Project dir:** \`${report.projectDir}\``);
  lines.push("");

  lines.push("## Totals");
  lines.push(`- Total task wall time: ${(report.totals.totalDurationMs / 1000).toFixed(1)}s across ${report.executions.length} executions`);
  lines.push(`- Total repair rounds: ${report.totals.totalRounds}`);
  lines.push(`- Total files changed: ${report.totals.totalChangedFiles}`);
  if (Object.keys(report.totals.perStatus).length > 0) {
    lines.push(`- Status breakdown: ${Object.entries(report.totals.perStatus).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  lines.push("");

  lines.push("## Definition of done");
  for (const c of report.decomposition.definitionOfDone.conditions) {
    lines.push(`- ${c}`);
  }
  lines.push("");

  lines.push("## Backlog (final state)");
  lines.push("");
  lines.push("| ID | Title | Kind | Status | Attempts | Last run |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const t of report.finalBacklog) {
    lines.push(
      `| ${t.id} | ${escapePipes(t.title)} | ${t.kind} | \`${t.status}\` | ${t.attempts} | ${t.lastRunId ?? "—"} |`,
    );
  }
  lines.push("");

  lines.push("## Executions");
  lines.push("");
  if (report.executions.length === 0) {
    lines.push("_No tasks were executed._");
  } else {
    for (const e of report.executions) {
      lines.push(
        `- \`${e.taskId}\` attempt ${e.attempt} → **${e.status}** (run \`${e.runId}\`, ${e.changedFiles.length} files changed)`,
      );
    }
  }
  lines.push("");

  lines.push("## Final state");
  lines.push("");
  lines.push("Files touched:");
  if (report.finalState.knownFiles.length === 0) lines.push("- _(none)_");
  for (const f of report.finalState.knownFiles) lines.push(`- ${f}`);
  lines.push("");
  if (report.finalState.blockers.length > 0) {
    lines.push("Open blockers:");
    for (const b of report.finalState.blockers) lines.push(`- ${b}`);
    lines.push("");
  }

  lines.push("## Suggested next human action");
  lines.push("");
  lines.push(suggestNextAction(report));
  return lines.join("\n");
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function computeTotals(executions: TaskExecution[]): import("./types.js").ProjectTotals {
  let totalDurationMs = 0;
  let totalRounds = 0;
  let totalChangedFiles = 0;
  const perStatus: Record<string, number> = {};
  for (const e of executions) {
    totalDurationMs += e.durationMs;
    totalRounds += e.rounds;
    totalChangedFiles += e.changedFiles.length;
    perStatus[e.status] = (perStatus[e.status] ?? 0) + 1;
  }
  return {
    totalDurationMs,
    totalRounds,
    totalChangedFiles,
    perStatus,
    averageTaskDurationMs: executions.length === 0 ? 0 : Math.round(totalDurationMs / executions.length),
  };
}

function extractMarkdownTitle(body: string): string {
  for (const line of body.split("\n")) {
    const m = /^#\s+(.*)/.exec(line.trim());
    if (m && m[1]) return m[1].trim();
  }
  return body.split("\n").find((l) => l.trim())?.trim().slice(0, 60) || "project";
}

function countByStatus(b: Backlog): string {
  const counts: Record<string, number> = {};
  for (const t of b.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
}

function suggestNextAction(report: ProjectReport): string {
  switch (report.status) {
    case "completed":
      return "Project finished cleanly. Review the diff in each task's run dir, run the verifier suite once more on the full tree, and merge.";
    case "stopped_approval":
      return "One or more tasks need human approval (risky operations or out-of-policy paths). Inspect each blocked task's run dir, decide manually, then optionally re-run with the constraints relaxed.";
    case "stopped_blocked":
      return "The remaining tasks are blocked by failed dependencies. Inspect the failed task(s) run dirs, fix manually, and re-run the project (it will pick up from the existing backlog if you point at the same project dir).";
    case "stopped_failures":
      return "Too many consecutive failures. The implementer worker may be stuck. Try increasing maxConsecutiveFailures, simplifying the spec, or running the failing task manually.";
    case "stopped_budget":
      return "Budget exhausted. Increase maxTasks / maxWallClockSeconds, or split the project spec into smaller projects.";
    case "needs_clarification":
      return "The clarifier found open questions (listed under blockers above, and in clarification.json). Answer them by editing the spec, then re-run build-project.";
    case "error":
      return "Internal orchestrator error. Inspect the timeline and per-task logs.";
    default:
      return "Inspect the project directory.";
  }
}
