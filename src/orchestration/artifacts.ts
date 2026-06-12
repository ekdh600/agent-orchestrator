import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

export function timestampSlug(date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

export function slugify(input: string, max = 40): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug || "task";
}

export interface RunPaths {
  runId: string;
  runDir: string;
  taskFile: string;
  configFile: string;
  planFile: string;
  patchFile: string;
  changedFilesFile: string;
  verifierFile: string;
  reviewFile: string;
  reportFile: string;
  logsDir: string;
}

export async function createRunDir(baseDir: string, slug: string, date = new Date()): Promise<RunPaths> {
  const runId = `${timestampSlug(date)}-${slugify(slug)}`;
  const runDir = path.resolve(baseDir, runId);
  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(runDir, "logs"), { recursive: true });
  await mkdir(path.join(runDir, "rounds"), { recursive: true });
  return {
    runId,
    runDir,
    taskFile: path.join(runDir, "task.md"),
    configFile: path.join(runDir, "config.resolved.json"),
    planFile: path.join(runDir, "plan.json"),
    patchFile: path.join(runDir, "patch.diff"),
    changedFilesFile: path.join(runDir, "changed_files.json"),
    verifierFile: path.join(runDir, "verifier.json"),
    reviewFile: path.join(runDir, "review.json"),
    reportFile: path.join(runDir, "final_report.md"),
    logsDir: path.join(runDir, "logs"),
  };
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function writeText(file: string, value: string): Promise<void> {
  await writeFile(file, value, "utf8");
}

export async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}

export async function readJson<T>(file: string): Promise<T> {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as T;
}
