# Oversize-leaf re-split — Design

**Date:** 2026-05-31
**Status:** Approved design, pre-implementation
**Repo:** gtir (G:\demon\gtir)

---

## Context

gtir's AST chunker (`src/chunker.mjs`) collects target nodes (functions, classes, …) and runs a
cAST sibling-merge. A node whose byte span exceeds `cfg.maxChars` (2000) is **dropped** outright
(`mergeSiblings`, `chunker.mjs:101` — `if (span > cfg.maxChars) { flush(); continue; }`).

For a **container** (class/impl/mod) that is fine: its members were collected as their own nodes
and surface separately. But for an oversize **leaf** — a single function/struct larger than
`maxChars` with no nested target nodes — the content is **silently lost** from the index. That is
a recall hole (data loss), documented as a "Known limitation" in the README.

The markdown chunker already solves the analogous problem: an oversize section is re-split via
`chunkRecursive` and its coordinates are offset back to the file (`markdown.mjs:103-116`). This
ports that proven pattern into the AST chunker, **guarded so only true leaves are re-split**.

---

## Goals / Non-Goals

**Goals**
- Stop dropping oversize **leaf** nodes: re-split them into line-aware windows via the existing
  `chunkRecursive`, with coordinates translated back to the original file.
- Preserve today's behavior for oversize **containers** (drop the container; members surface) —
  no duplicate/overlapping chunks.
- Demonstrate the fix through `gtir eval`: a fixture whose answer lives inside an oversize leaf
  misses before and hits after.
- Zero new config, no new dependencies, no change to embedding/search/markdown.

**Non-Goals**
- No change to the markdown chunker (already handles oversize sections).
- No re-splitting of containers, no recursive cAST on the sub-windows (line-window fallback is
  sufficient and matches the existing recursive path).
- No new chunk fields; sub-chunks look like every other AST chunk.

---

## Mechanism

In `mergeSiblings` (`src/chunker.mjs`), replace the unconditional drop of an oversize node with a
leaf-vs-container decision:

```
for each node n (source order):
  span = n.endIndex - n.startIndex
  if span > cfg.maxChars:
    flush()                      // close any pending merge group first
    if isLeaf(n, nodes):         // no other collected node nested inside n's span
      for sub in chunkRecursive(text.slice(n.startIndex, n.endIndex), langId, cfg):
        emit translate(sub, n)   // offset coords back to the file
    // else: container — drop it; its members surface as their own nodes (unchanged)
    continue
  ... (existing merge logic unchanged) ...
```

### `isLeaf(n, nodes)`
`n` is a leaf iff **no other collected node is nested inside its span**:
```js
!nodes.some((m) => m !== n && m.startIndex >= n.startIndex && m.endIndex <= n.endIndex)
```
A container (class/impl/mod with collected method children) fails this test → it is dropped exactly
as today, and its members surface separately. This precisely matches the documented limitation
("an oversize *leaf* node … with no nested target nodes").

### Coordinate translation (identical math to `markdown.mjs:106-115`)
`chunkRecursive` is called on the node's slice, so its positions are slice-relative:
- byte: `chunkStart += n.startIndex`, `chunkEnd += n.startIndex`
- line: `lineStart += n.startPosition.row`, `lineEnd += n.startPosition.row`
  (`startPosition.row` is 0-based; slice line 1 is file line `row + 1`, so add `row`).
`language` stays `langId`. No `prefix` field is added (AST chunks never carry one — the code prefix
is built later by `contextualize.mjs`). `text` is the sub-window body as `chunkRecursive` produced
it.

### Why ordering stays correct
Nodes are processed in source order and the pending group is flushed before the oversize node's
sub-chunks are appended, so emitted chunks remain in source order.

---

## Components & integration

- **`src/chunker.mjs`** — `mergeSiblings`: add the `isLeaf` helper (module-private) and the
  re-split branch. `chunkRecursive` is already in this file. No signature changes; `mergeSiblings`
  already receives `text`, `langId`, `relPath`, `cfg`.
- **`eval/corpus/`** — add one fixture with a single oversize leaf function (> `maxChars`, no
  nested target nodes) whose body contains a distinctive, deep passage.
- **`eval/golden.json`** — add a query whose answer is that deep passage (page + `lines`).
- **`eval/baseline.json`** — re-saved after the fix (the new query goes from miss to hit; counts
  `n`/`n_sec` grow by one).
- **`README.md`** — update the "Known limitations" bullet: oversize *leaves* are now re-split;
  only oversize containers still rely on member surfacing (which loses nothing).

No change to `search`, `embed`, `store`, `indexer`, `markdown`, or config.

---

## Error handling / edge cases

- **Container with nested targets**: `isLeaf` false → dropped as today; members surface. No
  duplication.
- **Leaf that is one giant line > maxChars** (e.g. minified): `chunkRecursive` emits it as a
  single chunk that may exceed `maxChars` (existing recursive-fallback behavior); the downstream
  `maxEmbedChars` cap still applies at embed time. Strictly better than dropping.
- **Re-split yields nothing** (only possible if the whole slice trims below `minChars`, which
  cannot happen for a span > `maxChars` > `minChars`): no chunks appended; node simply absent, as
  before. No crash.
- **Tiny trailing window < minChars**: dropped by `chunkRecursive`'s existing `minChars` guard —
  acceptable (overlap carries context).
- **Node at file start** (`startPosition.row === 0`): offset adds 0 → file lines equal slice
  lines. Correct.

---

## Testing (hermetic, `node --test`)

Unit tests in `test/chunker.test.mjs` (extend the existing file; use a fake/lowered `cfg.maxChars`
so fixtures stay small):

- **Oversize leaf is re-split**: a single function whose span > `maxChars` (no nested targets)
  produces ≥ 2 chunks; their concatenated coverage spans the function; `lineStart`/`lineEnd` are
  **file-relative** (a function starting at file line L yields a first sub-chunk with
  `lineStart >= L`, not 1).
- **Oversize container is NOT re-split**: a class > `maxChars` containing two method nodes (each a
  target type) emits the method chunks once each and **no** chunk that spans the whole class — i.e.
  no overlapping/duplicate span covering the methods.
- **Coordinate offset correctness**: for an oversize leaf not at file start, `chunkStart` equals
  `n.startIndex + sub.chunkStart` (byte offset translated), verified via the chunk's `text` being
  found at `chunkStart` in the source.
- **No regression**: a normal (under-`maxChars`) function still yields exactly one chunk; the full
  suite stays green.

Live demonstration (documented, not in the hermetic suite): `gtir eval --repo eval/corpus
--golden eval/golden.json --baseline eval/baseline.json` — the new oversize-leaf query misses on
the pre-fix index and hits post-fix; re-`--save` the baseline.

---

## Decisions log (from brainstorming)

| Decision | Choice |
|---|---|
| Re-split method | Reuse `chunkRecursive` on the node slice (same as markdown's oversize path) |
| Leaf vs container | Re-split only leaves; detect via "no other collected node nested in span" |
| Container behavior | Unchanged — dropped; members surface separately (no duplication) |
| Coordinate translation | Offset byte by `n.startIndex`, line by `n.startPosition.row` |
| Sub-chunk fields | Same shape as other AST chunks; no `prefix` |
| Demonstration | Add an oversize-leaf fixture + golden query; re-save baseline |
| Scope | AST chunker only; markdown already handles oversize sections |
