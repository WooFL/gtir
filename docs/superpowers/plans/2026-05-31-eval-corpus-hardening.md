# Eval-Corpus Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give gtir's eval harness real headroom by adding a `hard` golden tier over realistic decoys, while keeping the existing saturated set as a strict `gate` regression floor.

**Architecture:** Tag each golden entry with `tier` (`gate`/`hard`). `evalGolden` groups records by tier and emits per-tier metrics alongside the existing overall blob. The CLI gates on regressions in the overall metrics *and* every shared tier. Seven new corpus files model the real failure modes (doc/test shadowing, near-dup impls, method ambiguity); ~30 new `hard` queries exercise them plus cross-vocabulary phrasings.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, LanceDB index via Ollama (`jina-code-embeddings-0.5b`). Pure metric math in `src/eval.mjs`; CLI orchestration in `bin/gtir.mjs`. Corpus + golden + baseline live under `eval/`.

**Repo:** `G:\demon\gtir` (run all commands from the repo root). Note: `package.json` has no `"type"` field, so `node -e "...require('fs')..."` runs as CommonJS — that's intended for the data scripts below. `eval/corpus/.gtir/` is gitignored; the rebuilt index is never committed.

---

### Task 1: Per-tier aggregation + tier comparison (`src/eval.mjs`)

**Files:**
- Modify: `src/eval.mjs` (extend `evalGolden`; add `compareTiers`, `allRegressions`)
- Test: `test/eval.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/eval.test.mjs`:

```js
import { compareTiers, allRegressions } from "../src/eval.mjs";

test("evalGolden: splits records into byTier (gate/hard), overall unchanged", async () => {
  const golden = [
    { query: "g1", path: "a.ts", lines: [1, 9], tier: "gate" },
    { query: "g2", path: "b.ts", tier: "gate" },
    { query: "h1", path: "c.ts", tier: "hard" },
  ];
  const fake = async (q) => {
    if (q === "g1") return [R("a.ts", "1-9")];                 // gate hit @1
    if (q === "g2") return [R("b.ts", "1-9")];                 // gate hit @1
    return [R("x.ts", "1-9"), R("y.ts", "1-9"), R("c.ts", "1-9")]; // hard hit @3
  };
  const m = await evalGolden(golden, fake, { maxK: 10 });
  assert.equal(m.n, 3);                       // overall still present
  assert.ok(m.byTier.gate && m.byTier.hard);
  assert.equal(m.byTier.gate.n, 2);
  assert.equal(m.byTier.gate.recall[1], 1.0);
  assert.equal(m.byTier.hard.n, 1);
  assert.equal(m.byTier.hard.recall[1], 0.0);
  assert.equal(m.byTier.hard.recall[5], 1.0);
});

test("evalGolden: entry with no tier defaults to gate", async () => {
  const golden = [{ query: "x", path: "a.ts" }];
  const m = await evalGolden(golden, async () => [R("a.ts", "1-9")], { maxK: 10 });
  assert.equal(m.byTier.gate.n, 1);
  assert.equal(m.byTier.hard, undefined);
});

test("compareTiers: flags a per-tier regression with a tier-prefixed metric", () => {
  const cur =  { byTier: { hard: M({ 1: 0.40, 5: 0.80, 10: 0.90 }, 0.5, { 1: 0.3, 5: 0.5 }) } };
  const base = { byTier: { hard: M({ 1: 0.55, 5: 0.80, 10: 0.90 }, 0.5, { 1: 0.3, 5: 0.5 }) } };
  const regs = compareTiers(cur, base, 0.005);
  assert.deepEqual(regs.map((r) => r.metric), ["hard:recall@1"]);
});

test("compareTiers: a tier missing from baseline is skipped (no false regression)", () => {
  const cur =  { byTier: { hard: M({ 1: 0.4, 5: 0.8, 10: 0.9 }, 0.5, { 1: 0.3, 5: 0.5 }) } };
  const base = { byTier: {} };
  assert.equal(compareTiers(cur, base, 0.005).length, 0);
});

test("allRegressions: combines overall + per-tier regressions", () => {
  const cur =  { recall: { 1: 0.40 }, mrr: 0.5, sec_hit: {}, byTier: { hard: M({ 1: 0.40, 5: 0.8, 10: 0.9 }, 0.5, { 1: 0.3, 5: 0.5 }) } };
  const base = { recall: { 1: 0.55 }, mrr: 0.5, sec_hit: {}, byTier: { hard: M({ 1: 0.55, 5: 0.8, 10: 0.9 }, 0.5, { 1: 0.3, 5: 0.5 }) } };
  const keys = allRegressions(cur, base, 0.005).map((r) => r.metric).sort();
  assert.deepEqual(keys, ["hard:recall@1", "recall@1"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `compareTiers`/`allRegressions` are not exported; `m.byTier` is undefined.

- [ ] **Step 3: Implement the changes in `src/eval.mjs`**

Replace the `evalGolden` function (currently the last function in the file) with:

```js
// Run a golden set through an injected async searchFn(query, k) -> results[], score, aggregate.
// Each record carries its entry's tier (default "gate"); returns overall metrics + per-tier breakdown.
export async function evalGolden(golden, searchFn, { maxK = 10, ks } = {}) {
  if (!Array.isArray(golden) || golden.length === 0) throw new Error("golden set is empty");
  const records = [];
  for (const entry of golden) {
    const results = await searchFn(entry.query, maxK);
    const rec = scoreGolden(results, entry);
    rec.tier = entry.tier || "gate";
    records.push(rec);
  }
  const overall = aggregate(records, ks);
  const byTier = {};
  for (const tier of [...new Set(records.map((r) => r.tier))]) {
    byTier[tier] = aggregate(records.filter((r) => r.tier === tier), ks);
  }
  return { ...overall, byTier };
}
```

Then append these two functions to the end of `src/eval.mjs`:

```js
// Compare per-tier metrics. Returns regressions with metric names prefixed "<tier>:".
// A tier present in cur but absent from base is skipped (mirrors compareBaseline's missing-metric rule).
export function compareTiers(cur, base, tol = 0.005) {
  const out = [];
  const curTiers = cur.byTier || {};
  const baseTiers = base.byTier || {};
  for (const tier of Object.keys(curTiers)) {
    if (!(tier in baseTiers)) continue;
    for (const r of compareBaseline(curTiers[tier], baseTiers[tier], tol)) {
      out.push({ ...r, metric: `${tier}:${r.metric}` });
    }
  }
  return out;
}

// All regressions the CLI gates on: overall metrics plus every shared tier.
export function allRegressions(cur, base, tol = 0.005) {
  return [...compareBaseline(cur, base, tol), ...compareTiers(cur, base, tol)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — full suite green (existing eval tests unchanged, 5 new tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/eval.mjs test/eval.test.mjs
git commit -m "feat(gtir): per-tier eval aggregation + tier regression gate

evalGolden now emits byTier{gate,hard} alongside overall metrics; add
compareTiers (tier-prefixed regressions) and allRegressions (overall +
tiers). Backward compatible: missing tier defaults to gate.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire per-tier metrics into the CLI (`bin/gtir.mjs`)

**Files:**
- Modify: `bin/gtir.mjs` (import `allRegressions`; gate on it; print per-tier block)

- [ ] **Step 1: Update the import**

Change line 13 from:

```js
import { evalGolden, flattenMetrics, compareBaseline } from "../src/eval.mjs";
```

to:

```js
import { evalGolden, flattenMetrics, allRegressions } from "../src/eval.mjs";
```

- [ ] **Step 2: Gate on overall + per-tier regressions**

In `runEval`, replace this line (currently ~line 139):

```js
  const regressions = compareBaseline(metrics, baseline, 0.005);
```

with:

```js
  const regressions = allRegressions(metrics, baseline, 0.005);
```

(The surrounding block that prints `eval: REGRESSION ...` and returns 1 is unchanged — it already iterates `regressions`.)

- [ ] **Step 3: Print a per-tier block in `printMetricsTable`**

Replace the whole `printMetricsTable` function with:

```js
function printMetricsTable(m, base) {
  const fb = base ? flattenMetrics(base) : {};
  const line = (label, val, baseFlat = fb) => {
    if (val === null || val === undefined) return `  ${label.padEnd(11)} n/a`;
    const b = baseFlat[label];
    if (b === undefined) return `  ${label.padEnd(11)} ${val.toFixed(4)}`;
    const d = val - b;
    const ds = Math.abs(d) <= 0.005 ? "~0" : (d > 0 ? "+" : "") + d.toFixed(4);
    return `  ${label.padEnd(11)} ${val.toFixed(4)}  (base ${b.toFixed(4)}, ${ds})`;
  };
  const out = [`eval: n=${m.n} n_sec=${m.n_sec} model=${m.model}`];
  for (const k of Object.keys(m.recall)) out.push(line(`recall@${k}`, m.recall[k]));
  out.push(line("mrr", m.mrr));
  for (const k of Object.keys(m.sec_hit)) out.push(line(`sec_hit@${k}`, m.sec_hit[k]));
  for (const tier of Object.keys(m.byTier || {})) {
    const tm = m.byTier[tier];
    const tb = base && base.byTier && base.byTier[tier] ? flattenMetrics(base.byTier[tier]) : {};
    out.push(`  [${tier}] n=${tm.n} n_sec=${tm.n_sec}`);
    out.push(line("recall@1", tm.recall[1], tb));
    out.push(line("recall@5", tm.recall[5], tb));
    out.push(line("mrr", tm.mrr, tb));
    if (tm.sec_hit[1] !== null && tm.sec_hit[1] !== undefined) out.push(line("sec_hit@1", tm.sec_hit[1], tb));
  }
  process.stderr.write(out.join("\n") + "\n");
}
```

- [ ] **Step 4: Verify the file parses and the suite stays green**

Run: `node --check bin/gtir.mjs && npm test`
Expected: `node --check` prints nothing (exit 0); `npm test` PASS (no regressions). The CLI's eval gating logic now lives in the unit-tested `allRegressions`, so no Ollama is needed here.

- [ ] **Step 5: Commit**

```bash
git add bin/gtir.mjs
git commit -m "feat(gtir): CLI eval prints per-tier metrics and gates on every tier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Tag the existing 51 golden entries as `tier: "gate"`

**Files:**
- Modify: `eval/golden.json` (add `"tier": "gate"` to every existing entry)

- [ ] **Step 1: Tag and rewrite, one entry per line**

Run:

```bash
node -e "const fs=require('fs');const p='eval/golden.json';const g=JSON.parse(fs.readFileSync(p,'utf8'));for(const e of g)if(!e.tier)e.tier='gate';const body=g.map(e=>'  '+JSON.stringify(e)).join(',\n');fs.writeFileSync(p,'[\n'+body+'\n]\n');console.log('tagged',g.length,'entries');"
```

Expected output: `tagged 51 entries`

- [ ] **Step 2: Verify every entry now has tier "gate" and the file is valid JSON**

Run:

```bash
node -e "const g=require('./eval/golden.json');const n=g.length;const gate=g.filter(e=>e.tier==='gate').length;console.log('total',n,'gate',gate);if(n!==51||gate!==51)process.exit(1);"
```

Expected output: `total 51 gate 51` (exit 0)

- [ ] **Step 3: Commit**

```bash
git add eval/golden.json
git commit -m "chore(gtir): tag existing golden set as tier=gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Add the seven decoy corpus files

**Files:**
- Create: `eval/corpus/cache/lfu.py`
- Create: `eval/corpus/graph/bfs_grid.py`
- Create: `eval/corpus/http/retry.test.ts`
- Create: `eval/corpus/auth/jwt.test.ts`
- Create: `eval/corpus/notes/retry-policy.md`
- Create: `eval/corpus/notes/caching-strategy.md`
- Create: `eval/corpus/edge/node_c.py`

- [ ] **Step 1: Create `eval/corpus/cache/lfu.py`**

```python
from collections import Counter, OrderedDict


class LFUCache:
    """Fixed-capacity least-frequently-used cache; ties broken by insertion order."""
    def __init__(self, capacity):
        self.capacity = capacity
        self.store = OrderedDict()
        self.freq = Counter()

    def get(self, key):
        if key not in self.store:
            return None
        self.freq[key] += 1   # bump access frequency
        return self.store[key]

    def put(self, key, value):
        self.store[key] = value
        self.freq[key] += 1
        if len(self.store) > self.capacity:
            victim = min(self.store, key=lambda k: self.freq[k])   # evict least-frequently used
            del self.store[victim]
            del self.freq[victim]
```

- [ ] **Step 2: Create `eval/corpus/graph/bfs_grid.py`**

```python
from collections import deque
from typing import List, Optional, Tuple


def grid_shortest_path(grid: List[List[int]], start: Tuple[int, int], goal: Tuple[int, int]) -> Optional[int]:
    """Shortest path length on a 2D grid via BFS; cells equal to 1 are blocked, returns None if unreachable."""
    rows, cols = len(grid), len(grid[0])
    seen = {start}
    queue = deque([(start, 0)])
    while queue:
        (r, c), dist = queue.popleft()
        if (r, c) == goal:
            return dist
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols and grid[nr][nc] == 0 and (nr, nc) not in seen:
                seen.add((nr, nc))
                queue.append(((nr, nc), dist + 1))
    return None
```

- [ ] **Step 3: Create `eval/corpus/http/retry.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { fetchWithRetry, isRetryable } from "./retry";

describe("isRetryable", () => {
  it("treats 429 and 5xx gateway errors as retryable", () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(503)).toBe(true);
    expect(isRetryable(404)).toBe(false);
  });
});

describe("fetchWithRetry", () => {
  it("retries on a 503 then succeeds on the second attempt", async () => {
    const responses = [new Response("", { status: 503 }), new Response("ok", { status: 200 })];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const res = await fetchWithRetry("https://example.test", {}, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: false });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 4: Create `eval/corpus/auth/jwt.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "./jwt";

describe("signToken / verifyToken", () => {
  it("round-trips a payload and recovers the claims", () => {
    const token = signToken({ sub: "user-1" }, "s3cret", 3600);
    expect(verifyToken(token, "s3cret").sub).toBe("user-1");
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = signToken({ sub: "user-1" }, "s3cret", 3600);
    expect(() => verifyToken(token, "wrong")).toThrow(/bad signature/);
  });
});
```

- [ ] **Step 5: Create `eval/corpus/notes/retry-policy.md`**

```markdown
---
title: Retry & Backoff Policy
tags: [reliability, http]
---

## When to retry
We retry only idempotent outbound calls, and only on transient failures —
network timeouts and 429/502/503/504 gateway responses. A 4xx other than 429 is
a client error and is never retried.

## How long to keep trying
Attempts use exponential backoff with full jitter, capped at four attempts. Past
that we give up and surface the error to the caller rather than queueing
indefinitely — a failing dependency should shed load, not amplify it.

## Why jitter
Synchronised retries from many clients create a thundering herd that keeps a
recovering service down. Jitter spreads the retries out so the dependency can
recover.
```

- [ ] **Step 6: Create `eval/corpus/notes/caching-strategy.md`**

```markdown
---
title: Caching Strategy
tags: [performance, cache]
---

## Choosing an eviction policy
Use **LRU** when recent access predicts future access — request-scoped data and
session lookups. Use **LFU** when a small hot set is queried far more often than
the long tail and you want to keep the hot set resident regardless of recency.
Use **TTL** when entries go stale on a clock rather than on access — feature
flags and short-lived tokens.

## Sizing
Cache capacity is a memory-versus-hit-rate trade. Measure the hit rate at a few
capacities and pick the knee of the curve; past it, each extra megabyte buys
very little.
```

- [ ] **Step 7: Create `eval/corpus/edge/node_c.py`**

```python
# Throttling strategy for a peer (bidirectional) edge of the proxy.

class PeerThrottleStrategy:
    def __init__(self, capacity):
        self.capacity = capacity
        self.window = []
        # tracks how many request weight units are currently inflight in the window
        # the window is a list of (timestamp, weight) tuples sorted by arrival time
        # a peer edge accounts both inbound and outbound weight against one budget
        # capacity is set at construction time and may be reconfigured via reset()
        # callers should hold a lock before mutating this object in a multi-threaded env
        # the accounting window is intentionally a plain list for predictable gc behavior
        # internal state is not thread-safe; external locking is the caller's responsibility

    def admit(self, request):
        # decide whether to admit the request under the current budget and window
        # sum the weights of all inflight requests in the current window
        # a peer edge admits in either direction so long as the shared budget allows
        # the admit decision is synchronous and does not block the caller
        # callers are expected to call snapshot() periodically for observability
        # request.weight must be a non-negative integer; zero-weight is always admitted
        return request.weight <= self.capacity

    def reset(self):
        # clear the accounting window and restore the configured capacity
        # this is called by the supervisor after a rate-limit window expires
        # after reset the strategy behaves as if it were freshly constructed
        # any inflight weights tracked in the window are discarded unconditionally
        # callers are responsible for draining any pending queue before calling reset
        # reset does not emit a metric; the caller is responsible for that
        self.window = []

    def snapshot(self):
        # return a serializable view of the current accounting state for metrics
        # the snapshot is a plain dict so it can be serialised to JSON directly
        # capacity and inflight count are the two fields emitted to the metrics bus
        # callers should not mutate the returned dict; it may alias internal state
        # snapshot is called on every scrape interval by the metrics collector
        # the inflight count is the length of the window list at the time of the call
        return {"capacity": self.capacity, "inflight": len(self.window)}
```

- [ ] **Step 8: Verify all seven files exist**

Run:

```bash
node -e "const fs=require('fs');const files=['cache/lfu.py','graph/bfs_grid.py','http/retry.test.ts','auth/jwt.test.ts','notes/retry-policy.md','notes/caching-strategy.md','edge/node_c.py'];const missing=files.filter(f=>!fs.existsSync('eval/corpus/'+f));console.log(missing.length?'MISSING '+missing.join(','):'all 7 present');if(missing.length)process.exit(1);"
```

Expected output: `all 7 present`

- [ ] **Step 9: Commit**

```bash
git add eval/corpus/cache/lfu.py eval/corpus/graph/bfs_grid.py eval/corpus/http/retry.test.ts eval/corpus/auth/jwt.test.ts eval/corpus/notes/retry-policy.md eval/corpus/notes/caching-strategy.md eval/corpus/edge/node_c.py
git commit -m "test(gtir): add seven decoy corpus files for the hard eval tier

Near-dup impls (lfu, bfs_grid), test-file shadows (retry.test, jwt.test),
doc-copy shadows (retry-policy, caching-strategy), third throttle sibling
(node_c) — models the real failure modes that shadow source retrieval.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Add ~30 `hard` golden queries

**Files:**
- Modify: `eval/golden.json` (append `tier: "hard"` entries; validate every path exists)

- [ ] **Step 1: Append the hard queries and validate corpus paths**

Run (single command — appends 30 entries, asserts every golden path exists under `eval/corpus`, rewrites one-per-line):

```bash
node -e "
const fs=require('fs');
const p='eval/golden.json';
const g=JSON.parse(fs.readFileSync(p,'utf8'));
const hard=[
  { query: 'evict the least frequently used entry from a cache', path: 'cache/lfu.py', lines: [13,21], tier: 'hard' },
  { query: 'shortest path through a 2D grid avoiding blocked cells', path: 'graph/bfs_grid.py', lines: [5,18], tier: 'hard' },
  { query: 'test that a retry succeeds after a 503 response', path: 'http/retry.test.ts', lines: [11,19], tier: 'hard' },
  { query: 'what is our policy on retrying failed requests and when do we give up', path: 'notes/retry-policy.md', lines: [6,12], tier: 'hard' },
  { query: 'when should we use LRU versus LFU eviction', path: 'notes/caching-strategy.md', lines: [6,13], tier: 'hard' },
  { query: 'how does the peer throttle strategy admit a request', path: 'edge/node_c.py', lines: [15,22], tier: 'hard' },
  { query: 'how does the peer throttle strategy reset its accounting window', path: 'edge/node_c.py', lines: [24,31], tier: 'hard' },
  { query: 'what does the peer throttle snapshot expose for metrics', path: 'edge/node_c.py', lines: [33,40], tier: 'hard' },
  { query: 'stop a thundering herd of outbound requests', path: 'http/rate_limiter.ts', lines: [21,28], tier: 'hard' },
  { query: 'make sure only a fixed number of tasks run at once', path: 'concurrency/semaphore.ts', lines: [11,17], tier: 'hard' },
  { query: 'fan work out to background threads and collect results in order', path: 'concurrency/worker_pool.py', lines: [8,21], tier: 'hard' },
  { query: 'scramble plaintext into ciphertext with a block cipher', path: 'crypto/aes.py', lines: [24,29], tier: 'hard' },
  { query: 'tamper-proof authentication tag for a message', path: 'crypto/hmac.ts', lines: [3,7], tier: 'hard' },
  { query: 'turn a blog post title into a clean url path', path: 'text/slugify.ts', lines: [3,10], tier: 'hard' },
  { query: 'measure how different two words are', path: 'text/levenshtein.py', lines: [1,10], tier: 'hard' },
  { query: 'order build steps so dependencies come first', path: 'graph/topo_sort.py', lines: [5,32], tier: 'hard' },
  { query: 'do two boxes collide in space', path: 'geometry/aabb.rs', lines: [21,24], tier: 'hard' },
  { query: 'spin a point around an axis in 3d', path: 'geometry/quaternion.rs', lines: [18,24], tier: 'hard' },
  { query: 'drop cache entries that got too old', path: 'cache/ttl_cache.rs', lines: [16,24], tier: 'hard' },
  { query: 'stamp every outgoing request with a trace id', path: 'http/middleware.ts', lines: [5,10], tier: 'hard' },
  { query: 'bounded hand-off pipe between producer and consumer threads', path: 'concurrency/channel.rs', lines: [29,38], tier: 'hard' },
  { query: 'give up on a slow dependency after a few tries with growing waits', path: 'http/retry.ts', lines: [9,23], tier: 'hard' },
  { query: 'keep the most-recently-touched items and drop the rest', path: 'cache/lru.py', lines: [13,17], tier: 'hard' },
  { query: 'verify a signed session token has not been tampered with', path: 'auth/jwt.ts', lines: [9,15], tier: 'hard' },
  { query: 'what broke in production and how do we prevent it again', path: 'notes/incident-2025.md', lines: [13,21], tier: 'hard' },
  { query: 'how do new engineers get their machine set up', path: 'notes/onboarding.md', lines: [10,17], tier: 'hard' },
  { query: 'where do we keep user session records', path: 'notes/data-model.md', lines: [10,13], tier: 'hard' },
  { query: 'how is the event bus structured in our architecture', path: 'notes/architecture.md', lines: [11,14], tier: 'hard' },
  { query: 'split a sentence into individual words', path: 'text/tokenizer.py', lines: [8,10], tier: 'hard' },
  { query: 'find words within an edit distance of a query', path: 'text/levenshtein.py', lines: [13,16], tier: 'hard' }
];
g.push(...hard);
for(const e of g){ const fp='eval/corpus/'+e.path; if(!fs.existsSync(fp)) throw new Error('golden path missing on disk: '+fp); }
const body=g.map(e=>'  '+JSON.stringify(e)).join(',\n');
fs.writeFileSync(p,'[\n'+body+'\n]\n');
console.log('total',g.length,'hard',hard.length);
"
```

Expected output: `total 81 hard 30`

- [ ] **Step 2: Verify tiers and validity**

Run:

```bash
node -e "const g=require('./eval/golden.json');const gate=g.filter(e=>e.tier==='gate').length;const hard=g.filter(e=>e.tier==='hard').length;const untagged=g.filter(e=>!e.tier).length;console.log('gate',gate,'hard',hard,'untagged',untagged);if(gate!==51||hard!==30||untagged!==0)process.exit(1);"
```

Expected output: `gate 51 hard 30 untagged 0` (exit 0)

- [ ] **Step 3: Commit**

```bash
git add eval/golden.json
git commit -m "test(gtir): add 30 hard-tier golden queries (decoys + cross-vocabulary)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Rebuild index, tune to band, save baseline, update README

**Files:**
- Regenerate (not committed, gitignored): `eval/corpus/.gtir/`
- Modify: `eval/baseline.json` (re-saved tiered baseline)
- Modify: `README.md` (Headroom paragraph → new tiered numbers)

> **Requires Ollama running** with `hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16` pulled. If `gtir index` errors with an Ollama/model message, report BLOCKED with that message — do not fabricate numbers.

- [ ] **Step 1: Rebuild the corpus index over the new files**

Run:

```bash
node bin/gtir.mjs index --repo eval/corpus --rebuild
```

Expected: `gtir: indexed N chunks (...)` with N larger than before (the seven new files are now indexed). Exit 0.

- [ ] **Step 2: Score the golden set and read the hard-tier Recall@1**

Run:

```bash
node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --no-build --json 2>eval-run.txt | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log('overall recall@1',m.recall[1]);console.log('gate recall@1',m.byTier.gate.recall[1]);console.log('hard recall@1',m.byTier.hard.recall[1]);});"
cat eval-run.txt
```

Expected: prints overall/gate/hard Recall@1. The **hard recall@1 should land in 0.55–0.75**. (`eval-run.txt` holds the human-readable per-tier table on stderr.)

- [ ] **Step 3: Tune if out of band**

- If **hard recall@1 > 0.75** (too easy): the decoys aren't biting. Pick one hard query whose target has a near-dup and make its phrasing vaguer (drop a keyword that overlaps the target's code), or add one more cross-vocabulary query against a file that has a decoy. Re-run Step 2.
- If **hard recall@1 < 0.55** (too hard): inspect the misses — a miss usually means an underspecified query with a *second* defensible answer (a corpus bug per the authoring bar). Soften that one query's wording to point unambiguously at its target. Re-run Step 2.
- If **gate recall@1 dropped below ~0.85**: a decoy is too aggressive against a gate query — soften the decoy (e.g. rename a shared symbol) so the true source still wins. Re-run from Step 1.

Repeat Steps 2–3 until hard recall@1 is in band and gate recall@1 ≥ ~0.85. Apply any query edits by re-running the Task 5 Step 1 script with the adjusted `hard` array (it rewrites the file deterministically), then re-commit golden.json with message `test(gtir): tune hard-tier query wording to target band`.

- [ ] **Step 4: Save the new tiered baseline**

Run:

```bash
node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --no-build --save
node -e "const b=require('./eval/baseline.json');console.log('n',b.n,'byTier',Object.keys(b.byTier||{}));if(!b.byTier||!b.byTier.gate||!b.byTier.hard)process.exit(1);"
```

Expected: `eval: saved baseline → ...` then `n 81 byTier [ 'gate', 'hard' ]` (exit 0).

- [ ] **Step 5: Update the README "Headroom" note**

In `README.md`, replace the existing `**Headroom:**` paragraph (under `## Measuring retrieval quality`) with:

```markdown
**Tiers — gate vs meter:** golden entries carry a `tier`. The **`gate`** tier (51 near-saturated
queries) is the strict regression floor; the **`hard`** tier (~30 queries over realistic decoys —
near-duplicate implementations, test-file/doc-copy shadows, method-name ambiguity, and
cross-vocabulary phrasings) is the improvement meter, sitting at Recall@1 ≈ <HARD_R1> so a real
retrieval gain has room to register. `gtir eval` prints overall **and** per-tier metrics and gates on
regressions in *every* tier. Decoys follow one authoring rule: each query has exactly one defensible
target; a decoy must be wrong for the intent, only superficially similar.
```

Replace `<HARD_R1>` with the actual hard-tier Recall@1 from Step 2 (e.g. `0.63`), rounded to two decimals.

- [ ] **Step 6: Verify the full hermetic suite still passes**

Run: `npm test`
Expected: PASS (the corpus/baseline changes don't touch hermetic tests; this confirms nothing regressed).

- [ ] **Step 7: Commit**

```bash
git add eval/baseline.json README.md
git commit -m "test(gtir): save tiered eval baseline; document gate/hard tiers

Hard-tier Recall@1 now sits in the measurable band, giving the harness
headroom to register retrieval gains (e.g. a future rerank stage) while
the gate tier holds the regression floor.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Plan Self-Review

**Spec coverage:**
- Component 1 (tier tag) → Tasks 3 + 5. ✓
- Component 2 (`evalGolden` byTier, `compareTiers`) → Task 1. ✓
- Component 3 (CLI gating + per-tier print) → Task 2. ✓
- Component 4 (7 decoy files) → Task 4. ✓
- Component 5 (~30 hard queries + authoring bar) → Task 5 (authoring bar enforced by the one-defensible-target principle + Step 3 tuning). ✓
- Component 6 (tune to band) → Task 6 Steps 2–4. ✓
- Testing (hermetic eval tests, README) → Task 1 Step 1, Task 6 Steps 5–6. ✓
- Success criteria 1–6 → all mapped to tasks above. ✓

**Placeholder scan:** The only intentional placeholder is `<HARD_R1>` in Task 6 Step 5, which is explicitly a value to fill from the measured run — not a plan gap. No TBDs elsewhere.

**Type consistency:** `evalGolden` returns `{ ...overall, byTier }`; `compareTiers`/`allRegressions` read `cur.byTier`/`base.byTier`; `printMetricsTable` reads `m.byTier`/`base.byTier`. The CLI import (`allRegressions`) matches the export in Task 1. Tier values are the strings `"gate"`/`"hard"` throughout. Golden entry shape `{ query, path, lines, tier }` is consistent across Tasks 3 and 5 and matches `scoreGolden`'s expectations (`path`, optional `lines`).
