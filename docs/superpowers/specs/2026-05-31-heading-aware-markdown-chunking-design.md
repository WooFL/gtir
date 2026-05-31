# Heading-aware markdown chunking — Design

**Date:** 2026-05-31
**Status:** Approved design, pre-implementation
**Repo:** gtir (G:\demon\gtir)

---

## Context

gtir chunks code with tree-sitter but falls back to a naive line-aware char-splitter
for markdown. The reason is structural: `tree-sitter-wasms` ships **no markdown
grammar** (verified — 36 grammars, none markdown), so `langFor(".md") = "markdown"`
points at a grammar that never loads and degrades to `chunkRecursive`.

This means markdown chunk *boundaries* regressed versus the retired `vault-index`
(which chunked by headings). Hybrid retrieval more than compensated (benchmarked notes
win: cosine→hybrid +11pp Recall@1), but the boundary quality is free headroom — and it
now matters more because the MCP `search_notes` tool returns these chunks directly to
Claude. A chunk that starts mid-sentence in an arbitrary char-window is a worse answer
than a clean heading-bounded section.

This adds a hand-written, fence-aware **heading-aware markdown chunker** that cuts on
heading boundaries and carries each section's **heading breadcrumb** + frontmatter
tags into the embedding (the contextual-retrieval principle applied to markdown
structure). Zero new dependencies.

---

## Goals / Non-Goals

**Goals**
- Chunk `.md`/`.mdx` on heading boundaries (sections), not char windows.
- Each section chunk's embed-text carries its full heading **breadcrumb**
  (`Title › Section › Subsection`) + frontmatter `tags`; the stored snippet stays the
  raw body.
- Correctly ignore `#` lines inside fenced code blocks.
- Extract frontmatter `title` (breadcrumb root) + `tags`/`aliases` (context); strip the
  raw YAML from the body.
- Zero new dependencies; reuse `chunkRecursive` for oversize-section splitting.
- Measurably validate the lift with the existing benchmark harness.

**Non-Goals**
- No markdown tree-sitter grammar dependency.
- No setext (`===`/`---` underline) headings in v1 — ATX (`#`) only (documented limitation).
- No change to code chunking, embedding, store, or search.
- No full YAML parser — a simple line-based frontmatter reader (`key: value`, inline/block lists for tags) suffices.

---

## Components & data shapes

### `src/markdown.mjs` (new)

```
chunkMarkdown(relPath, text, cfg) -> Chunk[]
```

Returns gtir's standard chunk objects plus a `prefix` field:

```js
{
  path, language: "markdown",
  chunkStart, chunkEnd,      // char offsets into the ORIGINAL text (incl. frontmatter)
  lineStart, lineEnd,        // 1-indexed lines in the original file
  text,                      // raw section body (heading line + content) — for snippets
  prefix,                    // precomputed embed-context string (see below)
}
```

Internal helpers (each pure, independently testable):
- `parseFrontmatter(text)` → `{ title, tags, aliases, bodyOffset, bodyLineOffset }`
  (or `bodyOffset:0` when no valid frontmatter).
- `scanHeadings(body)` → ordered `[{ level, title, lineIndex, charIndex }]`, fence-aware.
- `buildSections(body, headings)` → `[{ headingTitle|null, level, breadcrumbStack,
  startChar, endChar, startLine, endLine }]` (preamble has `headingTitle:null`).
- `sectionPrefix(relPath, breadcrumb, tags)` → the `prefix` string.

### Modifications
- `src/chunker.mjs::chunkFile` — when `langId === "markdown"`, return
  `chunkMarkdown(relPath, text, cfg)` (all other languages unchanged).
- `src/contextualize.mjs::contextualizeChunk` — honor a precomputed prefix:
  `const prefix = chunk.prefix ?? (cfg.contextTier === "claude-cli" ? claudeCliPrefix(chunk) : syntheticPrefix(chunk)); return { ...chunk, embedText: \`${prefix}\n${chunk.text}\` };`

---

## Algorithm

1. **Frontmatter.** If `text` starts with `---` on line 1 and a closing `---` line
   exists, parse the block: collect `key: value`; for `tags`/`aliases` accept inline
   `[a, b]` or block `- a` lists. Extract `title`, `tags`, `aliases`. Set `bodyOffset`
   to just after the closing `---` (track char + line offsets). Unclosed/garbage
   frontmatter → `bodyOffset = 0` (treat whole text as body).

2. **Scan headings (fence-aware).** Walk body lines. Maintain `inFence` toggled by a
   line whose trimmed start is ```` ``` ```` or `~~~` (info string allowed). When
   `!inFence`, a line matching `^(#{1,6})\s+(.+?)\s*#*\s*$` is a heading of `level =
   #-count`, `title = capture`. Record its char/line index. Headings inside a fence are
   ignored.

3. **Sections.** Each heading owns the span from its line to the next heading (any
   level). Lines before the first heading form a **preamble** section. For the
   breadcrumb, keep a stack: on a heading of level L, pop entries with level ≥ L, read
   the remaining stack as ancestors, then push this heading. `breadcrumb = [root,
   ...ancestorTitles, ownTitle]` where `root = frontmatter.title || basename(relPath)
   without extension`. Preamble breadcrumb = `[root]`.

4. **Emit chunks.** For each section:
   - `body = text.slice(startChar, endChar)` (raw, includes the heading line).
   - If `body.trim()` has no content beyond the heading line (heading-only section) →
     **skip** (its title remains in descendants' breadcrumbs).
   - `prefix = sectionPrefix(relPath, breadcrumb, tags)` →
     `"<relPath> › <breadcrumb.join(' › ')>"` + (tags.length ? `"  [tags: " + tags.join(", ") + "]"` : "").
   - If `body.length <= cfg.maxChars` → one chunk `{…, text: body.trim(), prefix}`.
   - If `body.length > cfg.maxChars` → split via `chunkRecursive(relPath, "markdown",
     body, cfg)`; offset each returned sub-chunk's char/line positions by the section's
     start; attach the SAME `prefix` to each.
   - Short (`< minChars`) content sections are **kept** (a headed, breadcrumbed section
     is a meaningful retrieval unit, not noise).

5. **No headings at all.** One preamble section spanning the whole body; same emit rule
   (split if oversize). Behaves like the old recursive path but with a breadcrumb prefix
   of just `[root]`.

---

## Error handling / edge cases

- **Unclosed code fence** → `inFence` stays true to EOF; trailing `#` lines are treated
  as code (no false headings). Acceptable.
- **Unclosed/garbage frontmatter** → not stripped; first `---` may then read as a setext
  HR/heading — but since v1 ignores setext, it's treated as body text. No crash.
- **Offsets** are always relative to the ORIGINAL text (frontmatter included) so
  `chunkStart`/`lineStart` map to the real file for citations.
- **Empty body** (frontmatter only, or blank file) → zero chunks.
- **`stableId`** (from chunker.mjs) is computed from `text` as for any chunk — unchanged.
- **maxEmbedChars** cap still applies downstream in `embed.mjs` (prefix + body truncated
  there if needed); no special handling here.

---

## Testing (hermetic, `node --test`)

`test/markdown.test.mjs`:
- `parseFrontmatter`: extracts `title` + inline and block `tags`; returns correct
  `bodyOffset`; unclosed `---` → no strip (`bodyOffset:0`).
- `scanHeadings`: finds ATX headings with correct levels/lines; a `#` line **inside a
  ```` ``` ```` fence is NOT detected**; `~~~` fences too.
- breadcrumb: `# A / ## B / ### C` yields C's breadcrumb `[root, A, B, C]`; a sibling
  `## D` after C pops back to `[root, A, D]`.
- `chunkMarkdown`: one chunk per content section; heading-only section skipped; a section
  > maxChars is split into multiple chunks sharing one prefix; no-heading doc → one chunk;
  preamble before first heading → its own chunk.
- `prefix` format: `"<path> › Title › Section"` and `"  [tags: …]"` when tags present;
  frontmatter `title` overrides filename as root.
- `chunkFile` routing: a `.md` input produces chunks whose `language === "markdown"` and
  that carry a `prefix` (i.e. went through `chunkMarkdown`, not the raw splitter).
- `contextualize`: a chunk WITH `prefix` → `embedText` starts with that prefix; a chunk
  WITHOUT `prefix` (code) → unchanged synthetic behavior.

---

## Validation (post-build, measured)

Rebuild the MediaTraktor wiki index with the new chunker into a scratch index dir, and
re-run the notes A/B from the benchmark harness: **old char-split notes index vs new
heading-aware notes index**, same `nomic-embed-text`, same known-item query set. Report
Recall@1/5/10 + MRR deltas. Because page-level Recall@5 was already saturated (100%),
also report a **chunk-level** signal: for each query, whether the returned top chunk is
from the correct section (the breadcrumb matches the target). This is the metric the
change is designed to move.

---

## Decisions log (from brainstorming)

| Decision | Choice |
|---|---|
| Heading detection | **Hand-written fence-aware line scanner** (no markdown tree-sitter grammar) |
| Heading context | **Full breadcrumb path** (`Title › Section › Sub`) prepended to embed-text |
| Frontmatter | **Extract `title` (breadcrumb root) + `tags`/`aliases` (context)**, strip raw YAML |
| Section sizing | One chunk per content section; split oversize via `chunkRecursive`; keep short; skip heading-only |
| Scope | ATX headings only (setext = documented v1 limitation); markdown-only; no pipeline changes |

---

## Open questions (for the implementation plan)
- Breadcrumb separator: ` › ` (U+203A) vs ` > ` — pick one in the plan (lean toward
  ` › ` for visual distinctness; confirm it survives the embed/snippet cleanly).
- Whether `tags` should also be appended to the snippet `text` (no — keep snippet raw;
  tags live only in `prefix`/embed-text).
