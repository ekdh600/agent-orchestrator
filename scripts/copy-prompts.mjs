// Copy non-TypeScript prompt assets to the dist directory.
// `tsc` does not copy .md files; we ship them alongside the compiled JS so
// the prompt loader can find them in production installs.
import { readdir, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const PAIRS = [
  { src: path.join(ROOT, "src", "prompts"), dest: path.join(ROOT, "dist", "prompts") },
  { src: path.join(ROOT, "src", "project", "prompts"), dest: path.join(ROOT, "dist", "project", "prompts") },
];

let total = 0;
for (const { src, dest } of PAIRS) {
  try {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      await copyFile(path.join(src, entry), path.join(dest, entry));
      total++;
    }
    console.log(`copied prompts → ${path.relative(ROOT, dest)}`);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
}
console.log(`copied ${total} prompt template(s)`);
