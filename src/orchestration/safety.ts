import path from "node:path";
import type { OrchestratorConfig } from "../config/schema.js";
import type { ChangedFile, RiskTag } from "./types.js";

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

/**
 * Convert a glob-style allowed path pattern into a RegExp.
 * Supports `*` (segment wildcard, no `/`), `**` (any depth), and literal text.
 * Patterns are anchored to the start of the path; trailing `/` matches a directory.
 */
export function globToRegExp(pattern: string): RegExp {
  let normalized = pattern.replace(/\\/g, "/").replace(/^\.?\/+/, "");
  if (!normalized) normalized = "**";
  // Escape regex metacharacters except for our wildcard chars.
  const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  let re = "";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]!;
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRe(c);
    }
  }
  // If pattern ends in /, allow anything beneath it.
  if (re.endsWith("/")) re += ".*";
  return new RegExp("^" + re + "$");
}

export function isPathAllowed(filePath: string, allowedPatterns: string[]): boolean {
  if (!allowedPatterns || allowedPatterns.length === 0) return true;
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.?\/+/, "");
  return allowedPatterns.some((p) => globToRegExp(p).test(normalized));
}

/**
 * Match a verifier (or shell) command against deny patterns.
 * Patterns may include `*` as a wildcard meaning "any sequence of characters".
 * A literal pattern matches as a substring.
 */
export function shellCommandIsDenied(command: string, denyPatterns: string[]): string | null {
  for (const raw of denyPatterns) {
    if (!raw) continue;
    const hasWildcard = raw.includes("*");
    if (hasWildcard) {
      const re = new RegExp(
        raw
          .split("*")
          .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
          .join(".*"),
      );
      if (re.test(command)) return raw;
    } else if (command.includes(raw)) {
      return raw;
    }
  }
  return null;
}

/** Validate config-level safety properties before any worker is invoked. */
export function preflightSafety(config: OrchestratorConfig, repoRoot: string): void {
  // Verifier commands must not match deny patterns.
  for (const cmd of config.verifier.commands) {
    const matched = shellCommandIsDenied(cmd, config.safety.denyShellPatterns);
    if (matched) {
      throw new SafetyError(
        `Verifier command "${cmd}" matches denied pattern "${matched}". Refusing to run.`,
      );
    }
  }

  // projectRoot must be inside the repo root (or equal to it).
  const proj = path.resolve(config.projectRoot);
  const root = path.resolve(repoRoot);
  const rel = path.relative(root, proj);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SafetyError(
      `projectRoot ${proj} is outside the repository root ${root}; refusing to run.`,
    );
  }
}

/**
 * Sensitive-file patterns. Each tag indicates the kind of risk.
 * Ordered from most specific to most general.
 */
const FILE_RISK_RULES: { tag: RiskTag; test: (p: string) => boolean }[] = [
  {
    tag: "ci_change",
    test: (p) =>
      p.startsWith(".github/workflows/") ||
      p === ".gitlab-ci.yml" ||
      p.startsWith(".circleci/") ||
      p === "Jenkinsfile" ||
      p === ".travis.yml" ||
      p === "azure-pipelines.yml" ||
      p.startsWith(".buildkite/"),
  },
  {
    tag: "dependency_change",
    test: (p) => {
      const base = p.split("/").pop() ?? p;
      return [
        "package.json",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "requirements.txt",
        "Pipfile",
        "Pipfile.lock",
        "poetry.lock",
        "pyproject.toml",
        "Gemfile",
        "Gemfile.lock",
        "go.mod",
        "go.sum",
        "Cargo.toml",
        "Cargo.lock",
      ].includes(base);
    },
  },
  {
    tag: "migration",
    test: (p) =>
      /(^|\/)migrations?\//.test(p) ||
      /\.sql$/.test(p) ||
      /(^|\/)schema\.prisma$/.test(p) ||
      /(^|\/)alembic\//.test(p),
  },
  {
    tag: "secret_change",
    test: (p) => {
      const base = p.split("/").pop() ?? p;
      return (
        /^\.env(\..*)?$/.test(base) ||
        /credentials?(\.|_)/i.test(base) ||
        /^secrets?(\..*)?$/i.test(base) ||
        /\.(pem|key|p12|pfx)$/.test(base)
      );
    },
  },
  {
    tag: "security_change",
    test: (p) => /(^|\/)(auth|security|cors|csrf|permissions?|rbac)[^/]*$/i.test(p),
  },
];

export interface RiskDetection {
  detected: RiskTag[];
  pathViolations: string[];
}

export function detectRisks(
  changedFiles: ChangedFile[],
  config: OrchestratorConfig,
): RiskDetection {
  const detected = new Set<RiskTag>();
  const pathViolations: string[] = [];

  for (const cf of changedFiles) {
    if (cf.status === "deleted") detected.add("delete_file");
    for (const rule of FILE_RISK_RULES) {
      if (rule.test(cf.path)) detected.add(rule.tag);
    }
    if (!isPathAllowed(cf.path, config.safety.allowedPaths)) {
      pathViolations.push(cf.path);
    }
  }

  return { detected: [...detected], pathViolations };
}

/** Return the subset of detected risks that the config marks as needing approval. */
export function risksRequiringApproval(
  detected: RiskTag[],
  config: OrchestratorConfig,
): RiskTag[] {
  const required = new Set<string>(config.safety.approvalRequiredFor);
  return detected.filter((r) => required.has(r));
}
