# Content-hash Embedding Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip re-embedding chunks whose `embedText` is unchanged by reusing the prior index's embeddings (keyed by `sha256(embedText)`), for both `--rebuild` and `refresh`.

**Architecture:** Add a `content_hash` column to chunk rows. At `buildIndex` time, when the existing index used the same model and carries the column, load `{content_hash → embedding}` and reuse it for unchanged content, embedding only misses. `--rebuild` drops+recreates the chunks table (migrating the schema); `refresh` matches the existing schema. Reuses the store; zero new deps.

**Tech Stack:** Node ≥20 ESM, `node:test`, `node:crypto`. Modifies `src/embed.mjs`, `src/store.mjs`, `src/indexer.mjs`, `src/config.mjs`, `bin/gtir.mjs`.

**Spec:** `docs/superpowers/specs/2026-05-31-embedding-cache-design.md`.

---

## File Structure

```
src/embed.mjs      MODIFY — export contentHash(s) = sha256 hex
src/store.mjs      MODIFY — add hasContentHash(), loadEmbedCache(), dropChunks() to openStore's return
src/indexer.mjs    MODIFY — cache load + partition + reassemble; content_hash rows; rebuild drops table; reused/embedded counts
src/config.mjs     MODIFY — DEFAULTS.noCache = false
bin/gtir.mjs       MODIFY — --no-cache flag; thread to cfg.noCache; stderr shows (reused/embedded)
test/embed.test.mjs / test/store.test.mjs / test/indexer.test.mjs  MODIFY — tests
```

---

## Task 1: `contentHash` helper

**Files:**
- Modify: `gtir/src/embed.mjs`
- Test: `gtir/test/embed.test.mjs`

- [ ] **Step 1: Write the failing test (append to `test/embed.test.mjs`, reuse existing `test`/`assert` imports)**

```js
import { contentHash } from "../src/embed.mjs";

test("contentHash: stable sha256 hex; differs by input", () => {
  const a = contentHash("hello world");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(contentHash("hello world"), a);      // deterministic
  assert.notEqual(contentHash("hello world!"), a);  // input-sensitive
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/embed.test.mjs`
Expected: FAIL — `contentHash is not exported`.

- [ ] **Step 3: Implement in `src/embed.mjs`**

Add the import at the top (with the other imports, or as the first line if there are none — `embed.mjs` currently has no imports, so add it as line 1):

```js
import { createHash } from "node:crypto";
```

Add the export (e.g. at the end of the file):

```js
export function contentHash(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/embed.test.mjs` → PASS. Then full suite: `cd /g/demon/gtir && node --test`.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/embed.mjs test/embed.test.mjs && git commit -m "feat(gtir): contentHash(embedText) sha256 helper"
```

---

## Task 2: store helpers — `hasContentHash`, `loadEmbedCache`, `dropChunks`

**Files:**
- Modify: `gtir/src/store.mjs`
- Test: `gtir/test/store.test.mjs`

- [ ] **Step 1: Write the failing test (append to `test/store.test.mjs`, reuse its existing imports + the `openStore`/`mkdtempSync`/`join`/`tmpdir` already imported there)**

```js
function rowH(path, text, ch, vec = [0.1, 0.2, 0.3]) {
  return { id: `${path}:${text}`, path, language: "md", chunk_start: 0, chunk_end: text.length,
    line_start: 1, line_end: 1, text, mtime_ms: 1, embedding: vec, content_hash: ch };
}

test("hasContentHash: true when rows carry content_hash, false otherwise", async () => {
  const a = mkdtempSync(join(tmpdir(), "gtir-ch-"));
  const sa = await openStore({ indexDir: join(a, "i.lance") });
  assert.equal(await sa.hasContentHash(), false); // no table yet
  await sa.upsertRows([rowH("a.md", "alpha", "hash-a")]);
  assert.equal(await sa.hasContentHash(), true);
});

test("loadEmbedCache: returns {content_hash -> embedding}", async () => {
  const a = mkdtempSync(join(tmpdir(), "gtir-ch-"));
  const sa = await openStore({ indexDir: join(a, "i.lance") });
  await sa.upsertRows([rowH("a.md", "alpha", "h1", [1, 0, 0]), rowH("b.md", "beta", "h2", [0, 1, 0])]);
  const cache = await sa.loadEmbedCache();
  assert.equal(cache.size, 2);
  assert.deepEqual(Array.from(cache.get("h1")), [1, 0, 0]);
});

test("dropChunks: removes the chunks table", async () => {
  const a = mkdtempSync(join(tmpdir(), "gtir-ch-"));
  const sa = await openStore({ indexDir: join(a, "i.lance") });
  await sa.upsertRows([rowH("a.md", "alpha", "h1")]);
  assert.notEqual(await sa.chunksTable(), null);
  await sa.dropChunks();
  assert.equal(await sa.chunksTable(), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/store.test.mjs`
Expected: FAIL — `hasContentHash`/`loadEmbedCache`/`dropChunks` are not functions.

- [ ] **Step 3: Implement in `src/store.mjs`**

Add these three functions inside `openStore` (after `readMeta`, before the `return`):

```js
  async function hasContentHash() {
    const tbl = await chunksTable();
    if (!tbl) return false;
    try {
      const rows = await tbl.query().limit(1).toArray();
      return rows.length > 0 && Object.prototype.hasOwnProperty.call(rows[0], "content_hash");
    } catch { return false; }
  }

  async function loadEmbedCache() {
    const tbl = await chunksTable();
    if (!tbl) return new Map();
    let rows;
    try { rows = await tbl.query().select(["content_hash", "embedding"]).toArray(); }
    catch { return new Map(); } // table lacks the column
    const m = new Map();
    for (const r of rows) {
      if (r.content_hash && r.embedding) m.set(r.content_hash, Array.from(r.embedding));
    }
    return m;
  }

  async function dropChunks() {
    const names = await tableNames();
    if (names.includes("chunks")) await db.dropTable("chunks");
  }
```

Then add them to the returned object — change:

```js
  return { chunksTable, upsertRows, loadManifest, evictPaths, writeMeta, readMeta };
```

to:

```js
  return { chunksTable, upsertRows, loadManifest, evictPaths, writeMeta, readMeta, hasContentHash, loadEmbedCache, dropChunks };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /g/demon/gtir && node --test test/store.test.mjs` → PASS. Then full suite: `cd /g/demon/gtir && node --test`.

NOTE: if `tbl.query().limit(1)` is not supported by the installed `@lancedb/lancedb` 0.27.x, fall back to `(await tbl.query().toArray()).slice(0, 1)` — but try `.limit(1)` first (the codebase already uses `tbl.query().select(...).toArray()`, and `.limit()` is standard). Report if you had to change it.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/store.mjs test/store.test.mjs && git commit -m "feat(gtir): store helpers — hasContentHash, loadEmbedCache, dropChunks"
```

---

## Task 3: indexer cache integration

**Files:**
- Modify: `gtir/src/indexer.mjs`
- Test: `gtir/test/indexer.test.mjs`

Responsibility: load the cache, embed only misses, reassemble in order, write `content_hash`, drop the chunks table on rebuild (migrates schema), and report `reused`/`embedded`.

- [ ] **Step 1: Write the failing tests (append to `test/indexer.test.mjs`, reuse its existing imports — `loadConfig`, `buildIndex`, `mkdtempSync`, `writeFileSync`, `join`, `tmpdir`; add `openStore` if not already imported)**

```js
// A counting embedder: records how many texts it was asked to embed.
function counter() {
  const state = { calls: 0 };
  const fn = (texts) => {
    state.calls += texts.length;
    return Promise.resolve(texts.map((t) => { const n = (t.length % 5) + 1; const v = [n, n + 1, n + 2]; const L = Math.hypot(...v); return v.map((x) => x / L); }));
  };
  return { fn, state };
}
function repoWith(files) {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cache-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  return repo;
}
const CODE = "export function foo(input) {\n  // a body long enough to comfortably clear the 100-char minimum chunk size threshold here\n  return String(input).trim();\n}";

test("rebuild reuses cached embeddings: second build embeds 0", async () => {
  const repo = repoWith({ "a.ts": CODE, "b.ts": CODE.replace("foo", "bar") });
  const c1 = counter();
  const r1 = await buildIndex({ ...loadConfig(repo), embedImpl: c1.fn }, { rebuild: true });
  assert.ok(r1.embedded >= 2 && c1.state.calls === r1.embedded);
  const c2 = counter();
  const r2 = await buildIndex({ ...loadConfig(repo), embedImpl: c2.fn }, { rebuild: true });
  assert.equal(c2.state.calls, 0, "unchanged rebuild should embed nothing");
  assert.equal(r2.reused, r2.chunks);
  assert.equal(r2.embedded, 0);
});

test("model change ignores the cache (re-embeds all)", async () => {
  const repo = repoWith({ "a.ts": CODE });
  await buildIndex({ ...loadConfig(repo), embedImpl: counter().fn }, { rebuild: true });
  const c2 = counter();
  await buildIndex({ ...loadConfig(repo), model: "different-model", embedImpl: c2.fn }, { rebuild: true });
  assert.ok(c2.state.calls > 0, "model change must re-embed");
});

test("--no-cache (cfg.noCache) forces re-embed", async () => {
  const repo = repoWith({ "a.ts": CODE });
  await buildIndex({ ...loadConfig(repo), embedImpl: counter().fn }, { rebuild: true });
  const c2 = counter();
  await buildIndex({ ...loadConfig(repo), noCache: true, embedImpl: c2.fn }, { rebuild: true });
  assert.ok(c2.state.calls > 0, "noCache must re-embed");
});

test("refresh reuses unchanged sections within a changed file", async () => {
  const md = "# Page\n\n## A\nSection A body that is stable and long enough to be its own chunk here.\n\n## B\nSection B body original and also long enough to be a real chunk on its own.\n";
  const repo = repoWith({ "p.md": md });
  const cfg = { ...loadConfig(repo), embedImpl: counter().fn };
  await buildIndex(cfg, { rebuild: true }); // initial
  // Edit only section B; section A's chunk is byte-identical.
  writeFileSync(join(repo, "p.md"), md.replace("Section B body original", "Section B body EDITED"));
  const c2 = counter();
  const r = await buildIndex({ ...loadConfig(repo), embedImpl: c2.fn }, { rebuild: false });
  assert.ok(r.reused >= 1, "section A should be reused");
  assert.ok(r.embedded >= 1, "section B should be re-embedded");
  assert.equal(c2.state.calls, r.embedded);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /g/demon/gtir && node --test test/indexer.test.mjs`
Expected: FAIL — `r.reused`/`r.embedded` are `undefined` (cache logic not implemented).

- [ ] **Step 3: Implement in `src/indexer.mjs`**

Add `contentHash` to the embed import — change:

```js
import { embedTexts } from "./embed.mjs";
```

to:

```js
import { embedTexts, contentHash } from "./embed.mjs";
```

In the empty-chunks early return, add `reused`/`embedded` — change:

```js
    return { scanned: files.length, skipped, evicted, chunks: 0, dim: Number(meta.dim) || 0 };
```

to:

```js
    return { scanned: files.length, skipped, evicted, chunks: 0, dim: Number(meta.dim) || 0, reused: 0, embedded: 0 };
```

Replace the entire block from `// Contextualize, then embed.` (the `const ctx = []` line) through the final `return { ... }` with:

```js
  // Contextualize, then embed — reusing cached embeddings for unchanged content.
  const ctx = [];
  for (const c of allChunks) ctx.push(await contextualizeChunk(c, cfg));
  const hashes = ctx.map((c) => contentHash(c.embedText));

  // Load the cache BEFORE any eviction/drop: reuse the prior index's embeddings when the
  // model matches and the existing table carries content_hash.
  const tableHasHash = await store.hasContentHash();
  const useCache = !cfg.noCache && tableHasHash && (await store.readMeta()).model === cfg.model;
  const cache = useCache ? await store.loadEmbedCache() : new Map();

  const missIdx = [];
  for (let i = 0; i < hashes.length; i++) if (!cache.has(hashes[i])) missIdx.push(i);
  const missVecs = missIdx.length ? await embed(missIdx.map((i) => ctx[i].embedText)) : [];
  const vecs = new Array(ctx.length);
  for (let i = 0; i < ctx.length; i++) vecs[i] = cache.get(hashes[i]) ?? null;
  missIdx.forEach((i, k) => { vecs[i] = missVecs[k]; });
  const reused = ctx.length - missIdx.length;
  const embedded = missIdx.length;
  const dim = (vecs.find((v) => v) ?? []).length;

  // Replace prior rows. Rebuild drops+recreates the table (also migrates the schema to
  // include content_hash); refresh deletes the changed paths' rows.
  const changedPaths = [...new Set(toIndex.map((f) => f.relPath))];
  if (rebuild) await store.dropChunks();
  else if (changedPaths.length) await store.evictPaths(changedPaths);

  const writeHash = rebuild || tableHasHash; // rebuild recreates with the column; refresh matches existing schema
  const rows = allChunks.map((c, i) => ({
    id: stableId(c), path: c.path, language: c.language,
    chunk_start: c.chunkStart, chunk_end: c.chunkEnd,
    line_start: c.lineStart, line_end: c.lineEnd,
    text: c.text, mtime_ms: c.mtimeMs, embedding: vecs[i],
    ...(writeHash ? { content_hash: hashes[i] } : {}),
  }));
  await store.upsertRows(rows);
  await store.writeMeta({ model: cfg.model, dim, version: cfg.version });

  return { scanned: files.length, skipped, evicted, chunks: rows.length, dim, reused, embedded };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /g/demon/gtir && node --test test/indexer.test.mjs` → PASS (4 new + existing).
Then full suite: `cd /g/demon/gtir && node --test` (all green — confirms the `--rebuild` drop-and-recreate didn't break the existing indexer/cli/mcp tests).

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/indexer.mjs test/indexer.test.mjs && git commit -m "feat(gtir): reuse cached embeddings by content_hash (rebuild + refresh)"
```

---

## Task 4: CLI wiring — `--no-cache` flag + reuse stats

**Files:**
- Modify: `gtir/src/config.mjs`
- Modify: `gtir/bin/gtir.mjs`
- Test: `gtir/test/config.test.mjs`

- [ ] **Step 1: Write the failing test (append to `test/config.test.mjs`, reuse its existing `loadConfig`/`DEFAULTS`/`test`/`assert` imports)**

```js
test("DEFAULTS.noCache is false (cache on by default)", () => {
  assert.equal(DEFAULTS.noCache, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /g/demon/gtir && node --test test/config.test.mjs`
Expected: FAIL — `DEFAULTS.noCache` is `undefined`.

- [ ] **Step 3: Implement**

In `src/config.mjs`, add to the `DEFAULTS` object (next to `embedBatch`/`maxEmbedChars`):

```js
  noCache: false,                // set by `--no-cache` to force a full re-embed
```

In `bin/gtir.mjs`:

(a) thread `noCache` through `runIndex` — change:

```js
export async function runIndex({ repo, rebuild = false, embedImpl = null } = {}) {
  const cfg = loadConfig(repo);
  if (embedImpl) cfg.embedImpl = embedImpl;
  return buildIndex(cfg, { rebuild });
}
```

to:

```js
export async function runIndex({ repo, rebuild = false, embedImpl = null, noCache = false } = {}) {
  const cfg = loadConfig(repo);
  if (embedImpl) cfg.embedImpl = embedImpl;
  if (noCache) cfg.noCache = true;
  return buildIndex(cfg, { rebuild });
}
```

(b) parse the flag — in `parseArgs`, add (next to `--rebuild`):

```js
    else if (a === "--no-cache") args.noCache = true;
```

(c) the `index` case — change:

```js
      case "index": {
        const r = await runIndex({ repo, rebuild: !!args.rebuild });
        process.stderr.write(`gtir: indexed ${r.chunks} chunks (${r.skipped} skipped, ${r.evicted} evicted), dim=${r.dim}\n`);
        break;
      }
```

to:

```js
      case "index": {
        const r = await runIndex({ repo, rebuild: !!args.rebuild, noCache: !!args.noCache });
        process.stderr.write(`gtir: indexed ${r.chunks} chunks (${r.reused ?? 0} reused, ${r.embedded ?? 0} embedded, ${r.skipped} skipped, ${r.evicted} evicted), dim=${r.dim}\n`);
        break;
      }
```

(d) the `refresh` case — change:

```js
      case "refresh": {
        const r = await runIndex({ repo, rebuild: false });
        process.stderr.write(`gtir: refresh — ${r.chunks} chunks updated (${r.skipped} skipped, ${r.evicted} evicted)\n`);
        break;
      }
```

to:

```js
      case "refresh": {
        const r = await runIndex({ repo, rebuild: false, noCache: !!args.noCache });
        process.stderr.write(`gtir: refresh — ${r.chunks} chunks updated (${r.reused ?? 0} reused, ${r.embedded ?? 0} embedded, ${r.skipped} skipped, ${r.evicted} evicted)\n`);
        break;
      }
```

(e) usage string — add `[--no-cache]` to the `index|refresh` options in the `default:` usage line (insert it after `[--rebuild]`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /g/demon/gtir && node --test test/config.test.mjs` → PASS.
Then full suite: `cd /g/demon/gtir && node --test`.
Also smoke the flag parse: `cd /g/demon/gtir && node bin/gtir.mjs` (no args) prints usage including `--no-cache`.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/config.mjs bin/gtir.mjs test/config.test.mjs && git commit -m "feat(gtir): --no-cache flag + reuse/embedded stats in index/refresh output"
```

---

## Task 5: live smoke + README

**Files:**
- Modify: `gtir/README.md`

- [ ] **Step 1: Live smoke (real Ollama) — prove the cache reuses on a real rebuild**

Run against the real wiki index:

```bash
# First rebuild establishes content_hash (re-embeds all once):
gtir index --rebuild --repo G:/mediaTraktor/wiki
# Second rebuild with identical content should reuse ~everything (near-instant, 0 embedded):
gtir index --rebuild --repo G:/mediaTraktor/wiki
```

Expected: the second line reports `(… reused, 0 embedded, …)` (or a small embedded count) and finishes much faster than the first. Note the reused/embedded counts.

- [ ] **Step 2: Update `README.md`**

In the "How it works" section, after the `→ embed via Ollama …` line, add:

```
  → embedding cache: unchanged chunks (by content hash) reuse the prior index's vectors
```

And under "Use", add a line documenting the flag (after the `gtir refresh` line):

```
gtir index   --repo <project> --rebuild --no-cache   # force a full re-embed (ignore the cache)
```

- [ ] **Step 3: Commit**

```bash
cd /g/demon/gtir && git add README.md && git commit -m "docs(gtir): note the content-hash embedding cache + --no-cache"
```

---

## Self-Review (against the spec)

**Spec coverage:**
- `content_hash` column = `sha256(embedText)` → Task 1 (`contentHash`), Task 3 (rows include it). ✅
- Cache load when table has column + model matches → Task 3 (`tableHasHash`, `useCache`, `loadEmbedCache`). ✅
- Embed only misses, reassemble in order → Task 3 (`missIdx`/`missVecs`/`vecs`). ✅
- Helps rebuild AND refresh → Task 3 (cache loaded before drop/evict, both paths). ✅
- Model safety (meta.model guard) → Task 3 (`useCache`). ✅
- Backward-compat: pre-feature index → `hasContentHash()` false → legacy; rebuild migrates by dropping the table → Task 2 (`dropChunks`), Task 3 (`if (rebuild) dropChunks`, `writeHash`). ✅
- `--no-cache` → Task 4 (flag + `cfg.noCache`), Task 3 (`!cfg.noCache`). ✅
- Reuse stats reported → Task 3 (`reused`/`embedded`), Task 4 (stderr). ✅
- `contentHash` lives in `embed.mjs` (resolved open question) → Task 1. ✅
- store helpers (`hasContentHash`, `loadEmbedCache`, `dropChunks`) → Task 2. ✅
- Testing (counting embedder; rebuild-reuse, edit, model-change, no-cache, prefix-sensitivity via the markdown refresh test, pre-feature safety via store tests) → Task 2 + Task 3. ✅

**Placeholder scan:** No TBD/vague steps; every code step is complete. The `.limit(1)` API note in Task 2 includes a concrete fallback (not a placeholder).

**Type/name consistency:** `contentHash` (embed.mjs) used in indexer.mjs. Store methods `hasContentHash`/`loadEmbedCache`/`dropChunks` defined in Task 2, called in Task 3. Row field `content_hash` consistent (rows in Task 3, store read in Task 2, schema via `upsertRows`). `buildIndex` return now includes `reused`/`embedded` (Task 3 both return paths) consumed by `bin/gtir.mjs` (Task 4, with `?? 0` guards). `cfg.noCache` set in `runIndex` (Task 4) and read in `buildIndex` (Task 3). `DEFAULTS.noCache` (Task 4) keeps `cfg.noCache` defined.
```
