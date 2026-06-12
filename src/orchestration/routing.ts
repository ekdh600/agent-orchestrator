import type { OrchestratorConfig } from "../config/schema.js";
import type { Worker } from "../workers/Worker.js";

/**
 * Stage → worker/model routing.
 *
 * Resolution order for each stage:
 *   1. `routing.categories[<task category>][<stage>]`   (category override)
 *   2. `routing.stages[<stage>]`                        (per-stage default)
 *   3. built-in mapping (plan/review/decompose → claude, implement/repair → codex)
 *
 * A worker named EXPLICITLY by config must exist and be enabled — silent
 * fallback would mask a misconfiguration. The built-in defaults may resolve
 * to a disabled worker; callers already handle that (deterministic fallback
 * for plan/review/decompose, skip for implement/repair).
 */

export type RoutableStage = "plan" | "implement" | "review" | "repair" | "decompose";

/** Conventional categories the decomposer assigns. Free-form in config. */
export type TaskCategory = "quick" | "standard" | "deep";
export const TASK_CATEGORIES: readonly TaskCategory[] = ["quick", "standard", "deep"];

const DEFAULT_STAGE_WORKER: Record<RoutableStage, string> = {
  plan: "claude",
  implement: "codex",
  review: "claude",
  repair: "codex",
  decompose: "claude",
};

export interface ResolvedRoute {
  worker: Worker;
  workerName: string;
  model?: string;
  /** True when config (stage or category route) explicitly named the worker. */
  explicit: boolean;
}

export class RoutingError extends Error {}

export function resolveStage(args: {
  stage: RoutableStage;
  category?: string;
  config: OrchestratorConfig;
  /** Workers available to this run, keyed by name. */
  workers: Record<string, Worker | undefined>;
}): ResolvedRoute {
  const { stage, category, config } = args;
  const stageRoute = config.routing.stages[stage];
  const categoryRoute = category ? config.routing.categories[category]?.[stage] : undefined;

  const explicitName = categoryRoute?.worker ?? stageRoute?.worker;
  const workerName = explicitName ?? DEFAULT_STAGE_WORKER[stage];
  const model = categoryRoute?.model ?? stageRoute?.model;

  const worker = args.workers[workerName];
  if (!worker) {
    throw new RoutingError(
      `routing: stage "${stage}"${category ? ` (category "${category}")` : ""} is routed to unknown worker "${workerName}" — available: ${Object.keys(args.workers).filter((k) => args.workers[k]).join(", ")}`,
    );
  }
  if (explicitName && !worker.enabled) {
    throw new RoutingError(
      `routing: stage "${stage}"${category ? ` (category "${category}")` : ""} is explicitly routed to worker "${workerName}", but that worker is disabled. Enable it in workers.${workerName} or remove the route.`,
    );
  }
  return { worker, workerName, model, explicit: Boolean(explicitName) };
}

/** Effective repair-loop budget: category override wins over the global maxRounds. */
export function resolveMaxRounds(config: OrchestratorConfig, category?: string): number {
  if (category) {
    const override = config.routing.categories[category]?.maxRounds;
    if (override !== undefined) return override;
  }
  return config.maxRounds;
}
