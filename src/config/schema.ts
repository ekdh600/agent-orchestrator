import { z } from "zod";

const WorkerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string().min(1, "worker.command must be a non-empty string"),
  args: z.array(z.string()).default([]),
  // Optional environment overrides forwarded to the worker subprocess.
  env: z.record(z.string()).optional(),
});

export const WorkersConfigSchema = z
  .object({
    claude: WorkerConfigSchema.optional(),
    codex: WorkerConfigSchema.optional(),
    cursor: WorkerConfigSchema.optional(),
  })
  // Allow defining additional workers by name for forward compatibility.
  .catchall(WorkerConfigSchema);

export const VerifierConfigSchema = z.object({
  // Each entry is a shell command line. Verifier commands are trusted config —
  // they will be executed via a shell so that pipes/redirects work as expected.
  commands: z.array(z.string().min(1)).default([]),
  // When the working tree adds or modifies a package manifest (package.json,
  // package-lock.json, yarn.lock, pnpm-lock.yaml, …) the orchestrator runs the
  // matching install command BEFORE verifier.commands so subsequent `npm test`
  // etc. can find dependencies. Modes:
  //   "if-changed" (default): install only when manifests show up in the diff
  //   "always":               install before every verifier round
  //   "off":                  never auto-install
  autoInstall: z.enum(["if-changed", "always", "off"]).default("if-changed"),
  // Per-package-manager install command override. `auto` picks based on
  // which lockfile is present (npm/yarn/pnpm), defaulting to npm.
  installCommand: z.string().min(1).default("auto"),
});

// One stage's route: which worker runs it and (optionally) with which model.
// Both fields optional — anything unspecified falls back to the stage default,
// then to the built-in mapping (plan/review/decompose=claude, implement/repair=codex).
const StageRouteSchema = z
  .object({
    worker: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

const RoutingStagesSchema = z
  .object({
    plan: StageRouteSchema.optional(),
    implement: StageRouteSchema.optional(),
    review: StageRouteSchema.optional(),
    repair: StageRouteSchema.optional(),
    decompose: StageRouteSchema.optional(),
  })
  .strict();

// Category override: same shape as stages plus a per-category maxRounds.
// Category names are free-form ("quick" / "standard" / "deep" by convention —
// the decomposer assigns those three).
const CategoryRouteSchema = RoutingStagesSchema.extend({
  maxRounds: z.number().int().min(1).max(20).optional(),
}).strict();

export const RoutingConfigSchema = z
  .object({
    // Per-stage default worker/model.
    stages: RoutingStagesSchema.default({}),
    // Per-category overrides, keyed by category name. A task's category is
    // assigned by the decomposer (or --category for single-task runs).
    categories: z.record(CategoryRouteSchema).default({}),
  })
  .strict();

// One reviewer on the multi-perspective panel. worker/model default to the
// review stage route when omitted.
const ReviewPerspectiveSchema = z
  .object({
    name: z.string().min(1),
    focus: z.string().min(1),
    worker: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export const DEFAULT_REVIEW_PERSPECTIVES = [
  {
    name: "correctness",
    focus: "logic errors, broken edge cases, regressions, and whether the change actually does what the task asks",
  },
  {
    name: "security",
    focus: "input validation, authn/authz mistakes, injection, secret exposure, and unsafe defaults",
  },
  {
    name: "testing",
    focus: "test coverage of the changed behavior, missing edge-case tests, and brittle or tautological tests",
  },
];

const ReviewPanelSchema = z
  .object({
    // Default off — single-reviewer behavior is unchanged until enabled.
    enabled: z.boolean().default(false),
    perspectives: z.array(ReviewPerspectiveSchema).min(1).default(DEFAULT_REVIEW_PERSPECTIVES),
    // strict: one request_changes verdict is enough to request changes.
    // majority: more than half must request changes.
    // requires_human_review from ANY member always escalates, regardless.
    decision: z.enum(["strict", "majority"]).default("strict"),
    // always: panel on every round. risky: panel only when the diff carries
    // risk tags / path violations or touches many files; single review otherwise.
    trigger: z.enum(["always", "risky"]).default("risky"),
    // "risky" trigger: a diff touching at least this many files counts as risky.
    triggerFileThreshold: z.number().int().min(1).default(10),
  })
  .strict();

export const ReviewConfigSchema = z
  .object({
    panel: ReviewPanelSchema.default({}),
  })
  .strict();

export const ProjectConfigSchema = z
  .object({
    // Interview the spec for ambiguities BEFORE decomposing:
    //   off      — never (default)
    //   auto     — adopt each question's default assumption, record them in
    //              the spec under "## Assumptions (auto-adopted)", continue
    //   required — stop with status "needs_clarification" (CLI exit 14) and
    //              surface the questions; answer them in the spec and re-run
    interview: z.enum(["off", "auto", "required"]).default("off"),
    // When the backlog would stop with failed/blocked tasks, ask the replanner
    // to replace them with a different approach, up to this many times.
    // 0 disables replanning. Budgets always win over replans, and
    // needs_approval tasks are never replanned (no bypassing the human gate).
    maxReplans: z.number().int().min(0).max(10).default(0),
    // Run up to N independent tasks concurrently, each in its own git
    // worktree. 1 (default) = today's sequential behavior. >1 requires a git
    // projectRoot and autoCommitBetweenTasks (validated at project start).
    // Tasks whose allowed_paths overlap — or that have no allowed_paths at
    // all — never run concurrently.
    maxParallelTasks: z.number().int().min(1).max(8).default(1),
  })
  .strict();

export const SafetyConfigSchema = z.object({
  // Glob-style allowed paths (e.g. "src/**", "tests/**"). If empty, every path is allowed.
  allowedPaths: z.array(z.string()).default([]),
  // Risky operation tags that demand human approval.
  approvalRequiredFor: z
    .array(
      z.enum([
        "dependency_change",
        "migration",
        "delete_file",
        "ci_change",
        "secret_change",
        "security_change",
      ]),
    )
    .default([
      "dependency_change",
      "migration",
      "delete_file",
      "ci_change",
      "secret_change",
      "security_change",
    ]),
  // Substring/regex patterns blocked from appearing in any verifier command.
  // Plain strings are matched as substrings (with `*` treated as a wildcard).
  denyShellPatterns: z.array(z.string()).default([]),
});

const GmailServiceAccountAuth = z.object({
  kind: z.literal("service_account"),
  // Path to the service-account JSON key file. Path-only — never inline credentials in config.
  keyFileEnv: z.string().min(1),
  // The mailbox to impersonate via Workspace domain-wide delegation.
  impersonate: z.string().email(),
});

const GmailOAuthRefreshAuth = z.object({
  kind: z.literal("oauth_refresh"),
  clientIdEnv: z.string().min(1),
  clientSecretEnv: z.string().min(1),
  refreshTokenEnv: z.string().min(1),
});

export const GmailConfigSchema = z.object({
  auth: z.discriminatedUnion("kind", [GmailServiceAccountAuth, GmailOAuthRefreshAuth]),
  // Gmail search query (e.g. "label:account-request newer_than:1d -label:processed").
  query: z.string().min(1),
  // Label applied after a message is handled. Required for idempotency.
  processedLabel: z.string().min(1).default("orchestrator/processed"),
  // Label applied when a message could not be processed (parse error, etc.).
  errorLabel: z.string().min(1).default("orchestrator/error"),
  pollIntervalSeconds: z.number().int().min(10).max(3600).default(60),
  // Hard cap per poll, keeps a backlog from snowballing.
  maxMessagesPerPoll: z.number().int().min(1).max(100).default(20),
});

export const TemplateConfigSchema = z.object({
  // Regex applied to the message subject. Messages that don't match are skipped.
  subjectPattern: z.string().min(1),
  // Field labels we expect to find in the HTML table (left column = label, right = value).
  // Korean labels are fine — matched literally after whitespace trim.
  fieldLabels: z.object({
    requesterEmail: z.array(z.string().min(1)).default(["요청자 이메일", "Requester Email"]),
    targetUserEmail: z.array(z.string().min(1)).default(["대상자 이메일", "Target Email"]),
    system: z.array(z.string().min(1)).default(["시스템", "System"]),
    role: z.array(z.string().min(1)).default(["권한", "Role"]),
    reason: z.array(z.string().min(1)).default(["사유", "Reason"]),
    gitlabGroup: z.array(z.string().min(1)).default(["GitLab 그룹", "GitLab Group"]),
    jenkinsFolder: z.array(z.string().min(1)).default(["Jenkins 폴더", "Jenkins Folder"]),
  }),
});

export const ProvisioningPolicySchema = z.object({
  // Sender email domains that are allowed to file requests at all.
  senderDomainAllowlist: z.array(z.string().min(1)).default([]),
  // Target user email domains that are allowed to be provisioned.
  userEmailDomainAllowlist: z.array(z.string().min(1)).default([]),
  // Roles in this list always demand human approval (even if everything else passes).
  managerApprovalRequiredFor: z.array(z.string().min(1)).default(["maintainer", "owner", "admin"]),
  // Roles that are never granted automatically.
  denyRoles: z.array(z.string().min(1)).default(["root", "system"]),
  gitlab: z
    .object({
      // Glob patterns of group paths that may be granted (e.g. "dev/*").
      allowedGroups: z.array(z.string().min(1)).default([]),
    })
    .default({ allowedGroups: [] }),
  jenkins: z
    .object({
      // Glob patterns of folder paths that may be granted (e.g. "build/*").
      allowedFolders: z.array(z.string().min(1)).default([]),
    })
    .default({ allowedFolders: [] }),
});

export const GitLabConfigSchema = z.object({
  baseUrl: z.string().url(),
  // Env var name that holds the admin/personal access token. Token is NEVER in config.
  tokenEnv: z.string().min(1),
});

export const JenkinsConfigSchema = z.object({
  baseUrl: z.string().url(),
  userEnv: z.string().min(1),
  tokenEnv: z.string().min(1),
});

export const ApprovalConfigSchema = z.object({
  channel: z.enum(["slack", "email", "none"]).default("none"),
  // For slack: env var holding the incoming webhook URL.
  slackWebhookEnv: z.string().min(1).optional(),
  // For email: env var holding a comma-separated list of approver addresses.
  emailRecipientsEnv: z.string().min(1).optional(),
});

export const ProvisioningConfigSchema = z.object({
  gmail: GmailConfigSchema,
  template: TemplateConfigSchema,
  policy: ProvisioningPolicySchema.default({}),
  gitlab: GitLabConfigSchema.optional(),
  jenkins: JenkinsConfigSchema.optional(),
  approval: ApprovalConfigSchema.default({ channel: "none" }),
  // When true, the workflow runs everything except the actual GitLab/Jenkins mutations.
  dryRun: z.boolean().default(false),
});

export const OrchestratorConfigSchema = z
  .object({
    projectRoot: z.string().default("."),
    maxRounds: z.number().int().min(1).max(20).default(3),
    timeoutSeconds: z.number().int().min(5).max(7200).default(900),
    workers: WorkersConfigSchema.default({}),
    routing: RoutingConfigSchema.default({}),
    review: ReviewConfigSchema.default({}),
    project: ProjectConfigSchema.default({}),
    verifier: VerifierConfigSchema.default({ commands: [] }),
    safety: SafetyConfigSchema.default({}),
    // Optional. Only required for the account-provisioning workflow.
    provisioning: ProvisioningConfigSchema.optional(),
  })
  .strict();

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;
export type WorkersConfig = z.infer<typeof WorkersConfigSchema>;
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
export type StageRoute = z.infer<typeof StageRouteSchema>;
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ReviewPerspective = z.infer<typeof ReviewPerspectiveSchema>;
export type VerifierConfig = z.infer<typeof VerifierConfigSchema>;
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;
export type GmailConfig = z.infer<typeof GmailConfigSchema>;
export type TemplateConfig = z.infer<typeof TemplateConfigSchema>;
export type ProvisioningPolicy = z.infer<typeof ProvisioningPolicySchema>;
export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;
export type JenkinsConfig = z.infer<typeof JenkinsConfigSchema>;
export type ApprovalConfig = z.infer<typeof ApprovalConfigSchema>;
export type ProvisioningConfig = z.infer<typeof ProvisioningConfigSchema>;
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
