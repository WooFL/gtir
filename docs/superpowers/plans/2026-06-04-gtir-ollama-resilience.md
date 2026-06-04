# gtir Ollama Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden gtir's Ollama embed path against daemon-down, cold-start stall, and model-missing failures via timeout+retry, a warmup primitive, and startup preflight — no backend swap.

**Architecture:** Three layers. (1) `embed.mjs` wraps every `/api/embed` call in an AbortController timeout and a classified retry loop (retryable: timeout/network/5xx; fatal: 4xx/malformed). (2) A `warmup()` primitive force-loads the model. (3) `preflight()` (reusing `runDoctor`) gates `index` and `mcp` startup so they fail fast with an actionable message instead of dying mid-work. `search` stays preflight-free and leans on layer 1.

**Tech Stack:** Node ≥20 ESM, `node:test` + `node:assert/strict`, `fetch` with `AbortController`, injected `cfg.fetchImpl` for tests, mock-Ollama HTTP server in `test/integration.test.mjs`.

**Spec:** `docs/superpowers/specs/2026-06-04-gtir-ollama-resilience-design.md`

**Test runner:** `node --test test/*.test.mjs` (single file: `node --test test/embed.test.mjs`).

---

## File Structure

- `src/config.mjs` — add 4 `DEFAULTS` knobs (`embedTimeoutMs`, `embedRetries`, `embedRetryBackoffMs`, `warmupOnStart`). Owns all tunables.
- `src/embed.mjs` — split `embedBatch` into `embedOnce` (timeout + error classification) + `embedBatch` (retry/backoff); add `warmup()` export. Owns embed resilience.
- `src/doctor.mjs` — add `preflight(cfg)` thin wrapper over `runDoctor(cfg,{pull:false})`. Owns readiness gating.
- `src/mcp.mjs` — add `preflightIndexes(indexes,{log})`: keep healthy indexes, log+drop unready ones. Owns per-index startup tolerance.
- `bin/gtir.mjs` — `runIndex` gains `preflight`/`fetchImpl` params; CLI `index` case passes `preflight:true`; CLI `mcp` case filters indexes through `preflightIndexes`. Owns command wiring.
- `test/embed.test.mjs`, `test/doctor.test.mjs`, `test/mcp.test.mjs`, `test/integration.test.mjs` — unit + integration coverage.

---

## Task 1: Config knobs

**Files:**
- Modify: `src/config.mjs:12-50` (the `DEFAULTS` object)
- Test: `test/config.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.mjs`:

```js
test("DEFAULTS carry embed-resilience knobs", () => {
  const cfg = loadConfig(process.cwd());
  assert.equal(cfg.embedTimeoutMs, 60000);
  assert.equal(cfg.embedRetries, 2);
  assert.equal(cfg.embedRetryBackoffMs, 500);
  assert.equal(cfg.warmupOnStart, true);
});
```

(If `test/config.test.mjs` does not already `import { loadConfig } from "../src/config.mjs"` and `test`/`assert`, mirror the imports already at the top of that file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `cfg.embedTimeoutMs` is `undefined`, not `60000`.

- [ ] **Step 3: Add the knobs**

In `src/config.mjs`, inside `DEFAULTS`, immediately after the line `maxEmbedChars: 6000,           // hard cap ...` (line 20), insert:

```js
  // Ollama embed resilience (see docs/.../gtir-ollama-resilience-design.md).
  embedTimeoutMs: 60000,        // per-batch /api/embed call timeout; cold reload of a 4b override fits
  embedRetries: 2,              // retries for RETRYABLE failures (timeout / network / 5xx)
  embedRetryBackoffMs: 500,     // exponential backoff base: 500ms, 1s, 2s
  warmupOnStart: true,          // gate preflight+probe pre-load on `index`/`mcp` start (false = skip, trust retry)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "feat(config): embed-resilience knobs (timeout/retries/backoff/warmup)"
```

---

## Task 2: embed.mjs timeout + classified retry

**Files:**
- Modify: `src/embed.mjs:10-36` (replace `embedBatch`, keep `embedTexts`)
- Test: `test/embed.test.mjs`

The current `embedBatch` (lines 10-27) becomes two functions plus a `sleep` helper. `embedTexts`, `probeDim`, `l2normalize`, `contentHash` are unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/embed.test.mjs`:

```js
// fetch that hangs until the AbortController fires, then rejects like the platform does.
function hangingFetch(onCall = () => {}) {
  return (_url, opts) => new Promise((_resolve, reject) => {
    onCall();
    opts.signal.addEventListener("abort", () => {
      const e = new Error("The operation was aborted"); e.name = "AbortError"; reject(e);
    });
  });
}

test("embedBatch retries on timeout then throws after exhausting retries", async () => {
  let calls = 0;
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    embedTimeoutMs: 20, embedRetries: 2, embedRetryBackoffMs: 0,
    fetchImpl: hangingFetch(() => { calls++; }),
  };
  await assert.rejects(() => embedTexts(["a"], cfg), /abort/i);
  assert.equal(calls, 3, "1 initial attempt + 2 retries");
});

test("embedBatch recovers after retryable 503s", async () => {
  let calls = 0;
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    embedTimeoutMs: 1000, embedRetries: 2, embedRetryBackoffMs: 0,
    fetchImpl: async () => {
      calls++;
      if (calls <= 2) return { ok: false, status: 503, text: async () => "loading model" };
      return { ok: true, json: async () => ({ embeddings: [[1, 0, 0]] }) };
    },
  };
  const vecs = await embedTexts(["a"], cfg);
  assert.equal(calls, 3, "succeeds on the 3rd call");
  assert.equal(vecs.length, 1);
});

test("embedBatch does NOT retry a fatal 4xx", async () => {
  let calls = 0;
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    embedTimeoutMs: 1000, embedRetries: 2, embedRetryBackoffMs: 0,
    fetchImpl: async () => { calls++; return { ok: false, status: 400, text: async () => "does not support embeddings" }; },
  };
  await assert.rejects(() => embedTexts(["a"], cfg), /embed failed/);
  assert.equal(calls, 1, "4xx is fatal — no retry");
});

test("embedBatch does NOT retry a malformed response", async () => {
  let calls = 0;
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    embedTimeoutMs: 1000, embedRetries: 2, embedRetryBackoffMs: 0,
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({}) }; },
  };
  await assert.rejects(() => embedTexts(["a"], cfg), /no embeddings array/);
  assert.equal(calls, 1, "bad shape is fatal — no retry");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/embed.test.mjs`
Expected: FAIL — current `embedBatch` has no timeout (the hanging test never aborts) and no retry (503 test throws on the 1st call).

- [ ] **Step 3: Rewrite `embedBatch` into `embedOnce` + retry loop**

In `src/embed.mjs`, replace the whole `embedBatch` function (lines 10-27) with:

```js
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// One /api/embed call, time-boxed. Tags thrown errors with `.retryable` so embedBatch
// knows whether to back off and try again (timeout / network / 5xx) or give up (4xx / bad shape).
async function embedOnce(texts, cfg, timeoutMs) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${cfg.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, input: texts.map((t) => t.slice(0, cfg.maxEmbedChars ?? 6000)) }),
      signal: ac.signal,
    });
  } catch (err) {
    err.retryable = true;   // AbortError (timeout) or network failure
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text?.().catch(() => "")) || res.status;
    const e = new Error(`Ollama embed failed (${detail}). Is Ollama running and the model pulled? Run: gtir doctor`);
    e.retryable = res.status >= 500;   // 5xx transient; 4xx fatal (capability error etc.)
    throw e;
  }
  const data = await res.json();
  if (!data.embeddings) { const e = new Error("Ollama returned no embeddings array"); e.retryable = false; throw e; }
  if (data.embeddings.length !== texts.length) {
    const e = new Error(`Ollama returned ${data.embeddings.length} embeddings for ${texts.length} inputs`);
    e.retryable = false; throw e;
  }
  return data.embeddings.map(l2normalize);
}

async function embedBatch(texts, cfg) {
  const timeoutMs = cfg.embedTimeoutMs ?? 60000;
  const retries   = cfg.embedRetries ?? 2;
  const backoff   = cfg.embedRetryBackoffMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await embedOnce(texts, cfg, timeoutMs);
    } catch (e) {
      if (!e.retryable || attempt >= retries) throw e;
      await sleep(backoff * 2 ** attempt);
    }
  }
}
```

`embedTexts` (the loop that slices into batches) stays exactly as-is below this — it still calls `embedBatch`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/embed.test.mjs`
Expected: PASS — all four new tests plus the three pre-existing ones.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `node --test test/*.test.mjs`
Expected: PASS. The integration suite (mock Ollama) still drives the real embed path.

- [ ] **Step 6: Commit**

```bash
git add src/embed.mjs test/embed.test.mjs
git commit -m "feat(embed): timeout + classified retry on /api/embed (fixes cold-start stall, transient blip)"
```

---

## Task 3: warmup() primitive

**Files:**
- Modify: `src/embed.mjs` (add export after `embedTexts`)
- Test: `test/embed.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/embed.test.mjs`:

```js
import { warmup } from "../src/embed.mjs";

test("warmup returns true when the embed succeeds", async () => {
  let seen = null;
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    fetchImpl: async (_u, opts) => { seen = JSON.parse(opts.body).input; return { ok: true, json: async () => ({ embeddings: [[1, 0, 0]] }) }; },
  };
  assert.equal(await warmup(cfg), true);
  assert.deepEqual(seen, ["warmup"], "warmup embeds the single token 'warmup'");
});

test("warmup swallows failure and returns false", async () => {
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    embedRetries: 0, embedRetryBackoffMs: 0,
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => "nope" }),
  };
  assert.equal(await warmup(cfg), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/embed.test.mjs`
Expected: FAIL — `warmup` is not exported (`SyntaxError`/`undefined`).

- [ ] **Step 3: Add the `warmup` export**

In `src/embed.mjs`, immediately after the `embedTexts` function (the one ending `return out; }` near line 36), add:

```js
// Force the model to load before real work so the first real batch doesn't eat the cold-reload
// latency. Best-effort: never throws — preflight already reports hard-down / missing-model.
export async function warmup(cfg) {
  try { await embedTexts(["warmup"], cfg); return true; }
  catch { return false; }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/embed.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/embed.mjs test/embed.test.mjs
git commit -m "feat(embed): warmup() primitive — best-effort model pre-load"
```

---

## Task 4: preflight(cfg) in doctor.mjs + wire into `gtir index`

**Files:**
- Modify: `src/doctor.mjs` (add `preflight` export after `runDoctor`, ends line 122)
- Modify: `bin/gtir.mjs:26-31` (`runIndex`) and `bin/gtir.mjs:220-221` (CLI `index` case)
- Test: `test/doctor.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/doctor.test.mjs` (mirror its existing imports; add `preflight` to the doctor import):

```js
import { preflight } from "../src/doctor.mjs";

// Mock Ollama: /api/version ok, /api/tags lists the model, /api/embed returns a 3-vec, /api/show says embedding-capable.
function okOllama(model) {
  return async (url, opts) => {
    if (url.endsWith("/api/version")) return { ok: true, json: async () => ({ version: "0.5.0" }) };
    if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({ models: [{ name: model }] }) };
    if (url.endsWith("/api/show")) return { ok: true, json: async () => ({ capabilities: ["embedding"] }) };
    if (url.endsWith("/api/embed")) return { ok: true, json: async () => ({ embeddings: JSON.parse(opts.body).input.map(() => [1, 0, 0]) }) };
    return { ok: false, status: 404, text: async () => "nf" };
  };
}

test("preflight resolves with a dim when Ollama is ready", async () => {
  const cfg = { model: "m", ollamaUrl: "http://x", fetchImpl: okOllama("m") };
  const out = await preflight(cfg);
  assert.equal(out.dim, 3);
});

test("preflight throws an actionable error when Ollama is unreachable", async () => {
  const cfg = { model: "m", ollamaUrl: "http://x", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } };
  await assert.rejects(() => preflight(cfg), /gtir doctor/);
});

test("preflight throws when the model is missing", async () => {
  const cfg = {
    model: "absent", ollamaUrl: "http://x",
    fetchImpl: async (url) => {
      if (url.endsWith("/api/version")) return { ok: true, json: async () => ({ version: "0.5.0" }) };
      if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({ models: [{ name: "other" }] }) };
      return { ok: false, status: 404, text: async () => "nf" };
    },
  };
  await assert.rejects(() => preflight(cfg), /gtir doctor/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/doctor.test.mjs`
Expected: FAIL — `preflight` is not exported.

- [ ] **Step 3: Add `preflight` to `src/doctor.mjs`**

At the end of `src/doctor.mjs` (after `runDoctor`, line 122), add:

```js
// Fast readiness gate for commands that do expensive work (`index`, `mcp`). Reuses runDoctor's
// reachable → model-present → capability → probe checks (the probe doubles as a warmup), but never
// pulls. On not-ready, throws an Error whose message is the ✓/✗ report plus "run: gtir doctor",
// so the caller can print it and exit non-zero BEFORE walking files / serving.
export async function preflight(cfg) {
  const { ready, dim, report } = await runDoctor(cfg, { pull: false });
  if (!ready) throw new Error(`${report}\n\ngtir: Ollama not ready — run: gtir doctor`);
  return { dim };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/doctor.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire preflight into `runIndex` (CLI `index` only)**

In `bin/gtir.mjs`, replace `runIndex` (lines 26-31):

```js
export async function runIndex({ repo, rebuild = false, noCache = false, embedImpl = null, preflight: doPreflight = false, fetchImpl = null } = {}) {
  const cfg = loadConfig(repo);
  if (embedImpl) cfg.embedImpl = embedImpl;
  if (fetchImpl) cfg.fetchImpl = fetchImpl;
  cfg.noCache = noCache ?? cfg.noCache ?? false;
  // Preflight only the interactive `gtir index` path. The post-commit hook, `refresh`, and the
  // watcher call runIndex WITHOUT preflight so a momentarily-busy daemon never hard-blocks a commit.
  // Skip when a custom embed backend is injected (not Ollama) or the user disabled warmupOnStart.
  if (doPreflight && cfg.warmupOnStart && !cfg.embedImpl) {
    await preflight(cfg);   // throws an actionable Error on not-ready
  }
  return buildIndex(cfg, { rebuild });
}
```

Add `preflight` to the doctor import at the top of `bin/gtir.mjs`. The current line is:

```js
import { runDoctor } from "../src/doctor.mjs";
```

Change it to:

```js
import { runDoctor, preflight } from "../src/doctor.mjs";
```

Then in the CLI `case "index"` (line 220-221), pass the flag. Current:

```js
        const r = await runIndex({ repo, rebuild: !!args.rebuild, noCache: args.noCache ?? false });
```

becomes:

```js
        const r = await runIndex({ repo, rebuild: !!args.rebuild, noCache: args.noCache ?? false, preflight: true });
```

Leave the `case "refresh"` call (line 241) unchanged — no preflight there.

- [ ] **Step 6: Write the wiring test**

Append to `test/doctor.test.mjs`:

```js
import { runIndex } from "../bin/gtir.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("runIndex with preflight:true throws before walking when Ollama is unreachable", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-preflight-"));
  await assert.rejects(
    () => runIndex({ repo, preflight: true, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }),
    /gtir doctor/,
  );
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/doctor.test.mjs`
Expected: PASS — preflight unit tests + the runIndex wiring test.

- [ ] **Step 8: Run the full suite**

Run: `node --test test/*.test.mjs`
Expected: PASS. Existing `index`/`refresh`/hook tests still pass (they don't set `preflight:true`).

- [ ] **Step 9: Commit**

```bash
git add src/doctor.mjs bin/gtir.mjs test/doctor.test.mjs
git commit -m "feat(index): preflight Ollama before walking (fixes hard-down/model-missing mid-index)"
```

---

## Task 5: per-index preflight at `gtir mcp` start

**Files:**
- Modify: `src/mcp.mjs` (add `preflightIndexes` before `serveStdio`, line 378)
- Modify: `bin/gtir.mjs:296-311` (CLI `mcp` case)
- Test: `test/mcp.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/mcp.test.mjs` (mirror its existing imports; add `preflightIndexes` to the mcp import):

```js
import { preflightIndexes } from "../src/mcp.mjs";

function okFetch(model) {
  return async (url, opts) => {
    if (url.endsWith("/api/version")) return { ok: true, json: async () => ({ version: "0.5.0" }) };
    if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({ models: [{ name: model }] }) };
    if (url.endsWith("/api/show")) return { ok: true, json: async () => ({ capabilities: ["embedding"] }) };
    if (url.endsWith("/api/embed")) return { ok: true, json: async () => ({ embeddings: JSON.parse(opts.body).input.map(() => [1, 0, 0]) }) };
    return { ok: false, status: 404, text: async () => "nf" };
  };
}

test("preflightIndexes keeps healthy indexes and drops unready ones", async () => {
  const dropped = [];
  const indexes = [
    { label: "good", repo: "/g", cfg: { model: "m", ollamaUrl: "http://x", warmupOnStart: true, fetchImpl: okFetch("m") } },
    { label: "bad",  repo: "/b", cfg: { model: "m", ollamaUrl: "http://x", warmupOnStart: true, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } } },
  ];
  const healthy = await preflightIndexes(indexes, { log: (m) => dropped.push(m) });
  assert.deepEqual(healthy.map((i) => i.label), ["good"]);
  assert.ok(dropped.some((m) => /bad/.test(m)), "dropped index is logged");
});

test("preflightIndexes skips the probe when warmupOnStart is false (keeps the index)", async () => {
  const indexes = [
    { label: "lazy", repo: "/l", cfg: { model: "m", ollamaUrl: "http://x", warmupOnStart: false, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } } },
  ];
  const healthy = await preflightIndexes(indexes, { log: () => {} });
  assert.deepEqual(healthy.map((i) => i.label), ["lazy"], "no preflight ⇒ index kept, retry layer covers it");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mcp.test.mjs`
Expected: FAIL — `preflightIndexes` is not exported.

- [ ] **Step 3: Add `preflightIndexes` to `src/mcp.mjs`**

Add the import at the top of `src/mcp.mjs` (next to the existing `import { openStore } from "./store.mjs";`):

```js
import { preflight } from "./doctor.mjs";
```

Then, immediately before `export function serveStdio(` (line 378), add:

```js
// Gate each served index on a readiness probe before serving. A broken/unready index is dropped
// with a logged note (stderr) — the healthy ones still serve, matching defaultStatusFn's per-index
// tolerance. The server must not refuse to start because one index's daemon/model is unready.
// Indexes whose cfg disables warmupOnStart (or injects a non-Ollama backend) skip the probe and
// are kept as-is — the embed retry layer covers them at query time.
export async function preflightIndexes(indexes, { log = () => {} } = {}) {
  const healthy = [];
  for (const ix of indexes) {
    if (!ix.cfg.warmupOnStart || ix.cfg.embedImpl) { healthy.push(ix); continue; }
    try { await preflight(ix.cfg); healthy.push(ix); }
    catch (e) { log(`index '${ix.label}' not ready — skipping (${String(e.message).split("\n").pop()})`); }
  }
  return healthy;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mcp.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire into the CLI `mcp` case**

In `bin/gtir.mjs`, `case "mcp"`, insert a preflight filter after `resolveIndexes` and feed the filtered list to both the `--watch` block and `serveStdio`. The `printConfig` early-break stays BEFORE `resolveIndexes`/preflight (a config dump must not require a live daemon, and must not depend on label resolution). Replace lines 299-311 (from the `printConfig` line through the `return;`):

```js
        if (args.printConfig) { process.stdout.write(printConfig(repos, { watch: !!args.watch, debounceMs: args.debounce ?? null }) + "\n"); break; }
        const indexes = resolveIndexes(repos, args.labels ?? {});
        const served = await preflightIndexes(indexes, { log: (m) => process.stderr.write(`gtir mcp: ${m}\n`) });
        if (served.length === 0) { process.stderr.write("gtir mcp: no ready indexes — run: gtir doctor\n"); process.exit(1); }
        if (args.watch) {
          // Live-refresh each served index as files change (uncommitted edits). Logs to STDERR
          // only — stdout is the JSON-RPC channel. Defers during git ops via the shared gitBusy gate.
          const debounceMs = args.debounce ?? 1500;
          const sweepMs = args.sweep != null ? args.sweep * 1000 : undefined; // --sweep is seconds (0 disables)
          const handles = startWatchers(served, { debounceMs, sweepMs, log: (m) => process.stderr.write(`gtir mcp: watch ${m}\n`) });
          process.on("SIGINT", () => { Promise.all(handles.map((h) => h.close())).finally(() => process.exit(0)); }); // drop liveness locks on Ctrl+C
          process.stderr.write(`gtir mcp: live-refresh ON (debounce ${debounceMs}ms) — watching [${served.map((i) => i.label).join(", ")}]\n`);
        }
        serveStdio(served, { version: pkgVersion() });
        return; // keep the process alive on stdin; do not fall through to exit
```

Note: the `printConfig` early-break is preserved and intentionally runs BEFORE preflight (config dump must not require a live daemon).

Add `preflightIndexes` to the mcp import at the top of `bin/gtir.mjs`. The current line is:

```js
import { resolveIndexes, serveStdio, printConfig, startWatchers } from "../src/mcp.mjs";
```

Change it to:

```js
import { resolveIndexes, serveStdio, printConfig, startWatchers, preflightIndexes } from "../src/mcp.mjs";
```

- [ ] **Step 6: Run the full suite**

Run: `node --test test/*.test.mjs`
Expected: PASS. Existing mcp tests drive `handleRequest`/`serveStdio` directly and are unaffected by the CLI wiring.

- [ ] **Step 7: Commit**

```bash
git add src/mcp.mjs bin/gtir.mjs test/mcp.test.mjs
git commit -m "feat(mcp): preflight each index at startup; skip+log unready, serve the rest"
```

---

## Task 6: integration — retry survives a dropped first request

**Files:**
- Modify: `test/integration.test.mjs`

The integration suite already stands up a mock Ollama HTTP server and runs the real `buildIndex`. Add a case where the mock drops the first `/api/embed` (socket destroy) and succeeds afterward, proving the retry layer carries a real index build through a transient blip.

- [ ] **Step 1: Read the existing mock-Ollama setup**

Run: `node --test test/integration.test.mjs`
Expected: PASS (baseline). Open `test/integration.test.mjs` and locate the `createServer` handler that answers `/api/embed` and the `before`/`after` hooks that start/stop it. Note how a repo's `.gtir/config.json` sets `ollamaUrl` to the mock's address.

- [ ] **Step 2: Write the failing test**

Add a new `test(...)` in `test/integration.test.mjs` modeled on the existing index-build case, but point the repo's config at a mock whose embed handler fails once. If the existing mock is module-scoped, add a counter the handler honors; otherwise stand up a local server inside the test:

```js
test("index build survives a dropped first /api/embed (retry layer)", async () => {
  let embedHits = 0;
  const srv = createServer((req, res) => {
    if (req.url === "/api/version") { res.end(JSON.stringify({ version: "0.5.0" })); return; }
    if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "m" }] })); return; }
    if (req.url === "/api/show") { res.end(JSON.stringify({ capabilities: ["embedding"] })); return; }
    if (req.url === "/api/embed") {
      embedHits++;
      if (embedHits === 1) { req.destroy(); return; }            // drop the first call → network error → retryable
      let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
        const input = JSON.parse(body).input;
        res.end(JSON.stringify({ embeddings: input.map(() => [1, 0, 0]) }));
      });
      return;
    }
    res.statusCode = 404; res.end("nf");
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}`;

  const repo = mkdtempSync(join(tmpdir(), "gtir-retry-"));
  mkdirSync(join(repo, ".gtir"), { recursive: true });
  writeFileSync(join(repo, ".gtir", "config.json"), JSON.stringify({ ollamaUrl: url, model: "m", embedRetryBackoffMs: 0 }));
  writeFileSync(join(repo, "a.js"), "export function hello() { return 1; }\n");

  const cfg = loadConfig(repo);
  const out = await buildIndex(cfg, { rebuild: true });
  assert.ok(embedHits >= 2, "first embed dropped, retry succeeded");
  assert.ok(out, "index built despite the dropped request");

  await new Promise((r) => srv.close(r));
});
```

Ensure the test file imports `mkdirSync` (add it to the existing `node:fs` import if absent — the file already imports `mkdtempSync`, `writeFileSync`, `readFileSync`).

- [ ] **Step 3: Run test to verify it fails (on a pre-Task-2 checkout) / passes now**

Run: `node --test test/integration.test.mjs`
Expected: PASS now (Task 2 added retry). Sanity-check the assertion bites: temporarily set `embedRetries: 0` in the test's config.json — the build should then FAIL with a network error, proving the test exercises the retry path. Revert to remove `embedRetries` override (defaults to 2) before committing.

- [ ] **Step 4: Run the full suite**

Run: `node --test test/*.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/integration.test.mjs
git commit -m "test(integration): index build survives a dropped first embed via retry"
```

---

## Final verification

- [ ] **Run the whole suite**

Run: `node --test test/*.test.mjs`
Expected: All tests pass.

- [ ] **Manual smoke (optional, needs a real Ollama)**

```bash
# daemon up, model pulled:
node bin/gtir.mjs index --repo .          # preflight ✓, builds
# stop ollama, then:
node bin/gtir.mjs index --repo .          # preflight fails fast → "run: gtir doctor", non-zero exit
node bin/gtir.mjs search --repo . "foo"   # no preflight; query embed retries, then remediation message
```

- [ ] **Update README** (the embed section documents Ollama as a hard dependency)

Add a sentence to the README "Embedding model" / requirements area noting the new resilience: "Embed calls are time-boxed (`embedTimeoutMs`) and retried on transient failures (`embedRetries`); `index` and `mcp` preflight Ollama at startup and fail fast with a `gtir doctor` pointer. Disable the startup probe with `warmupOnStart: false` in `.gtir/config.json`." Commit:

```bash
git add README.md
git commit -m "docs(readme): document embed timeout/retry + startup preflight knobs"
```
