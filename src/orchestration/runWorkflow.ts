import { writeFile } from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { OrchestratorConfig, ReviewPerspective } from "../config/schema.js";
import { loadPrompt } from "../prompts/index.js";
import { extractJson } from "../utils/jsonExtract.js";
import { redact, redactedTail } from "../utils/redact.js";
import type { Worker, WorkerInput, SafetyPolicy } from "../workers/Worker.js";
import {
  createRunDir,
  readText,
  writeJson,
  writeText,
  type RunPaths,
} from "./artifacts.js";
import { ConversationLog, type ConversationStage } from "./conversationLog.js";
import { EventBus } from "./eventBus.js";
import {
  makeExchangeId,
  renderEnvelope,
  renderEchoRetryReminder,
  stripEcho,
  verifyEcho,
} from "./envelope.js";
import { renderFinalReport } from "./report.js";
import { mergePanelReviews, shouldRunPanel, type PanelMemberResult } from "./reviewPanel.js";
import { resolveMaxRounds, resolveStage, RoutingError, type ResolvedRoute } from "./routing.js";
import { captureDiff, captureGitInfo } from "./git.js";
import {
  detectRisks,
  preflightSafety,
  risksRequiringApproval,
} from "./safety.js";
import {
  type DiffSummary,
  type PlanArtifact,
  type ReviewArtifact,
  type RoundReport,
  type RunReport,
  type RunStatus,
  type VerifierReport,
} from "./types.js";
import { runVerifier } from "./verifier.js";
import { decidePreVerifier, runPreVerifier } from "./preVerifier.js";

export type ProgressEvent =
  | { kind: "status"; stage: string; round?: number; message: string }
  | { kind: "worker_start"; stage: string; round?: number; worker: string }
  | { kind: "worker_end"; stage: string; round?: number; worker: string; durationMs: number; exitCode: number }
  | { kind: "verifier_start"; round: number; command: string }
  | { kind: "verifier_end"; round: number; command: string; ok: boolean; exitCode: number; durationMs: number };

export interface RunWorkflowOptions {
  config: OrchestratorConfig;
  /** Path to the task markdown. Either taskPath or taskText is required. */
  taskPath?: string;
  /** Inline task text. Takes precedence over taskPath. */
  taskText?: string;
  workers: { claude: Worker; codex: Worker; cursor?: Worker };
  baseRunsDir?: string;
  /**
   * Additional path prefixes (absolute) that should be excluded from the diff
   * when computing risks / path-violations. Used by the project builder so the
   * orchestrator's project working directory isn't flagged as a user change.
   */
  extraIgnorePrefixes?: string[];
  /**
   * Risks the caller is intentionally introducing — they are still detected
   * and recorded in the report, but they do NOT trigger the requires_approval
   * gate. Used by the project builder so the decomposer can pre-declare that
   * `T03 build auth router` is allowed to touch security-sensitive files.
   */
  acknowledgedRisks?: string[];
  /** Allows tests to inject a deterministic clock. */
  now?: () => Date;
  /** Quiet mode for tests. */
  quiet?: boolean;
  /** Optional progress callback for chat / HTTP / MCP front-ends. */
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Event bus this run publishes to (topic `run:<runId>`). The project builder
   * passes a shared bus so all task runs stream onto one spine; standalone
   * runs get a private bus. Conversation events and progress events both flow
   * through it — onProgress is implemented as a bus subscriber.
   */
  bus?: EventBus;
  /**
   * Task category ("quick" / "standard" / "deep" by convention). Selects the
   * matching `routing.categories` override for worker/model/maxRounds.
   */
  category?: string;
}

/**
 * Default workflow: prepare → plan → implement → capture diff → verify → review
 *                  → repair loop (≤ maxRounds) → final report.
 *
 * The orchestrator is the only component that invokes workers. Workers receive
 * structured artifacts and produce results; they cannot call each other.
 */
export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunReport> {
  const { config, workers } = opts;
  const now = opts.now ?? (() => new Date());

  // 1. Prepare run -----------------------------------------------------------
  const taskRaw = await resolveTaskText(opts);
  const taskTitle = extractTaskTitle(taskRaw);
  const baseRunsDir = path.resolve(opts.baseRunsDir ?? path.join(config.projectRoot, "runs"));
  const paths = await createRunDir(baseRunsDir, taskTitle, now());
  const startedAt = now();

  preflightSafety(config, config.projectRoot);

  await writeText(paths.taskFile, taskRaw);
  await writeJson(paths.configFile, config);

  const bus = opts.bus ?? new EventBus();
  const topic = `run:${paths.runId}`;
  const conv = ConversationLog.forRun(paths.runDir, bus, topic);
  const category = opts.category;
  await conv.status(
    "prepare",
    `run ${paths.runId} started for task: ${taskTitle}${category ? ` (category: ${category})` : ""}`,
  );
  await conv.append({
    round: null,
    stage: "prepare",
    actor: "user",
    kind: "prompt",
    content: taskRaw,
  });

  const gitInfo = await captureGitInfo(config.projectRoot);
  await writeJson(path.join(paths.runDir, "git.initial.json"), gitInfo);

  const safetyPolicy: SafetyPolicy = {
    allowedPaths: config.safety.allowedPaths,
    approvalRequiredFor: config.safety.approvalRequiredFor,
    denyShellPatterns: config.safety.denyShellPatterns,
    forbiddenActions: ["invoke_other_agent", "destructive_shell"],
  };

  const log = (msg: string) => {
    if (!opts.quiet) console.log(`[orchestrator] ${msg}`);
  };
  // Progress flows over the bus; the caller's onProgress is just a subscriber.
  // The bus isolates subscriber errors, so a throwing observer can't crash
  // the workflow (same contract as the old direct-call emit).
  const unsubscribeProgress = opts.onProgress
    ? bus.subscribe(topic, (be) => {
        const payload = be.payload as { type?: string; event?: ProgressEvent };
        if (payload?.type === "progress" && payload.event) opts.onProgress!(payload.event);
      })
    : undefined;
  const emit = (e: ProgressEvent) => {
    bus.publish(topic, { type: "progress", event: e });
  };

  // Resolve all stage routes up front so a routing misconfiguration fails
  // fast, before any worker runs.
  const workerMap: Record<string, Worker | undefined> = {
    claude: workers.claude,
    codex: workers.codex,
    cursor: workers.cursor,
  };
  const planRoute = resolveStage({ stage: "plan", category, config, workers: workerMap });
  const implementRoute = resolveStage({ stage: "implement", category, config, workers: workerMap });
  const reviewRoute = resolveStage({ stage: "review", category, config, workers: workerMap });
  const repairRoute = resolveStage({ stage: "repair", category, config, workers: workerMap });
  const maxRounds = resolveMaxRounds(config, category);

  // 2. Plan -----------------------------------------------------------------
  emit({ kind: "status", stage: "plan", message: "running planner" });
  const plan = await runPlanner({
    route: planRoute,
    config,
    safetyPolicy,
    taskRaw,
    taskTitle,
    paths,
    log,
    conv,
    emit,
  });
  await writeJson(paths.planFile, plan);

  // 3. Implement ------------------------------------------------------------
  log(`running implementer (${implementRoute.workerName})…`);
  emit({ kind: "status", stage: "implement", message: "running implementer" });
  const implementPrompt = await loadPrompt("implement.codex");
  if (!implementRoute.worker.enabled) {
    log(`${implementRoute.workerName} worker disabled — skipping implementation`);
    await conv.status("implement", `${implementRoute.workerName} disabled — skipping implementation`);
  } else {
    const implementExchangeId = makeExchangeId(paths.runId, "implement", 1);
    const implementInput: WorkerInput = {
      role: "implementer",
      // File-editing stage: envelope is correlation-only (work comes back via git diff).
      prompt: `${implementPrompt}\n\n${renderEnvelope(implementExchangeId, { echoRequired: false })}`,
      cwd: config.projectRoot,
      timeoutSeconds: config.timeoutSeconds,
      logDir: paths.logsDir,
      safetyPolicy,
      tag: "round.1.implement",
      model: implementRoute.model,
      artifacts: [
        { name: "task.md", path: paths.taskFile, content: taskRaw },
        { name: "plan.json", path: paths.planFile, content: JSON.stringify(plan, null, 2) },
      ],
    };
    await conv.prompt({
      stage: "implement",
      actor: implementRoute.workerName,
      round: 1,
      content: renderPromptForLog(implementInput),
      meta: { exchangeId: implementExchangeId, ...(implementRoute.model ? { model: implementRoute.model } : {}) },
    });
    emit({ kind: "worker_start", stage: "implement", round: 1, worker: implementRoute.workerName });
    const result = await implementRoute.worker.run(implementInput);
    emit({
      kind: "worker_end",
      stage: "implement",
      round: 1,
      worker: implementRoute.workerName,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
    });
    await conv.response({
      stage: "implement",
      actor: implementRoute.workerName,
      round: 1,
      content: result.stdout,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      meta: { exchangeId: implementExchangeId },
    });
    await writeText(
      path.join(paths.logsDir, "round.1.implement.summary.txt"),
      `exit=${result.exitCode} timedOut=${result.timedOut} duration=${result.durationMs}ms\n` +
        redactedTail(result.stdout, 4000),
    );
  }

  // 4–7. Review-first cycle: implement → (review → verify? → repair) × N
  //
  // Per round:
  //   1. capture diff
  //   2. review — gets the patch + previous round's verifier results (if any).
  //   3. if review === requires_human_review: stop & escalate.
  //   4. if review === approve: run verifier. If verifier passes → DONE.
  //      If verifier fails → fall through to repair.
  //   5. if review === request_changes: skip verifier, jump to repair.
  //   6. if budget remaining: repair (codex), then loop.
  const rounds: RoundReport[] = [];
  let lastVerifier: VerifierReport | null = null;
  let lastReview: ReviewArtifact | null = null;
  let lastDiff: DiffSummary | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    log(`round ${round}: capturing diff`);
    emit({ kind: "status", stage: "diff", round, message: "capturing diff" });
    const diff = await captureRoundDiff(paths, round, config, baseRunsDir, opts.extraIgnorePrefixes ?? []);
    lastDiff = diff;
    await conv.status(
      "verify",
      `round ${round} diff: ${diff.changedFiles.length} files, risks=[${diff.detectedRisks.join(",")}], violations=${diff.pathViolations.length}`,
      round,
    );

    // ---- Step 1: review (always first) ----------------------------------
    log(`round ${round}: running reviewer`);
    emit({ kind: "status", stage: "review", round, message: "running reviewer" });
    const reviewerArgsBase = {
      config,
      safetyPolicy,
      paths,
      taskRaw,
      plan,
      diff,
      // review sees the PREVIOUS round's verifier output (or null on round 1).
      verifier: lastVerifier,
      round,
      log,
      conv,
      emit,
    };
    let review: ReviewArtifact;
    if (reviewRoute.worker.enabled && shouldRunPanel({ config, diff, category })) {
      const panel = config.review.panel;
      log(
        `round ${round}: review panel — ${panel.perspectives.map((p) => p.name).join(", ")} (decision=${panel.decision})`,
      );
      await conv.status(
        "review",
        `review panel: ${panel.perspectives.map((p) => p.name).join(", ")} (decision=${panel.decision})`,
        round,
      );
      const { merged, members } = await runReviewPanel({
        ...reviewerArgsBase,
        baseRoute: reviewRoute,
        workerMap,
      });
      for (const m of members) {
        await writeJson(path.join(paths.runDir, "rounds", `review.r${round}.${m.perspective}.json`), m.review);
      }
      review = merged;
    } else {
      review = await runReviewer({ ...reviewerArgsBase, route: reviewRoute });
    }
    await writeJson(path.join(paths.runDir, "rounds", `review.r${round}.json`), review);
    lastReview = review;

    let verifier: VerifierReport | null = null;
    let decision: RoundReport["decision"];

    if (review.verdict === "requires_human_review") {
      decision = "requires_human_review";
      rounds.push({ round, diff, review, verifier: null, decision });
      log(`round ${round}: reviewer escalated (requires_human_review) — stopping`);
      await conv.status("review", "reviewer escalated to human", round);
      break;
    }

    if (review.verdict === "approve") {
      // ---- Step 2: pre-verifier + verifier (only after review approved) -
      const preDecision = await decidePreVerifier({
        cwd: config.projectRoot,
        changedFiles: diff.changedFiles,
        mode: config.verifier.autoInstall,
        installCommand: config.verifier.installCommand,
      });
      if (preDecision) {
        log(`round ${round}: pre-verifier → ${preDecision.command} (${preDecision.reason})`);
        await conv.status("verify", `pre-verifier: ${preDecision.command} — ${preDecision.reason}`, round);
        const pre = await runPreVerifier({
          command: preDecision.command,
          cwd: config.projectRoot,
          logsDir: paths.logsDir,
          timeoutMs: config.timeoutSeconds * 1000,
          round,
        });
        await conv.verifierOutput({
          round,
          command: preDecision.command,
          exitCode: pre.exitCode,
          durationMs: pre.durationMs,
          tail: pre.truncatedTail,
        });
        if (!pre.ok) {
          log(`round ${round}: pre-verifier FAILED (exit ${pre.exitCode}); continuing anyway`);
        }
      }

      log(`round ${round}: running verifier`);
      emit({ kind: "status", stage: "verify", round, message: "running verifier" });
      for (const cmd of config.verifier.commands) {
        await conv.verifierCommand(round, cmd);
        emit({ kind: "verifier_start", round, command: cmd });
      }
      verifier = await runVerifier({
        commands: config.verifier.commands,
        cwd: config.projectRoot,
        logsDir: paths.logsDir,
        timeoutMs: config.timeoutSeconds * 1000,
        denyShellPatterns: config.safety.denyShellPatterns,
        round,
      });
      for (const r of verifier.results) {
        await conv.verifierOutput({
          round,
          command: r.command,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          tail: r.truncatedTail,
        });
        emit({
          kind: "verifier_end",
          round,
          command: r.command,
          ok: r.ok,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
        });
      }
      await writeJson(path.join(paths.runDir, "rounds", `verifier.r${round}.json`), verifier);
      lastVerifier = verifier;

      decision = verifier.passed ? "approved_passed" : "approved_failed_verify";
      rounds.push({ round, diff, review, verifier, decision });

      if (verifier.passed) {
        log(`round ${round}: verifier PASSED — DONE`);
        break;
      }
      log(`round ${round}: verifier FAILED — repair on next round`);
    } else {
      // verdict === "request_changes" — skip verify, go straight to repair.
      decision = "request_changes";
      rounds.push({ round, diff, review, verifier: null, decision });
      log(`round ${round}: reviewer requested changes — skipping verify, going to repair`);
      await conv.status("review", "reviewer requested changes — skipping verify this round", round);
    }

    // ---- Step 3: repair (only if budget remains) ------------------------
    if (round === maxRounds) {
      log(`max rounds (${maxRounds}) reached`);
      await conv.status("repair", `max rounds (${maxRounds}) reached`, round);
      break;
    }
    if (!repairRoute.worker.enabled) {
      log(`${repairRoute.workerName} disabled — cannot repair, exiting loop`);
      await conv.status("repair", `${repairRoute.workerName} disabled — cannot repair`, round);
      break;
    }

    log(`round ${round}: repair → ${repairRoute.workerName}`);
    emit({ kind: "status", stage: "repair", round, message: "running repair" });

    // Stale-artifact guard: the review fed to repair must be bound to THIS
    // round. With in-memory flow this is an internal invariant; it becomes a
    // real check once artifacts are assembled across processes/worktrees.
    if (review._meta && review._meta.round !== round) {
      await conv.error(
        "repair",
        "orchestrator",
        `stale review artifact: bound to round ${review._meta.round}, current round is ${round} — aborting repair`,
        round,
      );
      break;
    }

    const repairPrompt = await loadPrompt("repair.codex");
    const repairExchangeId = makeExchangeId(paths.runId, "repair", round + 1);
    const failingTails = (verifier?.results ?? [])
      .filter((r) => !r.ok)
      .map((r) => `# ${r.command} (exit ${r.exitCode})\n${r.truncatedTail}`)
      .join("\n\n");
    const repairInput: WorkerInput = {
      role: "repair",
      // File-editing stage: envelope is correlation-only (work comes back via git diff).
      prompt: `${repairPrompt}\n\n${renderEnvelope(repairExchangeId, { echoRequired: false })}`,
      cwd: config.projectRoot,
      timeoutSeconds: config.timeoutSeconds,
      logDir: paths.logsDir,
      safetyPolicy,
      tag: `round.${round + 1}.repair`,
      model: repairRoute.model,
      artifacts: [
        { name: "review.json", content: JSON.stringify(review, null, 2) },
        { name: "patch.diff", path: paths.patchFile, content: await readText(paths.patchFile) },
        ...(failingTails ? [{ name: "verifier.tails.txt", content: failingTails }] : []),
      ],
    };
    await conv.prompt({
      stage: "repair",
      actor: repairRoute.workerName,
      round: round + 1,
      content: renderPromptForLog(repairInput),
      meta: { exchangeId: repairExchangeId, ...(repairRoute.model ? { model: repairRoute.model } : {}) },
    });
    emit({ kind: "worker_start", stage: "repair", round: round + 1, worker: repairRoute.workerName });
    const repairResult = await repairRoute.worker.run(repairInput);
    emit({
      kind: "worker_end",
      stage: "repair",
      round: round + 1,
      worker: repairRoute.workerName,
      durationMs: repairResult.durationMs,
      exitCode: repairResult.exitCode,
    });
    await conv.response({
      stage: "repair",
      actor: repairRoute.workerName,
      round: round + 1,
      content: repairResult.stdout,
      durationMs: repairResult.durationMs,
      exitCode: repairResult.exitCode,
      meta: { exchangeId: repairExchangeId },
    });
    await writeText(
      path.join(paths.logsDir, `round.${round + 1}.repair.summary.txt`),
      `exit=${repairResult.exitCode} timedOut=${repairResult.timedOut} duration=${repairResult.durationMs}ms\n` +
        redactedTail(repairResult.stdout, 4000),
    );
  }

  // 8. Final report ---------------------------------------------------------
  const finishedAt = now();
  const finalDiff =
    lastDiff ?? {
      patchPath: paths.patchFile,
      changedFiles: [],
      detectedRisks: [],
      pathViolations: [],
    };
  // The verifier shown in the run-level report is the most recent verifier
  // result (which may be null if every round ended with the reviewer
  // requesting changes — in that case there's nothing to display).
  const finalVerifier: VerifierReport = lastVerifier ?? { passed: false, results: [] };
  const finalReview: ReviewArtifact =
    lastReview ?? {
      verdict: "requires_human_review",
      bugs: [],
      missing_tests: [],
      risks: ["no review produced"],
      recommended_fixes: [],
    };

  await writeJson(paths.changedFilesFile, finalDiff.changedFiles);
  await writeJson(paths.verifierFile, finalVerifier);
  await writeJson(paths.reviewFile, finalReview);

  const acknowledgedSet = new Set(opts.acknowledgedRisks ?? []);
  const approvalReasons = [
    ...risksRequiringApproval(finalDiff.detectedRisks, config).filter((r) => !acknowledgedSet.has(r)),
    ...(finalDiff.pathViolations.length > 0 ? (["path_violation"] as const) : []),
  ];
  const requiresApproval = approvalReasons.length > 0 || finalReview.verdict === "requires_human_review";

  const status = computeStatus({
    requiresApproval,
    verifierPassed: finalVerifier.passed,
    verdict: finalReview.verdict,
  });

  const report: RunReport = {
    runId: paths.runId,
    runDir: paths.runDir,
    task: { path: paths.taskFile, title: taskTitle },
    config,
    plan,
    rounds,
    status,
    requiresApproval,
    approvalReasons: [...new Set(approvalReasons)],
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };

  await conv.status("report", `run finished: status=${report.status}, requiresApproval=${report.requiresApproval}`);
  await conv.finalize();
  await writeText(paths.reportFile, renderFinalReport(report));
  emit({ kind: "status", stage: "report", message: `finished: ${report.status}` });

  await bus.flush();
  unsubscribeProgress?.();

  return report;
}

async function resolveTaskText(opts: RunWorkflowOptions): Promise<string> {
  if (opts.taskText && opts.taskText.trim().length > 0) {
    return opts.taskText;
  }
  if (opts.taskPath) {
    return readText(opts.taskPath);
  }
  throw new Error("runWorkflow: either taskText or taskPath must be provided");
}

interface JsonExchangeArgs {
  worker: Worker;
  stage: ConversationStage;
  actor: string;
  round: number | null;
  exchangeId: string;
  /** Worker input WITHOUT the envelope — the exchange appends it. */
  input: WorkerInput;
  conv: ConversationLog;
  emit: (event: ProgressEvent) => void;
  log: (msg: string) => void;
}

/**
 * Run one JSON-producing worker exchange under the envelope contract:
 * the worker must echo `exchange_id` at the top level of its JSON output.
 *
 * - unparseable output → { json: null, protocolError: false } (caller's
 *   existing deterministic fallback path, unchanged behavior)
 * - parseable but wrong/missing echo → one retry with a stronger reminder;
 *   still wrong → { json: null, protocolError: true } and the payload is
 *   DISCARDED — a suspect payload is never consumed silently.
 */
async function runJsonExchange(args: JsonExchangeArgs): Promise<{ json: unknown; protocolError: boolean }> {
  const { worker, stage, actor, round, exchangeId, conv, emit, log } = args;
  const envelope = renderEnvelope(exchangeId, { echoRequired: true });

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? `${args.input.prompt}\n\n${envelope}`
        : `${args.input.prompt}\n\n${envelope}\n\n${renderEchoRetryReminder(exchangeId)}`;
    const input: WorkerInput = {
      ...args.input,
      prompt,
      tag: attempt === 1 ? args.input.tag : `${args.input.tag}.retry`,
    };
    await conv.prompt({
      stage,
      actor,
      round,
      content: renderPromptForLog(input),
      meta: { exchangeId, attempt },
    });
    emit({ kind: "worker_start", stage, round: round ?? undefined, worker: actor });
    const result = await worker.run(input);
    emit({
      kind: "worker_end",
      stage,
      round: round ?? undefined,
      worker: actor,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
    });
    await conv.response({
      stage,
      actor,
      round,
      content: result.stdout,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      meta: { exchangeId, attempt },
    });

    const json = result.parsedJson ?? extractJson(result.stdout);
    if (!json || typeof json !== "object") {
      return { json: null, protocolError: false };
    }
    if (verifyEcho(json, exchangeId)) {
      return { json: stripEcho(json), protocolError: false };
    }
    log(`${stage}: response did not echo exchange_id ${exchangeId} (attempt ${attempt})`);
    await conv.error(
      stage,
      "orchestrator",
      `echo check failed: expected exchange_id ${exchangeId} in ${actor} response (attempt ${attempt})`,
      round,
    );
  }
  return { json: null, protocolError: true };
}

interface PlannerArgs {
  route: ResolvedRoute;
  config: OrchestratorConfig;
  safetyPolicy: SafetyPolicy;
  taskRaw: string;
  taskTitle: string;
  paths: RunPaths;
  log: (msg: string) => void;
  conv: ConversationLog;
  emit: (event: ProgressEvent) => void;
}

async function runPlanner(args: PlannerArgs): Promise<PlanArtifact> {
  const { route, config, safetyPolicy, taskRaw, taskTitle, paths, log, conv, emit } = args;

  if (!route.worker.enabled) {
    log(`${route.workerName} disabled — using deterministic fallback planner`);
    await conv.status("plan", `${route.workerName} disabled — using deterministic fallback planner`);
    const plan = fallbackPlan(taskRaw, taskTitle);
    await conv.response({ stage: "plan", actor: "fallback", content: JSON.stringify(plan, null, 2) });
    return plan;
  }

  log(`running planner (${route.workerName})…`);
  const plannerPrompt = await loadPrompt("planner.claude");
  const exchangeId = makeExchangeId(paths.runId, "plan");
  const input: WorkerInput = {
    role: "planner",
    prompt: plannerPrompt,
    cwd: config.projectRoot,
    timeoutSeconds: config.timeoutSeconds,
    logDir: paths.logsDir,
    safetyPolicy,
    tag: "plan",
    model: route.model,
    artifacts: [{ name: "task.md", path: paths.taskFile, content: taskRaw }],
  };
  const { json, protocolError } = await runJsonExchange({
    worker: route.worker,
    stage: "plan",
    actor: route.workerName,
    round: null,
    exchangeId,
    input,
    conv,
    emit,
    log,
  });
  if (!json) {
    if (protocolError) {
      log("planner echo check failed after retry — payload discarded, using deterministic fallback plan");
      await conv.status("plan", `protocol_error: planner payload discarded (exchange ${exchangeId}) — using fallback`);
    } else {
      log("planner did not return parseable JSON — falling back to deterministic plan");
      await conv.status("plan", "planner did not return parseable JSON — using fallback");
    }
    return fallbackPlan(taskRaw, taskTitle);
  }
  const plan = normalizePlan(json as Partial<PlanArtifact>, taskRaw, taskTitle);
  plan._meta = { runId: paths.runId, round: null, exchangeId };
  return plan;
}

interface ReviewerArgs {
  route: ResolvedRoute;
  /** Set when this reviewer is one member of the multi-perspective panel. */
  perspective?: ReviewPerspective;
  config: OrchestratorConfig;
  safetyPolicy: SafetyPolicy;
  paths: RunPaths;
  taskRaw: string;
  plan: PlanArtifact;
  diff: DiffSummary;
  /** Previous round's verifier result, or null on round 1 (review-first flow). */
  verifier: VerifierReport | null;
  round: number;
  log: (msg: string) => void;
  conv: ConversationLog;
  emit: (event: ProgressEvent) => void;
}

async function runReviewer(args: ReviewerArgs): Promise<ReviewArtifact> {
  const { route, perspective, config, safetyPolicy, paths, taskRaw, plan, diff, verifier, round, log, conv, emit } = args;

  if (!route.worker.enabled) {
    log(`${route.workerName} disabled — using deterministic fallback reviewer`);
    await conv.status("review", `${route.workerName} disabled — using deterministic fallback reviewer`, round);
    const fb = fallbackReview(diff, verifier);
    await conv.response({ stage: "review", actor: "fallback", round, content: JSON.stringify(fb, null, 2) });
    return fb;
  }

  const reviewPrompt = await loadPrompt("review.claude");
  const verifierSummary = verifier
    ? verifier.results
        .map(
          (r) =>
            `- \`${r.command}\` → exit ${r.exitCode} ${r.ok ? "PASS" : "FAIL"}\n${redactedTail(r.truncatedTail, 800)}`,
        )
        .join("\n")
    : "";

  const patch = await readText(paths.patchFile).catch(() => "");
  const exchangeId = makeExchangeId(paths.runId, "review", round, perspective?.name);
  const prompt = perspective
    ? `${reviewPrompt}\n\n${renderPerspectiveBlock(perspective)}`
    : reviewPrompt;
  const input: WorkerInput = {
    role: "reviewer",
    prompt,
    cwd: config.projectRoot,
    timeoutSeconds: config.timeoutSeconds,
    logDir: paths.logsDir,
    safetyPolicy,
    tag: perspective ? `round.${round}.review.${perspective.name}` : `round.${round}.review`,
    model: route.model,
    artifacts: [
      { name: "task.md", path: paths.taskFile, content: taskRaw },
      { name: "plan.json", content: JSON.stringify(plan, null, 2) },
      { name: "patch.diff", path: paths.patchFile, content: redact(patch).slice(0, 16_000) },
      {
        name: "verifier.summary.md",
        content:
          verifierSummary ||
          (verifier ? "(verifier ran but produced no output)" : "(no verifier results yet — first review of this patch)"),
      },
    ],
  };
  const { json, protocolError } = await runJsonExchange({
    worker: route.worker,
    stage: "review",
    actor: route.workerName,
    round,
    exchangeId,
    input,
    conv,
    emit,
    log,
  });
  if (!json) {
    if (protocolError) {
      log("reviewer echo check failed after retry — payload discarded, using deterministic fallback review");
      await conv.status("review", `protocol_error: reviewer payload discarded (exchange ${exchangeId}) — using fallback`, round);
    } else {
      log("reviewer did not return parseable JSON — using deterministic fallback review");
      await conv.status("review", "reviewer did not return parseable JSON — using fallback", round);
    }
    return fallbackReview(diff, verifier);
  }
  const review = normalizeReview(json as Partial<ReviewArtifact>, diff, verifier);
  review._meta = { runId: paths.runId, round, exchangeId };
  return review;
}

function renderPerspectiveBlock(perspective: ReviewPerspective): string {
  return [
    "## Review perspective",
    "",
    `You are the "${perspective.name}" reviewer on a multi-perspective review panel.`,
    `Focus your review on: ${perspective.focus}`,
    "Judge ONLY from this perspective — other panel members cover the rest.",
  ].join("\n");
}

interface PanelArgs extends Omit<ReviewerArgs, "route" | "perspective"> {
  baseRoute: ResolvedRoute;
  /** Workers available to this run, for perspectives that name their own worker. */
  workerMap: Record<string, Worker | undefined>;
}

async function runReviewPanel(args: PanelArgs): Promise<{ merged: ReviewArtifact; members: PanelMemberResult[] }> {
  const { workerMap } = args;
  const panel = args.config.review.panel;

  // Resolve every member's route up front — a misconfigured perspective fails
  // the round loudly instead of silently shrinking the panel.
  const memberRoutes = panel.perspectives.map((perspective) => {
    if (perspective.worker) {
      const worker = workerMap[perspective.worker];
      if (!worker) {
        throw new RoutingError(
          `review panel: perspective "${perspective.name}" routed to unknown worker "${perspective.worker}"`,
        );
      }
      if (!worker.enabled) {
        throw new RoutingError(
          `review panel: perspective "${perspective.name}" routed to disabled worker "${perspective.worker}"`,
        );
      }
      const route: ResolvedRoute = {
        worker,
        workerName: perspective.worker,
        model: perspective.model ?? args.baseRoute.model,
        explicit: true,
      };
      return { perspective, route };
    }
    const route: ResolvedRoute = { ...args.baseRoute, model: perspective.model ?? args.baseRoute.model };
    return { perspective, route };
  });

  const members: PanelMemberResult[] = await Promise.all(
    memberRoutes.map(async ({ perspective, route }) => ({
      perspective: perspective.name,
      review: await runReviewer({ ...args, route, perspective }),
    })),
  );

  const merged = mergePanelReviews(members, panel.decision);
  merged._meta = {
    runId: args.paths.runId,
    round: args.round,
    exchangeId: makeExchangeId(args.paths.runId, "review", args.round, "panel"),
  };
  return { merged, members };
}

async function captureRoundDiff(
  paths: RunPaths,
  round: number,
  config: OrchestratorConfig,
  baseRunsDir: string,
  extraIgnorePrefixesAbs: string[] = [],
): Promise<DiffSummary> {
  const raw = await captureDiff(config.projectRoot);
  const ignore = [
    ...relativeIgnorePrefixes(config.projectRoot, baseRunsDir),
    ...extraIgnorePrefixesAbs.flatMap((p) => relativeIgnorePrefixes(config.projectRoot, p)),
  ];
  const changedFiles = raw.changedFiles.filter(
    (cf) => !ignore.some((prefix) => cf.path === prefix || cf.path.startsWith(prefix + "/")),
  );
  const patch = stripIgnoredFromPatch(raw.patch, ignore);
  await writeFile(paths.patchFile, patch, "utf8");
  await writeFile(
    path.join(paths.runDir, "rounds", `patch.r${round}.diff`),
    patch,
    "utf8",
  );
  const detection = detectRisks(changedFiles, config);
  const summary: DiffSummary = {
    patchPath: paths.patchFile,
    changedFiles,
    detectedRisks: detection.detected,
    pathViolations: detection.pathViolations,
  };
  await writeJson(
    path.join(paths.runDir, "rounds", `changed_files.r${round}.json`),
    summary,
  );
  return summary;
}

function relativeIgnorePrefixes(projectRoot: string, baseRunsDir: string): string[] {
  const out = new Set<string>();
  // Canonicalize both paths to handle symlinks (e.g. macOS /private/var ↔ /var).
  const resolve = (p: string): string => {
    try {
      return fsSync.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  for (const projectVariant of [path.resolve(projectRoot), resolve(projectRoot)]) {
    for (const baseVariant of [path.resolve(baseRunsDir), resolve(baseRunsDir)]) {
      const rel = path.relative(projectVariant, baseVariant).replace(/\\/g, "/");
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        out.add(rel);
      }
    }
  }
  return [...out];
}

function stripIgnoredFromPatch(patch: string, ignorePrefixes: string[]): string {
  if (ignorePrefixes.length === 0) return patch;
  const lines = patch.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const m = /^# \+ (.+)$/.exec(line);
    if (m && m[1]) {
      const p = m[1];
      if (ignorePrefixes.some((pref) => p === pref || p.startsWith(pref + "/"))) continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function renderPromptForLog(input: WorkerInput): string {
  const parts: string[] = [];
  parts.push(`# role: ${input.role}`);
  parts.push(`# cwd: ${input.cwd}`);
  parts.push(`# timeout: ${input.timeoutSeconds}s`);
  parts.push("");
  parts.push("## prompt");
  parts.push(input.prompt);
  if (input.artifacts.length > 0) {
    parts.push("");
    parts.push("## artifacts");
    for (const a of input.artifacts) {
      parts.push(`### ${a.name}${a.description ? ` — ${a.description}` : ""}`);
      if (a.path) parts.push(`(path: ${a.path})`);
      if (a.content) {
        parts.push("```");
        parts.push(a.content.length > 2000 ? a.content.slice(0, 2000) + "\n…[truncated]…" : a.content);
        parts.push("```");
      }
    }
  }
  return parts.join("\n");
}

// -------------------------- helpers --------------------------------------

function computeStatus(args: {
  requiresApproval: boolean;
  verifierPassed: boolean;
  verdict: ReviewArtifact["verdict"];
}): RunStatus {
  if (args.requiresApproval) return "requires_approval";
  if (!args.verifierPassed) return "verifier_failed";
  if (args.verdict === "approve") return "approved";
  if (args.verdict === "request_changes") return "review_changes_requested";
  return "requires_approval";
}

function extractTaskTitle(taskRaw: string): string {
  for (const line of taskRaw.split("\n")) {
    const m = /^#\s+(.*)/.exec(line.trim());
    if (m && m[1]) return m[1].trim();
  }
  return taskRaw.split("\n")[0]?.trim().slice(0, 60) || "task";
}

function fallbackPlan(taskRaw: string, taskTitle: string): PlanArtifact {
  const targetFiles = Array.from(
    new Set(
      Array.from(taskRaw.matchAll(/`([^`]+)`/g))
        .map((m) => m[1]!)
        .filter((s) => /[/.]/.test(s) && !s.includes(" "))
        .slice(0, 10),
    ),
  );
  return {
    summary: `Fallback plan generated without Claude. Task: ${taskTitle}`,
    target_files: targetFiles,
    risk_level: "medium",
    risky_operations: [],
    proposed_steps: [
      "Read the task description carefully.",
      "Identify the smallest set of files that need to change.",
      "Implement the change with accompanying tests.",
      "Run the verifier suite.",
    ],
    verification_strategy: ["Run configured verifier commands."],
  };
}

function fallbackReview(diff: DiffSummary, verifier: VerifierReport | null): ReviewArtifact {
  if (diff.pathViolations.length > 0 || diff.detectedRisks.length > 0) {
    return {
      verdict: "requires_human_review",
      bugs: [],
      missing_tests: [],
      risks: [
        ...diff.detectedRisks.map((r) => `risky operation detected: ${r}`),
        ...diff.pathViolations.map((p) => `change outside allowed paths: ${p}`),
      ],
      recommended_fixes: [],
    };
  }
  // If a previous verifier round failed, push back so the implementer addresses it.
  if (verifier && !verifier.passed) {
    return {
      verdict: "request_changes",
      bugs: verifier.results
        .filter((r) => !r.ok)
        .map((r) => `previous verifier round failed: \`${r.command}\` (exit ${r.exitCode})`),
      missing_tests: [],
      risks: [],
      recommended_fixes: ["Fix the failing verifier commands from the previous round."],
    };
  }
  // Approve so the verifier can confirm. (verifier === null means round 1, no prior signal.)
  return {
    verdict: "approve",
    bugs: [],
    missing_tests: [],
    risks: [],
    recommended_fixes: [],
  };
}

function normalizePlan(json: Partial<PlanArtifact>, taskRaw: string, taskTitle: string): PlanArtifact {
  const fb = fallbackPlan(taskRaw, taskTitle);
  return {
    summary: typeof json.summary === "string" ? json.summary : fb.summary,
    target_files: Array.isArray(json.target_files) ? (json.target_files as string[]) : fb.target_files,
    risk_level:
      json.risk_level === "low" || json.risk_level === "medium" || json.risk_level === "high"
        ? json.risk_level
        : fb.risk_level,
    risky_operations: Array.isArray(json.risky_operations) ? (json.risky_operations as string[]) : [],
    proposed_steps: Array.isArray(json.proposed_steps) ? (json.proposed_steps as string[]) : fb.proposed_steps,
    verification_strategy: Array.isArray(json.verification_strategy)
      ? (json.verification_strategy as string[])
      : fb.verification_strategy,
  };
}

function normalizeReview(
  json: Partial<ReviewArtifact>,
  diff: DiffSummary,
  verifier: VerifierReport | null,
): ReviewArtifact {
  const fb = fallbackReview(diff, verifier);
  const verdict =
    json.verdict === "approve" ||
    json.verdict === "request_changes" ||
    json.verdict === "requires_human_review"
      ? json.verdict
      : fb.verdict;
  return {
    verdict,
    bugs: Array.isArray(json.bugs) ? (json.bugs as string[]) : fb.bugs,
    missing_tests: Array.isArray(json.missing_tests) ? (json.missing_tests as string[]) : fb.missing_tests,
    risks: Array.isArray(json.risks) ? (json.risks as string[]) : fb.risks,
    recommended_fixes: Array.isArray(json.recommended_fixes)
      ? (json.recommended_fixes as string[])
      : fb.recommended_fixes,
  };
}
