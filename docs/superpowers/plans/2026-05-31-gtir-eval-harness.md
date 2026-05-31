# gtir eval — Retrieval Eval Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `gtir eval` subcommand that scores a hand-authored golden query set against an index and compares the metrics (Recall@k, MRR, Sec-hit@k) to a committed baseline, flagging regressions.

**Architecture:** Pure, DB-free metric math in `src/eval.mjs` (unit-tested with fake search rows + an injected search function); the `eval` subcommand in `bin/gtir.mjs` does I/O, builds the index, runs the real `search()`, prints the table, and sets the exit code. A committed fixture corpus + golden set + baseline ship as the regression target.

**Tech Stack:** Node ESM, `node:test`, existing `search()` / `loadConfig` / `buildIndex` / `openStore`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-31-gtir-eval-harness-design.md`

---

## File Structure

- **Create `src/eval.mjs`** — pure helpers: `parseLines`, `overlaps`, `scoreGolden`, `aggregate`, `flattenMetrics`, `compareBaseline`, and the async orchestrator `evalGolden(golden, searchFn, opts)`. No I/O, no DB; `searchFn` is injected.
- **Create `test/eval.test.mjs`** — hermetic tests for every function above (fake result arrays + fake `searchFn`).
- **Modify `bin/gtir.mjs`** — add the `eval` subcommand (flags, index build, real search closure, baseline read/write, table, exit code) and its usage/help line.
- **Create `eval/corpus/`** — committed fixture files (mixed code + notes).
- **Create `eval/golden.json`** — ~30 hand-authored queries.
- **Create `eval/baseline.json`** — generated once via a live `gtir eval --save`, then committed.
- **Modify `.gitignore`** — ensure the fixture's regenerable index (`eval/corpus/.gtir/`) is ignored.
- **Modify `README.md`** — document `gtir eval`.

Notation in code steps: `round(x)` is the module-private helper `const round = (x) => Number(x.toFixed(4));` defined once at the top of `src/eval.mjs`.

---

### Task 1: Line helpers — `parseLines` + `overlaps`

**Files:**
- Create: `G:\demon\gtir\src\eval.mjs`
- Create: `G:\demon\gtir\test\eval.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/eval.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLines, overlaps } from "../src/eval.mjs";

test("parseLines: 'start-end' string", () => {
  assert.deepEqual(parseLines("12-40"), [12, 40]);
});
test("parseLines: single number", () => {
  assert.deepEqual(parseLines("7"), [7, 7]);
});
test("parseLines: whitespace and array forms", () => {
  assert.deepEqual(parseLines(" 3 - 9 "), [3, 9]);
  assert.deepEqual(parseLines([5, 8]), [5, 8]);
});

test("overlaps: touching, nested, disjoint, identical", () => {
  assert.equal(overlaps([1, 5], [5, 9]), true);   // touch at 5
  assert.equal(overlaps([2, 8], [4, 6]), true);   // nested
  assert.equal(overlaps([1, 3], [4, 9]), false);  // disjoint
  assert.equal(overlaps([10, 20], [10, 20]), true); // identical
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /g/demon/gtir && node --test test/eval.test.mjs`
Expected: FAIL — cannot find module `../src/eval.mjs` (not created yet).

- [ ] **Step 3: Create `src/eval.mjs` with the helpers**

```js
// Pure retrieval-eval helpers — no I/O, no DB. Search results are injected.

const round = (x) => Number(x.toFixed(4));

// Parse search()'s "start-end" line string into [start, end].
// Tolerant of a single number ("7" -> [7,7]), surrounding whitespace, and a [s,e] array.
export function parseLines(s) {
  if (Array.isArray(s)) return [Number(s[0]), Number(s[1] ?? s[0])];
  const str = String(s).trim();
  const m = str.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = Number(str);
  return Number.isFinite(n) ? [n, n] : [NaN, NaN];
}

// Inclusive range overlap: [as,ae] overlaps [bs,be] iff as <= be && bs <= ae.
export function overlaps(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /g/demon/gtir && node --test test/eval.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/eval.mjs test/eval.test.mjs && git commit -m "feat(gtir): eval line helpers — parseLines, overlaps"
```

---

### Task 2: `scoreGolden(results, entry)`

Scores one golden entry against a query's result list. Returns the 1-indexed rank of the first
page hit and first section hit (or null), plus whether the entry has `lines`.

**Files:**
- Modify: `G:\demon\gtir\src\eval.mjs`
- Modify: `G:\demon\gtir\test\eval.test.mjs`

- [ ] **Step 1: Append the failing tests**

Append to `test/eval.test.mjs`:

```js
import { scoreGolden } from "../src/eval.mjs";

const R = (path, lines) => ({ path, lines }); // fake search row

test("scoreGolden: page hit rank, no lines on entry", () => {
  const results = [R("a.ts", "1-9"), R("b.ts", "1-9"), R("c.ts", "1-9")];
  const s = scoreGolden(results, { query: "q", path: "b.ts" });
  assert.equal(s.pageRank, 2);
  assert.equal(s.secRank, null);
  assert.equal(s.hasLines, false);
});

test("scoreGolden: no page hit", () => {
  const results = [R("a.ts", "1-9"), R("b.ts", "1-9")];
  const s = scoreGolden(results, { query: "q", path: "z.ts" });
  assert.equal(s.pageRank, null);
});

test("scoreGolden: section hit needs path AND line overlap", () => {
  // page hit at rank 1 but lines disjoint; page+overlap hit at rank 2
  const results = [R("a.ts", "1-5"), R("a.ts", "30-40"), R("a.ts", "60-70")];
  const s = scoreGolden(results, { query: "q", path: "a.ts", lines: [32, 38] });
  assert.equal(s.pageRank, 1);
  assert.equal(s.secRank, 2);
  assert.equal(s.hasLines, true);
});

test("scoreGolden: page matches but no line overlap → secRank null", () => {
  const results = [R("a.ts", "1-5")];
  const s = scoreGolden(results, { query: "q", path: "a.ts", lines: [50, 60] });
  assert.equal(s.pageRank, 1);
  assert.equal(s.secRank, null);
});

test("scoreGolden: path as array (any-match)", () => {
  const results = [R("x.ts", "1-9"), R("b.ts", "1-9")];
  const s = scoreGolden(results, { query: "q", path: ["a.ts", "b.ts"] });
  assert.equal(s.pageRank, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /g/demon/gtir && node --test test/eval.test.mjs`
Expected: FAIL — `scoreGolden` is not exported.

- [ ] **Step 3: Add `scoreGolden` to `src/eval.mjs`**

```js
// Score one golden entry against a query's result list (ordered best-first).
// Returns { pageRank, secRank, hasLines } with 1-indexed ranks (null if no hit).
export function scoreGolden(results, entry) {
  const wanted = new Set((Array.isArray(entry.path) ? entry.path : [entry.path]).map(String));
  const hasLines = Array.isArray(entry.lines) && entry.lines.length === 2;
  let pageRank = null, secRank = null;
  for (let i = 0; i < results.length; i++) {
    const isPage = wanted.has(String(results[i].path));
    if (!isPage) continue;
    if (pageRank === null) pageRank = i + 1;
    if (hasLines && secRank === null && overlaps(parseLines(results[i].lines), entry.lines)) {
      secRank = i + 1;
    }
  }
  return { pageRank, secRank, hasLines };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /g/demon/gtir && node --test test/eval.test.mjs`
Expected: PASS (all prior + 5 new).

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/eval.mjs test/eval.test.mjs && git commit -m "feat(gtir): scoreGolden — page + section rank scoring"
```

---

### Task 3: `aggregate(records, ks)`

Aggregates per-query records into Recall@k, MRR, Sec-hit@k.

**Files:**
- Modify: `G:\demon\gtir\src\eval.mjs`
- Modify: `G:\demon\gtir\test\eval.test.mjs`

- [ ] **Step 1: Append the failing tests**

Append to `test/eval.test.mjs`:

```js
import { aggregate } from "../src/eval.mjs";

test("aggregate: recall, mrr, sec_hit", () => {
  const records = [
    { pageRank: 1, secRank: 1, hasLines: true },   // recall@1 hit, sec@1 hit
    { pageRank: 3, secRank: null, hasLines: true }, // recall@5 hit, no sec
    { pageRank: null, secRank: null, hasLines: false }, // miss, not in sec denom
    { pageRank: 2, secRank: 4, hasLines: true },   // recall@5, sec@5
  ];
  const m = aggregate(records);
  assert.equal(m.n, 4);
  assert.equal(m.n_sec, 3);                  // three hasLines entries
  assert.equal(m.recall[1], 0.25);           // only the rank-1 record
  assert.equal(m.recall[5], 0.75);           // ranks 1,3,2 (the null misses)
  assert.equal(m.recall[10], 0.75);
  // MRR = mean(1/1, 1/3, 0, 1/2) = (1 + 0.3333 + 0 + 0.5)/4 = 0.4583
  assert.equal(m.mrr, 0.4583);
  assert.equal(m.sec_hit[1], 0.3333);        // 1 of 3 sec entries hit at rank 1
  assert.equal(m.sec_hit[5], 0.6667);        // 2 of 3 hit within rank 5
});

test("aggregate: no sec entries → sec_hit null (n/a)", () => {
  const records = [{ pageRank: 1, secRank: null, hasLines: false }];
  const m = aggregate(records);
  assert.equal(m.n_sec, 0);
  assert.equal(m.sec_hit[1], null);
  assert.equal(m.sec_hit[5], null);
});

test("aggregate: empty records", () => {
  const m = aggregate([]);
  assert.equal(m.n, 0);
  assert.equal(m.recall[1], 0);
  assert.equal(m.mrr, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /g/demon/gtir && node --test test/eval.test.mjs`
Expected: FAIL — `aggregate` is not exported.

- [ ] **Step 3: Add `aggregate` to `src/eval.mjs`**

```js
// Aggregate per-query records into metrics. ks selects the reported cutoffs.
export function aggregate(records, ks = { recall: [1, 5, 10], sec: [1, 5] }) {
  const n = records.length;
  const recall = {};
  for (const k of ks.recall) {
    const hits = records.filter((r) => r.pageRank !== null && r.pageRank <= k).length;
    recall[k] = n ? round(hits / n) : 0;
  }
  const mrr = n
    ? round(records.reduce((s, r) => s + (r.pageRank ? 1 / r.pageRank : 0), 0) / n)
    : 0;
  const secRecords = records.filter((r) => r.hasLines);
  const nSec = secRecords.length;
  const sec_hit = {};
  for (const k of ks.sec) {
    sec_hit[k] = nSec
      ? round(secRecords.filter((r) => r.secRank !== null && r.secRank <= k).length / nSec)
      : null;
  }
  return { n, n_sec: nSec, recall, mrr, sec_hit };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /g/demon/gtir && node --test test/eval.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/eval.mjs test/eval.test.mjs && git commit -m "feat(gtir): aggregate — Recall@k, MRR, Sec-hit@k"
```

---

### Task 4: `flattenMetrics` + `compareBaseline`

**Files:**
- Modify: `G:\demon\gtir\src\eval.mjs`
- Modify: `G:\demon\gtir\test\eval.test.mjs`

- [ ] **Step 1: Append the failing tests**

Append to `test/eval.test.mjs`:

```js
import { flattenMetrics, compareBaseline } from "../src/eval.mjs";

const M = (recall, mrr, sec_hit) => ({ recall, mrr, sec_hit, n: 10, n_sec: 8 });

test("flattenMetrics: scalar keys; null sec_hit dropped", () => {
  const f = flattenMetrics(M({ 1: 0.5, 5: 0.8, 10: 0.9 }, 0.6, { 1: 0.4, 5: null }));
  assert.deepEqual(f, { "recall@1": 0.5, "recall@5": 0.8, "recall@10": 0.9, mrr: 0.6, "sec_hit@1": 0.4 });
});

test("compareBaseline: flags drops beyond tol, not within, not improvements", () => {
  const cur =  M({ 1: 0.50, 5: 0.80, 10: 0.90 }, 0.60, { 1: 0.40, 5: 0.60 });
  const base = M({ 1: 0.55, 5: 0.80, 10: 0.85 }, 0.60, { 1: 0.50, 5: 0.60 });
  const regs = compareBaseline(cur, base, 0.005);
  const keys = regs.map((r) => r.metric).sort();
  assert.deepEqual(keys, ["recall@1", "sec_hit@1"]); // 0.50<0.55 and 0.40<0.50; recall@10 improved; rest equal
});

test("compareBaseline: missing baseline metric is skipped (no false regression)", () => {
  const cur =  M({ 1: 0.50, 5: 0.80, 10: 0.90 }, 0.60, { 1: 0.40, 5: 0.60 });
  const base = { recall: { 1: 0.50 }, mrr: 0.60, sec_hit: {} }; // sparse baseline
  const regs = compareBaseline(cur, base, 0.005);
  assert.equal(regs.length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /g/demon/gtir && node --test test/eval.test.mjs`
Expected: FAIL — `flattenMetrics`/`compareBaseline` not exported.

- [ ] **Step 3: Add both to `src/eval.mjs`**

```js
// Flatten a metrics object to scalar { "recall@1": ..., mrr: ..., "sec_hit@1": ... }.
// Null sec_hit values (n_sec === 0) are omitted so they never read as regressions.
export function flattenMetrics(m) {
  const out = {};
  for (const k of Object.keys(m.recall || {})) out[`recall@${k}`] = m.recall[k];
  if (typeof m.mrr === "number") out.mrr = m.mrr;
  for (const k of Object.keys(m.sec_hit || {})) {
    if (m.sec_hit[k] !== null && m.sec_hit[k] !== undefined) out[`sec_hit@${k}`] = m.sec_hit[k];
  }
  return out;
}

// Return [{ metric, cur, base, delta }] for every metric that dropped by more than tol.
// A metric absent from the baseline is skipped (not a false regression).
export function compareBaseline(cur, base, tol = 0.005) {
  const c = flattenMetrics(cur), b = flattenMetrics(base);
  const regressions = [];
  for (const key of Object.keys(c)) {
    if (!(key in b)) continue;
    const delta = c[key] - b[key];
    if (delta < -tol) regressions.push({ metric: key, cur: c[key], base: b[key], delta: round(delta) });
  }
  return regressions;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /g/demon/gtir && node --test test/eval.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /g/demon/gtir && git add src/eval.mjs test/eval.test.mjs && git commit -m "feat(gtir): flattenMetrics + compareBaseline regression check"
```

---

### Task 5: `evalGolden(golden, searchFn, opts)` orchestrator

Pure orchestration: runs each query through an injected `searchFn`, scores, aggregates. No DB —
the CLI passes a real search closure; tests pass a fake.

**Files:**
- Modify: `G:\demon\gtir\src\eval.mjs`
- Modify: `G:\demon\gtir\test\eval.test.mjs`

- [ ] **Step 1: Append the failing tests**

Append to `test/eval.test.mjs`:

```js
import { evalGolden } from "../src/eval.mjs";

test("evalGolden: runs each query through searchFn and aggregates", async () => {
  const golden = [
    { query: "alpha", path: "a.ts", lines: [1, 9] },
    { query: "bravo", path: "b.ts" },
  ];
  // fake searchFn: returns a canned result list per query
  const fake = async (q, k) => {
    assert.equal(k, 10); // maxK threaded through
    if (q === "alpha") return [R("a.ts", "1-9"), R("z.ts", "1-9")];
    return [R("x.ts", "1-9"), R("y.ts", "1-9"), R("b.ts", "1-9")];
  };
  const m = await evalGolden(golden, fake, { maxK: 10 });
  assert.equal(m.n, 2);
  assert.equal(m.recall[1], 0.5);   // alpha hit@1, bravo hit@3
  assert.equal(m.recall[5], 1.0);
  assert.equal(m.n_sec, 1);         // only alpha has lines
  assert.equal(m.sec_hit[1], 1.0);
});

test("evalGolden: empty golden throws", async () => {
  await assert.rejects(() => evalGolden([], async () => []), /golden set is empty/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /g/demon/gtir && node --test test/eval.test.mjs`
Expected: FAIL — `evalGolden` not exported.

- [ ] **Step 3: Add `evalGolden` to `src/eval.mjs`**

```js
// Run a golden set through an injected async searchFn(query, k) -> results[], score, aggregate.
export async function evalGolden(golden, searchFn, { maxK = 10, ks } = {}) {
  if (!Array.isArray(golden) || golden.length === 0) throw new Error("golden set is empty");
  const records = [];
  for (const entry of golden) {
    const results = await searchFn(entry.query, maxK);
    records.push(scoreGolden(results, entry));
  }
  return aggregate(records, ks);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /g/demon/gtir && node --test test/eval.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the FULL suite (no regressions elsewhere)**

Run: `cd /g/demon/gtir && node --test`
Expected: all green (the prior 94 + the new eval tests).

- [ ] **Step 6: Commit**

```bash
cd /g/demon/gtir && git add src/eval.mjs test/eval.test.mjs && git commit -m "feat(gtir): evalGolden orchestrator (injected searchFn)"
```

---

### Task 6: `gtir eval` subcommand in `bin/gtir.mjs`

Wires the pure module to real I/O: flags, index build/refresh, real `search()` closure,
baseline read/write, metrics table, exit code. This is integration — verified by a focused arg
parse check plus the live smoke in Task 7 (the metric/compare logic is already unit-tested).

**Files:**
- Modify: `G:\demon\gtir\bin\gtir.mjs`

- [ ] **Step 1: Read the file and its imports**

Run: `cd /g/demon/gtir && node -e "console.log(require('fs').readFileSync('bin/gtir.mjs','utf8'))" | head -60`
Identify: the import block, the arg-parsing loop (how `--repo`, `--rebuild`, `--no-cache` are
parsed into an `args` object), the command dispatch (`if (cmd === "index") ...`), and the
`stderr`/logging helper style. Match these patterns exactly. Confirm whether `path`, `fs`,
`search`, `loadConfig`, `buildIndex`, `openStore` are already imported; add any that are missing
(import from the same modules the rest of the file uses: `search` from `../src/search.mjs`,
`loadConfig` from `../src/config.mjs`, `buildIndex` from `../src/indexer.mjs`, `openStore` from
`../src/store.mjs`, and `node:path` / `node:fs`).

- [ ] **Step 2: Add imports from the eval module**

Add to the import block:

```js
import { evalGolden, flattenMetrics, compareBaseline } from "../src/eval.mjs";
```

- [ ] **Step 3: Parse the `eval` flags**

In the arg-parsing loop, add cases (mirror how existing boolean/value flags are handled). Boolean
flags: `--save`, `--no-build`, `--json`. Value flags: `--golden <f>`, `--baseline <f>`, `-k <n>`
(reuse existing `-k`/`--repo` parsing if present). Resulting fields: `args.save`, `args.noBuild`,
`args.json`, `args.golden`, `args.baseline`, `args.k`.

```js
    else if (a === "--save") args.save = true;
    else if (a === "--no-build") args.noBuild = true;
    else if (a === "--json") args.json = true;
    else if (a === "--golden") args.golden = argv[++i];
    else if (a === "--baseline") args.baseline = argv[++i];
```

(If `-k` and `--repo` are already parsed for `search`/`index`, do NOT duplicate them.)

- [ ] **Step 4: Add the `runEval` function**

Place near the other `run*` helpers. Uses the already-imported `path`/`fs` (Node builtins):

```js
async function runEval(args) {
  const repo = args.repo || process.cwd();
  const cfg = loadConfig(repo);
  const goldenPath = args.golden || path.join(repo, "eval", "golden.json");
  if (!fs.existsSync(goldenPath)) {
    process.stderr.write(`eval: no golden file at ${goldenPath} — pass --golden <file>\n`);
    return 2;
  }
  let golden;
  try { golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")); }
  catch (e) { process.stderr.write(`eval: cannot parse ${goldenPath}: ${e.message}\n`); return 2; }
  if (!Array.isArray(golden) || golden.length === 0) {
    process.stderr.write("eval: golden set is empty\n"); return 2;
  }

  const store = await openStore(cfg);
  const hasIndex = !!(await store.chunksTable());
  if (!args.noBuild) {
    await buildIndex(cfg, { rebuild: false });        // refresh so metrics reflect current content
  } else if (!hasIndex) {
    process.stderr.write(`eval: no index at ${cfg.indexDir} — run: gtir index\n`); return 2;
  }

  const maxK = Math.max(1, Math.min(50, (args.k | 0) || 10));
  const searchFn = (q, k) => search(q, cfg, { k });
  const metrics = await evalGolden(golden, searchFn, { maxK });
  metrics.model = (await store.readMeta()).model || cfg.model;

  const baselinePath = args.baseline || path.join(repo, "eval", "baseline.json");

  if (args.save) {
    fs.writeFileSync(baselinePath, JSON.stringify(metrics, null, 2) + "\n");
    process.stderr.write(`eval: saved baseline → ${baselinePath} (n=${metrics.n}, model=${metrics.model})\n`);
    if (args.json) process.stdout.write(JSON.stringify(metrics) + "\n");
    return 0;
  }

  let baseline = null;
  if (fs.existsSync(baselinePath)) {
    try { baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")); } catch { /* treat as none */ }
  }
  printMetricsTable(metrics, baseline);
  if (args.json) process.stdout.write(JSON.stringify(metrics) + "\n");

  if (!baseline) {
    process.stderr.write("eval: no baseline to compare (run with --save to set one)\n");
    return 0;
  }
  if (baseline.model && baseline.model !== metrics.model) {
    process.stderr.write(`eval: WARNING baseline model (${baseline.model}) != current (${metrics.model}) — cross-model comparison\n`);
  }
  const regressions = compareBaseline(metrics, baseline, 0.005);
  if (regressions.length) {
    for (const r of regressions) {
      process.stderr.write(`eval: REGRESSION ${r.metric}: ${r.base} → ${r.cur} (${r.delta})\n`);
    }
    return 1;
  }
  process.stderr.write("eval: no regressions\n");
  return 0;
}

function printMetricsTable(m, base) {
  const fb = base ? flattenMetrics(base) : {};
  const line = (label, val) => {
    if (val === null || val === undefined) return `  ${label.padEnd(11)} n/a`;
    const b = fb[label];
    if (b === undefined) return `  ${label.padEnd(11)} ${val.toFixed(4)}`;
    const d = val - b;
    const ds = Math.abs(d) <= 0.005 ? "~0" : (d > 0 ? "+" : "") + d.toFixed(4);
    return `  ${label.padEnd(11)} ${val.toFixed(4)}  (base ${b.toFixed(4)}, ${ds})`;
  };
  const out = [`eval: n=${m.n} n_sec=${m.n_sec} model=${m.model}`];
  for (const k of Object.keys(m.recall)) out.push(line(`recall@${k}`, m.recall[k]));
  out.push(line("mrr", m.mrr));
  for (const k of Object.keys(m.sec_hit)) out.push(line(`sec_hit@${k}`, m.sec_hit[k]));
  process.stderr.write(out.join("\n") + "\n");
}
```

- [ ] **Step 5: Dispatch the command + help text**

In the command dispatch, add (mirroring how other commands call `process.exit`):

```js
  } else if (cmd === "eval") {
    process.exit(await runEval(args));
```

Add an `eval` line to the usage/help string, e.g.:

```
  gtir eval   --repo <project> [--golden <f>] [-k 10] [--save] [--no-build] [--json]
```

- [ ] **Step 6: Verify the flag is recognized (no Ollama needed)**

Run: `cd /g/demon/gtir && node bin/gtir.mjs eval --repo . --golden /definitely/missing.json; echo "exit=$?"`
Expected: prints `eval: no golden file at /definitely/missing.json — pass --golden <file>` and `exit=2`
(proves the subcommand is wired, flags parse, and the missing-file branch returns 2 — all without
touching Ollama).

- [ ] **Step 7: Full suite still green**

Run: `cd /g/demon/gtir && node --test`
Expected: all green (bin changes don't break unit tests).

- [ ] **Step 8: Commit**

```bash
cd /g/demon/gtir && git add bin/gtir.mjs && git commit -m "feat(gtir): gtir eval subcommand — metrics table, baseline compare, exit code"
```

---

### Task 7: Fixture corpus + golden set + baseline + docs

Author the committed regression target and generate its baseline. This is the one generative
task: the corpus and golden answers must be **mutually consistent** (each golden `path`/`lines`
must really be the best home for its query), verified by building the index and checking the
metrics are non-degenerate.

**Files:**
- Create: `G:\demon\gtir\eval\corpus\` (≈25–35 files)
- Create: `G:\demon\gtir\eval\golden.json` (≈30 queries)
- Create: `G:\demon\gtir\eval\baseline.json` (generated)
- Modify: `G:\demon\gtir\.gitignore`
- Modify: `G:\demon\gtir\README.md`

- [ ] **Step 1: Ensure the fixture index is gitignored**

Run: `cd /g/demon/gtir && grep -n "gtir" .gitignore || echo "MISSING"`
If `.gtir/` (matching anywhere) is NOT already ignored, append a line so the fixture's regenerable
index is not committed:

```
# regenerable indexes
.gtir/
```

(If a `.gtir/` rule already exists and matches nested dirs, do nothing.)

- [ ] **Step 2: Author the fixture corpus**

Create ≈25–35 files under `eval/corpus/` mixing code and notes so retrieval has to discriminate
(the right answer must NOT be trivially rank-1 for every query). Requirements:
- **Languages:** at least js/ts, python, and rust files (all present in `src/languages.mjs`),
  plus several markdown notes with `##` headings and frontmatter `title:`/`tags:`.
- **Distinct topics:** each file is about a recognizably different thing (e.g. `auth/jwt.ts`,
  `cache/lru.py`, `geometry/quaternion.rs`, `notes/deployment.md`, `notes/incident-2025.md`).
  Avoid near-duplicate files — distinct vocabulary per file is what makes ranking meaningful.
- **Real-ish bodies:** functions/sections long enough to clear the 100-char min-chunk size; a few
  files with multiple functions/headings so `lines` targeting is meaningful.

Concrete starter examples (create these, then continue the pattern to reach the count):

`eval/corpus/auth/jwt.ts`:
```ts
// Issue and verify JSON Web Tokens for session auth.
export function signToken(payload, secret, ttlSeconds) {
  const header = { alg: "HS256", typ: "JWT" };
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = { ...payload, exp };
  return encode(header) + "." + encode(body) + "." + hmac(header, body, secret);
}

export function verifyToken(token, secret) {
  const [h, b, sig] = token.split(".");
  if (hmac(JSON.parse(decode(h)), JSON.parse(decode(b)), secret) !== sig) throw new Error("bad signature");
  const body = JSON.parse(decode(b));
  if (body.exp < Math.floor(Date.now() / 1000)) throw new Error("token expired");
  return body;
}
```

`eval/corpus/cache/lru.py`:
```python
class LRUCache:
    """Fixed-capacity least-recently-used cache backed by an ordered dict."""
    def __init__(self, capacity):
        self.capacity = capacity
        self.store = OrderedDict()

    def get(self, key):
        if key not in self.store:
            return None
        self.store.move_to_end(key)   # mark as most-recently used
        return self.store[key]

    def put(self, key, value):
        self.store[key] = value
        self.store.move_to_end(key)
        if len(self.store) > self.capacity:
            self.store.popitem(last=False)   # evict least-recently used
```

`eval/corpus/geometry/quaternion.rs`:
```rust
/// Hamilton product of two quaternions (w, x, y, z).
pub fn mul(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [
        a[0]*b[0] - a[1]*b[1] - a[2]*b[2] - a[3]*b[3],
        a[0]*b[1] + a[1]*b[0] + a[2]*b[3] - a[3]*b[2],
        a[0]*b[2] - a[1]*b[3] + a[2]*b[0] + a[3]*b[1],
        a[0]*b[3] + a[1]*b[2] - a[2]*b[1] + a[3]*b[0],
    ]
}
```

`eval/corpus/notes/deployment.md`:
```md
---
title: Deployment Runbook
tags: [ops, deploy]
---

## Rolling restart
Drain one node at a time; wait for health checks to go green before the next.

## Rollback
Re-point the alias to the previous image tag and restart. Database migrations are
forward-only, so a rollback must be paired with a compensating migration.
```

- [ ] **Step 3: Author the golden set**

Create `eval/golden.json` — a JSON array of ≈30 entries. Each `query` is a natural-language
question; `path` is the repo-relative file (relative to `eval/corpus/`, e.g. `auth/jwt.ts`) that
best answers it; add `lines` (`[start, end]`) for ≈70% of entries pointing at the specific
function/section. Mix code and notes queries. Starter examples (extend to ~30, one per distinct
corpus file, plus a few that should be answered by a specific section):

```json
[
  { "query": "how do I verify a JWT and reject expired tokens", "path": "auth/jwt.ts", "lines": [10, 17] },
  { "query": "sign a session token with an expiry", "path": "auth/jwt.ts", "lines": [2, 8] },
  { "query": "evict the least recently used entry from a cache", "path": "cache/lru.py", "lines": [16, 22] },
  { "query": "multiply two quaternions", "path": "geometry/quaternion.rs" },
  { "query": "how do we roll back a bad deploy", "path": "notes/deployment.md", "lines": [12, 15] }
]
```

Rules: every `path` must exist under `eval/corpus/`; `lines` must bracket the relevant code in the
actual file you wrote (open the file and read off the line numbers). Keep queries phrased like a
developer searching — not copied keywords from the file (that tests real retrieval, not exact
match).

- [ ] **Step 4: Build the fixture index and generate the baseline**

Ollama must be running with the default model. Run:

```bash
cd /g/demon/gtir && node bin/gtir.mjs index --repo eval/corpus --rebuild 2>&1 | tail -2
cd /g/demon/gtir && node bin/gtir.mjs eval --repo eval/corpus 2>&1 | tail -20
```

Inspect the printed metrics. **Sanity gate:** Recall@10 should be clearly non-degenerate
(≳ 0.6) — if it is near zero, the golden answers are mis-targeted; fix `golden.json` (wrong
paths/lines) and re-run. Recall@1 well below 1.0 is GOOD (it means the corpus discriminates).

- [ ] **Step 5: Save and commit the baseline**

```bash
cd /g/demon/gtir && node bin/gtir.mjs eval --repo eval/corpus --save 2>&1 | tail -2
```

Confirm `eval/baseline.json` now exists with the metrics. Then verify a plain compare run reports
no regressions and exits 0:

```bash
cd /g/demon/gtir && node bin/gtir.mjs eval --repo eval/corpus; echo "exit=$?"
```
Expected: prints the table with `~0` deltas and `eval: no regressions`, `exit=0`.

- [ ] **Step 6: Document `gtir eval` in the README**

Add a section after the "Use" block:

```md
## Measuring retrieval quality — `gtir eval`

gtir ships a committed eval harness so retrieval changes are measurable, not vibes:

    gtir eval --repo eval/corpus            # score the golden set, compare to baseline
    gtir eval --repo eval/corpus --save     # set the current metrics as the new baseline

It runs a hand-authored golden query set (`eval/golden.json`) against a fixture corpus
(`eval/corpus/`) and reports **Recall@{1,5,10}**, **MRR**, and **Sec-hit@{1,5}**, then compares
to `eval/baseline.json` and **exits non-zero if any metric regressed** (CI-usable). The harness is
corpus-agnostic — point `--repo` at any index and pass `--golden <file>` to score your own set.
`--json` emits the metrics object to stdout; `--no-build` skips the pre-run refresh.

A/B across a change: `gtir eval --save` on the old commit, then `gtir eval` on the new one reads
the delta. Metric math is unit-tested (hermetic); the corpus run needs Ollama.
```

- [ ] **Step 7: Commit corpus, golden, baseline, gitignore, README**

```bash
cd /g/demon/gtir && git add eval/ .gitignore README.md && git commit -m "feat(gtir): committed eval fixture corpus, golden set, baseline + docs"
```

- [ ] **Step 8: Final full suite**

Run: `cd /g/demon/gtir && node --test`
Expected: all green.

---

## Self-Review

**Spec coverage:**
- `parseLines`/`overlaps` → Task 1. `scoreGolden` (page+section, array paths, hasLines) → Task 2.
  `aggregate` (Recall@{1,5,10}, MRR, Sec-hit@{1,5}, n_sec, null sec_hit) → Task 3. `compareBaseline`
  + `flattenMetrics` (tol, missing-metric skip) → Task 4. `evalGolden` orchestrator → Task 5.
  CLI flags/build/baseline/table/exit/`--json`/`--save`/`--no-build` → Task 6. Fixture corpus +
  golden + baseline + `.gitignore` + README → Task 7. Error cases (missing/empty golden, no index)
  → Task 6 `runEval`. Cross-model warning → Task 6. ✓ all spec sections mapped.
- Live smoke (spec "Testing") → Task 7 Steps 4–5.

**Placeholder scan:** every code step contains complete code; the only generative content (corpus
files, golden entries) ships with concrete starter examples + explicit rules + a metric sanity
gate, not "add more like this" hand-waving. ✓

**Type consistency:** result rows use `{path, lines}` with `lines` a `"start-end"` string
everywhere (search output, fakes, `scoreGolden`). Metrics object shape `{n, n_sec, recall, mrr,
sec_hit, model}` is identical in `aggregate`, the baseline file, `flattenMetrics`, and
`printMetricsTable`. `evalGolden(golden, searchFn, {maxK, ks})` signature matches its CLI call
`evalGolden(golden, searchFn, { maxK })` and its test. `compareBaseline(cur, base, tol)` matches
both call sites. ✓
