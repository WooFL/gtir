# Cross-Encoder Rerank Stage — Design

**Date:** 2026-06-01
**Status:** Approved (brainstorming → spec)
**Repo:** `G:\demon\gtir`

## Problem

gtir's retrieval is bi-encoder hybrid (vector + BM25 + RRF). Its real bottleneck is **shadowing** —
a test file, doc-copy, or near-duplicate implementation outranking the source the query wants.
Shadowing is **intent-dependent** (sometimes the user wants the test/doc, usually the source), and a
bi-encoder can't tell: it only sees surface similarity. A cross-encoder reranker reads `(query, chunk)`
*together*, so it's the one tool that can resolve intent. The eval harness's `hard` tier (built last
session) encodes exactly these shadowing cases and is ready to measure the gain.

## Goal

Add a deterministic, query-time cross-encoder rerank stage that reorders the top-N hybrid candidates,
and measure its effect on the `hard` tier via the eval harness. No index change, no re-embedding.

## Substrate (decided)

llama.cpp's `llama-server` (build b9442 at `G:\demon\llamacpp`, CUDA 13.3 build) exposes a `/rerank`
endpoint under `--reranking --pooling rank`. It runs as a persistent local server, exactly like Ollama.
Cross-encoder scoring is a forward pass with no sampling → **deterministic**, which keeps the meter
clean (unlike an LLM-listwise reranker). Sharability is explicitly secondary to main-use quality here,
so the extra runtime is an accepted cost.

**Model:** ship Phase 1 with **bge-reranker-v2-m3** (568M XLM-RoBERTa, ~600 MB Q8_0 GGUF) — the
battle-tested choice for llama.cpp reranking. The design is model-agnostic (the reranker is just a
config value + whichever GGUF `llama-server` loads), so A/B-ing **jina-reranker-v2** later is a
relaunch + config change with **zero code change**.

## Non-Goals

- No auto-spawning of `llama-server` (process management, port conflicts, model-path discovery —
  complexity we don't need; Ollama isn't auto-spawned either).
- No index/embedding changes. Rerank is purely a search-time reordering.
- Rerank is **off by default** and **off in the committed eval config**, so the eval gate still runs
  with no rerank server present.

## Component 1 — Rerank client (`src/rerank.mjs`, new)

Mirrors `src/embed.mjs` (same HTTP + injection + graceful-degradation patterns).

```js
// POST {query, documents, top_n} to llama-server /rerank; return [{index, score}] sorted desc.
// Never throws fatally — returns null on any failure so the caller can fall back to RRF order.
export async function rerankDocs(query, docs, cfg) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const cap = cfg.rerankMaxChars ?? 2000;
  try {
    const res = await fetchImpl(`${cfg.rerankUrl}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.rerankModel,
        query,
        documents: docs.map((d) => String(d).slice(0, cap)),
        top_n: docs.length,
      }),
    });
    if (!res.ok) {
      process.stderr.write(`[gtir] rerank unavailable (HTTP ${res.status}), using hybrid order\n`);
      return null;
    }
    const data = await res.json();
    const results = Array.isArray(data) ? data : data.results;
    if (!Array.isArray(results)) return null;
    return results
      .map((r) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }))
      .filter((r) => Number.isInteger(r.index))
      .sort((a, b) => b.score - a.score);
  } catch (err) {
    process.stderr.write(`[gtir] rerank unavailable (${err.message}), using hybrid order\n`);
    return null;
  }
}
```

Notes:
- `top_n: docs.length` asks the server to score *all* candidates (we slice to k ourselves after).
- Client-side sort by score is defensive — never assume the server pre-sorts.
- Documents are char-capped (`rerankMaxChars`, default 2000 ≈ 512 tokens, bge's context) before send.

## Component 2 — Wire into search (`src/search.mjs`)

When `cfg.rerank` is truthy, fuse to a *larger* candidate set, rerank, reorder, then slice to k.
Mirrors how `embedImpl` is injected.

- Raise the vector/FTS fanout so it covers the rerank set:
  `const rcand = Math.min(50, cfg.rerankCandidates ?? 24);`
  `const fanout = Math.min(50, Math.max(limit * 3, 16, cfg.rerank ? rcand : 0));`
- Fuse to `cfg.rerank ? rcand : limit` (pass that as `fuseRRF`'s `limit` arg — `fuseRRF` unchanged).
- If `cfg.rerank`:
  - `const rerankImpl = cfg.rerankImpl ?? ((q, docs) => rerankDocs(q, docs, cfg));`
  - `const ranked = await rerankImpl(query, fused.map((r) => r.snippet));`
  - If `ranked` is a non-empty array: reorder `fused` by `ranked`'s index order, attach
    `rerank_score`, then `fused = reordered`.
  - If `ranked` is null/empty: keep RRF order (the client already warned).
  - `return fused.slice(0, limit);`
- When `cfg.rerank` is falsy: today's path, byte-for-byte unchanged.

Reorder detail: build the result as
`ranked.map(({index, score}) => ({ ...fused[index], rerank_score: Number(score.toFixed(4)) }))`,
guarding `fused[index]` exists, then append any fused rows the reranker omitted (shouldn't happen with
`top_n = length`, but defensive), then slice to `limit`.

## Component 3 — Config (`src/config.mjs`)

Add to `DEFAULTS`:

```js
rerank: false,                          // opt-in; off by default (eval gate runs with no server)
rerankUrl: "http://127.0.0.1:8088",     // llama-server --reranking endpoint
rerankModel: "bge-reranker-v2-m3",      // sent in the request; informational for a single-model server
rerankCandidates: 24,                   // how many hybrid candidates to rerank before slicing to k
rerankMaxChars: 2000,                   // per-document char cap (~512 tokens, bge context)
```

`rerankImpl` is honored if present (test injection), like `embedImpl` — it is not a default key.

## Component 4 — CLI `--rerank` flag (`bin/gtir.mjs`)

Add a `--rerank` flag parsed in `parseArgs` that sets `args.rerank = true`. In `runEval` and the
`search` command path, when `args.rerank`, override `cfg.rerank = true` for that invocation. This makes
the A/B a one-liner without editing config:

```
gtir eval   --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --no-build            # rerank OFF (floor)
gtir eval   --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --no-build --rerank   # rerank ON
gtir search "verify a signed token" --repo eval/corpus --rerank
```

## Component 5 — Model acquisition + server launch (operational)

Documented in the README, not code:

1. Download the GGUF (~600 MB) to `G:\demon\llamacpp\models\bge-reranker-v2-m3-Q8_0.gguf` (HuggingFace,
   e.g. `gpustack/bge-reranker-v2-m3-GGUF`).
2. Launch the server (CUDA build):
   `G:\demon\llamacpp\llama-b9442-bin-win-cuda-13.3-x64\llama-server.exe -m <gguf> --reranking --pooling rank --port 8088`
3. gtir health-checks via the request itself; if the server is down, it degrades to hybrid order with
   a one-line stderr hint. No separate `gtir` subcommand — graceful fallback is the contract.

## Data Flow

```
search(query, cfg, {k}):
  qvec = embed(query)
  vecRows = vector_search(qvec, fanout)     # fanout ≥ rerankCandidates when rerank on
  ftsRows = fts_search(query, fanout)
  fused   = fuseRRF(vecRows, ftsRows, rerank ? rerankCandidates : k)
  if rerank:
    ranked = rerankImpl(query, fused.map(snippet))   # [{index,score}] | null
    fused  = ranked ? reorder(fused, ranked) : fused  # graceful fallback
  return fused.slice(0, k)
```

## Error Handling / Edge Cases

- **Server down / HTTP error / bad JSON** → `rerankDocs` returns `null` → hybrid order, one-line warn.
  Never fatal. (Same contract as the existing FTS-unavailable fallback.)
- **Reranker returns fewer rows than sent** → reorder uses returned indices; any omitted fused rows are
  appended in RRF order before the final slice.
- **`rerank` off** → zero behavior change; the new code paths are not entered.
- **Index out of range from server** → filtered by the `fused[index]` existence guard.

## Testing

- **Hermetic unit tests** (no server):
  - `test/rerank.test.mjs`: `rerankDocs` parses `{results:[...]}` and sorts desc; returns `null` on
    `res.ok === false`; returns `null` on thrown fetch; char-caps documents. Uses an injected
    `cfg.fetchImpl` returning a fake `Response`.
  - `test/search.test.mjs` (extend): with `cfg.rerank = true` and an injected `cfg.rerankImpl`
    returning a reversed order, `search()` returns results in the reranked order; with `rerankImpl`
    returning `null`, `search()` returns hybrid (RRF) order. Inject `embedImpl` + a fake store as the
    existing search tests do.
- **Integration** (manual, needs `llama-server`): the A/B eval run — `gtir eval ... --rerank` vs
  without, comparing `hard`-tier Recall@1. Deterministic, so the delta is real.
- **README**: a rerank section — what it is, the launch command, the config keys, the A/B recipe, and
  the honest note that it requires the extra `llama-server` runtime.

## Success Criteria

1. `src/rerank.mjs` exists with the graceful-`null` contract; hermetic tests pass.
2. `search()` reorders by rerank when enabled, falls back to RRF when the server is absent, and is
   byte-unchanged when `rerank` is off.
3. Config keys added; `--rerank` flag wires through `eval` and `search`.
4. Full hermetic suite green (rerank off by default → no new server dependency for `npm test`).
5. A measured A/B on the `hard` tier: `gtir eval --rerank` vs baseline, delta reported. (Direction not
   pre-judged — the harness exists precisely to tell us the truth; a null or negative result is a
   valid, honest outcome that informs whether jina-reranker-v2 is worth the follow-up A/B.)
6. README documents the stage and the launch.
