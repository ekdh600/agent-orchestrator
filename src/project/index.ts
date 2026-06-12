export { runProject, type RunProjectOptions, type ProjectProgressEvent } from "./runProject.js";
export { decomposeProject, fallbackDecompose } from "./decompose.js";
export { pickNextTask, pickReadyTasks, pathSetsOverlap, applyTaskOutcome, backlogProgress } from "./scheduler.js";
export {
  createProjectDir,
  saveBacklog,
  loadBacklog,
  saveState,
  appendTimeline,
  saveReport,
  updateStateAfterTask,
  type ProjectPaths,
  type TimelineEvent,
} from "./stateStore.js";
export {
  DEFAULT_BUDGET,
  DEFAULT_PROJECT_OPTIONS,
  type BacklogTask,
  type Backlog,
  type ProjectSpec,
  type ProjectState,
  type ProjectBudget,
  type ProjectOptions,
  type ProjectReport,
  type ProjectStatus,
  type TaskKind,
  type TaskStatus,
  type TaskExecution,
  type DecompositionResult,
  type DefinitionOfDone,
} from "./types.js";

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectSpec } from "./types.js";

/**
 * Read a project spec from disk, extracting a title from the first H1 (or the
 * first non-empty line if there is no heading).
 */
export async function loadProjectSpec(specPath: string): Promise<ProjectSpec> {
  const abs = path.resolve(specPath);
  const body = await readFile(abs, "utf8");
  return { title: extractTitle(body), body, source: abs };
}

export function specFromText(body: string, source = "<inline>"): ProjectSpec {
  return { title: extractTitle(body), body, source };
}

function extractTitle(body: string): string {
  for (const line of body.split("\n")) {
    const m = /^#\s+(.*)/.exec(line.trim());
    if (m && m[1]) return m[1].trim();
  }
  return body.split("\n").find((l) => l.trim())?.trim().slice(0, 60) || "project";
}
