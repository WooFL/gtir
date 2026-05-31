# Cross-Encoder Rerank Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, query-time cross-encoder rerank stage (llama.cpp `llama-server`) that reorders the top-N hybrid candidates, off by default, with graceful fallback to RRF — and measure its effect on the eval harness's `hard` tier.

**Architecture:** A new `src/rerank.mjs` HTTP client (mirrors `embed.mjs`, returns `null` on any failure). `search.mjs` gains a pure `applyRerank()` reorder function and an opt-in rerank branch. Config gains `rerank` keys; a `--rerank` CLI flag drives the A/B. Rerank stays off in the committed eval config so the gate runs without the server.

**Tech Stack:** Node ESM (`.mjs`), `node:test` (hermetic — `fetchImpl`/`rerankImpl` injected, no server needed). Integration A/B uses `llama-server.exe` at `G:\demon\llamacpp` + a bge-reranker-v2-m3 GGUF.

**Repo:** `G:\demon\gtir` (run commands from repo root). `npm test` = `node --test test/*.test.mjs`.

---

### Task 1: Config keys (`src/config.mjs`)

**Files:**
- Modify: `src/config.mjs` (add rerank keys to `DEFAULTS`)
- Test: `test/config.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.mjs`:

```js
test("rerank defaults: off, with url/model/candidates/maxChars", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cfg-"));
  const cfg = loadConfig(repo);
  assert.equal(cfg.rerank, false);
  assert.equal(cfg.rerankUrl, "http://127.0.0.1:8088");
  assert.equal(cfg.rerankModel, "bge-reranker-v2-m3");
  assert.equal(cfg.rerankCandidates, 24);
  assert.equal(cfg.rerankMaxChars, 2000);
});

test("rerank is overridable via .gtir/config.json", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cfg-"));
  mkdirSync(join(repo, ".gtir"), { recursive: true });
  writeFileSync(join(repo, ".gtir", "config.json"), JSON.stringify({ rerank: true, rerankCandidates: 30 }));
  const cfg = loadConfig(repo);
  assert.equal(cfg.rerank, true);
  assert.equal(cfg.rerankCandidates, 30);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `cfg.rerank` is `undefined`.

- [ ] **Step 3: Add the keys to `DEFAULTS`**

In `src/config.mjs`, insert after the `noCache: false,` line (currently line 22):

```js
  rerank: false,                          // opt-in cross-encoder rerank; off by default
  rerankUrl: "http://127.0.0.1:8088",     // llama-server --reranking endpoint
  rerankModel: "bge-reranker-v2-m3",      // sent in the /rerank request (informational for a 1-model server)
  rerankCandidates: 24,                   // hybrid candidates to rerank before slicing to k
  rerankMaxChars: 2000,                   // per-document char cap (~512 tokens, bge context)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "feat(gtir): rerank config keys (off by default)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rerank client (`src/rerank.mjs`)

**Files:**
- Create: `src/rerank.mjs`
- Test: `test/rerank.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/rerank.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { rerankDocs } from "../src/rerank.mjs";

const cfgWith = (fetchImpl, extra = {}) => ({
  rerankUrl: "http://127.0.0.1:8088", rerankModel: "m", rerankMaxChars: 2000, fetchImpl, ...extra,
});

test("rerankDocs parses {results} and sorts by score desc", async () => {
  const cfg = cfgWith(async () => ({
    ok: true, status: 200,
    json: async () => ({ results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.9 }] }),
  }));
  const out = await rerankDocs("q", ["a", "b"], cfg);
  assert.deepEqual(out, [{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }]);
});

test("rerankDocs returns null on HTTP error (graceful fallback)", async () => {
  const cfg = cfgWith(async () => ({ ok: false, status: 503, text: async () => "down" }));
  assert.equal(await rerankDocs("q", ["a"], cfg), null);
});

test("rerankDocs returns null when fetch throws", async () => {
  const cfg = cfgWith(async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(await rerankDocs("q", ["a"], cfg), null);
});

test("rerankDocs caps each document to rerankMaxChars", async () => {
  let sent;
  const cfg = cfgWith(async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  }, { rerankMaxChars: 10 });
  await rerankDocs("q", ["abcdefghijklmnopqrstuvwxyz"], cfg);
  assert.equal(sent.documents[0].length, 10);
  assert.equal(sent.query, "q");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `../src/rerank.mjs` does not exist (import error).

- [ ] **Step 3: Implement `src/rerank.mjs`**

```js
// Cross-encoder rerank client for llama.cpp llama-server (--reranking, /rerank endpoint).
// Mirrors embed.mjs: fetchImpl-injectable, and NEVER throws fatally — returns null on any
// failure so search() can fall back to hybrid (RRF) order, like the FTS-unavailable path.

export async function rerankDocs(query, docs, cfg) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const cap = cfg.rerankMaxChars ?? 2000;
  try {
    const res = await fetchImpl(`${cfg.rerankUrl}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.rerankModel,
        query,
        documents: docs.map((d) => String(d).slice(0, cap)),
        top_n: docs.length,
      }),
    });
    if (!res.ok) {
      process.stderr.write(`[gtir] rerank unavailable (HTTP ${res.status}), using hybrid order\n`);
      return null;
    }
    const data = await res.json();
    const results = Array.isArray(data) ? data : data.results;
    if (!Array.isArray(results)) return null;
    return results
      .map((r) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }))
      .filter((r) => Number.isInteger(r.index))
      .sort((a, b) => b.score - a.score);
  } catch (err) {
    process.stderr.write(`[gtir] rerank unavailable (${err.message}), using hybrid order\n`);
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/rerank.mjs test/rerank.test.mjs
git commit -m "feat(gtir): rerank client for llama-server /rerank (graceful null on failure)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire rerank into search (`src/search.mjs`)

**Files:**
- Modify: `src/search.mjs` (import `rerankDocs`; add pure `applyRerank`; opt-in rerank branch)
- Test: `test/search.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/search.test.mjs`:

```js
import { applyRerank } from "../src/search.mjs";

const F = (p) => ({ path: p, snippet: p, score: 0 });

test("applyRerank reorders fused by reranker indices and slices to k", () => {
  const fused = [F("a"), F("b"), F("c")];
  const ranked = [{ index: 2, score: 0.9 }, { index: 0, score: 0.5 }, { index: 1, score: 0.1 }];
  const out = applyRerank(fused, ranked, 2);
  assert.deepEqual(out.map((r) => r.path), ["c", "a"]);
  assert.equal(out[0].rerank_score, 0.9);
});

test("applyRerank falls back to RRF order when ranked is null or empty", () => {
  const fused = [F("a"), F("b")];
  assert.deepEqual(applyRerank(fused, null, 5).map((r) => r.path), ["a", "b"]);
  assert.deepEqual(applyRerank(fused, [], 5).map((r) => r.path), ["a", "b"]);
});

test("applyRerank appends fused rows the reranker omitted, preserving RRF order", () => {
  const fused = [F("a"), F("b"), F("c")];
  const ranked = [{ index: 1, score: 0.9 }];          // only b came back
  const out = applyRerank(fused, ranked, 5);
  assert.deepEqual(out.map((r) => r.path), ["b", "a", "c"]);
});

test("applyRerank ignores out-of-range indices from the server", () => {
  const fused = [F("a"), F("b")];
  const ranked = [{ index: 9, score: 0.9 }, { index: 0, score: 0.5 }];
  const out = applyRerank(fused, ranked, 5);
  assert.deepEqual(out.map((r) => r.path), ["a", "b"]);  // index 9 dropped; b appended
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `applyRerank` is not exported from `search.mjs`.

- [ ] **Step 3: Implement in `src/search.mjs`**

Add the import at the top (after the existing `embedTexts` import):

```js
import { rerankDocs } from "./rerank.mjs";
```

Add this pure function after `fuseRRF` (before `search`):

```js
// Pure reorder of fused RRF rows by a reranker's [{index, score}] list (best-first).
// Falls back to RRF order when `ranked` is null/empty; ignores out-of-range indices;
// appends any fused rows the reranker omitted, preserving RRF order. Then slices to k.
export function applyRerank(fused, ranked, limit) {
  if (!Array.isArray(ranked) || ranked.length === 0) return fused.slice(0, limit);
  const used = new Set();
  const out = [];
  for (const { index, score } of ranked) {
    if (fused[index] && !used.has(index)) {
      used.add(index);
      out.push({ ...fused[index], rerank_score: Number(score.toFixed(4)) });
    }
  }
  for (let i = 0; i < fused.length; i++) if (!used.has(i)) out.push(fused[i]);
  return out.slice(0, limit);
}
```

In `search`, change the fanout line. Replace:

```js
  const fanout = Math.min(50, Math.max(limit * 3, 16));
```

with:

```js
  const rcand = Math.min(50, cfg.rerankCandidates ?? 24);
  const fanout = Math.min(50, Math.max(limit * 3, 16, cfg.rerank ? rcand : 0));
```

Then replace the final line:

```js
  return fuseRRF(vecRows, ftsRows, limit);
```

with:

```js
  const fused = fuseRRF(vecRows, ftsRows, cfg.rerank ? rcand : limit);
  if (!cfg.rerank) return fused;
  const rerankImpl = cfg.rerankImpl ?? ((q, docs) => rerankDocs(q, docs, cfg));
  const ranked = await rerankImpl(query, fused.map((r) => r.snippet));
  return applyRerank(fused, ranked, limit);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — full suite green. (The rerank-off path returns `fuseRRF(..., limit)` exactly as before.)

- [ ] **Step 5: Commit**

```bash
git add src/search.mjs test/search.test.mjs
git commit -m "feat(gtir): opt-in rerank branch in search + pure applyRerank reorder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: CLI `--rerank` flag (`bin/gtir.mjs`)

**Files:**
- Modify: `bin/gtir.mjs` (parse `--rerank`; thread into `runSearch` and `runEval`)

- [ ] **Step 1: Parse the flag**

In `parseArgs`, add after the `else if (a === "--json") args.json = true;` line:

```js
    else if (a === "--rerank") args.rerank = true;
```

- [ ] **Step 2: Thread into `runSearch`**

Change the `runSearch` signature and body. Replace:

```js
export async function runSearch({ repo, query, k = 8, pathPrefix = null, language = null, embedImpl = null } = {}) {
  const cfg = loadConfig(repo);
  if (embedImpl) cfg.embedImpl = embedImpl;
  return search(query, cfg, { k, pathPrefix, language });
}
```

with:

```js
export async function runSearch({ repo, query, k = 8, pathPrefix = null, language = null, embedImpl = null, rerank = false } = {}) {
  const cfg = loadConfig(repo);
  if (embedImpl) cfg.embedImpl = embedImpl;
  if (rerank) cfg.rerank = true;
  return search(query, cfg, { k, pathPrefix, language });
}
```

And in the `case "search":` dispatch, pass the flag — replace:

```js
        const hits = await runSearch({ repo, query, k: args.k || 8, pathPrefix: args.pathPrefix, language: args.language });
```

with:

```js
        const hits = await runSearch({ repo, query, k: args.k || 8, pathPrefix: args.pathPrefix, language: args.language, rerank: args.rerank });
```

- [ ] **Step 3: Thread into `runEval`**

In `runEval`, immediately after `const cfg = loadConfig(repo);` (currently line 90), add:

```js
  if (args.rerank) cfg.rerank = true;
```

- [ ] **Step 4: Verify the file parses and the suite stays green**

Run: `node --check bin/gtir.mjs && npm test`
Expected: `node --check` exits 0; `npm test` PASS. (No new unit test — the flag is thin wiring over the unit-tested `search()`/`applyRerank`; it's exercised by the Task 6 integration A/B.)

- [ ] **Step 5: Commit**

```bash
git add bin/gtir.mjs
git commit -m "feat(gtir): --rerank flag for search and eval (drives the A/B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: README rerank section

**Files:**
- Modify: `README.md` (new section after `## Measuring retrieval quality — \`gtir eval\``)

- [ ] **Step 1: Add the section**

Insert this section into `README.md` immediately before `## MCP server (use gtir from inside Claude)`:

```markdown
## Reranking (optional cross-encoder stage)

gtir can rerank the top hybrid candidates with a **cross-encoder** before returning them. A
bi-encoder (the default vector+BM25+RRF path) scores query and document separately; a cross-encoder
reads the `(query, chunk)` pair together, so it resolves *intent* — which is what beats shadowing
(a test file or doc-copy outranking the source the query actually wants). It's **off by default** and
needs a separate `llama-server` runtime, so it's opt-in.

**Setup (once):**

1. Download a reranker GGUF (~600 MB), e.g. `bge-reranker-v2-m3-Q8_0.gguf`, into
   `G:\demon\llamacpp\models\`.
2. Run llama.cpp's server with the reranking endpoint:

       llama-server.exe -m models\bge-reranker-v2-m3-Q8_0.gguf --reranking --pooling rank --host 127.0.0.1 --port 8088

3. Enable it per-repo in `.gtir/config.json`: `{ "rerank": true }` — or pass `--rerank` per command.

**Config keys** (defaults): `rerank` (`false`), `rerankUrl` (`http://127.0.0.1:8088`), `rerankModel`
(`bge-reranker-v2-m3`), `rerankCandidates` (`24` — how many hybrid hits to rerank), `rerankMaxChars`
(`2000` — per-document cap, ~512 tokens).

If the server is unreachable, gtir **degrades gracefully** to hybrid order with a one-line stderr
note — it never fails a search because the reranker is down.

**Measure the gain** with the eval harness (the rerank stage is deterministic, so the delta is real):

       gtir eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --no-build            # hybrid (floor)
       gtir eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --no-build --rerank   # + rerank

Compare the **`hard`-tier** Recall@1 between the two runs — that tier encodes the shadowing cases the
reranker is meant to fix. The reranker is swappable (it's just the GGUF `llama-server` loads plus the
`rerankModel` label), so trying `jina-reranker-v2` later is a relaunch, not a code change.
```

- [ ] **Step 2: Verify it reads cleanly**

Run: `node -e "const s=require('fs').readFileSync('README.md','utf8');if(!s.includes('## Reranking'))process.exit(1);console.log('rerank section present');"`
Expected: `rerank section present`

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(gtir): document the optional rerank stage + A/B recipe

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Integration A/B (requires `llama-server` + GGUF download)

**Files:**
- Download (not committed): `G:\demon\llamacpp\models\bge-reranker-v2-m3-Q8_0.gguf`

> **This task needs the ~600 MB model and a running server.** The controller runs it (not a hermetic
> subagent). If the download or server launch fails, report what's needed and hand the user the exact
> commands — do NOT fabricate an A/B result.

- [ ] **Step 1: Download the reranker GGUF**

```bash
mkdir -p /g/demon/llamacpp/models
curl -L -o /g/demon/llamacpp/models/bge-reranker-v2-m3-Q8_0.gguf \
  https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q8_0.gguf
```

Expected: a ~600 MB file. If the URL 404s, search HuggingFace for a `bge-reranker-v2-m3` GGUF mirror
and adjust the URL (any Q8_0/Q4_K_M GGUF of that model works).

- [ ] **Step 2: Launch llama-server (background)**

```bash
G:\demon\llamacpp\llama-b9442-bin-win-cuda-13.3-x64\llama-server.exe \
  -m G:\demon\llamacpp\models\bge-reranker-v2-m3-Q8_0.gguf \
  --reranking --pooling rank --host 127.0.0.1 --port 8088
```

Run it in the background. Wait until it logs that the model loaded and the HTTP server is listening.

- [ ] **Step 3: Probe the endpoint**

```bash
curl -s http://127.0.0.1:8088/rerank -H "content-type: application/json" \
  -d '{"query":"verify a token","documents":["jwt verify","cache eviction"],"top_n":2}'
```

Expected: JSON with a `results` array of `{index, relevance_score}`. The `jwt verify` doc should score
higher than `cache eviction`.

- [ ] **Step 4: Run the A/B on the hard tier**

```bash
echo "=== hybrid (floor) ==="
node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --no-build --json 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log('hard r1',m.byTier.hard.recall[1],'r5',m.byTier.hard.recall[5],'mrr',m.byTier.hard.mrr);});"
echo "=== + rerank ==="
node bin/gtir.mjs eval --repo eval/corpus --golden eval/golden.json --baseline eval/baseline.json --no-build --rerank --json 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log('hard r1',m.byTier.hard.recall[1],'r5',m.byTier.hard.recall[5],'mrr',m.byTier.hard.mrr);});"
```

Expected: two lines of hard-tier metrics. Record the delta in `hard r1`. **Any direction is a valid
result** — the harness exists to tell the truth. A clear positive validates the stage; a null/negative
informs whether the `jina-reranker-v2` follow-up A/B is worth it.

- [ ] **Step 5: Record the result**

Append a short "Measured A/B" note to the README rerank section with the two hard-tier numbers and the
delta (e.g. `hybrid 0.63 → +rerank 0.71 (+0.08)`), then commit:

```bash
git add README.md
git commit -m "docs(gtir): record rerank A/B result on the hard tier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

If the server couldn't be brought up, skip Steps 4–5, leave the README's recipe in place, and report
the blocker to the user with the commands to run themselves.

---

## Plan Self-Review

**Spec coverage:**
- Component 1 (rerank client, graceful null) → Task 2. ✓
- Component 2 (search wiring, fuse-to-N, reorder, fallback) → Task 3 (pure `applyRerank` + branch). ✓
- Component 3 (config keys) → Task 1. ✓
- Component 4 (`--rerank` flag) → Task 4. ✓
- Component 5 (model acquisition + launch) → Task 6 + README (Task 5). ✓
- Data flow / error handling → Task 3 (`applyRerank` guards) + Task 2 (null contract). ✓
- Testing (hermetic rerank + applyRerank; manual A/B) → Tasks 2, 3, 6. ✓
- README → Task 5. Success criteria 1–6 all mapped. ✓

**Placeholder scan:** No TBDs. The only run-time-filled value is the A/B delta in Task 6 Step 5, which
is an explicitly measured number, not a plan gap. The GGUF URL has a stated fallback.

**Type consistency:** `rerankDocs` returns `[{index, score}] | null`; `applyRerank(fused, ranked, limit)`
consumes exactly that shape and reads `r.snippet` (the field `fuseRRF` emits). `search()` injects
`cfg.rerankImpl ?? ((q,docs)=>rerankDocs(q,docs,cfg))`, mirroring `cfg.embedImpl`. Config keys
(`rerank`, `rerankUrl`, `rerankModel`, `rerankCandidates`, `rerankMaxChars`) are spelled identically in
Tasks 1, 2, 3, 4, 5. The `--rerank` flag sets `cfg.rerank = true` in both `runSearch` and `runEval`.
