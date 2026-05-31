import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// Defaults ported from flow.py (MAX_CHARS/MIN_CHARS/OVERLAP_CHARS, SKIP_DIRS,
// MAX_FILE_BYTES) and the spec's model decision. The Ollama model TAG is
// resolved/pulled by `gtir setup`; this is the logical name stored in meta.
export const DEFAULTS = {
  model: "jina-code-embeddings-0.5b",
  ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
  maxChars: 2000,
  minChars: 100,
  overlapChars: 400,
  maxFileBytes: 256 * 1024,
  embedBatch: 32,
  contextPrefix: true,            // synthetic prefix on by default
  contextTier: "synthetic",       // "synthetic" | "claude-cli"
  version: 1,
  skipDirs: [
    "node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache",
    "target", "coverage", ".obsidian", ".vault-meta", ".trash",
    ".worktrees", ".raw", ".archive", ".command-center", ".venv", ".gtir",
    "test-results", "playwright-report", "src-tauri",
  ],
  skipSuffixes: [".excalidraw.md", ".lock", ".min.js", ".min.css", ".map"],
};

export function loadConfig(repoPath) {
  const repo = resolve(repoPath || process.cwd());
  let override = {};
  const file = join(repo, ".gtir", "config.json");
  if (existsSync(file)) {
    try { override = JSON.parse(readFileSync(file, "utf8")); }
    catch (e) { throw new Error(`invalid .gtir/config.json: ${e.message}`); }
  }
  const merged = { ...DEFAULTS, ...override };
  merged.repo = repo;
  merged.gtirDir = join(repo, ".gtir");
  merged.indexDir = join(repo, ".gtir", "index.lance");
  return merged;
}
