# gtir

**gtir** (Armenian *գտնել*, "to find") — a portable, install-once CLI for semantic code retrieval over any repository. It chunks code with tree-sitter (AST-aware, with a cAST sibling-merge refinement), embeds chunks via a local **Ollama** model (`jina-code-embeddings-0.5b`), stores vectors + a BM25 index in **LanceDB**, and answers queries with hybrid (vector + BM25 + RRF) search.

**Scope:** code only. Wiki/notes retrieval is intentionally *not* here — that stays with [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian)'s `wiki-retrieve`. gtir is the code half of a two-store setup: both are reached from the same Claude session (notes via `wiki-query`, code via `gtir search`).

## How it works

```
walk repo (.gitignore-aware)
  → tree-sitter AST chunks (+ cAST sibling-merge; recursive fallback for grammarless files)
  → contextual prefix per chunk (synthetic by default; opt-in claude-cli tier)
  → embed via Ollama /api/embed  (jina-code-embeddings-0.5b)
  → LanceDB upsert (vectors + BM25 FTS)
search: query → embed → vector branch + BM25 branch → Reciprocal Rank Fusion (k=60)
```

Everything runs through **one runtime — Ollama** (the same daemon that serves `nomic-embed-text` for your notes). No Python, no sentence-transformers, no torch.

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
gtir index   --repo <project> [--rebuild]              # build / full rebuild
gtir refresh --repo <project>                          # incremental (changed files only)
gtir search  "how are sessions created" --repo <project> [-k 8] [--language python] [--path-prefix src/]
gtir status  --repo <project>                          # model, dim, file count
gtir hook    --repo <project> [--remove]               # install/remove post-commit auto-refresh
```

- `search` prints JSON to **stdout** (pipe to `jq`); all human-readable logs go to stderr.
- The index lives in `<project>/.gtir/` — regenerable, add it to `.gitignore`.
- `gtir hook` installs a git `post-commit` hook so the index refreshes itself as you commit; it's idempotent and preserves any existing hook.

## Model

Default model tag (in `src/config.mjs`): `hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16` (994 MB, ~896-dim).

- **Smaller/faster:** override with a lower quant in `<project>/.gtir/config.json`, e.g. `{ "model": "hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:Q8_0" }` (531 MB) or `:IQ4_XS` (349 MB), then `gtir index --rebuild`.
- **Max recall:** use the 1.5B sibling — `hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:<quant>`.
- Changing the model changes the embedding dimension, so a full `gtir index --rebuild` is required (the old vectors are incompatible).

## Migration from the MediaTraktor pipelines

- **Notes:** provision claude-obsidian retrieval per vault (`bash bin/setup-retrieve.sh`). **Retire `G:\mediaTraktor\tools\vault-index`** — `wiki-retrieve` supersedes it (it was cosine-only on a custom binary store; `wiki-retrieve` adds contextual-prefix + BM25 + rerank).
- **Code:** replace `tools\code-index` + `tools\code-mcp` with `gtir`. The embedding model changed (old `jina-v2-base-code` was 768-dim; this is ~896-dim), so run `gtir index --rebuild` once. tree-sitter chunking, LanceDB, and hybrid RRF search are carried over; the Python/torch/uv embed stack is gone.

## Known limitations

- **FTS index rebuilds fully on every upsert.** Correct, but O(corpus) per write — fine for solo-dev repos, noticeable on very large monorepos during incremental refresh. (Faithful to the original Python pipeline.)
- **Oversize *leaf* nodes are dropped, not re-split.** A single function/struct larger than `maxChars` (2000 by default) with no nested target nodes is skipped. Container types (class/impl/mod) lose nothing — their members are indexed as their own chunks. Lower `maxChars` or rely on the recursive fallback for files with no AST targets.
- **No automatic dimension-skew guard at query time.** `meta` records the model + dim; if you switch models, rebuild. (`gtir status` shows the recorded dim.)

## Development

```bash
npm test        # node --test — full suite, hermetic (embedder is injected; no Ollama needed)
```

Tests never hit the network: the Ollama client and embedder are injectable (`cfg.fetchImpl` / `cfg.embedImpl`), so unit and integration tests run offline against a fake embedder.
