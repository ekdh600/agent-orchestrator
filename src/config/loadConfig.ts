import { readFile } from "node:fs/promises";
import path from "node:path";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "./schema.js";

export class ConfigError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ConfigError";
    this.cause = cause;
  }
}

/**
 * Load and validate an orchestrator config file.
 * Resolves `projectRoot` relative to the directory containing the config file
 * so configs are portable across machines.
 */
export async function loadConfig(configPath: string): Promise<OrchestratorConfig> {
  const absConfig = path.resolve(configPath);
  let raw: string;
  try {
    raw = await readFile(absConfig, "utf8");
  } catch (err) {
    throw new ConfigError(`Could not read config file at ${absConfig}`, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config at ${absConfig} is not valid JSON`, err);
  }

  const result = OrchestratorConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid orchestrator config:\n${issues}`);
  }

  const cfg = result.data;
  const configDir = path.dirname(absConfig);
  const resolvedRoot = path.resolve(configDir, cfg.projectRoot);
  return { ...cfg, projectRoot: resolvedRoot };
}

/** Return a default config used when no file is provided. */
export function defaultConfig(projectRoot: string): OrchestratorConfig {
  return OrchestratorConfigSchema.parse({
    projectRoot,
    maxRounds: 3,
    timeoutSeconds: 900,
    workers: {},
    verifier: { commands: [] },
    safety: {},
  });
}
