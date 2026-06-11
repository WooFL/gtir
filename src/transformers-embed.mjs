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

function getExtractor(cfg, repo, dtype) {
  const key = `${repo}::${dtype}`;
  let p = _pipelines.get(key);
  if (p) return p;
  p = (async () => {
    const { pipeline, env } = await loadLib();
    // Pin the on-disk model cache to a stable, gtir-owned dir (default is deep under node_modules). This dir
    // IS the offline bundle: warm it once with remote allowed (`gtir doctor`), and a later localOnly run reads
    // the same files with no network. Always applied so warm + serve agree on one location.
    if (cfg.transformersCacheDir) env.cacheDir = cfg.transformersCacheDir;
    // Zero-egress: by default transformers.js fetches the model from the HF hub on first run — a network path
    // net-guard does NOT see. transformersLocalOnly forbids that; transformers.js then serves only from the
    // local cache (cacheDir, warmed earlier) or a pre-staged localModelPath, restoring the no-egress guarantee.
    if (cfg.transformersLocalOnly) {
      env.allowRemoteModels = false;
      if (cfg.transformersModelDir) env.localModelPath = cfg.transformersModelDir;
    }
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

// Test/model-switch hook: drop the cached pipelines.
export function _resetPipelines() { _pipelines.clear(); }
