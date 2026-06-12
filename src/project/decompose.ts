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
} from "../orchestration/envelope.js";
import { extractJson } from "../utils/jsonExtract.js";
import { redactedTail } from "../utils/redact.js";
import type { Worker, WorkerInput, SafetyPolicy } from "../workers/Worker.js";
import type {
  BacklogTask,
  DecompositionResult,
  ProjectSpec,
  TaskCategory,
  TaskKind,
} from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadDecomposePrompt(): Promise<string> {
  const candidates = [
    path.join(HERE, "prompts", "decompose.claude.md"),
    path.join(HERE, "..", "..", "src", "project", "prompts", "decompose.claude.md"),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error("Could not find decompose.claude.md prompt template");
}

export interface DecomposeArgs {
  spec: ProjectSpec;
  config: OrchestratorConfig;
  safetyPolicy: SafetyPolicy;
  workers: { claude: Worker };
  /** Model override from routing (stage "decompose"). */
  model?: string;
  logDir: string;
  log: (msg: string) => void;
  /** Optional record of the raw model response, for the timeline. */
  onRawResponse?: (raw: string) => void;
}

/**
 * Produce an ordered, dependency-aware backlog from the project spec.
 *
 * If the Claude worker is disabled or returns unparseable output, falls back
 * to a deterministic decomposer that reads top-level bullet points / H2
 * sections from the spec.
 */
export async function decomposeProject(args: DecomposeArgs): Promise<DecompositionResult> {
  if (!args.workers.claude.enabled) {
    args.log("claude disabled — using deterministic fallback decomposer");
    return fallbackDecompose(args.spec);
  }

  const prompt = await loadDecomposePrompt();
  // logDir is the project directory; its basename is the projectId.
  const exchangeId = makeExchangeId(path.basename(args.logDir), "decompose");
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
      tag: attempt === 1 ? "project.decompose" : "project.decompose.retry",
      model: args.model,
      artifacts: [
        { name: "project_spec.md", content: args.spec.body },
        {
          name: "safety_policy.md",
          content:
            `Allowed paths: ${args.safetyPolicy.allowedPaths.join(", ") || "(any)"}\n` +
            `Approval required for: ${args.safetyPolicy.approvalRequiredFor.join(", ")}`,
        },
      ],
    };
    args.log(attempt === 1 ? "running decomposer (claude)…" : "decomposer echo check failed — retrying once");
    const result = await args.workers.claude.run(input);
    args.onRawResponse?.(redactedTail(result.stdout, 8000));

    const parsed = (result.parsedJson ?? extractJson(result.stdout)) as RawDecomposition | null;
    if (!parsed || typeof parsed !== "object") {
      args.log("decomposer returned unparseable JSON — using fallback");
      return fallbackDecompose(args.spec);
    }
    if (verifyEcho(parsed, exchangeId)) {
      const decomposition = normalizeDecomposition(stripEcho(parsed), args.spec);
      decomposition._meta = { runId: path.basename(args.logDir), round: null, exchangeId };
      return decomposition;
    }
  }
  args.log(`protocol_error: decomposer payload discarded (exchange ${exchangeId}) — using fallback`);
  return fallbackDecompose(args.spec);
}

interface RawDecomposition {
  summary?: unknown;
  definition_of_done?: unknown;
  tasks?: unknown;
}

function normalizeDecomposition(raw: RawDecomposition, spec: ProjectSpec): DecompositionResult {
  const fb = fallbackDecompose(spec);
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.map((t, i) => normalizeTask(t, i)) : [];
  if (tasks.length === 0) return fb;
  // Sort tasks: any task whose deps are all earlier in the list stays where it is;
  // otherwise we topo-sort to avoid forward dependencies.
  const ordered = topoSort(tasks);
  return {
    summary: typeof raw.summary === "string" ? raw.summary : fb.summary,
    definitionOfDone: {
      conditions: Array.isArray(raw.definition_of_done)
        ? raw.definition_of_done.filter((c): c is string => typeof c === "string")
        : fb.definitionOfDone.conditions,
    },
    tasks: ordered,
  };
}

function normalizeTask(raw: unknown, index: number): BacklogTask {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = typeof r.id === "string" && /^T\d{2,}$/.test(r.id) ? r.id : `T${String(index + 1).padStart(2, "0")}`;
  const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : `Task ${id}`;
  const description = typeof r.description === "string" ? r.description : "";
  const kind: TaskKind =
    r.kind === "setup" ||
    r.kind === "impl" ||
    r.kind === "test" ||
    r.kind === "doc" ||
    r.kind === "fix" ||
    r.kind === "verify"
      ? r.kind
      : "impl";
  const depends_on = Array.isArray(r.depends_on)
    ? r.depends_on.filter((x): x is string => typeof x === "string")
    : [];
  const allowed_paths = Array.isArray(r.allowed_paths)
    ? r.allowed_paths.filter((x): x is string => typeof x === "string")
    : undefined;
  const acknowledged_risks = Array.isArray(r.acknowledged_risks)
    ? r.acknowledged_risks.filter((x): x is string => typeof x === "string")
    : undefined;
  const estimated_complexity =
    r.estimated_complexity === "low" || r.estimated_complexity === "medium" || r.estimated_complexity === "high"
      ? r.estimated_complexity
      : "medium";
  const category: TaskCategory =
    r.category === "quick" || r.category === "standard" || r.category === "deep"
      ? r.category
      : // derive from complexity when the decomposer omits it
        estimated_complexity === "low"
        ? "quick"
        : estimated_complexity === "high"
          ? "deep"
          : "standard";
  return {
    id,
    title,
    description,
    kind,
    depends_on,
    ...(allowed_paths !== undefined ? { allowed_paths } : {}),
    ...(acknowledged_risks !== undefined ? { acknowledged_risks } : {}),
    category,
    estimated_complexity,
    status: "pending",
    attempts: 0,
  };
}

/**
 * Topologically sort tasks. If a cycle is detected, falls back to the original
 * order — the scheduler will still surface unsatisfied dependencies as blocked.
 */
function topoSort(tasks: BacklogTask[]): BacklogTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: BacklogTask[] = [];
  let hasCycle = false;
  const visit = (t: BacklogTask) => {
    if (visited.has(t.id)) return;
    if (visiting.has(t.id)) {
      hasCycle = true;
      return;
    }
    visiting.add(t.id);
    for (const dep of t.depends_on) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    visiting.delete(t.id);
    visited.add(t.id);
    out.push(t);
  };
  for (const t of tasks) visit(t);
  return hasCycle ? tasks : out;
}

/**
 * Deterministic fallback. Pulls H2 sections or top-level bullet points out of
 * the spec body and turns each into a task. Always appends a final verify task.
 */
export function fallbackDecompose(spec: ProjectSpec): DecompositionResult {
  const candidates: { title: string; body: string }[] = [];

  // 1. H2 sections
  const lines = spec.body.split("\n");
  let curHeader: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (curHeader) {
      candidates.push({ title: curHeader, body: buf.join("\n").trim() });
    }
  };
  for (const line of lines) {
    const m = /^##\s+(.+)/.exec(line.trim());
    if (m) {
      flush();
      curHeader = m[1]!.trim();
      buf = [];
    } else if (curHeader) {
      buf.push(line);
    }
  }
  flush();

  // 2. If no H2s, look for top-level "- " bullets.
  if (candidates.length === 0) {
    for (const line of lines) {
      const m = /^[-*]\s+(.+)/.exec(line);
      if (m) {
        candidates.push({ title: m[1]!.trim().slice(0, 80), body: m[1]!.trim() });
      }
    }
  }

  // 3. Last resort — single task that says "implement everything".
  if (candidates.length === 0) {
    candidates.push({
      title: `Implement: ${spec.title}`,
      body: spec.body || "Implement the project as described.",
    });
  }

  const tasks: BacklogTask[] = candidates.slice(0, 12).map((c, i) => ({
    id: `T${String(i + 1).padStart(2, "0")}`,
    title: c.title,
    description: c.body,
    kind: classifyKindFromTitle(c.title),
    depends_on: i === 0 ? [] : [`T${String(i).padStart(2, "0")}`],
    estimated_complexity: "medium",
    status: "pending",
    attempts: 0,
  }));

  // Append a verify task.
  const verifyId = `T${String(tasks.length + 1).padStart(2, "0")}`;
  tasks.push({
    id: verifyId,
    title: "Verify project against definition of done",
    description: "Run the verifier suite and confirm every condition in the definition of done holds.",
    kind: "verify",
    depends_on: tasks.map((t) => t.id),
    estimated_complexity: "low",
    status: "pending",
    attempts: 0,
  });

  return {
    summary: `Fallback decomposition of: ${spec.title}`,
    definitionOfDone: {
      conditions: [
        "All tasks reach `done` status.",
        "The verifier commands all pass.",
        "No `requires_approval` blockers remain.",
      ],
    },
    tasks,
  };
}

function classifyKindFromTitle(title: string): TaskKind {
  const t = title.toLowerCase();
  if (/(test|spec)\b/.test(t)) return "test";
  if (/(setup|init|scaffold|config|install)/.test(t)) return "setup";
  if (/(doc|readme|guide)/.test(t)) return "doc";
  if (/(fix|bug)/.test(t)) return "fix";
  if (/(verify|validate|check)/.test(t)) return "verify";
  return "impl";
}
