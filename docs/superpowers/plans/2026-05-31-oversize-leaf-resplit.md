# Oversize-leaf re-split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silently dropping oversize *leaf* AST nodes — re-split them into line-aware windows (coordinates translated back to the file) while leaving oversize *containers* unchanged.

**Architecture:** In `mergeSiblings` (`src/chunker.mjs`), replace the unconditional drop of an oversize node with a leaf-vs-container check: a true leaf (no other collected node nested in its span) is re-split via the existing `chunkRecursive`; a container is dropped as today (its members surface separately). Same coordinate-offset math the markdown chunker already uses for oversize sections.

**Tech Stack:** Node ESM, `node:test`, web-tree-sitter (real parsers, offline). No new deps.

**Spec:** `docs/superpowers/specs/2026-05-31-oversize-leaf-resplit-design.md`

---

## File Structure

- **Modify `src/chunker.mjs`** — add module-private `isLeaf(n, nodes)`; replace the oversize-node drop in `mergeSiblings` with the re-split branch. `chunkRecursive` is already in this file and in scope.
- **Modify `test/chunker.test.mjs`** — add tests: leaf re-split, container not re-split, coordinate offset, no-regression.
- **Add `eval/corpus/data/aggregate_report.py`** — a fixture with one oversize leaf function (no nested targets) holding a distinctive deep passage.
- **Modify `eval/golden.json`** — add a query whose answer is that deep passage.
- **Regenerate `eval/baseline.json`** — re-save after the fix (live, needs Ollama).
- **Modify `README.md`** — update the "Known limitations" bullet.

---

### Task 1: Re-split oversize leaf nodes in `mergeSiblings`

**Files:**
- Modify: `G:\demon\gtir\src\chunker.mjs` (`mergeSiblings`, around line 94-109)
- Modify: `G:\demon\gtir\test\chunker.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/chunker.test.mjs` (it already imports `chunkFile` and `chunkRecursive` from `../src/chunker.mjs`, plus `test`/`assert`). These use a small `maxChars` so fixtures stay tiny. Python target types are `class_definition` + `function_definition`.

```js
// --- Oversize-leaf re-split (recall hole fix) ---

// A top-level function with NO nested def, whose span exceeds maxChars, must be
// re-split into windows (not dropped). Starts at file line 3 to prove the line
// offset is file-relative, not slice-relative.
const OVERSIZE_LEAF_PY = [
  "# header comment line one",
  "# header comment line two",
  "def process_records(records):",
  "    total = 0",
  "    # accumulate every record value into a running total for the summary report",
  "    for r in records:",
  "        total += r.value  # add this record's value to the running accumulator",
  "    # distinctive deep marker sits far inside this oversize leaf function body",
  "    average = total / max(len(records), 1)",
  "    return {\"total\": total, \"average\": average, \"count\": len(records)}",
].join("\n");

test("oversize leaf function is re-split, not dropped, with file-relative lines", async () => {
  const cfg = { maxChars: 150, minChars: 20, overlapChars: 0 };
  const chunks = await chunkFile("data/report.py", ".py", OVERSIZE_LEAF_PY, cfg);
  // It must NOT be dropped:
  assert.ok(chunks.length >= 2, `expected re-split into >=2 windows, got ${chunks.length}`);
  // The deep marker survives somewhere:
  assert.ok(chunks.some((c) => c.text.includes("distinctive deep marker")), "deep passage missing");
  // First window starts at the def's file line (3), not slice line 1:
  assert.equal(chunks[0].lineStart, 3, "lineStart must be file-relative");
  // Every window respects minChars:
  for (const c of chunks) assert.ok(c.text.length >= cfg.minChars);
});

// A class (container) larger than maxChars whose methods are each under maxChars
// must NOT be re-split into class-spanning windows; its methods surface as their
// own chunks exactly once. No chunk should cover the `class` header line.
const OVERSIZE_CONTAINER_PY = [
  "class Repository:",
  "    def find(self, identifier):",
  "        # look up a stored item by its identifier and return it to the caller",
  "        return self.store.get(identifier)",
  "",
  "    def save(self, item):",
  "        # persist the given item into the backing store keyed by its identifier",
  "        self.store[item.identifier] = item",
].join("\n");

test("oversize container class is NOT re-split (members surface, no duplication)", async () => {
  const cfg = { maxChars: 150, minChars: 20, overlapChars: 0 };
  const chunks = await chunkFile("data/repo.py", ".py", OVERSIZE_CONTAINER_PY, cfg);
  // No window covers the class header — proves the container wasn't re-split:
  assert.ok(!chunks.some((c) => c.text.includes("class Repository")), "container was wrongly re-split");
  // Both methods still surface:
  assert.ok(chunks.some((c) => c.text.includes("def find")), "find method missing");
  assert.ok(chunks.some((c) => c.text.includes("def save")), "save method missing");
  // No duplicate spans:
  const spans = chunks.map((c) => `${c.chunkStart}:${c.chunkEnd}`);
  assert.equal(new Set(spans).size, spans.length, "duplicate spans emitted");
});

test("oversize leaf coordinate offset: text is found at chunkStart in the source", async () => {
  const cfg = { maxChars: 150, minChars: 20, overlapChars: 0 };
  const chunks = await chunkFile("data/report.py", ".py", OVERSIZE_LEAF_PY, cfg);
  for (const c of chunks) {
    const at = OVERSIZE_LEAF_PY.slice(c.chunkStart, c.chunkStart + c.text.length);
    assert.equal(at, c.text, `chunk text not located at chunkStart=${c.chunkStart}`);
  }
});

test("normal (under-maxChars) function still yields exactly one chunk (no regression)", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const py = [
    "def small(n):",
    "    # a short helper well under the maxChars threshold so it stays one chunk",
    "    return n * 2 + 1",
  ].join("\n");
  const chunks = await chunkFile("data/small.py", ".py", py, cfg);
  assert.equal(chunks.length, 1);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd /g/demon/gtir && node --test test/chunker.test.mjs`
Expected: the two oversize-leaf tests FAIL (today the leaf is dropped → `chunks.length` is 0 or the deep marker is absent → assertions fail). The container test and the no-regression test should already PASS (current behavior already drops the container and keeps small functions whole).

Note: if the leaf fixture's `function_definition` span does not actually exceed `maxChars=150`, the leaf test won't fail for the right reason. Verify the span is oversize by a quick check; if needed, add one more padding comment line inside the function body so its byte span clearly exceeds 150. (It should already: the function body is ~300+ chars.)

- [ ] **Step 3: Implement the re-split branch**

In `src/chunker.mjs`, add this module-private helper just above `mergeSiblings` (after `collectNodes`):

```js
// A collected node is a leaf iff no OTHER collected node is nested inside its
// span. Oversize leaves get re-split; oversize containers (which have nested
// target nodes) are dropped so their members surface as their own chunks.
function isLeaf(n, nodes) {
  return !nodes.some((m) => m !== n && m.startIndex >= n.startIndex && m.endIndex <= n.endIndex);
}
```

Then in `mergeSiblings`, replace this line:

```js
    if (span > cfg.maxChars) { flush(); continue; }
```

with:

```js
    if (span > cfg.maxChars) {
      flush();
      // Oversize *leaf* (no nested target node): re-split into line-aware windows
      // via chunkRecursive and offset its positions back to the file, instead of
      // dropping it. Oversize *containers* are still dropped here — their members
      // were collected separately and surface as their own chunks.
      if (isLeaf(n, nodes)) {
        const slice = text.slice(n.startIndex, n.endIndex);
        for (const s of chunkRecursive(relPath, langId, slice, cfg)) {
          out.push({
            ...s,
            chunkStart: s.chunkStart + n.startIndex,
            chunkEnd: s.chunkEnd + n.startIndex,
            lineStart: s.lineStart + n.startPosition.row,
            lineEnd: s.lineEnd + n.startPosition.row,
          });
        }
      }
      continue;
    }
```

(`chunkRecursive`, `relPath`, `text`, `langId`, `cfg`, and the `out` array are all already in scope inside `mergeSiblings`.)

- [ ] **Step 4: Run to verify all chunker tests pass**

Run: `cd /g/demon/gtir && node --test test/chunker.test.mjs`
Expected: PASS — all four new tests plus the pre-existing chunker tests.

- [ ] **Step 5: Full suite**

Run: `cd /g/demon/gtir && node --test 2>&1 | grep -iE 'tests |pass |fail '`
Expected: all green (was 115 pass; now ~119 with the 4 new tests, 0 fail).

- [ ] **Step 6: Commit**

```bash
cd /g/demon/gtir && git add src/chunker.mjs test/chunker.test.mjs && git commit -m "fix(gtir): re-split oversize leaf AST nodes instead of dropping them"
```

---

### Task 2: Demonstrate via eval + update docs

Add a fixture whose answer lives inside an oversize leaf, confirm `gtir eval` now surfaces it, re-save the baseline, and correct the README. **Needs Ollama** (running, default model).

**Files:**
- Create: `G:\demon\gtir\eval\corpus\data\aggregate_report.py`
- Modify: `G:\demon\gtir\eval\golden.json`
- Regenerate: `G:\demon\gtir\eval\baseline.json`
- Modify: `G:\demon\gtir\README.md`

- [ ] **Step 1: Add the oversize-leaf fixture**

Create `G:\demon\gtir\eval\corpus\data\aggregate_report.py` — ONE top-level function with **no nested `def`/`class`** whose byte span clearly exceeds the real `maxChars` (2000). Pad the body with realistic, distinct lines so it's > 2000 chars, and bury a distinctive passage deep inside. Skeleton (extend the body until the file is > 2200 chars; keep it a single function, no nested defs):

```python
# Monthly aggregate reporting over raw event rows.

def build_monthly_aggregate_report(events, fiscal_year):
    # Group raw event rows into per-month buckets, compute totals, variances,
    # and a rolling trend, then emit a report dict the dashboard consumes.
    buckets = {}
    for ev in events:
        month = ev["ts"].month
        buckets.setdefault(month, []).append(ev)
    # ... (pad with many more realistic lines: running totals, variance math,
    #      anomaly flags, comments — until the function body exceeds 2200 chars) ...
    # DISTINCTIVE DEEP MARKER: the variance is computed as the mean of squared
    # deviations from the trailing twelve-month moving average, not the simple
    # year-to-date mean, so a late-year spike does not understate earlier drift.
    # ... (more padding lines after the marker too) ...
    report = {"fiscal_year": fiscal_year, "months": {}}
    for month, rows in sorted(buckets.items()):
        report["months"][month] = {"count": len(rows), "total": sum(r["amount"] for r in rows)}
    return report
```

Verify the file exceeds ~2200 bytes and contains no nested `def`/`class` (so the function is a single oversize **leaf**).

- [ ] **Step 2: Add the golden query**

Append one entry to `G:\demon\gtir\eval\golden.json` (mind JSON comma placement). The query targets the deep marker; `path` is repo-relative to the corpus; `lines` brackets the marker lines (open the file and read the actual line numbers of the DISTINCTIVE DEEP MARKER comment):

```json
{ "query": "how is the monthly variance computed — moving average or year-to-date mean", "path": "data/aggregate_report.py", "lines": [<marker_start>, <marker_end>] }
```

- [ ] **Step 3: Rebuild the fixture index and confirm the query now hits**

```bash
cd /g/demon/gtir && node bin/gtir.mjs index --repo eval/corpus --rebuild 2>&1 | tail -2
cd /g/demon/gtir && node bin/gtir.mjs search "how is the monthly variance computed — moving average or year-to-date mean" --repo eval/corpus -k 5 2>/dev/null
```
Expected: `data/aggregate_report.py` appears in the results (it would NOT have, pre-fix, because the whole function was dropped). If it does not appear, the fixture may still be under `maxChars` (not actually oversize) — enlarge the body and rebuild.

- [ ] **Step 4: Re-run eval and re-save the baseline**

```bash
cd /g/demon/gtir && node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json 2>&1 | tail -12
cd /g/demon/gtir && node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --save 2>&1 | tail -2
```
The metrics now reflect `n` (and `n_sec`) grown by one. Saving updates `eval/baseline.json`. Confirm a plain compare run then reports no regressions and exits 0:
```bash
cd /g/demon/gtir && node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json; echo "exit=$?"
```
Expected: `~0` deltas, `eval: no regressions`, `exit=0`.

- [ ] **Step 5: Update the README "Known limitations" bullet**

In `G:\demon\gtir\README.md`, find the bullet beginning "**Oversize *leaf* nodes are dropped, not re-split.**" and replace that whole bullet with:

```md
- **Oversize *leaf* nodes are re-split, not dropped.** A function/struct larger than `maxChars`
  (2000) with no nested target nodes is split into line-aware windows (same fallback as
  grammarless files), so its content stays searchable. Oversize *containers* (class/impl/mod)
  are still represented by their members, which are indexed as their own chunks — the container's
  own non-member lines (e.g. a class docstring) are not separately re-split.
```

- [ ] **Step 6: Confirm the index is not staged, then commit**

```bash
cd /g/demon/gtir && git status --short
```
Verify `eval/corpus/.gtir/` does NOT appear (gitignored). Then:
```bash
cd /g/demon/gtir && git add eval/corpus/data/aggregate_report.py eval/golden.json eval/baseline.json README.md && git commit -m "test(gtir): eval fixture proving oversize-leaf content is now indexed; update docs"
```

- [ ] **Step 7: Final full suite**

Run: `cd /g/demon/gtir && node --test 2>&1 | grep -iE 'tests |pass |fail '`
Expected: all green.

---

## Self-Review

**Spec coverage:** Re-split mechanism + `isLeaf` guard + coordinate translation → Task 1 Step 3. Leaf re-split / container-not-re-split / coordinate-offset / no-regression tests → Task 1 Step 1. Eval demonstration (fixture + golden + re-saved baseline) → Task 2. README "Known limitations" update → Task 2 Step 5. Container behavior preserved (members surface, no duplication) → asserted in Task 1's container test. ✓

**Placeholder scan:** Task 1 ships complete code + complete tests. Task 2's fixture is the one generative artifact — it ships a concrete skeleton with an explicit size gate (> 2200 chars) and a named DISTINCTIVE DEEP MARKER the golden query targets, plus a verify-it-actually-surfaces gate (Step 3). The golden `lines` are `<marker_start>/<marker_end>` placeholders deliberately, because the implementer must read the real line numbers from the file they generate — Step 2 says so explicitly. ✓

**Type consistency:** sub-chunks are built by spreading a `chunkRecursive` result (`{path, language, chunkStart, chunkEnd, lineStart, lineEnd, text}`) and overriding the four coordinate fields — identical shape to every other AST chunk, no `prefix`. `isLeaf(n, nodes)` matches its call site. `stableId` (text+span) keeps each window distinct. ✓
