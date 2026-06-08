# gtir

[![CI](https://github.com/WooFL/gtir/actions/workflows/ci.yml/badge.svg)](https://github.com/WooFL/gtir/actions/workflows/ci.yml)

Search code and notes by meaning. Ask *"where do we retry failed requests?"* and gtir finds the
function even when it's called `backoffFetch` and never says the word "retry."

A small command-line tool that indexes your repositories and Obsidian vaults and runs entirely on your
machine — a local Ollama model, no cloud, no API keys.

> *gtir* — Armenian *գտնել*, "to find."

## 🎯 What it's for

- **Find code by what it does, not what it's named.** grep needs the word; gtir matches the idea — ask
  in plain English (*"evict the least-recently-used cache entry"*, *"rotate a 3D vector"*).
- **Code and notes, one tool.** `gtir init` detects repo vs Obsidian vault and picks the right model (a
  code embedder for repos, a prose one for notes).
- **Local.** Everything runs through Ollama. Native on Windows, macOS, Linux.
- **In your editor.** Ships an MCP server so Claude or Cursor can search your codebase mid-session.

Under the hood: split files into chunks (tree-sitter for code, headings for Markdown), embed each with a
local model, and answer a query by fusing semantic (vector) and keyword (BM25) search.

### Why it saves an agent tokens

Finding the right file is where an agent burns tokens: with grep it searches a guess, gets a pile of
matches, and reads candidate files into context to find the right one — most of those tokens pay for
code it throws away. gtir ranks relevance *outside* the context window (a local embedding compare, zero
tokens) and returns the top few `file:line` chunks.

| Find *"where do we verify a JWT?"* | Tokens read |
| --- | --- |
| grep → read 3–4 candidate files | ~10,000–20,000 |
| gtir search → top hits | ~2,000–3,000 |

grep and gtir are complementary: grep for an exact string you know, gtir for finding by meaning.
(Numbers illustrative.)

## ✨ Highlights

- **Code and notes behind one query** — a code model on repos, a prose model on vaults, both through the
  same CLI and the same MCP server.
- **Measurable retrieval** — a committed eval harness (golden set + saved baseline + regression gate)
  reports Recall@1 and proves deltas; `gtir eval --tune` sweeps the fusion weights so they're
  data-driven, not eyeballed.
- **Query-adaptive ranking** — a bare identifier lets keyword search lead, a plain-English question lets
  the embedder lead, and a question that names a symbol gets both.
- **One runtime, every OS** — a single local Ollama model, no Python/torch/API keys, prebuilt
  vector-store binaries; installs the same on Windows, Linux, macOS.
- **AST-aligned chunks** — whole functions, classes, structs (including shaders), not fixed-size windows.
- **Traversable in an editor** — search, read a span, outline a file, find similar chunks, jump to a
  symbol's definition or references.

## ⚙️ How it works

```
walk repo (.gitignore-aware)
  → tree-sitter AST chunks (+ cAST sibling-merge; line-window fallback for grammarless files)
  → markdown: heading-aware sections, each carrying its heading breadcrumb + frontmatter tags
  → contextual prefix per chunk (code: path › enclosing class/module; markdown: heading breadcrumb)
  → embed via Ollama /api/embed  (qwen3-embedding:0.6b)
  → LanceDB upsert (vectors + BM25 FTS over a path/scope/decl-weighted text)
search: query → embed → vector branch + BM25 branch → query-adaptive Reciprocal Rank Fusion (k=60)
```

Tuned ranking knobs, all overridable per-repo in `.gtir/config.json`:

- **Field-weighted BM25** (`bm25Boost`) — indexes the path / scope / declaration ahead of the body, so a
  symbol match beats an incidental mention in a comment.
- **Query-adaptive fusion** (`ftsWeight` / `ftsWeightSymbol` / `ftsWeightMixed`) — a bare identifier lets
  BM25 lead, a plain-English question lets the embedder lead, and a question that *names* a symbol
  (`fetchWithRetry`) is fused with full lexical weight so the exact token still counts.
- **Test-file demotion** (`testPenalty`) — a query for an implementation won't return its test file at #1
  (unless you're actually asking about tests).
- **Scope breadcrumb** (`contextScope`) — prepends the enclosing class/module to each chunk, so a method
  sliced out of a big class keeps its context.

The fusion weights are swept on the eval golden set (`gtir eval --tune`), not hand-guessed, and should be
re-tuned per embedding model — a weight that's right for one model can be inert on another.

### Supported languages

gtir chunks by AST wherever it has a tree-sitter grammar, and falls back to line-window chunking
everywhere else — grammarless files stay fully searchable, just not function-aligned.

- **AST-aware** (function/class/struct chunks): TypeScript/JS/TSX, Python, Rust, Go, C, C++, Objective-C,
  and — once installed — HLSL and GLSL shaders.
- **Shaders:** `.hlsl`/`.glsl` need real grammars — run [`gtir fetch-grammars`](#shader-grammars) once
  (~5 MB, no toolchain). `.slang` uses HLSL, `.metal` uses C++, `.wgsl` falls back to line-windows. Until
  fetched, shaders index as line-windows and gtir tells you so.
- **Markdown** — split by heading, each chunk carrying its heading breadcrumb and frontmatter tags.
- **Everything else** (JSON/YAML/TOML/HTML/CSS, any unlisted extension) → line-window chunking.

## 📦 Install

```bash
git clone <gtir repo> && cd gtir
npm install
npm link            # exposes `gtir` globally
```

Requires **Node ≥20** and **Ollama ≥0.24** running locally. LanceDB ships prebuilt native binaries (no
compile step) for Windows (x64/arm64), Linux (x64/arm64, glibc + musl), and Apple Silicon macOS.
**Intel Macs (`darwin-x64`) are not supported** — LanceDB ships no prebuilt for them.

## 🔧 Setup (once per machine)

```bash
gtir doctor
```

Checks Ollama, pulls the embedding model if missing, and verifies embeddings work:

```text
gtir doctor — ready ✓
  ✓  Node 26.1.0
  ✓  Ollama reachable at http://localhost:11434
  ✓  model qwen3-embedding:0.6b
  ✓  embeddings (dim=1024)
```

The first run pulls the model (~1 GB GGUF, one-time). `--no-pull` only diagnoses and prints the
`ollama pull` command; `--repo <project>` checks that repo's configured model. It exits non-zero when
something's missing, so it works as a script preflight.

## 🚀 Quick start

```bash
gtir demo            # a real search vs grep on a bundled corpus (numbers computed, not canned)
```

Point it at a real project:

```bash
cd ~/my-project
gtir init --repo .     # detect code vs notes, index, install the auto-refresh git hooks
```

```text
gtir init: /home/me/my-project
  mode: code (detected)
  config: wrote .gtir/config.json
  gitignore: .gtir/ added
  index: 1284 chunks, dim=1024
  hook: auto-refresh installed (post-commit + post-rewrite; rebase-aware)
```

Now search — the query never says `verifyToken`, but that's the top hit:

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
  }
]
```

Results are JSON on stdout (logs go to stderr), so pipe to `jq` for just the locations:

```bash
gtir search "verify a JWT" --repo . | jq -r '.[] | "\(.path):\(.lines)"'
#   src/auth/token.ts:48-79
#   src/auth/middleware.ts:12-26
```

That's the loop: `init` once, then `search`. The git hooks keep the index fresh and are rebase-aware
(see [Staying fresh](#staying-fresh)).

## 🧰 Commands

```bash
gtir init    --repo <project> [--notes|--code] [--no-index] [--no-hook]  # set up a repo or vault
gtir index   --repo <project> [--rebuild] [--no-cache]                   # build / full rebuild
gtir refresh --repo <project> [--no-cache]                              # incremental (changed files)
gtir watch   --repo <project> [--debounce 1500]        # live-refresh on every save (uncommitted edits)
gtir search  "how are sessions created" --repo <project> [-k 8] [--language python] [--path-prefix src/] [--edges] [--centrality]
gtir status  --repo <project>                          # model, dim, file count
gtir hook    --repo <project> [--remove]               # install/remove the auto-refresh git hooks
gtir fetch-grammars                                    # download prebuilt HLSL/GLSL grammars (~5 MB)
gtir doctor  [--repo <project>] [--no-pull]            # check Ollama + model, pull if missing
gtir mcp     --repo <project> [--label name:<repo>] [--watch] [--print-config]   # run the MCP server
gtir eval    --repo <corpus> --golden <f> [--save] [--json]            # score retrieval quality
gtir eval    --repo <corpus> --tune ["ftsWeight=0,0.2;ftsWeightMixed=0,1"]   # sweep fusion weights
gtir eval    --repo <corpus> --edges [--save]                         # score call-edge extraction quality
gtir graph   --repo <project> [--focus <symbol>] [--rollup] [--out FILE]    # render edge graph as HTML
gtir impact  <symbol> --repo <project> [--downstream] [--depth N] [--path F]  # transitive blast radius
gtir orphans --repo <project>                                               # likely-dead symbols
gtir cycles  --repo <project>                                               # circular dependencies
```

`search` prints JSON to stdout; everything human-readable goes to stderr. The index lives in
`<project>/.gtir/` and is fully regenerable, so add it to `.gitignore` (`gtir init` does this).

### What `gtir init` does

Detects a **note vault** (`.obsidian/` or markdown-dominant → `nomic-embed-text` + prose chunk sizes) or
a **codebase** (→ `qwen3-embedding` defaults), then:

1. writes `.gtir/config.json` (never overwrites an existing one),
2. appends `.gtir/` to `.gitignore`,
3. builds the first index,
4. installs the auto-refresh git hooks (`post-commit` + `post-rewrite`) — or, with **lefthook/husky**,
   prints the snippet to add rather than clobbering the managed hook.

For a code repo with a nested vault (e.g. `wiki/`), it adds that folder to `skipDirs`. Force the mode
with `--notes` / `--code`; skip steps with `--no-index` / `--no-hook`.

### What gets indexed (and skipped)

The walk respects your `.gitignore`, and on top of that skips:

- **Build / vendored / noise directories** (`skipDirs`): `node_modules`, `.git`, `dist`, `build`,
  `target`, `coverage`, `.next`, `.turbo`, `.cache`, `.venv`, `.obsidian`, `.gtir`, the usual C/C++/C#
  build output (`Debug`, `Release`, `x64`, `obj`, `.vs`), and vendored deps (`vendor`, `third_party`,
  `thirdparty`, `external`).
- **Generated suffixes** (`skipSuffixes`): `.min.js`, `.min.css`, `.map`, `.lock`, `.excalidraw.md`.
- **Files over 256 KB** (`maxFileBytes`).

Setting `skipDirs` / `skipSuffixes` **replaces** the defaults rather than merging — keep the entries you
still want when you edit them.

### Shader grammars

The HLSL and GLSL grammars aren't in the upstream grammar package, and rebuilding them needs a heavy
toolchain (a ~510 MB wasi-sdk), so they ship as a small prebuilt download:

```bash
gtir fetch-grammars          # ~5 MB, then: gtir index --rebuild
```

It downloads the prebuilt wasm (OS/CPU-independent), verifies each against a pinned SHA-256, and installs
them. Until then gtir indexes shaders as line-windows. You only need the 510 MB toolchain to
*regenerate* a grammar (`npm run build:shaders`, for maintainers), never to use one.

### Staying fresh

`gtir init` installs `post-commit` and `post-rewrite` hooks. After a commit, `post-commit` runs
`gtir refresh` (incremental — only changed files re-chunked, unchanged content reuses the embedding cache).

`post-rewrite` handles **rebase**: `post-commit` defers while git's in-flight markers (`rebase-merge`,
`rebase-apply`, `sequencer`, `CHERRY_PICK_HEAD`, `MERGE_HEAD`, …) are present, then `post-rewrite` runs
exactly one refresh of the final tree. So an N-commit rebase costs **one** refresh of the net diff, not
N refreshes of states you threw away. Worktrees are handled per-worktree; `commit --amend` refreshes
once; a manual `gtir refresh` never defers.

**Live mode (uncommitted edits)** — track the working tree as you save:

```bash
gtir watch --repo .                 # standalone: debounced refresh on every save, Ctrl+C to stop
gtir mcp   --repo . --watch         # or bundled into the MCP server
```

It watches the same fileset as the indexer, coalesces rapid saves (`--debounce`, default 1500 ms), and
honors the same git-busy gate as the hooks (defers during rebase/cherry-pick/merge). Each save triggers
a **targeted** refresh — only the changed paths, so a single-file refresh stays roughly constant
regardless of repo size. It also runs a startup catch-up, a periodic full re-sweep (`--sweep <seconds>`,
default 5 min, `0` disables) to catch missed events, and keeps a heartbeat lock (`.gtir/watch.lock`) so
the commit hooks stand down while a watcher runs (the lock goes stale within ~2.5 min if it crashes).
With `gtir mcp --watch`, every served index reflects uncommitted edits with no restart.

### Embedding cache

An embedding depends only on `(model, text)`, so gtir keys each chunk by `content_hash =
sha256(embedText)` and reuses the prior index's vector for any byte-identical chunk — both `--rebuild`
and `refresh` benefit. The stats line shows the split: `indexed N chunks (R reused, K embedded)`. Reuse
is gated on the model matching (switching models re-embeds everything); `--no-cache` forces a full
re-embed.

### Graph-aware search

Two opt-in flags fold the edge graph into search (JSON on stdout; MCP `search_`/`read_` tools take the same as booleans):

- `gtir search "<query>" --edges` — attach each hit's `callers`/`callees` (capped, the symbols the
  chunk declares). One call gives the result *and* its neighborhood. `read_` also takes `edges:true`.
- `gtir search "<query>" --centrality` — gently re-rank by call-graph degree, so a widely-called
  helper or widely-imported module floats up. Bounded multiplier (≤ `centralityWeight`, default
  +15%); off by default; ignored when reranking is on (the reranker stays authoritative).

Both read the edge graph at query time (cached in memory); they need an index built with the edge
layer (`gtir index`). Tunables: `centralityWeight`, `centralityK`, `contextCap` in the config file.

## 📊 Measuring retrieval quality — `gtir eval`

A committed eval harness so you can tell whether a change improved retrieval or quietly hurt it:

```bash
npm run eval              # score the golden set against the bundled corpus, compare to baseline
npm run eval -- --save    # set the current metrics as the new baseline
```

Runs `eval/golden.json` (110 queries) against `eval/corpus/`, reports **Recall@{1,5,10}**, **MRR**, and
**Sec-hit@{1,5}**, compares to `eval/baseline.json`, and **exits non-zero if the overall or `gate`
metrics regress** — so it works in CI.

Tiers: **gate** (55, the strict regression floor), **hard** (33, realistic decoys — reported with deltas
rather than gated, since one rank flip moves it ~0.03 and inference isn't bit-exact), **symbol** (12,
bare-identifier lookups where BM25 carries it), **mixed** (10, natural-language queries that name a symbol).

Corpus-agnostic: point `--repo` at any index and pass `--golden <file>` to score your own set. `--json`
emits metrics to stdout; `--no-build` skips the pre-run refresh.

**Tuning fusion weights — `gtir eval --tune`.** Fusion is a query-time step, so one index build serves
every combo and query embeddings are cached across them — an N-combo sweep costs one embedding pass:

```bash
gtir eval --repo eval/corpus --tune --no-build                          # default grid (pure-NL ftsWeight)
gtir eval --repo eval/corpus --tune "ftsWeightMixed=0,0.3,0.5,1" --no-build   # a specific axis
```

It prints the grid best-first by (MRR, R@1, R@5) with per-tier R@1, marks your current config, and
recommends a `.gtir/config.json` line. Re-run after any embedding-model change.

**Edge-extraction quality — `gtir eval --edges`.** Beyond retrieval, a second harness scores the *call
graph*. It runs `eval/edges-golden.json` (labeled cross-file, same-file, and expected-external calls
across ts/py/rs/cpp) against the extracted edges over `eval/corpus/`, classifying each golden call as
**correct** (resolved to the right file — `inferred` promotions count), **wrong** (resolved to the wrong
file), or **missing** (extraction never saw the call). `missing` isolates extraction gaps; `wrong`
isolates resolution gaps. It reports per-language recall + the `resolved/inferred/ambiguous/external`
split and gates on a recall floor + wrong-rate ceiling vs. `eval/edges-baseline.json`:

```bash
npm run eval:edges            # score call-edge extraction, compare to baseline
npm run eval:edges -- --save  # set the current metrics as the new baseline
```

## 🥇 Reranking (optional)

gtir can rerank the top hybrid candidates with a cross-encoder before returning them. Off by default;
needs a separate `llama-server`.

1. Get a reranker GGUF (~600 MB), e.g. `bge-reranker-v2-m3-Q8_0.gguf`.
2. `llama-server -m bge-reranker-v2-m3-Q8_0.gguf --reranking --pooling rank --host 127.0.0.1 --port 8088`
3. Set `{ "rerank": true }` in `.gtir/config.json`, or pass `--rerank` per command.

Keys (defaults): `rerankUrl` (`http://127.0.0.1:8088`), `rerankModel` (`bge-reranker-v2-m3`),
`rerankCandidates` (`24`), `rerankMaxChars` (`2000`). If the server is unreachable, gtir falls back to
hybrid order with a stderr note — a search never fails because the reranker is down. On the bundled
corpus reranking didn't beat the hybrid order; measure on yours with `gtir eval --rerank` before relying
on it.

## 🔌 MCP server

Expose gtir's search as MCP tools so Claude can call them mid-session:

```bash
gtir mcp --repo <codeRepo> --repo <wikiRepo>
```

A tool suite **per index** (auto-labeled by model — `code`, `notes` — or override with
`--label name:<repo>`), plus a global `gtir_status`:

- **`search_<label>`** — hybrid semantic + BM25 search (`compact: true` for path/lines/score only).
- **`read_<label>`** — read the source of a span (`path` + `lines`, optional `context`).
- **`outline_<label>`** — list a file's indexed chunks with line ranges and signatures.
- **`similar_<label>`** — find chunks similar to a span (reuses the stored embedding, no re-embed).
- **`find_<label>`** — jump to a symbol by exact name: `kind:"definition"` (default) or
  `kind:"references"` (lexical, not type-resolved, so same-named symbols collide).

Register the server by pasting `gtir mcp … --print-config` into your `.mcp.json`. It's stdio JSON-RPC
with no extra dependencies. Add `--watch` to live-refresh every served index as you edit (defers during
git operations).

```text
1. search_code  { "query": "where do we verify a JWT and reject expired tokens" }
      → src/auth/token.ts:48-79      top hit — verifyToken(), matched by meaning
2. read_code    { "path": "src/auth/token.ts", "lines": "48-79", "context": 5 }
3. find_code    { "symbol": "verifyToken", "kind": "references" }
4. similar_code { "path": "src/auth/token.ts", "line": 50 }
```

Every result carries `file:line`, so each call feeds the next.

## 🕸️ Edges — how things connect

Beyond finding a span, gtir tracks the edges between spans — locally, no LLM. Code gets `calls` and
`imports` edges (tree-sitter AST); notes get `links` and `embeds` (Obsidian `[[wikilinks]]` / `![[embeds]]`).
Edges build on `gtir index`/`refresh` (incremental, same git hooks) into a second LanceDB table, and the
MCP server exposes them as traversal tools:

- **`callers_<label>`** `{ symbol }` — spans that call a symbol (notes: `backlinks_<label>` — notes that link here).
- **`callees_<label>`** `{ symbol }` — what a symbol calls (notes: `links_<label>` — what a note links to).
- **`neighbors_<label>`** `{ symbol, path, lines }` — the blast radius: callers + callees + same-file siblings.

Each edge carries a confidence tag: **`resolved`** (a same-file definition, or an import-scoped one),
**`ambiguous`** (a cross-file match no import vouches for, or several same-named definitions — the
candidate path(s) returned, never a guess passed off as fact), **`inferred`** (an ambiguous edge promoted
by embedding similarity — see below), or **`external`** (a library/builtin not in the index). Resolution
is import-scoped *heuristic*, not type-resolved — a cross-file call only counts as `resolved` when an
import links the two files; otherwise a same-name coincidence (a builtin `Error`, a method `.split`) stays
`ambiguous`. It is not an LSP. `find … references` prefers real call edges and falls back to the lexical
sweep when none exist.

### Inferred edges (embedding-disambiguation)

When a call name resolves to several candidate definitions (or one unvouched cross-file
candidate), the rule resolver marks the edge `ambiguous`. At index time gtir then compares the
call-site chunk's embedding against each candidate definition's embedding and, when one is a
confident match, promotes the edge to **`inferred`** — choosing the target and recording a cosine
`score`. Inferred edges are traversed like `resolved` ones (they show up in `callers`/`callees`,
`impact`, `cycles`, and `--centrality`), but stay distinct so you can tell a proven edge from a
guessed one. It reuses vectors already in the index (no extra embedding cost) and is on by default.

Tunables (config): `disambiguate` (default true), `disambigThreshold` (0.55), `disambigMargin` (0.05).

### Visualizing the edge graph

`gtir graph` renders the edge layer as a single self-contained interactive HTML file — open it in any browser, no server, no network. A WebGL renderer (cosmograph/cosmos) keeps it smooth at thousands of nodes, and each directory/package is laid out as its own **territory** — a packed disc on a grid — so the structure reads at a glance. **Node color = directory cluster**, **node size = connection count**, **edge color = confidence** (within-package edges solid; cross-package bridges faded). Translucent **islands** mark each package; hub files are labeled.

    gtir graph --repo .                         # whole repo (full graph, GPU-rendered)
    gtir graph --repo . --focus verifyToken     # ego-graph: 2 hops around one symbol
    gtir graph --repo . --rollup                # collapse symbols to files (architecture view)

In the page, a control panel filters live: a **min-degree** slider hides leaf nodes, **kind** and **confidence** toggles carve the graph (external edges start hidden), a **spacing** slider sizes the territories, a **labels** slider sets how many hubs are named, search centers a node, and the cluster legend isolates a package. The full graph is embedded and filtered in-browser, so no regeneration is needed.

Flags: `--out FILE` (default `gtir-graph.html`), `--focus SYM [--depth N]`, `--rollup`, `--kind`/`--conf`/`--path-prefix` pre-filters, `--max-nodes N` (optional hard cap; off by default). The graph reads edges built during `gtir index`.

> The vendored WebGL bundle (`vendor/cosmos.min.js`) is regenerated with `npm run bundle:cosmos` (needs dev deps); it ships in the npm package.

### Graph analysis: impact, orphans, cycles

Beyond 1-hop `callers`/`callees`, gtir traverses the whole edge graph. All three are JSON on
stdout and exist as MCP tools (`impact_<label>`, `orphans_<label>`, `cycles_<label>`).

- `gtir impact <symbol>` — transitive blast radius (who calls this, recursively).
  `--downstream` for what it depends on; `--depth N` to cap hops; `--path <file>` to
  disambiguate a name defined in multiple files; `--include-ambiguous` to also follow
  name-coincidence edges. Capped at 500 nodes (`--limit`); `truncated:true` when hit.
- `gtir orphans` — likely-dead **callable** symbols (functions/classes/methods with no inbound
  reference). Local variables and types are excluded; entrypoints (exports, `bin/`/`main`/`index`/
  `cli`, test files, Go-exported names, handler names) go to a separate `possible_entrypoint` list.
  Always counts ambiguous inbound as a reference (a method only called via `obj.method()` is not dead).
- `gtir cycles` — circular dependencies: call cycles and import cycles (Tarjan SCC
  groups, each with one sample path). Self-recursion is excluded.

`impact` and `cycles` traverse **resolved** (and embedding-`inferred`) edges by default (ambiguous
edges are name-coincidence guesses); pass `--include-ambiguous` to widen. (`orphans` always counts
ambiguous inbound — see above.) Requires an index built with the edge layer (`gtir index`); on an
older index, run `gtir index --rebuild` first.

## 🤖 Model

Default code model (in `src/config.mjs`): **`qwen3-embedding:0.6b`** (639 MB, 1024-dim), pulled by
`gtir doctor`. It's embedding-native (Ollama serves `/api/embed` for it first-class) and scores overall
R@1 0.918 / MRR 0.949 on the bundled eval.

- **Notes vaults** default to `nomic-embed-text` (prose, 768-dim) — `gtir init` picks it automatically
  for an Obsidian vault or markdown-dominant repo.
- **Higher recall:** override in `.gtir/config.json`, e.g. `{ "model": "qwen3-embedding:4b" }`, then
  `gtir index --rebuild`.
- Changing the model changes the embedding dimension, so `gtir index --rebuild` is required.

**"does not support embeddings"?** Ollama only serves `/api/embed` for models whose GGUF carries
`pooling_type` metadata; decoder models repackaged as embedders lack it and load completion-only, so the
embed call fails. Fix: use a pooling-native model — the default `qwen3-embedding:0.6b`, or
`nomic-embed-text`. `gtir doctor` detects this and names the fix.

## ⚠️ Known limitations

- **BM25 index is incremental.** First build and `--rebuild` build it in full; each `refresh` folds the
  changed fragments in via LanceDB `optimize()`. Deleted rows are filtered out immediately and physically
  pruned on the next refresh that adds rows.
- **Oversize leaf nodes are re-split, not dropped.** A node larger than `maxChars` (2000) with no nested
  target nodes is split into line-aware windows.
- **No dimension-skew guard at query time.** Switch models → rebuild. (`gtir status` shows the recorded
  dim.)
- **`find … references` is lexical, not type-resolved.** Same-named methods both surface and a name in a
  comment counts. `find … definition` (the default) is precise; use an LSP for exact type-aware references.
- **Edge resolution is import-scoped heuristic, not type-resolved.** A cross-file call is only
  `resolved` when an import links the files; a same-name coincidence with no import (or several same-named
  definitions) is tagged `ambiguous` with its candidate path(s), not resolved to one. Use an LSP for exact
  type-aware references; `find … references` uses edges when present.

## 🛠️ Development

```bash
npm test        # node --test — full suite, runs offline (embedder + HTTP client are injected)
npm run eval    # retrieval quality against the bundled corpus
```

The embedder and Ollama client are injectable (`cfg.embedImpl` / `cfg.fetchImpl`), so the chunker,
fusion, eval math, weight sweep, and MCP layer test offline. The integration suite stands up a mock
Ollama HTTP server and drives the real stack end-to-end — `/api/embed` → store → search → watcher →
rebase catch-up → doctor — still fully offline. CI runs `npm test` across {ubuntu, windows, macos} ×
Node {20, 22} on every push and PR; only the corpus eval needs a live Ollama. If you touch retrieval,
snapshot a baseline (`npm run eval -- --save`), change, and re-run — a gate/overall regression fails.

**Layout** (`src/`, one job per file): `walker` → `chunker` (+ `languages` / `parser`) → `contextualize`
→ `embed` (Ollama) → `store` (LanceDB) → `search` (fusion); plus `sweep` (weight tuning), `mcp` (server),
`eval` (metrics), and `bin/gtir.mjs` (the CLI). The bundled grammars live in `grammars/` (gitignored,
generated at prepack); the two shader grammars are built by `scripts/build-shader-grammars.mjs` and
shipped as a release asset that `gtir fetch-grammars` pulls.

## 📄 License

[MIT](LICENSE) © 2026 WooFL
