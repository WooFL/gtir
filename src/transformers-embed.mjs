// In-process embedding backend via @huggingface/transformers (ONNX / onnxruntime-node).
// Drops the Ollama server: produces the SAME thing embed.mjs does — an array of L2-normalized
// vectors, one per input — but by running the model inside this Node process instead of POSTing to
// localhost:11434. Selected by `embedBackend: "transformers"` in .gtir/config.json; config.loadConfig
// then hangs the returned closure on cfg.embedImpl, which search.mjs / indexer.mjs already prefer over
// the Ollama path (`cfg.embedImpl ?? embedTexts`). No other call site changes.
//
// @huggingface/transformers is an OPTIONAL dependency: it is imported lazily (first embed call), so the
// Ollama path and the whole test suite keep working with it uninstalled. Picking the transformers backend
// without it installed throws a clear install hint.
//
// PARITY NOTE: the Ollama path sends raw chunk text with no task-instruction prefix, so this backend does
// the same (no `search_document:` / qwen3 query instruction). That keeps vectors comparable to the current
// index; adding asymmetric query/doc prefixes is a separate quality lever (and needs a role flag the
// embedImpl contract — `(texts) => vec[]` — does not carry today).

// Known Ollama model tags → their transformers.js ONNX repo + the pooling the model was trained for.
// Getting pooling wrong yields plausible-but-wrong vectors that only an eval catches, so it is pinned
// per model: Qwen3-Embedding is last-token pooled; nomic is mean pooled.
const PROFILES = {
  "qwen3-embedding:0.6b": { repo: "onnx-community/Qwen3-Embedding-0.6B-ONNX", pooling: "last_token" },
  "nomic-embed-text":     { repo: "Xenova/nomic-embed-text-v1",              pooling: "mean" },
};

// Resolve the ONNX repo + pooling for a cfg. A cfg.model that is not a known Ollama tag is treated as a
// direct HF repo id / local path; its pooling must then be given via cfg.transformersPooling (default mean).
function profileFor(cfg) {
  const known = PROFILES[cfg.model];
  if (known) return known;
  return { repo: cfg.model, pooling: cfg.transformersPooling ?? "mean" };
}

async function loadLib() {
  try {
    return await import("@huggingface/transformers");
  } catch (cause) {
    const e = new Error(
      'embedBackend "transformers" needs the optional dependency @huggingface/transformers. ' +
      "Install it: npm i @huggingface/transformers",
    );
    e.cause = cause;
    throw e;
  }
}

// One loaded pipeline per (repo, dtype) — keyed so a notes-vault nomic model and a code qwen3 model can
// coexist in one process (e.g. `gtir serve` with two indexes). Memoizes the in-flight promise, not just
// the result, so concurrent first calls share a single load.
const _pipelines = new Map();

// Apply the gtir-owned cache + zero-egress settings to the shared transformers.js env. Used by both the
// embedder and the reranker so they agree on cache location and offline policy.
//   - cacheDir is the on-disk model cache (default is deep under node_modules) = the offline bundle: warm it
//     once with remote allowed (`gtir doctor`), and a later localOnly run reads the same files with no network.
//   - transformersLocalOnly forbids the HF-hub fetch transformers.js does by default (a path net-guard can't
//     see); the library then serves only from cacheDir or a pre-staged localModelPath — restoring zero-egress.
function applyEnv(env, cfg) {
  if (cfg.transformersCacheDir) env.cacheDir = cfg.transformersCacheDir;
  if (cfg.transformersLocalOnly) {
    env.allowRemoteModels = false;
    if (cfg.transformersModelDir) env.localModelPath = cfg.transformersModelDir;
  }
}

function getExtractor(cfg, repo, dtype) {
  const key = `${repo}::${dtype}`;
  let p = _pipelines.get(key);
  if (p) return p;
  p = (async () => {
    const { pipeline, env } = await loadLib();
    applyEnv(env, cfg);
    return pipeline("feature-extraction", repo, { dtype });
  })();
  _pipelines.set(key, p);
  return p;
}

// Build an embedImpl: (texts: string[]) => Promise<number[][]>, each vector L2-normalized (normalize:true),
// matching embed.mjs's l2normalize so cosine stays a dot product downstream.
export function makeEmbedImpl(cfg) {
  const { repo, pooling } = profileFor(cfg);
  const dtype = cfg.transformersDtype ?? "fp32";   // fp32 (parity) | fp16 | q8 (smaller/faster, lower precision)
  const maxChars = cfg.maxEmbedChars ?? 6000;
  return async function embedTexts(texts) {
    if (!texts.length) return [];
    const extractor = await getExtractor(cfg, repo, dtype);
    const inputs = texts.map((t) => String(t).slice(0, maxChars));
    const out = await extractor(inputs, { pooling, normalize: true });
    return out.tolist();   // Tensor [n, dim] → number[][]
  };
}

// Probe the embedding dimension (mirrors embed.probeDim for the transformers path).
export async function probeDim(cfg) {
  const [v] = await makeEmbedImpl(cfg)(["ping"]);
  return v.length;
}

// --- Cross-encoder reranker (the in-process counterpart of rerank.mjs's llama-server /rerank) ---

// Known llama-server rerank model tags → their transformers.js ONNX repo. An unknown tag (or an explicit
// transformersRerankRepo) is used as a direct HF repo id / local path.
const RERANK_PROFILES = {
  "bge-reranker-v2-m3": { repo: "onnx-community/bge-reranker-v2-m3-ONNX" },
};

function rerankRepoFor(cfg) {
  if (cfg.transformersRerankRepo) return cfg.transformersRerankRepo;
  return RERANK_PROFILES[cfg.rerankModel]?.repo ?? cfg.rerankModel;
}

// One loaded (model, tokenizer) per (repo, dtype), memoized like the embed pipelines.
const _rerankers = new Map();

function getReranker(cfg, repo, dtype) {
  const key = `${repo}::${dtype}`;
  let p = _rerankers.get(key);
  if (p) return p;
  p = (async () => {
    const { AutoModelForSequenceClassification, AutoTokenizer, env } = await loadLib();
    applyEnv(env, cfg);
    const [model, tokenizer] = await Promise.all([
      // graphOptimizationLevel:"disabled" sidesteps an onnxruntime-node graph-fusion bug that crashes
      // initialization of the bge-reranker fp16 export (SimplifiedLayerNormFusion on a missing node arg).
      // Rerank runs over ~24 candidates, so skipping fusion optimizations costs nothing noticeable.
      AutoModelForSequenceClassification.from_pretrained(repo, { dtype, session_options: { graphOptimizationLevel: "disabled" } }),
      AutoTokenizer.from_pretrained(repo),
    ]);
    return { model, tokenizer };
  })();
  _rerankers.set(key, p);
  return p;
}

// Build a rerankImpl: (query, docs: string[]) => Promise<[{index, score}] | null>, sorted by score desc.
// Mirrors rerank.mjs's contract exactly — it NEVER throws fatally: on any failure (dep missing, model not
// staged offline, bad output) it returns null so search() silently falls back to RRF hybrid order. bge-reranker
// is a single-logit cross-encoder; the raw logit is the relevance score (sigmoid would be monotonic, so the
// ranking is identical — we keep the logit).
export function makeRerankImpl(cfg) {
  const repo = rerankRepoFor(cfg);
  // Default fp16: a single-file export (~1.1 GB). fp32 is split (model.onnx + a 2.3 GB .onnx_data sidecar
  // transformers.js does not auto-fetch), so it is NOT a safe default here — unlike the embed model.
  const dtype = cfg.transformersRerankDtype ?? "fp16";
  const cap = cfg.rerankMaxChars ?? 2000;
  return async function rerank(query, docs) {
    if (!docs.length) return [];
    try {
      const { model, tokenizer } = await getReranker(cfg, repo, dtype);
      const passages = docs.map((d) => String(d).slice(0, cap));
      const inputs = tokenizer(new Array(passages.length).fill(query), { text_pair: passages, padding: true, truncation: true });
      const { logits } = await model(inputs);
      const scores = logits.tolist().map((row) => row[0]);   // [n, 1] → n relevance logits
      if (scores.length !== docs.length) return null;
      return scores
        .map((score, index) => ({ index, score }))
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      process.stderr.write(`[gtir] transformers rerank unavailable (${err.message}), using hybrid order\n`);
      return null;
    }
  };
}

// Probe the reranker for `gtir doctor`: score one trivial pair, return true iff it produced a ranking.
export async function probeRerank(cfg) {
  const ranked = await makeRerankImpl(cfg)("ping", ["pong"]);
  return Array.isArray(ranked) && ranked.length === 1;
}

// Test/model-switch hook: drop the cached pipelines + rerankers.
export function _resetPipelines() { _pipelines.clear(); _rerankers.clear(); }
