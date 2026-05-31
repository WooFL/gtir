# Structural code prefixes — Design

**Date:** 2026-05-31
**Status:** Approved design, pre-implementation
**Repo:** gtir (G:\demon\gtir)

---

## Context

Each chunk is embedded with a one-line **prefix** prepended, to restore the context the chunk lost
when it was sliced out of its file. Markdown chunks get a rich breadcrumb (`path › title ›
heading [tags]`). **Code chunks do not** — they fall back to `syntheticPrefix` =
`path — <first line>` (`contextualize.mjs:12-14`), which throws away the structural context
gtir already extracted with tree-sitter.

A method `apply(self, ctx)` is nearly meaningless out of context; the same method inside
`class RetryPolicy` vs `class CachePolicy` should retrieve differently. The AST already knows the
enclosing class/module and the symbol's own name — we just discard it. This gives code chunks the
same structural breadcrumb markdown chunks already get:

```
auth/jwt.ts › TokenService › verifyToken
```

This is the no-new-model form of contextual retrieval: pure structure, zero index-time cost, no
second model. (A future LLM-generated tier remains possible if eval shows structure isn't enough.)

---

## Goals / Non-Goals

**Goals**
- Give every AST code chunk a breadcrumb prefix: `relPath › <enclosing container names…> ›
  <own symbol name>`, derived from the tree-sitter nodes already in hand.
- Apply it to merged-sibling chunks and to oversize-leaf re-split chunks (which today carry no
  prefix at all).
- Measure the lift through `gtir eval`: add scope-sensitive queries where only the enclosing
  scope disambiguates the answer; record synthetic-baseline numbers, then the structural numbers.
- Zero new dependencies, no new model, no index-time network/LLM cost.

**Non-Goals**
- No LLM-generated prefixes (deferred).
- No change to markdown chunks (already have breadcrumbs) or to grammarless/recursive chunks
  (no AST → keep `syntheticPrefix`).
- No change to embedding, search, or storage logic. (Prefixes change `embedText`, so a one-time
  `gtir index --rebuild` re-embeds code chunks — expected.)

---

## Mechanism

All changes are in the AST chunker (`src/chunker.mjs`); `contextualizeChunk` already honors a
`chunk.prefix` when present (`contextualize.mjs:33`), so setting it routes through unchanged.

### Symbol-name extraction
```js
function nodeName(n) {
  const f = n.childForFieldName ? n.childForFieldName("name") : null;
  if (f && f.text) return f.text;
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (/identifier/.test(c.type)) return c.text;   // identifier / type_identifier / property_identifier
  }
  return null;
}
```

### Enclosing-scope breadcrumb
Walk `node.parent` to the root, collecting the names of ancestors whose type is a **container**:
```js
const CONTAINER_TYPES = new Set([
  "class_declaration", "abstract_class_declaration", "class_definition",
  "interface_declaration", "enum_declaration", "module_declaration",
  "internal_module", "namespace_declaration",
  "impl_item", "trait_item", "mod_item",
]);
function scopeBreadcrumb(node) {
  const parts = [];
  for (let p = node.parent; p; p = p.parent) {
    if (CONTAINER_TYPES.has(p.type)) {
      const nm = nodeName(p);
      if (nm) parts.unshift(nm);
    }
  }
  return parts;
}
```

### The prefix
```js
const SEP = " › ";   // same separator markdown uses
function codePrefix(relPath, node) {
  const own = nodeName(node);
  const tail = [...scopeBreadcrumb(node), ...(own ? [own] : [])];
  return tail.length ? `${relPath}${SEP}${tail.join(SEP)}` : null;  // null → fall back to syntheticPrefix
}
```
`codePrefix` returns `null` when no symbol/scope can be extracted (anonymous chunk); the chunker
then leaves `chunk.prefix` unset so `contextualizeChunk` falls back to `syntheticPrefix` (today's
behavior). The prefix is the **breadcrumb only** — it does NOT repeat the declaration line (that
is already in the chunk body), exactly like the markdown prefix.

### Wiring in `mergeSiblings`
- When a group is created, record its first node: `group.node = n`.
- In `flush`, set `prefix: codePrefix(relPath, group.node)` on the emitted chunk (omit the key
  when `codePrefix` returns null).
- In the oversize-leaf re-split branch, set `prefix: codePrefix(relPath, n)` on each sub-chunk
  (the leaf node `n` is in hand there).

For a merged group, the breadcrumb uses the first sibling's scope (siblings share the enclosing
container) and the first sibling's name — adequate; the body carries the rest.

---

## Components & integration

- **`src/chunker.mjs`** — add `nodeName`, `scopeBreadcrumb`, `codePrefix`, `CONTAINER_TYPES`, a
  local `SEP`. Store `group.node` in `mergeSiblings`; set `prefix` on merged-group chunks and on
  oversize-leaf sub-chunks. No signature changes (`mergeSiblings` already has `relPath`).
- **`src/contextualize.mjs`** — unchanged (already honors `chunk.prefix`).
- **`eval/corpus/`** — add scope-sensitive fixtures: files defining multiple small classes with
  similarly-named generic methods whose meaning comes from the class, not the body/path.
- **`eval/golden.json`** — add ~8 queries that reference the class/scope concept, answerable only
  by the right scoped method.
- **`eval/baseline.json`** — captured twice: first on the synthetic prefixes (the "before"), then
  re-saved on the structural prefixes (the "after"); the delta is the measured lift.
- **`README.md`** — note that code chunks now carry an AST breadcrumb prefix.

No change to `search`, `embed`, `store`, `indexer`, `markdown`, or config.

---

## Error handling / edge cases

- **No name / anonymous node**: `codePrefix` → null → `syntheticPrefix` fallback (no regression).
- **`childForFieldName` absent or returns null** (grammar variance): fall back to scanning named
  children for an `*identifier*` type; if none, null.
- **Grammarless / recursive-fallback chunks**: never reach `mergeSiblings`; keep `syntheticPrefix`.
- **Merged-sibling group**: breadcrumb from the first node; correct scope, representative name.
- **Deeply nested scopes** (class › nested class › method): all container ancestors are collected
  in order, so the full chain appears.
- **Prefix changes `embedText`** → `content_hash` changes → those chunks re-embed on the next
  `--rebuild` (one-time; the embedding cache covers subsequent rebuilds).

---

## Testing (hermetic, `node --test`)

Extend `test/chunker.test.mjs` (real parsers, offline):

- **Method inside a class** gets `relPath › ClassName › methodName`: a Python file with
  `class Repository:` + `def find(self, id)` yields a chunk whose `prefix` contains
  `Repository` and `find` and starts with the relPath.
- **Nested scope**: a class within a class (or a method within an impl) yields a breadcrumb with
  both container names in order.
- **Top-level function** (no container) gets `relPath › funcName` (no spurious scope).
- **Oversize-leaf sub-chunks carry the prefix**: reuse the oversize-leaf fixture with a small
  `maxChars`; every re-split window has `prefix` containing the function name.
- **Anonymous/grammarless fallback**: a `.wgsl` (grammarless) chunk has no AST breadcrumb →
  `contextualizeChunk` still produces a `syntheticPrefix` embedText (no crash, prefix unset).
- **`contextualizeChunk` uses the structural prefix**: a chunk with the new `prefix` yields
  `embedText === \`${prefix}\n${text}\`` (confirms wiring end-to-end).

Live A/B (documented, needs Ollama): on the scope-augmented corpus, `gtir eval` on the synthetic
baseline vs after the change — report the Recall/MRR/Sec-hit delta, especially on the scope-
sensitive queries.

---

## Decisions log

| Decision | Choice |
|---|---|
| Approach | Structural AST breadcrumb prefix — **no LLM, no second model** |
| Prefix content | `relPath › container chain › own symbol` (breadcrumb only, no declaration line) |
| Scope source | Walk `node.parent`, collect `CONTAINER_TYPES` ancestor names |
| Fallback | `codePrefix` → null → existing `syntheticPrefix` (anonymous / grammarless) |
| Markdown | Unchanged (already has breadcrumbs) |
| Measurement | Scope-sensitive eval queries; synthetic baseline vs structural, report the lift |
| Cost | One-time re-embed of code chunks on next `--rebuild`; no per-chunk LLM/network |
