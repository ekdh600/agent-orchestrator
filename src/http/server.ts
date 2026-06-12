import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import type { OrchestratorConfig } from "../config/schema.js";
import { runWorkflow } from "../orchestration/runWorkflow.js";
import { buildWorkers } from "../workers/factory.js";
import { runProject, specFromText, loadProjectSpec } from "../project/index.js";

export interface HttpServerOptions {
  config: OrchestratorConfig;
  baseRunsDir?: string;
  host?: string;
  port?: number;
  /** Optional shared-secret bearer token. If unset, the server binds to localhost only and is unauthenticated. */
  authToken?: string;
}

/**
 * Minimal HTTP API for ChatGPT custom GPTs, internal scripts, and any
 * tool-use platform that can call HTTPS endpoints.
 *
 * Security defaults:
 *   - binds to 127.0.0.1 unless `host` is overridden
 *   - if no `authToken` is provided AND host is not localhost, the server refuses to start
 *   - requests outside localhost are rejected unless they carry `Authorization: Bearer <token>`
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<{ stop: () => Promise<void>; url: string }> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4711;
  const isLocalhost = host === "127.0.0.1" || host === "localhost" || host === "::1";

  if (!isLocalhost && !opts.authToken) {
    throw new Error(
      "HTTP server refusing to bind to a non-localhost host without an auth token. " +
        "Set authToken (or use host='127.0.0.1').",
    );
  }

  const baseRunsDir = path.resolve(opts.baseRunsDir ?? path.join(opts.config.projectRoot, "runs"));
  const workers = buildWorkers(opts.config);

  const server = http.createServer((req, res) => {
    handle(req, res, opts, workers, baseRunsDir).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  const boundPort = addr && typeof addr === "object" ? addr.port : port;
  const url = `http://${host}:${boundPort}`;
  return {
    url,
    stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HttpServerOptions,
  workers: ReturnType<typeof buildWorkers>,
  baseRunsDir: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Auth: require bearer token if configured.
  if (opts.authToken) {
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${opts.authToken}`;
    if (auth !== expected) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
  }

  const route = `${req.method ?? "GET"} ${url.pathname}`;

  if (route === "GET /healthz") {
    return sendJson(res, 200, { ok: true });
  }
  if (route === "GET /openapi.json") {
    return sendJson(res, 200, openApiSpec(opts));
  }
  if (route === "POST /runs") {
    const body = await readJsonBody(req);
    return handlePostRun(res, opts, workers, baseRunsDir, body);
  }
  if (route === "GET /runs") {
    return handleListRuns(res, baseRunsDir);
  }
  // GET /runs/:id
  let m = /^\/runs\/([^/]+)$/.exec(url.pathname);
  if (m && req.method === "GET") {
    return handleGetRun(res, baseRunsDir, decodeURIComponent(m[1]!));
  }
  // GET /runs/:id/conversation
  m = /^\/runs\/([^/]+)\/conversation$/.exec(url.pathname);
  if (m && req.method === "GET") {
    return handleGetConversation(res, baseRunsDir, decodeURIComponent(m[1]!));
  }
  // GET /runs/:id/artifact?name=plan.json
  m = /^\/runs\/([^/]+)\/artifact$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const name = url.searchParams.get("name");
    if (!name) return sendJson(res, 400, { error: "missing 'name' query parameter" });
    return handleGetArtifact(res, baseRunsDir, decodeURIComponent(m[1]!), name);
  }

  // POST /projects — full-auto project builder
  if (route === "POST /projects") {
    const body = await readJsonBody(req);
    return handlePostProject(res, opts, workers, body);
  }
  if (route === "GET /projects") {
    return handleListProjects(res, opts);
  }
  m = /^\/projects\/([^/]+)$/.exec(url.pathname);
  if (m && req.method === "GET") {
    return handleGetProject(res, opts, decodeURIComponent(m[1]!));
  }

  return sendJson(res, 404, { error: `no route: ${route}` });
}

async function handlePostProject(
  res: ServerResponse,
  opts: HttpServerOptions,
  workers: ReturnType<typeof buildWorkers>,
  body: Record<string, unknown>,
): Promise<void> {
  const inline = typeof body.spec === "string" ? body.spec : undefined;
  const specPath = typeof body.spec_path === "string" ? body.spec_path : undefined;
  const resumeId = typeof body.resume_project_id === "string" ? body.resume_project_id : undefined;
  if (!inline && !specPath && !resumeId) {
    return sendJson(res, 400, { error: "either 'spec', 'spec_path', or 'resume_project_id' is required" });
  }
  const spec = inline ? specFromText(inline) : specPath ? await loadProjectSpec(specPath) : undefined;
  const budget: Record<string, number> = {};
  if (typeof body.max_tasks === "number") budget.maxTasks = body.max_tasks;
  if (typeof body.max_seconds === "number") budget.maxWallClockSeconds = body.max_seconds;
  const acks = Array.isArray(body.acknowledged_risks)
    ? body.acknowledged_risks.filter((x): x is string => typeof x === "string")
    : [];
  const baseProjectsDir = path.join(opts.config.projectRoot, "projects");
  const report = await runProject({
    ...(spec ? { spec } : {}),
    ...(resumeId ? { resumeProjectId: resumeId } : {}),
    config: opts.config,
    workers: { claude: workers.claude, codex: workers.codex, cursor: workers.cursor },
    baseProjectsDir,
    budget,
    options: acks.length > 0 ? { acknowledgedRisks: acks } : {},
    quiet: true,
  });
  return sendJson(res, 200, {
    projectId: report.projectId,
    projectDir: report.projectDir,
    status: report.status,
    stopReason: report.stopReason,
    durationMs: report.durationMs,
    tasks: {
      total: report.finalBacklog.length,
      done: report.finalBacklog.filter((t) => t.status === "done").length,
      failed: report.finalBacklog.filter((t) => t.status === "failed").length,
      blocked: report.finalBacklog.filter((t) => t.status === "blocked").length,
      needsApproval: report.finalBacklog.filter((t) => t.status === "needs_approval").length,
    },
    backlog: report.finalBacklog,
    executions: report.executions,
  });
}

async function handleListProjects(res: ServerResponse, opts: HttpServerOptions): Promise<void> {
  const baseProjectsDir = path.join(opts.config.projectRoot, "projects");
  let entries: string[] = [];
  try {
    entries = await readdir(baseProjectsDir);
  } catch {
    return sendJson(res, 200, { projects: [] });
  }
  const projects: { projectId: string; createdAt: string }[] = [];
  for (const e of entries) {
    try {
      const s = await stat(path.join(baseProjectsDir, e));
      if (s.isDirectory()) projects.push({ projectId: e, createdAt: s.birthtime.toISOString() });
    } catch {
      // ignore
    }
  }
  projects.sort((a, b) => b.projectId.localeCompare(a.projectId));
  return sendJson(res, 200, { projects });
}

async function handleGetProject(res: ServerResponse, opts: HttpServerOptions, projectId: string): Promise<void> {
  if (!safeRunId(projectId)) return sendJson(res, 400, { error: "invalid project id" });
  const baseProjectsDir = path.join(opts.config.projectRoot, "projects");
  try {
    const [reportMd, backlogRaw, reportJson] = await Promise.all([
      readFile(path.join(baseProjectsDir, projectId, "final_report.md"), "utf8"),
      readFile(path.join(baseProjectsDir, projectId, "backlog.json"), "utf8").catch(() => "{}"),
      readFile(path.join(baseProjectsDir, projectId, "final_report.json"), "utf8").catch(() => "null"),
    ]);
    return sendJson(res, 200, {
      projectId,
      finalReport: reportMd,
      backlog: JSON.parse(backlogRaw),
      report: JSON.parse(reportJson),
    });
  } catch {
    return sendJson(res, 404, { error: `project not found: ${projectId}` });
  }
}

async function handlePostRun(
  res: ServerResponse,
  opts: HttpServerOptions,
  workers: ReturnType<typeof buildWorkers>,
  baseRunsDir: string,
  body: Record<string, unknown>,
): Promise<void> {
  const taskText = typeof body.task === "string" ? body.task : undefined;
  const taskPath = typeof body.task_path === "string" ? body.task_path : undefined;
  if (!taskText && !taskPath) {
    return sendJson(res, 400, { error: "either 'task' (string) or 'task_path' (string) is required" });
  }
  const report = await runWorkflow({
    config: opts.config,
    taskText,
    taskPath,
    workers: { claude: workers.claude, codex: workers.codex, cursor: workers.cursor },
    baseRunsDir,
    quiet: true,
  });
  return sendJson(res, 200, summarizeReport(report));
}

async function handleListRuns(res: ServerResponse, baseRunsDir: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(baseRunsDir);
  } catch {
    // baseRunsDir doesn't exist yet
    return sendJson(res, 200, { runs: [] });
  }
  const runs: { runId: string; createdAt: string }[] = [];
  for (const e of entries) {
    const full = path.join(baseRunsDir, e);
    try {
      const s = await stat(full);
      if (s.isDirectory()) runs.push({ runId: e, createdAt: s.birthtime.toISOString() });
    } catch {
      // ignore
    }
  }
  runs.sort((a, b) => b.runId.localeCompare(a.runId));
  return sendJson(res, 200, { runs });
}

async function handleGetRun(res: ServerResponse, baseRunsDir: string, runId: string): Promise<void> {
  if (!safeRunId(runId)) return sendJson(res, 400, { error: "invalid run id" });
  const reportPath = path.join(baseRunsDir, runId, "final_report.md");
  const verifierPath = path.join(baseRunsDir, runId, "verifier.json");
  const reviewPath = path.join(baseRunsDir, runId, "review.json");
  try {
    const [report, verifier, review] = await Promise.all([
      readFile(reportPath, "utf8"),
      readFile(verifierPath, "utf8").catch(() => "null"),
      readFile(reviewPath, "utf8").catch(() => "null"),
    ]);
    return sendJson(res, 200, {
      runId,
      finalReport: report,
      verifier: JSON.parse(verifier),
      review: JSON.parse(review),
    });
  } catch (err) {
    return sendJson(res, 404, { error: `run not found: ${runId}` });
  }
}

async function handleGetConversation(res: ServerResponse, baseRunsDir: string, runId: string): Promise<void> {
  if (!safeRunId(runId)) return sendJson(res, 400, { error: "invalid run id" });
  const jsonlPath = path.join(baseRunsDir, runId, "conversation.jsonl");
  try {
    const raw = await readFile(jsonlPath, "utf8");
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return sendJson(res, 200, { runId, events });
  } catch {
    return sendJson(res, 404, { error: `conversation not found for run ${runId}` });
  }
}

async function handleGetArtifact(
  res: ServerResponse,
  baseRunsDir: string,
  runId: string,
  name: string,
): Promise<void> {
  if (!safeRunId(runId) || !safeArtifactName(name)) {
    return sendJson(res, 400, { error: "invalid run id or artifact name" });
  }
  const filePath = path.join(baseRunsDir, runId, name);
  try {
    const content = await readFile(filePath, "utf8");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(content);
  } catch {
    return sendJson(res, 404, { error: `artifact not found: ${name}` });
  }
}

function summarizeReport(report: import("../orchestration/types.js").RunReport) {
  return {
    runId: report.runId,
    runDir: report.runDir,
    status: report.status,
    requiresApproval: report.requiresApproval,
    approvalReasons: report.approvalReasons,
    durationMs: report.durationMs,
    plan: report.plan,
    rounds: report.rounds.map((r) => ({
      round: r.round,
      decision: r.decision,
      verifierPassed: r.verifier ? r.verifier.passed : null,
      verifierSkipped: r.verifier === null,
      verdict: r.review.verdict,
      changedFiles: r.diff.changedFiles,
      detectedRisks: r.diff.detectedRisks,
      pathViolations: r.diff.pathViolations,
    })),
  };
}

function safeRunId(runId: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(runId);
}

function safeArtifactName(name: string): boolean {
  // Must not contain path traversal or absolute paths.
  if (name.includes("..") || path.isAbsolute(name)) return false;
  // Limit to filenames or simple subpaths.
  return /^[a-zA-Z0-9._\-/]+$/.test(name);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return reject(new Error("body must be a JSON object"));
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function openApiSpec(opts: HttpServerOptions): unknown {
  // Minimal OpenAPI 3.1 spec — sufficient for ChatGPT custom GPTs and similar.
  return {
    openapi: "3.1.0",
    info: {
      title: "agent-orchestrator",
      version: "0.1.0",
      description:
        "Local-first orchestrator that coordinates AI coding agents (Claude, Codex, Cursor) " +
        "as isolated workers via auditable, artifact-driven runs.",
    },
    servers: [{ url: "/" }],
    paths: {
      "/healthz": { get: { summary: "Liveness probe", responses: { "200": { description: "ok" } } } },
      "/runs": {
        post: {
          summary: "Start a new orchestrator run",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    task: { type: "string", description: "Inline task description (Markdown)" },
                    task_path: { type: "string", description: "Absolute path to a task .md file" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Run report summary" } },
        },
        get: { summary: "List recent runs", responses: { "200": { description: "ok" } } },
      },
      "/runs/{runId}": {
        get: {
          summary: "Get a run's final report + verifier + review",
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" }, "404": { description: "run not found" } },
        },
      },
      "/runs/{runId}/conversation": {
        get: {
          summary: "Get the chronological conversation log for a run",
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
      "/runs/{runId}/artifact": {
        get: {
          summary: "Get a single artifact file from a run",
          parameters: [
            { name: "runId", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
      "/projects": {
        post: {
          summary: "Start a full-auto project build (decompose → loop)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    spec: { type: "string", description: "Inline project spec (Markdown)" },
                    spec_path: { type: "string", description: "Absolute path to a spec .md file" },
                    max_tasks: { type: "number", description: "Hard cap on task executions (default 30)" },
                    max_seconds: { type: "number", description: "Hard cap on wall-clock seconds (default 3600)" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Project report summary" } },
        },
        get: { summary: "List recent projects", responses: { "200": { description: "ok" } } },
      },
      "/projects/{projectId}": {
        get: {
          summary: "Get a project's final report + backlog",
          parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" }, "404": { description: "project not found" } },
        },
      },
    },
    components: opts.authToken
      ? {
          securitySchemes: {
            bearer: { type: "http", scheme: "bearer" },
          },
        }
      : {},
    security: opts.authToken ? [{ bearer: [] }] : [],
  };
}
