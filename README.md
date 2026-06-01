# gtir

**Find your code and notes by *meaning*, not exact words.** Ask *"where do we retry failed
requests?"* and gtir finds the function — even when it's called `backoffFetch` and never says the
word "retry." It's a small, install-once command-line tool that searches your own repositories and
note vaults, and it runs **entirely on your machine** — no cloud, no API keys, nothing leaves your
laptop.

> *gtir* — Armenian *գտնել*, "to find."

### Why you'd want it

- **`grep` finds the word; gtir finds the thing.** Keyword search misses code that *means* what you
  asked but doesn't *say* it. gtir matches the intent of your question to the intent of your code.
- **Ask in plain English** — *"evict the least-recently-used cache entry"*, *"sign a session token
  with an expiry"*, *"rotate a 3D vector"*. You don't need to remember what the function was named.
- **Your code *and* your notes — one tool.** Point `gtir init` at a codebase or an Obsidian vault; it
  auto-detects which and picks the right model (a code embedder for repos, a prose one for notes). Most
  semantic-search tools commit to one domain — gtir puts both behind the same query. Re-indexing stays
  incremental (only changed files re-embed), so it's fast on big repos.
- **Measured, not vibes.** gtir ships a committed eval harness — a golden query set, a saved baseline,
  and a regression gate that fails CI when a change makes search worse. Most tools in this space embed
  and hope; gtir can tell you its own Recall@1 and *prove* a change helped (or catch one that quietly
  hurt). See [Measuring retrieval quality](#measuring-retrieval-quality--gtir-eval).
- **Private by default.** Everything runs through a local **Ollama** model — no API keys, nothing sent
  to a server. Native on Windows, macOS, and Linux (no Unix-only shell scripts).
- **Works inside your AI editor.** gtir ships an MCP server, so tools like Claude and Cursor can search
  your codebase for you (`search_code` for repos, `search_notes` for vaults).

Under the hood it splits files into meaningful chunks (tree-sitter for code, headings for Markdown),
embeds each with a local model (a code model for repos, a prose one for notes), and answers a query by
blending **semantic** (vector) and **keyword** (BM25) search. The details are below.

### Why it saves tokens — and time

Finding the right code is the expensive part of an agent's work. With `grep`, the agent searches a
guess, gets a pile of matches, and **reads candidate files into its context to judge which one is
right** — most of those tokens pay for code it then throws away. gtir does the relevance-ranking
*outside* the context window (a local embedding compare — **zero tokens** in the model's context) and
hands back just the top few **chunks**, each a focused `file:line` span. The agent reads the winner,
not the rejects.

| Find *"where do we verify a JWT?"* | Tokens pulled into context |
| --- | --- |
| `grep` → read 3–4 candidate files | ~10,000–20,000 |
| `gtir search` → top hits | ~2,000–3,000 |

That gap is **structural, not a quirk of today's grep.** Even a perfect grep returns text the agent
still has to read to rank, and you can't grep a *concept* — *"give up on a flaky dependency"* has no
keyword if the code calls it `backoffFetch`. So the saving grows exactly where grep gets expensive: big
repos, vocabulary mismatch, multi-guess hunts. The two are complementary — grep for an exact string you
already know, gtir for finding by meaning. (Numbers illustrative; and a smaller, cleaner context is also
a *sharper* one.)

**Same lever, for latency.** The *search itself* isn't faster than `grep` — gtir embeds your query
first, so one lookup is slower than millisecond-fast ripgrep. But the agent's bottleneck isn't the tool,
it's the **model turns** (seconds each). Folding several guess→grep→read round-trips into one ranked
answer means fewer turns, and a smaller context is quicker for the model to process — so the *answer*
lands sooner even though the *search* is slower. Tokens and time are the same win: fewer, lighter turns.

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

Everything runs through **one runtime — Ollama** (no Python, no sentence-transformers, no torch).

Search blends a **dense** (vector) branch with a **lexical** (BM25) branch, plus a few small
refinements — each kept only because it moved the numbers on the
[eval harness](#measuring-retrieval-quality--gtir-eval), and each tunable per-repo in `.gtir/config.json`:

- **Field-weighted BM25** (`bm25Boost`) — indexes the path / scope / declaration ahead of the body, so a
  symbol match beats an incidental mention. The main defense against a test or doc outranking the source it references.
- **Query-adaptive fusion** (`ftsWeight` / `ftsWeightSymbol`) — routes by intent: a bare-identifier lookup lets BM25 lead, a natural-language query lets the embedder lead. Avoids the compromise a single fixed weight forces.
- **Identifier boost** (`ftsWeightMixed`) — a natural-language query that *names* a symbol (`fetchWithRetry`) gets a lexical nudge instead of being treated as purely conceptual.
- **Test-file demotion** (`testPenalty`) — in a code repo, a query for an implementation won't surface its test at #1 (unless you're actually asking about tests).
- **Scope breadcrumb** (`contextScope`) — prepends the enclosing class/module to each chunk, restoring context a method loses when it's sliced out of a large class.

That "kept only if measured" rule cuts both ways: several plausible tricks — a cross-encoder reranker, a
structural-centrality prior, a bigger embedding model — were tried, measured as no better, and dropped.
The retrieval is tuned against evidence, not guessed.

## Install

```bash
git clone <gtir repo> && cd gtir
npm install
npm link            # exposes `gtir` globally
```

Prereqs: **Node ≥20**, **Ollama ≥0.24** running locally.

**Platforms:** the embedded vector store (LanceDB) installs a prebuilt native binary, so there's no
compile step — on **Windows** (x64/arm64), **Linux** (x64/arm64, glibc + musl), and **Apple Silicon**
macOS it just works. **Intel Macs (`darwin-x64`) are not supported** — the current LanceDB build ships
no `darwin-x64` prebuilt, so `npm install` resolves no native binary and gtir fails to load there.

## Setup (once per machine)

One command checks Ollama, **pulls the embedding model if it's missing**, and verifies embeddings work:

```bash
gtir doctor
```

```text
gtir doctor — ready ✓
  ✓  Node 26.1.0
  ✓  Ollama reachable at http://localhost:11434
  ✓  model hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16
  ✓  embeddings (dim=896)
```

The first run pulls the model (HuggingFace GGUF, ~1 GB, one-time — Ollama has no official tag for it).
Flags: `--no-pull` to only diagnose (prints the `ollama pull …` to run yourself), `--repo <project>`
to check that repo's configured model (e.g. `nomic-embed-text` for a notes vault). It exits non-zero if
anything's not ready, so it's usable as a preflight in scripts. (`gtir setup` remains as a bare probe.)

## Quick start

**See it work in one command — before you index anything of your own:**

```bash
gtir demo      # indexes a tiny bundled sample once, then shows the contrast
```

```text
  ❓  "compute the edit distance between two strings"

      grep -rin distance   →  5 matches in 2 files  (graph/dijkstra.rs, text/levenshtein.py)
      gtir search   →  top hit:

         text/levenshtein.py:1-16
         ┌──────────────────────────────────────────────────────────┐
         │ def levenshtein(s: str, t: str) -> int:                  │
         │     """Classic Wagner-Fischer dynamic-programming edit … │
         │     m, n = len(s), len(t)                                │
         │     dp = list(range(n + 1))                              │
         └──────────────────────────────────────────────────────────┘
         ↑ matched by meaning — your query never said "levenshtein"

  to find it, you read:   grep → 474 tokens (the files it hit)   ·   gtir → 187 (one span)   (≈ 3× less)
```

`gtir demo` runs a *real* search against a bundled sample corpus (all numbers are computed, not canned)
and shows what `grep` returns vs. what gtir returns: the meaning-match — you searched *"edit distance"*
and it found `levenshtein`, a word your query never used — and how much less you read to get there.
Point it at your own indexed code with `gtir demo --repo .`, or ask your own question with `--query "…"`.

---

Already installed gtir and pulled the model (see **Install** / **Setup** above)? Point it at any
project and ask a question in plain English:

```bash
cd ~/my-project
gtir init --repo .     # auto-detect code vs notes, index, install a post-commit refresh hook
```

```text
gtir init: /home/me/my-project
  mode: code (detected)
  config: wrote .gtir/config.json
  gitignore: .gtir/ added
  index: 1284 chunks, dim=896
  hook: post-commit auto-refresh installed
```

Now search. The query never says `verifyToken` — but that's the top hit, matched by *meaning*:

```bash
gtir search "where do we verify a JWT and reject expired tokens" --repo .
```

```json
[
  {
    "path": "src/auth/token.ts",
    "lines": "48-79",
    "language": "typescript",
    "score": 0.0309,
    "vec_rank": 1,
    "fts_rank": 2,
    "snippet": "export function verifyToken(raw: string): Session {\n  const claims = jwt.verify(raw, SECRET)\n  if (claims.exp < now()) throw new ExpiredTokenError()\n  ..."
  },
  {
    "path": "src/auth/middleware.ts",
    "lines": "12-26",
    "language": "typescript",
    "score": 0.0190,
    "vec_rank": 3,
    "fts_rank": null,
    "snippet": "export const requireAuth = (req, res, next) => { /* ... verifyToken(req.headers.authorization) ... */ }"
  }
]
```

Results are JSON on **stdout** (logs go to stderr), so pipe to `jq` for just the locations:

```bash
gtir search "verify a JWT" --repo . | jq -r '.[] | "\(.path):\(.lines)"'
#   src/auth/token.ts:48-79
#   src/auth/middleware.ts:12-26
```

That's the whole loop: `init` once, then `search` as often as you like — the post-commit hook keeps
the index fresh as the code changes.

### What `gtir init` does

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

Most semantic-search tools give you no way to know whether a change improved retrieval or quietly
regressed it — they embed and hope. gtir treats retrieval quality as a first-class, *measured* concern.
It ships a committed eval harness so changes are provable, not vibes:

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

**Tiers — gate vs meter:** the **103** golden entries each carry a `tier`. The **`gate`** tier (51
near-saturated queries) is the strict regression floor; the **`hard`** tier (30 queries over realistic
decoys — near-duplicate implementations, test-file/doc-copy shadows, method-name ambiguity, and
cross-vocabulary phrasings) is the improvement meter; the **`symbol`** tier (12 bare-identifier lookups
like `LRUCache`) covers exact-symbol search, where BM25 carries the weight; and the **`mixed`** tier (10
natural-language queries that *name* a symbol, e.g. *"how does `fetchWithRetry` back off"*) covers the
identifier-boost case. The hard and symbol tiers pull in opposite directions (dense vs lexical), which
is what makes them useful for tuning the fusion weight rather than overfitting to one query style. `gtir eval` prints overall **and** per-tier metrics, and **exits
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

It serves a small tool **suite per index** (auto-labeled from each index's model — `code`, `notes` —
or override with `--label name:<repo>`), plus a global `gtir_status`:

- **`search_<label>`** — hybrid semantic + BM25 search. Pass `compact: true` for path/lines/score only (token-saving).
- **`read_<label>`** — read the source of a span (`path` + `lines`, optional `context`); the natural follow-up to a search hit.
- **`outline_<label>`** — list a file's indexed chunks, each with its line range and signature — a cheap map of a file.
- **`similar_<label>`** — find chunks semantically similar to a span (reuses the stored embedding — no re-embed).
- **`find_<label>`** — jump to a symbol by **exact name**: `kind:"definition"` (default) returns where it's *declared*; `kind:"references"` is a lexical sweep of where the name *appears* (not type-resolved — same-named symbols collide). Use it instead of `search` when you already know the name.

Together these let an agent **search → read more → map a file → jump to a definition → pivot to related
code** without leaving the conversation. Register the server by pasting the snippet from:

    gtir mcp --repo <codeRepo> --repo <wikiRepo> --print-config

into your project's `.mcp.json` (`mcpServers`). It's stdio JSON-RPC with zero extra deps; `search` and
`similar` reuse the same hybrid retrieval as the CLI, and `read`/`outline` are plain lookups over the index.

**Example — one agent, one session** (the tool calls it makes; results abbreviated to `file:line`):

```text
1. search_code  { "query": "where do we verify a JWT and reject expired tokens" }
      → src/auth/token.ts:48-79      top hit — verifyToken(), matched by meaning

2. read_code    { "path": "src/auth/token.ts", "lines": "48-79", "context": 5 }
      → the source span (returns lines 43-84)

3. find_code    { "symbol": "verifyToken", "kind": "references" }
      → src/auth/token.ts:48 (definition) · http/middleware.ts:12 · test/auth.test.ts:30

4. find_code    { "symbol": "ExpiredTokenError" }            // kind defaults to "definition"
      → src/auth/errors.ts:7

5. similar_code { "path": "src/auth/token.ts", "line": 50 }
      → src/auth/refresh.ts:20-41 · src/auth/middleware.ts:12-26

   outline_code { "path": "src/auth/token.ts" }
      → 12-26 signToken · 48-79 verifyToken · 81-93 decodeToken

   search_code  { "query": "token refresh", "compact": true }   // path/lines/score, no snippet bodies
      → src/auth/refresh.ts:20-41 · src/auth/token.ts:48-79
```

Every result carries `file:line`, so each call feeds the next — *find by meaning → read more → trace a
symbol → jump to a definition → pivot to neighbors → map the file* — without the agent leaving the chat.

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
