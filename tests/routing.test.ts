import { describe, it, expect } from "vitest";
import { OrchestratorConfigSchema } from "../src/config/schema.js";
import { resolveMaxRounds, resolveStage, RoutingError } from "../src/orchestration/routing.js";
import { MockWorker } from "../src/workers/MockWorker.js";

function makeWorkers() {
  return {
    claude: new MockWorker({ name: "claude" }),
    codex: new MockWorker({ name: "codex" }),
    cursor: new MockWorker({ name: "cursor", enabled: false }),
  };
}

const baseConfig = {
  projectRoot: ".",
  maxRounds: 3,
  workers: {
    claude: { enabled: true, command: "claude", args: ["-p"] },
    codex: { enabled: true, command: "codex", args: ["exec"] },
  },
};

describe("resolveStage", () => {
  it("falls back to the built-in stage→worker mapping when routing is unconfigured", () => {
    const config = OrchestratorConfigSchema.parse(baseConfig);
    const workers = makeWorkers();
    expect(resolveStage({ stage: "plan", config, workers }).workerName).toBe("claude");
    expect(resolveStage({ stage: "implement", config, workers }).workerName).toBe("codex");
    expect(resolveStage({ stage: "review", config, workers }).workerName).toBe("claude");
    expect(resolveStage({ stage: "repair", config, workers }).workerName).toBe("codex");
    expect(resolveStage({ stage: "decompose", config, workers }).workerName).toBe("claude");
    expect(resolveStage({ stage: "plan", config, workers }).model).toBeUndefined();
    expect(resolveStage({ stage: "plan", config, workers }).explicit).toBe(false);
  });

  it("stage route overrides the default; category route overrides the stage route", () => {
    const config = OrchestratorConfigSchema.parse({
      ...baseConfig,
      routing: {
        stages: {
          review: { model: "sonnet" },
          implement: { worker: "claude", model: "opus" },
        },
        categories: {
          quick: {
            implement: { worker: "codex", model: "mini" },
            review: { model: "haiku" },
          },
        },
      },
    });
    const workers = makeWorkers();

    // stage route only
    const reviewDefault = resolveStage({ stage: "review", config, workers });
    expect(reviewDefault.workerName).toBe("claude");
    expect(reviewDefault.model).toBe("sonnet");

    const implStage = resolveStage({ stage: "implement", config, workers });
    expect(implStage.workerName).toBe("claude");
    expect(implStage.model).toBe("opus");
    expect(implStage.explicit).toBe(true);

    // category overrides stage
    const implQuick = resolveStage({ stage: "implement", category: "quick", config, workers });
    expect(implQuick.workerName).toBe("codex");
    expect(implQuick.model).toBe("mini");

    const reviewQuick = resolveStage({ stage: "review", category: "quick", config, workers });
    expect(reviewQuick.workerName).toBe("claude"); // worker from stage default
    expect(reviewQuick.model).toBe("haiku"); // model from category

    // unknown category in config → ignored, falls through
    const reviewDeep = resolveStage({ stage: "review", category: "deep", config, workers });
    expect(reviewDeep.model).toBe("sonnet");
  });

  it("throws loudly when config explicitly routes to a disabled or unknown worker", () => {
    const config = OrchestratorConfigSchema.parse({
      ...baseConfig,
      routing: {
        stages: { plan: { worker: "cursor" } },
        categories: { deep: { review: { worker: "nonexistent" } } },
      },
    });
    const workers = makeWorkers(); // cursor disabled

    expect(() => resolveStage({ stage: "plan", config, workers })).toThrow(RoutingError);
    expect(() => resolveStage({ stage: "plan", config, workers })).toThrow(/disabled/);
    expect(() => resolveStage({ stage: "review", category: "deep", config, workers })).toThrow(/unknown worker/);
  });

  it("does NOT throw for the built-in default resolving to a disabled worker (fallback paths handle it)", () => {
    const config = OrchestratorConfigSchema.parse(baseConfig);
    const workers = {
      claude: new MockWorker({ name: "claude", enabled: false }),
      codex: new MockWorker({ name: "codex" }),
    };
    const route = resolveStage({ stage: "plan", config, workers });
    expect(route.workerName).toBe("claude");
    expect(route.worker.enabled).toBe(false);
  });
});

describe("resolveMaxRounds", () => {
  it("uses the category override when present, else the global maxRounds", () => {
    const config = OrchestratorConfigSchema.parse({
      ...baseConfig,
      maxRounds: 5,
      routing: { categories: { quick: { maxRounds: 1 } } },
    });
    expect(resolveMaxRounds(config)).toBe(5);
    expect(resolveMaxRounds(config, "quick")).toBe(1);
    expect(resolveMaxRounds(config, "deep")).toBe(5);
  });
});
