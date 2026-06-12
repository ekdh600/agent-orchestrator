/**
 * Best-effort strict JSON extraction from a worker's stdout.
 * Strategy:
 *   1. Try to parse the whole string.
 *   2. Look for a fenced ```json block.
 *   3. Walk the string and extract the first balanced top-level {...} or [...].
 *
 * Returns null on failure; never throws.
 */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;

  const trimmed = text.trim();
  const direct = tryParse<T>(trimmed);
  if (direct !== undefined) return direct;

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch?.[1]) {
    const fenced = tryParse<T>(fenceMatch[1].trim());
    if (fenced !== undefined) return fenced;
  }

  const balanced = extractFirstBalancedJson(trimmed);
  if (balanced) {
    const parsed = tryParse<T>(balanced);
    if (parsed !== undefined) return parsed;
  }

  return null;
}

function tryParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

function extractFirstBalancedJson(s: string): string | null {
  const openers = new Set(["{", "["]);
  const matchers: Record<string, string> = { "{": "}", "[": "]" };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (openers.has(c)) {
      const end = findBalancedEnd(s, i, c, matchers[c]!);
      if (end !== -1) {
        return s.slice(i, end + 1);
      }
    }
  }
  return null;
}

function findBalancedEnd(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
