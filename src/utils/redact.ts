/**
 * Redact common credential patterns from a string.
 * Order matters: more specific patterns first.
 */
const PATTERNS: { name: string; re: RegExp }[] = [
  // PEM private keys (multi-line)
  {
    name: "private_key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  // Anthropic
  { name: "anthropic_key", re: /sk-ant-[A-Za-z0-9_\-]{20,}/g },
  // OpenAI
  { name: "openai_key", re: /sk-(?:proj-)?[A-Za-z0-9_\-]{20,}/g },
  // GitHub tokens
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  // AWS access key id
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // AWS secret access key (heuristic)
  {
    name: "aws_secret_key",
    re: /\b(?:aws[_-]?secret[_-]?access[_-]?key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi,
  },
  // Generic Bearer tokens
  { name: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._\-]{16,}/g },
  // Generic API key style assignments: api_key=..., token: "..."
  {
    name: "generic_api_key",
    re: /\b(?:api[_-]?key|access[_-]?token|secret[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._\-]{16,}["']?/gi,
  },
];

export function redact(input: string): string {
  let out = input;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}

/** Redact and truncate from the end — useful for sending log tails to workers. */
export function redactedTail(input: string, maxBytes = 4_000): string {
  const redacted = redact(input);
  if (redacted.length <= maxBytes) return redacted;
  return `…[truncated ${redacted.length - maxBytes} chars]…\n` + redacted.slice(-maxBytes);
}
