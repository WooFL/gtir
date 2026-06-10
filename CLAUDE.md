<!-- gtir:start -->
## Code navigation: prefer gtir's MCP tools

This repo has a gtir semantic+lexical code index available over MCP. For navigating code,
these usually beat raw Grep/Glob/Read:

- `mcp__gtir__context` — pull a full bundle for a symbol or query (definition + source span +
  callers/callees + siblings) in ONE call, instead of several Read/Grep round-trips.
- `mcp__gtir__search_code` — find code by meaning (a concept, or "where does X happen").
- `mcp__gtir__find_code` — jump to an exact symbol's definition and references.

For repos paired with an Obsidian wiki, `mcp__gtir__stale_check` flags notes whose cited code drifted.

Grep/Glob remain fine for exact string matches and file-name globs.
<!-- gtir:end -->
