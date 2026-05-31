# Content-hash embedding cache — Design

**Date:** 2026-05-31
**Status:** Approved design, pre-implementation
**Repo:** gtir (G:\demon\gtir)

---

## Context

Embedding is the expensive step of `gtir index`/`refresh`. Today every chunk of a
*changed* file is re-embedded, and a full `--rebuild` re-embeds *everything* — even
when a chunk's text is byte-identical to what the index already holds. With per-commit
auto-refresh now wired (a `post-commit` hook on both the code and wiki repos) over a
7412-chunk wiki index, this cost is paid on every commit; and model/chunker changes
re-embed the whole corpus (the markdown-chunking work re-embedded all 648 wiki pages;
the A/B benchmark re-embedded the wiki twice).

An embedding is a pure function of `(model, embedText)`, and the prior index *already
stores* embeddings for the current content. This adds a **content-addressed cache that
reuses the prior index's embeddings**, so unchanged content is never re-embedded.

---

## Goals / Non-Goals

**Goals**
- Skip the Ollama embed call for any chunk whose `embedText` is unchanged and whose
  embedding already exists in the current index (same model).
- Help **both** `--rebuild` (reuse all unchanged content) and `refresh` (reuse unchanged
  chunks within a changed file).
- Zero new dependencies, no new on-disk store — reuse the LanceDB chunks table.
- Backward compatible with pre-feature indexes; `--no-cache` escape hatch.
- Report reuse stats so the win is visible.

**Non-Goals**
- No separate cache file, no global cross-repo cache.
- No change to chunking, embedding math, or search.
- No cross-model reuse (an embedding is model-specific).

---

## Mechanism

### `content_hash` column
Each chunk row gains a `content_hash` column = `sha256(embedText)` (hex). It hashes the
**exact string that gets embedded** — i.e. the contextualized text (`prefix + "\n" +
text` for markdown/code), NOT just the raw body. So a rename or a markdown retitle
(which changes the prefix → changes `embedText`) correctly invalidates the entry.

### Cache load (at `buildIndex` start, before any eviction)
Build a map `cache: Map<content_hash, embedding>` from the existing index when **all**
hold:
1. the chunks table exists,
2. it has a `content_hash` column (i.e. last built with this feature),
3. `readMeta().model === cfg.model`.

Otherwise `cache` is empty. The map is loaded from **all** existing rows
(`select(["content_hash", "embedding"])`) so reuse is maximal (content-addressed across
the whole index, including chunks that moved between files).

### Embed with cache (replaces the single `embed(...)` call in the indexer)
For the contextualized chunks `ctx`:
1. Compute `h = sha256(c.embedText)` for each.
2. Partition: if `cache.has(h)` → reuse `cache.get(h)`; else add to `misses`.
3. Embed only `misses` via the existing `embed` function (one batched Ollama pass).
4. Reassemble `vecs` in original chunk order (cached vectors + freshly embedded ones).
5. `dim` = length of any vector (cached or fresh).

### Write
Rows now include `content_hash: h`. Stats line:
`gtir: indexed N chunks (R reused, K embedded), dim=D` (and the analogous refresh line).

### Model safety
The cache loads only when `meta.model === cfg.model`, so switching the embedding model
re-embeds everything (no stale-model vectors).

### `--no-cache`
`gtir index --rebuild --no-cache` forces `cache = empty` (full re-embed) — for debugging
or distrust of the cache. (Flag is accepted on `index`/`refresh`.)

---

## Components & integration

- **`src/store.mjs`** — add two helpers on the object `openStore` returns:
  - `hasContentHash()` → boolean: does the `chunks` table schema include `content_hash`?
    (Read the table schema / a sample row; an empty/absent table → false.)
  - `loadEmbedCache()` → `Map<string, number[]>` of `{content_hash → embedding}` from the
    chunks table (empty Map if no table or no `content_hash` column).
- **`src/indexer.mjs`** — `buildIndex`:
  - After `openStore`, before eviction: `const useCache = !cfg.noCache && (await store.hasContentHash()) && (await store.readMeta()).model === cfg.model; const cache = useCache ? await store.loadEmbedCache() : new Map();`
  - Replace the `const vecs = await embed(ctx.map(c => c.embedText))` block with the
    partition/embed-misses/reassemble logic; track `reused`/`embedded` counts.
  - Compute `content_hash` per chunk; include it in the row objects.
  - Return `{..., reused, embedded}` (in addition to `chunks`, `dim`, etc.).
  - **Schema-consistency guard:** if `useCache` is false because the existing table
    *lacks* the column (pre-feature index) AND this is a non-rebuild `refresh`, do NOT
    add `content_hash` to new rows (adding a column to an existing column-less table
    breaks LanceDB `add`); behave as today. A `--rebuild` recreates the table fresh, so
    it always writes `content_hash` and enables the feature thereafter.
- **`src/config.mjs`** — `DEFAULTS.noCache = false` (overridable; the CLI flag sets it).
- **`bin/gtir.mjs`** — parse `--no-cache` → `args.noCache`; thread into `runIndex` →
  `cfg.noCache`. Update the `index`/`refresh` stderr lines to include `(R reused, K embedded)`.
- Reuses: `embed` (cfg.embedImpl ?? embedTexts), `openStore`, `readMeta`. `content_hash`
  is inert to `search` (it selects its own columns).

A new tiny helper `contentHash(s)` = `sha256` hex lives where the indexer can share it
(e.g. exported from `src/embed.mjs` or a one-liner in the indexer).

---

## Error handling / edge cases

- **Pre-feature index** (no `content_hash` column): `hasContentHash()` → false → no cache,
  legacy behavior; a later `--rebuild` migrates the schema by recreating the table.
- **Model change**: meta.model guard → cache empty → full re-embed (correct).
- **Corrupt/short cached vector**: cached vectors are trusted as-is (they were valid when
  written); `--no-cache` is the recovery path. No per-vector validation (YAGNI).
- **Empty repo / zero chunks**: nothing to embed; cache load is a no-op.
- **dim from cache only** (a build where everything is cached → 0 embed calls): `dim` is
  read from a cached vector's length; meta still written with the correct dim.
- **`content_hash` collisions**: sha256 — negligible.

---

## Testing (hermetic, `node --test`)

Use an injected embedder that **counts calls** (`cfg.embedImpl = (texts) => { calls += texts.length; return fakeVecs(texts); }`).

- **Cache hit on rebuild:** build a small repo, capture embed-call count; rebuild → the
  second build embeds **0** (or only changed) and produces identical vectors for unchanged
  chunks.
- **Single edit:** change one file's one chunk → exactly that chunk is re-embedded
  (call count == number of changed chunks), the rest reused.
- **Model change:** second build with a different `cfg.model` → cache ignored, all
  re-embedded.
- **`--no-cache` (via `cfg.noCache = true`):** all re-embedded even when cache available.
- **Prefix-sensitivity:** a markdown chunk whose breadcrumb prefix changes (e.g. page
  retitled) → `content_hash` differs → re-embedded (not wrongly reused).
- **Pre-feature index:** a chunks table without `content_hash` → `hasContentHash()` false,
  refresh runs legacy (no crash, no schema error).
- **`store.loadEmbedCache`:** returns the `{hash → embedding}` map from a populated table;
  empty Map for an empty/absent table.

(Most of these run through `buildIndex` with the counting embedder — no Ollama, no
network. A live smoke confirms a real `gtir index --rebuild` on the wiki reports a large
`reused` count and finishes much faster than a cold build.)

---

## Decisions log (from brainstorming)

| Decision | Choice |
|---|---|
| Cache substrate | **Reuse the LanceDB store** (new `content_hash` column; load `{hash→embedding}` at build start) |
| Cache key | `sha256(embedText)` — the exact embedded string (prefix-inclusive), content-addressed |
| Model safety | load cache only when `meta.model === cfg.model` |
| Scope | both `--rebuild` and `refresh` |
| Backward-compat | feature-detect the column; legacy behavior on pre-feature indexes; rebuild migrates |
| Escape hatch | `--no-cache` |

---

## Open questions (for the implementation plan)
- Where `contentHash()` lives (export from `embed.mjs` vs inline in `indexer.mjs`) — pick
  in the plan; lean toward `embed.mjs` so it sits with the embedding code.
- Exact `hasContentHash()` implementation against `@lancedb/lancedb` (read `table.schema`
  vs sample a row) — settle against the installed 0.27.x API in the plan.
