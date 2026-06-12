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
import type { ProjectSpec } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadClarifyPrompt(): Promise<string> {
  const candidates = [
    path.join(HERE, "prompts", "clarify.claude.md"),
    path.join(HERE, "..", "..", "src", "project", "prompts", "clarify.claude.md"),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error("Could not find clarify.claude.md prompt template");
}

export interface ClarificationQuestion {
  question: string;
  why: string;
  default_assumption: string;
}

export interface ClarificationResult {
  ready: boolean;
  questions: ClarificationQuestion[];
  assumptions: string[];
  _meta?: ArtifactMeta;
}

export interface ClarifyArgs {
  spec: ProjectSpec;
  config: OrchestratorConfig;
  safetyPolicy: SafetyPolicy;
  worker: Worker;
  model?: string;
  logDir: string;
  log: (msg: string) => void;
}

const SKIP: ClarificationResult = { ready: true, questions: [], assumptions: [] };

/**
 * Interview the spec for ambiguities before decomposition.
 *
 * Fails OPEN: a disabled worker, unparseable JSON, or a failed echo check all
 * skip the gate (ready=true) — clarification must never block a project on an
 * orchestrator-side failure. Open questions only ever come from a verified
 * model response.
 */
export async function clarifySpec(args: ClarifyArgs): Promise<ClarificationResult> {
  if (!args.worker.enabled) {
    args.log("clarifier worker disabled — skipping interview gate");
    return SKIP;
  }

  const prompt = await loadClarifyPrompt();
  const exchangeId = makeExchangeId(path.basename(args.logDir), "clarify");
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
      tag: attempt === 1 ? "project.clarify" : "project.clarify.retry",
      model: args.model,
      artifacts: [{ name: "project_spec.md", content: args.spec.body }],
    };
    args.log(attempt === 1 ? "running clarifier (interview mode)…" : "clarifier echo check failed — retrying once");
    const result = await args.worker.run(input);

    const parsed = result.parsedJson ?? extractJson(result.stdout);
    if (!parsed || typeof parsed !== "object") {
      args.log("clarifier returned unparseable JSON — skipping interview gate");
      return SKIP;
    }
    if (verifyEcho(parsed, exchangeId)) {
      const normalized = normalizeClarification(stripEcho(parsed));
      normalized._meta = { runId: path.basename(args.logDir), round: null, exchangeId };
      return normalized;
    }
  }
  args.log(`protocol_error: clarifier payload discarded (exchange ${exchangeId}) — skipping interview gate`);
  return SKIP;
}

function normalizeClarification(raw: unknown): ClarificationResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const questions: ClarificationQuestion[] = Array.isArray(r.questions)
    ? r.questions
        .map((q) => {
          const qq = (q ?? {}) as Record<string, unknown>;
          return {
            question: typeof qq.question === "string" ? qq.question.trim() : "",
            why: typeof qq.why === "string" ? qq.why.trim() : "",
            default_assumption: typeof qq.default_assumption === "string" ? qq.default_assumption.trim() : "",
          };
        })
        .filter((q) => q.question.length > 0)
    : [];
  const assumptions = Array.isArray(r.assumptions)
    ? r.assumptions.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    : [];
  return {
    ready: questions.length === 0 ? true : r.ready === true,
    questions,
    assumptions,
  };
}

/**
 * Interview mode "auto": adopt every open question's default assumption and
 * record everything in the spec so all downstream prompts see it.
 */
export function specWithAdoptedAssumptions(spec: ProjectSpec, clarification: ClarificationResult): ProjectSpec {
  if (clarification.questions.length === 0 && clarification.assumptions.length === 0) return spec;
  const lines: string[] = [spec.body.trimEnd(), "", "## Assumptions (auto-adopted)", ""];
  lines.push(
    "_The clarifier raised the following points; the orchestrator adopted each default assumption (interview mode: auto)._",
    "",
  );
  for (const q of clarification.questions) {
    lines.push(`- **Q:** ${q.question}`);
    lines.push(`  **Adopted:** ${q.default_assumption || "(no default given — use the most conservative reading)"}`);
  }
  for (const a of clarification.assumptions) {
    lines.push(`- ${a}`);
  }
  lines.push("");
  return { ...spec, body: lines.join("\n") };
}
