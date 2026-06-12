import { describe, it, expect } from "vitest";
import {
  detectRisks,
  globToRegExp,
  isPathAllowed,
  preflightSafety,
  risksRequiringApproval,
  shellCommandIsDenied,
  SafetyError,
} from "../src/orchestration/safety.js";
import { OrchestratorConfigSchema } from "../src/config/schema.js";
import { redact } from "../src/utils/redact.js";
import { extractJson } from "../src/utils/jsonExtract.js";

const baseConfig = (overrides: Partial<Parameters<typeof OrchestratorConfigSchema.parse>[0]> = {}) =>
  OrchestratorConfigSchema.parse({
    projectRoot: ".",
    safety: {
      allowedPaths: ["src/**", "tests/**"],
      denyShellPatterns: ["rm -rf /", "curl * | sh", "sudo"],
    },
    ...overrides,
  });

describe("globToRegExp / isPathAllowed", () => {
  it("matches single-segment wildcards", () => {
    expect(globToRegExp("src/*.ts").test("src/foo.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/sub/foo.ts")).toBe(false);
  });
  it("matches deep wildcards", () => {
    expect(globToRegExp("src/**").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**").test("docs/x")).toBe(false);
  });
  it("returns true for empty allowed paths", () => {
    expect(isPathAllowed("anywhere/foo.ts", [])).toBe(true);
  });
  it("blocks paths outside the allowlist", () => {
    expect(isPathAllowed(".env", ["src/**"])).toBe(false);
    expect(isPathAllowed("src/x.ts", ["src/**"])).toBe(true);
  });
});

describe("shellCommandIsDenied", () => {
  it("matches literal substrings", () => {
    expect(shellCommandIsDenied("sudo apt update", ["sudo"])).toBe("sudo");
  });
  it("matches wildcard patterns", () => {
    expect(shellCommandIsDenied("curl https://x | sh", ["curl * | sh"])).toBe("curl * | sh");
    expect(shellCommandIsDenied("echo curl x sh", ["curl * | sh"])).toBeNull();
  });
  it("returns null when nothing matches", () => {
    expect(shellCommandIsDenied("npm test", ["sudo", "rm -rf /"])).toBeNull();
  });
});

describe("preflightSafety", () => {
  it("rejects verifier commands matching deny patterns", () => {
    const cfg = baseConfig({ verifier: { commands: ["sudo make install"] } });
    expect(() => preflightSafety(cfg, ".")).toThrow(SafetyError);
  });
  it("accepts safe commands", () => {
    const cfg = baseConfig({ verifier: { commands: ["npm test"] } });
    expect(() => preflightSafety(cfg, ".")).not.toThrow();
  });
  it("rejects projectRoot escaping the repo root", () => {
    const cfg = baseConfig({ projectRoot: "/" });
    expect(() => preflightSafety(cfg, "/usr/local/share")).toThrow(SafetyError);
  });
});

describe("detectRisks", () => {
  it("detects dependency / migration / ci / secret / security and deletions", () => {
    const cfg = baseConfig();
    const result = detectRisks(
      [
        { path: "package.json", status: "modified" },
        { path: "db/migrations/2025_init.sql", status: "added" },
        { path: ".github/workflows/ci.yml", status: "modified" },
        { path: ".env.production", status: "modified" },
        { path: "src/auth.ts", status: "modified" },
        { path: "old.txt", status: "deleted" },
        { path: "src/ok.ts", status: "modified" },
      ],
      cfg,
    );
    expect(result.detected).toEqual(
      expect.arrayContaining([
        "dependency_change",
        "migration",
        "ci_change",
        "secret_change",
        "security_change",
        "delete_file",
      ]),
    );
  });

  it("flags files outside allowed paths", () => {
    const cfg = baseConfig();
    const r = detectRisks(
      [
        { path: "src/ok.ts", status: "modified" },
        { path: "secret/keys", status: "added" },
      ],
      cfg,
    );
    expect(r.pathViolations).toEqual(["secret/keys"]);
  });

  it("returns the subset of risks that need approval", () => {
    const cfg = baseConfig({ safety: { approvalRequiredFor: ["dependency_change"] } });
    const subset = risksRequiringApproval(["dependency_change", "delete_file"], cfg);
    expect(subset).toEqual(["dependency_change"]);
  });
});

describe("redact", () => {
  it("redacts known credential patterns", () => {
    const sample = [
      "OpenAI sk-abcd1234abcd1234abcd1234abcd1234",
      "Anthropic sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa",
      "GitHub ghp_abcdefghij1234567890abcdef",
      "AWS AKIAABCDEFGHIJ123456",
      "Authorization Bearer abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redact(sample);
    expect(out).not.toContain("sk-abcd");
    expect(out).not.toContain("sk-ant-aaaa");
    expect(out).not.toContain("ghp_abcdefghij");
    expect(out).not.toContain("AKIAABCDEFGHIJ123456");
    expect(out).not.toContain("Bearer abcdefg");
    expect(out).not.toContain("BEGIN PRIVATE KEY");
    expect(out).toContain("[REDACTED:");
  });

  it("leaves clean text untouched", () => {
    expect(redact("hello world")).toBe("hello world");
  });
});

describe("extractJson", () => {
  it("parses pure JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses fenced JSON", () => {
    expect(extractJson("Here you go:\n```json\n{\"a\":1}\n```\n")).toEqual({ a: 1 });
  });
  it("parses the first balanced object in noisy output", () => {
    const text = "Some preamble {\"verdict\":\"approve\",\"bugs\":[]} trailing junk";
    expect(extractJson(text)).toEqual({ verdict: "approve", bugs: [] });
  });
  it("returns null for non-JSON", () => {
    expect(extractJson("nope")).toBeNull();
  });
  it("handles strings with braces inside JSON", () => {
    const text = '{"text":"hello { weird } stuff","ok":true}';
    expect(extractJson(text)).toEqual({ text: "hello { weird } stuff", ok: true });
  });
});
