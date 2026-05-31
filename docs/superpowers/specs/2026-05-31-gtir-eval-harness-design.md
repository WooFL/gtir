# gtir eval — Retrieval Eval Harness — Design

**Date:** 2026-05-31
**Status:** Approved design, pre-implementation
**Repo:** gtir (G:\demon\gtir)

---

## Context

gtir's retrieval quality has been changed several times (cosine → hybrid RRF; char-split →
heading-aware markdown chunking; the content-hash embedding cache). Each change was validated
with an **ad-hoc** A/B benchmark rebuilt from scratch, then thrown away. There is no committed,
repeatable way to answer "did this change help or hurt retrieval?"

`gtir eval` makes retrieval quality a **measured, regression-guarded** property: a committed
golden query set scored against a committed fixture corpus, with metrics compared to a saved
baseline. Future levers (rerank, oversize-leaf re-splitting, fusion tuning) become measurable
deltas instead of vibes.

---

## Goals / Non-Goals

**Goals**
- A `gtir eval` subcommand that runs a hand-authored golden query set through the existing
  `search()` and reports **Recall@k**, **MRR**, and **Sec-hit@k**.
- Compare current metrics against a committed `eval/baseline.json`; flag regressions; exit
  non-zero on regression (CI-usable). `--save` updates the baseline.
- Corpus-agnostic: the harness takes `--repo` + a golden file, so it can score any index.
- Ship a committed fixture corpus + golden set as the canonical regression target.
- Pure, DB-free metric math that is unit-tested without Ollama.

**Non-Goals**
- No synthetic/LLM query generation (hand-authored only).
- No live two-index A/B in one command (the saved baseline decouples comparison in time).
- No per-query LLM "is this answer good" judging — pure rank-based metrics only.
- No change to chunking, embedding, or search behavior.

---

## Architecture

A corpus-agnostic harness in two layers:

```
gtir eval --repo <path> [--golden <file>] [-k 10] [--save] [--no-build] [--json]
   │
   ├─ (unless --no-build) refresh the index at <repo>        [live: needs Ollama]
   ├─ for each golden entry: search(query, cfg, {k}) → results
   ├─ scoreGolden(results, golden) → per-query hit records   [pure]
   ├─ aggregate(records)           → metrics object          [pure]
   └─ --save ? writeBaseline(metrics)
            : compareBaseline(metrics, baseline, tol) → regressions; print deltas; exit 0/1
```

- **`src/eval.mjs`** — pure functions only (no I/O, no DB): `parseLines`, `overlaps`,
  `scoreGolden`, `aggregate`, `compareBaseline`. Unit-tested with fake search rows.
- **`bin/gtir.mjs`** — the `eval` subcommand: arg parsing, index build, file I/O for golden
  + baseline, table printing, exit code. Orchestration only; delegates math to `src/eval.mjs`.
- **`eval/corpus/`** — committed fixture files (code + notes).
- **`eval/golden.json`** — committed golden query set.
- **`eval/baseline.json`** — committed metrics snapshot.
- **`test/eval.test.mjs`** — hermetic tests for the metric math and regression logic.

---

## Data shapes

### Golden entry (`eval/golden.json` — a JSON array)
```json
[
  { "query": "how are embeddings reused across rebuilds",
    "path": "src/indexer.mjs",
    "lines": [50, 90] },
  { "query": "what fuses the vector and keyword result lists",
    "path": ["src/search.mjs"] }
]
```
- `query` (string, required).
- `path` (string **or** array of strings, required): acceptable answer file(s), repo-relative,
  matched against a result's `path`. An array means "any of these counts as correct."
- `lines` (`[start, end]`, optional): the answer's line span. Present → that query participates
  in Sec-hit scoring; absent → it contributes to Recall/MRR only.

### Search result shape (already produced by `search()`)
Each result row has `path` (repo-relative string) and `lines` (a `"start-end"` string, e.g.
`"12-40"`), among others. `parseLines("12-40")` → `[12, 40]`.

### Hit definitions
- **Page hit** at rank *r*: result *r*'s `path` equals (one of) the golden `path`(s).
- **Section hit** at rank *r*: a page hit **and** the result's line range overlaps the golden
  `lines`. Overlap: `[rs, re]` overlaps `[gs, ge]` iff `rs <= ge && gs <= re`.

### Metrics (over N queries)
- **Recall@k** (page level): fraction of queries whose golden path appears in the top-k results.
  Reported at k ∈ {1, 5, 10}.
- **MRR** (page level): mean of `1 / rank` of the first page hit within the returned list
  (rank 1-indexed); 0 for a query with no page hit in the returned results.
- **Sec-hit@k** (section level): among queries that **have** `lines`, the fraction with a
  section hit in the top-k. Reported at k ∈ {1, 5}. Queries without `lines` are excluded from
  the Sec-hit denominator.

### Baseline / `--json` output (`eval/baseline.json`)
```json
{ "model": "hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16",
  "n": 30, "n_sec": 24,
  "recall": { "1": 0.57, "5": 0.83, "10": 0.90 },
  "mrr": 0.68,
  "sec_hit": { "1": 0.40, "5": 0.63 } }
```
`n` = total queries; `n_sec` = queries with `lines` (the Sec-hit denominator). `model` is read
from the index meta. (Any timestamp is stamped by the CLI caller, not by pure code.)

---

## Behavior & output

1. Resolve `--golden` (default: `<repo>/eval/golden.json` if present, else error asking for
   `--golden`). For the shipped fixture, the default path resolves to the repo's own
   `eval/golden.json` scoring `eval/corpus/`.
2. Unless `--no-build`: run a `refresh` (incremental) of the index at `--repo` so metrics
   reflect current content. With `--no-build` and no index → error: "no index — run `gtir index`".
3. For each golden entry: `search(query, cfg, { k: maxK })` where `maxK = max(reported k) = 10`
   (overridable with `-k`, clamped to search's 50 cap). Score against the golden answer.
4. `aggregate` → metrics. Read baseline from `<repo>/eval/baseline.json` (or `--baseline`).
5. **`--save`**: write metrics to the baseline path; print "saved baseline (n=…, model=…)".
6. **Default (compare)**: print a metrics table with current value, baseline value, and delta
   per metric; flag any metric that dropped by more than `tol = 0.005`. Exit **1** if any
   regression, else **0**. No baseline file present → print metrics, note "no baseline to
   compare (run --save to set one)", exit 0.
7. **`--json`**: emit the metrics object to **stdout** (for scripting); human table + deltas
   go to **stderr**. (Mirrors `search`: stdout is machine-readable, stderr is logs.)

---

## Error handling / edge cases

- **No index, no `--no-build`:** build it (refresh). No index **with** `--no-build`: error
  "no index at <dir> — run: gtir index", exit 2.
- **Missing/!JSON golden file:** error naming the path, exit 2.
- **Golden `path` not present in the corpus:** warn to stderr ("golden path X not in index —
  likely a typo"); that query still scores (it will simply never hit), counting as a miss.
- **Baseline model ≠ current model:** warn the comparison is cross-model (embeddings differ);
  still print the table. (Switching models legitimately moves the numbers.)
- **Empty golden set / n = 0:** error "golden set is empty", exit 2.
- **All queries lack `lines` (n_sec = 0):** Sec-hit reported as `n/a` (not 0); excluded from
  regression checks.
- **Float noise:** deltas within `tol` are shown as `~0` and never flagged as regressions.

---

## Components & integration

- **`src/eval.mjs`** (new, pure):
  - `parseLines(s)` → `[start, end]` from `"start-end"`; tolerant of a single number.
  - `overlaps(a, b)` → boolean range overlap.
  - `scoreGolden(results, entry)` → `{ pageRank|null, secRank|null, hasLines }` — the 1-indexed
    rank of the first page hit and first section hit (or null).
  - `aggregate(records, ks)` → metrics object (`recall`, `mrr`, `sec_hit`, `n`, `n_sec`).
  - `compareBaseline(cur, base, tol)` → array of `{ metric, cur, base, delta }` for drops `> tol`.
- **`bin/gtir.mjs`** — add the `eval` subcommand wired to the above; reuse `loadConfig`,
  `search`, and the existing index/refresh path. Add `eval` to the usage/help text.
- **`eval/corpus/`** — ~40 files: a realistic mix of code (multiple languages: js/ts, python,
  rust, plus a couple of others present in `languages.mjs`) and markdown notes with headings.
  Sized and varied enough that the correct answer is **not** trivially always rank 1 (so the
  metrics discriminate). `eval/corpus/.gtir/` is gitignored (regenerable).
- **`eval/golden.json`** — ~30 hand-authored queries against the fixture corpus, a mix of
  page-only and `lines`-bearing entries, spanning code and notes.
- **`eval/baseline.json`** — generated once via `gtir eval --repo eval/corpus --save` after the
  corpus + golden set exist and Ollama is available; committed.
- **`.gitignore`** — ensure `eval/corpus/.gtir/` (or the global `.gtir/` rule already covers it).

Reuses: `search()` (unchanged), `loadConfig`, the index/refresh path. `eval` adds no new
retrieval logic — it only measures the existing search.

---

## Testing (hermetic, `node --test`)

Metric math is pure → tested with **fake** search-result arrays, no Ollama, no DB:

- **`parseLines`**: `"12-40"` → `[12,40]`; `"7"` → `[7,7]`.
- **`overlaps`**: touching, nested, disjoint, identical ranges.
- **`scoreGolden`**: page hit at rank 1 / rank 3 / no hit; section hit requires both path and
  line overlap (path matches but lines disjoint → page hit, no section hit); `path` as array
  (any-match); entry without `lines` → `hasLines=false`, never contributes to Sec-hit.
- **`aggregate`**: Recall@1/5/10 fractions; MRR = mean reciprocal of first page rank (0 for
  misses); Sec-hit denominator = only `lines`-bearing queries; `n_sec=0` → sec_hit `n/a`.
- **`compareBaseline`**: a drop > tol is flagged; a drop within tol is not; an improvement is
  never flagged; a missing baseline metric is skipped (not a false regression).
- **Exit-code logic** (the comparison → boolean): regressions present → "would exit 1".

A **live smoke** (documented, not in the hermetic suite) runs the real
`gtir eval --repo eval/corpus` and confirms it prints a metrics table and a sane exit code.

---

## Decisions log (from brainstorming)

| Decision | Choice |
|---|---|
| Ground truth | **Hand-authored** golden set (no synthetic generation) |
| Corpus | **Committed fixture** under `eval/corpus/`; harness is corpus-agnostic (`--repo` + golden) |
| Output | **Absolute metrics + saved baseline** compare with regression flag; `--save` updates |
| Metrics | Recall@{1,5,10}, MRR, Sec-hit@{1,5} |
| Golden size | ~30 queries (mix of page-only and `lines`-bearing) |
| A/B across commits | save baseline on old commit, eval on new → delta (no live two-index run) |
| Section hit | page hit AND result line-range overlaps golden `lines` |
| stdout/stderr | `--json` metrics to stdout; human table + deltas to stderr (mirrors `search`) |
