# Eval-Corpus Hardening — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorming → spec)
**Repo:** `G:\demon\gtir`

## Problem

The committed eval fixture is near-saturated: baseline **Recall@1 = 0.902**, Recall@5 = 0.980,
MRR = 0.935, Sec-hit@1 = 0.863 over 51 queries / 33 corpus files. That makes the harness a strong
*regression gate* but a useless *improvement meter* — a real retrieval gain (e.g. adding a rerank
stage) has almost no room to register. We cannot currently tell whether a proposed retrieval change
helps, which is the exact failure the harness was built to prevent.

The hardening must add **realistic** difficulty, not noise. Difficulty modeled on failure modes that
don't occur in real code would let a change "win" on synthetic hardness while doing nothing in
practice — defeating external validity. So the new difficulty is grounded on the failure modes we
actually observed breaking retrieval on the real mediaTraktor corpus:

- **Doc-copy shadowing** — a prose page paraphrasing a source concept outranks the source.
- **Test-file shadowing** — a test file sharing the source's symbols competes with the source.
- **Near-duplicate implementations** — two sibling implementations of one concept (LRU vs LFU).
- **Large-class method-name ambiguity** — multiple classes with identically-named methods.

## Goal

Grow the committed fixture so the harness has headroom, while keeping the existing saturated set as a
strict regression floor. Split the golden set into two tiers:

- **`gate`** — the existing 51 queries, unchanged. Stays ~0.9. Strict regression floor.
- **`hard`** — ~30 new queries against realistic decoys and cross-vocabulary phrasings. Lands
  Recall@1 ≈ **0.55–0.75** (blended overall ≈ 0.70). The improvement meter.

The harness reports **overall + per-tier** metrics. **Both tiers gate on regression** — the
gate/meter distinction is about *headroom to show gains*, not about disabling regression detection.

## Non-Goals

- No rerank stage in this work — this only builds the *measurement* that a rerank would be evaluated
  against.
- No change to chunking, embedding, or search logic.
- No private/real-corpus golden set committed (real code can't be committed). The harness already
  supports pointing `--repo`/`--golden` at a private tree; that remains an out-of-band option.

## Component 1 — Golden format: `tier` tag

Each entry in `eval/golden.json` gains a `tier` field:

```json
{ "query": "...", "path": "auth/jwt.ts", "lines": [9, 15], "tier": "gate" }
{ "query": "...", "path": "cache/lfu.py", "lines": [3, 9], "tier": "hard" }
```

- The existing 51 entries are tagged `"tier": "gate"` (paths/lines unchanged).
- New entries are tagged `"tier": "hard"`.
- **Missing `tier` defaults to `"gate"`** — any external/older golden file keeps working unchanged.

`eval/golden.json` remains the single golden file (one source of truth).

## Component 2 — Harness: per-tier aggregation (`src/eval.mjs`)

Backward-compatible extension. The existing pure functions (`parseLines`, `overlaps`, `scoreGolden`,
`aggregate`, `flattenMetrics`, `compareBaseline`) are unchanged in signature and behavior.

**`evalGolden(golden, searchFn, { maxK, ks })`** now:
1. Builds a per-query record as today, additionally carrying that entry's tier
   (`tier = entry.tier || "gate"`).
2. Returns the existing **overall** metrics blob (`{ n, n_sec, recall, mrr, sec_hit }`) **plus** a
   `byTier` object: `{ gate: <metrics>, hard: <metrics> }`, each computed by running the existing
   `aggregate` over that tier's records. Only tiers that have ≥1 record appear in `byTier`.

So the return shape becomes:

```js
{ n, n_sec, recall, mrr, sec_hit, byTier: { gate: {...}, hard: {...} } }
```

**New `compareTiers(cur, base, tol = 0.005)`** in `src/eval.mjs`:
- For each tier present in **both** `cur.byTier` and `base.byTier`, run the existing
  `compareBaseline(cur.byTier[t], base.byTier[t], tol)` and prefix each returned metric name with
  `"<tier>:"` (e.g. `gate:recall@1`, `hard:mrr`).
- Returns the concatenated list. A tier present in `cur` but absent from `base` is skipped (no false
  regression — mirrors `compareBaseline`'s existing "metric absent from baseline" rule).

`compareBaseline` (overall) is unchanged and still called for the overall metrics.

## Component 3 — Harness orchestration (`bin/gtir.mjs runEval`)

- `metrics` from `evalGolden` now carries `byTier`; `--save` writes it into `baseline.json`
  verbatim (no code change needed — it already serializes the whole `metrics` object).
- After the existing overall `compareBaseline` check, also run `compareTiers(metrics, baseline)` and
  fold its regressions into the same `regressions` list. Any regression (overall **or** any tier)
  → exit 1, printed as `eval: REGRESSION <metric>: <base> → <cur> (<delta>)`.
- `printMetricsTable` gains a per-tier section: after the overall block, print a compact
  `gate` and `hard` sub-block (recall@1/5, mrr, sec_hit@1) each with its base delta, so a run shows
  both the floor and the meter at a glance. Reads `base.byTier?.[t]` for the deltas.

## Component 4 — Corpus additions (`eval/corpus/`)

Seven new files. Each decoy is a *realistic* competitor: superficially similar to a target (shared
vocabulary/structure) but clearly **wrong** for the query's intent.

| File | Models | Role |
|---|---|---|
| `cache/lfu.py` | Near-dup impl | LFUCache sibling of `lru.py`. Decoy for the gate LRU query; **target** for a new LFU query. |
| `graph/bfs_grid.py` | Near-dup impl | BFS shortest path on a 2D grid. Decoy for the gate graph-BFS query; **target** for a new grid-BFS query. |
| `http/retry.test.ts` | Test-file shadow | Tests `fetchWithRetry`/`isRetryable`. Decoy for retry queries (source must win); **target** for one "where are the retry tests" query. |
| `auth/jwt.test.ts` | Test-file shadow | Tests JWT verify/sign. Decoy for the JWT-verify query (source must win). |
| `notes/retry-policy.md` | Doc-copy shadow | Prose on retry/backoff policy. Decoy for code-intent retry queries; **target** for one conceptual "what's our retry policy" query. |
| `notes/caching-strategy.md` | Doc-copy shadow | Prose on LRU/LFU/TTL trade-offs. Decoy for cache code queries; **target** for one conceptual "LRU vs LFU" query. |
| `edge/node_c.py` | Method ambiguity | Third throttle sibling (peer throttle) with identical `admit`/`reset`/`snapshot` method names. Deepens the existing `node_a`/`node_b` 2-way ambiguity to 3-way. |

## Component 5 — Hard queries (~30 in `eval/golden.json`, `tier: "hard"`)

Three families:

1. **Targeted at new files (~8):** the LFU query, grid-BFS query, retry-test query, JWT-source-vs-test
   query, retry-policy doc query, caching-strategy doc query, and 2–3 node_c throttle queries.

2. **Cross-vocabulary against existing files (~15):** query phrasings whose words do **not** appear in
   the code, so BM25 misses and the dense vector must carry the hit — where real headroom lives.
   Examples (target file in parens): "stop a thundering herd of outbound requests"
   (`http/rate_limiter.ts`); "make sure only N things run at once" (`concurrency/semaphore.ts`); "fan
   work out to background threads and collect results in order" (`concurrency/worker_pool.py`);
   "scramble plaintext into ciphertext with a block cipher" (`crypto/aes.py`); "tamper-proof message
   authentication tag" (`crypto/hmac.ts`); "turn a blog post title into a clean URL path"
   (`text/slugify.ts`); "measure how different two words are" (`text/levenshtein.py`); "order build
   steps so dependencies come first" (`graph/topo_sort.py`); "do two boxes collide in space"
   (`geometry/aabb.rs`); "spin a point around an axis in 3D" (`geometry/quaternion.rs`); "drop cache
   entries that got too old" (`cache/ttl_cache.rs`); "stamp every outgoing request with a trace id"
   (`http/middleware.ts`); "bounded hand-off pipe between producer and consumer threads"
   (`concurrency/channel.rs`).

3. **Conceptual / notes (~5):** "what broke in production and how do we prevent it again"
   (`notes/incident-2025.md`); "how do new engineers get started" (`notes/onboarding.md`); "where do
   we store user sessions" (`notes/data-model.md`); plus the two doc-shadow conceptual queries above.

**Authoring bar (quality gate):** every query has exactly **one** defensible target; decoys must be
*wrong* for the intent, only *superficially* similar. A query with two defensible answers is a corpus
bug, not difficulty — fix the query or the corpus, don't ship the ambiguity.

## Component 6 — Tuning to band

After authoring, run `gtir eval --repo eval/corpus --golden eval/golden.json --no-build` (against a
freshly built index) and confirm the **`hard`** tier Recall@1 lands in **0.55–0.75**. If too easy
(>0.75), add a decoy or a harder phrasing; if too hard (<0.55), soften an underspecified query (it's
probably ambiguous — a corpus bug). Then `--save` the new tiered baseline. Record the final numbers
in the README.

## Data Flow

Unchanged pipeline: corpus indexed (jina code model) → each golden query searched → `scoreGolden`
per query → `aggregate`. The only new step is grouping records by `tier` before aggregation and
emitting `byTier` alongside the overall blob.

## Error Handling / Edge Cases

- **Missing `tier`** → treated as `gate` (default).
- **Tier in current but not baseline** → skipped in `compareTiers` (no false regression).
- **`hard` tier with `sec_hit` null** (n_sec === 0 for that tier) → already handled by
  `flattenMetrics` omitting null sec_hit; no special case needed.
- **Old flat baseline** (no `byTier`) → `compareTiers` finds no matching tiers and returns `[]`;
  overall `compareBaseline` still runs. Re-saving the baseline migrates it.

## Testing

- **Hermetic unit tests** (`test/eval.test.mjs`, fake search results — no Ollama):
  - `evalGolden` returns `byTier` with `gate`/`hard` split correctly from tagged entries.
  - An entry with no `tier` lands in `gate`.
  - `compareTiers` flags a per-tier regression with the `"<tier>:"` prefix.
  - `compareTiers` against a baseline lacking `byTier` returns `[]`.
- **Integration** (manual, needs Ollama): `gtir eval` over `eval/corpus` — the Component 6 tuning run.
- **README**: document the two tiers, the gate-vs-meter framing, the new baseline numbers, and the
  decoy authoring principle.

## Success Criteria

1. `eval/golden.json` has every entry tagged `gate` or `hard`; ~30 `hard` entries added.
2. Seven new corpus files committed, each a realistic decoy or near-dup.
3. `gtir eval` prints overall + per-tier metrics; both tiers gate on regression.
4. `hard`-tier Recall@1 lands in 0.55–0.75; new tiered `baseline.json` saved.
5. Hermetic eval unit tests pass; full suite green.
6. README updated.

## Implementation note — measured revision (2026-06-01)

Two things were learned during implementation and changed the design:

1. **Test discovery collision.** The decoy `*.test.ts` files under `eval/corpus/` were picked up by
   `node --test`'s repo-wide discovery and failed (they're vitest-syntax fixtures, not node:test
   files). Fixed by scoping the `test` script to `node --test test/*.test.mjs`.

2. **"Both tiers gate" was wrong.** The spec assumed both tiers would gate on regression. Measurement
   on an unchanged index showed the **overall and `gate`-tier metrics are stable run-to-run**, but the
   small **`hard` tier is intrinsically noisy** — one borderline query flipping rank 1↔2 (Ollama F16
   embedding inference isn't bit-exact) moves its recall by ~1/30 ≈ 0.033, which no sane CI tolerance
   survives. So the shipped design gates on **overall + `gate` only** (`tol = 0.02`) and treats the
   `hard` tier as the reported **meter** — which is exactly what the gate/meter naming promised. This
   matches Component 3's intent (the gate stays strict) while keeping the harness non-flaky.
