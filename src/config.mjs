import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// Defaults ported from flow.py (MAX_CHARS/MIN_CHARS/OVERLAP_CHARS, SKIP_DIRS,
// MAX_FILE_BYTES) and the spec's model decision. `model` is the Ollama tag
// served via /api/embed; pull it with `ollama pull <model>` (or `gtir setup`).
// jina-code-embeddings-0.5b has no official Ollama-library tag, so we use the
// HuggingFace GGUF that Ollama 0.24+ can pull directly. Switch to the 1.5b GGUF
// or a smaller quant (e.g. :Q8_0) via a per-repo .gtir/config.json override.
export const DEFAULTS = {
  model: "hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16",
  ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
  maxChars: 2000,
  minChars: 100,
  overlapChars: 400,
  maxFileBytes: 256 * 1024,
  embedBatch: 32,
  maxEmbedChars: 6000,           // hard cap on per-input embed length (avoids model context overflow)
  contextPrefix: true,            // synthetic prefix on by default
  contextTier: "synthetic",       // "synthetic" | "claude-cli"
  contextScope: true,             // prepend the AST scope breadcrumb (enclosing class/module) to code chunks
  noCache: false,
  rerank: false,                          // opt-in cross-encoder rerank; off by default
  rerankUrl: "http://127.0.0.1:8088",     // llama-server --reranking endpoint
  rerankModel: "bge-reranker-v2-m3",      // sent in the /rerank request (informational for a 1-model server)
  rerankCandidates: 24,                   // hybrid candidates to rerank before slicing to k
  rerankMaxChars: 2000,                   // per-document char cap (~512 tokens, bge context)
  bm25Boost: 3,                           // repeat the path+scope+decl head N times in the FTS text so BM25 weights symbol/path matches above incidental body hits (0 = index raw text)
  ftsWeight: 0.1,                         // BM25 branch weight in RRF fusion relative to the vector branch (1 = classic RRF). 0.1 favors the embedder on conceptual/cross-vocab queries while keeping BM25's exact-symbol wins; tuned on the eval set (hard tier +6.7pp, symbol tier retained). Set 1 for classic RRF, 0 for vector-only.
  version: 1,
  skipDirs: [
    "node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache",
    "target", "coverage", ".obsidian", ".trash", ".worktrees", ".venv",
    ".gtir", "test-results", "playwright-report", "src-tauri",
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
