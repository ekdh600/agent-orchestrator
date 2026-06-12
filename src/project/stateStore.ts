import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { redact } from "../utils/redact.js";
import type {
  Backlog,
  BacklogTask,
  ProjectReport,
  ProjectSpec,
  ProjectState,
  TaskExecution,
} from "./types.js";

/**
 * Disk layout for one project run:
 *
 *   projects/<projectId>/
 *   ├── spec.md
 *   ├── backlog.json          ← always reflects the current state of the backlog
 *   ├── state.json            ← cross-task working memory
 *   ├── timeline.jsonl        ← append-only audit log
 *   ├── decomposition.json    ← raw initial decomposition (immutable)
 *   ├── final_report.md       ← human-readable summary, written at the end
 *   ├── final_report.json     ← machine-readable ProjectReport
 *   └── tasks/                ← passed as baseRunsDir to runWorkflow per task
 *       └── <runId>/          ← (one per task execution)
 */
export interface ProjectPaths {
  projectId: string;
  projectDir: string;
  specFile: string;
  backlogFile: string;
  stateFile: string;
  decompositionFile: string;
  timelineFile: string;
  reportMdFile: string;
  reportJsonFile: string;
  tasksDir: string;
}

export type TimelineEvent =
  | { kind: "project_started"; ts: string; spec_title: string; budget: unknown }
  | { kind: "decomposed"; ts: string; task_count: number }
  | { kind: "task_picked"; ts: string; task_id: string; attempt: number }
  | { kind: "task_finished"; ts: string; task_id: string; run_id: string; status: string; attempt: number }
  | { kind: "task_failed"; ts: string; task_id: string; reason: string }
  | { kind: "task_blocked"; ts: string; task_id: string; reason: string }
  | { kind: "replan"; ts: string; details: string }
  | { kind: "clarified"; ts: string; question_count: number }
  | { kind: "assumptions_adopted"; ts: string; count: number }
  | { kind: "needs_clarification"; ts: string; question_count: number }
  | { kind: "budget_exhausted"; ts: string; reason: string }
  | { kind: "project_finished"; ts: string; status: string; stop_reason: string };

export async function createProjectDir(
  baseDir: string,
  spec: ProjectSpec,
  date = new Date(),
): Promise<ProjectPaths> {
  const projectId = makeProjectId(spec.title, date);
  const projectDir = path.resolve(baseDir, projectId);
  await mkdir(projectDir, { recursive: true });
  await mkdir(path.join(projectDir, "tasks"), { recursive: true });
  return {
    projectId,
    projectDir,
    specFile: path.join(projectDir, "spec.md"),
    backlogFile: path.join(projectDir, "backlog.json"),
    stateFile: path.join(projectDir, "state.json"),
    decompositionFile: path.join(projectDir, "decomposition.json"),
    timelineFile: path.join(projectDir, "timeline.jsonl"),
    reportMdFile: path.join(projectDir, "final_report.md"),
    reportJsonFile: path.join(projectDir, "final_report.json"),
    tasksDir: path.join(projectDir, "tasks"),
  };
}

export async function saveBacklog(paths: ProjectPaths, backlog: Backlog): Promise<void> {
  await writeFile(paths.backlogFile, JSON.stringify(backlog, null, 2) + "\n", "utf8");
}

export async function loadBacklog(paths: ProjectPaths): Promise<Backlog> {
  const raw = await readFile(paths.backlogFile, "utf8");
  return JSON.parse(raw) as Backlog;
}

export async function loadState(paths: ProjectPaths): Promise<ProjectState> {
  const raw = await readFile(paths.stateFile, "utf8");
  return JSON.parse(raw) as ProjectState;
}

/**
 * Re-attach to an existing project directory so a stopped run can be picked
 * up without losing the existing backlog / state / timeline.
 */
export function existingProjectPaths(baseDir: string, projectId: string): ProjectPaths {
  const projectDir = path.resolve(baseDir, projectId);
  return {
    projectId,
    projectDir,
    specFile: path.join(projectDir, "spec.md"),
    backlogFile: path.join(projectDir, "backlog.json"),
    stateFile: path.join(projectDir, "state.json"),
    decompositionFile: path.join(projectDir, "decomposition.json"),
    timelineFile: path.join(projectDir, "timeline.jsonl"),
    reportMdFile: path.join(projectDir, "final_report.md"),
    reportJsonFile: path.join(projectDir, "final_report.json"),
    tasksDir: path.join(projectDir, "tasks"),
  };
}

export async function saveState(paths: ProjectPaths, state: ProjectState): Promise<void> {
  await writeFile(paths.stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// Per-timeline-file monotonic sequence numbers. Initialized lazily from the
// existing line count so a resumed project continues where it left off.
// Timeline writes happen only from the single coordinator loop, so a simple
// in-process counter is sufficient.
const timelineSeq = new Map<string, number>();

async function nextTimelineSeq(timelineFile: string): Promise<number> {
  let next = timelineSeq.get(timelineFile);
  if (next === undefined) {
    try {
      const raw = await readFile(timelineFile, "utf8");
      next = raw.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      next = 0;
    }
  }
  timelineSeq.set(timelineFile, next + 1);
  return next;
}

export async function appendTimeline(paths: ProjectPaths, event: TimelineEvent): Promise<void> {
  const seq = await nextTimelineSeq(paths.timelineFile);
  const safe = JSON.parse(redact(JSON.stringify({ seq, ...event })));
  await appendFile(paths.timelineFile, JSON.stringify(safe) + "\n", "utf8");
}

export async function saveReport(paths: ProjectPaths, report: ProjectReport, markdown: string): Promise<void> {
  await writeFile(paths.reportJsonFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(paths.reportMdFile, markdown, "utf8");
}

/** Update the working state given a finished task. Does not mutate inputs. */
export function updateStateAfterTask(
  state: ProjectState,
  task: BacklogTask,
  exec: TaskExecution,
): ProjectState {
  const knownFiles = new Set(state.knownFiles);
  for (const f of exec.changedFiles) knownFiles.add(f);
  const taskNotes = { ...state.taskNotes };
  taskNotes[task.id] = `${task.title} → ${exec.status} (run ${exec.runId})`;

  const blockers = [...state.blockers];
  if (exec.status === "verifier_failed" || exec.status === "review_changes_requested") {
    blockers.push(`${task.id} attempt ${exec.attempt} ended with ${exec.status}`);
  }
  if (exec.status === "requires_approval") {
    blockers.push(`${task.id} requires human approval (run ${exec.runId})`);
  }

  return {
    summary: rebuildSummary(state, task, exec),
    knownFiles: [...knownFiles].sort(),
    blockers,
    taskNotes,
  };
}

function rebuildSummary(state: ProjectState, task: BacklogTask, exec: TaskExecution): string {
  const lines = state.summary ? state.summary.split("\n").slice(0, 20) : [];
  lines.push(`- [${exec.status}] ${task.id}: ${task.title}`);
  return lines.join("\n");
}

function makeProjectId(title: string, date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const ts =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "project";
  return `${ts}-${slug}`;
}
