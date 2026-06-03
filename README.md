# gtir

[![CI](https://github.com/WooFL/gtir/actions/workflows/ci.yml/badge.svg)](https://github.com/WooFL/gtir/actions/workflows/ci.yml)

Search your code and notes by meaning. Ask *"where do we retry failed requests?"* and gtir finds the
function even when it's called `backoffFetch` and never says the word "retry."

It's a small command-line tool that indexes your repositories and Obsidian vaults and runs entirely on
your machine — a local Ollama model, no cloud, no API keys, nothing leaves your laptop.

> *gtir* — Armenian *գտնել*, "to find."

## 🎯 What it's for

- **Find code by what it does, not what it's named.** grep needs the word; gtir matches the idea. Ask
  in plain English — *"evict the least-recently-used cache entry"*, *"rotate a 3D vector"* — without
  remembering the function name.
- **Code and notes, one tool.** Point `gtir init` at a repo or an Obsidian vault and it detects which,
  then picks the right model (a code embedder for repos, a prose one for notes).
- **It stays local.** Everything runs through Ollama. Native on Windows, macOS, and Linux.
- **It works in your editor.** Ships an MCP server so Claude or Cursor can search your codebase
  mid-session.

Under the hood: split files into chunks (tree-sitter for code, headings for Markdown), embed each with
a local model, and answer a query by blending semantic (vector) and keyword (BM25) search.

### Why it saves an agent tokens

Finding the right file is where an agent burns tokens. With grep it searches a guess, gets a pile of
matches, and reads candidate files into context to work out which one is right — most of those tokens
pay for code it then throws away. gtir ranks relevance *outside* the context window (a local embedding
compare, zero tokens) and hands back the top few `file:line` chunks. The agent reads the winner, not
the rejects.

| Find *"where do we verify a JWT?"* | Tokens read |
| --- | --- |
| grep → read 3–4 candidate files | ~10,000–20,000 |
| gtir search → top hits | ~2,000–3,000 |

grep and gtir are complementary: grep for an exact string you already know, gtir for finding by
meaning. Folding several guess→grep→read round-trips into one ranked answer also means fewer model
turns, so the answer lands sooner. For the other big token sink — verbose command output (`git`, test
runs, builds) — pair gtir with an output-compression proxy like [RTK](https://github.com/rtk-ai/rtk).
(Token numbers above are illustrative.)

## ✨ What makes it different

Semantic code search isn't new. What gtir combines, that most tools don't:

- **Code and notes behind one query.** Most tools pick a lane — code *or* documents — and embed
  everything with a single model. gtir runs a code model on repos and a prose model on vaults, detects
  which per project, and serves both through the same CLI and the same MCP server. The function and the
  note explaining why it works are one `search` apart.
- **Retrieval you can measure.** gtir ships a committed eval harness — a golden query set, a saved
  baseline, and a regression gate that fails when a change makes search worse. Most tools give you no
  way to tell whether a tweak helped or quietly hurt; gtir reports its own Recall@1 and proves the
  delta.
- **Ranking that adapts to the question.** Instead of one fixed blend of vector and keyword search,
  gtir routes by intent: a bare identifier lets keyword search lead, a plain-English question lets the
  embedder lead, and a question that names a symbol gets both. Each rule is in the tree because it moved
  the eval numbers — a cross-encoder reranker and a bigger model were tried and dropped.
- **Local, one runtime, every OS.** A single local Ollama model does the embedding — no Python, no
  torch, no API keys, and no native build step (the vector store ships prebuilt binaries). That stack
  is usually where cross-platform pain lives, so gtir installs and runs the same on Windows as on Linux
  or macOS.
- **Chunks that follow the code.** Files are split along the syntax tree — whole functions, classes,
  structs — not fixed-size windows, so a hit comes back as a complete unit with its signature. That
  extends to shaders, which most code search skips entirely.
- **Made to be traversed.** In an editor it's more than a search box: search, read a span, outline a
  file, find similar chunks, and jump to a symbol's definition or references — enough to navigate a
  codebase, not just match strings against it.

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

Search runs two branches — vector (semantic) and BM25 (keyword) — and fuses them. A handful of tuned
knobs sharpen the ranking, all overridable per-repo in `.gtir/config.json`:

- **Field-weighted BM25** (`bm25Boost`) — indexes the path / scope / declaration ahead of the body, so
  a symbol match beats an incidental mention in a comment.
- **Query-adaptive fusion** (`ftsWeight` / `ftsWeightSymbol`) — a bare identifier lets BM25 lead; a
  natural-language question lets the embedder lead.
- **Identifier boost** (`ftsWeightMixed`) — a natural-language query that *names* a symbol
  (`fetchWithRetry`) gets a lexical nudge.
- **Test-file demotion** (`testPenalty`) — a query for an implementation won't return its test file at
  #1 (unless you're actually asking about tests).
- **Scope breadcrumb** (`contextScope`) — prepends the enclosing class/module to each chunk, so a
  method sliced out of a big class keeps its context.

Each knob is in the tree because it improved the eval numbers (below). A cross-encoder reranker, a
structural-centrality prior, and a bigger embedding model were tried and dropped because they didn't.

### Supported languages

gtir chunks by AST wherever it has a tree-sitter grammar, and falls back to line-window chunking
everywhere else — grammarless files are still fully indexed and searchable, just not function-aligned.

- **AST-aware** (function/class/struct-level chunks): TypeScript/JS/TSX, Python, Rust, Go, C, C++,
  Objective-C, and — once installed — HLSL and GLSL shaders.
- **Shaders:** `.hlsl` and `.glsl` get real grammars that parse `register()` / `SV_TARGET` semantics
  cleanly. `.slang` uses the HLSL grammar, `.metal` uses C++, `.wgsl` falls back to line-windows. The
  shader grammars aren't bundled — run [`gtir fetch-grammars`](#shader-grammars) once (~5 MB, no
  toolchain). Until then gtir indexes shaders as line-windows and tells you so.
- **Markdown** is split by heading, each chunk carrying its heading breadcrumb and frontmatter tags.
- **Everything else** (JSON/YAML/TOML/HTML/CSS, and any unlisted extension) → line-window chunking.

## 📦 Install

```bash
git clone <gtir repo> && cd gtir
npm install
npm link            # exposes `gtir` globally
```

Requirements: **Node ≥20** and **Ollama ≥0.24** running locally.

The vector store (LanceDB) ships a prebuilt native binary, so there's no compile step — it works on
Windows (x64/arm64), Linux (x64/arm64, glibc + musl), and Apple Silicon macOS. **Intel Macs
(`darwin-x64`) are not supported**: LanceDB ships no `darwin-x64` prebuilt, so `npm install` finds no
native binary and gtir won't load.

## 🔧 Setup (once per machine)

```bash
gtir doctor
```

Checks Ollama, pulls the embedding model if it's missing, and verifies embeddings work:

```text
gtir doctor — ready ✓
  ✓  Node 26.1.0
  ✓  Ollama reachable at http://localhost:11434
  ✓  model qwen3-embedding:0.6b
  ✓  embeddings (dim=1024)
```

The first run pulls the model (a HuggingFace GGUF, ~1 GB, one-time). `--no-pull` only diagnoses and
prints the `ollama pull` command to run yourself; `--repo <project>` checks that repo's configured
model (e.g. `nomic-embed-text` for a notes vault). It exits non-zero when something's missing, so it
works as a script preflight.

## 🚀 Quick start

See it work before indexing anything of your own:

```bash
gtir demo
```

```text
  ❓  "compute the edit distance between two strings"

      grep -rin distance   →  5 matches in 2 files  (graph/dijkstra.rs, text/levenshtein.py)
      gtir search   →  top hit:

         text/levenshtein.py:1-16
         ┌──────────────────────────────────────────────────────────┐
         │ def levenshtein(s: str, t: str) -> int:                  │
         │     """Classic Wagner-Fischer dynamic-programming edit … │
         └──────────────────────────────────────────────────────────┘
         ↑ matched by meaning — your query never said "levenshtein"

  to find it, you read:   grep → 474 tokens   ·   gtir → 187 (one span)   (≈ 3× less)
```

`gtir demo` runs a real search against a bundled sample corpus (the numbers are computed, not canned).
Point it at your own indexed code with `gtir demo --repo .`, or ask your own question with `--query "…"`.

Then point it at a real project:

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

Now search. The query never says `verifyToken`, but that's the top hit:

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

That's the whole loop: `init` once, then `search` as often as you like. The git hooks keep the index
fresh as the code changes — and they're rebase-aware: a rebase or cherry-pick won't re-embed every
intermediate commit, it refreshes once when the operation finishes (see [Staying fresh](#staying-fresh)).

## 🧰 Commands

```bash
gtir init    --repo <project> [--notes|--code] [--no-index] [--no-hook]  # set up a repo or vault
gtir index   --repo <project> [--rebuild] [--no-cache]                   # build / full rebuild
gtir refresh --repo <project> [--no-cache]                              # incremental (changed files)
gtir watch   --repo <project> [--debounce 1500]        # long-lived: live-refresh on every save (uncommitted edits)
gtir search  "how are sessions created" --repo <project> [-k 8] [--language python] [--path-prefix src/]
gtir status  --repo <project>                          # model, dim, file count
gtir hook    --repo <project> [--remove]               # install/remove the auto-refresh git hooks
gtir fetch-grammars                                    # download prebuilt HLSL/GLSL grammars (~5 MB)
gtir doctor  [--repo <project>] [--no-pull]            # check Ollama + model, pull if missing
gtir mcp     --repo <project> [--label name:<repo>] [--watch] [--print-config]   # run the MCP server
gtir eval    --repo <corpus> --golden <f> [--save] [--json]            # score retrieval quality
```

`search` prints JSON to stdout; everything human-readable goes to stderr. The index lives in
`<project>/.gtir/` and is fully regenerable, so add it to `.gitignore` (`gtir init` does this for you).

### What `gtir init` does

It detects whether the target is a **note vault** (has `.obsidian/` or is markdown-dominant →
`nomic-embed-text` + prose chunk sizes) or a **codebase** (→ `qwen3-embedding` defaults), then:

1. writes `.gtir/config.json` (never overwrites an existing one),
2. appends `.gtir/` to `.gitignore`,
3. builds the first index,
4. installs the auto-refresh git hooks (`post-commit` + `post-rewrite`) — or, if it finds
   **lefthook/husky**, prints the snippet to add rather than clobbering the managed hook.

For a code repo with a nested vault (e.g. `wiki/`), it adds that folder to `skipDirs` so it isn't
indexed twice with the wrong model. Force the mode with `--notes` / `--code`; skip steps with
`--no-index` / `--no-hook`.

### What gets indexed (and skipped)

The walk respects your `.gitignore`. On top of that it skips:

- **Build / vendored / noise directories** (`skipDirs`): `node_modules`, `.git`, `dist`, `build`,
  `target`, `coverage`, `.next`, `.turbo`, `.cache`, `.venv`, `.obsidian`, `.gtir`, the usual C/C++/C#
  build output (`Debug`, `Release`, `x64`, `obj`, `.vs`), and vendored deps (`vendor`, `third_party`,
  `thirdparty`, `external`).
- **Generated suffixes** (`skipSuffixes`): `.min.js`, `.min.css`, `.map`, `.lock`, `.excalidraw.md`.
- **Files over 256 KB** (`maxFileBytes`).

All three live in `.gtir/config.json`. Note that setting `skipDirs` / `skipSuffixes` **replaces** the
defaults rather than merging, so keep the entries you still want when you edit them.

### Shader grammars

gtir bundles AST grammars for nine languages, but the HLSL and GLSL shader grammars can't ride along:
they aren't in the upstream grammar package, and rebuilding them from source needs a heavy compiler
toolchain (a ~510 MB wasi-sdk). So they're shipped as a small prebuilt download instead.

```bash
gtir fetch-grammars          # ~5 MB, then: gtir index --rebuild
```

When gtir indexes a repo with `.hlsl`/`.glsl` files and the grammar isn't installed, it prints a notice
and indexes them as line-windows for now. `gtir fetch-grammars` downloads the prebuilt wasm (WebAssembly
is OS/CPU-independent, so one artifact works on every machine), verifies each against a pinned SHA-256,
and installs them. Re-run `gtir index --rebuild` and your shaders chunk function-by-function.

You only need the 510 MB toolchain to *regenerate* a grammar (`npm run build:shaders`, for maintainers),
never to use one.

### Staying fresh

`gtir init` installs two git hooks: `post-commit` and `post-rewrite`. After an ordinary commit, the
`post-commit` hook runs `gtir refresh` (incremental — only changed files are re-chunked, and unchanged
content reuses the embedding cache below), so the index tracks your working tree automatically.

The `post-rewrite` hook is there for **rebase**, which is otherwise a trap. A rebase replays your commits,
and depending on the git backend the `post-commit` hook either fires once per replayed commit — so a naive
setup re-embeds every throwaway intermediate tree, which is where the "rebase pinned my GPU for ten
minutes" reports come from — or doesn't fire at all, leaving the index stale. gtir handles both ends:

- **During** the operation, `post-commit` **defers**. It checks git's own in-flight markers
  (`rebase-merge`, `rebase-apply`, `sequencer`, `CHERRY_PICK_HEAD`, `MERGE_HEAD`, …) and does nothing
  while a rebase / cherry-pick / merge / revert / bisect is in progress — no work against a tree you're
  about to discard.
- **After** it completes, `post-rewrite` runs exactly one refresh of the final tree.

That one catch-up is cheap because it only does real work where the tree actually changed: files git
didn't touch keep their mtime and are skipped; files it rewrote get re-chunked but reuse their cached
embedding when the content is byte-identical (a rebase churns mtimes, not content); only genuinely new or
changed content is re-embedded. So an N-commit rebase costs **one** refresh proportional to the net diff,
not N refreshes of states you threw away.

Worktrees are handled correctly (the rebase state is resolved per-worktree), and `commit --amend`
refreshes exactly once. A manual `gtir refresh` never defers — run it any time to force a catch-up.

**Live mode (uncommitted edits).** The git hooks refresh at commit time. If you want the index to track
the working tree *as you save* — before you commit — run a long-lived watcher:

```bash
gtir watch --repo .                 # standalone: debounced refresh on every save, Ctrl+C to stop
gtir mcp   --repo . --watch         # or bundled into the MCP server — see below
```

It watches the same set of files the indexer would (skipDirs / `.gitignore` / indexable extensions),
coalesces rapid saves into one refresh (`--debounce`, default 1500 ms), and — crucially — **honors the
same git-busy gate as the hooks**: during a rebase / cherry-pick / merge the worktree churns constantly,
so the watcher defers and lets the `post-rewrite` catch-up handle it, rather than re-indexing every
transient state. `.gtir` and `.git` are excluded, so the watcher never reacts to its own index writes.

Two more things it handles so you don't have to:

- **Startup catch-up.** On launch it runs one refresh, so edits you made while it wasn't running are
  picked up immediately — you don't have to touch a file to wake it.
- **No double work with the hooks.** A running watcher keeps a heartbeat lock (`.gtir/watch.lock`); the
  commit hooks see it and stand down, so a commit doesn't trigger a second refresh on top of the
  save-time one. Clean exit drops the lock and the hooks resume; if the watcher crashes, the lock goes
  stale within ~2.5 min and they resume on their own. So you can leave the hooks installed and just run a
  watcher when you want live freshness — they won't fight.

Add `--watch` to `gtir mcp` and the server live-refreshes every index it serves *while it serves
queries* — so an agent's search reflects edits you haven't committed yet, with no restart. (The watcher
runs in the server process; its logs go to stderr, leaving stdout for the MCP protocol.)

### Embedding cache

An embedding depends only on `(model, text)`, so gtir keys each chunk by `content_hash = sha256(embedText)`
and reuses the prior index's vector for any chunk whose text is byte-identical. Unchanged content is
never re-embedded — both `--rebuild` (reuse the whole corpus) and `refresh` (reuse unchanged sections of
a changed file) benefit. The stats line shows the split: `indexed N chunks (R reused, K embedded)`.

Reuse is gated on the model matching, so switching models re-embeds everything. `--no-cache` forces a
full re-embed. Indexes built before this cache existed keep working; a one-time `gtir index --rebuild`
enables it.

## 📊 Measuring retrieval quality — `gtir eval`

gtir ships a committed eval harness so you can tell whether a change improved retrieval or quietly hurt
it, instead of guessing.

```bash
npm run eval              # score the golden set against the bundled corpus, compare to baseline
npm run eval -- --save    # set the current metrics as the new baseline
```

It runs a hand-written golden query set (`eval/golden.json`, 103 queries) against a fixture corpus
(`eval/corpus/`), reports **Recall@{1,5,10}**, **MRR**, and **Sec-hit@{1,5}**, compares to
`eval/baseline.json`, and **exits non-zero if the overall or `gate` metrics regressed** — so it works
in CI.

The golden queries are split into tiers:

- **gate** (51) — near-saturated queries; the strict regression floor.
- **hard** (30) — realistic decoys (near-duplicate implementations, test/doc shadows, ambiguous method
  names). This is the improvement *meter*, not a gate — it's small enough that one query flipping rank
  between runs moves it ~0.03, and Ollama's inference isn't bit-exact, so gating on it would flake.
  It's reported with deltas instead.
- **symbol** (12) — bare-identifier lookups like `LRUCache`, where BM25 carries the result.
- **mixed** (10) — natural-language queries that name a symbol; covers the identifier boost.

The harness is corpus-agnostic: point `--repo` at any index and pass `--golden <file>` to score your
own set. Keep golden/baseline JSON outside the indexed tree so they don't get indexed as corpus content.
`npm run eval` wraps `gtir eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json`;
add `--json` to emit metrics to stdout, `--no-build` to skip the pre-run refresh.

## 🥇 Reranking (optional)

gtir can rerank the top hybrid candidates with a cross-encoder before returning them. The default path
scores query and document separately (a bi-encoder); a cross-encoder reads the `(query, chunk)` pair
together, which can help when a test file or doc copy outranks the source you actually wanted. It's off
by default and needs a separate `llama-server`.

To turn it on:

1. Get a reranker GGUF (~600 MB), e.g. `bge-reranker-v2-m3-Q8_0.gguf`.
2. Serve it: `llama-server -m bge-reranker-v2-m3-Q8_0.gguf --reranking --pooling rank --host 127.0.0.1 --port 8088`
3. Set `{ "rerank": true }` in `.gtir/config.json`, or pass `--rerank` per command.

Config keys (defaults): `rerankUrl` (`http://127.0.0.1:8088`), `rerankModel` (`bge-reranker-v2-m3`),
`rerankCandidates` (`24` hits reranked), `rerankMaxChars` (`2000` per document). If the server is
unreachable, gtir falls back to hybrid order with a stderr note — a search never fails because the
reranker is down.

One thing worth knowing before you bother: on gtir's bundled corpus, reranking didn't help. Both
`bge-reranker-v2-m3` and `jina-reranker-v2` scored slightly *below* the plain hybrid order (hard-tier
Recall@1 0.63 → 0.60 / 0.57 across repeated runs). The hybrid RRF order is already strong, and reranking
short code chunks without the scope context the embedder sees doesn't add anything here. The plumbing
stays in place in case it helps on your corpus — measure it with `gtir eval --rerank` versus the floor.

## 🔌 MCP server

Expose gtir's search as MCP tools so Claude can call them mid-session:

```bash
gtir mcp --repo <codeRepo> --repo <wikiRepo>
```

You get a small tool suite **per index** (auto-labeled from each index's model — `code`, `notes` — or
override with `--label name:<repo>`), plus a global `gtir_status`:

- **`search_<label>`** — hybrid semantic + BM25 search. Pass `compact: true` for path/lines/score only.
- **`read_<label>`** — read the source of a span (`path` + `lines`, optional `context`).
- **`outline_<label>`** — list a file's indexed chunks with line ranges and signatures.
- **`similar_<label>`** — find chunks similar to a span (reuses the stored embedding, no re-embed).
- **`find_<label>`** — jump to a symbol by exact name: `kind:"definition"` (default) finds where it's
  declared; `kind:"references"` is a lexical sweep of where the name appears (not type-resolved, so
  same-named symbols collide). Use it instead of `search` when you already know the name.

Register the server by pasting the snippet from `gtir mcp … --print-config` into your project's
`.mcp.json`. It's stdio JSON-RPC with no extra dependencies. Add `--watch` (passed through into
`--print-config`) to have the server **live-refresh as you edit** — every served index tracks the
working tree without a commit or restart, so a mid-session `search_<label>` reflects uncommitted code.
The watcher defers during git operations just like the commit hooks (see [Staying fresh](#staying-fresh)).

```text
1. search_code  { "query": "where do we verify a JWT and reject expired tokens" }
      → src/auth/token.ts:48-79      top hit — verifyToken(), matched by meaning
2. read_code    { "path": "src/auth/token.ts", "lines": "48-79", "context": 5 }
      → the source span (lines 43-84)
3. find_code    { "symbol": "verifyToken", "kind": "references" }
      → src/auth/token.ts:48 (definition) · http/middleware.ts:12 · test/auth.test.ts:30
4. similar_code { "path": "src/auth/token.ts", "line": 50 }
      → src/auth/refresh.ts:20-41 · src/auth/middleware.ts:12-26
```

Every result carries `file:line`, so each call feeds the next: find by meaning → read more → trace a
symbol → jump to a definition → pivot to neighbors, all without leaving the chat.

## 🤖 Model

Default code model (in `src/config.mjs`): **`qwen3-embedding:0.6b`** (639 MB, 1024-dim) — pulled by
`gtir doctor`. It's embedding-native (Ollama serves it first-class) and it **tied** the older
`jina-code-embeddings-0.5b` on the bundled eval — overall R@1 0.913, MRR 0.945 — while staying a clean
one-command `ollama pull`.

- **Notes vaults** default to `nomic-embed-text` instead (prose, 768-dim); `gtir init` picks it
  automatically for an Obsidian vault or a markdown-dominant repo.
- **Higher recall:** override with a larger variant in `.gtir/config.json`, e.g.
  `{ "model": "qwen3-embedding:4b" }`, then `gtir index --rebuild`.
- Changing the model changes the embedding dimension, so a full `gtir index --rebuild` is required (the
  old vectors are incompatible).

### Embedding model won't embed? ("does not support embeddings")

Ollama only serves `/api/embed` for models whose GGUF carries `pooling_type` metadata. Decoder models
repackaged as embedders — notably `jina-code-embeddings` (Qwen2-based) and GTE-Qwen2 — lack it, so
Ollama's newer engine loads them completion-only and the embed call fails. `gtir doctor` detects this and
names the fix: **use a pooling-native model** — the default `qwen3-embedding:0.6b`, or `nomic-embed-text`.

If you specifically want a decoder embedder like jina-code, Ollama won't run it from the stock GGUF —
you'd re-pack the GGUF with `pooling_type` set and `ollama create` from it, or serve it under
`llama-server --embedding --pooling last` behind an OpenAI-compatible embeddings proxy. gtir targets
Ollama's `/api/embed` today, so the pooling-native route is the supported one.

## ⚠️ Known limitations

- **BM25 index is incremental.** First build and `--rebuild` build it in full; each `refresh` folds
  only the changed fragments in via LanceDB `optimize()`. Deleted rows are filtered out of results
  immediately and physically pruned on the next refresh that adds rows.
- **Oversize leaf nodes are re-split, not dropped.** A function/struct larger than `maxChars` (2000)
  with no nested target nodes is split into line-aware windows, so its content stays searchable.
- **No dimension-skew guard at query time.** `meta` records the model and dim; if you switch models,
  rebuild. (`gtir status` shows the recorded dim.)
- **`find … references` is lexical, not type-resolved.** It matches a symbol's name, so two same-named
  methods both surface and a name in a comment counts. `find … definition` (the default) is precise;
  for exact type-aware references, use an LSP.

## 🛠️ Development

```bash
npm test        # node --test — full suite, runs offline (embedder + HTTP client are injected)
npm run eval    # retrieval quality against the bundled corpus
```

The embedder and Ollama client are injectable (`cfg.embedImpl` / `cfg.fetchImpl`), so the chunker,
fusion, eval math, and MCP layer all test offline against fakes; only the corpus eval needs a live
Ollama. If you touch retrieval, snapshot a baseline (`npm run eval -- --save`), make the change, and
re-run — a regression in the overall or `gate` metrics fails the run.

**Layout** (`src/`, one job per file): `walker` → `chunker` (+ `languages` / `parser`) →
`contextualize` → `embed` (Ollama) → `store` (LanceDB) → `search` (fusion); plus `mcp` (server), `eval`
(metrics), and `bin/gtir.mjs` (the CLI). The nine bundled grammars live in `grammars/` (gitignored,
generated by `scripts/bundle-grammars.mjs` at prepack). The two shader grammars are the exception: built
by `scripts/build-shader-grammars.mjs` into `vendor/grammars/` and shipped as a release asset that
`gtir fetch-grammars` pulls.

## 📄 License

[MIT](LICENSE) © 2026 WooFL
