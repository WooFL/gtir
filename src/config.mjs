import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { langFor } from "./languages.mjs";

// `model` is the Ollama tag served via /api/embed; pull it with `ollama pull <model>`
// (or `gtir doctor`). Default is qwen3-embedding:0.6b — an embedding-native model Ollama
// serves first-class because its GGUF carries the `pooling_type` metadata Ollama's engine
// requires. On the bundled eval it MATCHED the older jina-code-embeddings-0.5b (overall R@1
// 0.913 and MRR 0.945 — a tie) while staying a clean one-command `ollama pull`. The jina-code
// GGUF is a Qwen2 decoder with no pooling_type, so Ollama's newer engine refuses to embed it
// ("does not support embeddings"); see README "Embedding model" to use it via llama-server.
// Override per-repo in .gtir/config.json (e.g. qwen3-embedding:4b for higher recall).
export const DEFAULTS = {
  model: "qwen3-embedding:0.6b",
  ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
  maxChars: 2000,
  minChars: 100,
  overlapChars: 400,
  maxFileBytes: 256 * 1024,
  embedBatch: 32,
  maxEmbedChars: 6000,           // hard cap on per-input embed length (avoids model context overflow)
  // Ollama embed resilience (see docs/superpowers/specs/2026-06-04-gtir-ollama-resilience-design.md).
  embedTimeoutMs: 60000,        // per-batch /api/embed call timeout; cold reload of a 4b override fits
  embedRetries: 2,              // retries for RETRYABLE failures (timeout / network / 5xx)
  embedRetryBackoffMs: 500,     // exponential backoff base: 500ms, 1s, 2s
  warmupOnStart: true,          // gate preflight+probe pre-load on `index`/`mcp` start (false = skip, trust retry)
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
  testPenalty: 0.5,                       // CODE mode: RRF score multiplier for test-file paths (a query for an impl shouldn't surface its test at #1); skipped for test-seeking queries and in notes mode. 1 = off
  findCandidates: 200,                     // MCP `find`: how many BM25 candidates to scan for the symbol's declaration. Wider = catches definitions of heavily-referenced symbols (whose decl ranks below many mentions), at more scan cost. Capped at 1000.
  centralityWeight: 0.15,   // `--centrality`/centrality:true: ceiling of the degree multiplier (1 → 1.15)
  centralityK: 8,           // half-saturation degree for the centrality multiplier
  centralityTieEps: 0.000001, // `--centrality` is tiebreaker-only: reorder hits only within this RRF-score band. Must be << the inter-rank RRF gap (~2.6e-4) so only genuine ties move; larger values demote exact matches (measured: 0.001 cost 25pp recall@1, a score-multiplier cost ~4.5pp).
  contextCap: 5,            // `--edges`/edges:true: max callers + max callees attached per hit
  relatedNotesCap: 8,      // `context`/`notes_for`: max wiki notes attached per code item
  metricsWindow: 1000,          // commits scanned by cochange/hotspots
  cochangeMinSupport: 3,        // min co-change count to report a pair
  metricsMaxCommitFiles: 25,    // skip commits touching more files than this (weak signal)
  // Connections pane (gtir serve /connections): note-to-note related-notes ranking.
  connK: 12,               // results returned per active note
  connGraphWeight: 0.25,   // ceiling of the link-graph proximity multiplier (1 -> 1.25)
  connGraphHops: 2,        // max BFS hop distance counted as "near" in the link graph
  connFusion: true,        // fold wikilink-graph proximity into the ranking (false = vector+BM25 only)
  crossLinkCap: 15,        // max note->code cross-links returned per note
  // `context` task-shaped tool: bundle size + confidence thresholds.
  contextK: 5,              // query-mode result count
  contextMarginHigh: 0.30,  // relative top-vs-#2 margin -> retrieval_quality "high"
  contextMarginLow: 0.08,   // below this (near-tied) -> "low" + best_guesses
  disambiguate: true,        // promote ambiguous call edges to conf:"inferred" via embedding similarity
  disambigThreshold: 0.55,   // min cosine(call-site, candidate def) to promote (precision-first)
  disambigMargin: 0.05,      // min lead of the best candidate over the runner-up to promote
  cppSmartPointers: ["unique_ptr", "shared_ptr", "weak_ptr"],  // wrapper templates whose ptr->m() unwraps to the element type (add custom forwarders, e.g. "AEFX_SuiteScoper")

  // Query-adaptive RRF fusion weights for the BM25 branch (relative to the vector branch = 1).
  // Conceptual/natural-language queries let the embedder lead (ftsWeight, low); single bare-identifier
  // queries (exact-symbol lookups) let BM25 lead (ftsWeightSymbol, ~classic RRF). See isSymbolQuery.
  ftsWeight: 0,                           // conceptual queries: vector-led (0 = vector-only). Swept on qwen3-embedding:0.6b (`gtir eval --tune`): any BM25 weight monotonically hurts — hard-tier R@1 0.879→0.727 at 0.3. 0 is optimal.
  ftsWeightSymbol: 1,                     // bare-identifier queries: classic equal-weight RRF (BM25 leads)
  ftsWeightMixed: 1,                      // NL query that NAMES a symbol (camelCase/snake/etc.): treat like the symbol bucket — equal-weight RRF. Swept on qwen3-embedding:0.6b: 0.1–0.5 are INERT (mixed R@1 stuck at 0.90, identical to off); only full weight 1 flips the symbol-naming query (mixed R@1 0.90→1.00, overall R@1 +0.009, zero regression on gate/hard/symbol). The old "saturates at 0.3" tuning was for the jina-code model; re-tune with `gtir eval --tune "ftsWeightMixed=0,0.3,0.5,1"` after any model change.

  version: 1,
  skipDirs: [
    "node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache",
    "target", "coverage", ".obsidian", ".trash", ".worktrees", ".venv",
    ".gtir", "test-results", "playwright-report", "src-tauri",
    "vendor", "third_party", "thirdparty", "external",           // vendored dependencies
    "Debug", "debug", "Release", "release", "x64", ".vs", "obj",  // common C/C++/C# build output
  ],
  skipSuffixes: [".excalidraw.md", ".lock", ".min.js", ".min.css", ".map"],
  // `gtir stale`: gitignore-style globs (matched against repo-relative note paths) to exclude from
  // drift checks — e.g. archived/ingest sources whose code citations are historical (`[".raw/"]`).
  // A report-time view filter: the baseline still records every note, so editing this needs no re-baseline.
  staleIgnore: [],
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

// Real programming-language grammar ids (excludes markdown + data/markup like json/yaml/css/html).
// A repo with ANY of these is "a codebase" → keep the default (code) model.
const CODE_LANGS = new Set(["typescript", "tsx", "javascript", "python", "rust", "go", "cpp", "c", "objc", "hlsl", "glsl", "bash"]);

// Pick the embedding model from the indexable file mix: nomic-embed-text when the set is a notes
// vault (>=1 markdown file and ZERO code-language files), else null (caller keeps its default/qwen).
export function pickEmbedModel(relPaths) {
  let md = 0, code = 0;
  for (const p of relPaths || []) {
    const ext = (String(p).match(/\.[^.\\/]+$/) || [""])[0].toLowerCase();
    if (ext === ".md" || ext === ".mdx") { md++; continue; }
    if (CODE_LANGS.has(langFor(ext))) code++;
  }
  return md > 0 && code === 0 ? "nomic-embed-text" : null;
}

// Resolve the embedding model for a repo, auto-detecting + persisting a notes vault's nomic model.
// Respects an explicit `model` in .gtir/config.json (returns cfg.model unchanged). On a notes vault
// with no pin, writes { ...existing, model } back to .gtir/config.json so index+search stay consistent.
export function resolveAutoModel(cfg, relPaths) {
  const file = join(cfg.repo, ".gtir", "config.json");
  let raw = {};
  if (existsSync(file)) { try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { raw = {}; } }
  if (raw.model) return cfg.model;                 // explicit pin — never override
  const detected = pickEmbedModel(relPaths);
  if (!detected) return cfg.model;                 // codebase — keep the default, write nothing
  mkdirSync(join(cfg.repo, ".gtir"), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...raw, model: detected }, null, 2) + "\n");
  return detected;
}
