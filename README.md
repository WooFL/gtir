# gtir

**gtir** (Armenian *գտնել*, "to find") — a portable, install-once CLI for semantic **code and notes** retrieval over any repository or note vault. It chunks code with tree-sitter (AST-aware, with a cAST sibling-merge refinement), embeds chunks via a local **Ollama** model (`jina-code-embeddings-0.5b`), stores vectors + a BM25 index in **LanceDB**, and answers queries with hybrid (vector + BM25 + RRF) search.

**Scope:** code *and* notes. gtir indexes a codebase (`jina-code-embeddings`) or an Obsidian-style note vault (`nomic-embed-text`) — `gtir init` auto-detects which, and the MCP server exposes `search_code` / `search_notes` accordingly. It runs natively on Windows, macOS, and Linux (no Unix-only shell scripts).

## How it works

```
walk repo (.gitignore-aware)
  → tree-sitter AST chunks (+ cAST sibling-merge; recursive fallback for grammarless files)
  → markdown: heading-aware sections, each carrying its heading breadcrumb + frontmatter tags
  → contextual prefix per chunk: code chunks prepend an AST scope breadcrumb
    (path › enclosing class/module — first line); markdown uses its heading breadcrumb;
    grammarless files use path + first line (opt-in claude-cli tier still available)
  → embed via Ollama /api/embed  (jina-code-embeddings-0.5b)
  → LanceDB upsert (vectors + BM25 FTS over a path/scope/decl-weighted text)
search: query → embed → vector branch + BM25 branch → query-adaptive Reciprocal Rank Fusion (k=60)
```

Everything runs through **one runtime — Ollama** (the same daemon that serves `nomic-embed-text` for your notes). No Python, no sentence-transformers, no torch.

The AST scope breadcrumb is **additive** — it prepends the enclosing class/module to the chunk's
informative first line rather than replacing it. It restores the context a method loses when it is
sliced out of a large class: on a scope-ambiguous fixture (two big classes with identically-named
methods), it lifted Recall@1 and Sec-hit@1 by ~6 points each via `gtir eval`, with no regression on
the rest of the corpus. (No LLM, no second model — it reuses structure tree-sitter already parsed.)
The gain is corpus-dependent — it helps codebases with large classes and method-name ambiguity,
and is neutral elsewhere. Disable it per-repo with `{ "contextScope": false }` in `.gtir/config.json`.

The BM25 branch indexes a **field-weighted** text rather than the raw chunk body: the tokenized file
path, enclosing scope, and declaration line are repeated `bm25Boost` (=3) times ahead of the body, so
a lexical match on a *symbol or path* outweighs an incidental mention of it in some other file's body.
This is the main defense against shadowing — a test or doc that merely references a symbol no longer
outranks the source that defines it. Measured on the fixture via `gtir eval` (embeddings unchanged, so
the gain is purely BM25): overall Recall@1 0.77 → ~0.82, gate tier 0.84 → 0.90. Tune or disable it with
`{ "bm25Boost": 0 }` in `.gtir/config.json` (0 indexes the raw body, as before).

**Query-adaptive fusion (`ftsWeight` / `ftsWeightSymbol`).** The two branches have opposite strengths:
the dense embedder wins conceptual and cross-vocabulary queries, while BM25 wins exact-symbol lookups
(searching `fetchWithRetry` by name). An ablation showed *any* single fusion weight is a compromise —
it trades one for the other. So gtir routes by query intent instead: `isSymbolQuery()` flags a query
that is a single bare identifier (`fetchWithRetry`, `LRUCache`, `grid_shortest_path`) as an
exact-lookup, and those get `ftsWeightSymbol` (default `1` — classic equal-weight RRF, BM25 leads);
every natural-language query gets `ftsWeight` (default `0` — vector-only, the embedder leads). Each
RRF weight scales the BM25 branch relative to the vector branch. On the eval set this is the best of
both with no compromise — overall Recall@1 **0.85 → 0.90**, the conceptual *hard* tier matches
vector-only (0.90) and the exact-symbol tier matches BM25 (0.92) — beating both a fixed weight (0.85)
and vector-only (0.86). Detection is exact on the fixture (12/12 symbol queries, zero false positives
on 81 NL queries). Override either weight per-repo in `.gtir/config.json`.

**Test-file demotion (`testPenalty`, code repos only).** Field-weighting handles *incidental*
mentions, but a *test* for an implementation is a strong, legitimate match — `config.test.mjs`
genuinely is about config — so it can still outrank the source you actually want. In a code repo a
query for an implementation almost never wants its test, so gtir multiplies the fused score of
conventional test paths (`*.test.*`, `*_test.go`, `test_*.py`, `tests/`, `spec/`) by `testPenalty`
(default `0.5`), sinking them below comparably-ranked source. Two guards keep it honest: it is skipped
when the query is itself test-seeking (mentions tests / specs / mocks / fixtures — so *"test that a
retry succeeds"* still finds the test), and it is disabled entirely in notes mode, where `.md` *is* the
content. Measured on gtir's own source with its real tests as decoys (one shared index, so the prior is
the only variable): overall Recall@1 **0.70 → 0.76**, the exact-symbol tier **0.75 → 1.00**, with
provably zero change on the fixture (no fixture golden target is a test file). Set `{ "testPenalty": 1 }`
to disable.

## Install

```bash
git clone <gtir repo> && cd gtir
npm install
npm link            # exposes `gtir` globally
```

Prereqs: **Node ≥20**, **Ollama ≥0.24** running locally.

## Setup (once per machine)

```bash
# Pull the embedding model (HuggingFace GGUF — Ollama has no official tag for it):
ollama pull hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16

# Verify Ollama serves it and record the embedding dimension:
gtir setup --repo <project>
# → gtir: Ollama OK — model=hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16 dim=896
```

## Quick start — `gtir init`

One command sets up a repo or vault end-to-end:

```bash
gtir init --repo <path>          # auto-detects notes vs code
```

It detects whether the target is a **note vault** (has `.obsidian/` or is markdown-dominant → `nomic-embed-text` + prose chunk sizes) or a **codebase** (→ `jina-code` defaults), then:
1. writes the right `.gtir/config.json` (never clobbers an existing one),
2. appends `.gtir/` to `.gitignore`,
3. builds the first index,
4. installs the post-commit auto-refresh hook — or, if it detects **lefthook/husky**, prints the snippet to add instead of clobbering the managed hook.

For a code repo with a **nested vault** (e.g. `wiki/`), it auto-adds that folder to `skipDirs` so it isn't double-indexed with the code model.

Flags: `--notes` / `--code` to force the mode, `--no-index`, `--no-hook`.

## Use

```bash
gtir index   --repo <project> [--rebuild] [--no-cache]  # build / full rebuild
gtir refresh --repo <project> [--no-cache]              # incremental (changed files only)
gtir search  "how are sessions created" --repo <project> [-k 8] [--language python] [--path-prefix src/]
gtir status  --repo <project>                          # model, dim, file count
gtir hook    --repo <project> [--remove]               # install/remove post-commit auto-refresh
```

- `search` prints JSON to **stdout** (pipe to `jq`); all human-readable logs go to stderr.
- The index lives in `<project>/.gtir/` — regenerable, add it to `.gitignore`.
- `gtir hook` installs a git `post-commit` hook so the index refreshes itself as you commit; it's idempotent and preserves any existing hook.

### Embedding cache (content-addressed)

An embedding is a pure function of `(model, embedText)`, and the index already stores
embeddings for the current content. gtir keys each chunk row by `content_hash =
sha256(embedText)` and, before embedding, reuses the prior index's vectors for any chunk
whose embedded text is byte-identical — so **unchanged content is never re-embedded**. This
helps both `--rebuild` (reuse the whole unchanged corpus) and `refresh` (reuse unchanged
sections of a changed file). The hash covers the *contextualized* text (heading breadcrumb /
prefix included), so a rename or markdown retitle correctly invalidates the entry.

The stats line reports the split: `gtir: indexed N chunks (R reused, K embedded), dim=D`.

- Reuse is gated on `meta.model === cfg.model`, so switching the embedding model re-embeds
  everything (no stale-model vectors).
- Pre-feature indexes (built before this column existed) keep working unchanged; a one-time
  `gtir index --rebuild` migrates them and enables the cache thereafter.
- `--no-cache` forces a full re-embed (for debugging or distrust of the cache).

## Measuring retrieval quality — `gtir eval`

gtir ships a committed eval harness so retrieval changes are measurable, not vibes:

    gtir eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json            # score the golden set, compare to baseline
    gtir eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --save     # set the current metrics as the new baseline

It runs a hand-authored golden query set (`eval/golden.json`) against a fixture corpus
(`eval/corpus/`) and reports **Recall@{1,5,10}**, **MRR**, and **Sec-hit@{1,5}**, then compares
to `eval/baseline.json` and **exits non-zero if any metric regressed** (CI-usable). The harness is
corpus-agnostic — point `--repo` at any index and pass `--golden <file>` to score your own set.
`--json` emits the metrics object to stdout; `--no-build` skips the pre-run refresh.

A/B across a change: `gtir eval --save` on the old commit, then `gtir eval` on the new one reads
the delta. Metric math is unit-tested (hermetic); the corpus run needs Ollama.

**Where golden/baseline live:** keep `golden.json` / `baseline.json` *outside* the indexed
tree (the bundled fixture keeps them at `eval/`, scoring the corpus under `eval/corpus/`). If you
point `--repo` at a tree that contains your golden file, that JSON gets indexed as corpus content
and can surface in results — pass `--golden`/`--baseline` to files kept outside `--repo`, or add
them to the index's skip list.

**Tiers — gate vs meter:** golden entries carry a `tier`. The **`gate`** tier (51 near-saturated
queries) is the strict regression floor; the **`hard`** tier (~30 queries over realistic decoys —
near-duplicate implementations, test-file/doc-copy shadows, method-name ambiguity, and
cross-vocabulary phrasings) is the improvement meter; the **`symbol`** tier (12 bare-identifier
lookups like `LRUCache`) covers exact-symbol search, where BM25 carries the weight. The hard and
symbol tiers pull in opposite directions (dense vs lexical), which is what makes them useful for
tuning the fusion weight rather than overfitting to one query style. `gtir eval` prints overall **and** per-tier metrics, and **exits
non-zero on a regression in the overall or `gate` metrics** (`tol = 0.02`). The `hard` tier is the
*meter*, not a gate: it's small enough that one borderline query flipping rank 1↔2 between runs moves
its recall by ~1/30 ≈ 0.03 (Ollama's embedding inference isn't bit-exact), so gating on it would
flake — instead it's reported with deltas so you can read a real gain. Measured: overall/`gate`
metrics are stable run-to-run; if a single small regression ever shows, re-run to confirm — a
cold-start flip clears, a real regression (≥0.05) persists. Decoys follow one authoring rule: each
query has exactly one defensible target; a decoy must be wrong for the intent, only superficially
similar.

## Reranking (optional cross-encoder stage)

gtir can rerank the top hybrid candidates with a **cross-encoder** before returning them. A
bi-encoder (the default vector+BM25+RRF path) scores query and document separately; a cross-encoder
reads the `(query, chunk)` pair together, so it resolves *intent* — which is what beats shadowing
(a test file or doc-copy outranking the source the query actually wants). It's **off by default** and
needs a separate `llama-server` runtime, so it's opt-in.

**Setup (once):**

1. Download a reranker GGUF (~600 MB), e.g. `bge-reranker-v2-m3-Q8_0.gguf`, into a local
   models directory.
2. Run llama.cpp's server with the reranking endpoint:

       llama-server.exe -m models\bge-reranker-v2-m3-Q8_0.gguf --reranking --pooling rank --host 127.0.0.1 --port 8088

3. Enable it per-repo in `.gtir/config.json`: `{ "rerank": true }` — or pass `--rerank` per command.

**Config keys** (defaults): `rerank` (`false`), `rerankUrl` (`http://127.0.0.1:8088`), `rerankModel`
(`bge-reranker-v2-m3`), `rerankCandidates` (`24` — how many hybrid hits to rerank), `rerankMaxChars`
(`2000` — per-document cap, ~512 tokens).

If the server is unreachable, gtir **degrades gracefully** to hybrid order with a one-line stderr
note — it never fails a search because the reranker is down.

**Measure the gain** with the eval harness (the rerank stage is deterministic, so the delta is real):

       gtir eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --no-build            # hybrid (floor)
       gtir eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --no-build --rerank   # + rerank

Compare the **`hard`-tier** Recall@1 between the two runs — that tier encodes the shadowing cases the
reranker is meant to fix. The reranker is swappable (it's just the GGUF `llama-server` loads plus the
`rerankModel` label), so trying `jina-reranker-v2` later is a relaunch, not a code change.

**Measured A/B (2026-06-01) — two rerankers, both a net negative on the bundled fixture.** Each
stable across 3 paired runs (hybrid hard-tier Recall@1 = 0.633 every run):

| reranker | hard Recall@1 | hard MRR | hard Recall@5 |
|---|---|---|---|
| *(hybrid, no rerank)* | **0.633** | ~0.724 | 0.867 |
| `bge-reranker-v2-m3` Q8_0 | 0.600 | ~0.710 | ~flat |
| `jina-reranker-v2-base-multilingual` Q8_0 | 0.567 | ~0.686 | ~flat–0.900 |

Both demote correct top-1 hits; neither beats the hybrid. So the stage stays **off by default**.
Honest read: the hybrid RRF order is already strong here, and a pointwise cross-encoder reranking
short code chunks — without the contextual prefix the *embedder* sees (path › scope), so with *less*
context than the index — doesn't add over it. The harness earned its keep: it caught a plausible,
expensive-sounding feature before it shipped as a default.

Caveats and unexplored levers (the infrastructure stays in place for them): this is the synthetic
fixture, not real code; feeding the reranker the *contextualized* text rather than raw chunk text is
untried; and `jina-reranker-v3` is a different (listwise) paradigm that needs a llama.cpp fork + an MLP
projector, so it's a separate integration, not a drop-in swap.

## MCP server (use gtir from inside Claude)

Expose gtir's search as native MCP tools so Claude can call them mid-session:

    gtir mcp --repo <codeRepo> --repo <wikiRepo>

It serves one tool per index — `search_code`, `search_notes` (auto-labeled from each
index's model; override with `--label name:<repo>`) — plus `gtir_status`. Register it by
pasting the snippet from:

    gtir mcp --repo <codeRepo> --repo <wikiRepo> --print-config

into your project's `.mcp.json` (`mcpServers`). The server is stdio JSON-RPC, zero extra
deps, and adds no new retrieval logic — it wraps the same hybrid search as the CLI.

## Model

Default model tag (in `src/config.mjs`): `hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16` (994 MB, ~896-dim).

- **Smaller/faster:** override with a lower quant in `<project>/.gtir/config.json`, e.g. `{ "model": "hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:Q8_0" }` (531 MB) or `:IQ4_XS` (349 MB), then `gtir index --rebuild`.
- **Max recall:** use the 1.5B sibling — `hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:<quant>`.
- Changing the model changes the embedding dimension, so a full `gtir index --rebuild` is required (the old vectors are incompatible).

## Known limitations

- **FTS index is maintained incrementally.** First build (and `gtir index --rebuild`) build the BM25
  index in full; each `gtir refresh` then folds only the changed fragments in via LanceDB `optimize()`
  (O(changed), not O(corpus)). Deleted rows are filtered from results immediately and physically pruned
  on the next refresh that adds rows.
- **Oversize *leaf* nodes are re-split, not dropped.** A function/struct larger than `maxChars`
  (2000) with no nested target nodes is split into line-aware windows (same fallback as
  grammarless files), so its content stays searchable. Oversize *containers* (class/impl/mod)
  are still represented by their members, which are indexed as their own chunks — the container's
  own non-member lines (e.g. a class docstring) are not separately re-split.
- **No automatic dimension-skew guard at query time.** `meta` records the model + dim; if you switch models, rebuild. (`gtir status` shows the recorded dim.)

## Development

```bash
npm test        # node --test — full suite, hermetic (embedder is injected; no Ollama needed)
```

Tests never hit the network: the Ollama client and embedder are injectable (`cfg.fetchImpl` / `cfg.embedImpl`), so unit and integration tests run offline against a fake embedder.

## License

[MIT](LICENSE) © 2026 WooFL
