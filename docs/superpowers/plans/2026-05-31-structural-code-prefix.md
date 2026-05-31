# Structural code prefixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AST code chunks a structural breadcrumb prefix (`relPath › container chain › own symbol`) from the tree-sitter nodes already parsed — no new model — and measure the retrieval lift via eval.

**Architecture:** All code changes live in the AST chunker (`src/chunker.mjs`); `contextualizeChunk` already prepends `chunk.prefix` when set, so the chunker just computes and attaches a breadcrumb. A scope-sensitive eval corpus + a synthetic "before" baseline make the lift measurable.

**Tech Stack:** Node ESM, `node:test`, web-tree-sitter (real parsers, offline). No new deps.

**Spec:** `docs/superpowers/specs/2026-05-31-structural-code-prefix-design.md`

**Task order matters:** Task 1 captures the synthetic baseline (the "before") and MUST run before Task 2 changes the prefix.

---

## File Structure

- **Modify `src/chunker.mjs`** — add `nodeName`, `scopeBreadcrumb`, `codePrefix`, `CONTAINER_TYPES`, a local `SEP`; store `group.node`; set `prefix` on merged-group and oversize-leaf chunks.
- **Modify `test/chunker.test.mjs`** — breadcrumb / nested / top-level / oversize-leaf-prefix / grammarless-fallback / contextualize-wiring tests.
- **Add `eval/corpus/policy/evaluators.py`** — several classes with near-identical generic methods (scope is the only disambiguator).
- **Modify `eval/golden.json`** — ~6 scope-sensitive queries (with `lines`).
- **Regenerate `eval/baseline.json`** — synthetic "before" (Task 1), then structural "after" (Task 3).
- **Modify `README.md`** — note the AST breadcrumb prefix.

---

### Task 1: Scope-sensitive corpus + synthetic baseline (the "before")

This runs with the CURRENT synthetic prefixes — it captures the pre-change numbers. **Needs Ollama.**

**Files:**
- Create: `G:\demon\gtir\eval\corpus\policy\evaluators.py`
- Modify: `G:\demon\gtir\eval\golden.json`
- Regenerate: `G:\demon\gtir\eval\baseline.json`

- [ ] **Step 1: Create the scope-sensitive fixture**

Create `G:\demon\gtir\eval\corpus\policy\evaluators.py` with FOUR classes whose `evaluate` methods are deliberately **near-identical and generic**, so the class name is the only disambiguator (synthetic prefix `path — def evaluate(self, context):` cannot tell them apart; a structural breadcrumb `… › RetryPolicy › evaluate` can):

```python
# Policy evaluators — each decides whether a request may proceed.

class RetryPolicy:
    def __init__(self, limit):
        self.limit = limit

    def evaluate(self, context):
        # consult the configured limit and return the boolean verdict to the caller
        return self._check(context)

    def _check(self, context):
        return context.value < self.limit


class CachePolicy:
    def __init__(self, limit):
        self.limit = limit

    def evaluate(self, context):
        # consult the configured limit and return the boolean verdict to the caller
        return self._check(context)

    def _check(self, context):
        return context.value < self.limit


class RateLimitPolicy:
    def __init__(self, limit):
        self.limit = limit

    def evaluate(self, context):
        # consult the configured limit and return the boolean verdict to the caller
        return self._check(context)

    def _check(self, context):
        return context.value < self.limit


class CircuitBreakerPolicy:
    def __init__(self, limit):
        self.limit = limit

    def evaluate(self, context):
        # consult the configured limit and return the boolean verdict to the caller
        return self._check(context)

    def _check(self, context):
        return context.value < self.limit
```

- [ ] **Step 2: Add scope-sensitive golden queries**

Open the file, read the ACTUAL 1-based line numbers of each `def evaluate` method. Append SIX entries to `G:\demon\gtir\eval\golden.json` (fix comma placement; keep valid JSON). Each query names a policy by concept; `path` is `policy/evaluators.py`; `lines` bracket THAT class's `evaluate` method (the `def evaluate` line through its `return self._check(context)`):

```json
{ "query": "how does the retry policy decide whether to evaluate another attempt", "path": "policy/evaluators.py", "lines": [<retry_eval_start>, <retry_eval_end>] },
{ "query": "what does the cache policy evaluate to decide if a cached entry is valid", "path": "policy/evaluators.py", "lines": [<cache_eval_start>, <cache_eval_end>] },
{ "query": "how is the rate limit policy evaluated for an incoming request", "path": "policy/evaluators.py", "lines": [<rate_eval_start>, <rate_eval_end>] },
{ "query": "when does the circuit breaker policy evaluate the request as allowed", "path": "policy/evaluators.py", "lines": [<cb_eval_start>, <cb_eval_end>] }
```
(Those are four; add two more of your own in the same style — e.g. targeting `_check` of two of the classes — so there are ~6 scope-sensitive entries total. Validate JSON: `cd /g/demon/gtir && node -e "console.log('entries:', JSON.parse(require('fs').readFileSync('eval/golden.json','utf8')).length)"`.)

- [ ] **Step 3: Rebuild (synthetic prefixes) and capture the baseline**

```bash
cd /g/demon/gtir && node bin/gtir.mjs index --repo eval/corpus --rebuild 2>&1 | tail -2
cd /g/demon/gtir && node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json 2>&1 | tail -12
```
**Headroom gate:** the scope-sensitive queries must reveal headroom — `sec_hit@1` should now be NOTICEABLY below 1.0 (the synthetic prefix can't disambiguate the four identical `evaluate` methods, so the right section often is NOT rank 1). If `sec_hit@1` is still ~1.0, the fixtures are too easy — make the four `evaluate` bodies even more identical (remove any distinguishing tokens) and rebuild. Record the printed `sec_hit@1`/`sec_hit@5`/`mrr` — this is the SYNTHETIC "before".

- [ ] **Step 4: Save the synthetic baseline + commit**

```bash
cd /g/demon/gtir && node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --save 2>&1 | tail -2
cd /g/demon/gtir && git status --short    # confirm eval/corpus/.gtir/ is NOT listed (gitignored)
cd /g/demon/gtir && git add eval/corpus/policy/evaluators.py eval/golden.json eval/baseline.json && git commit -m "test(gtir): scope-sensitive eval fixtures + synthetic baseline (pre-structural-prefix)"
```

- [ ] **Step 5: Full suite still green**

Run: `cd /g/demon/gtir && node --test 2>&1 | grep -iE 'tests |pass |fail '`
Expected: 119 pass, 0 fail (no code changed yet).

---

### Task 2: Structural breadcrumb prefix in the chunker

**Files:**
- Modify: `G:\demon\gtir\src\chunker.mjs`
- Modify: `G:\demon\gtir\test\chunker.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/chunker.test.mjs` (it already imports `chunkFile` from `../src/chunker.mjs`, plus `test`/`assert`; add `import { contextualizeChunk } from "../src/contextualize.mjs";` at the top if not already present):

```js
// --- Structural code prefixes (AST breadcrumb) ---

test("method inside a class gets a relPath › Class › method breadcrumb prefix", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const py = [
    "class Repository:",
    "    def find(self, identifier):",
    "        # look up a stored item by its identifier and return it to the caller",
    "        return self.store.get(identifier)",
  ].join("\n");
  const chunks = await chunkFile("data/repo.py", ".py", py, cfg);
  const c = chunks.find((c) => c.text.includes("def find"));
  assert.ok(c, "find method chunk missing");
  assert.ok(c.prefix && c.prefix.startsWith("data/repo.py"), `prefix should start with relPath: ${c.prefix}`);
  assert.ok(c.prefix.includes("Repository"), `prefix should name the class: ${c.prefix}`);
  assert.ok(c.prefix.includes("find"), `prefix should name the method: ${c.prefix}`);
});

test("nested scope yields a breadcrumb with both container names in order", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const py = [
    "class Outer:",
    "    class Inner:",
    "        def deep_method(self, value):",
    "            # a method nested two scopes deep to verify the full breadcrumb chain",
    "            return value * 2",
  ].join("\n");
  const chunks = await chunkFile("m/nested.py", ".py", py, cfg);
  const c = chunks.find((c) => c.text.includes("deep_method"));
  assert.ok(c && c.prefix, "nested method chunk/prefix missing");
  const iOuter = c.prefix.indexOf("Outer");
  const iInner = c.prefix.indexOf("Inner");
  assert.ok(iOuter >= 0 && iInner >= 0 && iOuter < iInner, `breadcrumb order wrong: ${c.prefix}`);
  assert.ok(c.prefix.includes("deep_method"));
});

test("top-level function gets relPath › funcName (no spurious scope)", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const py = [
    "def standalone(x):",
    "    # a module-level function with no enclosing class or module wrapper at all",
    "    return x + 1",
  ].join("\n");
  const chunks = await chunkFile("m/top.py", ".py", py, cfg);
  const c = chunks.find((c) => c.text.includes("standalone"));
  assert.ok(c && c.prefix, "top-level chunk/prefix missing");
  assert.ok(c.prefix.includes("standalone"), `prefix should name the function: ${c.prefix}`);
  assert.ok(!c.prefix.includes("class"), "no spurious scope token");
});

test("oversize-leaf sub-chunks carry the function-name breadcrumb prefix", async () => {
  const cfg = { maxChars: 150, minChars: 20, overlapChars: 0 };
  const py = [
    "def process_records(records):",
    "    total = 0",
    "    # accumulate every record value into a running total for the summary report",
    "    for r in records:",
    "        total += r.value  # add this record's value to the running accumulator",
    "    # distinctive deep marker sits far inside this oversize leaf function body",
    "    average = total / max(len(records), 1)",
    "    return {\"total\": total, \"average\": average, \"count\": len(records)}",
  ].join("\n");
  const chunks = await chunkFile("data/report.py", ".py", py, cfg);
  assert.ok(chunks.length >= 2, "expected oversize re-split");
  for (const c of chunks) assert.ok(c.prefix && c.prefix.includes("process_records"), `sub-chunk prefix missing func name: ${c.prefix}`);
});

test("grammarless chunk has no structural prefix but contextualize still produces embedText", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const body = "fn main() { let x = 1; }\n".repeat(6); // .wgsl has no grammar → recursive fallback
  const chunks = await chunkFile("s.wgsl", ".wgsl", body, cfg);
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].prefix, undefined, "grammarless chunk should not get a structural prefix");
  const cx = await contextualizeChunk(chunks[0], cfg);
  assert.ok(cx.embedText.includes(chunks[0].text), "synthetic fallback embedText must include the body");
  assert.ok(cx.embedText.startsWith("s.wgsl"), "synthetic prefix should lead with the path");
});

test("contextualizeChunk prepends the structural prefix to the body", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const py = [
    "class Service:",
    "    def run(self, job):",
    "        # execute the given job and return its computed result to the caller now",
    "        return job.execute()",
  ].join("\n");
  const chunks = await chunkFile("svc.py", ".py", py, cfg);
  const c = chunks.find((c) => c.text.includes("def run"));
  const cx = await contextualizeChunk(c, cfg);
  assert.equal(cx.embedText, `${c.prefix}\n${c.text}`);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /g/demon/gtir && node --test test/chunker.test.mjs`
Expected: the breadcrumb tests FAIL (AST chunks have no `prefix` today → `c.prefix` is undefined). The grammarless test should already PASS.

- [ ] **Step 3: Implement the breadcrumb in `src/chunker.mjs`**

Add these helpers near the top of the file (after the imports, before `stableId` is fine):

```js
const SEP = " › "; // breadcrumb separator (same glyph the markdown chunker uses)

const CONTAINER_TYPES = new Set([
  "class_declaration", "abstract_class_declaration", "class_definition",
  "interface_declaration", "enum_declaration", "module_declaration",
  "internal_module", "namespace_declaration",
  "impl_item", "trait_item", "mod_item",
]);

// The declared name of a node: prefer the `name` field, else the first
// identifier-like named child. null when none (anonymous).
function nodeName(n) {
  const f = n.childForFieldName ? n.childForFieldName("name") : null;
  if (f && f.text) return f.text;
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (/identifier/.test(c.type)) return c.text;
  }
  return null;
}

// Names of the container ancestors enclosing `node`, outermost first.
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

// `relPath > Container > ... > ownSymbol`. null when nothing extractable -> caller
// leaves chunk.prefix unset so contextualize falls back to syntheticPrefix.
function codePrefix(relPath, node) {
  const own = nodeName(node);
  const tail = [...scopeBreadcrumb(node), ...(own ? [own] : [])];
  return tail.length ? `${relPath}${SEP}${tail.join(SEP)}` : null;
}
```

In `mergeSiblings`, record the node when a group is created. Find the group-creation site:
```js
        group = { startIndex: n.startIndex, endIndex: n.endIndex,
          startRow: n.startPosition.row, endRow: n.endPosition.row };
```
and add the node reference:
```js
        group = { startIndex: n.startIndex, endIndex: n.endIndex,
          startRow: n.startPosition.row, endRow: n.endPosition.row, node: n };
```

In the `flush` closure of `mergeSiblings`, attach the prefix to the emitted chunk. Change the pushed object:
```js
      out.push({
        path: relPath, language: langId,
        chunkStart: group.startIndex, chunkEnd: group.endIndex,
        lineStart: group.startRow + 1, lineEnd: group.endRow + 1, text: body,
      });
```
to:
```js
      const prefix = codePrefix(relPath, group.node);
      out.push({
        path: relPath, language: langId,
        chunkStart: group.startIndex, chunkEnd: group.endIndex,
        lineStart: group.startRow + 1, lineEnd: group.endRow + 1, text: body,
        ...(prefix ? { prefix } : {}),
      });
```

In the oversize-leaf re-split branch, attach the leaf's prefix to each sub-chunk. Change:
```js
          out.push({
            ...s,
            chunkStart: trimmedStart,
            chunkEnd: trimmedStart + s.text.length,
            lineStart: s.lineStart + n.startPosition.row,
            lineEnd: s.lineEnd + n.startPosition.row,
          });
```
to:
```js
          const leafPrefix = codePrefix(relPath, n);
          out.push({
            ...s,
            chunkStart: trimmedStart,
            chunkEnd: trimmedStart + s.text.length,
            lineStart: s.lineStart + n.startPosition.row,
            lineEnd: s.lineEnd + n.startPosition.row,
            ...(leafPrefix ? { prefix: leafPrefix } : {}),
          });
```

- [ ] **Step 4: Run to verify all chunker tests pass**

Run: `cd /g/demon/gtir && node --test test/chunker.test.mjs`
Expected: PASS — the 6 new tests plus all pre-existing chunker tests.

- [ ] **Step 5: Full suite**

Run: `cd /g/demon/gtir && node --test 2>&1 | grep -iE 'tests |pass |fail '`
Expected: all green (was 119; now ~125, 0 fail).

- [ ] **Step 6: Commit**

```bash
cd /g/demon/gtir && git add src/chunker.mjs test/chunker.test.mjs && git commit -m "feat(gtir): structural breadcrumb prefix for AST code chunks (relPath › scope › symbol)"
```

---

### Task 3: Measure the lift, re-save baseline, docs

**Needs Ollama.** Rebuild with the new structural prefixes and compare to the synthetic baseline saved in Task 1.

**Files:**
- Regenerate: `G:\demon\gtir\eval\baseline.json`
- Modify: `G:\demon\gtir\README.md`

- [ ] **Step 1: Rebuild (re-embeds with structural prefixes) and compare to the synthetic baseline**

```bash
cd /g/demon/gtir && node bin/gtir.mjs index --repo eval/corpus --rebuild 2>&1 | tail -2
cd /g/demon/gtir && node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json 2>&1 | tail -14
```
The table prints deltas vs the synthetic baseline. EXPECTED: `sec_hit@1` (and likely `sec_hit@5`/`mrr`) show a POSITIVE delta — the breadcrumb disambiguates the four near-identical `evaluate` methods. Record the before→after numbers (this is the measured lift). Improvements are not regressions, so `exit=0`. If `sec_hit@1` did NOT improve, report it honestly (the structural prefix did not help on this corpus) — do not fudge the fixtures to manufacture a win.

- [ ] **Step 2: Re-save the baseline (now structural)**

```bash
cd /g/demon/gtir && node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --save 2>&1 | tail -2
cd /g/demon/gtir && node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json; echo "exit=$?"
```
Expected: after --save, the plain compare shows `~0` deltas, `eval: no regressions`, `exit=0`.

- [ ] **Step 3: README note**

In `G:\demon\gtir\README.md`, in the "How it works" pipeline block, update the contextual-prefix line. Find:
```
  → contextual prefix per chunk (synthetic by default; opt-in claude-cli tier)
```
and replace with:
```
  → contextual prefix per chunk: code chunks get an AST breadcrumb (relPath › enclosing
    class/module › symbol); markdown gets its heading breadcrumb; grammarless files use a
    synthetic path+first-line prefix (opt-in claude-cli tier still available)
```

- [ ] **Step 4: Commit**

```bash
cd /g/demon/gtir && git status --short   # confirm no .gtir/ staged
cd /g/demon/gtir && git add eval/baseline.json README.md && git commit -m "test(gtir): structural-prefix baseline + measured sec-hit lift; docs"
```

- [ ] **Step 5: Final full suite**

Run: `cd /g/demon/gtir && node --test 2>&1 | grep -iE 'tests |pass |fail '`
Expected: all green.

---

## Self-Review

**Spec coverage:** `nodeName`/`scopeBreadcrumb`/`codePrefix`/`CONTAINER_TYPES`/`SEP` → Task 2 Step 3. `group.node` + merged-group prefix + oversize-leaf prefix → Task 2 Step 3. Tests (method/nested/top-level/oversize-leaf/grammarless/contextualize-wiring) → Task 2 Step 1. Scope-sensitive eval corpus + synthetic "before" baseline → Task 1. Measured lift + structural "after" baseline → Task 3. README → Task 3 Step 3. Fallback to `syntheticPrefix` for anonymous/grammarless → asserted by the grammarless test + the `...(prefix ? {prefix} : {})` spread. ✓

**Placeholder scan:** All code steps are complete. The `codePrefix` JSDoc contains one intentionally-flagged illustrative token with an explicit instruction to write it as plain ASCII. Golden `lines` are `<…_start>/<…_end>` placeholders by necessity — Task 1 Step 2 instructs reading the real line numbers from the file just written. ✓

**Type consistency:** chunks gain an optional `prefix` field (string), identical to how markdown chunks already carry `prefix`; `contextualizeChunk` reads `chunk.prefix` (existing code). `codePrefix(relPath, node)` matches both call sites. `group.node` is set at creation and read in `flush`. ✓
