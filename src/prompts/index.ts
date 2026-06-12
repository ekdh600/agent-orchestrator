import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prompt templates ship alongside the source. After `tsc` builds to `dist/`,
 * the .md files are NOT copied automatically — `package.json` includes a
 * postbuild step that copies them. For dev mode (`tsx`), they resolve from
 * `src/prompts/`.
 *
 * We resolve relative to this file's URL, then probe both source and dist
 * locations so we work in either mode.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export type PromptName =
  | "planner.claude"
  | "implement.codex"
  | "review.claude"
  | "repair.codex";

const FILENAMES: Record<PromptName, string> = {
  "planner.claude": "planner.claude.md",
  "implement.codex": "implement.codex.md",
  "review.claude": "review.claude.md",
  "repair.codex": "repair.codex.md",
};

export async function loadPrompt(name: PromptName): Promise<string> {
  const filename = FILENAMES[name];
  const candidates = [
    path.join(HERE, filename),
    // When running from dist/prompts/, the .md is in src/prompts/.
    path.join(HERE, "..", "..", "src", "prompts", filename),
  ];
  let lastErr: unknown = null;
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not locate prompt template ${filename}. Tried: ${candidates.join(", ")}. Cause: ${String(lastErr)}`,
  );
}
