# gtir

**gtir** (Armenian *գտնել*, "to find") — a portable, install-once CLI for semantic **code and notes** retrieval over any repository or note vault. It chunks code with tree-sitter (AST-aware, with a cAST sibling-merge refinement), embeds chunks via a local **Ollama** model (`jina-code-embeddings-0.5b`), stores vectors + a BM25 index in **LanceDB**, and answers queries with hybrid (vector + BM25 + RRF) search.

**Scope:** code *and* notes. gtir indexes a codebase (`jina-code-embeddings`) or an Obsidian-style note vault (`nomic-embed-text`) — `gtir init` auto-detects which, and the MCP server exposes `search_code` / `search_notes` accordingly. (claude-obsidian's `wiki-retrieve` is an alternative for notes, but its scripts are Unix-only; gtir runs natively on Windows.)

## How it works

```
walk repo (.gitignore-aware)
  → tree-sitter AST chunks (+ cAST sibling-merge; recursive fallback for grammarless files)
  → markdown: heading-aware sections, each carrying its heading breadcrumb + frontmatter tags
  → contextual prefix per chunk: code chunks prepend an AST scope breadcrumb
    (path › enclosing class/module — first line); markdown uses its heading breadcrumb;
    grammarless files use path + first line (opt-in claude-cli tier still available)
  → embed via Ollama /api/embed  (jina-code-embeddings-0.5b)
  → LanceDB upsert (vectors + BM25 FTS)
search: query → embed → vector branch + BM25 branch → Reciprocal Rank Fusion (k=60)
```

Everything runs through **one runtime — Ollama** (the same daemon that serves `nomic-embed-text` for your notes). No Python, no sentence-transformers, no torch.

The AST scope breadcrumb is **additive** — it prepends the enclosing class/module to the chunk's
informative first line rather than replacing it. It restores the context a method loses when it is
sliced out of a large class: on a scope-ambiguous fixture (two big classes with identically-named
methods), it lifted Recall@1 and Sec-hit@1 by ~6 points each via `gtir eval`, with no regression on
the rest of the corpus. (No LLM, no second model — it reuses structure tree-sitter already parsed.)
The gain is corpus-dependent — it helps codebases with large classes and method-name ambiguity,
and is neutral elsewhere. Disable it per-repo with `{ "contextScope": false }` in `.gtir/config.json`.

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

**Headroom:** the shipped fixture is near-saturated (Recall@1 ≈ 0.92), which makes it a strong
*regression gate* but a weak *improvement meter* — a real retrieval gain has little room to show.
To measure gains, expand the corpus and add harder, more ambiguous queries, then re-`--save`.

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

## Migration from the MediaTraktor pipelines

- **Notes:** point gtir at the wiki with a `nomic-embed-text` config (`gtir init` does this automatically). **Retire `G:\mediaTraktor\tools\vault-index`** — gtir supersedes it (vault-index was cosine-only on a custom binary store; gtir adds BM25 + RRF, runs on Windows, and shares one tool with code search).
- **Code:** replace `tools\code-index` + `tools\code-mcp` with `gtir`. The embedding model changed (old `jina-v2-base-code` was 768-dim; this is ~896-dim), so run `gtir index --rebuild` once. tree-sitter chunking, LanceDB, and hybrid RRF search are carried over; the Python/torch/uv embed stack is gone.

## Known limitations

- **FTS index rebuilds fully on every upsert.** Correct, but O(corpus) per write — fine for solo-dev repos, noticeable on very large monorepos during incremental refresh. (Faithful to the original Python pipeline.)
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
