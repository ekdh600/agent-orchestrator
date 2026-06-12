// Public entrypoint for programmatic use of the orchestrator.
export { runWorkflow } from "./orchestration/runWorkflow.js";
export type { ProgressEvent, RunWorkflowOptions } from "./orchestration/runWorkflow.js";
export {
  ConversationLog,
  renderTranscript,
  type ConversationEvent,
  type ConversationKind,
  type ConversationStage,
} from "./orchestration/conversationLog.js";
export { EventBus, topicMatches, type BusEvent, type BusHandler } from "./orchestration/eventBus.js";
export {
  resolveStage,
  resolveMaxRounds,
  RoutingError,
  TASK_CATEGORIES,
  type RoutableStage,
  type TaskCategory,
  type ResolvedRoute,
} from "./orchestration/routing.js";
export {
  makeExchangeId,
  renderEnvelope,
  verifyEcho,
  stripEcho,
  type ArtifactMeta,
} from "./orchestration/envelope.js";
export { startChat, type ChatOptions } from "./chat/repl.js";
export { startHttpServer, type HttpServerOptions } from "./http/server.js";
export { startMcpServer, type McpServerOptions } from "./mcp/server.js";
export {
  runProject,
  loadProjectSpec,
  specFromText,
  decomposeProject,
  fallbackDecompose,
  pickNextTask,
  applyTaskOutcome,
  backlogProgress,
  DEFAULT_BUDGET,
  type RunProjectOptions,
  type ProjectProgressEvent,
  type ProjectSpec,
  type ProjectReport,
  type ProjectStatus,
  type ProjectBudget,
  type ProjectState,
  type Backlog,
  type BacklogTask,
  type TaskKind,
  type TaskStatus,
  type DecompositionResult,
  type DefinitionOfDone,
  type TaskExecution,
} from "./project/index.js";
export { loadConfig, defaultConfig, ConfigError } from "./config/loadConfig.js";
export { buildWorkers } from "./workers/factory.js";
export { MockWorker } from "./workers/MockWorker.js";
export { ClaudeWorker } from "./workers/ClaudeWorker.js";
export { CodexWorker } from "./workers/CodexWorker.js";
export { CursorWorker } from "./workers/CursorWorker.js";
export {
  detectRisks,
  preflightSafety,
  risksRequiringApproval,
  isPathAllowed,
  shellCommandIsDenied,
  globToRegExp,
  SafetyError,
} from "./orchestration/safety.js";
export { runVerifier } from "./orchestration/verifier.js";
export { mergePanelReviews, shouldRunPanel, type PanelMemberResult } from "./orchestration/reviewPanel.js";
export {
  clarifySpec,
  specWithAdoptedAssumptions,
  type ClarificationResult,
  type ClarificationQuestion,
} from "./project/clarify.js";
export { replanProject, applyReplan, failureSignature, lineageRoot, type ReplanResult } from "./project/replan.js";
export {
  createTaskWorktree,
  mergeTaskWorktree,
  removeTaskWorktree,
  pruneTaskWorktrees,
  isGitRepo,
  WorktreeError,
  type TaskWorktree,
  type MergeResult,
} from "./orchestration/worktree.js";
export { extractJson } from "./utils/jsonExtract.js";
export { redact, redactedTail } from "./utils/redact.js";
export { renderFinalReport, renderTerminalSummary } from "./orchestration/report.js";
// Runtime zod schemas — useful for consumers that want to validate their own
// config files programmatically.
export {
  OrchestratorConfigSchema,
  WorkersConfigSchema,
  VerifierConfigSchema,
  SafetyConfigSchema,
} from "./config/schema.js";
export type {
  OrchestratorConfig,
  WorkerConfig,
  SafetyConfig,
  VerifierConfig,
  WorkersConfig,
} from "./config/schema.js";
export type { Worker, WorkerInput, WorkerResult, SafetyPolicy, WorkerArtifact, WorkerRole } from "./workers/Worker.js";
export type {
  PlanArtifact,
  ReviewArtifact,
  RunReport,
  RoundReport,
  DiffSummary,
  VerifierReport,
  VerifierCommandResult,
  RiskTag,
  RiskLevel,
  ChangedFile,
  RunStatus,
} from "./orchestration/types.js";
