# gtir MCP server — Design

**Date:** 2026-05-31
**Status:** Approved design, pre-implementation
**Repo:** gtir (G:\demon\gtir)

---

## Context

gtir is a CLI. To use it inside a Claude session today you shell out via Bash
(`gtir search ...`). The retired MediaTraktor pipeline exposed retrieval as
**MCP tools** (`code-mcp`/`vault-mcp`) that Claude could call natively — the one
real ergonomic regression when we replaced those pipelines with gtir.

This adds a stdio **MCP server** (`gtir mcp`) that exposes gtir's *existing*
search as native tools, restoring in-session ergonomics. It is **pure plumbing
around already-tested logic** — it introduces no new retrieval behavior and no
new runtime dependencies.

---

## Goals / Non-Goals

**Goals**
- `gtir mcp --repo <a> --repo <b>` starts a stdio MCP server serving those indexes.
- Expose **named per-index search tools** (`search_code`, `search_notes`, …) plus a
  `gtir_status` tool. No merging across indexes (matches the standing "no shim" decision).
- Auto-label tools from each index's config; allow `--label` override.
- Zero new dependencies; hand-rolled JSON-RPC modeled on the retired `code-mcp/server.mjs`.
- Core dispatch is dependency-injected so it is hermetically testable without Ollama.

**Non-Goals**
- No cross-index merge/fan-out tool.
- No new retrieval logic (no rerank, no symbol/outline, no query expansion — those are
  separate future improvements).
- No auto-discovery of indexes under a root (explicit `--repo` only).
- Not using the official `@modelcontextprotocol/sdk` (keep gtir's lean footprint).

---

## Invocation & configuration

```
gtir mcp --repo <repo> [--repo <repo> ...] [--label <name>:<repo> ...] [--print-config]
```

- **`--repo <path>`** (repeatable): an indexed repo/vault to serve.
- **`--label <name>:<path>`** (repeatable): force the tool label for that repo
  (overrides auto-detection; required to disambiguate collisions).
- **`--print-config`**: print a paste-ready `.mcp.json` snippet and exit (no server).

**Label derivation** (per `--repo`, in order):
1. An explicit `--label name:<repo>` for that path wins.
2. Else from `loadConfig(repo).model`: `/nomic/i` → `notes`; `/jina.*code/i` → `code`.
3. Else the repo's basename, sanitized to `[a-z0-9_]+` (lowercased, runs of other
   chars → `_`).

Labels are sanitized to valid MCP tool-name characters. If two resolved labels
**collide**, startup aborts with: `two indexes resolved to '<label>' — disambiguate
with --label <name>:<repo>` (exit 2). The server does not silently rename.

**`--print-config` output** (uses `node` + absolute path for env robustness, like the
git hooks):
```json
"gtir": {
  "type": "stdio",
  "command": "node",
  "args": ["<abs path to gtir>/bin/gtir.mjs", "mcp", "--repo", "<repoA>", "--repo", "<repoB>"]
}
```

---

## Tools exposed

### `search_<label>` (one per served index)
- **Description:** `Hybrid semantic + lexical (vector + BM25 + RRF) search over the
  <label> index at <repo>. Returns ranked chunks.`
- **inputSchema:** `{ query: string (required), k: integer (default 8, 1..50),
  path_prefix: string (optional), language: string (optional) }`
- **Behavior:** calls the existing `search(query, cfg, { k, pathPrefix, language })`.
- **Result:** MCP `content: [{ type: "text", text: <markdown> }]` **and**
  `structuredContent: { results: [...] }` where each result is
  `{ path, lines, language, score, vec_rank, fts_rank, snippet }` (the proven
  code-mcp shape). Markdown rendering mirrors code-mcp:
  `### <path>:<lines>  _(rrf=<score> · <branch>)_` + a fenced snippet.

### `gtir_status` (one, global)
- **Description:** `List the indexes this gtir MCP server serves, with model, dim,
  file/chunk count, and last-built time.`
- **inputSchema:** `{}` (no args)
- **Result:** JSON (text + structuredContent) — array of
  `{ label, repo, model, dim, files, built_at, age_minutes, healthy }` from each
  index's `readMeta()` + `loadManifest()`. `healthy: false` (with a `note`) if an
  index has no built table.

---

## Architecture & components

```
bin/gtir.mjs  (mcp subcommand)
   ├─ parse --repo* / --label* / --print-config
   ├─ resolveIndexes(args) -> [{ label, repo, cfg }]   (label derivation + collision check)
   ├─ --print-config? print snippet, exit
   └─ serveStdio(indexes)                               (src/mcp.mjs)

src/mcp.mjs
   ├─ resolveIndexes(repos, labelOverrides)   [pure, tested]
   ├─ deriveLabel(repo, cfg, override)         [pure, tested]
   ├─ sanitizeLabel(s)                         [pure, tested]
   ├─ buildTools(indexes)  -> MCP tools/list payload   [pure, tested]
   ├─ handleRequest(msg, { indexes, searchFn, statusFn })  [pure-ish, INJECTED deps, tested]
   │     handles: initialize | notifications/initialized | tools/list | tools/call
   └─ serveStdio(indexes)  [thin shell: newline-delimited JSON-RPC over stdin/stdout;
                            wires real searchFn = (label,args)=>search(...) with a
                            per-index store/embed cache, and statusFn = readMeta+manifest]
```

**Dependency injection is the key testability decision.** `handleRequest` takes
`searchFn` and `statusFn`, so unit tests drive the full JSON-RPC protocol with a fake
`searchFn` — no Ollama, no LanceDB. The stdio shell and the real `search()` wiring are
the only un-injected parts, covered by a documented live smoke test.

**Store caching:** `serveStdio` opens each index's store once (LanceDB connection +
`chunksTable`) and reuses it across queries (mirrors code-mcp's table cache). Query
embedding goes through Ollama per call (model stays warm).

**Reuses (no new logic):** `search()` (search.mjs), `openStore`/`readMeta`/
`loadManifest` (store.mjs), `loadConfig` (config.mjs). Transport pattern modeled on
the retired `code-mcp/server.mjs`.

---

## Protocol (hand-rolled stdio JSON-RPC 2.0)

Newline-delimited JSON over stdin/stdout. Methods handled:
- **`initialize`** → `{ protocolVersion: "2024-11-05", capabilities: { tools: {} },
  serverInfo: { name: "gtir", version: <pkg version> } }`
- **`notifications/initialized`** → ignored (no response).
- **`tools/list`** → `buildTools(indexes)`.
- **`tools/call`** → dispatch by tool name to `searchFn`/`statusFn`; unknown name →
  error result.
- Unknown method → JSON-RPC error `-32601` (method not found).
- Malformed/unparseable line → skipped (no crash), mirroring the proven driver.

---

## Error handling

All tool-level failures return a graceful MCP result with `isError: true` and a
`text` explanation — the server never crashes on a bad call:
- **Index has no built table** → `no index at <repo> — run: gtir index --repo <repo>`.
- **Ollama unreachable / model missing** → the remediation message thrown by `embed`
  ("Is Ollama running and the model pulled? Run: gtir setup").
- **FTS index missing** → already handled inside `search()` (degrades to vector-only
  with a stderr note); no special handling here.
- **Unknown tool / label** → `unknown tool: <name>`.
- **Startup label collision** → abort with exit 2 and a `--label` hint (this is the one
  fatal case — it's a misconfiguration, surfaced before the server accepts traffic).

---

## Testing

**Unit (hermetic, `node --test`):**
- `sanitizeLabel`: spaces/punctuation → `_`, lowercased; already-valid passes through.
- `deriveLabel`: nomic model → `notes`; jina-code model → `code`; override wins;
  unknown model → sanitized basename.
- `resolveIndexes`: builds `{label, repo, cfg}` list; detects collisions; applies overrides.
- `buildTools`: emits one `search_<label>` per index + `gtir_status`, with correct
  inputSchemas.
- `handleRequest` with an **injected fake `searchFn`/`statusFn`**:
  - `initialize` → correct serverInfo + capabilities.
  - `tools/list` → expected tool set.
  - `tools/call search_<label>` → calls searchFn with parsed args; wraps results into
    `content` + `structuredContent`.
  - `tools/call gtir_status` → calls statusFn; wraps result.
  - unknown tool → `isError` result.
  - unknown method → JSON-RPC `-32601`.

**Live smoke (documented, not in the hermetic suite):** spawn
`node bin/gtir.mjs mcp --repo <wiki> --repo <code>`, send initialize + tools/list +
a `search_notes`/`search_code` call over stdio, assert real ranked results — the exact
stdio-driver pattern already written for the A/B benchmark.

---

## Decisions log (from brainstorming)

| Decision | Choice |
|---|---|
| Multi-index model | One server, **named per-index tools** (`search_code`/`search_notes`), no merging |
| Configuration | **Paths + auto-label** from each index's model; `--label` override; collisions abort |
| v1 tool surface | **Search + `gtir_status`** (no symbol/outline/HyDE in v1) |
| Protocol impl | **Hand-rolled stdio JSON-RPC**, zero deps, modeled on code-mcp |
| Testability | **Dependency-injected `handleRequest`** (fake searchFn) + live smoke |

---

## Open questions (for the implementation plan)
- Exact `serverInfo.version` source (read `package.json` version at startup vs hardcode).
- Whether `--print-config` should also be offered automatically by `gtir init` (deferred;
  not in this spec's scope).
