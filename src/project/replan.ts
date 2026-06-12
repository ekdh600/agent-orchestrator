import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OrchestratorConfig } from "../config/schema.js";
import {
  makeExchangeId,
  renderEnvelope,
  renderEchoRetryReminder,
  stripEcho,
  verifyEcho,
  type ArtifactMeta,
} from "../orchestration/envelope.js";
import { extractJson } from "../utils/jsonExtract.js";
import type { Worker, WorkerInput, SafetyPolicy } from "../workers/Worker.js";
import type { Backlog, BacklogTask, ProjectSpec, TaskCategory, TaskExecution, TaskKind } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadReplanPrompt(): Promise<string> {
  const candidates = [
    path.join(HERE, "prompts", "replan.claude.md"),
    path.join(HERE, "..", "..", "src", "project", "prompts", "replan.claude.md"),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error("Could not find replan.claude.md prompt template");
}

export interface ReplanResult {
  notes: string;
  tasks: BacklogTask[];
  _meta?: ArtifactMeta;
}

export interface ReplanArgs {
  spec: ProjectSpec;
  backlog: Backlog;
  /** Failed/blocked tasks eligible for replanning (needs_approval excluded by caller). */
  failedTasks: BacklogTask[];
  executions: TaskExecution[];
  /** 1-based replan round, used for replacement task ids (R<n>-T01). */
  replanRound: number;
  config: OrchestratorConfig;
  safetyPolicy: SafetyPolicy;
  worker: Worker;
  model?: string;
  logDir: string;
  log: (msg: string) => void;
}

const NO_REPLAN: ReplanResult = { notes: "", tasks: [] };

/**
 * Ask the replanner to replace failed/blocked tasks with a different approach.
 *
 * Fails CLOSED: a disabled worker, unparseable JSON, or a failed echo check
 * yields an empty replan — the project then stops with its normal
 * stopped_blocked / stopped_failures status. Hard guarantees (budgets,
 * needs_approval exclusion, stall detection) are enforced by the caller.
 */
export async function replanProject(args: ReplanArgs): Promise<ReplanResult> {
  if (!args.worker.enabled) {
    args.log("replanner worker disabled — no replan");
    return NO_REPLAN;
  }
  if (args.failedTasks.length === 0) return NO_REPLAN;

  const prompt = await loadReplanPrompt();
  const exchangeId = makeExchangeId(path.basename(args.logDir), "replan", args.replanRound);
  const envelope = renderEnvelope(exchangeId, { echoRequired: true });

  for (let attempt = 1; attempt <= 2; attempt++) {
    const input: WorkerInput = {
      role: "planner",
      prompt:
        attempt === 1
          ? `${prompt}\n\n${envelope}`
          : `${prompt}\n\n${envelope}\n\n${renderEchoRetryReminder(exchangeId)}`,
      cwd: args.config.projectRoot,
      timeoutSeconds: args.config.timeoutSeconds,
      logDir: args.logDir,
      safetyPolicy: args.safetyPolicy,
      tag: attempt === 1 ? `project.replan.${args.replanRound}` : `project.replan.${args.replanRound}.retry`,
      model: args.model,
      artifacts: [
        { name: "project_spec.md", content: args.spec.body },
        { name: "failed_tasks.md", content: renderFailedTasks(args.failedTasks, args.executions) },
        { name: "backlog.md", content: renderBacklog(args.backlog) },
      ],
    };
    args.log(
      attempt === 1
        ? `running replanner (round ${args.replanRound}, ${args.failedTasks.length} failed/blocked task(s))…`
        : "replanner echo check failed — retrying once",
    );
    const result = await args.worker.run(input);

    const parsed = result.parsedJson ?? extractJson(result.stdout);
    if (!parsed || typeof parsed !== "object") {
      args.log("replanner returned unparseable JSON — no replan");
      return NO_REPLAN;
    }
    if (verifyEcho(parsed, exchangeId)) {
      const normalized = normalizeReplan(stripEcho(parsed), args);
      normalized._meta = { runId: path.basename(args.logDir), round: args.replanRound, exchangeId };
      return normalized;
    }
  }
  args.log(`protocol_error: replanner payload discarded (exchange ${exchangeId}) — no replan`);
  return NO_REPLAN;
}

function normalizeReplan(raw: unknown, args: ReplanArgs): ReplanResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const replaceable = new Set(args.failedTasks.map((t) => t.id));
  const rawTasks = Array.isArray(r.tasks) ? r.tasks : [];

  const tasks: BacklogTask[] = [];
  for (const [i, rawTask] of rawTasks.entries()) {
    const t = (rawTask ?? {}) as Record<string, unknown>;
    const replaces = Array.isArray(t.replaces)
      ? t.replaces.filter((x): x is string => typeof x === "string" && replaceable.has(x))
      : [];
    // A replacement that doesn't (validly) replace anything is dropped — the
    // prompt requires `replaces`, and accepting it would grow the backlog
    // unboundedly across replan rounds.
    if (replaces.length === 0) continue;

    const kind: TaskKind =
      t.kind === "setup" || t.kind === "impl" || t.kind === "test" || t.kind === "doc" || t.kind === "fix" || t.kind === "verify"
        ? t.kind
        : "impl";
    const estimated_complexity =
      t.estimated_complexity === "low" || t.estimated_complexity === "medium" || t.estimated_complexity === "high"
        ? t.estimated_complexity
        : "medium";
    const category: TaskCategory =
      t.category === "quick" || t.category === "standard" || t.category === "deep" ? t.category : "standard";
    const allowed_paths = Array.isArray(t.allowed_paths)
      ? t.allowed_paths.filter((x): x is string => typeof x === "string")
      : undefined;
    const acknowledged_risks = Array.isArray(t.acknowledged_risks)
      ? t.acknowledged_risks.filter((x): x is string => typeof x === "string")
      : undefined;
    const depends_on = Array.isArray(t.depends_on)
      ? t.depends_on.filter((x): x is string => typeof x === "string")
      : [];

    tasks.push({
      id: `R${args.replanRound}-T${String(i + 1).padStart(2, "0")}`,
      title: typeof t.title === "string" && t.title.trim() ? t.title.trim() : `Replacement for ${replaces.join(", ")}`,
      description: typeof t.description === "string" ? t.description : "",
      kind,
      depends_on,
      replaces,
      ...(allowed_paths !== undefined ? { allowed_paths } : {}),
      ...(acknowledged_risks !== undefined ? { acknowledged_risks } : {}),
      category,
      estimated_complexity,
      status: "pending",
      attempts: 0,
    });
  }

  return {
    notes: typeof r.notes === "string" ? r.notes : "",
    tasks,
  };
}

/**
 * Apply a replan to the backlog:
 *   - replaced tasks → status "superseded"
 *   - dependents of a replaced task get the dep rewritten to the replacement id(s)
 *   - tasks blocked (only) by replaced tasks go back to "pending" so the
 *     scheduler re-evaluates them
 *   - replacement tasks are appended
 */
export function applyReplan(backlog: Backlog, replacements: BacklogTask[]): Backlog {
  const replacedBy = new Map<string, string[]>();
  for (const task of replacements) {
    for (const old of task.replaces ?? []) {
      replacedBy.set(old, [...(replacedBy.get(old) ?? []), task.id]);
    }
  }
  if (replacedBy.size === 0) return backlog;

  const rewritten = backlog.tasks.map((t) => {
    if (replacedBy.has(t.id)) {
      return { ...t, status: "superseded" as const };
    }
    const deps = t.depends_on.flatMap((d) => replacedBy.get(d) ?? [d]);
    const depsChanged = deps.length !== t.depends_on.length || deps.some((d, i) => d !== t.depends_on[i]);
    const unblock = t.status === "blocked";
    if (!depsChanged && !unblock) return t;
    return {
      ...t,
      depends_on: deps,
      // Blocked tasks get a fresh chance — if they're still blocked by a
      // non-replaced failed dep, applyTaskOutcome's propagation will re-block
      // them on the next reconcile.
      ...(unblock ? { status: "pending" as const } : {}),
    };
  });

  return { tasks: [...rewritten, ...replacements] };
}

/**
 * Failure signature for stall detection: a replacement that fails "the same
 * way" as the task it replaced should not trigger yet another replan of the
 * same lineage.
 */
export function failureSignature(task: BacklogTask, executions: TaskExecution[]): string {
  const lastExec = [...executions].reverse().find((e) => e.taskId === task.id);
  const material = [
    task.kind,
    task.lastRunStatus ?? "",
    (task.lastError ?? "").slice(0, 200),
    ...(lastExec ? [...lastExec.changedFiles].sort() : []),
  ].join("|");
  return createHash("sha1").update(material).digest("hex").slice(0, 12);
}

/** Root of a replacement lineage: R2-T01 → its replaced ancestor chain root. */
export function lineageRoot(task: BacklogTask, backlog: Backlog): string {
  let current = task;
  const byId = new Map(backlog.tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  while (current.replaces && current.replaces.length > 0 && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.replaces[0]!);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

function renderFailedTasks(failed: BacklogTask[], executions: TaskExecution[]): string {
  const lines: string[] = [];
  for (const t of failed) {
    const lastExec = [...executions].reverse().find((e) => e.taskId === t.id);
    lines.push(`## ${t.id} — ${t.title} (${t.status})`);
    lines.push("");
    lines.push(`- kind: ${t.kind}, attempts: ${t.attempts}`);
    if (t.lastRunStatus) lines.push(`- last run status: ${t.lastRunStatus}`);
    if (t.lastError) lines.push(`- last error: ${t.lastError}`);
    if (lastExec && lastExec.changedFiles.length > 0) {
      lines.push(`- files touched in last attempt: ${lastExec.changedFiles.join(", ")}`);
    }
    lines.push("");
    lines.push("### Original description");
    lines.push("");
    lines.push(t.description || "(none)");
    lines.push("");
  }
  return lines.join("\n");
}

function renderBacklog(backlog: Backlog): string {
  return backlog.tasks
    .map((t) => `- ${t.id} [${t.status}] ${t.title}${t.depends_on.length ? ` (deps: ${t.depends_on.join(", ")})` : ""}`)
    .join("\n");
}
